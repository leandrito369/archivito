// CLOUD-03.4C2: isolated durable v3 outbox, no network or automatic dispatch.
// A receipt advances the baseline and releases ciphertext in one IDB transaction.
import {encodeV3Record,validateV3Package} from "./sync-v3-contract.mjs";
import {acceptPublishReceipt} from "./sync-v3-revisions.mjs";
const DB="archivito-sync-v3-outbox-v1", MAX_JOBS=8, MAX_BYTES=256*1024*1024, LEASE=120000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x);
const local=x=>typeof x==="string"&&x.length>0&&x.length<=200;
const fail=()=>{throw Error("Operación de sincronización local inválida o en conflicto.");};
const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
function openDB(laboratory){
 return new Promise((resolve,reject)=>{
  const r=indexedDB.open(laboratory===true?DB+'-lab':DB,1);
  r.onupgradeneeded=()=>{
   r.result.createObjectStore("heads",{keyPath:["scope","remoteId"]});
   r.result.createObjectStore("jobs",{keyPath:["scope","remoteId"]});
   r.result.createObjectStore("packets",{keyPath:["scope","remoteId"]});
  };
  r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();resolve(db);};
  r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error("Cola v3 bloqueada."));
 });
}
async function transact(db,mode,work){
 const tx=db.transaction(["heads","jobs","packets"],mode);
 const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error("Transacción cancelada."));});
 done.catch(()=>{});
 try{const result=await work(tx.objectStore("heads"),tx.objectStore("jobs"),tx.objectStore("packets"));await done;return result;}
 catch(e){try{tx.abort();}catch{}await done.catch(()=>{});throw e;}
}
const size=p=>[p.metadata,...p.assets].reduce((n,e)=>n+e.nonce.byteLength+e.ciphertext.byteLength,0);
function sameBase(a,b){return (a?.revision??0)===(b?.revision??0)&&(a?.operationId??null)===(b?.operationId??null);}
const summary=j=>j?{remoteId:j.remoteId,localId:j.localId,operationId:j.operationId,revision:j.revision,encodedGeneration:j.encodedGeneration,state:j.state,attempts:j.attempts,actualRevision:j.actualRevision??null}:null;
export async function openV3Outbox({userId,archiveId,keyId}={},{laboratory=false}={}){
 if(!uuid(userId)||!uuid(archiveId)||typeof keyId!=="string"||!HEX.test(keyId))fail();
 // Key changes must never create a fresh baseline for the same identity.
 const scope=userId+"/"+archiveId,db=await openDB(laboratory);let closed=false;
 const run=(mode,work)=>{if(closed)fail();return transact(db,mode,work);};
 const pk=remoteId=>{if(!uuid(remoteId))fail();return [scope,remoteId];};
 function check(row,localId){if(row&&(row.keyId!==keyId||localId!==undefined&&row.localId!==localId))fail();}
 return {
  close(){closed=true;db.close();},
  async status(remoteId){
   const key=pk(remoteId);
   return run("readonly",async(h,j)=>{
    const b=await req(h.get(key)),job=await req(j.get(key));check(b);check(job);
    return {base:b?.base??null,baseGeneration:b?.baseGeneration??null,pending:summary(job),pull:b?.pull??null};
   });
  },
  // Bind the snapshot's generation to the exact encrypted bytes. The caller
  // obtains the snapshot from a single readonly library transaction.
  async prepare({key,record,remoteId,base=null}){
   if(!key||key.keyId!==keyId||!record||!local(record.id)||!uuid(record.syncGeneration))fail();
   const snapshot=structuredClone(record),pkey=pk(remoteId),localId=snapshot.id,g=snapshot.syncGeneration;
   const expected=base?.revision??0;
   if(!Number.isSafeInteger(expected)||expected<0||expected===Number.MAX_SAFE_INTEGER||
      (base!==null&&(expected<1||!uuid(base.operationId))))fail();
   const pre=await this.status(remoteId);
   if(pre.pull||!sameBase(pre.base,base))fail();
   if(pre.pending){
    if(pre.pending.localId!==localId)fail();
    return {state:"existing",pending:pre.pending};
   }
   if(pre.baseGeneration===g)return {state:"unchanged"};
   const packet=await encodeV3Record(key,{archiveId,memoryId:remoteId,operationId:crypto.randomUUID(),revision:expected+1},snapshot);
   validateV3Package(packet);
   const bytes=size(packet);
   return run("readwrite",async(h,j,p)=>{
    const current=await req(h.get(pkey)),old=await req(j.get(pkey));
    check(current,localId);check(old,localId);
    if(current?.pull||!sameBase(current?.base??null,base))fail();
    if(old)return {state:"existing",pending:summary(old)};
    if(current?.baseGeneration===g)return {state:"unchanged"};
    // Only small metadata rows are loaded to check quota, not other ciphertext.
    const jobs=await req(j.getAll());
    if(jobs.length>=MAX_JOBS||jobs.reduce((n,x)=>n+x.bytes,0)+bytes>MAX_BYTES)throw Error("Cola v3 llena; el recuerdo local se conserva.");
    const row={scope,remoteId,localId,keyId,encodedGeneration:g,operationId:packet.operationId,revision:packet.revision,expectedRevision:expected,
     base:base?structuredClone(base):null,bytes,state:"pending",attempts:0,createdAt:Date.now(),leaseUntil:0,token:null};
    await req(p.add({scope,remoteId,packet}));await req(j.add(row));
    return {state:"queued",pending:summary(row)};
   });
  },
  claim(){return run("readwrite",async(h,j,p)=>{
   const rows=(await req(j.getAll())).filter(x=>x.scope===scope&&x.keyId===keyId);
   const now=Date.now(),row=rows.filter(x=>x.state==="pending"||x.state==="uploading"&&x.leaseUntil<=now).sort((a,b)=>a.createdAt-b.createdAt||a.remoteId.localeCompare(b.remoteId))[0];
   if(!row)return null;
   const k=pk(row.remoteId),baseline=await req(h.get(k));check(baseline,row.localId);
   if(baseline?.pull||!sameBase(baseline?.base??null,row.base))fail();
   const stored=await req(p.get(k));if(!stored)fail();
   const packet=validateV3Package(stored.packet);
   if(packet.keyId!==keyId||packet.archiveId!==archiveId||packet.memoryId!==row.remoteId||packet.operationId!==row.operationId||packet.revision!==row.revision)fail();
   row.state="uploading";row.attempts++;row.token=crypto.randomUUID();row.leaseUntil=now+LEASE;
   await req(j.put(row));
   return {packet,remoteId:row.remoteId,operationId:row.operationId,expectedRevision:row.expectedRevision,encodedGeneration:row.encodedGeneration,token:row.token};
  });},
  finish(remoteId,token,result){return run("readwrite",async(h,j,p)=>{
   const k=pk(remoteId),row=await req(j.get(k));check(row);
   if(!row||row.state!=="uploading"||row.token!==token)return false;
   if(!result||!["synced","conflict","error"].includes(result.state))fail();
   if(result.state==="synced"){
    const current=await req(h.get(k));check(current,row.localId);
    if(current?.pull||!sameBase(current?.base??null,row.base))fail();
    const accepted=acceptPublishReceipt({receipt:result,operationId:row.operationId,expectedRevision:row.expectedRevision,encodedGeneration:row.encodedGeneration,currentGeneration:row.encodedGeneration});
    await req(h.put({scope,remoteId,localId:row.localId,keyId,base:accepted.base,baseGeneration:accepted.baseGeneration}));
    await req(j.delete(k));await req(p.delete(k));
   }else{
    if(result.state==="conflict"&&(!Number.isSafeInteger(result.actualRevision)||result.actualRevision<0))fail();
    row.state=result.state;row.actualRevision=result.state==="conflict"?result.actualRevision:null;row.token=null;row.leaseUntil=0;
    await req(j.put(row));
   }
   return true;
  });},
  // Reserve an inbound revision before touching the separate library DB.
  // No ciphertext or plaintext is persisted here; caller can refetch exact packet.
  reservePull({remoteId,localId,base,baseGeneration,target,digest,expectedLocalGeneration}){
   if(!local(localId)||!target||!uuid(target.operationId)||!Number.isSafeInteger(target.revision)||target.revision<1||
      typeof digest!=="string"||!HEX.test(digest)||target.revision<=(base?.revision??0)||
      expectedLocalGeneration!==baseGeneration||
      (base===null?baseGeneration!==null:!uuid(baseGeneration)||!uuid(base.operationId)||!Number.isSafeInteger(base.revision)||base.revision<1))fail();
   const k=pk(remoteId);
   return run("readwrite",async(h,j)=>{
    const current=await req(h.get(k)),job=await req(j.get(k));check(current,localId);check(job,localId);
    if(job||!sameBase(current?.base??null,base)||(current?.baseGeneration??null)!==baseGeneration)fail();
    if(current?.pull){
     const x=current.pull;
     if(!sameBase(x.target,target)||x.digest!==digest||x.expectedLocalGeneration!==expectedLocalGeneration)fail();
     return x;
    }
    const pull={target:{revision:target.revision,operationId:target.operationId},digest,expectedLocalGeneration,newGeneration:crypto.randomUUID()};
    await req(h.put({scope,remoteId,localId,keyId,base,baseGeneration,pull}));return pull;
   });
  },
  finishPull({remoteId,localId,newGeneration,digest}){
   return run("readwrite",async(h,j)=>{
    const k=pk(remoteId),row=await req(h.get(k));check(row,localId);
    if(!row?.pull||row.pull.newGeneration!==newGeneration||row.pull.digest!==digest||await req(j.get(k)))fail();
    await req(h.put({scope,remoteId,localId,keyId,base:row.pull.target,baseGeneration:newGeneration}));
    return {base:row.pull.target,baseGeneration:newGeneration};
   });
  },
  retry(remoteId){return run("readwrite",async(h,j)=>{
   const k=pk(remoteId),row=await req(j.get(k));check(row);
   if(!row||row.state!=="error")return false;
   row.state="pending";await req(j.put(row));return true;
  });}
 };
}
// Read-only snapshot of the actual library. Does not create/upgrade it or mark legacy records.
export async function readLocalV3Snapshot(localId){
 if(!local(localId))fail();
 const db=await new Promise((resolve,reject)=>{
  const r=indexedDB.open("nuestro-archivo-cartas-v1",1);
  r.onupgradeneeded=()=>r.transaction.abort();
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  r.onblocked=()=>reject(Error("Biblioteca bloqueada."));
 });
 try{
  const record=await req(db.transaction("letters","readonly").objectStore("letters").get(localId));
  if(!record||record.schemaVersion!==3||!uuid(record.syncGeneration))throw Error("Recuerdo sin generación válida; requiere preparación explícita.");
  return record;
 }finally{db.close();}
}
// No upload here. The identity binding is resolved before reading the snapshot;
// a crash after allocation is harmless, as the same identity is reused.
export async function prepareLocalV3({identity,outbox,key,localId}){
 const binding=await identity.allocate(localId),record=await readLocalV3Snapshot(localId);
 const {base}=await outbox.status(binding.remoteId);
 return outbox.prepare({key,record,remoteId:binding.remoteId,base});
}
