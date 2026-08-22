import os
import sys
import time
import traceback

import cv2
import faiss
import numpy as np

from app.errors import describe_error_with_origin
from app.progress import write_progress_event
from app.services.face_index_service import (
    create_empty_index,
    extract_face_embedding,
    get_face_analyzer,
    get_face_model_name,
    is_id_mapped_index,
    load_index,
)
from app.services.file_service import (
    file_signature,
    list_event_photos,
    load_json_file_with_status,
    save_json_file_if_changed,
)

SAVE_CHECKPOINT_EVERY = 25
# Cuantos tracebacks completos se escriben a stderr por corrida. Cuando falla
# cada foto por la misma causa (modelo ausente, backend roto) uno alcanza; el
# resto solo inflaria el log del bridge.
STDERR_TRACEBACK_LIMIT = 3
PROGRESS_EVENT_EVERY = 25
PROGRESS_VERBOSE_LIMIT = 50
ALWAYS_EMIT_PROGRESS_STATUSES = {"error", "missing_file", "unreadable"}

# Larger detector input than the 640x640 default so small/distant faces
# (players far from the camera in event photos) are still detected.
INDEX_DET_SIZE = (1024, 1024)

# Quality gate for indexing: tiny or low-confidence detections (background
# crowd) produce noisy embeddings that cause false positives in search.
# Tuned for phone-quality event photos where the main subject's face can be
# ~30-45px and in profile (profiles score lower on detection confidence).
DEFAULT_MIN_FACE_SIZE_PX = 28
DEFAULT_MIN_FACE_DET_SCORE = 0.50


def _passes_quality_filter(face, min_face_size=None, min_det_score=None):
    if min_face_size is None:
        min_face_size = DEFAULT_MIN_FACE_SIZE_PX
    if min_det_score is None:
        min_det_score = DEFAULT_MIN_FACE_DET_SCORE

    bbox = getattr(face, "bbox", None)
    if bbox is None or len(bbox) < 4:
        return False
    width = float(bbox[2]) - float(bbox[0])
    height = float(bbox[3]) - float(bbox[1])
    if min(width, height) < min_face_size:
        return False

    det_score = getattr(face, "det_score", None)
    if det_score is None or float(det_score) < min_det_score:
        return False
    return True


def _build_progress_payload(
    processed, total, photo_path, status, faces_detected=0, change_type=None
):
    payload = {
        "processed": processed,
        "total": total,
        "photoPath": photo_path,
        "facesDetected": faces_detected,
        "status": status,
    }
    if change_type is not None:
        payload["changeType"] = change_type
    return payload


def _should_emit_progress(processed, total, status):
    if total <= PROGRESS_VERBOSE_LIMIT:
        return True
    if status in ALWAYS_EMIT_PROGRESS_STATUSES:
        return True
    if processed == 1 or processed == total:
        return True
    return processed % PROGRESS_EVENT_EVERY == 0


def _write_photo_progress(
    request_id,
    processed,
    total,
    photo_path,
    status,
    faces_detected=0,
    change_type=None,
    error=None,
    force=False,
):
    if not force and not _should_emit_progress(processed, total, status):
        return

    payload = _build_progress_payload(
        processed, total, photo_path, status, faces_detected, change_type
    )
    if error is not None:
        payload["error"] = str(error)
    write_progress_event(request_id, payload)


def _resolve_index_dir(data):
    runtime = (data or {}).get("__runtime", {})
    index_dir = runtime.get("indexDir")
    if index_dir:
        return index_dir

    app_data_path = runtime.get("appDataPath")
    if not app_data_path:
        raise ValueError("Missing runtime indexDir/appDataPath for index_photos action.")
    return os.path.join(app_data_path, "face-index")


