import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {prepareIncremental,decodeIncremental} from "../app/sync-incremental.mjs";
import {CHUNK,makeIncrementalWire,validateIncrementalWire,readIncrementalAsset} from "../app/sync-incremental-wire.mjs";
async function lab(){
 const key=await unlockRecoveryCode(await generateRecoveryCode()),c={archiveId:randomUUID(),memoryId:randomUUID(),operationId:randomUUID(),revision:1};
 const r={id:"local",schemaVersion:3,kind:"letter",title:"Privado",date:"",from:"",to:"",note:"Nota privada",tags:[],favorite:false,createdAt:"2026-11-25",updatedAt:"2026-11-25",pages:[{id:"p",caption:"",front:new Blob([new Uint8Array(CHUNK+7)],{type:"image/png"}),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
 const one=await prepareIncremental(key,c,r),base={revision:1,operationId:c.operationId},expected={...c,keyId:key.keyId};
 const two=await prepareIncremental(key,{...c,operationId:randomUUID(),revision:2},{...r,title:"Editado"},{expected,header:one.header});
 return {key,c,r,one,two,base,expected,w:await makeIncrementalWire(one)};
}
test("first publication uses bounded chunks and roundtrips; no plaintext",async()=>{
 const l=await lab(),w=JSON.parse(JSON.stringify(l.w.wire)),h=validateIncrementalWire(w);
 assert.deepEqual(h,l.one.header);assert.deepEqual(w.uploads[0].chunks.map(c=>c.size),[CHUNK,23]);assert.ok(!JSON.stringify(w).includes("Nota privada"));
 const out=await decodeIncremental(l.key,l.expected,h,{readAsset:r=>readIncrementalAsset(w,l.expected,r,async p=>l.w.chunk(p)),validateImage:async()=>{},makeThumb:async b=>b});
 assert.equal(out.title,"Privado");
});
test("metadata-only upload list empty, birth asset readable through later manifest",async()=>{
 const l=await lab(),w=await makeIncrementalWire(l.two,l.one.header,l.base);
 assert.deepEqual(w.wire.uploads,[]);assert.deepEqual(w.wire.header.refs,l.w.wire.header.refs);
 const expected={...l.expected,revision:2,operationId:l.two.header.operationId};
 const out=await decodeIncremental(l.key,expected,validateIncrementalWire(w.wire),{readAsset:r=>readIncrementalAsset(l.w.wire,expected,r,async p=>l.w.chunk(p)),validateImage:async()=>{},makeThumb:async b=>b});
 assert.equal(out.title,"Editado");
});
test("malformed paths, counts, unexpected fields and wrong predecessor rejected",async()=>{
 const l=await lab();
 for(const mutate of [w=>w.uploads[0].chunks[0].path="../other",w=>w.uploads[0].chunks.pop(),w=>w.uploads.push(w.uploads[0]),w=>w.header.note="clear",w=>w.uploads[0].chunks[0].size++]){
  const w=structuredClone(l.w.wire);mutate(w);assert.throws(()=>validateIncrementalWire(w));
 }
 await assert.rejects(makeIncrementalWire(l.two,l.one.header,{...l.base,operationId:randomUUID()}));
});
test("missing and tampered blocks, foreign memory and false birth rejected",async()=>{
 const l=await lab(),r=l.one.header.refs[0];
 await assert.rejects(readIncrementalAsset(l.w.wire,l.expected,r,async()=>null));
 await assert.rejects(readIncrementalAsset(l.w.wire,l.expected,r,async p=>{const b=l.w.chunk(p);b[0]^=1;return b;}));
 await assert.rejects(readIncrementalAsset(l.w.wire,{...l.expected,memoryId:randomUUID()},r,async p=>l.w.chunk(p)));
 await assert.rejects(readIncrementalAsset(l.w.wire,l.expected,{...r,born:2},async p=>l.w.chunk(p)));
});
