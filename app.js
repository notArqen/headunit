'use strict';
// headunit UI skeleton: load, transport, trim, controls, presets, export.

const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const LS_STATE = 'headunit.state', LS_PRESETS = 'headunit.presets';

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc */ } };

let S = Object.assign(clone(DEFAULT_SETTINGS), lsGet(LS_STATE) || {});
let ctx = null, chain = null, analyser = null;
let buf = null, fileName = 'audio', peaks = null;
const trim = { start: 0, end: 0 };
const fade = { in: 0, out: 0, shape: 'power' };
let region = null; // trimmed copy of buf with fades baked in; this is what plays and exports
let src = null, playing = false, t0 = 0, off0 = 0, pos = 0;

const FADE_SHAPES = {
  linear: (x) => x,
  power: (x) => Math.sin(x * Math.PI / 2),
  scurve: (x) => 0.5 - 0.5 * Math.cos(x * Math.PI),
  exp: (x) => x * x * x,
};

// ---------------------------------------------------------------- control spec
const opts = (labels) => labels.map((l, i) => [i, l]);
const SECTIONS = [
  { title: 'Master', controls: [
    { k: 'volume', label: 'Volume', min: -40, max: 12, step: 0.5, unit: 'dB' },
    { k: 'preamp', label: 'Pre-amp (into effects)', min: -12, max: 12, step: 0.5, unit: 'dB' },
    { k: 'balance', label: 'Balance L/R', min: -1, max: 1, step: 0.05 },
    { k: 'limiter', label: 'Output limiter', type: 'check' },
    { k: 'bypass', label: 'Bypass all effects (A/B)', type: 'check' },
  ] },
  { title: 'Equalizer (13-band)', custom: 'eq' },
  { title: 'Bass', controls: [
    { k: 'bassBoost', label: 'Bass boost', min: 0, max: 12, step: 0.5, unit: 'dB' },
    { k: 'bassFreq', label: 'Bass boost freq', type: 'select', options: [40, 60, 80, 100, 150, 200].map((f) => [f, f + ' Hz']) },
    { k: 'bassRestore', label: 'Bass restore (harmonics)', min: 0, max: 1, step: 0.01 },
    { k: 'bassRestoreFreq', label: 'Bass restore below', type: 'select', options: [60, 80, 100, 120, 150].map((f) => [f, f + ' Hz']) },
  ] },
  { title: 'Restoration / enhancement', controls: [
    { k: 'supreme', label: 'Supreme+ (rebuild lost highs)', min: 0, max: 1, step: 0.01 },
    { k: 'exciter', label: 'Exciter amount', min: 0, max: 1, step: 0.01 },
    { k: 'exciterFreq', label: 'Exciter from', min: 1000, max: 10000, step: 100, unit: 'Hz' },
    { k: 'exciterDrive', label: 'Exciter drive', min: 1, max: 50, step: 1 },
  ] },
  { title: 'Sound field', controls: [
    { k: 'width', label: 'Space enhancement (width)', min: 0, max: 200, step: 5, unit: '%' },
    { k: 'realizer', label: 'Sound realizer', type: 'select', options: opts(['Off', 'Level 1', 'Level 2', 'Level 3']) },
    { k: 'vocal', label: 'Vocal boost', type: 'select', options: opts(['Off', 'Low', 'Mid', 'High']) },
    { k: 'stageEq', label: 'Stage lift', type: 'select', options: opts(['Off', 'Low', 'Mid', 'High']) },
  ] },
  { title: 'Subwoofer', controls: [
    { k: 'subOn', label: 'Subwoofer on', type: 'check' },
    { k: 'subLevel', label: 'Sub level', min: -24, max: 12, step: 0.5, unit: 'dB' },
    { k: 'subFreq', label: 'Sub crossover', type: 'select', options: [50, 60, 80, 100, 120, 150].map((f) => [f, f + ' Hz']) },
    { k: 'subPhase', label: 'Sub phase', type: 'select', options: [[0, '0°'], [180, '180°']] },
  ] },
  { title: 'Listening position / time alignment', controls: [
    { k: 'position', label: 'Position', type: 'select', options: opts(['Off', 'Front L (driver)', 'Front R', 'Custom']) },
    { k: 'alignL', label: 'Custom: delay L', min: 0, max: 10, step: 0.1, unit: 'ms' },
    { k: 'alignR', label: 'Custom: delay R', min: 0, max: 10, step: 0.1, unit: 'ms' },
  ] },
  { title: 'Compressor', controls: [
    { k: 'compOn', label: 'Compressor on', type: 'check' },
    { k: 'compThreshold', label: 'Threshold', min: -50, max: 0, step: 1, unit: 'dB' },
    { k: 'compRatio', label: 'Ratio', min: 1, max: 20, step: 0.5, unit: ':1' },
    { k: 'compAttack', label: 'Attack', min: 0, max: 100, step: 1, unit: 'ms' },
    { k: 'compRelease', label: 'Release', min: 10, max: 1000, step: 10, unit: 'ms' },
    { k: 'compMakeup', label: 'Makeup gain', min: 0, max: 18, step: 0.5, unit: 'dB' },
  ] },
  { title: 'Loudness / drive EQ', controls: [
    { k: 'loudness', label: 'Loudness', type: 'select', options: opts(['Off', 'Low', 'High']) },
    { k: 'driveEq', label: 'Drive EQ (road-noise comp)', type: 'check' },
  ] },
  { title: 'Filters', controls: [
    { k: 'hpf', label: 'High-pass (20 = off)', min: 20, max: 300, step: 5, unit: 'Hz' },
    { k: 'lpf', label: 'Low-pass (20000 = off)', min: 1000, max: 20000, step: 100, unit: 'Hz' },
  ] },
];

