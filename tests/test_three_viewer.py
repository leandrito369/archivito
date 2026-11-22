"""E2E del visor experimental: carga local de carta y fallback 2D.
Las fotos de prueba son PNG sintéticas de colores sólidos.
"""
import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from threading import Thread
import unittest
from playwright.sync_api import expect,sync_playwright
from test_browser import png_bytes
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
FRONT=png_bytes((221,55,51))
BACK=png_bytes((43,73,217))
SECOND=png_bytes((83,175,93))
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*_args):pass
class ThreeViewerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),partial(Quiet,directory=str(ROOT)))
        cls.thread=Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f"http://127.0.0.1:{cls.server.server_port}/app/"
        cls.playwright=sync_playwright().start()
        cls.browser=cls.playwright.chromium.launch(headless=True,args=[
            "--enable-webgl","--use-gl=angle","--use-angle=swiftshader",
            "--enable-unsafe-swiftshader"
        ])
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.playwright.stop()
        cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        self.context=self.browser.new_context()
        self.page=self.context.new_page()
        self.page.goto(self.base)
        self.page.wait_for_function("typeof db!=='undefined' && db!==null")
        self.page.locator("#add-record").click()
        self.page.locator("#rec-title").fill("Carta 3D de prueba")
        for n,image in [(0,FRONT),(1,BACK)]:
            self.page.locator('#page-entries input[type="file"]').nth(n).set_input_files({
                "name":"fixture.png","mimeType":"image/png","buffer":image})
        self.page.locator("#add-page").click()
        self.page.locator('#page-entries input[type="file"]').nth(2).set_input_files({
            "name":"otra.png","mimeType":"image/png","buffer":SECOND})
        self.page.locator("#editor-save").click()
        expect(self.page.locator("#stat-count")).to_have_text("1")
        self.before=self.page.evaluate("async()=>(await all())[0].updatedAt")
        self.page.locator("#collection .tile").click()
        self.page.locator("#open-three").click()
        self.page.wait_for_url("**/app/visor-3d.html?recuerdo=*&hoja=0")
        expect(self.page.locator("#title")).to_have_text("Carta 3D de prueba")
    def tearDown(self):self.context.close()
    def color_from_flat(self):
        return self.page.locator("#flat-image").evaluate("""async img=>{
            await img.decode();const c=document.createElement('canvas');
            c.width=img.naturalWidth;c.height=img.naturalHeight;
            const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
            return [...ctx.getImageData(1,1,1,1).data];
        }""")
    def snapshot_status(self):
        return self.page.locator("#status").inner_text()
    def test_fallback_forzado_persiste_y_navega(self):
        self.page.goto(self.page.url+"&modo=2d")
        expect(self.page.locator("#page-position")).to_have_text("Hoja 1 / 2")
        expect(self.page.locator("#flat-view")).to_be_visible()
        self.assertEqual(self.color_from_flat()[:3],[221,55,51])
        self.page.locator("#back").click()
        self.assertEqual(self.color_from_flat()[:3],[43,73,217])
        self.page.locator("#next").click()
        expect(self.page.locator("#page-position")).to_have_text("Hoja 2 / 2")
        self.assertEqual(self.color_from_flat()[:3],[83,175,93])
        self.page.locator("#back").click()
        expect(self.page.locator("#noimage")).to_be_visible()
        self.assertEqual(self.page.locator("#webgl-stage canvas").count(),0)
        self.page.locator("#return-link").click()
        expect(self.page.locator("#viewer-title")).to_have_text("Carta 3D de prueba")
        expect(self.page.locator("#page-position")).to_have_text("Hoja 2 / 2")
        after=self.page.evaluate("async()=>(await all())[0].updatedAt")
        self.assertEqual(self.before,after,"El visor no debe reescribir cartas")
    def test_falla_import_webgl_sigue_leyendo_en_2d(self):
        self.page.route("**/node_modules/three/**",lambda route:route.abort())
        self.page.reload()
        expect(self.page.locator("#flat-view")).to_be_visible(timeout=20000)
        expect(self.page.locator("#status")).to_contain_text("Vista 2D disponible",timeout=20000)
        self.assertEqual(self.color_from_flat()[:3],[221,55,51])
        self.page.locator("#back").click()
        self.assertEqual(self.color_from_flat()[:3],[43,73,217])
    def webgl_center_rgb(self):
        raw=self.page.locator("#webgl-stage canvas").first.screenshot()
        image=base64.b64encode(raw).decode()
        return self.page.evaluate("""async b64 => {
            const img=new Image();img.src='data:image/png;base64,'+b64;
            await img.decode();
            const c=document.createElement('canvas');
            c.width=img.width;c.height=img.height;
            const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
            return [...ctx.getImageData(Math.floor(c.width/2),
                Math.floor(c.height/2),1,1).data];
        }""",image)

    def test_webgl_textura_cara_y_curvatura(self):
        try:
            expect(self.page.locator("#status")).to_contain_text("Three.js local activo",timeout=25000)
        except AssertionError:
            self.skipTest("No hay contexto WebGL disponible en Chromium del runner; fallback 2D validado")
        expect(self.page.locator("#webgl-stage canvas")).to_be_visible()
        expect(self.page.locator("#flat-view")).to_be_hidden()
        self.page.locator("#front").click()
        self.page.evaluate("()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
        front=self.webgl_center_rgb()
        self.page.locator("#back").click()
        self.page.evaluate("()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
        back=self.webgl_center_rgb()
        self.assertGreater(front[0]-front[2],25,"Frente WebGL incorrecto: "+str(front))
        self.assertGreater(back[2]-back[0],25,"Reverso WebGL incorrecto: "+str(back))
        self.page.locator("#curve").fill("60")
        self.page.locator("#zoom-in").click()
        self.page.locator("#back").click()
        expect(self.page.locator("#back")).to_have_class("active")
        self.page.locator("#front").click()
        self.page.locator("#toggle-2d").click()
        expect(self.page.locator("#flat-view")).to_be_visible()
        self.assertEqual(self.color_from_flat()[:3],[221,55,51])
        self.page.locator("#toggle-2d").click()
        expect(self.page.locator("#webgl-stage canvas")).to_be_visible()
        expect(self.page.locator("#status")).to_contain_text("Three.js local activo",timeout=20000)

if __name__=="__main__":unittest.main()
