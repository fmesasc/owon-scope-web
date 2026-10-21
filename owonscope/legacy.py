"""Driver for older OWON / Lilliput scopes (PDS, early SDS/MSO) using the "START" binary dump.

Protocol (reverse engineered, verified on a PDS5022S):
  host  -> EP OUT : b"START"      (b"STARTBMP" asks for a screen bitmap on models that support it)
  scope -> EP IN  : 12-byte header, little-endian uint32 payload length first
  scope -> EP IN  : payload

The firmware answers any number of requests in one session, but it stops answering if the host sends
SET_CONFIGURATION or CLEAR_HALT when opening it. The session is therefore opened without them, and a USB
reset (which re-enumerates the device) is only used to recover from a scope that stopped answering.

Waveform payload:
  "SPBxNN" magic (6 bytes) + int32 total length
  then channel blocks until the end:
    name[3]  (e.g. "CH1")
    int32    block length (counted from this field)
    int32 x7 sample_count, screen_samples, slow_move, timebase_index,
             vertical_offset (counts), volts_div_index, probe_index (0=x1, 1=x10, ...)
    float x4 us_per_sample, frequency_Hz, period_us, mV_per_count
    int16 x sample_count
  One vertical division is 25 counts.
"""
from __future__ import annotations

import struct
import time

import numpy as np
import usb.core

from .model import Capture, Driver, Waveform
from .usbio import BulkLink, DeviceGone

COUNTS_PER_DIV = 25

TIMEBASES = ["5ns", "10ns", "25ns", "50ns", "100ns", "250ns", "500ns",
             "1us", "2.5us", "5us", "10us", "25us", "50us", "100us", "250us", "500us",
             "1ms", "2.5ms", "5ms", "10ms", "25ms", "50ms", "100ms", "250ms", "500ms",
             "1s", "2.5s", "5s", "10s", "25s", "50s", "100s"]
VOLTS_DIV = ["2mV", "5mV", "10mV", "20mV", "50mV", "100mV", "200mV", "500mV",
             "1V", "2V", "5V", "10V", "20V", "50V", "100V"]

CH_HEADER = struct.Struct("<3si7i4f")


def parse_dump(buf: bytes) -> Capture:
    if buf[:3] != b"SPB":
        raise ValueError(f"Unknown legacy dump format (magic {buf[:6]!r})")
    magic = buf[:6].decode("ascii", "replace")
    waveforms = []
    o = 10
    time_per_div = None
    while o + CH_HEADER.size <= len(buf):
        (name, blen, n, screen_n, slow, tb, offset, vd, probe_idx,
         us_per_sample, freq, period, mv_per_count) = CH_HEADER.unpack_from(buf, o)
        name = name.decode("ascii", "replace")
        if blen <= 0 or n < 0 or o + CH_HEADER.size + 2 * n > len(buf):
            raise ValueError(f"Corrupt channel block {name!r} at offset {o}")
        raw = np.frombuffer(buf, dtype="<i2", count=n, offset=o + CH_HEADER.size).astype(float)
        probe = 10.0 ** probe_idx
        v_per_count = mv_per_count * 1e-3 * probe
        waveforms.append(Waveform(
            name=name,
            volts=(raw - offset) * v_per_count,
            dt=us_per_sample * 1e-6,
            volts_per_div=v_per_count * COUNTS_PER_DIV,
            position_div=offset / COUNTS_PER_DIV,
            probe=probe,
            frequency=freq if freq > 0 else None,
            extra={
                "timebase": TIMEBASES[tb] if 0 <= tb < len(TIMEBASES) else f"#{tb}",
                "volts_div_setting": VOLTS_DIV[vd] if 0 <= vd < len(VOLTS_DIV) else f"#{vd}",
                "period_us": period or None,
                "screen_samples": screen_n,
                "slow_move": slow,
                # Live channels are CH1..CH4; other blocks (e.g. "CHA") are waveforms stored in the
                # scope's memory, sent with every dump but never changing (verified on a PDS5022S).
                "reference": not (name.startswith("CH") and name[2:].isdigit()),
            },
        ))
        if time_per_div is None and n:
            time_per_div = n * us_per_sample * 1e-6 / 10
        o += 3 + blen  # block length includes its own 4-byte field
    if not waveforms:
        raise ValueError("Dump contains no channel data")
    return Capture(waveforms, time_per_div=time_per_div, settings={"format": magic})


