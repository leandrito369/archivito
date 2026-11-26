// Fixed synthetic-only memory IDs; no personal library APIs.
import {prepareIncremental,decodeIncremental} from "./sync-incremental.mjs";
import {makeIncrementalWire,validateIncrementalWire} from "./sync-incremental-wire.mjs";
import {openIncrementalLabStore,drainIncrementalLab} from "./sync-incremental-local.mjs";
export const INC_LAB_MEMORIES=Object.freeze({small:"73ac551b-2df8-4da7-91b8-4adf18d83901",medium:"73ac551b-2df8-4da7-91b8-4adf18d83902",large:"73ac551b-2df8-4da7-91b8-4adf18d83903"});
const sides=["front","back","frontDerived","backDerived"];
const fail=()=>{throw Error("Operación de laboratorio rechazada.");};
async function image(n,label){
 const c=document.createElement("canvas");c.width=n;c.height=n;const ctx=c.getContext("2d"),p=ctx.createImageData(n,n),raw=new Uint8Array(n*n*3);
 for(let i=0;i<raw.length;i+=65536)crypto.getRandomValues(raw.subarray(i,Math.min(raw.length,i+65536)));
 for(let i=0,j=0;i<p.data.length;i+=4){p.data[i]=raw[j++];p.data[i+1]=raw[j++];p.data[i+2]=raw[j++];p.data[i+3]=255;}
 ctx.putImageData(p,0,0);ctx.fillStyle="#fff";ctx.fillRect(0,0,n,44);ctx.fillStyle="#333";ctx.font="16px sans-serif";ctx.fillText("FICTICIA · "+label,8,26);
 const b=await new Promise(r=>c.toBlob(r,"image/png"));if(!b)fail();return b;
}
async function validateImage(b){if(b.type!=="image/png"||b.size>20*1024*1024)fail();const p=await createImageBitmap(b);try{if(p.width<1||p.height<1||p.width>2000||p.height>2000)fail();}finally{p.close();}}
async function thumb(b){const p=await createImageBitmap(b);try{const c=document.createElement("canvas");c.width=120;c.height=120;c.getContext("2d").drawImage(p,0,0,120,120);const t=await new Promise(r=>c.toBlob(r,"image/png"));if(!t)fail();return t;}finally{p.close();}}
async function sample(m,size){
 const n={small:280,medium:1500,large:1900}[size],front=await image(n,"frente"),back=await image(160,"reverso"),now=new Date().toISOString();
 return {id:m,schemaVersion:3,kind:"letter",title:"Carta ficticia incremental",date:"2026-11-25",from:"Muestra A",to:"Muestra B",note:"Sin información personal.",tags:["certificacion"],favorite:false,createdAt:now,updatedAt:now,pages:[{id:"p1",caption:"Muestra",front,back,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
}
function expected(h){return {archiveId:h.archiveId,memoryId:h.memoryId,operationId:h.operationId,revision:h.revision,keyId:h.keyId};}
export async function runIncrementalLab({scope,key,authorize,remote,action,size,metrics,signal}){
 await authorize();if(!Object.hasOwn(INC_LAB_MEMORIES,size)||!["create","read","edit","photo","retry","status"].includes(action))fail();
 const m=INC_LAB_MEMORIES[size],store=await openIncrementalLabStore(scope);
 const measure=(p,f)=>metrics?metrics.measure(p,f):f();
 let hits=0,downloadBytes=0,newBytes=0,newAssets=0;
 async function decode(h){
  return measure("apply",()=>decodeIncremental(key,expected(h),h,{validateImage,makeThumb:thumb,readAsset:async ref=>{
   await authorize();const r=await store.cached(m,ref,()=>remote.readAsset(expected(h),ref,{signal}));await authorize();
   if(r.hit)hits++;else downloadBytes+=r.bytes.length;return r.bytes;
  }}));
 }
 try{
  let s=await store.status(m);
  if(action==="status")return {state:"status",revision:s.wire?.header.revision??0,pending:s.pending?.state??null};
  if(action==="read"){
   if(s.pending)return {state:"pending-exists",pending:s.pending.state,revision:s.wire?.header.revision??0};
   const value=await remote.manifest(m,null,{signal});if(!value)return {state:"empty",revision:0};
   const r=await decode(value.header);await authorize();await store.acceptRead(m,value.wire);
   return {state:"applied",revision:value.header.revision,assets:value.header.refs.length,title:r.title,hits,downloadBytes};
  }
  if(action==="retry"){
   if(!s.pending||s.pending.state==="conflict")return {state:s.pending?.state??"idle",revision:s.wire?.header.revision??0};
  }else{
   if(s.pending)return {state:"pending-exists",pending:s.pending.state,revision:s.wire?.header.revision??0};
   let r,prior=null,base=null;
   if(action==="create"){
    if(scope.role!=="owner"||s.wire)fail();
    if(await remote.manifest(m,null,{signal}))return {state:"already-remote",revision:0};
    r=await measure("sample",()=>sample(m,size));
   }else{
    if(!s.wire)return {state:"read-first",revision:0};
    const h=validateIncrementalWire(s.wire);if(h.revision>=24)fail();
    // Check current authorization even on a cache hit. A stale predecessor is
    // deliberately retained so the server can detect the conflicting edit.
    await remote.manifest(m,h.operationId,{signal});
    r=await decode(h);prior={expected:expected(h),header:h};base={revision:h.revision,operationId:h.operationId};
    r={...r,title:"Carta ficticia · "+scope.role+" r"+(h.revision+1),note:"Edición sintética",favorite:!r.favorite,updatedAt:new Date().toISOString()};
    if(action==="photo")r.pages[0].back=await image(160,"reverso nuevo");
   }
   const c={archiveId:scope.archiveId,memoryId:m,operationId:crypto.randomUUID(),revision:(base?.revision??0)+1};
   const d=await measure("prepare",()=>prepareIncremental(key,c,r,prior));
   newAssets=d.newAssets.length;newBytes=d.newAssets.reduce((n,a)=>n+a.ciphertext.length,0);
   const w=await measure("wire",()=>makeIncrementalWire(d,prior?.header??null,base));
   await authorize();await store.prepare(m,w.wire,w.chunk);
  }
  const result=await drainIncrementalLab({store,memoryId:m,remote,authorize,signal});
  s=await store.status(m);
  return {state:result.state,revision:s.wire?.header.revision??0,pending:s.pending?.state??null,replayed:result.replayed??false,newAssets,newBytes,hits,downloadBytes};
 }finally{store.close();}
}
