import {runV3Lab} from "./sync-v3-lab.mjs";
import {createV3Remote} from "./sync-v3-remote.mjs";
import {createV3Metrics} from "./sync-v3-metrics.mjs";
const $=id=>document.getElementById(id);
const actions=["create","read","edit","retry"];
const labels={synced:"PUBLICADO: revisión confirmada.",applied:"VERIFICADO: revisión descargada, descifrada y guardada en laboratorio.","already-applied":"VERIFICADO: recuperación completada.",noop:"VERIFICADO: revisión ya actualizada.",conflict:"CONFLICTO: modificación local conservada.","pending-exists":"Hay una operación pendiente; usá Reintentar.","already-remote":"Ya existe la muestra: recuperala.","read-first-or-limit":"Recuperá primero la muestra o alcanzaste el límite de revisión 3.","nothing-to-retry":"No hay operación reintentable.",empty:"Todavía no existe muestra remota.",blocked:"Bloqueado: el cambio local o diario se conserva.",error:"Transferencia no confirmada; paquete cifrado conservado.",idle:"Sin trabajo disponible o lease vigente.",stale:"Intento obsoleto; revisá la cola."};
export function createV3LabUI({getClient,getGate,url,publishableKey}){
 let seq=0;
 function clear(){seq++;$("v3-lab-panel").hidden=true;$("v3-lab-status").textContent="";$("v3-lab-proof").textContent="";$("v3-lab-metrics").textContent="";for(const a of actions)$("v3-lab-"+a).disabled=false;}
 function reveal(){clear();$("v3-lab-panel").hidden=false;$("v3-lab-status").textContent="Sólo datos generados automáticamente.";}
 async function run(action){
  const n=++seq;for(const a of actions)$("v3-lab-"+a).disabled=true;$("v3-lab-status").textContent="Procesando…";$("v3-lab-proof").textContent="";
  try{
   const client=getClient();
   const metrics=createV3Metrics(rows=>{if(n===seq)$("v3-lab-metrics").textContent=rows.map(r=>r.phase+": "+r.count+" × · "+r.ms+" ms"+(r.bytes?" · "+r.bytes+" bytes":"")).join(" | ");});
   const optimized=$("v3-lab-mode").value==="optimized";
   const r=await metrics.measure("total",()=>getGate().withUnlocked(async(key,scope,authorize,localGuard)=>{
    const {data,error}=await client.from("sync_v3_gate").select("enabled").eq("archive_id",scope.archiveId).maybeSingle();
    if(error||data?.enabled!==true)throw Error("Lab desactivado.");
    const checked=()=>metrics.measure("auth",authorize);
    const remote=createV3Remote({client,url,publishableKey,scope,authorize,enabled:true,
     concurrency:optimized?2:1,localGuard:optimized?localGuard:undefined,metrics,
     onProgress:({phase,done,total})=>{if(n===seq)$("v3-lab-status").textContent=({upload:"Subiendo bloques",download:"Descargando bloques",commit:"Confirmando revisión"}[phase]||phase)+" · "+done+"/"+total;}
    });
    return runV3Lab({scope,key,authorize:checked,remote,action,metrics});
   }));
   if(n===seq){$("v3-lab-status").textContent=labels[r.state]||"Estado no confirmado.";$("v3-lab-proof").textContent=(r.title||"Sin copia local")+" · revisión confirmada "+r.revision+" · "+r.pages+" hojas · "+r.assets+" activos · frente "+r.large+" bytes"+(r.pending?" · cola "+r.pending:"");}
  }catch{if(n===seq)$("v3-lab-status").textContent="Prueba no completada. Revisá acceso, conexión e interruptor de laboratorio. No se modificaron cartas personales.";}
  finally{if(n===seq)for(const a of actions)$("v3-lab-"+a).disabled=false;}
 }
 for(const a of actions)$("v3-lab-"+a).onclick=()=>run(a);
 return {clear,reveal};
}
