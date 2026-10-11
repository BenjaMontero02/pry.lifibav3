"""Indicador en vivo de la camara: hay cara, cuantas y de que tamano.

Lo pide la vista de escaneo 2 veces por segundo mientras la camara esta
prendida, para avisar "acercate" o "no se ve ninguna cara" ANTES de capturar.
Solo corre el detector en una pasada chica (sin embeddings) y no escribe logs:
a esa frecuencia ensuciarian la salida de diagnostico.
"""

from app.actions.find_player import (
    QUERY_MIN_DET_SCORE,
    QUERY_MIN_FACE_SIZE_PX,
    _decode_frame_image,
    _estimate_yaw,
    _primary_face_rank,
)
from app.services.face_index_service import PREVIEW_DETECTION_SIZE, detect_faces, face_size_px


def preview_face(data, _request_id):
    image = _decode_frame_image((data or {}).get("frame"))
    height, width = image.shape[:2]
    faces = detect_faces(image, QUERY_MIN_DET_SCORE, input_sizes=[PREVIEW_DETECTION_SIZE])
    result = {
        "frameWidth": int(width),
        "frameHeight": int(height),
        "faceCount": len(faces),
        "primary": None,
        # Tamano minimo que exige la busqueda, en pixeles del frame capturado.
        "minFaceSizePx": QUERY_MIN_FACE_SIZE_PX,
    }
    if not faces:
        return result

    primary = max(faces, key=_primary_face_rank)
    x1, y1, x2, y2 = (float(value) for value in primary.bbox[:4])
    yaw = _estimate_yaw(primary)
    result["primary"] = {
        # Lado menor del recuadro, en pixeles de ESTE frame (la UI lo escala a la
        # resolucion de captura).
        "sizePx": round(face_size_px(primary), 1),
        "detScore": round(float(primary.det_score), 3),
        "yaw": None if yaw is None else round(yaw, 3),
        "box": [
            round(x1 / width, 4),
            round(y1 / height, 4),
            round(x2 / width, 4),
            round(y2 / height, 4),
        ],
    }
    return result
