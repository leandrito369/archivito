# CLOUD-03.2B — Cola persistente sintética

Base separada archivito-sync-fixture-queue-v1, no toca nuestro-archivo-cartas-v1. Guarda únicamente sobres cifrados de fixture, contexto técnico y estado. No guarda claves, títulos, notas ni errores arbitrarios. El namespace usuario/archivo/huella separa operaciones en la lógica; IndexedDB es accesible al código del mismo origen, no es una frontera de autorización. No se integra con la biblioteca ni se expone en dist en este corte.

## Máquina de estados
pending -> uploading (claim transaccional, token aleatorio, lease 60 s) -> synced, conflict o error. error -> pending por decisión explícita. Lease vencido permite reclamar mismo paquete y operación. finish exige token vigente; un worker anterior no puede confirmar luego de otro claim. Reintento exacto, sin volver a cifrar. Sólo synced se puede podar explícitamente. Conflicto conserva paquete; resolución UI y descarga aún pendientes. Máximo un trabajo sin sincronizar por recuerdo/ámbito y límite global de 32 operaciones / 64 MiB de bytes cifrados (no equivale a cuota del navegador). Transacciones IndexedDB confirman antes de informar éxito. No borra recuerdos originales. Tiempo local y lease sirven para disponibilidad, no seguridad; reloj incorrecto puede demorar o duplicar intentos, la idempotencia remota futura es obligatoria.

## Pruebas
tests/test_sync_queue.py usa Chromium real vía Playwright en CI browser-smoke: recarga y namespace, fallo posterior al commit + replay, dos conexiones de IndexedDB y expiración, conflicto conservado y rechazo de campos extra. No se prueba persistencia física tras reinicio del SO, Firefox/iOS, agotamiento real de cuota o API remota. El simulador no es una frontera de seguridad. No habilitar sincronización de producción.

## Próximo corte
Adaptador de Storage inmutable + API de confirmación autorizada, verificación de recibos, prueba negativa por REST/Storage, ciclo de reconexión/sesión, reconciliación y conflictos. Custodia/rotación definitiva y respaldo v4 siguen pendientes. No habilitar INSERT ni Storage remoto. PR apilado sobre #24.
