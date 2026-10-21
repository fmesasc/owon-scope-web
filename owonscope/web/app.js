import {
  demoDrivers, detectWebUsb, listServerDevices, pairedWebUsbDevices, requestWebUsbDevice,
  serverAvailable, webUsbSupported,
} from "./drivers.js";
import { measure } from "./measure.js";
import { formatSI } from "./protocols.js";
import { captureToCsv, library, niceStep, openFile, recordingToBlob } from "./store.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const COLORS = { CH1: "#f5c400", CH2: "#22b8f0", CH3: "#e64ea3", CH4: "#3ccf6e", CHA: "#ff7a45", CHB: "#a78bfa" };
const EXTRA_COLORS = ["#ff7a45", "#a78bfa", "#f472b6", "#94e2d5"];
const REF_COLOR = "rgba(200, 210, 220, 0.55)";
const MAX_HISTORY = 16;
const MAX_REC_BYTES = 400 * 1024 * 1024;

const state = {
  serverMode: false,
  drivers: new Map(),
  serverEntries: [],
  driver: null,
  live: false,
  liveRun: 0,
  interval: 0,
  capture: null,
  history: [],
  rec: null,          // { name, created, device, frames[], savedId }
  recording: false,
  recBytes: 0,
  frameIndex: -1,     // -1 = follow live
  playing: false,
  view: "scope",
  hidden: new Set(),
  refs: null,
  persist: false,
  cursors: { on: false, a: null, b: null },  // positions as fractions of plot width
  zoom: { x0: 0, x1: 1, yScale: 1, yCenter: null },
  errors: 0,
  resume: null,       // { live } after a lost connection, applied when the scope is back
};

// ------------------------------------------------------------------ utils ---

function toast(msg, isError = false, ms = 3500, action = null) {
  const t = $("#toast");
  t.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.onclick = () => { t.className = "toast"; action.run(); };
    t.append(b);
  }
  t.className = `toast show${isError ? " error" : ""}${action ? " has-action" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = "toast"; }, ms);
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[:T]/g, (m) => (m === "T" ? "_" : ""));
const colorOf = (name, i) => COLORS[name] || EXTRA_COLORS[i % EXTRA_COLORS.length];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function setStatus(text, cls = "") {
  const p = $("#statusPill");
  p.textContent = text;
  p.className = `pill ${cls}`;
}

function refreshStatus() {
  if (state.recording) setStatus(`● REC ${state.rec.frames.length}`, "rec");
  else if (state.live) setStatus("live", "live");
  else if (state.frameIndex >= 0 && state.rec) setStatus("playback", "ok");
  else if (state.driver) setStatus("connected", "ok");
  else setStatus("offline");
}

// ------------------------------------------------------------ setup guide ---

function detectOS() {
  const p = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent}`.toLowerCase();
  if (/android/.test(p)) return "android";
  if (/cros|chrome os/.test(p)) return "android";
  if (/iphone|ipad/.test(p)) return "other";
  if (/win/.test(p)) return "windows";
  if (/mac/.test(p)) return "mac";
  return "linux";
}

