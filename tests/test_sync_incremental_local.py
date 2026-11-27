"""Real IndexedDB tests; no network, no personal library."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*_): pass
class IncrementalLocalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),partial(Quiet,directory=str(ROOT)))
        Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url=f"http://127.0.0.1:{cls.server.server_port}/app/sync-incremental-local.mjs"
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(headless=True)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
    def test_persistence_lease_cache_and_isolation(self):
        ctx=self.browser.new_context()
        try:
            page=ctx.new_page();page.goto(self.url)
            result=page.evaluate("""async()=>{
              const {openIncrementalLabStore,drainIncrementalLab}=await import('./sync-incremental-local.mjs');
              const {prepareIncremental}=await import('./sync-incremental.mjs');
              const {makeIncrementalWire}=await import('./sync-incremental-wire.mjs');
              const {generateRecoveryCode,unlockRecoveryCode}=await import('./shared-crypto.mjs');
              const key=await unlockRecoveryCode(await generateRecoveryCode()),m=crypto.randomUUID(),scope={userId:crypto.randomUUID(),archiveId:crypto.randomUUID(),keyId:key.keyId};
              const c={archiveId:scope.archiveId,memoryId:m,operationId:crypto.randomUUID(),revision:1};
              const record={id:m,schemaVersion:3,kind:'letter',title:'SECRET TEST',date:'',from:'',to:'',note:'',tags:[],favorite:false,createdAt:'2026-11-25',updatedAt:'2026-11-25',pages:[{id:'p',caption:'',front:new Blob([new Uint8Array(100)],{type:'image/png'}),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
              const d=await prepareIncremental(key,c,record),w=await makeIncrementalWire(d);
              let store=await openIncrementalLabStore(scope);await store.prepare(m,w.wire,w.chunk);store.close();
              store=await openIncrementalLabStore(scope);
              const before=await store.status(m),other=await openIncrementalLabStore({...scope,userId:crypto.randomUUID()}),isolated=await other.status(m);other.close();
              const j=await store.claim(m),competing=await store.claim(m),renewed=await store.renew(m,j.token);
              const stale=await store.finish(m,crypto.randomUUID(),{state:'error'});
              await store.finish(m,j.token,{state:'error'});store.close();
              store=await openIncrementalLabStore(scope);
              const result=await drainIncrementalLab({store,memoryId:m,authorize:async()=>scope,remote:{publish:async(wire,read)=>{if(wire.header.operationId!==c.operationId)throw Error('wrong operation');const b=wire.uploads[0].chunks[0];if((await read(b.path)).length!==b.size)throw Error('wrong bytes');return {state:'synced',operationId:c.operationId,revision:1,replayed:true};}}});
              const after=await store.status(m),ref=d.header.refs[0],bytes=d.newAssets[0].ciphertext;
              let calls=0;const load=async()=>{calls++;return bytes;};
              const cold=await store.cached(m,ref,load),warm=await store.cached(m,ref,load);
              const dbs=await indexedDB.databases();store.close();
              return {before,isolated,competing,renewed,stale,result,after,cold:cold.hit,warm:warm.hit,calls,dbs:dbs.map(x=>x.name)};
            }""")
            self.assertEqual(result["before"]["pending"]["state"],"pending")
            self.assertIsNone(result["isolated"]["pending"])
            self.assertIsNone(result["competing"])
            self.assertTrue(result["renewed"])
            self.assertFalse(result["stale"])
            self.assertEqual(result["result"]["state"],"synced")
            self.assertIsNone(result["after"]["pending"])
            self.assertFalse(result["cold"])
            self.assertTrue(result["warm"])
            self.assertEqual(result["calls"],1)
            self.assertNotIn("nuestro-archivo-cartas-v1",result["dbs"])
            self.assertNotIn("SECRET TEST",str(result["after"]))
        finally:
            ctx.close()

    def test_synthetic_lab_recovery_metadata_cache_and_conflict(self):
        ctx=self.browser.new_context()
        try:
            page=ctx.new_page();page.goto(self.url)
            result=page.evaluate("""async()=>{
              const {runIncrementalLab}=await import('./sync-incremental-lab.mjs');
              const {validateIncrementalWire}=await import('./sync-incremental-wire.mjs');
              const {createIncrementalTransport}=await import('./sync-incremental-transport.mjs');
              const {generateRecoveryCode,unlockRecoveryCode}=await import('./shared-crypto.mjs');
              const key=await unlockRecoveryCode(await generateRecoveryCode()),archiveId=crypto.randomUUID();
              const a={archiveId,userId:crypto.randomUUID(),keyId:key.keyId,role:'owner'},b={...a,userId:crypto.randomUUID(),role:'editor'};
              const t=createIncrementalTransport(),wires=new Map();
              let lose=true;
              const reorder=x=>Array.isArray(x)?x.map(reorder):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,reorder(x[k])])):x;
              const remote={
                async publish(w,read){
                  const h=validateIncrementalWire(w),newAssets=[];
                  for(const u of w.uploads){const ref=h.refs.find(r=>r.id===u.id),ciphertext=new Uint8Array(ref.size);let offset=0;for(const c of u.chunks){const b=await read(c.path);ciphertext.set(b,offset);offset+=b.length;}newAssets.push({id:u.id,ciphertext});}
                  const r=await t.publish({header:h,newAssets},w.base);
                  if(r.state==='synced')wires.set(h.operationId,w);
                  if(lose){lose=false;throw Error('lost confirmation');}
                  return r;
                },
                async manifest(m,op=null){
                  const head=t.latest(archiveId,m);const original=op===null?wires.get(head?.operationId):wires.get(op);
                  if(!original)return null;
                  const wire=reorder(original),header=validateIncrementalWire(wire);
                  return {wire,header,expected:{archiveId,memoryId:m,operationId:header.operationId,revision:header.revision,keyId:key.keyId}};
                },
                readAsset:(expected,ref)=>t.readAsset(expected,ref)
              };
              const run=(scope,action)=>runIncrementalLab({scope,key,authorize:async()=>scope,remote,action,size:'small'});
              const first=await run(a,'create'),retry=await run(a,'retry'),aRead=await run(a,'read'),bRead=await run(b,'read'),bWarm=await run(b,'read'),edit=await run(b,'edit'),aUpdate=await run(a,'read'),photo=await run(a,'photo'),conflict=await run(b,'edit');
              return {first,retry,aRead,bRead,bWarm,edit,aUpdate,photo,conflict,audit:t.audit(archiveId),dbs:(await indexedDB.databases()).map(d=>d.name)};
            }""")
            self.assertEqual(result["first"]["state"],"error")
            self.assertEqual(result["first"]["pending"],"error")
            self.assertEqual(result["retry"]["state"],"synced")
            self.assertTrue(result["retry"]["replayed"])
            self.assertGreater(result["retry"]["newBytes"],0)
            self.assertEqual(result["aRead"]["state"],"applied")
            self.assertEqual(result["bRead"]["hits"],0)
            self.assertEqual(result["bWarm"]["hits"],2)
            self.assertEqual(result["bWarm"]["downloadBytes"],0)
            self.assertEqual(result["edit"]["newBytes"],0)
            self.assertEqual(result["aUpdate"]["hits"],2)
            self.assertEqual(result["photo"]["newAssets"],1)
            self.assertEqual(result["conflict"]["state"],"conflict")
            self.assertEqual(result["audit"]["revisions"],3)
            self.assertEqual(result["audit"]["assets"],3)
            self.assertNotIn("nuestro-archivo-cartas-v1",result["dbs"])
        finally:
            ctx.close()

    def test_expired_lease_corrupt_queue_cache_and_page_close(self):
        ctx=self.browser.new_context()
        try:
            page=ctx.new_page();page.goto(self.url)
            seed=page.evaluate("""async()=>{
              const {openIncrementalLabStore}=await import('./sync-incremental-local.mjs');
              const {prepareIncremental}=await import('./sync-incremental.mjs');
              const {makeIncrementalWire}=await import('./sync-incremental-wire.mjs');
              const {generateRecoveryCode,unlockRecoveryCode}=await import('./shared-crypto.mjs');
              const key=await unlockRecoveryCode(await generateRecoveryCode()),m=crypto.randomUUID(),scope={userId:crypto.randomUUID(),archiveId:crypto.randomUUID(),keyId:key.keyId};
              const record={id:m,schemaVersion:3,kind:'letter',title:'Fixture',date:'',from:'',to:'',note:'',tags:[],favorite:false,createdAt:'2026-11-25',updatedAt:'2026-11-25',pages:[{id:'p',caption:'',front:new Blob([new Uint8Array(100)],{type:'image/png'}),back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]};
              const d=await prepareIncremental(key,{archiveId:scope.archiveId,memoryId:m,operationId:crypto.randomUUID(),revision:1},record),w=await makeIncrementalWire(d);
              const s=await openIncrementalLabStore(scope);await s.prepare(m,w.wire,w.chunk);const j=await s.claim(m);
              return {scope,m,token:j.token,until:j.until,ref:d.header.refs[0],bytes:Array.from(d.newAssets[0].ciphertext)};
            }""")
            page.close()
            page=ctx.new_page();page.goto(self.url)
            result=page.evaluate("""async seed=>{
              const {openIncrementalLabStore,drainIncrementalLab}=await import('./sync-incremental-local.mjs');
              const {scope,m,token,until,ref}=seed,bytes=new Uint8Array(seed.bytes),s=await openIncrementalLabStore(scope);
              const before=await s.status(m),busy=await s.claim(m);
              const originalNow=Date.now;Date.now=()=>until+1;
              let recovered,oldRenew,oldFinish;
              try{recovered=await s.claim(m);oldRenew=await s.renew(m,token);oldFinish=await s.finish(m,token,{state:'error'});await s.finish(m,recovered.token,{state:'error'});}
              finally{Date.now=originalNow;}
              const db=await new Promise((ok,no)=>{const r=indexedDB.open('archivito-incremental-cert-v1');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
              const mutate=(name,fn)=>new Promise((ok,no)=>{const t=db.transaction(name,'readwrite'),r=t.objectStore(name).openCursor();r.onsuccess=()=>{const c=r.result;if(c){const v=c.value;fn(v);c.update(v);}};t.oncomplete=ok;t.onabort=()=>no(t.error);});
              await mutate('jobs',v=>{v.chunks[0].bytes[0]^=1;});
              let calls=0;const remote={publish:async()=>{calls++;throw Error('must not call');}};
              const corrupt=await drainIncrementalLab({store:s,memoryId:m,remote,authorize:async()=>scope});
              const retained=await s.status(m);
              let reads=0;const good=async()=>{reads++;return bytes;};
              await s.cached(m,ref,good);await mutate('cache',v=>{v.bytes[0]^=1;});
              let rejected=false;try{await s.cached(m,ref,async()=>{const b=bytes.slice();b[0]^=1;return b;});}catch{rejected=true;}
              const repaired=await s.cached(m,ref,good),warm=await s.cached(m,ref,good);
              db.close();s.close();
              return {before,busy,newToken:recovered.token!==token,oldRenew,oldFinish,corrupt,retained,calls,rejected,repaired:repaired.hit,warm:warm.hit,reads};
            }""",seed)
            self.assertEqual(result["before"]["pending"]["state"],"uploading")
            self.assertIsNone(result["busy"])
            self.assertTrue(result["newToken"])
            self.assertFalse(result["oldRenew"])
            self.assertFalse(result["oldFinish"])
            self.assertEqual(result["corrupt"]["state"],"error")
            self.assertEqual(result["retained"]["pending"]["state"],"error")
            self.assertEqual(result["calls"],0)
            self.assertTrue(result["rejected"])
            self.assertFalse(result["repaired"])
            self.assertTrue(result["warm"])
            self.assertEqual(result["reads"],2)
        finally:
            ctx.close()
