"""Calidad de cara (norma AdaFace): se guarda al indexar, filtra la busqueda y pondera la consulta.

Sin modelos: la sesion ONNX, el detector y el embedding se reemplazan por fakes.
"""

import json

import cv2
import numpy as np
import pytest

from app.actions import find_player as find_player_module
from app.actions import index_photos as index_photos_module
from app.services import adaface_service
from app.services.face_index_service import create_empty_index


def _unit_rows(count, seed):
    rng = np.random.default_rng(seed)
    raw = rng.standard_normal((count, 512)).astype(np.float32)
    return raw / np.linalg.norm(raw, axis=1, keepdims=True)


class _FakeFace:
    """Cara minima: bbox para face_size_px, kps para el crop, det_score para el filtro."""

    def __init__(self, bbox, det_score=0.9):
        self.bbox = np.asarray(bbox, dtype=np.float32)
        self.kps = np.asarray(
            [[10, 10], [30, 10], [20, 20], [12, 30], [28, 30]], dtype=np.float32
        )
        self.det_score = det_score


# --- indexado -------------------------------------------------------------


def _patch_index_models(monkeypatch, qualities):
    monkeypatch.setattr(index_photos_module, "get_face_model_name", lambda: "fake+flip")
    monkeypatch.setattr(index_photos_module, "get_embedding_backend", lambda: "adaface")
    monkeypatch.setattr(index_photos_module, "get_embedding_backend_fallback", lambda: None)
    monkeypatch.setattr(index_photos_module, "get_face_analyzer", lambda: None)
    monkeypatch.setattr(
        index_photos_module,
        "detect_faces",
        lambda _image, _threshold, _mode="standard": [_FakeFace([0, 0, 60, 60]), _FakeFace([100, 0, 170, 70])],
    )
    calls = iter(qualities)

    def fake_embedding(_image, _face):
        quality = next(calls)
        return _unit_rows(1, seed=len(str(quality)))[0], quality

    monkeypatch.setattr(index_photos_module, "extract_face_embedding_with_quality", fake_embedding)


def _write_photo(source):
    source.mkdir()
    ok, encoded = cv2.imencode(".png", np.full((120, 200, 3), 128, dtype=np.uint8))
    assert ok
    (source / "partido.png").write_bytes(encoded.tobytes())


def test_quality_is_saved_per_row_rounded_and_logged(tmp_path, monkeypatch, capsys):
    _patch_index_models(monkeypatch, qualities=[23.123456, 18.5])
    source = tmp_path / "fotos"
    _write_photo(source)
    index_dir = tmp_path / "face-index"

    result = index_photos_module.index_photos(
        {"sourcePath": str(source), "__runtime": {"indexDir": str(index_dir)}}, "req-q1"
    )

    rows = json.loads((index_dir / "vectors.json").read_text(encoding="utf-8"))
    assert result["stats"]["newFacesIndexed"] == 2
    assert [row["quality"] for row in rows] == [23.123, 18.5]
    log = capsys.readouterr().err
    assert "calidad[2]: min=18.50 p10=" in log
    assert "max=23.12" in log


def test_rows_without_quality_are_stored_without_the_key(tmp_path, monkeypatch):
    _patch_index_models(monkeypatch, qualities=[None, 20.0])
    source = tmp_path / "fotos"
    _write_photo(source)
    index_dir = tmp_path / "face-index"

    index_photos_module.index_photos(
        {"sourcePath": str(source), "__runtime": {"indexDir": str(index_dir)}}, "req-q2"
    )

    rows = json.loads((index_dir / "vectors.json").read_text(encoding="utf-8"))
    assert "quality" not in rows[0]
    assert rows[1]["quality"] == 20.0
    # Electron lee la cobertura del manifest, no de vectors.json.
    manifest = json.loads((index_dir / "photos_manifest.json").read_text(encoding="utf-8"))
    assert manifest["quality_coverage"] == {"faces": 2, "withQuality": 1}


def test_pipeline_fingerprint_does_not_include_quality():
    fingerprint = index_photos_module._build_pipeline_fingerprint(28, 0.5)

    assert set(fingerprint) == {
        "version",
        "embeddingModel",
        "detectionSize",
        "largeImageDetectionSize",
        "largeImageMinSide",
        "minFaceSizePx",
        "minFaceDetScore",
    }
    # El filtro de calidad es de busqueda: no cambia la version del pipeline.
    assert index_photos_module.PIPELINE_VERSION == 2


# --- busqueda: filtro por calidad -------------------------------------------


