// Candidate; deployment requires bundling relative modules as documented.
import {createClient} from "npm:@supabase/supabase-js@2.119.2";
import {createV3Service} from "../../../server/sync-v3-service.mjs";
const origin="http://localhost:8000";
const headers={"Content-Type":"application/json","Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"authorization,apikey,x-client-info,content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Cache-Control":"no-store"};
const response=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers});
async function bounded(req:Request,max:number){
 const reader=req.body?.getReader();if(!reader)throw Error("body");
 const parts:Uint8Array[]=[];let length=0;
 for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>max){await reader.cancel();throw Error("size");}parts.push(value);}
 const out=new Uint8Array(length);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;
}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST"||req.headers.get("origin")!==origin)return response(403,{error:"rejected"});
 try{
  const token=req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if(!token)return response(401,{error:"rejected"});
  const url=Deno.env.get("SUPABASE_URL"),secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!secret)throw Error("config");
  const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const service=createV3Service({enabled:true,
   verifyUser:async(t:string)=>{const {data,error}=await admin.auth.getUser(t);return error?null:data.user;},
   step:async(actor:string,action:string,header:unknown,proof?:{path:string,size:number,sha256:string})=>{
    const {data,error}=await admin.rpc("sync_v3_step",{p_actor:actor,p_action:action,p_header:header,p_path:proof?.path??null,p_size:proof?.size??null,p_hash:proof?.sha256??null});
    if(error)throw Error("rpc");return data;
   },
   loadIntent:async(actor:string,archiveId:string,operationId:string)=>{
    const {data,error}=await admin.from("sync_v3_intents").select("header").eq("archive_id",archiveId).eq("operation_id",operationId).eq("actor",actor).maybeSingle();
    if(error||!data)throw Error("intent");return data.header;
   },
   upload:async(path:string,bytes:Uint8Array)=>{
    const {error}=await admin.storage.from("archivito-v3-private").upload(path,bytes,{contentType:"application/octet-stream",upsert:false});if(error)throw Error("upload");
   },
   download:async(path:string,max:number)=>{
    const {data,error}=await admin.storage.from("archivito-v3-private").download(path);if(error||!data||data.size!==max)return null;return new Uint8Array(await data.arrayBuffer());
   }
  });
  const params=new URL(req.url).searchParams,action=params.get("action");
  if(action==="block"){
   if(req.headers.get("content-type")!=="application/octet-stream")return response(415,{error:"rejected"});
   return response(200,await service.putBlock(token,{archiveId:params.get("archiveId"),operationId:params.get("operationId"),path:params.get("path"),bytes:await bounded(req,4194304)}));
  }
  const body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await bounded(req,600000)));
  return response(200,await service.command(token,action,body));
 }catch{return response(403,{error:"rejected"});}
});
