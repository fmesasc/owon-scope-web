// Device drivers for the browser.
// Every driver exposes: id, kind, info, capabilities, capture(), apply(action, params),
// screenshot() -> Blob, rawBlob() -> Blob|null, close().
import {
  LEGACY_CAPABILITIES, guessChannels, parseIdn, parseLegacyDump, parseSI, scpiCapabilities,
  scpiCapture, scpiCommand,
} from "./protocols.js";

export const OWON_VID = 0x5345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TimeoutError extends Error {}

// ------------------------------------------------------------ local server ---

export async function serverAvailable() {
  try {
    const r = await fetch("api/devices", { cache: "no-store" });
    return r.ok && (r.headers.get("content-type") || "").includes("json");
  } catch {
    return false;
  }
}

export async function listServerDevices() {
  const r = await fetch("api/devices", { cache: "no-store" });
  const data = await r.json();
  return data.devices.map((d) => (d.status === "ready" ? new ServerDriver(d) : { ...d, kind: "server", unusable: true }));
}

async function apiCall(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    const err = new Error(msg);
    err.gone = r.status === 410;
    throw err;
  }
  return r;
}

class ServerDriver {
  constructor(d) {
    this.kind = "server";
    this.id = `server:${d.id}`;
    this.serverId = d.id;
    this.info = d.info;
    this.capabilities = d.capabilities;
    this.usb = d.usb;
  }
  async capture() {
    const r = await apiCall(`api/devices/${this.serverId}/capture`, { cache: "no-store" });
    const cap = await r.json();
    for (const w of cap.waveforms) w.volts = Float32Array.from(w.volts);
    return cap;
  }
  async apply(action, params = {}) {
    const r = await apiCall(`api/devices/${this.serverId}/control`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...params, action }),
    });
    return r.json();
  }
  async screenshot() {
    return (await apiCall(`api/devices/${this.serverId}/screenshot`)).blob();
  }
  async rawBlob() {
    try { return await (await apiCall(`api/devices/${this.serverId}/raw`)).blob(); } catch { return null; }
  }
  async close() {}
}

// ------------------------------------------------------------------ WebUSB ---

class UsbTransport {
  constructor(device) {
    this.device = device;
    this.pending = null;
    this.tag = 1;
  }

