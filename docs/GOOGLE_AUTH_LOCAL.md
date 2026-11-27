# CLOUD-01.2 — prueba de acceso Google

**Estado:** implementación experimental; no sincronización ni despliegue.

La pantalla `/app/acceso.html` se genera con el build de Pages. El SDK de Supabase se empaqueta localmente (sin CDN). Usa PKCE, sesión por pestaña mediante sessionStorage, verificación de identidad con getUser y consulta RLS a archive_members. El login por Google no autoriza a entrar al archivo: sin una membresía explícita se informa acceso restringido.

## Probar

Desde la raíz de esta rama, con Node.js 22:
```powershell
$env:ARCHIVITO_SUPABASE_URL = "https://TU-PROYECTO.supabase.co"
$env:ARCHIVITO_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_..."
npm install
npm run build:pages
npm run test:auth
npm run test:pages
py -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Usar la URL y la **publishable key** de Project Settings → API Keys en Supabase; nunca Client Secret de Google, contraseña PostgreSQL, service_role ni secret key. La configuración pública se incorpora al bundle de navegador, no es una credencial administrativa. El build sin ambas variables deja el acceso deshabilitado para CI; rechaza una configuración incompleta o un tipo de clave distinto.

Abrir **http://localhost:8000/app/acceso.html**. El retorno Google usa exactamente **http://localhost:8000/app/**, previamente autorizado en Supabase; el script auth-return.js de la salida compilada reenvía sólo los parámetros OAuth necesarios hacia la pantalla de acceso. Debe mantenerse la misma pestaña, host y puerto durante el flujo PKCE.

1. Entrar con Google. Si el usuario todavía no es miembro, la pantalla debe informar «Cuenta autenticada, sin autorización». Esto confirma identidad pero no autorización.
2. Repetir con la otra cuenta, cerrando la sesión anterior o en otro perfil. No compartir credenciales ni tokens.
3. El administrador confirma las identidades de ambos y registra sus UIDs en archive_members con roles owner/editor. El cliente no puede autoautorizarse.
4. Pulsar «Comprobar acceso nuevamente» en ambos perfiles. El tercero autenticado debe seguir sin acceso.
5. Probar cierre de sesión y retorno al estado inicial. No borrar la base local al salir de la cuenta.

## Restricciones

- La biblioteca local existente se conserva separada. Cualquiera con acceso al mismo perfil del navegador puede consultar sus datos locales: este módulo **no cifra ni bloquea IndexedDB**.
- No hay carga, lectura de recuerdos remotos ni sincronización en esta entrega. No se concede acceso de escritura a tablas ni archivos todavía.
- No añadir la clave secreta de Google ni service_role al sitio, al repo o al chat.
- Antes de desplegar, añadir el redirect exacto correspondiente a la URL HTTPS definitiva y actualizar Site URL.
- El módulo se encuentra en una rama apilada sobre PR #19. Revisar y fusionar #19 antes que este PR; después retargetear este PR a main.
- Validar en navegador real con Google OAuth; las pruebas unitarias simulan respuestas del cliente, no sustituyen pruebas de RLS mediante cuentas reales.
