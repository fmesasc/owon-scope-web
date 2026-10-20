// OWON protocol parsing shared by the WebUSB and demo drivers.
// Mirrors owonscope/legacy.py and owonscope/scpi.py - keep them in sync.

export const COUNTS_PER_DIV = 25;

export const LEGACY_TIMEBASES = ["5ns", "10ns", "25ns", "50ns", "100ns", "250ns", "500ns",
  "1us", "2.5us", "5us", "10us", "25us", "50us", "100us", "250us", "500us",
  "1ms", "2.5ms", "5ms", "10ms", "25ms", "50ms", "100ms", "250ms", "500ms",
  "1s", "2.5s", "5s", "10s", "25s", "50s", "100s"];
export const LEGACY_VOLTS = ["2mV", "5mV", "10mV", "20mV", "50mV", "100mV", "200mV", "500mV",
  "1V", "2V", "5V", "10V", "20V", "50V", "100V"];

export const SCPI_VOLTS = ["1mV", "2mV", "5mV", "10mV", "20mV", "50mV", "100mV", "200mV", "500mV",
  "1V", "2V", "5V", "10V", "20V", "50V", "100V"];
export const SCPI_TIMEBASES = ["1ns", "2ns", "5ns", "10ns", "20ns", "50ns", "100ns", "200ns", "500ns",
  "1us", "2us", "5us", "10us", "20us", "50us", "100us", "200us", "500us",
  "1ms", "2ms", "5ms", "10ms", "20ms", "50ms", "100ms", "200ms", "500ms",
  "1s", "2s", "5s", "10s", "20s", "50s", "100s"];
export const SCPI_COUPLING = ["DC", "AC", "GND"];
export const SCPI_PROBES = ["1X", "10X", "100X", "1000X"];
export const SCPI_SLOPES = ["RISE", "FALL"];
export const SCPI_SWEEPS = ["AUTO", "NORMal", "SINGle"];

const SI = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

export function parseSI(text, unit) {
  let s = String(text).trim().replace(/\s+/g, "");
  if (s.toLowerCase().endsWith(unit.toLowerCase())) s = s.slice(0, -unit.length);
  let prefix = "";
  if (s && !/[\d.]$/.test(s)) { prefix = s.slice(-1); s = s.slice(0, -1); }
  if (prefix === "M" && unit.toLowerCase() === "s") prefix = "m";
  if (!(prefix in SI)) prefix = prefix.toLowerCase();
  const v = parseFloat(s) * SI[prefix];
  if (!isFinite(v)) throw new Error(`Cannot parse ${text}`);
  return v;
}

export function formatSI(value, unit, digits = 3) {
  if (value == null || !isFinite(value)) return "—";
  const a = Math.abs(value);
  const steps = [["G", 1e9], ["M", 1e6], ["k", 1e3], ["", 1], ["m", 1e-3], ["µ", 1e-6], ["n", 1e-9], ["p", 1e-12]];
  for (const [p, f] of steps) {
    if (a >= f * 0.9995) return `${+(value / f).toPrecision(digits)} ${p}${unit}`;
  }
  return value === 0 ? `0 ${unit}` : `${value.toPrecision(digits)} ${unit}`;
}

// ---------------------------------------------------------------- legacy ---

