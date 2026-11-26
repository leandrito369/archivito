// Explicit v3 transport. No automatic network, no real-library integration.
import {makeV3Wire,readV3Wire,validateV3Header} from "./sync-v3-wire.mjs";
import {validateV3Package} from "./sync-v3-contract.mjs";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x);
const fail=()=>{throw Error("Transporte v3 rechazado.");};
export function createV3Remote({client,url,publishableKey,scope,authorize,enabled=false,fetcher=globalThis.fetch}={}){
 if(!client||!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url||"")||!/^sb_publishable_[a-zA-Z0-9_-]+$/.test(publishableKey||"")||
 !uuid(scope?.userId)||!uuid(scope?.archiveId)||typeof scope?.keyId!=="string"||!HEX.test(scope.keyId)||typeof authorize!=="function"||typeof fetcher!=="function")fail();
 const s={userId:scope.userId,archiveId:scope.archiveId,keyId:scope.keyId};
 async function guard(){
  if(enabled!==true)fail();
  const a=await authorize();
  if(!a||a.unlocked!==true||a.userId!==s.userId||a.archiveId!==s.archiveId||a.keyId!==s.keyId||!["owner","editor"].includes(a.role))fail();
 }
 async function command(action,header,chunk){
  await guard();
  // getSession only retrieves the bearer credential; authorization is verified separately.
  const {data,error}=await client.auth.getSession();
  const session=data?.session;
  if(error||session?.user?.id!==s.userId||typeof session.access_token!=="string"||!session.access_token)fail();
  const endpoint=new URL(url+"/functions/v1/archivito-sync-v3");
  endpoint.searchParams.set("action",action);
  if(chunk){endpoint.searchParams.set("archiveId",header.archiveId);endpoint.searchParams.set("operationId",header.operationId);endpoint.searchParams.set("path",chunk.path);}
  await guard();
  const res=await fetcher(endpoint.href,{method:"POST",headers:{authorization:"Bearer "+session.access_token,apikey:publishableKey,"content-type":chunk?"application/octet-stream":"application/json"},body:chunk?chunk.bytes:JSON.stringify(header),cache:"no-store",redirect:"error"});
  if(!res.ok)fail();
  const r=await res.json();await guard();
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
   const wire=await makeV3Wire(p,expectedRevision),h=wire.header;
   const start=await command("begin",h);
   if(start.state!=="staging")return start;
   const verified=new Set(start.verifiedPaths);
   for(const c of h.assets.flatMap(a=>a.chunks)){
    if(verified.has(c.path))continue;
    const r=await command("block",h,{path:c.path,bytes:wire.chunk(c.path)});
    if(r.state!=="verified")return r;
   }
   const receipt=await command("commit",h);
   if(!["synced","conflict"].includes(receipt.state))fail();
   return receipt;
  },
  async read(remoteId,revision){
   await guard();
   if(!uuid(remoteId)||revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))fail();
   let query=client.from("sync_v3_intents").select("header,revision,operation_id,memory_id,archive_id").eq("archive_id",s.archiveId).eq("memory_id",remoteId).eq("committed",true);
   if(revision!==undefined)query=query.eq("revision",revision);
   const {data,error}=await query.order("revision",{ascending:false}).limit(1).maybeSingle();
   await guard();if(error)fail();if(!data)return null;
   const h=validateV3Header(data.header);
   const expected={archiveId:s.archiveId,memoryId:remoteId,operationId:data.operation_id,revision:data.revision,keyId:s.keyId};
   if(data.archive_id!==s.archiveId||data.memory_id!==remoteId||revision!==undefined&&data.revision!==revision)fail();
   const packet=await readV3Wire(h,expected,async(path,size)=>{
    await guard();
    const {data,error}=await client.storage.from("archivito-v3-private").download(path);
    await guard();if(error||!data||data.size!==size)fail();
    return new Uint8Array(await data.arrayBuffer());
   });
   await guard();return {expected,packet};
  }
 };
}
// One-shot worker. Never mark a job synced after a failed/invalid response.
export async function drainV3Once({outbox,remote,authorize}){
 await authorize();
 const job=await outbox.claim();
 if(!job)return {state:"idle"};
 let result;
 try{result=await remote.publish(job.packet,job.expectedRevision);await authorize();}
 catch{result={state:"error"};}
 const accepted=await outbox.finish(job.remoteId,job.token,result);
 return accepted?{state:result.state}:{state:"stale"};
}
