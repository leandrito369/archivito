# Archivito — prototipo local v0.2

Esta carpeta contiene la aplicación **HTML autónoma v0.2** previamente preparada. No requiere construir ni instalar paquetes para usarla. El código está incorporado sin migrarlo aún a React ni Three.js.

## Iniciar (recomendado)

Desde la **raíz** del repositorio:

```bash
python -m http.server 8000
```

Abrí **http://localhost:8000/app/** en Chrome o Edge. Mantené el mismo host y puerto para volver a encontrar tu colección: IndexedDB se aísla por **origen** (esquema + dominio + puerto), y la app utiliza la base `nuestro-archivo-cartas-v1` / store `letters`. Si antes ejecutabas la versión 0.2 en `http://localhost:8000/`, la base es la misma porque la ruta no forma parte del origen.

Usar `file://` puede ocasionar comportamientos inconsistentes en el almacenamiento. No alternes entre `localhost` y `127.0.0.1` esperando compartir datos.

## Primer uso

1. Hacé clic en **Ver ejemplo**. Es ficticio y no se guarda.
2. Guardá una carta nueva con al menos el frente de una hoja. Agregá el dorso u otras páginas cuando corresponda.
3. Recargá la página, abrí tu recuerdo, probá giro, zoom, frente/dorso y búsqueda.
4. Exportá un respaldo, guardalo en un lugar seguro y verificá su restauración en otro perfil.

## Compatibilidad y límites

- Importa respaldos `nuestro-archivo-v1` (0.1) y `nuestro-archivo-v2` (0.2).
- El visor usa perspectiva CSS 3D con hoja plana: **no es un escaneo volumétrico real**.
- Permite JPEG, PNG, WebP y GIF de hasta 35 MB por foto; **no HEIC/HEIF**.
- Importación v2 actual: si encuentra un ID repetido, reemplaza el recuerdo existente tras la confirmación general; si la importación falla a mitad, puede dejar un subconjunto ya incorporado. Guardá respaldo ANTES de importar.
- El JSON de respaldo incluye todas las fotos en base64 y **no está cifrado**.
- No hay cuenta, servidor de fotos ni sincronización entre dispositivos. La base local puede borrarse con los datos del navegador.
- Las imágenes originales se preservan como `Blob` junto a las miniaturas derivadas; la separación en entidades `OriginalAsset`/`DerivedAsset` corresponde a la versión 0.3.

## Pruebas

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
python -m unittest discover -s tests -v
```

Las pruebas E2E levantan un servidor HTTP local con puerto aleatorio, inician Chromium, guardan fotografías **sintéticas**, recargan la página y comparan SHA-256 de los `Blob` almacenados y restaurados. **No usan mocks de IndexedDB**.

El navegador ejecutado dentro del entorno de creación de este PR puede impedir la navegación por políticas del administrador, por lo que el resultado definitivo se obtiene en **GitHub Actions** o un navegador local sin ese bloqueo. Ver el estado de los checks antes de dar la prueba como superada.

## Aviso de privacidad

El repositorio es público. **No subas cartas reales, respaldos JSON ni fotografías personales** a GitHub. Usá exclusivamente datos ficticios en tests, commits, capturas e issues.

## Laboratorio de digitalización asistida (0.3A.1, experimental)

Abrí `http://localhost:8000/app/digitalizar.html` o usá el botón **Digitalizar foto** en la biblioteca.

1. Seleccioná una foto de una carta tomada desde arriba (JPEG/PNG/WebP/GIF, hasta 35 MB).
2. Ajustá manualmente las cuatro esquinas (en sentido horario, desde arriba a la izquierda). Se pueden mover con mouse, tacto o flechas del teclado, y Mayús acelera el movimiento.
3. Pulsá **Enderezar carta** para generar una vista previa rectificada.
4. Descargá el PNG generado y, si querés, cargalo **manualmente** en una hoja de la biblioteca.