def _resolve_source_path(data):
    source_path = (data or {}).get("sourcePath")
    if not source_path or not isinstance(source_path, str):
        raise ValueError("Missing sourcePath for index_photos action.")

    normalized = os.path.abspath(source_path.strip())
    if not normalized:
        raise ValueError("sourcePath cannot be empty.")
    if not os.path.isdir(normalized):
        raise ValueError(f"Configured source folder does not exist: {normalized}")
    return normalized


def _is_signature_changed(existing, current_signature):
    if not existing or not isinstance(existing, dict):
        return True
    return (
        int(existing.get("mtime_ns", -1)) != current_signature["mtime_ns"]
        or int(existing.get("size", -1)) != current_signature["size"]
    )


def _classify_photo_changes(photo_paths, file_signatures, photos_state):
    current_paths = set(photo_paths)
    by_path = {}
    summary = {
        "newPhotos": 0,
        "modifiedPhotos": 0,
        "unchangedPhotos": 0,
        "missingPhotos": 0,
        "removedPhotos": 0,
    }

    for photo_path in photo_paths:
        signature = file_signatures.get(photo_path)
        if signature is None:
            change_type = "missing"
            summary["missingPhotos"] += 1
        else:
            existing = photos_state.get(photo_path)
            if existing is None:
                change_type = "new"
                summary["newPhotos"] += 1
            elif _is_signature_changed(existing, signature):
                change_type = "modified"
                summary["modifiedPhotos"] += 1
            else:
                change_type = "unchanged"
                summary["unchangedPhotos"] += 1
        by_path[photo_path] = change_type

    summary["removedPhotos"] = sum(
        1 for photo_path in photos_state.keys() if photo_path not in current_paths
    )
    summary["byPath"] = by_path
    return summary


def _count_current_manifest_statuses(photo_paths, photos_state):
    counts = {}
    for photo_path in photo_paths:
        state = photos_state.get(photo_path)
        status = None
        if isinstance(state, dict):
            status = state.get("status")
        if not status:
            status = "unknown"
        counts[status] = counts.get(status, 0) + 1
    return counts


def _load_manifest(manifest_path):
    manifest, is_invalid = load_json_file_with_status(manifest_path, {"photos": {}})

    if not isinstance(manifest, dict):
        manifest = {"photos": {}}
        is_invalid = True

    photos_state = manifest.get("photos")
    if not isinstance(photos_state, dict):
        manifest["photos"] = {}
        photos_state = manifest["photos"]
        is_invalid = True

    return manifest, photos_state, is_invalid


def _load_vectors(vectors_path):
    vectors, failed_to_load = load_json_file_with_status(vectors_path, [])
    if failed_to_load or not isinstance(vectors, list):
        return [], True
    return vectors, False


