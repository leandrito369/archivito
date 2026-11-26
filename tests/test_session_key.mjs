import {test} from "node:test";
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
import {createSessionKeyGate} from "../app/session-key.mjs";
import {generateRecoveryCode,unlockRecoveryCode} from "../app/shared-crypto.mjs";
const base={state:"authorized",userId:"u",role:"owner",archiveId:"a",fingerprint:null};
test("sólo propietario con archivo no configurado genera candidato",async()=>{
 let access={...base};
 const gate=createSessionKeyGate(async()=>access);await gate.refresh();
 const candidate=await gate.candidate();
 assert.equal((await unlockRecoveryCode(candidate.code)).keyId,candidate.fingerprint);
 access={...base,role:"editor"};await gate.refresh();await assert.rejects(gate.candidate());
});
test("ambos miembros requieren exactamente la huella registrada",async()=>{
 const code=await generateRecoveryCode(),other=await generateRecoveryCode();
 const fingerprint=(await unlockRecoveryCode(code)).keyId;
 for(const role of ["owner","editor"]){
  const gate=createSessionKeyGate(async()=>({...base,role,fingerprint}));await gate.refresh();
  await assert.rejects(gate.unlock(other));assert.equal(gate.isUnlocked(),false);
  assert.equal(await gate.unlock(code),true);assert.equal(gate.isUnlocked(),true);
  gate.lock();assert.equal(gate.isUnlocked(),false);
  await assert.rejects(gate.candidate());
 }
});
test("sin configuración, sin membresía o con revocación no desbloquea",async()=>{
 const code=await generateRecoveryCode();let access={...base};const gate=createSessionKeyGate(async()=>access);
 await gate.refresh();await assert.rejects(gate.unlock(code));
 access={...base,fingerprint:(await unlockRecoveryCode(code)).keyId};await gate.refresh();
 access={state:"denied"};await assert.rejects(gate.unlock(code));assert.equal(gate.isUnlocked(),false);
});
test("logout durante verificación invalida el resultado",async()=>{
 const code=await generateRecoveryCode();const a={...base,fingerprint:(await unlockRecoveryCode(code)).keyId};
 let release;let delayed=false;
 const gate=createSessionKeyGate(()=>delayed?new Promise(r=>{release=r;}):Promise.resolve(a));
 await gate.refresh();delayed=true;const pending=gate.unlock(code);gate.clear();release(a);
 await assert.rejects(pending);assert.equal(gate.isUnlocked(),false);
});

test("local epoch guard uses no network and fails immediately after lock",async()=>{
 const code=await generateRecoveryCode(),fingerprint=(await unlockRecoveryCode(code)).keyId;
 let reads=0;const gate=createSessionKeyGate(async()=>{reads++;return {...base,fingerprint};});
 await gate.refresh();await gate.unlock(code);
 await assert.rejects(gate.withUnlocked(async(key,scope,authorize,localGuard)=>{
  const before=reads;assert.deepEqual(localGuard(),scope);assert.deepEqual(localGuard(),scope);assert.equal(reads,before);
  await authorize();assert.equal(reads,before+1);gate.lock();assert.throws(localGuard);
 }));
});
