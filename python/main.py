import json
import sys

from app.errors import describe_error
from app.router import handle_action


def _configure_utf8_streams():
    # Electron escribe el protocolo en UTF-8. Sin esto Windows lee stdin con la
    # codepage del sistema (cp1252) y las rutas con tildes llegan corruptas.
    # stderr tambien: los banners de los modelos imprimen rutas del usuario.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def _json_default(value):
    # numpy (float32, int64, ndarray) no es serializable por json.
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "item"):
        return value.item()
    return str(value)


def _write_line(payload):
    sys.stdout.write(json.dumps(payload, default=_json_default) + "\n")
    sys.stdout.flush()


def main():
    _configure_utf8_streams()

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = None
        try:
            payload = json.loads(line)
            request_id = payload.get("requestId")
            action = payload.get("action")
            data = payload.get("data", {})

            # Los pedidos se atienden de a uno: el bridge arma el timeout de
            # cada pedido recien cuando llega este aviso, no mientras espera
            # en la cola detras de otro (p. ej. un escaneo durante un indexado).
            _write_line({"type": "started", "requestId": request_id, "action": action})

            result = handle_action(action, data, request_id)
            serialized = json.dumps(
                {"requestId": request_id, "ok": True, "result": result},
                default=_json_default,
            )
        except Exception as error:
            serialized = json.dumps(
                {
                    "requestId": request_id,
                    "ok": False,
                    "error": describe_error(error),
                }
            )

        sys.stdout.write(serialized + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
