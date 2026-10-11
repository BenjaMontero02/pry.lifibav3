from app.actions.index_photos import index_photos
from app.actions.find_player import find_player
from app.actions.preview_face import preview_face
from app.actions.self_check import self_check
from app.errors import UnsupportedActionError


def handle_action(action, data, request_id):
    if action == "ping":
        return {"pong": True}
    if action == "index_photos":
        return index_photos(data, request_id)
    if action == "find_player":
        return find_player(data, request_id)
    if action == "preview_face":
        return preview_face(data, request_id)
    if action == "self_check":
        return self_check(data, request_id)
    raise UnsupportedActionError(f"Accion desconocida para el backend Python: {action!r}")