  async open() {
    const d = this.device;
    if (!d.opened) await d.open();
    // Only configure an unconfigured device: legacy OWON firmware stops answering after SET_CONFIGURATION.
    if (!d.configuration) await d.selectConfiguration(1);
    let found = null;
    for (const intf of d.configuration.interfaces) {
      const alt = intf.alternate || intf.alternates[0];
      const bulkIn = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "in");
      const bulkOut = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "out");
      if (!bulkIn || !bulkOut) continue;
      const tmc = alt.interfaceClass === 0xfe && alt.interfaceSubclass === 0x03;
      if (!found || tmc) found = { intf, bulkIn, bulkOut, tmc };
      if (tmc) break;
    }
    if (!found) throw new Error("The device has no bulk USB interface");
    this.ifaceNumber = found.intf.interfaceNumber;
    this.epIn = found.bulkIn.endpointNumber;
    this.epOut = found.bulkOut.endpointNumber;
    this.usbtmc = found.tmc;
    if (!found.intf.claimed) {
      try {
        await d.claimInterface(this.ifaceNumber);
      } catch (e) {
        throw new Error("Could not claim the USB interface. Close other programs using the scope " +
          "(including the owon-scope-web server). On Linux, install the udev rule from the README " +
          `and replug the scope. (${e.message})`);
      }
    }
  }

  async write(bytes) {
    const r = await this.device.transferOut(this.epOut, bytes);
    if (r.status !== "ok") throw new Error(`USB write failed (${r.status})`);
  }

  // A transfer that timed out is kept and reused by the next read, so no data is lost
  // and no reset is needed (WebUSB has no transfer timeouts of its own).
  async read(timeoutMs = 2000) {
    const p = this.pending || this.device.transferIn(this.epIn, 0x10000);
    this.pending = p;
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new TimeoutError("USB read timed out")), timeoutMs); });
    try {
      const r = await Promise.race([p, timeout]);
      this.pending = null;
      if (r.status === "stall") {
        await this.device.clearHalt("in", this.epIn);
        throw new Error("USB endpoint stalled");
      }
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    } finally {
      clearTimeout(timer);
    }
  }

  async readExact(n, timeoutMs = 3000) {
    const out = new Uint8Array(n);
    let got = 0;
    const deadline = Date.now() + 20000;
    while (got < n) {
      if (Date.now() > deadline) throw new TimeoutError(`Incomplete transfer (${got}/${n} bytes)`);
      const chunk = await this.read(timeoutMs);
      out.set(chunk.subarray(0, n - got), got);
      got += Math.min(chunk.length, n - got);
    }
    return out;
  }

  // ---- SCPI (raw bulk or USBTMC) ----
  nextTag() { this.tag = (this.tag % 255) + 1; return this.tag; }

  tmcHeader(msgId, size, attrs) {
    const tag = this.nextTag();
    const h = new Uint8Array(12);
    const dv = new DataView(h.buffer);
    h[0] = msgId; h[1] = tag; h[2] = 0xff ^ tag;
    dv.setUint32(4, size, true);
    h[8] = attrs;
    return h;
  }

  async scpiWrite(cmd) {
    const data = new TextEncoder().encode(cmd + "\n");
    if (!this.usbtmc) return this.write(data);
    const pad = (4 - (data.length % 4)) % 4;
    const msg = new Uint8Array(12 + data.length + pad);
    msg.set(this.tmcHeader(1, data.length, 1));
    msg.set(data, 12);
    return this.write(msg);
  }

  async scpiReadAll(timeoutMs) {
    if (this.usbtmc) {
      const parts = [];
      for (;;) {
        await this.write(this.tmcHeader(2, 1 << 20, 0));
        let chunk = await this.read(timeoutMs);
        const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const size = dv.getUint32(4, true);
        const eom = chunk[8] & 1;
        let body = chunk.subarray(12);
        while (body.length < size) body = concat(body, await this.read(timeoutMs));
        parts.push(body.subarray(0, size));
        if (eom) return concat(...parts);
      }
    }
    let out = await this.read(timeoutMs);
    while (out.length && out[out.length - 1] !== 0x0a) {
      try { out = concat(out, await this.read(300)); } catch (e) { if (e instanceof TimeoutError) break; throw e; }
    }
    return out;
  }

  async query(cmd, timeoutMs = 2000) {
    await this.scpiWrite(cmd);
    return new TextDecoder().decode(await this.scpiReadAll(timeoutMs)).trim();
  }

  async queryBlock(cmd, timeoutMs = 3000) {
    await this.scpiWrite(cmd);
    let data;
    if (this.usbtmc) {
      data = await this.scpiReadAll(timeoutMs);
    } else {
      data = await this.read(timeoutMs);
      const { n, start } = blockHeader(data);
      if (data.length - start < n) data = concat(data, await this.readExact(n - (data.length - start), timeoutMs));
    }
    const { n, start } = blockHeader(data);
    return data.subarray(start, start + n);
  }
}

function blockHeader(data) {
  if (data[0] === 0x23) { // '#'
    const nd = data[1] - 0x30;
    const n = parseInt(new TextDecoder().decode(data.subarray(2, 2 + nd)), 10);
    return { n, start: 2 + nd };
  }
  const n = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  if (n <= data.length * 1000) return { n, start: 4 };
  return { n: data.length, start: 0 };
}

function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

// One request at a time per device.
class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const r = this.p.then(fn, fn);
    this.p = r.catch(() => {});
    return r;
  }
}

