"""Real IndexedDB tests for the synthetic queue (no Supabase or user records)."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

class SyncQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(ROOT)))
        Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/app/"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.ctx = self.browser.new_context()
        self.page = self.ctx.new_page()
        # A neutral same-origin page; do not open or mutate the real library.
        self.page.goto(self.url + "sync-contract.mjs")
        self.page.evaluate("""async () => {
          const c=await import('./shared-crypto.mjs'), s=await import('./sync-contract.mjs'), q=await import('./sync-queue.mjs');
          const key=await c.unlockRecoveryCode(await c.generateRecoveryCode());
          const scope={userId:crypto.randomUUID(),archiveId:crypto.randomUUID(),keyId:key.keyId};
          const fixture={archiveId:scope.archiveId,memoryId:crypto.randomUUID(),revision:1,operationId:crypto.randomUUID(),title:'Ficticio',note:'Privado',assets:[
            {id:crypto.randomUUID(),side:'front-original',mime:'image/png',bytes:new Uint8Array([1,2,3])}]};
          window.lab={scope,fixture,key,s,q,package:await s.encodeFixture(key,fixture)};
        }""")

    def tearDown(self):
        self.ctx.close()

    def test_persistence_after_page_reload_and_scope(self):
        scope=self.page.evaluate("""async () => {
          const l=lab,q=await l.q.openSyncQueue(l.scope);
          await q.enqueue(l.package,0);q.close();return l.scope;
        }""")
        self.page.reload()
        result=self.page.evaluate("""async scope => {
          const {openSyncQueue}=await import('./sync-queue.mjs');
          const q=await openSyncQueue(scope),before=await q.list();q.close();
          const other=await openSyncQueue({...scope,userId:crypto.randomUUID()});const hidden=await other.list();other.close();
          return {before,hidden};
        }""",scope)
        self.assertEqual(len(result["before"]),1)
        self.assertEqual(result["before"][0]["state"],"pending")
        self.assertEqual(result["hidden"],[])

    def test_failure_retry_identical_ciphertext_and_receipt(self):
        result=self.page.evaluate("""async () => {
          const l=lab,q=await l.q.openSyncQueue(l.scope),t=l.s.createMemoryTransport();
          await q.enqueue(l.package,0);await q.enqueue(l.package,0);
          let calls=0;
          const transport={publish:async(p,r)=>{
            const answer=await t.publish(p,r);
            if(++calls===1)throw Error('lost response after commit');
            if(!answer.replayed)throw Error('not idempotent');
            return answer;
          }};
          const a=await l.q.drainOne(q,transport),e=await q.list();
          await q.retry(l.package.operationId);
          const b=await l.q.drainOne(q,transport),done=await q.list();q.close();
          return {a,e,b,done,calls};
        }""")
        self.assertEqual(result["a"]["state"],"error")
        self.assertEqual(result["e"][0]["error"],"transport-failed")
        self.assertEqual(result["b"]["state"],"synced")
        self.assertEqual(result["done"][0]["attempts"],2)
        self.assertEqual(result["calls"],2)

    def test_multi_connection_claim_and_expired_lease(self):
        result=self.page.evaluate("""async () => {
          const l=lab,a=await l.q.openSyncQueue(l.scope),b=await l.q.openSyncQueue(l.scope);
          await a.enqueue(l.package,0);
          const claims=await Promise.all([a.claim(),b.claim()]),first=claims.find(Boolean);
          const now=Date.now;let next;
          try {Date.now=()=>now()+61000;next=await b.claim();} finally{Date.now=now;}
          const stale=await a.finish(l.package.operationId,first.token,{state:'synced',revision:1});
          const accepted=await b.finish(l.package.operationId,next.token,{state:'synced',revision:1});
          const rows=await b.list();a.close();b.close();
          return {claimed:claims.filter(Boolean).length,stale,accepted,rows};
        }""")
        self.assertEqual(result["claimed"],1)
        self.assertFalse(result["stale"])
        self.assertTrue(result["accepted"])
        self.assertEqual(result["rows"][0]["attempts"],2)

    def test_conflict_retained_and_reject_plaintext_or_scope(self):
        result=self.page.evaluate("""async () => {
          const l=lab,q=await l.q.openSyncQueue(l.scope),t=l.s.createMemoryTransport();
          await t.publish(l.package,0);
          const competing=await l.s.encodeFixture(l.key,{...l.fixture,operationId:crypto.randomUUID()});
          let bad=0;
          for(const p of [{...competing,title:'plaintext'},{...competing,archiveId:crypto.randomUUID()}]){
            try{await q.enqueue(p,0);}catch{bad++;}
          }
          await q.enqueue(competing,0);
          const state=await l.q.drainOne(q,t);
          const retry=await q.retry(competing.operationId),prune=await q.pruneSynced(competing.operationId),rows=await q.list();
          q.close();return {bad,state,retry,prune,rows};
        }""")
        self.assertEqual(result["bad"],2)
        self.assertEqual(result["state"]["state"],"conflict")
        self.assertFalse(result["retry"])
        self.assertFalse(result["prune"])
        self.assertEqual(result["rows"][0]["actualRevision"],1)
