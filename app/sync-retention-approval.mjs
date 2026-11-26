// CLOUD-03.5C3A1 — non-destructive proposal and approval preflight.
// No authorization, persistence, backup verification or object deletion here.
// Trusted backend must supply authenticated actor, verified restore evidence,
// authoritative inventory and server clock under the same archive lock.
import {planRetention,RETENTION} from "./sync-incremental-retention.mjs";
import {sha256Hex} from "./shared-crypto.mjs";
const DAY=86400000,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,HEX=/^[0-9a-f]{64}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x),hex=x=>typeof x==="string"&&HEX.test(x),nat=x=>Number.isSafeInteger(x)&&x>=0;
const exact=(x,k)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(y=>Object.hasOwn(x,y));
const fail=()=>{throw Error("Propuesta de retención no válida o desactualizada.");};
const enc=new TextEncoder();
const sorted=(rows,fn)=>[...rows].sort((a,b)=>fn(a).localeCompare(fn(b)));
const key=r=>r.memoryId+"/"+r.operationId;
const hash=async value=>sha256Hex(enc.encode(JSON.stringify(value)));
function validateHolds(holds,inventory){
 if(!Array.isArray(holds))fail();
 const seen=new Set(),revisions=new Map(inventory.revisions.map(r=>[r.operationId,r]));
 for(const h of holds){
  if(!exact(h,["id","operationId","memoryId","kind"])||!uuid(h.id)||seen.has(h.id)||!["read","restore","backup"].includes(h.kind)||!uuid(h.operationId)||!uuid(h.memoryId))fail();
  if(revisions.get(h.operationId)?.memoryId!==h.memoryId)fail();
  seen.add(h.id);
 }
}
function canonicalInventory(x,holds){
 return [x.archiveId,x.otherReservedBytes,
 sorted(x.revisions,key).map(r=>[r.memoryId,r.revision,r.operationId,r.committedAt,r.pinned,[...r.refs].sort()]),
 sorted(x.assets,a=>a.id).map(a=>[a.id,a.memoryId,a.bytes]),
 sorted(x.intents,i=>i.operationId).map(i=>[i.memoryId,i.operationId,i.state,i.lastActivity,i.leaseUntil,i.inFlight,[...i.refs].sort()]),
 sorted(holds,h=>h.id).map(h=>[h.id,h.operationId,h.memoryId,h.kind])];
}
// selection = exact subset of candidate revision operation IDs. Never includes
// staged uploads, trash or unknown orphans; separate lifecycles are required.
export async function makeRetentionProposal({inventory,holds,selection}={}){
 const x=structuredClone(inventory),hs=structuredClone(holds),selected=structuredClone(selection);
 const plan=planRetention(x);validateHolds(hs,x);
 if(!Array.isArray(selected)||!selected.length||!selected.every(uuid)||new Set(selected).size!==selected.length)fail();
 const eligible=new Set(plan.eligibleRevisions.map(r=>r.operationId)),held=new Set(hs.map(h=>h.operationId));
 for(const op of selected)if(!eligible.has(op)||held.has(op))fail();
 const chosen=new Set(selected),remaining=new Set(),retiring=new Set();
 for(const r of x.revisions)for(const id of r.refs)(chosen.has(r.operationId)?retiring:remaining).add(id);
 for(const i of x.intents)for(const id of i.refs)remaining.add(id);
 const assets=sorted(x.assets.filter(a=>retiring.has(a.id)&&!remaining.has(a.id)),a=>a.id).map(a=>({id:a.id,memoryId:a.memoryId,bytes:a.bytes}));
 const potentialBytes=assets.reduce((n,a)=>n+a.bytes,0);
 const revisions=sorted(x.revisions.filter(r=>chosen.has(r.operationId)),key).map(r=>({memoryId:r.memoryId,revision:r.revision,operationId:r.operationId}));
 const inventoryDigest=await hash(canonicalInventory(x,hs));
 const proposalDigest=await hash(["archivito-retention-proposal-v1",inventoryDigest,revisions.map(r=>[r.memoryId,r.revision,r.operationId]),assets.map(a=>[a.id,a.memoryId,a.bytes])]);
 return {archiveId:x.archiveId,inventoryDigest,proposalDigest,revisions,assets,potentialBytes,deletionAuthorized:false};
}
// Approval and restore proof are trusted backend records, NOT client claims.
// An exact inventory match is deliberately conservative, including holds and
// concurrent new revisions. Time alone may not invalidate the proposal.
export async function inspectRetentionApproval({inventory,holds,selection,approval,backup,actor}={}){
 const x=structuredClone(inventory),a=structuredClone(approval),b=structuredClone(backup),who=structuredClone(actor);
 const p=await makeRetentionProposal({inventory:x,holds,selection});
 if(!exact(who,["userId","archiveId","role"])||!uuid(who.userId)||who.archiveId!==x.archiveId||who.role!=="owner")fail();
 if(!exact(a,["archiveId","ownerId","proposalDigest","approvedAt","cancelled"])||a.archiveId!==x.archiveId||a.ownerId!==who.userId||a.proposalDigest!==p.proposalDigest||!nat(a.approvedAt)||a.approvedAt>x.now||a.cancelled!==false)fail();
 if(!exact(b,["archiveId","inventoryDigest","backupDigest","verifiedAt","expiresAt","restoreVerified"])||b.archiveId!==x.archiveId||b.inventoryDigest!==p.inventoryDigest||!hex(b.backupDigest)||b.restoreVerified!==true||!nat(b.verifiedAt)||b.verifiedAt>a.approvedAt||!nat(b.expiresAt)||b.expiresAt<=x.now)fail();
 const readyAt=a.approvedAt+RETENTION.approvalGraceDays*DAY;
 if(!nat(readyAt))fail();
 return {...p,readyAt,state:x.now<readyAt?"grace-period":"eligible-for-server-recheck",deletionAuthorized:false};
}
