"""Driver for current OWON scopes that speak SCPI over USB (SDS, XDS, TAO, HDS, DOS...).

Based on OWON's published SCPI programming manuals. Commands used:
  *IDN?                              identification
  :DATA:WAVE:SCREen:HEAD?            JSON description of the screen (4-byte length prefix)
  :DATA:WAVE:SCREen:CH<n>?           screen samples for one channel (4-byte length prefix)
  :CHANnel<n>:DISPlay|SCALe|COUPling|PROBe|OFFSet
  :HORizontal:SCALe|OFFSet
  :TRIGger:SINGle:EDGe:SOURce|SLOPe|LEVel, :TRIGger:SINGle:SWEep
  :RUNning RUN|STOP, :AUTOset ON

Waveform scaling: OWON returns ADC codes where one vertical division is 25 codes
(8-bit models), or 25*256 codes when the data is 16-bit.
"""
from __future__ import annotations

import json
import re

import numpy as np

from .model import Capture, Driver, Waveform, format_si, parse_si
from .usbio import BulkLink, ScpiPipe

VOLTS_DIV = ["1mV", "2mV", "5mV", "10mV", "20mV", "50mV", "100mV", "200mV", "500mV",
             "1V", "2V", "5V", "10V", "20V", "50V", "100V"]
TIMEBASES = ["1ns", "2ns", "5ns", "10ns", "20ns", "50ns", "100ns", "200ns", "500ns",
             "1us", "2us", "5us", "10us", "20us", "50us", "100us", "200us", "500us",
             "1ms", "2ms", "5ms", "10ms", "20ms", "50ms", "100ms", "200ms", "500ms",
             "1s", "2s", "5s", "10s", "20s", "50s", "100s"]
COUPLING = ["DC", "AC", "GND"]
PROBES = ["1X", "10X", "100X", "1000X"]
SLOPES = ["RISE", "FALL"]
SWEEPS = ["AUTO", "NORMal", "SINGle"]


def _ci_get(d: dict, *keys, default=None):
    """Case-insensitive dict lookup trying several key spellings."""
    low = {k.lower(): v for k, v in d.items()} if isinstance(d, dict) else {}
    for k in keys:
        if k.lower() in low:
            return low[k.lower()]
    return default


def _probe_factor(text) -> float:
    m = re.match(r"\s*([\d.]+)", str(text or "1"))
    return float(m.group(1)) if m else 1.0


