// Archivito — compilación acotada para Cloudflare Pages.
// No copia imágenes privadas, backups, claves ni node_modules.
// Uso: npm install && npm run build:pages
import { copyFile, mkdir, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { resolve, dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(repo, "app"), destination = join(repo, "dist");
const appOut = join(destination, "app");

// Lista explícita: ningún archivo inesperado dentro de app/ se publica.
const publicFiles = [
  "index.html", "digitalizar.html", "visor-3d.html",
  "archive-v3.js", "capture-existing.js", "paper-math.js",
  "perspective.js", "visor-3d-data.js", "acceso.html", "auth-return.js",
  "respaldo-v4.html", "crypto-v4.js", "backup-v4.js"
];
const mandatory = ["index.html", "digitalizar.html", "visor-3d.html", "acceso.html", "auth-return.js"];
async function exists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }

async function main() {
  await rm(destination, { recursive: true, force: true });
  await mkdir(appOut, { recursive: true });
  for (const name of publicFiles) {
    const input = join(src, name);
    if (!(await exists(input))) {
      if (mandatory.includes(name)) throw Error("Archivo obligatorio faltante: " + name);
      continue;
    }
    if (![".html", ".js"].includes(extname(name))) throw Error("Extensión no permitida: " + name);
    await copyFile(input, join(appOut, name));
  }

  // Única entrada ESM que importa paquetes. Se crea un bundle autónomo.
  await build({
    entryPoints: [join(src, "visor-three.js")],
    outfile: join(appOut, "visor-three.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning"
  });

  // Public configuration only. Never allow service-role or secret API keys.
  const supabaseUrl = process.env.ARCHIVITO_SUPABASE_URL || "";
  const supabaseKey = process.env.ARCHIVITO_SUPABASE_PUBLISHABLE_KEY || "";
  if (Boolean(supabaseUrl) !== Boolean(supabaseKey))
    throw Error("Configurá ambas variables públicas de Supabase o ninguna.");
  if (supabaseUrl && (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(supabaseUrl) ||
      !/^sb_publishable_[a-zA-Z0-9_-]+$/.test(supabaseKey)))
    throw Error("Sólo se admite URL HTTPS de Supabase y publishable key.");
  await build({
    entryPoints:[join(src,"auth-entry.js")],
    outfile:join(appOut,"auth-entry.js"),
    bundle:true,platform:"browser",format:"esm",target:"es2022",minify:true,
    sourcemap:false,legalComments:"eof",
    define:{
      __ARCHIVITO_SUPABASE_URL__:JSON.stringify(supabaseUrl),
      __ARCHIVITO_SUPABASE_PUBLISHABLE_KEY__:JSON.stringify(supabaseKey)
    }
  });
  const libraryPath=join(appOut,"index.html");
  const library=await readFile(libraryPath,"utf8");
  if(!library.includes("<head>")||!library.includes("</body>"))throw Error("HTML de biblioteca inesperado.");
  await writeFile(libraryPath,library.replace("<head>",'<head><meta name="referrer" content="no-referrer"><script src="./auth-return.js"></script>')
    .replace("</body>",'<p style="text-align:center;padding:16px"><a href="./acceso.html" style="color:#eac99a">Acceso compartido — prueba Google</a></p></body>'),"utf8");

  const visorFile = join(appOut, "visor-3d.html");
  const html = await readFile(visorFile, "utf8");
  const pattern = /<script type="importmap">[\s\S]*?<\/script>/;
  if (!pattern.test(html)) throw Error("Falta el importmap a reemplazar.");
  await writeFile(visorFile, html.replace(pattern,
    "<!-- Three.js está integrado en visor-three.js. -->"), "utf8");

  const landing = [
    '<!doctype html><html lang="es"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="refresh" content="0;url=/app/acceso.html">',
    '<title>Archivito</title></head><body>',
    '<p><a href="/app/acceso.html">Abrir Archivito</a></p></body></html>'
  ].join("\n");
  await writeFile(join(destination, "index.html"), landing, "utf8");

  const headers = [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: geolocation=(), microphone=()"
  ].join("\n");
  await writeFile(join(destination, "_headers"), headers, "utf8");

  const files = await readdir(appOut);
  if (files.some(name => !publicFiles.includes(name) && !["visor-three.js","auth-entry.js"].includes(name)))
    throw Error("Archivo no permitido en dist/app.");
  console.log("Archivito Pages: build estático en dist/ (" + files.length + " archivos).");
}

await main();
