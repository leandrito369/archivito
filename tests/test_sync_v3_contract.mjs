import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {encodeV3Record,decodeV3Record} from "../app/sync-v3-contract.mjs";
const blob=(n,type="image/png")=>new Blob([new Uint8Array([n,n+1])],{type});
const context=()=>({archiveId:randomUUID(),memoryId:randomUUID(),operationId:randomUUID(),revision:1});
const crop={algorithm:"homography-js-v1",points:[{x:1,y:2},{x:3,y:4},{x:5,y:6},{x:7,y:8}],input:{width:100,height:200},output:{width:80,height:160}};
const record=()=>({id:"legacy-local-id",schemaVersion:3,kind:"letter",title:"Carta de prueba",date:"2026-11-25",from:"A",to:"B",note:"Texto privado",tags:["recuerdo"],favorite:true,createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-25T00:00:00Z",pages:[
 {id:"p-0",caption:"Hoja uno",front:blob(1),back:blob(3,"image/gif"),frontDerived:blob(5),backDerived:blob(7),frontCrop:crop,backCrop:crop,thumb:blob(99)},
 {id:"p-1",caption:"Hoja dos",front:blob(9,"image/webp"),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]});
const tools={validateImage:async b=>assert.ok(b instanceof Blob),makeThumb:async b=>new Blob([await b.arrayBuffer()],{type:"image/jpeg"})};
const key=async()=>unlockRecoveryCode(await generateRecoveryCode());
test("v3 two pages, all originals/derivatives, metadata, crop and local identity roundtrip",async()=>{
 const k=await key(),c=context(),r=record(),p=await encodeV3Record(k,c,r),out=await decodeV3Record(k,c,p,tools);
 assert.equal(p.assets.length,5);assert.equal(out.id,r.id);assert.equal(out.updatedAt,r.updatedAt);assert.equal(out.createdAt,r.createdAt);
 assert.equal(out.favorite,true);assert.deepEqual(out.tags,r.tags);assert.equal(out.note,r.note);
 for(let i=0;i<r.pages.length;i++){
  const a=r.pages[i],b=out.pages[i];assert.equal(a.id,b.id);assert.equal(a.caption,b.caption);assert.deepEqual(a.frontCrop,b.frontCrop);assert.deepEqual(a.backCrop,b.backCrop);
  for(const side of ["front","back","frontDerived","backDerived"]){
   if(!a[side])assert.equal(b[side],null);else {assert.equal(a[side].type,b[side].type);assert.deepEqual(await a[side].arrayBuffer(),await b[side].arrayBuffer());}
  }
 }
 assert.equal(out.front,out.pages[0].front);assert.equal(out.thumb,out.pages[0].thumb);assert.equal(r.pages[0].thumb.size,2);
 assert.equal(p.format,"archivito-sync-record-v3");assert.ok(!JSON.stringify(p).includes(r.note));assert.ok(!JSON.stringify(p).includes(r.id));
});
test("all 25 pages and 100 assets supported within local byte budget",async()=>{
 const k=await key(),c=context(),r=record();r.pages=Array.from({length:25},(_,i)=>({...r.pages[0],id:"page-"+i}));
 const p=await encodeV3Record(k,c,r);assert.equal(p.assets.length,100);assert.equal((await decodeV3Record(k,c,p,tools)).pages.length,25);
});
test("wrong key or context, missing, duplicated or tampered ciphertext rejected",async()=>{
 const k=await key(),c=context(),p=await encodeV3Record(k,c,record());
 await assert.rejects(decodeV3Record(await key(),c,p,tools));
 await assert.rejects(decodeV3Record(k,{...c,operationId:randomUUID()},p,tools));
 await assert.rejects(decodeV3Record(k,c,{...p,assets:p.assets.slice(1)},tools));
 await assert.rejects(decodeV3Record(k,c,{...p,assets:[...p.assets,p.assets[0]]},tools));
 const bad=structuredClone(p);bad.assets[0].ciphertext[0]^=1;
 let thumbnails=0;await assert.rejects(decodeV3Record(k,c,bad,{...tools,makeThumb:async()=>{thumbnails++;return blob(1);}}));assert.equal(thumbnails,0);
});
test("reject malformed source without truncating original",async()=>{
 const k=await key(),c=context(),r=record();r.title="x".repeat(121);
 await assert.rejects(encodeV3Record(k,c,r));assert.equal(r.title.length,121);
 r.title="ok";r.pages[0].back=null;await assert.rejects(encodeV3Record(k,c,r));
 r.pages[0].back=blob(3);r.pages[1].id=r.pages[0].id;await assert.rejects(encodeV3Record(k,c,r));
});
test("per-image and aggregate size limits fail before encryption",async()=>{
 const k=await key(),c=context(),r=record();
 r.pages[0].front=new Blob([new Uint8Array(35*1024*1024+1)],{type:"image/png"});await assert.rejects(encodeV3Record(k,c,r));
 const big=new Blob([new Uint8Array(33*1024*1024)],{type:"image/png"});
 r.pages[0].front=big;r.pages[0].back=big;r.pages[0].frontDerived=big;r.pages[0].backDerived=big;await assert.rejects(encodeV3Record(k,c,r));
});
test("image validation failure aborts materialization",async()=>{
 const k=await key(),c=context(),p=await encodeV3Record(k,c,record());
 await assert.rejects(decodeV3Record(k,c,p,{...tools,validateImage:async()=>{throw Error("invalid image");}}));
});
