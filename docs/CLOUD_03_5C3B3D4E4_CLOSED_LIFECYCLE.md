# CLOUD-03.5C3B3D.4E.4 — Certificación integral cerrada
Fecha 2026-11-27 UTC (26/11 en Argentina). Base certificada PR #58, SHA ffb8949eedb8091bd6b9ed0165c3ff8ccc7c4b8d. No merge ni promoción.

## Evidencia de cierre D.4E.3
- Stack real #12: https://github.com/leandrito369/archivito/actions/runs/45925088428/job/140264431093 — PASS.
- Pages #78: https://github.com/leandrito369/archivito/actions/runs/45925088484 — PASS.
- IndexedDB #114: https://github.com/leandrito369/archivito/actions/runs/45925088503 — PASS.
- SonarQube: https://github.com/leandrito369/archivito/pull/58#issuecomment-7207657829 — Quality Gate PASS, 0 new issues, 0 accepted, 0 hotspots. La cobertura publicada 0% no representa medición del harness.
- Upstream Edge 8081 (LISTEN all IPv4), host alias verificado. GET directo 405 ACAO exacto, Kong 405 wildcard por plugin CORS activo sin origins. Delegación al handler exclusivamente en gateway local: preflight 204 y origen no autorizado 403 en ambas capas, no wildcard. A/B/C Auth, managed context, RPC, Edge y Storage negativa, revocación, ACL y auditoría final aprobadas. Cleanup PASS.
- Auditoría hosted read-only: 3 cuentas sintéticas confirmadas, key NULL, 2 membresías correctas, cero inesperadas; gate dedicado cerrado, hard CHECK validado, cero sesiones fixture/gates abiertos/ops/heads/objetos globales. Candidato/RPC ausentes, Edge v1 ACTIVE hash 4a5b026b846e3c77ae8729cb97e2b53db45640733997debfdd4e7f8a54623c2e intacta.

## Alcance D.4E.4
Reutilizar el harness E.3 sin modificarlo: stack CLI 2.122.0 aislado, configuración de Kong derivada de upstream y corrección CORS condicionada, DDL candidato exacto, gate CHECK y ventana disabled, autenticación real, 12 RLS y ACL efectivas. E.4 subclass cambia únicamente JWT expiry de Auth en config local (120 s) antes del inicio; verifica exp-iat real. No altera relojes, tokens firmados, hosted ni SQL candidato.

## Matriz de aceptación (pendiente CI)
1. Ejecutar íntegramente E.3 sobre stack nuevo con TTL local. Verificar wire sintético estructural contra validador JS real antes de iniciar. Bytes deterministas de forma compatible, no datos personales ni afirmación de cifrado real.
2. A/B/C sesiones reales concurrentes. Dos claims idénticos por actor por Edge y PostgREST; commit sin fence, generación 0, generaciones fabricadas 1/2 con token sintético, attest/block, manifest head/revision, catalog/download. Exigir rechazo genérico exacto, 403 con CORS/no-store; PostgREST 42501 certification denied. No transferir bytes.
3. Seis threads sincronizados por barrera, dos claims idénticos por actor contra mismo OP, seguidos de RPC real. Exigir todos los rechazos y auditoría cero mutaciones. No afirma orden de adquisición de locks ni que todas las transacciones estén simultáneamente dentro de SQL.
4. Acortar exclusivamente ventana local ya disabled; esperar expiración natural, verificar SQL expiry y repetir claim por Edge/RPC. Mantener gate y ventana cerrados.
5. JWT natural exp + 65 s (tolerancia), sin modificar reloj ni token. Auth user rechaza token expirado; Edge 401 exacto. Refresh real de sesión aún existente conserva identidad/session_id y aumenta exp; nuevo token continúa rechazado por gate. Logout de cada actor, helper privado rechaza sesión, manifest rechaza token anterior (401 si Auth rechaza, 403 si Auth aún acepta), RPC guard cerrado; refresh revocado rechazado con código conocido; auditoría entre actores.
6. Final: cero sesiones/fences/operations/heads/objects, lista Storage vacía, ACL/hard CHECK intactas, cleanup auxiliar y stack. CI verde y SonarQube PASS sobre SHA final, auditoría remota independiente previa al cierre.

## Límites y transición
Las generaciones 1/2 son fabricadas y no leases efectivamente adquiridos. La ventana y el gate cerrados cortocircuitan guard antes del fencing; por eso no se prueba causalidad específica de lease/generación ni una transición real de generación, replay exitoso o transferencia. Los casos SQL previos D.1–D.3 se ejecutaron en laboratorios separados; no sustituir una certificación HTTP positiva. E.5 exige plan de promoción coordinada y rollback; F requiere autorización explícita separada. No habilitar gate ni ventana, no realizar migración remota o deploy, ni merge de PR. Este documento es plan de prueba, no evidencia de ejecución E.4.
