'use strict';
// headunit UI: load, transport, waveform trim/fades, settings pages, EQ spectrum, presets, export.

const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const LS_STATE = 'headunit.state', LS_PRESETS = 'headunit.presets', LS_TAB = 'headunit.tab';
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc */ } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let S = Object.assign(clone(DEFAULT_SETTINGS), lsGet(LS_STATE) || {});
let ctx = null, chain = null, analyser = null, meterAn = null;
let buf = null, fileName = '', peaks = null;
const trim = { start: 0, end: 0 };
const fade = { in: 0, out: 0, shape: 'power' };
let region = null; // trimmed copy of buf with fades baked in; this is what plays and exports
let src = null, playing = false, looping = false, t0 = 0, off0 = 0, pos = 0;
let activeTab = lsGet(LS_TAB) || 'eq';

const FADE_SHAPES = {
  linear: (x) => x,
  power: (x) => Math.sin(x * Math.PI / 2),
  scurve: (x) => 0.5 - 0.5 * Math.cos(x * Math.PI),
  exp: (x) => x * x * x,
};

// ---------------------------------------------------------------- control spec
const opts = (labels) => labels.map((l, i) => [i, l]);
const pct = (v) => Math.round(v * 100) + '%';
const hz = (f) => (f >= 1000 ? (f / 1000).toFixed(f % 1000 ? 1 : 0) + 'k' : f) + '';

const MASTER = [
  { k: 'preamp', label: 'Pre-amp', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { k: 'balance', label: 'Balance', min: -1, max: 1, step: 0.05, fmt: (v) => (v === 0 ? 'C' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100)) },
  { k: 'limiter', label: 'Output limiter', type: 'check' },
];

