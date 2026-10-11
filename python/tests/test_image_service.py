import cv2
import numpy as np

from app.services.image_service import read_image_bgr


def test_reads_image_from_non_ascii_path(tmp_path):
    folder = tmp_path / "Ñandú José"
    folder.mkdir()
    photo = folder / "partido final.png"
    # Pixel BGR (10, 200, 90): tiene que volver igual en BGR.
    pixels = np.full((20, 30, 3), (10, 200, 90), dtype=np.uint8)
    ok, encoded = cv2.imencode(".png", pixels)
    assert ok
    photo.write_bytes(encoded.tobytes())

    image = read_image_bgr(str(photo))

    assert image is not None
    assert image.shape == (20, 30, 3)
    assert tuple(image[0, 0]) == (10, 200, 90)


def test_missing_file_returns_none(tmp_path):
    assert read_image_bgr(str(tmp_path / "no-existe.jpg")) is None
