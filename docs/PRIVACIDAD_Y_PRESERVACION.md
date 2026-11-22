# Privacidad, preservación y riesgos

## Política inicial

Archivito es un proyecto personal: los recuerdos pueden contener caligrafía, nombres, fechas, direcciones e información íntima. El código vive en un **repositorio GitHub público**, pero los recuerdos de los usuarios deben permanecer privados.

## Nunca subir al repositorio

- Fotos reales de cartas, sobres y objetos personales.
- Respaldos JSON/ZIP que contengan recuerdos.
- Datos privados en fixtures de prueba, capturas, logs o issues.
- Claves, tokens, contraseñas o configuraciones con secretos.

Usar fixtures totalmente sintéticos y comprobar PRs antes de publicar.

## Amenazas y mitigaciones por etapa

| Riesgo | Efecto | Acción |
|---|---|---|
| Pérdida o limpieza de datos del navegador | Desaparición de recuerdos | Mantener originales fuera de la app, exportación regular y restauración verificada |
| Robo de respaldo JSON v0.2 | Exposición de cartas | Advertencia explícita: respaldo no cifrado; guardarlo en almacenamiento seguro |
| Subida accidental a GitHub público | Divulgación irreversible | Fixtures ficticios, ignore de archivos privados y revisión de commits |
| Transformaciones destructivas | Pérdida de detalles | Originales inmutables y derivados vinculados |
| Imágenes maliciosas o archivos enormes | Bloqueo de app | Validación de tamaño/tipo, límites de procesamiento y errores controlados |
| Dependencias/código remoto | Riesgo de filtración | Dependencias auditables, CSP apropiada y sin servicios externos de OCR por defecto |
| Futura sincronización débil | Accesos no autorizados | Cifrado, modelo de amenazas, permisos por identidad y revocación |

## Preservación documental

- Conservar **fotografía original byte a byte** y metadatos mínimos de procedencia.
- Generar miniatura y versión corregida como archivos derivados.
- Incorporar hash SHA-256 para verificación de integridad en 0.4 (o antes si se necesita para aceptación 0.3).
- La restauración debe demostrar que no hay pérdida de contenido; guardar al menos una copia externa del respaldo.
- Evitar OCR automático externo por defecto. Una transcripción siempre debe poder corregirse.

## Consideraciones de cifrado futuro

Cifrado en reposo local, respaldo protegido con contraseña y sincronización cifrada son problemas distintos. No asumir que HTTPS o autenticación equivalen a cifrado de extremo a extremo. Antes de implementarlos, documentar claves, recuperación, rotación, autorización, sincronización de metadatos y eliminación.

## Estado real

La versión 0.2 es local-first con IndexedDB y respaldos JSON **sin cifrar**. No tiene cuentas, control de acceso entre usuarios, almacenamiento compartido ni sincronización. No presentarla como solución segura frente a un atacante con acceso al dispositivo o respaldo.
