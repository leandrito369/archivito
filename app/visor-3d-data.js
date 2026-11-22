/* Archivito 0.3B.1: solo lecturas IndexedDB; fallback 2D si falla WebGL. */
(function(){
"use strict";
const $=s=>document.querySelector(s);
const params=new URLSearchParams(location.search);
const id=params.get("recuerdo"),desired=Number(params.get("hoja")||0);
const force2d=params.get("modo")==="2d";
let item=null,pages=[],index=0,side="front",derived=true,flat=true,viewer=null,threeModule=null;
let urls=[],sequence=0,closed=false;
function report(message,error=false){$("#status").textContent=message;$("#status").classList.toggle("error",error);}
function clearUrls(){urls.forEach(u=>URL.revokeObjectURL(u));urls=[];}
function chosen(p,face){return derived&&p[face+"Derived"] instanceof Blob?p[face+"Derived"]:p[face] instanceof Blob?p[face]:null;}
function update(){
 if(!item)return;
 const p=pages[index];
 $("#return-link").href="./index.html?recuerdo="+encodeURIComponent(id)+"&hoja="+index;
 $("#page-position").textContent="Hoja "+(index+1)+" / "+pages.length;
 $("#prev").disabled=index===0;$("#next").disabled=index===pages.length-1;
 $("#front").classList.toggle("active",side==="front");
 $("#back").classList.toggle("active",side==="back");
 $("#sources").disabled=!pages.some(p=>p.frontDerived||p.backDerived);
 $("#sources").textContent=derived?"Ver fotos originales":"Ver digitalizaciones";
 $("#toggle-2d").textContent=flat?"Activar visor 3D":"Cambiar a vista 2D";
 ["#reset","#zoom-in","#zoom-out","#curve"].forEach(s=>{$(s).disabled=flat;});
 $("#webgl-stage").hidden=flat;$("#flat-view").hidden=!flat;
 $("#hint").textContent=flat?"Vista de lectura 2D · frente y reverso":
   "Arrastrar para girar · rueda para zoom · usar botones frente/reverso";
 clearUrls();
 if(flat){
   const blob=chosen(p,side),img=$("#flat-image");
   img.hidden=!blob;$("#noimage").style.display=blob?"none":"block";
   if(blob){const url=URL.createObjectURL(blob);urls.push(url);img.src=url;}
   else img.removeAttribute("src");
 }
}
async function photoSize(blob){
 if(!blob)return {width:3,height:4};
 const b=await createImageBitmap(blob);
 try{return {width:b.width,height:b.height};}finally{b.close();}
}
function fallback(reason){
 ++sequence;
 viewer?.dispose();viewer=null;flat=true;
 update();report(reason+" Vista 2D disponible.",true);
}
async function redraw(){
 if(flat||!viewer)return;
 const revision=++sequence,p=pages[index],front=chosen(p,"front"),back=chosen(p,"back");
 try{
   const size=await photoSize(front);
   if(revision!==sequence||closed)return;
   await viewer.setPage({...size,front,back,curve:Number($("#curve").value)/100});
   if(revision!==sequence||closed)return;
   viewer.showSide(side);
   report("Visor Three.js local activo. Las fotos originales no se modificaron.");
 }catch(e){fallback("No se pudo cargar el papel: "+e.message);}
}
async function enable3D(){
 if(!flat||!item||closed)return;
 if(force2d){report("Modo 2D forzado. Abrí esta página sin modo=2d para usar WebGL.");return;}
 if(viewer){flat=false;update();await redraw();return;}
 try{
   report("Iniciando Three.js desde node_modules...");
   threeModule??=await import("./visor-three.js");
   if(closed)return;
   viewer=threeModule.createThreeViewer($("#webgl-stage"),{onFailure:error=>fallback(error.message)});
   flat=false;update();await redraw();
 }catch(e){fallback("Three.js/WebGL no disponible ("+e.message+"). Instalá la dependencia con npm install y recargá.");}
}
function refresh(){if(!flat&&viewer){update();redraw();}else update();}
async function loadRecord(){
 if(!id||id.length>200)throw Error("Abrí este visor desde una carta de la biblioteca.");
 $("#return-link").href="./index.html?recuerdo="+encodeURIComponent(id)+"&hoja="+(Number.isInteger(desired)&&desired>=0?desired:0);
 const db=await new Promise((resolve,reject)=>{
   const q=indexedDB.open("nuestro-archivo-cartas-v1",1);
   q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains("letters"))q.result.createObjectStore("letters",{keyPath:"id"});};
   q.onerror=()=>reject(q.error);q.onsuccess=()=>resolve(q.result);
 });
 let raw;
 try{raw=await new Promise((resolve,reject)=>{
   const req=db.transaction("letters","readonly").objectStore("letters").get(id);
   req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });}finally{db.close();}
 if(!raw)throw Error("Carta no encontrada en este navegador y origen.");
 item=ArchivitoArchiveV3.normalize(raw);pages=item.pages;
 if(!pages.length)throw Error("Esta carta no tiene hojas.");
 index=Number.isInteger(desired)?Math.min(pages.length-1,Math.max(0,desired)):0;
 $("#title").textContent=item.title;
 $("#detail").textContent="Archivo local · "+pages.length+" hojas · volumen aproximado, no escaneo 3D exacto";
 update();report("Carta cargada. Podés verla en modo 2D sin dependencias.");
 if(!force2d)await enable3D();
}
$("#front").onclick=()=>{side="front";viewer?.showSide(side);update();};
$("#back").onclick=()=>{side="back";viewer?.showSide(side);update();};
$("#prev").onclick=()=>{if(index>0){index--;side="front";refresh();}};
$("#next").onclick=()=>{if(index<pages.length-1){index++;side="front";refresh();}};
$("#sources").onclick=()=>{derived=!derived;refresh();};
$("#toggle-2d").onclick=()=>{if(flat)enable3D();else{flat=true;update();report("Vista de lectura 2D activa.");}};
$("#zoom-in").onclick=()=>viewer?.zoom(.85);
$("#zoom-out").onclick=()=>viewer?.zoom(1.16);
$("#reset").onclick=()=>viewer?.reset();
$("#curve").oninput=e=>viewer?.setCurvature(Number(e.target.value)/100);
document.addEventListener("keydown",e=>{
 if(!item||/input|textarea|select/i.test(e.target?.tagName||""))return;
 if(e.key==="ArrowLeft"&&index>0){index--;side="front";refresh();}
 if(e.key==="ArrowRight"&&index<pages.length-1){index++;side="front";refresh();}
});
window.addEventListener("pagehide",()=>{closed=true;++sequence;viewer?.dispose();clearUrls();},{once:true});
loadRecord().catch(e=>report("No se pudo abrir el visor: "+e.message,true));
})();