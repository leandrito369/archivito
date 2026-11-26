# CLOUD-03.5C3B3D — Precondiciones de certificación HTTP autenticada

## Cierre técnico C3B3C (26/11/2026)
PR #51, SHA a3a772471b04a5a580a1e664ee2e39819408a2a6: workflows #79 (45831726569) y #43 (45831726617) success; 34 pruebas Python/navegador, incluyendo corrupción/expiración/cierre de página, y 4 Node específicas del adaptador incremental. No merge ni despliegue. La prueba simula expiración y transporte, no caída de proceso ni red real.

## Auditoría remota de sólo lectura
Observado el 26/11/2026: una fila de gate, cero gates habilitados, restricción CHECK (NOT enabled), cero operaciones/heads/objetos incrementales, bucket archivito-inc-private no público. Ocho tablas incrementales con RLS, sin permisos CRUD directos para anon/authenticated; sync_inc_step y sync_inc_inspect invoker, sólo service_role entre esos roles, guardas de gate presentes. Edge archivito-sync-incremental activa v1; verify_jwt=false en gateway, código repositorio valida getUser. Migraciones 20261126042001 y 20261126042455 registradas. No se probó HTTP real ni se auditó exhaustivamente el código remoto o la política efectiva de Storage. No JWT/credenciales ni datos personales en evidencia.

## Candidato aislado
- docs/sql/cloud_03_5c3b3d_cert_fence_candidate.sql: esquema de laboratorio independiente, no migración; sin grants a clientes/service_role ni apertura operacional. Ventana de hasta 15 minutos, archivo dedicado, dos actores diferentes, huella, tres memorias fijas, cuota hasta 64 MiB, hasta 24 operaciones/revisión 24. Parámetros de ejemplo conservadores, no definitivos.
- Claim con bloqueo de fila de ventana, scope/actor/digest/reserva inmutables por operación; takeover sólo tras vencimiento, generación monotónica y token emitido por PostgreSQL, renovación de 30 s acotada al vencimiento de ventana. Rechazo de token viejo incluso si operación coincide.
- assert_fence debe ejecutarse dentro de la misma transacción que la mutación/atestación/commit real. No se ha integrado con sync_inc_step/inspect, Edge ni cliente; no sustituye el hard gate. No confiar en el cliente para digest, bytes, identidad o rol; calcular/verificar en servicio y comprobar membresía actual, huella y sesión por cada acción.
- Storage externo no comparte transacción SQL: preservar create-only, ruta ligada a intención y hash, verificación de lectura; una carga en vuelo puede terminar tras cierre. No confirmar revisión fuera de fence, conservar staging/orphans, sin GC ni sobreescritura.
- tests/sql/cloud_03_5c3b3d_cert_fence_lab.sql: BEGIN/ROLLBACK en PostgreSQL desechable, fixtures aleatorios sin datos reales. Prueba cierre, expiración, scope, cuota, takeover y token obsoleto. No prueba concurrencia multisesión, autenticación ni Storage.
- Workflow incremental-cert-sql.yml: servicio postgres:17 aislado, sin acceso a secretos ni a Supabase; comprueba rollback. El password es exclusivamente de fixture de CI. No deployment.

## Gate de avance (bloqueante)
1. CI nueva aprobada, revisión de SQL y prueba multisesión (incluye carrera entre cierre, expiración y commit).
2. Diseñar integración transaccional real con RPC/Storage, demostrar CAS/receipt idempotente, recuperación de claim/recibo perdido, y no bypass por rutas legacy. Verificar roles y revocación actual, calcular reserva desde wire validado. Evitar alterar el gate hasta contar con autorización explícita.
3. Preparar archivo/identidades de certificación dedicados y origen HTTPS permitido o localhost controlado, sin datos personales. Probar rechazo HTTP de JWT ausente/inválido y de usuarios autorizados mientras el gate real esté cerrado. CORS no es autorización. Validar todas las políticas Storage y permisos efectivos.
4. Aprobar una ventana acotada, operador y procedimiento de cierre; sólo entonces preparar migración revisada y despliegue de candidato. Ningún script de este PR realiza esa apertura.
5. Ejecutar matriz A/B/C/D en documentación C3B3C, cerrar gate y comprobar rechazo posterior. Sólo después iniciar C3B3E.

Estado: C3B3D iniciado, certificación HTTP real pendiente. No cambio persistente en Supabase, no merge, no despliegue ni acceso a biblioteca personal.

## Incremento de integración multisesión (PR #52)
La primera revisión 9390070fd7c16b9c5c2bafab7f415373d4cb02b7 aprobó SQL #1 (45833118527): NOTICE PASS y rollback confirmado; Pages #44 (45833118659) success. La CI del nuevo SHA debe volver a aprobarse.

- Candidato fenced_rpc: claim_begin y fenced_step llaman al sync_inc_step existente en la misma transacción; guardas antes y después de la mutación. El digest JSONB y la reserva se calculan del wire, no de números enviados por el cliente. La validación completa de wire y la identidad de sesión fresca siguen siendo obligación del futuro Edge. Una sola ventana por archivo en el candidato (sin renovación entre ventanas).
- PostgreSQL multisesión desechable: carga el SQL original de la RPC y del catálogo, con relaciones mínimas de archives/members/Storage ficticias. Sólo dentro de ese contenedor se elimina la restricción hard-closed para ensayar la transacción; jamás contra Supabase. El rol de prueba es administrador del contenedor, no demuestra permisos de ejecución real del futuro wrapper. Sin grants nuevos a service_role.
- Pruebas con conexiones independientes y barrera de espera comprobada en pg_stat_activity: cierre antes de commit, commit antes de cierre, expiración mientras RPC espera lock (rollback de mutación), takeover y token obsoleto, dos revisiones competidoras, replay, revocación de membresía y rollback de reserva ante fallo de begin.
- La serialización se define por locks de ventana/fence/gate. Un commit que obtiene los locks y supera guardas antes de cierre puede terminar antes de que el cierre se linealice; no se promete que el cierre cancele una transacción ya autorizada ni que la hora física de COMMIT preceda exactamente el vencimiento. La expiración durante el trabajo del core se revalida antes de devolver el resultado. Storage externo no está transaccionado; se usan sólo metadatos ficticios.
- Antes de un despliegue: cerrar bypass de RPC legacy (no basta wrapper), integrar inspect/lecturas y acciones Storage, sesión/revocación, entrega/recuperación del token, protocolo cliente, privilegios mínimos, autorización de apertura y E2E real. Este candidato no es una migración ni una versión desplegable.
