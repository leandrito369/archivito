# CLOUD-02.1 — Núcleo de cifrado y laboratorio local

Estado: experimental, sin conexión con Supabase ni recuerdos reales. Depende del PR #20 (autenticación) y #19 (build). El laboratorio no requiere iniciar sesión porque trabaja exclusivamente con datos ficticios.

## Contrato criptográfico v1

- Código de recuperación: 32 bytes aleatorios generados con Web Crypto, en base64url canónico, prefijo versionado y ocho caracteres de comprobación SHA-256. El código contiene el secreto: debe transferirse físicamente o por un canal privado seguro, nunca por el chat, Git o el servidor. El checksum detecta errores de copia, no autentica a la persona.
- La clave AES-256-GCM importada es no exportable. Nonce aleatorio de 96 bits por cifrado, etiqueta de autenticación de 128 bits. Los datos adicionales autenticados vinculan versión, archivo, objeto, tipo, revisión y huella SHA-256 de la clave. No se reutiliza un nonce intencionalmente.
- Metadatos y bytes de imagen se cifran antes de cualquier operación remota futura. El hash de imagen debe viajar dentro de los metadatos cifrados. Límite local de 35 MiB por objeto.
- El núcleo devuelve nonce/ciphertext como bytes; el JSON base64url sólo se utiliza en el laboratorio. La futura capa de persistencia debe definir serialización binaria, manifiesto, revisiones y límites.
- El laboratorio conserva la clave importada en memoria y limpia el campo de recuperación al bloquear o abandonar la página; no persiste secretos ni accede a IndexedDB. Esto no garantiza borrado físico de RAM ni protege contra código comprometido, extensiones maliciosas o acceso al navegador.
- La autenticación y RLS son independientes. Compartir el código da acceso criptográfico a cualquier copia del ciphertext. Revocar membresía no revoca copias previas de la clave. Rotación, recuperación ante pérdida, protección de clave en reposo, conflictos/replay y custodia deben resolverse antes de producción.

## Prueba manual en Linux

Desde el repositorio local actualizado, con cambios locales respaldados y sin detenerse sobre una rama con cambios sin guardar:

```bash
git fetch origin
git switch feat/cloud-02-1-client-crypto
npm ci
npm run test:crypto
npm run build:pages
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Si la rama no existe localmente, usar `git switch --track origin/feat/cloud-02-1-client-crypto`. Detener servidor anterior con Ctrl+C. Abrir http://localhost:8000/app/crypto-lab.html.

1. Generar código **de prueba desechable**, mostrarlo sólo para transferirlo de forma privada y desbloquearlo.
2. Cifrar muestra. El JSON contiene sólo el contexto técnico, nonce y ciphertext.
3. Abrir otro perfil o ventana privada. Introducir el mismo código de prueba y pegar el JSON cifrado.
4. Descifrar y verificar; debe aparecer VERIFICADO con SHA-256 coincidente.
5. Bloquear, generar y desbloquear otro código; con el mismo JSON el descifrado debe rechazarse.
6. Bloquear y descartar el código de prueba al terminar. No emplear cartas ni claves reales.

## Gate siguiente

CLOUD-02.2 debe integrar una clave de archivo real sólo tras definir custodia, rotación, comprobación de clave correcta, políticas de sesión y revisión de seguridad. No habilitar Storage/INSERT remoto hasta cerrar pruebas de autorización por API, cifrado e integridad. El PR #18 de respaldo cifrado sigue siendo independiente.
