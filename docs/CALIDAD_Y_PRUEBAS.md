# Calidad, validación y criterios de aceptación

## Evidencia actual (prototipo externo 0.2)

Se documentaron pruebas de sintaxis JavaScript e interfaz con Chromium/Playwright: navegación de hojas/caras, CRUD, favoritos, filtros, cronología, exportación/importación v2 e importación v1. **Limitación:** la simulación de IndexedDB utilizada en la prueba de interfaz no demuestra persistencia real del navegador. Estas pruebas no son todavía parte del CI de este repositorio.

## Prueba manual mínima de integración 0.2

1. Ejecutar con un servidor local: `python -m http.server 8000` desde la carpeta que contiene `index.html`, abrir `http://localhost:8000/`.
2. Crear un recuerdo con dos hojas (frentes y dorsos de prueba); guardar.
3. Recargar y cerrar/reabrir navegador. Verificar que la biblioteca y las imágenes persistieron.
4. Abrir visor: comprobar cara, hoja, giro, zoom y reset.
5. Editar título, fecha y etiquetas; comprobar que no desaparecen imágenes.
6. Exportar respaldo v2 e importarlo en perfil/origen limpio. Verificar registro y bytes de fotos.
7. Importar respaldo v1 ficticio. Confirmar migración sin pérdida.
8. Borrar únicamente un recuerdo de prueba y verificar que no afecta otros.

## Criterios para cerrar 0.3

- **CA-01:** una fotografía de papel oblicua se corrige con cuatro esquinas ajustables.
- **CA-02:** existe previsualización antes de persistir el recorte.
- **CA-03:** la imagen original queda intacta y vinculada al derivado.
- **CA-04:** el visor representa frente/dorso correctamente, con órbita y zoom.
- **CA-05:** cualquier hoja puede abrirse en modo lectura 2D.
- **CA-06:** se importan archivos v1/v2 de prueba sin perder fotos originales.
- **CA-07:** exportar/restaurar la colección conserva contenido e integridad binaria (comparación de hashes).
- **CA-08:** si WebGL falla, se ofrece visor alternativo 2D y no se pierde acceso al contenido.
- **CA-09:** no existe envío de fotografías a servidores externos por defecto.
- **CA-10:** funcionamiento offline luego de una instalación PWA válida se exige **sólo cuando PWA esté implementada**, no se atribuye a 0.2.

## Estrategia de pruebas

- **Unitarias:** normalización, validación de imágenes, geometría de cuatro puntos, serialización/migración.
- **Integración:** IndexedDB real, Blob originales, restauración, errores de importación.
- **End-to-end:** biblioteca→captura→visor→exportar→restaurar.
- **Visuales:** textos legibles, proyección correcta de caras, fotos verticales/horizontales.
- **No funcionales:** memoria con fotografías grandes, tacto/mouse, teclado, mobile, modo offline, seguridad del almacenamiento.

**No pasar de simulaciones a declaraciones de persistencia validada sin pruebas en navegador real.**
