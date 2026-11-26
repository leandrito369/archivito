// CLOUD-03.4C3 — explicit inbound v3 revision; offline, no network or UI.
// Call only with an authenticated remote head and verified session in future.
import {decodeV3Record,validateV3Package} from "./sync-v3-contract.mjs";
import {sha256Hex,toBase64Url} from "./shared-crypto.mjs";
import {openV3IdentityMap} from "./sync-v3-identity.mjs";
import {openV3Outbox} from "./sync-v3-outbox.mjs";
import {planReconciliation} from "./sync-v3-revisions.mjs";
const UUID=/^[a-f0-9]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x);
const fail=()=>{throw Error("Revisión entrante bloqueada; no se sobrescribió el recuerdo local.");};
const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
async function library(laboratory){
 return new Promise((resolve,reject)=>{
  const r=indexedDB.open(laboratory===true?"archivito-v3-lab-library-v1":"nuestro-archivo-cartas-v1",1);
  r.onupgradeneeded=()=>{if(laboratory===true)r.result.createObjectStore("letters",{keyPath:"id"});else r.transaction.abort();};
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  r.onblocked=()=>reject(Error("Biblioteca bloqueada."));
 });
}
async function transact(db,mode,work){
 const tx=db.transaction("letters",mode),s=tx.objectStore("letters");
 const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error("Transacción cancelada."));});
 done.catch(()=>{});
 try{const result=await work(s);await done;return result;}
 catch(e){try{tx.abort();}catch{}await done.catch(()=>{});throw e;}
}
async function digest(p){
 const env=async e=>[e.version,e.archiveId,e.objectId,e.kind,e.revision,e.keyId,toBase64Url(e.nonce),await sha256Hex(e.ciphertext)];
 return sha256Hex(new TextEncoder().encode(JSON.stringify([p.format,p.archiveId,p.memoryId,p.operationId,p.revision,p.keyId,await env(p.metadata),await Promise.all(p.assets.map(env))])));
}
// The import path uses an explicit fresh local UUID, never the remote manifest's
// local ID. Existing bindings always retain their local ID.
export async function applyV3Pull({scope,key,expected,packet,localId,validateImage,makeThumb,laboratory=false}){
 const p=structuredClone(packet);validateV3Package(p);
 if(!scope||key?.keyId!==scope.keyId||p.archiveId!==scope.archiveId||p.keyId!==scope.keyId||
 !expected||p.archiveId!==expected.archiveId||p.memoryId!==expected.memoryId||p.operationId!==expected.operationId||p.revision!==expected.revision)fail();
 const target={revision:p.revision,operationId:p.operationId},hash=await digest(p);
 // Validate all content before reserving or writing anything.
 const decoded=await decodeV3Record(key,expected,p,{validateImage,makeThumb});
 const identity=await openV3IdentityMap(scope,{laboratory});
 let outbox,db;
 try{
  outbox=await openV3Outbox(scope,{laboratory});db=await library(laboratory);
  let binding=await identity.byRemote(p.memoryId);
  if(binding&&localId!==undefined&&binding.localId!==localId)fail();
  if(!binding){
   // Never bind a remote item to an existing local item implicitly.
   if(!uuid(localId)||await transact(db,"readonly",s=>req(s.get(localId))))fail();
   binding=await identity.bind(localId,p.memoryId);
  }
  const id=binding.localId,st=await outbox.status(p.memoryId);
  if(st.pending) return {state:"blocked",reason:"outgoing-pending"};
  const current=await transact(db,"readonly",s=>req(s.get(id)));
  if(current&&!uuid(current.syncGeneration))return {state:"blocked",reason:"legacy-local"};
  let reservation=st.pull;
  if(reservation){
   if(reservation.digest!==hash||reservation.target.revision!==target.revision||reservation.target.operationId!==target.operationId)return {state:"blocked",reason:"different-pull-pending"};
  }else{
   const plan=planReconciliation({base:st.base,remote:target,localGeneration:current?.syncGeneration??null,baseGeneration:st.baseGeneration});
   if(!["import","pull"].includes(plan.action))return {state:plan.action,reason:plan.reason??null};
   reservation=await outbox.reservePull({remoteId:p.memoryId,localId:id,base:st.base,baseGeneration:st.baseGeneration,target,digest:hash,expectedLocalGeneration:current?.syncGeneration??null});
  }
  const state=await transact(db,"readwrite",async s=>{
   const latest=await req(s.get(id));
   if(latest?.syncGeneration===reservation.newGeneration)return "already-applied";
   // Absent only when importing. A missing existing record is never recreated.
   if(reservation.expectedLocalGeneration===null?Boolean(latest):latest?.syncGeneration!==reservation.expectedLocalGeneration)return "conflict";
   const record={...decoded,id,syncGeneration:reservation.newGeneration};
   if(latest)await req(s.put(record));else await req(s.add(record));
   return "applied";
  });
  if(state==="conflict")return {state:"blocked",reason:"local-changed-during-pull"};
  // Cross-database journal remains if this step fails. Re-fetch exact packet to resume.
  const baseline=await outbox.finishPull({remoteId:p.memoryId,localId:id,newGeneration:reservation.newGeneration,digest:hash});
  return {state,localId:id,...baseline};
 }finally{db?.close();outbox?.close();identity.close();}
}
