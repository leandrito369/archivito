import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {encodeV3Record} from "../app/sync-v3-contract.mjs";
import {makeV3Wire} from "../app/sync-v3-wire.mjs";
import {createV3Service} from "../server/sync-v3-service.mjs";
async function lab(){
 const key=await unlockRecoveryCode(await generateRecoveryCode()),c={archiveId:randomUUID(),memoryId:randomUUID(),operationId:randomUUID(),revision:1},user=randomUUID();
 const record={id:"local",schemaVersion:3,kind:"letter",title:"Ficticio",date:"",from:"",to:"",note:"",tags:[],favorite:false,createdAt:"2026-11-25",updatedAt:"2026-11-25",pages:[{id:"p",caption:"",front:new Blob([new Uint8Array([1,2,3])],{type:"image/png"}),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
 const w=await makeV3Wire(await encodeV3Record(key,c,record),0),path=w.header.assets[0].chunks[0].path;
 const calls=[],state={member:true,corrupt:false,lost:false,verified:false},storage=new Map();
 const deps={verifyUser:async t=>t==="valid"?{id:user}:null,
 loadIntent:async(u,a,o)=>{assert.equal(u,user);assert.equal(a,c.archiveId);assert.equal(o,c.operationId);return w.header;},
 step:async(u,action,h,proof)=>{assert.equal(u,user);if(!state.member)throw Error("disabled");assert.deepEqual(h,w.header);calls.push(action);
 if(action==="verify"){assert.equal(proof.path,path);state.verified=true;return {state:"verified"};}
 return {state:"staging",verifiedPaths:state.verified?[path]:[]};},
 upload:async(n,b)=>{calls.push("upload");if(storage.has(n))throw Error("exists");storage.set(n,b.slice());if(state.lost)throw Error("response lost");},
 download:async n=>{calls.push("download");const b=storage.get(n)?.slice();if(b&&state.corrupt)b[0]^=1;return b;}};
 return {service:createV3Service({...deps,enabled:true}),deps,w,input:{archiveId:c.archiveId,operationId:c.operationId,path,bytes:w.chunk(path)},calls,state};
}
test("valid block uploaded and independently verified; lost response recovered",async()=>{
 const l=await lab();l.state.lost=true;
 assert.equal((await l.service.putBlock("valid",l.input)).state,"verified");
 assert.deepEqual(l.calls,["lookup","upload","download","verify"]);
 await l.service.putBlock("valid",l.input);assert.equal(l.calls.filter(x=>x==="upload").length,1);
});
test("invalid user, closed service, bad hash and unauthorized path cannot upload",async()=>{
 const l=await lab();await assert.rejects(createV3Service(l.deps).putBlock("valid",l.input));
 await assert.rejects(l.service.putBlock("wrong",l.input));
 await assert.rejects(l.service.putBlock("valid",{...l.input,path:"wrong"}));
 const bad=l.input.bytes.slice();bad[0]^=1;await assert.rejects(l.service.putBlock("valid",{...l.input,bytes:bad}));
 assert.deepEqual(l.calls,[]);
});
test("gate denial and corrupt storage prevent attestation",async()=>{
 const l=await lab();l.state.member=false;await assert.rejects(l.service.putBlock("valid",l.input));assert.deepEqual(l.calls,[]);
 l.state.member=true;l.state.corrupt=true;await assert.rejects(l.service.putBlock("valid",l.input));assert.ok(!l.calls.includes("verify"));
});
test("command strict validation and no caller-supplied attestation",async()=>{
 const l=await lab();await l.service.command("valid","begin",l.w.header);
 await assert.rejects(l.service.command("valid","verify",l.w.header));
 await assert.rejects(l.service.command("valid","commit",{...l.w.header,title:"plaintext"}));
 assert.deepEqual(l.calls,["begin"]);
});