function showGuideTab(os) {
  $$(".guide-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.os === os));
  $$("[data-os-panel]").forEach((p) => { p.hidden = p.dataset.osPanel !== os; });
}

function openGuide(reason = "", os = null) {
  if (!os) os = webUsbSupported() || state.serverMode ? detectOS() : "other";
  showGuideTab(os);
  const r = $("#guideReason");
  r.hidden = !reason;
  r.textContent = reason;
  const d = $("#guideDialog");
  if (!d.open) d.showModal();
}

const guideAction = { label: "Setup guide", run: () => openGuide() };

// --------------------------------------------------------------- devices ---

function addDriver(drv, select = true) {
  state.drivers.set(drv.id, drv);
  renderDeviceSelect();
  if (select || !state.driver) selectDriver(drv.id);
}

function renderDeviceSelect() {
  const sel = $("#deviceSelect");
  const opts = ['<option value="">No device</option>'];
  for (const d of state.drivers.values()) {
    const src = { server: "USB (local app)", webusb: "USB", demo: "demo" }[d.kind] || d.kind;
    opts.push(`<option value="${esc(d.id)}">${esc(d.info.model)} — ${src}</option>`);
  }
  for (const d of state.serverEntries.filter((x) => x.unusable)) {
    opts.push(`<option disabled>⚠ ${esc(d.usb?.vid)}:${esc(d.usb?.pid)} ${esc(d.status)}</option>`);
  }
  sel.innerHTML = opts.join("");
  sel.value = state.driver?.id || "";
}

function selectDriver(id) {
  const resume = state.driver == null && state.drivers.get(id) ? state.resume : null;
  stopLive(!!resume);
  state.driver = state.drivers.get(id) || null;
  if (!resume) {
    state.history = [];
    state.refs = null;
    state.hidden.clear();
  }
  $("#deviceSelect").value = state.driver?.id || "";
  renderDeviceInfo();
  buildControls();
  refreshStatus();
  if (state.driver) {
    $("#welcome").hidden = true;
    if (resume) {
      state.resume = null;
      toast("Reconnected to the scope.");
      if (resume.live) startLive(); else captureOnce();
    } else {
      captureOnce();
    }
  }
}

function renderDeviceInfo() {
  const d = state.driver;
  const dl = $("#deviceInfo");
  const note = $("#deviceNote");
  $("#deviceButtons").hidden = !d;
  if (!d) {
    const bad = state.serverEntries.find((x) => x.unusable);
    dl.innerHTML = "<dt>Status</dt><dd>Not connected</dd>";
    note.hidden = !bad;
    if (bad) note.textContent = bad.error;
    $("#btnScreenshot").hidden = true;
    return;
  }
  const rows = [
    ["Model", d.info.model], ["Vendor", d.info.vendor], ["Protocol", d.info.protocol_name],
    ["Serial", d.info.serial], ["Firmware", d.info.firmware], ["Format", d.info.format],
  ].filter(([, v]) => v);
  dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  note.hidden = !d.capabilities?.note;
  note.textContent = d.capabilities?.note || "";
  $("#btnScreenshot").hidden = !d.capabilities?.screenshot;
}

async function loadServerDevices(quiet = false) {
  try {
    const list = await listServerDevices();
    state.serverEntries = list;
    const ready = list.filter((d) => !d.unusable);
    for (const [id, d] of state.drivers) if (d.kind === "server" && !ready.find((r) => r.id === id)) state.drivers.delete(id);
    for (const d of ready) if (!state.drivers.has(d.id)) state.drivers.set(d.id, d);
    renderDeviceSelect();
    if (!state.driver && ready.length) selectDriver(ready[0].id);
    else if (state.driver?.kind === "server" && !state.drivers.has(state.driver.id)) selectDriver("");
    renderDeviceInfo();
    if (!quiet) {
      const bad = list.find((d) => d.unusable);
      if (bad) toast(bad.error, true, 10000, guideAction);
      else if (!ready.length) toast("No OWON scope found. Is it on and connected with a data USB cable?", true, 10000, guideAction);
    }
  } catch (e) {
    if (!quiet) toast(`Local app: ${e.message}`, true);
  }
}

async function connectUsb() {
  if (state.serverMode) return loadServerDevices();
  if (!webUsbSupported()) {
    openGuide("This browser can't use USB devices. Use Chrome or Edge, or the local app below.", "other");
    return;
  }
  try {
    setStatus("connecting…");
    toast("In the list, OWON scopes usually appear as “LILLIPUT S3C2410A SPQ SYSTEM” or “System MCU”.", false, 15000);
    const drv = await requestWebUsbDevice();
    addDriver(drv);
    toast(`Connected: ${drv.info.model} (${drv.info.protocol_name})`);
  } catch (e) {
    refreshStatus();
    if (e.stale) {
      openGuide("That “LILLIPUT…” entry is left over from an earlier connection: Chrome keeps one for every time the " +
        "scope reconnected, and only the current one works. To clear the list, type chrome://restart in the address bar " +
        "(your tabs come back), then click Connect USB again.");
    } else if (e.cancelled) {
      toast("No scope selected. Not in the list, or listed several times?", false, 10000, guideAction);
    } else if (e.name === "SecurityError" || /access denied|claim|permission/i.test(e.message)) {
      openGuide(`Couldn't open the scope: ${e.message}`);
    } else {
      toast(e.message, true, 12000, guideAction);
    }
  }
}

// Serialised: the "connect" event and a lost connection can both trigger it at once.
let autoConnectChain = Promise.resolve();
function autoConnectWebUsb() {
  autoConnectChain = autoConnectChain.then(autoConnectOnce, autoConnectOnce);
  return autoConnectChain;
}

async function autoConnectOnce() {
  const inUse = new Set([...state.drivers.values()].map((d) => d.t?.device).filter(Boolean));
  for (const dev of await pairedWebUsbDevices()) {
    if (inUse.has(dev)) continue;
    try {
      addDriver(await detectWebUsb(dev), !state.driver);
      inUse.add(dev);
    } catch (e) {
      console.warn("Auto-connect failed:", e);
    }
  }
}

function startDemo() {
  for (const d of demoDrivers()) if (!state.drivers.has(d.id)) state.drivers.set(d.id, d);
  renderDeviceSelect();
  selectDriver("demo:scpi");
  toast("Demo: two simulated scopes (legacy PDS and modern SCPI). Switch between them above.");
}

async function disconnect() {
  const d = state.driver;
  if (!d) return;
  stopLive();
  if (d.kind !== "server") {
    await d.close();
    state.drivers.delete(d.id);
  }
  state.driver = null;
  renderDeviceSelect();
  selectDriver("");
}

// ------------------------------------------------------------ acquisition ---

async function captureOnce() {
  if (!state.driver) return;
  try {
    const cap = await state.driver.capture();
    state.errors = 0;
    onCapture(cap);
  } catch (e) {
    handleCaptureError(e);
  }
}

function handleCaptureError(e) {
  console.error(e);
  if (e.gone) return onConnectionLost(e);
  state.errors++;
  toast(e.message, true, 8000, /stopped answering|disconnected/i.test(e.message) ? guideAction : null);
  if (e.gone || state.errors >= 3) {
    stopLive();
    if (e.gone && state.serverMode) loadServerDevices(true);
  }
}

// The scope dropped off the USB bus. Keep the recording session, and resume as soon as
// the scope is back (automatically if the browser still has permission to use it).
async function onConnectionLost(e) {
  const d = state.driver;
  if (!d || state.resume) return;
  state.resume = { live: state.live };
  stopLive(true);
  state.driver = null;
  if (d.kind === "webusb") {
    state.drivers.delete(d.id);
    try { await d.close(); } catch { /* already gone */ }
  }
  renderDeviceSelect();
  renderDeviceInfo();
  setStatus("reconnecting…", "err");
  toast("Lost the USB connection to the scope. Reconnecting… If this keeps happening, try another USB cable or port.",
        true, 20000, d.kind === "webusb" ? { label: "Reconnect", run: connectUsb } : guideAction);
  console.warn("Connection lost:", e.message);
  if (d.kind === "server") {
    for (let i = 0; i < 30 && state.resume && !state.driver; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      await loadServerDevices(true);
    }
  } else {
    await autoConnectWebUsb(); // succeeds if the browser kept the permission (e.g. Chrome policy)
  }
}

function onCapture(cap) {
  cap.timestamp = cap.timestamp || Date.now() / 1000;
  if (state.recording) {
    state.rec.frames.push(cap);
    state.recBytes += cap.waveforms.reduce((s, w) => s + w.volts.length * 4, 0);
    if (state.recBytes > MAX_REC_BYTES) {
      toggleRecord();
      toast("Recording stopped: memory limit reached (400 MB).", true);
    }
  }
  state.history.push(cap);
  if (state.history.length > MAX_HISTORY) state.history.shift();
  if (state.frameIndex < 0) showCapture(cap);
  updateTimeline();
  refreshStatus();
}

function startLive() {
  if (!state.driver || state.live) return;
  state.frameIndex = -1;
  state.playing = false;
  state.live = true;
  const run = ++state.liveRun;
  $("#btnLive").textContent = "■ Stop";
  $("#btnLive").classList.add("on");
  refreshStatus();
  (async () => {
    while (state.live && run === state.liveRun) {
      const t0 = performance.now();
      try {
        const cap = await state.driver.capture();
        if (!state.live || run !== state.liveRun) break;
        state.errors = 0;
        onCapture(cap);
      } catch (e) {
        handleCaptureError(e);
      }
      const wait = Math.max(0, state.interval - (performance.now() - t0));
      await new Promise((r) => setTimeout(r, wait || 16));
    }
  })();
}

function stopLive(keepRecording = false) {
  state.live = false;
  state.liveRun++;
  if (state.recording && !keepRecording) toggleRecord();
  $("#btnLive").textContent = "▶ Live";
  $("#btnLive").classList.remove("on");
  refreshStatus();
}

// ------------------------------------------------------- recording/playback ---

function toggleRecord() {
  if (state.recording) {
    state.recording = false;
    $("#btnRec").classList.remove("on");
    $("#btnRec").textContent = "● Rec";
    const n = state.rec.frames.length;
    if (n) toast(`Recorded ${n} frame${n === 1 ? "" : "s"}. Scrub the timeline, save it to the library or download it.`);
    updateTimeline();
    refreshStatus();
    return;
  }
  if (!state.driver) { toast("Connect a device (or start the demo) to record.", true); return; }
  if (state.rec && state.rec.frames.length && !state.rec.savedId &&
      !confirm("Discard the current unsaved recording and start a new one?")) return;
  const model = state.driver.info.model || "OWON";
  state.rec = { name: `${model} ${new Date().toLocaleString()}`, created: Date.now(), device: state.driver.info, frames: [] };
  state.recBytes = 0;
  state.recording = true;
  $("#btnRec").classList.add("on");
  $("#btnRec").textContent = "■ Stop rec";
  if (!state.live) startLive();
  updateTimeline();
  refreshStatus();
}

function loadRecording(rec) {
  stopLive();
  state.rec = rec;
  state.history = [];
  state.hidden.clear();
  state.frameIndex = 0;
  $("#welcome").hidden = true;
  updateTimeline();
  showFrame(0);
  refreshStatus();
}

function updateTimeline() {
  const tl = $("#timeline");
  const n = state.rec?.frames.length || 0;
  tl.max = Math.max(0, n - 1);
  tl.disabled = n < 2 || state.recording;
  $("#btnPlay").disabled = n < 2 || state.recording;
  $("#speedSelect").disabled = n < 2 || state.recording;
  tl.value = state.frameIndex >= 0 ? state.frameIndex : Math.max(0, n - 1);
  const info = $("#recInfo");
  if (!state.rec || !n) { info.textContent = state.recording ? "Recording…" : "No recording"; return; }
  const span = state.rec.frames[n - 1].timestamp - state.rec.frames[0].timestamp;
  info.textContent = `${n} frame${n === 1 ? "" : "s"} · ${fmtDuration(span)}${state.rec.savedId ? " · saved" : ""}`;
}

function fmtDuration(s) {
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.round(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function showFrame(i) {
  if (!state.rec?.frames.length) return;
  i = Math.max(0, Math.min(state.rec.frames.length - 1, i));
  state.frameIndex = i;
  $("#timeline").value = i;
  const f = state.rec.frames[i];
  showCapture(f);
  const badge = $("#frameBadge");
  badge.hidden = false;
  const rel = f.timestamp - state.rec.frames[0].timestamp;
  badge.textContent = `Frame ${i + 1}/${state.rec.frames.length} · +${rel.toFixed(2)} s · ${new Date(f.timestamp * 1000).toLocaleTimeString()}`;
  refreshStatus();
}

function scrubTo(i) {
  if (state.live) stopLive();
  showFrame(i);
}

async function togglePlay() {
  if (state.playing) { state.playing = false; $("#btnPlay").textContent = "▶"; return; }
  if (!state.rec || state.rec.frames.length < 2) return;
  if (state.live) stopLive();
  state.playing = true;
  $("#btnPlay").textContent = "❚❚";
  let i = state.frameIndex < 0 || state.frameIndex >= state.rec.frames.length - 1 ? 0 : state.frameIndex;
  showFrame(i);
  while (state.playing && i < state.rec.frames.length - 1) {
    const speed = parseFloat($("#speedSelect").value);
    const gap = (state.rec.frames[i + 1].timestamp - state.rec.frames[i].timestamp) * 1000 / speed;
    await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(16, gap))));
    if (!state.playing) break;
    showFrame(++i);
  }
  state.playing = false;
  $("#btnPlay").textContent = "▶";
}

