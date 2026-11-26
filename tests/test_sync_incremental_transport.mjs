import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {prepareIncremental,decodeIncremental} from "../app/sync-incremental.mjs";
import {createIncrementalTransport} from "../app/sync-incremental-transport.mjs";
const blob=(n,size=8)=>new Blob([new Uint8Array(size).fill(n)],{type:"image/png"});
const head=d=>({revision:d.header.revision,operationId:d.header.operationId});
const expected=d=>({...head(d),archiveId:d.header.archiveId,memoryId:d.header.memoryId,keyId:d.header.keyId});
const prior=d=>({expected:expected(d),header:d.header});
async function lab(){
 const code=await generateRecoveryCode(),a=await unlockRecoveryCode(code),b=await unlockRecoveryCode(code);
 const c={archiveId:randomUUID(),memoryId:randomUUID(),operationId:randomUUID(),revision:1};
 const record={id:"fixture",schemaVersion:3,kind:"letter",title:"Original",date:"",from:"",to:"",note:"",tags:[],favorite:false,createdAt:"2026-11-25",updatedAt:"2026-11-25",pages:[{id:"p",caption:"",front:blob(1,1024*1024),back:blob(2),frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
 const one=await prepareIncremental(a,c,record),next=d=>({...c,revision:d.header.revision+1,operationId:randomUUID()});
 const decode=(t,k,d)=>decodeIncremental(k,expected(d),t.readRevision(c.archiveId,c.memoryId,d.header.revision),{readAsset:r=>t.readAsset(expected(d),r),validateImage:async()=>{},makeThumb:async x=>x});
 return {a,b,c,record,one,next,decode};
}
test("A publishes, B edits metadata, A reads; assets stored once and exact retry does not charge twice",async()=>{
 const l=await lab(),t=createIncrementalTransport();await t.publish(l.one,null);
 const before=t.audit(l.c.archiveId),received=await l.decode(t,l.b,l.one);
 const two=await prepareIncremental(l.b,l.next(l.one),{...received,title:"Edición B"},prior(l.one));
 const receipt=await t.publish(two,head(l.one));assert.equal(receipt.state,"synced");
 const after=t.audit(l.c.archiveId);assert.equal(after.assets,2);assert.equal(after.references,4);assert.equal(after.assetBytes,before.assetBytes);assert.ok(after.headerBytes>before.headerBytes);
 assert.equal((await l.decode(t,l.a,two)).title,"Edición B");
 assert.equal((await l.decode(t,l.a,l.one)).title,"Original");
 assert.equal((await t.publish(l.one,null)).replayed,true);assert.equal((await t.publish(two,head(l.one))).replayed,true);
 assert.deepEqual(t.audit(l.c.archiveId),after);
});
test("parallel CAS rejects losing edit without storing orphan assets",async()=>{
 const l=await lab(),t=createIncrementalTransport();await t.publish(l.one,null);
 const ra=structuredClone(l.record),rb=structuredClone(l.record);ra.pages[0].back=blob(3);rb.pages[0].back=blob(4);
 const a=await prepareIncremental(l.a,l.next(l.one),ra,prior(l.one)),b=await prepareIncremental(l.b,l.next(l.one),rb,prior(l.one));
 const results=await Promise.all([t.publish(a,head(l.one)),t.publish(b,head(l.one))]);
 assert.equal(results.filter(r=>r.state==="synced").length,1);assert.equal(results.filter(r=>r.state==="conflict").length,1);
 assert.equal(t.audit(l.c.archiveId).assets,3);assert.equal(t.audit(l.c.archiveId).unreferenced,0);assert.equal(t.audit(l.c.archiveId).historyOnly,1);
 const loser=results[0].state==="conflict"?a:b;assert.throws(()=>t.readAsset(expected(loser),loser.header.refs[1]));
});
test("same operation concurrent retry is idempotent, modified bytes or header rejected",async()=>{
 const l=await lab(),t=createIncrementalTransport();
 const r=await Promise.all([t.publish(l.one,null),t.publish(l.one,null)]);assert.equal(r.filter(x=>x.replayed).length,1);
 const changed=structuredClone(l.one);changed.header.metadata.ciphertext[0]^=1;await assert.rejects(t.publish(changed,null));
 const bytes=structuredClone(l.one);bytes.newAssets[0].ciphertext[0]^=1;await assert.rejects(t.publish(bytes,null));
 const reverse=structuredClone(l.one);reverse.newAssets.reverse();assert.equal((await t.publish(reverse,null)).replayed,true);
 assert.equal(t.audit(l.c.archiveId).revisions,1);
});
test("same revision different predecessor operation is conflict; foreign key and memory references rejected",async()=>{
 const l=await lab(),t=createIncrementalTransport();await t.publish(l.one,null);
 const two=await prepareIncremental(l.a,l.next(l.one),l.record,prior(l.one));
 const result=await t.publish(two,{revision:1,operationId:randomUUID()});assert.equal(result.state,"conflict");
 assert.equal(result.actualOperationId,l.one.header.operationId);
 const fake=structuredClone(two);fake.header.refs[0].nonce="A".repeat(16);await assert.rejects(t.publish(fake,head(l.one)));
 const other=await unlockRecoveryCode(await generateRecoveryCode());
 const x=await prepareIncremental(other,{...l.c,memoryId:randomUUID(),operationId:randomUUID()},l.record);await assert.rejects(t.publish(x,null));
 assert.throws(()=>t.readAsset({...expected(l.one),memoryId:randomUUID()},l.one.header.refs[0]));
 assert.equal(t.audit(l.c.archiveId).revisions,1);
});
test("quota and revision limit fail atomically; bytes counted once and snapshots isolated",async()=>{
 const l=await lab(),initial=createIncrementalTransport();await initial.publish(l.one,null);
 const limit=initial.audit(l.c.archiveId).usedBytes,t=createIncrementalTransport({quotaBytes:limit,maxRevisions:2});await t.publish(l.one,null);
 const two=await prepareIncremental(l.a,l.next(l.one),l.record,prior(l.one)),before=t.audit(l.c.archiveId);
 await assert.rejects(t.publish(two,head(l.one)),/Cuota/);assert.deepEqual(t.audit(l.c.archiveId),before);
 const bounded=createIncrementalTransport({maxRevisions:1});await bounded.publish(l.one,null);
 await assert.rejects(bounded.publish(two,head(l.one)),/Cuota/);
 const h=t.latest(l.c.archiveId,l.c.memoryId);h.refs[0].size=99;
 const bytes=t.readAsset(expected(l.one),l.one.header.refs[0]);bytes[0]^=1;
 assert.equal((await l.decode(t,l.a,l.one)).title,"Original");
});
test("removed asset remains reachable only through history; audit never deletes",async()=>{
 const l=await lab(),t=createIncrementalTransport();await t.publish(l.one,null);
 const r=structuredClone(l.record);r.pages[0].back=null;
 const two=await prepareIncremental(l.a,l.next(l.one),r,prior(l.one));await t.publish(two,head(l.one));
 const stats=t.audit(l.c.archiveId);
 assert.equal(stats.assets,2);assert.equal(stats.historyOnly,1);assert.equal(stats.unreferenced,0);assert.equal(stats.missing,0);
 assert.throws(()=>t.readAsset(expected(two),l.one.header.refs[1]));
 assert.ok((await l.decode(t,l.a,l.one)).back);assert.equal((await l.decode(t,l.a,two)).back,null);
});
