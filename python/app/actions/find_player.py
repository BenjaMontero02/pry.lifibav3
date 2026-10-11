import base64
import binascii
import math
import os
import sys

import cv2
import numpy as np

from app.services.face_index_service import (
    detect_faces,
    embedding_provides_quality,
    extract_face_embedding_with_quality,
    face_size_px,
    get_face_model_name,
    load_index,
    normalize_embedding,
)
from app.services.file_service import load_json_file
from app.services.index_location import index_artifact_paths, resolve_index_dir

# Mismo default que la UI (useScanPlayer.js). No esta calibrado con fotos
# reales de un evento: ajustarlo desde el control de la pantalla Escanear.
DEFAULT_SIMILARITY_THRESHOLD = 0.45
DEFAULT_MAX_RESULTS = 12
MAX_RESULTS_LIMIT = 500
MAX_QUERY_FRAMES = 16
SEARCH_INITIAL_MULTIPLIER = 4
SEARCH_CANDIDATE_MULTIPLIER = 64
MAX_SEARCH_CANDIDATES = 20000
# Cuantas similitudes (fotos distintas) se loguean aunque no superen el umbral.
TOP_SIMILARITY_LOG_LIMIT = 5

# Caras de la webcam: el jugador esta cerca, asi que se descartan detecciones
# chicas o dudosas (gente de fondo) antes de elegir la cara principal.
QUERY_MIN_DET_SCORE = 0.5
QUERY_MIN_FACE_SIZE_PX = 32
# Un frame cuya cara se parece poco a la del resto de los frames es otra
# persona (alguien que cruzo por delante) o una captura mala: no entra al promedio.
QUERY_FRAME_CONSISTENCY_MIN = 0.35

# Busqueda ampliada (query expansion). Desactivada por defecto: con un umbral
# sin calibrar puede arrastrar fotos de otra persona parecida.
QUERY_EXPANSION_MIN_SIMILARITY = 0.6
QUERY_EXPANSION_MARGIN = 0.15
QUERY_EXPANSION_MAX_NEIGHBORS = 5

# Calidad de cara (norma del feature AdaFace, mas alto = mejor). 0 = filtro apagado.
# Sin calibrar con fotos reales del evento: la norma solo separa bien el blur
# fuerte. Se ajusta desde Ajustes ("Calidad minima de rostro en resultados").
DEFAULT_MIN_FACE_QUALITY = 0.0
# Piso del peso de un frame en el promedio de la consulta (evita pesos en cero).
QUERY_WEIGHT_FLOOR = 1e-6

_artifact_cache = {
    "index_path": None,
    "index_signature": None,
    "vectors_path": None,
    "vectors_signature": None,
    "manifest_signature": None,
    "index": None,
    "vectors": None,
    "vectors_by_id": None,
    "embedding_model": None,
}


class IndexStaleError(ValueError):
    """El indice en disco no se puede usar para buscar. ``reason`` va al resultado
    ``index_stale``; el mensaje ya viene en espanol para el operador."""

    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason


def _artifact_signature(path):
    stats = os.stat(path)
    return (int(stats.st_mtime_ns), int(stats.st_size))


def _optional_artifact_signature(path):
    try:
        return _artifact_signature(path)
    except FileNotFoundError:
        return None


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


def _load_search_artifacts(index_path, vectors_path, manifest_path):
    global _artifact_cache

    index_signature = _artifact_signature(index_path)
    vectors_signature = _artifact_signature(vectors_path)
    manifest_signature = _optional_artifact_signature(manifest_path)
    if (
        _artifact_cache["index_path"] == index_path
        and _artifact_cache["index_signature"] == index_signature
        and _artifact_cache["vectors_path"] == vectors_path
        and _artifact_cache["vectors_signature"] == vectors_signature
        and _artifact_cache["manifest_signature"] == manifest_signature
    ):
        return (
            _artifact_cache["index"],
            _artifact_cache["vectors"],
            _artifact_cache["vectors_by_id"],
            _artifact_cache["embedding_model"],
            "hit",
        )

    try:
        index = load_index(index_path)
    except ValueError as error:
        raise IndexStaleError(
            "index_unreadable",
            "No se pudo leer el indice de caras ({error}). Anda a Fotos y presiona "
            "'Actualizar fotos'.".format(error=error),
        ) from error
    vectors = load_json_file(vectors_path, None)
    if not isinstance(vectors, list):
        raise IndexStaleError(
            "invalid_vectors",
            "El archivo de vectores esta danado. Anda a Fotos y presiona 'Actualizar fotos'.",
        )
    if index.ntotal != len(vectors):
        raise IndexStaleError(
            "index_out_of_sync",
            "El catalogo de caras quedo desincronizado (el indice y los vectores no "
            "coinciden). Anda a Fotos y presiona 'Actualizar fotos'.",
        )

    vectors_by_id = _build_vector_lookup(vectors)
    manifest = load_json_file(manifest_path, {}) if manifest_signature else {}
    embedding_model = manifest.get("embedding_model") if isinstance(manifest, dict) else None

    _artifact_cache = {
        "index_path": index_path,
        "index_signature": index_signature,
        "vectors_path": vectors_path,
        "vectors_signature": vectors_signature,
        "manifest_signature": manifest_signature,
        "index": index,
        "vectors": vectors,
        "vectors_by_id": vectors_by_id,
        "embedding_model": embedding_model,
    }
    return index, vectors, vectors_by_id, embedding_model, "reloaded"


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


