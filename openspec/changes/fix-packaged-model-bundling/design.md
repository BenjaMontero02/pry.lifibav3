## Context

Ver `proposal.md` - Why para el diagnostico y la evidencia de CI. Restricciones que condicionan el enfoque:

- Los dos workflows corren en runners distintos (`macos-14` arm64, `windows-latest`). El de Windows ya fuerza `shell: bash` solo para poder usar un heredoc de Python; el de Mac usa el bash por defecto. Cualquier logica en shell se duplica y divergen.
- El AdaFace ONNX pesa 260 MB, `python/models/` esta en `.gitignore:15`, y su checkpoint de origen vive en Google Drive y requiere `torch` para convertirse. No es reproducible dentro de un job de CI.
- El repo es publico (`BenjaMontero02/pry.lifibav3`) y **hoy no tiene ningun Release**, solo tags `v0.1.0`..`v0.1.3`.
- `python-child` es un one-file de PyInstaller: en runtime los modelos viven bajo `sys._MEIPASS`, que es un directorio temporal de **solo lectura efectiva**. Cualquier descarga en runtime esta condenada.
- El protocolo con Electron es JSON por linea sobre stdout, y `redirect_stdout_to_stderr()` existe justamente porque insightface y onnxruntime escriben en stdout. Toda verificacion nueva debe respetar eso.

## Goals / Non-Goals

**Goals:**

- Una sola implementacion de preparacion de modelos, compartida por los dos workflows y ejecutable en local.
- Que un modelo faltante o mal estructurado sea un error de build, no una advertencia.
- Que la verificacion previa a publicar ejercite la carga real de los modelos dentro del bundle.
- Que el fallo de carga de modelos, si igual ocurriera, sea visible para el operador.

**Non-Goals:**

- Reproducir la conversion del checkpoint AdaFace a ONNX dentro de CI.
- Firmar o notarizar la app en macOS.
- Cambiar el switch de backend de embeddings (`LIFIBA_EMBEDDING_BACKEND`) ni su semantica en el manifest del indice.
- Cachear los modelos entre corridas de CI (optimizacion, no correctitud).

## Decisions

### 1. Un script Node unico (`scripts/prepare-models.cjs`) en lugar de pasos de shell por workflow

Los workflows quedan con un solo `run: node scripts/prepare-models.cjs`. Node ya es la herramienta de build del repo (`scripts/build-python.cjs`, `smoke-child.cjs`), esta disponible en ambos runners antes que cualquier dep de Python, y elimina la divergencia entre el bash de Mac y el `shell: bash` forzado de Windows.

*Alternativas consideradas:* heredoc de Python por workflow (lo de hoy - se duplica y ya divergio); script Python (`prepare_models.py`) - viable, pero ata la preparacion de modelos al entorno Python del runner, que es justo lo que despues queremos validar de forma independiente.

### 2. La descarga de antelopev2 no pasa por insightface

`insightface.utils.storage.download()` es la fuente del bug: hace `zf.extractall(dir_path)` sobre `models/antelopev2/` cuando el zip ya trae un `antelopev2/` interno. En lugar de llamar a `FaceAnalysis(name=...)` para provocar la descarga, el script baja el zip de la URL fijada y lo extrae **aplanando**: cualquier entrada del zip se escribe en `models/antelopev2/<basename>`, ignorando directorios intermedios y entradas de metadata de macOS (`__MACOSX/`, `._*`).

Ese aplanado es correcto y no fragil: el pack es una lista plana de `.onnx`, y despues del extract se verifica la lista exacta de nombres esperados. Si upstream cambiara la estructura, la verificacion falla en lugar de empaquetar basura.

*Alternativas consideradas:* llamar a insightface y despues corregir la anidacion (depende de un comportamiento buggy que puede cambiar); parchear insightface (invasivo, y hay que mantenerlo).

### 3. Manifiesto declarativo de modelos (`scripts/models.json`)

Un unico archivo con, por modelo: URL, SHA-256, destino y archivos esperados. El script es logica; el manifiesto es dato. Cambiar de version de modelo o de host es editar JSON, y el mismo archivo es la fuente de verdad para la validacion en `build.spec`.

Valores ya medidos sobre los archivos locales que hoy producen un build funcional:

| Modelo | Bytes | SHA-256 |
|---|---|---|
| `antelopev2.zip` | 360.662.982 | `8e182f14fc6e80b3bfa375b33eb6cff7ee05d8ef7633e738d1c89021dcf0c5c5` |
| `adaface_ir101_webface12m.onnx` | 260.696.317 | `36556268033749ed0779399a696c9ead051115bd68c595331c45abfd1c430766` |

### 4. AdaFace se sirve como asset de un Release propio, descargado por HTTPS directo

Se crea el Release `models-v1` en este repo con el `.onnx` como asset. Al ser publico, el script lo baja por HTTPS directo (`https://github.com/<owner>/<repo>/releases/download/models-v1/...`) sin `gh` ni token: menos dependencias en el job y funciona igual en local.

*Alternativas consideradas:* convertir en CI desde el `.ckpt` de Google Drive (rate-limit, `torch` de ~2 GB, builds fragiles); Git LFS (consume cuota de bandwidth en cada build y engorda todo clone); repo de Hugging Face de terceros (pesos no verificables contra los que ya se usan).

