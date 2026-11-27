// Handle the already configured exact callback /app/ on the same origin.
(function(root){
  "use strict";
  function resolveAuthReturn(search){
    const p=new URLSearchParams(search);
    if(!p.has("code")&&!p.has("error")&&!p.has("error_description"))return null;
    const out=new URLSearchParams();
    for(const name of ["code","error","error_description","error_code"]){
      if(p.has(name))out.set(name,p.get(name));
    }
    return "./acceso.html?"+out.toString();
  }
  root.ArchivitoAuthReturn=Object.freeze({resolveAuthReturn});
  if(typeof module!=="undefined"&&module.exports)module.exports=root.ArchivitoAuthReturn;
  if(typeof location==="object"&&typeof location.replace==="function"&&typeof document==="object"){
    const target=resolveAuthReturn(location.search);
    if(target&&target.startsWith("./acceso.html?")){
      document.documentElement.style.visibility="hidden";
      location.replace(target);
    }
  }
})(typeof globalThis==="object"?globalThis:this);
