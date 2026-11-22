import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

const dist=resolve("dist");
const app=join(dist,"app");

test("compilación Pages expone páginas de Archivito",async()=>{
  for(const file of ["index.html","digitalizar.html","visor-3d.html"]){
    const html=await readFile(join(app,file),"utf8");
    assert.match(html,/<html/);
    assert.ok(html.length>100);
  }
  assert.match(await readFile(join(dist,"index.html"),"utf8"),/\/app\/index.html/);
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

test("no incluye dependencias completas, datos privados o respaldos",async()=>{
  const output=await readdir(dist,{withFileTypes:true});
  assert.deepEqual(output.map(x=>x.name).sort(),["_headers","app","index.html"].sort());
  const allowed=new Set([
    "index.html","digitalizar.html","visor-3d.html","archive-v3.js",
    "capture-existing.js","paper-math.js","perspective.js",
    "visor-3d-data.js","visor-three.js","respaldo-v4.html",
    "crypto-v4.js","backup-v4.js"
  ]);
  const files=await readdir(app);
  assert.ok(files.length>=9);
  for(const name of files) {
    assert.ok(allowed.has(name),"Archivo inesperado: "+name);
    assert.ok((await stat(join(app,name))).isFile());
    assert.doesNotMatch(name,/\.(json|png|jpe?g|webp|gif|archivito|env)$/i);
  }
});
