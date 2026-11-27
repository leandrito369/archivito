import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import vm from "node:vm";

const dist=resolve("dist");
const app=join(dist,"app");

test("compilación Pages expone páginas de producto y apunta a la biblioteca local",async()=>{
  const pages=["index.html","digitalizar.html","visor-3d.html","acceso.html","respaldo-v4.html"];
  for(const file of pages){
    const html=await readFile(join(app,file),"utf8");
    assert.match(html,/<html/);
    assert.ok(html.length>100);
  }
  const landing=await readFile(join(dist,"index.html"),"utf8");
  assert.match(landing,/\/app\/index\.html/);
  assert.doesNotMatch(landing,/\/app\/acceso\.html/);
});

test("Three.js queda integrado sin importmap ni acceso a node_modules",async()=>{
  const html=await readFile(join(app,"visor-3d.html"),"utf8");
  assert.doesNotMatch(html,/<script type="importmap">/);
  assert.doesNotMatch(html,/node_modules\//);
  const bundled=await readFile(join(app,"visor-three.js"),"utf8");
  assert.ok(bundled.length>35000,"El bundle debe contener Three.js y OrbitControls.");
  assert.doesNotMatch(bundled,/from\s*["']three["']/);
  assert.doesNotMatch(bundled,/import\s*["']three["']/);
});

test("no incluye laboratorios, dependencias completas, datos privados ni respaldos",async()=>{
  const output=await readdir(dist,{withFileTypes:true});
  assert.deepEqual(output.map(x=>x.name).sort(),["_headers","app","index.html"].sort());
  const expected=[
    "index.html","digitalizar.html","visor-3d.html","archive-v3.js","local-generation.js",
    "capture-existing.js","paper-math.js","perspective.js",
    "visor-3d-data.js","visor-three.js","respaldo-v4.html",
    "crypto-v4.js","backup-v4.js","acceso.html","auth-return.js","auth-entry.js"
  ];
  const files=await readdir(app);
  assert.deepEqual(files.sort(),expected.sort());
  for(const name of files){
    assert.ok((await stat(join(app,name))).isFile());
    assert.doesNotMatch(name,/\.(json|png|jpe?g|webp|gif|archivito|env)$/i);
    assert.doesNotMatch(name,/(crypto-lab|sync-fixture|sync-v3|sync-incremental)/i);
  }
  // Confirm every local HTML/JS asset referenced by <script src="./..."> exists in dist/app.
  const present=new Set(files);
  for(const page of ["index.html","digitalizar.html","visor-3d.html","acceso.html","respaldo-v4.html"]){
    const html=await readFile(join(app,page),"utf8");
    for(const match of html.matchAll(/<script[^>]+src="\.\/([^"]+)"/g)){
      assert.ok(present.has(match[1]),`Asset faltante en dist/app para ${page}: ${match[1]}`);
    }
  }
});

test("acceso de Google libre de paneles de laboratorio y retorno OAuth PKCE operativo",async()=>{
  const html=await readFile(join(app,"acceso.html"),"utf8");
  const index=await readFile(join(app,"index.html"),"utf8");
  const bundle=await readFile(join(app,"auth-entry.js"),"utf8");
  const authReturn=await readFile(join(app,"auth-return.js"),"utf8");
  assert.match(html,/auth-entry\.js/);
  assert.doesNotMatch(html,/fixture-panel|v3-lab-panel|inc-lab-panel/);
  assert.doesNotMatch(bundle,/fixture-publish|v3-lab-create|inc-lab-create/);
  assert.doesNotMatch(bundle,/from\s*["']@supabase\/supabase-js["']/);
  assert.ok(bundle.length>10000);
  assert.match(index,/auth-return\.js/);

  // Verificar retorno OAuth PKCE en /app/?code=... -> ./acceso.html?code=...
  let redirected=null;
  const ctxWithCode={
    location:{href:"https://archivito.example/app/?code=pkce-demo",search:"?code=pkce-demo",replace:u=>{redirected=u;}},
    URL,URLSearchParams,document:{documentElement:{style:{}}}
  };
  vm.runInNewContext(authReturn,ctxWithCode);
  assert.equal(redirected,"https://archivito.example/app/acceso.html?code=pkce-demo");

  // Sin parámetros OAuth, la biblioteca local permanece en /app/index.html.
  let plainRedirect=null;
  const ctxPlain={
    location:{href:"https://archivito.example/app/",search:"",replace:u=>{plainRedirect=u;}},
    URL,URLSearchParams,document:{documentElement:{style:{}}}
  };
  vm.runInNewContext(authReturn,ctxPlain);
  assert.equal(plainRedirect,null);
});
