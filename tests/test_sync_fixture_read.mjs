import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto,randomUUID} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {generateRecoveryCode,unlockRecoveryCode,sha256Hex,toBase64Url} from "../app/shared-crypto.mjs";
import {encodeFixture} from "../app/sync-contract.mjs";
import {readPublishedFixture} from "../app/sync-fixture-read.mjs";
async function lab(){
 const key=await unlockRecoveryCode(await generateRecoveryCode()),scope={userId:randomUUID(),archiveId:randomUUID(),keyId:key.keyId};
 const p=await encodeFixture(key,{archiveId:scope.archiveId,memoryId:randomUUID(),revision:1,operationId:randomUUID(),title:"Carta ficticia",note:"Nota",assets:[{id:randomUUID(),side:"front-original",mime:"image/png",bytes:new Uint8Array([1,2,3])}]});
 const e=p.assets[0],path=[p.archiveId,p.operationId,e.objectId].join("/");
 const header={format:p.format,archiveId:p.archiveId,memoryId:p.memoryId,operationId:p.operationId,revision:1,keyId:p.keyId,metadata:{nonce:toBase64Url(p.metadata.nonce),ciphertext:toBase64Url(p.metadata.ciphertext)},assets:[{assetId:e.objectId,path,nonce:toBase64Url(e.nonce),size:e.ciphertext.length,sha256:await sha256Hex(e.ciphertext)}]};
 const state={corrupt:false,authorized:true,empty:false};
 const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:async()=>({data:state.empty?[]:[{header}]})};
 const client={from:()=>chain,storage:{from:()=>({download:async name=>{assert.equal(name,path);const b=e.ciphertext.slice();if(state.corrupt)b[0]^=1;return {data:new Blob([b])};}})}};
 const authorize=async()=>({...scope,unlocked:state.authorized});
 return {read:()=>readPublishedFixture(client,key,scope,authorize),state};
}
test("published fixture decrypts, validates bytes and returns original",async()=>{const l=await lab(),r=await l.read();assert.equal(r.title,"Carta ficticia");assert.deepEqual(r.assets[0].bytes,new Uint8Array([1,2,3]));});
test("corrupt download rejected",async()=>{const l=await lab();l.state.corrupt=true;await assert.rejects(l.read());});
test("locked and empty states",async()=>{const l=await lab();l.state.empty=true;assert.equal(await l.read(),null);l.state.authorized=false;await assert.rejects(l.read());});
