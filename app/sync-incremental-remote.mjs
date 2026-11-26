// Explicit authenticated HTTP adapter. No automatic synchronization or DB writes.
import {validateIncrementalWire,CHUNK} from "./sync-incremental-wire.mjs";
import {sha256Hex} from "./shared-crypto.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[0-9a-f]{64}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x),hex=x=>typeof x==="string"&&HEX.test(x);
const fail=()=>{throw Error("Transporte incremental rechazado; conservar operación pendiente.");};
const sameRef=(a,b)=>a&&b&&["id","born","size","nonce","cipherSha256"].every(k=>a[k]===b[k]);
export function createIncrementalRemote({client,url,publishableKey,scope,authorize,localGuard,fetcher=globalThis.fetch,enabled=false,metrics,onProgress,timeoutMs=120000}={}){
 if(!client||!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url||"")||!/^sb_publishable_[a-zA-Z0-9_-]+$/.test(publishableKey||"")||
 !uuid(scope?.userId)||!uuid(scope?.archiveId)||!hex(scope?.keyId)||typeof authorize!=="function"||typeof fetcher!=="function"||
 localGuard!==undefined&&typeof localGuard!=="function"||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)fail();
 const s={userId:scope.userId,archiveId:scope.archiveId,keyId:scope.keyId};
 const measure=(phase,work,bytes=0)=>metrics?metrics.measure(phase,work,bytes):work();
 function check(a){if(enabled!==true||!a||a.unlocked!==true||a.userId!==s.userId||a.archiveId!==s.archiveId||a.keyId!==s.keyId||!["owner","editor"].includes(a.role))fail();}
 async function guard(){if(enabled!==true)fail();check(await measure("auth",authorize));if(localGuard)check(localGuard());}
 async function ioGuard(){if(localGuard)check(localGuard());else await guard();}
 function progress(phase,done,total){try{onProgress?.({phase,done,total});}catch{}}
 function scopeHeader(h){if(h.archiveId!==s.archiveId||h.keyId!==s.keyId)fail();}
 async function request(action,body,{block,binarySize,signal,assertLease}={}){
  if(assertLease)await assertLease();
  await ioGuard();
  const {data,error}=await client.auth.getSession(),session=data?.session;
  if(error||session?.user?.id!==s.userId||typeof session.access_token!=="string"||!session.access_token)fail();
  const endpoint=new URL(url+"/functions/v1/archivito-sync-incremental");
  endpoint.searchParams.set("action",action);
  if(block)for(const k of ["archiveId","operationId","path"])endpoint.searchParams.set(k,block[k]);
  await ioGuard();
  if(assertLease)await assertLease();
  const controller=new AbortController(),cancel=()=>controller.abort();
  if(signal?.aborted)fail();
  signal?.addEventListener("abort",cancel,{once:true});
  const timer=setTimeout(cancel,timeoutMs);
  try{
   const value=await measure(action,async()=>{
    const res=await fetcher(endpoint.href,{method:"POST",headers:{authorization:"Bearer "+session.access_token,apikey:publishableKey,"content-type":block?"application/octet-stream":"application/json"},body:block?block.bytes:JSON.stringify(body),cache:"no-store",redirect:"error",signal:controller.signal});
    if(!res.ok)fail();
    if(binarySize!==undefined){
     if(res.headers.get("content-type")?.split(";")[0]!=="application/octet-stream")fail();
     const reader=res.body?.getReader();if(!reader)fail();const bytes=new Uint8Array(binarySize);let off=0;
     try{for(;;){const {done,value}=await reader.read();if(done)break;if(off+value.length>binarySize)fail();bytes.set(value,off);off+=value.length;}}finally{await reader.cancel().catch(()=>{});}
     if(off!==binarySize)fail();return bytes;
    }
    const reader=res.body?.getReader();if(!reader)fail();const parts=[];let n=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>600000)fail();parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(n);let off=0;for(const part of parts){bytes.set(part,off);off+=part.length;}
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
   },block?.bytes.length??binarySize??0);
   await ioGuard();if(assertLease)await assertLease();if(signal?.aborted)fail();return value;
  }finally{clearTimeout(timer);signal?.removeEventListener("abort",cancel);}
 }
 function receipt(r,h){
  if(!r||r.operationId!==h.operationId)fail();
  if(r.state==="synced"){if(r.revision!==h.revision||typeof r.replayed!=="boolean")fail();return {state:"synced",operationId:r.operationId,revision:r.revision,replayed:r.replayed};}
  if(r.state==="conflict"){if(!Number.isSafeInteger(r.actualRevision)||r.actualRevision<0||(r.actualRevision===0?r.actualOperationId!==null:!uuid(r.actualOperationId)))fail();return {state:"conflict",operationId:r.operationId,actualRevision:r.actualRevision,actualOperationId:r.actualOperationId};}
  return null;
 }
 return {
  // Exact wire and exact chunk reader can be persisted independently of this adapter.
  // Aborted requests may already have reached the server. Never regenerate the operation.
  async publish(input,readChunk,{signal,assertLease}={}){
   if(assertLease!==undefined&&typeof assertLease!=="function")fail();
   await guard();
   const w=structuredClone(input),h=validateIncrementalWire(w);scopeHeader(h);if(typeof readChunk!=="function")fail();
   const start=await request("begin",w,{signal,assertLease}),terminal=receipt(start,h);
   if(terminal){await guard();return terminal;}
   const known=new Set(w.uploads.map(x=>x.id));
   if(start.state!=="staging"||!Array.isArray(start.verifiedAssets)||new Set(start.verifiedAssets).size!==start.verifiedAssets.length||start.verifiedAssets.some(x=>!known.has(x)))fail();
   const verified=new Set(start.verifiedAssets),total=w.uploads.length;let done=verified.size;progress("upload",done,total);
   for(const u of w.uploads){
    if(verified.has(u.id))continue;
    for(const b of u.chunks){
     const bytes=await readChunk(b.path);if(!(bytes instanceof Uint8Array)||bytes.length!==b.size)fail();
     const snapshot=bytes.slice();if(await sha256Hex(snapshot)!==b.sha256)fail();
     const r=await request("block",null,{block:{archiveId:h.archiveId,operationId:h.operationId,path:b.path,bytes:snapshot},signal,assertLease});
     const end=receipt(r,h);if(end){await guard();return end;}
     if(r.state!=="stored"||r.path!==b.path)fail();
    }
    const r=await request("attest",{archiveId:h.archiveId,operationId:h.operationId,assetId:u.id},{signal,assertLease});
    const end=receipt(r,h);if(end){await guard();return end;}
    if(r.state!=="verified"||r.assetId!==u.id)fail();
    await guard();progress("upload",++done,total);
   }
   progress("commit",done,total);const end=receipt(await request("commit",w,{signal,assertLease}),h);
   if(!end)fail();await guard();return end;
  },
  async manifest(memoryId,operationId=null,{signal}={}){
   await guard();if(!uuid(memoryId)||operationId!==null&&!uuid(operationId))fail();
   const w=await request("manifest",{archiveId:s.archiveId,memoryId,operationId},{signal});
   await guard();if(w===null&&operationId===null)return null;
   const h=validateIncrementalWire(w);scopeHeader(h);
   if(h.memoryId!==memoryId||operationId!==null&&h.operationId!==operationId)fail();
   return {header:h,wire:w,expected:{archiveId:h.archiveId,memoryId:h.memoryId,operationId:h.operationId,revision:h.revision,keyId:h.keyId}};
  },
  async readAsset(expected,ref,{signal}={}){
   await guard();if(expected?.archiveId!==s.archiveId||expected?.keyId!==s.keyId||!uuid(expected?.memoryId)||!uuid(expected?.operationId)||!uuid(ref?.id)||!Number.isSafeInteger(ref.size)||ref.size<17||ref.size>35*1024*1024+16)fail();
   const q={archiveId:s.archiveId,memoryId:expected.memoryId,operationId:expected.operationId,assetId:ref.id};
   const c=await request("catalog",q,{signal});
   if(!c||c.archiveId!==q.archiveId||c.memoryId!==q.memoryId||c.operationId!==q.operationId||c.keyId!==s.keyId||!sameRef(c.ref,ref)||!Array.isArray(c.chunks)||c.chunks.length!==Math.ceil(ref.size/CHUNK))fail();
   const out=new Uint8Array(ref.size);let off=0;
   for(let i=0;i<c.chunks.length;i++){
    const b=c.chunks[i];if(b.index!==i||b.path!==[q.archiveId,q.memoryId,q.assetId,i].join("/")||b.size!==Math.min(CHUNK,ref.size-off)||!hex(b.sha256))fail();
    const bytes=await request("download",{...q,index:i},{binarySize:b.size,signal});if(await sha256Hex(bytes)!==b.sha256)fail();
    out.set(bytes,off);off+=bytes.length;progress("download",i+1,c.chunks.length);
   }
   if(await sha256Hex(out)!==ref.cipherSha256)fail();await guard();return out;
  }
 };
}
