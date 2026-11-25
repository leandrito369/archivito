import { createClient } from "@supabase/supabase-js";
import { inspectAccess } from "./auth-access.mjs";

const status = document.querySelector("#status");
const login = document.querySelector("#login");
const logout = document.querySelector("#logout");
const retry = document.querySelector("#retry");
const url = __ARCHIVITO_SUPABASE_URL__;
const key = __ARCHIVITO_SUPABASE_PUBLISHABLE_KEY__;
let client, seq = 0;
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
  show("Verificando sesión y permisos…");
  try{
    const result=await inspectAccess(client);
    if(token!==seq)return;
    render(result.state);
    if(result.state==="signed-out")show("Iniciá sesión para solicitar acceso.");
    if(result.state==="denied")show("Cuenta autenticada, sin autorización para el archivo. El administrador debe habilitarla.");
    if(result.state==="authorized")show("Acceso autorizado ("+(result.role==="owner"?"propietario":"editor")+"). Sincronización aún deshabilitada.");
  }catch{
    if(token!==seq)return;
    render("error");show("No se pudo verificar el acceso. Reintentá con conexión a Internet.");
  }
}
async function init(){
  if(!url||!key){show("Configuración de Supabase ausente. Compilá con la URL y la clave pública del proyecto.");return;}
  try{
    client=createClient(url,key,{auth:{flowType:"pkce",persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:"archivito-auth-v1",storage:sessionStorage}});
    login.onclick=async()=>{
      login.disabled=true;
      try{
        const redirectTo=new URL("./",location.href).href;
        const {error}=await client.auth.signInWithOAuth({provider:"google",options:{redirectTo,queryParams:{prompt:"select_account"}}});
        if(error)throw error;
      }catch{login.disabled=false;show("No se pudo iniciar Google OAuth. Revisá la configuración y la conexión.");}
    };
    logout.onclick=async()=>{
      ++seq;logout.disabled=true;
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
    client.auth.onAuthStateChange(()=>{setTimeout(refresh,0);});
    await refresh();
  }catch{show("No se pudo iniciar el módulo de acceso. Revisá configuración y navegador.");}
}
init();
