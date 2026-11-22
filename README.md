# Archivito

**Biblioteca privada de recuerdos con un visor interactivo de cartas.**

Archivito busca preservar cartas, sobres, fotografías y otros recuerdos físicos en un archivo digital que respete su apariencia original. La experiencia combina **biblioteca de recuerdos** (búsqueda, cronología, colecciones) y **explorador físico** (rotación, zoom, frente/dorso y recorrido de páginas). Está pensado inicialmente para dos personas.

> **Estado del repositorio:** fase de documentación y preparación de código. La versión **0.2 existe como prototipo local HTML** elaborado fuera de este repositorio; **todavía no está integrada aquí**. La versión **0.3 está planificada**, no implementada.

## Principios

1. **Preservación:** conservar imágenes originales intactas; transformaciones, miniaturas y transcripciones son derivadas.
2. **Privacidad por diseño:** primera etapa *local-first*, sin subir fotografías a servidores.
3. **Fidelidad:** distinguir una carta plana texturizada de una reconstrucción física 3D verdadera.
4. **Portabilidad:** respaldos exportables, restaurables y con formatos versionados.
5. **Evolución incremental:** construir y probar por etapas, sin adelantar promesas de cifrado o sincronización.

## Documentación

- [Visión, alcance y requisitos](docs/VISION_Y_ALCANCE.md)
- [Arquitectura y modelo de datos](docs/ARQUITECTURA.md)
- [Hoja de ruta y orden de implementación](docs/ROADMAP.md)
- [Pruebas y criterios de aceptación](docs/CALIDAD_Y_PRUEBAS.md)
- [Privacidad, preservación y amenazas](docs/PRIVACIDAD_Y_PRESERVACION.md)
- [ADR-0001: local-first](docs/decisiones/ADR-0001-local-first.md)

## Estado resumido

| Entrega | Estado | Alcance |
|---|---|---|
| 0.1 | Prototipo externo | Carta plana, frente/dorso, zoom y giro |
| 0.2 | Prototipo externo | Biblioteca, filtros, cronología, páginas, IndexedDB, exportación/importación JSON |
| 0.2 en el repositorio | Pendiente | Incorporación del código, validación de persistencia real y pruebas de regresión |
| 0.3 | Planificada | Recorte asistido, corrección de perspectiva, visor Three.js, modelo de originales/derivados |
| 0.4 | Planificada | Integridad, respaldos cifrados y mejoras de archivo |
| 1.0 | Visión futura | Biblioteca compartida con autorización y sincronización privada |

## Tecnología propuesta

- Interfaz: **React + TypeScript** (migración posterior; no es requisito para importar el prototipo).
- Visor: **Three.js** para la etapa 0.3, sobre geometría de papel aproximada.
- Procesamiento: **OpenCV.js**, recorte de cuatro esquinas editable.
- Persistencia inicial: **IndexedDB** con metadatos e imágenes originales.
- Backend futuro (no decidido definitivamente): API, PostgreSQL y almacén de objetos.

## Seguridad del repositorio

**Este repositorio es público.** No subir cartas personales, fotografías reales, respaldos JSON, contraseñas, secretos, claves ni metadatos íntimos. Las capturas y fixtures de prueba deben ser ficticios. Los respaldos de 0.2 **no están cifrados**.

## Siguiente paso

**Integrar el prototipo 0.2 al repositorio en un PR separado**, agregar un servidor de desarrollo local y probar persistencia real, restauración y conservación de imágenes originales. Después implementar el flujo de digitalización asistida 0.3.

Ver [ROADMAP](docs/ROADMAP.md) y los issues del proyecto.
