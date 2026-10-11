import contextlib
import os
import sys

import faiss
import numpy as np
from insightface.app import FaceAnalysis
from insightface.app.common import Face
from insightface.utils import face_align

EMBEDDING_DIMENSION = 512
# Pack de InsightFace usado SIEMPRE para deteccion (SCRFD + landmarks).
DETECTION_MODEL_NAME = "antelopev2"

# Backend de embeddings:
#  - "adaface": AdaFace IR-101 WebFace12M via ONNX (mejor con caras chicas,
#    borrosas y de perfil). Requiere python/models/adaface_ir101_webface12m.onnx.
#  - "insightface": embedding ArcFace del propio pack antelopev2.
# Se puede forzar con la variable de entorno LIFIBA_EMBEDDING_BACKEND.
# ``get_face_model_name()`` viaja al manifest del indice: cambiar de backend dispara
# el rebuild automatico (embedding_model_changed) en index_photos.
def _resolve_embedding_backend():
    global _embedding_backend_fallback

    from app.services import adaface_service

    requested = os.environ.get("LIFIBA_EMBEDDING_BACKEND", "adaface").strip().lower()
    if requested == "adaface":
        # No alcanza con que exista el archivo: la sesion ONNX tiene que cargar.
        # Si no carga, las caras se embeben con InsightFace y se avisa.
        if not adaface_service.is_available():
            reason = "falta el archivo del modelo AdaFace"
        elif adaface_service.session_ok():
            return "adaface"
        else:
            reason = adaface_service.session_error() or "la sesion ONNX no cargo"
        _embedding_backend_fallback = reason
        sys.stderr.write(
            "AVISO: AdaFace no disponible ({reason}); se usan embeddings de InsightFace. "
            "El indice se reconstruye con ese modelo.\n".format(reason=reason)
        )
    return "insightface"


EMBEDDING_BACKEND = None
# Motivo por el que se pidio AdaFace y no se pudo usar (None si no hubo fallback).
_embedding_backend_fallback = None


def get_embedding_backend():
    global EMBEDDING_BACKEND
    if EMBEDDING_BACKEND is None:
        EMBEDDING_BACKEND = _resolve_embedding_backend()
    return EMBEDDING_BACKEND


def get_embedding_backend_fallback():
    """Motivo del fallback a InsightFace, o None. Resuelve el backend si hace falta."""
    get_embedding_backend()
    return _embedding_backend_fallback


# Sufijo del pipeline de embedding. Va dentro del nombre de modelo que se guarda
# en el manifest: cambiarlo (p. ej. al agregar el flip TTA) hace que el indice
# viejo se reconstruya solo, porque sus vectores ya no son comparables.
EMBEDDING_VARIANT = "flip"


def get_face_model_name():
    if get_embedding_backend() == "adaface":
        base_name = "adaface_ir101_webface12m"
    else:
        base_name = DETECTION_MODEL_NAME
    return f"{base_name}+{EMBEDDING_VARIANT}"

# Modulos del pack antelopev2 que se cargan. El pack trae tambien
# ``landmark_3d_68`` y ``genderage``, que este proyecto no usa: solo hacen falta
# el detector (bbox + kps) y, para el backend de fallback, ``recognition``.
#
# Cargarlos ademas rompia el indexado empaquetado: ``landmark_3d_68`` lee
# ``meanshape_68.pkl`` con ``insightface.data.get_object()``, que en un binario
# congelado busca en ``sys._MEIPASS/objects/`` y devuelve None -sin excepcion-
# si no esta. Con ``mean_lmk = None``, ``estimate_affine_matrix_3d23d`` reventaba
# con AttributeError en CADA cara de CADA foto. Restringir los modulos saca la
# causa de raiz y ahorra dos inferencias ONNX por cara.
ALLOWED_MODULES = ["detection", "recognition"]

DEFAULT_DET_SIZE = (640, 640)

