// CLOUD-03.5C1 — candidate immutable-asset contract. Pure, offline, not wire v1.
import {sealMetadata,openMetadata,sha256Hex,toBase64Url,fromBase64Url} from "./shared-crypto.mjs";
import {validateRecordMetadata,validateRecordCrop} from "./sync-v3-contract.mjs";
const FORMAT="archivito-sync-incremental-v1",MANIFEST="archivito-incremental-manifest-v1";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,HEX=/^[a-f0-9]{64}$/;
const fields=["id","kind","title","date","from","to","note","tags","favorite","createdAt","updatedAt"];
const sides=["front","back","frontDerived","backDerived"],types=new Set(["image/png","image/jpeg","image/webp","image/gif"]);
const MAX_ASSET=35*1024*1024,MAX_TOTAL=128*1024*1024,MAX_META=256*1024;
const encoder=new TextEncoder();
const fail=()=>{throw Error("Contrato incremental inválido; no se modificó el original.");};
const uuid=x=>typeof x==="string"&&UUID.test(x),hex=x=>typeof x==="string"&&HEX.test(x);
const positive=x=>Number.isSafeInteger(x)&&x>0;
const str=(x,n)=>typeof x==="string"&&x.length<=n;
const exact=(o,k)=>o&&typeof o==="object"&&!Array.isArray(o)&&Object.keys(o).length===k.length&&k.every(x=>Object.hasOwn(o,x));
const refFields=["id","born","size","nonce","cipherSha256"];
function context(c){
 if(!c||!uuid(c.archiveId)||!uuid(c.memoryId)||!uuid(c.operationId)||!positive(c.revision))fail();
 return {archiveId:c.archiveId,memoryId:c.memoryId,operationId:c.operationId,revision:c.revision};
}
function sameContext(a,b){return ["archiveId","memoryId","operationId","revision"].every(k=>a[k]===b[k]);}
function refEqual(a,b){return refFields.every(k=>a[k]===b[k]);}
function metaContext(h){return {archiveId:h.archiveId,objectId:h.memoryId,kind:"metadata",revision:h.revision};}
// Separate AAD domain. Birth revision remains immutable; memory ID prevents
// cross-record substitution. Fresh random nonce for every new asset.
function assetAAD(h,r){return encoder.encode(JSON.stringify(["archivito-immutable-asset",1,h.archiveId,h.memoryId,r.id,r.born,h.keyId]));}
export function validateIncrementalHeader(h){
 if(!exact(h,["format","archiveId","memoryId","operationId","revision","keyId","metadata","refs"])||h.format!==FORMAT||!hex(h.keyId))fail();
 context(h);
 const e=h.metadata;
 if(!exact(e,["version","archiveId","objectId","kind","revision","keyId","nonce","ciphertext"])||e.version!==1||e.archiveId!==h.archiveId||e.objectId!==h.memoryId||e.kind!=="metadata"||e.revision!==h.revision||e.keyId!==h.keyId||
 !(e.nonce instanceof Uint8Array)||e.nonce.length!==12||!(e.ciphertext instanceof Uint8Array)||e.ciphertext.length<16||e.ciphertext.length>MAX_META+16)fail();
 if(!Array.isArray(h.refs)||h.refs.length<1||h.refs.length>100)fail();
 const ids=new Set([h.memoryId]);let total=0;
 for(const r of h.refs){
  if(!exact(r,refFields)||!uuid(r.id)||ids.has(r.id)||!positive(r.born)||r.born>h.revision||
   !positive(r.size)||r.size<17||r.size>MAX_ASSET+16||!hex(r.cipherSha256)||fromBase64Url(r.nonce,12).length!==12)fail();
  ids.add(r.id);total+=r.size-16;if(total>MAX_TOTAL)fail();
 }
 return h;
}
// Manifest authenticates exact public descriptors (including ciphertext hash,
// nonce and birth revision) as well as the plaintext hash, MIME and page role.
async function authenticatedManifest(key,expected,input){
 const h=structuredClone(input);validateIncrementalHeader(h);
 if(!sameContext(context(expected),h)||expected.keyId!==key.keyId||h.keyId!==key.keyId)fail();
 const m=await openMetadata(key,metaContext(h),h.metadata);
 if(!exact(m,["format","operationId","record","pages"])||m.format!==MANIFEST||m.operationId!==h.operationId||!Array.isArray(m.pages)||m.pages.length<1||m.pages.length>25)fail();
 validateRecordMetadata(m.record);
 const refs=new Map(h.refs.map(r=>[r.id,r])),used=new Set(),pages=new Set();
 for(const p of m.pages){
  if(!exact(p,["id","caption","frontCrop","backCrop",...sides])||!str(p.id,120)||!p.id||pages.has(p.id)||!str(p.caption,200)||!p.front||
   p.frontCrop!==null&&!p.frontDerived||p.backCrop!==null&&!p.backDerived||p.backDerived&&!p.back)fail();
  pages.add(p.id);validateRecordCrop(p.frontCrop);validateRecordCrop(p.backCrop);
  for(const side of sides){
   const d=p[side];if(d===null)continue;
   if(!exact(d,["ref","mime","sha256"])||!types.has(d.mime)||!hex(d.sha256)||!exact(d.ref,refFields)||used.has(d.ref.id)||!refs.has(d.ref.id)||!refEqual(d.ref,refs.get(d.ref.id)))fail();
   used.add(d.ref.id);
  }
 }
 if(used.size!==refs.size)fail();
 return {header:h,manifest:m};
}
export async function prepareIncremental(key,c,record,prior=null){
 c=context(c);
 const r=structuredClone(record);
 if(!r||r.schemaVersion!==3||!Array.isArray(r.pages)||r.pages.length<1||r.pages.length>25)fail();
 const meta=validateRecordMetadata(Object.fromEntries(fields.map(k=>[k,r[k]])));
 let old=null;
 // No implicit migration or speculative reuse. Caller must supply trusted
 // committed predecessor identity from remote/baseline, not the header itself.
 if(c.revision===1){if(prior!==null)fail();}
 else {
  if(!prior||!prior.expected||prior.expected.archiveId!==c.archiveId||prior.expected.memoryId!==c.memoryId||prior.expected.revision!==c.revision-1||prior.expected.operationId===c.operationId)fail();
  old=(await authenticatedManifest(key,prior.expected,prior.header)).manifest;
 }
 const prev=new Map(old?.pages.map(p=>[p.id,p])??[]),ids=new Set([c.memoryId]),pages=[],pending=[],newAssets=[],refs=[];
 let total=0;const pageIds=new Set();
 for(const p of r.pages){
  if(!p||!str(p.id,120)||!p.id||pageIds.has(p.id)||!str(p.caption??"",200)||!p.front||
   p.frontCrop!=null&&!p.frontDerived||p.backCrop!=null&&!p.backDerived||p.backDerived&&!p.back)fail();
  pageIds.add(p.id);
  const page={id:p.id,caption:p.caption??"",frontCrop:validateRecordCrop(p.frontCrop??null),backCrop:validateRecordCrop(p.backCrop??null),front:null,back:null,frontDerived:null,backDerived:null};
  for(const side of sides){
   const b=p[side];if(b==null)continue;
   if(!(b instanceof Blob)||!types.has(b.type)||b.size<1||b.size>MAX_ASSET)fail();
   total+=b.size;if(total>MAX_TOTAL)fail();
   pending.push({page,side,b,previous:prev.get(p.id)?.[side]});
  }
  pages.push(page);
 }
 const h={format:FORMAT,...c,keyId:key.keyId,metadata:null,refs};
 for(const {page,side,b,previous} of pending){
  const bytes=new Uint8Array(await b.arrayBuffer()),sha256=await sha256Hex(bytes);
  let ref;
  if(previous&&previous.mime===b.type&&previous.ref.size===b.size+16&&previous.sha256===sha256){
   ref=structuredClone(previous.ref);
  }else{
   const id=crypto.randomUUID(),born=c.revision,nonce=crypto.getRandomValues(new Uint8Array(12));
   const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce,additionalData:assetAAD(h,{id,born}),tagLength:128},key.key,bytes));
   ref={id,born,size:ciphertext.length,nonce:toBase64Url(nonce),cipherSha256:await sha256Hex(ciphertext)};
   newAssets.push({id,ciphertext});
  }
  if(ids.has(ref.id))fail();ids.add(ref.id);refs.push(ref);page[side]={ref,mime:b.type,sha256};
 }
 const m={format:MANIFEST,operationId:c.operationId,record:meta,pages};
 if(encoder.encode(JSON.stringify(m)).length>MAX_META)fail();
 h.metadata=await sealMetadata(key,metaContext(h),m);
 validateIncrementalHeader(h);
 return {header:h,newAssets};
}
// Trusted server simulation/preflight: no decryption, validates exact inherited
// references against a committed predecessor and exact new ciphertext bytes.
// Future server must check immutable objects/quotas/commit atomically.
export async function validateIncrementalDelta(input,previous=null){
 const delta=structuredClone(input);
 if(!exact(delta,["header","newAssets"])||!Array.isArray(delta.newAssets))fail();
 const h=validateIncrementalHeader(delta.header),oldRefs=new Map();
 if(h.revision===1){if(previous!==null)fail();}
 else{
  const p=validateIncrementalHeader(structuredClone(previous));
  if(p.archiveId!==h.archiveId||p.memoryId!==h.memoryId||p.keyId!==h.keyId||p.revision!==h.revision-1||p.operationId===h.operationId)fail();
  for(const r of p.refs)oldRefs.set(r.id,r);
 }
 const fresh=new Map();
 for(const a of delta.newAssets){
  if(!exact(a,["id","ciphertext"])||!uuid(a.id)||fresh.has(a.id)||!(a.ciphertext instanceof Uint8Array))fail();
  fresh.set(a.id,a.ciphertext);
 }
 let newBytes=0;
 for(const r of h.refs){
  if(r.born===h.revision){
   const b=fresh.get(r.id);
   if(oldRefs.has(r.id)||!b||b.length!==r.size||await sha256Hex(b)!==r.cipherSha256)fail();
   newBytes+=b.length;fresh.delete(r.id);
  }else if(!oldRefs.has(r.id)||!refEqual(r,oldRefs.get(r.id)))fail();
 }
 if(fresh.size)fail();
 return {newBytes,newAssets:delta.newAssets.length,reusedAssets:h.refs.length-delta.newAssets.length};
}
export async function decodeIncremental(key,expected,input,{readAsset,validateImage,makeThumb}={}){
 if(typeof readAsset!=="function"||typeof validateImage!=="function"||typeof makeThumb!=="function")fail();
 const {header:h,manifest:m}=await authenticatedManifest(key,expected,input),pages=[];
 for(const p of m.pages){
  const page={id:p.id,caption:p.caption,frontCrop:p.frontCrop,backCrop:p.backCrop};
  for(const side of sides){
   const d=p[side];if(d===null){page[side]=null;continue;}
   const ref=d.ref,b=await readAsset(structuredClone(ref));
   if(!(b instanceof Uint8Array)||b.length!==ref.size)fail();
   const ciphertext=b.slice();
   if(await sha256Hex(ciphertext)!==ref.cipherSha256)fail();
   const bytes=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:fromBase64Url(ref.nonce,12),additionalData:assetAAD(h,ref),tagLength:128},key.key,ciphertext));
   if(bytes.length!==ref.size-16||await sha256Hex(bytes)!==d.sha256)fail();
   page[side]=new Blob([bytes],{type:d.mime});
  }
  pages.push(page);
 }
 for(const p of pages)for(const side of sides)if(p[side])await validateImage(p[side]);
 for(const p of pages){p.thumb=await makeThumb(p.frontDerived||p.front);if(!(p.thumb instanceof Blob)||!types.has(p.thumb.type)||p.thumb.size<1)fail();}
 return {...m.record,schemaVersion:3,pages,front:pages[0].front,back:pages[0].back,thumb:pages[0].thumb};
}
