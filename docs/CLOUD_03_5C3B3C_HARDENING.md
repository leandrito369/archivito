# CLOUD-03.5C3B3C — Hardening y precondiciones de certificación remota

Base: PR #50, da1d8800d05783b3f36c24861e8b4740fdcb5266. Relacionado con #15.
Estado: candidato; no abrir gate, no migrar Supabase, no desplegar, no usar biblioteca personal.

## Cambios y límites
- Revalidar todos los bloques persistidos por tamaño, ruta, unicidad y SHA-256 antes de cualquier publicación, incluso replay; conservar el job si falla.
- Renovación serializada y comprobación de lease antes de I/O y al aceptar respuesta; token vencido o sustituido no confirma localmente. Recibo de conflicto ligado a operationId y revisión actual; recibo inválido conserva pendiente.
- El reloj es local; el cierre de página y avance de reloj controlado no equivalen a caída completa del navegador ni prueba de reloj hostil. IndexedDB no garantiza persistencia frente a borrado del perfil.
- El lease local NO es fencing distribuido. Una solicitud en vuelo puede llegar al servidor tras cancelación. CAS, inmutabilidad y recibo exacto reducen efectos del replay, no revocan una solicitud ya enviada.
- No se cambia la UI, el esquema SQL, el bucket, el servicio desplegado ni el gate. No GC.

## Gate de entrada a certificación remota (C3B3D, todos pendientes hasta evidencia)
1. CI verde sobre SHA exacto; revisar diff de PR apilado y logs sin datos privados.
2. Inventariar versión Edge, migraciones, bucket privado, grants/RLS y estado cerrado por lectura independiente; comprobar cierre mediante solicitud autenticada negativa antes de abrir.
3. Diseñar y revisar gate temporal server-side con expiración por reloj PostgreSQL, archivo de certificación exclusivo, allowlist de identidades A/B, tres IDs sintéticos fijos y límites de revisión/bytes/operaciones; aplicar guardas en cada RPC y acción Storage. Prohibir acceso directo cliente al bucket y a RPC privilegiadas. El tercero C no es miembro. CORS no sustituye autorización.
4. Demostrar fencing servidor o justificar formalmente una alternativa transaccional equivalente para efectos de escritura: generación monotónica por intención, comprobación en commit/attest y tratamiento de bloques inmutables en vuelo. No confiar en token de lease local ni en metadatos editables del usuario.
5. Probar cierre/expiración/revocación durante operación, concurrencia, límites y rechazo de scope incorrecto en SQL/servicio antes de autorizar la ventana. No cambiar gate en este PR.
6. Obtener autorización explícita para ventana y entorno de prueba; preparar rollback/cierre y operador responsable. Sólo muestras ficticias.

## Matriz E2E propuesta para C3B3D/E
- A propietario: publicar muestra pequeña, mediana multibloque y grande; verificar revisión, recibo, hashes y objetos únicos.
- B editor: recuperar y verificar, lectura fría/caliente, editar metadatos (cero nuevos activos), reemplazar reverso (un activo nuevo).
- C autenticado sin membresía y sesión ausente/expirada: rechazar manifest/catalog/download/begin/block/attest/commit; ninguna mutación.
- Dos ediciones concurrentes: un ganador por CAS, conflicto conservado, sin sobrescritura.
- Interrumpir durante bloque y tras commit antes de recibo; recargar y reintentar exactamente operationId/wire; confirmar una revisión y objetos sin duplicación.
- Cerrar gate al terminar o ante cualquier desviación; comprobar rechazo posterior, conservar evidencia agregada y no purgar.
- Evidencias: SHA, run IDs, timestamp UTC, rol ficticio, acción, resultado HTTP, recuentos y bytes agregados, duración; no tokens, claves, URLs firmadas, contenido ni identificadores personales.
- Benchmark real y expulsión de caché fuera del alcance de este corte.

## Pruebas nuevas
Chromium: cierre de página con job reclamado, takeover tras expiración simulada, rechazo del token viejo, corrupción de cola antes de red, corrupción de caché con rechazo de descarga corrupta y recuperación válida.
Node: pérdida de lease antes de nueva fase HTTP y rechazo de respuesta obsoleta; reintento exacto. Transporte simulado; no equivale a HTTP autenticado real.