def _is_valid_face_id(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _vectors_have_stable_ids(vectors):
    for vector_row in vectors:
        if not isinstance(vector_row, dict) or not _is_valid_face_id(vector_row.get("id")):
            return False
    return True


def _resolve_next_face_id(manifest, vectors):
    next_face_id = manifest.get("next_face_id")
    if not _is_valid_face_id(next_face_id):
        next_face_id = 0

    max_existing_id = -1
    for vector_row in vectors:
        if isinstance(vector_row, dict) and _is_valid_face_id(vector_row.get("id")):
            max_existing_id = max(max_existing_id, vector_row["id"])
    return max(next_face_id, max_existing_id + 1)


def _save_dirty_artifacts(
    index,
    vectors,
    manifest,
    index_path,
    vectors_path,
    manifest_path,
    dirty_index,
    dirty_vectors,
    dirty_manifest,
):
    writes = {"index": False, "vectors": False, "manifest": False}
    if dirty_index:
        faiss.write_index(index, index_path)
        writes["index"] = True
    if dirty_vectors:
        writes["vectors"] = save_json_file_if_changed(vectors_path, vectors)
    if dirty_manifest:
        writes["manifest"] = save_json_file_if_changed(manifest_path, manifest)
    return writes


def index_photos(data, request_id):
    data = data or {}
    index_dir = _resolve_index_dir(data)
    os.makedirs(index_dir, exist_ok=True)

    source_path = _resolve_source_path(data)
    photo_paths = list_event_photos(source_path)

    index_path = os.path.join(index_dir, "faces.faiss")
    vectors_path = os.path.join(index_dir, "vectors.json")
    manifest_path = os.path.join(index_dir, "photos_manifest.json")

    force_reindex = bool(data.get("forceReindex", False))

    min_face_size = int(data.get("minFaceSizePx", DEFAULT_MIN_FACE_SIZE_PX))
    if min_face_size < 1:
        min_face_size = DEFAULT_MIN_FACE_SIZE_PX

    min_det_score = float(data.get("minFaceDetScore", DEFAULT_MIN_FACE_DET_SCORE))
    if not (0.0 < min_det_score <= 1.0):
        min_det_score = DEFAULT_MIN_FACE_DET_SCORE

    file_signatures = {}
    for photo_path in photo_paths:
        try:
            file_signatures[photo_path] = file_signature(photo_path)
        except FileNotFoundError:
            continue

    index_exists = os.path.exists(index_path)
    vectors_exists = os.path.exists(vectors_path)
    manifest_exists = os.path.exists(manifest_path)
    any_artifact_exists = index_exists or vectors_exists or manifest_exists
    all_artifacts_exist = index_exists and vectors_exists and manifest_exists

    manifest, photos_state, manifest_invalid = _load_manifest(manifest_path)
    vectors, vectors_invalid = _load_vectors(vectors_path)

    photo_changes = _classify_photo_changes(photo_paths, file_signatures, photos_state)

    rebuild_reason = None
    if force_reindex:
        rebuild_reason = "force_reindex"
    elif manifest_invalid:
        rebuild_reason = "invalid_manifest"
    elif vectors_invalid:
        rebuild_reason = "invalid_vectors"
    elif any_artifact_exists and not all_artifacts_exist:
        rebuild_reason = "incomplete_artifacts"

    index = None
    if rebuild_reason is None:
        try:
            index = load_index(index_path)
            if index.ntotal != len(vectors):
                rebuild_reason = "index_metadata_mismatch"
        except Exception:
            rebuild_reason = "index_load_error"

    # Legacy artifacts (flat IndexFlatIP without IDMap, or vectors rows without
    # stable ids) cannot be updated incrementally: force a one-time migration rebuild.
    if rebuild_reason is None and not is_id_mapped_index(index):
        rebuild_reason = "legacy_index_format"

    if rebuild_reason is None and vectors and not _vectors_have_stable_ids(vectors):
        rebuild_reason = "legacy_vectors_format"

    # Embeddings from different models are not comparable: an index built with
    # another model (or a legacy manifest without the key) must be rebuilt.
    if (
        rebuild_reason is None
        and photos_state
        and manifest.get("embedding_model") != get_face_model_name()
    ):
        rebuild_reason = "embedding_model_changed"

    if rebuild_reason is not None:
        index = create_empty_index()
        vectors = []
        photos_state = {}
        manifest["photos"] = photos_state
        next_face_id = 0
        dirty_index = True
        dirty_vectors = True
        dirty_manifest = True
    else:
        next_face_id = _resolve_next_face_id(manifest, vectors)
        dirty_index = not index_exists
        dirty_vectors = not vectors_exists
        dirty_manifest = not manifest_exists

    if manifest.get("next_face_id") != next_face_id:
        manifest["next_face_id"] = next_face_id
        dirty_manifest = True

    if manifest.get("embedding_model") != get_face_model_name():
        manifest["embedding_model"] = get_face_model_name()
        dirty_manifest = True

    # Incremental removal: drop stale vectors (removed or modified photos) from
    # the IDMap2 index instead of rebuilding everything. Modified photos are
    # reprocessed below because their signature changed.
    faces_removed_from_index = 0
    if rebuild_reason is None:
        current_paths = set(photo_paths)
        removed_paths = {
            photo_path for photo_path in photos_state if photo_path not in current_paths
        }
        modified_paths = {
            photo_path
            for photo_path, change_type in photo_changes["byPath"].items()
            if change_type == "modified"
        }
        stale_paths = removed_paths | modified_paths
        if stale_paths:
            stale_ids = [
                vector_row["id"]
                for vector_row in vectors
                if isinstance(vector_row, dict)
                and vector_row.get("photo_path") in stale_paths
            ]
            if stale_ids:
                index.remove_ids(np.asarray(stale_ids, dtype=np.int64))
                vectors = [
                    vector_row
                    for vector_row in vectors
                    if not (
                        isinstance(vector_row, dict)
                        and vector_row.get("photo_path") in stale_paths
                    )
                ]
                faces_removed_from_index = len(stale_ids)
                dirty_index = True
                dirty_vectors = True
        if removed_paths:
            for photo_path in removed_paths:
                photos_state.pop(photo_path, None)
            dirty_manifest = True

    total_photos = len(photo_paths)
    processed_photos = 0
    photos_processed_for_indexing = 0
    skipped_existing = 0
    skipped_unchanged_photos = 0
    processed_new_photos = 0
    processed_modified_photos = 0
    reprocessed_unchanged_photos = 0
    new_faces_indexed = 0
    faces_indexed_from_new_or_modified_photos = 0
    faces_reindexed_from_unchanged_photos = 0
    photos_without_faces = 0
    photos_with_only_filtered_faces = 0
    faces_filtered_by_quality = 0
    unreadable_photos = 0
    failed_photos = 0
    artifact_write_counts = {"index": 0, "vectors": 0, "manifest": 0}

    tracebacks_written = 0

    analyzer = None
    has_processing_work = any(
        file_signatures.get(photo_path) is not None
        and (
            rebuild_reason is not None
            or photo_changes["byPath"].get(photo_path) != "unchanged"
        )
        for photo_path in photo_paths
    )
    if has_processing_work:
        analyzer = get_face_analyzer(det_size=INDEX_DET_SIZE)

    started_at = time.time()

    def save_dirty_artifacts():
        nonlocal dirty_index, dirty_vectors, dirty_manifest

        if not (dirty_index or dirty_vectors or dirty_manifest):
            return

        writes = _save_dirty_artifacts(
            index,
            vectors,
            manifest,
            index_path,
            vectors_path,
            manifest_path,
            dirty_index,
            dirty_vectors,
            dirty_manifest,
        )
        for artifact_name, did_write in writes.items():
            if did_write:
                artifact_write_counts[artifact_name] += 1
        dirty_index = False
        dirty_vectors = False
        dirty_manifest = False

    for photo_path in photo_paths:
        processed_photos += 1
        signature = file_signatures.get(photo_path)
        existing_state = photos_state.get(photo_path)
        change_type = photo_changes["byPath"].get(photo_path, "new")

        if (
            rebuild_reason is None
            and signature is not None
            and existing_state is not None
            and not _is_signature_changed(existing_state, signature)
        ):
            skipped_existing += 1
            skipped_unchanged_photos += 1
            _write_photo_progress(
                request_id,
                processed_photos,
                total_photos,
                photo_path,
                "skipped_existing",
                0,
                change_type,
            )
            continue

        if signature is None:
            failed_photos += 1
            _write_photo_progress(
                request_id,
                processed_photos,
                total_photos,
                photo_path,
                "missing_file",
                0,
                change_type,
            )
            continue

        photos_processed_for_indexing += 1
        if change_type == "new":
            processed_new_photos += 1
        elif change_type == "modified":
            processed_modified_photos += 1
        elif change_type == "unchanged":
            reprocessed_unchanged_photos += 1

        try:
            image = cv2.imread(photo_path)
            if image is None:
                unreadable_photos += 1
                photos_state[photo_path] = {
                    "mtime_ns": signature["mtime_ns"],
                    "size": signature["size"],
                    "faces_detected": 0,
                    "status": "unreadable",
                    "indexed_at": int(time.time()),
                }
                dirty_manifest = True
                _write_photo_progress(
                    request_id,
                    processed_photos,
                    total_photos,
                    photo_path,
                    "unreadable",
                    0,
                    change_type,
                )
                if processed_photos % SAVE_CHECKPOINT_EVERY == 0:
                    save_dirty_artifacts()
                continue

            faces = analyzer.get(image)
            valid_embeddings = []
            for face in faces:
                if not _passes_quality_filter(face, min_face_size, min_det_score):
                    faces_filtered_by_quality += 1
                    continue
                embedding = extract_face_embedding(image, face)
                if embedding is not None:
                    valid_embeddings.append(embedding)

            faces_detected = len(valid_embeddings)
            if faces_detected == 0:
                # Distinguish "nothing detected" from "detections discarded by
                # the quality gate" so the operator can tune the filter.
                if faces:
                    no_face_status = "faces_filtered"
                    photos_with_only_filtered_faces += 1
                else:
                    no_face_status = "no_faces"
                    photos_without_faces += 1
                photos_state[photo_path] = {
                    "mtime_ns": signature["mtime_ns"],
                    "size": signature["size"],
                    "faces_detected": 0,
                    "status": no_face_status,
                    "indexed_at": int(time.time()),
                }
                dirty_manifest = True
                _write_photo_progress(
                    request_id,
                    processed_photos,
                    total_photos,
                    photo_path,
                    no_face_status,
                    0,
                    change_type,
                )
                if processed_photos % SAVE_CHECKPOINT_EVERY == 0:
                    save_dirty_artifacts()
                continue

            embedding_matrix = np.stack(valid_embeddings).astype(np.float32)
            face_ids = list(range(next_face_id, next_face_id + faces_detected))
            next_face_id += faces_detected
            manifest["next_face_id"] = next_face_id
            index.add_with_ids(embedding_matrix, np.asarray(face_ids, dtype=np.int64))
            for face_ordinal, face_id in enumerate(face_ids):
                vectors.append(
                    {"id": face_id, "photo_path": photo_path, "face_ordinal": face_ordinal}
                )

            new_faces_indexed += faces_detected
            if change_type in {"new", "modified"}:
                faces_indexed_from_new_or_modified_photos += faces_detected
            elif change_type == "unchanged":
                faces_reindexed_from_unchanged_photos += faces_detected
            photos_state[photo_path] = {
                "mtime_ns": signature["mtime_ns"],
                "size": signature["size"],
                "faces_detected": faces_detected,
                "status": "indexed",
                "indexed_at": int(time.time()),
            }
            dirty_index = True
            dirty_vectors = True
            dirty_manifest = True
            _write_photo_progress(
                request_id,
                processed_photos,
                total_photos,
                photo_path,
                "indexed",
                faces_detected,
                change_type,
            )
        except Exception as error:
            failed_photos += 1
            # El mensaje viaja al manifest -> photo_index_status.last_error -> UI,
            # asi que tiene que bastar por si solo: tipo de excepcion (nunca
            # vacio) y la frame donde revento.
            described_error = describe_error_with_origin(error)
            if tracebacks_written < STDERR_TRACEBACK_LIMIT:
                tracebacks_written += 1
                sys.stderr.write(
                    "index_photos fallo en {path}:\n{trace}".format(
                        path=photo_path, trace=traceback.format_exc()
                    )
                )
            photos_state[photo_path] = {
                "mtime_ns": signature["mtime_ns"],
                "size": signature["size"],
                "faces_detected": 0,
                "status": "error",
                "error": described_error,
                "indexed_at": int(time.time()),
            }
            dirty_manifest = True
            _write_photo_progress(
                request_id,
                processed_photos,
                total_photos,
                photo_path,
                "error",
                0,
                change_type,
                error=described_error,
            )

        if processed_photos % SAVE_CHECKPOINT_EVERY == 0:
            save_dirty_artifacts()

    if total_photos == 0:
        _write_photo_progress(
            request_id,
            0,
            0,
            None,
            "empty_source",
            0,
            None,
            force=True,
        )

    save_dirty_artifacts()

    elapsed_ms = int((time.time() - started_at) * 1000)
    current_status_counts = _count_current_manifest_statuses(photo_paths, photos_state)
    current_photos_without_faces = current_status_counts.get("no_faces", 0)
    current_unreadable_photos = current_status_counts.get("unreadable", 0)
    current_error_photos = current_status_counts.get("error", 0)
    current_indexed_photos = current_status_counts.get("indexed", 0)

    return {
        "sourcePath": source_path,
        "indexDir": index_dir,
        "indexPath": index_path,
        "vectorsPath": vectors_path,
        "manifestPath": manifest_path,
        "rebuildReason": rebuild_reason,
        "stats": {
            "processedPhotos": processed_photos,
            "totalPhotos": total_photos,
            "newPhotosProcessed": photos_processed_for_indexing,
            "photosProcessedForIndexing": photos_processed_for_indexing,
            "newPhotos": photo_changes["newPhotos"],
            "modifiedPhotos": photo_changes["modifiedPhotos"],
            "unchangedPhotos": photo_changes["unchangedPhotos"],
            "removedPhotos": photo_changes["removedPhotos"],
            "missingPhotos": photo_changes["missingPhotos"],
            "skippedPhotos": skipped_existing,
            "skippedExistingPhotos": skipped_existing,
            "skippedUnchangedPhotos": skipped_unchanged_photos,
            "processedNewPhotos": processed_new_photos,
            "processedModifiedPhotos": processed_modified_photos,
            "modifiedPhotosProcessed": processed_modified_photos,
            "reprocessedUnchangedPhotos": reprocessed_unchanged_photos,
            "removedPhotosDetected": photo_changes["removedPhotos"],
            "photosRemovedFromManifest": photo_changes["removedPhotos"],
            "facesRemovedFromIndex": faces_removed_from_index,
            "newFacesIndexed": new_faces_indexed,
            "facesIndexed": new_faces_indexed,
            "facesIndexedFromNewOrModifiedPhotos": faces_indexed_from_new_or_modified_photos,
            "facesReindexedFromUnchangedPhotos": faces_reindexed_from_unchanged_photos,
            "photosWithoutFaces": photos_without_faces,
            "runPhotosWithoutFaces": photos_without_faces,
            "facesFilteredByQuality": faces_filtered_by_quality,
            "photosWithOnlyFilteredFaces": photos_with_only_filtered_faces,
            "currentFacesFilteredPhotos": current_status_counts.get("faces_filtered", 0),
            "currentPhotosWithoutFaces": current_photos_without_faces,
            "totalPhotosWithoutFaces": current_photos_without_faces,
            "unreadablePhotos": unreadable_photos,
            "runUnreadablePhotos": unreadable_photos,
            "currentUnreadablePhotos": current_unreadable_photos,
            "totalUnreadablePhotos": current_unreadable_photos,
            "errorPhotos": failed_photos,
            "runErrorPhotos": failed_photos,
            "currentErrorPhotos": current_error_photos,
            "totalErrorPhotos": current_error_photos,
            "failedPhotos": failed_photos,
            "currentIndexedPhotos": current_indexed_photos,
            "totalIndexedPhotos": current_indexed_photos,
            "byStatus": current_status_counts,
            "totalEmbeddingsInIndex": int(index.ntotal),
            "indexRebuilt": rebuild_reason is not None,
            "artifactWrites": artifact_write_counts,
            "elapsedMs": elapsed_ms,
        },
    }
