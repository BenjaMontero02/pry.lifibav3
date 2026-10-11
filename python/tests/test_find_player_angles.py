"""Escaneo en 3 angulos: una plantilla por angulo, chequeo de identidad y fusion por maximo.

Sin modelos: el detector y el embedding se reemplazan por fakes.
"""

import json

import numpy as np
import pytest

from app.actions import find_player as find_player_module
from app.services.face_index_service import create_empty_index, save_index


def _unit(vector):
    vector = np.asarray(vector, dtype=np.float32)
    return vector / np.linalg.norm(vector)


def _basis(seed, count):
    rng = np.random.default_rng(seed)
    raw = rng.standard_normal((count, 512)).astype(np.float32)
    # Ortonormalizar para controlar exactamente las similitudes.
    q, _r = np.linalg.qr(raw.T)
    return q.T[:count].astype(np.float32)


class _FakeFace:
    def __init__(self, nose_offset=0.0):
        # ojo izq., ojo der., nariz, boca izq., boca der. (distancia interocular = 20)
        self.kps = np.asarray(
            [[10, 10], [30, 10], [20 + 20 * nose_offset, 20], [12, 30], [28, 30]],
            dtype=np.float32,
        )


# Identidad del jugador: frente = e0; girado = mezcla con e1 (similitud con el
# frente ~0.5). Otra persona = e2 (similitud ~0 con el jugador).
E = _basis(seed=7, count=3)
FRONT = _unit(E[0])
LEFT = _unit(E[0] + 1.7 * E[1])
OTHER = _unit(E[2])


def _patch_frames(monkeypatch, frames):
    monkeypatch.setattr(find_player_module, "_decode_frame_image", lambda frame: frame)
    monkeypatch.setattr(find_player_module, "_primary_face", lambda frame, _min_det=0.5: frames[frame])


def _write_index(tmp_path, rows_with_vectors):
    index_dir = tmp_path / "face-index"
    index_dir.mkdir()
    vectors = np.stack([vector for _row, vector in rows_with_vectors]).astype(np.float32)
    index = create_empty_index()
    index.add_with_ids(vectors, np.arange(len(rows_with_vectors), dtype=np.int64))
    save_index(index, str(index_dir / "faces.faiss"))
    rows = [dict(row, id=position) for position, (row, _vector) in enumerate(rows_with_vectors)]
    (index_dir / "vectors.json").write_text(json.dumps(rows), encoding="utf-8")
    (index_dir / "photos_manifest.json").write_text(
        json.dumps({"photos": {}, "embedding_model": "fake+flip"}), encoding="utf-8"
    )
    return index_dir


def test_estimate_yaw_uses_nose_offset_in_eye_distances():
    assert find_player_module._estimate_yaw(_FakeFace(0.0)) == pytest.approx(0.0)
    assert find_player_module._estimate_yaw(_FakeFace(0.3)) == pytest.approx(0.3)
    assert find_player_module._estimate_yaw(object()) is None


def test_frame_groups_validation():
    resolve = find_player_module._resolve_frame_groups
    assert resolve({"frames": ["a"]}) is None
    with pytest.raises(ValueError, match="front"):
        resolve({"frameGroups": [{"angle": "left", "frames": ["a"]}]})
    with pytest.raises(ValueError, match="repeated"):
        resolve({"frameGroups": [{"angle": "front", "frames": ["a"]}, {"angle": "front", "frames": ["b"]}]})
    with pytest.raises(ValueError, match="more than"):
        resolve({"frameGroups": [{"angle": "front", "frames": ["a"] * 17}]})


