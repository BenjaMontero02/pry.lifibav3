import numpy as np

from app.actions import find_player as find_player_module
from app.services.face_index_service import create_empty_index


def _index_with_rows(rows):
    """``rows``: lista de (id, photo_path). Devuelve (index, filas, vectors_by_id)."""
    rng = np.random.default_rng(7)
    raw = rng.standard_normal((len(rows), 512)).astype(np.float32)
    vectors = raw / np.linalg.norm(raw, axis=1, keepdims=True)
    index = create_empty_index()
    index.add_with_ids(vectors, np.asarray([row_id for row_id, _ in rows], dtype=np.int64))
    vector_rows = [
        {"id": row_id, "photo_path": path, "face_ordinal": 0} for row_id, path in rows
    ]
    vectors_by_id = {row["id"]: row for row in vector_rows}
    return index, vector_rows, vectors_by_id


def test_top_similarities_are_reported_even_below_threshold():
    index, vector_rows, vectors_by_id = _index_with_rows(
        [(0, "A.jpg"), (1, "B.jpg"), (2, "C.jpg")]
    )
    query = index.reconstruct(0).reshape(1, 512)

    matches, summary = find_player_module._search_unique_matches(
        index, query, vector_rows, vectors_by_id, threshold=1.01, max_results=12
    )

    # Nada supera un umbral imposible, pero el log de calibracion igual ve la mejor (1.0).
    assert matches == []
    assert summary["topSimilarities"][0] == 1.0
    assert len(summary["topSimilarities"]) == 3
