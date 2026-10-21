import json
import threading
import urllib.request

import pytest

from owonscope.manager import Manager
from owonscope.server import serve


@pytest.fixture()
def base_url(monkeypatch):
    monkeypatch.setattr("owonscope.manager.scan", lambda extra=None: [])  # no real USB in CI
    httpd = serve(Manager(demo=True), "127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def get(url):
    with urllib.request.urlopen(url) as r:
        return r.status, r.headers.get("Content-Type"), r.read()


def test_static_ui(base_url):
    status, ctype, body = get(base_url + "/")
    assert status == 200 and "text/html" in ctype and b"OWON Scope" in body
    assert b'name="owon-local-server"' in body  # lets the page know the API exists
    status, ctype, _ = get(base_url + "/app.js")
    assert "javascript" in ctype


def test_devices_capture_and_control(base_url):
    _, _, body = get(base_url + "/api/devices")
    devices = {d["id"]: d for d in json.loads(body)["devices"]}
    assert devices["demo-legacy"]["capabilities"]["control"] is False
    assert devices["demo-scpi"]["capabilities"]["control"] is True

    _, _, body = get(base_url + "/api/devices/demo-legacy/capture")
    cap = json.loads(body)
    assert [w["name"] for w in cap["waveforms"]] == ["CH1", "CH2"]
    assert len(cap["waveforms"][0]["volts"]) == 1000

    req = urllib.request.Request(base_url + "/api/devices/demo-scpi/control", method="POST",
                                 data=json.dumps({"action": "stop"}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        assert json.loads(r.read())["sent"] == ":RUNning STOP"


def test_errors_are_json(base_url):
    with pytest.raises(urllib.error.HTTPError) as e:
        get(base_url + "/api/devices/nope/capture")
    assert e.value.code == 404
    assert "error" in json.loads(e.value.read())
