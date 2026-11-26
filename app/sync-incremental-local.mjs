// Isolated certification storage. No personal library, plaintext or keys.
import {validateIncrementalWire} from "./sync-incremental-wire.mjs";
import {sha256Hex} from "./shared-crypto.mjs";
const DB="archivito-incremental-cert-v1",LIMIT=64*1024*1024,LEASE=30000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,HEX=/^[0-9a-f]{64}$/;
const uuid=x=>typeof x==="string"&&UUID.test(x),hex=x=>typeof x==="string"&&HEX.test(x);
const fail=()=>{throw Error("Estado de certificación inválido o concurrente.");};
const req=r=>new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
async function open(){
 return new Promise((ok,no)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>{for(const n of ["jobs","heads","cache"])r.result.createObjectStore(n,{keyPath:"id"});};r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);r.onblocked=()=>no(Error("Base bloqueada."));});
}
const same=(a,b)=>a===null||b===null?a===b:a.revision===b.revision&&a.operationId===b.operationId;
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const baseOf=w=>w?{revision:w.header.revision,operationId:w.header.operationId}:null;
export async function openIncrementalLabStore(scope){
 if(!uuid(scope?.userId)||!uuid(scope?.archiveId)||!hex(scope?.keyId))fail();
 const db=await open(),prefix=[scope.userId,scope.archiveId,scope.keyId].join("/")+"/";
 function id(m){if(!uuid(m))fail();return prefix+m;}
 function scoped(w,m){const h=validateIncrementalWire(w);if(h.archiveId!==scope.archiveId||h.keyId!==scope.keyId||h.memoryId!==m)fail();return h;}
 async function tx(names,mode,fn){
  const t=db.transaction(names,mode),done=new Promise((ok,no)=>{t.oncomplete=ok;t.onabort=()=>no(t.error||Error("Transacción abortada."));});done.catch(()=>{});
  try{const out=await fn(...names.map(n=>t.objectStore(n)));await done;return out;}
  catch(e){try{t.abort();}catch{}await done.catch(()=>{});throw e;}
 }
 return {
  close:()=>db.close(),
  async status(m){return tx(["jobs","heads"],"readonly",async(j,h)=>{const job=await req(j.get(id(m))),head=await req(h.get(id(m)));return {pending:job?{state:job.state,revision:job.wire.header.revision,newAssets:job.wire.uploads.length,newBytes:job.chunks.reduce((n,c)=>n+c.bytes.length,0)}:null,wire:head?.wire??null};});},
  async prepare(m,input,readChunk){
   const w=structuredClone(input),h=scoped(w,m),chunks=[];let size=new TextEncoder().encode(JSON.stringify(w)).length;
   for(const u of w.uploads)for(const b of u.chunks){const x=await readChunk(b.path);if(!(x instanceof Uint8Array)||x.length!==b.size)fail();const bytes=x.slice();if(await sha256Hex(bytes)!==b.sha256)fail();size+=bytes.length;if(size>LIMIT)fail();chunks.push({path:b.path,bytes});}
   return tx(["jobs","heads"],"readwrite",async(j,heads)=>{
    if(await req(j.get(id(m))))fail();const head=await req(heads.get(id(m)));
    if(!same(baseOf(head?.wire??null),w.base))fail();
    const all=await req(j.getAll());if(all.length>=8||all.reduce((n,r)=>n+r.size,0)+size>LIMIT)fail();
    await req(j.add({id:id(m),wire:w,chunks,size,state:"pending",token:null,until:0}));return h.revision;
   });
  },
  async claim(m){
   return tx(["jobs"],"readwrite",async j=>{const row=await req(j.get(id(m))),now=Date.now();
    if(!row||row.state==="conflict"||row.state==="uploading"&&row.until>now)return null;
    if(!["pending","error","uploading"].includes(row.state))fail();
    row.state="uploading";row.token=crypto.randomUUID();row.until=now+LEASE;await req(j.put(row));return row;
   });
  },
  async renew(m,token){return tx(["jobs"],"readwrite",async j=>{const r=await req(j.get(id(m)));if(!r||r.state!=="uploading"||r.token!==token||r.until<=Date.now())return false;r.until=Date.now()+LEASE;await req(j.put(r));return true;});},
  async finish(m,token,result){
   return tx(["jobs","heads"],"readwrite",async(j,h)=>{
    const r=await req(j.get(id(m)));if(!r||r.state!=="uploading"||r.token!==token||r.until<=Date.now())return false;
    if(result?.state==="synced"){
     if(result.operationId!==r.wire.header.operationId||result.revision!==r.wire.header.revision||typeof result.replayed!=="boolean")fail();
     const old=await req(h.get(id(m)));if(!same(baseOf(old?.wire??null),r.wire.base))fail();
     await req(h.put({id:id(m),wire:r.wire}));await req(j.delete(id(m)));
    }else{
     if(!["error","conflict"].includes(result?.state))fail();r.state=result.state;r.token=null;r.until=0;await req(j.put(r));
    }
    return true;
   });
  },
  async acceptRead(m,input){
   const w=structuredClone(input),h=scoped(w,m);
   return tx(["jobs","heads"],"readwrite",async(j,heads)=>{
    if(await req(j.get(id(m))))fail();
    const old=await req(heads.get(id(m))),base=baseOf(old?.wire??null);
    if(base&&(h.revision<base.revision||h.revision===base.revision&&(h.operationId!==base.operationId||JSON.stringify(canonical(old.wire))!==JSON.stringify(canonical(w)))))fail();
    await req(heads.put({id:id(m),wire:w}));return true;
   });
  },
  // Ciphertext cache is bounded across all scopes. No automatic deletion of jobs.
  async cached(m,ref,readRemote){
   if(!uuid(ref?.id)||!hex(ref.cipherSha256)||!Number.isSafeInteger(ref.size)||ref.size<17||ref.size>35*1024*1024+16)fail();
   const cacheId=id(m)+"/"+ref.id+"/"+ref.cipherSha256;
   const old=await tx(["cache"],"readonly",s=>req(s.get(cacheId)));
   if(old&&old.bytes instanceof Uint8Array&&old.bytes.length===ref.size&&await sha256Hex(old.bytes)===ref.cipherSha256)return {bytes:old.bytes,hit:true};
   const b=await readRemote();if(!(b instanceof Uint8Array)||b.length!==ref.size)fail();const bytes=b.slice();if(await sha256Hex(bytes)!==ref.cipherSha256)fail();
   // Cache failure must not lose an otherwise verified download.
   try{await tx(["cache"],"readwrite",async s=>{
    const all=await req(s.getAll()),used=all.filter(x=>x.id!==cacheId).reduce((n,x)=>n+x.size,0);
    if(used+bytes.length<=LIMIT)await req(s.put({id:cacheId,size:bytes.length,bytes}));});}catch{}
   return {bytes,hit:false};
  }
 };
}
// Renewal is serialized; wait for it before finishing. If ownership is lost,
// abort request and leave job for its next valid lease holder.
export async function drainIncrementalLab({store,memoryId,remote,authorize,signal}){
 await authorize();const job=await store.claim(memoryId);if(!job)return {state:"idle"};
 const ctl=new AbortController(),cancel=()=>ctl.abort();
 if(signal?.aborted)cancel();signal?.addEventListener("abort",cancel,{once:true});
 let renewal=Promise.resolve(),lost=false;
 const timer=setInterval(()=>{renewal=renewal.then(async()=>{if(!await store.renew(memoryId,job.token)){lost=true;cancel();}}).catch(()=>{lost=true;cancel();});},LEASE/3);
 let result;
 try{const chunks=new Map(job.chunks.map(x=>[x.path,x.bytes]));result=await remote.publish(job.wire,p=>chunks.get(p)?.slice(),{signal:ctl.signal});await authorize();}
 catch{result={state:"error"};}
 finally{clearInterval(timer);signal?.removeEventListener("abort",cancel);await renewal;}
 if(lost)return {state:"stale"};
 return await store.finish(memoryId,job.token,result)?result:{state:"stale"};
}
