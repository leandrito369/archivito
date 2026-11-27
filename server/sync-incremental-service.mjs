// Trusted service only. Never accept an attestation from a client.
import {validateIncrementalWire,readIncrementalAsset,CHUNK} from "../app/sync-incremental-wire.mjs";
import {sha256Hex} from "../app/shared-crypto.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[0-9a-f]{64}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x),hex=x=>typeof x==="string"&&HEX.test(x);
const fail=()=>{throw Error("Operación incremental rechazada.");};
const exact=(x,k)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(a=>Object.hasOwn(x,a));
export function validateCatalog(c,q){
 if(!exact(c,["archiveId","memoryId","operationId","keyId","ref","chunks"])||c.archiveId!==q.archiveId||c.memoryId!==q.memoryId||c.operationId!==q.operationId||!hex(c.keyId))fail();
 const r=c.ref;
 if(!exact(r,["id","born","size","nonce","cipherSha256"])||r.id!==q.assetId||!Number.isSafeInteger(r.born)||r.born<1||!Number.isSafeInteger(r.size)||r.size<17||r.size>35*1024*1024+16||typeof r.nonce!=="string"||!/^[A-Za-z0-9_-]{16}$/.test(r.nonce)||!hex(r.cipherSha256))fail();
 if(!Array.isArray(c.chunks)||c.chunks.length!==Math.ceil(r.size/CHUNK))fail();
 for(let i=0;i<c.chunks.length;i++){
  const b=c.chunks[i];
  if(!exact(b,["index","path","size","sha256"])||b.index!==i||b.path!==[q.archiveId,q.memoryId,q.assetId,i].join("/")||b.size!==Math.min(CHUNK,r.size-i*CHUNK)||!hex(b.sha256))fail();
 }
 return c;
}
export function createIncrementalService({verifyUser,step,inspect,upload,download,enabled=false}){
 async function actor(token){
  if(enabled!==true||typeof token!=="string"||!token)fail();
  const u=await verifyUser(token);if(!u||!uuid(u.id))fail();return u.id;
 }
 async function load(user,a,o){
  if(!uuid(a)||!uuid(o))fail();
  const w=structuredClone(await inspect(user,a,"intent",null,o,null)),h=validateIncrementalWire(w);
  if(h.archiveId!==a||h.operationId!==o)fail();return {w,h};
 }
 async function readExact(b){
  const bytes=await download(b.path,b.size);
  if(!(bytes instanceof Uint8Array)||bytes.length!==b.size)fail();
  const copy=bytes.slice();if(await sha256Hex(copy)!==b.sha256)fail();return copy;
 }
 function query(q){
  if(!q||!uuid(q.archiveId)||!uuid(q.memoryId)||!uuid(q.operationId)||!uuid(q.assetId))fail();
  return {archiveId:q.archiveId,memoryId:q.memoryId,operationId:q.operationId,assetId:q.assetId};
 }
 async function catalog(user,q){
  return validateCatalog(structuredClone(await inspect(user,q.archiveId,"catalog",q.memoryId,q.operationId,q.assetId)),q);
 }
 return {
  async command(token,action,input){
   const u=await actor(token);
   if(!["begin","lookup","commit"].includes(action))fail();
   const w=structuredClone(input);validateIncrementalWire(w);return step(u,action,w);
  },
  async putBlock(token,{archiveId,operationId,path,bytes}={}){
   const u=await actor(token);
   if(typeof path!=="string"||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>CHUNK)fail();
   const snapshot=bytes.slice(),{w}=await load(u,archiveId,operationId);
   const b=w.uploads.flatMap(x=>x.chunks).find(x=>x.path===path);
   if(!b||snapshot.length!==b.size||await sha256Hex(snapshot)!==b.sha256)fail();
   const check=await step(u,"lookup",w);if(check?.state!=="staging")return check;
   if(await actor(token)!==u)fail();
   // Read existing bytes first to avoid a duplicate upload on retry. A corrupt
   // pre-existing object is never overwritten; final readback must succeed.
   const existing=await download(path,b.size);
   if(existing==null){try{await upload(path,snapshot);}catch{}}
   await readExact(b);
   if(await actor(token)!==u)fail();
   const after=await step(u,"lookup",w);
   return after?.state==="staging"?{state:"stored",operationId,path}:after;
  },
  async attestAsset(token,{archiveId,operationId,assetId}={}){
   const u=await actor(token);if(!uuid(assetId))fail();
   const {w,h}=await load(u,archiveId,operationId),r=h.refs.find(x=>x.id===assetId&&x.born===h.revision);
   if(!r)fail();
   const check=await step(u,"lookup",w);if(check?.state!=="staging")return check;
   // Independently check EVERY block and the full ciphertext hash before RPC.
   await readIncrementalAsset(w,h,r,async(path,size)=>{
    if(await actor(token)!==u)fail();
    return download(path,size);
   });
   if(await actor(token)!==u)fail();
   return step(u,"attest",w,{assetId:r.id,sha256:r.cipherSha256});
  },
  async manifest(token,{archiveId,memoryId,operationId=null}={}){
   const u=await actor(token);if(!uuid(archiveId)||!uuid(memoryId)||operationId!==null&&!uuid(operationId))fail();
   const w=await inspect(u,archiveId,operationId===null?"head":"revision",memoryId,operationId,null);
   if(w===null&&operationId===null)return null;
   const h=validateIncrementalWire(w);if(h.archiveId!==archiveId||h.memoryId!==memoryId||operationId!==null&&h.operationId!==operationId)fail();
   if(await actor(token)!==u)fail();return w;
  },
  async catalog(token,input){
   const q=query(input),u=await actor(token),c=await catalog(u,q);
   if(await actor(token)!==u)fail();return c;
  },
  async getBlock(token,input){
   const q=query(input),index=input.index,u=await actor(token);
   if(!Number.isSafeInteger(index)||index<0)fail();
   const c=await catalog(u,q),b=c.chunks[index];if(!b)fail();
   const bytes=await readExact(b);
   if(await actor(token)!==u)fail();
   const latest=await catalog(u,q);
   if(latest.keyId!==c.keyId||JSON.stringify(latest.ref)!==JSON.stringify(c.ref)||JSON.stringify(latest.chunks)!==JSON.stringify(c.chunks))fail();
   return bytes;
  }
 };
}
