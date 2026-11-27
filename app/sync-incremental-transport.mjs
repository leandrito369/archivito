// CLOUD-03.5C2: in-memory transactional model; no network or authorization boundary.
// Keep committed history; no physical deletion or implicit migration from v3.
import {validateIncrementalHeader,validateIncrementalDelta} from "./sync-incremental.mjs";
import {sha256Hex,toBase64Url} from "./shared-crypto.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x);
const exact=(x,ks)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===ks.length&&ks.every(k=>Object.hasOwn(x,k));
const fail=()=>{throw Error("Transacción incremental rechazada.");};
const key=(a,b)=>a+"/"+b;
const fields=["id","born","size","nonce","cipherSha256"];
const sameRef=(a,b)=>a&&b&&fields.every(k=>a[k]===b[k]);
const enc=new TextEncoder();
// Deterministic representation: reference order is part of the header;
// new asset order is irrelevant (map keyed by ID). No plaintext in digest.
function headerBytes(h){
 const e=h.metadata;
 return enc.encode(JSON.stringify([h.format,h.archiveId,h.memoryId,h.operationId,h.revision,h.keyId,
 [e.version,e.archiveId,e.objectId,e.kind,e.revision,e.keyId,toBase64Url(e.nonce),toBase64Url(e.ciphertext)],
 h.refs.map(r=>fields.map(k=>r[k]))]));
}
async function fingerprint(d,base){
 const h=validateIncrementalHeader(d.header),refs=new Map(h.refs.filter(r=>r.born===h.revision).map(r=>[r.id,r]));
 if(!exact(d,["header","newAssets"])||!Array.isArray(d.newAssets)||d.newAssets.length!==refs.size)fail();
 const assets=[];
 for(const a of d.newAssets){
  if(!exact(a,["id","ciphertext"])||!refs.has(a.id)||!(a.ciphertext instanceof Uint8Array))fail();
  const r=refs.get(a.id);refs.delete(a.id);
  if(a.ciphertext.length!==r.size||await sha256Hex(a.ciphertext)!==r.cipherSha256)fail();
  assets.push([a.id,r.cipherSha256]);
 }
 assets.sort((a,b)=>a[0].localeCompare(b[0]));
 const serialized=headerBytes(h);
 return {hash:await sha256Hex(enc.encode(JSON.stringify([base===null?null:[base.revision,base.operationId],await sha256Hex(serialized),assets]))),headerSize:serialized.byteLength};
}
function validateBase(base,revision){
 if(base===null){if(revision!==1)fail();return;}
 if(!exact(base,["revision","operationId"])||!Number.isSafeInteger(base.revision)||base.revision<1||base.revision!==revision-1||!uuid(base.operationId))fail();
}
const head=h=>h?{revision:h.revision,operationId:h.operationId}:null;
const sameHead=(a,b)=>a===null||b===null?a===b:a.revision===b.revision&&a.operationId===b.operationId;
export function createIncrementalTransport({quotaBytes=256*1024*1024,maxRevisions=512}={}){
 if(!Number.isSafeInteger(quotaBytes)||quotaBytes<1||!Number.isSafeInteger(maxRevisions)||maxRevisions<1)fail();
 const archives=new Map();
 const conflict=(h,current)=>({state:"conflict",operationId:h.operationId,actualRevision:current?.revision??0,actualOperationId:current?.operationId??null});
 const get=a=>archives.get(a);
 return {
  async publish(input,expectedBase){
   const d=structuredClone(input),base=structuredClone(expectedBase);
   const h=validateIncrementalHeader(d?.header);validateBase(base,h.revision);
   if(base?.operationId===h.operationId)fail();
   const {hash,headerSize}=await fingerprint(d,base);
   let archive=get(h.archiveId);
   const receipt=archive?.receipts.get(h.operationId);
   if(receipt){
    if(receipt.hash!==hash)fail();
    return {...receipt.result,replayed:true};
   }
   if(archive&&archive.keyId!==h.keyId)fail();
   const current=archive?.records.get(h.memoryId)?.at(-1)??null;
   if(!sameHead(head(current),base))return conflict(h,current);
   const verified=await validateIncrementalDelta(d,current);
   // Final CAS after ALL awaits; synchronous mutation below is the simulated
   // commit boundary. Concurrent requests cannot interleave in this section.
   archive=get(h.archiveId);
   const replay=archive?.receipts.get(h.operationId);
   if(replay){if(replay.hash!==hash)fail();return {...replay.result,replayed:true};}
   if(archive&&archive.keyId!==h.keyId)fail();
   const history=archive?.records.get(h.memoryId)??[],latest=history.at(-1)??null;
   if(!sameHead(head(latest),base))return conflict(h,latest);
   const fresh=new Map(d.newAssets.map(a=>[a.id,a.ciphertext]));
   for(const r of h.refs){
    const stored=archive?.assets.get(r.id);
    if(r.born===h.revision){if(stored||!fresh.has(r.id))fail();}
    else if(!stored||stored.memoryId!==h.memoryId||!sameRef(stored.ref,r))fail();
   }
   const used=(archive?.usedBytes??0)+verified.newBytes+headerSize;
   if(used>quotaBytes||(archive?.receipts.size??0)>=maxRevisions)throw Error("Cuota incremental excedida.");
   const result={state:"synced",operationId:h.operationId,revision:h.revision,replayed:false};
   // No external code or awaits after validation. Retain every earlier header
   // and asset, including assets removed from the newest revision.
   const target=archive??{keyId:h.keyId,records:new Map(),assets:new Map(),receipts:new Map(),usedBytes:0,headerBytes:0,assetBytes:0};
   for(const r of h.refs)if(fresh.has(r.id))target.assets.set(r.id,{memoryId:h.memoryId,ref:r,ciphertext:fresh.get(r.id)});
   target.records.set(h.memoryId,[...history,h]);
   target.receipts.set(h.operationId,{hash,result});
   target.usedBytes=used;target.headerBytes+=headerSize;target.assetBytes+=verified.newBytes;
   archives.set(h.archiveId,target);
   return {...result};
  },
  latest(archiveId,memoryId){
   if(!uuid(archiveId)||!uuid(memoryId))fail();
   return structuredClone(get(archiveId)?.records.get(memoryId)?.at(-1)??null);
  },
  readRevision(archiveId,memoryId,revision){
   if(!uuid(archiveId)||!uuid(memoryId)||!Number.isSafeInteger(revision)||revision<1)fail();
   return structuredClone(get(archiveId)?.records.get(memoryId)?.find(h=>h.revision===revision)??null);
  },
  // Read only an asset referenced by the exact committed revision. No global
  // hash lookup and no access to another memory using an arbitrary UUID.
  readAsset(expected,ref){
   if(!expected||!uuid(expected.archiveId)||!uuid(expected.memoryId)||!uuid(expected.operationId)||!Number.isSafeInteger(expected.revision)||expected.revision<1||!exact(ref,fields))fail();
   const archive=get(expected.archiveId),h=archive?.records.get(expected.memoryId)?.find(x=>x.revision===expected.revision);
   if(!h||h.operationId!==expected.operationId||h.keyId!==expected.keyId||!sameRef(h.refs.find(x=>x.id===ref.id),ref))fail();
   const a=archive.assets.get(ref.id);
   if(!a||a.memoryId!==h.memoryId||!sameRef(a.ref,ref))fail();
   return a.ciphertext.slice();
  },
  audit(archiveId){
   if(!uuid(archiveId))fail();
   const a=get(archiveId),counts=new Map(),latestIds=new Set();
   if(a)for(const history of a.records.values()){
    for(const h of history)for(const r of h.refs)counts.set(r.id,(counts.get(r.id)??0)+1);
    for(const r of history.at(-1).refs)latestIds.add(r.id);
   }
   let historyOnly=0,unreferenced=0,missing=0;
   for(const id of a?.assets.keys()??[]){
    if(!counts.has(id))unreferenced++;
    else if(!latestIds.has(id))historyOnly++;
   }
   for(const id of counts.keys())if(!a?.assets.has(id))missing++;
   return {revisions:a?.receipts.size??0,memories:a?.records.size??0,assets:a?.assets.size??0,assetBytes:a?.assetBytes??0,
    headerBytes:a?.headerBytes??0,usedBytes:a?.usedBytes??0,historyOnly,unreferenced,missing,references:[...counts.values()].reduce((n,x)=>n+x,0)};
  }
 };
}
