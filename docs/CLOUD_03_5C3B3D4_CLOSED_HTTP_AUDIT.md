# CLOUD-03.5C3B3D.4 — Auditoría cerrada y certificación HTTP negativa
Fecha: 2026-11-26. Relacionado #15. Base #53, f86872a718df9aa568065df4140e8255f4960157, CI 3/3 aprobada. PR #54.

## Evidencia real (Edge v1)
Workflow HTTP #1, run 45840338958, job 139980004929, SHA ef20b6209a38814d1d6db142d30b0584591bd243, success. Logs 14:34:20–21 UTC:
| Caso | Esperado | Observado |
|---|---:|---:|
| preflight | 204 | 204 |
| no_token | 401 | 401 |
| invalid_token | 403 | 403 |
| wrong_origin | 403 | 403 |
| wrong_method | 405 | 405 |

Se verificaron cuerpo genérico para rechazos, CORS y no-store. El preflight no es autenticación. No se usaron credenciales válidas ni IDs de recuerdos. El runner resolvió el bloqueo DNS del entorno anterior. Son pruebas de v1, no del candidato #53 ni de un JWT auténtico.

## Auditoría remota
Inspección previa: Edge v1 activa, verify_jwt=false, getUser en código desplegado; bucket privado 4 MiB, MIME octet-stream; 8 tablas RLS, sin acceso CRUD cliente; RPC legacy invoker sólo service_role entre roles API. Las tres políticas storage.objects no incluyen bucket incremental. SQL real: service_role begin/commit/head/intent rechazados por disabled; authenticated RPC/tabla por permisos. Avisos: RLS sin política (8 INFO, esperado mientras cerrado), leaked password protection (1 WARN, revisar aparte).
Consulta posterior a sondas (26/11/2026): open_gates=0, operations=0, heads=0, objects=0, CHECK (NOT enabled), esquema candidato ausente. No mutaciones, migraciones, despliegue ni apertura.

## Preparación A/B/C con sesiones auténticas (no ejecutada)
Precondiciones: operador identifica un archivo exclusivamente sintético con gate cerrado; cuentas de prueba A owner/B editor/C no miembro, sesiones genuinas obtenidas por su flujo de login habitual, sin emplear identidades personales. Validar membresía y gate por lectura administrativa sin exportar IDs. No crear cuentas, archivos, membresías ni gates en este PR. Si no existe fixture dedicado, detenerse: provisionamiento requiere autorización aparte.
- Ejecutar en terminal local interactiva, desde el checkout del candidato, `python3 tests/remote/probe_incremental_authenticated_closed.py` por cada rol.
- Introducir confirmación CLOSED, etiqueta, UUID del archivo sintético, publishable key y access JWT de corta duración mediante entrada oculta; no usar refresh token, service_role ni claves secretas; no pegar tokens en chat, commits, CI ni capturas. No escribirlos a archivos ni variables de entorno.
- El script verifica /auth/v1/user 200 y sub coincidente, luego solicita manifest de la memoria sintética fija. Esperado 403, cuerpo genérico, CORS y no-store. Sólo lectura, sin begin/commit/upload; sin proxy ni redirect. Imprime únicamente etiqueta, caso, código y pass. No devuelve datos de usuario.
- El resultado 403 por sí solo no discrimina gate, membresía u otro rechazo; correlacionar con auditoría de configuración/membresía. No se presenta esto como certificación de aislamiento con gate abierto.
- Detener si falla autenticación o si Edge devuelve algo inesperado; repetir inspección de gate y contadores después de cada sesión. No reintento automático. Adjuntar exclusivamente resultados agregados y fecha UTC.
- Revocación/expiración auténticas y candidato Edge con fence siguen pendientes; no usar tokens ajenos ni modificar sesiones reales.

## Gate de salida
Pendiente: archivo/roles sintéticos confirmados, pruebas auténticas A/B/C y evidencia postcondición, revisión del runtime candidato #53 en entorno aislado, permisos efectivos y procedimiento de rollback. Ninguna apertura autorizada. No promover ni mergear por estos resultados.