const PAGES = [
  { id: 'eq', name: 'Equalizer', desc: 'Faders sit over the live spectrum, so you can see where the song lives.',
    on: (s) => s.eq.some((v) => v !== 0), custom: 'eq' },
  { id: 'bass', name: 'Bass', desc: 'Boost the lows, or rebuild them as harmonics small speakers can reproduce.',
    on: (s) => s.bassBoost > 0 || s.bassRestore > 0, controls: [
      { k: 'bassBoost', label: 'Bass boost', min: 0, max: 12, step: 0.5, unit: 'dB' },
      { k: 'bassFreq', label: 'Boost center (Hz)', type: 'seg', options: [40, 60, 80, 100, 150, 200].map((f) => [f, f]) },
      { k: 'bassRestore', label: 'Bass restore', min: 0, max: 1, step: 0.01, fmt: pct, hint: 'Psychoacoustic bass: adds harmonics so the sub is felt even when it can\'t be played.' },
      { k: 'bassRestoreFreq', label: 'Restore below (Hz)', type: 'seg', options: [60, 80, 100, 120, 150].map((f) => [f, f]) },
    ] },
  { id: 'restore', name: 'Restore', desc: 'Bring back the top end lost to compression, slowing or bad rips.',
    on: (s) => s.supreme > 0 || s.exciter > 0, controls: [
      { k: 'supreme', label: 'Supreme+', min: 0, max: 1, step: 0.01, fmt: pct, hint: 'Rebuilds the missing highs above 10 kHz from what\'s still in the song.' },
      { k: 'exciter', label: 'Exciter', min: 0, max: 1, step: 0.01, fmt: pct, hint: 'Harmonic sparkle on the presence band. Clarity without plain treble boost.' },
      { k: 'exciterFreq', label: 'Exciter from', min: 1000, max: 10000, step: 100, fmt: (v) => hz(v) + ' Hz' },
      { k: 'exciterDrive', label: 'Exciter drive', min: 1, max: 50, step: 1 },
    ] },
  { id: 'field', name: 'Sound field', desc: 'Width, ambience and where the vocal sits.',
    on: (s) => s.width !== 100 || s.realizer > 0 || s.vocal > 0 || s.stageEq > 0, controls: [
      { k: 'width', label: 'Space enhancement', min: 0, max: 200, step: 5, unit: '%', zero: 100, hint: 'Stereo width. 100% is untouched, 0% is mono.' },
      { k: 'realizer', label: 'Sound realizer', type: 'seg', options: opts(['Off', '1', '2', '3']), hint: 'Early reflections for a live-room feel.' },
      { k: 'vocal', label: 'Vocal boost', type: 'seg', options: opts(['Off', 'Low', 'Mid', 'High']), hint: 'Lifts the center only, so the vocal steps forward.' },
      { k: 'stageEq', label: 'Stage lift', type: 'seg', options: opts(['Off', 'Low', 'Mid', 'High']), hint: 'Raises the sound image toward ear level.' },
    ] },
  { id: 'sub', name: 'Subwoofer', desc: 'A virtual sub layered under the mix.',
    on: (s) => s.subOn, controls: [
      { k: 'subOn', label: 'Subwoofer', type: 'check' },
      { k: 'subLevel', label: 'Sub level', min: -24, max: 12, step: 0.5, unit: 'dB' },
      { k: 'subFreq', label: 'Crossover (Hz)', type: 'seg', options: [50, 60, 80, 100, 120, 150].map((f) => [f, f]) },
      { k: 'subPhase', label: 'Phase', type: 'seg', options: [[0, '0°'], [180, '180°']], hint: 'Flip if the bass gets thinner when the sub comes in.' },
    ] },
  { id: 'position', name: 'Position', desc: 'Time alignment: delay the near speaker so both sides arrive together.',
    on: (s) => s.position > 0, controls: [
      { k: 'position', label: 'Listening position', type: 'seg', options: opts(['Off', 'Front L', 'Front R', 'Custom']) },
      { k: 'alignL', label: 'Delay left', min: 0, max: 10, step: 0.1, unit: 'ms', hint: 'Custom position only.' },
      { k: 'alignR', label: 'Delay right', min: 0, max: 10, step: 0.1, unit: 'ms', hint: 'Custom position only.' },
    ] },
  { id: 'dyn', name: 'Dynamics', desc: 'Compressor. Evens out loud and quiet parts.',
    on: (s) => s.compOn, controls: [
      { k: 'compOn', label: 'Compressor', type: 'check' },
      { k: 'compThreshold', label: 'Threshold', min: -50, max: 0, step: 1, unit: 'dB' },
      { k: 'compRatio', label: 'Ratio', min: 1, max: 20, step: 0.5, fmt: (v) => v + ':1' },
      { k: 'compAttack', label: 'Attack', min: 0, max: 100, step: 1, unit: 'ms' },
      { k: 'compRelease', label: 'Release', min: 10, max: 1000, step: 10, unit: 'ms' },
      { k: 'compMakeup', label: 'Makeup gain', min: 0, max: 18, step: 0.5, unit: 'dB' },
    ] },
  { id: 'tone', name: 'Loudness', desc: 'Loudness contour, drive EQ and the crossover filters.',
    on: (s) => s.loudness > 0 || s.driveEq || s.hpf > 20 || s.lpf < 20000, controls: [
      { k: 'loudness', label: 'Loudness', type: 'seg', options: opts(['Off', 'Low', 'High']), hint: 'Lifts lows and highs that the ear loses at low volume.' },
      { k: 'driveEq', label: 'Drive EQ', type: 'check', hint: 'Compensates for road noise masking the lows and highs.' },
      { k: 'hpf', label: 'High-pass', min: 20, max: 300, step: 5, fmt: (v) => (v <= 20 ? 'Off' : v + ' Hz') },
      { k: 'lpf', label: 'Low-pass', min: 1000, max: 20000, step: 100, fmt: (v) => (v >= 20000 ? 'Off' : hz(v) + ' Hz'), zero: 20000 },
    ] },
];

const refs = {}; // key → { c, el, out, kind }

function getPath(k, obj = S) { const [a, b] = k.split('.'); return b === undefined ? obj[a] : obj[a][+b]; }
function setPath(k, v) { const [a, b] = k.split('.'); if (b === undefined) S[a] = v; else S[a][+b] = v; }

const fmtVal = (c, v) => (c.fmt ? c.fmt(v) : (+v).toString() + (c.unit ? ' ' + c.unit : ''));

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function setFill(input, c, v) {
  const min = +input.min, max = +input.max;
  const zero = c.zero != null ? c.zero : clamp(0, min, max);
  const p = (x) => ((x - min) / (max - min)) * 100;
  const a = Math.min(p(zero), p(v)), b = Math.max(p(zero), p(v));
  input.style.setProperty('--a', a + '%'); input.style.setProperty('--b', b + '%');
}

