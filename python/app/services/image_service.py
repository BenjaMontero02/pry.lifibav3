"""Lectura de fotos del evento como arrays BGR (el formato que esperan cv2/insightface).

``cv2.imread`` no sirve en Windows: con rutas que tienen caracteres no ASCII
(tildes, enie) devuelve None sin excepcion, y la foto quedaba como ilegible.
Leer los bytes con numpy y decodificar con ``cv2.imdecode`` evita el problema;
imdecode aplica la orientacion EXIF igual que imread.

Lo que OpenCV no decodifica (GIF, algunos JPEG CMYK) se intenta con Pillow.
"""

import cv2
import numpy as np


def _read_with_pillow(path):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None

    try:
        with Image.open(path) as handle:
            handle = ImageOps.exif_transpose(handle)
            rgb = np.asarray(handle.convert("RGB"))
    except Exception:
        return None
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def read_image_bgr(path):
    """Devuelve la imagen BGR uint8 o None si no se puede decodificar."""
    try:
        buffer = np.fromfile(path, dtype=np.uint8)
    except OSError:
        return None
    if buffer.size == 0:
        return None

    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is not None:
        return image
    return _read_with_pillow(path)
