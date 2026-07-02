import json
import sys

from app.router import handle_action


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
            response = {"requestId": request_id, "ok": False, "error": str(error)}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
