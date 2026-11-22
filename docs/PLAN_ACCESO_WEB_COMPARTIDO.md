# Plan de ejecución — Archivito web compartido y gratuito

**Decisión adoptada:** 22/11/2026 · **Stack:** Cloudflare Pages Free + Supabase Free · **Estado:** pendiente de implementación y despliegue.

## Objetivo

Dos personas con sus propias cuentas Google pueden entrar por una **misma URL HTTPS** desde celulares o PC, guardar recuerdos desde cualquier lugar y visualizarlos en biblioteca 2D/3D compartida. Las cartas, fotos y metadatos privados sólo serán legibles por los dos miembros autorizados que posean la clave del archivo.

**Importante:** la aplicación actual guarda todo en IndexedDB por navegador y origen; aún no existe sincronización remota ni login. No asumir que publicar el frontend resuelve esos requisitos.

## Arquitectura

| Componente | Servicio gratuito | Función |
|---|---|---|
| Frontend HTTPS | Cloudflare Pages | Entregar HTML, CSS y JS empaquetado (Three.js incluido en el build) |
| Identidad | Supabase Auth / Google OAuth | Identificar las dos cuentas |
| Membresía privada | PostgreSQL + RLS | Autorizar sólo 2 UIDs; un tercero es rechazado |
| Índice de recuerdos | Supabase Postgres | Cargar únicamente metadatos cifrados, referencias y revisiones |
| Fotos y derivados | Supabase Storage | Bucket privado de ciphertext; rutas de assets opacas |
| Avisos de cambios | Supabase Realtime | Notificar cambios sujetos a autorización |
| Trabajo offline | IndexedDB | Copias, fotos y cola local de sincronización |
| Confidencialidad | Web Crypto | Cifrar **antes** de subir; distribuir clave entre dos personas de forma segura |
| Recuperación | Backup cifrado v4 | Exportación/restauración independiente de la nube (PR #18, aún draft) |

Ver [ADR-0003](decisiones/ADR-0003-cloudflare-supabase.md). La anterior [ADR-0002 Firebase](decisiones/ADR-0002-acceso-web-compartido.md) queda sustituida.

## Fases con criterios de aceptación

### 0 — Preservación 0.4A.1 (PR #18)

- [ ] Validar en CI el cifrado de respaldo v4: AES-GCM, derivación de clave y hashes SHA-256.
- [ ] Restaurar backup cifrado en **un perfil distinto**, sin eliminar ni modificar originales.
- [ ] Rechazar contraseña incorrecta, archivo manipulado y IDs ya existentes sin escritura parcial.
- [ ] Revisar límites de memoria/backup y mecanismos de recuperación de clave.
- [ ] Aclarar que este backup **no implementa** cifrado remoto de extremo a extremo.

### 1 — CLOUD-01: empaquetado web, Google Auth y autorización

- [ ] Compilar la aplicación en un directorio estático `dist/` con Three.js **empaquetado**: no publicar `node_modules`.
- [ ] Probar la compilación en CI sin despliegue automático.
- [ ] Crear **proyectos propios** Cloudflare y Supabase en los planes Free, cuando el propietario decida conectarlos.
- [ ] Habilitar Google OAuth en Supabase y configurar callback/redirects exactos de Pages y localhost.
- [ ] Establecer un único `archive_id` y **dos** miembros identificados por `auth.users.id`, no por emails escritos en Git.
- [ ] Aplicar tablas, policies RLS y bucket privado mediante migración revisada; no usar service_role en el navegador.
- [ ] Ejecutar pruebas **negativas** por API: tercero autenticado y anónimo no leen ni escriben.
- [ ] Publicar solo fixtures sintéticos; la URL puede ser pública como código, no los recuerdos.

**Criterio de salida:** ambas cuentas entran, pero un tercero no puede acceder a la base ni a Storage aunque conozca la URL y la publishable key.

### 2 — CLOUD-02: clave del archivo y cifrado en navegador

- [ ] Definir clave de archivo aleatoria, forma de compartirla sin compartir contraseña Google y recuperación por ambos usuarios.
- [ ] Cifrar antes de subir **originales, derivados, título, notas, fechas, etiquetas, remitente y destinatario**.
- [ ] Documentar qué metadatos operativos no se pueden ocultar al proveedor (cuentas, tamaños, tiempos).
- [ ] Cifrado autenticado con parámetros versionados; nunca subir claves en claro ni incluirlas en logs.
- [ ] Pruebas: dos usuarios autorizados descifran; tercero o usuario sin clave no puede.

**Criterio de salida:** un ciphertext de carta sintética puede recuperarse entre dos dispositivos con el mecanismo seguro de clave; el servidor no dispone del texto o las fotos descifradas.

### 3 — CLOUD-03: sincronización local-first

- [ ] Repositorios local/remoto, IDs estables, cola persistente de operaciones y reintentos.
- [ ] Subir blobs cifrados, confirmar índice sólo cuando completaron, validar hashes.
- [ ] Descargar nuevos recuerdos sin recargar manualmente y descifrarlos localmente.
- [ ] Marcar estado real: `Sólo local`, `Pendiente`, `Sincronizando`, `Sincronizado`, `Conflicto`.
- [ ] Detectar revisiones incompatibles y mantener copia recuperable antes de resolver conflictos.
- [ ] Probar simultáneamente dos navegadores, reconexión tras caída de red, borrado y cargas parciales.

**Criterio de salida:** usuario A sube recuerdo sintético con frente/reverso y B lo ve; B sube otro y A lo ve; tercero no tiene acceso por API ni descifra contenido.

### 4 — CLOUD-04: móvil/PWA y migración de recuerdos

- [ ] Manifest y caché estática segura para funcionar desde pantalla de inicio.
- [ ] Captura desde cámara/galería y soporte de orientación/formato móvil.
- [ ] Migración **explícita** desde `localhost:8000` a `https://<nombre>.pages.dev`: no comparten IndexedDB.
- [ ] Importar backup con comprobación de integridad y confirmación; no eliminar origen local hasta verificar nube + recuperación.
- [ ] Validar en Safari iPhone, Chrome Android, Firefox/Chrome PC.
- [ ] Documentar restauración tras pausa del proyecto Free de Supabase.

**Criterio de salida:** ambos pueden usar Archivito desde cualquier lugar; una desconexión deja operaciones pendientes, no falsamente completadas.

## Modelo de permisos propuesto

- Supabase Auth permite iniciar sesión a usuarios de Google: eso sólo prueba identidad.
- `archive_members` establece pertenencia y rol `owner` o `editor`; **ningún cliente puede autoañadirse**.
- Policies RLS limitan `archives`, `archive_members` y `memories` a miembros de ese archivo.
- Policies de `storage.objects` limitan las rutas `<archive_id>/<asset_uuid>` y el bucket debe ser privado.
- Ningún usuario tiene permiso de conceder acceso a terceros desde la API pública.
- **NUNCA** usar `service_role`, Google OAuth Client Secret ni claves de archivo dentro de páginas publicadas.

## Condiciones económicas

El objetivo es **USD 0**, no una promesa de disponibilidad o capacidad ilimitada. En noviembre 2026 Supabase Free incluye aprox. 500 MB de base, 1 GB de Storage y 5 GB de salida no cacheada, con posible pausa por inactividad; Cloudflare Pages Free tiene límites mensuales de compilaciones. Vigilar cambios y no superar cuotas; **no activar servicios pagos automáticamente**.

## Gestión del repositorio

- La rama `main` y los recuerdos reales no se modifican sin PR revisado.
- No subir fotos, backups, emails, UID de ambos usuarios, secretos o credenciales al repositorio público.
- Un PR técnico por corte: build Pages, Auth/permissions, cifrado compartido, sync, PWA.
- Pruebas con fixtures sintéticos y estados de CI verdes antes de cada merge.

## Dependencias

- [Issue #13](https://github.com/leandrito369/archivito/issues/13): Hosting Cloudflare Pages + Google OAuth + RLS.
- [Issue #14](https://github.com/leandrito369/archivito/issues/14): clave y cifrado cliente.
- [Issue #15](https://github.com/leandrito369/archivito/issues/15): sincronización bidireccional.
- [Issue #16](https://github.com/leandrito369/archivito/issues/16): PWA/migración.
- [Issue #4](https://github.com/leandrito369/archivito/issues/4): backup cifrado v4.

## Referencias

- Cloudflare Pages: https://developers.cloudflare.com/pages/get-started/git-integration/
- Configuración de compilación: https://developers.cloudflare.com/pages/configuration/build-configuration/
- Supabase Free: https://supabase.com/pricing
- Google Auth: https://supabase.com/docs/guides/auth/social-sign-in/auth-google
- RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Storage: https://supabase.com/docs/guides/storage/security/access-control

**Este plan no es una afirmación de que las cuentas, la base ni el sitio ya estén creados.**
