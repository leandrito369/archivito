/* Archivito — contrato de respaldo v3: original + derivado por cada cara.
   Sin dependencias, sin servidor, sin escritura de IndexedDB.
   Compatibilidad: export v3, import v1/v2/v3. */
(function(root) {
  "use strict";
  const FORMAT = "nuestro-archivo-v3";
  const COPY_FIELDS = ["id","kind","title","date","from","to","note","tags",
    "favorite","createdAt","updatedAt"];
  function copyMeta(record) {
    const result = {};
    for (const key of COPY_FIELDS) if (record[key] !== undefined) result[key] = record[key];
    return result;
  }
  function asPage(page, i) {
    return {
      id: page.id || "p-"+i,
      caption: String(page.caption || "").slice(0,200),
      front: page.front,
      back: page.back || null,
      thumb: page.thumb || null,
      frontDerived: page.frontDerived || null,
      backDerived: page.backDerived || null,
      frontCrop: page.frontCrop || null,
      backCrop: page.backCrop || null
    };
  }
  function normalize(record) {
    const pages = Array.isArray(record.pages) && record.pages.length
      ? record.pages.map(asPage)
      : [asPage({id:"legacy",front:record.front,back:record.back,thumb:record.thumb},0)];
    return {...record,schemaVersion:record.schemaVersion>=3?3:2,pages};
  }
  async function encode(record, blobToDataURL) {
    const normalized=normalize(record);
    const pages=[];
    for (const page of normalized.pages) {
      pages.push({
        id:page.id,caption:page.caption,
        front:await blobToDataURL(page.front),
        back:page.back?await blobToDataURL(page.back):null,
        frontDerived:page.frontDerived?await blobToDataURL(page.frontDerived):null,
        backDerived:page.backDerived?await blobToDataURL(page.backDerived):null,
        frontCrop:page.frontCrop,backCrop:page.backCrop
      });
    }
    return {...copyMeta(normalized),pages};
  }
  function boundedText(x,max=100) {return String(x??"").slice(0,max);}
  async function decode(item, format, dataToBlob, validateImage, makeThumb) {
    if (!item||typeof item!=="object"||!item.id||!item.title)
      throw new Error("El respaldo contiene un recuerdo inválido.");
    if (!["nuestro-archivo-v1","nuestro-archivo-v2",FORMAT].includes(format))
      throw new Error("Versión de respaldo no compatible.");
    const legacy=format==="nuestro-archivo-v1";
    const sourcePages = legacy
      ? [{id:"legacy",front:item.front,back:item.back}]
      : item.pages;
    if (!Array.isArray(sourcePages)||sourcePages.length===0||sourcePages.length>25)
      throw new Error("Cantidad de hojas inválida.");
    const pages=[];
    for (const [i,p] of sourcePages.entries()) {
      if (!p||typeof p!=="object") throw new Error("Hoja inválida en el respaldo.");
      const front=dataToBlob(p.front);
      const back=p.back?dataToBlob(p.back):null;
      const frontDerived=format===FORMAT&&p.frontDerived?dataToBlob(p.frontDerived):null;
      const backDerived=format===FORMAT&&p.backDerived?dataToBlob(p.backDerived):null;
      [front,back,frontDerived,backDerived].filter(Boolean).forEach(validateImage);
      const thumb=await makeThumb(frontDerived||front);
      pages.push({
        id:boundedText(p.id||"p-"+i,120),caption:boundedText(p.caption,200),
        front,back,frontDerived,backDerived,
        frontCrop:format===FORMAT&&frontDerived?(p.frontCrop||null):null,
        backCrop:format===FORMAT&&backDerived?(p.backCrop||null):null,
        thumb
      });
    }
    const kinds=["letter","postcard","envelope","photo","other"];
    const now=new Date().toISOString();
    return {
      id:boundedText(item.id,200),schemaVersion:3,
      kind:kinds.includes(item.kind)?item.kind:"letter",title:boundedText(item.title,120),
      date:boundedText(item.date,10),from:boundedText(item.from),
      to:boundedText(item.to),note:boundedText(item.note,4000),
      tags:Array.isArray(item.tags)?item.tags.slice(0,15).map(x=>boundedText(x,60)):[],
      favorite:!!item.favorite,createdAt:item.createdAt||now,updatedAt:now,
      pages,front:pages[0].front,back:pages[0].back,thumb:pages[0].thumb
    };
  }
  function validateBackup(json) {
    if (!json || typeof json !== "object") throw new Error("Respaldo JSON inválido.");
    const format=json.format;
    const records=format==="nuestro-archivo-v1"?json.letters:json.records;
    if (!["nuestro-archivo-v1","nuestro-archivo-v2",FORMAT].includes(format) ||
        !Array.isArray(records)) throw new Error("El archivo no es un respaldo compatible (v1, v2 o v3).");
    if (records.length>1000) throw new Error("Demasiados recuerdos para importar.");
    return {format,records};
  }
  root.ArchivitoArchiveV3={FORMAT,normalize,encode,decode,validateBackup};
  if (typeof module!=="undefined"&&module.exports) module.exports=root.ArchivitoArchiveV3;
})(typeof globalThis==="object"?globalThis:this);
