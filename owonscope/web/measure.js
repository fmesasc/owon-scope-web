// Automatic measurements on one waveform.

export function measure(w) {
  const v = w.volts;
  const n = v.length;
  if (!n) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
    sq += x * x;
  }
  const mean = sum / n;
  const res = { max, min, vpp: max - min, mean, rms: Math.sqrt(sq / n), freq: null, period: null, duty: null };

  // Frequency from mid-level crossings with 10% hysteresis (robust to noise).
  const mid = (max + min) / 2;
  const hyst = (max - min) * 0.1;
  // Below ~half a division it's noise, not a signal with a frequency.
  if (max - min <= 0 || max - min < 0.4 * (w.volts_per_div || 0)) return res;
  const rising = [];
  let state = v[0] > mid;
  for (let i = 0; i < n; i++) {
    if (!state && v[i] > mid + hyst) { state = true; rising.push(i); }
    else if (state && v[i] < mid - hyst) state = false;
  }
  if (rising.length >= 2) {
    const periodSamples = (rising[rising.length - 1] - rising[0]) / (rising.length - 1);
    res.period = periodSamples * w.dt;
    res.freq = 1 / res.period;
    const a = rising[0];
    const b = rising[rising.length - 1];
    let hi = 0;
    for (let i = a; i < b; i++) if (v[i] > mid) hi++;
    res.duty = hi / (b - a);
  } else if (w.frequency) {
    res.freq = w.frequency;
    res.period = 1 / w.frequency;
  }
  return res;
}