*Trade-off aceptado:* el Release es un paso manual previo, y el `.onnx` deja de ser reproducible desde su fuente original en un solo comando. Se mitiga registrando en `models.json` el SHA-256 y, en la descripcion del Release, como se produjo (`scripts/convert_adaface_to_onnx.py` + checkpoint de origen).

### 5. `build.spec` valida contra el manifiesto y aborta

`build.spec` pasa de `os.path.isdir()` + `sys.stderr.write(WARNING)` a: leer `scripts/models.json`, verificar por cada modelo que existan los archivos esperados, y `raise SystemExit(<mensaje>)` si falta alguno. PyInstaller propaga el fallo del spec, `build-python.cjs` ya chequea `build.status !== 0`, y `pnpm run build` corta antes de electron-builder por el `&&` de la cadena. No hace falta plomeria nueva.

La validacion de estructura pasa a ser "existen los `.onnx` esperados", no "existe el directorio" - que es exactamente lo que dejo pasar el bundle roto.

### 6. La verificacion de extremo a extremo es una accion `self_check` del backend, no una imagen de prueba

`smoke:child` hoy manda `ping`, que prueba imports nativos pero no toca los modelos. La alternativa obvia -indexar una foto de prueba- exige versionar una imagen con un rostro real en un repo publico: es un dato biometrico de una persona, con licencia y privacidad que resolver, para un beneficio que se puede obtener sin eso.

Se agrega en su lugar una accion `self_check` al router que construye el analizador (`get_face_analyzer()`, que es donde revienta hoy) y devuelve que modelos quedaron cargados y que backend de embeddings esta activo. El smoke exige `detection: true` y `embeddingBackend: "adaface"`. Eso cubre las dos fallas reales -antelopev2 ausente y AdaFace ausente con fallback silencioso- sin fixtures.

La accion se ejecuta bajo `redirect_stdout_to_stderr()`, como el resto de la carga de modelos, para no corromper el protocolo.

*Alternativa considerada:* generar una cara sintetica en tiempo de smoke - no hay garantia de que el detector la encuentre, y un smoke que pasa "por suerte" es peor que ninguno.

### 7. El bridge decide por `ok`, no por la verdad del mensaje

`python-bridge.js:132` usa `if (parsed.error)`, y `""` es falsy: un fallo se resuelve como exito. Pasa a decidir por `parsed.ok === false` y, si el mensaje viene vacio, sustituye por un texto que nombra la accion y el `requestId`. En paralelo, `main.py` normaliza (`str(error) or repr(error)` / nombre de la clase), asi que el vacio se ataca en los dos extremos: el backend deja de emitirlo y el bridge deja de confiar en que no lo emita.

### 8. La UI no infiere exito de la ausencia de datos

`usePhotos.js:466` escribe "Analisis completo." cuando no hay `stats`. Pasa a tratar la ausencia de `stats` como fallo y a mostrar el error. Es la ultima red: cualquier respuesta anomala futura se ve, no se disimula.

## Risks / Trade-offs

- **La URL del release v0.7 de insightface deja de existir o cambia de contenido** → El SHA-256 fijado hace que un cambio de contenido falle el build en vez de pasar inadvertido; si desaparece, se mitiga subiendo `antelopev2.zip` como segundo asset de `models-v1` (mismo mecanismo ya implementado, solo cambia la URL en `models.json`).
- **El Release `models-v1` es un prerequisito manual** → Si no existe, todo build de CI falla en el primer paso con un mensaje explicito. Es un fallo ruidoso y auto-explicativo, no un instalador roto.
- **620 MB de descarga por build** (360 del zip + 260 del onnx) → Suma ~1-2 min al job. Aceptable frente al costo actual de publicar instaladores inservibles; si molesta, `actions/cache` sobre los destinos es un cambio aditivo posterior.
- **Bandwidth del asset publico** → Los assets de Release en repos publicos no tienen cuota facturada como LFS. Riesgo bajo.
- **`self_check` amplia la superficie del router** → Es una accion de solo lectura que no toca el indice ni el filesystem del usuario. No se expone en `PYTHON_ACTIONS` de `main.js`, asi que no queda alcanzable desde el renderer.
- **El smoke pasa a tardar mas** (carga antelopev2 + AdaFace, ~30 s) → El timeout actual de `smoke-child.cjs` es 30.000 ms y quedaria justo. Se sube a 120.000 ms.

## Migration Plan

1. Publicar el Release `models-v1` con `adaface_ir101_webface12m.onnx` como asset. **Manual, una sola vez.** Sin esto, todo build de CI falla.
2. Mergear el cambio. El primer build de CI es la verificacion: si `prepare-models` o `self_check` fallan, el instalador no se publica.
3. Reinstalar en Mac y Windows desde los artefactos nuevos. El manifest del indice pasa de `antelopev2` a `adaface_ir101_webface12m` en las instalaciones que venian de un build de CI, lo que dispara el rebuild automatico por `embedding_model_changed` - mecanismo ya existente, no requiere accion del operador.

**Rollback:** revertir el commit. Los builds vuelven a producir instaladores sin modelos - es decir, al estado roto actual. No hay estado persistente que deshacer: nada de esto migra datos.

## Open Questions

- Si en el futuro se agrega un tercer modelo, conviene mover tambien `antelopev2.zip` al Release propio para tener un unico origen bajo control. No cambia specs, approach ni tareas: es un cambio de una linea en `models.json` cuando haga falta.
