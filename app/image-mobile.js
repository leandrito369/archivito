/* Archivito 0.4B — soporte móvil de fotografías (EXIF, formatos y validación por magic bytes).
   Nunca modifica ni re-codifica los bytes del archivo original.
   Sin dependencias externas ni red; compatible con navegador (globalThis) y Node (CommonJS). */
(function (root) {
  "use strict";

  const MAX_IMAGE_BYTES = 35 * 1024 * 1024;
  const HEADER_SLICE_BYTES = 131072; // 128 KB: suficiente para SOI + APP0/APP1 EXIF (máx. 64 KB) + SOF.
  const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  const HEIC_BRANDS = new Set([
    "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"
  ]);
  const AVIF_BRANDS = new Set(["avif", "avis"]);
  const HEIC_MIMES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
  const AVIF_MIMES = new Set(["image/avif", "image/avif-sequence"]);
  const GENERIC_MIMES = new Set(["", "application/octet-stream"]);

  const HEIC_MESSAGE =
    "Formato HEIC/HEIF (típico de iPhone/iPad) no es compatible de forma directa en todos los navegadores. " +
    "Convertí o exportá la foto a JPEG, PNG o WebP en tu dispositivo " +
    "(en iOS: Ajustes → Cámara → Formatos → «Más compatible») antes de subirla. No se envió nada a Internet.";
  const AVIF_MESSAGE =
    "El formato AVIF todavía no está admitido en Archivito. " +
    "Convertí la fotografía a JPEG, PNG o WebP en tu dispositivo antes de cargarla.";
  const UNSUPPORTED_MESSAGE =
    "Formato no admitido o archivo de imagen dañado. Usá fotografías JPEG, PNG, WebP o GIF (máx. 35 MB).";

  // JPEG grayscale baseline mínimo de 16×8 px con etiqueta EXIF Orientation = 6 (90° horario).
  // Permite detectar una sola vez por sesión si createImageBitmap ya aplica EXIF de forma nativa.
  const PROBE_EXIF6_JPEG = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0xff, 0xdb, 0x00, 0x43, 0x00,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xc4, 0x00, 0x14, 0x00, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00,
    0xff, 0xc4, 0x00, 0x14, 0x10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x0f,
    0xff, 0xd9
  ]);

  let autoOrientPromise = null;

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return new Uint8Array(0);
  }

  function asciiAt(bytes, offset, length) {
    if (offset < 0 || offset + length > bytes.length) return "";
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCodePoint(bytes[offset + i]);
    return out;
  }

  function uint16(bytes, offset, littleEndian) {
    if (offset < 0 || offset + 2 > bytes.length) return -1;
    return littleEndian
      ? bytes[offset] | (bytes[offset + 1] << 8)
      : (bytes[offset] << 8) | bytes[offset + 1];
  }

  function uint32(bytes, offset, littleEndian) {
    if (offset < 0 || offset + 4 > bytes.length) return -1;
    if (littleEndian) {
      return (bytes[offset] | (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    }
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function extensionOf(name) {
    if (typeof name !== "string") return "";
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
  }

  function detectIsoBmffFormat(bytes) {
    if (bytes.length < 12 || asciiAt(bytes, 4, 4) !== "ftyp") return null;
    const boxSize = uint32(bytes, 0, false);
    const limit = Math.min(bytes.length, boxSize >= 12 ? boxSize : 64, 128);
    const brands = [asciiAt(bytes, 8, 4).toLowerCase()];
    for (let offset = 16; offset + 4 <= limit; offset += 4) {
      brands.push(asciiAt(bytes, offset, 4).toLowerCase());
    }
    if (brands.some(b => HEIC_BRANDS.has(b))) return "image/heic";
    if (brands.some(b => AVIF_BRANDS.has(b))) return "image/avif";
    return null;
  }

  function detectMagicFormat(rawBytes) {
    const bytes = toBytes(rawBytes);
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
      return "image/png";
    }
    if (bytes.length >= 6) {
      const gifHead = asciiAt(bytes, 0, 6);
      if (gifHead === "GIF87a" || gifHead === "GIF89a") return "image/gif";
    }
    if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") {
      return "image/webp";
    }
    const iso = detectIsoBmffFormat(bytes);
    if (iso) return iso;
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
    if (bytes.length >= 4 && (
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
    )) {
      return "image/tiff";
    }
    return null;
  }

  function detectFormat(rawBytes, mime = "", name = "") {
    const byMagic = detectMagicFormat(rawBytes);
    if (byMagic) return byMagic;
    const lowerMime = String(mime || "").toLowerCase().trim();
    const ext = extensionOf(name);
    if (HEIC_MIMES.has(lowerMime) || ext === "heic" || ext === "heif") return "image/heic";
    if (AVIF_MIMES.has(lowerMime) || ext === "avif") return "image/avif";
    return null;
  }

  function readTiffOrientation(bytes, tiffStart, segmentEnd) {
    if (tiffStart + 8 > segmentEnd) return 1;
    const order = asciiAt(bytes, tiffStart, 2);
    if (order !== "II" && order !== "MM") return 1;
    const little = order === "II";
    if (uint16(bytes, tiffStart + 2, little) !== 0x002a) return 1;
    const ifdOffset = uint32(bytes, tiffStart + 4, little);
    if (ifdOffset < 8 || tiffStart + ifdOffset + 2 > segmentEnd) return 1;
    const ifdStart = tiffStart + ifdOffset;
    const entryCount = Math.min(uint16(bytes, ifdStart, little), 256);
    for (let i = 0; i < entryCount; i++) {
      const entry = ifdStart + 2 + i * 12;
      if (entry + 12 > segmentEnd) break;
      const tag = uint16(bytes, entry, little);
      if (tag !== 0x0112) continue;
      const type = uint16(bytes, entry + 2, little);
      const count = uint32(bytes, entry + 4, little);
      if (type !== 3 || count !== 1) return 1;
      const value = uint16(bytes, entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
    return 1;
  }

  function readExifOrientation(rawBytes) {
    const bytes = toBytes(rawBytes);
    if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
    let offset = 2;
    while (offset + 1 < bytes.length) {
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break; // EOI o SOS: fin de cabeceras.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // Sin longitud.
      const length = uint16(bytes, offset, false);
      if (length < 2) break;
      const segmentEnd = Math.min(bytes.length, offset + length);
      if (marker === 0xe1 && offset + 8 <= segmentEnd &&
          asciiAt(bytes, offset + 2, 4) === "Exif" &&
          bytes[offset + 6] === 0x00 && bytes[offset + 7] === 0x00) {
        return readTiffOrientation(bytes, offset + 8, segmentEnd);
      }
      offset += length;
    }
    return 1;
  }

  function orientedDimensions(width, height, orientation = 1) {
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    const swapsAxes = orientation >= 5 && orientation <= 8;
    return swapsAxes
      ? { width: h, height: w, swapsAxes: true }
      : { width: w, height: h, swapsAxes: false };
  }

  function orientationMatrix(orientation, outW, outH) {
    const w = Math.max(1, Number(outW) || 1);
    const h = Math.max(1, Number(outH) || 1);
    switch (orientation) {
      case 2: return { a: -1, b: 0, c: 0, d: 1, e: w, f: 0, swapsAxes: false, drawW: w, drawH: h };
      case 3: return { a: -1, b: 0, c: 0, d: -1, e: w, f: h, swapsAxes: false, drawW: w, drawH: h };
      case 4: return { a: 1, b: 0, c: 0, d: -1, e: 0, f: h, swapsAxes: false, drawW: w, drawH: h };
      case 5: return { a: 0, b: 1, c: 1, d: 0, e: 0, f: 0, swapsAxes: true, drawW: h, drawH: w };
      case 6: return { a: 0, b: 1, c: -1, d: 0, e: w, f: 0, swapsAxes: true, drawW: h, drawH: w };
      case 7: return { a: 0, b: -1, c: -1, d: 0, e: w, f: h, swapsAxes: true, drawW: h, drawH: w };
      case 8: return { a: 0, b: -1, c: 1, d: 0, e: 0, f: h, swapsAxes: true, drawW: h, drawH: w };
      default: return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, swapsAxes: false, drawW: w, drawH: h };
    }
  }

  function quickValidateFile(file) {
    if (!file || typeof file.size !== "number") {
      throw new Error(UNSUPPORTED_MESSAGE);
    }
    if (file.size === 0) throw new Error("El archivo de imagen está vacío.");
    if (file.size > MAX_IMAGE_BYTES) throw new Error("Cada fotografía debe ocupar menos de 35 MB.");
    const mime = String(file.type || "").toLowerCase().trim();
    const ext = extensionOf(file.name);
    if (HEIC_MIMES.has(mime) || ext === "heic" || ext === "heif") {
      throw new Error(HEIC_MESSAGE);
    }
    if (AVIF_MIMES.has(mime) || ext === "avif") {
      throw new Error(AVIF_MESSAGE);
    }
    if (!GENERIC_MIMES.has(mime) && !ALLOWED_TYPES.has(mime)) {
      throw new Error(UNSUPPORTED_MESSAGE);
    }
    return true;
  }

  function validateImageBytes(rawBytes, { mime = "", name = "", size = null } = {}) {
    const bytes = toBytes(rawBytes);
    const totalSize = size === null ? bytes.length : Number(size);
    if (!Number.isFinite(totalSize) || totalSize <= 0 || bytes.length === 0) {
      throw new Error("El archivo de imagen está vacío.");
    }
    if (totalSize > MAX_IMAGE_BYTES) {
      throw new Error("Cada fotografía debe ocupar menos de 35 MB.");
    }
    const detected = detectFormat(bytes, mime, name);
    if (detected === "image/heic") throw new Error(HEIC_MESSAGE);
    if (detected === "image/avif") throw new Error(AVIF_MESSAGE);
    if (!detected || !ALLOWED_TYPES.has(detected)) {
      throw new Error(UNSUPPORTED_MESSAGE);
    }
    const orientation = detected === "image/jpeg" ? readExifOrientation(bytes) : 1;
    return { ok: true, mime: detected, orientation };
  }

  async function readHeaderBytes(blob) {
    if (!(blob instanceof Blob)) return new Uint8Array(0);
    const slice = blob.slice(0, Math.min(blob.size, HEADER_SLICE_BYTES));
    return new Uint8Array(await slice.arrayBuffer());
  }

  async function inspectImageBlob(blob) {
    if (!(blob instanceof Blob)) throw new Error(UNSUPPORTED_MESSAGE);
    if (blob.size === 0) throw new Error("El archivo de imagen está vacío.");
    if (blob.size > MAX_IMAGE_BYTES) throw new Error("Cada fotografía debe ocupar menos de 35 MB.");
    const bytes = await readHeaderBytes(blob);
    const info = validateImageBytes(bytes, {
      mime: blob.type || "",
      name: typeof blob.name === "string" ? blob.name : "",
      size: blob.size
    });
    // Si el selector móvil entregó MIME vacío o genérico, etiquetamos el tipo real sin alterar un solo byte.
    const normalizedBlob = blob.type === info.mime ? blob : blob.slice(0, blob.size, info.mime);
    return { ...info, blob: normalizedBlob };
  }

  function browserAutoOrientsBitmap() {
    if (autoOrientPromise) return autoOrientPromise;
    autoOrientPromise = (async () => {
      if (typeof createImageBitmap !== "function" || typeof Blob !== "function") return true;
      try {
        const probe = new Blob([PROBE_EXIF6_JPEG], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(probe);
        try {
          // El JPEG sonda es 16×8 en crudo con EXIF 6: si el navegador orienta solo, entrega 8×16.
          return bitmap.width === 8 && bitmap.height === 16;
        } finally {
          bitmap.close();
        }
      } catch {
        return true;
      }
    })();
    return autoOrientPromise;
  }

  async function drawOrientedCanvas(blob, maxSide = 2400, targetCanvas = null, contextOptions = undefined) {
    const header = await readHeaderBytes(blob);
    const orientation = detectMagicFormat(header) === "image/jpeg" ? readExifOrientation(header) : 1;
    const autoOriented = await browserAutoOrientsBitmap();
    const bitmap = await createImageBitmap(blob);
    try {
      const needsManual = !autoOriented && orientation > 1;
      const dims = needsManual
        ? orientedDimensions(bitmap.width, bitmap.height, orientation)
        : { width: bitmap.width, height: bitmap.height, swapsAxes: false };
      const limit = Number.isFinite(maxSide) && maxSide > 0 ? maxSide : Math.max(dims.width, dims.height);
      const scale = Math.min(1, limit / Math.max(dims.width, dims.height));
      const outW = Math.max(1, Math.round(dims.width * scale));
      const outH = Math.max(1, Math.round(dims.height * scale));
      const canvas = targetCanvas || document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = contextOptions ? canvas.getContext("2d", contextOptions) : canvas.getContext("2d");
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (needsManual) {
        const m = orientationMatrix(orientation, outW, outH);
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.drawImage(bitmap, 0, 0, m.drawW, m.drawH);
      } else {
        ctx.drawImage(bitmap, 0, 0, outW, outH);
      }
      ctx.restore();
      return { canvas, width: outW, height: outH, orientation, autoOriented };
    } finally {
      bitmap.close();
    }
  }

  async function orientedSize(blob) {
    if (!(blob instanceof Blob)) return { width: 3, height: 4, orientation: 1 };
    const header = await readHeaderBytes(blob);
    const orientation = detectMagicFormat(header) === "image/jpeg" ? readExifOrientation(header) : 1;
    const autoOriented = await browserAutoOrientsBitmap();
    const bitmap = await createImageBitmap(blob);
    try {
      const dims = !autoOriented && orientation > 1
        ? orientedDimensions(bitmap.width, bitmap.height, orientation)
        : { width: bitmap.width, height: bitmap.height };
      return { width: dims.width, height: dims.height, orientation };
    } finally {
      bitmap.close();
    }
  }

  async function createThumbnail(blob, maxSide = 540, quality = 0.78) {
    const { canvas } = await drawOrientedCanvas(blob, maxSide);
    return await new Promise((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error("No se pudo crear la miniatura.")),
      "image/jpeg",
      quality
    ));
  }

  root.ArchivitoImageMobile = Object.freeze({
    MAX_IMAGE_BYTES,
    ALLOWED_TYPES,
    HEIC_BRANDS,
    PROBE_EXIF6_JPEG,
    detectFormat,
    readExifOrientation,
    orientedDimensions,
    orientationMatrix,
    quickValidateFile,
    validateImageBytes,
    inspectImageBlob,
    browserAutoOrientsBitmap,
    drawOrientedCanvas,
    orientedSize,
    createThumbnail
  });
  if (typeof module !== "undefined" && module.exports) module.exports = root.ArchivitoImageMobile;
})(typeof globalThis === "object" ? globalThis : this);
