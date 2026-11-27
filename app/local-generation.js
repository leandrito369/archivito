/* CLOUD-03.4C1: opaque local generation saved atomically with record.
   No network, no queue, no schema upgrade and no automatic migration.
   This field is local-only; archive-v3's explicit metadata allowlist excludes it. */
(function(root){
 "use strict";
 const pattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
 function generation(record){
  const g=record?.syncGeneration;
  if(g===undefined||g===null)return null;
  if(typeof g!=="string"||!pattern.test(g))throw Error("Generación local inválida.");
  return g;
 }
 function next(){
  const bytes=root.crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const h=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);
 }
 function stamp(record){
  if(!record||typeof record!=="object"||typeof record.id!=="string"||!record.id)throw Error("Recuerdo inválido.");
  return {...record,syncGeneration:next()};
 }
 root.ArchivitoLocalGeneration=Object.freeze({generation,stamp});
})(globalThis);
