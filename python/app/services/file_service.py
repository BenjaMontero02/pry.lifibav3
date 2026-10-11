import json
import os
from pathlib import Path

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


def save_json_file_if_changed(path, payload):
    serialized = _serialize_json_payload(payload)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            current = handle.read()
        if current == serialized:
            return False
        try:
            if json.loads(current) == payload:
                return False
        except Exception:
            pass
    except FileNotFoundError:
        pass

    _write_text_atomic(path, serialized)
    return True


def write_bytes_atomic(path, data):
    """Escribe a un temporal propio y lo mueve encima: un corte a mitad de la
    escritura deja el archivo anterior intacto, nunca uno truncado."""
    temp_path = f"{path}.{os.getpid()}.tmp"
    with open(temp_path, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, path)


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
