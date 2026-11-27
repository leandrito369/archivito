# Manifiesto de retiro de prototipos y laboratorios — Archivito

**Fecha:** 2026-11-27  
**Corte:** Consolidación de línea Cloud (`E.5.6`, SHA `78da4b1`) sobre `main` (`fd3a1f6`, con `0.4A.1` respaldo cifrado v4 y ADR-0003).  
**Regla de trazabilidad:** las 38 actas `docs/CLOUD_*.md` permanecen intactas. Todos los archivos retirados siguen siendo recuperables de forma inmutable desde el historial Git mediante `git show <SHA>:<ruta>`.

> **Alcance:** esta limpieza afecta únicamente al repositorio Git y al build estático `dist/`. **No** elimina ni modifica funciones Edge, tablas ni configuraciones existentes en Supabase Hosted ni en Cloudflare; cualquier retiro remoto requiere inventario y autorización independientes.

---

## 1. Archivos retirados del árbol activo (40 archivos)

### Generación 1 — Fixture (`CLOUD-03.1` a `CLOUD-03.3D`, 16 archivos)

| Archivo retirado | Generación | SHA histórico | PR de origen | Sustitución vigente | Justificación |
|---|---|---|---|---|---|
| `app/sync-contract.mjs` | Gen 1 — Fixture | `d9f7a69` | PR #23 (`CLOUD-03.1`) | `app/sync-incremental.mjs` | Contrato inicial de carta ficticia superado por el contrato incremental de activos inmutables |
| `app/sync-queue.mjs` | Gen 1 — Fixture | `7a1a2e1` | PR #25 (`CLOUD-03.2B`) | `app/sync-incremental-local.mjs` | Cola prototipo de fixture reemplazada por la cola durable incremental |
| `app/sync-storage-adapter.mjs` | Gen 1 — Fixture | `95bde7d` | PR #26 (`CLOUD-03.3A`) | `app/sync-incremental-remote.mjs` | Adaptador de Storage fixture reemplazado por transporte incremental |
| `app/sync-fixture-read.mjs` | Gen 1 — Fixture | `fd7a1bc` | PR #29 (`CLOUD-03.3D`) | `app/sync-incremental-remote.mjs` | Lectura de muestra única superada por catálogo y descarga incremental |
| `app/sync-fixture-ui.mjs` | Gen 1 — Fixture | `fd7a1bc` | PR #29 (`CLOUD-03.3D`) | Retirado del bundle público | Panel experimental en `acceso.html` sin uso en producción |
| `server/sync-fixture-service.mjs` | Gen 1 — Fixture | `51af514` | PR #27 (`CLOUD-03.3B`) | `server/sync-incremental-fenced-service.mjs` | Servicio servidor inicial superado por servicio incremental con fencing |
| `supabase/functions/archivito-sync-fixture/index.ts` | Gen 1 — Fixture | `60dbd24` | PR #28 (`CLOUD-03.3C`) | `supabase/functions/archivito-sync-incremental/index.ts` | Edge Function prototipo superada por la Edge incremental |
| `supabase/functions/archivito-sync-fixture/sync-fixture-service.mjs` | Gen 1 — Fixture | `60dbd24` | PR #28 (`CLOUD-03.3C`) | `server/sync-incremental-fenced-service.mjs` | Copia local del servicio fixture superada por el servicio incremental |
| `docs/sql/cloud_03_3c_fixture_backend.sql` | Gen 1 — Fixture | `60dbd24` | PR #28 (`CLOUD-03.3C`) | `docs/sql/cloud_03_5c3b2a_closed_rpc.sql` | DDL de prototipo fixture retirado para evitar aplicación accidental |
| `docs/sql/cloud_03_3c_service_privileges.sql` | Gen 1 — Fixture | `824293b` | PR #28 (`CLOUD-03.3C`) | `docs/sql/cloud_03_5c3b3d3_http_acl_candidate.sql` | ACL de prototipo fixture sustituida por el candidato con puentes privados |
| `tests/test_sync_contract.mjs` | Gen 1 — Fixture | `d9f7a69` | PR #23 (`CLOUD-03.1`) | `tests/test_sync_incremental.mjs` | Prueba unitaria de módulo retirado |
| `tests/test_sync_queue.py` | Gen 1 — Fixture | `7a1a2e1` | PR #25 (`CLOUD-03.2B`) | `tests/test_sync_incremental_local.py` | Prueba Playwright de cola prototipo retirada |
| `tests/test_sync_storage_adapter.mjs` | Gen 1 — Fixture | `95bde7d` | PR #26 (`CLOUD-03.3A`) | `tests/test_sync_incremental_remote.mjs` | Prueba unitaria de adaptador retirado |
| `tests/test_sync_fixture_read.mjs` | Gen 1 — Fixture | `fd7a1bc` | PR #29 (`CLOUD-03.3D`) | `tests/test_sync_incremental_remote.mjs` | Prueba unitaria de lector fixture retirado |
| `tests/test_sync_fixture_service.mjs` | Gen 1 — Fixture | `51af514` | PR #27 (`CLOUD-03.3B`) | `tests/test_sync_incremental_service.mjs` | Prueba unitaria de servicio servidor retirado |
| `tests/sql/cloud_03_2_transaction_lab.sql` | Gen 1 — Fixture | `f243f43` | PR #24 (`CLOUD-03.2A`) | `tests/sql/cloud_03_5c3a2_incremental_transaction_lab.sql` | Ensayo SQL de etapa fixture superado por laboratorio incremental |

