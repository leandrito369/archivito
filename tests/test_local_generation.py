"""Atomic local generation on real IndexedDB writes; synthetic data, no network."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest
from playwright.sync_api import sync_playwright
from test_browser import png_bytes

ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*_):
        pass

class LocalGenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),partial(Quiet,directory=str(ROOT)))
        Thread(target=cls.server.serve_forever,daemon=True).start()
        cls.url=f"http://127.0.0.1:{cls.server.server_port}/app/"
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()
        cls.server.shutdown();cls.server.server_close()

    def setUp(self):
        self.ctx=self.browser.new_context()
        self.page=self.ctx.new_page()
        self.page.goto(self.url)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")

    def tearDown(self):
        self.ctx.close()

    def test_local_writes_stamp_same_transaction_and_legacy_read_does_not_migrate(self):
        result=self.page.evaluate("""async ()=>{
          const old={id:'legacy',title:'Original',updatedAt:'same'};
          await tx('readwrite',s=>s.put(old));
          const legacy=(await all())[0];
          await put({...legacy,title:'Edited'});
          const first=(await all())[0];
          await put({...first,favorite:true});
          const second=(await all())[0];
          const stampWasNotMutated=first.syncGeneration!==second.syncGeneration;
          await atomicPut([{...second,title:'Imported',syncGeneration:first.syncGeneration}]);
          const third=(await all())[0];
          let failed=false;
          try{await atomicPut([{...third,title:'Must rollback'},{title:'No ID'}]);}catch{failed=true;}
          const after=(await all())[0];
          return {legacy:ArchivitoLocalGeneration.generation(legacy),first:first.syncGeneration,
            second:second.syncGeneration,third:third.syncGeneration,after:after.syncGeneration,
            title:after.title,failed,stampWasNotMutated};
        }""")
        self.assertIsNone(result["legacy"])
        self.assertEqual(len({result["first"],result["second"],result["third"]}),3)
        self.assertTrue(result["stampWasNotMutated"])
        self.assertTrue(result["failed"])
        self.assertEqual(result["after"],result["third"])
        self.assertEqual(result["title"],"Imported")

    def test_new_digitization_has_generation(self):
        self.page.goto(self.url+"digitalizar.html")
        self.page.locator("#file").set_input_files({"name":"ficticio.png","mimeType":"image/png","buffer":png_bytes((143,120,85))})
        self.page.locator("#process").click()
        self.page.locator("#save-archive").wait_for(state="visible")
        from playwright.sync_api import expect
        expect(self.page.locator("#save-archive")).to_be_enabled(timeout=20000)
        self.page.locator("#save-archive").click()
        expect(self.page.locator("#status")).to_contain_text("guardada",timeout=20000)
        self.page.goto(self.url)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        generation=self.page.evaluate("async ()=>(await all())[0].syncGeneration")
        self.assertRegex(generation,r"^[0-9a-f-]{36}$")
