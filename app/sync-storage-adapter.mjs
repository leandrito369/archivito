// CLOUD-03.3A: fixture-only adapter against a PROPOSED backend contract.
// Not imported by any page, not included in dist. No backend endpoint is deployed.
import {validatePackage} from "./sync-contract.mjs";
import {sha256Hex,toBase64Url} from "./shared-crypto.mjs";
const BUCKET="archivito-sync-lab";
const ENDPOINT="archivito-sync-fixture";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
function fail(){throw Error("Operación remota de prueba no confirmada.");}
function matches(scope,p){return scope?.archiveId===p.archiveId&&scope.keyId===p.keyId&&typeof scope.userId==="string"&&UUID.test(scope.userId);}
function receipt(data,p){
 if(data?.state==="synced"&&data.revision===p.revision&&data.operationId===p.operationId&&typeof data.replayed==="boolean")return {state:"synced",revision:data.revision,replayed:data.replayed};
 if(data?.state==="conflict"&&data.operationId===p.operationId&&Number.isSafeInteger(data.actualRevision)&&data.actualRevision>=0)return {state:"conflict",actualRevision:data.actualRevision};
 fail();
}
export function createFixtureStorageAdapter({client,scope,authorize,enabled=false}){
 // Both opt-in and current verified scope are mandatory. Local checks are NOT authorization.
 if(enabled!==true||!client||typeof authorize!=="function"||!scope||!UUID.test(scope.userId)||!UUID.test(scope.archiveId)||!HEX.test(scope.keyId))fail();
 const bound=Object.freeze({userId:scope.userId,archiveId:scope.archiveId,keyId:scope.keyId});
 async function guard(p){
  const a=await authorize();
  if(!matches(bound,p)||!a||a.userId!==bound.userId||a.archiveId!==bound.archiveId||a.keyId!==bound.keyId||a.unlocked!==true||!["owner","editor"].includes(a.role))fail();
 }
 async function invoke(p,body){
  await guard(p);
  const {data,error}=await client.functions.invoke(ENDPOINT,{body});
  if(error||!data)fail();
  await guard(p);
  return data;
 }
 return {async publish(input,expectedRevision){
  const p=structuredClone(input);validatePackage(p);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||p.revision!==expectedRevision+1)fail();
  await guard(p);
  const assets=[];
  for(const e of p.assets)assets.push({
   assetId:e.objectId,path:[p.archiveId,p.operationId,e.objectId].join("/"),
   nonce:toBase64Url(e.nonce),size:e.ciphertext.byteLength,sha256:await sha256Hex(e.ciphertext)
  });
  assets.sort((a,b)=>a.assetId.localeCompare(b.assetId));
  const header={format:p.format,archiveId:p.archiveId,memoryId:p.memoryId,operationId:p.operationId,
   keyId:p.keyId,revision:p.revision,expectedRevision,
   metadata:{nonce:toBase64Url(p.metadata.nonce),ciphertext:toBase64Url(p.metadata.ciphertext)},assets};
  const begin=await invoke(p,{action:"begin",...header});
  if(begin.state!=="staging")return receipt(begin,p);
  if(begin.operationId!==p.operationId)fail();
  const storage=client.storage.from(BUCKET);
  for(const a of assets){
   const e=p.assets.find(x=>x.objectId===a.assetId);
   await guard(p);
   // Always create-only. Never overwrite, delete, or use public URLs.
   // A failed upload may have committed; only exact readback permits progress.
   try{await storage.upload(a.path,e.ciphertext,{contentType:"application/octet-stream",upsert:false});}catch{}
   await guard(p);
   const {data,error}=await storage.download(a.path);
   if(error||!data||data.size!==a.size)fail();
   const readback=new Uint8Array(await data.arrayBuffer());
   if(readback.byteLength!==a.size||await sha256Hex(readback)!==a.sha256)fail();
   await guard(p);
  }
  // The backend MUST independently verify all staged blobs and atomically commit.
  // Client readback is useful for retries but is not proof for a trusted server.
  return receipt(await invoke(p,{action:"commit",...header}),p);
 }};
}
