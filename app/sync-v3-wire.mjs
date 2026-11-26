// CLOUD-03.4D1: versioned wire protocol. No network, UI, key or plaintext on server.
import {validateV3Package} from "./sync-v3-contract.mjs";
import {sha256Hex,toBase64Url,fromBase64Url} from "./shared-crypto.mjs";
export const CHUNK=4*1024*1024;
const MAX_ASSET=35*1024*1024+16,MAX_TOTAL=128*1024*1024,MAX_META=256*1024+16;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x),hex=x=>typeof x==="string"&&HEX.test(x);
const exact=(x,k)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(a=>Object.hasOwn(x,a));
const fail=()=>{throw Error("Contrato remoto v3 inválido.");};
const path=(h,id,i)=>[h.archiveId,h.operationId,id,String(i)].join("/");
const format="archivito-sync-record-wire-v1";
export function validateV3Header(h){
 if(!exact(h,["format","archiveId","memoryId","operationId","keyId","revision","expectedRevision","metadata","assets"])||h.format!==format||
 !uuid(h.archiveId)||!uuid(h.memoryId)||!uuid(h.operationId)||!hex(h.keyId)||!Number.isSafeInteger(h.expectedRevision)||h.expectedRevision<0||
 !Number.isSafeInteger(h.revision)||h.revision!==h.expectedRevision+1||!exact(h.metadata,["nonce","ciphertext"])||
 fromBase64Url(h.metadata.nonce,12).length!==12||fromBase64Url(h.metadata.ciphertext,MAX_META).length<16||
 !Array.isArray(h.assets)||h.assets.length<1||h.assets.length>100)fail();
 let total=0;const ids=new Set([h.memoryId]);
 for(const a of h.assets){
  if(!exact(a,["assetId","nonce","size","sha256","chunks"])||!uuid(a.assetId)||ids.has(a.assetId)||fromBase64Url(a.nonce,12).length!==12||
   !Number.isSafeInteger(a.size)||a.size<17||a.size>MAX_ASSET||!hex(a.sha256)||!Array.isArray(a.chunks)||a.chunks.length!==Math.ceil(a.size/CHUNK))fail();
  ids.add(a.assetId);total+=a.size-16;if(total>MAX_TOTAL)fail();
  for(let i=0;i<a.chunks.length;i++){
   const c=a.chunks[i],n=Math.min(CHUNK,a.size-i*CHUNK);
   if(!exact(c,["index","path","size","sha256"])||c.index!==i||c.path!==path(h,a.assetId,i)||c.size!==n||!hex(c.sha256))fail();
  }
 }
 return h;
}
export async function makeV3Wire(input,expectedRevision){
 const p=structuredClone(input);validateV3Package(p);
 const h={format,archiveId:p.archiveId,memoryId:p.memoryId,operationId:p.operationId,keyId:p.keyId,revision:p.revision,expectedRevision,
  metadata:{nonce:toBase64Url(p.metadata.nonce),ciphertext:toBase64Url(p.metadata.ciphertext)},assets:[]};
 const objects=new Map();
 for(const e of p.assets){
  const a={assetId:e.objectId,nonce:toBase64Url(e.nonce),size:e.ciphertext.length,sha256:await sha256Hex(e.ciphertext),chunks:[]};
  for(let i=0;i<Math.ceil(a.size/CHUNK);i++){
   const bytes=e.ciphertext.subarray(i*CHUNK,(i+1)*CHUNK),name=path(h,a.assetId,i);
   a.chunks.push({index:i,path:name,size:bytes.length,sha256:await sha256Hex(bytes)});
   objects.set(name,bytes);
  }
  h.assets.push(a);
 }
 validateV3Header(h);
 return {header:h,chunk(name){const b=objects.get(name);if(!b)fail();return b.slice();}};
}
// The reader must use authenticated, private downloads. Never expose partial plaintext.
export async function readV3Wire(input,expected,readChunk){
 const h=structuredClone(input);validateV3Header(h);
 if(!expected||["archiveId","memoryId","operationId","revision","keyId"].some(k=>h[k]!==expected[k])||typeof readChunk!=="function")fail();
 const env=(kind,objectId,nonce,ciphertext)=>({version:1,archiveId:h.archiveId,objectId,kind,revision:h.revision,keyId:h.keyId,nonce:fromBase64Url(nonce,12),ciphertext});
 const assets=[];
 for(const a of h.assets){
  const bytes=new Uint8Array(a.size);let offset=0;
  for(const c of a.chunks){
   const b=await readChunk(c.path,c.size);
   if(!(b instanceof Uint8Array)||b.length!==c.size||await sha256Hex(b)!==c.sha256)fail();
   bytes.set(b,offset);offset+=b.length;
  }
  if(await sha256Hex(bytes)!==a.sha256)fail();
  assets.push(env("asset",a.assetId,a.nonce,bytes));
 }
 return validateV3Package({format:"archivito-sync-record-v3",archiveId:h.archiveId,memoryId:h.memoryId,operationId:h.operationId,revision:h.revision,keyId:h.keyId,
 metadata:env("metadata",h.memoryId,h.metadata.nonce,fromBase64Url(h.metadata.ciphertext,MAX_META)),assets});
}
// Server helper: independently verifies one bounded ciphertext block. This does
// NOT authenticate plaintext, prove key possession, or verify the whole asset.
export async function verifyV3Chunk(header,name,readChunk){
 const h=structuredClone(header);validateV3Header(h);
 const c=h.assets.flatMap(a=>a.chunks).find(c=>c.path===name);
 if(!c)fail();
 const b=await readChunk(c.path,c.size);
 if(!(b instanceof Uint8Array)||b.length!==c.size||await sha256Hex(b)!==c.sha256)fail();
 return {path:c.path,size:c.size,sha256:c.sha256};
}
