// Stable one-to-one identity mapping, isolated from the current library and queue.
// Local ID is never changed. Scope is a logical namespace, not authorization.
const DB="archivito-sync-v3-identity-v1", STORE="bindings";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x);
const local=x=>typeof x==="string"&&x.length>0&&x.length<=200;
const fail=()=>{throw Error("Vinculación de identidad inválida o en conflicto.");};
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
async function openDB(laboratory){
 return new Promise((resolve,reject)=>{
  const r=indexedDB.open(laboratory===true?DB+'-lab':DB,1);
  r.onupgradeneeded=()=>{const s=r.result.createObjectStore(STORE,{keyPath:["scope","localId"]});s.createIndex("remote",["scope","remoteId"],{unique:true});};
  r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();resolve(db);};
  r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error("Base de identidad bloqueada."));
 });
}
export async function openV3IdentityMap({userId,archiveId}={},{laboratory=false}={}){
 if(!uuid(userId)||!uuid(archiveId))fail();
 const scope=userId+"/"+archiveId,db=await openDB(laboratory);
 let closed=false;
 async function run(mode,work){
  if(closed)fail();
  const tx=db.transaction(STORE,mode),s=tx.objectStore(STORE);
  const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error("Transacción cancelada."));});
  done.catch(()=>{});
  try{const result=await work(s);await done;return result;}
  catch(e){try{tx.abort();}catch{}await done.catch(()=>{});throw e;}
 }
 const publicRow=r=>r?{localId:r.localId,remoteId:r.remoteId}:null;
 async function bind(localId,remoteId){
  if(!local(localId)||!uuid(remoteId))fail();
  return run("readwrite",async s=>{
   const old=await request(s.get([scope,localId]));
   if(old){if(old.remoteId!==remoteId)fail();return publicRow(old);}
   if(await request(s.index("remote").get([scope,remoteId])))fail();
   const row={scope,localId,remoteId};await request(s.add(row));return publicRow(row);
  });
 }
 return {
  close(){closed=true;db.close();},
  bind,
  async allocate(localId){
   if(!local(localId))fail();
   return run("readwrite",async s=>{
    const old=await request(s.get([scope,localId]));if(old)return publicRow(old);
    const remoteId=crypto.randomUUID(),row={scope,localId,remoteId};
    await request(s.add(row));return publicRow(row);
   });
  },
  byLocal(localId){if(!local(localId))fail();return run("readonly",async s=>publicRow(await request(s.get([scope,localId]))));},
  byRemote(remoteId){if(!uuid(remoteId))fail();return run("readonly",async s=>publicRow(await request(s.index("remote").get([scope,remoteId]))));}
 };
}
