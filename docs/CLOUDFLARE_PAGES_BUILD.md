# Cloudflare Pages Free — compilación estática de Archivito

**Estado:** corte CLOUD-01.1, preparado para CI. **No desplegado**, sin cuentas Google, sin Supabase, sin sincronización.

## Objetivo del corte

Permitir alojar el **frontend** de Archivito por HTTPS sin servir `node_modules` ni archivos de usuario. El resultado contiene las páginas HTML y scripts locales y un bundle de Three.js listo para navegadores modernos.

No se cambia IndexedDB ni se cargan cartas en un servidor. En una futura URL `*.pages.dev` cada navegador tendrá una **base local distinta**, inicialmente vacía; **eso no es la biblioteca compartida**.

## Compilar desde Windows / PowerShell

Necesitás Node.js 22 y npm.

```powershell
npm install
npm run build:pages
npm run test:pages
py -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Abrí `http://localhost:8000/app/`. Para que aparezcan los recuerdos anteriores usá exactamente el mismo host, puerto y perfil de Firefox, siempre que no hayas limpiado la base local. Para cualquier cambio de origen (por ejemplo `pages.dev`), **exportá un respaldo y restauralo de forma controlada**.

## Configuración propuesta en Cloudflare Pages

Sólo después de revisar y fusionar este PR, crear un proyecto Pages desde el repositorio GitHub:

| Campo | Configuración |
|---|---|
| Repositorio Git | `leandrito369/archivito` |
| Rama de producción | `main` |
| Directorio raíz | raíz del repositorio |
| Comando de compilación | `npm run build:pages` |
| Directorio de salida | `dist` |
| Versión Node | 22, si el entorno permite elegirla |
| Funciones / Workers | ninguna en este primer corte |
| Variables secretas | ninguna |

Cloudflare suele instalar dependencias npm en su pipeline; **no** publicar ni copiar `node_modules` completos. El script `scripts/build-pages.mjs` lista explícitamente los archivos permitidos y empaqueta el único import externo de Three.js usando esbuild.

La dirección pública se asignará al crear el proyecto, por ejemplo `https://<nombre-disponible>.pages.dev`.

## Advertencias de seguridad

- **El código web sí será público.** No hay autenticación aún. No considerar esta etapa un archivo privado compartido.
- Hoy todas las cartas permanecen en el almacenamiento local del navegador y **no se suben al hosting**.
- **No crear Storage/SQL remoto con permisos abiertos**, no colocar `service_role`, tokens, credenciales, contraseñas, fotos o backups en la carpeta `app`, `dist` o Git.
- La futura versión con Supabase debe separar autenticación Google de autorización por membresía `archive_members` + RLS, cifrar contenido y validar claves antes de subir recuerdos.
- En el plan Free de Supabase se puede pausar el proyecto tras inactividad y hay cuotas de 1 GB de Storage y 500 MB de base (consultar precios actuales antes de escalar).

## Aceptación del PR

1. CI ejecuta `npm install`, `npm run build:pages`, `npm run test:pages` exitosamente.
2. La salida `dist/app/visor-three.js` incluye Three.js/OrbitControls empaquetados y `visor-3d.html` **ya no solicita** `../node_modules`.
3. La salida no contiene fotografías, JSON personales, respaldos, secretos o `node_modules/`.
4. El lector 2D/3D sigue apuntando a los mismos IDs/Blobs locales, sin migraciones.
5. Prueba manual de la salida `dist` en Firefox antes de habilitar despliegue.

## Próximo subcorte CLOUD-01.2

- Crear proyecto Supabase **propiedad del usuario** (el conector actualmente no muestra proyectos), habilitar Google OAuth.
- Provisionar membresía inicial de dos UIDs de forma administrativa.
- Implementar policies RLS y Storage privado, probar accesos con dos cuentas sintéticas y un tercero.
- **No mover recuerdos reales** hasta terminar cifrado del lado cliente y recuperación de claves (CLOUD-02).

### Fuentes oficiales

- https://developers.cloudflare.com/pages/get-started/git-integration/
- https://developers.cloudflare.com/pages/configuration/build-configuration/
- https://supabase.com/docs/guides/auth/social-sign-in/auth-google
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/pricing
