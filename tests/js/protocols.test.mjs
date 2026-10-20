// Run with: node --test tests/js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { measure } from "../../owonscope/web/measure.js";
import { formatSI, parseLegacyDump, parseSI, scpiCapture, scpiCommand } from "../../owonscope/web/protocols.js";

const fixture = readFileSync(new URL("../data/pds5022s_spbv01.bin", import.meta.url));

test("parses a real PDS5022S dump like the Python driver", () => {
  const cap = parseLegacyDump(fixture);
  assert.deepEqual(cap.waveforms.map((w) => w.name), ["CH1", "CH2", "CHA"]);
  const [ch1, ch2, cha] = cap.waveforms;
  assert.equal(ch1.volts.length, 1000);
  assert.equal(cha.volts.length, 6250);
  assert.ok(Math.abs(ch1.volts_per_div - 5) < 1e-6);
  assert.ok(Math.abs(ch2.volts_per_div - 0.2) < 1e-6);
  assert.equal(ch2.probe, 10);
  assert.ok(Math.abs(Math.max(...cha.volts) - 1.84) < 0.1);
  assert.ok(Math.abs(Math.min(...cha.volts) + 6.08) < 0.1);
  assert.equal(cha.extra.timebase, "250us");
});

test("measures frequency from the waveform", () => {
  const cha = parseLegacyDump(fixture).waveforms[2];
  const m = measure(cha);
  assert.ok(Math.abs(m.freq - 1347) / 1347 < 0.02, `freq ${m.freq}`);
  assert.ok(Math.abs(m.vpp - 7.92) < 0.1);
  // A flat noisy trace has no frequency
  assert.equal(measure(parseLegacyDump(fixture).waveforms[0]).freq, null);
});

test("SI units", () => {
  assert.equal(parseSI("500mV", "V"), 0.5);
  assert.ok(Math.abs(parseSI("2.5us", "s") - 2.5e-6) < 1e-15);
  assert.equal(formatSI(0.0015, "s"), "1.5 ms");
});

test("SCPI commands and capture", () => {
  assert.equal(scpiCommand("volts_div", { channel: "CH2", value: "200mV" }), ":CHANnel2:SCALe 200mv");
  assert.equal(scpiCommand("trigger_level", { value: "1.5" }), ":TRIGger:SINGle:EDGe:LEVel 1.5v");
  assert.throws(() => scpiCommand("volts_div", { value: "3V" }));
  const head = { TIMEBASE: { SCALE: "1ms" }, SAMPLE: { DATALEN: 4 },
                 CHANNEL: [{ NAME: "CH1", DISPLAY: "ON", SCALE: "1V", OFFSET: 0, PROBE: "10X" }] };
  const data = new Uint8Array(new Int16Array([25, -25, 50, 0]).buffer);
  const cap = scpiCapture(head, { CH1: data });
  assert.deepEqual(Array.from(cap.waveforms[0].volts), [1, -1, 2, 0]);
  assert.ok(Math.abs(cap.waveforms[0].dt - 2.5e-3) < 1e-12);
});