async function saveToLibrary() {
  if (!state.rec?.frames.length) { toast("Nothing recorded yet. Press ● Rec while live.", true); return; }
  try {
    const meta = await library.save({ ...state.rec, id: state.rec.savedId });
    state.rec.savedId = meta.id;
    updateTimeline();
    renderLibrary();
    toast("Saved to this browser's library.");
  } catch (e) {
    toast(`Could not save: ${e.message}`, true);
  }
}

async function renderLibrary() {
  const items = await library.list();
  const ul = $("#libraryList");
  if (!items.length) { ul.innerHTML = '<li class="muted small">Nothing saved yet</li>'; return; }
  ul.innerHTML = items.map((m) => `
    <li data-id="${esc(m.id)}">
      <span class="name" title="${esc(m.name)}">${esc(m.name)}<br><span class="muted small">${m.count} frames · ${fmtDuration(m.span || 0)} · ${new Date(m.created).toLocaleDateString()}</span></span>
      <button class="btn" data-lib="open" title="Open">Open</button>
      <button class="btn" data-lib="download" title="Download">⤓</button>
      <button class="btn" data-lib="rename" title="Rename">✎</button>
      <button class="btn" data-lib="delete" title="Delete">✕</button>
    </li>`).join("");
}

async function libraryAction(act, id) {
  try {
    if (act === "open") {
      const rec = await library.load(id);
      loadRecording({ ...rec, savedId: id });
      toast(`Opened “${rec.name}”`);
    } else if (act === "download") {
      const rec = await library.load(id);
      download(await recordingToBlob(rec), `${rec.name.replace(/[^\w.-]+/g, "_")}.owonrec`);
    } else if (act === "rename") {
      const items = await library.list();
      const cur = items.find((m) => m.id === id);
      const name = prompt("New name", cur?.name || "");
      if (name) { await library.rename(id, name); if (state.rec?.savedId === id) state.rec.name = name; }
    } else if (act === "delete") {
      if (!confirm("Delete this recording from the library?")) return;
      await library.remove(id);
      if (state.rec?.savedId === id) delete state.rec.savedId;
    }
    renderLibrary();
    updateTimeline();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------- display ---

function showCapture(cap) {
  state.capture = cap;
  renderChannels();
  renderMeasurements();
  syncControls(cap.settings);
  draw();
}

function renderChannels() {
  const cap = state.capture;
  const el = $("#channelList");
  if (!cap?.waveforms.length) { el.innerHTML = '<p class="muted small">No data yet</p>'; return; }
  el.innerHTML = cap.waveforms.map((w, i) => {
    const bits = [`${formatSI(w.volts_per_div, "V")}/div`];
    if (w.probe && w.probe !== 1) bits.push(`×${w.probe}`);
    if (w.coupling) bits.push(w.coupling);
    bits.push(`${w.volts.length} pts`);
    if (w.extra?.timebase) bits.push(`${w.extra.timebase}/div`);
    return `<label class="chan"><input type="checkbox" data-ch="${esc(w.name)}" ${state.hidden.has(w.name) ? "" : "checked"}>
      <span><span class="swatch" style="background:${colorOf(w.name, i)}"></span><b>${esc(w.name)}</b>
      <br><span class="meta">${esc(bits.join(" · "))}</span></span></label>`;
  }).join("");
}

function renderMeasurements() {
  const cap = state.capture;
  const tb = $("#measureTable tbody");
  if (!cap) { tb.innerHTML = ""; return; }
  tb.innerHTML = cap.waveforms.filter((w) => !state.hidden.has(w.name)).map((w, i) => {
    const m = measure(w);
    if (!m) return "";
    const v = (x) => formatSI(x, "V");
    return `<tr><td><span class="swatch" style="background:${colorOf(w.name, i)}"></span>${esc(w.name)}</td>
      <td>${v(m.vpp)}</td><td>${v(m.max)}</td><td>${v(m.min)}</td><td>${v(m.mean)}</td><td>${v(m.rms)}</td>
      <td>${formatSI(m.freq, "Hz", 4)}</td><td>${formatSI(m.period, "s")}</td>
      <td>${m.duty == null ? "—" : `${(m.duty * 100).toFixed(1)} %`}</td></tr>`;
  }).join("");
}

const canvas = $("#scope");
const ctx = canvas.getContext("2d");

function geometry() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const volts = state.view === "volts";
  const m = volts ? { l: 62, r: 30, t: 12, b: 34 } : { l: 14, r: 14, t: 12, b: 30 };
  return { w, h, x: m.l, y: m.t, pw: w - m.l - m.r, ph: h - m.t - m.b };
}

function visibleWaves(cap = state.capture) {
  return (cap?.waveforms || []).map((w, i) => ({ w, i })).filter(({ w }) => !state.hidden.has(w.name));
}

// Mapping helpers for the current view.
function mapping(g, cap) {
  const z = state.zoom;
  const hdiv = cap?.h_divisions || 10;
  const vdiv = cap?.v_divisions || 8;
  if (state.view === "scope") {
    return {
      hdiv, vdiv,
      x: (w, i) => g.x + ((i / Math.max(1, w.volts.length - 1)) - z.x0) / (z.x1 - z.x0) * g.pw,
      y: (w, v) => g.y + g.ph / 2 - ((v / w.volts_per_div + w.position_div) * z.yScale) * (g.ph / vdiv),
      span: (w) => w.volts.length * w.dt,
    };
  }
  const waves = visibleWaves(cap);
  const T = Math.max(1e-12, ...waves.map(({ w }) => w.volts.length * w.dt));
  let lo = Infinity;
  let hi = -Infinity;
  for (const { w } of waves) for (const v of w.volts) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) { lo = -1; hi = 1; }
  const pad = Math.max((hi - lo) * 0.1, 1e-3);
  const center = z.yCenter ?? (hi + lo) / 2;
  const half = ((hi - lo) / 2 + pad) / z.yScale;
  return {
    hdiv, vdiv, T, vlo: center - half, vhi: center + half,
    x: (w, i) => g.x + ((w.t0 + i * w.dt) / T - z.x0) / (z.x1 - z.x0) * g.pw,
    y: (w, v) => g.y + (center + half - v) / (2 * half) * g.ph,
    span: () => T,
  };
}

