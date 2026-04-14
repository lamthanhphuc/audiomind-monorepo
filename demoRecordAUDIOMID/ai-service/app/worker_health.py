from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from loguru import logger

from app.config import get_settings
from app.job_status_store import _get_client

settings = get_settings()
_health_server_started = False
_health_server_lock = threading.Lock()


class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return

        try:
            _get_client().ping()
            body = b'{"status":"healthy","redis":"ok"}'
            self.send_response(200)
        except Exception:
            body = b'{"status":"unhealthy","redis":"error"}'
            self.send_response(503)

        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def _run_health_server() -> None:
    port = int(settings.worker_health_port)
    server = HTTPServer(("0.0.0.0", port), _HealthHandler)
    logger.info(f"Celery worker health endpoint listening on :{port}/health")
    server.serve_forever()


def start_worker_health_server() -> None:
    global _health_server_started
    with _health_server_lock:
        if _health_server_started:
            return

        thread = threading.Thread(
            target=_run_health_server,
            name="celery-worker-health",
            daemon=True,
        )
        thread.start()
        _health_server_started = True
