# CLOUD-03.5C3B3D.4D — Revocación y expiración auténticas
Fecha 2026-11-26. Base #55 SHA 785b04b3b6834907c4ba6af94923a872581bade1, CI 3/3, A/B/C 12/12 criterios HTTP satisfechos, una incidencia C login 400 recuperada. Auditoría remota previa: 3 cuentas, 2 membresías correctas, 0 ajenas, 1 fixture vacío, gate hard closed, 0 sesiones sintéticas, 0 operaciones/heads/objetos fixture. No cambios remotos.
## Fundamento
Supabase signout local revoca refresh y elimina sesión; JWT ya emitido puede continuar criptográficamente válido hasta exp. /auth/v1/user puede rechazar antes por sesión revocada; observar sin confundir con validación de firma. Referencias revisadas 26/11/2026: https://supabase.com/docs/guides/auth/signout , https://supabase.com/docs/guides/auth/sessions , https://supabase.com/docs/reference/python/auth-signout . No cambiar TTL global ni simular expiración modificando reloj, JWT o sesión real.
## Ejecución local, no CI
Requiere aprobación CI del SHA final, auditoría independiente del fixture cerrado y ausencia de sesiones previas. Ejecutar una vez por actor y modo, secuencialmente. Desde checkout certificado:
`python3 tests/remote/probe_incremental_session_lifecycle.py`
Ingresar CLOSED-FIXTURE, A/B/C, REVOKE o EXPIRE; EXPIRE requiere WAIT explícito. Publishable key y contraseña sintética ocultas. No usar personal, admin, refresh token manual, proxy, persistencia, copiar JWT, capturas con secretos, ni cambiar auth global.
### REVOKE
1. Login 200, /user 200 y manifest 403.
2. Logout scope=local 200/204.
3. Reutilizar exactamente el access JWT original: /user 200 (identidad coincide) o 401/403 se registra OBSERVED, no PASS de revocación JWT. Registrar si exp aún futuro.
4. Reusar mismo JWT contra manifest: 403 genérico, CORS, no-store.
5. Intentar una sola renovación con refresh original: 400/401/403 y código de revocación reconocido, sin access nuevo. Error desconocido = FAIL, no adivinar ni reintentar. Si inesperadamente emite access de la misma identidad, cleanup logout y FAIL. 
6. Operador comparte sólo líneas JSON agregadas; verificar auth.sessions=0 por SQL y gate/contadores/roles intactos.
### EXPIRE
Sesión nueva, login y /user válidos, manifest 403. Validar Date del servidor frente a reloj local (máximo 30 s diferencia), obtener exp de JWT recibido de Auth, esperar de forma local e interactiva hasta exp + 60 s (límite total 7200 s); no auto-refresh, no logout antes, no modificar token. Se conserva en memoria y no se escriben secretos. Si equipo se suspende o hay desajuste, detener y auditar. 
Después del vencimiento: /user 401/403 y manifest 403; luego refresh una vez debe emitir JWT nuevo para mismo sub y session_id con exp mayor, /user 200, logout local 200/204. Renovación exitosa posterior corrobora que el refresh seguía operativo, no que el viejo JWT se revocó por logout. Ante interrupción, cleanup acotado; si falla, STOP y revisar sesiones del fixture con operador, nunca logout global ni borrar usuarios. Verificar SQL final. No ejecutar modo EXPIRE en runner ni modificar TTL global para acelerar.
## Criterios
REVOKE A/B/C, EXPIRE A/B/C; registrar cada ejecución y auditoría de sesiones/roles/contadores. Si token reutilizado aceptado por Auth tras logout, hallazgo esperado posible, no implica acceso incremental. Si Edge acepta manifest, STOP; gate audit inmediato. Una respuesta 403 con gate cerrado no discrimina autorización por sesión frente al gate. Expiración real y revocación de sesión en la RPC candidata requieren certificación D.4E en entorno aislado; no apertura ni migración ni deploy. Tests offline usan JWT ficticios únicamente en mocks, no son evidencia real. Ninguna sesión auténtica se ejecutó desde este PR.