export function parseLegacyDump(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (ascii(0, 3) !== "SPB") throw new Error(`Unknown legacy dump format (${JSON.stringify(ascii(0, 6))})`);
  const waveforms = [];
  let timePerDiv = null;
  let o = 10;
  while (o + 51 <= u8.length) {
    const name = ascii(o, 3);
    const blen = dv.getInt32(o + 3, true);
    const i = (k) => dv.getInt32(o + 7 + 4 * k, true);
    const f = (k) => dv.getFloat32(o + 35 + 4 * k, true);
    const [n, screenN, slow, tb, offset, vd, probeIdx] = [0, 1, 2, 3, 4, 5, 6].map(i);
    const [usPerSample, freq, period, mvPerCount] = [0, 1, 2, 3].map(f);
    if (blen <= 0 || n < 0 || o + 51 + 2 * n > u8.length) throw new Error(`Corrupt channel block ${name}`);
    const probe = 10 ** probeIdx;
    const vPerCount = mvPerCount * 1e-3 * probe;
    const volts = new Float32Array(n);
    for (let k = 0; k < n; k++) volts[k] = (dv.getInt16(o + 51 + 2 * k, true) - offset) * vPerCount;
    waveforms.push({
      name, volts, dt: usPerSample * 1e-6, t0: 0,
      volts_per_div: vPerCount * COUNTS_PER_DIV,
      position_div: offset / COUNTS_PER_DIV,
      probe, coupling: null, frequency: freq > 0 ? freq : null,
      extra: {
        timebase: LEGACY_TIMEBASES[tb] ?? `#${tb}`,
        volts_div_setting: LEGACY_VOLTS[vd] ?? `#${vd}`,
        period_us: period || null, screen_samples: screenN, slow_move: slow,
      },
    });
    if (timePerDiv == null && n) timePerDiv = n * usPerSample * 1e-6 / 10;
    o += 3 + blen; // block length includes its own 4-byte field
  }
  if (!waveforms.length) throw new Error("Dump contains no channel data");
  return { timestamp: Date.now() / 1000, time_per_div: timePerDiv, h_divisions: 10, v_divisions: 8,
           settings: { format: ascii(0, 6) }, waveforms };
}

// ------------------------------------------------------------------ SCPI ---

const ci = (obj, ...keys) => {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const hit = Object.keys(obj).find((x) => x.toLowerCase() === k.toLowerCase());
    if (hit !== undefined) return obj[hit];
  }
  return undefined;
};

export function decodeScpiSamples(bytes, nExpected) {
  const u8 = new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let codes;
  if (nExpected && u8.length >= 2 * nExpected) {
    codes = Float32Array.from({ length: nExpected }, (_, k) => dv.getInt16(2 * k, true));
  } else if (nExpected && u8.length >= nExpected) {
    return { codes: Float32Array.from({ length: nExpected }, (_, k) => dv.getInt8(k)), perDiv: 25 };
  } else {
    codes = Float32Array.from({ length: u8.length >> 1 }, (_, k) => dv.getInt16(2 * k, true));
  }
  let maxAbs = 0;
  for (const c of codes) maxAbs = Math.max(maxAbs, Math.abs(c));
  return { codes, perDiv: maxAbs > 255 ? 25 * 256 : 25 };
}

