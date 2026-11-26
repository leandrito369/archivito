// Closed by database hard gate; deploy only after unit tests and review.
import {createClient} from "npm:@supabase/supabase-js@2.119.2";
import {createIncrementalService} from "../../../server/sync-incremental-service.mjs";
const origin="http://localhost:8000";
const headers={"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"authorization,apikey,x-client-info,content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Cache-Control":"no-store","Vary":"Origin"};
const json=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{...headers,"Content-Type":"application/json"}});
async function bounded(req:Request,max:number){
 const reader=req.body?.getReader();if(!reader)throw Error("body");
 const parts:Uint8Array[]=[];let length=0;
 for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>max){await reader.cancel();throw Error("size");}parts.push(value);}
 const out=new Uint8Array(length);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;
}
Deno.serve(async req=>{
 if(req.headers.get("origin")!==origin)return json(403,{error:"rejected"});
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return json(405,{error:"rejected"});
 try{
  const token=req.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];if(!token)return json(401,{error:"rejected"});
  const url=Deno.env.get("SUPABASE_URL"),secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!url||!secret)throw Error("config");
  const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const bucket=admin.storage.from("archivito-inc-private");
  const service=createIncrementalService({
   enabled:true,
   verifyUser:async(t:string)=>{const {data,error}=await admin.auth.getUser(t);return error?null:data.user;},
   step:async(actor:string,action:string,wire:unknown,proof?:{assetId:string,sha256:string})=>{
    const {data,error}=await admin.rpc("sync_inc_step",{p_actor:actor,p_action:action,w:wire,p_asset:proof?.assetId??null,p_hash:proof?.sha256??null});if(error)throw Error("rpc");return data;
   },
   inspect:async(actor:string,archive:string,action:string,memory:string|null,operation:string|null,asset:string|null)=>{
    const {data,error}=await admin.rpc("sync_inc_inspect",{p_actor:actor,p_archive:archive,p_action:action,p_memory:memory,p_operation:operation,p_asset:asset});if(error)throw Error("inspect");return data;
   },
   upload:async(path:string,bytes:Uint8Array)=>{const {error}=await bucket.upload(path,bytes,{upsert:false,contentType:"application/octet-stream"});if(error)throw Error("upload");},
   download:async(path:string,size:number)=>{const {data,error}=await bucket.download(path);if(error||!data)return null;if(data.size!==size)throw Error("size");return new Uint8Array(await data.arrayBuffer());}
  });
  const p=new URL(req.url).searchParams,action=p.get("action");
  if(action==="block"){
   if(req.headers.get("content-type")!=="application/octet-stream")return json(415,{error:"rejected"});
   return json(200,await service.putBlock(token,{archiveId:p.get("archiveId"),operationId:p.get("operationId"),path:p.get("path"),bytes:await bounded(req,4194304)}));
  }
  if(req.headers.get("content-type")?.split(";")[0]!=="application/json")return json(415,{error:"rejected"});
  const body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await bounded(req,600000)));
  if(action==="attest")return json(200,await service.attestAsset(token,body));
  if(action==="manifest")return json(200,await service.manifest(token,body));
  if(action==="catalog")return json(200,await service.catalog(token,body));
  if(action==="download")return new Response(await service.getBlock(token,body),{status:200,headers:{...headers,"Content-Type":"application/octet-stream"}});
  return json(200,await service.command(token,action,body));
 }catch{return json(403,{error:"rejected"});}
});