class WebUsbLegacyDriver {
  constructor(transport, firstDump) {
    this.kind = "webusb";
    this.t = transport;
    this.mutex = new Mutex();
    const d = transport.device;
    this.id = `webusb:${d.serialNumber || ""}:${d.productId}`;
    this.info = { vendor: "OWON", model: "Legacy OWON (PDS/SDS series)", protocol: "owon-legacy",
                  protocol_name: "Legacy binary dump (START) via WebUSB",
                  format: String.fromCharCode(...firstDump.subarray(0, 6)) };
    this.capabilities = { ...LEGACY_CAPABILITIES };
    this.last = firstDump;
  }
  // The firmware answers repeated requests in one session. Never reset the port here:
  // with WebUSB a reset re-enumerates the scope and, as it has no serial number,
  // the browser forgets the permission to use it.
  request(cmd, timeoutMs = 3000) {
    return this.mutex.run(async () => {
      await this.t.write(new TextEncoder().encode(cmd));
      let hdr;
      try {
        hdr = await this.t.read(timeoutMs);
      } catch (e) {
        if (e instanceof TimeoutError) {
          throw new Error("The scope stopped answering. Unplug it and plug it back in, then click Connect USB.");
        }
        throw e;
      }
      if (hdr.length < 4) throw new Error("Short header from scope");
      const n = new DataView(hdr.buffer, hdr.byteOffset, 4).getUint32(0, true);
      if (!(n > 0 && n < 64 << 20)) throw new Error(`Implausible payload length ${n}`);
      return this.t.readExact(n, timeoutMs);
    });
  }
  async capture() {
    this.last = await this.request("START");
    return parseLegacyDump(this.last);
  }
  async apply() { throw new Error("This model cannot be controlled over USB"); }
  async screenshot() {
    const data = await this.request("STARTBMP", 5000);
    if (data[0] !== 0x42 || data[1] !== 0x4d) throw new Error("Device did not return a bitmap");
    return new Blob([data], { type: "image/bmp" });
  }
  async rawBlob() { return this.last ? new Blob([this.last]) : null; }
  async close() { try { await this.t.device.close(); } catch { /* already closed */ } }
}

class WebUsbScpiDriver {
  constructor(transport, idn) {
    this.kind = "webusb";
    this.t = transport;
    this.mutex = new Mutex();
    const d = transport.device;
    this.id = `webusb:${d.serialNumber || ""}:${d.productId}`;
    this.info = { ...parseIdn(idn), protocol: "owon-scpi",
                  protocol_name: transport.usbtmc ? "SCPI over USBTMC via WebUSB" : "SCPI over USB bulk via WebUSB" };
    this.capabilities = scpiCapabilities(guessChannels(this.info.model));
    this.last = null;
  }
  capture() {
    return this.mutex.run(async () => {
      const headBytes = await this.t.queryBlock(":DATA:WAVE:SCREen:HEAD?");
      const text = new TextDecoder().decode(headBytes);
      const head = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const data = {};
      for (const ch of head.CHANNEL || head.channel || []) {
        const name = String(ch.NAME || ch.name || "").toUpperCase();
        if (String(ch.DISPLAY || ch.display || "ON").toUpperCase() !== "ON" || !name.startsWith("CH")) continue;
        data[name] = await this.t.queryBlock(`:DATA:WAVE:SCREen:${name}?`);
      }
      this.last = { head, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.from(v)])) };
      return scpiCapture(head, data);
    });
  }
  apply(action, params = {}) {
    const cmd = scpiCommand(action, params);
    return this.mutex.run(async () => { await this.t.scpiWrite(cmd); return { sent: cmd }; });
  }
  async screenshot() { throw new Error("Screenshots are not supported by this device"); }
  async rawBlob() { return this.last ? new Blob([JSON.stringify(this.last)], { type: "application/json" }) : null; }
  async close() { try { await this.t.device.close(); } catch { /* already closed */ } }
}

export const webUsbSupported = () => "usb" in navigator;

export async function requestWebUsbDevice() {
  const device = await navigator.usb.requestDevice({ filters: [{ vendorId: OWON_VID }] });
  return detectWebUsb(device);
}

export async function pairedWebUsbDevices() {
  if (!webUsbSupported()) return [];
  return (await navigator.usb.getDevices()).filter((d) => d.vendorId === OWON_VID);
}

