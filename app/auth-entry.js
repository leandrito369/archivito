import { createClient } from "@supabase/supabase-js";
import { inspectKeyAccess, createSessionKeyGate } from "./session-key.mjs";
import { createFixtureUI } from "./sync-fixture-ui.mjs";
import { createV3LabUI } from "./sync-v3-lab-ui.mjs";
import { createIncrementalLabUI } from "./sync-incremental-lab-ui.mjs";

const status = document.querySelector("#status");
const login = document.querySelector("#login");
const logout = document.querySelector("#logout");
const retry = document.querySelector("#retry");
const url = __ARCHIVITO_SUPABASE_URL__;
const key = __ARCHIVITO_SUPABASE_PUBLISHABLE_KEY__;
let client, seq = 0, gate, keyEpoch=0;
const $=id=>document.getElementById(id);
const keyStatus=$("key-status"), keyCode=$("key-code");
const fixture=createFixtureUI({getClient:()=>client,getGate:()=>gate});
const v3Lab=createV3LabUI({getClient:()=>client,getGate:()=>gate,url,publishableKey:key});
const incLab=createIncrementalLabUI({getClient:()=>client,getGate:()=>gate,url,publishableKey:key});
function clearKeyPanel(){
 fixture.clear();v3Lab.clear();incLab.clear();
 keyEpoch++;gate?.clear();$("key-panel").hidden=true;keyCode.value="";keyCode.type="password";$("key-show").checked=false;$("key-fingerprint").textContent="";keyStatus.textContent="";
}
function showKeyPanel(access){
 $("key-panel").hidden=false;
 $("key-generate").hidden=access.role!=="owner"||access.fingerprint!==null;
 $("key-unlock").hidden=access.fingerprint===null;
 keyCode.disabled=access.fingerprint===null&&access.role!=="owner";
 keyStatus.textContent=access.fingerprint===null?"Clave sin registrar. "+(access.role==="owner"?"Generá un código de prueba para preparar su huella.":"El propietario debe completar la configuración."):"Clave registrada. Introducí el código privado.";
 $("key-fingerprint").textContent=access.fingerprint?"Huella registrada: "+access.fingerprint:"";
}
async function keyAction(action){
 fixture.clear();v3Lab.clear();incLab.clear();
 const e=++keyEpoch;
 $("key-generate").disabled=true;$("key-unlock").disabled=true;
 try{
  if(action==="generate"){
   const value=await gate.candidate();
   if(e!==keyEpoch)return;
   keyCode.value=value.code;
   $("key-fingerprint").textContent="Huella candidata (64 caracteres): "+value.fingerprint;
   keyStatus.textContent="Guardá el código de prueba en privado. Sólo la huella puede registrarse administrativamente.";
  }else{
   const code=keyCode.value.trim();keyCode.value="";keyCode.type="password";$("key-show").checked=false;
   await gate.unlock(code);
   if(e===keyEpoch){keyStatus.textContent="Clave verificada y desbloqueada en memoria. Sólo laboratorio ficticio.";v3Lab.reveal();incLab.reveal();}
  }
 }catch{if(e===keyEpoch){keyCode.value="";keyStatus.textContent="Operación rechazada. Revisá la clave o volvé a comprobar el acceso.";}}
 finally{if(e===keyEpoch){$("key-generate").disabled=false;$("key-unlock").disabled=false;}}
}
$("key-show").onchange=()=>{keyCode.type=$("key-show").checked?"text":"password";};
$("key-generate").onclick=()=>keyAction("generate");
$("key-unlock").onclick=()=>keyAction("unlock");
$("key-lock").onclick=()=>{fixture.clear();v3Lab.clear();incLab.clear();keyEpoch++;gate?.lock();keyCode.value="";keyCode.type="password";$("key-show").checked=false;$("key-generate").disabled=false;$("key-unlock").disabled=false;keyStatus.textContent="Clave bloqueada.";};
addEventListener("pagehide",()=>{++seq;clearKeyPanel();});
function show(message){status.textContent = message;}
function render(state){
  login.hidden = state !== "signed-out";
  login.disabled = state !== "signed-out";
  logout.hidden = state === "signed-out";
  logout.disabled = false;
  retry.hidden = state !== "error" && state !== "denied";
  retry.disabled = false;
}
async function refresh(){
  const token=++seq;
  clearKeyPanel();
  $("key-generate").disabled=false;$("key-unlock").disabled=false;
  show("Verificando sesión y permisos…");
  try{
    const result=await gate.refresh();
    if(token!==seq)return;
    render(result.state);
    if(result.state==="signed-out")show("Iniciá sesión para solicitar acceso.");
    if(result.state==="denied")show("Cuenta autenticada, sin autorización para el archivo. El administrador debe habilitarla.");
    if(result.state==="authorized"){show("Acceso autorizado ("+(result.role==="owner"?"propietario":"editor")+"). Sincronización real deshabilitada.");showKeyPanel(result);}
  }catch{
    if(token!==seq)return;
    render("error");show("No se pudo verificar el acceso. Reintentá con conexión a Internet.");
  }
}
async function init(){
  if(!url||!key){show("Configuración de Supabase ausente. Compilá con la URL y la clave pública del proyecto.");return;}
  try{
    client=createClient(url,key,{auth:{flowType:"pkce",persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:"archivito-auth-v1",storage:sessionStorage}});
    gate=createSessionKeyGate(()=>inspectKeyAccess(client));
    login.onclick=async()=>{
      login.disabled=true;
      try{
        const redirectTo=new URL("./",location.href).href;
        const {error}=await client.auth.signInWithOAuth({provider:"google",options:{redirectTo,queryParams:{prompt:"select_account"}}});
        if(error)throw error;
      }catch{login.disabled=false;show("No se pudo iniciar Google OAuth. Revisá la configuración y la conexión.");}
    };
    logout.onclick=async()=>{
      ++seq;clearKeyPanel();logout.disabled=true;
      try{const {error}=await client.auth.signOut({scope:"local"});if(error)throw error;await refresh();}
      catch{render("error");show("No se pudo cerrar la sesión. Reintentá.");}
    };
    retry.onclick=refresh;
    const query=new URLSearchParams(location.search);
    if(query.has("code")){
      const code=query.get("code");
      history.replaceState(null,"",location.pathname);
      const {error}=await client.auth.exchangeCodeForSession(code);
      if(error){render("signed-out");show("No se pudo completar Google OAuth. Volvé a iniciar sesión.");return;}
    } else if(query.has("error")||query.has("error_description")){
      history.replaceState(null,"",location.pathname);
      render("signed-out");show("Google no completó el inicio de sesión. Volvé a intentarlo.");return;
    }
    client.auth.onAuthStateChange(()=>{++seq;clearKeyPanel();setTimeout(refresh,0);});
    await refresh();
  }catch{show("No se pudo iniciar el módulo de acceso. Revisá configuración y navegador.");}
}
init();
