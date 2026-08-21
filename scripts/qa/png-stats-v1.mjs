// Minimal dependency-free PNG statistics for capture evidence.
//
// These are REGRESSION SIGNALS ONLY. Docs/VISUAL_QUALITY_GATE.md is explicit
// that image statistics cannot approve a quality bar, and nothing here tries
// to. What they can do is catch a frame that is not a picture at all - a black
// surface, a white-out, a flat fill - which is exactly what the round needs,
// because nobody in this loop can see the frames and a 20 KB "is the PNG
// bigger than nothing" heuristic already let a fully blown-out card through.
//
// Decodes 8-bit truecolour (with or without alpha), which is what the capture
// harness produces.
import { inflateSync } from 'node:zlib';

/** Decode an 8-bit RGB/RGBA PNG buffer into { width, height, bpp, pixels }. */
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colourType = 0; let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (colourType !== 2 && colourType !== 6) throw new Error(`unsupported colour type ${colourType}`);
  if (interlace) throw new Error('interlaced PNG is not supported');
  const bpp = colourType === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    switch (filter) {
      case 0: break;
      case 1:
        for (let i = bpp; i < stride; i += 1) line[i] = (line[i] + line[i - bpp]) & 255;
        break;
      case 2:
        for (let i = 0; i < stride; i += 1) line[i] = (line[i] + previous[i]) & 255;
        break;
      case 3:
        for (let i = 0; i < stride; i += 1) {
          const left = i >= bpp ? line[i - bpp] : 0;
          line[i] = (line[i] + ((left + previous[i]) >> 1)) & 255;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i += 1) {
          const a = i >= bpp ? line[i - bpp] : 0;
          const b = previous[i];
          const c = i >= bpp ? previous[i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          line[i] = (line[i] + pr) & 255;
        }
        break;
      default: throw new Error(`unknown PNG filter ${filter}`);
    }
    line.copy(pixels, y * stride);
    previous = line;
  }
  return { width, height, bpp, pixels };
}

/**
 * Luminance/contrast/edge statistics, plus the two "this is not a picture"
 * flags the capture round actually needs.
 *
 * `featureless` is deliberately a CONJUNCTION of two independent signals - the
 * frame has almost no local contrast AND its average sits against one end of
 * the range. A legitimately bright or dark card still has edges; a white-out
 * or a black surface has neither.
 */
export function pngStats(buffer, { sampleStep = 2 } = {}) {
  const { width, height, bpp, pixels } = decodePng(buffer);
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < pixels.length; i += bpp, p += 1) {
    luma[p] = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
  }
  let sum = 0;
  for (let i = 0; i < luma.length; i += 1) sum += luma[i];
  const mean = sum / luma.length;
  let variance = 0;
  for (let i = 0; i < luma.length; i += 1) variance += (luma[i] - mean) ** 2;
  variance /= luma.length;

  let edges = 0; let sampled = 0;
  for (let y = 1; y < height - 1; y += sampleStep) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += sampleStep) {
      const c = luma[row + x];
      sampled += 1;
      if (Math.abs(c - luma[row + x + 1]) > 12 || Math.abs(c - luma[row + width + x]) > 12) edges += 1;
    }
  }
  const colours = new Set();
  for (let i = 0; i < pixels.length; i += bpp * 7) {
    colours.add(((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4));
  }
  const bands = [];
  for (let k = 0; k < 3; k += 1) {
    const y0 = Math.floor((height * k) / 3);
    const y1 = Math.floor((height * (k + 1)) / 3);
    let bandSum = 0;
    for (let i = y0 * width; i < y1 * width; i += 1) bandSum += luma[i];
    bands.push(+(bandSum / ((y1 - y0) * width)).toFixed(1));
  }
  const edgeDensity = sampled ? edges / sampled : 0;
  const stdev = Math.sqrt(variance);
  return {
    width,
    height,
    meanLuma: +mean.toFixed(1),
    stdevLuma: +stdev.toFixed(1),
    edgeDensity: +edgeDensity.toFixed(3),
    quantColours: colours.size,
    bandsTopMidBottom: bands,
    /** No local detail and pinned against one end of the range. */
    featureless: edgeDensity < 0.06 && (mean > 235 || mean < 20),
    blownOut: mean > 235,
    nearBlack: mean < 20,
    note: 'regression signal only; image statistics cannot approve a quality bar',
  };
}

export default pngStats;
