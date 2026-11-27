/* Archivito 0.4A.1 — backup v4 seguro, sin subir datos a Internet.
   Dos etapas para importar: descifrar + verificar todos los bytes -> una transacción add.
   No sobrescribe IDs existentes. */
(function(){
  "use strict";
  const $=s=>document.querySelector(s);
  const CRYPTO=ArchivitoCryptoV4,ARCHIVE=ArchivitoArchiveV3;
  const DB_NAME="nuestro-archivo-cartas-v1",STORE="letters";
  const MAX_FILE=250*1024*1024;

  function tell(message,error=false){
    const el=$("#status");
    el.textContent=message;el.classList.toggle("error",error);
  }
  function openDB(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>{
        if(!req.result.objectStoreNames.contains(STORE))
          req.result.createObjectStore(STORE,{keyPath:"id"});
      };
      req.onerror=()=>reject(req.error);
      req.onsuccess=()=>resolve(req.result);
    });
  }
  async function allRecords(){
    const db=await openDB();
    try{return await new Promise((resolve,reject)=>{
      const request=db.transaction(STORE,"readonly").objectStore(STORE).getAll();
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });}finally{db.close();}
  }
  async function addAllAtomically(records){
    if(!records.length)return;
    const db=await openDB();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORE,"readwrite"),store=tx.objectStore(STORE);
        tx.oncomplete=()=>resolve();
        tx.onabort=()=>reject(tx.error||Error("La importación se canceló. Puede existir un ID duplicado. No se escribió nada."));
        tx.onerror=()=>reject(tx.error||Error("Falló la importación."));
        const stamp=typeof ArchivitoLocalGeneration==="object"&&typeof ArchivitoLocalGeneration.stamp==="function"
          ?ArchivitoLocalGeneration.stamp:r=>r;
        try{records.forEach(r=>store.add(stamp(r)));}
        catch(err){tx.abort();reject(err);}
      });
    }finally{db.close();}
  }
  function blobToDataURL(blob){
    if(!(blob instanceof Blob))return Promise.reject(Error("Falta una fotografía original."));
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(reader.error||Error("No se pudo leer el archivo."));
      reader.readAsDataURL(blob);
    });
  }
  function dataToBlob(uri){
    if(typeof uri!=="string"||!/^data:image\/(jpeg|png|webp|gif);base64,/i.test(uri))
      throw Error("El respaldo contiene una imagen con formato inválido.");
    const parts=uri.split(",",2);
    const type=parts[0].slice(5,parts[0].indexOf(";"));
    const raw=atob(parts[1]);
    if(raw.length>35*1024*1024)throw Error("Una fotografía supera los 35 MB.");
    const bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    return new Blob([bytes],{type});
  }
  function validateImage(file){
    if(!(file instanceof Blob)||
       !["image/jpeg","image/png","image/webp","image/gif"].includes(file.type)||
       file.size===0||file.size>35*1024*1024)
      throw Error("Imagen inválida o mayor que 35 MB.");
  }
  async function thumbnail(file){
    const image=await createImageBitmap(file);
    try{
      const scale=Math.min(1,540/Math.max(image.width,image.height));
      const canvas=document.createElement("canvas");
      canvas.width=Math.max(1,Math.round(image.width*scale));
      canvas.height=Math.max(1,Math.round(image.height*scale));
      canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height);
      return await new Promise((resolve,reject)=>canvas.toBlob(
        value=>value?resolve(value):reject(Error("No se pudo crear la miniatura.")),
        "image/jpeg",.78
      ));
    }finally{image.close();}
  }
  function download(data,name){
    const blob=new Blob([JSON.stringify(data)],{type:"application/json"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  async function withBusy(button,action){
    button.disabled=true;
    try{await action();}
    catch(error){console.error("Respaldo v4:",error.name||"Error");tell(error.message||"Error al procesar el respaldo.",true);}
    finally{button.disabled=false;}
  }
  $("#export-form").addEventListener("submit",event=>{
    event.preventDefault();
    withBusy($("#export-button"),async()=>{
      const first=$("#export-password"),again=$("#export-confirm");
      const password=first.value;
      try{
        if(password!==again.value)throw Error("Las contraseñas no coinciden.");
        if([...password].length<12)throw Error("Usá al menos 12 caracteres.");
        tell("Preparando imágenes, hashes y cifrado… El navegador puede necesitar unos segundos.");
        const records=await allRecords(),serialized=[],manifest=[];
        if(records.length>1000)throw Error("Demasiados recuerdos para un solo respaldo.");
        for(const record of records){
          const normalized=ARCHIVE.normalize(record);
          manifest.push(await CRYPTO.manifestFor(normalized));
          serialized.push(await ARCHIVE.encode(normalized,blobToDataURL));
        }
        const payload={
          format:"archivito-v4-payload",version:4,sourceFormat:ARCHIVE.FORMAT,
          exportedAt:new Date().toISOString(),records:serialized,manifest
        };
        const sealed=await CRYPTO.encrypt(payload,password);
        download(sealed,"archivito-"+new Date().toISOString().slice(0,10)+"-cifrado-v4.archivito");
        tell("Respaldo cifrado v4 exportado: "+records.length+
          " recuerdos. Conservalo fuera del navegador y guardá la contraseña por separado.");
      }finally{first.value="";again.value="";}
    });
  });
  $("#import-form").addEventListener("submit",event=>{
    event.preventDefault();
    withBusy($("#import-button"),async()=>{
      const file=$("#backup-file").files?.[0],passwordField=$("#import-password");
      const password=passwordField.value;
      try{
        if(!file||file.size<64||file.size>MAX_FILE)
          throw Error("Seleccioná un respaldo v4 válido menor que 250 MB.");
        tell("Descifrando y verificando todas las fotografías… No se escribieron datos todavía.");
        const encrypted=JSON.parse(await file.text());
        const payload=await CRYPTO.decrypt(encrypted,password);
        if(!payload||payload.format!=="archivito-v4-payload"||
           payload.version!==4||payload.sourceFormat!==ARCHIVE.FORMAT||
           !Array.isArray(payload.records)||!Array.isArray(payload.manifest)||
           payload.records.length!==payload.manifest.length||
           payload.records.length>1000)
          throw Error("Contenido de respaldo v4 inválido.");
        const restored=[];
        const ids=new Set();
        for(let i=0;i<payload.records.length;i++){
          const record=await ARCHIVE.decode(payload.records[i],ARCHIVE.FORMAT,
            dataToBlob,validateImage,thumbnail);
          if(ids.has(record.id))throw Error("El respaldo contiene IDs duplicados.");
          ids.add(record.id);
          await CRYPTO.verifyManifest(record,payload.manifest[i]);
          restored.push(record);
        }
        await addAllAtomically(restored);
        tell("Restauración v4 exitosa: "+restored.length+
          " recuerdos nuevos. Todos los originales y derivados pasaron la verificación SHA-256.");
      }finally{passwordField.value="";}
    });
  });
})();