import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {planRetention,quotaStatus,RETENTION} from "../app/sync-incremental-retention.mjs";
const DAY=86400000,now=Date.UTC(2026,10,26);
function lab(){
 const archiveId=randomUUID(),memoryId=randomUUID(),shared=randomUUID(),historical=randomUUID(),pinned=randomUUID(),orphan=randomUUID();
 const revisions=Array.from({length:15},(_,i)=>({memoryId,revision:i+1,operationId:randomUUID(),committedAt:now-(60-i)*DAY,pinned:i===2,refs:[shared,...(i===1?[historical]:i===2?[pinned]:[])]}));
 const assets=[shared,historical,pinned,orphan].map(id=>({id,memoryId,bytes:100}));
 return {archiveId,memoryId,shared,historical,pinned,orphan,input:{archiveId,now,complete:true,revisions,assets,intents:[],otherReservedBytes:25}};
}
test("protect original, pinned, head, last ten; old exclusive asset only potential",()=>{
 const l=lab(),p=planRetention(l.input);
 assert.deepEqual(p.eligibleRevisions.map(x=>x.revision).sort((a,b)=>a-b),[2,4,5]);
 assert.deepEqual(p.potentialAssets,[l.historical]);assert.equal(p.potentialBytes,100);
 assert.deepEqual(p.quarantinedAssets,[l.orphan]);assert.equal(p.deletionAuthorized,false);
 assert.equal(p.quota.usedBytes,425);
 assert.ok(p.protectedRevisions.find(x=>x.revision===1).reasons.includes("original"));
 assert.ok(p.protectedRevisions.find(x=>x.revision===3).reasons.includes("pinned"));
});
test("30-day protection inclusive; old active intent protects its assets",()=>{
 const l=lab();l.input.revisions[1].committedAt=now-30*DAY;
 assert.equal(planRetention(l.input).potentialBytes,0);
 l.input.revisions[1].committedAt=now-31*DAY;
 l.input.intents.push({memoryId:l.memoryId,operationId:randomUUID(),state:"staging",lastActivity:now-8*DAY,leaseUntil:now+1000,inFlight:false,refs:[l.historical]});
 const p=planRetention(l.input);assert.equal(p.potentialBytes,0);assert.equal(p.fenceCandidates.length,0);
});
test("expired staging only candidate for fencing; fenced rows still protect assets",()=>{
 const l=lab(),op=randomUUID();
 l.input.intents.push({memoryId:l.memoryId,operationId:op,state:"staging",lastActivity:now-7*DAY,leaseUntil:now,inFlight:false,refs:[l.historical]});
 let p=planRetention(l.input);assert.deepEqual(p.fenceCandidates,[op]);assert.equal(p.potentialBytes,0);
 l.input.intents[0].state="fenced";p=planRetention(l.input);assert.deepEqual(p.fencedCandidates,[op]);assert.equal(p.potentialBytes,0);
 l.input.intents[0].inFlight=true;assert.equal(planRetention(l.input).fencedCandidates.length,0);
});
test("missing committed asset, incomplete snapshot and cross-memory references fail closed",()=>{
 for(const mutate of [x=>{x.complete=false;},x=>{x.assets.shift();},x=>{x.assets[0].memoryId=randomUUID();},x=>{x.revisions.shift();},x=>{x.revisions[1].operationId=x.revisions[0].operationId;}]){
  const l=lab();mutate(l.input);assert.throws(()=>planRetention(l.input));
 }
});
test("quota warnings and hard stop are explicit, never authorize removal",()=>{
 const q=RETENTION.quotaBytes;
 assert.equal(quotaStatus(0).state,"normal");assert.equal(quotaStatus(Math.ceil(q*.7)).state,"warning");assert.equal(quotaStatus(Math.ceil(q*.85)).state,"critical");assert.equal(quotaStatus(q).state,"blocked");assert.equal(quotaStatus(q+1).availableBytes,0);
});
