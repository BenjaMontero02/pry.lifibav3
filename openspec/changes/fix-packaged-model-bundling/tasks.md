## 1. Prerequisito manual (bloquea el pipeline) - hecho: https://github.com/BenjaMontero02/pry.lifibav3/releases/tag/models-v1

- [x] 1.1 Publicar el Release `models-v1` en `BenjaMontero02/pry.lifibav3` con `python/models/adaface_ir101_webface12m.onnx` como asset, y dejar en la descripcion del Release como se produjo el archivo (`scripts/convert_adaface_to_onnx.py` + checkpoint AdaFace IR-101 WebFace12M)
- [x] 1.2 Verificar que la URL directa del asset responde sin autenticacion y que el SHA-256 descargado es `36556268033749ed0779399a696c9ead051115bd68c595331c45abfd1c430766`

## 2. Manifiesto y preparacion de modelos

- [x] 2.1 Crear `scripts/models.json` con una entrada por modelo: id, url, sha256, bytes, tipo (`zip-flatten` | `file`), destino y lista de archivos esperados
- [x] 2.2 Crear `scripts/prepare-models.cjs`: descarga con seguimiento de redirects, verificacion de SHA-256 contra el manifiesto y salida distinguiendo "no se pudo descargar" de "se descargo mal"
- [x] 2.3 Implementar en el script la extraccion aplanada del zip: cada entrada se escribe en `<destino>/<basename>`, ignorando directorios intermedios, `__MACOSX/` y `._*`
- [x] 2.4 Implementar la verificacion post-extraccion contra la lista de archivos esperados, con exit code distinto de 0 y mensaje que nombre el archivo faltante y la ruta esperada
- [x] 2.5 Implementar el salteo idempotente: si el destino ya tiene todos los archivos esperados, no volver a descargar (permite correr el script en local sin costo)
- [x] 2.6 Agregar el script `prepare:models` a `package.json`
- [x] 2.7 Verificar en local: borrar `~/.insightface/models/antelopev2`, correr `pnpm run prepare:models` y confirmar que quedan los 5 `.onnx` planos (`scrfd_10g_bnkps`, `glintr100`, `1k3d68`, `2d106det`, `genderage`)

## 3. Empaquetado que aborta si falta un modelo

- [x] 3.1 Reemplazar en `python/build.spec` los dos bloques de WARNING por lectura de `scripts/models.json` y validacion de archivos esperados por modelo
- [x] 3.2 Hacer que la validacion falle el build con `raise SystemExit(<mensaje con modelo y ruta>)` en lugar de escribir en stderr y continuar
- [x] 3.3 Verificar que la validacion aborta - hecho ejecutando el bloque de validacion de `build.spec` con el manifiesto saboteado (PyInstaller no esta instalado en la maquina local, asi que el build completo se verifica en CI en 8.2)

## 4. Resolucion de modelos en runtime

- [x] 4.1 Cambiar `_resolve_insightface_root()` en `python/app/services/face_index_service.py` para exigir la presencia de al menos un `.onnx` en `<root>/models/<DETECTION_MODEL_NAME>`, no solo que el directorio exista
- [x] 4.2 Hacer que `get_face_analyzer()` falle con un mensaje explicito cuando el pack de deteccion este ausente o vacio, en lugar de propagar el `AssertionError` sin texto de insightface

## 5. Verificacion de extremo a extremo sobre el bundle

- [x] 5.1 Agregar la accion `self_check` al router de Python: construye el analizador bajo `redirect_stdout_to_stderr()` y devuelve los modelos cargados y el backend de embeddings activo
- [x] 5.2 Cambiar `scripts/smoke-child.cjs` de `ping` a `self_check`, exigiendo `detection: true` y `embeddingBackend: "adaface"`, y fallando con el detalle del error de carga
- [x] 5.3 Subir el timeout de `smoke-child.cjs` de 30.000 ms a 120.000 ms para cubrir la carga real de los modelos
- [x] 5.4 Confirmar que `self_check` NO queda en `PYTHON_ACTIONS` de `electron/main.js` (no alcanzable desde el renderer)
- [ ] 5.5 Verificar en local: `pnpm run build:python && pnpm run smoke:child` pasa con los modelos presentes, y falla con mensaje claro con antelopev2 renombrado

## 6. Errores del backend siempre visibles

- [x] 6.1 Normalizar el error en `python/main.py` para que nunca sea string vacio (usar el texto de la excepcion o, en su defecto, el nombre de su clase)
- [x] 6.2 Cambiar `electron/python-bridge.js` para decidir por `parsed.ok === false` en lugar de `if (parsed.error)`, con mensaje sustituto que nombre accion y `requestId` cuando el error venga vacio
- [x] 6.3 Cambiar `src/windows/operator/hooks/usePhotos.js` para tratar la respuesta sin `stats` como fallo y mostrar el error, en lugar de escribir "Analisis completo."
- [ ] 6.4 (pendiente, requiere correr la app en dev) Verificar la cadena completa en dev: forzar el fallo de carga (renombrar `~/.insightface/models/antelopev2`), disparar la indexacion y confirmar que la vista Fotos muestra un error con detalle y NO "Analisis completo."

## 7. Workflows de CI

- [x] 7.1 Reemplazar en `.github/workflows/build-mac.yml` el step "Prefetch InsightFace models" (heredoc con `try/except`) por `node scripts/prepare-models.cjs`
- [x] 7.2 Aplicar el mismo reemplazo en `.github/workflows/build-win.yml` y evaluar si sigue haciendo falta el `defaults.run.shell: bash` una vez que no hay heredoc
- [x] 7.3 Confirmar que ningun step relacionado con modelos captura errores para continuar

## 8. Validacion final

- [x] 8.1 `pnpm run check` en verde
- [ ] 8.2 Disparar los dos workflows con `workflow_dispatch` y confirmar en el log que no aparece ningun WARNING de modelo faltante y que el smoke reporta el backend `adaface`
- [ ] 8.3 Instalar el `.dmg` en la Mac, indexar una carpeta con JPGs y confirmar barra de progreso y conteo de rostros
- [ ] 8.4 Instalar el `.exe` de CI en Windows y confirmar el mismo comportamiento (hoy ese instalador tambien esta roto)
