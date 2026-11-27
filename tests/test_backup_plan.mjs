import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plan = require("../app/backup-plan.js");

const fakeBlob = size => ({ size });
const makeRecord = (id, title, sizes = [1000]) => ({
  id,
  title,
  date: "2026-11-27",
  pages: sizes.map((s, i) => ({ id: `p-${i}`, front: fakeBlob(s), back: null, thumb: fakeBlob(200) }))
});

test("classifyImport distingue nuevos, conflictos y rechaza IDs repetidos internos", () => {
  const existing = [makeRecord("r-1", "Carta local", [4000])];
  const incoming = [
    makeRecord("r-1", "Carta backup", [5000, 3000]),
    makeRecord("r-2", "Postal nueva", [2000])
  ];
  const res = plan.classifyImport(existing, incoming);
  assert.equal(res.totalIncoming, 2);
  assert.equal(res.newCount, 1);
  assert.equal(res.conflictCount, 1);
  assert.equal(res.totalPages, 3);
  assert.equal(res.fresh[0].id, "r-2");
  assert.equal(res.conflicts[0].existingTitle, "Carta local");
  assert.equal(res.conflicts[0].incomingTitle, "Carta backup");
  assert.ok(res.estimatedBytes > 10000);

  assert.throws(
    () => plan.classifyImport([], [makeRecord("dup", "A"), makeRecord("dup", "B")]),
    /duplicados/
  );
});

test("resolveImportPlan soporta abort, skip, replace y duplicate con IDs nuevos", () => {
  const existing = [makeRecord("r-1", "Carta local", [1000])];
  const incoming = [
    makeRecord("r-1", "Carta backup", [2000]),
    makeRecord("r-2", "Carta nueva", [3000])
  ];
  const classified = plan.classifyImport(existing, incoming);

  assert.throws(() => plan.resolveImportPlan(classified, "abort"), /cancelada/i);

  const skipped = plan.resolveImportPlan(classified, "skip");
  assert.equal(skipped.added, 1);
  assert.equal(skipped.skipped, 1);
  assert.equal(skipped.toAdd.length, 1);
  assert.equal(skipped.toPut.length, 0);
  assert.equal(skipped.toAdd[0].id, "r-2");

  const replaced = plan.resolveImportPlan(classified, "replace");
  assert.equal(replaced.added, 1);
  assert.equal(replaced.replaced, 1);
  assert.equal(replaced.toAdd.length, 1);
  assert.equal(replaced.toPut.length, 1);
  assert.equal(replaced.toPut[0].id, "r-1");

  let seq = 0;
  const duplicated = plan.resolveImportPlan(classified, "duplicate", () => `copy-${++seq}`);
  assert.equal(duplicated.added, 1);
  assert.equal(duplicated.copied, 1);
  assert.equal(duplicated.toAdd.length, 2);
  assert.equal(duplicated.toPut.length, 0);
  assert.equal(duplicated.toAdd[1].id, "copy-1");
  assert.equal(duplicated.toAdd[1].title, "Carta backup (copia)");

  // Sin conflictos, abort permite importar todos los nuevos.
  const noConflict = plan.classifyImport([], [makeRecord("r-9", "Nueva")]);
  const clean = plan.resolveImportPlan(noConflict, "abort");
  assert.equal(clean.toAdd.length, 1);
  assert.equal(clean.toPut.length, 0);
});

test("resolveImportPlan acota títulos largos al duplicar y rechaza políticas inválidas", () => {
  const longTitle = "A".repeat(120);
  const classified = plan.classifyImport([makeRecord("id-1", "Local")], [makeRecord("id-1", longTitle)]);
  const dup = plan.resolveImportPlan(classified, "duplicate", () => "id-copy");
  assert.ok(dup.toAdd[0].title.length <= 120);
  assert.ok(dup.toAdd[0].title.endsWith(" (copia)"));
  assert.throws(() => plan.resolveImportPlan(classified, "overwrite-all"), /no admitida/i);
  assert.throws(() => plan.resolveImportPlan(classified, "duplicate", () => "id-1"), /identificador único/i);
});

test("assessStorage evalúa cuota, persistencia, antigüedad de respaldo y tamaño entrante", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");

  const healthy = plan.assessStorage({
    usage: 10 * 1024 * 1024,
    quota: 200 * 1024 * 1024,
    persisted: true,
    lastExportAt: "2026-11-25T10:00:00Z",
    now,
    incomingBytes: 5 * 1024 * 1024
  });
  assert.equal(healthy.level, "ok");
  assert.equal(healthy.warnings.length, 0);
  assert.equal(healthy.backupStale, false);
  assert.equal(healthy.quotaExceeds, false);
  assert.equal(healthy.quotaWarning, null);

  const staleAndUnpersisted = plan.assessStorage({
    usage: 50 * 1024 * 1024,
    quota: 100 * 1024 * 1024,
    persisted: false,
    lastExportAt: "2026-09-01T00:00:00Z",
    now
  });
  assert.equal(staleAndUnpersisted.level, "warning");
  assert.equal(staleAndUnpersisted.backupStale, true);
  assert.equal(staleAndUnpersisted.quotaWarning, null);
  assert.ok(staleAndUnpersisted.daysSinceBackup > 30);
  assert.ok(staleAndUnpersisted.warnings.length >= 2);

  const exceeds = plan.assessStorage({
    usage: 90 * 1024 * 1024,
    quota: 100 * 1024 * 1024,
    persisted: true,
    lastExportAt: "2026-11-27T00:00:00Z",
    now,
    incomingBytes: 20 * 1024 * 1024
  });
  assert.equal(exceeds.level, "critical");
  assert.equal(exceeds.quotaExceeds, true);
  assert.match(exceeds.quotaWarning, /supera el espacio libre/);
  assert.ok(exceeds.warnings.some(w => w.includes("supera el espacio libre")));

  assert.equal(plan.formatBytes(512), "512 B");
  assert.equal(plan.formatBytes(1536), "1.5 KB");
  assert.equal(plan.formatBytes(2 * 1024 * 1024), "2.0 MB");
});
