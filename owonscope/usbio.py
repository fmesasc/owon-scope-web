"""Low-level USB access: device discovery, raw bulk links and USBTMC framing."""
from __future__ import annotations

import struct
import threading
import time
from dataclasses import dataclass

import usb.core
import usb.util

OWON_VID = 0x5345

USBTMC_CLASS = 0xFE
USBTMC_SUBCLASS = 0x03


class DeviceGone(IOError):
    pass


@dataclass(frozen=True)
class UsbLocation:
    """Physical location of a device (bus + port path); stable across USB resets."""
    bus: int
    ports: tuple[int, ...]

    @property
    def id(self) -> str:
        return f"usb-{self.bus}-" + ".".join(map(str, self.ports))

    def matches(self, dev) -> bool:
        return dev.bus == self.bus and tuple(dev.port_numbers or ()) == self.ports


@dataclass
class UsbCandidate:
    location: UsbLocation
    vid: int
    pid: int
    usbtmc: bool


def _find_bulk_interface(dev):
    """Return (interface, ep_in, ep_out, is_usbtmc) for the first interface with bulk IN+OUT."""
    cfg = dev.get_active_configuration() if _has_active_config(dev) else dev[0]
    best = None
    for intf in cfg:
        ep_in = usb.util.find_descriptor(intf, custom_match=lambda e: _is_bulk(e, usb.util.ENDPOINT_IN))
        ep_out = usb.util.find_descriptor(intf, custom_match=lambda e: _is_bulk(e, usb.util.ENDPOINT_OUT))
        if ep_in is None or ep_out is None:
            continue
        tmc = intf.bInterfaceClass == USBTMC_CLASS and intf.bInterfaceSubClass == USBTMC_SUBCLASS
        if tmc:
            return intf, ep_in, ep_out, True
        best = best or (intf, ep_in, ep_out, False)
    if best is None:
        raise IOError("No bulk IN/OUT interface found")
    return best


def _has_active_config(dev) -> bool:
    try:
        dev.get_active_configuration()
        return True
    except usb.core.USBError:
        return False


def _is_bulk(ep, direction) -> bool:
    return (usb.util.endpoint_type(ep.bmAttributes) == usb.util.ENDPOINT_TYPE_BULK
            and usb.util.endpoint_direction(ep.bEndpointAddress) == direction)


def scan(extra_ids: list[tuple[int, int]] | None = None) -> list[UsbCandidate]:
    """List OWON devices (any PID under the OWON vendor ID, plus user-supplied VID:PID pairs)."""
    wanted = set(extra_ids or [])
    found = []
    for dev in usb.core.find(find_all=True):
        if dev.idVendor != OWON_VID and (dev.idVendor, dev.idProduct) not in wanted:
            continue
        try:
            usbtmc = _find_bulk_interface(dev)[3]
        except (IOError, usb.core.USBError):
            continue
        loc = UsbLocation(dev.bus, tuple(dev.port_numbers or (dev.address,)))
        found.append(UsbCandidate(loc, dev.idVendor, dev.idProduct, usbtmc))
    return found


class BulkLink:
    """Raw bulk pipe to a device. Thread-safe; re-finds the device after resets."""

    def __init__(self, location: UsbLocation):
        self.location = location
        self.dev = None
        self.ep_in = self.ep_out = None
        self.intf = None
        self.usbtmc = False
        self.lock = threading.RLock()

    def _find(self):
        for dev in usb.core.find(find_all=True):
            if self.location.matches(dev):
                return dev
        return None

    def open(self, reset: bool = False):
        self.close()
        dev = self._find()
        if dev is None:
            raise DeviceGone(f"Device {self.location.id} not found")
        if reset:
            try:
                dev.reset()
            except usb.core.USBError:
                pass
            dev = None
            for _ in range(20):  # some devices re-enumerate after a reset
                dev = self._find()
                if dev is not None:
                    break
                time.sleep(0.1)
            if dev is None:
                raise DeviceGone(f"Device {self.location.id} did not come back after reset")
        intf, ep_in, ep_out, tmc = _find_bulk_interface(dev)
        try:
            if dev.is_kernel_driver_active(intf.bInterfaceNumber):
                dev.detach_kernel_driver(intf.bInterfaceNumber)
        except (NotImplementedError, usb.core.USBError):
            pass
        # Never send SET_CONFIGURATION to an already configured device: legacy OWON
        # firmware stops answering after it.
        if not _has_active_config(dev):
            dev.set_configuration()
        usb.util.claim_interface(dev, intf.bInterfaceNumber)
        self.dev, self.intf, self.ep_in, self.ep_out, self.usbtmc = dev, intf, ep_in, ep_out, tmc

    def close(self):
        if self.dev is not None:
            try:
                usb.util.dispose_resources(self.dev)
            except usb.core.USBError:
                pass
        self.dev = None

    @property
    def is_open(self) -> bool:
        return self.dev is not None

    def write(self, data: bytes, timeout: int = 1000):
        try:
            self.dev.write(self.ep_out.bEndpointAddress, data, timeout=timeout)
        except usb.core.USBError as e:
            self._check_gone(e)
            raise

    def read(self, size: int = 0x10000, timeout: int = 2000) -> bytes:
        try:
            return bytes(self.dev.read(self.ep_in.bEndpointAddress, size, timeout=timeout))
        except usb.core.USBTimeoutError:
            raise TimeoutError("USB read timed out")
        except usb.core.USBError as e:
            self._check_gone(e)
            raise

    def read_exact(self, n: int, timeout: int = 3000, deadline_s: float = 20.0) -> bytes:
        buf = bytearray()
        deadline = time.time() + deadline_s
        while len(buf) < n:
            if time.time() > deadline:
                raise TimeoutError(f"Incomplete transfer ({len(buf)}/{n} bytes)")
            buf += self.read(max(0x10000, n - len(buf)), timeout)
        return bytes(buf)

    def _check_gone(self, e):
        if getattr(e, "errno", None) in (19, 5):  # ENODEV / EIO
            self.close()
            raise DeviceGone(str(e)) from e


