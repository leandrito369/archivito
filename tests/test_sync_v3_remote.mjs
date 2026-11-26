import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {encodeV3Record} from "../app/sync-v3-contract.mjs";
import {makeV3Wire,CHUNK} from "../app/sync-v3-wire.mjs";
import {createV3Remote,drainV3Once} from "../app/sync-v3-remote.mjs";
async function lab(options={}){
 const key=await unlockRecoveryCode(await generateRecoveryCode());
 const c={archiveId:randomUUID(),memoryId:randomUUID(),operationId:randomUUID(),revision:1};
 const scope={userId:randomUUID(),archiveId:c.archiveId,keyId:key.keyId,role:"owner",unlocked:true};
 const record={id:"local",schemaVersion:3,kind:"letter",title:"Ficticio",date:"",from:"",to:"",note:"",tags:[],favorite:false,createdAt:"2026-11-25",updatedAt:"2026-11-25",pages:[{id:"p",caption:"",front:new Blob([new Uint8Array(CHUNK+2)],{type:"image/png"}),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
 const packet=await encodeV3Record(key,c,record),wire=await makeV3Wire(packet,0),paths=wire.header.assets[0].chunks.map(c=>c.path);
 const state={verified:new Set(),calls:[],failBlock:false,wrong:false,revoked:false,corrupt:false,conflict:false};
 const row={header:wire.header,revision:1,operation_id:c.operationId,memory_id:c.memoryId,archive_id:c.archiveId};
 const query={select:()=>query,eq:()=>query,order:()=>query,limit:()=>query,maybeSingle:async()=>({data:row})};
 const client={auth:{getSession:async()=>({data:{session:{user:{id:scope.userId},access_token:"fake"}}})},from:()=>query,storage:{from:()=>({download:async p=>{const b=wire.chunk(p);if(state.corrupt)b[0]^=1;return {data:new Blob([b])};}})}};
 const authorize=async()=>{if(state.revoked)throw Error("revoked");return scope;};
 const fetcher=async(url,opts)=>{
  const u=new URL(url),a=u.searchParams.get("action");state.calls.push(a);
  const op=state.wrong?randomUUID():c.operationId;
  assert.equal(opts.headers.authorization,"Bearer fake");
  let result;
  if(a==="begin")result=state.conflict?{state:"conflict",operationId:op,actualRevision:1}:{state:"staging",operationId:op,verifiedPaths:[...state.verified]};
  if(a==="block"){const p=u.searchParams.get("path");assert.deepEqual(opts.body,wire.chunk(p));state.verified.add(p);if(state.failBlock)throw Error("lost");result={state:"verified",operationId:op,path:p};}
  if(a==="commit")result={state:"synced",operationId:op,revision:1,replayed:false};
  return {ok:true,json:async()=>result};
 };
 const remote=createV3Remote({client,url:"https://test.supabase.co",publishableKey:"sb_publishable_test",scope,authorize,fetcher,enabled:true,...options});
 return {remote,state,packet,paths,c,authorize,scope,client,fetcher};
}
test("lost block response retries same ciphertext, skips verified paths",async()=>{
 const l=await lab();l.state.failBlock=true;await assert.rejects(l.remote.publish(l.packet,0));
 l.state.failBlock=false;const result=await l.remote.publish(l.packet,0);
 assert.equal(result.state,"synced");assert.deepEqual(l.state.calls,["begin","block","begin","block","commit"]);
});
test("wrong receipt, revoked access, conflict do not transmit subsequent blocks",async()=>{
 const l=await lab();l.state.wrong=true;await assert.rejects(l.remote.publish(l.packet,0));assert.deepEqual(l.state.calls,["begin"]);
 l.state.wrong=false;l.state.revoked=true;await assert.rejects(l.remote.publish(l.packet,0));assert.equal(l.state.calls.length,1);
 l.state.revoked=false;l.state.conflict=true;assert.equal((await l.remote.publish(l.packet,0)).state,"conflict");assert.equal(l.state.calls.length,2);
});
test("authenticated read reconstructs exact packet and rejects corrupted chunks",async()=>{
 const l=await lab();assert.deepEqual((await l.remote.read(l.c.memoryId)).packet,l.packet);
 l.state.corrupt=true;await assert.rejects(l.remote.read(l.c.memoryId,1));
});
test("outbox preserves error instead of confirming failed transfer",async()=>{
 const l=await lab();l.state.failBlock=true;let result;
 const outbox={claim:async()=>({packet:l.packet,expectedRevision:0,remoteId:l.c.memoryId,token:"token"}),finish:async(id,token,r)=>{assert.equal(id,l.c.memoryId);assert.equal(token,"token");result=r;return true;}};
 assert.equal((await drainV3Once({outbox,remote:l.remote,authorize:l.authorize})).state,"error");assert.deepEqual(result,{state:"error"});
});

test("two blocks in flight, commit after both settle, metrics no identity",async()=>{
 const l=await lab();const {createV3Metrics}=await import("../app/sync-v3-metrics.mjs");
 let active=0,peak=0,checks=0;const progress=[],metrics=createV3Metrics();
 const r=createV3Remote({client:l.client,url:"https://test.supabase.co",publishableKey:"sb_publishable_test",scope:l.scope,authorize:async()=>{checks++;return l.scope;},localGuard:()=>l.scope,concurrency:2,enabled:true,metrics,onProgress:p=>progress.push(p),
 fetcher:async(url,opts)=>{
  const action=new URL(url).searchParams.get("action");
  if(action==="commit")assert.equal(active,0);
  if(action!=="block")return l.fetcher(url,opts);
  active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,20));return await l.fetcher(url,opts);}finally{active--;}
 }});
 assert.equal((await r.publish(l.packet,0)).state,"synced");assert.equal(peak,2);assert.equal(checks,5);
 assert.equal(progress.at(-1).phase,"commit");assert.equal(progress.at(-1).done,2);
 assert.equal(metrics.snapshot().find(x=>x.phase==="block").count,2);
 assert.ok(metrics.snapshot().every(x=>Object.keys(x).sort().join(",")==="bytes,count,ms,phase"));
});
test("failed parallel batch drains in-flight requests before returning and never commits",async()=>{
 const l=await lab();let active=0,started=0,settled=0,commit=false;
 const r=createV3Remote({client:l.client,url:"https://test.supabase.co",publishableKey:"sb_publishable_test",scope:l.scope,authorize:l.authorize,localGuard:()=>l.scope,concurrency:2,enabled:true,
 fetcher:async(url,opts)=>{
  const a=new URL(url).searchParams.get("action");if(a==="commit")commit=true;
  if(a!=="block")return l.fetcher(url,opts);
  const i=++started;active++;try{if(i===1)throw Error("failed");await new Promise(r=>setTimeout(r,30));return await l.fetcher(url,opts);}finally{active--;settled++;}
 }});
 await assert.rejects(r.publish(l.packet,0));assert.equal(started,2);assert.equal(settled,2);assert.equal(active,0);assert.equal(commit,false);
});
test("epoch invalidation during parallel batch prevents commit",async()=>{
 const l=await lab();let locked=false,commit=false;
 const guard=()=>{if(locked)throw Error("locked");return l.scope;};
 const r=createV3Remote({client:l.client,url:"https://test.supabase.co",publishableKey:"sb_publishable_test",scope:l.scope,authorize:l.authorize,localGuard:guard,concurrency:2,enabled:true,
 fetcher:async(url,opts)=>{
  const a=new URL(url).searchParams.get("action");if(a==="commit")commit=true;
  if(a==="block")locked=true;
  return l.fetcher(url,opts);
 }});
 await assert.rejects(r.publish(l.packet,0));assert.equal(commit,false);
});