const refs = {}; // key → { ctl, input, out }

function fmtVal(ctl, v) {
  if (ctl.type === 'check') return '';
  if (ctl.type === 'select') return '';
  return (+v).toString() + (ctl.unit ? ' ' + ctl.unit : '');
}

function readInput(ctl, el) {
  if (ctl.type === 'check') return el.checked;
  if (ctl.type === 'select') return Number(el.value);
  return Number(el.value);
}

function writeInput(ctl, el, v) {
  if (ctl.type === 'check') el.checked = !!v;
  else el.value = v;
}

function makeControl(parent, ctl) {
  const row = document.createElement('div');
  const label = document.createElement('label');
  label.textContent = ctl.label + ' ';
  let el;
  if (ctl.type === 'check') {
    el = document.createElement('input'); el.type = 'checkbox';
  } else if (ctl.type === 'select') {
    el = document.createElement('select');
    for (const [v, l] of ctl.options) { const o = document.createElement('option'); o.value = v; o.textContent = l; el.appendChild(o); }
  } else {
    el = document.createElement('input'); el.type = 'range';
    el.min = ctl.min; el.max = ctl.max; el.step = ctl.step;
  }
  const out = document.createElement('output');
  label.appendChild(el);
  row.appendChild(label); row.appendChild(document.createTextNode(' ')); row.appendChild(out);
  parent.appendChild(row);
  el.addEventListener('input', () => {
    setPath(ctl.k, readInput(ctl, el));
    if (ctl.k.startsWith('eq.')) { S.eqPreset = 'User'; refreshUI(); }
    out.textContent = fmtVal(ctl, readInput(ctl, el));
    changed();
  });
  // double-click a slider to zero it (or to its default)
  if (ctl.type !== 'check' && ctl.type !== 'select') {
    el.addEventListener('dblclick', () => {
      const d = getPath(ctl.k, DEFAULT_SETTINGS);
      setPath(ctl.k, d); refreshUI(); changed();
    });
  }
  refs[ctl.k] = { ctl, input: el, out };
}

function getPath(k, obj = S) {
  const [a, b] = k.split('.');
  return b === undefined ? obj[a] : obj[a][+b];
}
function setPath(k, v) {
  const [a, b] = k.split('.');
  if (b === undefined) S[a] = v; else S[a][+b] = v;
}

function buildControls() {
  const root = $('controls');
  for (const sec of SECTIONS) {
    const fs = document.createElement('fieldset');
    const lg = document.createElement('legend'); lg.textContent = sec.title; fs.appendChild(lg);
    if (sec.custom === 'eq') buildEq(fs);
    else sec.controls.forEach((c) => makeControl(fs, c));
    root.appendChild(fs);
  }
}

