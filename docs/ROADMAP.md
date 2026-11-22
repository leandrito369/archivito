# Hoja de ruta y plan de ejecución — Archivito

**Línea base:** 2026-11-22. Estados expresan sólo avances comprobados en este repositorio o prototipos externos explícitamente indicados.

## Iteración 0 — Base y adopción del prototipo 0.2

**Objetivo:** pasar de un repositorio documental a una aplicación reproducible y probada.

**Entregables**
- Integrar el `index.html` de 0.2 en el repositorio mediante PR separado.
- Instrucciones para ejecutar mediante `localhost` y probar almacenamiento.
- Fixtures sintéticos; nunca cartas, nombres privados ni respaldos reales.
- Verificación de IndexedDB en navegador real: crear, recargar, cerrar/reabrir y recuperar.
- Importar respaldos 0.1 y 0.2 y confirmar integridad de fotos originales.
- Configuración mínima de pruebas automáticas y .gitignore.
- Registrar límites del prototipo y errores conocidos.

**Salida:** biblioteca utilizable en local, con prueba reproducible de creación, persistencia y restauración; sin afirmar cobertura que no existe.

## Iteración 1 — 0.3A: captura y digitalización asistida

**Dependencia:** Iteración 0 cerrada.

**Entregables**
- Refactor incremental y esquema versionado: activo original y derivado.
- Carga de fotografías con formatos documentados y mensajes de error.
- Cuatro esquinas ajustables y transformación de perspectiva con vista previa.
- Guardar transformación como derivado; preservar bytes originales.
- Validar recortes sobre fotos oblicuas, con sombra y distinto formato de papel.
- Exportación/restauración con los nuevos metadatos.

**Salida:** convertir fotos en cartas legibles y enderezadas sin perder el material original.

## Iteración 2 — 0.3B: visor físico WebGL

**Dependencia:** 0.3A o contrato de activos estabilizado.

**Entregables**
- Visor Three.js de papel con frente, dorso, leve grosor y curvatura aproximada.
- OrbitControls (o equivalente), zoom, cambio de página, reinicio y vista lectura.
- Gestionar texturas grandes, orientación, proporciones y pérdida de contexto WebGL.
- Fallback 2D si no hay WebGL.
- Pruebas de integración con cartas de varias hojas y fotos de prueba.

**Salida:** experiencia consistente de objeto físico aproximado; no reconstrucción 3D exacta.

## Iteración 3 — 0.4: preservación

- Hash SHA-256 y comprobación de integridad.
- Respaldo empaquetado y cifrado con contraseña, con restauración validada.
- Detección de duplicados y soporte de colecciones.
- Transcripción manuscrita manual (OCR opcional no confiable).
- Verificar recuperación de respaldos grandes.

## Iteración 4 — 1.0: biblioteca compartida

- Diseño de amenaza y protección de claves; autenticación y autorización.
- Sincronización cifrada, conflictos offline, exportación integral y borrado.
- API y almacenamiento remoto, sólo tras validar amenaza/costos/operación.
- Pruebas de permisos de acceso y recuperación de cuenta.

## Orden sugerido de issues

1. Integración 0.2 y comprobación de persistencia (bloqueante).
2. Esquema de originales/derivados y migraciones.
3. Digitalización asistida (recorte de cuatro esquinas).
4. Visor Three.js.
5. Respaldo cifrado e integridad.

## Regla de avance

Cada PR debe declarar alcance, evidencias de pruebas, riesgos de pérdida de datos y cambios de esquema. No hacer merge automático ni publicar cartas privadas en el repositorio público.
