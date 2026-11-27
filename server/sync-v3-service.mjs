// Trusted service candidate; no deploy, no use of browser credentials as authority.
import {validateV3Header,verifyV3Chunk} from "../app/sync-v3-wire.mjs";
import {sha256Hex} from "../app/shared-crypto.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x);
const fail=()=>{throw Error("Operación remota rechazada.");};
export function createV3Service({verifyUser,step,loadIntent,upload,download,enabled=false}){
 async function actor(token){
  if(enabled!==true||typeof token!=="string"||!token)fail();
  const u=await verifyUser(token);if(!u||!uuid(u.id))fail();return u.id;
 }
 return {
  async command(token,action,input){
   const user=await actor(token);
   if(!["begin","lookup","commit"].includes(action))fail();
   const h=validateV3Header(structuredClone(input));
   return step(user,action,h);
  },
  async putBlock(token,{archiveId,operationId,path,bytes}={}){
   const user=await actor(token);
   if(!uuid(archiveId)||!uuid(operationId)||typeof path!=="string"||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>4194304)fail();
   const snapshot=bytes.slice();
   const h=validateV3Header(structuredClone(await loadIntent(user,archiveId,operationId)));
   if(h.archiveId!==archiveId||h.operationId!==operationId)fail();
   const c=h.assets.flatMap(a=>a.chunks).find(c=>c.path===path);
   if(!c||snapshot.length!==c.size||await sha256Hex(snapshot)!==c.sha256)fail();
   // Revalidate membership, gate, key, operation ownership and revision via RPC.
   const check=await step(user,"lookup",h);
   if(check?.state!=="staging")return check;
   // Always create-only. A lost upload response is handled by exact readback.
   // Avoid a second upload if already attested; still verify actual bytes.
   if(!Array.isArray(check.verifiedPaths))fail();
   if(!check.verifiedPaths.includes(path)){try{await upload(path,snapshot);}catch{}}
   const proof=await verifyV3Chunk(h,path,download);
   if(await actor(token)!==user)fail();
   return step(user,"verify",h,proof);
  }
 };
}