def _consistent_positions(embeddings):
    """Posiciones de los frames que concuerdan con el medoide (el frame mas
    parecido al resto). Descarta frames donde otra persona quedo como cara principal.
    Devuelve ``(posiciones_que_se_quedan, cantidad_descartada)``."""
    if len(embeddings) <= 1:
        return list(range(len(embeddings))), 0

    stacked = np.stack(embeddings, axis=0)
    similarity = stacked @ stacked.T
    medoid = int(np.argmax(similarity.sum(axis=1)))
    kept = [
        position
        for position in range(len(embeddings))
        if position == medoid or similarity[medoid, position] >= QUERY_FRAME_CONSISTENCY_MIN
    ]
    return kept, len(embeddings) - len(kept)


def _query_weights(qualities):
    """Peso de cada frame en el promedio: su calidad si todos la tienen; si no, igual peso
    (mezclar normas con y sin calidad no es comparable)."""
    if qualities and all(quality is not None for quality in qualities):
        return [max(float(quality), QUERY_WEIGHT_FLOOR) for quality in qualities]
    return [1.0] * len(qualities)


def _average_query_embedding(frames_b64):
    """Compute embeddings per frame and return the quality-weighted, L2-normalized average.

    Frames without a detectable face are skipped (not an error), and so are
    frames inconsistent with the others. Each kept frame weighs by its AdaFace
    quality, so blurry or dark frames pull the query less. Returns a tuple
    (embedding_or_none, frames_used, frames_total, frames_rejected, frame_qualities),
    where ``frame_qualities`` has one entry per frame with a face (None = unknown).
    Re-normalizing the average is critical: the FAISS index uses inner product,
    which only equals cosine similarity for unit-norm vectors.
    """
    embeddings = []
    qualities = []
    for frame_b64 in frames_b64:
        image = _decode_frame_image(frame_b64)
        embedding, quality = _primary_face_embedding(image)
        if embedding is not None:
            embeddings.append(embedding)
            qualities.append(quality)

    if not embeddings:
        return None, 0, len(frames_b64), 0, qualities

    kept_positions, rejected = _consistent_positions(embeddings)
    kept_embeddings = [embeddings[position] for position in kept_positions]
    kept_qualities = [qualities[position] for position in kept_positions]
    averaged = np.average(
        np.stack(kept_embeddings, axis=0),
        axis=0,
        weights=_query_weights(kept_qualities),
    )
    normalized = normalize_embedding(averaged)
    return normalized, len(kept_positions), len(frames_b64), rejected, qualities


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


def _resolve_min_face_quality(data):
    """Calidad minima (norma AdaFace) para una cara del catalogo. 0 o ausente = apagado."""
    raw_quality = (data or {}).get("minFaceQuality", DEFAULT_MIN_FACE_QUALITY)
    if raw_quality is None:
        return DEFAULT_MIN_FACE_QUALITY
    if isinstance(raw_quality, bool):
        raise ValueError("minFaceQuality must be a finite number.")
    try:
        quality_value = float(raw_quality)
    except (TypeError, ValueError) as error:
        raise ValueError("minFaceQuality must be a finite number.") from error
    if not math.isfinite(quality_value) or quality_value < 0.0:
        raise ValueError("minFaceQuality must be a finite number greater than or equal to zero.")
    return quality_value


