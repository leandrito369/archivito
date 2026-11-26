// CLOUD-03.5C3A. Pure, dry-run only. Never mutates records, deletes objects or
// authorizes deletion. Inputs must be complete and collected under an archive lock.
export const RETENTION=Object.freeze({recentRevisions:10,recentDays:30,trashDays:30,stagingDays:7,approvalGraceDays:7,quotaBytes:256*1024*1024});
const DAY=86400000,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x),nat=x=>Number.isSafeInteger(x)&&x>=0;
const fail=()=>{throw Error("Inventario de retención incompleto o inconsistente; limpieza bloqueada.");};
const exact=(x,keys)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
function time(x,now){if(!nat(x)||x>now)fail();return x;}
function sum(a,b){const n=a+b;if(!nat(n))fail();return n;}
export function quotaStatus(usedBytes){
 if(!nat(usedBytes))fail();
 const q=RETENTION.quotaBytes;
 return {usedBytes,quotaBytes:q,state:usedBytes>=q?"blocked":usedBytes>=Math.ceil(q*.85)?"critical":usedBytes>=Math.ceil(q*.7)?"warning":"normal",availableBytes:Math.max(0,q-usedBytes)};
}
// "complete" is an assertion by a trusted future inventory adapter, not proof.
// All committed revisions, stored assets and live/staged intent references are required.
// Trash and final erasure are separate lifecycle operations, never inferred here.
export function planRetention(input){
 const x=structuredClone(input);
 if(!exact(x,["archiveId","now","complete","revisions","assets","intents","otherReservedBytes"])||!uuid(x.archiveId)||!nat(x.now)||x.complete!==true||!Array.isArray(x.revisions)||!Array.isArray(x.assets)||!Array.isArray(x.intents)||!nat(x.otherReservedBytes))fail();
 const now=x.now,assets=new Map(),histories=new Map(),ops=new Set(),allRefs=new Set(),protectedRefs=new Set(),intentRefs=new Set();
 let bytes=x.otherReservedBytes;
 for(const a of x.assets){
  if(!exact(a,["id","memoryId","bytes"])||!uuid(a.id)||!uuid(a.memoryId)||!nat(a.bytes)||a.bytes<1||assets.has(a.id))fail();
  assets.set(a.id,a);bytes=sum(bytes,a.bytes);
 }
 function refs(row,allowMissing=false){
  if(!Array.isArray(row.refs)||row.refs.length<1||row.refs.length>100||new Set(row.refs).size!==row.refs.length)fail();
  for(const id of row.refs){
   if(!uuid(id))fail();
   const a=assets.get(id);
   if((!a&&!allowMissing)||(a&&a.memoryId!==row.memoryId))fail();
  }
 }
 for(const r of x.revisions){
  if(!exact(r,["memoryId","revision","operationId","committedAt","pinned","refs"])||!uuid(r.memoryId)||!uuid(r.operationId)||ops.has(r.operationId)||!nat(r.revision)||r.revision<1||typeof r.pinned!=="boolean")fail();
  time(r.committedAt,now);refs(r);ops.add(r.operationId);
  const list=histories.get(r.memoryId)??[];list.push(r);histories.set(r.memoryId,list);
  for(const id of r.refs)allRefs.add(id);
 }
 const protectedRevisions=[],eligibleRevisions=[];
 for(const list of histories.values()){
  list.sort((a,b)=>b.revision-a.revision);
  if(list.at(-1).revision!==1||new Set(list.map(r=>r.revision)).size!==list.length)fail();
  // Non-contiguous history is allowed only because earlier pruning may have
  // occurred; the original revision and current head must remain available.
  for(let i=0;i<list.length;i++){
   const r=list[i],reasons=[];
   if(i===0)reasons.push("head");
   if(r.revision===1)reasons.push("original");
   if(i<RETENTION.recentRevisions)reasons.push("recent-count");
   if(now-r.committedAt<=RETENTION.recentDays*DAY)reasons.push("recent-time");
   if(r.pinned)reasons.push("pinned");
   const item={memoryId:r.memoryId,revision:r.revision,operationId:r.operationId};
   if(reasons.length){protectedRevisions.push({...item,reasons});for(const id of r.refs)protectedRefs.add(id);}
   else eligibleRevisions.push(item);
  }
 }
 const fenceCandidates=[],fencedCandidates=[];
 for(const i of x.intents){
  if(!exact(i,["memoryId","operationId","state","lastActivity","leaseUntil","inFlight","refs"])||!uuid(i.memoryId)||!uuid(i.operationId)||ops.has(i.operationId)||!["staging","fenced"].includes(i.state)||typeof i.inFlight!=="boolean"||!nat(i.leaseUntil))fail();
  time(i.lastActivity,now);refs(i,true);ops.add(i.operationId);
  // Until actual cleanup finalizes, even fenced intent references protect assets.
  for(const id of i.refs)intentRefs.add(id);
  if(now-i.lastActivity>=RETENTION.stagingDays*DAY&&i.leaseUntil<=now&&!i.inFlight){
   (i.state==="fenced"?fencedCandidates:fenceCandidates).push(i.operationId);
  }
 }
 const potentialAssets=[],quarantinedAssets=[];
 let potentialBytes=0;
 for(const [id,a] of assets){
  // Unknown orphans are investigated, never automatically reclaimed.
  if(!allRefs.has(id)&&!intentRefs.has(id))quarantinedAssets.push(id);
  else if(allRefs.has(id)&&!protectedRefs.has(id)&&!intentRefs.has(id)){
   potentialAssets.push(id);potentialBytes=sum(potentialBytes,a.bytes);
  }
 }
 return {archiveId:x.archiveId,protectedRevisions,eligibleRevisions,potentialAssets,potentialBytes,quarantinedAssets,
  fenceCandidates,fencedCandidates,quota:quotaStatus(bytes),deletionAuthorized:false};
}
