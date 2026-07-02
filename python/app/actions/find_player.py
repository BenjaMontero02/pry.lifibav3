import base64
import binascii
import math
import os

import cv2
import numpy as np

from app.services.face_index_service import get_face_analyzer, load_index, normalize_embedding
from app.services.file_service import load_json_file

DEFAULT_SIMILARITY_THRESHOLD = 0.35
DEFAULT_MAX_RESULTS = 12
MAX_RESULTS_LIMIT = 100
MAX_QUERY_FRAMES = 16
SEARCH_INITIAL_MULTIPLIER = 4
SEARCH_CANDIDATE_MULTIPLIER = 64
MAX_SEARCH_CANDIDATES = 5000
_artifact_cache = {
    "index_path": None,
    "index_signature": None,
    "vectors_path": None,
    "vectors_signature": None,
    "index": None,
    "vectors": None,
    "vectors_by_id": None,
}


def _normalize_path(path):
    return os.path.abspath(os.path.normpath(path))


def _resolve_index_dir(data):
    runtime = (data or {}).get("__runtime", {})
    index_dir = runtime.get("indexDir")
    if index_dir:
        return _normalize_path(index_dir)

    app_data_path = runtime.get("appDataPath")
    if not app_data_path:
        raise ValueError("Missing runtime indexDir/appDataPath for find_player action.")
    return _normalize_path(os.path.join(app_data_path, "face-index"))


def _artifact_signature(path):
    stats = os.stat(path)
    return (int(stats.st_mtime_ns), int(stats.st_size))


def _empty_result(status, reason, message, **extra):
    return {
        "status": status,
        "reason": reason,
        "message": message,
        "matches": [],
        **extra,
    }


def _build_vector_lookup(vectors):
    """Map FAISS search ids to vector rows.

    New-format rows carry a stable "id" (IndexIDMap2 returns those ids from
    search). Legacy rows lack "id"; a legacy flat index returns positions, so
    the row position is used as fallback id to stay compatible until reindex.
    """
    lookup = {}
    for position, vector_row in enumerate(vectors):
        if not isinstance(vector_row, dict):
            continue
        row_id = vector_row.get("id")
        if not isinstance(row_id, int) or isinstance(row_id, bool):
            row_id = position
        lookup[int(row_id)] = vector_row
    return lookup


def _load_search_artifacts(index_path, vectors_path):
    global _artifact_cache

    index_signature = _artifact_signature(index_path)
    vectors_signature = _artifact_signature(vectors_path)
    if (
        _artifact_cache["index_path"] == index_path
        and _artifact_cache["index_signature"] == index_signature
        and _artifact_cache["vectors_path"] == vectors_path
        and _artifact_cache["vectors_signature"] == vectors_signature
    ):
        return (
            _artifact_cache["index"],
            _artifact_cache["vectors"],
            _artifact_cache["vectors_by_id"],
            "hit",
        )

    index = load_index(index_path)
    vectors = load_json_file(vectors_path, None)
    if not isinstance(vectors, list):
        raise ValueError("vectors.json has invalid format. Re-run index_photos.")
    if index.ntotal != len(vectors):
        raise ValueError("FAISS index and vectors.json are out of sync. Re-run index_photos.")

    vectors_by_id = _build_vector_lookup(vectors)

    _artifact_cache = {
        "index_path": index_path,
        "index_signature": index_signature,
        "vectors_path": vectors_path,
        "vectors_signature": vectors_signature,
        "index": index,
        "vectors": vectors,
        "vectors_by_id": vectors_by_id,
    }
    return index, vectors, vectors_by_id, "reloaded"


def _decode_frame_image(frame_b64):
    if not frame_b64 or not isinstance(frame_b64, str):
        raise ValueError("Missing frameBase64 for find_player action.")

    payload = frame_b64.split(",", 1)[1] if "," in frame_b64 else frame_b64
    payload = payload.strip()
    if not payload:
        raise ValueError("frameBase64 payload cannot be empty.")

    try:
        image_bytes = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("Invalid frameBase64 payload. Expected base64 image data.") from error

    image_array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Invalid webcam frame payload. Could not decode image.")
    return image


def _resolve_frames(data):
    """Return the list of base64 frames to process.

    Prefers the multi-frame "frames" field; falls back to the legacy
    single-frame "frameBase64" field (treated as a list of one) so older
    renderers keep working.
    """
    frames = (data or {}).get("frames")
    if frames is None:
        return [(data or {}).get("frameBase64")]

    if not isinstance(frames, list) or not frames:
        raise ValueError("frames must be a non-empty list of base64 images.")
    if len(frames) > MAX_QUERY_FRAMES:
        raise ValueError(f"frames cannot contain more than {MAX_QUERY_FRAMES} images.")
    return frames


