import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const img = require("../app/image-mobile.js");

function makeExifJpeg(orientation, littleEndian = false, extraPrefix = []) {
  const u16 = v => littleEndian ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff];
  const u32 = v => littleEndian
    ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
    : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const order = littleEndian ? [0x49, 0x49] : [0x4d, 0x4d];
  const tiff = [
    ...order, ...u16(0x002a), ...u32(8),
    ...u16(1),
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
    ...u32(0)
  ];
  const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = exif.length + 2;
  return new Uint8Array([
    0xff, 0xd8,
    ...extraPrefix,
    0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...exif,
    0xff, 0xd9
  ]);
}

function makeIsoBmff(majorBrand, compatibleBrands = []) {
  const size = 16 + compatibleBrands.length * 4;
  const out = new Uint8Array(size);
  out[3] = size;
  out.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  for (let i = 0; i < 4; i++) out[8 + i] = majorBrand.codePointAt(i);
  for (let b = 0; b < compatibleBrands.length; b++) {
    for (let i = 0; i < 4; i++) out[16 + b * 4 + i] = compatibleBrands[b].codePointAt(i);
  }
  return out;
}

test("detectFormat identifica JPEG, PNG, WebP, GIF, HEIC/HEIF y AVIF por magic bytes", () => {
  assert.equal(img.detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(img.detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(img.detectFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "image/gif");
  assert.equal(
    img.detectFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    "image/webp"
  );
  assert.equal(img.detectFormat(makeIsoBmff("heic")), "image/heic");
  assert.equal(img.detectFormat(makeIsoBmff("mif1", ["heic"])), "image/heic");
  assert.equal(img.detectFormat(makeIsoBmff("avif")), "image/avif");
  // HEIC renombrado a .jpg sigue siendo detectado por magic bytes.
  assert.equal(img.detectFormat(makeIsoBmff("heic"), "image/jpeg", "foto.jpg"), "image/heic");
  // Archivo de texto disfrazado de JPEG devuelve null.
  assert.equal(img.detectFormat(new TextEncoder().encode("esto no es un jpeg"), "image/jpeg", "fake.jpg"), null);
});

test("validateImageBytes y quickValidateFile dan errores claros para HEIC, AVIF, corruptos y >35 MB", () => {
  const validJpeg = makeExifJpeg(6, false);
  // MIME vacío pero bytes JPEG válidos -> aceptado y clasificado como image/jpeg + orientación 6.
  const ok = img.validateImageBytes(validJpeg, { mime: "", name: "IMG_1234.JPG", size: validJpeg.length });
  assert.equal(ok.ok, true);
  assert.equal(ok.mime, "image/jpeg");
  assert.equal(ok.orientation, 6);

  assert.throws(
    () => img.validateImageBytes(makeIsoBmff("heic"), { mime: "image/heic", name: "IMG_0001.HEIC" }),
    /HEIC\/HEIF.*JPEG, PNG o WebP/
  );
  assert.throws(
    () => img.validateImageBytes(makeIsoBmff("heic"), { mime: "image/jpeg", name: "renombrada.jpg" }),
    /HEIC\/HEIF/
  );
  assert.throws(
    () => img.validateImageBytes(makeIsoBmff("avif"), { mime: "image/avif", name: "foto.avif" }),
    /AVIF/
  );
  assert.throws(
    () => img.validateImageBytes(new TextEncoder().encode("basura"), { mime: "image/jpeg", name: "roto.jpg" }),
    /no admitido|dañado/i
  );
  assert.throws(
    () => img.validateImageBytes(validJpeg, { mime: "image/jpeg", size: img.MAX_IMAGE_BYTES + 1 }),
    /35 MB/
  );

  // quickValidateFile rechaza HEIC sincrónicamente, pero permite MIME vacío para validación posterior por bytes.
  assert.throws(() => img.quickValidateFile({ size: 1024, type: "", name: "foto.HEIC" }), /HEIC\/HEIF/);
  assert.throws(() => img.quickValidateFile({ size: 1024, type: "image/heif", name: "foto" }), /HEIC\/HEIF/);
  assert.equal(img.quickValidateFile({ size: 1024, type: "", name: "foto_movil.jpg" }), true);
});

test("readExifOrientation lee orientaciones 1..8 en big-endian, little-endian y tras APP0/XMP", () => {
  for (const little of [false, true]) {
    for (let o = 1; o <= 8; o++) {
      assert.equal(img.readExifOrientation(makeExifJpeg(o, little)), o);
    }
  }
  // APP0 JFIF + APP1 XMP + padding 0xFF antes del APP1 EXIF real.
  const app0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46];
  const xmp = [0xff, 0xe1, 0x00, 0x08, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f];
  const withPrefix = makeExifJpeg(8, true, [...app0, ...xmp, 0xff, 0xff]);
  assert.equal(img.readExifOrientation(withPrefix), 8);

  // Sonda interna válida.
  assert.equal(img.detectFormat(img.PROBE_EXIF6_JPEG), "image/jpeg");
  assert.equal(img.readExifOrientation(img.PROBE_EXIF6_JPEG), 6);

  // Entradas sin EXIF o truncadas devuelven 1 sin lanzar error.
  assert.equal(img.readExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), 1);
  assert.equal(img.readExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x45, 0x78])), 1);
  assert.equal(img.readExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 1);
});

test("orientationMatrix y orientedDimensions mapean exactamente las 8 orientaciones EXIF", () => {
  const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

  for (let o = 1; o <= 8; o++) {
    const dims = img.orientedDimensions(24, 12, o);
    assert.equal(dims.swapsAxes, o >= 5);
    assert.deepEqual([dims.width, dims.height], o >= 5 ? [12, 24] : [24, 12]);
    const m = img.orientationMatrix(o, dims.width, dims.height);
    const corners = [
      apply(m, 0, 0),
      apply(m, m.drawW, 0),
      apply(m, 0, m.drawH),
      apply(m, m.drawW, m.drawH)
    ];
    for (const [cx, cy] of corners) {
      assert.ok(cx === 0 || cx === dims.width, `x fuera de borde en orientación ${o}: ${cx}`);
      assert.ok(cy === 0 || cy === dims.height, `y fuera de borde en orientación ${o}: ${cy}`);
    }
  }

  // Orientación 6 (90° horario): borde izquierdo raw (0, 6) debe ir a la parte superior (6, 0).
  const m6 = img.orientationMatrix(6, 12, 24);
  assert.deepEqual(apply(m6, 0, 6), [6, 0]);
  assert.deepEqual(apply(m6, 24, 6), [6, 24]);

  // Orientación 3 (180°): borde izquierdo raw (0, 6) va al borde derecho (24, 6).
  const m3 = img.orientationMatrix(3, 24, 12);
  assert.deepEqual(apply(m3, 0, 6), [24, 6]);
  assert.deepEqual(apply(m3, 24, 6), [0, 6]);
});