def _index_with_rows(rows):
    """``rows``: lista de (id, photo_path, quality_o_clave_ausente)."""
    vectors = _unit_rows(len(rows), seed=11)
    index = create_empty_index()
    index.add_with_ids(vectors, np.asarray([row[0] for row in rows], dtype=np.int64))
    vector_rows = []
    for row_id, path, quality in rows:
        vector_row = {"id": row_id, "photo_path": path, "face_ordinal": 0}
        if quality is not None:
            vector_row["quality"] = quality
        vector_rows.append(vector_row)
    vectors_by_id = {row["id"]: row for row in vector_rows}
    return index, vectors, vector_rows, vectors_by_id


def test_quality_filter_excludes_faces_below_minimum_before_grouping_by_photo():
    index, _vectors, vector_rows, vectors_by_id = _index_with_rows(
        [(0, "A.jpg", 10.0), (1, "B.jpg", 25.0), (2, "C.jpg", None)]
    )
    query = index.reconstruct(0).reshape(1, 512)

    matches, summary = find_player_module._search_unique_matches(
        index, query, vector_rows, vectors_by_id, -1.0, 12, min_quality=20.0
    )

    photos = {match["photoPath"] for match in matches}
    assert "A.jpg" not in photos
    # Sin calidad conocida nunca se filtra.
    assert photos == {"B.jpg", "C.jpg"}
    assert summary["facesFilteredByQuality"] == 1
    best = next(match for match in matches if match["photoPath"] == "B.jpg")
    assert best["quality"] == 25.0
    unknown = next(match for match in matches if match["photoPath"] == "C.jpg")
    assert unknown["quality"] is None


def test_without_minimum_quality_nothing_is_filtered():
    index, _vectors, vector_rows, vectors_by_id = _index_with_rows(
        [(0, "A.jpg", 10.0), (1, "B.jpg", 25.0)]
    )
    query = index.reconstruct(0).reshape(1, 512)

    matches, summary = find_player_module._search_unique_matches(
        index, query, vector_rows, vectors_by_id, -1.0, 12, min_quality=None
    )

    assert {match["photoPath"] for match in matches} == {"A.jpg", "B.jpg"}
    assert summary["facesFilteredByQuality"] == 0


def test_rows_without_quality_are_never_filtered_by_minimum():
    index, _vectors, vector_rows, vectors_by_id = _index_with_rows(
        [(0, "viejo-1.jpg", None), (1, "viejo-2.jpg", None)]
    )
    query = index.reconstruct(0).reshape(1, 512)

    matches, summary = find_player_module._search_unique_matches(
        index, query, vector_rows, vectors_by_id, -1.0, 12, min_quality=99.0
    )

    assert len(matches) == 2
    assert summary["facesFilteredByQuality"] == 0


@pytest.mark.parametrize("value", [-1, "abc", True, float("nan")])
def test_min_face_quality_rejects_invalid_values(value):
    with pytest.raises(ValueError):
        find_player_module._resolve_min_face_quality({"minFaceQuality": value})


@pytest.mark.parametrize("data", [{}, {"minFaceQuality": 0}, {"minFaceQuality": None}])
def test_min_face_quality_zero_or_missing_means_off(data):
    assert find_player_module._resolve_min_face_quality(data) == 0.0


# --- consulta: ponderacion por calidad --------------------------------------


def _patch_query_frames(monkeypatch, frame_embeddings):
    monkeypatch.setattr(find_player_module, "_decode_frame_image", lambda frame: frame)

    def fake_primary(frame):
        return frame_embeddings[frame]

    monkeypatch.setattr(find_player_module, "_primary_face_embedding", fake_primary)


def test_query_embedding_is_weighted_by_frame_quality(monkeypatch):
    base = _unit_rows(1, seed=5)[0]
    near = base + 0.01 * _unit_rows(1, seed=6)[0]
    near = near / np.linalg.norm(near)
    _patch_query_frames(monkeypatch, {"sharp": (base, 30.0), "blurry": (near, 10.0)})

    embedding, used, total, rejected, frame_qualities = find_player_module._average_query_embedding(
        ["sharp", "blurry"]
    )

    expected = (30.0 * base + 10.0 * near) / 40.0
    expected = expected / np.linalg.norm(expected)
    assert used == 2 and total == 2 and rejected == 0
    assert frame_qualities == [30.0, 10.0]
    assert np.allclose(embedding, expected, atol=1e-5)
    assert np.isclose(np.linalg.norm(embedding), 1.0, atol=1e-5)


