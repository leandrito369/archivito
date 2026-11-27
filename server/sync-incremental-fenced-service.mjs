// Request-scoped bridge. All Storage I/O is bracketed by guarded SQL inspection.
import {createIncrementalService} from "./sync-incremental-service.mjs";
import {validateIncrementalWire} from "../app/sync-incremental-wire.mjs";
const uuid=x=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const fail=()=>{throw Error("Certification denied");};
export function parseFence(g,t){
 if(g===null&&t===null)return null;
 if(typeof g!=="string"||!/^[1-9][0-9]*$/.test(g)||!Number.isSafeInteger(Number(g))||!uuid(t))fail();
 return {generation:Number(g),token:t};
}
export function verifiedSession(jwt,userId){
 if(!uuid(userId)||typeof jwt!=="string")fail();
 const parts=jwt.split(".");if(parts.length!==3)fail();
 // Call ONLY after server auth.getUser(jwt) succeeds. This does not verify JWT.
 const b=parts[1].replace(/-/g,"+").replace(/_/g,"/");
 const p=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b),c=>c.charCodeAt(0))));
 if(p.sub!==userId||p.role!=="authenticated"||!uuid(p.session_id))fail();
 return p.session_id;
}
export async function handleFencedIncremental({action,body,block,fence,token,verifyUser,rpc,upload,download}){
 const writes=["block","attest","commit"];
 if(!["claim",...writes,"manifest","catalog","download"].includes(action))fail();
 if(writes.includes(action)!==Boolean(fence))fail();
 const actor=async()=>{
  const u=await verifyUser(token);if(!u||!uuid(u.id))fail();
  return {id:u.id,session:verifiedSession(token,u.id)};
 };
 const initial=await actor();
 async function checkActor(){const a=await actor();if(a.id!==initial.id||a.session!==initial.session)fail();return a;}
 async function dispatch(a,p){
  const u=await checkActor();
  if(a!==u.id)fail();
  return rpc({p_actor:u.id,p_session:u.session,...p});
 }
 const fenceArgs=fence?{p_generation:fence.generation,p_token:fence.token}:{};
 if(action==="claim"){
  const w=structuredClone(body),h=validateIncrementalWire(w);
  return dispatch(initial.id,{p_action:"claim",p_archive:h.archiveId,p_wire:w});
 }
 let lastInspect=null;
 const service=createIncrementalService({
  enabled:true,
  verifyUser:async()=>({id:(await checkActor()).id}),
  step:async(a,phase,w,proof)=>{
   const h=validateIncrementalWire(w);
   return dispatch(a,{p_action:phase,p_archive:h.archiveId,p_wire:w,p_asset:proof?.assetId??null,p_hash:proof?.sha256??null,...fenceArgs});
  },
  inspect:async(a,archive,phase,memory,operation,asset)=>{
   const p={p_action:phase,p_archive:archive,p_memory:memory,p_operation:operation,p_asset:asset,...(phase==="intent"?fenceArgs:{})};
   const result=await dispatch(a,p);lastInspect={a,p};return result;
  },
  upload:async(path,bytes)=>{if(lastInspect?.p.p_action!=="intent")fail();await dispatch(lastInspect.a,lastInspect.p);const r=await upload(path,bytes);await dispatch(lastInspect.a,lastInspect.p);return r;},
  download:async(path,size)=>{if(!lastInspect||!["intent","catalog"].includes(lastInspect.p.p_action))fail();await dispatch(lastInspect.a,lastInspect.p);const r=await download(path,size);await dispatch(lastInspect.a,lastInspect.p);return r;}
 });
 if(action==="block")return service.putBlock(token,block);
 if(action==="attest")return service.attestAsset(token,body);
 if(action==="commit")return service.command(token,"commit",body);
 if(action==="manifest")return service.manifest(token,body);
 if(action==="catalog")return service.catalog(token,body);
 return service.getBlock(token,body);
}
