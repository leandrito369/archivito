"""Prueba funcional de digitalización en Chromium real con una imagen PNG ficticia."""
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import struct
from threading import Thread
import unittest
import zlib

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def sample_png():
    w, h, rgb = 240, 320, (108, 143, 172)
    pixels = b"".join(b"\0" + bytes(rgb) * w for _ in range(h))

    def chunk(kind, data):
        return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels))
            + chunk(b"IEND", b""))


class NoLogHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class DigitizerSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0),
                                       partial(NoLogHandler, directory=str(ROOT)))
        cls.thread = Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.http.server_port}/app/digitalizar.html"
        cls.engine = sync_playwright().start()
        cls.browser = cls.engine.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.engine.stop()
        cls.http.shutdown()
        cls.http.server_close()

    def test_digitaliza_sin_reemplazar_original_ni_crear_base(self):
        image = sample_png()
        context = self.browser.new_context(accept_downloads=True)
        try:
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(self.url)
            page.locator("#file").set_input_files({
                "name": "foto-ficticia.png", "mimeType": "image/png", "buffer": image
            })
            expect(page.locator("#process")).to_be_enabled()
            page.locator(".point").first.focus()
            page.keyboard.press("ArrowRight")
            expect(page.locator("#export")).to_be_disabled()
            page.locator("#process").click()
            expect(page.locator("#export")).to_be_enabled(timeout=20000)

            values = page.evaluate("""() => {
                const canvas = document.querySelector('#result');
                const center = canvas.getContext('2d').getImageData(
                    Math.floor(canvas.width/2), Math.floor(canvas.height/2),1,1).data;
                return {width:canvas.width,height:canvas.height,center:[...center]};
            }""")
            self.assertGreater(values["width"], 50)
            self.assertGreater(values["height"], 50)
            self.assertEqual(values["center"], [108, 143, 172, 255])

            # El File original del input no se mutó durante el recorte.
            digest = page.evaluate("""async () => {
                const f = document.querySelector('#file').files[0];
                const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()));
                return [...sha].map(x=>x.toString(16).padStart(2,'0')).join('');
            }""")
            self.assertEqual(digest, hashlib.sha256(image).hexdigest())
            # Esta etapa experimental sólo genera un PNG en memoria.
            dbs = page.evaluate("async()=>await indexedDB.databases()")
            self.assertFalse(dbs, "La digitalización aislada no debería crear bases de datos")

            with page.expect_download() as info:
                page.locator("#export").click()
            filename = info.value.suggested_filename
            data = Path(info.value.path()).read_bytes()
            self.assertEqual(filename, "foto-ficticia-digitalizada.png")
            self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertFalse(errors, "Errores JS: " + repr(errors))
        finally:
            context.close()


if __name__ == "__main__":
    unittest.main()