# Escalas del detector. Indexado y busqueda usan las MISMAS: con tamanos
# distintos los landmarks (y por lo tanto el embedding) de una misma cara
# cambiaban segun quien la detectara.
#
# SCRFD achica la foto entera para que entre en el tamano de entrada: una foto
# de 4000 px a 1024 queda x0.26 y una cara de 80 px pasa a ~20 px, donde el
# detector ya no la ve. Las fotos grandes se pasan tambien a una escala mayor
# y SCRFD fusiona ambas pasadas con NMS.
DETECTION_SIZE = (1024, 1024)
LARGE_IMAGE_DETECTION_SIZE = (2048, 2048)
# Lado mayor (px) a partir del cual se agrega la pasada grande.
LARGE_IMAGE_MIN_SIDE = 1600

# Modo "preciso" (opcional, Ajustes): pasada extra a 3072 en fotos de camara.
# En una foto de 6000 px la pasada 2048 deja una cara de 30 px en ~10 px, el
# limite de SCRFD; a 3072 queda en ~15 px. La deteccion tarda ~3x; el analisis
# completo, 1.5-3x segun cuantas caras haya (los embeddings no cambian).
# Se usa el mismo detector: el SCRFD-34G con landmarks no existe oficialmente y
# el de terceros solo acepta 640 px (peor que las pasadas actuales).
DETECTION_MODE_STANDARD = "standard"
DETECTION_MODE_PRECISE = "precise"
PRECISE_IMAGE_DETECTION_SIZE = (3072, 3072)
# Por debajo de esto la pasada 3072 solo agranda la foto: no suma caras.
PRECISE_IMAGE_MIN_SIDE = 2400

# Indicador en vivo de la camara: una sola pasada chica, solo para saber si hay
# una cara y de que tamano (no se calculan embeddings).
PREVIEW_DETECTION_SIZE = (640, 640)

_face_analyzer = None


@contextlib.contextmanager
def redirect_stdout_to_stderr():
    """Temporarily divert anything written to stdout into stderr.

    stdout carries the line-delimited JSON protocol with Electron, so any
    library output (InsightFace "Applied providers:"/"find model:" banners,
    onnxruntime logs, model download progress bars) would corrupt it.

    This covers both levels:
    - Python level: swaps ``sys.stdout`` for ``sys.stderr``.
    - OS level: duplicates fd 2 over fd 1 with ``os.dup2`` so native C/C++
      writes (onnxruntime) also land on stderr. Restored afterwards.
    """
    try:
        sys.stdout.flush()
    except Exception:
        pass
    try:
        sys.stderr.flush()
    except Exception:
        pass

    original_stdout = sys.stdout
    sys.stdout = sys.stderr

    saved_stdout_fd = None
    try:
        saved_stdout_fd = os.dup(1)
        os.dup2(2, 1)
    except OSError:
        if saved_stdout_fd is not None:
            try:
                os.close(saved_stdout_fd)
            except OSError:
                pass
        saved_stdout_fd = None

    try:
        yield
    finally:
        try:
            sys.stdout.flush()
        except Exception:
            pass
        if saved_stdout_fd is not None:
            try:
                os.dup2(saved_stdout_fd, 1)
            finally:
                try:
                    os.close(saved_stdout_fd)
                except OSError:
                    pass
        sys.stdout = original_stdout


def create_empty_index():
    return faiss.IndexIDMap2(faiss.IndexFlatIP(EMBEDDING_DIMENSION))


def is_id_mapped_index(index):
    """Return True when the index supports stable custom ids (IndexIDMap/IDMap2)."""
    try:
        candidate = faiss.downcast_index(index)
    except Exception:
        candidate = index
    return isinstance(candidate, (faiss.IndexIDMap, faiss.IndexIDMap2))


def get_index_ids(index):
    """Ids guardados en un IndexIDMap/IDMap2 (los mismos que devuelve search)."""
    candidate = faiss.downcast_index(index)
    return {int(value) for value in faiss.vector_to_array(candidate.id_map)}


