'use strict';
// AudioBuffer → WAV blob. 16-bit gets TPDF dither, 24-bit doesn't need it.
function encodeWav(buffer, bits = 16) {
  const ch = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const bps = bits / 8, dataLen = len * ch * bps;
  const ab = new ArrayBuffer(44 + dataLen);
  const v = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * bps, true); v.setUint16(32, ch * bps, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);

  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      let s = data[c][i];
      if (bits === 16) {
        s += (Math.random() - Math.random()) / 32768;
        s = Math.max(-1, Math.min(1, s));
        v.setInt16(o, Math.round(s * 32767), true);
        o += 2;
      } else {
        s = Math.max(-1, Math.min(1, s));
        const n = Math.round(s * 8388607);
        v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setUint8(o + 2, (n >> 16) & 255);
        o += 3;
      }
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