export function scpiCapture(head, channelData) {
  const timebase = ci(head, "TIMEBASE") || {};
  const sample = ci(head, "SAMPLE") || {};
  const nPoints = parseInt(ci(sample, "DATALEN", "FULLSCREEN") || 0, 10);
  let tdiv = null;
  try { tdiv = parseSI(ci(timebase, "SCALE"), "s"); } catch { /* unknown */ }
  const sr = /([\d.]+)\s*([kKMG]?)S\/s/.exec(String(ci(sample, "SAMPLERATE") || ""));
  const srate = sr ? parseFloat(sr[1]) * ({ "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }[sr[2]]) : null;
  const waveforms = [];
  for (const ch of ci(head, "CHANNEL") || []) {
    const name = String(ci(ch, "NAME") || "").toUpperCase();
    if (!(name in channelData)) continue;
    const { codes, perDiv } = decodeScpiSamples(channelData[name], nPoints || null);
    let vdiv = 1;
    try { vdiv = parseSI(ci(ch, "SCALE"), "V"); } catch { /* keep 1 */ }
    const offset = parseFloat(ci(ch, "OFFSET") || 0);
    const volts = codes.map((c) => (c - offset) / perDiv * vdiv);
    const freq = parseFloat(ci(ch, "FREQUENCE", "FREQUENCY"));
    waveforms.push({
      name, volts, t0: 0,
      dt: tdiv ? tdiv * 10 / Math.max(codes.length, 1) : (srate ? 1 / srate : 1e-6),
      volts_per_div: vdiv, position_div: offset / perDiv,
      probe: parseFloat(String(ci(ch, "PROBE") || "1")) || 1,
      coupling: ci(ch, "COUPLING") ?? null,
      frequency: isFinite(freq) ? freq : null, extra: {},
    });
  }
  return { timestamp: Date.now() / 1000, time_per_div: tdiv, h_divisions: 10, v_divisions: 8,
           settings: scpiSettings(head), waveforms };
}

export function scpiSettings(head) {
  const s = { channels: {} };
  for (const ch of ci(head, "CHANNEL") || []) {
    const name = String(ci(ch, "NAME") || "").toUpperCase();
    s.channels[name] = {
      display: String(ci(ch, "DISPLAY") || "").toUpperCase() === "ON",
      volts_div: ci(ch, "SCALE"), coupling: ci(ch, "COUPLING"), probe: ci(ch, "PROBE"),
    };
  }
  s.timebase = ci(ci(head, "TIMEBASE") || {}, "SCALE");
  const trig = ci(head, "TRIGGER");
  if (trig && typeof trig === "object") {
    s.trigger = {};
    for (const [k, v] of Object.entries(trig)) if (typeof v !== "object") s.trigger[k.toLowerCase()] = v;
  }
  s.running = ci(head, "RUNSTATUS");
  return s;
}

export function scpiCommand(action, params) {
  const ch = String(params.channel || "CH1").toUpperCase();
  const n = ch.startsWith("CH") ? ch.slice(2) : "1";
  const value = String(params.value ?? "");
  const pick = (list) => {
    const hit = list.find((a) => a.toLowerCase() === value.toLowerCase());
    if (!hit) throw new Error(`${value} is not one of ${list.join(", ")}`);
    return hit;
  };
  switch (action) {
    case "run": return ":RUNning RUN";
    case "stop": return ":RUNning STOP";
    case "autoset": return ":AUTOset ON";
    case "single": return ":TRIGger:SINGle:SWEep SINGle";
    case "channel_display": return `:CHANnel${n}:DISPlay ${params.value ? "ON" : "OFF"}`;
    case "volts_div": return `:CHANnel${n}:SCALe ${pick(SCPI_VOLTS).toLowerCase()}`;
    case "coupling": return `:CHANnel${n}:COUPling ${pick(SCPI_COUPLING)}`;
    case "probe": return `:CHANnel${n}:PROBe ${pick(SCPI_PROBES)}`;
    case "position": return `:CHANnel${n}:OFFSet ${+value}`;
    case "timebase": return `:HORizontal:SCALe ${pick(SCPI_TIMEBASES).toLowerCase()}`;
    case "h_position": return `:HORizontal:OFFSet ${+value}`;
    case "trigger_source": return `:TRIGger:SINGle:EDGe:SOURce ${pick(["CH1", "CH2", "CH3", "CH4"])}`;
    case "trigger_slope": return `:TRIGger:SINGle:EDGe:SLOPe ${pick(SCPI_SLOPES)}`;
    case "trigger_level": return `:TRIGger:SINGle:EDGe:LEVel ${formatSI(+value, "v").replace(/\s|µ/g, (m) => (m === "µ" ? "u" : "")).toLowerCase()}`;
    case "trigger_sweep": return `:TRIGger:SINGle:SWEep ${pick(SCPI_SWEEPS)}`;
    default: throw new Error(`Unknown action ${action}`);
  }
}

export function scpiCapabilities(nChannels) {
  const chans = Array.from({ length: nChannels }, (_, i) => `CH${i + 1}`);
  return {
    control: true, screenshot: false,
    controls: { channels: chans, volts_div: SCPI_VOLTS, coupling: SCPI_COUPLING, probe: SCPI_PROBES,
                timebase: SCPI_TIMEBASES, trigger_source: chans, trigger_slope: SCPI_SLOPES,
                trigger_sweep: SCPI_SWEEPS },
    note: "Experimental driver for SCPI-capable OWON scopes. If something looks wrong, " +
          "download the raw data and open an issue.",
  };
}

export function guessChannels(model) {
  const m = /(\d{3,4})/.exec(model || "");
  return m && "24".includes(m[1].slice(-1)) ? +m[1].slice(-1) : 2;
}

export function parseIdn(idn) {
  const p = idn.split(",").map((s) => s.trim());
  return { vendor: p[0] || "OWON", model: p[1] || "SCPI oscilloscope", serial: p[2] || "", firmware: p[3] || "", idn };
}

export const LEGACY_CAPABILITIES = {
  control: false, screenshot: false, controls: {},
  note: "This model only sends data over USB. Change volts/div, timebase and trigger " +
        "on the oscilloscope itself; the viewer follows automatically.",
};