function drawGrid(g, map) {
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.lineWidth = 1;
  if (state.view === "scope") {
    for (let i = 0; i <= map.hdiv; i++) {
      const x = Math.round(g.x + i * g.pw / map.hdiv) + 0.5;
      ctx.strokeStyle = i === map.hdiv / 2 ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.10)";
      ctx.beginPath(); ctx.moveTo(x, g.y); ctx.lineTo(x, g.y + g.ph); ctx.stroke();
    }
    for (let j = 0; j <= map.vdiv; j++) {
      const y = Math.round(g.y + j * g.ph / map.vdiv) + 0.5;
      ctx.strokeStyle = j === map.vdiv / 2 ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.10)";
      ctx.beginPath(); ctx.moveTo(g.x, y); ctx.lineTo(g.x + g.pw, y); ctx.stroke();
    }
    // minor ticks on the centre axes
    ctx.strokeStyle = "rgba(255,255,255,.28)";
    const cx = g.x + g.pw / 2;
    const cy = g.y + g.ph / 2;
    for (let i = 0; i <= map.hdiv * 5; i++) {
      const x = g.x + i * g.pw / (map.hdiv * 5);
      ctx.beginPath(); ctx.moveTo(x, cy - 3); ctx.lineTo(x, cy + 3); ctx.stroke();
    }
    for (let j = 0; j <= map.vdiv * 5; j++) {
      const y = g.y + j * g.ph / (map.vdiv * 5);
      ctx.beginPath(); ctx.moveTo(cx - 3, y); ctx.lineTo(cx + 3, y); ctx.stroke();
    }
    return;
  }
  // volts/time axes with labelled ticks
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillStyle = "#8b9aab";
  const z = state.zoom;
  const t0 = z.x0 * map.T;
  const t1 = z.x1 * map.T;
  const tStep = niceStep((t1 - t0) / 8);
  ctx.textAlign = "center";
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1 + 1e-15; t += tStep) {
    const x = Math.round(g.x + (t - t0) / (t1 - t0) * g.pw) + 0.5;
    ctx.strokeStyle = Math.abs(t) < tStep / 1e6 ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.10)";
    ctx.beginPath(); ctx.moveTo(x, g.y); ctx.lineTo(x, g.y + g.ph); ctx.stroke();
    ctx.fillText(formatSI(t, "s"), x, g.y + g.ph + 16);
  }
  const vStep = niceStep((map.vhi - map.vlo) / 7);
  ctx.textAlign = "right";
  for (let v = Math.ceil(map.vlo / vStep) * vStep; v <= map.vhi + 1e-12; v += vStep) {
    const y = Math.round(g.y + (map.vhi - v) / (map.vhi - map.vlo) * g.ph) + 0.5;
    ctx.strokeStyle = Math.abs(v) < vStep / 1e6 ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.10)";
    ctx.beginPath(); ctx.moveTo(g.x, y); ctx.lineTo(g.x + g.pw, y); ctx.stroke();
    ctx.fillText(formatSI(Math.abs(v) < vStep / 1e6 ? 0 : v, "V"), g.x - 6, y + 4);
  }
}

