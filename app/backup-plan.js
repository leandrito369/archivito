/* Archivito 0.4A.2 — planificación pura de importación, conflictos y diagnóstico de cuota.
   Sin DOM, sin red ni escrituras de IndexedDB; reutilizable en respaldo-v4, biblioteca y tests. */
(function (root) {
  "use strict";
  const POLICIES = new Set(["abort", "skip", "duplicate", "replace"]);
  const LAST_EXPORT_KEY = "archivito-last-v4-export-at";
  const STALE_BACKUP_DAYS = 30;
  const DAY_MS = 86400000;

  function blobSize(value) {
    if (!value || typeof value !== "object") return 0;
    const size = Number(value.size);
    return Number.isFinite(size) && size > 0 ? size : 0;
  }

  function estimateRecordBytes(record) {
    const pages = Array.isArray(record?.pages) ? record.pages : [];
    let bytes = 512;
    if (pages.length) {
      for (const page of pages) {
        bytes += blobSize(page?.front) + blobSize(page?.back) +
          blobSize(page?.frontDerived) + blobSize(page?.backDerived) +
          blobSize(page?.thumb) + 256;
      }
    } else {
      bytes += blobSize(record?.front) + blobSize(record?.back) + blobSize(record?.thumb);
    }
    return bytes;
  }

  function formatBytes(bytes) {
    const safe = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
    if (safe < 1024) return `${Math.round(safe)} B`;
    if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
    if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
    return `${(safe / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function pageCountOf(record) {
    return Array.isArray(record?.pages) && record.pages.length ? record.pages.length : 1;
  }

  function classifyImport(existingRecords, incomingRecords) {
    if (!Array.isArray(existingRecords) || !Array.isArray(incomingRecords)) {
      throw new Error("Listas de recuerdos inválidas para planificar la importación.");
    }
    const existingById = new Map();
    for (const rec of existingRecords) {
      if (rec && typeof rec.id === "string" && rec.id) existingById.set(rec.id, rec);
    }
    const seenIncoming = new Set();
    const fresh = [];
    const conflicts = [];
    let totalPages = 0;
    let estimatedBytes = 0;

    for (const incoming of incomingRecords) {
      if (!incoming || typeof incoming.id !== "string" || !incoming.id) {
        throw new Error("El respaldo contiene un recuerdo sin identificador válido.");
      }
      if (seenIncoming.has(incoming.id)) {
        throw new Error("El respaldo contiene IDs duplicados.");
      }
      seenIncoming.add(incoming.id);
      const pages = pageCountOf(incoming);
      const bytes = estimateRecordBytes(incoming);
      totalPages += pages;
      estimatedBytes += bytes;

      const current = existingById.get(incoming.id);
      if (current) {
        conflicts.push({
          id: incoming.id,
          incoming,
          existing: current,
          incomingTitle: String(incoming.title || "Sin título"),
          existingTitle: String(current.title || "Sin título"),
          incomingDate: String(incoming.date || ""),
          existingDate: String(current.date || ""),
          incomingPages: pages,
          existingPages: pageCountOf(current),
          estimatedBytes: bytes
        });
      } else {
        fresh.push(incoming);
      }
    }

    return {
      fresh,
      conflicts,
      totalIncoming: incomingRecords.length,
      newCount: fresh.length,
      conflictCount: conflicts.length,
      totalPages,
      estimatedBytes
    };
  }

  function duplicateTitle(title) {
    const base = String(title || "Recuerdo").trim() || "Recuerdo";
    const suffix = " (copia)";
    return (base.length + suffix.length <= 120 ? base : base.slice(0, 120 - suffix.length).trimEnd()) + suffix;
  }

  function resolveImportPlan(classification, policy, makeId) {
    if (!classification || !Array.isArray(classification.fresh) || !Array.isArray(classification.conflicts)) {
      throw new Error("Clasificación de importación inválida.");
    }
    if (!POLICIES.has(policy)) {
      throw new Error("Política de conflictos no admitida.");
    }
    if (policy === "abort" && classification.conflicts.length > 0) {
      throw new Error(
        `Importación cancelada: ${classification.conflicts.length} recuerdo(s) ya existen con el mismo ID. ` +
        "Elegí omitir, conservar copia o reemplazar antes de continuar."
      );
    }

    const toAdd = [...classification.fresh];
    const toPut = [];
    let skipped = 0;
    let copied = 0;
    let replaced = 0;

    if (policy === "skip") {
      skipped = classification.conflicts.length;
    } else if (policy === "replace") {
      for (const item of classification.conflicts) {
        toPut.push(item.incoming);
        replaced += 1;
      }
    } else if (policy === "duplicate") {
      if (typeof makeId !== "function") {
        throw new Error("Se requiere un generador de IDs para duplicar conflictos.");
      }
      const used = new Set(toAdd.map(r => r.id));
      for (const item of classification.conflicts) used.add(item.id);
      for (const item of classification.conflicts) {
        const nextId = String(makeId());
        if (!nextId || used.has(nextId)) {
          throw new Error("No se pudo generar un identificador único para la copia.");
        }
        used.add(nextId);
        toAdd.push({
          ...item.incoming,
          id: nextId,
          title: duplicateTitle(item.incoming.title)
        });
        copied += 1;
      }
    }

    const writeBytes = [...toAdd, ...toPut].reduce((acc, rec) => acc + estimateRecordBytes(rec), 0);
    return {
      policy,
      toAdd,
      toPut,
      added: classification.fresh.length,
      skipped,
      copied,
      replaced,
      totalWrites: toAdd.length + toPut.length,
      writeBytes
    };
  }

  function parseTimestamp(value) {
    if (typeof value !== "string" || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  function assessStorage({
    usage = null,
    quota = null,
    persisted = null,
    lastExportAt = null,
    now = Date.now(),
    incomingBytes = 0
  } = {}) {
    const warnings = [];
    let level = "ok";
    const bump = next => {
      if (next === "critical" || (next === "warning" && level === "ok")) level = next;
    };

    const hasQuota = Number.isFinite(usage) && usage >= 0 && Number.isFinite(quota) && quota > 0;
    const availableBytes = hasQuota ? Math.max(0, quota - usage) : null;
    const usageRatio = hasQuota ? Math.min(1, usage / quota) : null;
    let quotaExceeds = false;
    let quotaTight = false;
    let quotaWarning = null;

    if (hasQuota) {
      if (incomingBytes > 0 && incomingBytes > availableBytes) {
        quotaExceeds = true;
        bump("critical");
        quotaWarning =
          `El respaldo estimado (${formatBytes(incomingBytes)}) supera el espacio libre (${formatBytes(availableBytes)}).`;
        warnings.push(quotaWarning);
      } else if (incomingBytes > 0 && availableBytes > 0 && incomingBytes > availableBytes * 0.85) {
        quotaTight = true;
        bump("warning");
        quotaWarning =
          `El respaldo (${formatBytes(incomingBytes)}) dejará menos del 15 % de cuota libre en este navegador.`;
        warnings.push(quotaWarning);
      }
      if (usageRatio >= 0.9) {
        bump("critical");
        warnings.push(`Almacenamiento casi lleno (${Math.round(usageRatio * 100)} % usado de ${formatBytes(quota)}).`);
      } else if (usageRatio >= 0.8) {
        bump("warning");
        warnings.push(`Uso elevado del navegador (${Math.round(usageRatio * 100)} % de ${formatBytes(quota)}).`);
      }
    }

    if (persisted === false) {
      bump("warning");
      warnings.push("El navegador no garantizó almacenamiento persistente: puede liberar datos si falta espacio.");
    }

    const lastMs = parseTimestamp(lastExportAt);
    const daysSinceBackup = lastMs === null ? null : Math.max(0, Math.floor((now - lastMs) / DAY_MS));
    let backupStale = false;
    if (lastMs === null) {
      backupStale = true;
      bump("warning");
      warnings.push("Todavía no registraste una exportación cifrada v4 desde este perfil.");
    } else if (daysSinceBackup > STALE_BACKUP_DAYS) {
      backupStale = true;
      bump("warning");
      warnings.push(`Último respaldo cifrado v4 hace ${daysSinceBackup} días; conviene generar uno nuevo.`);
    }

    return {
      level,
      hasQuota,
      usage: hasQuota ? usage : null,
      quota: hasQuota ? quota : null,
      availableBytes,
      usageRatio,
      persisted,
      lastExportAt: lastMs === null ? null : new Date(lastMs).toISOString(),
      daysSinceBackup,
      backupStale,
      quotaExceeds,
      quotaTight,
      quotaWarning,
      warnings
    };
  }

  root.ArchivitoBackupPlan = Object.freeze({
    POLICIES,
    LAST_EXPORT_KEY,
    STALE_BACKUP_DAYS,
    estimateRecordBytes,
    formatBytes,
    classifyImport,
    resolveImportPlan,
    assessStorage
  });
  if (typeof module !== "undefined" && module.exports) module.exports = root.ArchivitoBackupPlan;
})(typeof globalThis === "object" ? globalThis : this);