def load_index(index_path):
    if not index_path:
        raise ValueError("index_path is required.")
    if not os.path.exists(index_path):
        return create_empty_index()

    # faiss.read_index/write_index abren el archivo con fopen(char*): en Windows
    # fallan con rutas no ASCII (p. ej. un usuario "José" en AppData). Los bytes
    # se leen y escriben desde Python y FAISS solo (de)serializa en memoria.
    try:
        index = faiss.deserialize_index(np.fromfile(index_path, dtype=np.uint8))
    except Exception as error:
        raise ValueError(f"Could not load FAISS index: {index_path}") from error

    if index.d != EMBEDDING_DIMENSION:
        raise ValueError(
            f"FAISS index dimension mismatch. Expected {EMBEDDING_DIMENSION}, got {index.d}."
        )
    return index


def save_index(index, index_path):
    from app.services.file_service import write_bytes_atomic

    write_bytes_atomic(index_path, faiss.serialize_index(index).tobytes())


def _resolve_insightface_root():
    """Return the bundled InsightFace root when running frozen, else None.

    build.spec packages ``~/.insightface/models/<DETECTION_MODEL_NAME>`` under
    ``insightface_models/models/<DETECTION_MODEL_NAME>`` inside the PyInstaller
    bundle. FaceAnalysis(root=...) expects the models under
    ``<root>/models/<name>``.
    """
    if not getattr(sys, "frozen", False):
        return None

    bundle_dir = getattr(sys, "_MEIPASS", None)
    if not bundle_dir:
        return None

    bundled_root = os.path.join(bundle_dir, "insightface_models")
    if _has_detection_onnx(os.path.join(bundled_root, "models", DETECTION_MODEL_NAME)):
        return bundled_root
    return None


def _has_detection_onnx(pack_dir):
    """True cuando el directorio del pack tiene .onnx en el nivel esperado.

    Chequear solo ``isdir`` no alcanza: el zip de antelopev2 trae una carpeta
    interna con el mismo nombre, y ``insightface.utils.storage.download()`` no
    la aplana. Eso deja un directorio que existe pero cuyos .onnx viven un
    nivel mas abajo de donde ``FaceAnalysis`` hace glob, y el fallo llega como
    un ``assert`` sin mensaje.
    """
    if not os.path.isdir(pack_dir):
        return False
    return any(name.lower().endswith(".onnx") for name in os.listdir(pack_dir))


def get_face_analyzer():
    """Return the process-wide cached FaceAnalysis (models loaded and prepared).

    Se prepara una sola vez. El tamano de entrada y el umbral del detector se
    pasan en cada llamada a ``detect_faces``; antes se re-ejecutaba ``prepare``
    cada vez que indexado (1024) y busqueda (640) se alternaban.
    """
    global _face_analyzer

    if _face_analyzer is not None:
        return _face_analyzer

    analyzer_kwargs = {
        "name": DETECTION_MODEL_NAME,
        "allowed_modules": list(ALLOWED_MODULES),
        "providers": ["CPUExecutionProvider"],
    }
    insightface_root = _resolve_insightface_root()
    if insightface_root:
        analyzer_kwargs["root"] = insightface_root
    elif getattr(sys, "frozen", False):
        # Empaquetado y sin pack de deteccion utilizable: FaceAnalysis reventaria
        # con un `assert` sin mensaje (o intentaria descargar dentro de _MEIPASS,
        # que es de solo lectura). Fallar aca con texto explicito.
        raise RuntimeError(
            "El pack de deteccion '{name}' no esta dentro del instalador (se esperaba "
            "{path} con archivos .onnx). El instalador se genero sin modelos: hay que "
            "reconstruirlo con `node scripts/prepare-models.cjs` antes de empaquetar.".format(
                name=DETECTION_MODEL_NAME,
                path=os.path.join(
                    getattr(sys, "_MEIPASS", "<bundle>"),
                    "insightface_models",
                    "models",
                    DETECTION_MODEL_NAME,
                ),
            )
        )
    else:
        dev_pack_dir = os.path.join(
            os.path.expanduser("~"), ".insightface", "models", DETECTION_MODEL_NAME
        )
        if not _has_detection_onnx(dev_pack_dir):
            raise RuntimeError(
                "El pack de deteccion '{name}' falta o esta mal estructurado en {path} "
                "(no hay archivos .onnx en ese nivel). Corre "
                "`node scripts/prepare-models.cjs`.".format(
                    name=DETECTION_MODEL_NAME, path=dev_pack_dir
                )
            )

    with redirect_stdout_to_stderr():
        analyzer = FaceAnalysis(**analyzer_kwargs)
        analyzer.prepare(ctx_id=-1, det_size=DETECTION_SIZE)

    _face_analyzer = analyzer
    return _face_analyzer


