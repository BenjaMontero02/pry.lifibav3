import os
import sys
import time
import traceback

import numpy as np

from app.errors import describe_error_with_origin
from app.progress import write_progress_event
from app.services.face_index_service import (
    DETECTION_SIZE,
    LARGE_IMAGE_DETECTION_SIZE,
    LARGE_IMAGE_MIN_SIDE,
    create_empty_index,
    detect_faces,
    extract_face_embedding_with_quality,
    face_size_px,
    get_embedding_backend,
    get_embedding_backend_fallback,
    get_face_analyzer,
    get_face_model_name,
    get_index_ids,
    is_id_mapped_index,
    load_index,
    save_index,
)
from app.services.file_service import (
    file_signature,
    list_event_photos,
    load_json_file_with_status,
    remove_stale_temp_files,
    save_json_file,
)
from app.services.image_service import read_image_bgr
from app.services.index_location import index_artifact_paths, resolve_index_dir

# Los checkpoints se guardan por tiempo, no por cantidad de fotos: cada guardado
# reserializa el indice FAISS completo, y con cada 25 fotos el costo crecia
# cuadraticamente con el tamano del catalogo. Un corte pierde como mucho este lapso.
SAVE_CHECKPOINT_INTERVAL_SECONDS = 30
# Cuantos tracebacks completos se escriben a stderr por corrida. Cuando falla
# cada foto por la misma causa (modelo ausente, backend roto) uno alcanza; el
# resto solo inflaria el log del bridge.
STDERR_TRACEBACK_LIMIT = 3
PROGRESS_EVENT_EVERY = 25
PROGRESS_VERBOSE_LIMIT = 50
ALWAYS_EMIT_PROGRESS_STATUSES = {"error", "unreadable"}

# Version de la logica de indexado. Subirla cuando un cambio de codigo altere
# que caras se detectan o como se embeben: fuerza un rebuild en el proximo scan.
PIPELINE_VERSION = 2

# Estados finales: una foto con firma sin cambios y uno de estos estados se
# saltea. "error" y "unreadable" se reintentan SIEMPRE (pueden ser transitorios:
# modelo que no cargo, archivo a medio copiar, disco de red).
SKIPPABLE_STATUSES = {"indexed", "no_faces", "faces_filtered"}

# Quality gate for indexing: tiny or low-confidence detections (background
# crowd) produce noisy embeddings that cause false positives in search.
# Tuned for phone-quality event photos where the main subject's face can be
# ~30-45px and in profile (profiles score lower on detection confidence).
DEFAULT_MIN_FACE_SIZE_PX = 28
DEFAULT_MIN_FACE_DET_SCORE = 0.50

# Piso con el que se pide el detector solo para el log de calibracion, asi se
# cuentan las caras que quedan bajo el umbral. El NMS es greedy por score: las
# caras por encima del umbral salen identicas, y el filtro se aplica aca.
CALIBRATION_DETECTION_FLOOR = 0.20


def _passes_quality_filter(face, min_face_size=None, min_det_score=None):
    if min_face_size is None:
        min_face_size = DEFAULT_MIN_FACE_SIZE_PX
    if min_det_score is None:
        min_det_score = DEFAULT_MIN_FACE_DET_SCORE

    if face_size_px(face) < min_face_size:
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


def _build_pipeline_fingerprint(min_face_size, min_det_score):
    """Todo lo que cambia que caras entran al indice. Se guarda en el manifest:
    si difiere del de la corrida anterior, el indice se reconstruye (antes
    cambiar los ajustes solo afectaba a fotos nuevas)."""
    return {
        "version": PIPELINE_VERSION,
        "embeddingModel": get_face_model_name(),
        "detectionSize": list(DETECTION_SIZE),
        "largeImageDetectionSize": list(LARGE_IMAGE_DETECTION_SIZE),
        "largeImageMinSide": LARGE_IMAGE_MIN_SIDE,
        "minFaceSizePx": int(min_face_size),
        "minFaceDetScore": round(float(min_det_score), 4),
    }


def _can_skip_photo(existing_state, signature):
    if signature is None or not isinstance(existing_state, dict):
        return False
    if _is_signature_changed(existing_state, signature):
        return False
    return existing_state.get("status") in SKIPPABLE_STATUSES


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


