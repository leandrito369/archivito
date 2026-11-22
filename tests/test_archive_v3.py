"""Compatibilidad v1/v2/v3, original inmutable y guardado vinculado (Chromium + IDB)."""
import base64
import hashlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
import unittest
from playwright.sync_api import expect, sync_playwright
from test_digitalizacion import sample_png

ROOT=Path(__file__).resolve().parents[1]

class NoLog(SimpleHTTPRequestHandler):
    def log_message(self,*_args):
        pass

class ArchiveV3Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),partial(NoLog,directory=str(ROOT)))
        cls.thread=Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f"http://127.0.0.1:{cls.server.server_port}/app/"
        cls.playwright=sync_playwright().start()
        cls.browser=cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.playwright.stop()
        cls.server.shutdown();cls.server.server_close()

    def setUp(self):
        self.context=self.browser.new_context(accept_downloads=True)
        self.page=self.context.new_page()
        self.page.goto(self.base)
        self.page.wait_for_function("typeof db !== 'undefined' && db !== null")

    def tearDown(self):
        self.context.close()

    def test_guardar_digitalizacion_y_restaurar_ambas_imagenes(self):
        raw=sample_png()
        expected=hashlib.sha256(raw).hexdigest()
        # Crea una carta previa, para demostrar que no se modifica.
        self.page.locator("#add-record").click()
        self.page.locator("#rec-title").fill("Carta anterior")
        self.page.locator('#page-entries input[type="file"]').nth(0).set_input_files(
            {"name":"antes.png","mimeType":"image/png","buffer":raw})
        self.page.locator("#editor-save").click()
        expect(self.page.locator("#stat-count")).to_have_text("1")
        before=self.page.evaluate("""async () => {
           const rows=await all();
           return {id:rows[0].id,createdAt:rows[0].createdAt,blobSize:rows[0].pages[0].front.size};
        }""")

        self.page.goto(self.base+"digitalizar.html")
        self.page.locator("#file").set_input_files(
            {"name":"original-ficticio.png","mimeType":"image/png","buffer":raw})
        expect(self.page.locator("#process")).to_be_enabled()
        self.page.locator("#process").click()
        expect(self.page.locator("#save-archive")).to_be_enabled(timeout=20000)
        self.page.locator("#rec-title").fill("Carta digitalizada con origen")
        self.page.locator("#save-archive").click()
        expect(self.page.locator("#status")).to_contain_text("Carta guardada",timeout=20000)

        self.page.goto(self.base)
        self.page.wait_for_function("typeof db !== 'undefined' && db !== null")
        expect(self.page.locator("#stat-count")).to_have_text("2")
        proof=self.page.evaluate("""async () => {
           const rows=await all(),hex=async blob => {
             const d=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
             return [...new Uint8Array(d)].map(v=>v.toString(16).padStart(2,'0')).join('');
           };
           const old=rows.find(r=>r.title==='Carta anterior');
           const newer=rows.find(r=>r.title==='Carta digitalizada con origen');
           return {
             before:{id:old.id,createdAt:old.createdAt,blobSize:old.pages[0].front.size},
             original:await hex(newer.pages[0].front),
             derivative:await hex(newer.pages[0].frontDerived),
             originalSize:newer.pages[0].front.size,
             derivativeSize:newer.pages[0].frontDerived.size,
             crop:newer.pages[0].frontCrop,
             schema:newer.schemaVersion
           };
        }""")
        self.assertEqual(proof["before"],before)
        self.assertEqual(proof["original"],expected)
        self.assertEqual(proof["schema"],3)
        self.assertEqual(proof["crop"]["algorithm"],"homography-js-v1")
        self.assertEqual(len(proof["crop"]["points"]),4)
        self.assertGreater(proof["derivativeSize"],0)

        self.page.locator("#collection .tile",has_text="Carta digitalizada con origen").click()
        expect(self.page.locator("#view-source")).to_be_enabled()
        expect(self.page.locator("#view-source")).to_have_text("Ver fotos originales")
        self.page.locator("#view-source").click()
        expect(self.page.locator("#view-source")).to_have_text("Ver digitalización")

        self.page.locator("#viewer-close").click()
        with self.page.expect_download() as download:
            self.page.locator("#backup-export").click()
        backup=Path(download.value.path()).read_bytes()
        parsed=json.loads(backup)
        self.assertEqual(parsed["format"],"nuestro-archivo-v3")
        derived_pages=next(r for r in parsed["records"] if r["title"]=="Carta digitalizada con origen")["pages"]
        self.assertTrue(derived_pages[0]["frontDerived"])
        self.assertTrue(derived_pages[0]["front"])
        self.assertEqual(len(parsed["records"]),2)

        # Se restaura en un nuevo perfil/origen IDB vacío.
        restored_context=self.browser.new_context()
        try:
            page=restored_context.new_page()
            page.goto(self.base)
            page.wait_for_function("typeof db !== 'undefined' && db !== null")
            page.on("dialog",lambda d:d.accept())
            page.locator("#backup-file").set_input_files({
                "name":"archivito-v3-ficticio.json","mimeType":"application/json","buffer":backup})
            expect(page.locator("#stat-count")).to_have_text("2")
            again=page.evaluate("""async () => {
              const rows=await all(),r=rows.find(r=>r.title==='Carta digitalizada con origen');
              const digest=async blob=>{
                const d=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
                return [...new Uint8Array(d)].map(n=>n.toString(16).padStart(2,'0')).join('');
              };
              return {orig:await digest(r.pages[0].front),derived:await digest(r.pages[0].frontDerived)};
            }""")
            self.assertEqual(again["orig"],expected)
            self.assertEqual(again["derived"],proof["derivative"])
        finally:
            restored_context.close()

    def test_importacion_v2_compatible_y_fallo_atomico(self):
        original=sample_png()
        b64="data:image/png;base64,"+base64.b64encode(original).decode()
        record={"id":"v2-ficticio","title":"Legado versión 2","kind":"letter",
                "pages":[{"id":"p1","front":b64,"back":None}]}
        backup={"format":"nuestro-archivo-v2","version":2,"records":[record]}
        self.page.on("dialog",lambda d:d.accept())
        self.page.locator("#backup-file").set_input_files(
            {"name":"v2.json","mimeType":"application/json","buffer":json.dumps(backup).encode()})
        expect(self.page.locator("#stat-count")).to_have_text("1")
        item=self.page.evaluate("""async () => (await all())[0]""")
        self.assertEqual(item["schemaVersion"],3)
        self.assertIsNone(item["pages"][0]["frontDerived"])
        self.assertEqual(item["pages"][0]["front"]["size"],len(original))

        # Segundo respaldo contiene un válido seguido de otro inválido.
        # Ninguno de los dos debe llegar a persistir.
        bad={"format":"nuestro-archivo-v3","records":[
          {"id":"nuevo-valido","title":"No guardar","pages":[{"front":b64}]},
          {"id":"nuevo-invalido","title":"Falla","pages":[{"front":"not-an-image"}]}
        ]}
        self.page.locator("#backup-file").set_input_files(
            {"name":"corrupto.json","mimeType":"application/json","buffer":json.dumps(bad).encode()})
        expect(self.page.locator("#message")).to_contain_text("No se pudo importar")
        expect(self.page.locator("#stat-count")).to_have_text("1")
        self.page.reload()
        self.page.wait_for_function("typeof db !== 'undefined' && db !== null")
        expect(self.page.locator("#stat-count")).to_have_text("1")
        titles=self.page.evaluate("async () => (await all()).map(x=>x.title)")
        self.assertEqual(titles,["Legado versión 2"])

if __name__=="__main__":
    unittest.main()