function drawTrace(g, map, w, color, alpha = 1, dashed = false) {
  const n = w.volts.length;
  if (!n) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.x, g.y, g.pw, g.ph);
  ctx.clip();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = dashed ? 1.2 : 1.5;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.lineJoin = "round";
  ctx.beginPath();
  // Find the visible index range, then min/max-decimate per pixel column when dense.
  const xa = map.x(w, 0);
  const xb = map.x(w, n - 1);
  const pxPerSample = (xb - xa) / Math.max(1, n - 1);
  const iStart = Math.max(0, Math.floor((g.x - xa) / pxPerSample) - 1);
  const iEnd = Math.min(n - 1, Math.ceil((g.x + g.pw - xa) / pxPerSample) + 1);
  if (pxPerSample >= 0.5) {
    for (let i = iStart; i <= iEnd; i++) {
      const x = map.x(w, i);
      const y = map.y(w, w.volts[i]);
      i === iStart ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
  } else {
    let col = Math.floor(map.x(w, iStart));
    let lo = Infinity;
    let hi = -Infinity;
    let first = true;
    for (let i = iStart; i <= iEnd; i++) {
      const c = Math.floor(map.x(w, i));
      if (c !== col) {
        const y1 = map.y(w, lo);
        const y2 = map.y(w, hi);
        if (first) { ctx.moveTo(col, y1); first = false; } else ctx.lineTo(col, y1);
        ctx.lineTo(col, y2);
        col = c; lo = Infinity; hi = -Infinity;
      }
      const v = w.volts[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo <= hi) {
      if (first) ctx.moveTo(col, map.y(w, lo)); else ctx.lineTo(col, map.y(w, lo));
      ctx.lineTo(col, map.y(w, hi));
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawLabels(g, map, cap) {
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "alphabetic";
  let x = g.x + 2;
  const y = g.h - 10;
  const waves = visibleWaves(cap);
  for (const { w, i } of waves) {
    const txt = `${w.name} ${formatSI(w.volts_per_div, "V")}/div${w.coupling ? ` ${w.coupling}` : ""}`;
    ctx.fillStyle = colorOf(w.name, i);
    ctx.textAlign = "left";
    if (state.view === "scope") ctx.fillText(txt, x, y);
    x += ctx.measureText(txt).width + 18;
    // ground marker on the left edge
    if (state.view === "scope") {
      const gy = map.y(w, 0);
      if (gy > g.y && gy < g.y + g.ph) {
        ctx.beginPath();
        ctx.moveTo(g.x - 12, gy - 6); ctx.lineTo(g.x - 4, gy); ctx.lineTo(g.x - 12, gy + 6);
        ctx.fill();
      }
    }
  }
  if (state.view === "scope") {
    const first = waves[0]?.w;
    const tdiv = first ? first.volts.length * first.dt / map.hdiv : cap.time_per_div;
    const zoomF = state.zoom.x1 - state.zoom.x0;
    ctx.fillStyle = "#c9d1d9";
    ctx.textAlign = "right";
    ctx.fillText(`${formatSI(tdiv * zoomF, "s")}/div${zoomF < 0.999 ? " (zoom)" : ""}`, g.x + g.pw - 2, y);
    const multi = new Set(waves.map(({ w }) => (w.volts.length * w.dt).toPrecision(4)));
    if (multi.size > 1) {
      ctx.fillStyle = "#ffb86b";
      ctx.textAlign = "center";
      ctx.fillText("channels have different timebases: switch to Volts view to compare in seconds", g.x + g.pw / 2, g.y + 16);
    }
  }
}

function drawCursors(g, map, cap) {
  const c = state.cursors;
  const box = $("#cursorBox");
  if (!c.on || !cap) { box.hidden = true; return; }
  const waves = visibleWaves(cap);
  const z = state.zoom;
  const tAt = (fx, w) => (z.x0 + fx * (z.x1 - z.x0)) * (state.view === "scope" ? w.volts.length * w.dt : map.T);
  const lines = [];
  const vals = {};
  for (const [key, fx] of [["A", c.a], ["B", c.b]]) {
    if (fx == null) continue;
    const x = g.x + fx * g.pw;
    ctx.save();
    ctx.strokeStyle = "#e6edf3";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, g.y); ctx.lineTo(x, g.y + g.ph); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#e6edf3";
    ctx.font = "bold 12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(key, x, g.y + 12);
    for (const { w, i } of waves) {
      const t = tAt(fx, w) - (w.t0 || 0);
      const idx = Math.round(t / w.dt);
      if (idx < 0 || idx >= w.volts.length) continue;
      const v = w.volts[idx];
      (vals[w.name] ||= {})[key] = v;
      ctx.fillStyle = colorOf(w.name, i);
      ctx.beginPath(); ctx.arc(map.x(w, idx), map.y(w, v), 4, 0, 7); ctx.fill();
    }
    ctx.restore();
  }
  const ref = waves[0]?.w;
  if (ref) {
    const ta = c.a != null ? tAt(c.a, ref) : null;
    const tb = c.b != null ? tAt(c.b, ref) : null;
    if (ta != null) lines.push(`A  ${formatSI(ta, "s", 4).padStart(10)}`);
    if (tb != null) lines.push(`B  ${formatSI(tb, "s", 4).padStart(10)}`);
    if (ta != null && tb != null) {
      lines.push(`Δt ${formatSI(tb - ta, "s", 4).padStart(10)}   1/Δt ${formatSI(1 / Math.abs(tb - ta), "Hz", 4)}`);
    }
  }
  for (const [name, v] of Object.entries(vals)) {
    const parts = [`${name.padEnd(4)}`];
    if (v.A != null) parts.push(`A ${formatSI(v.A, "V", 4)}`);
    if (v.B != null) parts.push(`B ${formatSI(v.B, "V", 4)}`);
    if (v.A != null && v.B != null) parts.push(`ΔV ${formatSI(v.B - v.A, "V", 4)}`);
    lines.push(parts.join("  "));
  }
  box.hidden = !lines.length;
  box.textContent = lines.length ? lines.join("\n") : "";
}

function draw() {
  const g = geometry();
  const cap = state.capture;
  const map = mapping(g, cap);
  drawGrid(g, map);
  if (!cap) return;
  if (state.persist && state.frameIndex < 0) {
    const hist = state.history.slice(0, -1);
    hist.forEach((h, k) => {
      for (const { w, i } of visibleWaves(h)) drawTrace(g, map, w, colorOf(w.name, i), 0.08 + 0.25 * (k / hist.length));
    });
  }
  if (state.refs) for (const w of state.refs) if (!state.hidden.has(w.name)) drawTrace(g, map, w, REF_COLOR, 1, true);
  for (const { w, i } of visibleWaves(cap)) drawTrace(g, map, w, colorOf(w.name, i));
  drawLabels(g, map, cap);
  drawCursors(g, map, cap);
}

// ------------------------------------------------------------- interaction ---

function plotFraction(ev) {
  const g = geometry();
  const r = canvas.getBoundingClientRect();
  return { fx: (ev.clientX - r.left - g.x) / g.pw, fy: (ev.clientY - r.top - g.y) / g.ph, g };
}

let drag = null;
canvas.addEventListener("pointerdown", (ev) => {
  if (!state.capture) return;
  const { fx, g } = plotFraction(ev);
  canvas.setPointerCapture(ev.pointerId);
  const c = state.cursors;
  if (c.on) {
    const near = (p) => p != null && Math.abs(p - fx) * g.pw < 10;
    let which = near(c.a) ? "a" : near(c.b) ? "b" : null;
    if (!which) {
      which = c.a == null ? "a" : c.b == null ? "b" : (Math.abs(c.a - fx) < Math.abs(c.b - fx) ? "a" : "b");
      c[which] = Math.max(0, Math.min(1, fx));
      draw();
    }
    drag = { mode: "cursor", which };
  } else {
    drag = { mode: "pan", startFx: fx, x0: state.zoom.x0, x1: state.zoom.x1 };
  }
});
canvas.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const { fx } = plotFraction(ev);
  if (drag.mode === "cursor") {
    state.cursors[drag.which] = Math.max(0, Math.min(1, fx));
  } else {
    const span = drag.x1 - drag.x0;
    let x0 = drag.x0 - (fx - drag.startFx) * span;
    x0 = Math.max(0, Math.min(1 - span, x0));
    state.zoom.x0 = x0;
    state.zoom.x1 = x0 + span;
  }
  draw();
});
canvas.addEventListener("pointerup", () => { drag = null; });
canvas.addEventListener("dblclick", resetZoom);
canvas.addEventListener("wheel", (ev) => {
  if (!state.capture) return;
  ev.preventDefault();
  const f = Math.exp(ev.deltaY * 0.0015);
  const z = state.zoom;
  if (ev.shiftKey) {
    z.yScale = Math.max(0.1, Math.min(100, z.yScale / f));
  } else {
    const { fx } = plotFraction(ev);
    const pivot = z.x0 + Math.max(0, Math.min(1, fx)) * (z.x1 - z.x0);
    let span = Math.max(0.002, Math.min(1, (z.x1 - z.x0) * f));
    let x0 = pivot - (pivot - z.x0) * span / (z.x1 - z.x0);
    x0 = Math.max(0, Math.min(1 - span, x0));
    z.x0 = x0;
    z.x1 = x0 + span;
  }
  draw();
}, { passive: false });

function resetZoom() {
  state.zoom = { x0: 0, x1: 1, yScale: 1, yCenter: null };
  draw();
}

// -------------------------------------------------------------- controls ---

function fillSelect(sel, values) {
  sel.innerHTML = values.map((v) => `<option>${esc(v)}</option>`).join("");
}

function buildControls() {
  const caps = state.driver?.capabilities;
  const card = $("#cardControls");
  card.hidden = !caps?.control;
  if (!caps?.control) return;
  const c = caps.controls;
  $("#chanControls").innerHTML = c.channels.map((ch) => `
    <div class="chan-ctl" data-ch="${ch}">
      <div class="head"><span><span class="swatch" style="background:${colorOf(ch, 0)}"></span>${ch}</span>
        <label class="small"><input type="checkbox" data-ctl="channel_display" checked> On</label></div>
      <label class="field">Volts/div <select data-ctl="volts_div">${c.volts_div.map((v) => `<option>${v}</option>`).join("")}</select></label>
      <label class="field">Coupling <select data-ctl="coupling">${c.coupling.map((v) => `<option>${v}</option>`).join("")}</select></label>
      <label class="field">Probe <select data-ctl="probe">${c.probe.map((v) => `<option>${v}</option>`).join("")}</select></label>
      <label class="field">Position (div) <input type="number" step="0.2" value="0" data-ctl="position"></label>
    </div>`).join("");
  fillSelect($("#ctlTimebase"), c.timebase);
  fillSelect($("#ctlTrigSource"), c.trigger_source);
  fillSelect($("#ctlTrigSlope"), c.trigger_slope);
  fillSelect($("#ctlTrigSweep"), c.trigger_sweep);
}

// Reflect device settings in the controls (without overriding a field being edited).
function syncControls(settings) {
  if ($("#cardControls").hidden || !settings) return;
  const setSel = (sel, value) => {
    if (value == null || sel === document.activeElement) return;
    const opt = [...sel.options].find((o) => o.value.toLowerCase() === String(value).toLowerCase().replace(/\s/g, ""));
    if (opt) sel.value = opt.value;
  };
  for (const [ch, s] of Object.entries(settings.channels || {})) {
    const box = $(`.chan-ctl[data-ch="${ch}"]`);
    if (!box) continue;
    const disp = box.querySelector('[data-ctl="channel_display"]');
    if (disp !== document.activeElement) disp.checked = !!s.display;
    setSel(box.querySelector('[data-ctl="volts_div"]'), s.volts_div);
    setSel(box.querySelector('[data-ctl="coupling"]'), s.coupling);
    setSel(box.querySelector('[data-ctl="probe"]'), s.probe);
  }
  setSel($("#ctlTimebase"), settings.timebase);
  const t = settings.trigger || {};
  setSel($("#ctlTrigSource"), t.source);
  setSel($("#ctlTrigSlope"), t.slope);
  setSel($("#ctlTrigSweep"), t.sweep);
}

async function control(action, params = {}) {
  if (!state.driver) return;
  try {
    await state.driver.apply(action, params);
    if (!state.live) await captureOnce();
  } catch (e) {
    toast(e.message, true);
  }
}

// ----------------------------------------------------------------- wiring ---

function bind() {
  $("#btnConnectUsb").onclick = connectUsb;
  $("#btnDemo").onclick = startDemo;
  $("#fileInput").onchange = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const rec = await openFile(file);
      loadRecording(rec);
      toast(`Opened “${rec.name}” (${rec.frames.length} frame${rec.frames.length === 1 ? "" : "s"})`);
    } catch (e) {
      toast(`Could not open file: ${e.message}`, true);
    }
  };
  $$(".welcome-actions button").forEach((b) => {
    b.onclick = () => ({ usb: connectUsb, demo: startDemo, open: () => $("#fileInput").click() }[b.dataset.act]());
  });
  $("#deviceSelect").onchange = (ev) => selectDriver(ev.target.value);
  $("#btnDisconnect").onclick = disconnect;

  $("#btnLive").onclick = () => (state.live ? stopLive() : startLive());
  $("#btnOnce").onclick = () => { state.frameIndex = -1; $("#frameBadge").hidden = true; captureOnce(); };
  $("#intervalSelect").onchange = (ev) => { state.interval = +ev.target.value; };
  $("#btnRec").onclick = toggleRecord;
  $("#btnPlay").onclick = togglePlay;
  $("#timeline").oninput = (ev) => { state.playing = false; scrubTo(+ev.target.value); };

  $$(".seg button").forEach((b) => {
    b.onclick = () => {
      $$(".seg button").forEach((x) => x.classList.toggle("on", x === b));
      state.view = b.dataset.view;
      resetZoom();
    };
  });
  $("#btnCursors").onclick = () => {
    const c = state.cursors;
    c.on = !c.on;
    if (c.on && c.a == null) { c.a = 0.3; c.b = 0.7; }
    $("#btnCursors").classList.toggle("on", c.on);
    draw();
  };
  $("#btnPersist").onclick = () => {
    state.persist = !state.persist;
    $("#btnPersist").classList.toggle("on", state.persist);
    draw();
  };
  $("#btnRef").onclick = () => {
    if (state.refs) { state.refs = null; $("#btnRef").textContent = "Save REF"; $("#btnRef").classList.remove("on"); }
    else if (state.capture) {
      state.refs = state.capture.waveforms.map((w) => ({ ...w, volts: Float32Array.from(w.volts) }));
      $("#btnRef").textContent = "Clear REF";
      $("#btnRef").classList.add("on");
    }
    draw();
  };
  $("#btnZoomReset").onclick = resetZoom;
  $("#btnFullscreen").onclick = () => {
    const el = $(".screen-wrap");
    document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.();
  };

  $("#channelList").onchange = (ev) => {
    const ch = ev.target.dataset.ch;
    if (!ch) return;
    ev.target.checked ? state.hidden.delete(ch) : state.hidden.add(ch);
    renderMeasurements();
    draw();
  };

  $("#cardControls").addEventListener("click", (ev) => {
    const cmd = ev.target.dataset?.cmd;
    if (cmd) control(cmd);
  });
  $("#cardControls").addEventListener("change", (ev) => {
    const t = ev.target;
    const box = t.closest(".chan-ctl");
    if (box && t.dataset.ctl) {
      const value = t.type === "checkbox" ? t.checked : t.value;
      return control(t.dataset.ctl, { channel: box.dataset.ch, value });
    }
    const map = { ctlTimebase: "timebase", ctlTrigSource: "trigger_source", ctlTrigSlope: "trigger_slope",
                  ctlTrigSweep: "trigger_sweep", ctlTrigLevel: "trigger_level" };
    if (map[t.id]) control(map[t.id], { value: t.value });
  });

  $("#btnScreenshot").onclick = async () => {
    try {
      const blob = await state.driver.screenshot();
      const url = URL.createObjectURL(blob);
      $("#shotImg").src = url;
      $("#shotSave").href = url;
      $("#shotDialog").showModal();
    } catch (e) {
      toast(e.message, true);
    }
  };
  $("#btnRaw").onclick = async () => {
    const blob = await state.driver?.rawBlob();
    if (!blob) return toast("Capture something first.", true);
    download(blob, `owon_raw_${stamp()}.${state.driver.info.protocol === "owon-scpi" ? "json" : "bin"}`);
  };
  $("#btnCsv").onclick = () => {
    if (!state.capture) return toast("Nothing to export yet.", true);
    download(new Blob([captureToCsv(state.capture)], { type: "text/csv" }), `owon_${stamp()}.csv`);
  };
  $("#btnPng").onclick = () => {
    if (!state.capture) return toast("Nothing to export yet.", true);
    canvas.toBlob((b) => download(b, `owon_${stamp()}.png`));
  };
  $("#btnSaveRec").onclick = async () => {
    if (!state.rec?.frames.length) return toast("Nothing recorded yet. Press ● Rec while live.", true);
    download(await recordingToBlob(state.rec), `${state.rec.name.replace(/[^\w.-]+/g, "_")}.owonrec`);
  };
  $("#btnLibSave").onclick = saveToLibrary;
  $("#libraryList").onclick = (ev) => {
    const act = ev.target.dataset?.lib;
    if (act) libraryAction(act, ev.target.closest("li").dataset.id);
  };
  $("#kbdHelp").onclick = () => $("#helpDialog").showModal();
  $("#btnHelp").onclick = () => openGuide();
  document.addEventListener("click", (ev) => {
    const g = ev.target.closest('[data-act="guide"]');
    if (g) { ev.preventDefault(); openGuide(); }
  });
  $$(".guide-tabs button").forEach((b) => { b.onclick = () => showGuideTab(b.dataset.os); });
  $$("[data-copy]").forEach((b) => {
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText($(`#${b.dataset.copy}`).textContent);
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = "Copy"; }, 1500);
      } catch {
        toast("Select the text and copy it with Ctrl+C.", true);
      }
    };
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.target.closest("input, select, textarea, dialog") || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    const actions = {
      " ": () => (state.live ? stopLive() : startLive()),
      c: () => $("#btnOnce").click(), r: toggleRecord, p: togglePlay,
      k: () => $("#btnCursors").click(), f: () => $("#btnFullscreen").click(),
      arrowleft: () => state.rec && scrubTo((state.frameIndex < 0 ? state.rec.frames.length - 1 : state.frameIndex) - 1),
      arrowright: () => state.rec && scrubTo((state.frameIndex < 0 ? state.rec.frames.length - 1 : state.frameIndex) + 1),
    };
    if (actions[k]) { ev.preventDefault(); actions[k](); }
  });

  new ResizeObserver(() => draw()).observe(canvas);

  if (webUsbSupported()) {
    navigator.usb.addEventListener("disconnect", (ev) => {
      for (const [id, d] of state.drivers) {
        if (d.kind === "webusb" && d.t?.device === ev.device) {
          if (state.driver?.id === id) {
            onConnectionLost(new Error("device disconnected"));
          } else {
            state.drivers.delete(id);
          }
        }
      }
      renderDeviceSelect();
    });
    navigator.usb.addEventListener("connect", () => autoConnectWebUsb());
  }
}

