"""Regresión del editor y visor 3D en Firefox con IndexedDB real.

Se usan fotos sintéticas uniformes de colores contrastados; jamás cartas reales.
Verifica almacenamiento (SHA-256) y salida visual efectiva de cada cara.
"""
import base64
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import unittest
from playwright.sync_api import expect, sync_playwright
from test_browser import png_bytes
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
FRONT=png_bytes((231, 51, 54))
BACK=png_bytes((36, 88, 229))
NEW_FRONT=png_bytes((222, 182, 44))

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*_args):
        pass

class FirefoxEditorViewerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(
            ("127.0.0.1",0),partial(QuietHandler,directory=str(ROOT)))
        cls.thread=Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.url=f"http://127.0.0.1:{cls.server.server_port}/app/"
        cls.playwright=sync_playwright().start()
        cls.browser=cls.playwright.firefox.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.playwright.stop()
        cls.server.shutdown();cls.server.server_close()

    def setUp(self):
        self.context=self.browser.new_context()
        self.page=self.context.new_page()
        self.page.goto(self.url)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")

    def tearDown(self):
        self.context.close()

    def upload(self,index,data):
        self.page.locator('#page-entries input[type="file"]').nth(index).set_input_files(
            {"name":"foto-ficticia-"+str(index)+".png",
             "mimeType":"image/png","buffer":data})

    def create(self,with_back=False):
        self.page.locator("#add-record").click()
        self.page.locator("#rec-title").fill("Carta de colores ficticios")
        self.upload(0,FRONT)
        if with_back:self.upload(1,BACK)
        self.page.locator("#editor-save").click()
        expect(self.page.locator("#editor-wrap")).to_be_hidden()
        expect(self.page.locator("#stat-count")).to_have_text("1")

    def hashes(self):
        return self.page.evaluate("""async () => {
          const rows=await all();
          const p=rows[0].pages[0];
          const sha=async blob=>{
            if(!blob)return null;
            const h=new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()));
            return [...h].map(x=>x.toString(16).padStart(2,'0')).join('');
          };
          return {front:await sha(p.front),back:await sha(p.back),
                  frontSize:p.front?.size,backSize:p.back?.size};
        }""")

    def pixel_center_of_stage(self):
        png=self.page.locator("#stage").screenshot()
        return self.page.evaluate("""async (b64) => {
          const image=new Image();
          image.src='data:image/png;base64,'+b64;
          await image.decode();
          const canvas=document.createElement('canvas');
          canvas.width=image.width;canvas.height=image.height;
          const ctx=canvas.getContext('2d',{willReadFrequently:true});
          ctx.drawImage(image,0,0);
          return [...ctx.getImageData(Math.floor(canvas.width/2),
              Math.floor(canvas.height/2),1,1).data];
        }""",base64.b64encode(png).decode())

    def assertDistinctVisualFaces(self):
        expect(self.page.locator("#paper")).to_be_visible()
        self.page.locator("#show-front").click()
        front=self.pixel_center_of_stage()
        self.page.locator("#show-back").click()
        back=self.pixel_center_of_stage()
        # Fondo delantero: rojo puro; fondo trasero: azul. La iluminación CSS
        # puede oscurecer, pero nunca intercambiar los canales dominantes.
        self.assertGreater(front[0]-front[2],80, "Frente no visible: "+str(front))
        self.assertGreater(back[2]-back[0],80, "Reverso no visible: "+str(back))
        self.assertNotEqual(front,back)
        # Evita regresar a un filter en el padre que aplana preserve-3d.
        self.assertEqual(self.page.locator("#paper").evaluate(
            "el=>getComputedStyle(el).filter"),"none")
        self.assertEqual(self.page.locator("#paper").evaluate(
            "el=>getComputedStyle(el).transformStyle"),"preserve-3d")

    def test_editar_agregar_reverso_preserva_frente_y_muestra_ambas_caras(self):
        self.create(with_back=False)
        initial=self.hashes()
        self.assertEqual(initial["front"],hashlib.sha256(FRONT).hexdigest())
        self.assertIsNone(initial["back"])
        self.page.locator("#collection .tile").click()
        self.page.locator("#edit-record").click()
        expect(self.page.locator("#page-entries .filebox img").nth(0)).to_be_visible()
        expect(self.page.locator("#page-entries .filebox img").nth(1)).to_be_hidden()
        expect(self.page.locator("#page-entries .filebox .filename").nth(0)).to_contain_text("Foto guardada")
        self.upload(1,BACK)
        expect(self.page.locator("#page-entries .filebox img").nth(1)).to_be_visible()
        expect(self.page.locator("#page-entries .filebox .filename").nth(1)).to_contain_text("Foto guardada")
        self.page.locator("#editor-save").click()
        expect(self.page.locator("#editor-wrap")).to_be_hidden()
        self.page.reload()
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        after=self.hashes()
        self.assertEqual(after["front"],initial["front"])
        self.assertEqual(after["back"],hashlib.sha256(BACK).hexdigest())
        self.page.locator("#collection .tile").click()
        self.assertDistinctVisualFaces()

    def test_carga_directa_frente_reverso_distingue_imagenes(self):
        self.create(with_back=True)
        self.page.reload()
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        data=self.hashes()
        self.assertEqual(data["front"],hashlib.sha256(FRONT).hexdigest())
        self.assertEqual(data["back"],hashlib.sha256(BACK).hexdigest())
        self.page.locator("#collection .tile").click()
        self.assertDistinctVisualFaces()

    def test_cambiar_frente_desde_editor_sin_perder_reverso(self):
        self.create(with_back=True)
        before=self.hashes()
        self.page.locator("#collection .tile").click()
        self.page.locator("#edit-record").click()
        self.upload(0,NEW_FRONT)
        self.page.locator("#editor-save").click()
        expect(self.page.locator("#editor-wrap")).to_be_hidden()
        self.page.reload()
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        after=self.hashes()
        self.assertNotEqual(before["front"],after["front"])
        self.assertEqual(after["front"],hashlib.sha256(NEW_FRONT).hexdigest())
        self.assertEqual(after["back"],before["back"])

if __name__=="__main__":
    unittest.main()
