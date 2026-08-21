// Deterministic 8-bit RGBA image operations for the world-asset pipeline.
// No dependencies, no floating-point RNG from the platform: every random draw
// comes from a string-seeded mulberry32, so a re-run reproduces the bytes.

export function makeImage(width, height, fill = [0, 0, 0, 0]) {
  const data = new Uint8Array(width * height * 4);
  if (fill.some((v) => v !== 0)) {
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1];
      data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = fill[3];
    }
  }
  return { width, height, data };
}

export function hashString(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = hashString(String(seed)) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function srgbToLinear(v) { return SRGB_TO_LINEAR[v]; }
export function linearToSrgb(x) {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * (x ** (1 / 2.4)) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/** Box-filter resize. Exact integer accumulation over source pixels. */
export function resize(image, width, height) {
  const out = makeImage(width, height);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let j = y0; j < y1 && j < image.height; j += 1) {
        for (let i = x0; i < x1 && i < image.width; i += 1) {
          const s = (j * image.width + i) * 4;
          const w = image.data[s + 3];
          r += image.data[s] * w; g += image.data[s + 1] * w; b += image.data[s + 2] * w;
          a += w; n += 1;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = n > 0 ? Math.round(a / n) : 0;
    }
  }
  return out;
}

/**
 * Label 4-connected runs of `alpha >= threshold` and return one sprite per run
 * whose area is at least `minArea` pixels, largest first.
 */
export function extractSprites(color, opacity, { threshold = 24, minArea = 900 } = {}) {
  const { width, height } = color;
  const label = new Int32Array(width * height).fill(-1);
  const stack = new Int32Array(width * height);
  const sprites = [];
  let next = 0;
  for (let start = 0; start < width * height; start += 1) {
    if (label[start] !== -1) continue;
    if (opacity.data[start * 4] < threshold) { label[start] = -2; continue; }
    let top = 0;
    stack[top] = start;
    top += 1;
    label[start] = next;
    let minX = width; let maxX = -1; let minY = height; let maxY = -1; let area = 0;
    const members = [];
    while (top > 0) {
      top -= 1;
      const p = stack[top];
      const x = p % width;
      const y = (p - x) / width;
      members.push(p);
      area += 1;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const push = (q) => {
        if (label[q] !== -1) return;
        if (opacity.data[q * 4] < threshold) { label[q] = -2; return; }
        label[q] = next;
        stack[top] = q;
        top += 1;
      };
      if (x > 0) push(p - 1);
      if (x < width - 1) push(p + 1);
      if (y > 0) push(p - width);
      if (y < height - 1) push(p + width);
    }
    if (area < minArea) { next += 1; continue; }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const sprite = makeImage(w, h);
    for (const p of members) {
      const x = p % width;
      const y = (p - x) / width;
      const o = ((y - minY) * w + (x - minX)) * 4;
      sprite.data[o] = color.data[p * 4];
      sprite.data[o + 1] = color.data[p * 4 + 1];
      sprite.data[o + 2] = color.data[p * 4 + 2];
      sprite.data[o + 3] = opacity.data[p * 4];
    }
    sprites.push({ image: sprite, area });
    next += 1;
  }
  sprites.sort((a, b) => b.area - a.area);
  return sprites;
}

/**
 * Alpha-over a sprite into `dst`, rotated about its centre, scaled, optionally
 * mirrored, and multiplied by a linear RGB gain. Bilinear inverse sampling.
 */
export function stamp(dst, sprite, {
  cx, cy, scale = 1, rotation = 0, flip = false, gain = [1, 1, 1], alphaGain = 1,
}) {
  const sw = sprite.width;
  const sh = sprite.height;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const half = Math.ceil((Math.abs(sw * cos) + Math.abs(sh * sin)) * scale / 2) + 2;
  const halfY = Math.ceil((Math.abs(sw * sin) + Math.abs(sh * cos)) * scale / 2) + 2;
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(dst.width - 1, Math.ceil(cx + half));
  const y0 = Math.max(0, Math.floor(cy - halfY));
  const y1 = Math.min(dst.height - 1, Math.ceil(cy + halfY));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = (x + 0.5 - cx) / scale;
      const dy = (y + 0.5 - cy) / scale;
      let u = dx * cos + dy * sin + sw / 2;
      const v = -dx * sin + dy * cos + sh / 2;
      if (flip) u = sw - u;
      if (u < 0 || v < 0 || u >= sw - 1 || v >= sh - 1) continue;
      const iu = Math.floor(u);
      const iv = Math.floor(v);
      const fu = u - iu;
      const fv = v - iv;
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let j = 0; j < 2; j += 1) {
        for (let i = 0; i < 2; i += 1) {
          const w = (i ? fu : 1 - fu) * (j ? fv : 1 - fv);
          const s = ((iv + j) * sw + (iu + i)) * 4;
          const sa = sprite.data[s + 3] / 255;
          r += sprite.data[s] * sa * w;
          g += sprite.data[s + 1] * sa * w;
          b += sprite.data[s + 2] * sa * w;
          a += sa * w;
        }
      }
      if (a <= 0.002) continue;
      const sr = Math.min(255, (r / a) * gain[0]);
      const sg = Math.min(255, (g / a) * gain[1]);
      const sb = Math.min(255, (b / a) * gain[2]);
      const sa = Math.min(1, a * alphaGain);
      const o = (y * dst.width + x) * 4;
      const da = dst.data[o + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      dst.data[o] = Math.round((sr * sa + dst.data[o] * da * (1 - sa)) / outA);
      dst.data[o + 1] = Math.round((sg * sa + dst.data[o + 1] * da * (1 - sa)) / outA);
      dst.data[o + 2] = Math.round((sb * sa + dst.data[o + 2] * da * (1 - sa)) / outA);
      dst.data[o + 3] = Math.round(outA * 255);
    }
  }
}

