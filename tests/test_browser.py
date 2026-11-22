"""Pruebas E2E con IndexedDB REAL, sin mocks ni fotografías personales.

Ejecutar:
    pip install -r requirements-dev.txt
    python -m playwright install chromium
    python -m unittest discover -s tests -v
"""
import base64
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import struct
from threading import Thread
import unittest
import zlib

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FRONT_RGB = (93, 143, 196)
BACK_RGB = (219, 165, 118)
SECOND_RGB = (143, 174, 99)


def png_bytes(rgb):
    """Genera una imagen RGB PNG 3×4 inventada; no necesita fixtures privados."""
    w, h = 3, 4
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(kind, data):
        return (len(data).to_bytes(4, "big") + kind + data
                + zlib.crc32(kind + data).to_bytes(4, "big"))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def blob_hash_js():
    return """async () => {
      const rows = await all();
      async function hex(blob) {
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
      }
      return Promise.all(rows.map(async r => ({
        id: r.id, title: r.title, pages: await Promise.all(
          r.pages.map(async p => ({
            front: await hex(p.front),
            back: p.back ? await hex(p.back) : null
          }))
        )
      })));
    }"""


class BrowserIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT))
        )
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
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
        self.context = self.browser.new_context(accept_downloads=True)
        self.page = self.context.new_page()
        self.page.goto(self.url)
        self.page.wait_for_function(
            "typeof db !== 'undefined' && db !== null", timeout=15000
        )

    def tearDown(self):
        self.context.close()

    def upload(self, index, rgb):
        data = png_bytes(rgb)
        self.page.locator('#page-entries input[type="file"]').nth(
            index
        ).set_input_files(
            {"name": f"fixture-{index}.png", "mimeType": "image/png", "buffer": data}
        )
        return hashlib.sha256(data).hexdigest()

    def create_two_page_letter(self):
        self.page.locator("#add-record").click()
        self.page.locator("#rec-title").fill("Carta de prueba")
        self.page.locator("#rec-date").fill("2026-11-22")
        self.page.locator("#rec-tags").fill("historia, prueba")
        original_hashes = [self.upload(0, FRONT_RGB), self.upload(1, BACK_RGB)]
        self.page.locator("#add-page").click()
        original_hashes.append(self.upload(2, SECOND_RGB))
        self.page.locator("#editor-save").click()
        expect(self.page.locator("#stat-count")).to_have_text("1")
        return original_hashes

    def test_persistencia_visor_edicion_y_originales(self):
        hashes = self.create_two_page_letter()
        self.page.reload()
        self.page.wait_for_function("typeof db !== 'undefined' && db !== null")
        self.assertEqual(self.page.locator("#stat-count").inner_text(), "1")
        self.assertEqual(self.page.locator("#stat-pages").inner_text(), "2")

        data = self.page.evaluate(blob_hash_js())
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["pages"][0]["front"], hashes[0])
        self.assertEqual(data[0]["pages"][0]["back"], hashes[1])
        self.assertEqual(data[0]["pages"][1]["front"], hashes[2])

        self.page.locator("#collection .tile").click()
        self.assertEqual(self.page.locator("#page-position").inner_text(), "Hoja 1 / 2")
        self.page.locator("#show-back").click()
        self.assertIn("rotateY(180deg)", self.page.locator("#paper").get_attribute("style"))
        self.page.locator("#next-page").click()
        self.assertEqual(self.page.locator("#page-position").inner_text(), "Hoja 2 / 2")
        self.page.locator("#viewer-fav").click()
        self.page.locator("#edit-record").click()
        self.page.locator("#rec-title").fill("Carta editada")
        self.page.locator("#editor-save").click()
        expect(self.page.locator("#stat-count")).to_have_text("1")
        self.page.reload()
        self.page.wait_for_function("typeof db !== 'undefined' && db !== null")
        data = self.page.evaluate(blob_hash_js())
        self.assertEqual(data[0]["title"], "Carta editada")
        self.assertEqual(data[0]["pages"][0]["front"], hashes[0])
        self.assertEqual(data[0]["pages"][0]["back"], hashes[1])
        self.assertEqual(data[0]["pages"][1]["front"], hashes[2])
        self.assertEqual(self.page.locator("#stat-favorites").inner_text(), "1")
        self.page.locator("#search").fill("historia")
        self.assertEqual(self.page.locator("#collection .tile").count(), 1)
        self.page.locator('[data-view="timeline"]').click()
        self.assertIn("2026", self.page.locator("#timeline").inner_text())

    def test_exportacion_importacion_v2_con_bytes_identicos(self):
        hashes = self.create_two_page_letter()
        with self.page.expect_download() as download_info:
            self.page.locator("#backup-export").click()
        backup = Path(download_info.value.path()).read_bytes()
        parsed = json.loads(backup)
        self.assertEqual(parsed["format"], "nuestro-archivo-v2")
        self.assertEqual(len(parsed["records"][0]["pages"]), 2)

        # Contexto nuevo: la IndexedDB inicial está vacía.
        context2 = self.browser.new_context()
        try:
            restored = context2.new_page()
            restored.goto(self.url)
            restored.wait_for_function("typeof db !== 'undefined' && db !== null")
            self.assertEqual(restored.locator("#stat-count").inner_text(), "0")
            restored.on("dialog", lambda dialog: dialog.accept())
            restored.locator("#backup-file").set_input_files({
                "name": "respaldo-ficticio.json",
                "mimeType": "application/json",
                "buffer": backup
            })
            expect(restored.locator("#stat-count")).to_have_text("1")
            saved = restored.evaluate(blob_hash_js())
            self.assertEqual(saved[0]["pages"][0]["front"], hashes[0])
            self.assertEqual(saved[0]["pages"][0]["back"], hashes[1])
            self.assertEqual(saved[0]["pages"][1]["front"], hashes[2])
        finally:
            context2.close()

    def test_importacion_respaldo_v1(self):
        image_bytes = png_bytes(FRONT_RGB)
        legacy = {
            "format": "nuestro-archivo-v1",
            "letters": [{
                "id": "legacy-ficticio-1",
                "title": "Carta heredada ficticia",
                "date": "2025-07-04",
                "front": "data:image/png;base64," + base64.b64encode(image_bytes).decode(),
                "back": None
            }]
        }
        self.page.on("dialog", lambda dialog: dialog.accept())
        self.page.locator("#backup-file").set_input_files({
            "name": "v1-sintetico.json",
            "mimeType": "application/json",
            "buffer": json.dumps(legacy).encode()
        })
        expect(self.page.locator("#stat-count")).to_have_text("1")
        records = self.page.evaluate(blob_hash_js())
        self.assertEqual(records[0]["pages"][0]["front"], hashlib.sha256(image_bytes).hexdigest())
        self.page.reload()
        self.page.wait_for_function("typeof db !== 'undefined' && db !== null")
        self.assertEqual(self.page.locator("#stat-count").inner_text(), "1")


if __name__ == "__main__":
    unittest.main()
