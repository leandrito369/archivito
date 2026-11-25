import {test} from "node:test";
import assert from "node:assert/strict";
import {generateRecoveryCode,unlockRecoveryCode,seal,open,sealMetadata,openMetadata,sha256Hex,toBase64Url,fromBase64Url} from "../app/shared-crypto.mjs";
const archiveId="12345678-1234-4abc-8def-0123456789ab";
const asset={archiveId,objectId:"12345678-1234-4abc-8def-0123456789ac",kind:"asset",revision:1};
const meta={...asset,objectId:"12345678-1234-4abc-8def-0123456789ad",kind:"metadata"};
const plain=new Uint8Array([0,1,2,253,254,255]);
const keys=async()=>{const recovery=await generateRecoveryCode();return [await unlockRecoveryCode(recovery),await unlockRecoveryCode(recovery)];};
test("dos dispositivos recuperan la misma clave no exportable",async()=>{
 const [a,b]=await keys();
 assert.equal(a.keyId,b.keyId);
 assert.equal(a.key.extractable,false);
 const envelope=await seal(a,asset,plain);
 assert.deepEqual(await open(b,asset,envelope),plain);
 assert.equal(envelope.nonce.length,12);
 assert.equal(envelope.ciphertext.length,plain.length+16);
});
test("códigos aleatorios y rechazo de códigos dañados",async()=>{
 const a=await generateRecoveryCode(),b=await generateRecoveryCode();
 assert.notEqual(a,b);
 assert.match(a,/^archivito1\.[A-Za-z0-9_-]{43}\.[a-f0-9]{8}$/);
 await assert.rejects(unlockRecoveryCode(a.slice(0,-1)+(a.endsWith("0")?"1":"0")));
 await assert.rejects(unlockRecoveryCode("una contraseña"));
});
test("metadatos privados y hash de bytes recuperables",async()=>{
 const [a,b]=await keys();
 const data={title:"Carta ficticia",note:"Texto privado de prueba",hash:await sha256Hex(plain)};
 const encrypted=await sealMetadata(a,meta,data);
 assert.notEqual(new TextDecoder().decode(encrypted.ciphertext),JSON.stringify(data));
 assert.deepEqual(await openMetadata(b,meta,encrypted),data);
 assert.equal(await sha256Hex(await open(b,asset,await seal(a,asset,plain))),data.hash);
});
test("clave incorrecta y manipulación del contenido o nonce rechazadas",async()=>{
 const [a]=await keys();const [other]=await keys();
 const env=await seal(a,asset,plain);
 await assert.rejects(open(other,asset,env));
 const bad=env.ciphertext.slice();bad[0]^=1;
 await assert.rejects(open(a,asset,{...env,ciphertext:bad}));
 const iv=env.nonce.slice();iv[0]^=1;
 await assert.rejects(open(a,asset,{...env,nonce:iv}));
});
test("contexto autenticado: archivo, objeto, revisión, tipo y versión",async()=>{
 const [a]=await keys();const env=await seal(a,asset,plain);
 for(const patch of [{archiveId:"12345678-1234-4abc-8def-0123456789ae"},{objectId:meta.objectId},{revision:2},{kind:"metadata"}]){
   await assert.rejects(open(a,{...asset,...patch},env));
   await assert.rejects(open(a,{...asset,...patch},{...env,...patch}));
 }
 await assert.rejects(open(a,asset,{...env,version:2}));
});
test("cifrados repetidos no reutilizan nonce ni ciphertext",async()=>{
 const [a]=await keys();
 const x=await seal(a,asset,plain),y=await seal(a,asset,plain);
 assert.notDeepEqual(x.nonce,y.nonce);
 assert.notDeepEqual(x.ciphertext,y.ciphertext);
});
test("serialización canónica y límites",async()=>{
 assert.deepEqual(fromBase64Url(toBase64Url(plain)),plain);
 assert.throws(()=>fromBase64Url("AB"));
 assert.throws(()=>fromBase64Url("AA=="));
 assert.throws(()=>fromBase64Url("AAAA",1));
 const [a]=await keys();
 await assert.rejects(seal(a,{...asset,revision:0},plain));
 await assert.rejects(seal(a,asset,new Uint8Array(35*1024*1024+1)));
});
