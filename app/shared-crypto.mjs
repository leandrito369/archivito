// Archivito CLOUD-02.1: client-side cryptographic primitives. No network or persistence.
// The recovery code is a high-entropy secret, NOT a password and NOT a public API key.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_BYTES = 35 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const KINDS = new Set(["metadata","asset"]);
function webcrypto() {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto requiere HTTPS o localhost.");
  return globalThis.crypto;
}
function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError("Se requieren bytes.");
  return value;
}
export function toBase64Url(value) {
  const input = bytes(value);
  let s = "";
  for (let i=0;i<input.length;i+=16384) s += String.fromCharCode(...input.subarray(i,i+16384));
  return btoa(s).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}
export function fromBase64Url(value, maxBytes=MAX_BYTES+16) {
  if (typeof value!=="string" || value.length>Math.ceil(maxBytes*4/3) ||
      !/^[A-Za-z0-9_-]*$/.test(value) || value.length%4===1) throw new Error("Base64url inválido.");
  const raw=atob(value.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(value.length/4)*4,"="));
  const out=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(out.length>maxBytes || toBase64Url(out)!==value) throw new Error("Base64url no canónico.");
  return out;
}
export async function sha256Hex(value) {
  const result=await webcrypto().subtle.digest("SHA-256",bytes(value));
  return Array.from(new Uint8Array(result),n=>n.toString(16).padStart(2,"0")).join("");
}
export async function generateRecoveryCode() {
  const raw=webcrypto().getRandomValues(new Uint8Array(32));
  try {
    const id=await sha256Hex(raw);
    return "archivito1."+toBase64Url(raw)+"."+id.slice(0,8);
  } finally { raw.fill(0); }
}
export async function unlockRecoveryCode(code) {
  if(typeof code!=="string"||code.length!==63) throw new Error("Código de recuperación inválido.");
  const match=/^archivito1\.([A-Za-z0-9_-]{43})\.([0-9a-f]{8})$/.exec(code);
  if(!match)throw new Error("Código de recuperación inválido.");
  const raw=fromBase64Url(match[1],32);
  try {
    if(raw.length!==32)throw new Error("Longitud de clave inválida.");
    const keyId=await sha256Hex(raw);
    if(keyId.slice(0,8)!==match[2])throw new Error("Código de recuperación incorrecto.");
    const key=await webcrypto().subtle.importKey("raw",raw,"AES-GCM",false,["encrypt","decrypt"]);
    return Object.freeze({key,keyId});
  } finally {raw.fill(0);}
}
function header(context,keyId) {
  if(!context||!UUID.test(context.archiveId)||!UUID.test(context.objectId)||
    !KINDS.has(context.kind)||!Number.isSafeInteger(context.revision)||context.revision<1||
    !HEX.test(keyId))throw new Error("Contexto criptográfico inválido.");
  return {version:1,archiveId:context.archiveId,objectId:context.objectId,kind:context.kind,revision:context.revision,keyId};
}
function aad(h) {
  return encoder.encode(JSON.stringify(["archivito-e2ee",h.version,h.archiveId,h.objectId,h.kind,h.revision,h.keyId]));
}
export async function seal(unlocked,context,plaintext) {
  const h=header(context,unlocked.keyId);
  const input=bytes(plaintext);
  if(input.length>MAX_BYTES)throw new Error("Contenido demasiado grande.");
  const nonce=webcrypto().getRandomValues(new Uint8Array(12));
  const ciphertext=new Uint8Array(await webcrypto().subtle.encrypt(
    {name:"AES-GCM",iv:nonce,additionalData:aad(h),tagLength:128},unlocked.key,input));
  return {...h,nonce,ciphertext};
}
export async function open(unlocked,expected,envelope) {
  const h=header(expected,unlocked.keyId);
  if(!envelope || Object.keys(h).some(k=>envelope[k]!==h[k]))throw new Error("Clave o contexto incorrecto.");
  const nonce=bytes(envelope.nonce), ciphertext=bytes(envelope.ciphertext);
  if(nonce.length!==12||ciphertext.length<16||ciphertext.length>MAX_BYTES+16)throw new Error("Sobre cifrado inválido.");
  try {
    return new Uint8Array(await webcrypto().subtle.decrypt(
      {name:"AES-GCM",iv:nonce,additionalData:aad(h),tagLength:128},unlocked.key,ciphertext));
  }catch{throw new Error("No se pudo autenticar el contenido cifrado.");}
}
export async function sealMetadata(unlocked,context,value) {
  if(context.kind!=="metadata"||!value||typeof value!=="object"||Array.isArray(value))throw new Error("Metadatos inválidos.");
  return seal(unlocked,context,encoder.encode(JSON.stringify(value)));
}
export async function openMetadata(unlocked,expected,envelope) {
  if(expected.kind!=="metadata")throw new Error("Contexto no corresponde a metadatos.");
  const value=JSON.parse(decoder.decode(await open(unlocked,expected,envelope)));
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Metadatos inválidos.");
  return value;
}
