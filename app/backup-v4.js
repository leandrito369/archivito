/* Archivito 0.4A.2 — backup v4 seguro, vista previa de conflictos y diagnóstico local.
   Dos etapas para importar: descifrar + verificar SHA-256 + resolver conflictos ->
   una única transacción atómica. Nunca sobrescribe IDs sin política explícita. */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const CRYPTO = ArchivitoCryptoV4;
  const ARCHIVE = ArchivitoArchiveV3;
  const PLAN = ArchivitoBackupPlan;
  const DB_NAME = "nuestro-archivo-cartas-v1";
  const STORE = "letters";
  const MAX_FILE = 250 * 1024 * 1024;
  const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

  function tell(message, error = false) {
    const el = $("#status");
    el.textContent = message;
    el.classList.toggle("error", error);
  }

  function makeId() {
    if (typeof crypto === "object" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }

  async function allRecords() {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async function applyPlanAtomically(resolved) {
    if (!resolved.totalWrites) return;
    const db = await openDB();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(
          tx.error || new Error("La importación se canceló. Puede existir un ID duplicado. No se escribió nada.")
        );
        tx.onerror = () => reject(tx.error || new Error("Falló la importación."));
        const stamp = typeof ArchivitoLocalGeneration === "object" &&
          typeof ArchivitoLocalGeneration.stamp === "function"
          ? ArchivitoLocalGeneration.stamp
          : r => r;
        try {
          for (const rec of resolved.toAdd) store.add(stamp(rec));
          for (const rec of resolved.toPut) store.put(stamp(rec));
        } catch (err) {
          tx.abort();
          reject(err);
        }
      });
    } finally {
      db.close();
    }
  }

  function blobToDataURL(blob) {
    if (!(blob instanceof Blob)) return Promise.reject(new Error("Falta una fotografía original."));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
      reader.readAsDataURL(blob);
    });
  }

  function dataToBlob(uri) {
    if (typeof uri !== "string" || !/^data:image\/(jpeg|png|webp|gif);base64,/i.test(uri)) {
      throw new Error("El respaldo contiene una imagen con formato inválido.");
    }
    const parts = uri.split(",", 2);
    const type = parts[0].slice(5, parts[0].indexOf(";"));
    const raw = atob(parts[1]);
    if (raw.length > 35 * 1024 * 1024) throw new Error("Una fotografía supera los 35 MB.");
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.codePointAt(i);
    return new Blob([bytes], { type });
  }

  function validateImage(file) {
    if (!(file instanceof Blob) || !ALLOWED_TYPES.has(file.type) ||
        file.size === 0 || file.size > 35 * 1024 * 1024) {
      throw new Error("Imagen inválida o mayor que 35 MB.");
    }
  }

  async function thumbnail(file) {
    const image = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 540 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) => canvas.toBlob(
        value => value ? resolve(value) : reject(new Error("No se pudo crear la miniatura.")),
        "image/jpeg",
        0.78
      ));
    } finally {
      image.close();
    }
  }

  function download(data, name) {
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function readLastExportAt() {
    try {
      return localStorage.getItem(PLAN.LAST_EXPORT_KEY);
    } catch {
      return null;
    }
  }

  function saveLastExportAt(iso) {
    try {
      localStorage.setItem(PLAN.LAST_EXPORT_KEY, iso);
    } catch {
      // Almacenamiento local restringido; el respaldo exportado sigue siendo válido.
    }
  }

  async function inspectStorage(incomingBytes = 0) {
    let usage = null;
    let quota = null;
    let persisted = null;
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        if (Number.isFinite(est?.usage) && Number.isFinite(est?.quota)) {
          usage = est.usage;
          quota = est.quota;
        }
      }
      if (navigator.storage?.persisted) {
        persisted = Boolean(await navigator.storage.persisted());
      }
    } catch {
      // Navegador sin API StorageManager disponible.
    }
    return PLAN.assessStorage({
      usage,
      quota,
      persisted,
      lastExportAt: readLastExportAt(),
      incomingBytes
    });
  }

  async function readRecordsIfPresent() {
    if (typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      if (!dbs.some(d => d.name === DB_NAME)) return [];
    }
    return allRecords();
  }

  async function refreshDiagnostics() {
    const diag = $("#storage-diag");
    if (!diag) return;
    try {
      const records = await readRecordsIfPresent();
      const pages = records.reduce((sum, r) => sum + (Array.isArray(r.pages) && r.pages.length ? r.pages.length : 1), 0);
      const bytes = records.reduce((sum, r) => sum + PLAN.estimateRecordBytes(r), 0);
      $("#diag-collection").textContent = `${records.length} recuerdos · ${pages} hojas (~${PLAN.formatBytes(bytes)})`;

      const state = await inspectStorage(0);
      $("#diag-quota").textContent = state.hasQuota
        ? `${PLAN.formatBytes(state.usage)} / ${PLAN.formatBytes(state.quota)} (${Math.round(state.usageRatio * 100)} %)`
        : "No informada por el navegador";
      let persistedLabel = "No informada";
      if (state.persisted === true) persistedLabel = "Concedida";
      else if (state.persisted === false) persistedLabel = "No garantizada";
      $("#diag-persisted").textContent = persistedLabel;
      $("#diag-last-export").textContent = state.lastExportAt
        ? `${state.lastExportAt.slice(0, 10)} (hace ${state.daysSinceBackup} días)`
        : "Sin respaldo v4 registrado";

      diag.classList.toggle("critical", state.level === "critical");
      const list = $("#diag-warnings");
      list.replaceChildren();
      for (const text of state.warnings) {
        const li = document.createElement("li");
        li.textContent = text;
        list.append(li);
      }
      list.hidden = state.warnings.length === 0;
    } catch {
      $("#diag-collection").textContent = "No disponible";
    }
  }

  function clearPreview() {
    const box = $("#import-preview");
    if (!box) return;
    box.hidden = true;
    $("#preview-summary").textContent = "";
    const list = $("#preview-conflicts");
    list.replaceChildren();
    list.hidden = true;
  }

  function describePolicyEffect(classification, policy) {
    if (!classification.conflictCount) {
      return `Se agregarán ${classification.newCount} recuerdos nuevos.`;
    }
    if (policy === "abort") {
      return "Con la política actual («Cancelar»), la importación se detendrá sin escribir cambios.";
    }
    if (policy === "skip") {
      return `Se agregarán ${classification.newCount} nuevos y se omitirán ${classification.conflictCount} repetidos.`;
    }
    if (policy === "duplicate") {
      return `Se agregarán ${classification.newCount} nuevos y ${classification.conflictCount} copias con nuevo ID (sin pisar existentes).`;
    }
    return `Se agregarán ${classification.newCount} nuevos y se reemplazarán ${classification.conflictCount} existentes.`;
  }

  function renderPreview(classification, policy, storage) {
    const box = $("#import-preview");
    const quotaNote = storage.hasQuota
      ? ` Espacio libre estimado: ${PLAN.formatBytes(storage.availableBytes)}.`
      : "";
    $("#preview-summary").textContent =
      `Respaldo verificado (SHA-256 OK): ${classification.totalIncoming} recuerdos ` +
      `(${classification.totalPages} hojas, ~${PLAN.formatBytes(classification.estimatedBytes)}). ` +
      `Nuevos: ${classification.newCount} · Conflictos por ID: ${classification.conflictCount}. ` +
      describePolicyEffect(classification, policy) + quotaNote;
    const list = $("#preview-conflicts");
    list.replaceChildren();
    for (const conflict of classification.conflicts) {
      const li = document.createElement("li");
      li.textContent =
        `ID repetido: «${conflict.incomingTitle}» (${conflict.incomingPages} h.) ` +
        `coincide con el recuerdo local «${conflict.existingTitle}» (${conflict.existingPages} h.).`;
      list.append(li);
    }
    if (storage.quotaWarning) {
      const li = document.createElement("li");
      li.textContent = `Advertencia de cuota: ${storage.quotaWarning}`;
      list.append(li);
    }
    list.hidden = list.children.length === 0;
    box.hidden = false;
  }

  async function decodeAndVerifyV4(file, password) {
    if (!file || file.size < 64 || file.size > MAX_FILE) {
      throw new Error("Seleccioná un respaldo v4 válido menor que 250 MB.");
    }
    tell("Descifrando y verificando todas las fotografías… No se escribieron datos todavía.");
    const encrypted = JSON.parse(await file.text());
    const payload = await CRYPTO.decrypt(encrypted, password);
    if (!payload || payload.format !== "archivito-v4-payload" ||
        payload.version !== 4 || payload.sourceFormat !== ARCHIVE.FORMAT ||
        !Array.isArray(payload.records) || !Array.isArray(payload.manifest) ||
        payload.records.length !== payload.manifest.length ||
        payload.records.length > 1000) {
      throw new Error("Contenido de respaldo v4 inválido.");
    }
    const restored = [];
    const ids = new Set();
    for (let i = 0; i < payload.records.length; i++) {
      const record = await ARCHIVE.decode(
        payload.records[i],
        ARCHIVE.FORMAT,
        dataToBlob,
        validateImage,
        thumbnail
      );
      if (ids.has(record.id)) throw new Error("El respaldo contiene IDs duplicados.");
      ids.add(record.id);
      await CRYPTO.verifyManifest(record, payload.manifest[i]);
      restored.push(record);
    }
    return restored;
  }

  function formatImportSummary(resolved) {
    const details = [];
    if (resolved.copied) details.push(`${resolved.copied} copias nuevas`);
    if (resolved.replaced) details.push(`${resolved.replaced} reemplazados`);
    if (resolved.skipped) details.push(`${resolved.skipped} omitidos`);
    const suffix = details.length ? ` (${details.join(", ")})` : "";
    return `Restauración v4 exitosa: ${resolved.added} recuerdos nuevos${suffix}. ` +
      "Todos los originales y derivados pasaron la verificación SHA-256.";
  }

  async function withBusy(buttons, action) {
    for (const btn of buttons) if (btn) btn.disabled = true;
    try {
      await action();
    } catch (error) {
      console.error("Respaldo v4:", error.name || "Error");
      tell(error.message || "Error al procesar el respaldo.", true);
    } finally {
      for (const btn of buttons) if (btn) btn.disabled = false;
    }
  }

  $("#export-form").addEventListener("submit", event => {
    event.preventDefault();
    void withBusy([$("#export-button")], async () => {
      const first = $("#export-password");
      const again = $("#export-confirm");
      const password = first.value;
      try {
        if (password !== again.value) throw new Error("Las contraseñas no coinciden.");
        if ([...password].length < 12) throw new Error("Usá al menos 12 caracteres.");
        tell("Preparando imágenes, hashes y cifrado… El navegador puede necesitar unos segundos.");
        const records = await allRecords();
        const serialized = [];
        const manifest = [];
        if (records.length > 1000) throw new Error("Demasiados recuerdos para un solo respaldo.");
        for (const record of records) {
          const normalized = ARCHIVE.normalize(record);
          manifest.push(await CRYPTO.manifestFor(normalized));
          serialized.push(await ARCHIVE.encode(normalized, blobToDataURL));
        }
        const nowIso = new Date().toISOString();
        const payload = {
          format: "archivito-v4-payload",
          version: 4,
          sourceFormat: ARCHIVE.FORMAT,
          exportedAt: nowIso,
          records: serialized,
          manifest
        };
        const sealed = await CRYPTO.encrypt(payload, password);
        download(sealed, `archivito-${nowIso.slice(0, 10)}-cifrado-v4.archivito`);
        saveLastExportAt(nowIso);
        await refreshDiagnostics();
        tell(
          `Respaldo cifrado v4 exportado: ${records.length} recuerdos. ` +
          "Conservalo fuera del navegador y guardá la contraseña por separado."
        );
      } finally {
        first.value = "";
        again.value = "";
      }
    });
  });

  $("#preview-button").addEventListener("click", () => {
    void withBusy([$("#preview-button"), $("#import-button")], async () => {
      const file = $("#backup-file").files?.[0];
      const passwordField = $("#import-password");
      const policy = $("#conflict-policy").value;
      const password = passwordField.value;
      clearPreview();
      try {
        const incoming = await decodeAndVerifyV4(file, password);
        const existing = await readRecordsIfPresent();
        const classification = PLAN.classifyImport(existing, incoming);
        const storage = await inspectStorage(classification.estimatedBytes);
        renderPreview(classification, policy, storage);
        tell(
          `Vista previa lista: ${classification.newCount} nuevos, ${classification.conflictCount} conflictos por ID ` +
          `(~${PLAN.formatBytes(classification.estimatedBytes)}). No se escribió ningún cambio.`
        );
      } finally {
        passwordField.value = "";
      }
    });
  });

  $("#import-form").addEventListener("submit", event => {
    event.preventDefault();
    void withBusy([$("#preview-button"), $("#import-button")], async () => {
      const file = $("#backup-file").files?.[0];
      const passwordField = $("#import-password");
      const policy = $("#conflict-policy").value;
      const password = passwordField.value;
      clearPreview();
      try {
        const incoming = await decodeAndVerifyV4(file, password);
        const existing = await readRecordsIfPresent();
        const classification = PLAN.classifyImport(existing, incoming);
        const resolved = PLAN.resolveImportPlan(classification, policy, makeId);
        const storage = await inspectStorage(resolved.writeBytes);
        if (storage.quotaExceeds) {
          throw new Error(
            `Espacio insuficiente para restaurar (~${PLAN.formatBytes(resolved.writeBytes)} requeridos; ` +
            `${PLAN.formatBytes(storage.availableBytes)} disponibles). No se escribió ningún cambio.`
          );
        }
        await applyPlanAtomically(resolved);
        await refreshDiagnostics();
        tell(formatImportSummary(resolved));
      } finally {
        passwordField.value = "";
      }
    });
  });

  $("#diag-persist").addEventListener("click", () => {
    void withBusy([$("#diag-persist")], async () => {
      if (!navigator.storage?.persist) {
        tell("Este navegador no ofrece la solicitud de almacenamiento persistente.", true);
        return;
      }
      const granted = await navigator.storage.persist();
      await refreshDiagnostics();
      tell(
        granted
          ? "Persistencia concedida por el navegador. Aun así, mantené respaldos externos."
          : "El navegador no concedió persistencia. Conservá respaldos v4 fuera del navegador."
      );
    });
  });

  void refreshDiagnostics();
})();