function buildEq(fs) {
  const row = document.createElement('div');
  const lbl = document.createElement('label'); lbl.textContent = 'Preset ';
  const sel = document.createElement('select'); sel.id = 'eqPreset';
  for (const name of [...Object.keys(EQ_PRESETS), 'User']) {
    const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    if (EQ_PRESETS[sel.value]) { S.eq = EQ_PRESETS[sel.value].slice(); S.eqPreset = sel.value; refreshUI(); changed(); }
  });
  lbl.appendChild(sel); row.appendChild(lbl);
  fs.appendChild(row);
  makeControl(fs, { k: 'eqQ', label: 'Band width (Q)', min: 0.5, max: 4, step: 0.1 });
  EQ_FREQS.forEach((f, i) => {
    const name = f >= 1000 ? (f / 1000) + 'k' : f;
    makeControl(fs, { k: 'eq.' + i, label: name + ' Hz', min: -12, max: 12, step: 0.5, unit: 'dB' });
  });
}

function refreshUI() {
  for (const k in refs) {
    const { ctl, input, out } = refs[k];
    const v = getPath(k);
    writeInput(ctl, input, v);
    out.textContent = fmtVal(ctl, v);
  }
  const sel = $('eqPreset'); if (sel) sel.value = S.eqPreset;
}

function changed() {
  if (chain) chain.apply(S);
  lsSet(LS_STATE, S);
}

// ---------------------------------------------------------------- audio setup
function ensureCtx() {
  if (ctx) return;
  ctx = new AudioContext();
  chain = createChain(ctx);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.75;
  chain.output.connect(analyser);
  analyser.connect(ctx.destination);
  chain.apply(S);
}

async function loadFile(file) {
  ensureCtx();
  $('info').textContent = 'decoding ' + file.name + '…';
  try {
    const b = await ctx.decodeAudioData(await file.arrayBuffer());
    fileName = file.name.replace(/\.[^.]+$/, '');
    loadBuffer(b);
  } catch (e) {
    $('info').textContent = 'could not decode ' + file.name + ': ' + e.message;
  }
}

function loadBuffer(b) {
  ensureCtx();
  stop();
  buf = b;
  trim.start = 0; trim.end = b.duration; pos = 0;
  computePeaks();
  syncTrimUI();
  bake();
  for (const id of ['play', 'pause', 'stop', 'setStart', 'setEnd', 'resetTrim', 'export']) $(id).disabled = false;
  $('info').textContent = `${fileName}: ${fmtTime(b.duration)}, ${b.sampleRate} Hz, ${b.numberOfChannels} ch`;
}

// ---------------------------------------------------------------- transport
function position() {
  if (!playing) return pos;
  let p = off0 + (ctx.currentTime - t0);
  if (src && src.loop) {
    const len = trim.end - trim.start;
    if (p >= trim.end && len > 0) p = trim.start + ((p - trim.start) % len);
  }
  return Math.min(p, trim.end);
}

function killSource() {
  if (!src) return;
  src.onended = null;
  try { src.stop(); } catch { /* not started */ }
  src.disconnect();
  src = null;
}

function play(from) {
  if (!buf) return;
  ctx.resume();
  killSource();
  let at = from ?? pos;
  if (at < trim.start || at >= trim.end - 0.01) at = trim.start;
  const s = ctx.createBufferSource();
  s.buffer = region;
  s.connect(chain.input);
  s.loop = $('loop').checked;
  s.start(0, at - trim.start);
  s.onended = () => { if (src === s) { playing = false; pos = trim.start; src = null; } };
  src = s; t0 = ctx.currentTime; off0 = at; playing = true;
}

function pause() { if (!playing) return; pos = position(); killSource(); playing = false; }
function stop() { killSource(); playing = false; pos = trim.start; }
function seek(t) { pos = Math.max(0, Math.min(t, buf ? buf.duration : 0)); if (playing) play(pos); }

// ---------------------------------------------------------------- trim
function syncTrimUI() {
  const d = buf ? buf.duration : 0;
  for (const id of ['trimStart', 'trimEnd']) $(id).max = d.toFixed(2);
  $('trimStart').value = trim.start.toFixed(2);
  $('trimEnd').value = trim.end.toFixed(2);
  $('trimLen').textContent = buf ? 'length ' + fmtTime(trim.end - trim.start) : '';
}

