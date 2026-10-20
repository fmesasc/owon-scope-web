"""Small HTTP server: JSON API + static web UI. Standard library only."""
from __future__ import annotations

import json
import logging
import mimetypes
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from urllib.parse import urlparse

from . import __version__
from .manager import Manager
from .usbio import DeviceGone

log = logging.getLogger(__name__)
WEB = resources.files("owonscope") / "web"


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def make_handler(manager: Manager):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"owon-scope-web/{__version__}"

        def log_message(self, fmt, *args):
            log.debug("%s - " + fmt, self.address_string(), *args)

        # --- plumbing ------------------------------------------------------
        def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, status: int = 200):
            self._send(status, json.dumps(obj).encode(), "application/json")

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def _route(self, method: str):
            path = urlparse(self.path).path
            try:
                if path.startswith("/api/"):
                    self._api(method, path[5:].strip("/").split("/"))
                elif method == "GET":
                    self._static(path)
                else:
                    raise ApiError(404, "Not found")
            except ApiError as e:
                self._json({"error": str(e)}, e.status)
            except DeviceGone as e:
                self._json({"error": f"Device disconnected: {e}", "gone": True}, 410)
            except (TimeoutError, IOError, ValueError, NotImplementedError) as e:
                self._json({"error": str(e)}, 502 if isinstance(e, (TimeoutError, IOError)) else 400)
            except Exception as e:  # noqa: BLE001
                log.error("Unhandled error: %s", traceback.format_exc())
                self._json({"error": f"{type(e).__name__}: {e}"}, 500)

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

        def _static(self, path: str):
            name = "index.html" if path in ("", "/") else path.lstrip("/")
            if "/" in name or name.startswith("."):
                raise ApiError(404, "Not found")
            f = WEB / name
            if not f.is_file():
                raise ApiError(404, "Not found")
            ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self._send(200, f.read_bytes(), ctype)

        # --- API -------------------------------------------------------------
        def _api(self, method: str, parts: list[str]):
            if parts == ["devices"] and method == "GET":
                return self._json({"version": __version__,
                                   "devices": [d.to_json() for d in manager.rescan()]})
            if len(parts) < 3 or parts[0] != "devices":
                raise ApiError(404, "Unknown endpoint")
            dev_id, action = parts[1], parts[2]
            try:
                dev = manager.get(dev_id)
            except KeyError:
                raise ApiError(404, f"No ready device {dev_id!r}")
            drv = dev.driver
            try:
                if action == "capture" and method == "GET":
                    return self._json(drv.capture().to_json())
                if action == "settings" and method == "GET":
                    return self._json(drv.get_settings())
                if action == "control" and method == "POST":
                    body = self._body()
                    return self._json(drv.apply(body.get("action", ""), body))
                if action == "screenshot" and method == "GET":
                    data, ctype = drv.screenshot()
                    return self._send(200, data, ctype)
                if action == "raw" and method == "GET":
                    if not drv.last_raw:
                        raise ApiError(404, "Nothing captured yet")
                    stamp = time.strftime("%Y%m%d_%H%M%S")
                    ext = "json" if drv.protocol == "owon-scpi" else "bin"
                    return self._send(200, drv.last_raw, "application/octet-stream", {
                        "Content-Disposition": f'attachment; filename="owon_raw_{stamp}.{ext}"'})
            except DeviceGone:
                manager.forget(dev_id)
                raise
            raise ApiError(404, "Unknown endpoint")

    return Handler


def serve(manager: Manager, host: str, port: int) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), make_handler(manager))
    httpd.daemon_threads = True
    return httpd
