import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {prepareIncremental,decodeIncremental,validateIncrementalDelta} from "../app/sync-incremental.mjs";
import {validateV3Package} from "../app/sync-v3-contract.mjs";
const blob=(n,size=5)=>new Blob([new Uint8Array(size).fill(n)],{type:"image/png"});
function record(){return {id:"local",schemaVersion:3,kind:"letter",title:"Ficticia",date:"",from:"",to:"",note:"",tags:[],favorite:false,createdAt:"2026-11-25",updatedAt:"2026-11-25",pages:[{id:"p1",caption:"",front:blob(1,7*1024*1024),back:blob(2),frontDerived:blob(3),backDerived:blob(4),frontCrop:{algorithm:"test"},backCrop:{algorithm:"test"}},{id:"p2",caption:"",front:blob(5),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};}
async function lab(){
 const key=await unlockRecoveryCode(await generateRecoveryCode()),c={archiveId:randomUUID(),memoryId:randomUUID(),operationId:randomUUID(),revision:1},r=record();
 const one=await prepareIncremental(key,c,r);
 const expected=d=>({...c,revision:d.header.revision,operationId:d.header.operationId,keyId:key.keyId});
 const prior=d=>({expected:expected(d),header:d.header});
 const next=d=>({...c,revision:d.header.revision+1,operationId:randomUUID()});
 const objects=new Map(one.newAssets.map(a=>[a.id,a.ciphertext]));
 const tools={readAsset:async r=>objects.get(r.id),validateImage:async()=>{},makeThumb:async b=>b};
 return {key,c,r,one,prior,next,expected,objects,tools};
}
test("metadata-only edit reuses all five immutable assets, no image ciphertext upload",async t=>{
 const l=await lab(),a=await validateIncrementalDelta(l.one);
 const two=await prepareIncremental(l.key,l.next(l.one),{...l.r,title:"Nuevo título",favorite:true},l.prior(l.one));
 const b=await validateIncrementalDelta(two,l.one.header);
 assert.equal(a.newAssets,5);assert.deepEqual(b,{newBytes:0,newAssets:0,reusedAssets:5});
 assert.deepEqual(two.header.refs,l.one.header.refs);assert.notDeepEqual(two.header.metadata.ciphertext,l.one.header.metadata.ciphertext);
 const out=await decodeIncremental(l.key,l.expected(two),two.header,l.tools);
 assert.equal(out.title,"Nuevo título");assert.equal(out.favorite,true);assert.equal(out.pages.length,2);
 assert.deepEqual(await out.front.arrayBuffer(),await l.r.pages[0].front.arrayBuffer());
 assert.throws(()=>validateV3Package(two));
 t.diagnostic(JSON.stringify({initialImageCiphertextBytes:a.newBytes,metadataOnlyImageCiphertextBytes:b.newBytes,metadataCiphertextBytes:two.header.metadata.ciphertext.length}));
});
test("replace one photo, preserve original references and history",async()=>{
 const l=await lab();const r=structuredClone(l.r);r.pages[0].back=blob(9,100);
 const two=await prepareIncremental(l.key,l.next(l.one),r,l.prior(l.one)),b=await validateIncrementalDelta(two,l.one.header);
 assert.deepEqual(b,{newBytes:116,newAssets:1,reusedAssets:4});
 for(const a of two.newAssets)l.objects.set(a.id,a.ciphertext);
 const old=await decodeIncremental(l.key,l.expected(l.one),l.one.header,l.tools),out=await decodeIncremental(l.key,l.expected(two),two.header,l.tools);
 assert.deepEqual(await out.back.arrayBuffer(),await r.pages[0].back.arrayBuffer());assert.deepEqual(await old.back.arrayBuffer(),await l.r.pages[0].back.arrayBuffer());
});
test("new page transfers only new asset, removed page not referenced",async()=>{
 const l=await lab(),r=structuredClone(l.r);r.pages.push({...r.pages[1],id:"p3",front:blob(7,20)});
 const two=await prepareIncremental(l.key,l.next(l.one),r,l.prior(l.one));
 assert.deepEqual(await validateIncrementalDelta(two,l.one.header),{newBytes:36,newAssets:1,reusedAssets:5});
 r.pages.splice(2,1);r.pages.splice(1,1);
 const three=await prepareIncremental(l.key,l.next(two),r,l.prior(two));
 assert.deepEqual(await validateIncrementalDelta(three,two.header),{newBytes:0,newAssets:0,reusedAssets:4});
});
test("untrusted predecessor, wrong context, key, tampered references and missing ciphertext rejected",async()=>{
 const l=await lab(),c=l.next(l.one);
 await assert.rejects(prepareIncremental(l.key,c,l.r));
 await assert.rejects(prepareIncremental(l.key,{...c,memoryId:randomUUID()},l.r,l.prior(l.one)));
 await assert.rejects(prepareIncremental(l.key,c,l.r,{...l.prior(l.one),expected:{...l.expected(l.one),operationId:randomUUID()}}));
 const two=await prepareIncremental(l.key,c,l.r,l.prior(l.one)),bad=structuredClone(two);
 bad.header.refs[0].cipherSha256="a".repeat(64);
 await assert.rejects(validateIncrementalDelta(bad,l.one.header));
 await assert.rejects(decodeIncremental(l.key,l.expected(two),bad.header,l.tools));
 await assert.rejects(decodeIncremental(l.key,{...l.expected(two),revision:1},two.header,l.tools));
 const other=await unlockRecoveryCode(await generateRecoveryCode());
 await assert.rejects(decodeIncremental(other,l.expected(two),two.header,l.tools));
 await assert.rejects(decodeIncremental(l.key,l.expected(two),two.header,{...l.tools,readAsset:async()=>null}));
 const corrupt={...l.tools,readAsset:async r=>{const b=l.objects.get(r.id).slice();b[0]^=1;return b;}};
 await assert.rejects(decodeIncremental(l.key,l.expected(two),two.header,corrupt));
});
test("new asset is mandatory and exact, no extra or cross-memory reference",async()=>{
 const l=await lab(),bad=structuredClone(l.one);bad.newAssets.pop();await assert.rejects(validateIncrementalDelta(bad));
 const bad2=structuredClone(l.one);bad2.newAssets[0].ciphertext[0]^=1;await assert.rejects(validateIncrementalDelta(bad2));
 const two=await prepareIncremental(l.key,l.next(l.one),l.r,l.prior(l.one));
 await assert.rejects(validateIncrementalDelta({...two,newAssets:l.one.newAssets},l.one.header));
 await assert.rejects(validateIncrementalDelta(two,{...l.one.header,memoryId:randomUUID()}));
});
