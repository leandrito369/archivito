import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
import {encodeFixture,decodeFixture,createMemoryTransport} from "../app/sync-contract.mjs";
const ids=()=>({archiveId:randomUUID(),memoryId:randomUUID(),revision:1,operationId:randomUUID()});
const fixture=()=>({...ids(),title:"Carta ficticia",note:"Texto privado ficticio",assets:[
 {id:randomUUID(),side:"front-original",mime:"image/png",bytes:new Uint8Array([1,2,3])},
 {id:randomUUID(),side:"back-original",mime:"image/png",bytes:new Uint8Array([4,5,6])}
]});
async function keys(){const code=await generateRecoveryCode();return [await unlockRecoveryCode(code),await unlockRecoveryCode(code)];}
test("A publica y B recupera metadatos y frente/reverso; transporte no recibe texto",async()=>{
 const [a,b]=await keys(),f=fixture(),p=await encodeFixture(a,f),t=createMemoryTransport();
 assert.equal(Object.hasOwn(p,"title"),false);assert.equal(Object.hasOwn(p,"note"),false);
 assert.equal(Object.hasOwn(p.assets[0],"mime"),false);
 assert.equal((await t.publish(p,0)).state,"synced");
 const recovered=await decodeFixture(b,f,t.read(f.archiveId,f.memoryId));
 assert.equal(recovered.title,f.title);assert.equal(recovered.note,f.note);assert.deepEqual(recovered.assets,f.assets);
});
test("B edita revisión 2; una edición concurrente de A no pisa el contenido",async()=>{
 const [a,b]=await keys(),f=fixture(),t=createMemoryTransport();
 await t.publish(await encodeFixture(a,f),0);
 const left={...f,title:"Edición A",revision:2,operationId:randomUUID()},right={...f,title:"Edición B",revision:2,operationId:randomUUID()};
 const results=await Promise.all([t.publish(await encodeFixture(b,right),1),t.publish(await encodeFixture(a,left),1)]);
 assert.equal(results.filter(x=>x.state==="synced").length,1);
 assert.equal(results.filter(x=>x.state==="conflict").length,1);
 const r=await decodeFixture(a,{...f,revision:2},t.read(f.archiveId,f.memoryId));assert.ok(["Edición A","Edición B"].includes(r.title));
});
test("reintento exacto idempotente; operación reutilizada con otro paquete rechazada",async()=>{
 const [a]=await keys(),f=fixture(),t=createMemoryTransport(),p=await encodeFixture(a,f);
 assert.equal((await t.publish(p,0)).replayed,false);
 assert.equal((await t.publish(p,0)).replayed,true);
 await assert.rejects(t.publish(await encodeFixture(a,{...f,title:"Cambio incompatible"}),0));
});
test("clave distinta, archivo distinto, revisión inesperada y operación alterada fallan",async()=>{
 const [a]=await keys(),[b]=await keys(),f=fixture(),p=await encodeFixture(a,f);
 await assert.rejects(decodeFixture(b,f,p));
 await assert.rejects(decodeFixture(a,{...f,archiveId:randomUUID()},p));
 await assert.rejects(decodeFixture(a,{...f,revision:2},p));
 await assert.rejects(decodeFixture(a,f,{...p,operationId:randomUUID()}));
});
test("activo ausente, duplicado o alterado no produce recuperación parcial",async()=>{
 const [a]=await keys(),f=fixture(),p=await encodeFixture(a,f);
 await assert.rejects(decodeFixture(a,f,{...p,assets:[p.assets[0]]}));
 await assert.rejects(decodeFixture(a,f,{...p,assets:[p.assets[0],p.assets[0]]}));
 const bad=structuredClone(p);bad.assets[1].ciphertext[0]^=1;await assert.rejects(decodeFixture(a,f,bad));
});
test("transporte rechaza campos claros extras y conserva instantánea independiente",async()=>{
 const [a]=await keys(),f=fixture(),p=await encodeFixture(a,f),t=createMemoryTransport();
 await assert.rejects(t.publish({...p,title:f.title},0));
 await t.publish(p,0);p.assets[0].ciphertext[0]^=1;
 const copy=t.read(f.archiveId,f.memoryId);copy.assets[0].ciphertext[0]^=1;
 assert.deepEqual((await decodeFixture(a,f,t.read(f.archiveId,f.memoryId))).assets,f.assets);
});
test("identificadores repetidos y límites de tamaño se rechazan",async()=>{
 const [a]=await keys(),f=fixture();
 await assert.rejects(encodeFixture(a,{...f,assets:[f.assets[0],f.assets[0]]}));
 await assert.rejects(encodeFixture(a,{...f,assets:[{...f.assets[0],bytes:new Uint8Array(8*1024*1024+1)}]}));
});
