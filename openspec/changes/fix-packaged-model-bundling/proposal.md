## Why

Los instaladores generados por CI (`.dmg` y `.exe`) salen sin los modelos faciales y el CI queda en verde. El log del run mac `31261474349` y del run windows `31260557216` muestran el mismo fallo: el prefetch de antelopev2 descarga el zip al 100% y despues revienta con una excepcion **de mensaje vacio**, porque `insightface/utils/storage.py:22` hace `zf.extractall(dir_path)` sobre `models/antelopev2/` y el zip ya trae una carpeta `antelopev2/` adentro, dejando los `.onnx` un nivel mas abajo de donde `face_analysis.py:45` los busca. `build.spec:31` solo valida `os.path.isdir(...)`, que da `True` porque la carpeta existe, asi que empaqueta el directorio inservible sin emitir su WARNING. El AdaFace ONNX nunca se empaqueta en CI: `python/models/` esta en `.gitignore:15` y el archivo de 260 MB no viaja al runner.

Ese fallo llega mudo al operador: la excepcion es un `assert` sin mensaje, `main.py:26` la serializa como `{"ok": false, "error": ""}`, y en `python-bridge.js:132` la guarda `if (parsed.error)` trata `""` como falsy y **resuelve la promesa en vez de rechazarla**. `main.js:1550` se saltea la validacion porque `ok` es `false`, y `usePhotos.js:466` no encuentra `stats` y escribe "Analisis completo.". El operador ve exito instantaneo, sin barra de progreso y sin error. Hoy la app solo funciona con builds locales, donde los modelos ya estan en disco.

## What Changes

- La descarga de antelopev2 en CI deja de delegarse a insightface: se baja el zip del release fijado y se extrae **aplanando** la carpeta anidada, dejando los `.onnx` en `~/.insightface/models/antelopev2/*.onnx`.
- El AdaFace ONNX se publica una vez como **asset de un GitHub Release de este repo** y el CI lo descarga con verificacion de SHA-256 antes de empaquetar. No entra `torch` ni Google Drive al pipeline.
- `build.spec` deja de conformarse con `isdir()`: verifica que existan los `.onnx` esperados de antelopev2 y el AdaFace ONNX, y **falla el build** si falta alguno. **BREAKING** para el pipeline: un build sin modelos completos ya no produce instalador.
- El paso de prefetch en ambos workflows deja de tragarse la excepcion: si la descarga o la verificacion fallan, el job falla.
- `smoke:child` deja de probar solo `ping`: indexa una imagen de prueba versionada en el repo y exige que se detecte al menos un rostro, cubriendo la carga real de los modelos dentro del bundle.
- Ningun error del backend puede llegar vacio ni pasar por exito: Python garantiza mensaje no vacio, el bridge decide por `ok === false` en lugar de por la verdad del string, y la vista Fotos muestra el error en vez de "Analisis completo.".

**No incluye**: cambios en el algoritmo de deteccion o embeddings, ni firma/notarizacion de la app en macOS (`hardenedRuntime: false` y firma ad-hoc se mantienen), ni el problema de calidad por caer al backend insightface (queda resuelto de hecho al empaquetar AdaFace, pero no se toca el switch de backend).

## Capabilities

### New Capabilities
- `model-bundling`: garantia de que todo instalador publicado contiene los modelos faciales completos y utilizables offline - origen fijado y verificable de cada modelo, validacion en tiempo de build que aborta si falta o esta mal estructurado, y verificacion de extremo a extremo sobre el binario ya empaquetado.
- `backend-error-reporting`: garantia de que cualquier fallo del proceso Python llega visible al operador - sin errores de mensaje vacio, sin fallos reportados como exito, y con el detalle suficiente para diagnosticar sin abrir una terminal.

### Modified Capabilities
<!-- Ninguna: openspec/specs/ todavia esta vacio. El cambio toca comportamiento que `add-explicit-index-panel` describe en su propio delta (`specs/photo-indexing/spec.md`), pero esa capability aun no esta archivada como spec del repo. -->

## Impact

- `.github/workflows/build-mac.yml` y `.github/workflows/build-win.yml` - reemplazo del step de prefetch por descarga + aplanado + verificacion de antelopev2, nuevo step de descarga del AdaFace ONNX desde el release asset, y quitar el `try/except` que enmascara fallos.
- Nuevo script de preparacion de modelos (compartido por ambos workflows y usable en local) que descarga, aplana y valida; hoy esa logica esta implicita en un heredoc de cada workflow.
- `python/build.spec:31-58` - validacion estricta de antelopev2 y AdaFace; los WARNING pasan a error.
- `python/app/services/face_index_service.py:140-158` - `_resolve_insightface_root()` debe reconocer estructura correcta (presencia de `.onnx`), no solo que el directorio exista.
- `python/main.py:26` - normalizar el error para que nunca sea string vacio.
- `electron/python-bridge.js:132` - resolver/rechazar segun `ok`, no segun `parsed.error` truthy.
- `src/windows/operator/hooks/usePhotos.js:466` - no reportar "Analisis completo." cuando la respuesta no trae `stats`.
- `scripts/smoke-child.cjs` - pasa de `ping` a una indexacion real; requiere una imagen de prueba versionada (nueva, chica, con un rostro).
- Release de este repo con el asset del AdaFace ONNX (~260 MB) - tarea manual, una sola vez, prerequisito del pipeline.
- `.gitignore:15` se mantiene: el `.onnx` sigue fuera del repo, ahora con origen declarado.
