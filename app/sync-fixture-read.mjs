// Authenticated fixture read: reconstruct envelopes from published header and Storage.
import {decodeFixture,validatePackage} from "./sync-contract.mjs";
import {fromBase64Url,sha256Hex} from "./shared-crypto.mjs";
export async function readPublishedFixture(client,key,scope,authorize){
 const guard=async()=>{const a=await authorize();if(!a||a.unlocked!==true||a.userId!==scope.userId||a.archiveId!==scope.archiveId||a.keyId!==key.keyId)throw Error("Acceso modificado.");};
 await guard();
 const {data,error}=await client.from("sync_fixture_intents").select("header").eq("archive_id",scope.archiveId).eq("committed",true).order("created_at",{ascending:false}).limit(1);
 if(error||!Array.isArray(data))throw Error("No se pudo consultar la muestra.");
 if(!data.length)return null;
 const h=data[0].header;
 if(!h||h.archiveId!==scope.archiveId||h.keyId!==key.keyId||h.format!=="archivito-sync-fixture-v1"||!Array.isArray(h.assets)||h.assets.length<1||h.assets.length>8)throw Error("Cabecera inválida.");
 const env=(kind,objectId,nonce,ciphertext)=>({version:1,archiveId:h.archiveId,objectId,kind,revision:h.revision,keyId:h.keyId,nonce:fromBase64Url(nonce,12),ciphertext});
 const metadata=env("metadata",h.memoryId,h.metadata.nonce,fromBase64Url(h.metadata.ciphertext,65552));
 let total=0;const assets=[];
 for(const a of h.assets){
  if(!a||a.path!==[h.archiveId,h.operationId,a.assetId].join("/")||!Number.isSafeInteger(a.size)||a.size<17||a.size>8388624||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error("Activo inválido.");
  total+=a.size-16;if(total>8388608)throw Error("Límite superado.");
  await guard();
  const {data:blob,error:err}=await client.storage.from("archivito-sync-lab").download(a.path);
  if(err||!blob||blob.size!==a.size)throw Error("Descarga incompleta.");
  const bytes=new Uint8Array(await blob.arrayBuffer());
  if(bytes.length!==a.size||await sha256Hex(bytes)!==a.sha256)throw Error("Integridad de activo incorrecta.");
  assets.push(env("asset",a.assetId,a.nonce,bytes));
 }
 const packet=validatePackage({format:h.format,archiveId:h.archiveId,memoryId:h.memoryId,revision:h.revision,operationId:h.operationId,keyId:h.keyId,metadata,assets});
 const result=await decodeFixture(key,{archiveId:scope.archiveId,memoryId:h.memoryId,revision:h.revision},packet);
 await guard();return result;
}
