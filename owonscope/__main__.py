"""Command line entry point: `owon-scope-web` (or `python -m owonscope`)."""
from __future__ import annotations

import argparse
import csv
import logging
import sys
import threading
import webbrowser

from . import __version__
from .manager import Manager


def _usb_id(text: str) -> tuple[int, int]:
    vid, pid = text.split(":")
    return int(vid, 16), int(pid, 16)


def _list(manager: Manager) -> int:
    devices = manager.rescan()
    if not devices:
        print("No OWON devices found. Is the scope on and connected with a data USB cable?")
        return 1
    for d in devices:
        info = d.driver.info if d.driver else {}
        print(f"{d.id:14} {d.status:13} {info.get('model', '-'):34} {info.get('protocol_name', d.error)}")
    return 0


def _capture(manager: Manager, path: str) -> int:
    ready = [d for d in manager.rescan() if d.status == "ready"]
    if not ready:
        print("No usable device found (run with --list for details).", file=sys.stderr)
        return 1
    cap = ready[0].driver.capture()
    cols = []
    for w in cap.waveforms:
        t = [w.t0 + i * w.dt for i in range(len(w.volts))]
        cols += [(f"{w.name}_time_s", t), (f"{w.name}_volts", list(w.volts))]
    rows = max(len(c[1]) for c in cols)
    with open(path, "w", newline="") as f:
        out = csv.writer(f)
        out.writerow([c[0] for c in cols])
        for i in range(rows):
            out.writerow([f"{c[1][i]:.9g}" if i < len(c[1]) else "" for c in cols])
    print(f"Saved {', '.join(w.name for w in cap.waveforms)} to {path}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="owon-scope-web",
        description="Web interface for OWON oscilloscopes connected over USB.")
    p.add_argument("--host", default="127.0.0.1",
                   help="address to listen on (use 0.0.0.0 to allow other devices on your network)")
    p.add_argument("--port", type=int, default=8642, help="HTTP port (default: 8642)")
    p.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    p.add_argument("--demo", action="store_true", help="add simulated scopes (no hardware needed)")
    p.add_argument("--usb", action="append", type=_usb_id, default=[], metavar="VID:PID",
                   help="also probe this USB ID (for rebranded OWON scopes), e.g. --usb 1234:5678")
    p.add_argument("--list", action="store_true", help="detect connected scopes and exit")
    p.add_argument("--capture", metavar="FILE.csv", help="capture once from the first scope to CSV and exit")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s")
    manager = Manager(demo=args.demo, extra_ids=args.usb)

    if args.list:
        return _list(manager)
    if args.capture:
        return _capture(manager, args.capture)

    from .server import serve
    httpd = serve(manager, args.host, args.port)
    host = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    url = f"http://{host}:{args.port}/"
    print(f"owon-scope-web {__version__} running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, (url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBye")
    finally:
        httpd.server_close()
        for d in manager.devices.values():
            if d.driver:
                d.driver.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