function makeControl(parent, c) {
  const kind = c.type || 'range';
  let root, input = null, out = null;
  const hint = c.hint ? el('div', 'ctl-hint', c.hint) : null;

  if (kind === 'check') {
    root = el('label', 'ctl ctl-toggle');
    const txt = el('div');
    txt.appendChild(el('div', 'ctl-label', c.label));
    if (hint) txt.appendChild(hint);
    input = el('input', 'switch'); input.type = 'checkbox';
    input.addEventListener('change', () => { setPath(c.k, input.checked); changed(); });
    root.append(txt, input);
  } else if (kind === 'seg') {
    root = el('div', 'ctl');
    const head = el('div', 'ctl-head'); head.appendChild(el('span', 'ctl-label', c.label));
    root.appendChild(head);
    if (hint) root.appendChild(hint);
    input = el('div', 'seg'); input.setAttribute('role', 'radiogroup'); input.setAttribute('aria-label', c.label);
    for (const [v, l] of c.options) {
      const b = el('button', null, l); b.type = 'button'; b.dataset.v = v;
      b.addEventListener('click', () => { setPath(c.k, Number(v)); refreshUI(); changed(); });
      input.appendChild(b);
    }
    root.appendChild(input);
  } else {
    root = el('div', 'ctl');
    const head = el('div', 'ctl-head');
    head.appendChild(el('span', 'ctl-label', c.label));
    out = el('output', 'ctl-val'); head.appendChild(out);
    root.appendChild(head);
    if (hint) root.appendChild(hint);
    input = el('input', 'slider'); input.type = 'range';
    input.min = c.min; input.max = c.max; input.step = c.step;
    input.setAttribute('aria-label', c.label);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      setPath(c.k, v); out.textContent = fmtVal(c, v); setFill(input, c, v); changed();
    });
    input.addEventListener('dblclick', () => { setPath(c.k, getPath(c.k, DEFAULT_SETTINGS)); refreshUI(); changed(); });
    root.appendChild(input);
  }
  parent.appendChild(root);
  refs[c.k] = { c, el: input, out, kind };
}

// ---------------------------------------------------------------- pages + menu
function buildUI() {
  const menu = $('menu'), panel = $('panel');
  for (const p of PAGES) {
    const b = el('button'); b.type = 'button'; b.dataset.tab = p.id; b.setAttribute('role', 'tab');
    b.append(el('span', null, p.name), el('span', 'dot'));
    b.addEventListener('click', () => showTab(p.id));
    menu.appendChild(b);

    const page = el('div', 'page'); page.dataset.tab = p.id;
    const head = el('div', 'page-head');
    head.append(el('h2', null, p.name), el('p', null, p.desc));
    page.appendChild(head);
    if (p.custom === 'eq') buildEq(page);
    else { const g = el('div', 'ctl-grid'); p.controls.forEach((c) => makeControl(g, c)); page.appendChild(g); }
    panel.appendChild(page);
  }
  MASTER.forEach((c) => makeControl($('masterControls'), c));
  showTab(PAGES.some((p) => p.id === activeTab) ? activeTab : 'eq');
}

function showTab(id) {
  activeTab = id; lsSet(LS_TAB, id);
  for (const b of $('menu').children) b.setAttribute('aria-selected', b.dataset.tab === id);
  for (const p of $('panel').children) p.classList.toggle('active', p.dataset.tab === id);
  if (id === 'eq') sizeCanvas($('eqCanvas'));
}

// ---------------------------------------------------------------- EQ page
const eqFaders = [];
function buildEq(page) {
  const top = el('div', 'eq-top');
  const chips = el('div', 'chips'); chips.id = 'eqChips';
  for (const name of Object.keys(EQ_PRESETS)) {
    const b = el('button', 'chip', name); b.type = 'button'; b.dataset.v = name;
    b.addEventListener('click', () => { S.eq = EQ_PRESETS[name].slice(); S.eqPreset = name; refreshUI(); changed(); });
    chips.appendChild(b);
  }
  top.appendChild(chips);
  const q = el('div', 'eq-q'); top.appendChild(q);
  makeControl(q, { k: 'eqQ', label: 'Band width (Q)', min: 0.5, max: 4, step: 0.1, zero: 0.5 });
  refs.eqQ.el.closest('.ctl').classList.add('ctl-bare');
  page.appendChild(top);

  const stage = el('div', 'eq-stage');
  const cv = el('canvas'); cv.id = 'eqCanvas';
  const bands = el('div', 'eq-bands');
  EQ_FREQS.forEach((f, i) => {
    const band = el('div', 'band');
    const val = el('span', 'band-val');
    const fader = el('input', 'vfader'); fader.type = 'range'; fader.min = -12; fader.max = 12; fader.step = 0.5;
    fader.setAttribute('aria-label', hz(f) + ' Hz');
    fader.addEventListener('input', () => {
      S.eq[i] = Number(fader.value); S.eqPreset = 'User';
      val.textContent = fmtDb(S.eq[i]); syncChips(); changed();
    });
    fader.addEventListener('dblclick', () => { S.eq[i] = 0; S.eqPreset = 'User'; refreshUI(); changed(); });
    band.append(val, fader, el('span', 'band-f', hz(f)));
    bands.appendChild(band);
    eqFaders.push({ fader, val });
  });
  stage.append(cv, bands);
  page.appendChild(stage);
}

