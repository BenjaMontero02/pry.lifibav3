"""Verificacion de que los modelos faciales cargan de verdad en este binario.

Existe para el smoke de CI: `ping` solo probaba que los imports nativos
resolvieran, y un bundle sin modelos pasaba igual. Esta accion construye el
analizador -que es donde reventaba- y reporta que quedo cargado.

Es de solo lectura: no toca el indice ni el filesystem del usuario. No se
expone en PYTHON_ACTIONS de electron/main.js, asi que no es alcanzable desde
el renderer.
"""

from app.services import adaface_service
from app.services.face_index_service import (
    DETECTION_MODEL_NAME,
    get_embedding_backend,
    get_face_analyzer,
    get_face_model_name,
)


def self_check(_data=None, _request_id=None):
    analyzer = get_face_analyzer()
    loaded_models = sorted(analyzer.models.keys())

    return {
        "detection": "detection" in loaded_models,
        "loadedModels": loaded_models,
        "detectionModelName": DETECTION_MODEL_NAME,
        "detectionModelDir": analyzer.model_dir,
        "embeddingBackend": get_embedding_backend(),
        "faceModelName": get_face_model_name(),
        "adafaceModelPresent": adaface_service.is_available(),
        "adafaceSessionOk": adaface_service.session_ok(),
    }
