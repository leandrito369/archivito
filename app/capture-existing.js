/* Archivito 0.3A.3 — edición selectiva no destructiva de una hoja/cara existente.
   La transacción aborta si el recuerdo cambió desde que se abrió el editor.
   El original se conserva, excepto al agregar una foto a un reverso que antes estaba vacío.
   Sin servicios remotos ni cambios de esquema físico IndexedDB. */
(function (root) {
  "use strict";
  const DB_NAME="nuestro-archivo-cartas-v1", STORE="letters";
  function parseQuery(search) {
    const q=new URLSearchParams(search);
    const id=q.get("recuerdo"), pageId=q.get("hoja"), side=q.get("cara");
    if (!id && !pageId && !side) return null;
    if (!id || !pageId || !["front","back"].includes(side) ||
        id.length>200 || pageId.length>120)
      throw new Error("Enlace de digitalización inválido. Abrí la carta desde la biblioteca.");
    return {id,pageId,side};
  }
  const supported = blob => blob instanceof Blob &&
    ["image/jpeg","image/png","image/webp","image/gif"].includes(blob.type) &&
    blob.size>0 && blob.size<=35*1024*1024;
  const checkSource = blob => {
    if (typeof root.ArchivitoImageMobile === "object" &&
        typeof root.ArchivitoImageMobile.quickValidateFile === "function") {
      if (!(blob instanceof Blob)) throw new Error("La fotografía original no tiene un formato admitido.");
      root.ArchivitoImageMobile.quickValidateFile(blob);
      return;
    }
    if (!supported(blob)) throw new Error("La fotografía original no tiene un formato admitido.");
  };
  const cropMeta = (points, photo, canvas) => {
    if (!root.ArchivitoPerspective?.valid(points))
      throw new Error("Las cuatro esquinas del recorte no son válidas.");
    return {algorithm:"homography-js-v1",
      points:points.map(p=>({x:p.x,y:p.y})),
      input:{width:photo.width,height:photo.height},
      output:{width:canvas.width,height:canvas.height},
      createdAt:new Date().toISOString()};
  };
  function openDB() {
    return new Promise((resolve,reject)=>{
      const q=indexedDB.open(DB_NAME,1);
      q.onupgradeneeded=()=> {
        if(!q.result.objectStoreNames.contains(STORE))
          q.result.createObjectStore(STORE,{keyPath:"id"});
      };
      q.onerror=()=>reject(q.error);
      q.onsuccess=()=>resolve(q.result);
    });
  }
  async function load(target) {
    const db=await openDB();
    try {
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORE,"readonly");
        const get=tx.objectStore(STORE).get(target.id);
        get.onerror=()=>reject(get.error);
        get.onsuccess=()=>{
          const record=get.result;
          if(!record) {reject(new Error("No se encontró la carta. Comprobá el origen y el navegador."));return;}
          const r=root.ArchivitoArchiveV3.normalize(record);
          const index=r.pages.findIndex(p=>p.id===target.pageId);
          if(index<0){reject(new Error("La hoja seleccionada ya no existe."));return;}
          const page=r.pages[index];
          if(target.side==="front" && !(page.front instanceof Blob)){
            reject(new Error("La hoja no tiene fotografía del frente."));return;
          }
          resolve({
            target:{...target},title:r.title,pageIndex:index,totalPages:r.pages.length,
            expectedUpdatedAt:record.updatedAt??null,
            expectedGeneration:root.ArchivitoLocalGeneration.generation(record),
            original:page[target.side]||null
          });
        };
      });
    } finally {db.close();}
  }
  function save({target,expectedUpdatedAt,expectedGeneration=null,derived,crop,thumb,newBackOriginal=null}) {
    if(!target||!["front","back"].includes(target.side))
      return Promise.reject(new Error("Destino de captura inválido."));
    if(!(derived instanceof Blob)||derived.type!=="image/png"||derived.size===0)
      return Promise.reject(new Error("El derivado PNG no es válido."));
    if(!crop||crop.algorithm!=="homography-js-v1"||
       !root.ArchivitoPerspective?.valid(crop.points))
      return Promise.reject(new Error("No se puede guardar un recorte inválido."));
    if(target.side==="front" && !(thumb instanceof Blob))
      return Promise.reject(new Error("No se pudo generar la miniatura del frente."));
    if(newBackOriginal!==null) checkSource(newBackOriginal);
    return openDB().then(db=>new Promise((resolve,reject)=>{
      let failure=null, saved=false;
      const tx=db.transaction(STORE,"readwrite"), store=tx.objectStore(STORE);
      const fail=(message)=>{failure=message instanceof Error?message:new Error(message);tx.abort();};
      tx.oncomplete=()=>{saved=true;db.close();resolve();};
      tx.onerror=()=>{failure??=tx.error;};
      tx.onabort=()=>{db.close();reject(failure||tx.error||new Error("No se pudo guardar."));};
      const req=store.get(target.id);
      req.onsuccess=()=>{
        try {
          if(!req.result){fail("La carta ya no existe.");return;}
          const current=req.result;
          if((current.updatedAt??null)!==(expectedUpdatedAt??null)||root.ArchivitoLocalGeneration.generation(current)!==expectedGeneration){
            fail("Esta carta cambió en otra pestaña. Volvé a abrirla antes de digitalizar.");return;
          }
          const r=root.ArchivitoArchiveV3.normalize(current);
          const page=r.pages.find(p=>p.id===target.pageId);
          if(!page){fail("La hoja ya no existe.");return;}
          let original=page[target.side]||null;
          if(original){
            checkSource(original);
            if(newBackOriginal){fail("El reverso ya contiene una foto original. No se reemplazó.");return;}
          }else{
            if(target.side!=="back"||!newBackOriginal){
              fail("Falta una fotografía original del reverso.");return;
            }
            original=newBackOriginal;
            page.back=original;
          }
          page[target.side+"Derived"]=derived;
          page[target.side+"Crop"]=crop;
          if(target.side==="front")page.thumb=thumb;
          if(r.pages[0].id===target.pageId){
            // Mantener los espejos legacy sincronizados sin cambiar los originales.
            r.front=r.pages[0].front;
            r.back=r.pages[0].back||null;
            r.thumb=r.pages[0].thumb||null;
          }
          r.schemaVersion=3;
          r.updatedAt=new Date().toISOString();
          store.put(root.ArchivitoLocalGeneration.stamp(r));
        }catch(error){fail(error);}
      };
    }));
  }
  root.ArchivitoCaptureExisting={parseQuery,load,save,cropMeta};
  if(typeof module!=="undefined"&&module.exports)module.exports=root.ArchivitoCaptureExisting;
})(typeof globalThis==="object"?globalThis:this);
