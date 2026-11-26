"""Real browser lab flow, synthetic PNG, simulated remote; no personal DB."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*_): pass

class V3LabTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),partial(Quiet,directory=str(ROOT)))
        Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url=f"http://127.0.0.1:{cls.server.server_port}/app/sync-v3-lab.mjs"
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(headless=True)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close()
    def test_full_lab_and_conflict(self):
        ctx=self.browser.new_context()
        try:
            page=ctx.new_page();page.goto(self.url)
            result=page.evaluate("""async ()=>{
              const {runV3Lab}=await import('./sync-v3-lab.mjs');
              const {generateRecoveryCode,unlockRecoveryCode}=await import('./shared-crypto.mjs');
              const {createV3RevisionTransport}=await import('./sync-v3-revisions.mjs');
              const key=await unlockRecoveryCode(await generateRecoveryCode()),archiveId=crypto.randomUUID();
              const t=createV3RevisionTransport();
              const remote={publish:(p,e)=>t.publish(p,e),read:async(id,revision)=>{
                const p=revision===undefined?t.latest(archiveId,id):t.readRevision(archiveId,id,revision);
                return p?{expected:{archiveId:p.archiveId,memoryId:p.memoryId,operationId:p.operationId,revision:p.revision,keyId:p.keyId},packet:p}:null;
              }};
              const a={userId:crypto.randomUUID(),archiveId,keyId:key.keyId,role:'owner'},b={...a,userId:crypto.randomUUID(),role:'editor'};
              const run=(scope,action)=>runV3Lab({scope,key,authorize:async()=>({...scope,unlocked:true}),remote,action});
              const a1=await run(a,'create'),b1=await run(b,'read'),b2=await run(b,'edit'),a2=await run(a,'read'),a3=await run(a,'edit'),conflict=await run(b,'edit');
              const dbs=await indexedDB.databases();
              return {a1,b1,b2,a2,a3,conflict,dbs:dbs.map(x=>x.name)};
            }""")
            self.assertEqual([result[k]["state"] for k in ["a1","b1","b2","a2","a3","conflict"]],["synced","applied","synced","applied","synced","conflict"])
            self.assertEqual([result[k]["revision"] for k in ["a1","b1","b2","a2","a3","conflict"]],[1,1,2,2,3,2])
            self.assertEqual(result["a2"]["assets"],5)
            self.assertEqual(result["a2"]["pages"],2)
            self.assertGreater(result["a2"]["large"],4194304)
            self.assertEqual(result["conflict"]["pending"],"conflict")
            self.assertNotIn("nuestro-archivo-cartas-v1",result["dbs"])
            self.assertNotIn("archivito-sync-v3-outbox-v1",result["dbs"])
        finally:
            ctx.close()