### Generación 2 — Sync v3 bloques completos (`CLOUD-03.4A` a `CLOUD-03.5B`, 22 archivos)

| Archivo retirado | Generación | SHA histórico | PR de origen | Sustitución vigente | Justificación |
|---|---|---|---|---|---|
| `app/sync-v3-identity.mjs` | Gen 2 — Sync v3 | `a278821` | PR #31 / #39 (`CLOUD-03.4B`–`4D4B`) | `app/sync-incremental-local.mjs` | Mapa de identidad v3 monolítico superado por modelo incremental |
| `app/sync-v3-revisions.mjs` | Gen 2 — Sync v3 | `3a69993` | PR #31 (`CLOUD-03.4B`) | `app/sync-incremental-transport.mjs` | Reconciliación v3 de paquete completo reemplazada por delta incremental |
| `app/sync-v3-outbox.mjs` | Gen 2 — Sync v3 | `a278821` | PR #33 / #39 (`CLOUD-03.4C2`–`4D4B`) | `app/sync-incremental-local.mjs` | Outbox v3 monolítico reemplazado por outbox incremental |
| `app/sync-v3-pull.mjs` | Gen 2 — Sync v3 | `a278821` | PR #34 / #39 (`CLOUD-03.4C3`–`4D4B`) | `app/sync-incremental-local.mjs` | Pull v3 monolítico superado por recuperación incremental |
| `app/sync-v3-wire.mjs` | Gen 2 — Sync v3 | `5b65e56` | PR #35 (`CLOUD-03.4D1`) | `app/sync-incremental-wire.mjs` | Formato wire v3 completo reemplazado por `archivito-incremental-wire-v1` |
| `app/sync-v3-remote.mjs` | Gen 2 — Sync v3 | `2b3313c` | PR #38 / #41 (`CLOUD-03.4D4A`–`5B`) | `app/sync-incremental-remote.mjs` | Adaptador HTTP v3 reemplazado por adaptador HTTP incremental |
| `app/sync-v3-lab.mjs` | Gen 2 — Sync v3 | `2b3313c` | PR #39 / #41 (`CLOUD-03.4D4B`–`5B`) | `app/sync-incremental-lab.mjs` | Runner de laboratorio v3 reemplazado por runner incremental |
| `app/sync-v3-lab-ui.mjs` | Gen 2 — Sync v3 | `2b3313c` | PR #39 / #41 (`CLOUD-03.4D4B`–`5B`) | Retirado del bundle público | Panel v3 en `acceso.html` retirado de la superficie entregable |
| `server/sync-v3-service.mjs` | Gen 2 — Sync v3 | `2db0bfd` | PR #37 (`CLOUD-03.4D3`) | `server/sync-incremental-fenced-service.mjs` | Servicio servidor v3 reemplazado por servicio incremental con fencing |
| `supabase/functions/archivito-sync-v3/index.ts` | Gen 2 — Sync v3 | `2db0bfd` | PR #37 (`CLOUD-03.4D3`) | `supabase/functions/archivito-sync-incremental/index.ts` | Edge Function v3 superada por Edge incremental |
| `docs/sql/cloud_03_4d3_v3_backend.sql` | Gen 2 — Sync v3 | `3af8fbc` | PR #37 (`CLOUD-03.4D3`) | `docs/sql/cloud_03_5c3b2a_closed_rpc.sql` | DDL backend v3 retirado para evitar despliegue accidental |
| `docs/sql/cloud_03_4d4b_acceptance_scope.sql` | Gen 2 — Sync v3 | `1fafc9e` | PR #39 (`CLOUD-03.4D4B`) | `docs/sql/cloud_03_5c3b3d_cert_fence_candidate.sql` | Ventana de alcance v3 superada por candidato incremental |
| `tests/test_sync_v3_identity.py` | Gen 2 — Sync v3 | `3a69993` | PR #31 (`CLOUD-03.4B`) | `tests/test_sync_incremental_local.py` | Prueba Playwright de módulo retirado |
| `tests/test_sync_v3_lab.py` | Gen 2 — Sync v3 | `1fafc9e` | PR #39 (`CLOUD-03.4D4B`) | `tests/test_sync_incremental_local.py` | Prueba de laboratorio v3 retirada |
| `tests/test_sync_v3_outbox.py` | Gen 2 — Sync v3 | `7480f6e` | PR #33 (`CLOUD-03.4C2`) | `tests/test_sync_incremental_local.py` | Prueba de outbox v3 retirada |
| `tests/test_sync_v3_pull.py` | Gen 2 — Sync v3 | `5b009d5` | PR #34 (`CLOUD-03.4C3`) | `tests/test_sync_incremental_local.py` | Prueba de pull v3 retirada |
| `tests/test_sync_v3_remote.mjs` | Gen 2 — Sync v3 | `eabef7d` | PR #38 / #41 (`CLOUD-03.4D4A`–`5B`) | `tests/test_sync_incremental_remote.mjs` | Prueba unitaria de adaptador v3 retirada |
| `tests/test_sync_v3_revisions.mjs` | Gen 2 — Sync v3 | `3a69993` | PR #31 (`CLOUD-03.4B`) | `tests/test_sync_incremental_transport.mjs` | Prueba unitaria de reconciliación v3 retirada |
| `tests/test_sync_v3_service.mjs` | Gen 2 — Sync v3 | `2db0bfd` | PR #37 (`CLOUD-03.4D3`) | `tests/test_sync_incremental_service.mjs` | Prueba unitaria de servicio v3 retirada |
| `tests/test_sync_v3_wire.mjs` | Gen 2 — Sync v3 | `5b65e56` | PR #35 (`CLOUD-03.4D1`) | `tests/test_sync_incremental_wire.mjs` | Prueba unitaria de wire v3 retirada |
| `tests/sql/cloud_03_4d2_v3_transaction_lab.sql` | Gen 2 — Sync v3 | `1fc3e76` | PR #36 (`CLOUD-03.4D2`) | `tests/sql/cloud_03_5c3a2_incremental_transaction_lab.sql` | Laboratorio SQL v3 reemplazado por laboratorio incremental |
| `tests/sql/cloud_03_5a_v3_acceptance_rls.sql` | Gen 2 — Sync v3 | `c4ecc87` | PR #40 (`CLOUD-03.5A`) | `tests/sql/test_incremental_cert_acl.py` | Prueba RLS v3 superada por certificación ACL incremental |