class LegacyDriver(Driver):
    protocol = "owon-legacy"

    def __init__(self, link: BulkLink):
        super().__init__()
        self.link = link
        self._bmp_supported: bool | None = None
        self.info = {"vendor": "OWON", "model": "Legacy OWON (PDS/SDS series)",
                     "protocol": self.protocol, "protocol_name": "Legacy binary dump (START)"}

    def request(self, cmd: bytes, timeout: int = 3000, recover: bool = True) -> bytes:
        with self.link.lock:
            try:
                return self._request(cmd, timeout)
            except TimeoutError:
                if not recover:
                    raise
                self.link.open(reset=True)  # last resort: the scope stopped answering
                return self._request(cmd, timeout)
            except (DeviceGone, usb.core.USBError):
                if not recover:
                    raise
                # The scope dropped off the bus (bad cable/port, glitch): wait for it to come back.
                self.link.close()
                self._wait_for_device(8.0)
                return self._request(cmd, timeout)

    def _wait_for_device(self, seconds: float):
        deadline = time.time() + seconds
        while time.time() < deadline:
            time.sleep(0.3)
            try:
                self.link.open()
                return
            except (DeviceGone, usb.core.USBError, IOError):
                continue
        raise DeviceGone("The scope disconnected and did not come back")

    def _request(self, cmd: bytes, timeout: int) -> bytes:
        if not self.link.is_open:
            self.link.open()
        self.link.write(cmd)
        hdr = self.link.read(0x10000, timeout)
        if len(hdr) < 4:
            raise IOError(f"Short header from scope: {hdr!r}")
        n = struct.unpack_from("<I", hdr, 0)[0]
        if not 0 < n < 64 << 20:
            raise IOError(f"Implausible payload length {n}")
        return self.link.read_exact(n, timeout)

    def close(self):
        self.link.close()

    def capabilities(self) -> dict:
        return {
            "control": False,
            "screenshot": bool(self._bmp_supported),
            "controls": {},
            "note": "This model only sends data over USB. Change volts/div, timebase and trigger "
                    "on the oscilloscope itself; the viewer follows automatically.",
        }

    def capture(self) -> Capture:
        buf = self.request(b"START")
        self.last_raw = buf
        cap = parse_dump(buf)
        names = [w.name for w in cap.waveforms]
        self.info["channels"] = names
        return cap

    def screenshot(self) -> tuple[bytes, str]:
        try:
            data = self.request(b"STARTBMP", timeout=5000)
        except Exception:
            self._bmp_supported = False
            raise
        if data[:2] != b"BM":
            self._bmp_supported = False
            raise IOError("Device did not return a bitmap")
        self._bmp_supported = True
        return data, "image/bmp"


def probe(link: BulkLink) -> LegacyDriver | None:
    """Return a driver if the device answers START with an SPB dump."""
    drv = LegacyDriver(link)
    try:
        buf = drv.request(b"START", timeout=1500)  # recovers a scope left stuck by another program
    except Exception:
        return None
    if buf[:3] != b"SPB":
        return None
    drv.last_raw = buf
    try:
        cap = parse_dump(buf)
        drv.info["channels"] = [w.name for w in cap.waveforms]
    except ValueError:
        pass
    drv.info["format"] = buf[:6].decode("ascii", "replace")
    try:  # PDS firmware ignores the BMP suffix and sends a waveform instead
        drv.screenshot()
    except Exception:
        pass
    return drv
