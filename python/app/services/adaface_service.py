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
_session_error = None


def _resolve_model_path():
    if getattr(sys, "frozen", False):
        bundle_dir = getattr(sys, "_MEIPASS", "")
        return os.path.join(bundle_dir, "adaface_models", ADAFACE_MODEL_FILENAME)
    python_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(python_root, "models", ADAFACE_MODEL_FILENAME)


def is_available():
    return os.path.isfile(_resolve_model_path())


def _get_session():
    global _session, _session_failed, _session_error
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
        _session_error = f"{type(error).__name__}: {error}"
        sys.stderr.write(f"AdaFace session failed to load ({model_path}): {error}\n")
    return _session


def compute_embedding(image_bgr, face):
    """Devuelve el embedding AdaFace L2-normalizado para una cara detectada.

    ``face`` es un objeto de insightface con ``kps`` (5 landmarks). Se promedia
    el embedding del crop con el de su espejo horizontal (flip TTA): mas estable
    con caras de perfil o borrosas. Ambos crops van en un solo batch.

    Devuelve None si la cara no trae landmarks o el embedding es invalido.
    Si la sesion ONNX no cargo LANZA: devolver None hacia que la foto quedara
    marcada como "sin caras" y nunca se reintentara.
    """
    from app.services.face_index_service import normalize_embedding

    landmarks = getattr(face, "kps", None)
    if landmarks is None:
        return None

    session = _get_session()
    if session is None:
        raise RuntimeError(
            "No se pudo cargar el modelo AdaFace ({path}): {error}".format(
                path=_resolve_model_path(), error=_session_error or "error desconocido"
            )
        )

    aligned = face_align.norm_crop(image_bgr, landmark=landmarks, image_size=112)
    crops = np.stack([aligned, aligned[:, ::-1, :]]).astype(np.float32)
    blob = np.ascontiguousarray(np.transpose((crops / 255.0 - 0.5) / 0.5, (0, 3, 1, 2)))

    outputs = session.run(None, {"input": blob})
    return normalize_embedding(outputs[0][0] + outputs[0][1])


def session_ok():
    """True cuando la sesion ONNX de AdaFace carga realmente.

    ``is_available()`` solo mira que el archivo exista; esto ejercita la carga,
    que es lo que hay que verificar sobre un binario ya empaquetado.
    """
    return _get_session() is not None


def session_error():
    """Motivo por el que la sesion no cargo (None si no hubo error o no se intento)."""
    return _session_error