// Same order as the Python manager: SCPI first (legacy firmware simply doesn't answer),
// then the legacy START dump.
export async function detectWebUsb(device) {
  const t = new UsbTransport(device);
  await t.open();
  try {
    const idn = await t.query("*IDN?", 800);
    if (idn.includes(",") && /^[\x20-\x7e]+$/.test(idn)) return new WebUsbScpiDriver(t, idn);
  } catch (e) {
    if (!(e instanceof TimeoutError)) console.warn("SCPI probe:", e);
  }
  if (!t.usbtmc) {
    const drv = new WebUsbLegacyDriver(t, new Uint8Array());
    try {
      const dump = await drv.request("START", 1500);
      if (dump[0] === 0x53 && dump[1] === 0x50 && dump[2] === 0x42) {
        const real = new WebUsbLegacyDriver(t, dump);
        try { await real.screenshot(); real.capabilities.screenshot = true; } catch { /* not supported */ }
        return real;
      }
    } catch (e) {
      console.warn("Legacy probe:", e);
    }
  }
  throw new Error("The device did not answer any known OWON protocol. " +
                  "PC-only scopes like the VDS1022 are not supported yet.");
}

// -------------------------------------------------------------------- demo ---

function demoSignal(kind, t, freq, amp) {
  // Locked to a rising-edge trigger at t=0, with a little jitter like a real scope.
  const phase = 2 * Math.PI * freq * t + (Math.random() - 0.5) * 0.04;
  const noise = (Math.random() - 0.5) * amp * 0.05;
  if (kind === "square") return amp * Math.sign(Math.sin(phase)) + noise;
  if (kind === "pulse") return (Math.sin(phase) > 0.95 ? -3 * amp : amp) + noise;
  return amp * Math.sin(phase) + noise;
}

export function buildLegacyDemoDump() {
  const specs = [ // name, n, tb, offset, vd, probeIdx, us/sample, mV/count, kind, freq, amp
    ["CH1", 1000, 13, 25, 8, 0, 1.0, 40.0, "sine", 1000, 2.5],
    ["CH2", 1000, 13, -50, 6, 1, 1.0, 8.0, "pulse", 1500, 0.3],
  ];
  const blocks = [];
  for (const [name, n, tb, off, vd, pr, usps, mvpc, kind, freq, amp] of specs) {
    const b = new DataView(new ArrayBuffer(51 + 2 * n));
    [...name].forEach((c, i) => b.setUint8(i, c.charCodeAt(0)));
    b.setInt32(3, 48 + 2 * n, true);
    [n, n, 0, tb, off, vd, pr].forEach((v, i) => b.setInt32(7 + 4 * i, v, true));
    [usps, freq, 1e6 / freq, mvpc].forEach((v, i) => b.setFloat32(35 + 4 * i, v, true));
    const vpc = mvpc * 1e-3 * 10 ** pr;
    for (let k = 0; k < n; k++) {
      const code = Math.round(demoSignal(kind, k * usps * 1e-6, freq, amp) / vpc) + off;
      b.setInt16(51 + 2 * k, Math.max(-32768, Math.min(32767, code)), true);
    }
    blocks.push(new Uint8Array(b.buffer));
  }
  const body = concat(...blocks);
  const head = new Uint8Array(10);
  [..."SPBV01"].forEach((c, i) => { head[i] = c.charCodeAt(0); });
  new DataView(head.buffer).setInt32(6, 10 + body.length, true);
  return concat(head, body);
}

class DemoLegacyDriver {
  constructor() {
    this.kind = "demo";
    this.id = "demo:legacy";
    this.info = { vendor: "OWON", model: "Demo PDS5022S (simulated)", protocol: "owon-legacy",
                  protocol_name: "Legacy binary dump (simulated)", simulated: true };
    this.capabilities = { ...LEGACY_CAPABILITIES };
    this.last = null;
  }
  async capture() { await sleep(30); this.last = buildLegacyDemoDump(); return parseLegacyDump(this.last); }
  async apply() { throw new Error("This model cannot be controlled over USB"); }
  async screenshot() { throw new Error("Screenshots are not supported by this device"); }
  async rawBlob() { return this.last ? new Blob([this.last]) : null; }
  async close() {}
}