**Alcance actual:** usa homografía en JavaScript local, sin dependencia CDN, no hay detección automática de esquinas ni integración con OpenCV.js todavía. El procesamiento limita el origen a 2400 px en su lado mayor y la salida a 1600 px; no reemplaza el archivo original, que sólo permanece en memoria durante la sesión. Las cartas ya guardadas en IndexedDB **no son tocadas ni migradas** por el laboratorio. No enviar fotos a repositorios públicos. El próximo corte debe almacenar el original y su derivado vinculado en la biblioteca con esquema versionado y respaldos compatibles.

Para probar el algoritmo: `node --test tests/test_perspective.cjs`. Las pruebas E2E en `tests/test_digitalizacion.py` prueban la carga, el recorte, la descarga y la ausencia de escrituras en IndexedDB.

## Guardado vinculado: 0.3A.2 (PR apilado, experimental)

El laboratorio `app/digitalizar.html` ahora permite **Guardar nueva carta** desde una fotografía enderezada. Al usar ese botón:

1. Se almacena la fotografía cargada en `pages[0].front` como **original** (Blob/File sin modificar).
2. El PNG corregido queda en `pages[0].frontDerived`; se conservan puntos y dimensiones en `pages[0].frontCrop`, con `algorithm=homography-js-v1`.
3. Se crea un **nuevo** recuerdo con `schemaVersion=3` en el *mismo* `IndexedDB` (`nuestro-archivo-cartas-v1` / `letters`). El código usa `add` y no reescribe IDs existentes.
4. En el visor, **Ver fotos originales / Ver digitalización** permite comparar la textura sin reemplazar los bytes originales.
5. **Exportar respaldo** ahora genera el formato `nuestro-archivo-v3`, con originales, derivados y parámetros. **Importar respaldo** admite v1/v2/v3 y procesa/valida antes de guardar en una sola transacción.

### Compatibilidad y seguridad de tus recuerdos existentes

- Los registros de 0.2 permanecen con su estructura y sus fotos; **no hay migración automática destructiva ni incremento de versión de base IndexedDB**. Los datos antiguos se normalizan al leer; los registros editados o importados pasan a formato de registro 3.
- **Primero exportá un respaldo privado desde el navegador donde ya guardaste tus recuerdos.** No elimines ese respaldo hasta comprobar una restauración completa; las copias JSON siguen sin cifrar.
- Si arrancás el servidor en otro **origen** (host, puerto o protocolo distinto), verás otra base local. Firefox y Chromium tampoco comparten IndexedDB.
- El guardado asistido crea una **carta nueva de una hoja (frente)**, no adjunta una hoja a una carta existente, no digitaliza reversos en este flujo y no detecta esquinas automáticamente. Se añadirán en cortes posteriores.
- **No guardes JSON de respaldo, fotografías ni nombres reales en GitHub público.**

### Validación automatizada

`python -m unittest discover -s tests -v` cubre persistencia real, compatibilidad v1/v2/v3, original y derivado con SHA-256, importación atómica ante archivo inválido y regresión del visor. `node --test tests/test_perspective.cjs` verifica la geometría.

**Limitación de diseño:** los activos original/derivado siguen embebidos en cada página del registro para preservar el esquema físico actual. La separación en stores independientes con migración explícita es trabajo futuro y no se declara implementada.

## Captura sobre cartas existentes — 0.3A.3 (PR apilado)

En la biblioteca abrí una carta existente y elegí la hoja que querés corregir. Desde **Digitalizar esta hoja**, usá:

- **Digitalizar frente:** abre la fotografía original ya guardada de ese frente. No permite reemplazarla por otra foto desde esta pantalla.
- **Digitalizar reverso:** si ya existe una fotografía original, la reutiliza sin reemplazarla. Si el reverso está vacío, primero permite cargar una foto original y después genera su recorte derivado.
- Ajustá las cuatro esquinas, pulsá **Enderezar carta** y después **Guardar esta cara**.

La operación sólo modifica el **derivado y los parámetros de recorte de esa cara**. Si el reverso no tenía foto, también agrega ese archivo como original. No toca los frentes, los demás reversos, otras hojas ni otros recuerdos. Se conserva el mismo ID, título, notas y demás metadatos de la carta. Para evitar pérdidas de edición por pestañas simultáneas, el guardado se rechaza si cambió `updatedAt` desde que abriste la digitalización.

