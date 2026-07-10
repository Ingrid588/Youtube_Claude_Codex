"""Local-only controller for the Hugging Face test server.

The HF write token stays in config.json or the HF_WRITE_TOKEN environment
variable. The Chrome extension only talks to this loopback service.
"""
import json
import os
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8766
SPACE_REPO_ID = "Ingrid919/dub-server"
HEALTH_URL = "https://ingrid919-dub-server.hf.space/health"
HERE = os.path.dirname(os.path.abspath(__file__))
restart_lock = threading.Lock()
control_state = {
    "state": "checking",
    "started_at": None,
    "error": None,
}


def load_token():
    token = os.environ.get("HF_WRITE_TOKEN", "").strip()
    if token:
        return token
    path = os.path.join(HERE, "config.json")
    try:
        with open(path, "r", encoding="utf-8") as file:
            config = json.load(file)
        return (config.get("hf_write_token") or config.get("hf_token") or "").strip()
    except Exception:
        return ""


def health():
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=8) as response:
            return response.status == 200
    except Exception:
        return False


def restart_worker():
    control_state.update(
        state="restarting", started_at=time.time(), error=None)
    try:
        token = load_token()
        if not token:
            raise RuntimeError("HF write token is not configured")
        from huggingface_hub import HfApi
        HfApi(token=token).restart_space(repo_id=SPACE_REPO_ID)

        # The old container can keep answering /health for several seconds.
        # Never announce Ready immediately; wait for a real restart window and
        # then require two consecutive successful health probes.
        consecutive_ready = 0
        deadline = time.time() + 300
        while time.time() < deadline:
            time.sleep(4)
            elapsed = time.time() - control_state["started_at"]
            online = health()
            if elapsed >= 12 and online:
                consecutive_ready += 1
                if consecutive_ready >= 2:
                    control_state.update(state="ready", error=None)
                    return
            else:
                consecutive_ready = 0
        raise RuntimeError("test server did not become ready within 5 minutes")
    except Exception as exc:
        control_state.update(state="error", error=str(exc))
    finally:
        restart_lock.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path == "/status":
            online = health()
            if control_state["state"] not in ("restarting", "error"):
                control_state["state"] = "ready" if online else "offline"
            self._send(200, {
                "ok": True,
                "state": control_state["state"],
                "server_online": online,
                "started_at": control_state["started_at"],
                "error": control_state["error"],
            })
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/restart":
            self._send(404, {"ok": False, "error": "not found"})
            return
        origin = self.headers.get("Origin", "")
        if origin and not origin.startswith("chrome-extension://"):
            self._send(403, {"ok": False, "error": "extension origin required"})
            return
        if not restart_lock.acquire(blocking=False):
            self._send(409, {"ok": False, "error": "restart already in progress"})
            return
        try:
            if not load_token():
                restart_lock.release()
                self._send(503, {"ok": False, "error": "HF write token is not configured"})
                return
            threading.Thread(target=restart_worker, daemon=True).start()
            self._send(202, {"ok": True, "target": SPACE_REPO_ID})
        except Exception as exc:
            restart_lock.release()
            self._send(500, {"ok": False, "error": str(exc)})


if __name__ == "__main__":
    print(f"Test server controller: http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
