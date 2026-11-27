import {inspectAccess} from "./auth-access.mjs";
import {generateRecoveryCode,unlockRecoveryCode} from "./shared-crypto.mjs";
const HEX=/^[0-9a-f]{64}$/;
export async function inspectKeyAccess(client){
 const access=await inspectAccess(client);
 if(access.state!=="authorized")return access;
 const {data,error}=await client.from("archives").select("id,key_fingerprint").eq("id",access.archiveId).maybeSingle();
 if(error||!data||data.id!==access.archiveId||!(data.key_fingerprint===null||HEX.test(data.key_fingerprint)))throw Error("No se pudo verificar la configuración de clave.");
 return {...access,fingerprint:data.key_fingerprint};
}
function same(a,b){
 return a?.state==="authorized"&&b?.state==="authorized"&&a.userId===b.userId&&a.archiveId===b.archiveId&&a.role===b.role&&a.fingerprint===b.fingerprint;
}
export function createSessionKeyGate(readAccess){
 let epoch=0, access=null, unlocked=null;
 const clear=()=>{epoch++;access=null;unlocked=null;};
 const lock=()=>{epoch++;unlocked=null;};
 async function refresh(){
   clear();const e=epoch;const result=await readAccess();
   if(e!==epoch)throw Error("Verificación obsoleta.");
   if(result.state==="authorized")access=result;
   return result;
 }
 async function fresh(){
   const e=epoch,prev=access;
   if(!prev)throw Error("Sin membresía verificada.");
   const next=await readAccess();
   if(e!==epoch)throw Error("Sesión modificada.");
   if(!same(prev,next)){clear();throw Error("La autorización o configuración cambió.");}
   return {e,next};
 }
 return {
  clear,lock,refresh,
  isUnlocked:()=>Boolean(unlocked),
  async withUnlocked(work){
   const {e,next}=await fresh();
   if(!unlocked)throw Error("Clave bloqueada.");
   const current=unlocked;
   // This synchronous check only protects the local epoch; it is not remote authorization.
   const localGuard=()=>{
    if(e!==epoch||unlocked!==current)throw Error("Clave bloqueada.");
    return {userId:next.userId,archiveId:next.archiveId,keyId:current.keyId,role:next.role,unlocked:true};
   };
   const authorize=async()=>{localGuard();await fresh();return localGuard();};
   const value=await work(current,localGuard(),authorize,localGuard);
   await authorize();
   return value;
  },
  async candidate(){
   const {e,next}=await fresh();
   if(next.role!=="owner"||next.fingerprint!==null)throw Error("Configuración no disponible.");
   const code=await generateRecoveryCode();
   const {keyId}=await unlockRecoveryCode(code);
   if(e!==epoch)throw Error("Sesión modificada.");
   return {code,fingerprint:keyId};
  },
  async unlock(code){
   lock();const {e,next}=await fresh();
   if(!HEX.test(next.fingerprint||""))throw Error("Clave sin registrar.");
   const candidate=await unlockRecoveryCode(code);
   if(e!==epoch)throw Error("Sesión modificada.");
   if(candidate.keyId!==next.fingerprint)throw Error("La clave no corresponde al archivo.");
   unlocked=candidate;
   return true;
  }
 };
}
