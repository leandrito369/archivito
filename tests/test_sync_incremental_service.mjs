import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,webcrypto} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {prepareIncremental} from "../app/sync-incremental.mjs";
import {makeIncrementalWire,CHUNK} from "../app/sync-incremental-wire.mjs";
import {createIncrementalService} from "../server/sync-incremental-service.mjs";
async function lab(){
 const key=await unlockRecoveryCode(await generateRecoveryCode()),c={archiveId:randomUUID(),memoryId:randomUUID(),operationId:randomUUID(),revision:1};
 const record={id:"lab",schemaVersion:3,kind:"letter",title:"Lab",date:"",from:"",to:"",note:"",tags:[],favorite:false,createdAt:"2026-11-25",updatedAt:"2026-11-25",pages:[{id:"p",caption:"",front:new Blob([new Uint8Array(CHUNK+5)],{type:"image/png"}),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
 const delta=await prepareIncremental(key,c,record),w=await makeIncrementalWire(delta),ref=delta.header.refs[0],chunks=w.wire.uploads[0].chunks;
 const user=randomUUID(),objects=new Map(),state={enabled:true,revoked:false,uploads:0,attests:0,committed:false,wrongCatalog:false};
 const opts={enabled:true,verifyUser:async t=>t==="token"&&!state.revoked?{id:user}:null,
 step:async(u,a,wire,proof)=>{assert.equal(u,user);assert.deepEqual(wire,w.wire);if(!state.enabled)throw Error("gate");
 if(a==="attest"){assert.deepEqual(proof,{assetId:ref.id,sha256:ref.cipherSha256});state.attests++;return {state:"verified"};}
 return {state:state.committed?"synced":"staging"};},
 inspect:async(u,a,action,m,o,x)=>{if(!state.enabled)throw Error("gate");assert.equal(u,user);assert.equal(a,c.archiveId);
 if(action==="intent"){assert.equal(o,c.operationId);return w.wire;}
 if(!state.committed)throw Error("not committed");
 if(action==="head"||action==="revision")return w.wire;
 return {archiveId:a,memoryId:m,operationId:o,keyId:key.keyId,ref,chunks:state.wrongCatalog?chunks.map(b=>({...b,path:"bad"})):chunks};},
 upload:async(p,b)=>{state.uploads++;if(objects.has(p))throw Error("exists");objects.set(p,b.slice());},
 download:async p=>objects.get(p)?.slice()??null};
 const svc=createIncrementalService(opts),q={archiveId:c.archiveId,operationId:c.operationId,memoryId:c.memoryId,assetId:ref.id};
 const put=b=>svc.putBlock("token",{...q,path:b.path,bytes:w.chunk(b.path)});
 return {svc,q,w,ref,chunks,objects,state,put,opts};
}
test("first upload, retry, whole-asset attestation only after all blocks",async()=>{
 const l=await lab();await l.put(l.chunks[0]);await l.put(l.chunks[0]);assert.equal(l.state.uploads,1);
 await assert.rejects(l.svc.attestAsset("token",l.q));assert.equal(l.state.attests,0);
 await l.put(l.chunks[1]);await l.svc.attestAsset("token",l.q);assert.equal(l.state.attests,1);
});
test("reject wrong hash/path, caller attestation and closed gate",async()=>{
 const l=await lab(),b=l.chunks[0];await assert.rejects(l.svc.putBlock("token",{...l.q,path:b.path,bytes:new Uint8Array(b.size).fill(1)}));
 await assert.rejects(l.svc.putBlock("token",{...l.q,path:"bad",bytes:l.w.chunk(b.path)}));
 await assert.rejects(l.svc.command("token","attest",l.w.wire));l.state.enabled=false;await assert.rejects(l.put(b));assert.equal(l.state.uploads,0);
});
test("corrupt stored block never overwritten or attested",async()=>{
 const l=await lab();for(const b of l.chunks)await l.put(b);
 l.objects.get(l.chunks[0].path)[0]^=1;await assert.rejects(l.put(l.chunks[0]));await assert.rejects(l.svc.attestAsset("token",l.q));assert.equal(l.state.uploads,2);assert.equal(l.state.attests,0);
});
test("catalog download only committed, exact path and hash, revocation rejects",async()=>{
 const l=await lab();for(const b of l.chunks)await l.put(b);
 await assert.rejects(l.svc.getBlock("token",{...l.q,index:0}));
 l.state.committed=true;assert.deepEqual(await l.svc.getBlock("token",{...l.q,index:0}),l.w.chunk(l.chunks[0].path));
 l.state.wrongCatalog=true;await assert.rejects(l.svc.getBlock("token",{...l.q,index:0}));l.state.wrongCatalog=false;
 l.state.revoked=true;await assert.rejects(l.svc.catalog("token",l.q));
});
test("lost response create-only upload recovered by verified readback",async()=>{
 const l=await lab(),original=l.opts.upload;
 const svc=createIncrementalService({...l.opts,upload:async(p,b)=>{await original(p,b);throw Error("lost");}});
 assert.equal((await svc.putBlock("token",{...l.q,path:l.chunks[0].path,bytes:l.w.chunk(l.chunks[0].path)})).state,"stored");
 assert.equal(l.state.uploads,1);
});
