import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode,sha256Hex,toBase64Url} from "../app/shared-crypto.mjs";
import {encodeFixture} from "../app/sync-contract.mjs";
import {createFixtureService} from "../server/sync-fixture-service.mjs";
async function lab(){
 const key=await unlockRecoveryCode(await generateRecoveryCode()),user=randomUUID(),archiveId=randomUUID();
 const p=await encodeFixture(key,{archiveId,memoryId:randomUUID(),operationId:randomUUID(),revision:1,title:"Ficticio",note:"",assets:[{id:randomUUID(),side:"front-original",mime:"image/png",bytes:new Uint8Array([1,2,3])}]});
 const e=p.assets[0],path=[archiveId,p.operationId,e.objectId].join("/");
 const body={action:"begin",format:p.format,archiveId,memoryId:p.memoryId,operationId:p.operationId,keyId:p.keyId,revision:1,expectedRevision:0,
 metadata:{nonce:toBase64Url(p.metadata.nonce),ciphertext:toBase64Url(p.metadata.ciphertext)},
 assets:[{assetId:e.objectId,path,nonce:toBase64Url(e.nonce),size:e.ciphertext.length,sha256:await sha256Hex(e.ciphertext)}]};
 const control={member:true,enabled:true,corrupt:false,missing:false,revokedAfterRead:false},calls=[];
 let saved=null;
 const deps={verifyUser:async t=>t==="valid"?{id:user}:null,authorize:async()=>control.member?{role:"owner",keyId:key.keyId,labEnabled:control.enabled}:null,
 db:{async begin(u,h){calls.push("begin");saved=JSON.stringify([u,h]);return {state:"staging",operationId:h.operationId};},
 async lookup(u,h){calls.push("lookup");if(saved!==JSON.stringify([u,h]))throw Error("intent mismatch");return {state:"staging"};},
 async commit(u,h){calls.push("commit");return {state:"synced",operationId:h.operationId,revision:h.revision,replayed:false};}},
 readBlob:async(bucket,name)=>{calls.push("read");assert.equal(bucket,"archivito-sync-lab");assert.equal(name,path);if(control.revokedAfterRead)control.member=false;if(control.missing)return null;const b=e.ciphertext.slice();if(control.corrupt)b[0]^=1;return b;}};
 return {body,control,calls,deps,handle:createFixtureService({...deps,enabled:true})};
}
test("closed by default, invalid session, nonmember and disabled archive",async()=>{
 const l=await lab();await assert.rejects(createFixtureService(l.deps)("valid",l.body));
 await assert.rejects(l.handle("wrong",l.body));l.control.member=false;await assert.rejects(l.handle("valid",l.body));
 l.control.member=true;l.control.enabled=false;await assert.rejects(l.handle("valid",l.body));assert.deepEqual(l.calls,[]);
});
test("malformed path or plaintext extra rejected before database",async()=>{
 const l=await lab();const bad=structuredClone(l.body);bad.assets[0].path="../other";
 await assert.rejects(l.handle("valid",bad));await assert.rejects(l.handle("valid",{...l.body,title:"plaintext"}));assert.deepEqual(l.calls,[]);
});
test("begin then commit with independent bytes verification",async()=>{
 const l=await lab();await l.handle("valid",l.body);
 const r=await l.handle("valid",{...l.body,action:"commit"});assert.equal(r.state,"synced");assert.deepEqual(l.calls,["begin","lookup","read","commit"]);
});
test("absent or corrupt blob rejects commit",async()=>{
 const l=await lab();await l.handle("valid",l.body);l.control.missing=true;
 await assert.rejects(l.handle("valid",{...l.body,action:"commit"}));l.control.missing=false;l.control.corrupt=true;
 await assert.rejects(l.handle("valid",{...l.body,action:"commit"}));assert.ok(!l.calls.includes("commit"));
});
test("changed intent and membership loss before commit rejected",async()=>{
 const l=await lab();await l.handle("valid",l.body);
 const bad=structuredClone(l.body);bad.assets[0].sha256="a".repeat(64);
 await assert.rejects(l.handle("valid",{...bad,action:"commit"}));assert.ok(!l.calls.includes("read"));
 l.control.revokedAfterRead=true;await assert.rejects(l.handle("valid",{...l.body,action:"commit"}));assert.ok(!l.calls.includes("commit"));
});
