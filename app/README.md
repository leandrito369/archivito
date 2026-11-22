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
