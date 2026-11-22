# ADR-0001 — Arquitectura local-first y conservación de originales

- **Fecha:** 2026-11-22
- **Estado:** aceptada para MVP
- **Contexto:** archivito almacena cartas y recuerdos personales sensibles. Queremos validar biblioteca y visor sin complejidad de servidor ni obligación de enviar fotos a terceros.

## Decisión

1. El MVP trabaja localmente con IndexedDB.
2. Las fotografías originales se mantienen sin transformación destructiva.
3. Recortes, miniaturas, transcripciones y geometría serán derivados referenciados.
4. Exportar/restaurar seguirá siendo una función fundamental.
5. Cualquier nube, autenticación y sincronización se pospone hasta diseñar sus garantías de privacidad.

## Consecuencias positivas

- Funciona sin servidor remoto ni cuentas.
- Menor superficie de exposición de datos por red.
- Desarrollo incremental del visor y digitalización.

## Costos y riesgos

- IndexedDB no es copia de seguridad fiable; puede ser borrada.
- El usuario debe hacer y verificar respaldos.
- Las exportaciones JSON 0.2 no están cifradas.
- La futura migración requerirá versionado de esquemas y pruebas.
- Compartir entre dispositivos no estará disponible en el MVP.

## Alternativas consideradas

- **Cloud-first desde el inicio:** descartada por complejidad de seguridad, almacenamiento y acceso.
- **Fotografías en carpetas sin base de datos:** simple pero insuficiente para cronología, relaciones y visor integrado.
- **Todo como PDF:** útil para lectura, no para preservación de ambas caras y experiencia de objeto interactivo.

## Revisión

Revisar esta ADR antes de añadir cuentas, telemetría, OCR externo o sincronización.
