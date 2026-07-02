# AdaFace Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar la extracción de embeddings faciales (hoy ArcFace de antelopev2) por AdaFace IR-101 WebFace12M, manteniendo InsightFace solo como detector, para mejorar el reconocimiento con caras chicas, borrosas y de perfil típicas de fotos de eventos deportivos.

**Architecture:** InsightFace (SCRFD de antelopev2) sigue detectando caras y landmarks; las caras detectadas se alinean a 112×112 con `face_align.norm_crop` y el embedding lo produce AdaFace corriendo en onnxruntime (ya es dependencia). El checkpoint PyTorch se convierte a ONNX una sola vez con un script de desarrollo — PyTorch NO entra al runtime ni al bundle. Un switch de backend (`insightface` | `adaface`) permite volver atrás al instante; el `FACE_MODEL_NAME` registrado en el manifest cambia según backend, así que el rebuild del índice al cambiar de modelo es automático (mecanismo ya existente: `embedding_model_changed`).

**Tech Stack:** Python, insightface (detección), onnxruntime (inferencia AdaFace), numpy, FAISS. Solo para conversión offline: torch + repo AdaFace (MIT).

## Global Constraints

- El protocolo Electron↔Python usa stdout exclusivamente para JSON: toda inicialización de modelos debe correr dentro de `redirect_stdout_to_stderr()` (ya existe en `face_index_service.py`).
- Embeddings SIEMPRE L2-normalizados antes de entrar/consultar el índice (`IndexFlatIP` = coseno solo con vectores normalizados). AdaFace produce 512 dims — `EMBEDDING_DIMENSION` no cambia.
- El archivo ONNX (~250MB) NO se commitea: agregar `python/models/` a `.gitignore`.
- PyTorch no puede aparecer en `requirements.txt` ni en el bundle de PyInstaller (pesa >2GB); solo se usa en el script de conversión, instalado a mano.
- No ejecutar tests automatizados (preferencia del usuario); la verificación es por scripts manuales y `python -m compileall -q python`.
- El proyecto no tiene framework de tests: la verificación de cada tarea es un script standalone o un chequeo manual documentado.
- Licencia: código AdaFace MIT; pesos entrenados en WebFace12M (investigación no comercial — mismo estatus que los pesos de InsightFace ya en uso). Documentarlo en el plan, no bloquea.

---

### Task 1: Script de conversión del checkpoint a ONNX

**Files:**
- Create: `scripts/convert_adaface_to_onnx.py`
- Modify: `.gitignore` (agregar `python/models/`)

**Interfaces:**
- Produces: archivo `python/models/adaface_ir101_webface12m.onnx` con input `input` (float32, [batch,3,112,112]) y outputs `embedding` ([batch,512]) y `norm`. Las tareas 2+ consumen ese archivo por ruta.

- [ ] **Step 1: Preparar entorno de conversión (manual, una sola vez)**

```powershell
# En una carpeta temporal fuera del repo (no ensuciar el proyecto):
cd $env:TEMP
git clone https://github.com/mk-minchul/AdaFace
pip install torch --index-url https://download.pytorch.org/whl/cpu
```

Descargar el checkpoint **AdaFace IR-101 WebFace12M** (`adaface_ir101_webface12m.ckpt`) desde el link del README del repo (sección "Pretrained Models", hosteado en Google Drive) y guardarlo en `$env:TEMP\AdaFace\pretrained\`.

- [ ] **Step 2: Crear el script de conversión**

```python
"""Convierte el checkpoint PyTorch de AdaFace a ONNX (solo desarrollo).

Uso:
  python scripts/convert_adaface_to_onnx.py --adaface-repo <ruta clone AdaFace> \
      --checkpoint <ruta .ckpt> --output python/models/adaface_ir101_webface12m.onnx

Requiere torch instalado (no es dependencia del runtime).
"""

