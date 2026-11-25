"""Real IndexedDB inbound reconciliation; synthetic ciphertext and no network."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*_): pass

class V3PullTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),partial(Quiet,directory=str(ROOT)))
        Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url=f"http://127.0.0.1:{cls.server.server_port}/app/"
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()

    def setUp(self):
        self.ctx=self.browser.new_context()
        self.page=self.ctx.new_page()
        self.page.goto(self.url)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        self.page.evaluate("""async ()=>{
          const c=await import('./shared-crypto.mjs'),v=await import('./sync-v3-contract.mjs'),p=await import('./sync-v3-pull.mjs'),q=await import('./sync-v3-outbox.mjs');
          const key=await c.unlockRecoveryCode(await c.generateRecoveryCode());
          const scope={userId:crypto.randomUUID(),archiveId:crypto.randomUUID(),keyId:key.keyId},remoteId=crypto.randomUUID(),localId=crypto.randomUUID();
          const img=new Blob([new Uint8Array([1,2,3])],{type:'image/png'});
          const make=async (revision,title)=>{
            const expected={archiveId:scope.archiveId,memoryId:remoteId,operationId:crypto.randomUUID(),revision};
            const packet=await v.encodeV3Record(key,expected,{id:'other-device',schemaVersion:3,kind:'letter',title,date:'',from:'',to:'',note:'',tags:[],favorite:false,createdAt:'2026-11-25',updatedAt:'2026-11-25',pages:[{id:'p1',caption:'',front:img,back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null}]});
            return {scope,key,expected,packet,localId,validateImage:async()=>{},makeThumb:async b=>b};
          };
          window.lab={make,p,q,scope,key,remoteId,localId};
        }""")

    def tearDown(self): self.ctx.close()

    def test_import_and_pull_preserve_local_identity(self):
        r=self.page.evaluate("""async ()=>{
          const l=lab,a=await l.p.applyV3Pull(await l.make(1,'Primera')),first=(await all())[0];
          const b=await l.p.applyV3Pull(await l.make(2,'Segunda')),second=(await all())[0];
          const o=await l.q.openV3Outbox(l.scope),st=await o.status(l.remoteId);o.close();
          return {a,b,id:second.id,localId:l.localId,title:second.title,g1:first.syncGeneration,g2:second.syncGeneration,st,count:(await all()).length};
        }""")
        self.assertEqual(r["a"]["state"],"applied")
        self.assertEqual(r["b"]["state"],"applied")
        self.assertEqual(r["id"],r["localId"])
        self.assertEqual(r["title"],"Segunda")
        self.assertEqual(r["count"],1)
        self.assertNotEqual(r["g1"],r["g2"])
        self.assertEqual(r["st"]["base"]["revision"],2)
        self.assertEqual(r["st"]["baseGeneration"],r["g2"])

    def test_dirty_local_and_existing_id_never_overwritten(self):
        r=self.page.evaluate("""async ()=>{
          const l=lab;await l.p.applyV3Pull(await l.make(1,'Primera'));
          await put({...((await all())[0]),title:'Cambio local'});
          const b=await l.p.applyV3Pull(await l.make(2,'Remota'));
          const record=(await all())[0];
          const collision=await l.make(3,'Remota');collision.expected={...collision.expected,memoryId:crypto.randomUUID()};
          let rejected=false;try{await l.p.applyV3Pull(collision);}catch{rejected=true;}
          return {b,title:record.title,rejected};
        }""")
        self.assertEqual(r["b"]["state"],"conflict")
        self.assertEqual(r["title"],"Cambio local")
        self.assertTrue(r["rejected"])

    def test_journal_recovers_after_library_write_before_baseline(self):
        r=self.page.evaluate("""async ()=>{
          const l=lab,input=await l.make(1,'Primera');
          // Inject failure specifically into baseline write, after the letters transaction.
          const original=IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put=function(value,...args){
            if(this.name==='heads'&&value.base?.revision===1&&!value.pull)throw Error('simulated interruption');
            return original.call(this,value,...args);
          };
          let failed=false;try{await l.p.applyV3Pull(input);}catch{failed=true;}
          finally{IDBObjectStore.prototype.put=original;}
          const before=(await all())[0],o=await l.q.openV3Outbox(l.scope),pending=await o.status(l.remoteId);o.close();
          const resumed=await l.p.applyV3Pull(input),after=(await all())[0];
          return {failed,pending,resumed,unchanged:before.syncGeneration===after.syncGeneration,count:(await all()).length};
        }""")
        self.assertTrue(r["failed"])
        self.assertIsNotNone(r["pending"]["pull"])
        self.assertEqual(r["resumed"]["state"],"already-applied")
        self.assertTrue(r["unchanged"])
        self.assertEqual(r["count"],1)
