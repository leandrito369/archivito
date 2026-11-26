// Explicit v3 transport. No automatic network, no real-library integration.
import {makeV3Wire,readV3Wire,validateV3Header} from "./sync-v3-wire.mjs";
import {validateV3Package} from "./sync-v3-contract.mjs";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x);
const fail=()=>{throw Error("Transporte v3 rechazado.");};
export function createV3Remote({client,url,publishableKey,scope,authorize,enabled=false,fetcher=globalThis.fetch,localGuard,concurrency=1,metrics,onProgress}={}){
 if(!client||!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url||"")||!/^sb_publishable_[a-zA-Z0-9_-]+$/.test(publishableKey||"")||
 !uuid(scope?.userId)||!uuid(scope?.archiveId)||typeof scope?.keyId!=="string"||!HEX.test(scope.keyId)||typeof authorize!=="function"||typeof fetcher!=="function")fail();
 if(![1,2].includes(concurrency)||localGuard!==undefined&&typeof localGuard!=="function")fail();
 const s={userId:scope.userId,archiveId:scope.archiveId,keyId:scope.keyId};
 const measure=(phase,work,bytes=0)=>metrics?metrics.measure(phase,work,bytes):work();
 function check(a){
  if(enabled!==true||!a||a.unlocked!==true||a.userId!==s.userId||a.archiveId!==s.archiveId||a.keyId!==s.keyId||!["owner","editor"].includes(a.role))fail();
 }
 async function guard(){if(enabled!==true)fail();check(await measure("auth",authorize));if(localGuard)check(localGuard());}
 async function ioGuard(){if(localGuard)check(localGuard());else await guard();}
 function progress(phase,done,total){try{onProgress?.({phase,done,total});}catch{}}
 // At most two active requests; await all started requests, even on failure.
 async function batch(items,work){
  const settled=await Promise.allSettled(items.map(item=>work(item)));
  const failed=settled.find(x=>x.status==="rejected");if(failed)throw failed.reason;
  return settled.map(x=>x.value);
 }
 async function command(action,header,chunk){
  await ioGuard();
  // getSession only retrieves the bearer credential; authorization is verified separately.
  const {data,error}=await client.auth.getSession();
  const session=data?.session;
  if(error||session?.user?.id!==s.userId||typeof session.access_token!=="string"||!session.access_token)fail();
  const endpoint=new URL(url+"/functions/v1/archivito-sync-v3");
  endpoint.searchParams.set("action",action);
  if(chunk){endpoint.searchParams.set("archiveId",header.archiveId);endpoint.searchParams.set("operationId",header.operationId);endpoint.searchParams.set("path",chunk.path);}
  await ioGuard();
  const r=await measure(action,async()=>{
   const res=await fetcher(endpoint.href,{method:"POST",headers:{authorization:"Bearer "+session.access_token,apikey:publishableKey,"content-type":chunk?"application/octet-stream":"application/json"},body:chunk?chunk.bytes:JSON.stringify(header),cache:"no-store",redirect:"error"});
   if(!res.ok)fail();return res.json();
  },chunk?.bytes.byteLength??0);
  await ioGuard();
  if(!r||r.operationId!==header.operationId)fail();
  if(r.state==="synced"){
   if(r.revision!==header.revision||typeof r.replayed!=="boolean")fail();
   return {state:r.state,operationId:r.operationId,revision:r.revision,replayed:r.replayed};
  }
  if(r.state==="conflict"){
   if(!Number.isSafeInteger(r.actualRevision)||r.actualRevision<0||r.actualRevision===header.expectedRevision)fail();
   return {state:r.state,operationId:r.operationId,actualRevision:r.actualRevision};
  }
  if(r.state==="staging"&&(action==="begin"||action==="lookup")){
   const known=new Set(header.assets.flatMap(a=>a.chunks.map(c=>c.path)));
   if(!Array.isArray(r.verifiedPaths)||new Set(r.verifiedPaths).size!==r.verifiedPaths.length||r.verifiedPaths.some(p=>!known.has(p)))fail();
   return {state:"staging",verifiedPaths:r.verifiedPaths};
  }
  if(action==="block"&&r.state==="verified"&&r.path===chunk.path)return {state:"verified"};
  fail();
 }
 return {
  async publish(packet,expectedRevision){
   await guard();
   const p=structuredClone(packet);validateV3Package(p);
   if(p.archiveId!==s.archiveId||p.keyId!==s.keyId)fail();
   const wire=await measure("wire",()=>makeV3Wire(p,expectedRevision)),h=wire.header;
   if(localGuard)await guard();
   const start=await command("begin",h);
   if(localGuard)await guard();
   if(start.state!=="staging")return start;
   const verified=new Set(start.verifiedPaths),all=h.assets.flatMap(a=>a.chunks),missing=all.filter(c=>!verified.has(c.path));
   let done=verified.size;progress("upload",done,all.length);
   for(let i=0;i<missing.length;i+=concurrency){
    const results=await batch(missing.slice(i,i+concurrency),c=>command("block",h,{path:c.path,bytes:wire.chunk(c.path)}));
    if(localGuard)await guard();
    const terminal=results.filter(r=>r.state!=="verified");
    if(terminal.length){
     if(terminal.some(r=>r.state!==terminal[0].state||r.revision!==terminal[0].revision||r.actualRevision!==terminal[0].actualRevision))fail();
     return terminal[0];
    }
    done+=results.length;progress("upload",done,all.length);
   }
   progress("commit",done,all.length);
   const receipt=await command("commit",h);
   if(localGuard)await guard();
   if(!["synced","conflict"].includes(receipt.state))fail();
   return receipt;
  },
  async read(remoteId,revision){
   await guard();
   if(!uuid(remoteId)||revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))fail();
   let query=client.from("sync_v3_intents").select("header,revision,operation_id,memory_id,archive_id").eq("archive_id",s.archiveId).eq("memory_id",remoteId).eq("committed",true);
   if(revision!==undefined)query=query.eq("revision",revision);
   const {data,error}=await measure("header",()=>query.order("revision",{ascending:false}).limit(1).maybeSingle());
   await guard();if(error)fail();if(!data)return null;
   const h=validateV3Header(data.header);
   const expected={archiveId:s.archiveId,memoryId:remoteId,operationId:data.operation_id,revision:data.revision,keyId:s.keyId};
   if(data.archive_id!==s.archiveId||data.memory_id!==remoteId||revision!==undefined&&data.revision!==revision)fail();
   let done=0;const total=h.assets.reduce((n,a)=>n+a.chunks.length,0);progress("download",done,total);
   const packet=await measure("reconstruct",()=>readV3Wire(h,expected,async(path,size)=>{
    await ioGuard();
    const bytes=await measure("download",async()=>{
     const {data,error}=await client.storage.from("archivito-v3-private").download(path);
     if(error||!data||data.size!==size)fail();return new Uint8Array(await data.arrayBuffer());
    },size);
    await ioGuard();progress("download",++done,total);
    return bytes;
   }));
   await guard();return {expected,packet};
  }
 };
}
// One-shot worker. Never mark a job synced after a failed/invalid response.
export async function drainV3Once({outbox,remote,authorize,metrics}){
 await authorize();
 const job=await (metrics?metrics.measure('queue',()=>outbox.claim()):outbox.claim());
 if(!job)return {state:"idle"};
 let result;
 try{result=await remote.publish(job.packet,job.expectedRevision);await authorize();}
 catch{result={state:"error"};}
 const accepted=await (metrics?metrics.measure('queue',()=>outbox.finish(job.remoteId,job.token,result)):outbox.finish(job.remoteId,job.token,result));
 return accepted?{state:result.state}:{state:"stale"};
}
