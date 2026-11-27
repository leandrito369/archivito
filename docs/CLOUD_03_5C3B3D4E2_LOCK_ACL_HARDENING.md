# D.4E.2 — Hardening de locks y privilegios del candidato
Fecha 2026-11-26. Continuación del PR #57 sobre #56. Sólo candidatos SQL en docs/sql y código Edge de rama draft; no migración ni instalación hosted. Gate real y gate del nuevo laboratorio permanecen hard closed.
## Defectos y correcciones D.4E.1
Run #2: Deno 2.5.6 deno check no acepta --cached-only; retirado sólo de check, preservado en ejecución. Run #3: TS2345 en Response(result as Uint8Array); comprobar instanceof y copiar a ArrayBuffer propio, con tamaño de descarga limitado por contrato. Typecheck superado en run del SHA 72fa851. Fallo SQL posterior por delimitador de dispatch introducido durante edición, corregido en 9677628. No certificar hasta CI final.
## Orden de locks
Ruta pública candidata: dispatch -> actor_guard -> ventana FOR UPDATE -> gate FOR UPDATE -> auth.sessions FOR SHARE -> archive_members FOR SHARE -> archives FOR SHARE -> fence -> core. Gate exclusivo evita promoción SHARE a UPDATE en escritura, y anticipa el orden gate->membership->archive del core legacy. Rechequeo final de ventana/sesión/clave/rol. lock_timeout=5s en dispatch acota cada espera de lock (no es timeout total de operación). Costo: serialización por archivo incluso de lectura; medir en D.4F. El helper privado lock_actor_context no otorga acceso, no devuelve datos y no abre gate; sólo se llama por actor_guard con ventana ya bloqueada. Las funciones privadas D.2 no se exponen a roles API; su orden interno separado no sustituye este contrato.
Administración: si necesita ventana y gate, adquirir ventana primero; si sólo gate y autorización, gate antes de sesión/membresía/archivo; no adquirir ventana después de gate. Logout/expiración de sesión por sí solos no toman gate. No se afirma ausencia universal de deadlocks: managed Auth, FK, triggers, administradores y transacciones ajenas necesitan revisión real, rollback y política de retry acotado. 
## Privilegios efectivos
Políticas AS RESTRICTIVE para UPDATE en archives, archive_members, auth.sessions, gates y windows: USING true, WITH CHECK false. Preservan locks requeridos, impiden mutar filas aunque otra policy permisiva autorice update. Mantener rol NOLOGIN/NOINHERIT/NOBYPASSRLS, sin ownership de tablas, sin capacidad DDL privilegiada, sin PUBLIC EXECUTE, sin miembros API, sin acceso legacy directo por service_role. Grants lock-only de columnas sin posibilidad de actualizar clave, rol ni not_after. Storage metadata sólo SELECT. No ampliar grants remotos. Service role conserva poderes de plataforma fuera de este límite, secreto sólo servidor. Validar default privileges, managed ownership y grants reales en E.3.
## Regresiones nuevas
test_incremental_closed_admin_acl.py, después de test_incremental_closed_runtime.py, con la misma DB descartable y ambos gates cerrados:
- catálogo ACL efectivo y ausencia de PUBLIC EXECUTE;
- simular política permisiva accidental y verificar rechazo real de UPDATE para las cinco tablas lock-only, y que locks siguen funcionando;
- helper privado bajo rol dedicado, identidad correcta/incorrecta y rol incorrecto, sin acceso a datos;
- gate bloqueado por admin, candidato esperando; cambio de membresía, rotación de clave o revocación de sesión gana, luego helper deniega;
- logout gana y contexto gana (bloqueo SHARE, logout espera), luego sesión revocada denegada;
- expiración not_after y rechazo de dispatch real con ventana cerrada;
- 0 fences, operaciones, heads y objetos; restricción hard-closed intacta.
Estas carreras prueban helper de autorización real y orden de locks en PostgreSQL con filas ficticias; no son HTTP Auth real ni transferencias positivas con gate abierto. Se mantiene además la regresión histórica D.2/D.3 en su contenedor desechable separado, que habilita exclusivamente su gate ficticio para probar commit/CAS; no altera el gate de este laboratorio ni el remoto.
## Criterio de cierre
CI completa en SHA final, logs de pruebas específicas, auditoría remota de sólo lectura. E.3 queda pendiente: Supabase CLI/Edge Runtime, Auth y PostgREST reales, RLS/ACL managed, empaquetado, logs redacted, prueba de revocación en runtime y orden administrativo con stack completo. No promover ni abrir gate.
Referencias: https://www.postgresql.org/docs/17/explicit-locking.html , https://www.postgresql.org/docs/17/sql-createpolicy.html , https://docs.deno.com/runtime/reference/cli/check/ .
