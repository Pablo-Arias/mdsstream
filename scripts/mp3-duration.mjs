// Length of a remote MP3 in seconds, from its first few KB (HTTP range requests).
// Uses the Xing/Info or VBRI header when present (VBR and most encoders),
// otherwise works it out from the bitrate (CBR). Returns null if it can't tell.

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2/2.5 Layer III
};
const SAMPLE_RATES = [44100, 48000, 32000];

async function range(url, start, length) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`Range request returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, length); // a server that ignores Range sends everything
}

function frameHeader(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (b[i + 1] >> 1) & 3; // 1 = Layer III
  const bitrateIdx = b[i + 2] >> 4;
  const rateIdx = (b[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null;
  const mpeg1 = version === 3;
  return {
    mpeg1,
    bitrate: BITRATES[mpeg1 ? 1 : 2][bitrateIdx] * 1000,
    sampleRate: SAMPLE_RATES[rateIdx] / (mpeg1 ? 1 : version === 2 ? 2 : 4),
    samplesPerFrame: mpeg1 ? 1152 : 576,
    mono: b[i + 3] >> 6 === 3,
  };
}

export async function mp3Duration(url, fileSize) {
  let buf = await range(url, 0, 64 * 1024);
  let base = 0;
  let start = 0;
  if (buf.toString("latin1", 0, 3) === "ID3") {
    const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + tagSize + (buf[5] & 0x10 ? 10 : 0);
    if (start + 4096 > buf.length) {
      buf = await range(url, start, 64 * 1024); // big ID3 tag (e.g. embedded cover art)
      base = start;
    }
  }

  for (let i = start - base; i < buf.length - 200; i++) {
    const h = frameHeader(buf, i);
    if (!h) continue;
    const xing = i + 4 + (h.mpeg1 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17);
    const tag = buf.toString("latin1", xing, xing + 4);
    if ((tag === "Xing" || tag === "Info") && buf.readUInt32BE(xing + 4) & 1) {
      return (buf.readUInt32BE(xing + 8) * h.samplesPerFrame) / h.sampleRate;
    }
    if (buf.toString("latin1", i + 36, i + 40) === "VBRI") {
      return (buf.readUInt32BE(i + 36 + 14) * h.samplesPerFrame) / h.sampleRate;
    }
    return ((fileSize - (base + i)) * 8) / h.bitrate;
  }
  return null;
}
