import json
import os

import numpy as np

from app.actions import index_photos as index_photos_module
from app.services.face_index_service import create_empty_index, get_index_ids, load_index, save_index
from app.services.file_service import file_signature


def _patch_models_away(monkeypatch):
    # Sin modelos: el nombre del modelo y el backend se fijan a mano. Como ninguna
    # foto necesita reprocesarse, el detector nunca se carga.
    monkeypatch.setattr(index_photos_module, "get_face_model_name", lambda: "fake+flip")
    monkeypatch.setattr(index_photos_module, "get_embedding_backend", lambda: "insightface")
    monkeypatch.setattr(index_photos_module, "get_embedding_backend_fallback", lambda: None)


def test_orphan_index_id_is_removed_without_full_rebuild(tmp_path, monkeypatch, capsys):
    _patch_models_away(monkeypatch)
    source = tmp_path / "fotos"
    source.mkdir()
    photo = source / "partido.jpg"
    photo.write_bytes(b"no-se-decodifica-porque-no-se-reprocesa")
    signature = file_signature(str(photo))
    photo_key = os.path.abspath(str(photo))

    index_dir = tmp_path / "face-index"
    index_dir.mkdir()
    rng = np.random.default_rng(3)
    raw = rng.standard_normal((2, 512)).astype(np.float32)
    vectors = raw / np.linalg.norm(raw, axis=1, keepdims=True)
    index = create_empty_index()
    # Id 0 es la cara de la foto; id 9 quedo huerfano (corte entre escrituras).
    index.add_with_ids(vectors, np.asarray([0, 9], dtype=np.int64))
    save_index(index, str(index_dir / "faces.faiss"))

    (index_dir / "vectors.json").write_text(
        json.dumps([{"id": 0, "photo_path": photo_key, "face_ordinal": 0}]), encoding="utf-8"
    )
    manifest = {
        "photos": {
            photo_key: {
                "mtime_ns": signature["mtime_ns"],
                "size": signature["size"],
                "faces_detected": 1,
                "status": "indexed",
            }
        },
        "next_face_id": 1,
        "embedding_model": "fake+flip",
        "pipeline": index_photos_module._build_pipeline_fingerprint(
            index_photos_module.DEFAULT_MIN_FACE_SIZE_PX,
            index_photos_module.DEFAULT_MIN_FACE_DET_SCORE,
        ),
    }
    (index_dir / "photos_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (index_dir / "stale.faces.faiss.999.tmp").write_bytes(b"restos")

    result = index_photos_module.index_photos(
        {"sourcePath": str(source), "__runtime": {"indexDir": str(index_dir)}}, "req-5"
    )

    stats = result["stats"]
    assert result["rebuildReason"] is None
    assert stats["orphanIndexIdsRemoved"] == 1
    assert stats["orphanVectorRowsRemoved"] == 0
    assert stats["skippedUnchangedPhotos"] == 1
    assert stats["totalEmbeddingsInIndex"] == 1
    assert get_index_ids(load_index(str(index_dir / "faces.faiss"))) == {0}
    assert not (index_dir / "stale.faces.faiss.999.tmp").exists()

    log = capsys.readouterr().err
    assert "[face-calibration] index caras=0" in log


def test_photo_removed_from_folder_loses_its_vectors(tmp_path, monkeypatch):
    _patch_models_away(monkeypatch)
    source = tmp_path / "fotos"
    source.mkdir()

    index_dir = tmp_path / "face-index"
    index_dir.mkdir()
    index = create_empty_index()
    index.add_with_ids(
        np.eye(1, 512, dtype=np.float32), np.asarray([4], dtype=np.int64)
    )
    save_index(index, str(index_dir / "faces.faiss"))
    gone_key = os.path.abspath(str(source / "borrada.jpg"))
    (index_dir / "vectors.json").write_text(
        json.dumps([{"id": 4, "photo_path": gone_key, "face_ordinal": 0}]), encoding="utf-8"
    )
    (index_dir / "photos_manifest.json").write_text(
        json.dumps(
            {
                "photos": {gone_key: {"status": "indexed", "mtime_ns": 1, "size": 1}},
                "next_face_id": 5,
                "embedding_model": "fake+flip",
                "pipeline": index_photos_module._build_pipeline_fingerprint(
                    index_photos_module.DEFAULT_MIN_FACE_SIZE_PX,
                    index_photos_module.DEFAULT_MIN_FACE_DET_SCORE,
                ),
            }
        ),
        encoding="utf-8",
    )

    result = index_photos_module.index_photos(
        {"sourcePath": str(source), "__runtime": {"indexDir": str(index_dir)}}, "req-6"
    )

    assert result["stats"]["facesRemovedFromIndex"] == 1
    assert result["stats"]["errorPhotos"] == 0
    assert result["stats"]["totalEmbeddingsInIndex"] == 0
    assert json.loads((index_dir / "vectors.json").read_text(encoding="utf-8")) == []