class ScpiPipe:
    """SCPI text/binary queries over a BulkLink, either raw bulk or USBTMC framed."""

    def __init__(self, link: BulkLink):
        self.link = link
        self._tag = 1

    # --- USBTMC framing -------------------------------------------------
    def _next_tag(self) -> int:
        self._tag = self._tag % 255 + 1
        return self._tag

    def _tmc_write(self, data: bytes):
        tag = self._next_tag()
        hdr = struct.pack("<BBBxIBxxx", 1, tag, 0xFF ^ tag, len(data), 1)
        pad = (-len(data)) % 4
        self.link.write(hdr + data + b"\0" * pad)

    def _tmc_read(self, timeout: int) -> bytes:
        out = bytearray()
        while True:
            tag = self._next_tag()
            self.link.write(struct.pack("<BBBxIBxxx", 2, tag, 0xFF ^ tag, 1 << 20, 0))
            chunk = self.link.read(0x10000, timeout)
            size, attrs = struct.unpack_from("<IB", chunk, 4)
            data = bytearray(chunk[12:])
            while len(data) < size:
                data += self.link.read(0x10000, timeout)
            out += data[:size]
            if attrs & 1:  # EOM
                return bytes(out)

    # --- public API -----------------------------------------------------
    def write(self, cmd: str):
        data = cmd.encode("ascii") + b"\n"
        if self.link.usbtmc:
            self._tmc_write(data)
        else:
            self.link.write(data)

    def _read_raw(self, timeout: int) -> bytes:
        if self.link.usbtmc:
            return self._tmc_read(timeout)
        out = bytearray(self.link.read(0x10000, timeout))
        # Text replies end with a newline; keep reading short packets until it arrives.
        while out and not out.endswith(b"\n"):
            try:
                out += self.link.read(0x10000, 300)
            except TimeoutError:
                break
        return bytes(out)

    def query(self, cmd: str, timeout: int = 2000) -> str:
        with self.link.lock:
            self.write(cmd)
            return self._read_raw(timeout).decode("ascii", "replace").strip()

    def query_block(self, cmd: str, timeout: int = 3000) -> bytes:
        """Query returning a binary block: OWON's 4-byte little-endian length prefix or IEEE '#n...'."""
        with self.link.lock:
            self.write(cmd)
            if self.link.usbtmc:
                data = self._tmc_read(timeout)
                return _strip_block_header(data)
            first = self.link.read(0x10000, timeout)
            if first[:1] == b"#":
                nd = int(first[1:2])
                n = int(first[2:2 + nd])
                start = 2 + nd
            else:
                n = struct.unpack_from("<I", first, 0)[0]
                start = 4
            body = first[start:]
            if len(body) < n:
                body += self.link.read_exact(n - len(body), timeout)
            return body[:n]


def _strip_block_header(data: bytes) -> bytes:
    if data[:1] == b"#":
        nd = int(data[1:2])
        n = int(data[2:2 + nd])
        return data[2 + nd:2 + nd + n]
    if len(data) >= 4:
        n = struct.unpack_from("<I", data, 0)[0]
        if n == len(data) - 4:
            return data[4:]
    return data
