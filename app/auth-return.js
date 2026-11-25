// Handle the already configured exact callback /app/ on the same origin.
(function(){
  const p=new URLSearchParams(location.search);
  if(!p.has("code")&&!p.has("error")&&!p.has("error_description"))return;
  const destination=new URL("./acceso.html",location.href);
  for(const name of ["code","error","error_description","error_code"])if(p.has(name))destination.searchParams.set(name,p.get(name));
  document.documentElement.style.visibility="hidden";
  location.replace(destination.href);
})();
