import json
import sys

from app.router import handle_action


def _describe_error(error):
    """Mensaje de error nunca vacio.

    Un ``assert`` sin texto (lo que lanza insightface cuando no encuentra los
    modelos) daba ``str(error) == ""``, y del otro lado del puente ese string
    vacio era falsy: el fallo se reportaba como exito y el operador veia
    "Analisis completo." sin haber indexado nada.
    """
    message = str(error).strip()
    if message:
        return "{name}: {message}".format(name=type(error).__name__, message=message)
    return "{name} (sin mensaje)".format(name=type(error).__name__)


def main():
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

            result = handle_action(action, data, request_id)
            response = {"requestId": request_id, "ok": True, "result": result}
        except Exception as error:
            response = {
                "requestId": request_id,
                "ok": False,
                "error": _describe_error(error),
            }

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
