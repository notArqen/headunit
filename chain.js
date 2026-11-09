'use strict';
// headunit audio chain. one builder used for both live playback (AudioContext)
// and export (OfflineAudioContext), so what you hear is what you export.
//
// signal flow:
//   input ─┬─ dry ───────────────────────────────────────────────────────┐
//          └─ preamp → HPF → LPF → 13-band EQ → bass boost → loudness →   │
//             drive EQ → stage lift → tone ─┬────────────────┐            │
//                                           ├ supreme+ ──────┤ sum        │
//                                           ├ exciter ───────┤            │
//                                           └ bass restore ──┘            │
//             sum → M/S (vocal boost on mid, width on side) → realizer →  │
//             balance → wet ───────────────────────────────────────────── out → volume → limiter → output

const EQ_FREQS = [62.5, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000];

const EQ_PRESETS = {
  Flat:      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Natural:   [1, 1, 0.5, 0, 0, 0, 0, 0, 0.5, 1, 1, 1, 0.5],
  Rock:      [4, 3.5, 2.5, 1, -0.5, -1, -0.5, 1, 2, 3, 3.5, 3.5, 3],
  Pops:      [-1, 0, 1, 2, 3, 3, 2, 1, 0, -0.5, -1, -1, -1],
  Easy:      [2, 1.5, 1, 0.5, 0, 0, 0, 0, 0, -0.5, -1, -1.5, -2],
  'Top 40':  [2, 2, 1, 0, -1, 0, 1.5, 2.5, 2, 1.5, 1, 1, 1],
  Jazz:      [2.5, 2, 1, 1.5, -1, -1, 0, 1, 2, 2.5, 2.5, 2, 1.5],
  Powerful:  [6, 5, 4, 2, 0, -1, -1, 0, 1.5, 3, 4, 4.5, 4],
  'Bass Max':[8, 7, 5, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  Treble:    [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 5],
  Vocal:     [-2, -2, -1, 0, 1.5, 3, 3.5, 3, 2, 1, 0, -1, -1],
};

const DEFAULT_SETTINGS = {
  bypass: false,
  volume: 0,          // dB, post-everything
  preamp: 0,          // dB, into the effects
  balance: 0,         // -1 L .. 1 R
  limiter: true,
  hpf: 20,            // Hz, 20 = off
  lpf: 20000,         // Hz, 20000 = off
  eqPreset: 'Flat',
  eq: EQ_PRESETS.Flat.slice(),
  eqQ: 1.4,
  bassBoost: 0,       // dB
  bassFreq: 80,       // Hz
  bassRestore: 0,     // 0..1, psychoacoustic bass (harmonics of the lows)
  bassRestoreFreq: 100,
  loudness: 0,        // 0 off, 1 low, 2 high
  driveEq: false,
  stageEq: 0,         // 0 off, 1 low, 2 mid, 3 high
  supreme: 0,         // 0..1, rebuilds the missing top end (like Kenwood Supreme+)
  exciter: 0,         // 0..1
  exciterFreq: 3000,  // Hz
  exciterDrive: 12,   // saturation amount
  vocal: 0,           // 0 off, 1 low, 2 mid, 3 high
  width: 100,         // %, stereo width (space enhancement)
  realizer: 0,        // 0 off, 1..3 (sound realizer, early-reflection ambience)
  subOn: false,       // virtual subwoofer: lowpassed mono sum layered back in
  subLevel: 0,        // dB
  subFreq: 80,        // Hz crossover
  subPhase: 0,        // 0 or 180
  position: 0,        // listening position: 0 off, 1 front-L (driver), 2 front-R, 3 custom
  alignL: 0,          // ms delay, custom position
  alignR: 0,
  compOn: false,
  compThreshold: -18, // dB
  compRatio: 3,
  compAttack: 10,     // ms
  compRelease: 150,   // ms
  compMakeup: 0,      // dB on top of the browser's auto makeup
};

// listening-position presets: [L ms, R ms]. the near speaker gets delayed so both arrive together.
const POSITIONS = [[0, 0], [1.6, 0], [0, 1.6]];

const dB = (v) => Math.pow(10, v / 20);

// tanh saturation with an even-harmonic (rectified) part. small-signal gain is 1,
// so the "amount" knobs mean roughly the same thing no matter the drive.
function shaperCurve(k, asym) {
  const n = 4096, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const t = Math.tanh(k * x);
    c[i] = (t + asym * Math.abs(t)) / k;
  }
  return c;
}

