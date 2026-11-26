import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {encodeV3Record,decodeV3Record} from "../app/sync-v3-contract.mjs";
import {validatePackage} from "../app/sync-contract.mjs";
import {CHUNK,makeV3Wire,readV3Wire,validateV3Header,verifyV3Chunk} from "../app/sync-v3-wire.mjs";
async function lab(){
 const key=await unlockRecoveryCode(await generateRecoveryCode()),c={archiveId:randomUUID(),memoryId:randomUUID(),operationId:randomUUID(),revision:1};
 const bytes=new Uint8Array(CHUNK+3);bytes[CHUNK]=8;
 const r={id:"private-local",schemaVersion:3,kind:"letter",title:"Ficticio",date:"",from:"",to:"",note:"Nota privada",tags:[],favorite:false,createdAt:"2026-11-25",updatedAt:"2026-11-25",pages:[{id:"p",caption:"",front:new Blob([bytes],{type:"image/png"}),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
 const p=await encodeV3Record(key,c,r),w=await makeV3Wire(p,0);
 return {key,c,p,w,expected:{...c,keyId:key.keyId},bytes};
}
test("multi-block ciphertext roundtrip, exact path and no plaintext",async()=>{
 const l=await lab(),a=l.w.header.assets[0];assert.equal(a.chunks.length,2);assert.equal(a.chunks[0].size,CHUNK);assert.equal(a.chunks[1].size,19);
 const p=await readV3Wire(l.w.header,l.expected,async n=>l.w.chunk(n));assert.deepEqual(p,l.p);
 const out=await decodeV3Record(l.key,l.c,p,{validateImage:async()=>{},makeThumb:async b=>b});assert.deepEqual(new Uint8Array(await out.front.arrayBuffer()),l.bytes);
 assert.ok(!JSON.stringify(l.w.header).includes("Nota privada"));assert.throws(()=>validatePackage(p));
});
test("server block verification rejects mismatch and unknown paths",async()=>{
 const l=await lab(),c=l.w.header.assets[0].chunks[0];
 assert.deepEqual(await verifyV3Chunk(l.w.header,c.path,async n=>l.w.chunk(n)),{path:c.path,size:c.size,sha256:c.sha256});
 await assert.rejects(verifyV3Chunk(l.w.header,"other/path",async()=>new Uint8Array()));
 await assert.rejects(verifyV3Chunk(l.w.header,c.path,async n=>{const b=l.w.chunk(n);b[0]^=1;return b;}));
});
test("path, length, duplicate asset, extra plaintext and wrong revision rejected",async()=>{
 const l=await lab();
 for(const change of [h=>h.assets[0].chunks[0].path="../other",h=>h.assets[0].chunks[1].size++,h=>h.assets.push(h.assets[0]),h=>h.title="clear",h=>h.expectedRevision=3]){
  const h=structuredClone(l.w.header);change(h);assert.throws(()=>validateV3Header(h));
 }
 await assert.rejects(readV3Wire(l.w.header,{...l.expected,operationId:randomUUID()},async n=>l.w.chunk(n)));
});
test("missing block, wrong whole asset hash and mutated block rejected",async()=>{
 const l=await lab();
 await assert.rejects(readV3Wire(l.w.header,l.expected,async()=>null));
 const h=structuredClone(l.w.header);h.assets[0].sha256="0".repeat(64);
 await assert.rejects(readV3Wire(h,l.expected,async n=>l.w.chunk(n)));
 await assert.rejects(readV3Wire(l.w.header,l.expected,async n=>{const b=l.w.chunk(n);b[0]^=1;return b;}));
});
test("same queued ciphertext produces exact header on retry",async()=>{
 const l=await lab(),again=await makeV3Wire(l.p,0);assert.deepEqual(again.header,l.w.header);
});
