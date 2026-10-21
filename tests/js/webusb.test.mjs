// WebUSB driver logic against a fake device that behaves like a real PDS5022S.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dump = new Uint8Array(readFileSync(new URL("../data/pds5022s_spbv01.bin", import.meta.url)));

class FakePds {
  constructor() {
    this.vendorId = 0x5345; this.productId = 0x1234; this.serialNumber = undefined;
    this.opened = false; this.stuck = false; this.queue = []; this.waiters = [];
    const alt = { interfaceClass: 5, interfaceSubclass: 0, endpoints: [
      { endpointNumber: 1, direction: "in", type: "bulk" }, { endpointNumber: 3, direction: "out", type: "bulk" }] };
    this.configuration = { interfaces: [{ interfaceNumber: 0, claimed: false, alternate: alt, alternates: [alt] }] };
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration() { this.stuck = true; }   // real firmware stops answering after SET_CONFIGURATION
  async reset() { throw new Error("reset must not be used"); }
  async claimInterface(n) { this.configuration.interfaces[n].claimed = true; }
  async clearHalt() { this.stuck = true; }
  push(bytes) {
    const w = this.waiters.shift();
    if (w) w(bytes); else this.queue.push(bytes);
  }
  async transferOut(ep, data) {
    const cmd = new TextDecoder().decode(data);
    if (!this.stuck && cmd.startsWith("START")) {
      const hdr = new Uint8Array(12);
      new DataView(hdr.buffer).setUint32(0, dump.length, true);
      this.push(hdr);
      for (let i = 0; i < dump.length; i += 4096) this.push(dump.subarray(i, i + 4096));
    }
    return { status: "ok", bytesWritten: data.length };
  }
  transferIn() {
    return new Promise((resolve) => {
      const deliver = (b) => resolve({ status: "ok", data: new DataView(b.buffer, b.byteOffset, b.byteLength) });
      if (this.queue.length) deliver(this.queue.shift()); else this.waiters.push(deliver);
    });
  }
}

globalThis.navigator ??= {};
const { detectWebUsb } = await import("../../owonscope/web/drivers.js");

test("detects a PDS over WebUSB and captures repeatedly without resets", async () => {
  const dev = new FakePds();
  const drv = await detectWebUsb(dev);
  assert.equal(drv.info.protocol, "owon-legacy");
  assert.equal(drv.capabilities.screenshot, false);
  for (let i = 0; i < 5; i++) {
    const cap = await drv.capture();
    assert.deepEqual(cap.waveforms.map((w) => w.name), ["CH1", "CH2", "CHA"]);
  }
  assert.equal(dev.stuck, false);
});

test("reports a stuck scope instead of hanging", async () => {
  const dev = new FakePds();
  const drv = await detectWebUsb(dev);
  dev.stuck = true;
  await assert.rejects(drv.capture(), /stopped answering/);
});

test("a dropped USB connection is reported as 'gone' so the app can reconnect", async () => {
  const dev = new FakePds();
  const drv = await detectWebUsb(dev);
  dev.transferOut = async () => { throw Object.assign(new Error("A transfer error has occurred."), { name: "NetworkError" }); };
  await assert.rejects(drv.capture(), (e) => e.gone === true && /connection to the scope was lost/.test(e.message));
});
