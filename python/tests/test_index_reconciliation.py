import numpy as np

from app.actions.index_photos import _reconcile_index_with_vectors
from app.services.face_index_service import create_empty_index


def _unit_vectors(count, seed=0):
    rng = np.random.default_rng(seed)
    raw = rng.standard_normal((count, 512)).astype(np.float32)
    return raw / np.linalg.norm(raw, axis=1, keepdims=True)


def _build_index(ids):
    index = create_empty_index()
    index.add_with_ids(_unit_vectors(len(ids)), np.asarray(ids, dtype=np.int64))
    return index


def test_orphans_on_both_sides_are_dropped_by_id():
    # Corte entre escrituras: el indice tiene el id 3 sin fila, y vectors.json
    # tiene la fila 4 (foto C) sin vector en el indice.
    index = _build_index([0, 1, 2, 3])
    vectors = [
        {"id": 0, "photo_path": "A.jpg", "face_ordinal": 0},
        {"id": 1, "photo_path": "A.jpg", "face_ordinal": 1},
        {"id": 2, "photo_path": "B.jpg", "face_ordinal": 0},
        {"id": 4, "photo_path": "C.jpg", "face_ordinal": 0},
    ]
    photos_state = {
        "A.jpg": {"status": "indexed", "faces_detected": 2},
        "B.jpg": {"status": "indexed", "faces_detected": 1},
        "C.jpg": {"status": "indexed", "faces_detected": 1},
    }

    kept, orphan_index_ids, orphan_rows, affected = _reconcile_index_with_vectors(
        index, vectors, photos_state
    )

    assert [row["id"] for row in kept] == [0, 1, 2]
    assert orphan_index_ids == 1
    assert orphan_rows == 1
    assert affected == {"C.jpg"}
    assert index.ntotal == len(kept) == 3
    assert "C.jpg" not in photos_state
    # Fotos sanas: no se tocan, no se reprocesan.
    assert photos_state["A.jpg"]["status"] == "indexed"
    assert photos_state["B.jpg"]["status"] == "indexed"


def test_photo_with_partial_vectors_is_marked_for_reprocessing():
    # La foto A perdio una de sus filas: sus vectores restantes se descartan
    # despues, al reprocesarla, asi que A no puede quedar como "indexed".
    index = _build_index([0, 1])
    vectors = [
        {"id": 0, "photo_path": "A.jpg", "face_ordinal": 0},
        {"id": 7, "photo_path": "A.jpg", "face_ordinal": 1},
        {"id": 1, "photo_path": "B.jpg", "face_ordinal": 0},
    ]
    photos_state = {
        "A.jpg": {"status": "indexed", "faces_detected": 2},
        "B.jpg": {"status": "indexed", "faces_detected": 1},
    }

    kept, orphan_index_ids, orphan_rows, affected = _reconcile_index_with_vectors(
        index, vectors, photos_state
    )

    assert [row["id"] for row in kept] == [0, 1]
    assert orphan_index_ids == 0
    assert orphan_rows == 1
    assert affected == {"A.jpg"}
    assert "A.jpg" not in photos_state
    assert "B.jpg" in photos_state


def test_duplicate_row_ids_keep_first_only():
    index = _build_index([5])
    vectors = [
        {"id": 5, "photo_path": "A.jpg", "face_ordinal": 0},
        {"id": 5, "photo_path": "B.jpg", "face_ordinal": 0},
    ]
    photos_state = {"A.jpg": {"status": "indexed"}, "B.jpg": {"status": "indexed"}}

    kept, orphan_index_ids, orphan_rows, affected = _reconcile_index_with_vectors(
        index, vectors, photos_state
    )

    assert [row["photo_path"] for row in kept] == ["A.jpg"]
    assert orphan_index_ids == 0
    assert orphan_rows == 1
    assert affected == {"B.jpg"}
    assert index.ntotal == 1


def test_consistent_index_is_untouched():
    index = _build_index([0, 1])
    vectors = [
        {"id": 0, "photo_path": "A.jpg", "face_ordinal": 0},
        {"id": 1, "photo_path": "B.jpg", "face_ordinal": 0},
    ]
    photos_state = {"A.jpg": {"status": "indexed"}, "B.jpg": {"status": "indexed"}}

    kept, orphan_index_ids, orphan_rows, affected = _reconcile_index_with_vectors(
        index, vectors, photos_state
    )

    assert len(kept) == 2
    assert (orphan_index_ids, orphan_rows, affected) == (0, 0, set())
    assert set(photos_state) == {"A.jpg", "B.jpg"}