def test_query_embedding_falls_back_to_equal_weights_when_a_quality_is_unknown(monkeypatch):
    base = _unit_rows(1, seed=5)[0]
    near = base + 0.01 * _unit_rows(1, seed=6)[0]
    near = near / np.linalg.norm(near)
    _patch_query_frames(monkeypatch, {"a": (base, 30.0), "b": (near, None)})

    embedding, *_rest = find_player_module._average_query_embedding(["a", "b"])

    expected = base + near
    expected = expected / np.linalg.norm(expected)
    assert np.allclose(embedding, expected, atol=1e-5)


# --- AdaFace: salida de norma ----------------------------------------------


class _FakeSession:
    def __init__(self, outputs):
        self._outputs = outputs

    def run(self, _names, _feed):
        return self._outputs


def test_compute_embedding_with_quality_averages_norm_of_both_crops(monkeypatch):
    rng = np.random.default_rng(2)
    embeddings = rng.standard_normal((2, 512)).astype(np.float32)
    norms = np.asarray([[20.0], [24.0]], dtype=np.float32)
    monkeypatch.setattr(
        adaface_service, "_get_session", lambda: _FakeSession([embeddings, norms])
    )
    image = np.zeros((200, 200, 3), dtype=np.uint8)

    embedding, quality = adaface_service.compute_embedding_with_quality(image, _FakeFace([0, 0, 60, 60]))

    assert quality == pytest.approx(22.0)
    assert np.isclose(np.linalg.norm(embedding), 1.0, atol=1e-5)
    assert adaface_service.compute_embedding(image, _FakeFace([0, 0, 60, 60])) is not None


def test_compute_embedding_with_quality_without_norm_output_gives_none(monkeypatch):
    rng = np.random.default_rng(2)
    embeddings = rng.standard_normal((2, 512)).astype(np.float32)
    monkeypatch.setattr(adaface_service, "_get_session", lambda: _FakeSession([embeddings]))
    image = np.zeros((200, 200, 3), dtype=np.uint8)

    embedding, quality = adaface_service.compute_embedding_with_quality(image, _FakeFace([0, 0, 60, 60]))

    assert embedding is not None
    assert quality is None


def test_compute_embedding_with_quality_without_landmarks_gives_none_pair():
    face = _FakeFace([0, 0, 60, 60])
    face.kps = None

    assert adaface_service.compute_embedding_with_quality(np.zeros((8, 8, 3), np.uint8), face) == (
        None,
        None,
    )


def test_find_player_applies_quality_filter_and_reports_it(tmp_path, monkeypatch, capsys):
    from app.services.face_index_service import save_index

    index_dir = tmp_path / "face-index"
    index_dir.mkdir()
    vectors = _unit_rows(2, seed=21)
    index = create_empty_index()
    index.add_with_ids(vectors, np.asarray([0, 1], dtype=np.int64))
    save_index(index, str(index_dir / "faces.faiss"))
    rows = [
        {"id": 0, "photo_path": "borrosa.jpg", "face_ordinal": 0, "quality": 12.0},
        {"id": 1, "photo_path": "nitida.jpg", "face_ordinal": 0, "quality": 24.0},
    ]
    (index_dir / "vectors.json").write_text(json.dumps(rows), encoding="utf-8")
    (index_dir / "photos_manifest.json").write_text(
        json.dumps({"photos": {}, "embedding_model": "fake+flip"}), encoding="utf-8"
    )
    monkeypatch.setattr(find_player_module, "get_face_model_name", lambda: "fake+flip")
    monkeypatch.setattr(find_player_module, "embedding_provides_quality", lambda: True)
    monkeypatch.setattr(find_player_module, "_decode_frame_image", lambda frame: frame)
    monkeypatch.setattr(
        find_player_module, "_primary_face_embedding", lambda _frame: (vectors[0], 15.0)
    )

    result = find_player_module.find_player(
        {
            "frames": ["q1"],
            "similarityThreshold": -1.0,
            "minFaceQuality": 20,
            "__runtime": {"indexDir": str(index_dir)},
        },
        "req-fq",
    )

    assert result["status"] == "ok"
    assert [match["photoPath"] for match in result["matches"]] == ["nitida.jpg"]
    assert result["matches"][0]["quality"] == 24.0
    assert result["search"]["facesFilteredByQuality"] == 1
    assert result["search"]["minFaceQuality"] == 20.0
    assert result["search"]["facesWithQuality"] == 2
    assert result["search"]["qualityAvailable"] is True
    assert "calidadFrames=[15.00] minCalidad=20.00 filtradasCalidad=1" in capsys.readouterr().err
