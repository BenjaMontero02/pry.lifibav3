import contextlib
import os
import sys

import faiss
import numpy as np
from insightface.app import FaceAnalysis

EMBEDDING_DIMENSION = 512
# antelopev2 (ResNet100 @ Glint360K) reconoce mejor que buffalo_l
# (ResNet50 @ WebFace600K); mismo embedding de 512 dims. Cambiar el modelo
# invalida los indices existentes: index_photos fuerza rebuild si el
# manifest registra otro modelo.
FACE_MODEL_NAME = "antelopev2"
DEFAULT_DET_SIZE = (640, 640)
_face_analyzer = None
_face_analyzer_det_size = None


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


def load_index(index_path):
    if not index_path:
        raise ValueError("index_path is required.")
    if not os.path.exists(index_path):
        return create_empty_index()

    try:
        index = faiss.read_index(index_path)
    except Exception as error:
        raise ValueError(f"Could not load FAISS index: {index_path}") from error

    if index.d != EMBEDDING_DIMENSION:
        raise ValueError(
            f"FAISS index dimension mismatch. Expected {EMBEDDING_DIMENSION}, got {index.d}."
        )
    return index


def _resolve_insightface_root():
    """Return the bundled InsightFace root when running frozen, else None.

    build.spec packages ``~/.insightface/models/<FACE_MODEL_NAME>`` under
    ``insightface_models/models/<FACE_MODEL_NAME>`` inside the PyInstaller
    bundle. FaceAnalysis(root=...) expects the models under
    ``<root>/models/<name>``.
    """
    if not getattr(sys, "frozen", False):
        return None

    bundle_dir = getattr(sys, "_MEIPASS", None)
    if not bundle_dir:
        return None

    bundled_root = os.path.join(bundle_dir, "insightface_models")
    if os.path.isdir(os.path.join(bundled_root, "models", FACE_MODEL_NAME)):
        return bundled_root
    return None


def get_face_analyzer(det_size=DEFAULT_DET_SIZE):
    """Return the process-wide cached FaceAnalysis, prepared for ``det_size``.

    A single analyzer instance is kept in memory (a second one would duplicate
    the model weights). When a caller requests a different ``det_size`` than the
    one the cached analyzer was last prepared with, ``prepare`` is re-run on the
    same instance, which works in both directions (e.g. 640 -> 1024 -> 640).
    """
    global _face_analyzer, _face_analyzer_det_size

    det_size = tuple(det_size) if det_size is not None else DEFAULT_DET_SIZE

    if _face_analyzer is not None:
        if _face_analyzer_det_size != det_size:
            with redirect_stdout_to_stderr():
                _face_analyzer.prepare(ctx_id=-1, det_size=det_size)
            _face_analyzer_det_size = det_size
        return _face_analyzer

    analyzer_kwargs = {"name": FACE_MODEL_NAME, "providers": ["CPUExecutionProvider"]}
    insightface_root = _resolve_insightface_root()
    if insightface_root:
        analyzer_kwargs["root"] = insightface_root

    with redirect_stdout_to_stderr():
        analyzer = FaceAnalysis(**analyzer_kwargs)
        analyzer.prepare(ctx_id=-1, det_size=det_size)

    _face_analyzer = analyzer
    _face_analyzer_det_size = det_size
    return _face_analyzer


def normalize_embedding(raw_embedding):
    embedding = np.asarray(raw_embedding, dtype=np.float32)
    if embedding.ndim != 1 or embedding.shape[0] != EMBEDDING_DIMENSION:
        return None
    norm = float(np.linalg.norm(embedding))
    if norm <= 0:
        return None
    return embedding / norm
