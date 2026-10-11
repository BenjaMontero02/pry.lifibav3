import cv2
import numpy as np
import pytest

from app.actions import index_photos as index_photos_module


def test_interrupted_run_saves_progress_before_raising(tmp_path, monkeypatch):
    monkeypatch.setattr(index_photos_module, "get_face_model_name", lambda: "fake+flip")
    monkeypatch.setattr(index_photos_module, "get_embedding_backend", lambda: "insightface")
    monkeypatch.setattr(index_photos_module, "get_embedding_backend_fallback", lambda: None)
    monkeypatch.setattr(index_photos_module, "get_face_analyzer", lambda: None)

    def interrupted_detection(_image, _threshold, _mode="standard"):
        raise KeyboardInterrupt()

    monkeypatch.setattr(index_photos_module, "detect_faces", interrupted_detection)

    source = tmp_path / "fotos"
    source.mkdir()
    ok, encoded = cv2.imencode(".png", np.full((40, 40, 3), 128, dtype=np.uint8))
    assert ok
    (source / "foto.png").write_bytes(encoded.tobytes())
    index_dir = tmp_path / "face-index"

    with pytest.raises(KeyboardInterrupt):
        index_photos_module.index_photos(
            {"sourcePath": str(source), "__runtime": {"indexDir": str(index_dir)}}, "req-7"
        )

    # Lo que se llego a preparar queda en disco: la siguiente corrida no arranca de cero.
    assert (index_dir / "faces.faiss").exists()
    assert (index_dir / "vectors.json").exists()
    assert (index_dir / "photos_manifest.json").exists()
