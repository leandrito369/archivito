import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,webcrypto} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {prepareIncremental,decodeIncremental} from "../app/sync-incremental.mjs";
import {makeIncrementalWire,CHUNK} from "../app/sync-incremental-wire.mjs";
import {createIncrementalRemote} from "../app/sync-incremental-remote.mjs";
async function lab(){
 const key=await unlockRecoveryCode(await generateRecoveryCode()),c={archiveId:randomUUID(),memoryId:randomUUID(),operationId:randomUUID(),revision:1};
 const record={id:"lab",schemaVersion:3,kind:"letter",title:"Lab",date:"",from:"",to:"",note:"",tags:[],favorite:false,createdAt:"2026-11-25",updatedAt:"2026-11-25",pages:[{id:"p",caption:"",front:new Blob([new Uint8Array(CHUNK+2)],{type:"image/png"}),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
 const d=await prepareIncremental(key,c,record),w=await makeIncrementalWire(d),scope={archiveId:c.archiveId,userId:randomUUID(),keyId:key.keyId,role:"owner",unlocked:true};
 const objects=new Map(),verified=new Set(),committed=new Map(),calls=[];
 const st={lostBlock:false,lostCommit:false,wrongReceipt:false,locked:false,wire:w.wire,corrupt:false};
 const json=x=>new Response(JSON.stringify(x),{headers:{"content-type":"application/json"}});
 const remote=createIncrementalRemote({client:{auth:{getSession:async()=>({data:{session:{user:{id:scope.userId},access_token:"token"}}})}},url:"https://test.supabase.co",publishableKey:"sb_publishable_test",scope,enabled:true,authorize:async()=>({...scope,unlocked:!st.locked}),localGuard:()=>({...scope,unlocked:!st.locked}),
 fetcher:async(url,o)=>{
  assert.equal(o.headers.authorization,"Bearer token");const p=new URL(url).searchParams,a=p.get("action");calls.push(a);
  const h=st.wire.header,op=h.operationId,body=a==="block"?null:JSON.parse(o.body);
  if(a==="begin"){assert.deepEqual(body,st.wire);return json(committed.has(op)?{state:"synced",operationId:op,revision:h.revision,replayed:true}:{state:"staging",operationId:op,verifiedAssets:[...verified].filter(id=>st.wire.uploads.some(u=>u.id===id))});}
  if(a==="block"){const path=p.get("path");if(!objects.has(path))objects.set(path,o.body.slice());if(st.lostBlock){st.lostBlock=false;throw Error("network");}return json({state:"stored",operationId:op,path});}
  if(a==="attest"){verified.add(body.assetId);return json({state:"verified",operationId:op,assetId:body.assetId});}
  if(a==="commit"){committed.set(op,st.wire);if(st.lostCommit){st.lostCommit=false;throw Error("lost receipt");}return json({state:"synced",operationId:op,revision:st.wrongReceipt?99:h.revision,replayed:false});}
  if(a==="manifest")return json(st.wire);
  if(a==="catalog")return json({archiveId:c.archiveId,memoryId:c.memoryId,operationId:op,keyId:key.keyId,ref:d.header.refs[0],chunks:w.wire.uploads[0].chunks});
  if(a==="download"){const b=objects.get(w.wire.uploads[0].chunks[body.index].path).slice();if(st.corrupt)b[0]^=1;return new Response(b,{headers:{"content-type":"application/octet-stream"}});}
  throw Error("bad action");
 }});
 return {key,c,record,d,w,scope,objects,verified,committed,calls,st,remote};
}
test("lost block and commit responses recover exact operation without duplicate objects",async()=>{
 const l=await lab();l.st.lostBlock=true;
 await assert.rejects(l.remote.publish(l.w.wire,l.w.chunk));assert.equal(l.objects.size,1);
 l.st.lostCommit=true;await assert.rejects(l.remote.publish(l.w.wire,l.w.chunk));assert.equal(l.objects.size,2);assert.equal(l.committed.size,1);
 const r=await l.remote.publish(l.w.wire,l.w.chunk);assert.equal(r.replayed,true);assert.equal(l.objects.size,2);
});
test("metadata-only edit uploads no images and reads verified prior asset",async()=>{
 const l=await lab();await l.remote.publish(l.w.wire,l.w.chunk);
 const two=await prepareIncremental(l.key,{...l.c,operationId:randomUUID(),revision:2},{...l.record,title:"Edited"},{expected:{...l.c,keyId:l.key.keyId},header:l.d.header});
 const w=await makeIncrementalWire(two,l.d.header,{revision:1,operationId:l.c.operationId});
 l.st.wire=w.wire;l.calls.length=0;await l.remote.publish(w.wire,()=>{throw Error("no new chunks");});assert.deepEqual(l.calls,["begin","commit"]);
 const m=await l.remote.manifest(l.c.memoryId);
 const record=await decodeIncremental(l.key,m.expected,m.header,{readAsset:r=>l.remote.readAsset(m.expected,r),validateImage:async()=>{},makeThumb:async b=>b});
 assert.equal(record.title,"Edited");assert.equal(l.objects.size,2);
 l.st.corrupt=true;await assert.rejects(l.remote.readAsset(m.expected,m.header.refs[0]));
});
test("invalid receipt, abort and lock cannot acknowledge success",async()=>{
 const l=await lab();l.st.wrongReceipt=true;await assert.rejects(l.remote.publish(l.w.wire,l.w.chunk));
 const controller=new AbortController();controller.abort();await assert.rejects(l.remote.publish(l.w.wire,l.w.chunk,{signal:controller.signal}));
 l.st.locked=true;await assert.rejects(l.remote.manifest(l.c.memoryId));
});

test("lease loss prevents the next HTTP request and rejects stale response",async()=>{
 const l=await lab();
 let checks=0;
 await assert.rejects(l.remote.publish(l.w.wire,l.w.chunk,{assertLease:async()=>{if(++checks===3)throw Error("lease expired");}}));
 assert.deepEqual(l.calls,["begin"]);
 assert.equal(l.objects.size,0);
 assert.equal(l.committed.size,0);
 l.calls.length=0;
 await assert.rejects(l.remote.publish(l.w.wire,l.w.chunk,{assertLease:async()=>{if(l.calls.includes("block"))throw Error("lease replaced");}}));
 assert.deepEqual(l.calls,["begin","block"]);
 assert.equal(l.committed.size,0);
 const result=await l.remote.publish(l.w.wire,l.w.chunk,{assertLease:async()=>{}});
 assert.equal(result.state,"synced");
 assert.equal(l.objects.size,2);
});

import {handleFencedIncremental,parseFence,verifiedSession} from "../server/sync-incremental-fenced-service.mjs";
test("fenced client and service: exact acquisition recovery, no legacy and guarded Storage",async()=>{
 const l=await lab(),sessionId=randomUUID(),jwt="e30."+Buffer.from(JSON.stringify({sub:l.scope.userId,role:"authenticated",session_id:sessionId})).toString("base64url")+".synthetic";
 const objects=new Map(),calls=[],actions=[];let gen=0,fenceToken=null,committed=false,verified=false,lost=true,allow=true,revokeOnDownload=false;
 const rpc=async p=>{
  assert.equal(p.p_actor,l.scope.userId);assert.equal(p.p_session,sessionId);
  calls.push(p.p_action);if(!allow)throw Error("revoked");
  if(p.p_action==="claim"){
   assert.deepEqual(p.p_wire,l.w.wire);
   gen++;fenceToken=randomUUID();
   return {generation:gen,token:fenceToken,result:committed?{state:"synced",operationId:l.c.operationId,revision:1,replayed:true}:{state:"staging",operationId:l.c.operationId,verifiedAssets:verified?[l.d.header.refs[0].id]:[]}};
  }
  if(["lookup","intent","attest","commit"].includes(p.p_action)){
   assert.equal(p.p_generation,gen);assert.equal(p.p_token,fenceToken);
   if(p.p_action==="intent")return l.w.wire;
   if(p.p_action==="lookup")return {state:"staging",operationId:l.c.operationId,verifiedAssets:[]};
   if(p.p_action==="attest"){verified=true;return {state:"verified",operationId:l.c.operationId,assetId:p.p_asset};}
   committed=true;return {state:"synced",operationId:l.c.operationId,revision:1,replayed:false};
  }
  assert.equal(p.p_generation,undefined);assert.equal(p.p_token,undefined);
  if(p.p_action==="head"||p.p_action==="revision")return l.w.wire;
  if(p.p_action==="catalog")return {archiveId:l.c.archiveId,memoryId:l.c.memoryId,operationId:l.c.operationId,keyId:l.key.keyId,ref:l.d.header.refs[0],chunks:l.w.wire.uploads[0].chunks};
  throw Error("unexpected action");
 };
 const common={token:jwt,verifyUser:async t=>t===jwt?{id:l.scope.userId}:null,rpc,
  upload:async(path,b)=>{assert(!objects.has(path));objects.set(path,b.slice());},
  download:async(path)=>{const result=objects.get(path)?.slice()??null;if(revokeOnDownload)allow=false;return result;}};
 const remote=createIncrementalRemote({client:{auth:{getSession:async()=>({data:{session:{user:{id:l.scope.userId},access_token:jwt}}})}},url:"https://test.supabase.co",publishableKey:"sb_publishable_test",scope:l.scope,enabled:true,fenced:true,authorize:async()=>l.scope,localGuard:()=>l.scope,
  fetcher:async(url,o)=>{
   const p=new URL(url).searchParams,action=p.get("action");actions.push(action);
   const fence=parseFence(o.headers["x-archivito-generation"]??null,o.headers["x-archivito-fence"]??null);
   const result=await handleFencedIncremental({...common,action,fence,body:action==="block"?null:JSON.parse(o.body),block:action==="block"?{archiveId:p.get("archiveId"),operationId:p.get("operationId"),path:p.get("path"),bytes:o.body}:undefined});
   if(action==="claim"&&lost){lost=false;throw Error("lost acquisition response");}
   return result instanceof Uint8Array?new Response(result,{headers:{"content-type":"application/octet-stream"}}):new Response(JSON.stringify(result),{headers:{"content-type":"application/json"}});
  }});
 assert.equal(verifiedSession(jwt,l.scope.userId),sessionId);
 assert.throws(()=>parseFence("1",null));
 assert.throws(()=>verifiedSession(jwt,randomUUID()));
 await assert.rejects(handleFencedIncremental({...common,action:"begin",body:l.w.wire,fence:null}));
 await assert.rejects(handleFencedIncremental({...common,action:"commit",body:l.w.wire,fence:null}));
 await assert.rejects(remote.publish(l.w.wire,l.w.chunk));assert.deepEqual(actions,["claim"]);assert.equal(objects.size,0);
 // Mock permits immediate second claim; real SQL waits for expiry (separate lab).
 const result=await remote.publish(l.w.wire,l.w.chunk);
 assert.equal(result.state,"synced");assert.equal(gen,2);assert.equal(objects.size,2);
 assert(!actions.includes("begin"));assert(calls.filter(x=>x==="intent").length>=4);
 const m=await remote.manifest(l.c.memoryId);
 assert.deepEqual(await remote.readAsset(m.expected,m.header.refs[0]),l.d.newAssets[0].ciphertext);
 revokeOnDownload=true;
 await assert.rejects(remote.readAsset(m.expected,m.header.refs[0]));
});
