// CLOUD-03.1: bounded synthetic-only transport contract; no network, IndexedDB or real records.
import {seal,open,sealMetadata,openMetadata,sha256Hex,toBase64Url} from "./shared-crypto.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[0-9a-f]{64}$/;
const MAX_ASSETS=8, MAX_TOTAL=8*1024*1024, MAX_META=64*1024;
const encoder=new TextEncoder();
const fail=()=>{throw Error("Paquete de sincronización inválido.");};
const uuid=v=>typeof v==="string"&&UUID.test(v);
const rev=v=>Number.isSafeInteger(v)&&v>=1;
const roles=new Set(["front-original","back-original","front-derived","back-derived"]);
const mimes=new Set(["image/png","image/jpeg","image/webp"]);
function context(archiveId,objectId,kind,revision){return {archiveId,objectId,kind,revision};}
function exact(o,keys){return o&&typeof o==="object"&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));}
function assertEnvelope(e,ctx,keyId,max){
 if(!exact(e,["version","archiveId","objectId","kind","revision","keyId","nonce","ciphertext"])||
   e.version!==1||e.archiveId!==ctx.archiveId||e.objectId!==ctx.objectId||e.kind!==ctx.kind||e.revision!==ctx.revision||e.keyId!==keyId||
   !(e.nonce instanceof Uint8Array)||e.nonce.length!==12||!(e.ciphertext instanceof Uint8Array)||e.ciphertext.length<16||e.ciphertext.length>max+16)fail();
}
export function validatePackage(p){
 if(!exact(p,["format","archiveId","memoryId","revision","operationId","keyId","metadata","assets"])||
   p.format!=="archivito-sync-fixture-v1"||!uuid(p.archiveId)||!uuid(p.memoryId)||!uuid(p.operationId)||!rev(p.revision)||
   typeof p.keyId!=="string"||!HEX.test(p.keyId)||!Array.isArray(p.assets)||p.assets.length<1||p.assets.length>MAX_ASSETS)fail();
 assertEnvelope(p.metadata,context(p.archiveId,p.memoryId,"metadata",p.revision),p.keyId,MAX_META);
 let total=0;const ids=new Set([p.memoryId]);
 for(const e of p.assets){
  if(!e||!uuid(e.objectId)||ids.has(e.objectId))fail();
  ids.add(e.objectId);assertEnvelope(e,context(p.archiveId,e.objectId,"asset",p.revision),p.keyId,MAX_TOTAL);
  total+=e.ciphertext.length-16;if(total>MAX_TOTAL)fail();
 }
 return p;
}
function validateDescriptor(d){
 if(!exact(d,["id","side","mime","size","sha256"])||!uuid(d.id)||!roles.has(d.side)||!mimes.has(d.mime)||
   !Number.isSafeInteger(d.size)||d.size<1||d.size>MAX_TOTAL||typeof d.sha256!=="string"||!HEX.test(d.sha256))fail();
}
export async function encodeFixture(key,{archiveId,memoryId,revision,operationId,title,note,assets}){
 if(!uuid(archiveId)||!uuid(memoryId)||!uuid(operationId)||!rev(revision)||
   typeof title!=="string"||title.length>200||typeof note!=="string"||note.length>4000||
   !Array.isArray(assets)||assets.length<1||assets.length>MAX_ASSETS)fail();
 const ids=new Set([memoryId]);let total=0;const descriptors=[],encrypted=[];
 for(const a of assets){
  if(!a||!uuid(a.id)||ids.has(a.id)||!roles.has(a.side)||!mimes.has(a.mime)||!(a.bytes instanceof Uint8Array)||a.bytes.length<1)fail();
  ids.add(a.id);total+=a.bytes.length;if(total>MAX_TOTAL)fail();
  const snapshot=a.bytes.slice();
  descriptors.push({id:a.id,side:a.side,mime:a.mime,size:snapshot.length,sha256:await sha256Hex(snapshot)});
  encrypted.push(await seal(key,context(archiveId,a.id,"asset",revision),snapshot));
 }
 const metadata=await sealMetadata(key,context(archiveId,memoryId,"metadata",revision),{format:"archivito-sync-manifest-v1",operationId,title,note,assets:descriptors});
 return validatePackage({format:"archivito-sync-fixture-v1",archiveId,memoryId,revision,operationId,keyId:key.keyId,metadata,assets:encrypted});
}
export async function decodeFixture(key,expected,p){
 validatePackage(p);
 if(!expected||p.archiveId!==expected.archiveId||p.memoryId!==expected.memoryId||p.revision!==expected.revision||p.keyId!==key.keyId)fail();
 const m=await openMetadata(key,context(p.archiveId,p.memoryId,"metadata",p.revision),p.metadata);
 if(!exact(m,["format","operationId","title","note","assets"])||m.format!=="archivito-sync-manifest-v1"||m.operationId!==p.operationId||
   typeof m.title!=="string"||m.title.length>200||typeof m.note!=="string"||m.note.length>4000||
   !Array.isArray(m.assets)||m.assets.length!==p.assets.length)fail();
 const decoded=[],ids=new Set();
 for(const d of m.assets){
  validateDescriptor(d);
  if(ids.has(d.id))fail();ids.add(d.id);
  const e=p.assets.find(a=>a.objectId===d.id);
  if(!e)fail();
  const bytes=await open(key,context(p.archiveId,d.id,"asset",p.revision),e);
  if(bytes.length!==d.size||await sha256Hex(bytes)!==d.sha256)fail();
  decoded.push({id:d.id,side:d.side,mime:d.mime,bytes});
 }
 // All assets verified before any plaintext is returned.
 return {archiveId:p.archiveId,memoryId:p.memoryId,revision:p.revision,title:m.title,note:m.note,assets:decoded};
}
async function packageDigest(p){
 const env=async e=>[e.version,e.archiveId,e.objectId,e.kind,e.revision,e.keyId,toBase64Url(e.nonce),await sha256Hex(e.ciphertext)];
 const data=[p.format,p.archiveId,p.memoryId,p.revision,p.operationId,p.keyId,await env(p.metadata),await Promise.all(p.assets.map(env))];
 return sha256Hex(encoder.encode(JSON.stringify(data)));
}
// Simulated transport only. No authentication or durable storage; not a security boundary.
// An operation receipt and record are committed synchronously after digest calculation.
export function createMemoryTransport(){
 const records=new Map(),receipts=new Map();
 const recordKey=(a,m)=>a+"/"+m;
 return {
  async publish(input,expectedRevision){
   const p=structuredClone(input);validatePackage(p);
   if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||p.revision!==expectedRevision+1)fail();
   const digest=await packageDigest(p),k=recordKey(p.archiveId,p.memoryId),op=p.archiveId+"/"+p.operationId;
   const receipt=receipts.get(op);
   if(receipt){
    if(receipt.digest!==digest||receipt.expectedRevision!==expectedRevision)throw Error("Reutilización incompatible de operación.");
    return {state:"synced",revision:receipt.revision,replayed:true};
   }
   const current=records.get(k),actual=current?.revision??0;
   if(actual!==expectedRevision)return {state:"conflict",actualRevision:actual};
   if(current&&current.keyId!==p.keyId)throw Error("Cambio de clave no soportado.");
   records.set(k,p);receipts.set(op,{digest,expectedRevision,revision:p.revision});
   return {state:"synced",revision:p.revision,replayed:false};
  },
  read(archiveId,memoryId){
   const p=records.get(recordKey(archiveId,memoryId));
   return p?structuredClone(p):null;
  }
 };
}
