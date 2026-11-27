"""Durable v3 outbox in real Chromium. Only synthetic local records and simulated transport."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*_):
        pass

class V3OutboxTests(unittest.TestCase):
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
          const c=await import('./shared-crypto.mjs'),q=await import('./sync-v3-outbox.mjs'),i=await import('./sync-v3-identity.mjs'),r=await import('./sync-v3-revisions.mjs');
          const key=await c.unlockRecoveryCode(await c.generateRecoveryCode());
          const scope={userId:crypto.randomUUID(),archiveId:crypto.randomUUID(),keyId:key.keyId};
          const img=new Blob([new Uint8Array([1,2,3])],{type:'image/png'});
          await put({id:'fixture',schemaVersion:3,kind:'letter',title:'Ficticio',date:'',from:'',to:'',note:'',tags:[],favorite:false,createdAt:'2026-11-25',updatedAt:'2026-11-25',pages:[{id:'p1',caption:'',front:img,back:null,frontDerived:null,backDerived:null,frontCrop:null,backCrop:null,thumb:img}],front:img,back:null,thumb:img});
          window.lab={key,scope,q,i,r};
        }""")

    def tearDown(self):
        self.ctx.close()

    def test_snapshot_receipt_and_later_edit(self):
        result=self.page.evaluate("""async ()=>{
          const l=lab,identity=await l.i.openV3IdentityMap(l.scope),outbox=await l.q.openV3Outbox(l.scope);
          const queued=await l.q.prepareLocalV3({identity,outbox,key:l.key,localId:'fixture'});
          const job=await outbox.claim(),r=(await all())[0];
          await put({...r,title:'Nueva edición'});
          const t=l.r.createV3RevisionTransport(),receipt=await t.publish(job.packet,job.expectedRevision);
          await outbox.finish(job.remoteId,job.token,receipt);
          const state=await outbox.status(job.remoteId),current=(await all())[0];
          const next=await l.q.prepareLocalV3({identity,outbox,key:l.key,localId:'fixture'});
          identity.close();outbox.close();
          return {queued,state,current:current.syncGeneration,title:current.title,next};
        }""")
        self.assertEqual(result["queued"]["state"],"queued")
        self.assertEqual(result["state"]["base"]["revision"],1)
        self.assertIsNone(result["state"]["pending"])
        self.assertNotEqual(result["state"]["baseGeneration"],result["current"])
        self.assertEqual(result["title"],"Nueva edición")
        self.assertEqual(result["next"]["pending"]["revision"],2)

    def test_reload_retry_exact_ciphertext_and_stale_worker(self):
        before=self.page.evaluate("""async ()=>{
          const l=lab,identity=await l.i.openV3IdentityMap(l.scope),outbox=await l.q.openV3Outbox(l.scope);
          await l.q.prepareLocalV3({identity,outbox,key:l.key,localId:'fixture'});
          const job=await outbox.claim();
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',job.packet.metadata.ciphertext)));
          identity.close();outbox.close();return {scope:l.scope,remote:job.remoteId,token:job.token,op:job.operationId,hash};
        }""")
        self.page.reload()
        after=self.page.evaluate("""async before=>{
          const {openV3Outbox}=await import('./sync-v3-outbox.mjs'),o=await openV3Outbox(before.scope);
          const now=Date.now;let job;
          try{Date.now=()=>now()+121000;job=await o.claim();}finally{Date.now=now;}
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',job.packet.metadata.ciphertext)));
          const stale=await o.finish(before.remote,before.token,{state:'error'});
          await o.finish(before.remote,job.token,{state:'error'});
          const retry=await o.retry(before.remote),again=await o.claim();
          o.close();return {hash,stale,retry,op:again.operationId};
        }""",before)
        self.assertEqual(before["hash"],after["hash"])
        self.assertEqual(before["op"],after["op"])
        self.assertFalse(after["stale"])
        self.assertTrue(after["retry"])

    def test_conflict_retained_and_scope_bound(self):
        result=self.page.evaluate("""async ()=>{
          const l=lab,identity=await l.i.openV3IdentityMap(l.scope),o=await l.q.openV3Outbox(l.scope);
          const a=await l.q.prepareLocalV3({identity,outbox:o,key:l.key,localId:'fixture'});
          const job=await o.claim();
          await o.finish(job.remoteId,job.token,{state:'conflict',actualRevision:2});
          const state=await o.status(job.remoteId),retry=await o.retry(job.remoteId);
          const b=await l.q.prepareLocalV3({identity,outbox:o,key:l.key,localId:'fixture'});
          const other=await l.q.openV3Outbox({...l.scope,userId:crypto.randomUUID()});
          const hidden=await other.status(job.remoteId);other.close();
          const rotated=await l.q.openV3Outbox({...l.scope,keyId:'a'.repeat(64)});
          let rejected=false;try{await rotated.status(job.remoteId);}catch{rejected=true;}
          rotated.close();identity.close();o.close();return {a,b,state,retry,hidden,rejected};
        }""")
        self.assertEqual(result["state"]["pending"]["state"],"conflict")
        self.assertEqual(result["a"]["pending"]["operationId"],result["b"]["pending"]["operationId"])
        self.assertFalse(result["retry"])
        self.assertIsNone(result["hidden"]["pending"])
        self.assertTrue(result["rejected"])
