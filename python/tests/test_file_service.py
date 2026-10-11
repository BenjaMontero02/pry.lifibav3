import errno
import os

import pytest

from app.errors import ArtifactWriteError
from app.services import file_service


def test_write_bytes_atomic_replaces_content(tmp_path):
    target = tmp_path / "vectors.json"
    file_service.write_bytes_atomic(str(target), b"primero")
    file_service.write_bytes_atomic(str(target), b"segundo")

    assert target.read_bytes() == b"segundo"
    assert not list(tmp_path.glob("*.tmp"))


def test_write_bytes_atomic_in_non_ascii_directory(tmp_path):
    folder = tmp_path / "José ñandú"
    folder.mkdir()
    target = folder / "photos_manifest.json"

    file_service.write_bytes_atomic(str(target), b"{}")

    assert target.read_bytes() == b"{}"


def test_disk_full_removes_temp_and_keeps_previous_file(tmp_path, monkeypatch):
    target = tmp_path / "faces.faiss"
    target.write_bytes(b"version-anterior")

    def fail_fsync(_fd):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(file_service.os, "fsync", fail_fsync)

    with pytest.raises(ArtifactWriteError) as caught:
        file_service.write_bytes_atomic(str(target), b"version-nueva")

    message = str(caught.value)
    assert "espacio en disco" in message
    assert "faces.faiss" in message
    assert target.read_bytes() == b"version-anterior"
    assert not list(tmp_path.glob("*.tmp"))


def test_other_os_error_gets_readable_message(tmp_path, monkeypatch):
    target = tmp_path / "vectors.json"

    def fail_fsync(_fd):
        raise OSError(errno.EACCES, "Permission denied")

    monkeypatch.setattr(file_service.os, "fsync", fail_fsync)

    with pytest.raises(ArtifactWriteError) as caught:
        file_service.write_bytes_atomic(str(target), b"[]")

    assert "No se pudo guardar vectors.json" in str(caught.value)
    assert not list(tmp_path.glob("*.tmp"))


def test_remove_stale_temp_files_only_touches_tmp(tmp_path):
    stale = tmp_path / "faces.faiss.1234.tmp"
    stale.write_bytes(b"restos")
    keep = tmp_path / "faces.faiss"
    keep.write_bytes(b"indice")

    file_service.remove_stale_temp_files(str(tmp_path))

    assert not os.path.exists(stale)
    assert keep.read_bytes() == b"indice"
