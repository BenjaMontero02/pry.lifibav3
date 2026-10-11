"""Modo de deteccion preciso: pasada extra a 3072 y fingerprint propio."""

import numpy as np

from app.actions import index_photos as index_photos_module
from app.services.face_index_service import (
    DETECTION_SIZE,
    LARGE_IMAGE_DETECTION_SIZE,
    PRECISE_IMAGE_DETECTION_SIZE,
    detection_sizes_for,
)


def _image(width, height):
    return np.zeros((height, width, 3), dtype=np.uint8)


def test_standard_mode_keeps_the_existing_passes():
    assert detection_sizes_for(_image(1200, 800)) == [DETECTION_SIZE]
    assert detection_sizes_for(_image(6000, 4000)) == [DETECTION_SIZE, LARGE_IMAGE_DETECTION_SIZE]


def test_precise_mode_adds_the_3072_pass_only_on_large_photos():
    assert detection_sizes_for(_image(6000, 4000), "precise") == [
        DETECTION_SIZE,
        LARGE_IMAGE_DETECTION_SIZE,
        PRECISE_IMAGE_DETECTION_SIZE,
    ]
    # Entre 1600 y 2400 px la pasada 3072 solo agrandaria la foto.
    assert detection_sizes_for(_image(2000, 1500), "precise") == [
        DETECTION_SIZE,
        LARGE_IMAGE_DETECTION_SIZE,
    ]


def test_standard_fingerprint_is_unchanged_so_updates_do_not_force_reindex():
    standard = index_photos_module._build_pipeline_fingerprint(28, 0.5)
    assert "detectionMode" not in standard
    assert standard == index_photos_module._build_pipeline_fingerprint(28, 0.5, "standard")


def test_switching_to_precise_changes_the_fingerprint():
    standard = index_photos_module._build_pipeline_fingerprint(28, 0.5)
    precise = index_photos_module._build_pipeline_fingerprint(28, 0.5, "precise")
    assert precise != standard
    assert precise["detectionMode"] == "precise"
    assert precise["preciseImageDetectionSize"] == list(PRECISE_IMAGE_DETECTION_SIZE)
