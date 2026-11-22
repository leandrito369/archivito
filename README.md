# Archivito

**Biblioteca local y privada de recuerdos, cartas y fotografías con visor interactivo.**

Archivito preserva fotografías originales de cartas, sobres y recuerdos y permite recorrerlas con una biblioteca, cronología y un visor de frente/reverso. La aplicación es **local-first**: las fotos se guardan en IndexedDB en el navegador; **no hay cuentas ni nube**.

## Estado al 22/11/2026

- **0.2 integrada en main** mediante PR #6: biblioteca, favoritos, filtros, varias hojas, originales en IndexedDB y respaldos.
- **0.3A integrada en main** mediante PR #7, #8 y #9: digitalización de perspectiva manual, fotografías originales vinculadas a derivados, respaldo JSON v3 e incorporación de frente/reverso de hojas existentes.
- **0.3B.1 experimental**: [PR #11](https://github.com/leandrito369/archivito/pull/11) desarrolla un visor **Three.js** con malla de papel, dos caras, espesor y curvatura aproximados. Hasta su revisión y merge, está en una rama; el visor CSS 3D integrado sigue siendo la opción estable.
- **0.4 futura**: integridad del archivo, respaldos cifrados y mejoras de preservación.
- **1.0 futura**: biblioteca privada compartida entre dos personas, tras diseñar su seguridad.

## Ejecutar la biblioteca estable

Con Python 3 desde la raíz del repositorio:

\`\`\`powershell
py -m http.server 8000 --bind 127.0.0.1
\`\`\`

Abrí \`http://localhost:8000/app/\`. **No cambiés entre \`localhost\` y \`127.0.0.1\`, entre puertos ni entre perfiles de navegador** esperando compartir la misma colección. IndexedDB pertenece al origen y al perfil.

## Probar el visor 3D experimental (PR #11)

Después de cambiar a la rama del PR, con Node y npm instalados:

\`\`\`powershell
npm install
py -m http.server 8000 --bind 127.0.0.1
\`\`\`

Entrá a la biblioteca, abrí una carta y seleccioná **Abrir visor 3D**. Three.js se carga desde \`node_modules\` local; **no se utiliza CDN** para cargar fotografías ni bibliotecas al visualizar cartas. Si falta Three.js o WebGL, la pantalla ofrece una **vista 2D**. Se conserva el visor de siempre.

## Documentación

- [Uso de la app, digitalizador y visor](app/README.md)
- [Visión y requisitos](docs/VISION_Y_ALCANCE.md)
- [Arquitectura](docs/ARQUITECTURA.md)
- [Roadmap](docs/ROADMAP.md)
- [Pruebas](docs/CALIDAD_Y_PRUEBAS.md)
- [Privacidad y preservación](docs/PRIVACIDAD_Y_PRESERVACION.md)
- [ADR-0001: local-first](docs/decisiones/ADR-0001-local-first.md)

## Seguridad de los recuerdos

**El repositorio es público. Nunca subir cartas personales, fotos reales, backups JSON, credenciales ni datos íntimos.** Las muestras de pruebas son sintéticas. El respaldo JSON v3 incluye fotografías originales y derivadas, **no está cifrado**, y debe mantenerse privado. El navegador puede perder datos: conservá originales en otro lugar y probá periódicamente una restauración en un perfil de prueba.

## Principios

Preservación de imágenes originales; derivados no destructivos; operaciones locales por defecto; acceso mediante fallback de lectura 2D; compatibilidad de respaldos versionados. El 3D es **aproximado**, no un escaneo geométrico exacto de dobleces y relieves.

Para funcionalidades futuras y deuda técnica, consultar [issues](https://github.com/leandrito369/archivito/issues).
