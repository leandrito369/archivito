// Server-side core, intentionally not deployed. Dependencies must be trusted adapters.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[0-9a-f]{64}$/;
const MAX=8*1024*1024;
const uuid=x=>typeof x==="string"&&UUID.test(x);
const hex=x=>typeof x==="string"&&HEX.test(x);
const exact=(x,ks)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===ks.length&&ks.every(k=>Object.hasOwn(x,k));
function deny(){throw Error("Solicitud de laboratorio rechazada.");}
function bytes(s,max){
 if(typeof s!=="string"||s.length>Math.ceil(max*4/3)||!/^[A-Za-z0-9_-]+$/.test(s)||s.length%4===1)deny();
 const b=atob(s.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(s.length/4)*4,"="));
 const canonical=btoa(b).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
 if(canonical!==s||b.length>max)deny();return b.length;
}
function validate(b){
 if(!exact(b,["action","format","archiveId","memoryId","operationId","keyId","revision","expectedRevision","metadata","assets"])||
 !["begin","commit"].includes(b.action)||b.format!=="archivito-sync-fixture-v1"||!uuid(b.archiveId)||!uuid(b.memoryId)||!uuid(b.operationId)||!hex(b.keyId)||
 !Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0||!Number.isSafeInteger(b.revision)||b.revision!==b.expectedRevision+1||
 !exact(b.metadata,["nonce","ciphertext"])||bytes(b.metadata.nonce,12)!==12||bytes(b.metadata.ciphertext,65552)<16||
 !Array.isArray(b.assets)||b.assets.length<1||b.assets.length>8)deny();
 const ids=new Set([b.memoryId]);let total=0;
 for(const a of b.assets){
  if(!exact(a,["assetId","path","nonce","size","sha256"])||!uuid(a.assetId)||ids.has(a.assetId)||a.path!==[b.archiveId,b.operationId,a.assetId].join("/")||
  bytes(a.nonce,12)!==12||!Number.isSafeInteger(a.size)||a.size<17||a.size>MAX+16||!hex(a.sha256))deny();
  ids.add(a.assetId);total+=a.size-16;if(total>MAX)deny();
 }
 const {action,...header}=b;
 return {action,header:{...header,assets:[...header.assets].sort((a,b)=>a.assetId.localeCompare(b.assetId))}};
}
async function hash(b){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",b)),v=>v.toString(16).padStart(2,"0")).join("");}
// db.begin/lookup/commit must be transactional, compare immutable headers and actor,
// enforce fresh membership/key + lab enablement, and commit only verified immutable paths.
// readBlob is trusted server-side storage, not a receipt supplied by a client.
export function createFixtureService({verifyUser,authorize,db,readBlob,enabled=false}){
 return async function handle(token,body){
  if(enabled!==true||typeof token!=="string"||!token)deny();
  const {action,header}=validate(structuredClone(body));
  const user=await verifyUser(token);
  if(!user||!uuid(user.id))deny();
  async function guard(){
   const a=await authorize(user.id,header.archiveId);
   if(!a||a.labEnabled!==true||a.keyId!==header.keyId||!["owner","editor"].includes(a.role))deny();
  }
  await guard();
  if(action==="begin")return db.begin(user.id,header);
  // Lookup must reject changed header, actor or missing intent before any blob reads.
  const intent=await db.lookup(user.id,header);
  if(intent?.state==="synced"||intent?.state==="conflict")return intent;
  if(intent?.state!=="staging")deny();
  for(const a of header.assets){
   await guard();
   const blob=await readBlob("archivito-sync-lab",a.path);
   if(!(blob instanceof Uint8Array)||blob.byteLength!==a.size||await hash(blob)!==a.sha256)deny();
  }
  await guard();
  // Adapter must recheck membership and key in the same transaction as revision CAS.
  return db.commit(user.id,header);
 };
}