def test_turned_frames_are_kept_within_their_own_group(monkeypatch):
    # Con el escaneo comun los frames girados se comparan contra el medoide frontal;
    # por angulo, cada grupo solo exige consistencia interna.
    _patch_frames(
        monkeypatch,
        {
            "f1": (FRONT, 22.0, _FakeFace(0.0)),
            "f2": (FRONT, 22.0, _FakeFace(0.0)),
            "l1": (LEFT, 21.0, _FakeFace(0.3)),
            "l2": (LEFT, 21.0, _FakeFace(0.3)),
        },
    )
    templates, summary, groups = find_player_module._build_angle_templates(
        [("front", ["f1", "f2"]), ("left", ["l1", "l2"])]
    )

    assert [name for name, _template in templates] == ["mean", "front", "left"]
    left = next(entry for entry in summary if entry["angle"] == "left")
    assert left["status"] == "ok"
    assert left["framesUsed"] == 2
    assert left["turnedEnough"] is True
    assert 0.25 <= left["similarityToFront"] < 0.6
    assert groups["left"]["framesRejected"] == 0


def test_side_group_from_another_person_is_rejected(monkeypatch):
    _patch_frames(
        monkeypatch,
        {
            "f1": (FRONT, 22.0, _FakeFace(0.0)),
            "r1": (OTHER, 22.0, _FakeFace(-0.3)),
        },
    )
    templates, summary, _groups = find_player_module._build_angle_templates(
        [("front", ["f1"]), ("right", ["r1"])]
    )

    assert [name for name, _template in templates] == ["mean", "front"]
    right = next(entry for entry in summary if entry["angle"] == "right")
    assert right["status"] == "rejected_identity"


def test_fusion_keeps_max_similarity_and_tags_side_only_photos():
    fused = find_player_module._fuse_template_matches(
        [
            ("mean", [{"photoPath": "a.jpg", "similarity": 0.7}]),
            ("front", [{"photoPath": "a.jpg", "similarity": 0.8}]),
            ("left", [{"photoPath": "a.jpg", "similarity": 0.6}, {"photoPath": "perfil.jpg", "similarity": 0.75}]),
        ],
        limit=10,
    )

    by_photo = {match["photoPath"]: match for match in fused}
    assert by_photo["a.jpg"]["similarity"] == 0.8
    assert by_photo["a.jpg"]["matchedBy"] == "front"
    assert "viaSideAngle" not in by_photo["a.jpg"]
    assert by_photo["perfil.jpg"]["viaSideAngle"] is True
    assert by_photo["perfil.jpg"]["matchedBy"] == "left"


def test_find_player_with_angles_finds_profile_photo_the_mean_misses(tmp_path, monkeypatch, capsys):
    index_dir = _write_index(
        tmp_path,
        [
            ({"photo_path": "frente.jpg", "face_ordinal": 0}, FRONT),
            ({"photo_path": "perfil.jpg", "face_ordinal": 0}, LEFT),
            ({"photo_path": "otro.jpg", "face_ordinal": 0}, OTHER),
        ],
    )
    monkeypatch.setattr(find_player_module, "get_face_model_name", lambda: "fake+flip")
    _patch_frames(
        monkeypatch,
        {
            "f1": (FRONT, 22.0, _FakeFace(0.0)),
            "l1": (LEFT, 21.0, _FakeFace(0.3)),
            "r1": (OTHER, 22.0, _FakeFace(-0.3)),
        },
    )
    base = {"similarityThreshold": 0.9, "__runtime": {"indexDir": str(index_dir)}}

    result = find_player_module.find_player(
        {
            **base,
            "frameGroups": [
                {"angle": "front", "frames": ["f1"]},
                {"angle": "left", "frames": ["l1"]},
                {"angle": "right", "frames": ["r1"]},
            ],
        },
        "req-ang",
    )

    assert result["status"] == "ok"
    photos = {match["photoPath"]: match for match in result["matches"]}
    assert set(photos) == {"frente.jpg", "perfil.jpg"}
    assert photos["perfil.jpg"]["viaSideAngle"] is True
    assert "otro.jpg" not in photos
    assert [entry["status"] for entry in result["angles"]] == ["ok", "ok", "rejected_identity"]
    assert set(result["search"]["templateTopSimilarities"]) == {"mean", "front", "left"}
    assert "[face-calibration] find_player angulos front:ok" in capsys.readouterr().err

    # Mismo indice con el escaneo comun (toggle apagado): sin campo angles y sin
    # la foto de perfil, que solo alcanza la plantilla girada.
    monkeypatch.setattr(find_player_module, "_primary_face_embedding", lambda frame: (FRONT, 22.0))
    plain = find_player_module.find_player({**base, "frames": ["f1"]}, "req-plain")
    assert "angles" not in plain
    assert [match["photoPath"] for match in plain["matches"]] == ["frente.jpg"]