// commit=false is used while dragging: move the markers, re-bake on release.
function setTrim(start, end, commit = true) {
  if (!buf) return;
  const d = buf.duration;
  start = Math.max(0, Math.min(start, d));
  end = Math.max(0, Math.min(end, d));
  if (end - start < 0.05) return syncTrimUI();
  const p = position();
  trim.start = start; trim.end = end;
  syncTrimUI();
  if (commit) rebake(p);
}

function syncFadeUI() {
  $('fadeIn').value = fade.in.toFixed(2);
  $('fadeOut').value = fade.out.toFixed(2);
  $('fadeShape').value = fade.shape;
}

// keep fades inside the region (in + out can't exceed its length)
function clampFades() {
  const len = trim.end - trim.start;
  fade.in = Math.max(0, fade.in); fade.out = Math.max(0, fade.out);
  if (fade.in + fade.out > len) { const k = len / (fade.in + fade.out); fade.in *= k; fade.out *= k; }
}

function setFades(fi, fo, commit = true) {
  fade.in = fi; fade.out = fo;
  clampFades(); syncFadeUI();
  if (commit) rebake(position());
}

function bake() {
  if (!buf) return;
  clampFades();
  const sr = buf.sampleRate;
  const a = Math.round(trim.start * sr), b = Math.round(trim.end * sr), len = Math.max(1, b - a);
  const r = new AudioBuffer({ length: len, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  const fi = Math.round(fade.in * sr), fo = Math.round(fade.out * sr), curve = FADE_SHAPES[fade.shape];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = r.getChannelData(c);
    d.set(buf.getChannelData(c).subarray(a, a + len));
    for (let i = 0; i < fi; i++) d[i] *= curve(i / fi);
    for (let i = 0; i < fo; i++) d[len - 1 - i] *= curve(i / fo);
  }
  region = r;
}

function rebake(p) {
  bake();
  if (playing) play(Math.min(Math.max(p, trim.start), trim.end - 0.02));
  else if (pos < trim.start || pos > trim.end) pos = trim.start;
}

// ---------------------------------------------------------------- drawing
function computePeaks() {
  const W = $('wave').width;
  const ch = [];
  for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
  const per = Math.max(1, Math.floor(buf.length / W));
  peaks = new Float32Array(W * 2);
  for (let x = 0; x < W; x++) {
    let mn = 1, mx = -1;
    const a = x * per, b = Math.min(a + per, buf.length);
    for (let i = a; i < b; i += 4) {
      for (const d of ch) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    peaks[x * 2] = mn; peaks[x * 2 + 1] = mx;
  }
}

function drawWave() {
  const cv = $('wave'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  if (!buf) return;
  const d = buf.duration;
  const xs = (trim.start / d) * W, xe = (trim.end / d) * W;
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(0, 0, xs, H); g.fillRect(xe, 0, W - xe, H);
  g.fillStyle = '#444';
  for (let x = 0; x < W; x++) {
    const y1 = (1 - peaks[x * 2 + 1]) * H / 2, y2 = (1 - peaks[x * 2]) * H / 2;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  g.fillStyle = 'blue'; g.fillRect(xs, 0, 2, H); g.fillRect(xe - 2, 0, 2, H);

  // fade curves + handles
  const curve = FADE_SHAPES[fade.shape];
  const xfi = ((trim.start + fade.in) / d) * W, xfo = ((trim.end - fade.out) / d) * W;
  g.strokeStyle = 'orange'; g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= 40; i++) { const x = xs + (xfi - xs) * i / 40; const y = H - curve(i / 40) * H; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.lineTo(xfo, 0);
  for (let i = 0; i <= 40; i++) { const x = xfo + (xe - xfo) * i / 40; const y = H - curve(1 - i / 40) * H; g.lineTo(x, y); }
  g.stroke();
  g.fillStyle = 'orange';
  g.fillRect(xfi - HANDLE / 2, 0, HANDLE, HANDLE);
  g.fillRect(xfo - HANDLE / 2, 0, HANDLE, HANDLE);

  g.fillStyle = 'red'; g.fillRect((position() / d) * W, 0, 2, H);
}

// ---------------------------------------------------------------- waveform dragging
const HANDLE = 14; // canvas px
let drag = null; // { kind: 'start'|'end'|'fadeIn'|'fadeOut'|'select'|'seek', x0, t0 }

function waveHit(e) {
  const cv = $('wave'), r = cv.getBoundingClientRect();
  const sx = cv.width / r.width, sy = cv.height / r.height;
  const x = (e.clientX - r.left) * sx, y = (e.clientY - r.top) * sy;
  const d = buf.duration, W = cv.width, tx = (t) => (t / d) * W;
  const t = Math.max(0, Math.min(d, (x / W) * d));
  const near = (px, tol) => Math.abs(x - px) <= tol;
  let kind = null;
  if (y <= HANDLE + 2) {
    if (near(tx(trim.start + fade.in), HANDLE)) kind = 'fadeIn';
    else if (near(tx(trim.end - fade.out), HANDLE)) kind = 'fadeOut';
  }
  if (!kind && near(tx(trim.start), 8)) kind = 'start';
  else if (!kind && near(tx(trim.end), 8)) kind = 'end';
  return { kind, x, t };
}

function waveDown(e) {
  if (!buf) return;
  const h = waveHit(e);
  drag = { kind: h.kind || 'seek', x0: h.x, t0: h.t };
  try { $('wave').setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
}

function waveMove(e) {
  if (!buf) return;
  const h = waveHit(e);
  if (!drag) {
    $('wave').style.cursor = h.kind ? 'ew-resize' : 'crosshair';
    return;
  }
  if (drag.kind === 'seek' && Math.abs(h.x - drag.x0) > 6) drag.kind = 'select';
  switch (drag.kind) {
    case 'start': setTrim(Math.min(h.t, trim.end - 0.05), trim.end, false); break;
    case 'end': setTrim(trim.start, Math.max(h.t, trim.start + 0.05), false); break;
    case 'select': setTrim(Math.min(drag.t0, h.t), Math.max(drag.t0, h.t), false); break;
    case 'fadeIn': setFades(h.t - trim.start, fade.out, false); break;
    case 'fadeOut': setFades(fade.in, trim.end - h.t, false); break;
  }
}

function waveUp(e) {
  if (!drag) return;
  const k = drag.kind; drag = null;
  if (k === 'seek') return seek(waveHit(e).t);
  setFades(fade.in, fade.out, false); // re-clamp to the new region
  rebake(position());
}

let specData = null, timeData = null, peakHold = -Infinity, peakHoldT = 0;
function drawSpectrum() {
  const cv = $('spec'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  if (!analyser) return;
  if (!specData) { specData = new Float32Array(analyser.frequencyBinCount); timeData = new Float32Array(analyser.fftSize); }
  analyser.getFloatFrequencyData(specData);
  const nyq = ctx.sampleRate / 2, lo = Math.log10(20), hi = Math.log10(20000);
  g.fillStyle = '#444';
  const bars = 120;
  for (let i = 0; i < bars; i++) {
    const f1 = Math.pow(10, lo + (hi - lo) * (i / bars)), f2 = Math.pow(10, lo + (hi - lo) * ((i + 1) / bars));
    const b1 = Math.floor(f1 / nyq * specData.length), b2 = Math.max(b1 + 1, Math.floor(f2 / nyq * specData.length));
    let m = -Infinity;
    for (let b = b1; b < b2 && b < specData.length; b++) m = Math.max(m, specData[b]);
    const h = Math.max(0, (m + 100) / 100) * H;
    g.fillRect(i * (W / bars), H - h, W / bars - 1, h);
  }
  g.fillStyle = '#888'; g.font = '12px sans-serif';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000]) {
    const x = (Math.log10(f) - lo) / (hi - lo) * W;
    g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 2, 12);
  }

  analyser.getFloatTimeDomainData(timeData);
  let pk = 0; for (const v of timeData) pk = Math.max(pk, Math.abs(v));
  const pdb = 20 * Math.log10(pk || 1e-9);
  const now = performance.now();
  if (pdb > peakHold || now - peakHoldT > 1500) { peakHold = pdb; peakHoldT = now; }
  $('peak').textContent = 'peak: ' + (peakHold < -90 ? '-∞' : peakHold.toFixed(1)) + ' dBFS' + (peakHold > -0.1 ? ' CLIP' : '');
}

function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + s.toFixed(2).padStart(5, '0');
}

function frame() {
  drawWave();
  drawSpectrum();
  if (buf) $('time').textContent = fmtTime(position()) + ' / ' + fmtTime(buf.duration);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- export
async function exportAudio() {
  if (!buf) return;
  const bits = Number($('exportBits').value);
  const sr = buf.sampleRate;
  const len = region.length, dur = len / sr;
  $('exportStatus').textContent = 'rendering…';
  $('export').disabled = true;
  try {
    const oc = new OfflineAudioContext(2, len, sr);
    const c = createChain(oc);
    c.apply(S);
    c.output.connect(oc.destination);
    const s = oc.createBufferSource();
    s.buffer = region; // already trimmed + faded, same buffer the live preview plays
    s.connect(c.input);
    s.start(0);
    const out = await oc.startRendering();
    const blob = encodeWav(out, bits);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName + ' (headunit).wav';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $('exportStatus').textContent = `done: ${(blob.size / 1048576).toFixed(1)} MB, ${fmtTime(dur)}`;
    window.__lastExport = { blob, buffer: out };
  } catch (e) {
    $('exportStatus').textContent = 'export failed: ' + e.message;
  } finally {
    $('export').disabled = false;
  }
}

// ---------------------------------------------------------------- presets
function presets() { return lsGet(LS_PRESETS) || {}; }
function refreshPresetList() {
  const sel = $('presetList'); sel.innerHTML = '';
  for (const name of Object.keys(presets())) { const o = document.createElement('option'); o.value = o.textContent = name; sel.appendChild(o); }
}

// ---------------------------------------------------------------- wiring
function wire() {
  $('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

  $('play').onclick = () => play();
  $('pause').onclick = pause;
  $('stop').onclick = stop;
  $('loop').onchange = () => { if (playing) play(position()); };
  $('wave').addEventListener('pointerdown', waveDown);
  $('wave').addEventListener('pointermove', waveMove);
  $('wave').addEventListener('pointerup', waveUp);
  $('wave').addEventListener('pointercancel', () => { drag = null; rebake(position()); });

  $('fadeIn').onchange = () => setFades(Number($('fadeIn').value) || 0, fade.out);
  $('fadeOut').onchange = () => setFades(fade.in, Number($('fadeOut').value) || 0);
  $('fadeShape').onchange = () => { fade.shape = $('fadeShape').value; rebake(position()); };
  $('clearFades').onclick = () => setFades(0, 0);

  $('trimStart').onchange = () => setTrim(Number($('trimStart').value), trim.end);
  $('trimEnd').onchange = () => setTrim(trim.start, Number($('trimEnd').value));
  $('setStart').onclick = () => setTrim(position(), trim.end);
  $('setEnd').onclick = () => setTrim(trim.start, position());
  $('resetTrim').onclick = () => buf && setTrim(0, buf.duration);

  $('presetSave').onclick = () => {
    const name = $('presetName').value.trim(); if (!name) return;
    const p = presets(); p[name] = clone(S); lsSet(LS_PRESETS, p); refreshPresetList(); $('presetList').value = name;
  };
  $('presetLoad').onclick = () => {
    const p = presets()[$('presetList').value]; if (!p) return;
    S = Object.assign(clone(DEFAULT_SETTINGS), clone(p)); refreshUI(); changed();
  };
  $('presetDelete').onclick = () => {
    const p = presets(); delete p[$('presetList').value]; lsSet(LS_PRESETS, p); refreshPresetList();
  };
  $('resetAll').onclick = () => { S = clone(DEFAULT_SETTINGS); refreshUI(); changed(); };

  $('export').onclick = exportAudio;

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    if (e.key === 'b') { S.bypass = !S.bypass; refreshUI(); changed(); }
  });
}

buildControls();
refreshUI();
syncFadeUI();
refreshPresetList();
wire();
requestAnimationFrame(frame);

// test hook
window.HU = { get S() { return S; }, set S(v) { S = v; refreshUI(); changed(); }, loadBuffer, ensureCtx, play, pause, stop, exportAudio, setTrim, setFades, position, get ctx() { return ctx; }, get region() { return region; }, get playing() { return playing; }, trim, fade };