const fmtDb = (v) => (v > 0 ? '+' : '') + v.toFixed(1);
function syncChips() {
  for (const b of $('eqChips').children) b.setAttribute('aria-pressed', b.dataset.v === S.eqPreset);
}

// ---------------------------------------------------------------- refresh / persist
function refreshUI() {
  for (const k in refs) {
    const { c, el: input, out, kind } = refs[k];
    const v = getPath(k);
    if (kind === 'check') input.checked = !!v;
    else if (kind === 'seg') for (const b of input.children) b.setAttribute('aria-pressed', Number(b.dataset.v) === v);
    else { input.value = v; out.textContent = fmtVal(c, v); setFill(input, c, v); }
  }
  eqFaders.forEach(({ fader, val }, i) => { fader.value = S.eq[i]; val.textContent = fmtDb(S.eq[i]); });
  syncChips();
  $('ab').setAttribute('aria-pressed', S.bypass);
  updateKnob();
  syncMenuDots();
}

function syncMenuDots() {
  for (const b of $('menu').children) {
    const p = PAGES.find((x) => x.id === b.dataset.tab);
    b.classList.toggle('on', !!p.on(S));
  }
}

function changed() {
  if (chain) chain.apply(S);
  lsSet(LS_STATE, S);
  syncMenuDots();
  $('ab').setAttribute('aria-pressed', S.bypass);
}

// ---------------------------------------------------------------- volume knob
const VOL_MIN = -40, VOL_MAX = 12;
function updateKnob() {
  const k = $('volKnob');
  const sweep = ((S.volume - VOL_MIN) / (VOL_MAX - VOL_MIN)) * 270;
  k.style.setProperty('--sweep', sweep + 'deg');
  k.style.setProperty('--ang', (sweep - 135) + 'deg');
  k.setAttribute('aria-valuenow', S.volume); k.setAttribute('aria-valuemin', VOL_MIN); k.setAttribute('aria-valuemax', VOL_MAX);
  $('volRead').textContent = (S.volume > 0 ? '+' : '') + S.volume.toFixed(1);
}
function setVolume(v) { S.volume = Math.round(clamp(v, VOL_MIN, VOL_MAX) * 10) / 10; updateKnob(); changed(); }
function wireKnob() {
  const k = $('volKnob');
  let drag = null;
  k.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, v: S.volume }; try { k.setPointerCapture(e.pointerId); } catch { /* synthetic */ } });
  k.addEventListener('pointermove', (e) => { if (drag) setVolume(drag.v + (drag.y - e.clientY) * (e.shiftKey ? 0.05 : 0.2)); });
  const end = () => { drag = null; };
  k.addEventListener('pointerup', end); k.addEventListener('pointercancel', end);
  k.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(S.volume - e.deltaY * 0.02); }, { passive: false });
  k.addEventListener('dblclick', () => setVolume(0));
  k.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
    if (d) { e.preventDefault(); setVolume(S.volume + d); }
  });
}

// ---------------------------------------------------------------- audio setup
function ensureCtx() {
  if (ctx) return;
  ctx = new AudioContext();
  chain = createChain(ctx);
  // spectrum reads the processed sound pre-volume (so it shows at any volume);
  // the meter reads the real output (so it catches clipping from volume boosts)
  analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.8;
  chain.tap.connect(analyser);
  meterAn = ctx.createAnalyser();
  meterAn.fftSize = 2048;
  chain.output.connect(meterAn);
  chain.output.connect(ctx.destination);
  chain.apply(S);
}

async function loadFile(file) {
  ensureCtx();
  $('track').textContent = 'Decoding…';
  try {
    const b = await ctx.decodeAudioData(await file.arrayBuffer());
    fileName = file.name.replace(/\.[^.]+$/, '');
    loadBuffer(b, (file.name.split('.').pop() || '').toUpperCase());
  } catch (e) {
    $('track').textContent = 'Couldn\'t decode ' + file.name;
  }
}

