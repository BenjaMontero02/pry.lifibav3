from app.services import adaface_service, face_index_service


def _reset_backend(monkeypatch):
    monkeypatch.setattr(face_index_service, "EMBEDDING_BACKEND", None)
    monkeypatch.setattr(face_index_service, "_embedding_backend_fallback", None)
    monkeypatch.delenv("LIFIBA_EMBEDDING_BACKEND", raising=False)


def test_adaface_falls_back_when_session_does_not_load(monkeypatch, capsys):
    _reset_backend(monkeypatch)
    monkeypatch.setattr(adaface_service, "is_available", lambda: True)
    monkeypatch.setattr(adaface_service, "session_ok", lambda: False)
    monkeypatch.setattr(adaface_service, "session_error", lambda: "onnx roto")

    assert face_index_service.get_embedding_backend() == "insightface"
    assert face_index_service.get_embedding_backend_fallback() == "onnx roto"
    assert face_index_service.get_face_model_name() == "antelopev2+flip"
    assert "AVISO: AdaFace no disponible (onnx roto)" in capsys.readouterr().err


def test_adaface_is_used_when_session_loads(monkeypatch):
    _reset_backend(monkeypatch)
    monkeypatch.setattr(adaface_service, "is_available", lambda: True)
    monkeypatch.setattr(adaface_service, "session_ok", lambda: True)

    assert face_index_service.get_embedding_backend() == "adaface"
    assert face_index_service.get_embedding_backend_fallback() is None
