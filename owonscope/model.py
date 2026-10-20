"""Data types shared by all drivers."""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np


@dataclass
class Waveform:
    name: str
    volts: np.ndarray          # sample values in volts (probe factor applied)
    dt: float                  # seconds between samples
    volts_per_div: float       # vertical scale as shown on the scope (probe applied)
    position_div: float = 0.0  # trace position on screen, in divisions from centre
    probe: float = 1.0
    coupling: str | None = None
    frequency: float | None = None  # as measured by the instrument, if reported
    t0: float = 0.0
    extra: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        v = self.volts
        return {
            "name": self.name,
            "dt": self.dt,
            "t0": self.t0,
            "volts": [round(float(x), 6) for x in v],
            "volts_per_div": self.volts_per_div,
            "position_div": self.position_div,
            "probe": self.probe,
            "coupling": self.coupling,
            "frequency": self.frequency,
            "extra": self.extra,
        }


@dataclass
class Capture:
    waveforms: list[Waveform]
    time_per_div: float | None = None
    h_divisions: int = 10
    v_divisions: int = 8
    settings: dict = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    def to_json(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "time_per_div": self.time_per_div,
            "h_divisions": self.h_divisions,
            "v_divisions": self.v_divisions,
            "settings": self.settings,
            "waveforms": [w.to_json() for w in self.waveforms],
        }


class Driver:
    """Base class for an oscilloscope driver."""

    protocol = "unknown"

    def __init__(self):
        self.last_raw: bytes | None = None
        self.info: dict = {}

    def capabilities(self) -> dict:
        """What the UI may offer for this device.

        keys: control (bool), screenshot (bool), controls (dict of option lists),
        note (str shown to the user)."""
        return {"control": False, "screenshot": False, "controls": {}, "note": ""}

    def capture(self) -> Capture:
        raise NotImplementedError

    def screenshot(self) -> tuple[bytes, str]:
        raise NotImplementedError("Screenshots are not supported by this device")

    def get_settings(self) -> dict:
        return {}

    def apply(self, action: str, params: dict) -> dict:
        raise NotImplementedError("This device cannot be controlled over USB")

    def close(self):
        pass


# --- unit helpers ---------------------------------------------------------

_SI = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "µ": 1e-6, "m": 1e-3, "": 1.0, "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9}


def parse_si(text: str, unit: str) -> float:
    """'500mV' -> 0.5, '2.5us' -> 2.5e-6, '1ks' -> 1000. Case-insensitive for the unit."""
    s = text.strip().replace(" ", "")
    if s.lower().endswith(unit.lower()):
        s = s[: -len(unit)]
    prefix = ""
    if s and not (s[-1].isdigit() or s[-1] == "."):
        prefix = s[-1]
        s = s[:-1]
    if prefix == "M" and unit.lower() == "s":  # "Ms" is never mega-seconds here
        prefix = "m"
    if prefix not in _SI:
        prefix = prefix.lower()
    return float(s) * _SI[prefix]


def format_si(value: float, unit: str) -> str:
    for p, f in (("G", 1e9), ("M", 1e6), ("k", 1e3), ("", 1), ("m", 1e-3), ("u", 1e-6), ("n", 1e-9), ("p", 1e-12)):
        if abs(value) >= f * 0.999:
            return f"{value / f:g}{p}{unit}"
    return f"{value:g}{unit}"
