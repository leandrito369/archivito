// CLOUD-03.4A: offline codec for the v3 library. Never accepted by the fixture backend.
// Pure conversion; no IndexedDB, network, or mutation of the source record.
import {seal,open,sealMetadata,openMetadata,sha256Hex} from "./shared-crypto.mjs";
const FORMAT="archivito-sync-record-v3", MANIFEST="archivito-sync-record-manifest-v3";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[0-9a-f]{64}$/;
const MAX_ASSET=35*1024*1024, MAX_TOTAL=128*1024*1024, MAX_META=256*1024;
const fields=["id","kind","title","date","from","to","note","tags","favorite","createdAt","updatedAt"];
const sides=["front","back","frontDerived","backDerived"];
const types=new Set(["image/jpeg","image/png","image/webp","image/gif"]);
const kinds=new Set(["letter","postcard","envelope","photo","other"]);
const encoder=new TextEncoder();
const fail=()=>{throw Error("Recuerdo v3 no compatible con el contrato cifrado; no se modificó el original.");};
const uuid=x=>typeof x==="string"&&UUID.test(x);
const str=(x,n)=>typeof x==="string"&&x.length<=n;
const exact=(x,k)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(a=>Object.hasOwn(x,a));
const ctx=(c,objectId,kind)=>({archiveId:c.archiveId,objectId,kind,revision:c.revision});
function context(c){
 if(!c||!uuid(c.archiveId)||!uuid(c.memoryId)||!uuid(c.operationId)||!Number.isSafeInteger(c.revision)||c.revision<1)fail();
 return {archiveId:c.archiveId,memoryId:c.memoryId,operationId:c.operationId,revision:c.revision};
}
export function validateRecordMetadata(m){
 if(!exact(m,fields)||!str(m.id,200)||!m.id||!kinds.has(m.kind)||!str(m.title,120)||!m.title||
 !str(m.date,10)||!str(m.from,100)||!str(m.to,100)||!str(m.note,4000)||
 !Array.isArray(m.tags)||m.tags.length>15||!m.tags.every(x=>str(x,60))||
 typeof m.favorite!=="boolean"||!str(m.createdAt,80)||!m.createdAt||!str(m.updatedAt,80)||!m.updatedAt)fail();
 return m;
}
// Crop is a bounded JSON value; preserve geometry and algorithm metadata without coercion.
// Reject non-JSON data, dangerous keys, excessive depth and non-finite numbers.
export function validateRecordCrop(value,depth=0){
 if(depth>8)fail();
 if(value===null||typeof value==="boolean"||str(value,2048)||typeof value==="number"&&Number.isFinite(value))return value;
 if(Array.isArray(value)&&value.length<=64)return value.map(x=>validateRecordCrop(x,depth+1));
 if(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length<=64){
  const entries=Object.entries(value).map(([k,v])=>{if(!str(k,80)||["__proto__","constructor","prototype"].includes(k))fail();return [k,validateRecordCrop(v,depth+1)];});
  return Object.fromEntries(entries);
 }
 fail();
}
function envelope(e,c,kind,id,keyId,max){
 if(!exact(e,["version","archiveId","objectId","kind","revision","keyId","nonce","ciphertext"])||
 e.version!==1||e.archiveId!==c.archiveId||e.objectId!==id||e.kind!==kind||e.revision!==c.revision||e.keyId!==keyId||
 !(e.nonce instanceof Uint8Array)||e.nonce.length!==12||!(e.ciphertext instanceof Uint8Array)||e.ciphertext.length<16||e.ciphertext.length>max+16)fail();
}
export function validateV3Package(p){
 if(!exact(p,["format","archiveId","memoryId","operationId","revision","keyId","metadata","assets"])||p.format!==FORMAT||typeof p.keyId!=="string"||!HEX.test(p.keyId))fail();
 const c=context(p);
 envelope(p.metadata,c,"metadata",c.memoryId,p.keyId,MAX_META);
 if(!Array.isArray(p.assets)||p.assets.length<1||p.assets.length>100)fail();
 const ids=new Set([c.memoryId]);let total=0;
 for(const e of p.assets){
  if(!e||!uuid(e.objectId)||ids.has(e.objectId)||e.ciphertext?.length<17)fail();
  ids.add(e.objectId);envelope(e,c,"asset",e.objectId,p.keyId,MAX_ASSET);
  total+=e.ciphertext.length-16;if(total>MAX_TOTAL)fail();
 }
 return p;
}
export async function encodeV3Record(key,c,record){
 c=context(c);
 // Snapshot before awaits; Blobs are immutable and structuredClone preserves their bytes.
 const r=structuredClone(record);
 if(!r||r.schemaVersion!==3||!Array.isArray(r.pages)||r.pages.length<1||r.pages.length>25)fail();
 const m=validateRecordMetadata(Object.fromEntries(fields.map(k=>[k,r[k]])));
 const ids=new Set([c.memoryId]),pageIds=new Set(),pages=[],assets=[];
 let total=0;
 // Preflight every page and all byte limits before encryption.
 const pending=[];
 for(const p of r.pages){
  if(!p||!str(p.id,120)||!p.id||pageIds.has(p.id)||!str(p.caption??"",200)||!p.front)fail();
  pageIds.add(p.id);
  if(p.frontCrop!=null&&!p.frontDerived||p.backCrop!=null&&!p.backDerived||p.backDerived&&!p.back)fail();
  const page={id:p.id,caption:p.caption??"",frontCrop:validateRecordCrop(p.frontCrop??null),backCrop:validateRecordCrop(p.backCrop??null),front:null,back:null,frontDerived:null,backDerived:null};
  for(const side of sides){
   const b=p[side];if(b==null)continue;
   if(!(b instanceof Blob)||!types.has(b.type)||b.size<1||b.size>MAX_ASSET)fail();
   total+=b.size;if(total>MAX_TOTAL)fail();
   const id=crypto.randomUUID();if(ids.has(id))fail();ids.add(id);
   const descriptor={id,mime:b.type,size:b.size};
   page[side]=descriptor;pending.push({b,descriptor});
  }
  pages.push(page);
 }
 for(const {b,descriptor:d} of pending){
  const bytes=new Uint8Array(await b.arrayBuffer());d.sha256=await sha256Hex(bytes);
  assets.push(await seal(key,ctx(c,d.id,"asset"),bytes));
 }
 const manifest={format:MANIFEST,operationId:c.operationId,record:m,pages};
 if(encoder.encode(JSON.stringify(manifest)).length>MAX_META)fail();
 const metadata=await sealMetadata(key,ctx(c,c.memoryId,"metadata"),manifest);
 return validateV3Package({format:FORMAT,...c,keyId:key.keyId,metadata,assets});
}
export async function decodeV3Record(key,expected,p,{makeThumb,validateImage}={}){
 // Snapshot prevents mutations between asynchronous integrity checks.
 p=structuredClone(p);validateV3Package(p);
 const c=context(expected);
 if(Object.keys(c).some(k=>c[k]!==p[k])||p.keyId!==key.keyId||typeof makeThumb!=="function"||typeof validateImage!=="function")fail();
 const m=await openMetadata(key,ctx(c,c.memoryId,"metadata"),p.metadata);
 if(!exact(m,["format","operationId","record","pages"])||m.format!==MANIFEST||m.operationId!==c.operationId||!Array.isArray(m.pages)||m.pages.length<1||m.pages.length>25)fail();
 const record=validateRecordMetadata(m.record),byId=new Map(p.assets.map(e=>[e.objectId,e])),used=new Set(),pageIds=new Set(),pages=[];
 for(const page of m.pages){
  if(!exact(page,["id","caption","frontCrop","backCrop",...sides])||!str(page.id,120)||!page.id||pageIds.has(page.id)||!str(page.caption,200)||!page.front||
  page.frontCrop!==null&&!page.frontDerived||page.backCrop!==null&&!page.backDerived||page.backDerived&&!page.back)fail();
  pageIds.add(page.id);
  const decoded={id:page.id,caption:page.caption,frontCrop:validateRecordCrop(page.frontCrop),backCrop:validateRecordCrop(page.backCrop)};
  for(const side of sides){
   const d=page[side];if(d===null){decoded[side]=null;continue;}
   if(!exact(d,["id","mime","size","sha256"])||!uuid(d.id)||used.has(d.id)||!types.has(d.mime)||!Number.isSafeInteger(d.size)||d.size<1||d.size>MAX_ASSET||typeof d.sha256!=="string"||!HEX.test(d.sha256)||!byId.has(d.id))fail();
   used.add(d.id);
   const bytes=await open(key,ctx(c,d.id,"asset"),byId.get(d.id));
   if(bytes.length!==d.size||await sha256Hex(bytes)!==d.sha256)fail();
   decoded[side]=new Blob([bytes],{type:d.mime});
  }
  pages.push(decoded);
 }
 if(used.size!==p.assets.length)fail();
 // All bytes authenticated before invoking local image validators and thumbnail generator.
 for(const page of pages)for(const side of sides)if(page[side])await validateImage(page[side]);
 for(const page of pages){page.thumb=await makeThumb(page.frontDerived||page.front);if(!(page.thumb instanceof Blob)||page.thumb.size<1||!types.has(page.thumb.type))fail();}
 return {...record,schemaVersion:3,pages,front:pages[0].front,back:pages[0].back,thumb:pages[0].thumb};
}
