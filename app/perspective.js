/* Archivito — homografía y recorte en memoria, sin dependencias ni cargas externas.
   Entradas: cuatro esquinas normalizadas [TL, TR, BR, BL] del archivo ya orientado.
   El resultado es DERIVADO; este módulo nunca modifica el original. */
(function (root) {
  "use strict";
  const MAX_SIDE = 1600;

  function valid(points) {
    if (!Array.isArray(points) || points.length !== 4) return false;
    if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
        p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return false;
    const signed = [];
    for (let i = 0; i < 4; ++i) {
      const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
      signed.push((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
    }
    if (signed.some(x => Math.abs(x) < 0.00001) ||
        !signed.every(x => Math.sign(x) === Math.sign(signed[0]))) return false;
    const area = Math.abs(points.reduce((a, p, i) => {
      const q = points[(i + 1) % 4]; return a + p.x * q.y - q.x * p.y;
    }, 0)) / 2;
    return area > 0.005;
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function estimateSize(points, srcWidth, srcHeight, maxSide = MAX_SIDE) {
    if (!valid(points)) throw new Error("Las esquinas deben formar un cuadrilátero convexo sin cruces.");
    if (!Number.isFinite(srcWidth) || !Number.isFinite(srcHeight) ||
        srcWidth < 2 || srcHeight < 2) throw new Error("Dimensiones de fotografía inválidas.");
    const px = points.map(p => ({x: p.x * srcWidth, y: p.y * srcHeight}));
    const w = Math.max(distance(px[0], px[1]), distance(px[3], px[2]));
    const h = Math.max(distance(px[0], px[3]), distance(px[1], px[2]));
    const scale = Math.min(1, maxSide / Math.max(w, h));
    return {width: Math.max(2, Math.round(w * scale)),
            height: Math.max(2, Math.round(h * scale))};
  }

  function linearSystem(a, b) {
    // Eliminación de Gauss con pivoteo parcial; 8 incógnitas / 8 ecuaciones.
    const n = b.length;
    const m = a.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++)
        if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
      if (Math.abs(m[pivot][col]) < 1e-10) throw new Error("No se pudo calcular la perspectiva.");
      [m[col], m[pivot]] = [m[pivot], m[col]];
      const div = m[col][col];
      for (let j = col; j <= n; j++) m[col][j] /= div;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = m[row][col];
        for (let j = col; j <= n; j++) m[row][j] -= factor * m[col][j];
      }
    }
    return m.map(row => row[n]);
  }

  function homography(from, to) {
    if (!Array.isArray(from) || !Array.isArray(to) || from.length !== 4 || to.length !== 4)
      throw new Error("La homografía requiere cuatro pares de esquinas.");
    const a = [], b = [];
    for (let i = 0; i < 4; i++) {
      const {x, y} = from[i], {x: u, y: v} = to[i];
      a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      a.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    return [...linearSystem(a, b), 1];
  }

  function project(h, x, y) {
    const den = h[6] * x + h[7] * y + h[8];
    return {x: (h[0] * x + h[1] * y + h[2]) / den,
            y: (h[3] * x + h[4] * y + h[5]) / den};
  }

  function rectify(source, points, maxSide = MAX_SIDE) {
    if (!source || !source.data || !source.width || !source.height)
      throw new Error("Fotografía de entrada inválida.");
    const {width, height} = estimateSize(points, source.width, source.height, maxSide);
    const srcCorners = points.map(p => ({x: p.x * (source.width - 1),
                                          y: p.y * (source.height - 1)}));
    const dstCorners = [
      {x: 0, y: 0}, {x: width - 1, y: 0},
      {x: width - 1, y: height - 1}, {x: 0, y: height - 1}
    ];
    const h = homography(dstCorners, srcCorners);
    const pixels = new Uint8ClampedArray(width * height * 4);
    const src = source.data, sw = source.width, sh = source.height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const {x: fx, y: fy} = project(h, x, y);
        const dst = (y * width + x) * 4;
        if (!Number.isFinite(fx) || !Number.isFinite(fy) ||
            fx < 0 || fy < 0 || fx > sw - 1 || fy > sh - 1) {
          pixels[dst] = pixels[dst + 1] = pixels[dst + 2] = 255;
          pixels[dst + 3] = 255;
          continue;
        }
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        // Papel opaco: derivado PNG RGB (blanco si alguna zona cae fuera de la imagen).
        for (let c = 0; c < 3; c++) {
          const top = src[i00 + c] * (1 - tx) + src[i10 + c] * tx;
          const bottom = src[i01 + c] * (1 - tx) + src[i11 + c] * tx;
          pixels[dst + c] = top * (1 - ty) + bottom * ty;
        }
        pixels[dst + 3] = 255;
      }
    }
    return {width, height, data: pixels};
  }

  const api = {valid, estimateSize, homography, project, rectify};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ArchivitoPerspective = api;
})(typeof globalThis === "object" ? globalThis : this);