def _average_query_embedding(frames_b64):
    """Compute embeddings per frame and return the L2-normalized average.

    Frames without a detectable face are skipped (not an error). Returns a
    tuple (embedding_or_none, frames_used, frames_total). Re-normalizing the
    average is critical: the FAISS index uses inner product, which only equals
    cosine similarity for unit-norm vectors.
    """
    embeddings = []
    for frame_b64 in frames_b64:
        image = _decode_frame_image(frame_b64)
        embedding = _best_face_embedding(image)
        if embedding is not None:
            embeddings.append(embedding)

    if not embeddings:
        return None, 0, len(frames_b64)

    averaged = np.mean(np.stack(embeddings, axis=0), axis=0)
    normalized = normalize_embedding(averaged)
    return normalized, len(embeddings), len(frames_b64)


def _resolve_threshold(data):
    threshold = (data or {}).get("similarityThreshold", DEFAULT_SIMILARITY_THRESHOLD)
    if isinstance(threshold, bool):
        raise ValueError("similarityThreshold must be a finite number.")
    try:
        threshold_value = float(threshold)
    except (TypeError, ValueError) as error:
        raise ValueError("similarityThreshold must be a finite number.") from error

    if not math.isfinite(threshold_value):
        raise ValueError("similarityThreshold must be a finite number.")
    if threshold_value < -1.0 or threshold_value > 1.0:
        raise ValueError("similarityThreshold must be in range [-1.0, 1.0].")
    return threshold_value


def _resolve_max_results(data):
    raw_max_results = (data or {}).get("maxResults", DEFAULT_MAX_RESULTS)
    if isinstance(raw_max_results, bool):
        raise ValueError("maxResults must be a finite integer greater than zero.")

    if isinstance(raw_max_results, int):
        max_results = raw_max_results
    elif isinstance(raw_max_results, float):
        if not math.isfinite(raw_max_results) or not raw_max_results.is_integer():
            raise ValueError("maxResults must be a finite integer greater than zero.")
        max_results = int(raw_max_results)
    elif isinstance(raw_max_results, str):
        try:
            parsed = float(raw_max_results.strip())
        except ValueError as error:
            raise ValueError("maxResults must be a finite integer greater than zero.") from error
        if not math.isfinite(parsed) or not parsed.is_integer():
            raise ValueError("maxResults must be a finite integer greater than zero.")
        max_results = int(parsed)
    else:
        raise ValueError("maxResults must be a finite integer greater than zero.")

    if max_results <= 0:
        raise ValueError("maxResults must be greater than zero.")
    return min(max_results, MAX_RESULTS_LIMIT)


def _best_face_embedding(image):
    analyzer = get_face_analyzer()
    faces = analyzer.get(image)
    if not faces:
        return None

    best_embedding = None
    best_score = -math.inf
    for face in faces:
        embedding = normalize_embedding(getattr(face, "embedding", None))
        if embedding is None:
            continue

        score = float(getattr(face, "det_score", 0.0) or 0.0)
        if score > best_score:
            best_embedding = embedding
            best_score = score

    return best_embedding


def _unique_matches(indices, distances, vectors_by_id, threshold, limit):
    matches_by_photo = {}
    for index_position, vector_id in enumerate(indices):
        if vector_id < 0:
            continue

        similarity = float(distances[index_position])
        if similarity < threshold:
            continue

        vector_row = vectors_by_id.get(int(vector_id))
        if not isinstance(vector_row, dict):
            continue

        photo_path = vector_row.get("photo_path")
        if not photo_path:
            continue

        current = matches_by_photo.get(photo_path)
        if current is None or similarity > current["similarity"]:
            try:
                face_ordinal = int(vector_row.get("face_ordinal", 0))
            except (TypeError, ValueError):
                face_ordinal = 0

            matches_by_photo[photo_path] = {
                "photoPath": photo_path,
                "similarity": similarity,
                "faceOrdinal": face_ordinal,
            }

    ordered = sorted(matches_by_photo.values(), key=lambda row: row["similarity"], reverse=True)
    return ordered[:limit]


def _count_unique_photos(vectors):
    photo_paths = set()
    for vector_row in vectors:
        if not isinstance(vector_row, dict):
            continue
        photo_path = vector_row.get("photo_path")
        if photo_path:
            photo_paths.add(photo_path)
    return len(photo_paths)


