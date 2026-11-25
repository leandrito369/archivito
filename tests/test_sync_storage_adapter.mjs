import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {encodeFixture} from "../app/sync-contract.mjs";
import {createFixtureStorageAdapter} from "../app/sync-storage-adapter.mjs";
async function lab(){
 const key=await unlockRecoveryCode(await generateRecoveryCode());
 const scope={userId:randomUUID(),archiveId:randomUUID(),keyId:key.keyId};
 const p=await encodeFixture(key,{archiveId:scope.archiveId,memoryId:randomUUID(),operationId:randomUUID(),revision:1,title:"Texto privado",note:"Nota privada",assets:[
 {id:randomUUID(),side:"front-original",mime:"image/png",bytes:new Uint8Array([1,2,3])},
 {id:randomUUID(),side:"back-original",mime:"image/png",bytes:new Uint8Array([4,5,6])}]});
 const objects=new Map(),calls=[],control={auth:true,failDownload:false,failCommit:false,corrupt:false,receipt:null,conflict:false};
 const client={functions:{async invoke(name,{body}){
  assert.equal(name,"archivito-sync-fixture");calls.push(body.action);
  assert.ok(!JSON.stringify(body).includes("Texto privado"));
  assert.ok(!JSON.stringify(body).includes("Nota privada"));
  if(control.conflict)return {data:{state:"conflict",operationId:p.operationId,actualRevision:1}};
  if(control.receipt)return {data:{...control.receipt,replayed:true}};
  if(body.action==="begin")return {data:{state:"staging",operationId:p.operationId}};
  assert.equal(body.action,"commit");
  assert.equal(objects.size,2);
  control.receipt={state:"synced",operationId:p.operationId,revision:1,replayed:false};
  if(control.failCommit)return {error:{}};
  return {data:control.receipt};
 }},storage:{from(bucket){
  assert.equal(bucket,"archivito-sync-lab");
  return {async upload(path,bytes,opts){
   calls.push("upload");assert.equal(opts.upsert,false);assert.equal(opts.contentType,"application/octet-stream");
   assert.ok(path.startsWith(scope.archiveId+"/"+p.operationId+"/"));
   if(objects.has(path))return {error:{message:"exists"}};
   objects.set(path,bytes.slice());return {data:{}};
  },async download(path){
   calls.push("download");
   if(control.failDownload||!objects.has(path))return {error:{}};
   const b=objects.get(path).slice();if(control.corrupt)b[0]^=1;return {data:new Blob([b])};
  }};
 }}};
 const authorize=async()=>({...scope,role:"owner",unlocked:control.auth});
 return {p,scope,objects,calls,control,client,authorize,adapter:createFixtureStorageAdapter({client,scope,authorize,enabled:true})};
}
test("gate cerrado por defecto y scope distinto sin red",async()=>{
 const l=await lab();
 assert.throws(()=>createFixtureStorageAdapter(l));
 l.control.auth=false;await assert.rejects(l.adapter.publish(l.p,0));assert.deepEqual(l.calls,[]);
});
test("subida inmutable, lectura de verificación y confirmación",async()=>{
 const l=await lab();assert.equal((await l.adapter.publish(l.p,0)).state,"synced");
 assert.deepEqual(l.calls,["begin","upload","download","upload","download","commit"]);
});
test("fallo parcial impide commit y reintento exacto recupera archivo",async()=>{
 const l=await lab();l.control.failDownload=true;
 await assert.rejects(l.adapter.publish(l.p,0));assert.equal(l.objects.size,1);assert.ok(!l.calls.includes("commit"));
 l.control.failDownload=false;assert.equal((await l.adapter.publish(l.p,0)).state,"synced");assert.equal(l.objects.size,2);
});
test("ciphertext distinto impide publicar",async()=>{
 const l=await lab();l.control.corrupt=true;await assert.rejects(l.adapter.publish(l.p,0));assert.ok(!l.calls.includes("commit"));
});
test("recibo perdido se recupera sin nuevas subidas",async()=>{
 const l=await lab();l.control.failCommit=true;await assert.rejects(l.adapter.publish(l.p,0));
 const n=l.calls.filter(x=>x==="upload").length;
 assert.equal((await l.adapter.publish(l.p,0)).replayed,true);
 assert.equal(l.calls.filter(x=>x==="upload").length,n);
});
test("conflicto detectado antes de staging",async()=>{
 const l=await lab();l.control.conflict=true;
 assert.deepEqual(await l.adapter.publish(l.p,0),{state:"conflict",actualRevision:1});assert.deepEqual(l.calls,["begin"]);
});
