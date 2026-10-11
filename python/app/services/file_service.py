import errno
import json
import os
from pathlib import Path

from app.errors import ArtifactWriteError

# Tiene que coincidir con SOURCE_IMAGE_EXTENSIONS de electron/main.js: una
# extension que la UI lista pero Python no indexa queda "pendiente" para siempre.
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif"}


def load_json_file(path, default_value):
    payload, _failed = load_json_file_with_status(path, default_value)
    return payload


def load_json_file_with_status(path, default_value):
    if not os.path.exists(path):
        return default_value, False
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle), False
    except Exception:
        return default_value, True


def save_json_file(path, payload):
    _write_text_atomic(path, _serialize_json_payload(payload))


# Errnos de "no hay lugar para escribir" (EDQUOT solo existe en Unix).
DISK_FULL_ERRNOS = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}


def write_bytes_atomic(path, data):
    """Escribe a un temporal propio y lo mueve encima: un corte a mitad de la
    escritura deja el archivo anterior intacto, nunca uno truncado.

    Si la escritura falla, el temporal se borra y el error sale como
    ArtifactWriteError con un texto entendible, no como excepcion cruda.
    """
    temp_path = f"{path}.{os.getpid()}.tmp"
    try:
        with open(temp_path, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except OSError as error:
        _remove_temp_file(temp_path)
        raise ArtifactWriteError(_describe_write_error(path, error)) from error
    except BaseException:
        _remove_temp_file(temp_path)
        raise


def remove_stale_temp_files(directory):
    """Borra los .tmp que dejo una corrida que murio antes del os.replace."""
    try:
        names = os.listdir(directory)
    except OSError:
        return
    for name in names:
        if name.endswith(".tmp"):
            _remove_temp_file(os.path.join(directory, name))


def _remove_temp_file(temp_path):
    try:
        os.remove(temp_path)
    except OSError:
        pass


def _describe_write_error(path, error):
    file_name = os.path.basename(path)
    if error.errno in DISK_FULL_ERRNOS:
        return (
            "No hay espacio en disco para guardar {name}. Libera espacio y volve a "
            "indexar las fotos.".format(name=file_name)
        )
    return (
        "No se pudo guardar {name} ({error}). Revisa los permisos y el espacio en "
        "disco, y volve a indexar las fotos.".format(name=file_name, error=error)
    )


def _write_text_atomic(path, text):
    write_bytes_atomic(path, text.encode("utf-8"))


def _serialize_json_payload(payload):
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


def file_signature(file_path):
    stats = os.stat(file_path)
    return {"mtime_ns": int(stats.st_mtime_ns), "size": int(stats.st_size)}


def is_image_file(file_path):
    path = Path(file_path)
    # "._foto.jpg" son metadatos de macOS (AppleDouble), no imagenes.
    if path.name.startswith("._"):
        return False
    return path.suffix.lower() in IMAGE_EXTENSIONS


def list_event_photos(source_dir):
    photo_paths = []
    for root, _dirs, files in os.walk(source_dir):
        for name in files:
            candidate = os.path.join(root, name)
            if is_image_file(candidate):
                photo_paths.append(os.path.abspath(candidate))
    photo_paths.sort()
    return photo_paths
