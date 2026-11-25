import {generateRecoveryCode,unlockRecoveryCode,seal,open,sealMetadata,openMetadata,sha256Hex,toBase64Url,fromBase64Url} from "./shared-crypto.mjs";
const $=id=>document.getElementById(id);
const archiveId="12345678-1234-4abc-8def-0123456789ab";
const asset={archiveId,objectId:"12345678-1234-4abc-8def-0123456789ac",kind:"asset",revision:1};
const meta={...asset,objectId:"12345678-1234-4abc-8def-0123456789ad",kind:"metadata"};
let unlocked=null,busy=false,generation=0;
const tell=s=>{$("status").textContent=s;};
function render(){
 for(const id of ["encrypt","decrypt","lock"])$(id).disabled=busy||!unlocked;
 for(const id of ["generate","unlock"])$(id).disabled=busy;
}
function clearKey(){
 generation++;unlocked=null;$("recovery").value="";$("recovery").type="password";$("reveal").checked=false;render();
}
function pack(e){return {...e,nonce:toBase64Url(e.nonce),ciphertext:toBase64Url(e.ciphertext)};}
function unpack(e){return {...e,nonce:fromBase64Url(e.nonce,12),ciphertext:fromBase64Url(e.ciphertext,65536)};}
async function run(action){
 if(busy)return;
 busy=true;render();
 const current=generation;
 try{await action(current);}
 catch{if(current===generation)tell("Operación rechazada: revisá la clave, el contexto o la integridad del paquete.");}
 finally{busy=false;render();}
}
$("generate").onclick=()=>run(async current=>{
 unlocked=null;
 const code=await generateRecoveryCode();
 if(current!==generation)return;
 $("recovery").value=code;tell("Código de prueba generado. Guardalo temporalmente de forma privada y pulsá Desbloquear.");
});
$("reveal").onchange=()=>{$("recovery").type=$("reveal").checked?"text":"password";};
$("unlock").onclick=()=>run(async current=>{
 unlocked=null;
 const key=await unlockRecoveryCode($("recovery").value.trim());
 if(current!==generation)return;
 unlocked=key;tell("Clave desbloqueada. Huella pública: "+key.keyId.slice(0,16));
});
$("lock").onclick=()=>{clearKey();tell("Clave bloqueada. El paquete cifrado puede conservarse.");};
$("encrypt").onclick=()=>run(async current=>{
 const key=unlocked;
 // Draw a synthetic image without reading the user's photos.
 const canvas=document.createElement("canvas");canvas.width=32;canvas.height=24;
 const ctx=canvas.getContext("2d");ctx.fillStyle="#eac99a";ctx.fillRect(0,0,32,24);ctx.fillStyle="#49392a";ctx.fillRect(4,6,24,2);ctx.fillRect(4,11,18,2);
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
 if(!blob)throw Error("No se pudo generar la muestra.");
 const image=new Uint8Array(await blob.arrayBuffer());
 const metadata={title:"Carta ficticia",note:"Prueba de cifrado compartido",mime:"image/png",assetSha256:await sha256Hex(image)};
 const envelope={format:"archivito-lab-v1",metadata:pack(await sealMetadata(key,meta,metadata)),asset:pack(await seal(key,asset,image))};
 if(current!==generation)return;
 $("envelope").value=JSON.stringify(envelope,null,2);
 tell("Muestra cifrada. Transferí únicamente este JSON y, por separado y en privado, el código de prueba.");
});
$("decrypt").onclick=()=>run(async current=>{
 const key=unlocked,raw=$("envelope").value;
 if(raw.length>65536)throw Error("Paquete demasiado grande.");
 const envelope=JSON.parse(raw);
 if(envelope.format!=="archivito-lab-v1")throw Error("Formato incorrecto.");
 const metadata=await openMetadata(key,meta,unpack(envelope.metadata));
 const image=await open(key,asset,unpack(envelope.asset));
 if(metadata.title!=="Carta ficticia"||metadata.mime!=="image/png"||metadata.assetSha256!==await sha256Hex(image))throw Error("Integridad incorrecta.");
 if(current===generation)tell("VERIFICADO: "+metadata.title+" · PNG recuperado ("+image.length+" bytes) · SHA-256 coincide.");
});
addEventListener("pagehide",clearKey);
render();
