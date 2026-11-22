"""Pruebas con IndexedDB real de captura de frente/reverso de cartas existentes.

Las imágenes son PNG sintéticas generadas localmente. No se utilizan cartas personales.
"""
import hashlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
import unittest
from playwright.sync_api import expect, sync_playwright
from test_browser import png_bytes

ROOT=Path(__file__).resolve().parents[1]

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*_args):
        pass

HASHES=(
    png_bytes((143,120,85)),png_bytes((87,114,170)),
    png_bytes((193,148,102)),png_bytes((77,165,135))
)

class ExistingPagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=ThreadingHTTPServer(("127.0.0.1",0),
            partial(QuietHandler,directory=str(ROOT)))
        cls.thread=Thread(target=cls.http.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f"http://127.0.0.1:{cls.http.server_port}/app/"
        cls.playwright=sync_playwright().start()
        cls.browser=cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.playwright.stop()
        cls.http.shutdown();cls.http.server_close()

    def setUp(self):
        self.context=self.browser.new_context(accept_downloads=True)
        self.page=self.context.new_page()
        self.page.goto(self.base)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")

    def tearDown(self):
        self.context.close()

    def add_letter(self, include_back=False, two_pages=False):
        page=self.page
        page.locator("#add-record").click()
        page.locator("#rec-title").fill("Carta archivada")
        page.locator("#rec-note").fill("Contenido ficticio que no debe cambiar")
        page.locator('#page-entries input[type="file"]').nth(0).set_input_files({
            "name":"frente1.png","mimeType":"image/png","buffer":HASHES[0]})
        if include_back:
            page.locator('#page-entries input[type="file"]').nth(1).set_input_files({
                "name":"reverso1.png","mimeType":"image/png","buffer":HASHES[1]})
        if two_pages:
            page.locator("#add-page").click()
            page.locator('#page-entries input[type="file"]').nth(2).set_input_files({
                "name":"frente2.png","mimeType":"image/png","buffer":HASHES[2]})
            if include_back:
                page.locator('#page-entries input[type="file"]').nth(3).set_input_files({
                    "name":"reverso2.png","mimeType":"image/png","buffer":HASHES[3]})
        page.locator("#editor-save").click()
        expect(page.locator("#stat-count")).to_have_text("1")

    @staticmethod
    def extract_record(page):
        return page.evaluate("""async () => {
          const r=(await all())[0];
          const sha=async blob => {
            if(!blob)return null;
            const d=new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()));
            return [...d].map(n=>n.toString(16).padStart(2,'0')).join('');
          };
          return {
            id:r.id,title:r.title,note:r.note,updatedAt:r.updatedAt,
            pages:await Promise.all(r.pages.map(async p=>({
              id:p.id,
              front:await sha(p.front),back:await sha(p.back),
              frontDerived:await sha(p.frontDerived),backDerived:await sha(p.backDerived),
              frontCrop:p.frontCrop||null,backCrop:p.backCrop||null
            })))
          };
        }""")

    def test_digitalizar_reverso_segunda_hoja_y_restaurar_v3(self):
        self.add_letter(include_back=True,two_pages=True)
        before=self.extract_record(self.page)
        self.page.locator("#collection .tile").click()
        self.page.locator("#next-page").click()
        expect(self.page.locator("#page-position")).to_have_text("Hoja 2 / 2")
        self.page.locator("#capture-back").click()
        expect(self.page.locator("#capture-target-info")).to_contain_text("hoja 2/2 · reverso")
        expect(self.page.locator("#file")).to_be_hidden()
        expect(self.page.locator("#process")).to_be_enabled(timeout=10000)
        self.page.locator("#process").click()
        expect(self.page.locator("#save-archive")).to_be_enabled(timeout=20000)
        self.page.locator("#save-archive").click()
        expect(self.page.locator("#status")).to_contain_text("Digitalización vinculada",timeout=20000)

        self.page.goto(self.base)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        expect(self.page.locator("#stat-count")).to_have_text("1")
        after=self.extract_record(self.page)
        self.assertEqual(after["id"],before["id"])
        self.assertEqual(after["title"],before["title"])
        self.assertEqual(after["note"],before["note"])
        self.assertEqual(after["pages"][0],before["pages"][0])
        self.assertEqual(after["pages"][1]["front"],before["pages"][1]["front"])
        self.assertEqual(after["pages"][1]["back"],before["pages"][1]["back"])
        self.assertIsNone(after["pages"][1]["frontDerived"])
        self.assertIsNotNone(after["pages"][1]["backDerived"])
        self.assertEqual(after["pages"][1]["backCrop"]["algorithm"],"homography-js-v1")
        self.assertEqual(len(after["pages"][1]["backCrop"]["points"]),4)

        self.page.locator("#collection .tile").click()
        self.page.locator("#next-page").click()
        expect(self.page.locator("#view-source")).to_be_enabled()
        self.page.locator("#view-source").click()
        expect(self.page.locator("#view-source")).to_have_text("Ver digitalización")
        self.page.locator("#viewer-close").click()
        with self.page.expect_download() as backup_job:
            self.page.locator("#backup-export").click()
        backup=Path(backup_job.value.path()).read_bytes()
        data=json.loads(backup)
        self.assertEqual(data["format"],"nuestro-archivo-v3")
        self.assertTrue(data["records"][0]["pages"][1]["backDerived"])
        self.assertTrue(data["records"][0]["pages"][1]["back"])

        new_context=self.browser.new_context()
        try:
            restored=new_context.new_page()
            restored.goto(self.base)
            restored.wait_for_function("typeof db!=='undefined' && db!==null")
            restored.on("dialog",lambda d:d.accept())
            restored.locator("#backup-file").set_input_files({
                "name":"respaldo-sintetico-v3.json","mimeType":"application/json","buffer":backup})
            expect(restored.locator("#stat-count")).to_have_text("1")
            recovered=self.extract_record(restored)
            self.assertEqual(recovered["pages"],after["pages"])
            self.assertEqual(recovered["note"],after["note"])
        finally:
            new_context.close()

    def test_agregar_reverso_faltante_sin_reemplazar_frente(self):
        self.add_letter(include_back=False)
        initial=self.extract_record(self.page)
        self.page.locator("#collection .tile").click()
        self.page.locator("#capture-back").click()
        expect(self.page.locator("#capture-target-info")).to_contain_text("hoja 1/1 · reverso")
        expect(self.page.locator("#file")).to_be_visible()
        expect(self.page.locator("#process")).to_be_disabled()
        self.page.locator("#file").set_input_files({
            "name":"nuevo-reverso.png","mimeType":"image/png","buffer":HASHES[1]})
        expect(self.page.locator("#process")).to_be_enabled()
        self.page.locator("#process").click()
        expect(self.page.locator("#save-archive")).to_be_enabled(timeout=20000)
        self.page.locator("#save-archive").click()
        expect(self.page.locator("#status")).to_contain_text("Digitalización vinculada",timeout=20000)

        self.page.goto(self.base)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        current=self.extract_record(self.page)
        self.assertEqual(current["id"],initial["id"])
        self.assertEqual(current["pages"][0]["front"],initial["pages"][0]["front"])
        self.assertEqual(current["pages"][0]["back"],hashlib.sha256(HASHES[1]).hexdigest())
        self.assertIsNotNone(current["pages"][0]["backDerived"])

        # Un reverso registrado se reutiliza al redigitalizar, no se reemplaza.
        self.page.locator("#collection .tile").click()
        self.page.locator("#capture-back").click()
        expect(self.page.locator("#file")).to_be_hidden()
        expect(self.page.locator("#process")).to_be_enabled()
        self.page.locator("#process").click()
        expect(self.page.locator("#save-archive")).to_be_enabled(timeout=20000)
        self.page.locator("#save-archive").click()
        expect(self.page.locator("#status")).to_contain_text("Digitalización vinculada",timeout=20000)
        self.page.goto(self.base)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        latest=self.extract_record(self.page)
        self.assertEqual(latest["pages"][0]["back"],current["pages"][0]["back"])

    def test_reprocesar_frente_sin_modificar_original_ni_reverso(self):
        self.add_letter(include_back=True)
        before=self.extract_record(self.page)
        self.page.locator("#collection .tile").click()
        self.page.locator("#capture-front").click()
        expect(self.page.locator("#capture-target-info")).to_contain_text("hoja 1/1 · frente")
        expect(self.page.locator("#file")).to_be_hidden()
        self.page.locator("#process").click()
        expect(self.page.locator("#save-archive")).to_be_enabled(timeout=20000)
        self.page.locator("#save-archive").click()
        expect(self.page.locator("#status")).to_contain_text("Digitalización vinculada",timeout=20000)
        self.page.goto(self.base)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        after=self.extract_record(self.page)
        self.assertEqual(after["id"],before["id"])
        self.assertEqual(after["note"],before["note"])
        self.assertEqual(after["pages"][0]["front"],before["pages"][0]["front"])
        self.assertEqual(after["pages"][0]["back"],before["pages"][0]["back"])
        self.assertIsNotNone(after["pages"][0]["frontDerived"])
        self.assertIsNone(after["pages"][0]["backDerived"])
        self.assertEqual(after["pages"][0]["frontCrop"]["algorithm"],"homography-js-v1")

    def test_frente_existente_y_conflicto_con_otra_pestana(self):
        self.add_letter(include_back=True)
        before=self.extract_record(self.page)
        self.page.locator("#collection .tile").click()
        self.page.locator("#capture-front").click()
        expect(self.page.locator("#capture-target-info")).to_contain_text("hoja 1/1 · frente")
        expect(self.page.locator("#file")).to_be_hidden()
        expect(self.page.locator("#process")).to_be_enabled()
        self.page.locator("#process").click()
        expect(self.page.locator("#save-archive")).to_be_enabled(timeout=20000)
        # Simula otro editor actualizando el mismo recuerdo.
        other=self.context.new_page()
        other.goto(self.base)
        other.wait_for_function("typeof db!=='undefined' && db!==null")
        other.evaluate("""async()=>{const r=(await all())[0];r.note='Editada en otra pestaña';
          r.updatedAt=new Date(Date.now()+60000).toISOString();await put(r);}""")
        other.close()
        self.page.locator("#save-archive").click()
        expect(self.page.locator("#status")).to_contain_text(
            "Esta carta cambió en otra pestaña",timeout=20000)
        self.page.goto(self.base)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        after=self.extract_record(self.page)
        self.assertEqual(after["pages"],before["pages"])
        self.assertEqual(after["note"],"Editada en otra pestaña")


if __name__=="__main__":
    unittest.main()