def _row_quality(vector_row):
    """Calidad guardada en una fila de vectors.json, o None si no la tiene (indice viejo)."""
    value = vector_row.get("quality")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _count_faces_with_quality(vectors):
    return sum(
        1 for vector_row in vectors if isinstance(vector_row, dict) and _row_quality(vector_row) is not None
    )


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


def _primary_face_embedding(image):
    """``(embedding, quality)`` of the player's face in a webcam frame, or ``(None, None)``.

    The player stands in front of the camera, so the main face is the biggest
    one (weighted by detection confidence). Picking by confidence alone let a
    frontal bystander win over the player in profile.
    """
    faces = [
        face
        for face in detect_faces(image, QUERY_MIN_DET_SCORE)
        if face_size_px(face) >= QUERY_MIN_FACE_SIZE_PX
    ]
    faces.sort(
        key=lambda face: (face_size_px(face) ** 2) * float(face.det_score),
        reverse=True,
    )
    for face in faces:
        embedding, quality = extract_face_embedding_with_quality(image, face)
        if embedding is not None:
            return embedding, quality
    return None, None


def _unique_matches(indices, distances, vectors_by_id, threshold, limit, min_quality=None):
    """Mejor cara por foto. Devuelve ``(coincidencias, caras_filtradas_por_calidad)``.

    Las caras con calidad conocida menor que ``min_quality`` se descartan antes de
    agregar por foto: una foto solo sale si tiene otra cara que pase el filtro.
    """
    matches_by_photo = {}
    filtered_by_quality = 0
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

        quality = _row_quality(vector_row)
        if min_quality is not None and quality is not None and quality < min_quality:
            filtered_by_quality += 1
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
                "faceId": int(vector_id),
                "quality": quality,
            }

    ordered = sorted(matches_by_photo.values(), key=lambda row: row["similarity"], reverse=True)
    return ordered[:limit], filtered_by_quality


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


def _search_unique_matches(
    index, query, vectors, vectors_by_id, threshold, max_results, min_quality=None
):
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
            "topSimilarities": [],
            "facesFilteredByQuality": 0,
        }

    search_size = min(
        search_limit,
        max(DEFAULT_MAX_RESULTS, result_limit * SEARCH_INITIAL_MULTIPLIER),
    )
    matches = []
    top_similarities = []
    filtered_by_quality = 0
    stop_reason = "search_limit_reached"

    while search_size > 0:
        distances, indices = index.search(query, search_size)
        indices_row = indices[0]
        distances_row = distances[0]
        matches, filtered_by_quality = _unique_matches(
            indices_row, distances_row, vectors_by_id, threshold, result_limit, min_quality
        )
        # Mejores similitudes sin filtrar por umbral ni calidad: para calibrar, no para mostrar.
        top_rows, _unused_filtered = _unique_matches(
            indices_row, distances_row, vectors_by_id, -1.0, TOP_SIMILARITY_LOG_LIMIT
        )
        top_similarities = [round(row["similarity"], 4) for row in top_rows]
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
        "topSimilarities": top_similarities,
        "facesFilteredByQuality": int(filtered_by_quality),
    }


def _expand_query(index, query_embedding, matches, threshold):
    """Alpha query expansion: blend the query with the faces it matched with
    high confidence, so profile/blurry photos of the same player that are
    closer to those faces than to the webcam frame also surface."""
    min_similarity = max(QUERY_EXPANSION_MIN_SIMILARITY, threshold + QUERY_EXPANSION_MARGIN)
    neighbors = [match for match in matches if match["similarity"] >= min_similarity]
    neighbors = neighbors[:QUERY_EXPANSION_MAX_NEIGHBORS]
    if not neighbors:
        return None, 0

    expanded = query_embedding.astype(np.float32).copy()
    for match in neighbors:
        neighbor_embedding = index.reconstruct(int(match["faceId"]))
        expanded += float(match["similarity"]) ** 3 * neighbor_embedding
    return normalize_embedding(expanded), len(neighbors)


def _merge_expanded_matches(matches, expanded_matches, limit):
    merged = {match["photoPath"]: dict(match) for match in matches}
    for match in expanded_matches:
        current = merged.get(match["photoPath"])
        if current is None:
            merged[match["photoPath"]] = {**match, "viaExpansion": True}
    ordered = sorted(merged.values(), key=lambda row: row["similarity"], reverse=True)
    return ordered[:limit]