def _sample_rate(text) -> float | None:
    """'(500MS/s)' -> 5e8."""
    m = re.search(r"([\d.]+)\s*([kKMG]?)S/s", str(text or ""))
    if not m:
        return None
    return float(m.group(1)) * {"": 1, "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9}[m.group(2)]


def decode_samples(data: bytes, n_expected: int | None) -> tuple[np.ndarray, float]:
    """Return (codes, codes_per_div) guessing 8- or 16-bit encoding from the length."""
    if n_expected and len(data) >= 2 * n_expected:
        codes = np.frombuffer(data[: 2 * n_expected], dtype="<i2").astype(float)
    elif n_expected and len(data) >= n_expected:
        return np.frombuffer(data[:n_expected], dtype="i1").astype(float), 25.0
    else:
        codes = np.frombuffer(data[: len(data) // 2 * 2], dtype="<i2").astype(float)
    per_div = 25.0 * 256 if np.abs(codes).max(initial=0) > 255 else 25.0
    return codes, per_div


class ScpiDriver(Driver):
    protocol = "owon-scpi"

    def __init__(self, pipe: ScpiPipe, idn: str):
        super().__init__()
        self.pipe = pipe
        parts = [p.strip() for p in idn.split(",")] + ["", "", "", ""]
        self.info = {
            "vendor": parts[0] or "OWON",
            "model": parts[1] or "SCPI oscilloscope",
            "serial": parts[2],
            "firmware": parts[3],
            "idn": idn,
            "protocol": self.protocol,
            "protocol_name": "SCPI over USBTMC" if pipe.link.usbtmc else "SCPI over USB bulk",
        }
        self.head: dict = {}
        self.n_channels = self._guess_channels(parts[1])

    @staticmethod
    def _guess_channels(model: str) -> int:
        # OWON model numbers usually end in the channel count digit: SDS1102 -> 2, XDS3104 -> 4
        m = re.search(r"(\d{3,4})", model or "")
        if m and m.group(1)[-1] in "24":
            return int(m.group(1)[-1])
        return 2

    # --- helpers -----------------------------------------------------------
    def query(self, cmd: str) -> str:
        return self.pipe.query(cmd)

    def send(self, cmd: str):
        with self.pipe.link.lock:
            self.pipe.write(cmd)

    def read_head(self) -> dict:
        raw = self.pipe.query_block(":DATA:WAVE:SCREen:HEAD?")
        text = raw.decode("utf-8", "replace").strip("\0 \r\n")
        self.head = json.loads(text[text.find("{"):])
        return self.head

    # --- Driver API --------------------------------------------------------
    def capabilities(self) -> dict:
        chans = [f"CH{i}" for i in range(1, self.n_channels + 1)]
        return {
            "control": True,
            "screenshot": False,
            "controls": {
                "channels": chans,
                "volts_div": VOLTS_DIV,
                "coupling": COUPLING,
                "probe": PROBES,
                "timebase": TIMEBASES,
                "trigger_source": chans,
                "trigger_slope": SLOPES,
                "trigger_sweep": SWEEPS,
            },
            "note": "Experimental driver for SCPI-capable OWON scopes. If something looks wrong, "
                    "use 'Download diagnostics' and open an issue.",
        }

    def capture(self) -> Capture:
        head = self.read_head()
        timebase = _ci_get(head, "TIMEBASE", default={})
        sample = _ci_get(head, "SAMPLE", default={})
        n_points = int(_ci_get(sample, "DATALEN", "FULLSCREEN", default=0) or 0)
        tdiv = None
        try:
            tdiv = parse_si(str(_ci_get(timebase, "SCALE", default="")), "s")
        except (ValueError, KeyError):
            pass
        srate = _sample_rate(_ci_get(sample, "SAMPLERATE"))

        waveforms = []
        raw_blocks = {"head": head}
        for ch in _ci_get(head, "CHANNEL", default=[]) or []:
            name = str(_ci_get(ch, "NAME", default="")).upper()
            if str(_ci_get(ch, "DISPLAY", default="ON")).upper() != "ON" or not name.startswith("CH"):
                continue
            data = self.pipe.query_block(f":DATA:WAVE:SCREen:{name}?")
            raw_blocks[name] = data.hex()
            codes, per_div = decode_samples(data, n_points or None)
            probe = _probe_factor(_ci_get(ch, "PROBE"))
            try:
                vdiv = parse_si(str(_ci_get(ch, "SCALE")), "V")
            except (ValueError, TypeError):
                vdiv = 1.0
            offset_codes = float(_ci_get(ch, "OFFSET", default=0) or 0)
            if tdiv:  # the screen record spans 10 horizontal divisions
                dt = tdiv * 10 / max(len(codes), 1)
            elif srate:
                dt = 1 / srate
            else:
                dt = 1e-6
            freq = _ci_get(ch, "FREQUENCE", "FREQUENCY")
            waveforms.append(Waveform(
                name=name,
                volts=(codes - offset_codes) / per_div * vdiv,
                dt=dt,
                volts_per_div=vdiv,
                position_div=offset_codes / per_div,
                probe=probe,
                coupling=_ci_get(ch, "COUPLING"),
                frequency=float(freq) if freq not in (None, "", "?") else None,
            ))
        self.last_raw = json.dumps(raw_blocks, indent=1).encode()
        return Capture(waveforms, time_per_div=tdiv, settings=self._settings_from_head(head))

    def _settings_from_head(self, head: dict) -> dict:
        s = {"channels": {}}
        for ch in _ci_get(head, "CHANNEL", default=[]) or []:
            name = str(_ci_get(ch, "NAME", default="")).upper()
            s["channels"][name] = {
                "display": str(_ci_get(ch, "DISPLAY", default="")).upper() == "ON",
                "volts_div": _ci_get(ch, "SCALE"),
                "coupling": _ci_get(ch, "COUPLING"),
                "probe": _ci_get(ch, "PROBE"),
            }
        tb = _ci_get(head, "TIMEBASE", default={})
        s["timebase"] = _ci_get(tb, "SCALE")
        trig = _ci_get(head, "TRIGGER", default={})
        if isinstance(trig, dict):
            s["trigger"] = {k.lower(): v for k, v in trig.items() if not isinstance(v, (dict, list))}
        s["running"] = _ci_get(head, "RUNSTATUS")
        return s

    def get_settings(self) -> dict:
        return self._settings_from_head(self.read_head())

    def apply(self, action: str, params: dict) -> dict:
        ch = params.get("channel", "CH1").upper()
        n = ch[2:] if ch.startswith("CH") else "1"
        value = str(params.get("value", ""))
        commands = {
            "run": lambda: ":RUNning RUN",
            "stop": lambda: ":RUNning STOP",
            "autoset": lambda: ":AUTOset ON",
            "single": lambda: ":TRIGger:SINGle:SWEep SINGle",
            "channel_display": lambda: f":CHANnel{n}:DISPlay {'ON' if params.get('value') else 'OFF'}",
            "volts_div": lambda: f":CHANnel{n}:SCALe {_check(value, VOLTS_DIV).lower()}",
            "coupling": lambda: f":CHANnel{n}:COUPling {_check(value, COUPLING)}",
            "probe": lambda: f":CHANnel{n}:PROBe {_check(value, PROBES)}",
            "position": lambda: f":CHANnel{n}:OFFSet {float(value):g}",
            "timebase": lambda: f":HORizontal:SCALe {_check(value, TIMEBASES).lower()}",
            "h_position": lambda: f":HORizontal:OFFSet {float(value):g}",
            "trigger_source": lambda: f":TRIGger:SINGle:EDGe:SOURce {_check(value, [f'CH{i}' for i in range(1, 5)])}",
            "trigger_slope": lambda: f":TRIGger:SINGle:EDGe:SLOPe {_check(value, SLOPES)}",
            "trigger_level": lambda: f":TRIGger:SINGle:EDGe:LEVel {format_si(float(value), 'v').lower()}",
            "trigger_sweep": lambda: f":TRIGger:SINGle:SWEep {_check(value, SWEEPS)}",
        }
        if action not in commands:
            raise ValueError(f"Unknown action {action!r}")
        cmd = commands[action]()
        self.send(cmd)
        return {"sent": cmd}

    def close(self):
        if hasattr(self.pipe.link, "close"):
            self.pipe.link.close()


def _check(value: str, allowed: list[str]) -> str:
    for a in allowed:
        if a.lower() == value.lower():
            return a
    raise ValueError(f"{value!r} is not one of {allowed}")


def probe(link: BulkLink) -> ScpiDriver | None:
    """Return a driver if the device answers *IDN? like an instrument."""
    try:
        link.open(reset=False)
    except Exception:
        return None
    pipe = ScpiPipe(link)
    try:
        idn = pipe.query("*IDN?", timeout=800)
    except Exception:
        link.close()
        return None
    if "," not in idn or not idn.isprintable():
        link.close()
        return None
    return ScpiDriver(pipe, idn)