def test_find_player_without_front_face_reports_no_face(tmp_path, monkeypatch):
    index_dir = _write_index(tmp_path, [({"photo_path": "frente.jpg", "face_ordinal": 0}, FRONT)])
    monkeypatch.setattr(find_player_module, "get_face_model_name", lambda: "fake+flip")
    _patch_frames(monkeypatch, {"f1": (None, None, None), "l1": (LEFT, 21.0, _FakeFace(0.3))})

    result = find_player_module.find_player(
        {
            "frameGroups": [{"angle": "front", "frames": ["f1"]}, {"angle": "left", "frames": ["l1"]}],
            "__runtime": {"indexDir": str(index_dir)},
        },
        "req-noface",
    )

    assert result["status"] == "no_face_detected"
    assert result["angles"][0] == {
        "angle": "front",
        "status": "no_face",
        "framesUsed": 0,
        "framesTotal": 1,
        "yaw": None,
    }


def test_side_angles_use_a_lower_detector_floor(monkeypatch):
    seen = {}

    def fake_primary(frame, min_det_score=0.5):
        seen[frame] = min_det_score
        return {"f1": FRONT, "l1": LEFT}[frame], 22.0, _FakeFace(0.0)

    monkeypatch.setattr(find_player_module, "_decode_frame_image", lambda frame: frame)
    monkeypatch.setattr(find_player_module, "_primary_face", fake_primary)

    find_player_module._build_angle_templates([("front", ["f1"]), ("left", ["l1"])])

    assert seen["f1"] == find_player_module.QUERY_MIN_DET_SCORE
    assert seen["l1"] == find_player_module.QUERY_SIDE_MIN_DET_SCORE < seen["f1"]


def test_preview_face_reports_primary_face_and_count(monkeypatch):
    from app.actions import preview_face as preview_module

    class _BoxFace(_FakeFace):
        def __init__(self, bbox, det_score):
            super().__init__(0.0)
            self.bbox = np.asarray(bbox, dtype=np.float32)
            self.det_score = det_score

    calls = {}

    def fake_detect(_image, threshold, input_sizes=None):
        calls["sizes"] = input_sizes
        return [_BoxFace([10, 10, 40, 40], 0.9), _BoxFace([100, 50, 220, 170], 0.8)]

    monkeypatch.setattr(preview_module, "_decode_frame_image", lambda _frame: np.zeros((240, 320, 3), np.uint8))
    monkeypatch.setattr(preview_module, "detect_faces", fake_detect)

    result = preview_module.preview_face({"frame": "x"}, "req-pv")

    assert calls["sizes"] == [preview_module.PREVIEW_DETECTION_SIZE]
    assert result["faceCount"] == 2
    assert result["frameWidth"] == 320 and result["frameHeight"] == 240
    assert result["primary"]["sizePx"] == 120.0
    assert result["primary"]["box"] == [0.3125, 0.2083, 0.6875, 0.7083]


def test_preview_face_without_faces(monkeypatch):
    from app.actions import preview_face as preview_module

    monkeypatch.setattr(preview_module, "_decode_frame_image", lambda _frame: np.zeros((240, 320, 3), np.uint8))
    monkeypatch.setattr(preview_module, "detect_faces", lambda *_args, **_kwargs: [])

    result = preview_module.preview_face({"frame": "x"}, "req-pv0")

    assert result["faceCount"] == 0
    assert result["primary"] is None