/**
 * Push colour outward into transparent pixels so a mipmapped alpha-tested card
 * never fringes toward the clear-colour when the filter blends across an edge.
 */
export function dilate(image, passes = 6) {
  const { width, height, data } = image;
  const filled = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) filled[i] = data[i * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < passes; pass += 1) {
    const added = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        if (filled[p]) continue;
        let r = 0; let g = 0; let b = 0; let n = 0;
        for (let j = -1; j <= 1; j += 1) {
          for (let i = -1; i <= 1; i += 1) {
            const qx = x + i;
            const qy = y + j;
            if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
            const q = qy * width + qx;
            if (!filled[q]) continue;
            r += data[q * 4]; g += data[q * 4 + 1]; b += data[q * 4 + 2]; n += 1;
          }
        }
        if (n === 0) continue;
        added.push([p, Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
      }
    }
    if (!added.length) break;
    for (const [p, r, g, b] of added) {
      data[p * 4] = r; data[p * 4 + 1] = g; data[p * 4 + 2] = b;
      filled[p] = 1;
    }
  }
  return image;
}

/** Mean linear value per channel over pixels with alpha >= `threshold`. */
export function opaqueMeanLinear(image, threshold = 128) {
  const sums = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < image.width * image.height; i += 1) {
    if (image.data[i * 4 + 3] < threshold) continue;
    sums[0] += SRGB_TO_LINEAR[image.data[i * 4]];
    sums[1] += SRGB_TO_LINEAR[image.data[i * 4 + 1]];
    sums[2] += SRGB_TO_LINEAR[image.data[i * 4 + 2]];
    n += 1;
  }
  return n ? { mean: sums.map((s) => s / n), pixels: n } : { mean: [0, 0, 0], pixels: 0 };
}

/**
 * Rescale linear RGB by a per-channel gain, then optionally pull chroma toward
 * luminance by `desaturate`. Alpha untouched.
 */
export function gradeLinear(image, gain, desaturate = 0) {
  const { data } = image;
  for (let i = 0; i < image.width * image.height; i += 1) {
    const o = i * 4;
    let r = SRGB_TO_LINEAR[data[o]] * gain[0];
    let g = SRGB_TO_LINEAR[data[o + 1]] * gain[1];
    let b = SRGB_TO_LINEAR[data[o + 2]] * gain[2];
    if (desaturate > 0) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r += (y - r) * desaturate; g += (y - g) * desaturate; b += (y - b) * desaturate;
    }
    data[o] = linearToSrgb(r); data[o + 1] = linearToSrgb(g); data[o + 2] = linearToSrgb(b);
  }
  return image;
}

/** Copy `src` into `dst` at (x, y), replacing (not blending). */
export function blit(dst, src, x, y) {
  for (let j = 0; j < src.height; j += 1) {
    const dy = y + j;
    if (dy < 0 || dy >= dst.height) continue;
    for (let i = 0; i < src.width; i += 1) {
      const dx = x + i;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (j * src.width + i) * 4;
      const o = (dy * dst.width + dx) * 4;
      dst.data[o] = src.data[s]; dst.data[o + 1] = src.data[s + 1];
      dst.data[o + 2] = src.data[s + 2]; dst.data[o + 3] = src.data[s + 3];
    }
  }
  return dst;
}