def detection_sizes_for(image, detection_mode=DETECTION_MODE_STANDARD):
    height, width = image.shape[:2]
    longest_side = max(height, width)
    sizes = [DETECTION_SIZE]
    if longest_side >= LARGE_IMAGE_MIN_SIDE:
        sizes.append(LARGE_IMAGE_DETECTION_SIZE)
    if detection_mode == DETECTION_MODE_PRECISE and longest_side >= PRECISE_IMAGE_MIN_SIDE:
        sizes.append(PRECISE_IMAGE_DETECTION_SIZE)
    return sizes


def detect_faces(image_bgr, det_thresh, detection_mode=DETECTION_MODE_STANDARD, input_sizes=None):
    """Detecta caras (bbox, kps, det_score) sin correr ningun otro modelo.

    Llama al detector directamente en vez de ``FaceAnalysis.get``: ``get``
    corre ademas el modelo ArcFace sobre CADA cara aunque el backend activo
    sea AdaFace, y el umbral quedaba fijo en el 0.5 de ``prepare`` (bajar
    "precision" en Ajustes no recuperaba ninguna cara).
    """
    det_model = get_face_analyzer().det_model
    det_model.det_thresh = float(det_thresh)
    sizes = input_sizes if input_sizes is not None else detection_sizes_for(image_bgr, detection_mode)
    bboxes, kpss = det_model.detect(image_bgr, input_size=sizes)

    faces = []
    for position in range(bboxes.shape[0]):
        faces.append(
            Face(
                bbox=bboxes[position, 0:4],
                kps=kpss[position] if kpss is not None else None,
                det_score=float(bboxes[position, 4]),
            )
        )
    return faces


def face_size_px(face):
    bbox = getattr(face, "bbox", None)
    if bbox is None or len(bbox) < 4:
        return 0.0
    return min(float(bbox[2]) - float(bbox[0]), float(bbox[3]) - float(bbox[1]))


def normalize_embedding(raw_embedding):
    embedding = np.asarray(raw_embedding, dtype=np.float32)
    if embedding.ndim != 1 or embedding.shape[0] != EMBEDDING_DIMENSION:
        return None
    norm = float(np.linalg.norm(embedding))
    if norm <= 0:
        return None
    return embedding / norm


def _insightface_embedding(image_bgr, face):
    landmarks = getattr(face, "kps", None)
    if landmarks is None:
        return None
    rec_model = get_face_analyzer().models["recognition"]
    aligned = face_align.norm_crop(image_bgr, landmark=landmarks, image_size=rec_model.input_size[0])
    features = rec_model.get_feat([aligned, np.ascontiguousarray(aligned[:, ::-1, :])])
    return normalize_embedding(features[0] + features[1])


def extract_face_embedding_with_quality(image_bgr, face):
    """``(embedding, quality)`` de una cara detectada, segun el backend activo.

    ``quality`` es la norma del feature AdaFace (proxy de calidad, mas alto =
    mejor). El backend InsightFace no la tiene: devuelve None.

    Unica puerta de entrada para indexado y busqueda: garantiza que ambos
    usan el mismo modelo (embeddings de modelos distintos no son comparables).
    Los dos backends promedian el crop con su espejo (ver EMBEDDING_VARIANT).
    """
    if get_embedding_backend() == "adaface":
        from app.services import adaface_service

        return adaface_service.compute_embedding_with_quality(image_bgr, face)
    return _insightface_embedding(image_bgr, face), None


def embedding_provides_quality():
    """True cuando el backend activo entrega calidad (norma AdaFace). InsightFace no."""
    return get_embedding_backend() == "adaface"


def extract_face_embedding(image_bgr, face):
    """Embedding L2-normalizado de una cara detectada (ver extract_face_embedding_with_quality)."""
    embedding, _quality = extract_face_embedding_with_quality(image_bgr, face)
    return embedding
