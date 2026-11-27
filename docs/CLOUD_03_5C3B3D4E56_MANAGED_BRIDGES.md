# CLOUD-03.5C3B3D.4E.5.6 — Integración y recertificación de puentes privados no-superuser
Fecha 2026-11-27 ART. Base certificada: PR #60 (`8d691b0`), CI 6/6 y SonarQube PASS. Este corte integra en el candidato SQL los puentes privados compatibles con el rol administrador no-superuser de Supabase (`postgres`) y los somete a recertificación integral en laboratorio local. **No autoriza cambios en entorno hosted ni apertura de gate/ventana.**

## 1. Cambios exactos en el candidato SQL (`cloud_03_5c3b3d3_http_acl_candidate.sql`)
- **Cero privilegios ni políticas RLS sobre esquemas managed (`auth`, `storage`) para `archivito_cert_executor`:**
  - Se retiró `USAGE` sobre `auth` y `storage`, `SELECT/UPDATE` sobre `auth.sessions`, `SELECT` sobre `storage.objects` y las 4 políticas RLS sobre `auth.sessions` y `storage.objects`.
  - Se conservan intactas las políticas restrictivas `inc_cert_exec_no_mutation` sobre `public.archives`, `public.archive_members`, `archivito_inc.gates` y `archivito_inc_cert_candidate.windows`.
- **Dos puentes privados mínimos `SECURITY DEFINER` (owner: administrador que despliega / `postgres`, `search_path = ''`, sin SQL dinámico ni exposición de filas):**
  - `archivito_inc_cert_candidate.lock_session(p_actor uuid, p_session uuid) returns void`: verifica `id`, `user_id` y `(not_after is null or not_after > clock_timestamp())` con `FOR SHARE` dentro de la misma transacción; si no coincide lanza `42501 certification session denied`.
  - `archivito_inc_cert_candidate.object_matches(p_path text, p_size bigint) returns boolean`: valida formato estricto `uuid/uuid/uuid/[0-8]`, rango `1..4194304` y existencia/tamaño exactos en el bucket fijo `'archivito-inc-private'`.
  - `EXECUTE` revocado de `PUBLIC`, `anon`, `authenticated` y `service_role`; otorgado exclusivamente a `archivito_cert_executor`.
- **Cambio quirúrgico verificado en `public.sync_inc_step`:**
  - Bloque de instalación anclado al MD5 exacto del `prosrc` baseline (`2ba9746fdc9d7ae955832f7c07bf1ead`), reemplaza únicamente los dos predicados `exists(select 1 from storage.objects ...)` por `archivito_inc_cert_candidate.object_matches(b.path,b.bytes)` y exige el MD5 resultante exacto (`d010b597b7cc21cae66b9fa09d01e3d0`) antes de aplicar `CREATE OR REPLACE FUNCTION`. Ante cualquier drift del core, aborta la transacción.
  - En rollback (`E.5`), se restaura el `public.sync_inc_step` original (`2ba9746fdc9d7ae955832f7c07bf1ead`) antes de ejecutar `DROP FUNCTION ... RESTRICT` sobre `object_matches` y `lock_session`, verificando restauración bit-a-bit del catálogo baseline.
- **Transferencia de ownership de `dispatch` compatible con no-superuser:**
  - Otorga temporalmente `CREATE` sobre `archivito_inc_cert_candidate` a `archivito_cert_executor` y membresía temporal `WITH SET TRUE` al administrador no-superuser, ejecuta `ALTER FUNCTION ... dispatch(...) OWNER TO archivito_cert_executor` y revoca inmediatamente ambos privilegios en la misma transacción.

## 2. Garantías verificadas en la recertificación (CI)
1. **Despliegue real no-superuser (`test_incremental_cert_acl.py` y `E.5`):** ejecución íntegra del candidato SQL bajo un rol `NOSUPERUSER / CREATEROLE / BYPASSRLS` sin `WITH GRANT OPTION` en `auth` ni `auth.sessions`, verificando `dispatch` con owner `archivito_cert_executor`, puentes con owner admin, cero `SET` residual, cero `CREATE` residual y cero políticas en `auth`/`storage`.
2. **Concurrencia real `logout` vs `lock_session` (`test_incremental_closed_admin_acl.py` y `E.5` con GoTrue real):** serialización en ambos sentidos; un `POST /auth/v1/logout?scope=local` real espera mientras `lock_session` sostiene `FOR SHARE`, completa al liberar y la siguiente invocación rechaza con `certification session denied`.
3. **Expiración bajo espera de lock (`test_incremental_closed_admin_acl.py`):** si `auth.sessions.not_after` vence mientras `lock_actor_context` espera el lock del gate, `lock_session` rechaza con `certification session denied`.
4. **Storage positivo y negativo real (`test_incremental_cert_acl.py` y `E.5` con Supabase Storage real):** `object_matches` devuelve `true` para un objeto real de 32 bytes en `archivito-inc-private` y `false` ante tamaño distinto, rango inválido, otro bucket, traversal o índice fuera de `0..8`; limpieza verificada (`Storage` vacío).
5. **Regresión completa de stack cerrado (`E.3`, `E.4`, `E.5`, runtime cerrado Deno+PG y multisesión SQL):** promoción doble + rollback doble con catálogo exacto restaurado y gate físico intacto (`CHECK (NOT enabled)`).

## 3. Límites vigentes (NO-GO hosted hasta autorización separada)
- Este corte resuelve el bloqueo de privilegios managed en SQL, pero **no** sustituye la validación de cutover same-slug en Supabase Hosted, backup/PITR verificado, allowlist CORS de dominio final ni la autorización explícita de promoción y apertura de Fase F.
