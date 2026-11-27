"""Pruebas reales de backup cifrado v4 en Chromium y Firefox con fotos ficticias.
El contenido sólo se procesa en localhost e IndexedDB aislado por contexto.
"""
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
import unittest

from playwright.sync_api import expect, sync_playwright
from test_browser import png_bytes

ROOT=Path(__file__).resolve().parents[1]
PHOTO_1=png_bytes((208,113,86))
PHOTO_BACK=png_bytes((60,151,183))
PHOTO_2=png_bytes((110,177,73))
PASSPHRASE="frase-super-segura-para-pruebas-Archivito-2026"


def sha_snapshot(page):
    return page.evaluate("""async () => {
       const rows=await all();
       const hash=async b=>{
         if(!b)return null;
         const h=await crypto.subtle.digest('SHA-256',await b.arrayBuffer());
         return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('');
       };
       return await Promise.all(rows.map(async r=>({
         id:r.id,title:r.title,note:r.note,
         syncGeneration:ArchivitoLocalGeneration.generation(r),
         pages:await Promise.all(r.pages.map(async p=>({
           front:await hash(p.front),back:await hash(p.back),
           frontDerived:await hash(p.frontDerived),
           backDerived:await hash(p.backDerived)
         })))
       })));
    }""")


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*_args):
        pass


class BackupEncryptedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=ThreadingHTTPServer(("127.0.0.1",0),
                                     partial(Quiet,directory=str(ROOT)))
        cls.thread=Thread(target=cls.http.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f"http://127.0.0.1:{cls.http.server_port}/app/"
        cls.playwright=sync_playwright().start()
        cls.engines={
          "chromium":cls.playwright.chromium.launch(headless=True),
          "firefox":cls.playwright.firefox.launch(headless=True)
        }

    @classmethod
    def tearDownClass(cls):
        for browser in cls.engines.values():browser.close()
        cls.playwright.stop()
        cls.http.shutdown();cls.http.server_close()

    def upload(self,page,i,bytes_):
        page.locator('#page-entries input[type="file"]').nth(i).set_input_files({
          "name":f"fixture-{i}.png","mimeType":"image/png","buffer":bytes_
        })

    def run_browser(self, browser):
        original=browser.new_context(accept_downloads=True)
        restored=browser.new_context(accept_downloads=True)
        try:
            page=original.new_page()
            page.goto(self.base)
            page.wait_for_function("typeof db!=='undefined' && db!==null")
            page.locator("#add-record").click()
            page.locator("#rec-title").fill("Carta privada FICTICIA para cifrar")
            page.locator("#rec-note").fill("Una nota sólo para pruebas, no pública.")
            self.upload(page,0,PHOTO_1)
            self.upload(page,1,PHOTO_BACK)
            page.locator("#add-page").click()
            self.upload(page,2,PHOTO_2)
            page.locator("#editor-save").click()
            expect(page.locator("#stat-count")).to_have_text("1")
            page.locator("#collection .tile").click()
            page.locator("#capture-front").click()
            expect(page.locator("#process")).to_be_enabled()
            page.locator("#process").click()
            expect(page.locator("#save-archive")).to_be_enabled(timeout=20000)
            page.locator("#save-archive").click()
            expect(page.locator("#status")).to_contain_text("Digitalización vinculada",timeout=20000)
            page.goto(self.base)
            page.wait_for_function("typeof db!=='undefined' && db!==null")
            before=sha_snapshot(page)
            self.assertEqual(len(before),1)
            self.assertEqual(before[0]["pages"][0]["front"],
                             hashlib.sha256(PHOTO_1).hexdigest())
            self.assertEqual(before[0]["pages"][0]["back"],
                             hashlib.sha256(PHOTO_BACK).hexdigest())
            self.assertIsNotNone(before[0]["pages"][0]["frontDerived"])

            page.goto(self.base+"respaldo-v4.html")
            page.locator("#export-password").fill(PASSPHRASE)
            page.locator("#export-confirm").fill(PASSPHRASE)
            with page.expect_download(timeout=60000) as received:
                page.locator("#export-button").click()
            backup=Path(received.value.path()).read_bytes()
            data=json.loads(backup)
            self.assertEqual(data["format"],"archivito-backup-encrypted-v4")
            self.assertEqual(data["version"],4)
            self.assertEqual(data["iterations"],600000)
            self.assertNotIn(b"Carta privada",backup)
            self.assertNotIn(b"data:image",backup)
            self.assertNotIn(PASSPHRASE.encode(),backup)
            self.assertGreater(len(data["ciphertext"]),40)
            expect(page.locator("#export-password")).to_have_value("")
            expect(page.locator("#export-confirm")).to_have_value("")
            expect(page.locator("#diag-last-export")).to_contain_text("hace 0 días")
            expect(page.locator("#diag-collection")).to_contain_text("1 recuerdos · 2 hojas")

            # Perfil limpio: contraseña errónea no debe añadir nada.
            second=restored.new_page()
            second.goto(self.base+"respaldo-v4.html")
            second.locator("#backup-file").set_input_files({
                "name":"ficticio-cifrado.archivito","mimeType":"application/json",
                "buffer":backup
            })
            second.locator("#import-password").fill("frase-correcta-NO-es-esta")
            second.locator("#import-button").click()
            expect(second.locator("#status")).to_contain_text(
                "Contraseña incorrecta o respaldo modificado",timeout=60000)
            expect(second.locator("#import-password")).to_have_value("")
            self.assertEqual(
                second.evaluate("""async()=>{
                  if(typeof indexedDB.databases==='function'){
                    const dbs=await indexedDB.databases();
                    if(!dbs.some(d=>d.name==='nuestro-archivo-cartas-v1'))return 0;
                  }
                  const q=indexedDB.open('nuestro-archivo-cartas-v1',1);
                  return new Promise((res,rej)=>{
                    q.onupgradeneeded=()=>{
                      if(!q.result.objectStoreNames.contains('letters'))
                        q.result.createObjectStore('letters',{keyPath:'id'});
                    };
                    q.onsuccess=()=>{
                      try{
                        const db=q.result;
                        const tx=db.transaction('letters','readonly');
                        const x=tx.objectStore('letters').count();
                        x.onsuccess=()=>{res(x.result);db.close();};
                        x.onerror=()=>{db.close();rej(x.error);};
                      }catch(err){q.result?.close();rej(err);}
                    };
                    q.onerror=()=>rej(q.error);
                    q.onblocked=()=>rej(Error('IndexedDB blocked'));
                  });
                }"""),0)

            # Cualquier cambio al ciphertext autentificado debe ser rechazado.
            tampered=dict(data)
            last=tampered["ciphertext"][-10]
            tampered["ciphertext"]=(
                tampered["ciphertext"][:-10]+("A" if last!="A" else "B")+
                tampered["ciphertext"][-9:]
            )
            second.locator("#backup-file").set_input_files({
                "name":"alterado.archivito","mimeType":"application/json",
                "buffer":json.dumps(tampered).encode()
            })
            second.locator("#import-password").fill(PASSPHRASE)
            second.locator("#import-button").click()
            expect(second.locator("#status")).to_contain_text(
                "Contraseña incorrecta o respaldo modificado",timeout=60000)

            # El mismo respaldo legítimo sí restaura todos los originales y derivados.
            second.locator("#backup-file").set_input_files({
                "name":"original-cifrado.archivito","mimeType":"application/json",
                "buffer":backup
            })
            second.locator("#import-password").fill(PASSPHRASE)
            second.locator("#import-button").click()
            expect(second.locator("#status")).to_contain_text(
                "Restauración v4 exitosa: 1 recuerdos",timeout=60000)
            second.goto(self.base)
            second.wait_for_function("typeof db!=='undefined' && db!==null")
            after=sha_snapshot(second)
            self.assertEqual(len(after),1)
            self.assertEqual(before[0]["pages"],after[0]["pages"])
            self.assertEqual(before[0]["title"],after[0]["title"])
            self.assertEqual(before[0]["note"],after[0]["note"])
            gen_before=before[0]["syncGeneration"]
            gen_restored=after[0]["syncGeneration"]
            self.assertRegex(gen_before,r"^[0-9a-f-]{36}$")
            self.assertRegex(gen_restored,r"^[0-9a-f-]{36}$")
            self.assertNotEqual(gen_before,gen_restored)
            self.assertNotIn(gen_before.encode(),backup)

            # Reimportar mismo ID debe fallar atómicamente sin sobrescribir.
            second.goto(self.base+"respaldo-v4.html")
            second.locator("#backup-file").set_input_files({
                "name":"duplicado.archivito","mimeType":"application/json",
                "buffer":backup
            })
            second.locator("#import-password").fill(PASSPHRASE)
            second.locator("#import-button").click()
            expect(second.locator("#status")).to_have_class("status error",timeout=60000)
            second.goto(self.base)
            second.wait_for_function("typeof db!=='undefined' && db!==null")
            again=sha_snapshot(second)
            self.assertEqual(again,after)

            # Interoperabilidad backup v4 <-> generaciones locales: editar y re-digitalizar
            # un recuerdo restaurado debe avanzar syncGeneration sin alterar originales.
            second.locator("#collection .tile").click()
            second.locator("#edit-record").click()
            second.locator("#rec-note").fill("Nota actualizada tras restauración v4.")
            second.locator("#editor-save").click()
            expect(second.locator("#editor-wrap")).to_have_class("dialogback hidden")
            edited=sha_snapshot(second)
            gen_edited=edited[0]["syncGeneration"]
            self.assertRegex(gen_edited,r"^[0-9a-f-]{36}$")
            self.assertNotEqual(gen_edited,gen_restored)
            self.assertEqual(edited[0]["pages"][0]["front"],before[0]["pages"][0]["front"])

            second.locator("#collection .tile").click()
            second.locator("#capture-front").click()
            expect(second.locator("#process")).to_be_enabled()
            second.locator("#process").click()
            expect(second.locator("#save-archive")).to_be_enabled(timeout=20000)
            second.locator("#save-archive").click()
            expect(second.locator("#status")).to_contain_text("Digitalización vinculada",timeout=20000)
            second.goto(self.base)
            second.wait_for_function("typeof db!=='undefined' && db!==null")
            redigitized=sha_snapshot(second)
            gen_redigitized=redigitized[0]["syncGeneration"]
            self.assertRegex(gen_redigitized,r"^[0-9a-f-]{36}$")
            self.assertNotEqual(gen_redigitized,gen_edited)
            self.assertEqual(redigitized[0]["pages"][0]["front"],before[0]["pages"][0]["front"])
            self.assertEqual(redigitized[0]["pages"][0]["back"],before[0]["pages"][0]["back"])
            self.assertIsNotNone(redigitized[0]["pages"][0]["frontDerived"])

            # 0.4A.2: generar un segundo respaldo con 1 recuerdo en conflicto y 1 recuerdo nuevo.
            page.goto(self.base)
            page.wait_for_function("typeof db!=='undefined' && db!==null")
            expect(page.locator("#storage-summary")).to_contain_text("Último v4:")
            page.locator("#add-record").click()
            page.locator("#rec-title").fill("Segunda carta FICTICIA nueva")
            page.locator("#rec-note").fill("Recuerdo adicional para probar conflictos.")
            self.upload(page,0,PHOTO_2)
            page.locator("#editor-save").click()
            expect(page.locator("#stat-count")).to_have_text("2")
            page.goto(self.base+"respaldo-v4.html")
            page.locator("#export-password").fill(PASSPHRASE)
            page.locator("#export-confirm").fill(PASSPHRASE)
            with page.expect_download(timeout=60000) as received_two:
                page.locator("#export-button").click()
            backup_two=Path(received_two.value.path()).read_bytes()

            # Vista previa sin escrituras: debe informar 1 nuevo y 1 conflicto por ID.
            second.goto(self.base+"respaldo-v4.html")
            second.locator("#backup-file").set_input_files({
                "name":"dos-recuerdos.archivito","mimeType":"application/json",
                "buffer":backup_two
            })
            second.locator("#import-password").fill(PASSPHRASE)
            second.locator("#preview-button").click()
            expect(second.locator("#import-preview")).to_be_visible(timeout=60000)
            expect(second.locator("#preview-summary")).to_contain_text(
                "Nuevos: 1 · Conflictos por ID: 1")
            expect(second.locator("#preview-conflicts")).to_contain_text(
                "Carta privada FICTICIA para cifrar")
            second.goto(self.base)
            second.wait_for_function("typeof db!=='undefined' && db!==null")
            self.assertEqual(sha_snapshot(second),redigitized)

            # Política skip: importa sólo el recuerdo nuevo y preserva el local editado.
            second.goto(self.base+"respaldo-v4.html")
            second.locator("#backup-file").set_input_files({
                "name":"dos-recuerdos.archivito","mimeType":"application/json",
                "buffer":backup_two
            })
            second.locator("#import-password").fill(PASSPHRASE)
            second.locator("#conflict-policy").select_option("skip")
            second.locator("#import-button").click()
            expect(second.locator("#status")).to_contain_text(
                "Restauración v4 exitosa: 1 recuerdos nuevos (1 omitidos)",timeout=60000)
            second.goto(self.base)
            second.wait_for_function("typeof db!=='undefined' && db!==null")
            after_skip=sha_snapshot(second)
            self.assertEqual(len(after_skip),2)
            by_id={r["id"]:r for r in after_skip}
            orig_id=before[0]["id"]
            self.assertEqual(by_id[orig_id]["note"],"Nota actualizada tras restauración v4.")
            self.assertEqual(by_id[orig_id]["syncGeneration"],gen_redigitized)
            new_rec=[r for r in after_skip if r["id"]!=orig_id][0]
            self.assertEqual(new_rec["title"],"Segunda carta FICTICIA nueva")
            self.assertEqual(new_rec["pages"][0]["front"],
                             hashlib.sha256(PHOTO_2).hexdigest())

            # Política duplicate: conserva original intacto y crea copia con nuevo ID y originales iguales.
            second.goto(self.base+"respaldo-v4.html")
            second.locator("#backup-file").set_input_files({
                "name":"copia-conflicto.archivito","mimeType":"application/json",
                "buffer":backup
            })
            second.locator("#import-password").fill(PASSPHRASE)
            second.locator("#conflict-policy").select_option("duplicate")
            second.locator("#import-button").click()
            expect(second.locator("#status")).to_contain_text(
                "Restauración v4 exitosa: 0 recuerdos nuevos (1 copias nuevas)",timeout=60000)
            second.goto(self.base)
            second.wait_for_function("typeof db!=='undefined' && db!==null")
            after_dup=sha_snapshot(second)
            self.assertEqual(len(after_dup),3)
            dup_by_id={r["id"]:r for r in after_dup}
            self.assertEqual(dup_by_id[orig_id]["note"],"Nota actualizada tras restauración v4.")
            self.assertEqual(dup_by_id[orig_id]["syncGeneration"],gen_redigitized)
            copies=[r for r in after_dup if r["title"].endswith("(copia)")]
            self.assertEqual(len(copies),1)
            self.assertNotEqual(copies[0]["id"],orig_id)
            self.assertRegex(copies[0]["syncGeneration"],r"^[0-9a-f-]{36}$")
            self.assertEqual(copies[0]["pages"],before[0]["pages"])

            # Política replace: reemplaza explícitamente el existente y avanza syncGeneration.
            second.goto(self.base+"respaldo-v4.html")
            second.locator("#backup-file").set_input_files({
                "name":"reemplazo-conflicto.archivito","mimeType":"application/json",
                "buffer":backup
            })
            second.locator("#import-password").fill(PASSPHRASE)
            second.locator("#conflict-policy").select_option("replace")
            second.locator("#import-button").click()
            expect(second.locator("#status")).to_contain_text(
                "Restauración v4 exitosa: 0 recuerdos nuevos (1 reemplazados)",timeout=60000)
            second.goto(self.base)
            second.wait_for_function("typeof db!=='undefined' && db!==null")
            after_replace=sha_snapshot(second)
            self.assertEqual(len(after_replace),3)
            rep_orig={r["id"]:r for r in after_replace}[orig_id]
            self.assertEqual(rep_orig["note"],"Una nota sólo para pruebas, no pública.")
            self.assertRegex(rep_orig["syncGeneration"],r"^[0-9a-f-]{36}$")
            self.assertNotEqual(rep_orig["syncGeneration"],gen_redigitized)
        finally:
            original.close()
            restored.close()

    def test_chromium_cifrado_integridad_y_restore(self):
        self.run_browser(self.engines["chromium"])

    def test_firefox_cifrado_integridad_y_restore(self):
        self.run_browser(self.engines["firefox"])


if __name__=="__main__":
    unittest.main()
