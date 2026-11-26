import {runIncrementalLab} from "./sync-incremental-lab.mjs";
import {createIncrementalRemote} from "./sync-incremental-remote.mjs";
import {createV3Metrics} from "./sync-v3-metrics.mjs";
const $=id=>document.getElementById(id),actions=["create","read","edit","photo","retry","status"];
export function createIncrementalLabUI({getClient,getGate,url,publishableKey}){
 let seq=0,controller=null;
 function clear(){seq++;controller?.abort();controller=null;$("inc-lab-panel").hidden=true;$("inc-lab-status-output").textContent="";$("inc-lab-proof").textContent="";$("inc-lab-metrics").textContent="";$("inc-lab-cancel").disabled=true;for(const a of actions)$("inc-lab-"+a).disabled=false;}
 function reveal(){clear();$("inc-lab-panel").hidden=false;$("inc-lab-status-output").textContent="Sólo muestras ficticias. El servidor puede estar cerrado.";}
 async function run(action){
  const n=++seq,ctl=new AbortController();controller=ctl;for(const a of actions)$("inc-lab-"+a).disabled=true;$("inc-lab-cancel").disabled=false;$("inc-lab-proof").textContent="";$("inc-lab-metrics").textContent="";
  $("inc-lab-status-output").textContent="Procesando…";
  const metrics=createV3Metrics(rows=>{if(n===seq)$("inc-lab-metrics").textContent=rows.map(r=>r.phase+": "+r.count+" × · "+r.ms+" ms"+(r.bytes?" · "+r.bytes+" bytes":"")).join(" | ");});
  try{
   const result=await metrics.measure("total",()=>getGate().withUnlocked(async(key,scope,authorize,localGuard)=>{
    const remote=createIncrementalRemote({client:getClient(),url,publishableKey,scope,authorize,localGuard,enabled:true,metrics,onProgress:({phase,done,total})=>{if(n===seq)$("inc-lab-status-output").textContent=phase+" · "+done+"/"+total;}});
    return runIncrementalLab({scope,key,authorize,remote,action,size:$("inc-lab-size").value,metrics,signal:ctl.signal});
   }));
   if(n===seq){$("inc-lab-status-output").textContent=({synced:"PUBLICADO",applied:"VERIFICADO",error:"Pendiente cifrado conservado; reintentá.",conflict:"CONFLICTO: pendiente conservado.",idle:"Sin trabajo disponible",stale:"Lease perdido; reintentá.",status:"Estado local","pending-exists":"Hay una operación pendiente.","read-first":"Recuperá primero la revisión.","already-remote":"Recuperá la muestra existente.",empty:"No hay muestra remota."})[result.state]||"Estado no confirmado";
    $("inc-lab-proof").textContent=JSON.stringify(result);}
  }catch{if(n===seq)$("inc-lab-status-output").textContent="Operación no confirmada. Revisá conexión, sesión y gate. No se modificó la biblioteca personal.";}
  finally{if(n===seq){controller=null;for(const a of actions)$("inc-lab-"+a).disabled=false;$("inc-lab-cancel").disabled=true;}}
 }
 for(const a of actions)$("inc-lab-"+a).onclick=()=>run(a);
 $("inc-lab-cancel").onclick=()=>controller?.abort();
 return {clear,reveal};
}