La base sigue siendo IndexedDB `nuestro-archivo-cartas-v1` / `letters`. Los respaldos v3 exportan originales, derivados y parámetros de ambas caras; se importan v1, v2 y v3. No hay cambios destructivos de esquema ni escritura masiva sobre cartas antiguas.

**Antes de probar:** exportá un respaldo JSON v3 de tus recuerdos actuales desde el **mismo Firefox y origen (`localhost:8000`)**. Conservá una copia fuera del proyecto. Si cargás el proyecto desde otro puerto, host, protocolo o perfil, el navegador tendrá un almacenamiento separado. El JSON no está cifrado; no lo compartas ni lo subas al repositorio público.

**Limitaciones:** la homografía es manual, todavía no hay detector automático de bordes, OpenCV.js ni visor Three.js. Para reemplazar fotografías originales de caras ya archivadas, usá el editor general: eso **invalida** el recorte anterior y exige regenerarlo. La captura contextual evita reemplazos accidentales.

**Pruebas:** `python -m unittest discover -s tests -v` incluye casos de varias hojas, reversos ya presentes o faltantes, original preservado, respaldo/restore v3, y conflicto con otra pestaña. `node --check app/capture-existing.js` verifica sintaxis del módulo.


## Visor físico 0.3B.1 — experimento Three.js local

Este primer visor 3D usa Three.js **instalado en el proyecto** (versión exacta fijada en \`package.json\`) y nunca lo descarga desde un CDN cuando abrís la aplicación. Las fotos proceden exclusivamente de IndexedDB y sólo se procesan en tu navegador. La hoja se aproxima mediante dos superficies diferentes, leve grosor, curvatura e iluminación. **No reconstruye las arrugas ni el relieve real de una carta.**

### Preparación en Windows (PowerShell)

Desde la **carpeta raíz del repositorio** (donde están \`package.json\` y \`app/\`):

\`\`\`powershell
npm install
py -m http.server 8000
\`\`\`

Abrí \`http://localhost:8000/app/\`, elegí una carta y pulsá **Abrir visor 3D**. Si el 3D no puede iniciarse (WebGL ausente, dependencia sin instalar), seguirá disponible una **vista 2D** que muestra frente/reverso y permite navegar por las hojas. El visor 0.3A anterior sigue disponible en la biblioteca; el nuevo no lo reemplaza.

### Funciones 0.3B.1

- Malla subdividida con frente y reverso texturizados **por separado**, usando el derivado corregido cuando exista y conservando el original intacto.
- Canto aproximado de papel, iluminación cálida, control de curvatura.
- Rotación con mouse o touch, zoom con rueda y botones, reset, cambiar cara, cambiar página.
- Botón para alternar entre fotos originales y derivadas y fallback de lectura 2D.
- Gestión de texturas por hoja: limitar a 2048 px para GPU; liberar recursos y cerrar objetos al cambiar de página.
- Se vuelve a la carta seleccionada en la biblioteca sin modificar su ID ni su contenido.

### Privacidad y almacenamiento

- \`app/visor-3d.html\` realiza **sólo lecturas** en la misma base \`nuestro-archivo-cartas-v1/letters\`; no altera ni migra recuerdos.
- Instalar npm requiere acceso a Internet **una sola vez**. La navegación posterior se ejecuta localmente, sin dependencias CDN.
- No subas \`node_modules/\`, cartas reales ni respaldos JSON al repositorio público.
- Si cambiás de host, protocolo, puerto o perfil, IndexedDB cambia de origen; los recuerdos previos pueden no aparecer.

### Pruebas automatizadas

\`\`\`powershell
npm install
node --test tests/test_paper_math.cjs
python -m unittest discover -s tests -v
\`\`\`

Los casos del visor incluyen fallback 2D, cambio de hoja y cara con imágenes ficticias y prueba WebGL si el runner admite aceleración/software rendering. Los E2E antiguos de IndexedDB, Firefox y respaldos siguen activos.

**Pendientes posteriores:** escenas Three.js más expresivas, mejora del espesor y bordes curvos, animación de giro controlada, alternativa accesible con teclado, medición de rendimiento móvil, y fijar un \`package-lock.json\` antes de una distribución reproducible formal.