function loadBuffer(b, ext = '') {
  ensureCtx();
  stop();
  buf = b;
  trim.start = 0; trim.end = b.duration; pos = 0;
  fade.in = 0; fade.out = 0;
  document.body.classList.add('loaded');
  sizeCanvas($('wave'));
  computePeaks();
  syncTrimUI(); syncFadeUI();
  bake();
  for (const id of ['play', 'stop', 'setStart', 'setEnd', 'resetTrim', 'export']) $(id).disabled = false;
  $('track').textContent = fileName || 'Untitled';
  $('dur').textContent = '/ ' + fmtTime(b.duration);
  $('info').textContent = [ext, (b.sampleRate / 1000).toFixed(1) + ' kHz', b.numberOfChannels === 1 ? 'mono' : 'stereo', fmtTime(b.duration)].filter(Boolean).join(' · ');
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
  s.loop = looping;
  s.start(0, at - trim.start);
  s.onended = () => { if (src === s) { playing = false; pos = trim.start; src = null; } };
  src = s; t0 = ctx.currentTime; off0 = at; playing = true;
}

function pause() { if (!playing) return; pos = position(); killSource(); playing = false; }
function stop() { killSource(); playing = false; pos = trim.start; }
function seek(t) { pos = clamp(t, 0, buf ? buf.duration : 0); if (playing) play(pos); }
function togglePlay() { playing ? pause() : play(); }

// ---------------------------------------------------------------- trim + fades
function syncTrimUI() {
  const d = buf ? buf.duration : 0;
  for (const id of ['trimStart', 'trimEnd']) $(id).max = d.toFixed(2);
  $('trimStart').value = trim.start.toFixed(2);
  $('trimEnd').value = trim.end.toFixed(2);
  if (buf) $('trimLen').textContent = 'Length ' + fmtTime(trim.end - trim.start) + ' of ' + fmtTime(d);
}

// commit=false while dragging: move the markers, re-bake on release
function setTrim(start, end, commit = true) {
  if (!buf) return;
  const d = buf.duration;
  start = clamp(start, 0, d); end = clamp(end, 0, d);
  if (end - start < 0.05) return syncTrimUI();
  const p = position();
  trim.start = start; trim.end = end;
  syncTrimUI();
  if (commit) rebake(p);
}

function syncFadeUI() {
  $('fadeIn').value = fade.in.toFixed(2);
  $('fadeOut').value = fade.out.toFixed(2);
  for (const b of $('fadeShape').children) b.setAttribute('aria-pressed', b.dataset.v === fade.shape);
}

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
  if (playing) play(clamp(p, trim.start, trim.end - 0.02));
  else if (pos < trim.start || pos > trim.end) pos = trim.start;
}

// ---------------------------------------------------------------- canvases
const dpr = () => window.devicePixelRatio || 1;
function sizeCanvas(cv) {
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr())), h = Math.max(1, Math.round(r.height * dpr()));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w; cv.height = h;
    if (cv.id === 'wave' && buf) computePeaks();
  }
}

function computePeaks() {
  const W = $('wave').width;
  const ch = [];
  for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
  const per = Math.max(1, Math.floor(buf.length / W));
  peaks = new Float32Array(W * 2);
  for (let x = 0; x < W; x++) {
    let mn = 1, mx = -1;
    const a = x * per, b = Math.min(a + per, buf.length);
    for (let i = a; i < b; i += 4) for (const d of ch) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    peaks[x * 2] = mn; peaks[x * 2 + 1] = mx;
  }
}

