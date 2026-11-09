# headunit

car-stereo-style sound shop for any audio file. load a song, trim it on the waveform, fade it, and push it through a Kenwood-style DSP chain with live preview. export a WAV when it sounds right.

**status:** styled. head-unit look, docking display, live spectrum EQ.

## run

**live:** https://notarqen.github.io/headunit/

or locally: open `index.html` in a browser (no build, no server needed), or `python3 -m http.server 8797` in this folder.

## what's in it

- **trim**: drag the blue edges, drag empty space to select a region, or type in exact times
- **fades**: drag the orange squares; choose linear, equal power, S-curve or exponential. you hear them live and they're in the export
- **13-band EQ** with presets, faders over a live spectrum and the tone-stack response curve
- **bass**: bass boost (level + freq), bass restore (psychoacoustic harmonics)
- **restoration**: Supreme+ (rebuilds lost top end above 10k), exciter (amount / freq / drive)
- **sound field**: space enhancement (M/S width), sound realizer (early reflections), vocal boost (mid only), stage lift
- **subwoofer**: level, crossover, phase
- **listening position / time alignment**: front L, front R, custom per-channel delay
- **compressor**: threshold, ratio, attack, release, makeup
- **loudness**, **drive EQ**, high/low-pass filters, balance, pre-amp, output limiter, A/B bypass (`b`)
- presets saved in the browser, peak meter, space = play/pause
- the display docks to the top as a compact bar (transport + waveform scrubber) when you scroll down

all settings apply live during playback. export renders the same chain offline, so what you hear is what you get.
