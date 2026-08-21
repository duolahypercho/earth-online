// Measure a captured frame without an image library.
//
// The quality gate's automatic rejection conditions are about things a reviewer
// SEES, but "is there a shadow in this frame" should not be settled by eye when
// it can be counted. This decodes a PNG with node's own zlib and reports the
// statistics a reviewer would otherwise have to estimate.
//
//   node scripts/qa/measure-frame-v1.mjs <file.png> [x0,y0,x1,y1 ...]
//
// Reports, for the whole frame and for each requested region: luma histogram
// summary, share of near-black pixels, and a bimodality test that answers "does
// this surface carry both a lit and a shadowed population".
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]; pos += 1;
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= channels ? prior[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function measure(image, region) {
  const { width, height, channels, data } = image;
  const [x0, y0, x1, y1] = region || [0, 0, width, height];
  const histogram = new Array(32).fill(0);
  let count = 0; let sum = 0; let black = 0; let blown = 0;
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
      const i = (y * width + x) * channels;
      const value = luma(data[i], data[i + 1], data[i + 2]);
      histogram[Math.min(31, Math.floor(value / 8))] += 1;
      sum += value; count += 1;
      if (value < 12) black += 1;
      if (value > 250) blown += 1;
    }
  }
  // Two populations on one surface = a shadow boundary crosses it. Otsu's
  // between-class variance, normalised, is a scale-free way to say so.
  let best = 0; let bestThreshold = 0;
  const total = count;
  let w0 = 0; let s0 = 0;
  const totalSum = histogram.reduce((acc, n, i) => acc + n * (i * 8 + 4), 0);
  for (let t = 0; t < 32; t += 1) {
    w0 += histogram[t]; s0 += histogram[t] * (t * 8 + 4);
    const w1 = total - w0;
    if (!w0 || !w1) continue;
    const m0 = s0 / w0; const m1 = (totalSum - s0) / w1;
    const between = (w0 / total) * (w1 / total) * (m0 - m1) ** 2;
    if (between > best) { best = between; bestThreshold = t * 8 + 4; }
  }
  const mean = count ? sum / count : 0;
  const variance = best;
  return {
    region: [x0, y0, x1, y1],
    pixels: count,
    meanLuma: +mean.toFixed(1),
    nearBlackShare: +(black / count).toFixed(4),
    blownShare: +(blown / count).toFixed(4),
    splitAt: bestThreshold,
    // separation = how far apart the two populations are, in luma units
    separation: +Math.sqrt(variance).toFixed(1),
  };
}

// `--diff a.png b.png` reports what changed between two frames of the same
// pose. Differencing a frame against the same frame with the key light off is
// the only way to answer "is the sun casting a shadow here" from screenshots: a
// real cast shadow is a hard boundary in the difference image, which shows up
// as two populations; a frame with no shadows differs smoothly and nothing else.
if (process.argv[2] === '--diff') {
  const a = decodePng(readFileSync(process.argv[3]));
  const b = decodePng(readFileSync(process.argv[4]));
  if (a.width !== b.width || a.height !== b.height) throw new Error('frames differ in size');
  const delta = { width: a.width, height: a.height, channels: 3, data: Buffer.alloc(a.width * a.height * 3) };
  let sum = 0; let max = 0; let changed = 0;
  for (let i = 0, j = 0; i < a.width * a.height; i += 1) {
    const ia = i * a.channels; const ib = i * b.channels;
    const d = Math.abs(luma(a.data[ia], a.data[ia + 1], a.data[ia + 2])
      - luma(b.data[ib], b.data[ib + 1], b.data[ib + 2]));
    delta.data[j] = delta.data[j + 1] = delta.data[j + 2] = Math.min(255, Math.round(d));
    j += 3; sum += d; if (d > max) max = d; if (d > 4) changed += 1;
  }
  const regions = process.argv.slice(5).map((spec) => spec.split(',').map(Number));
  console.log(JSON.stringify({
    a: process.argv[3], b: process.argv[4],
    meanDelta: +(sum / (a.width * a.height)).toFixed(2),
    maxDelta: +max.toFixed(1),
    changedShare: +(changed / (a.width * a.height)).toFixed(4),
    whole: measure(delta),
    regions: regions.map((r) => measure(delta, r)),
  }, null, 2));
  process.exit(0);
}

const file = process.argv[2];
if (!file) { console.error('usage: measure-frame-v1.mjs <file.png> [x0,y0,x1,y1 ...] | --diff a.png b.png [regions]'); process.exit(2); }
const image = decodePng(readFileSync(file));
const regions = process.argv.slice(3).map((spec) => spec.split(',').map(Number));
const report = {
  file, width: image.width, height: image.height,
  whole: measure(image),
  regions: regions.map((r) => measure(image, r)),
};
console.log(JSON.stringify(report, null, 2));