import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adaface-repo", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument(
        "--output",
        default=os.path.join("python", "models", "adaface_ir101_webface12m.onnx"),
    )
    args = parser.parse_args()

    import torch

    sys.path.insert(0, args.adaface_repo)
    import net  # definicion del modelo, vive en el repo AdaFace

    model = net.build_model("ir_101")
    # weights_only=True: el .ckpt viene de una descarga externa; sin esto,
    # torch.load despickla objetos arbitrarios (ejecucion de codigo).
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    state_dict = {
        key[len("model."):]: value
        for key, value in checkpoint["state_dict"].items()
        if key.startswith("model.")
    }
    model.load_state_dict(state_dict)
    model.eval()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    dummy = torch.randn(1, 3, 112, 112)
    torch.onnx.export(
        model,
        dummy,
        args.output,
        input_names=["input"],
        output_names=["embedding", "norm"],
        dynamic_axes={"input": {0: "batch"}, "embedding": {0: "batch"}, "norm": {0: "batch"}},
        opset_version=17,
    )
    print(f"OK: {args.output}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Agregar `python/models/` a `.gitignore`**

Al final de `.gitignore` agregar la línea:

```
python/models/
```

- [ ] **Step 4: Ejecutar la conversión y verificar**

```powershell
python scripts/convert_adaface_to_onnx.py --adaface-repo $env:TEMP\AdaFace --checkpoint $env:TEMP\AdaFace\pretrained\adaface_ir101_webface12m.ckpt
```

Expected: imprime `OK: python\models\adaface_ir101_webface12m.onnx` y el archivo pesa ~250MB.

- [ ] **Step 5: Smoke de la sesión ONNX**

```powershell
python -c "import onnxruntime as ort, numpy as np; s = ort.InferenceSession('python/models/adaface_ir101_webface12m.onnx', providers=['CPUExecutionProvider']); out = s.run(None, {'input': np.random.randn(2,3,112,112).astype('float32')}); print(out[0].shape)"
```

Expected: `(2, 512)`

- [ ] **Step 6: Commit (script + gitignore, sin el .onnx)**

```bash
git add scripts/convert_adaface_to_onnx.py .gitignore
git commit -m "feat: script de conversion AdaFace a ONNX"
```

---

### Task 2: Servicio AdaFace (alineación + embedding vía onnxruntime)

**Files:**
- Create: `python/app/services/adaface_service.py`

**Interfaces:**
- Consumes: archivo ONNX de Task 1; `redirect_stdout_to_stderr` y `normalize_embedding` de `app.services.face_index_service`.
- Produces: `compute_embedding(image_bgr, face) -> np.ndarray | None` (512 dims, L2-normalizado, o None si la cara no tiene landmarks o el embedding es inválido) y `is_available() -> bool`.

- [ ] **Step 1: Crear el servicio**

```python
"""Embeddings faciales con AdaFace IR-101 (ONNX) sobre caras detectadas por InsightFace.

AdaFace espera crops BGR 112x112 alineados por landmarks, normalizados a
[-1, 1], en formato NCHW. Las imagenes de cv2 ya estan en BGR.
"""

import os
import sys

import numpy as np
from insightface.utils import face_align

ADAFACE_MODEL_FILENAME = "adaface_ir101_webface12m.onnx"

_session = None
_session_failed = False


def _resolve_model_path():
    if getattr(sys, "frozen", False):
        bundle_dir = getattr(sys, "_MEIPASS", "")
        return os.path.join(bundle_dir, "adaface_models", ADAFACE_MODEL_FILENAME)
    python_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(python_root, "models", ADAFACE_MODEL_FILENAME)


def is_available():
    return os.path.isfile(_resolve_model_path())


def _get_session():
    global _session, _session_failed
    if _session is not None or _session_failed:
        return _session

    from app.services.face_index_service import redirect_stdout_to_stderr

    model_path = _resolve_model_path()
    try:
        import onnxruntime

        with redirect_stdout_to_stderr():
            _session = onnxruntime.InferenceSession(
                model_path, providers=["CPUExecutionProvider"]
            )
    except Exception as error:
        _session_failed = True
        sys.stderr.write(f"AdaFace session failed to load ({model_path}): {error}\n")
    return _session


def compute_embedding(image_bgr, face):
    """Devuelve el embedding AdaFace L2-normalizado para una cara detectada.

    ``face`` es un objeto de insightface con ``kps`` (5 landmarks). Devuelve
    None si no hay landmarks, la sesion no cargo o el embedding es invalido.
    """
    from app.services.face_index_service import normalize_embedding

    session = _get_session()
    landmarks = getattr(face, "kps", None)
    if session is None or landmarks is None:
        return None

    aligned = face_align.norm_crop(image_bgr, landmark=landmarks, image_size=112)
    blob = (aligned.astype(np.float32) / 255.0 - 0.5) / 0.5
    blob = np.transpose(blob, (2, 0, 1))[np.newaxis, ...]

    outputs = session.run(None, {"input": blob})
    return normalize_embedding(outputs[0][0])
```

- [ ] **Step 2: Verificar sintaxis**

```powershell
python -m compileall -q python
```

Expected: sin salida (exit 0).

- [ ] **Step 3: Verificación funcional con una foto real**

```powershell
python -c "import sys; sys.path.insert(0, 'python'); import cv2; from app.services.face_index_service import get_face_analyzer; from app.services import adaface_service; img = cv2.imread(sys.argv[1] if len(sys.argv) > 1 else 'C:/ruta/a/una/foto/con/cara.jpg'); faces = get_face_analyzer().get(img); emb = adaface_service.compute_embedding(img, faces[0]); import numpy as np; print('shape', emb.shape, 'norm', float(np.linalg.norm(emb)))" "C:\ruta\a\una\foto\con\cara.jpg"
```

Expected: `shape (512,) norm 1.0` (usar una foto real de la carpeta sourcepad).

- [ ] **Step 4: Commit**

```bash
git add python/app/services/adaface_service.py
git commit -m "feat: servicio AdaFace (alineacion + embedding ONNX)"
```

---

### Task 3: Switch de backend en face_index_service

**Files:**
- Modify: `python/app/services/face_index_service.py` (constantes `FACE_MODEL_NAME`/backend y nueva función `extract_face_embedding`)

**Interfaces:**
- Consumes: `adaface_service.compute_embedding` / `adaface_service.is_available` (Task 2).
- Produces: `extract_face_embedding(image_bgr, face) -> np.ndarray | None` (única puerta de embeddings para indexado y búsqueda); `FACE_MODEL_NAME` ahora refleja el backend activo (`"adaface_ir101_webface12m"` o `"antelopev2"`), lo que dispara el rebuild automático del índice al cambiar.

- [ ] **Step 1: Reemplazar la constante de modelo por selección de backend**

En `python/app/services/face_index_service.py`, reemplazar el bloque actual:

```python
# antelopev2 (ResNet100 @ Glint360K) reconoce mejor que buffalo_l
# (ResNet50 @ WebFace600K); mismo embedding de 512 dims. Cambiar el modelo
# invalida los indices existentes: index_photos fuerza rebuild si el
# manifest registra otro modelo.
FACE_MODEL_NAME = "antelopev2"
```

por:

```python
# Pack de InsightFace usado SIEMPRE para deteccion (SCRFD + landmarks).
DETECTION_MODEL_NAME = "antelopev2"

# Backend de embeddings:
#  - "adaface": AdaFace IR-101 WebFace12M via ONNX (mejor con caras chicas,
#    borrosas y de perfil). Requiere python/models/adaface_ir101_webface12m.onnx.
#  - "insightface": embedding ArcFace del propio pack antelopev2.
# Se puede forzar con la variable de entorno LIFIBA_EMBEDDING_BACKEND.
# FACE_MODEL_NAME viaja al manifest del indice: cambiar de backend dispara
# el rebuild automatico (embedding_model_changed) en index_photos.
def _resolve_embedding_backend():
    from app.services import adaface_service

    requested = os.environ.get("LIFIBA_EMBEDDING_BACKEND", "adaface").strip().lower()
    if requested == "adaface":
        if adaface_service.is_available():
            return "adaface"
        sys.stderr.write(
            "AdaFace backend requested but model file is missing; "
            "falling back to insightface embeddings.\n"
        )
    return "insightface"


EMBEDDING_BACKEND = None


def get_embedding_backend():
    global EMBEDDING_BACKEND
    if EMBEDDING_BACKEND is None:
        EMBEDDING_BACKEND = _resolve_embedding_backend()
    return EMBEDDING_BACKEND


def get_face_model_name():
    if get_embedding_backend() == "adaface":
        return "adaface_ir101_webface12m"
    return DETECTION_MODEL_NAME
```

- [ ] **Step 2: Actualizar los usos internos de `FACE_MODEL_NAME`**

En el mismo archivo:
- En `_resolve_insightface_root()`: reemplazar `FACE_MODEL_NAME` por `DETECTION_MODEL_NAME` (el bundle de detección sigue siendo el pack de InsightFace).
- En `get_face_analyzer()`: reemplazar `analyzer_kwargs = {"name": FACE_MODEL_NAME, ...}` por `analyzer_kwargs = {"name": DETECTION_MODEL_NAME, ...}`.

- [ ] **Step 3: Agregar la función unificada de extracción**

Al final de `face_index_service.py`:

```python
def extract_face_embedding(image_bgr, face):
    """Embedding L2-normalizado de una cara detectada, segun el backend activo.

    Unica puerta de entrada para indexado y busqueda: garantiza que ambos
    usan el mismo modelo (embeddings de modelos distintos no son comparables).
    """
    if get_embedding_backend() == "adaface":
        from app.services import adaface_service

        return adaface_service.compute_embedding(image_bgr, face)
    return normalize_embedding(getattr(face, "embedding", None))
```

- [ ] **Step 4: Verificar sintaxis**

```powershell
python -m compileall -q python
```

Expected: sin salida (exit 0).

- [ ] **Step 5: Commit**

```bash
git add python/app/services/face_index_service.py
git commit -m "feat: switch de backend de embeddings (adaface/insightface)"
```

---

### Task 4: Usar el backend unificado en indexado y búsqueda

**Files:**
- Modify: `python/app/actions/index_photos.py` (loop de detección y import de `FACE_MODEL_NAME`)
- Modify: `python/app/actions/find_player.py` (extracción de embedding del frame)

**Interfaces:**
- Consumes: `extract_face_embedding(image_bgr, face)` y `get_face_model_name()` de Task 3.
- Produces: manifest con `embedding_model = get_face_model_name()`; el resto de los shapes de respuesta no cambia.

- [ ] **Step 1: index_photos.py — import**

Reemplazar en el bloque de imports:

```python
from app.services.face_index_service import (
    FACE_MODEL_NAME,
    create_empty_index,
    get_face_analyzer,
    is_id_mapped_index,
    load_index,
    normalize_embedding,
)
```

por:

```python
from app.services.face_index_service import (
    create_empty_index,
    extract_face_embedding,
    get_face_analyzer,
    get_face_model_name,
    is_id_mapped_index,
    load_index,
)
```

y reemplazar TODAS las ocurrencias de `FACE_MODEL_NAME` en el archivo por `get_face_model_name()` (hay dos: el trigger de rebuild `embedding_model_changed` y la escritura de `manifest["embedding_model"]`).

- [ ] **Step 2: index_photos.py — loop de detección**

En el loop, reemplazar:

```python
            faces = analyzer.get(image)
            valid_embeddings = []
            for face in faces:
                if not _passes_quality_filter(face):
                    faces_filtered_by_quality += 1
                    continue
                embedding = normalize_embedding(getattr(face, "embedding", None))
                if embedding is not None:
                    valid_embeddings.append(embedding)
```

por:

```python
            faces = analyzer.get(image)
            valid_embeddings = []
            for face in faces:
                if not _passes_quality_filter(face):
                    faces_filtered_by_quality += 1
                    continue
                embedding = extract_face_embedding(image, face)
                if embedding is not None:
                    valid_embeddings.append(embedding)
```

- [ ] **Step 3: find_player.py — extracción del frame**

Localizar `_best_face_embedding` (usa `normalize_embedding(getattr(face, "embedding", None))` sobre la cara elegida del frame decodificado). Cambiar la firma para recibir también la imagen y usar la puerta unificada:

- Import: agregar `extract_face_embedding` desde `app.services.face_index_service` (y quitar `normalize_embedding` si queda sin uso).
- Donde hoy hace `normalize_embedding(getattr(best_face, "embedding", None))`, reemplazar por `extract_face_embedding(image, best_face)` — pasando la imagen BGR ya decodificada del frame (disponible en el mismo scope donde se llamó `analyzer.get(image)`).
- La lógica de selección de cara (por `det_score`) y el promedio multi-frame con re-normalización NO cambian.

- [ ] **Step 4: Verificar sintaxis**

```powershell
python -m compileall -q python
```

Expected: sin salida (exit 0).

- [ ] **Step 5: Verificación funcional del rebuild automático**

Arrancar la app (`pnpm dev`), vista Fotos → "Actualizar fotos". En la respuesta/logs debe verse `rebuildReason: "embedding_model_changed"` (el manifest tenía `antelopev2` y ahora registra `adaface_ir101_webface12m`) y el indexado debe completarse con conteos razonables.

- [ ] **Step 6: Commit**

```bash
git add python/app/actions/index_photos.py python/app/actions/find_player.py
git commit -m "feat: indexado y busqueda usan el backend de embeddings unificado"
```

---

### Task 5: Empaquetado PyInstaller

**Files:**
- Modify: `python/build.spec`

**Interfaces:**
- Consumes: `python/models/adaface_ir101_webface12m.onnx` (Task 1); convención de ruta frozen `<MEIPASS>/adaface_models/` (Task 2, `_resolve_model_path`).

- [ ] **Step 1: Agregar el ONNX de AdaFace a datas**

En `python/build.spec`, después del bloque que agrega los modelos de InsightFace, agregar:

```python
# AdaFace ONNX (backend de embeddings). Ruta frozen esperada por
# app/services/adaface_service.py: <MEIPASS>/adaface_models/.
adaface_model_path = os.path.join("python", "models", "adaface_ir101_webface12m.onnx")
if os.path.isfile(adaface_model_path):
    datas.append((adaface_model_path, "adaface_models"))
else:
    sys.stderr.write(
        "WARNING: AdaFace ONNX not found at {path}. The packaged app will fall "
        "back to insightface embeddings. Run scripts/convert_adaface_to_onnx.py "
        "first if AdaFace is the intended backend.\n".format(path=adaface_model_path)
    )
```

- [ ] **Step 2: Excluir torch del bundle por si está instalado en el venv**

En la llamada `Analysis(...)` del spec, reemplazar `excludes=[]` por:

```python
    excludes=["torch", "torchvision"],
```

- [ ] **Step 3: Verificación**

```powershell
python -m PyInstaller --noconfirm python/build.spec --distpath python/dist --workpath python/build
Get-ChildItem python\dist -Recurse -Filter "adaface_ir101_webface12m.onnx"
```

Expected: el .onnx aparece dentro del bundle bajo `adaface_models\`. (Si el build completo es muy pesado para este momento, dejar este paso para la verificación final de release.)

- [ ] **Step 4: Commit**

```bash
git add python/build.spec
git commit -m "feat: empaquetar modelo AdaFace ONNX en el bundle de PyInstaller"
```

---

### Task 6: Validación A/B contra antelopev2 (gate de adopción)

**Files:**
- Ninguno (verificación manual con la app real).

**Interfaces:**
- Consumes: variable de entorno `LIFIBA_EMBEDDING_BACKEND` (Task 3) para alternar backends sin tocar código.

- [ ] **Step 1: Definir el set de prueba**

Elegir 5-10 jugadores presentes en la carpeta real y anotar (a mano) en qué fotos aparece cada uno — ese es el ground truth.

- [ ] **Step 2: Medir con AdaFace (backend por defecto)**

Con la app corriendo: indexar, escanear a cada jugador con la webcam y anotar cuántas de sus fotos reales aparecen en los resultados (recall) y cuántos desconocidos se cuelan (falsos positivos). Probar umbral 0.30 y 0.35.

Nota: los scores de similitud de AdaFace tienen otra distribución que ArcFace — el umbral óptimo puede ser distinto; ajustar desde el control de la UI de escaneo.

- [ ] **Step 3: Medir con antelopev2**

Cerrar la app y relanzar con el backend alternativo:

```powershell
$env:LIFIBA_EMBEDDING_BACKEND = "insightface"; pnpm dev
```

Reindexar (rebuild automático por cambio de modelo) y repetir las mediciones del Step 2 con los mismos jugadores.

- [ ] **Step 4: Decidir**

Si AdaFace gana (más recall a igual o menos falsos positivos): dejar `adaface` como default y commitear la decisión de umbral si se ajustó. Si pierde o empata: fijar `LIFIBA_EMBEDDING_BACKEND=insightface` como default cambiando el valor por defecto en `_resolve_embedding_backend` y documentar el resultado — el código de AdaFace queda disponible sin costo.

---

## Notas de licencia

- Código AdaFace: MIT (uso libre, incluido comercial).
- Pesos `adaface_ir101_webface12m`: entrenados sobre WebFace12M, cuya licencia es de investigación no comercial. Es la misma situación que los pesos preentrenados de InsightFace (buffalo_l/antelopev2) que la app ya usa. Para un uso comercial estricto habría que entrenar/licenciar pesos propios — decisión de negocio, fuera del alcance técnico de este plan.
