/* Archivito — backup protegido v4 (WebCrypto, sin dependencias remotas).
   Formato: cabecera visible + payload JSON cifrado con AES-256-GCM.
   PBKDF2-HMAC-SHA256 600k iteraciones, sal 32 bytes, IV único 12 bytes.
   Esta función NO es sincronización cloud ni cifrado entre dos cuentas. */
(function(root) {
  "use strict";
  const FORMAT="archivito-backup-encrypted-v4";
  const VERSION=4, ITERATIONS=600000;
  const ENC=new TextEncoder(),DEC=new TextDecoder("utf-8",{fatal:true});
  const MAX_ENVELOPE_BYTES=250*1024*1024;

  function ensureSecure(){
    if(!root.crypto?.subtle||!root.crypto?.getRandomValues)
      throw Error("Web Crypto requiere HTTPS o localhost compatible.");
  }
  function b64(bytes){
    const size=8192;
    let out="";
    for(let i=0;i<bytes.length;i+=size)
      out+=String.fromCharCode(...bytes.subarray(i,i+size));
    return btoa(out);
  }
  function fromB64(value){
    if(typeof value!=="string"||value.length>MAX_ENVELOPE_BYTES*1.38||
       !/^[A-Za-z0-9+/]*={0,2}$/.test(value)||value.length%4!==0)
      throw Error("Campo binario del respaldo inválido.");
    const text=atob(value);
    const bytes=new Uint8Array(text.length);
    for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);
    return bytes;
  }
  async function keyFor(password,salt,iterations){
    const base=await root.crypto.subtle.importKey(
      "raw",ENC.encode(password),"PBKDF2",false,["deriveKey"]);
    return root.crypto.subtle.deriveKey({
      name:"PBKDF2",hash:"SHA-256",salt,iterations
    },base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  }
  function header(fields) {
    // Orden canónico para el AAD del cifrado autenticado.
    return JSON.stringify([
      fields.format,fields.version,fields.cipher,fields.kdf,
      fields.iterations,fields.salt,fields.iv
    ]);
  }
  function assertEnvelope(obj){
    if(!obj||typeof obj!=="object"||
       obj.format!==FORMAT||obj.version!==VERSION||
       obj.cipher!=="AES-256-GCM"||obj.kdf!=="PBKDF2-HMAC-SHA256"||
       obj.iterations!==ITERATIONS||
       typeof obj.ciphertext!=="string")
      throw Error("Formato de respaldo cifrado no compatible.");
    if(fromB64(obj.salt).length!==32||fromB64(obj.iv).length!==12)
      throw Error("Parámetros criptográficos inválidos.");
  }
  async function encrypt(payload,password){
    ensureSecure();
    if(typeof password!=="string"||[...password].length<12)
      throw Error("Usá una frase de contraseña de al menos 12 caracteres.");
    const salt=root.crypto.getRandomValues(new Uint8Array(32));
    const iv=root.crypto.getRandomValues(new Uint8Array(12));
    const fields={format:FORMAT,version:VERSION,cipher:"AES-256-GCM",
      kdf:"PBKDF2-HMAC-SHA256",iterations:ITERATIONS,salt:b64(salt),iv:b64(iv)};
    const key=await keyFor(password,salt,ITERATIONS);
    const plaintext=ENC.encode(JSON.stringify(payload));
    if(plaintext.length>160*1024*1024)
      throw Error("Colección demasiado grande para este respaldo v4; dividila en conjuntos más pequeños.");
    const encrypted=await root.crypto.subtle.encrypt({
      name:"AES-GCM",iv,additionalData:ENC.encode(header(fields)),tagLength:128
    },key,plaintext);
    return {...fields,ciphertext:b64(new Uint8Array(encrypted))};
  }
  async function decrypt(envelope,password){
    ensureSecure();assertEnvelope(envelope);
    if(typeof password!=="string"||!password)throw Error("Ingresá la contraseña.");
    const key=await keyFor(password,fromB64(envelope.salt),ITERATIONS);
    let plaintext;
    try{
      plaintext=await root.crypto.subtle.decrypt({
        name:"AES-GCM",iv:fromB64(envelope.iv),
        additionalData:ENC.encode(header(envelope)),tagLength:128
      },key,fromB64(envelope.ciphertext));
    }catch(_){
      throw Error("Contraseña incorrecta o respaldo modificado. No se importó ningún recuerdo.");
    }
    try{return JSON.parse(DEC.decode(plaintext));}
    catch(_){throw Error("Contenido del respaldo no válido.");}
  }
  async function sha256(blob){
    ensureSecure();
    if(!(blob instanceof Blob))throw Error("Se esperaba una fotografía Blob.");
    const digest=new Uint8Array(await root.crypto.subtle.digest("SHA-256",await blob.arrayBuffer()));
    return Array.from(digest,n=>n.toString(16).padStart(2,"0")).join("");
  }
  async function manifestFor(normalized) {
    return {
      id:normalized.id,
      pages:await Promise.all(normalized.pages.map(async p=>({
        id:p.id,
        front:await sha256(p.front),
        back:p.back?await sha256(p.back):null,
        frontDerived:p.frontDerived?await sha256(p.frontDerived):null,
        backDerived:p.backDerived?await sha256(p.backDerived):null
      })))
    };
  }
  async function verifyManifest(record,manifest){
    if(!manifest||record.id!==manifest.id||
       !Array.isArray(manifest.pages)||record.pages.length!==manifest.pages.length)
      throw Error("Manifiesto de integridad incompatible.");
    const real=await manifestFor(record);
    for(let i=0;i<real.pages.length;i++) {
      const a=real.pages[i],b=manifest.pages[i];
      if(!b||["id","front","back","frontDerived","backDerived"]
        .some(field=>a[field]!==b[field]))
        throw Error("No coinciden los hashes del archivo; importación cancelada.");
    }
  }
  root.ArchivitoCryptoV4={
    FORMAT,ITERATIONS,encrypt,decrypt,sha256,manifestFor,verifyManifest,assertEnvelope
  };
  if(typeof module!=="undefined"&&module.exports)module.exports=root.ArchivitoCryptoV4;
})(typeof globalThis==="object"?globalThis:this);