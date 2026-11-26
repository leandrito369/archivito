# C3B3D.4 — Entorno A/B/C exclusivo, gate cerrado
Fecha 2026-11-26. Base #54 SHA 11eb94f097ef639089b9f1fa424926662ec39551: CI 3/3 aprobada (HTTP #5, Pages #54, navegador #90). #54 sigue draft. No despliegue, apertura ni datos personales.

## Inventario remoto agregado
Un archivo, dos membresías, un gate cerrado, 0 operaciones/heads/objetos incrementales. CHECK (NOT enabled) validado en auditoría anterior; 0 cuentas reservadas A/B/C, 0 colisiones del UUID reservado, 0 triggers personalizados en las tres tablas de aprovisionamiento. Se inspeccionaron columnas/restricciones de archives, archive_members, gates y auth.users, sin exportar filas personales.
No reutilizar el archivo existente. El entorno fixture todavía NO existe. El conector disponible no ofrece creación de usuarios Auth; nunca insertar directamente en auth.users ni crear JWT manuales.

## Identidades propuestas
A = archivito-cert-a@example.com (owner)
B = archivito-cert-b@example.com (editor)
C = archivito-cert-c@example.com (sin membresía en ningún archivo).
UUID de fixture: 73ac551b-2df8-4da7-91b8-4adf18d83900.
Memorias fijas: 73ac551b-2df8-4da7-91b8-4adf18d83901/902/903 (UUID completos según C3B3D.1).
Usar únicamente cuentas sintéticas con contraseñas fuertes únicas, gestionadas por operador en un gestor local; nunca en repositorio, chat, CI, variables de entorno ni logs. example.com es dominio reservado; no enviar invitaciones/correos. Si proveedor no admite creación confirmada o password login está deshabilitado, detenerse; no cambiar configuración Auth global ni reutilizar cuentas personales. Referencia: https://supabase.com/docs/guides/auth/passwords y https://supabase.com/docs/reference/javascript/auth-admin-createuser .

## Runbook (ejecución real pendiente)
1. Confirmar CI de este PR, operador autorizado y ventana administrativa de aprovisionamiento (NO apertura). Verificar hard gate y ausencia de colisión. Obtener aprobación separada para crear cuentas y persistir fixture; no habilitar gate.
2. Dashboard Supabase Auth > Users: crear tres usuarios exclusivamente sintéticos mediante creación administrativa con contraseña y confirmación administrativa de email, sin envío de correo (o Auth Admin API autorizada en entorno seguro). No usar sign-up público ni alterar proveedor. No compartir contraseñas. Confirmar que C no tiene membresías, A/B no tienen otras membresías. El SQL de verificación sólo retorna cantidades.
3. Desde psql autenticado administrativamente al proyecto correcto (usar conexión protegida local, nunca URL con password en comandos publicados), ejecutar:
   psql -X -v ON_ERROR_STOP=1 -f docs/sql/cloud_03_5c3b3d4_closed_fixture_provision.sql
   Por defecto hace BEGIN, valida restricción dura, identidades confirmadas y alcance, simula inserción y ROLLBACK. Adquiere locks cortos con timeout para evitar carreras; si falla, no forzar.
4. Únicamente después de autorización explícita de persistencia, repetir con -v apply_closed_fixture=true. Sólo inserta archivo vacío, A/B y gate enabled=false con cuota 64 MiB; idempotencia exacta; nunca sobrescribe archivo/clave/membresías previas. C permanece sin membresía. key_fingerprint NULL intencional hasta futura generación de clave sintética. No insertar contenidos ni eliminar nada.
5. Ejecutar docs/sql/cloud_03_5c3b3d4_closed_fixture_verify.sql antes y después de cada sonda. Esperado: confirmed_accounts=3, empty_key_fixture=1, fixture_members=2, correct_memberships=2, unexpected_memberships=0, dedicated_closed_gate=1, open_gates=0, hard_closed=true, fixture_operations/heads/objects=0. Si no coincide, STOP.
6. Terminal local interactiva desde checkout: python3 tests/remote/probe_incremental_fixture_login.py
   Confirmar CLOSED-FIXTURE, elegir A/B/C, ingresar publishable key y password sintético en prompts ocultos. La herramienta obtiene sesión genuina desde Auth, valida identidad y ejecuta únicamente manifest del UUID fijo; cierra sesión localmente en finally. No copiar JWT ni refresh token, no redireccionar ni usar proxy. Esperado login 200, auth_user 200, manifest 403, logout 200/204; registrar sólo etiquetas, códigos, pass, fecha y SHA. Ejecutar una vez por actor; si falla, detener. No afirmar que 403 identifica causa única: correlacionar con verifier y auditoría.
7. Registrar evidencia agregada. No eliminar usuarios ni archivo automáticamente. Revocación/expiración auténtica, clave sintética y runtime candidato #53 siguen pendientes.

## Verificación en CI
Workflow dedicado PostgreSQL 17 desechable: schema mínimo simulado, dry run rollback, aplicación sólo en contenedor, idempotencia, archivo ajeno preservado, rechazo de cuenta no confirmada y de membresía de C fuera de scope. Comprueba sintaxis Python sin ejecutar login. No conexión a Supabase, secretos ni auth real. Resultado de CI debe verificarse sobre SHA final. No certifica Auth ni Storage remotos.
