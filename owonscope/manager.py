"""Finds connected scopes and works out which protocol each one speaks."""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

import usb.core

from . import legacy, scpi
from .model import Driver
from .usbio import BulkLink, UsbCandidate, scan

log = logging.getLogger(__name__)

PERMISSION_HINT = ("No permission to open the USB device. Install the udev rule "
                   "(see README: 'sudo cp udev/99-owon.rules /etc/udev/rules.d/') and replug the scope.")


@dataclass
class Device:
    id: str
    status: str                      # ready | unsupported | no-permission | error
    driver: Driver | None = None
    usb: dict = field(default_factory=dict)
    error: str = ""

    def to_json(self) -> dict:
        info = dict(self.driver.info) if self.driver else {}
        return {
            "id": self.id,
            "status": self.status,
            "error": self.error,
            "usb": self.usb,
            "info": info,
            "capabilities": self.driver.capabilities() if self.driver else None,
        }


def detect(cand: UsbCandidate) -> Device:
    """Probe one USB device. Order: SCPI first (harmless on legacy units, they just
    don't answer), then the legacy START dump."""
    usb_info = {"vid": f"{cand.vid:04x}", "pid": f"{cand.pid:04x}", "location": cand.location.id,
                "usbtmc": cand.usbtmc}
    dev_id = cand.location.id
    link = BulkLink(cand.location)
    try:
        drv = scpi.probe(link)
        if drv is None and not cand.usbtmc:
            drv = legacy.probe(link)
    except usb.core.USBError as e:
        if getattr(e, "errno", None) == 13:
            return Device(dev_id, "no-permission", usb=usb_info, error=PERMISSION_HINT)
        return Device(dev_id, "error", usb=usb_info, error=str(e))
    except Exception as e:  # noqa: BLE001 - report anything to the UI
        if "Access denied" in str(e) or "Errno 13" in str(e):
            return Device(dev_id, "no-permission", usb=usb_info, error=PERMISSION_HINT)
        return Device(dev_id, "error", usb=usb_info, error=str(e))
    if drv is None:
        return Device(dev_id, "unsupported", usb=usb_info,
                      error="The device did not answer any known OWON protocol. "
                            "(PC-only scopes like the VDS1022 are not supported yet.)")
    return Device(dev_id, "ready", driver=drv, usb=usb_info)


class Manager:
    def __init__(self, demo: bool = False, extra_ids=None):
        self.demo = demo
        self.extra_ids = extra_ids or []
        self.devices: dict[str, Device] = {}
        self.missing: dict[str, int] = {}
        self.lock = threading.Lock()

    def rescan(self) -> list[Device]:
        with self.lock:
            seen = set()
            try:
                candidates = scan(self.extra_ids)
            except usb.core.NoBackendError:
                candidates = []
                log.error("libusb not found - install libusb-1.0")
            for cand in candidates:
                seen.add(cand.location.id)
                old = self.devices.get(cand.location.id)
                if old and old.status == "ready":
                    continue
                log.info("Probing %s (%04x:%04x)", cand.location.id, cand.vid, cand.pid)
                dev = detect(cand)
                log.info("  -> %s %s", dev.status, dev.driver.info.get("model") if dev.driver else dev.error)
                self.devices[dev.id] = dev
            for dev_id in list(self.devices):
                if dev_id.startswith("demo-") or dev_id in seen:
                    self.missing.pop(dev_id, None)
                    continue
                # A legacy capture resets the port, so tolerate one scan where it's absent.
                self.missing[dev_id] = self.missing.get(dev_id, 0) + 1
                if self.missing[dev_id] >= 2:
                    gone = self.devices.pop(dev_id)
                    self.missing.pop(dev_id)
                    if gone.driver:
                        gone.driver.close()
            if self.demo:
                from .demo import DemoLegacyDriver, DemoScpiDriver
                for dev_id, cls in (("demo-legacy", DemoLegacyDriver), ("demo-scpi", DemoScpiDriver)):
                    if dev_id not in self.devices:
                        self.devices[dev_id] = Device(dev_id, "ready", driver=cls(), usb={"location": "simulated"})
            return list(self.devices.values())

    def get(self, dev_id: str) -> Device:
        dev = self.devices.get(dev_id)
        if dev is None or dev.driver is None:
            raise KeyError(dev_id)
        return dev

    def forget(self, dev_id: str):
        """Drop a device after it disappeared so the next scan re-detects it."""
        with self.lock:
            self.devices.pop(dev_id, None)
