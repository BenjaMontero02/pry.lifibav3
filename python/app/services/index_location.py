"""Ubicacion de los artefactos del indice de caras (compartida por indexado y busqueda)."""

import os


def resolve_index_dir(data, action_name):
    """Carpeta del indice: ``__runtime.indexDir`` o, si falta, ``appDataPath/face-index``."""
    runtime = (data or {}).get("__runtime", {})
    index_dir = runtime.get("indexDir")
    if not index_dir:
        app_data_path = runtime.get("appDataPath")
        if not app_data_path:
            raise ValueError(
                "Missing runtime indexDir/appDataPath for {action} action.".format(
                    action=action_name
                )
            )
        index_dir = os.path.join(app_data_path, "face-index")
    return os.path.abspath(os.path.normpath(index_dir))


def index_artifact_paths(index_dir):
    """``(faces.faiss, vectors.json, photos_manifest.json)`` dentro de ``index_dir``."""
    return (
        os.path.join(index_dir, "faces.faiss"),
        os.path.join(index_dir, "vectors.json"),
        os.path.join(index_dir, "photos_manifest.json"),
    )
