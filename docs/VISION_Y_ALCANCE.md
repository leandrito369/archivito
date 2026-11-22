# Visión, alcance y requisitos — Archivito

**Fecha de base:** 2026-11-22  
**Estado:** propuesta de producto; no equivale a funcionalidades implementadas.

## Problema

Las cartas manuscritas y los recuerdos físicos contienen información que un OCR o PDF común no conserva: caligrafía, tinta, papel, manchas, colores, posición de dobleces, frente y reverso, asociación con un sobre y contexto afectivo. Queremos hacerlos consultables y preservarlos en un espacio privado sin perder los originales.

## Objetivo del producto

Permitir a dos personas crear y recorrer una biblioteca privada de recuerdos digitalizados y examinar cartas como objetos manipulables desde PC o móvil, preservando la fidelidad de sus fotografías y la capacidad de recuperar sus archivos.

## Experiencia objetivo

1. Abrir **Biblioteca** y ver tarjetas con título, fecha, miniatura, tipo y etiquetas.
2. Buscar, ordenar, filtrar por favoritos y recorrer la **Cronología**.
3. Elegir un recuerdo para abrir **Visor físico**: girar, ampliar, dar vuelta, navegar páginas.
4. Agregar un recuerdo tomando fotos del frente y reverso; en 0.3 enderezar y recortar mediante cuatro esquinas ajustables.
5. Conservar los originales, exportar un respaldo y restaurarlo sin perder fotos ni metadatos.

## Requisitos funcionales (RF)

| ID | Requisito | Prioridad | Versión objetivo |
|---|---|---|---|
| RF-01 | Alta, consulta, edición y borrado de recuerdos | Alta | 0.2 |
| RF-02 | Cada recuerdo contiene una o varias páginas y cada página frente y reverso opcional | Alta | 0.2 |
| RF-03 | Biblioteca: búsqueda, filtros, favoritos y cronología | Alta | 0.2 |
| RF-04 | Visor: rotar, zoom, cambiar de cara y hoja, reiniciar vista | Alta | 0.2/0.3 |
| RF-05 | Almacenar imágenes de origen sin modificación destructiva | Crítica | 0.2+ |
| RF-06 | Exportar/importar respaldos versionados | Crítica | 0.2+ |
| RF-07 | Recortar y corregir perspectiva con cuatro esquinas editables y vista previa | Alta | 0.3 |
| RF-08 | Visor WebGL con textura por cara, grosor y curvatura aproximados | Alta | 0.3 |
| RF-09 | Vincular sobre con carta y recorrido sobre→hojas | Media | 0.3+ |
| RF-10 | Integridad por hashes y respaldo cifrado restaurable | Alta | 0.4 |
| RF-11 | Compartir entre dos cuentas de forma privada | Futura | 1.0 |

## Requisitos no funcionales (RNF)

- **RNF-01 Privacidad:** sin analítica ni telemetría de contenido sensible; sin envío de imágenes a servicios externos por defecto.
- **RNF-02 Recuperabilidad:** errores de exportación/importación deben ser visibles; probar restauración y verificar bytes/hash de originales.
- **RNF-03 Fidelidad:** mostrar claramente si se trata de una superficie texturizada o una reconstrucción real.
- **RNF-04 Accesibilidad:** navegación con teclado, contraste, alternativa 2D/lectura y gestos táctiles razonables.
- **RNF-05 Rendimiento:** miniaturas y carga bajo demanda; evitar decodificar simultáneamente todas las fotos.
- **RNF-06 Compatibilidad:** experiencia prioritaria en navegador de escritorio moderno; probar móvil y formatos HEIC/HEIF antes de declararlos compatibles.
- **RNF-07 Mantenibilidad:** datos versionados, módulos separados y pruebas automatizadas.

## Límites y supuestos

- Dos fotos (frente/dorso) **no reconstruyen el relieve real** ni muestran caras ocultas. La vista de carta 3D será una aproximación geométrica.
- 0.2 ofrece perspectiva CSS 3D; **no** Three.js, OpenCV.js, fotogrametría, OCR fiable, cifrado ni sincronización.
- 0.3 incorpora digitalización asistida; la calidad del resultado depende de fotos bien iluminadas.
- Guardar fotos en IndexedDB **no sustituye los respaldos**.
- Se debe definir el consentimiento y la gestión de claves antes de construir cuentas y sincronización.

## Fuera de alcance inicial

Escaneo volumétrico exacto, física de papel de precisión, reconstrucción automática de pliegues, identificación de escritura manuscrita sin errores, redes sociales, funcionalidades públicas de compartir y almacenamiento cloud obligatorio.

## Indicador de éxito del siguiente corte

Una carta de dos hojas queda registrada con todas sus caras; persiste tras recargar; puede exportarse y restaurarse; el original conserva sus bytes; y la visualización 3D puede manipularse sin alterar el archivo original.
