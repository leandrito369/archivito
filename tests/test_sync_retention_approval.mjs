import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,webcrypto} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {makeRetentionProposal,inspectRetentionApproval} from "../app/sync-retention-approval.mjs";
const DAY=86400000,now=Date.UTC(2026,10,26);
function fixture(){
 const archiveId=randomUUID(),memoryId=randomUUID(),shared=randomUUID(),old=randomUUID(),ownerId=randomUUID();
 const revisions=Array.from({length:15},(_,i)=>({memoryId,revision:i+1,operationId:randomUUID(),committedAt:now-(60-i)*DAY,pinned:false,refs:[shared,...([1,2].includes(i)?[old]:[])]}));
 const inventory={archiveId,now,complete:true,revisions,assets:[{id:shared,memoryId,bytes:50},{id:old,memoryId,bytes:100}],intents:[],otherReservedBytes:0};
 const holds=[],selection=[revisions[1].operationId,revisions[2].operationId],actor={userId:ownerId,archiveId,role:"owner"};
 return {inventory,holds,selection,actor,old};
}
async function approved(){
 const l=fixture(),p=await makeRetentionProposal(l);
 return {...l,approval:{archiveId:p.archiveId,ownerId:l.actor.userId,proposalDigest:p.proposalDigest,approvedAt:now,cancelled:false},
 backup:{archiveId:p.archiveId,inventoryDigest:p.inventoryDigest,backupDigest:"a".repeat(64),verifiedAt:now,expiresAt:now+30*DAY,restoreVerified:true}};
}
test("subset cannot reclaim asset still referenced by another eligible revision",async()=>{
 const l=fixture();
 assert.equal((await makeRetentionProposal({...l,selection:l.selection.slice(0,1)})).potentialBytes,0);
 const p=await makeRetentionProposal(l);assert.equal(p.potentialBytes,100);assert.deepEqual(p.assets.map(x=>x.id),[l.old]);assert.equal(p.deletionAuthorized,false);
});
test("canonical proposal independent of inventory and selection ordering",async()=>{
 const l=fixture(),p=await makeRetentionProposal(l);l.inventory.revisions.reverse();l.inventory.assets.reverse();l.selection.reverse();
 assert.deepEqual(await makeRetentionProposal(l),p);
});
test("owner, restored backup and seven-day grace required; no execution authorization",async()=>{
 const l=await approved();assert.equal((await inspectRetentionApproval(l)).state,"grace-period");
 l.inventory.now+=7*DAY;const p=await inspectRetentionApproval(l);assert.equal(p.state,"eligible-for-server-recheck");assert.equal(p.deletionAuthorized,false);
 for(const change of [x=>{x.actor.role="editor";},x=>{x.approval.cancelled=true;},x=>{x.backup.restoreVerified=false;},x=>{x.backup.expiresAt=x.inventory.now;},x=>{x.approval.ownerId=randomUUID();}]){
  const x=structuredClone(l);change(x);await assert.rejects(inspectRetentionApproval(x));
 }
});
test("new hold, pin, reference, asset size, or selected subset invalidates approval",async()=>{
 const l=await approved();l.inventory.now+=7*DAY;
 for(const change of [
  x=>{x.holds.push({id:randomUUID(),kind:"read",operationId:x.selection[0],memoryId:x.inventory.revisions[0].memoryId});},
  x=>{x.inventory.revisions[1].pinned=true;},
  x=>{x.inventory.revisions[14].refs.push(x.old);},
  x=>{x.inventory.assets[1].bytes++;},
  x=>{x.selection.pop();}
 ]){const x=structuredClone(l);change(x);await assert.rejects(inspectRetentionApproval(x));}
});
test("protected revision and unknown hold fail closed",async()=>{
 const l=fixture();await assert.rejects(makeRetentionProposal({...l,selection:[l.inventory.revisions[0].operationId]}));
 l.holds.push({id:randomUUID(),kind:"restore",operationId:randomUUID(),memoryId:l.inventory.revisions[0].memoryId});
 await assert.rejects(makeRetentionProposal(l));
});
