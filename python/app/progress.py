import json
import sys


def write_progress_event(request_id, payload, action="index_photos"):
    event = {
        "type": "progress",
        "requestId": request_id,
        "action": action,
        "payload": payload,
    }
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()