class DemoScpiDriver {
  constructor() {
    this.kind = "demo";
    this.id = "demo:scpi";
    this.info = { ...parseIdn("OWON,SDS1102 (simulated),2024000001,V4.0.0"), protocol: "owon-scpi",
                  protocol_name: "SCPI (simulated)", simulated: true };
    this.capabilities = scpiCapabilities(2);
    this.state = {
      CH1: { display: true, scale: "1V", coupling: "DC", probe: "10X", offset: 0, kind: "sine", freq: 1000, amp: 1.5 },
      CH2: { display: true, scale: "500mV", coupling: "AC", probe: "1X", offset: -50, kind: "square", freq: 3000, amp: 0.4 },
      timebase: "500us", running: true,
      trigger: { source: "CH1", slope: "RISE", level: "0V", sweep: "AUTO" },
    };
    this.frozen = null;
    this.last = null;
  }
  head() {
    return {
      TIMEBASE: { SCALE: this.state.timebase, HOFFSET: 0 },
      SAMPLE: { FULLSCREEN: 1520, DATALEN: 1520, SAMPLERATE: "(1MS/s)" },
      CHANNEL: ["CH1", "CH2"].map((n) => {
        const s = this.state[n];
        return { NAME: n, DISPLAY: s.display ? "ON" : "OFF", COUPLING: s.coupling, PROBE: s.probe,
                 SCALE: s.scale, OFFSET: s.offset, FREQUENCE: s.freq };
      }),
      TRIGGER: { Mode: "EDGE", ...this.state.trigger },
      RUNSTATUS: this.state.running ? "RUN" : "STOP",
    };
  }
  async capture() {
    await sleep(30);
    if (!this.state.running && this.frozen) return this.frozen;
    const head = this.head();
    const tdiv = parseSI(this.state.timebase, "s");
    const data = {};
    for (const n of ["CH1", "CH2"]) {
      const s = this.state[n];
      if (!s.display) continue;
      const vdiv = parseSI(s.scale, "V");
      const b = new DataView(new ArrayBuffer(2 * 1520));
      for (let k = 0; k < 1520; k++) {
        let v = demoSignal(s.kind, k * tdiv * 10 / 1520, s.freq, s.amp);
        if (s.coupling === "GND") v = 0;
        const code = Math.round(v / vdiv * 25) + s.offset;
        b.setInt16(2 * k, Math.max(-128, Math.min(127, code)), true);
      }
      data[n] = new Uint8Array(b.buffer);
    }
    this.last = { head, note: "simulated" };
    this.frozen = scpiCapture(head, data);
    return this.frozen;
  }
  async apply(action, params = {}) {
    const cmd = scpiCommand(action, params); // validates like a real device would
    const s = this.state;
    const ch = s[String(params.channel || "CH1").toUpperCase()];
    const v = params.value;
    switch (action) {
      case "run": s.running = true; break;
      case "stop": s.running = false; break;
      case "single": s.running = false; this.frozen = null; await this.capture(); break;
      case "autoset": s.timebase = "500us"; s.CH1.scale = "1V"; s.CH2.scale = "200mV"; s.running = true; break;
      case "channel_display": ch.display = !!v; break;
      case "volts_div": ch.scale = v; break;
      case "coupling": ch.coupling = v; break;
      case "probe": ch.probe = v; break;
      case "position": ch.offset = Math.round(+v * 25); break;
      case "timebase": s.timebase = v; break;
      case "trigger_source": s.trigger.source = v; break;
      case "trigger_slope": s.trigger.slope = v; break;
      case "trigger_level": s.trigger.level = `${v}V`; break;
      case "trigger_sweep": s.trigger.sweep = v; break;
      default: break;
    }
    return { sent: cmd };
  }
  async screenshot() { throw new Error("Screenshots are not supported by this device"); }
  async rawBlob() { return this.last ? new Blob([JSON.stringify(this.last)], { type: "application/json" }) : null; }
  async close() {}
}

export const demoDrivers = () => [new DemoLegacyDriver(), new DemoScpiDriver()];
