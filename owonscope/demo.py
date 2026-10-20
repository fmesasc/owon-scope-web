"""Simulated devices for trying the UI without hardware (--demo) and for tests."""
from __future__ import annotations

import json
import struct
import threading
import time

import numpy as np

from . import legacy, scpi
from .model import Capture, parse_si


def _signal(kind: str, t: np.ndarray, freq: float, amp: float) -> np.ndarray:
    phase = 2 * np.pi * freq * t + np.random.uniform(-0.02, 0.02)  # trigger-locked, slight jitter
    if kind == "square":
        s = amp * np.sign(np.sin(phase))
    elif kind == "pulse":
        s = np.where(np.sin(phase) > 0.95, -amp * 3, amp)
    else:
        s = amp * np.sin(phase)
    return s + np.random.normal(0, amp * 0.02, len(t))


def build_legacy_dump() -> bytes:
    """Make an SPBV01 dump like a PDS5022S would send."""
    blocks = b""
    specs = [  # name, n, timebase_idx, offset, vdiv_idx, probe_idx, us/sample, mV/count, kind, freq, amp(V)
        ("CH1", 1000, 13, 25, 8, 0, 1.0, 40.0, "sine", 1000.0, 2.5),
        ("CH2", 1000, 13, -50, 6, 1, 1.0, 0.8 * 10, "square", 2000.0, 0.3),
    ]
    for name, n, tb, off, vd, pr, usps, mvpc, kind, freq, amp in specs:
        t = np.arange(n) * usps * 1e-6
        volts = _signal(kind, t, freq, amp)
        codes = np.clip(np.round(volts / (mvpc * 1e-3 * 10 ** pr)) + off, -32768, 32767).astype("<i2")
        body = struct.pack("<7i4f", n, n, 0, tb, off, vd, pr, usps, freq, 1e6 / freq, mvpc) + codes.tobytes()
        blocks += name.encode() + struct.pack("<i", 4 + len(body)) + body
    total = 10 + len(blocks)
    return b"SPBV01" + struct.pack("<i", total) + blocks


class DemoLegacyDriver(legacy.LegacyDriver):
    def __init__(self):
        super().__init__(link=None)
        self.info.update(model="Demo PDS5022S (simulated)", simulated=True)

    def capture(self) -> Capture:
        time.sleep(0.05)
        buf = build_legacy_dump()
        self.last_raw = buf
        return legacy.parse_dump(buf)

    def screenshot(self):
        raise IOError("Device did not return a bitmap")


class _FakeLink:
    usbtmc = False

    def __init__(self):
        self.lock = threading.RLock()


class FakeScpiPipe:
    """Answers the subset of OWON SCPI used by ScpiDriver."""

    def __init__(self):
        self.link = _FakeLink()
        self.state = {
            "CH1": {"display": True, "scale": "1V", "coupling": "DC", "probe": "10X", "offset": 0},
            "CH2": {"display": True, "scale": "500mV", "coupling": "AC", "probe": "1X", "offset": -50},
            "timebase": "500us", "running": True,
            "trigger": {"source": "CH1", "slope": "RISE", "level": "0V", "sweep": "AUTO"},
        }
        self.points = 7600
        self.sent: list[str] = []

    def write(self, cmd: str):
        self.sent.append(cmd)
        c = cmd.strip()
        u = c.upper()
        arg = c.split(" ", 1)[1] if " " in c else ""
        if u.startswith(":CHANNEL"):
            ch = "CH" + u[8]
            key = u.split(":")[2].split(" ")[0]
            st = self.state[ch]
            if key.startswith("DISP"):
                st["display"] = arg.upper() == "ON"
            elif key.startswith("SCAL"):
                st["scale"] = arg.upper().replace("MV", "mV")
            elif key.startswith("COUP"):
                st["coupling"] = arg.upper()
            elif key.startswith("PROB"):
                st["probe"] = arg.upper()
            elif key.startswith("OFFS"):
                st["offset"] = int(float(arg) * 25)
        elif u.startswith(":HORIZONTAL:SCAL"):
            self.state["timebase"] = arg
        elif u.startswith(":RUNNING"):
            self.state["running"] = arg.upper() == "RUN"
        elif u.startswith(":TRIGGER:SINGLE:EDGE:SOUR"):
            self.state["trigger"]["source"] = arg
        elif u.startswith(":TRIGGER:SINGLE:EDGE:SLOP"):
            self.state["trigger"]["slope"] = arg
        elif u.startswith(":TRIGGER:SINGLE:EDGE:LEV"):
            self.state["trigger"]["level"] = arg
        elif u.startswith(":TRIGGER:SINGLE:SWE"):
            self.state["trigger"]["sweep"] = arg

    def query(self, cmd: str, timeout: int = 2000) -> str:
        self.sent.append(cmd)
        if cmd.upper() == "*IDN?":
            return "OWON,SDS1102 (simulated),2024000001,V4.0.0"
        return ""

    def _head(self) -> dict:
        chans = []
        for name in ("CH1", "CH2"):
            st = self.state[name]
            chans.append({"NAME": name, "DISPLAY": "ON" if st["display"] else "OFF",
                          "COUPLING": st["coupling"], "PROBE": st["probe"], "SCALE": st["scale"],
                          "OFFSET": st["offset"], "FREQUENCE": 1000.0 if name == "CH1" else 3000.0})
        return {"TIMEBASE": {"SCALE": self.state["timebase"], "HOFFSET": 0},
                "SAMPLE": {"FULLSCREEN": self.points, "DATALEN": self.points, "SAMPLERATE": "(1MS/s)"},
                "CHANNEL": chans,
                "TRIGGER": {"Mode": "EDGE", "Type": "SINGle", **self.state["trigger"]},
                "RUNSTATUS": "RUN" if self.state["running"] else "STOP"}

    def query_block(self, cmd: str, timeout: int = 3000) -> bytes:
        self.sent.append(cmd)
        u = cmd.upper()
        if u.endswith("HEAD?"):
            return json.dumps(self._head()).encode()
        ch = u.rsplit(":", 1)[1].rstrip("?")
        st = self.state[ch]
        tdiv = parse_si(self.state["timebase"], "s")
        vdiv = parse_si(st["scale"], "V")
        t = np.arange(self.points) * tdiv * 10 / self.points
        volts = _signal("sine" if ch == "CH1" else "square", t, 1000.0 if ch == "CH1" else 3000.0, 1.5 if ch == "CH1" else 0.4)
        codes = np.clip(np.round(volts / vdiv * 25) + st["offset"], -128, 127).astype("<i2")
        return codes.tobytes()


class DemoScpiDriver(scpi.ScpiDriver):
    def __init__(self):
        pipe = FakeScpiPipe()
        super().__init__(pipe, pipe.query("*IDN?"))
        self.info.update(simulated=True, protocol_name="SCPI (simulated)")

    def capture(self) -> Capture:
        time.sleep(0.05)
        return super().capture()
