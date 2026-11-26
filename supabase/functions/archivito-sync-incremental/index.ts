// Closed by database hard gate; deploy only after unit tests and review.
import {createClient} from "npm:@supabase/supabase-js@2.119.2";
import {handleFencedIncremental,parseFence} from "../../../server/sync-incremental-fenced-service.mjs";
const origin="http://localhost:8000";
const headers={"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"authorization,apikey,x-client-info,content-type,x-archivito-generation,x-archivito-fence","Access-Control-Allow-Methods":"POST,OPTIONS","Cache-Control":"no-store","Vary":"Origin"};
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
  const p=new URL(req.url).searchParams,action=p.get("action");
  const fence=parseFence(req.headers.get("x-archivito-generation"),req.headers.get("x-archivito-fence"));
  if(!action||!["claim","block","attest","commit","manifest","catalog","download"].includes(action))return json(403,{error:"rejected"});
  // Authenticate before reading a bounded request body; actor is never taken from body.
  const verifyUser=async(t:string)=>{const {data,error}=await admin.auth.getUser(t);return error?null:data.user;};
  if(!await verifyUser(token))return json(401,{error:"rejected"});
  let body:unknown=null,block:unknown=undefined;
  if(action==="block"){
   if(req.headers.get("content-type")!=="application/octet-stream")return json(415,{error:"rejected"});
   block={archiveId:p.get("archiveId"),operationId:p.get("operationId"),path:p.get("path"),bytes:await bounded(req,4194304)};
  }else{
   if(req.headers.get("content-type")?.split(";")[0]!=="application/json")return json(415,{error:"rejected"});
   body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await bounded(req,600000)));
  }
  const result=await handleFencedIncremental({action,body,block,fence,token,verifyUser,
   rpc:async(args:Record<string,unknown>)=>{const {data,error}=await admin.rpc("sync_inc_cert_http",args);if(error)throw Error("rpc");return data;},
   upload:async(path:string,bytes:Uint8Array)=>{const {error}=await bucket.upload(path,bytes,{upsert:false,contentType:"application/octet-stream"});if(error)throw Error("upload");},
   download:async(path:string,size:number)=>{const {data,error}=await bucket.download(path);if(error||!data)return null;if(data.size!==size)throw Error("size");return new Uint8Array(await data.arrayBuffer());}
  });
  if(action==="download")return new Response(result as Uint8Array,{status:200,headers:{...headers,"Content-Type":"application/octet-stream"}});
  return json(200,result);
 }catch{return json(403,{error:"rejected"});}
});
