// CLOUD-03.2B: durable queue for synthetic encrypted packages ONLY.
// Separate database; no automatic transmission and no access to the library.
import {validatePackage} from "./sync-contract.mjs";
const DB="archivito-sync-fixture-queue-v1", STORE="operations";
const MAX_ROWS=32, MAX_BYTES=64*1024*1024, LEASE=60000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const states=new Set(["pending","uploading","error","conflict","synced"]);
function checkScope(s){
 if(!s||typeof s.userId!=="string"||!UUID.test(s.userId)||typeof s.archiveId!=="string"||!UUID.test(s.archiveId)||typeof s.keyId!=="string"||!HEX.test(s.keyId))throw Error("Ámbito inválido.");
 return {userId:s.userId,archiveId:s.archiveId,keyId:s.keyId};
}
const scopeId=s=>[s.userId,s.archiveId,s.keyId].join("/");
const size=p=>p.metadata.ciphertext.byteLength+p.metadata.nonce.byteLength+p.assets.reduce((n,e)=>n+e.ciphertext.byteLength+e.nonce.byteLength,0);
const equalBytes=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function samePackage(a,b){
 const keys=["format","archiveId","memoryId","revision","operationId","keyId"];
 const env=(x,y)=>["version","archiveId","objectId","kind","revision","keyId"].every(k=>x[k]===y[k])&&equalBytes(x.nonce,y.nonce)&&equalBytes(x.ciphertext,y.ciphertext);
 return keys.every(k=>a[k]===b[k])&&env(a.metadata,b.metadata)&&a.assets.length===b.assets.length&&a.assets.every((e,i)=>env(e,b.assets[i]));
}
function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function openDB(){
 return new Promise((resolve,reject)=>{
  const r=indexedDB.open(DB,1);
  r.onupgradeneeded=()=>{r.result.createObjectStore(STORE,{keyPath:"id"});};
  r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();resolve(db);};
  r.onerror=()=>reject(r.error);
  r.onblocked=()=>reject(Error("Base de cola bloqueada."));
 });
}
async function transaction(db,mode,work){
 const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);
 const completion=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error("Transacción cancelada."));});
 // Install rejection handler immediately; still await final outcome below.
 completion.catch(()=>{});
 try{const result=await work(store);await completion;return result;}
 catch(e){try{tx.abort();}catch{}await completion.catch(()=>{});throw e;}
}
export async function openSyncQueue(scope){
 const s=checkScope(scope),sid=scopeId(s),db=await openDB();
 let closed=false;
 const run=(mode,work)=>{if(closed)throw Error("Cola cerrada.");return transaction(db,mode,work);};
 const id=op=>{if(typeof op!=="string"||!UUID.test(op))throw Error("Operación inválida.");return sid+"/"+op;};
 const rows=async store=>(await request(store.getAll())).filter(r=>r.scope===sid);
 const summary=r=>({operationId:r.package.operationId,memoryId:r.package.memoryId,revision:r.package.revision,state:r.state,attempts:r.attempts,actualRevision:r.actualRevision??null,error:r.error??null});
 return {
  close(){closed=true;db.close();},
  async enqueue(input,expectedRevision){
   const p=structuredClone(input);validatePackage(p);
   if(p.archiveId!==s.archiveId||p.keyId!==s.keyId||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||p.revision!==expectedRevision+1)throw Error("Paquete fuera de ámbito o revisión inválida.");
   return run("readwrite",async store=>{
    const key=id(p.operationId),existing=await request(store.get(key));
    if(existing){
     if(existing.expectedRevision!==expectedRevision||!samePackage(existing.package,p))throw Error("Operación incompatible.");
     return summary(existing);
    }
    const all=await request(store.getAll());
    if(all.length>=MAX_ROWS||all.reduce((n,r)=>n+size(r.package),0)+size(p)>MAX_BYTES)throw Error("Cola llena.");
    if(all.some(r=>r.scope===sid&&r.package.memoryId===p.memoryId&&r.state!=="synced"))throw Error("Ya existe una operación pendiente para el recuerdo.");
    const row={id:key,scope:sid,package:p,expectedRevision,state:"pending",attempts:0,createdAt:Date.now(),leaseUntil:0,token:null};
    await request(store.add(row));return summary(row);
   });
  },
  list(){return run("readonly",async store=>(await rows(store)).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id)).map(summary));},
  // A lease limits concurrent workers. If a tab dies, exact ciphertext is retried
  // after expiry. A stale worker cannot overwrite a newer attempt's receipt.
  claim(){return run("readwrite",async store=>{
   const now=Date.now(),all=await rows(store);
   const candidates=all.filter(r=>r.state==="pending"||(r.state==="uploading"&&r.leaseUntil<=now)).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
   const r=candidates[0];if(!r)return null;
   validatePackage(r.package);
   if(r.package.archiveId!==s.archiveId||r.package.keyId!==s.keyId)throw Error("Ámbito inválido.");
   r.state="uploading";r.attempts++;r.token=crypto.randomUUID();r.leaseUntil=now+LEASE;r.error=null;
   await request(store.put(r));
   return {package:r.package,expectedRevision:r.expectedRevision,token:r.token};
  });},
  finish(operationId,token,result){return run("readwrite",async store=>{
   const r=await request(store.get(id(operationId)));
   if(!r||r.state!=="uploading"||r.token!==token)return false;
   if(!result||!["synced","conflict","error"].includes(result.state))throw Error("Resultado inválido.");
   if(result.state==="synced"&&result.revision!==r.package.revision)throw Error("Recibo inválido.");
   if(result.state==="conflict"&&(!Number.isSafeInteger(result.actualRevision)||result.actualRevision<0))throw Error("Conflicto inválido.");
   r.state=result.state;r.token=null;r.leaseUntil=0;
   r.actualRevision=result.state==="conflict"?result.actualRevision:null;
   // Never persist arbitrary exception text, which could contain private data.
   r.error=result.state==="error"?"transport-failed":null;
   await request(store.put(r));return true;
  });},
  retry(operationId){return run("readwrite",async store=>{
   const r=await request(store.get(id(operationId)));
   if(!r||r.state!=="error")return false;
   r.state="pending";r.error=null;await request(store.put(r));return true;
  });},
  pruneSynced(operationId){return run("readwrite",async store=>{
   const r=await request(store.get(id(operationId)));
   if(!r||r.state!=="synced")return false;
   await request(store.delete(r.id));return true;
  });}
 };
}
// Explicit one-shot worker. Caller must verify session + key before each call;
// scope is a local namespace, not authentication. No timers, network or auto-retry.
export async function drainOne(queue,transport){
 const item=await queue.claim();if(!item)return {state:"idle"};
 const op=item.package.operationId;let result;
 try{
  result=await transport.publish(item.package,item.expectedRevision);
  if(!result||!(result.state==="synced"&&result.revision===item.package.revision||result.state==="conflict"&&Number.isSafeInteger(result.actualRevision)&&result.actualRevision>=0))throw Error("Respuesta inválida.");
 }catch{result={state:"error"};}
 const accepted=await queue.finish(op,item.token,result);
 return accepted?{state:result.state}:{state:"stale"};
}
