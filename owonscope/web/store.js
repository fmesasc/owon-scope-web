// Recordings: in-browser library (IndexedDB), file export/import, CSV.

export const FILE_FORMAT = "owon-scope-web/recording";

// ---------------------------------------------------------------- encoding ---

function f32ToB64(arr) {
  const f = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToF32(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

export function encodeRecording(rec) {
  return JSON.stringify({
    format: FILE_FORMAT, version: 1, name: rec.name, created: rec.created, device: rec.device,
    frames: rec.frames.map((f) => ({ ...f, waveforms: f.waveforms.map((w) => ({ ...w, volts: f32ToB64(w.volts) })) })),
  });
}

export function decodeRecording(text) {
  const obj = JSON.parse(text);
  if (obj.format !== FILE_FORMAT) throw new Error("Not an owon-scope-web recording");
  for (const f of obj.frames) {
    for (const w of f.waveforms) w.volts = typeof w.volts === "string" ? b64ToF32(w.volts) : Float32Array.from(w.volts);
  }
  return { name: obj.name || "Recording", created: obj.created || Date.now(), device: obj.device || {}, frames: obj.frames };
}

async function gzip(text) {
  if (!("CompressionStream" in window)) return new Blob([text], { type: "application/json" });
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(stream).arrayBuffer()], { type: "application/gzip" });
}

async function gunzipIfNeeded(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(u8);
}

export async function recordingToBlob(rec) {
  return gzip(encodeRecording(rec));
}

/** Open a .owonrec (gzip JSON), plain JSON recording, or a CSV exported by this app. */
export async function openFile(file) {
  const text = await gunzipIfNeeded(await file.arrayBuffer());
  const base = file.name.replace(/\.(owonrec|json|csv|gz)$/gi, "");
  if (text.trimStart().startsWith("{")) {
    const rec = decodeRecording(text);
    rec.name = rec.name || base;
    return rec;
  }
  return { name: base, created: file.lastModified || Date.now(), device: { model: "CSV import" },
           frames: [csvToCapture(text)] };
}

// --------------------------------------------------------------------- CSV ---

export function captureToCsv(cap) {
  const cols = [];
  for (const w of cap.waveforms) {
    cols.push([`${w.name}_time_s`, (i) => (w.t0 + i * w.dt).toPrecision(9), w.volts.length]);
    cols.push([`${w.name}_volts`, (i) => (+w.volts[i]).toPrecision(7), w.volts.length]);
  }
  const rows = Math.max(...cols.map((c) => c[2]));
  const lines = [cols.map((c) => c[0]).join(",")];
  for (let i = 0; i < rows; i++) lines.push(cols.map((c) => (i < c[2] ? c[1](i) : "")).join(","));
  return lines.join("\n") + "\n";
}

export function csvToCapture(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((l) => l.split(","));
  const waveforms = [];
  for (let c = 0; c < header.length; c++) {
    const m = /^(.*)_(volts|v)$/i.exec(header[c]);
    if (!m) continue;
    const tc = header.findIndex((h) => h.toLowerCase() === `${m[1]}_time_s`.toLowerCase());
    const volts = [];
    const times = [];
    for (const r of rows) {
      if (r[c] === undefined || r[c] === "") break;
      volts.push(parseFloat(r[c]));
      if (tc >= 0) times.push(parseFloat(r[tc]));
    }
    const dt = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 1e-6;
    let vmax = 0;
    for (const v of volts) vmax = Math.max(vmax, Math.abs(v));
    waveforms.push({ name: m[1], volts: Float32Array.from(volts), dt, t0: times[0] || 0,
                     volts_per_div: niceStep(vmax / 3.5 || 1), position_div: 0, probe: 1,
                     coupling: null, frequency: null, extra: { source: "csv" } });
  }
  if (!waveforms.length) throw new Error("CSV has no '<name>_volts' columns");
  const span = Math.max(...waveforms.map((w) => w.dt * w.volts.length));
  return { timestamp: Date.now() / 1000, time_per_div: span / 10, h_divisions: 10, v_divisions: 8,
           settings: {}, waveforms };
}

export function niceStep(x) {
  const steps = [1, 2, 5];
  const e = Math.floor(Math.log10(x));
  for (const s of steps) if (s * 10 ** e >= x) return s * 10 ** e;
  return 10 ** (e + 1);
}

// --------------------------------------------------------------- IndexedDB ---

const DB_NAME = "owon-scope-web";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("meta", { keyPath: "id" });
      db.createObjectStore("frames", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage transaction aborted"));
    result = fn(t);
  });
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const library = {
  async list() {
    try {
      const db = await openDb();
      const t = db.transaction("meta");
      const all = await reqP(t.objectStore("meta").getAll());
      return all.sort((a, b) => b.created - a.created);
    } catch {
      return [];
    }
  },
  async save(rec) {
    const db = await openDb();
    const id = rec.id || `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const span = rec.frames.length > 1 ? rec.frames[rec.frames.length - 1].timestamp - rec.frames[0].timestamp : 0;
    const meta = { id, name: rec.name, created: rec.created, device: rec.device, count: rec.frames.length, span };
    await tx(db, ["meta", "frames"], "readwrite", (t) => {
      t.objectStore("meta").put(meta);
      t.objectStore("frames").put({ id, frames: rec.frames });
    });
    return meta;
  },
  async load(id) {
    const db = await openDb();
    const t = db.transaction(["meta", "frames"]);
    const meta = await reqP(t.objectStore("meta").get(id));
    const data = await reqP(t.objectStore("frames").get(id));
    return { ...meta, frames: data.frames };
  },
  async rename(id, name) {
    const db = await openDb();
    const t = db.transaction("meta", "readwrite");
    const meta = await reqP(t.objectStore("meta").get(id));
    meta.name = name;
    await reqP(t.objectStore("meta").put(meta));
  },
  async remove(id) {
    const db = await openDb();
    await tx(db, ["meta", "frames"], "readwrite", (t) => {
      t.objectStore("meta").delete(id);
      t.objectStore("frames").delete(id);
    });
  },
};
