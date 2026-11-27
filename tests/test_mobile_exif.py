"""Pruebas reales (Chromium y Firefox) de orientación EXIF móvil y formatos (0.4B).
Las imágenes JPEG/HEIC son sintéticas y locales; nunca se alteran bytes originales.
"""
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import struct
from threading import Thread
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC_HEIC = (
    b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic"
)


def inject_exif_orientation(jpeg_bytes, orientation):
    """Inserta un segmento APP1 EXIF con orientación 1..8 justo después de SOI."""
    if not jpeg_bytes.startswith(b"\xff\xd8"):
        raise ValueError("JPEG sintético inválido")
    exif = (
        b"Exif\x00\x00"
        + b"MM\x00\x2a"
        + struct.pack(">I", 8)
        + struct.pack(">H", 1)
        + struct.pack(">HHIHH", 0x0112, 3, 1, orientation, 0)
        + struct.pack(">I", 0)
    )
    app1 = b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif
    return b"\xff\xd8" + app1 + jpeg_bytes[2:]


class QuietHttp(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def make_bicolor_jpeg(page):
    """Genera un JPEG 24x12 (izquierda ROJA, derecha AZUL) usando el canvas del navegador."""
    raw = page.evaluate("""async () => {
      const c = document.createElement('canvas');
      c.width = 24; c.height = 12;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#e62020'; ctx.fillRect(0, 0, 12, 12);
      ctx.fillStyle = '#2040e6'; ctx.fillRect(12, 0, 12, 12);
      const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.98));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }""")
    return bytes(raw)


def sample_blob_pixels(page, blob_expr):
    """Decodifica un Blob en un canvas y muestrea 4 zonas para verificar orientación real."""
    return page.evaluate(f"""async () => {{
      const blob = await ({blob_expr});
      const res = await ArchivitoImageMobile.drawOrientedCanvas(blob, 512);
      const ctx = res.canvas.getContext('2d');
      const w = res.width, h = res.height;
      const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
      return {{
        width: w, height: h,
        top: px(Math.floor(w / 2), Math.floor(h * 0.2)),
        bottom: px(Math.floor(w / 2), Math.floor(h * 0.8)),
        left: px(Math.floor(w * 0.2), Math.floor(h / 2)),
        right: px(Math.floor(w * 0.8), Math.floor(h / 2))
      }};
    }}""")


def sample_canvas(page, selector):
    return page.evaluate("""(sel) => {
      const c = document.querySelector(sel);
      const ctx = c.getContext('2d');
      const w = c.width, h = c.height;
      const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
      return {
        width: w, height: h,
        top: px(Math.floor(w / 2), Math.floor(h * 0.2)),
        bottom: px(Math.floor(w / 2), Math.floor(h * 0.8)),
        left: px(Math.floor(w * 0.2), Math.floor(h / 2)),
        right: px(Math.floor(w * 0.8), Math.floor(h / 2))
      };
    }""", selector)


class MobileExifAndFormatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHttp, directory=str(ROOT)))
        cls.thread = Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.http.server_port}/app/"
        cls.playwright = sync_playwright().start()
        cls.engines = {
            "chromium": cls.playwright.chromium.launch(headless=True),
            "firefox": cls.playwright.firefox.launch(headless=True),
        }

    @classmethod
    def tearDownClass(cls):
        for browser in cls.engines.values():
            browser.close()
        cls.playwright.stop()
        cls.http.shutdown()
        cls.http.server_close()

    def assert_red(self, rgb):
        self.assertGreater(rgb[0], 150, f"Se esperaba rojo, llegó {rgb}")
        self.assertLess(rgb[2], 100, f"Se esperaba rojo, llegó {rgb}")

    def assert_blue(self, rgb):
        self.assertGreater(rgb[2], 150, f"Se esperaba azul, llegó {rgb}")
        self.assertLess(rgb[0], 100, f"Se esperaba azul, llegó {rgb}")

    def run_engine(self, browser):
        context = browser.new_context()
        try:
            page = context.new_page()
            dialogs = []
            page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
            page.goto(self.base)
            page.wait_for_function("typeof db !== 'undefined' && db !== null")

            base_jpeg = make_bicolor_jpeg(page)
            exif6_jpeg = inject_exif_orientation(base_jpeg, 6)
            exif3_jpeg = inject_exif_orientation(base_jpeg, 3)

            # 1a. HEIC disfrazado de .jpg debe mostrar el error inline dentro del modal abierto.
            page.locator("#add-record").click()
            page.locator("#rec-title").fill("Prueba HEIC rechazada")
            page.locator('#page-entries input[type="file"]').nth(0).set_input_files({
                "name": "heic-disfrazada.jpg",
                "mimeType": "image/jpeg",
                "buffer": SYNTHETIC_HEIC,
            })
            expect(page.locator("#page-entries .filename").nth(0)).to_contain_text(
                "HEIC/HEIF", timeout=10000
            )

            # 1b. HEIC/HEIF explícito rechazado de inmediato con alerta y mensaje claro.
            page.locator('#page-entries input[type="file"]').nth(0).set_input_files({
                "name": "IMG_1001.HEIC",
                "mimeType": "image/heic",
                "buffer": SYNTHETIC_HEIC,
            })
            self.assertTrue(any("HEIC/HEIF" in m and "JPEG, PNG o WebP" in m for m in dialogs))
            expect(page.locator("#message")).to_contain_text("HEIC/HEIF")
            expect(page.locator("#page-entries .filename").nth(0)).to_contain_text("HEIC/HEIF")

            # 2. Subir JPEG EXIF-6 con MIME vacío (típico selector móvil): se acepta por magic bytes,
            #    conserva bytes originales bit a bit y genera miniatura vertical (arriba ROJO, abajo AZUL).
            page.locator("#rec-title").fill("Carta EXIF 6 móvil")
            page.locator('#page-entries input[type="file"]').nth(0).set_input_files({
                "name": "IMG_EXIF6.JPG",
                "mimeType": "",
                "buffer": exif6_jpeg,
            })
            page.locator("#editor-save").click()
            expect(page.locator("#stat-count")).to_have_text("1")

            stored = page.evaluate("""async () => {
              const r = (await all())[0];
              const p = r.pages[0];
              const hash = async b => {
                const d = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
                return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
              };
              return { id: r.id, frontType: p.front.type, frontSha: await hash(p.front) };
            }""")
            self.assertEqual(stored["frontSha"], hashlib.sha256(exif6_jpeg).hexdigest())
            self.assertEqual(stored["frontType"], "image/jpeg")

            thumb_px = sample_blob_pixels(page, "(await all())[0].pages[0].thumb")
            self.assertGreater(thumb_px["height"], thumb_px["width"])
            self.assert_red(thumb_px["top"])
            self.assert_blue(thumb_px["bottom"])

            # 3. Digitalizar el frente EXIF-6: canvas y derivado deben ser verticales (arriba ROJO, abajo AZUL)
            #    sin alterar el SHA-256 del original.
            page.locator("#collection .tile").click()
            page.locator("#capture-front").click()
            expect(page.locator("#process")).to_be_enabled(timeout=15000)
            expect(page.locator("#status")).to_contain_text("EXIF")
            photo_px = sample_canvas(page, "#photo")
            self.assertGreater(photo_px["height"], photo_px["width"])
            self.assert_red(photo_px["top"])
            self.assert_blue(photo_px["bottom"])

            page.locator("#process").click()
            expect(page.locator("#save-archive")).to_be_enabled(timeout=20000)
            page.locator("#save-archive").click()
            expect(page.locator("#status")).to_contain_text("Digitalización vinculada", timeout=20000)

            page.goto(self.base)
            page.wait_for_function("typeof db !== 'undefined' && db !== null")
            after_dig = page.evaluate("""async () => {
              const p = (await all())[0].pages[0];
              const d = await crypto.subtle.digest('SHA-256', await p.front.arrayBuffer());
              return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
            }""")
            self.assertEqual(after_dig, hashlib.sha256(exif6_jpeg).hexdigest())
            derived_px = sample_blob_pixels(page, "(await all())[0].pages[0].frontDerived")
            self.assertGreater(derived_px["height"], derived_px["width"])
            self.assert_red(derived_px["top"])
            self.assert_blue(derived_px["bottom"])

            # 4. Digitalizador directo: rechaza HEIC disfrazado de .jpg y orienta correctamente EXIF-3 (180°).
            page.goto(self.base + "digitalizar.html")
            page.locator("#file").set_input_files({
                "name": "disfrazada.jpg",
                "mimeType": "image/jpeg",
                "buffer": SYNTHETIC_HEIC,
            })
            expect(page.locator("#status")).to_contain_text("HEIC/HEIF")
            expect(page.locator("#process")).to_be_disabled()

            page.locator("#file").set_input_files({
                "name": "exif3.jpg",
                "mimeType": "image/jpeg",
                "buffer": exif3_jpeg,
            })
            expect(page.locator("#process")).to_be_enabled(timeout=15000)
            photo3_px = sample_canvas(page, "#photo")
            self.assertGreater(photo3_px["width"], photo3_px["height"])
            # En EXIF-3 (180°), la mitad izquierda ROJA pasa a la derecha y la AZUL a la izquierda.
            self.assert_blue(photo3_px["left"])
            self.assert_red(photo3_px["right"])

            # 5. Visor 3D/2D: orientedSize sobre el original EXIF-6 entrega proporción vertical (12x24).
            page.goto(f"{self.base}visor-3d.html?recuerdo={stored['id']}&hoja=0&modo=2d")
            expect(page.locator("#title")).to_have_text("Carta EXIF 6 móvil")
            dims = page.evaluate("""async (id) => {
              const db = await new Promise((res, rej) => {
                const q = indexedDB.open('nuestro-archivo-cartas-v1', 1);
                q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
              });
              try {
                const rec = await new Promise((res, rej) => {
                  const r = db.transaction('letters', 'readonly').objectStore('letters').get(id);
                  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
                });
                return await ArchivitoImageMobile.orientedSize(rec.pages[0].front);
              } finally { db.close(); }
            }""", stored["id"])
            self.assertEqual(dims["orientation"], 6)
            self.assertGreater(dims["height"], dims["width"])
        finally:
            context.close()

    def test_chromium_exif_movil_y_heic(self):
        self.run_engine(self.engines["chromium"])

    def test_firefox_exif_movil_y_heic(self):
        self.run_engine(self.engines["firefox"])


if __name__ == "__main__":
    unittest.main()

