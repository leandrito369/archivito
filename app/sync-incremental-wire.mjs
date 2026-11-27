// CLOUD-03.5C3A2 — JSON header and create-only chunks of NEW assets.
// No network. Existing refs retain their immutable birth descriptor.
import {validateIncrementalHeader,validateIncrementalDelta} from "./sync-incremental.mjs";
import {sha256Hex,toBase64Url,fromBase64Url} from "./shared-crypto.mjs";
export const CHUNK=4*1024*1024;
const FORMAT="archivito-incremental-wire-v1",MAX_HEADER=600000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,HEX=/^[0-9a-f]{64}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x),hex=x=>typeof x==="string"&&HEX.test(x);
const exact=(x,k)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(a=>Object.hasOwn(x,a));
const fail=()=>{throw Error("Wire incremental inválido.");};
const path=(h,r,i)=>[h.archiveId,h.memoryId,r.id,String(i)].join("/");
function validateBase(h,b){
 if(h.revision===1){if(b!==null)fail();}
 else if(!exact(b,["revision","operationId"])||b.revision!==h.revision-1||!uuid(b.operationId)||b.operationId===h.operationId)fail();
}
export function validateIncrementalWire(w){
 if(!exact(w,["format","header","base","uploads"])||w.format!==FORMAT||!Array.isArray(w.uploads)||w.uploads.length>100)fail();
 const h=w.header,e=h?.metadata;
 if(!exact(e,["version","archiveId","objectId","kind","revision","keyId","nonce","ciphertext"]))fail();
 const decoded=validateIncrementalHeader({...h,metadata:{...e,nonce:fromBase64Url(e.nonce,12),ciphertext:fromBase64Url(e.ciphertext,256*1024+16)}});
 validateBase(decoded,w.base);
 const fresh=new Map(decoded.refs.filter(r=>r.born===decoded.revision).map(r=>[r.id,r]));
 if(w.uploads.length!==fresh.size)fail();
 for(const u of w.uploads){
  if(!exact(u,["id","chunks"])||!fresh.has(u.id))fail();
  const r=fresh.get(u.id);fresh.delete(u.id);
  if(!Array.isArray(u.chunks)||u.chunks.length!==Math.ceil(r.size/CHUNK))fail();
  for(let i=0;i<u.chunks.length;i++){
   const c=u.chunks[i];
   if(!exact(c,["index","path","size","sha256"])||c.index!==i||c.path!==path(decoded,r,i)||c.size!==Math.min(CHUNK,r.size-i*CHUNK)||!hex(c.sha256))fail();
  }
 }
 if(new TextEncoder().encode(JSON.stringify(w)).length>MAX_HEADER)fail();
 return decoded;
}
export async function makeIncrementalWire(input,previous=null,expectedBase=null){
 const d=structuredClone(input),prior=structuredClone(previous),base=structuredClone(expectedBase);
 await validateIncrementalDelta(d,prior);
 const h=d.header;
 validateBase(h,base);
 if(prior&&(base.revision!==prior.revision||base.operationId!==prior.operationId))fail();
 const e=h.metadata,w={format:FORMAT,header:{...h,metadata:{...e,nonce:toBase64Url(e.nonce),ciphertext:toBase64Url(e.ciphertext)}},base,uploads:[]},objects=new Map();
 const byId=new Map(d.newAssets.map(a=>[a.id,a.ciphertext]));
 for(const r of h.refs){
  if(r.born!==h.revision)continue;
  const b=byId.get(r.id),chunks=[];
  for(let i=0;i<Math.ceil(b.length/CHUNK);i++){
   const bytes=b.subarray(i*CHUNK,(i+1)*CHUNK),name=path(h,r,i);
   chunks.push({index:i,path:name,size:bytes.length,sha256:await sha256Hex(bytes)});objects.set(name,bytes);
  }
  w.uploads.push({id:r.id,chunks});
 }
 validateIncrementalWire(w);
 return {wire:w,chunk(name){const b=objects.get(name);if(!b)fail();return b.slice();}};
}
// Reconstruct ONE immutable asset using its birth wire, not a later revision.
// Caller must obtain birth wire via authorized committed reference lookup.
export async function readIncrementalAsset(input,expected,ref,readChunk){
 const w=structuredClone(input),r=structuredClone(ref),h=validateIncrementalWire(w);
 if(!expected||h.archiveId!==expected.archiveId||h.memoryId!==expected.memoryId||h.keyId!==expected.keyId||h.revision!==r.born||typeof readChunk!=="function")fail();
 const source=h.refs.find(x=>x.id===r.id);
 if(!exact(r,["id","born","size","nonce","cipherSha256"])||!source||Object.keys(r).some(k=>source[k]!==r[k]))fail();
 const u=w.uploads.find(x=>x.id===r.id);if(!u)fail();
 const out=new Uint8Array(r.size);let offset=0;
 for(const c of u.chunks){
  const b=await readChunk(c.path,c.size);if(!(b instanceof Uint8Array)||b.length!==c.size)fail();
  const snap=b.slice();if(await sha256Hex(snap)!==c.sha256)fail();out.set(snap,offset);offset+=snap.length;
 }
 if(await sha256Hex(out)!==r.cipherSha256)fail();
 return out;
}