def _reconcile_index_with_vectors(index, vectors, photos_state):
    """Reconcilia por id el IndexIDMap2 con vectors.json despues de un corte.

    Cada archivo se reemplaza atomicamente, pero el conjunto no: si el proceso
    muere entre dos escrituras, quedan ids huerfanos en el indice y filas
    huerfanas en vectors.json. Se descartan los huerfanos de cada lado y las
    fotos que perdieron vectores salen del manifest, asi se reprocesan. Es
    mucho mas barato que reconstruir el catalogo entero.

    Devuelve ``(filas_validas, ids_huerfanos_en_indice, filas_huerfanas, fotos_afectadas)``.
    """
    index_ids = get_index_ids(index)
    kept_rows = []
    kept_ids = set()
    orphan_rows = []
    for vector_row in vectors:
        row_id = vector_row["id"]
        if row_id in index_ids and row_id not in kept_ids:
            kept_rows.append(vector_row)
            kept_ids.add(row_id)
        else:
            orphan_rows.append(vector_row)

    orphan_index_ids = index_ids - kept_ids
    if orphan_index_ids:
        index.remove_ids(np.asarray(sorted(orphan_index_ids), dtype=np.int64))

    affected_paths = {vector_row.get("photo_path") for vector_row in orphan_rows}
    for photo_path in affected_paths:
        photos_state.pop(photo_path, None)
    return kept_rows, len(orphan_index_ids), len(orphan_rows), affected_paths


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
    # Solo se llega aca con el flag dirty: se escribe directo. Releer el archivo
    # para comparar duplicaba el costo de cada checkpoint.
    writes = {"index": False, "vectors": False, "manifest": False}
    if dirty_index:
        save_index(index, index_path)
        writes["index"] = True
    if dirty_vectors:
        save_json_file(vectors_path, vectors)
        writes["vectors"] = True
        # Electron muestra en Ajustes cuantas caras tienen calidad. Leerlo de
        # vectors.json (cientos de MB en un evento grande) congelaba la UI: se
        # resume aca, en el manifest, que se escribe despues de los vectores.
        manifest["quality_coverage"] = {
            "faces": len(vectors),
            "withQuality": sum(
                1 for row in vectors if isinstance(row, dict) and row.get("quality") is not None
            ),
        }
        dirty_manifest = True
    if dirty_manifest:
        save_json_file(manifest_path, manifest)
        writes["manifest"] = True
    return writes


def _distribution_summary(values, digits):
    """``min p10 p50 p90 max`` de ``values`` o guiones si no hay datos."""
    if not values:
        return "min=- p10=- p50=- p90=- max=-"
    array = np.asarray(values, dtype=np.float64)
    p10, p50, p90 = np.percentile(array, [10, 50, 90])
    fmt = "{:." + str(digits) + "f}"
    return "min={a} p10={b} p50={c} p90={d} max={e}".format(
        a=fmt.format(array.min()),
        b=fmt.format(p10),
        c=fmt.format(p50),
        d=fmt.format(p90),
        e=fmt.format(array.max()),
    )


def _log_detection_calibration(
    det_scores,
    below_threshold,
    small_faces,
    accepted,
    min_det_score,
    min_face_size,
    qualities=(),
):
    """Una linea con la distribucion de det_score y de calidad (norma AdaFace) de la corrida."""
    spread = _distribution_summary(det_scores, 2)
    quality_spread = _distribution_summary(qualities, 2)
    sys.stderr.write(
        "[face-calibration] index caras={total} {spread} bajo_umbral={below} "
        "(umbral={thr:.2f} piso={floor:.2f}) chicas={small} (min={size}px) aceptadas={acc} "
        "calidad[{count}]: {quality}\n".format(
            total=len(det_scores),
            spread=spread,
            below=below_threshold,
            thr=min_det_score,
            floor=min(CALIBRATION_DETECTION_FLOOR, min_det_score),
            small=small_faces,
            size=min_face_size,
            acc=accepted,
            count=len(qualities),
            quality=quality_spread,
        )
    )