### Interfaces de laboratorio retiradas de la superficie pública (`CLOUD-02.1`, 2 archivos)

| Archivo retirado | Generación | SHA histórico | PR de origen | Sustitución vigente | Justificación |
|---|---|---|---|---|---|
| `app/crypto-lab.html` | Laboratorio cripto | `64e0885` | PR #21 (`CLOUD-02.1`) | `tests/test_shared_crypto.mjs` | Página de pruebas manuales retirada del producto entregable `dist/` |
| `app/crypto-lab.js` | Laboratorio cripto | `26f4439` | PR #21 (`CLOUD-02.1`) | `app/shared-crypto.mjs` + `tests/test_shared_crypto.mjs` | Script de pruebas manuales retirado de `dist/` |

---

## 2. Módulos conservados deliberadamente

1. **Contrato compartido de validación (`app/sync-v3-contract.mjs` + `tests/test_sync_v3_contract.mjs`):**
   * Conservado sin renombrar porque `app/sync-incremental.mjs` importa `validateRecordMetadata` y `validateRecordCrop`, y los harnesses `E.3`/`E.4`/`E.5` empaquetan ese módulo al validar paridad contra la Edge Function v1 (`3e3f7eaf`).
2. **Herramientas locales de ingeniería retenidas provisionalmente hasta cerrar `D.4F` (excluidas físicamente de `dist/`):**
   * `app/sync-incremental-lab.mjs` (usado por `tests/test_sync_incremental_local.py`).
   * `app/sync-incremental-lab-ui.mjs` y `app/sync-v3-metrics.mjs` (desconectados de `app/auth-entry.js` y excluidos de `scripts/build-pages.mjs`; su retiro definitivo se evaluará tras completar `D.4F`).
3. **Suite SQL, Edge y actas históricas:**
   * Los 10 scripts SQL activos en `docs/sql/`, las 38 actas `docs/CLOUD_*.md` y los 10 workflows de CI permanecen íntegros.
