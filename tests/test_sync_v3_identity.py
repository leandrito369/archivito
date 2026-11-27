"""Real IndexedDB identity mapping; no access to the library or remote service."""
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

class V3IdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),partial(Quiet,directory=str(ROOT)))
        Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url=f"http://127.0.0.1:{cls.server.server_port}/app/sync-v3-identity.mjs"
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.ctx=self.browser.new_context()
        self.page=self.ctx.new_page()
        self.page.goto(self.url)

    def tearDown(self):
        self.ctx.close()

    def test_stable_across_reload_and_concurrent_allocations(self):
        first=self.page.evaluate("""async () => {
          const {openV3IdentityMap}=await import('./sync-v3-identity.mjs');
          const scope={userId:crypto.randomUUID(),archiveId:crypto.randomUUID()};
          const a=await openV3IdentityMap(scope),b=await openV3IdentityMap(scope);
          const [x,y]=await Promise.all([a.allocate('legacy-123'),b.allocate('legacy-123')]);
          a.close();b.close();return {scope,x,y};
        }""")
        self.assertEqual(first["x"],first["y"])
        self.page.reload()
        result=self.page.evaluate("""async ({scope,x})=>{
          const {openV3IdentityMap}=await import('./sync-v3-identity.mjs');
          const a=await openV3IdentityMap(scope);
          const byLocal=await a.byLocal(x.localId),byRemote=await a.byRemote(x.remoteId);a.close();
          return {byLocal,byRemote};
        }""",first)
        self.assertEqual(result["byLocal"],first["x"])
        self.assertEqual(result["byRemote"],first["x"])

    def test_no_rebinding_or_cross_scope_leak(self):
        result=self.page.evaluate("""async ()=>{
          const {openV3IdentityMap}=await import('./sync-v3-identity.mjs');
          const scope={userId:crypto.randomUUID(),archiveId:crypto.randomUUID()};
          const a=await openV3IdentityMap(scope),b=await openV3IdentityMap({...scope,userId:crypto.randomUUID()});
          const remote=crypto.randomUUID();await a.bind('legacy',remote);
          let rejected=0;
          for(const [local,id] of [['legacy',crypto.randomUUID()],['other',remote]]){
            try{await a.bind(local,id);}catch{rejected++;}
          }
          const hidden=await b.byRemote(remote);const imported=await b.bind('different-local-id',remote);
          a.close();b.close();return {rejected,hidden,imported,remote};
        }""")
        self.assertEqual(result["rejected"],2)
        self.assertIsNone(result["hidden"])
        self.assertEqual(result["imported"]["remoteId"],result["remote"])