def index_photos(data, request_id):
    data = data or {}
    index_dir = resolve_index_dir(data, "index_photos")
    os.makedirs(index_dir, exist_ok=True)
    remove_stale_temp_files(index_dir)

    source_path = _resolve_source_path(data)
    photo_paths = list_event_photos(source_path)

    index_path, vectors_path, manifest_path = index_artifact_paths(index_dir)

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
        except OSError:
            # Borrada entre el listado y el stat, sin permisos, disco de red
            # caido: se trata como removida (sus vectores salen del indice).
            continue
    photo_paths = [photo_path for photo_path in photo_paths if photo_path in file_signatures]

    pipeline_fingerprint = _build_pipeline_fingerprint(min_face_size, min_det_score)

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
        # Que el ntotal coincida con vectors.json no se chequea aca: las
        # diferencias se reconcilian por id mas abajo.
        try:
            index = load_index(index_path)
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

    # Cambiaron los ajustes de deteccion (tamano minimo, precision) o la logica
    # de indexado: las fotos ya procesadas se habrian quedado con el resultado
    # viejo y el catalogo dependeria del historial de corridas.
    if (
        rebuild_reason is None
        and photos_state
        and manifest.get("pipeline") != pipeline_fingerprint
    ):
        rebuild_reason = "pipeline_changed"

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

    if manifest.get("pipeline") != pipeline_fingerprint:
        manifest["pipeline"] = pipeline_fingerprint
        dirty_manifest = True

    # Un corte entre dos escrituras deja indice y vectors.json desfasados: se
    # reconcilian por id antes de decidir que fotos reprocesar.
    orphan_index_ids_removed = 0
    orphan_vector_rows_removed = 0
    if rebuild_reason is None:
        vectors, orphan_index_ids_removed, orphan_vector_rows_removed, _affected = (
            _reconcile_index_with_vectors(index, vectors, photos_state)
        )
        if orphan_index_ids_removed:
            dirty_index = True
        if orphan_vector_rows_removed:
            dirty_vectors = True
            dirty_manifest = True

    # Fotos que esta corrida va a (re)procesar. El loop y la carga del modelo
    # usan este mismo conjunto: si discreparan, una foto a reintentar llegaria
    # al loop sin detector cargado.
    if rebuild_reason is None:
        paths_to_process = {
            photo_path
            for photo_path in photo_paths
            if not _can_skip_photo(photos_state.get(photo_path), file_signatures[photo_path])
        }
    else:
        paths_to_process = set(photo_paths)

    # Incremental removal: drop stale vectors from the IDMap2 index instead of
    # rebuilding everything. Stale = photo no longer in the folder, or photo
    # about to be reprocessed (modified, retried, or left with vectors but no
    # manifest entry by a crash between checkpoint writes). Removing them first
    # makes reprocessing idempotent: a photo can never end up with its faces
    # indexed twice.
    faces_removed_from_index = 0
    if rebuild_reason is None:
        current_paths = set(photo_paths)
        removed_paths = {
            photo_path for photo_path in photos_state if photo_path not in current_paths
        }
        stale_paths = set()
        for vector_row in vectors:
            if not isinstance(vector_row, dict):
                continue
            vector_photo_path = vector_row.get("photo_path")
            if vector_photo_path not in current_paths or vector_photo_path in paths_to_process:
                stale_paths.add(vector_photo_path)
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
    retried_photos = 0
    new_faces_indexed = 0
    faces_indexed_from_new_or_modified_photos = 0
    faces_reindexed_from_unchanged_photos = 0
    photos_without_faces = 0
    photos_with_only_filtered_faces = 0
    faces_filtered_by_quality = 0
    unreadable_photos = 0
    failed_photos = 0
    artifact_write_counts = {"index": 0, "vectors": 0, "manifest": 0}
    # Calibracion: det_score de cada cara que vio el detector, y las descartadas.
    det_scores_seen = []
    below_threshold_count = 0
    small_faces_count = 0
    # Calidad (norma AdaFace) de las caras indexadas en esta corrida.
    qualities_indexed = []

    tracebacks_written = 0

    if paths_to_process:
        # Carga los modelos antes del loop: si fallan, falla la corrida entera
        # con un error claro en vez de marcar cada foto como "error".
        get_face_analyzer()

    started_at = time.time()
    processing_ms_total = 0.0
    last_checkpoint_at = time.monotonic()

    def save_dirty_artifacts():
        nonlocal dirty_index, dirty_vectors, dirty_manifest, last_checkpoint_at

        last_checkpoint_at = time.monotonic()
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

    try:
        for photo_path in photo_paths:
            if time.monotonic() - last_checkpoint_at >= SAVE_CHECKPOINT_INTERVAL_SECONDS:
                save_dirty_artifacts()

            processed_photos += 1
            signature = file_signatures[photo_path]
            existing_state = photos_state.get(photo_path)
            change_type = photo_changes["byPath"].get(photo_path, "new")

            if photo_path not in paths_to_process:
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

            photos_processed_for_indexing += 1
            if change_type == "new":
                processed_new_photos += 1
            elif change_type == "modified":
                processed_modified_photos += 1
            elif change_type == "unchanged":
                reprocessed_unchanged_photos += 1
            if (
                rebuild_reason is None
                and isinstance(existing_state, dict)
                and existing_state.get("status") not in SKIPPABLE_STATUSES
            ):
                retried_photos += 1

            photo_started_at = time.perf_counter()
            try:
                image = read_image_bgr(photo_path)
                if image is None:
                    unreadable_photos += 1
                    photos_state[photo_path] = {
                        "mtime_ns": signature["mtime_ns"],
                        "size": signature["size"],
                        "faces_detected": 0,
                        "status": "unreadable",
                        "error": "No se pudo decodificar la imagen (formato no soportado o archivo danado).",
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
                    continue

                # El detector ya descarta las caras bajo min_det_score; el filtro de
                # calidad queda para el tamano minimo.
                candidates = detect_faces(image, min(CALIBRATION_DETECTION_FLOOR, min_det_score))
                faces = []
                for face in candidates:
                    det_scores_seen.append(float(face.det_score))
                    if float(face.det_score) < min_det_score:
                        below_threshold_count += 1
                    else:
                        faces.append(face)
                valid_embeddings = []
                valid_qualities = []
                for face in faces:
                    if not _passes_quality_filter(face, min_face_size, min_det_score):
                        faces_filtered_by_quality += 1
                        if face_size_px(face) < min_face_size:
                            small_faces_count += 1
                        continue
                    embedding, quality = extract_face_embedding_with_quality(image, face)
                    if embedding is None:
                        faces_filtered_by_quality += 1
                        continue
                    valid_embeddings.append(embedding)
                    valid_qualities.append(quality)

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
                    continue

                embedding_matrix = np.stack(valid_embeddings).astype(np.float32)
                face_ids = list(range(next_face_id, next_face_id + faces_detected))
                next_face_id += faces_detected
                manifest["next_face_id"] = next_face_id
                index.add_with_ids(embedding_matrix, np.asarray(face_ids, dtype=np.int64))
                for face_ordinal, face_id in enumerate(face_ids):
                    vector_row = {
                        "id": face_id,
                        "photo_path": photo_path,
                        "face_ordinal": face_ordinal,
                    }
                    # Calidad desconocida (backend InsightFace o modelo sin norma) = sin
                    # clave: find_player nunca filtra esas filas.
                    if valid_qualities[face_ordinal] is not None:
                        vector_row["quality"] = round(float(valid_qualities[face_ordinal]), 3)
                        qualities_indexed.append(vector_row["quality"])
                    vectors.append(vector_row)

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
            finally:
                processing_ms_total += (time.perf_counter() - photo_started_at) * 1000
    except BaseException:
        # Corte (Ctrl+C, cierre del proceso): se guarda lo ya indexado para no
        # rehacerlo. Si el guardado tambien falla, manda el error original.
        try:
            save_dirty_artifacts()
        except Exception as save_error:
            sys.stderr.write(
                "index_photos: no se pudo guardar el avance al interrumpir: {error}\n".format(
                    error=save_error
                )
            )
        raise

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

    _log_detection_calibration(
        det_scores_seen,
        below_threshold_count,
        small_faces_count,
        new_faces_indexed,
        min_det_score,
        min_face_size,
        qualities=qualities_indexed,
    )

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
        "pipeline": pipeline_fingerprint,
        "embeddingBackend": get_embedding_backend(),
        "embeddingModel": get_face_model_name(),
        # None salvo que se pidio AdaFace y no se pudo usar: ahi trae el motivo.
        "embeddingBackendFallback": get_embedding_backend_fallback(),
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
            "retriedPhotos": retried_photos,
            "removedPhotosDetected": photo_changes["removedPhotos"],
            "photosRemovedFromManifest": photo_changes["removedPhotos"],
            "facesRemovedFromIndex": faces_removed_from_index,
            "orphanIndexIdsRemoved": orphan_index_ids_removed,
            "orphanVectorRowsRemoved": orphan_vector_rows_removed,
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
            "avgMsPerProcessedPhoto": (
                int(processing_ms_total / photos_processed_for_indexing)
                if photos_processed_for_indexing
                else 0
            ),
        },
    }