function createChain(ctx) {
  const live = !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext);
  const nyq = ctx.sampleRate / 2;

  const gain = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const biquad = (type, f, q = 0.707, g = 0) => {
    const b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
    return b;
  };
  const shaper = () => { const w = ctx.createWaveShaper(); w.oversample = '4x'; return w; };
  const link = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };

  // input forces stereo so mono files go through the M/S stage correctly
  const input = gain();
  input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';

  const dry = gain(0), wet = gain(1), out = gain();
  input.connect(dry); dry.connect(out);

  // --- tone section ---
  const preamp = gain();
  const hpf = [biquad('highpass', 10), biquad('highpass', 10)];
  const lpf = [biquad('lowpass', nyq * 0.99), biquad('lowpass', nyq * 0.99)];
  const eq = EQ_FREQS.map((f) => biquad('peaking', Math.min(f, nyq * 0.95), 1.4, 0));
  const bassShelf = biquad('lowshelf', 80);
  const loudLow = biquad('lowshelf', 100);
  const loudHigh = biquad('highshelf', 10000);
  const driveLow = biquad('lowshelf', 120);
  const driveHigh = biquad('highshelf', 6000);
  const stage = biquad('peaking', 3500, 0.8);
  const tone = link(input, preamp, ...hpf, ...lpf, ...eq, bassShelf, loudLow, loudHigh, driveLow, driveHigh, stage);

  const sum = gain();
  tone.connect(sum);

  // --- supreme+: saturate 5k+ content, keep only what lands above 10k ---
  const supSh = shaper(); supSh.curve = shaperCurve(30, 0.8);
  const supOut = gain(0);
  link(tone, biquad('highpass', 5000), biquad('highpass', 5000), supSh,
    biquad('highpass', 10000), biquad('highpass', 10000), supOut, sum);

  // --- exciter: harmonics on the presence band ---
  const exHP1 = biquad('highpass', 3000), exHP2 = biquad('highpass', 3000);
  const exSh = shaper();
  const exOut = gain(0);
  link(tone, exHP1, exSh, exHP2, exOut, sum);

  // --- bass restore: harmonics of the lows so small speakers "hear" the sub ---
  const brLP1 = biquad('lowpass', 100), brLP2 = biquad('lowpass', 100);
  const brSh = shaper(); brSh.curve = shaperCurve(10, 0.8);
  const brBP = biquad('bandpass', 200, 0.7);
  const brOut = gain(0);
  link(tone, brLP1, brLP2, brSh, brBP, brOut, sum);

  // --- virtual subwoofer: mono sum → 24 dB/oct lowpass → level/phase ---
  const subMono = gain();
  subMono.channelCount = 1; subMono.channelCountMode = 'explicit'; subMono.channelInterpretation = 'speakers';
  const subLP1 = biquad('lowpass', 80), subLP2 = biquad('lowpass', 80);
  const subOut = gain(0);
  link(tone, subMono, subLP1, subLP2, subOut, sum);

  // --- M/S: vocal boost on mid, width on side ---
  const split = ctx.createChannelSplitter(2);
  sum.connect(split);
  const mid = gain(), side = gain();
  const Lm = gain(0.5), Rm = gain(0.5), Ls = gain(0.5), Rs = gain(-0.5);
  split.connect(Lm, 0); split.connect(Ls, 0);
  split.connect(Rm, 1); split.connect(Rs, 1);
  Lm.connect(mid); Rm.connect(mid); Ls.connect(side); Rs.connect(side);
  const vocal = biquad('peaking', 2000, 0.9, 0);
  const width = gain(1);
  mid.connect(vocal); side.connect(width);
  const merge = ctx.createChannelMerger(2);
  const inv = gain(-1);
  vocal.connect(merge, 0, 0); vocal.connect(merge, 0, 1);
  width.connect(merge, 0, 0); width.connect(inv); inv.connect(merge, 0, 1);

  // --- sound realizer: cross-fed early reflections ---
  const post = gain();
  merge.connect(post);
  const rSplit = ctx.createChannelSplitter(2), rMerge = ctx.createChannelMerger(2);
  const dL = ctx.createDelay(0.1), dR = ctx.createDelay(0.1);
  dL.delayTime.value = 0.013; dR.delayTime.value = 0.019;
  merge.connect(rSplit);
  rSplit.connect(dL, 0); rSplit.connect(dR, 1);
  dL.connect(rMerge, 0, 1); dR.connect(rMerge, 0, 0);
  const rOut = gain(0);
  link(rMerge, biquad('highpass', 300), biquad('lowpass', 7000), rOut, post);

  // --- balance → time alignment → compressor → wet → master ---
  const pan = ctx.createStereoPanner();
  const aSplit = ctx.createChannelSplitter(2), aMerge = ctx.createChannelMerger(2);
  const aL = ctx.createDelay(0.05), aR = ctx.createDelay(0.05);
  link(post, pan, aSplit);
  aSplit.connect(aL, 0); aSplit.connect(aR, 1);
  aL.connect(aMerge, 0, 0); aR.connect(aMerge, 0, 1);
  const comp = ctx.createDynamicsCompressor();
  const makeup = gain();
  link(aMerge, comp, makeup, wet, out);

  const volume = gain();
  const limiter = ctx.createDynamicsCompressor();
  const output = gain();
  link(out, volume, limiter, output);

  // ---------------------------------------------------------------------------
  // smooth ramps while audio is running; direct sets otherwise (a suspended context never
  // advances its timeline, so a ramp would sit at the old value until the first play)
  const set = (param, v) => {
    param.cancelScheduledValues(0);
    if (live && ctx.state === 'running') param.setTargetAtTime(v, ctx.currentTime, 0.015);
    else param.value = v;
  };
  let exK = null;

  function apply(s) {
    set(dry.gain, s.bypass ? 1 : 0);
    set(wet.gain, s.bypass ? 0 : 1);
    set(preamp.gain, dB(s.preamp));

    const hf = s.hpf <= 20 ? 10 : s.hpf;
    const lf = s.lpf >= 20000 ? nyq * 0.99 : Math.min(s.lpf, nyq * 0.99);
    hpf.forEach((b) => set(b.frequency, hf));
    lpf.forEach((b) => set(b.frequency, lf));

    eq.forEach((b, i) => { set(b.gain, s.eq[i] || 0); set(b.Q, s.eqQ); });

    set(bassShelf.frequency, s.bassFreq);
    set(bassShelf.gain, s.bassBoost);

    const loud = [[0, 0], [4, 2], [8, 4]][s.loudness] || [0, 0];
    set(loudLow.gain, loud[0]); set(loudHigh.gain, loud[1]);

    set(driveLow.gain, s.driveEq ? 3 : 0);
    set(driveHigh.gain, s.driveEq ? 2 : 0);

    set(stage.gain, [0, 1.5, 3, 4.5][s.stageEq] || 0);

    set(supOut.gain, s.supreme * 2);

    if (exK !== s.exciterDrive) { exK = s.exciterDrive; exSh.curve = shaperCurve(Math.max(1, exK), 0.4); }
    set(exHP1.frequency, s.exciterFreq); set(exHP2.frequency, s.exciterFreq);
    set(exOut.gain, s.exciter);

    set(brLP1.frequency, s.bassRestoreFreq); set(brLP2.frequency, s.bassRestoreFreq);
    set(brBP.frequency, s.bassRestoreFreq * 2);
    set(brOut.gain, s.bassRestore * 1.5);

    set(vocal.gain, [0, 3, 6, 9][s.vocal] || 0);
    set(width.gain, s.width / 100);
    set(rOut.gain, [0, 0.12, 0.2, 0.3][s.realizer] || 0);
    set(pan.pan, s.balance);

    set(subLP1.frequency, s.subFreq); set(subLP2.frequency, s.subFreq);
    set(subOut.gain, s.subOn ? dB(s.subLevel) * (s.subPhase === 180 ? -1 : 1) : 0);

    const al = s.position === 3 ? [s.alignL, s.alignR] : (POSITIONS[s.position] || [0, 0]);
    set(aL.delayTime, al[0] / 1000); set(aR.delayTime, al[1] / 1000);

    if (s.compOn) {
      comp.threshold.value = s.compThreshold; comp.ratio.value = s.compRatio; comp.knee.value = 6;
      comp.attack.value = s.compAttack / 1000; comp.release.value = s.compRelease / 1000;
      set(makeup.gain, dB(s.compMakeup));
    } else {
      comp.threshold.value = 0; comp.ratio.value = 1; comp.knee.value = 0;
      set(makeup.gain, 1);
    }

    set(volume.gain, dB(s.volume));
    if (s.limiter) {
      limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20;
      limiter.attack.value = 0.002; limiter.release.value = 0.15;
    } else {
      limiter.threshold.value = 0; limiter.ratio.value = 1;
    }
  }

  // the filters whose combined response the EQ screen draws
  const toneNodes = [...hpf, ...lpf, ...eq, bassShelf, loudLow, loudHigh, driveLow, driveHigh, stage];
  // tap = the processed sound before volume/limiter (what the spectrum shows)
  return { input, output, apply, toneNodes, tap: out };
}