def _log_match_calibration(
    threshold,
    search_summary,
    matches_count,
    frames_used,
    frames_total,
    frame_qualities,
    min_face_quality,
):
    """Una linea con las mejores similitudes, aunque no superen el umbral, y las
    calidades de los frames de la webcam."""
    top = ",".join("{:.4f}".format(value) for value in search_summary.get("topSimilarities", []))
    qualities = ",".join(
        "-" if quality is None else "{:.2f}".format(quality) for quality in frame_qualities
    )
    sys.stderr.write(
        "[face-calibration] find_player umbral={thr:.2f} top=[{top}] "
        "coincidencias={count} frames={used}/{total} calidadFrames=[{qualities}] "
        "minCalidad={min_quality:.2f} filtradasCalidad={filtered}\n".format(
            thr=threshold,
            top=top,
            count=matches_count,
            used=frames_used,
            total=frames_total,
            qualities=qualities,
            min_quality=min_face_quality,
            filtered=search_summary.get("facesFilteredByQuality", 0),
        )
    )


def find_player(data, _request_id):
    data = data or {}
    threshold = _resolve_threshold(data)
    max_results = _resolve_max_results(data)
    min_face_quality = _resolve_min_face_quality(data)
    # None = filtro apagado (0 o ausente): las filas sin calidad nunca se filtran.
    quality_filter = min_face_quality if min_face_quality > 0 else None
    use_query_expansion = bool(data.get("queryExpansion", False))

    index_dir = resolve_index_dir(data, "find_player")
    index_path, vectors_path, manifest_path = index_artifact_paths(index_dir)

    try:
        index, vectors, vectors_by_id, index_embedding_model, artifact_cache_status = (
            _load_search_artifacts(index_path, vectors_path, manifest_path)
        )
    except FileNotFoundError:
        return _empty_result(
            "empty_index",
            "missing_artifacts",
            "Face index artifacts are missing. Run index_photos first.",
            threshold=threshold,
            maxResults=max_results,
        )
    except IndexStaleError as error:
        return _empty_result(
            "index_stale",
            error.reason,
            str(error),
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

    # Vectores de modelos distintos no son comparables: buscar igual devolveria
    # resultados al azar sin ningun aviso.
    if index_embedding_model != get_face_model_name():
        return _empty_result(
            "index_stale",
            "embedding_model_mismatch",
            "The face index was built with a different embedding model. Re-run index_photos.",
            threshold=threshold,
            maxResults=max_results,
            indexEmbeddingModel=index_embedding_model,
            embeddingModel=get_face_model_name(),
        )

    frames_b64 = _resolve_frames(data)
    (
        query_embedding,
        frames_used,
        frames_total,
        frames_rejected,
        frame_qualities,
    ) = _average_query_embedding(frames_b64)
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
            framesRejected=frames_rejected,
        )

    query = np.expand_dims(query_embedding.astype(np.float32), axis=0)
    matches, search_summary = _search_unique_matches(
        index, query, vectors, vectors_by_id, threshold, max_results, quality_filter
    )
    search_summary["cacheStatus"] = artifact_cache_status
    search_summary["minFaceQuality"] = min_face_quality
    search_summary["facesWithQuality"] = _count_faces_with_quality(vectors)
    # Con el backend InsightFace ninguna cara trae calidad: reindexar no cambia nada.
    search_summary["qualityAvailable"] = embedding_provides_quality()
    _log_match_calibration(
        threshold,
        search_summary,
        len(matches),
        frames_used,
        frames_total,
        frame_qualities,
        min_face_quality,
    )

    search_summary["queryExpansionNeighbors"] = 0
    if use_query_expansion and matches:
        expanded_query, neighbor_count = _expand_query(index, query_embedding, matches, threshold)
        if expanded_query is not None:
            expanded_matches, _expanded_summary = _search_unique_matches(
                index,
                np.expand_dims(expanded_query, axis=0),
                vectors,
                vectors_by_id,
                threshold,
                max_results,
                quality_filter,
            )
            matches = _merge_expanded_matches(matches, expanded_matches, max_results)
            search_summary["queryExpansionNeighbors"] = neighbor_count

    # La lista se corto en maxResults y quedan fotos sin mirar: la UI avisa que
    # puede haber mas en vez de mostrar el corte como si fuera el total.
    has_more = len(matches) >= max_results and search_summary["uniquePhotos"] > len(matches)

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
            framesRejected=frames_rejected,
        )

    return {
        "status": "ok",
        "threshold": threshold,
        "maxResults": max_results,
        "hasMore": has_more,
        "search": search_summary,
        "matches": matches,
        "framesUsed": frames_used,
        "framesTotal": frames_total,
        "framesRejected": frames_rejected,
    }
