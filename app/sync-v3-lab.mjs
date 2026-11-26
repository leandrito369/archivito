// Synthetic-only v3 E2E. Independent local DB, identity and outbox namespaces.
import {openV3IdentityMap} from "./sync-v3-identity.mjs";
import {openV3Outbox} from "./sync-v3-outbox.mjs";
import {applyV3Pull} from "./sync-v3-pull.mjs";
import {drainV3Once} from "./sync-v3-remote.mjs";
export const LAB_MEMORY="fb8b27a1-06cf-49ea-8a28-eef4a1539d45";
const DB="archivito-v3-lab-library-v1",options={laboratory:true};
const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
async function local(mode,work){
 const db=await new Promise((resolve,reject)=>{
  const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore("letters",{keyPath:"id"});
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error("Lab bloqueado."));
 });
 try{
  const tx=db.transaction("letters",mode),store=tx.objectStore("letters");
  const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error("Lab abortado."));});done.catch(()=>{});
  try{const result=await work(store);await done;return result;}
  catch(e){try{tx.abort();}catch{}await done.catch(()=>{});throw e;}
 }finally{db.close();}
}
async function image(label,large=false){
 const c=document.createElement("canvas");c.width=large?1500:320;c.height=large?1500:200;
 const ctx=c.getContext("2d");
 if(large){
  const pixels=ctx.createImageData(c.width,c.height),raw=new Uint8Array(c.width*c.height*3);
  for(let i=0;i<raw.length;i+=65536)crypto.getRandomValues(raw.subarray(i,Math.min(raw.length,i+65536)));
  for(let i=0,j=0;i<pixels.data.length;i+=4){pixels.data[i]=raw[j++];pixels.data[i+1]=raw[j++];pixels.data[i+2]=raw[j++];pixels.data[i+3]=255;}
  ctx.putImageData(pixels,0,0);
 }else{ctx.fillStyle="#efdbb3";ctx.fillRect(0,0,c.width,c.height);}
 ctx.fillStyle="#fff";ctx.fillRect(12,12,280,68);ctx.fillStyle="#37291d";ctx.font="bold 20px sans-serif";ctx.fillText(label,20,40);ctx.font="14px sans-serif";ctx.fillText("MUESTRA FICTICIA",20,62);
 const blob=await new Promise(resolve=>c.toBlob(resolve,"image/png"));
 if(!blob||large&&blob.size<=4194304)throw Error("No se generó imagen multibloque.");
 return blob;
}
async function validateImage(b){
 if(!(b instanceof Blob)||b.type!=="image/png"||b.size>12*1024*1024)throw Error("Imagen lab inválida.");
 const bmp=await createImageBitmap(b);try{if(bmp.width<1||bmp.height<1||bmp.width>1500||bmp.height>1500)throw Error("Dimensiones inválidas.");}finally{bmp.close();}
}
async function makeThumb(b){
 const bmp=await createImageBitmap(b);try{
  const c=document.createElement("canvas");c.width=160;c.height=Math.max(1,Math.round(bmp.height*160/bmp.width));c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
  const thumb=await new Promise(resolve=>c.toBlob(resolve,"image/png"));if(!thumb)throw Error("Miniatura inválida.");return thumb;
 }finally{bmp.close();}
}
async function sample(id){
 const front=await image("Hoja 1 · frente",true),back=await image("Hoja 1 · reverso"),frontDerived=await image("Frente digitalizado"),backDerived=await image("Reverso digitalizado"),second=await image("Hoja 2 · frente");
 const crop={algorithm:"homography-js-v1",points:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],input:{width:320,height:200},output:{width:320,height:200}};
 const now=new Date().toISOString();
 return {id,schemaVersion:3,kind:"letter",title:"Carta ficticia v3",date:"2026-11-25",from:"Muestra A",to:"Muestra B",note:"Laboratorio v3 sin datos personales.",tags:["archivito-lab-v3"],favorite:false,createdAt:now,updatedAt:now,syncGeneration:crypto.randomUUID(),
 pages:[{id:"lab-page-1",caption:"Primera hoja",front,back,frontDerived,backDerived,frontCrop:{...crop,input:{width:1500,height:1500}},backCrop:crop,thumb:await makeThumb(frontDerived)},{id:"lab-page-2",caption:"Segunda hoja",front:second,back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null,thumb:await makeThumb(second)}],front,back,thumb:await makeThumb(frontDerived)};
}
function proof(record,base,pending){
 return {title:record?.title??null,revision:base?.revision??0,pending:pending?.state??null,pages:record?.pages?.length??0,assets:record?.pages?.reduce((n,p)=>n+["front","back","frontDerived","backDerived"].filter(k=>p[k]).length,0)??0,large:record?.pages?.[0]?.front?.size??0};
}
export async function runV3Lab({scope,key,authorize,remote,action}){
 await authorize();
 if(!["create","read","edit","retry"].includes(action))throw Error("Acción inválida.");
 const identity=await openV3IdentityMap(scope,options);let outbox;
 try{
  outbox=await openV3Outbox(scope,options);
  // One per account in this origin. Neither this DB nor its IDs touch the personal library.
  let binding=await identity.byRemote(LAB_MEMORY);
  const id=binding?.localId??crypto.randomUUID();
  let record=await local("readonly",s=>req(s.get(id)));
  let status=await outbox.status(LAB_MEMORY);
  if(action==="read"){
   const value=await remote.read(LAB_MEMORY,status.pull?.target.revision);
   if(!value)return {state:"empty",...proof(record,status.base,status.pending)};
   await authorize();
   const result=await applyV3Pull({scope,key,...value,localId:id,validateImage,makeThumb,laboratory:true});
   status=await outbox.status(LAB_MEMORY);record=await local("readonly",s=>req(s.get(id)));
   return {...proof(record,status.base,status.pending),state:result.state};
  }
  if(action==="retry"){
   if(status.pending?.state==="error")await outbox.retry(LAB_MEMORY);
   else if(!["pending","uploading"].includes(status.pending?.state))return {state:"nothing-to-retry",...proof(record,status.base,status.pending)};
  }else if(status.pending)return {state:"pending-exists",...proof(record,status.base,status.pending)};
  else if(action==="create"){
   if(scope.role!=="owner"||status.base||status.pull)throw Error("Creación no autorizada.");
   if(await remote.read(LAB_MEMORY))return {state:"already-remote",...proof(record,status.base,status.pending)};
   if(!binding){binding=await identity.bind(id,LAB_MEMORY);}
   if(!record){const r=await sample(id);await authorize();await local("readwrite",s=>req(s.add(r)));record=r;}
  }else{
   if(!record||!status.base||status.pull||status.base.revision>=3)return {state:"read-first-or-limit",...proof(record,status.base,status.pending)};
   const g=record.syncGeneration;
   await authorize();
   record=await local("readwrite",async s=>{
    const latest=await req(s.get(id));if(!latest||latest.syncGeneration!==g)throw Error("Cambio local concurrente.");
    const r={...latest,title:"Carta ficticia v3 · edición "+(scope.role==="owner"?"A":"B")+" r"+(status.base.revision+1),note:"Cambio sintético de "+scope.role,favorite:!latest.favorite,updatedAt:new Date().toISOString(),syncGeneration:crypto.randomUUID()};
    await req(s.put(r));return r;
   });
  }
  await authorize();
  if(action!=="retry")await outbox.prepare({key,record,remoteId:LAB_MEMORY,base:status.base});
  const result=await drainV3Once({outbox,remote,authorize});status=await outbox.status(LAB_MEMORY);
  return {...proof(record,status.base,status.pending),state:result.state};
 }finally{outbox?.close();identity.close();}
}
