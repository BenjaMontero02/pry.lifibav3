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
    ALLOWED_MODULES,
    DETECTION_MODEL_NAME,
    get_embedding_backend,
    get_face_analyzer,
    get_face_model_name,
    redirect_stdout_to_stderr,
)


def _data_objects_ok():
    """True cuando ``insightface.data.get_object`` encuentra su meanshape.

    Es el archivo que en el bundle vivia en el lugar equivocado: get_object lo
    busca en ``sys._MEIPASS/objects/`` y devuelve None sin excepcion si falta,
    asi que el bundle roto solo se notaba al procesar caras. El redirect es
    obligatorio: get_object imprime a stdout, que es el canal del protocolo JSON.
    """
    from insightface.data import get_object

    with redirect_stdout_to_stderr():
        return get_object("meanshape_68.pkl") is not None


def self_check(_data=None, _request_id=None):
    analyzer = get_face_analyzer()
    loaded_models = sorted(analyzer.models.keys())

    return {
        "detection": "detection" in loaded_models,
        "loadedModels": loaded_models,
        "allowedModules": sorted(ALLOWED_MODULES),
        "unexpectedModules": [
            name for name in loaded_models if name not in ALLOWED_MODULES
        ],
        "dataObjectsOk": _data_objects_ok(),
        "detectionModelName": DETECTION_MODEL_NAME,
        "detectionModelDir": analyzer.model_dir,
        "embeddingBackend": get_embedding_backend(),
        "faceModelName": get_face_model_name(),
        "adafaceModelPresent": adaface_service.is_available(),
        "adafaceSessionOk": adaface_service.session_ok(),
    }
