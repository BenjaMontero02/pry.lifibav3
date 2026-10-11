import numpy as np

from app.actions.find_player import find_player
from app.services.face_index_service import create_empty_index, save_index


def _write_index(index_dir, ids):
    index_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(1)
    raw = rng.standard_normal((len(ids), 512)).astype(np.float32)
    vectors = raw / np.linalg.norm(raw, axis=1, keepdims=True)
    index = create_empty_index()
    index.add_with_ids(vectors, np.asarray(ids, dtype=np.int64))
    save_index(index, str(index_dir / "faces.faiss"))


def _request(index_dir):
    return {"__runtime": {"indexDir": str(index_dir)}, "frameBase64": "aGVsbG8="}


def test_desynchronized_index_returns_structured_index_stale(tmp_path):
    index_dir = tmp_path / "face-index"
    _write_index(index_dir, [0])
    # Dos filas para un solo vector: el indice quedo a medio guardar.
    (index_dir / "vectors.json").write_text(
        '[{"id":0,"photo_path":"A.jpg","face_ordinal":0},'
        '{"id":1,"photo_path":"B.jpg","face_ordinal":0}]',
        encoding="utf-8",
    )

    result = find_player(_request(index_dir), "req-3")

    assert result["status"] == "index_stale"
    assert result["reason"] == "index_out_of_sync"
    assert result["matches"] == []
    assert "Actualizar fotos" in result["message"]


def test_missing_artifacts_return_empty_index(tmp_path):
    result = find_player(_request(tmp_path / "vacio"), "req-4")

    assert result["status"] == "empty_index"
    assert result["reason"] == "missing_artifacts"
