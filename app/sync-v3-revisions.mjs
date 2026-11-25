// CLOUD-03.4B — pure reconciliation and simulated revision transport.
// No network, UI, database or automatic replacement of local records.
import {validateV3Package} from "./sync-v3-contract.mjs";
import {sha256Hex,toBase64Url} from "./shared-crypto.mjs";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x);
const rev=x=>Number.isSafeInteger(x)&&x>=0;
const fail=()=>{throw Error("Estado de revisión inválido.");};
function head(h){
 if(h===null)return {revision:0,operationId:null};
 if(!h||!rev(h.revision)||h.revision<1||!uuid(h.operationId))fail();
 return {revision:h.revision,operationId:h.operationId};
}
// Local generation is an opaque UUID provided by a future local write adapter.
// It MUST change atomically on each edit; it is not a wall-clock timestamp.
// An absent local record is never interpreted as a remote deletion.
export function planReconciliation({base,remote,localGeneration,baseGeneration}){
 const b=head(base),r=head(remote);
 if(localGeneration!==null&&!uuid(localGeneration)||baseGeneration!==null&&!uuid(baseGeneration))fail();
 if((b.revision===0)!==(baseGeneration===null))fail();
 if(r.revision<b.revision)return {action:"blocked",reason:"remote-rollback"};
 if(r.revision===b.revision&&r.operationId!==b.operationId)return {action:"blocked",reason:"remote-equivocation"};
 if(localGeneration===null){
  if(b.revision>0)return {action:"blocked",reason:"local-missing"};
  return r.revision===0?{action:"noop"}:{action:"import",revision:r.revision,operationId:r.operationId};
 }
 const dirty=localGeneration!==baseGeneration;
 const changed=r.revision>b.revision;
 if(dirty&&changed)return {action:"conflict",localGeneration,remoteRevision:r.revision,remoteOperationId:r.operationId};
 if(changed)return {action:"pull",revision:r.revision,operationId:r.operationId,expectedLocalGeneration:localGeneration};
 if(dirty){
  if(b.revision===Number.MAX_SAFE_INTEGER)return {action:"blocked",reason:"revision-limit"};
  return {action:"publish",expectedRevision:b.revision,revision:b.revision+1,localGeneration};
 }
 return {action:"noop"};
}
// The receipt acknowledges the generation actually encoded, never a later edit.
// Caller must save the baseline with CAS and keep later edits dirty.
export function acceptPublishReceipt({receipt,operationId,expectedRevision,encodedGeneration,currentGeneration}){
 if(!uuid(operationId)||!rev(expectedRevision)||expectedRevision===Number.MAX_SAFE_INTEGER||!uuid(encodedGeneration)||!uuid(currentGeneration)||
 receipt?.state!=="synced"||receipt.operationId!==operationId||receipt.revision!==expectedRevision+1||typeof receipt.replayed!=="boolean")fail();
 return {base:{revision:receipt.revision,operationId},baseGeneration:encodedGeneration,dirty:currentGeneration!==encodedGeneration};
}
async function digest(p){
 const e=async x=>[x.version,x.archiveId,x.objectId,x.kind,x.revision,x.keyId,toBase64Url(x.nonce),await sha256Hex(x.ciphertext)];
 const rows=[p.format,p.archiveId,p.memoryId,p.operationId,p.revision,p.keyId,await e(p.metadata),await Promise.all(p.assets.map(e))];
 return sha256Hex(new TextEncoder().encode(JSON.stringify(rows)));
}
// Simulated CAS and receipts for the full v3 format, not a server security boundary.
// Exact ciphertext retries only. No overwrite of earlier revisions or cross-key rotation.
export function createV3RevisionTransport(){
 const records=new Map(),receipts=new Map();
 const k=(a,m)=>a+"/"+m;
 return {
  async publish(input,expectedRevision){
   const p=structuredClone(input);validateV3Package(p);
   if(!rev(expectedRevision)||expectedRevision===Number.MAX_SAFE_INTEGER||p.revision!==expectedRevision+1)fail();
   const hash=await digest(p),op=k(p.archiveId,p.operationId),record=k(p.archiveId,p.memoryId);
   const prior=receipts.get(op);
   if(prior){
    if(prior.hash!==hash||prior.expectedRevision!==expectedRevision)fail();
    return {state:"synced",operationId:p.operationId,revision:p.revision,replayed:true};
   }
   const history=records.get(record)||[],current=history.at(-1);
   if((current?.revision??0)!==expectedRevision)return {state:"conflict",actualRevision:current?.revision??0};
   if(current&&current.keyId!==p.keyId)fail();
   history.push(p);records.set(record,history);receipts.set(op,{hash,expectedRevision});
   return {state:"synced",operationId:p.operationId,revision:p.revision,replayed:false};
  },
  latest(archiveId,memoryId){const p=records.get(k(archiveId,memoryId))?.at(-1);return p?structuredClone(p):null;},
  readRevision(archiveId,memoryId,revision){const p=records.get(k(archiveId,memoryId))?.find(x=>x.revision===revision);return p?structuredClone(p):null;}
 };
}