def _resolve_search_limit(index_total, max_results, unique_photo_count):
    if index_total <= 0 or unique_photo_count <= 0:
        return 0

    useful_match_count = min(max_results, unique_photo_count)
    requested_window = max(
        DEFAULT_MAX_RESULTS,
        useful_match_count * SEARCH_CANDIDATE_MULTIPLIER,
    )
    return min(index_total, requested_window, MAX_SEARCH_CANDIDATES)


def _search_unique_matches(index, query, vectors, vectors_by_id, threshold, max_results):
    unique_photo_count = _count_unique_photos(vectors)
    result_limit = min(max_results, unique_photo_count)
    search_limit = _resolve_search_limit(index.ntotal, max_results, unique_photo_count)
    if result_limit <= 0 or search_limit <= 0:
        return [], {
            "candidatesScanned": 0,
            "candidateLimit": search_limit,
            "indexSize": int(index.ntotal),
            "uniquePhotos": unique_photo_count,
            "stopReason": "no_indexed_photos",
        }

    search_size = min(
        search_limit,
        max(DEFAULT_MAX_RESULTS, result_limit * SEARCH_INITIAL_MULTIPLIER),
    )
    matches = []
    stop_reason = "search_limit_reached"

    while search_size > 0:
        distances, indices = index.search(query, search_size)
        indices_row = indices[0]
        distances_row = distances[0]
        matches = _unique_matches(
            indices_row, distances_row, vectors_by_id, threshold, result_limit
        )
        valid_distances = [
            float(distance)
            for vector_id, distance in zip(indices_row, distances_row)
            if vector_id >= 0 and int(vector_id) in vectors_by_id
        ]

        if len(matches) >= result_limit:
            stop_reason = "max_results_reached"
            break
        if not valid_distances:
            stop_reason = "no_candidates"
            break
        if valid_distances[-1] < threshold:
            stop_reason = "threshold_exhausted"
            break
        if search_size >= search_limit:
            break

        search_size = min(search_limit, search_size * 2)

    return matches, {
        "candidatesScanned": int(search_size),
        "candidateLimit": int(search_limit),
        "indexSize": int(index.ntotal),
        "uniquePhotos": int(unique_photo_count),
        "stopReason": stop_reason,
    }


def find_player(data, _request_id):
    data = data or {}
    threshold = _resolve_threshold(data)
    max_results = _resolve_max_results(data)

    index_dir = _resolve_index_dir(data)
    index_path = os.path.join(index_dir, "faces.faiss")
    vectors_path = os.path.join(index_dir, "vectors.json")

    if not os.path.exists(index_path) or not os.path.exists(vectors_path):
        return _empty_result(
            "empty_index",
            "missing_artifacts",
            "Face index artifacts are missing. Run index_photos first.",
            threshold=threshold,
            maxResults=max_results,
        )

    try:
        index, vectors, vectors_by_id, artifact_cache_status = _load_search_artifacts(
            index_path, vectors_path
        )
    except FileNotFoundError:
        return _empty_result(
            "empty_index",
            "missing_artifacts",
            "Face index artifacts were removed while loading. Run index_photos first.",
            threshold=threshold,
            maxResults=max_results,
        )

    if index.ntotal == 0 or len(vectors) == 0:
        return _empty_result(
            "empty_index",
            "no_vectors",
            "Face index is empty. Run index_photos before searching.",
            threshold=threshold,
            maxResults=max_results,
            cacheStatus=artifact_cache_status,
        )

    frames_b64 = _resolve_frames(data)
    query_embedding, frames_used, frames_total = _average_query_embedding(frames_b64)
    if query_embedding is None:
        return _empty_result(
            "no_face_detected",
            "no_usable_face_embedding",
            "No usable face was detected in the webcam frames.",
            threshold=threshold,
            maxResults=max_results,
            cacheStatus=artifact_cache_status,
            framesUsed=frames_used,
            framesTotal=frames_total,
        )

    query = np.expand_dims(query_embedding.astype(np.float32), axis=0)
    matches, search_summary = _search_unique_matches(
        index, query, vectors, vectors_by_id, threshold, max_results
    )
    search_summary["cacheStatus"] = artifact_cache_status

    if not matches:
        return _empty_result(
            "no_matches_above_threshold",
            search_summary["stopReason"],
            "No indexed photos matched above the configured similarity threshold.",
            threshold=threshold,
            maxResults=max_results,
            search=search_summary,
            framesUsed=frames_used,
            framesTotal=frames_total,
        )

    return {
        "status": "ok",
        "threshold": threshold,
        "maxResults": max_results,
        "search": search_summary,
        "matches": matches,
        "framesUsed": frames_used,
        "framesTotal": frames_total,
    }
