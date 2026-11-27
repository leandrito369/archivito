// Explicit synthetic-only lab; no access to the ordinary library.
import {encodeFixture} from "./sync-contract.mjs";
import {openSyncQueue,drainOne} from "./sync-queue.mjs";
import {createFixtureStorageAdapter} from "./sync-storage-adapter.mjs";
import {readPublishedFixture} from "./sync-fixture-read.mjs";
const $=id=>document.getElementById(id);
async function picture(label,color){
 const canvas=document.createElement("canvas");canvas.width=320;canvas.height=200;
 const ctx=canvas.getContext("2d");ctx.fillStyle=color;ctx.fillRect(0,0,320,200);
 ctx.fillStyle="#37291d";ctx.font="bold 25px sans-serif";ctx.fillText(label,25,80);
 ctx.font="16px sans-serif";ctx.fillText("ARCHIVITO · MUESTRA FICTICIA",25,125);
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
 if(!blob)throw Error("No se pudo generar muestra.");
 return new Uint8Array(await blob.arrayBuffer());
}
export function createFixtureUI({getClient,getGate}){
 let seq=0;
 const clear=()=>{seq++;$("fixture-panel").hidden=true;$("fixture-status").textContent="";$("fixture-proof").textContent="";$("fixture-publish").disabled=false;$("fixture-read").disabled=false;};
 const reveal=()=>{clear();$("fixture-panel").hidden=false;$("fixture-status").textContent="Laboratorio: sólo una carta ficticia generada automáticamente.";};
 async function act(mode){
  const token=++seq;$("fixture-publish").disabled=true;$("fixture-read").disabled=true;$("fixture-proof").textContent="";
  $("fixture-status").textContent="Procesando muestra…";
  try{
   const client=getClient(),gate=getGate();
   const result=await gate.withUnlocked(async(key,scope,authorize)=>{
    if(mode==="read"){
     const value=await readPublishedFixture(client,key,scope,authorize);
     if(!value)return {message:"Todavía no hay muestra publicada."};
     return {message:"VERIFICADO: muestra remota descifrada.",proof:value.title+" · revisión "+value.revision+" · "+value.assets.length+" activos: "+value.assets.map(a=>a.side+" ("+a.bytes.length+" bytes)").join(", ")};
    }
    if(scope.role!=="owner")throw Error("Sólo el propietario publica esta primera muestra.");
    const {data,error}=await client.from("sync_fixture_gate").select("enabled").eq("archive_id",scope.archiveId).maybeSingle();
    if(error||data?.enabled!==true)throw Error("Laboratorio desactivado.");
    const queue=await openSyncQueue(scope);
    try{
     const rows=await queue.list();
     const old=rows.find(r=>r.state!=="synced");
     if(old?.state==="conflict")throw Error("Conflicto pendiente.");
     if(old?.state==="error")await queue.retry(old.operationId);
     if(!old){
      const existing=await readPublishedFixture(client,key,scope,authorize);
      if(existing)return {message:"Ya existe una muestra publicada. Usá Recuperar muestra."};
      const packet=await encodeFixture(key,{archiveId:scope.archiveId,memoryId:crypto.randomUUID(),revision:1,operationId:crypto.randomUUID(),title:"Primera carta ficticia",note:"Prueba de sincronización sin recuerdos personales.",assets:[
       {id:crypto.randomUUID(),side:"front-original",mime:"image/png",bytes:await picture("Frente ficticio","#efdbb3")},
       {id:crypto.randomUUID(),side:"back-original",mime:"image/png",bytes:await picture("Reverso ficticio","#d7e1ce")}]});
      await authorize();await queue.enqueue(packet,0);
     }
     const adapter=createFixtureStorageAdapter({client,scope,authorize,enabled:true});
     const state=await drainOne(queue,adapter);
     if(state.state==="synced")return {message:"PUBLICADO: muestra cifrada confirmada en Supabase."};
     if(state.state==="idle")return {message:"Operación en curso o lease pendiente. Reintentá después."};
     if(state.state==="conflict")return {message:"Conflicto detectado. No se descartó el paquete."};
     return {message:"Publicación no confirmada. El paquete cifrado queda en la cola para reintentar."};
    }finally{queue.close();}
   });
   if(token===seq){$("fixture-status").textContent=result.message;$("fixture-proof").textContent=result.proof||"";}
  }catch{if(token===seq)$("fixture-status").textContent="No se completó la prueba. Revisá sesión, clave y conexión; no se modificó la biblioteca local.";}
  finally{if(token===seq){$("fixture-publish").disabled=false;$("fixture-read").disabled=false;}}
 }
 $("fixture-publish").onclick=()=>act("publish");
 $("fixture-read").onclick=()=>act("read");
 return {clear,reveal};
}