async function init() {
  bind();
  draw();
  renderLibrary();
  state.serverMode = await serverAvailable();
  const note = $("#welcomeNote");
  if (state.serverMode) {
    $("#btnConnectUsb").textContent = "Rescan USB";
    $("#btnConnectUsb").title = "Look for scopes connected to the computer running owon-scope-web";
    $(".welcome-actions [data-act=usb]").textContent = "Find my scope";
    note.textContent = "Running with the local app: scopes connected to this computer are detected automatically.";
    await loadServerDevices(true);
    window.addEventListener("focus", () => { if (!state.driver) loadServerDevices(true); });
  } else if (webUsbSupported()) {
    note.innerHTML = 'Works in Chrome and Edge. First time? Follow the <a href="#" data-act="guide">setup guide</a> (Linux and Windows need a one-time step). Nothing is uploaded: data stays in your browser.';
    await autoConnectWebUsb();
  } else {
    note.innerHTML = 'This browser can\'t use USB devices. Use Chrome or Edge, or the local app — see the <a href="#" data-act="guide">setup guide</a>.';
    $("#btnConnectUsb").disabled = true;
    $(".welcome-actions [data-act=usb]").disabled = true;
  }
  if ($("#buildId").textContent.includes("BUILD")) $("#buildId").textContent = "dev";
  const params = new URLSearchParams(location.search);
  if (params.has("demo") && !state.driver) startDemo();
  if (params.has("help")) openGuide();
}

init();
