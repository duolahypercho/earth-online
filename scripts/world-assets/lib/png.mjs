// Minimal dependency-free PNG codec for the world-asset vendoring pipeline.
//
// Scope is deliberately narrow: what ambientCG ships and what we write back.
//   decode: non-interlaced, bit depth 8 or 16, colour types 0/2/4/6, filters 0-4
//   encode: 8-bit RGBA or RGB, filter 0/1/2/3/4 chosen per scanline (adaptive)
//
// Everything is exact integer work on Buffers, so a re-run of the pipeline
// produces byte-identical output and the provenance hashes stay stable.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, width, height, bpp, stride) {
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const type = raw[pos];
    pos += 1;
    const line = pos;
    raw.copy(out, y * stride, line, line + stride);
    pos += stride;
    const row = y * stride;
    const prev = row - stride;
    switch (type) {
      case 0: break;
      case 1:
        for (let i = bpp; i < stride; i += 1) out[row + i] = (out[row + i] + out[row + i - bpp]) & 255;
        break;
      case 2:
        if (y > 0) for (let i = 0; i < stride; i += 1) out[row + i] = (out[row + i] + out[prev + i]) & 255;
        break;
      case 3:
        for (let i = 0; i < stride; i += 1) {
          const a = i >= bpp ? out[row + i - bpp] : 0;
          const b = y > 0 ? out[prev + i] : 0;
          out[row + i] = (out[row + i] + ((a + b) >> 1)) & 255;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i += 1) {
          const a = i >= bpp ? out[row + i - bpp] : 0;
          const b = y > 0 ? out[prev + i] : 0;
          const c = i >= bpp && y > 0 ? out[prev + i - bpp] : 0;
          out[row + i] = (out[row + i] + paeth(a, b, c)) & 255;
        }
        break;
      default: throw new Error(`unsupported PNG filter ${type} on row ${y}`);
    }
  }
  return out;
}

/**
 * Decode a PNG buffer to 8-bit RGBA.
 * @returns {{width:number,height:number,data:Uint8Array}} data is RGBA, row-major, top-down.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let pos = 8;
  let width = 0; let height = 0; let depth = 0; let colorType = 0; let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + 4, pos + 8);
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (interlace !== 0) throw new Error('interlaced PNG is not supported by this pipeline');
  if (depth !== 8 && depth !== 16) throw new Error(`unsupported PNG bit depth ${depth}`);
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const sampleBytes = depth / 8;
  const bpp = channels * sampleBytes;
  const stride = width * bpp;
  const raw = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, bpp, stride);

  const data = new Uint8Array(width * height * 4);
  const read = (row, x, c) => {
    const at = row * stride + (x * channels + c) * sampleBytes;
    return depth === 16 ? raw[at] : raw[at];  // take the high byte of a 16-bit sample
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 0) {
        const g = read(y, x, 0);
        data[o] = g; data[o + 1] = g; data[o + 2] = g; data[o + 3] = 255;
      } else if (colorType === 2) {
        data[o] = read(y, x, 0); data[o + 1] = read(y, x, 1); data[o + 2] = read(y, x, 2); data[o + 3] = 255;
      } else if (colorType === 3) {
        const i = raw[y * stride + x];
        data[o] = palette[i * 3]; data[o + 1] = palette[i * 3 + 1]; data[o + 2] = palette[i * 3 + 2];
        data[o + 3] = transparency && i < transparency.length ? transparency[i] : 255;
      } else if (colorType === 4) {
        const g = read(y, x, 0);
        data[o] = g; data[o + 1] = g; data[o + 2] = g; data[o + 3] = read(y, x, 1);
      } else {
        data[o] = read(y, x, 0); data[o + 1] = read(y, x, 1);
        data[o + 2] = read(y, x, 2); data[o + 3] = read(y, x, 3);
      }
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeInt32BE(zlib.crc32
    ? zlib.crc32(out.subarray(4, 8 + body.length)) | 0
    : crc32(out.subarray(4, 8 + body.length)) | 0, 8 + body.length);
  return out;
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return c ^ -1;
}

/**
 * Encode 8-bit RGBA (or RGB when `alpha` is false) with adaptive per-row
 * filtering and maximum deflate, deterministically.
 */
export function encodePng({ width, height, data }, { alpha = true } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  const line = Buffer.alloc(stride);
  const candidate = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4;
      const d = x * channels;
      line[d] = data[s]; line[d + 1] = data[s + 1]; line[d + 2] = data[s + 2];
      if (alpha) line[d + 3] = data[s + 3];
    }
    let bestType = 0;
    let bestScore = Infinity;
    let best = null;
    for (let type = 0; type <= 4; type += 1) {
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? line[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        let v;
        if (type === 0) v = line[i];
        else if (type === 1) v = (line[i] - a) & 255;
        else if (type === 2) v = (line[i] - b) & 255;
        else if (type === 3) v = (line[i] - ((a + b) >> 1)) & 255;
        else v = (line[i] - paeth(a, b, c)) & 255;
        candidate[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestType = type; best = Buffer.from(candidate); }
    }
    raw[y * (stride + 1)] = bestType;
    best.copy(raw, y * (stride + 1) + 1);
    prev = Buffer.from(line);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9, memLevel: 9, strategy: zlib.constants.Z_DEFAULT_STRATEGY });
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
