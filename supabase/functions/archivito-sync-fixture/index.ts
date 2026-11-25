import {createClient} from "npm:@supabase/supabase-js@2.119.2";
import {createFixtureService} from "./sync-fixture-service.mjs";
const headers={"Content-Type":"application/json","Access-Control-Allow-Origin":"http://localhost:8000","Access-Control-Allow-Headers":"authorization, apikey, x-client-info, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Cache-Control":"no-store"};
const response=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers});
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST"||req.headers.get("origin")!=="http://localhost:8000")return response(403,{error:"rejected"});
 try{
  const token=req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if(!token)return response(401,{error:"rejected"});
  // Bound body before JSON parsing, including chunked requests.
  const reader=req.body?.getReader();if(!reader)return response(400,{error:"rejected"});
  const chunks:Uint8Array[]=[];let total=0;
  for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>120000){await reader.cancel();return response(413,{error:"rejected"});}chunks.push(value);}
  const buffer=new Uint8Array(total);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
  const body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer));
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)throw Error("config");
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  async function step(action:string,actor:string,header:unknown){
   const {data,error}=await admin.rpc("sync_fixture_step",{p_actor:actor,p_action:action,p_header:header});
   if(error)throw Error("rpc");return data;
  }
  const handle=createFixtureService({enabled:true,
   verifyUser:async(t:string)=>{const {data,error}=await admin.auth.getUser(t);return error?null:data.user;},
   authorize:async(actor:string,archive:string)=>{
    const [m,g,a]=await Promise.all([
     admin.from("archive_members").select("role").eq("user_id",actor).eq("archive_id",archive).maybeSingle(),
     admin.from("sync_fixture_gate").select("enabled").eq("archive_id",archive).maybeSingle(),
     admin.from("archives").select("key_fingerprint").eq("id",archive).maybeSingle()
    ]);
    if(m.error||g.error||a.error||!m.data||!g.data||!a.data)return null;
    return {role:m.data.role,labEnabled:g.data.enabled,keyId:a.data.key_fingerprint};
   },
   db:{begin:(u:string,h:unknown)=>step("begin",u,h),lookup:(u:string,h:unknown)=>step("lookup",u,h),commit:(u:string,h:unknown)=>step("commit",u,h)},
   readBlob:async(bucket:string,path:string)=>{const {data,error}=await admin.storage.from(bucket).download(path);if(error||!data||data.size>8388624)return null;return new Uint8Array(await data.arrayBuffer());}
  });
  return response(200,await handle(token,body));
 }catch{return response(403,{error:"rejected"});}
});