const ACC = '79,209,255', WARM = '255,165,61';
function drawWave() {
  const cv = $('wave'), g = cv.getContext('2d'), W = cv.width, H = cv.height, k = dpr();
  g.clearRect(0, 0, W, H);
  if (!buf || !peaks || peaks.length !== W * 2) return;
  const d = buf.duration, tx = (t) => (t / d) * W;
  const xs = tx(trim.start), xe = tx(trim.end), xp = tx(position());
  const mid = H / 2, amp = H / 2 - 6 * k;

  for (let x = 0; x < W; x++) {
    const y1 = mid - peaks[x * 2 + 1] * amp, y2 = mid - peaks[x * 2] * amp;
    const inside = x >= xs && x <= xe;
    g.fillStyle = !inside ? `rgba(${ACC},0.14)` : x <= xp ? `rgba(${ACC},0.95)` : `rgba(${ACC},0.45)`;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }

  // fade envelope
  const curve = FADE_SHAPES[fade.shape];
  const xfi = tx(trim.start + fade.in), xfo = tx(trim.end - fade.out);
  const top = 7 * k, bot = H - 2 * k, yOf = (gain) => bot - gain * (bot - top);
  g.beginPath();
  for (let i = 0; i <= 48; i++) { const x = xs + (xfi - xs) * i / 48, y = yOf(curve(i / 48)); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.lineTo(xfo, top);
  for (let i = 0; i <= 48; i++) g.lineTo(xfo + (xe - xfo) * i / 48, yOf(curve(1 - i / 48)));
  g.strokeStyle = `rgba(${WARM},0.9)`; g.lineWidth = 1.5 * k; g.stroke();
  g.fillStyle = `rgb(${WARM})`;
  for (const x of [xfi, xfo]) { g.beginPath(); g.roundRect(x - HANDLE / 2 * k, 0, HANDLE * k, HANDLE * k * 0.75, 3 * k); g.fill(); }

  // trim edges
  g.fillStyle = '#f4f6f8';
  for (const x of [xs, xe]) {
    g.fillRect(x - k, 0, 2 * k, H);
    g.beginPath(); g.roundRect(x - 4 * k, mid - 14 * k, 8 * k, 28 * k, 4 * k); g.fill();
  }

  // playhead
  g.fillStyle = '#fff'; g.fillRect(xp - k / 2, 0, k, H);
}

// EQ stage: live spectrum + tone-stack response curve, on the same axis as the faders.
// bands are 2/3-octave spaced (×1.6), so the faders' even columns are a log axis.
const BAND_RATIO = 1.6;
const eqX = (f, W) => ((Math.log(f / EQ_FREQS[0]) / Math.log(BAND_RATIO) + 0.5) / EQ_FREQS.length) * W;
const eqF = (x, W) => EQ_FREQS[0] * Math.pow(BAND_RATIO, (x / W) * EQ_FREQS.length - 0.5);
let specData = null, timeData = null, specHold = null, respFreqs = null, respMag = null, respPh = null, respTot = null;

function drawEq() {
  const cv = $('eqCanvas'); if (!cv) return;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, k = dpr();
  g.clearRect(0, 0, W, H);

  // fader travel (so the curve passes through the thumbs)
  const stageR = cv.getBoundingClientRect(), fR = eqFaders[0].fader.getBoundingClientRect();
  const thumb = 6;
  const yTop = (fR.top - stageR.top + thumb) * k, yBot = (fR.bottom - stageR.top - thumb) * k;
  const yDb = (db) => yTop + ((12 - clamp(db, -13, 13)) / 24) * (yBot - yTop);

  // grid
  g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = k;
  for (const db of [-12, -6, 6, 12]) { g.beginPath(); g.moveTo(0, yDb(db)); g.lineTo(W, yDb(db)); g.stroke(); }
  g.setLineDash([4 * k, 4 * k]); g.strokeStyle = 'rgba(255,255,255,0.14)';
  g.beginPath(); g.moveTo(0, yDb(0)); g.lineTo(W, yDb(0)); g.stroke(); g.setLineDash([]);

  // spectrum
  if (analyser && playing) {
    if (!specData) specData = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(specData);
  }
  const cols = Math.ceil(W / (2 * k));
  if (!specHold || specHold.length !== cols) specHold = new Float32Array(cols).fill(-140);
  const nyq = ctx ? ctx.sampleRate / 2 : 24000;
  const line = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const x = c * 2 * k, f = eqF(x, W);
    let db = -140;
    if (specData && playing) {
      const b1 = Math.max(1, Math.floor((f / 1.03) / nyq * specData.length));
      const b2 = Math.max(b1 + 1, Math.ceil((f * 1.03) / nyq * specData.length));
      for (let b = b1; b < b2 && b < specData.length; b++) db = Math.max(db, specData[b]);
      db += 3 * Math.log2(f / 1000); // +3 dB/oct tilt so music reads flat-ish
    }
    // fall slowly when quiet/paused, rise instantly
    specHold[c] = db > specHold[c] ? db : specHold[c] - 1.2;
    line[c] = specHold[c];
  }
  const ySpec = (db) => H - clamp((db + 90) / 75, 0, 1) * (H - 30 * k);
  const grad = g.createLinearGradient(0, H * 0.2, 0, H);
  grad.addColorStop(0, `rgba(${ACC},0.42)`); grad.addColorStop(1, `rgba(${ACC},0.02)`);
  g.beginPath(); g.moveTo(0, H);
  for (let c = 0; c < cols; c++) g.lineTo(c * 2 * k, ySpec(line[c]));
  g.lineTo(W, H); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath();
  for (let c = 0; c < cols; c++) { const y = ySpec(line[c]); c ? g.lineTo(c * 2 * k, y) : g.moveTo(0, y); }
  g.strokeStyle = `rgba(${ACC},0.7)`; g.lineWidth = 1.2 * k; g.stroke();

  // tone-stack response curve
  if (chain) {
    const N = 160;
    if (!respFreqs) {
      respFreqs = new Float32Array(N); respMag = new Float32Array(N); respPh = new Float32Array(N); respTot = new Float32Array(N);
      for (let i = 0; i < N; i++) respFreqs[i] = eqF((i / (N - 1)) * 1000, 1000);
    }
    respTot.fill(0);
    for (const n of chain.toneNodes) {
      n.getFrequencyResponse(respFreqs, respMag, respPh);
      for (let i = 0; i < N; i++) respTot[i] += 20 * Math.log10(Math.max(respMag[i], 1e-6));
    }
    g.beginPath();
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * W, y = yDb(respTot[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = S.bypass ? 'rgba(255,255,255,0.25)' : `rgba(${WARM},0.95)`;
    g.lineWidth = 2 * k; g.shadowColor = `rgba(${WARM},0.6)`; g.shadowBlur = S.bypass ? 0 : 10 * k;
    g.stroke(); g.shadowBlur = 0;
  }
}

let peakHold = -Infinity, peakHoldT = 0;
function drawMeter() {
  if (!meterAn) return;
  if (!timeData) timeData = new Float32Array(meterAn.fftSize);
  let pk = 0;
  if (playing) { meterAn.getFloatTimeDomainData(timeData); for (const v of timeData) { const a = Math.abs(v); if (a > pk) pk = a; } }
  const pdb = 20 * Math.log10(pk || 1e-9);
  const now = performance.now();
  if (pdb > peakHold || now - peakHoldT > 1500) { peakHold = pdb; peakHoldT = now; }
  $('meterFill').style.width = clamp((pdb + 48) / 48, 0, 1) * 100 + '%';
  const p = $('peak');
  p.textContent = peakHold < -90 ? '−∞' : peakHold.toFixed(1);
  p.classList.toggle('clip', peakHold > -0.1);
}

function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + s.toFixed(2).padStart(5, '0');
}

function frame() {
  document.body.classList.toggle('playing', playing);
  drawWave();
  if (activeTab === 'eq') drawEq();
  drawMeter();
  if (buf) $('time').textContent = fmtTime(position());
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- waveform dragging
const HANDLE = 14; // css px
let drag = null;

function waveHit(e) {
  const cv = $('wave'), r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top, W = r.width;
  const d = buf.duration, tx = (t) => (t / d) * W;
  const t = clamp((x / W) * d, 0, d);
  const near = (px, tol) => Math.abs(x - px) <= tol;
  let kind = null;
  if (y <= HANDLE + 4) {
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
  if (!drag) { $('wave').style.cursor = h.kind ? 'ew-resize' : 'pointer'; return; }
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
  setFades(fade.in, fade.out, false);
  rebake(position());
}

// ---------------------------------------------------------------- export
let exportBits = 16;
async function exportAudio() {
  if (!buf) return;
  const sr = buf.sampleRate, len = region.length, dur = len / sr;
  $('exportStatus').textContent = 'Rendering…';
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
    const blob = encodeWav(out, exportBits);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (fileName || 'audio') + ' (headunit).wav';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $('exportStatus').textContent = `Saved ${fmtTime(dur)} · ${(blob.size / 1048576).toFixed(1)} MB`;
    window.__lastExport = { blob, buffer: out };
  } catch (e) {
    $('exportStatus').textContent = 'Export failed: ' + e.message;
  } finally {
    $('export').disabled = false;
  }
}

// ---------------------------------------------------------------- presets
function presets() { return lsGet(LS_PRESETS) || {}; }
function refreshPresetList() {
  const sel = $('presetList'); sel.innerHTML = '';
  const names = Object.keys(presets());
  if (!names.length) { const o = el('option', null, 'No saved presets'); o.value = ''; sel.appendChild(o); }
  for (const name of names) { const o = el('option', null, name); o.value = name; sel.appendChild(o); }
}

// ---------------------------------------------------------------- wiring
function wire() {
  $('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
  let depth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
    const f = e.dataTransfer.files[0]; if (f) loadFile(f);
  });
  document.addEventListener('pointerdown', () => { if (ctx && ctx.state === 'suspended') ctx.resume(); }, { capture: true });

  $('play').onclick = togglePlay;
  $('stop').onclick = stop;
  $('loop').onclick = () => {
    looping = !looping; $('loop').setAttribute('aria-pressed', looping);
    if (playing) play(position());
  };
  $('ab').onclick = () => { S.bypass = !S.bypass; changed(); };

  const wv = $('wave');
  wv.addEventListener('pointerdown', waveDown);
  wv.addEventListener('pointermove', waveMove);
  wv.addEventListener('pointerup', waveUp);
  wv.addEventListener('pointercancel', () => { drag = null; rebake(position()); });

  $('trimStart').onchange = () => setTrim(Number($('trimStart').value), trim.end);
  $('trimEnd').onchange = () => setTrim(trim.start, Number($('trimEnd').value));
  $('setStart').onclick = () => setTrim(position(), trim.end);
  $('setEnd').onclick = () => setTrim(trim.start, position());
  $('resetTrim').onclick = () => buf && setTrim(0, buf.duration);
  $('fadeIn').onchange = () => setFades(Number($('fadeIn').value) || 0, fade.out);
  $('fadeOut').onchange = () => setFades(fade.in, Number($('fadeOut').value) || 0);
  for (const b of $('fadeShape').children) b.onclick = () => { fade.shape = b.dataset.v; syncFadeUI(); rebake(position()); };
  $('clearFades').onclick = () => setFades(0, 0);

  for (const b of $('exportBits').children) b.onclick = () => {
    exportBits = Number(b.dataset.v);
    for (const x of $('exportBits').children) x.setAttribute('aria-pressed', x === b);
  };
  $('export').onclick = exportAudio;

  $('presetSave').onclick = () => {
    const name = $('presetName').value.trim(); if (!name) return $('presetName').focus();
    const p = presets(); p[name] = clone(S); lsSet(LS_PRESETS, p); refreshPresetList();
    $('presetList').value = name; $('presetName').value = '';
  };
  $('presetLoad').onclick = () => {
    const p = presets()[$('presetList').value]; if (!p) return;
    S = Object.assign(clone(DEFAULT_SETTINGS), clone(p)); refreshUI(); changed();
  };
  $('presetDelete').onclick = () => {
    const p = presets(); delete p[$('presetList').value]; lsSet(LS_PRESETS, p); refreshPresetList();
  };
  $('resetAll').onclick = () => { S = clone(DEFAULT_SETTINGS); refreshUI(); changed(); };

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'number')) return;
    if (e.code === 'Space' && t.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    if (e.key === 'b' || e.key === 'B') { S.bypass = !S.bypass; changed(); }
  });

  // docking display: once it's mostly scrolled away, it pins to the top as a compact bar.
  // the slot holds its full height so the page underneath never jumps.
  const slot = $('displaySlot'), disp = $('display');
  let compact = false;
  new ResizeObserver(() => { if (!compact) slot.style.height = disp.offsetHeight + 'px'; }).observe(disp);
  const setCompact = (on) => {
    on = on && !!buf;
    if (on === compact) return;
    compact = on;
    disp.classList.toggle('compact', on);
    if (on) disp.animate(
      [{ transform: 'translate(-50%, -14px)', opacity: 0 }, { transform: 'translate(-50%, 0)', opacity: 1 }],
      { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    else disp.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
  };
  new IntersectionObserver(([e]) => setCompact(!e.isIntersecting && e.boundingClientRect.top < 0),
    { rootMargin: '-90px 0px 0px 0px' }).observe(slot);
  window.__setCompact = setCompact;

  const ro = new ResizeObserver(() => {
    sizeCanvas($('wave')); sizeCanvas($('eqCanvas'));
    const m = document.querySelector('.meter'); if (m) $('meterFill').style.setProperty('--mw', m.clientWidth + 'px');
  });
  ro.observe($('waveWrap')); ro.observe($('panel')); ro.observe(document.querySelector('.meter'));
}

buildUI();
wireKnob();
wire();
ensureCtx(); // suspended until the first click; lets the EQ curve draw before any audio
refreshUI();
syncFadeUI();
refreshPresetList();
requestAnimationFrame(frame);

// test hook
window.HU = {
  get S() { return S; }, set S(v) { S = v; refreshUI(); changed(); },
  loadBuffer, ensureCtx, play, pause, stop, exportAudio, setTrim, setFades, position, showTab,
  get ctx() { return ctx; }, get region() { return region; }, get playing() { return playing; },
  setLoop(v) { looping = v; $('loop').setAttribute('aria-pressed', v); }, trim, fade,
};
