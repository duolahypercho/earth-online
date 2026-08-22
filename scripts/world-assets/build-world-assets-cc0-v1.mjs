#!/usr/bin/env node
// Re-runnable vendoring pipeline for the CC0 world-asset slate.
//
//   node scripts/world-assets/build-world-assets-cc0-v1.mjs [--check]
//
// WHY THIS EXISTS
//
// The street trees used to be solid icosahedral leaf clusters, which is the
// "low-polygon blob tree" every visual review round has rejected. Replacing
// them with alpha-tested cross-cards needs a leaf alpha atlas, and an atlas
// that arrived by hand would be unreproducible and unattributed. This script
// is the provenance: it downloads the upstream source archives, verifies each
// one against a pinned SHA-256, repacks them deterministically, and writes the
// outputs together with a provenance record, a NOTICE and the licence text.
//
// LICENCE POSTURE. Every source below is from one library that publishes its
// whole catalogue under CC0 1.0 Universal (public domain dedication). The
// licence was verified by fetching the publisher's own licence page, not
// assumed; the URL and the retrieved statement are recorded in the provenance.
// CC0 requires no attribution, but the publisher requests it and this repo
// records provenance regardless, so the NOTICE names source, asset and licence.
// Nothing here is scanned or ripped from any commercial product, and no source
// carries a brand mark: they are photographs of leaves, road paint, asphalt and
// street ironwork.
//
// DETERMINISM. No Math.random, no Date.now in any output path. Every placement
// is a string-seeded mulberry32 draw and every filter is integer or exactly
// specified float work, so a re-run reproduces the output bytes and therefore
// the provenance hashes. `--check` re-runs the build and fails if any output
// would change, which is what makes the recorded hashes meaningful.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from './lib/png.mjs';
import { listZip, readZipEntry } from './lib/zip.mjs';
import {
  makeImage, blit, resize, extractSprites, stamp, dilate, opaqueMeanLinear,
  gradeLinear, rng, srgbToLinear, linearToSrgb,
} from './lib/image.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ASSETS = path.join(REPO, 'public', 'assets');
const CACHE = process.env.WORLD_ASSET_CACHE || path.join(REPO, 'tmp', 'world-assets-cache');
const CHECK_ONLY = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// source manifest
// ---------------------------------------------------------------------------

const SOURCE = Object.freeze({
  library: 'ambientCG',
  homepage: 'https://ambientcg.com/',
  licenseUrl: 'https://docs.ambientcg.com/license/',
  spdx: 'CC0-1.0',
  licenseName: 'Creative Commons CC0 1.0 Universal',
  licenseStatement: 'All ambientCG assets are provided under the Creative Commons CC0 1.0 Universal License. '
    + 'This applies to the downloadable asset files and the material preview renders shown for each asset on the site.',
  licenseVerifiedOn: '2026-08-21',
  attributionRequested: 'Created using <asset name> from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License.',
});

/** Every archive the build reads, with the digest it must have. */
const DOWNLOADS = Object.freeze([
  { id: 'leafMaple', file: 'LeafSet010_1K-PNG.zip', assetId: 'LeafSet010', assetPage: 'https://ambientcg.com/a/LeafSet010', sha256: 'eb9eaa00b8748fb49e3000c90987b78c1334e3b518dad8210d353229b6cee48c' },
  { id: 'leafOvate', file: 'LeafSet003_1K-PNG.zip', assetId: 'LeafSet003', assetPage: 'https://ambientcg.com/a/LeafSet003', sha256: '48b5aa90d48c1e076e87b2df0370e67c5ee9a330c96061d78645ea6c15738384' },
  { id: 'roadLineWorn', file: 'RoadLines032C_1K-PNG.zip', assetId: 'RoadLines032C', assetPage: 'https://ambientcg.com/a/RoadLines032C', sha256: '3417621d667a447213c6eb9c6c49be20a38bb15f1348fc3ed39bd1217eb64724' },
  { id: 'tyreTrack', file: 'TireTracks001_1K-PNG.zip', assetId: 'TireTracks001', assetPage: 'https://ambientcg.com/a/TireTracks001', sha256: '6b8fbe4cc2deb71575660be3f4d7cc2ee98099854ae7dc311ae3e9108ee51cef' },
  { id: 'asphaltDamage', file: 'AsphaltDamage001_1K-PNG.zip', assetId: 'AsphaltDamage001', assetPage: 'https://ambientcg.com/a/AsphaltDamage001', sha256: 'e7495c7ed145179d828fc82b1d03b7a00ab29040e7e33c1510545de66a75460c' },
  { id: 'manholeCover', file: 'ManholeCover011_1K-PNG.zip', assetId: 'ManholeCover011', assetPage: 'https://ambientcg.com/a/ManholeCover011', sha256: '8720de52e8fd493a151c171efca938df829a1d30a59c49aa7a6139c97e4f130b' },
  { id: 'tactilePaving', file: 'TactilePaving001_1K-PNG.zip', assetId: 'TactilePaving001', assetPage: 'https://ambientcg.com/a/TactilePaving001', sha256: '100fd65499d3fa3094f6341ba6c83841d45cdfed1bee336ae0448440f6682556' },
]);

const LEGALCODE = Object.freeze({
  file: 'cc0-1.0-legalcode.txt',
  url: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt',
  sha256: 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
});

// ---------------------------------------------------------------------------
// leaf atlas layout - MUST match STREET_TREE_ATLAS in
// src/render/passes/street-furniture.js. The verifier asserts the two agree.
// ---------------------------------------------------------------------------

export const ATLAS = Object.freeze({
  width: 1024,
  height: 1024,
  // Four leaf-cluster cells, 512 x 384 each, over the top 768 rows.
  cellWidth: 512,
  cellHeight: 384,
  cells: Object.freeze([
    Object.freeze({ id: 'maple-a', x: 0, y: 0, source: 'leafMaple', seed: 'cluster-maple-a' }),
    Object.freeze({ id: 'maple-b', x: 512, y: 0, source: 'leafMaple', seed: 'cluster-maple-b' }),
    Object.freeze({ id: 'ovate-a', x: 0, y: 384, source: 'leafOvate', seed: 'cluster-ovate-a' }),
    Object.freeze({ id: 'ovate-b', x: 512, y: 384, source: 'leafOvate', seed: 'cluster-ovate-b' }),
  ]),
  // A fully opaque bark strip across the bottom quarter. Anything in the tree
  // that is NOT a leaf card samples this, including any part that inherited the
  // default (0, 0) uv, so a missing uv can never be alpha-tested away.
  bark: Object.freeze({ x: 0, y: 768, width: 1024, height: 256, tileColumns: 4 }),
  // Per-channel linear mean the leaf and bark pixels are normalised to, so the
  // pass can carry the real palette in its vertex colours and multiply by this
  // texture without the tone drifting. See STREET_TREE_ATLAS.normalisedMean.
  //
  // 0.28 linear, not 0.5: at 0.5 the brightest sunlit leaves clipped to white
  // and lost the vein and edge detail that is the whole reason for using a
  // photographic source. The pass multiplies by 1 / normalisedMean, so the
  // rendered tone is unchanged by this choice - only the headroom is.
  normalisedMean: 0.28,
});

const LEAF_CLUSTER = Object.freeze({
  leaves: 300,
  // Leaf long-axis as a fraction of the cell height.
  minLeaf: 0.14,
  maxLeaf: 0.27,
  // Lobed radial mask, as a fraction of the space left after a leaf's own
  // half-size is reserved, so the mass fills the cell and NEVER crosses into
  // the neighbouring cell - a clipped leaf would show as a straight cut in the
  // silhouette and would bleed across the cell edge in the lower mips.
  lobeBase: 1.0,
  lobes: Object.freeze([
    Object.freeze({ k: 3, amplitude: 0.11 }),
    Object.freeze({ k: 5, amplitude: 0.075 }),
    Object.freeze({ k: 7, amplitude: 0.05 }),
  ]),
  // Per-leaf luminance range; the crown's own top-to-bottom ramp is baked into
  // the geometry's vertex colours, this is the leaf-to-leaf variation inside
  // one card that makes the mass read as leaves rather than as a green shape.
  minGain: 0.52,
  maxGain: 1.30,
  verticalRamp: 0.42,
  radialBias: 0.42,
  // 1 = the leaf mass is the ellipse inscribed in the cell, 0 = it fills the
  // cell rectangle. Filling the rectangle is denser but the card's own straight
  // edge starts to read in the crown silhouette, so this sits near the ellipse.
  corner: 0.75,
  // Clear texels kept between the leaf mass and the cell border, so a lower mip
  // cannot blend one cell's leaves into its neighbour's.
  cellMargin: 10,
  matteLow: 0.35,
  matteHigh: 0.78,
  desaturate: 0.30,
  dilatePasses: 8,
});

const DECALS = Object.freeze([
  { id: 'roadLineWorn', output: 'decal-road-line-worn-v1.png', size: 512, alpha: true, note: 'worn dashed carriageway line, cracked asphalt bed' },
  { id: 'tyreTrack', output: 'decal-tyre-track-v1.png', size: 512, alpha: true, note: 'tyre tread track; upstream substrate is loose ground, use as a tread stencil not as a bed' },
  { id: 'asphaltDamage', output: 'decal-asphalt-damage-v1.png', size: 512, alpha: true, note: 'crack and break-up patch for a carriageway' },
  { id: 'manholeCover', output: 'decal-manhole-cover-v1.png', size: 512, alpha: true, note: 'square rusted cast cover with a concrete surround' },
  { id: 'tactilePaving', output: 'surface-tactile-paving-warning-v1.png', size: 512, alpha: false, note: 'tileable detectable-warning surface, colour only' },
]);

const LEAF_ATLAS_OUTPUT = 'street-tree-leaf-atlas-v1.png';
const PROVENANCE_OUTPUT = 'world-assets-cc0-v1.provenance.json';
const NOTICE_OUTPUT = 'world-assets-cc0-v1.NOTICE.txt';
const LICENSE_OUTPUT = 'world-assets-cc0-v1.LICENSE.txt';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function fetchToCache(entry) {
  const target = path.join(CACHE, entry.file);
  if (!(await exists(target))) {
    const url = entry.url || `https://ambientcg.com/get?file=${entry.file}`;
    process.stdout.write(`  fetching ${entry.file} ... `);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    await writeFile(target, body);
    process.stdout.write(`${body.length} B\n`);
  }
  const buffer = await readFile(target);
  const digest = sha256(buffer);
  if (entry.sha256 && entry.sha256 !== digest) {
    throw new Error(`${entry.file}: expected sha256 ${entry.sha256}, got ${digest}. `
      + 'The upstream file changed - review it before re-pinning.');
  }
  return { buffer, digest };
}

function zipMap(buffer, suffix) {
  const entries = listZip(buffer);
  const found = entries.find((e) => e.name.endsWith(suffix));
  if (!found) return null;
  return decodePng(readZipEntry(buffer, found));
}

/** Colour + opacity from one archive, as a single RGBA image. */
function rgbaFromArchive(buffer) {
  const colour = zipMap(buffer, '_Color.png');
  if (!colour) throw new Error('archive has no _Color.png');
  const opacity = zipMap(buffer, '_Opacity.png');
  if (opacity) {
    for (let i = 0; i < colour.width * colour.height; i += 1) {
      colour.data[i * 4 + 3] = opacity.data[i * 4];
    }
  }
  return colour;
}

// ---------------------------------------------------------------------------
// leaf cluster cell
// ---------------------------------------------------------------------------

function buildClusterCell(sprites, seed) {
  const { cellWidth: w, cellHeight: h } = ATLAS;
  const cell = makeImage(w, h);
  const random = rng(seed);
  const cx = w / 2;
  const cy = h / 2;
  const phase = LEAF_CLUSTER.lobes.map(() => random() * Math.PI * 2);
  const radiusAt = (angle) => {
    let r = LEAF_CLUSTER.lobeBase;
    LEAF_CLUSTER.lobes.forEach((lobe, i) => {
      r += lobe.amplitude * Math.sin(lobe.k * angle + phase[i]);
    });
    return r;
  };

  // Back-to-front: deep, dark leaves first so the bright outer leaves finish on
  // top and the mass has depth instead of one flat layer.
  const placements = [];
  for (let i = 0; i < LEAF_CLUSTER.leaves; i += 1) {
    const angle = random() * Math.PI * 2;
    const t = random() ** LEAF_CLUSTER.radialBias;
    const rMax = Math.min(1, radiusAt(angle));
    const sprite = sprites[Math.floor(random() * sprites.length) % sprites.length].image;
    const long = Math.max(sprite.width, sprite.height);
    const target = h * (LEAF_CLUSTER.minLeaf + (LEAF_CLUSTER.maxLeaf - LEAF_CLUSTER.minLeaf) * random());
    const leafHalf = target / 2;
    const box = Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
    const reach = t * rMax / (box * (1 - LEAF_CLUSTER.corner) + LEAF_CLUSTER.corner);
    const rx = Math.cos(angle) * reach * Math.max(0, w / 2 - leafHalf - LEAF_CLUSTER.cellMargin);
    const ry = Math.sin(angle) * reach * Math.max(0, h / 2 - leafHalf - LEAF_CLUSTER.cellMargin);
    placements.push({
      angle, t, x: cx + rx, y: cy + ry, order: random(), sprite, scale: target / long,
    });
  }
  placements.sort((a, b) => (b.t - a.t) || (a.order - b.order));

  for (const place of placements) {
    const { sprite, scale } = place;
    // The petiole points back toward the middle of the mass, the way a leaf
    // hangs off a twig, with enough jitter that no two read as a stamp.
    const rotation = place.angle + Math.PI / 2 + (random() - 0.5) * 1.5;
    const vertical = 1 - place.y / h;
    const shade = LEAF_CLUSTER.minGain
      + (LEAF_CLUSTER.maxGain - LEAF_CLUSTER.minGain) * random()
      + LEAF_CLUSTER.verticalRamp * (vertical - 0.5);
    const g = Math.max(0.2, shade);
    stamp(cell, sprite, {
      cx: place.x, cy: place.y, scale, rotation,
      flip: random() < 0.5,
      gain: [g * (0.94 + random() * 0.12), g, g * (0.92 + random() * 0.16)],
    });
  }
  return cell;
}

/**
 * Procedural bark. Horizontally periodic with period `width / tileColumns`, so
 * a trunk cylinder can wrap one column with no seam. Deterministic harmonics,
 * no noise texture and therefore no fourth-party asset to license.
 */
function buildBarkStrip() {
  const { width: w, height: h, tileColumns } = ATLAS.bark;
  const strip = makeImage(w, h, [0, 0, 0, 255]);
  const random = rng('street-tree-bark-v1');
  const harmonics = [];
  for (let i = 0; i < 14; i += 1) {
    harmonics.push({
      k: tileColumns * (1 + i * 2),          // periodic over one column
      a: 0.34 / (1 + i * 0.8),
      p: random() * Math.PI * 2,
      ky: 0.5 + i * 0.7,
      py: random() * Math.PI * 2,
    });
  }
  for (let y = 0; y < h; y += 1) {
    const v = y / h;
    for (let x = 0; x < w; x += 1) {
      const u = x / w;
      let value = 0;
      for (const harmonic of harmonics) {
        value += harmonic.a * Math.sin(2 * Math.PI * harmonic.k * u + harmonic.p
          + 0.9 * Math.sin(2 * Math.PI * harmonic.ky * v + harmonic.py));
      }
      // Sharpen into ridges and fissures rather than a smooth wobble.
      const ridge = Math.tanh(value * 1.7) * 0.5 + 0.5;
      const fissure = ridge ** 1.9;
      const linear = 0.18 + 0.64 * fissure;
      const o = (y * w + x) * 4;
      strip.data[o] = linearToSrgb(linear * 1.06);
      strip.data[o + 1] = linearToSrgb(linear * 0.98);
      strip.data[o + 2] = linearToSrgb(linear * 0.88);
      strip.data[o + 3] = 255;
    }
  }
  return strip;
}

function normaliseToMean(image, target) {
  const before = opaqueMeanLinear(image, 128);
  const gain = before.mean.map((m) => (m > 1e-6 ? target / m : 1));
  gradeLinear(image, gain, 0);
  const after = opaqueMeanLinear(image, 128);
  return { before: before.mean, gain, after: after.mean, pixels: before.pixels };
}

/** Crop a region out of an image (used to normalise the leaf and bark halves apart). */
function crop(image, x, y, width, height) {
  const out = makeImage(width, height);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const s = ((y + j) * image.width + (x + i)) * 4;
      const o = (j * width + i) * 4;
      out.data[o] = image.data[s]; out.data[o + 1] = image.data[s + 1];
      out.data[o + 2] = image.data[s + 2]; out.data[o + 3] = image.data[s + 3];
    }
  }
  return out;
}

async function buildLeafAtlas(archives) {
  const spriteSets = new Map();
  for (const key of ['leafMaple', 'leafOvate']) {
    const buffer = archives.get(key).buffer;
    const colour = zipMap(buffer, '_Color.png');
    const opacity = zipMap(buffer, '_Opacity.png');
    if (!colour || !opacity) throw new Error(`${key}: archive is missing colour or opacity`);
    // Erode the soft edge of the upstream matte. Those partly transparent
    // pixels carry the white studio background mixed into the leaf colour, and
    // per-channel normalisation turns that into a bright rim around every leaf.
    // Remapping 0.35..0.78 to 0..1 throws the contaminated band away and leaves
    // a clean edge for the alpha test.
    for (let i = 0; i < opacity.width * opacity.height; i += 1) {
      const a = opacity.data[i * 4] / 255;
      const v = Math.max(0, Math.min(1, (a - LEAF_CLUSTER.matteLow)
        / (LEAF_CLUSTER.matteHigh - LEAF_CLUSTER.matteLow)));
      const b = Math.round(v * 255);
      opacity.data[i * 4] = b; opacity.data[i * 4 + 1] = b; opacity.data[i * 4 + 2] = b;
    }
    const sprites = extractSprites(colour, opacity, { threshold: 32, minArea: 2000 });
    if (!sprites.length) throw new Error(`${key}: no leaf found in the opacity mask`);
    spriteSets.set(key, sprites);
  }

  const atlas = makeImage(ATLAS.width, ATLAS.height);
  const cellStats = [];
  for (const cell of ATLAS.cells) {
    const image = buildClusterCell(spriteSets.get(cell.source), cell.seed);
    dilate(image, LEAF_CLUSTER.dilatePasses);
    let opaque = 0;
    for (let i = 0; i < image.width * image.height; i += 1) if (image.data[i * 4 + 3] >= 128) opaque += 1;
    cellStats.push({
      id: cell.id,
      source: archives.get(cell.source).assetId,
      leaves: LEAF_CLUSTER.leaves,
      coverage: Number((opaque / (image.width * image.height)).toFixed(4)),
    });
    blit(atlas, image, cell.x, cell.y);
  }
  blit(atlas, buildBarkStrip(), ATLAS.bark.x, ATLAS.bark.y);

  // Desaturate the upstream nursery-green toward the dusty olive a downtown
  // street tree actually shows, then normalise the per-channel linear mean so
  // the pass's palette does the colouring. Leaves and bark are normalised
  // SEPARATELY: one shared gain would make the crown darker and the trunk
  // brighter than the palette says, because bark is the lighter of the two.
  const leafRegion = crop(atlas, 0, 0, ATLAS.width, ATLAS.bark.y);
  gradeLinear(leafRegion, [1, 1, 1], LEAF_CLUSTER.desaturate);
  const normalisation = normaliseToMean(leafRegion, ATLAS.normalisedMean);
  blit(atlas, leafRegion, 0, 0);
  const barkRegion = crop(atlas, ATLAS.bark.x, ATLAS.bark.y, ATLAS.bark.width, ATLAS.bark.height);
  const barkNormalisation = normaliseToMean(barkRegion, ATLAS.normalisedMean);
  blit(atlas, barkRegion, ATLAS.bark.x, ATLAS.bark.y);

  let opaquePixels = 0;
  let clipped = 0;
  for (let i = 0; i < ATLAS.width * ATLAS.height; i += 1) {
    if (atlas.data[i * 4 + 3] < 128) continue;
    opaquePixels += 1;
    if (atlas.data[i * 4] === 255 || atlas.data[i * 4 + 1] === 255 || atlas.data[i * 4 + 2] === 255) clipped += 1;
  }

  return {
    png: encodePng(atlas, { alpha: true }),
    stats: {
      width: ATLAS.width,
      height: ATLAS.height,
      cells: cellStats,
      desaturate: LEAF_CLUSTER.desaturate,
      normalisedMeanTarget: ATLAS.normalisedMean,
      meanLinearBefore: normalisation.before.map((v) => Number(v.toFixed(5))),
      normalisationGain: normalisation.gain.map((v) => Number(v.toFixed(5))),
      meanLinearAfter: normalisation.after.map((v) => Number(v.toFixed(5))),
      barkMeanLinearBefore: barkNormalisation.before.map((v) => Number(v.toFixed(5))),
      barkNormalisationGain: barkNormalisation.gain.map((v) => Number(v.toFixed(5))),
      barkMeanLinearAfter: barkNormalisation.after.map((v) => Number(v.toFixed(5))),
      opaqueFraction: Number((opaquePixels / (ATLAS.width * ATLAS.height)).toFixed(4)),
      clippedChannelFraction: Number((clipped / Math.max(1, opaquePixels)).toFixed(5)),
      dilatePasses: LEAF_CLUSTER.dilatePasses,
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(CACHE, { recursive: true });
  console.log(`source library : ${SOURCE.library} (${SOURCE.spdx})`);
  console.log(`licence page   : ${SOURCE.licenseUrl}`);
  console.log(`cache          : ${CACHE}`);

  const archives = new Map();
  const sources = {};
  for (const entry of DOWNLOADS) {
    const { buffer, digest } = await fetchToCache(entry);
    archives.set(entry.id, { ...entry, buffer, digest });
    sources[entry.id] = {
      assetId: entry.assetId,
      assetPage: entry.assetPage,
      url: `https://ambientcg.com/get?file=${entry.file}`,
      archive: entry.file,
      archiveBytes: buffer.length,
      sha256: digest,
      pinned: entry.sha256 === digest,
      license: SOURCE.spdx,
    };
    console.log(`  ${entry.assetId.padEnd(18)} ${String(buffer.length).padStart(9)} B  sha256 ${digest.slice(0, 16)}…${entry.sha256 ? (entry.sha256 === digest ? '  pinned-ok' : '  PIN MISMATCH') : '  (unpinned)'}`);
  }
  const legal = await fetchToCache(LEGALCODE);

  const outputs = {};
  const written = [];
  const write = async (name, buffer, meta) => {
    const target = path.join(ASSETS, name);
    const digest = sha256(buffer);
    const previous = (await exists(target)) ? await readFile(target) : null;
    const changed = !previous || !previous.equals(buffer);
    if (CHECK_ONLY) {
      if (changed) throw new Error(`--check: ${name} would change (rebuild is not reproducible or the file is stale)`);
    } else if (changed) {
      await writeFile(target, buffer);
    }
    outputs[name] = { path: `public/assets/${name}`, bytes: buffer.length, sha256: digest, ...meta };
    written.push({ name, bytes: buffer.length, changed });
    return digest;
  };

  console.log('\nleaf atlas');
  const atlas = await buildLeafAtlas(archives);
  await write(LEAF_ATLAS_OUTPUT, atlas.png, {
    encoding: 'sRGB RGB + straight alpha, 8-bit RGBA PNG',
    consumedBy: 'src/render/passes/street-furniture.js (STREET_TREE_ATLAS)',
    layout: {
      cells: ATLAS.cells.map((c) => ({ id: c.id, x: c.x, y: c.y, w: ATLAS.cellWidth, h: ATLAS.cellHeight })),
      bark: ATLAS.bark,
    },
    build: atlas.stats,
    sources: ATLAS.cells.map((c) => archives.get(c.source).assetId).filter((v, i, a) => a.indexOf(v) === i)
      .concat('procedural bark (this script, buildBarkStrip)'),
  });
  console.log(`  ${LEAF_ATLAS_OUTPUT}: ${atlas.png.length} B, opaque ${(atlas.stats.opaqueFraction * 100).toFixed(1)}%, `
    + `clipped channels ${(atlas.stats.clippedChannelFraction * 100).toFixed(3)}%, `
    + `leaf mean linear ${atlas.stats.meanLinearAfter.join('/')}`);
  for (const cell of atlas.stats.cells) console.log(`    cell ${cell.id.padEnd(8)} from ${cell.source.padEnd(11)} coverage ${(cell.coverage * 100).toFixed(1)}%`);

  console.log('\ndecal and surface slate');
  for (const decal of DECALS) {
    const archive = archives.get(decal.id);
    const full = rgbaFromArchive(archive.buffer);
    const small = resize(full, decal.size, decal.size);
    if (decal.alpha) dilate(small, 4);
    const png = encodePng(small, { alpha: decal.alpha });
    await write(decal.output, png, {
      encoding: decal.alpha ? 'sRGB RGB + straight alpha, 8-bit RGBA PNG' : 'sRGB, 8-bit RGB PNG',
      sourceAsset: archive.assetId,
      sourceMaps: decal.alpha ? ['Color', 'Opacity'] : ['Color'],
      resample: `box filter ${full.width}x${full.height} -> ${decal.size}x${decal.size}`,
      note: decal.note,
      consumedBy: 'unclaimed - available to the street-surface/detail pass',
    });
    console.log(`  ${decal.output.padEnd(40)} ${String(png.length).padStart(8)} B  from ${archive.assetId}`);
  }

  console.log('\nlicence and notice');
  await write(LICENSE_OUTPUT, legal.buffer, {
    encoding: 'text/plain',
    url: LEGALCODE.url,
    note: 'verbatim CC0 1.0 Universal legal code',
  });

  const notice = [
    'THIRD-PARTY ASSET NOTICE - world-assets-cc0-v1',
    '',
    `Source library : ${SOURCE.library} (${SOURCE.homepage})`,
    `Licence        : ${SOURCE.licenseName} (SPDX: ${SOURCE.spdx})`,
    `Licence page   : ${SOURCE.licenseUrl}`,
    `Verified on    : ${SOURCE.licenseVerifiedOn} by fetching the licence page above.`,
    '',
    'Publisher statement, quoted from that page:',
    `  "${SOURCE.licenseStatement}"`,
    '',
    'CC0 waives the attribution requirement. The publisher asks for credit anyway,',
    'and this repository records provenance for every vendored byte, so:',
    '',
    ...DOWNLOADS.map((d) => `  ${d.assetId} - ${d.assetPage}`),
    '',
    `  ${SOURCE.attributionRequested.replace('<asset name>', DOWNLOADS.map((d) => d.assetId).join(', '))}`,
    '',
    'The bark region of the leaf atlas is not from any third party: it is generated',
    'procedurally by scripts/world-assets/build-world-assets-cc0-v1.mjs.',
    '',
    'Repacked outputs in public/assets/ are derivative works of the CC0 sources and',
    'are themselves offered under CC0 1.0. The full legal code is in',
    `public/assets/${LICENSE_OUTPUT}; the per-file record is in`,
    `public/assets/${PROVENANCE_OUTPUT}.`,
    '',
    'None of these sources is scanned, ripped, or otherwise derived from any',
    'commercial product, and none carries a brand mark.',
    '',
  ].join('\n');
  await write(NOTICE_OUTPUT, Buffer.from(notice, 'utf8'), { encoding: 'text/plain' });

  const provenance = {
    schemaVersion: 1,
    asset: 'world-assets-cc0-v1',
    license: SOURCE.spdx,
    licenseName: SOURCE.licenseName,
    licenseUrl: SOURCE.licenseUrl,
    licenseVerifiedOn: SOURCE.licenseVerifiedOn,
    licenseStatement: SOURCE.licenseStatement,
    attribution: SOURCE.attributionRequested,
    author: `${SOURCE.library} contributors`,
    assetPage: SOURCE.homepage,
    intent: 'presentation-only foliage alpha atlas and street-surface decal slate for the canonical runtime; '
      + 'not survey data, not geometry, and not a source of map truth',
    sources,
    legalCode: {
      url: LEGALCODE.url,
      sha256: legal.digest,
      bytes: legal.buffer.length,
    },
    outputs,
    generator: {
      path: 'scripts/world-assets/build-world-assets-cc0-v1.mjs',
      libraries: ['scripts/world-assets/lib/png.mjs', 'scripts/world-assets/lib/zip.mjs', 'scripts/world-assets/lib/image.mjs'],
      node: process.version.replace(/\.\d+$/, '.x'),
      algorithm: 'zip -> PNG decode -> connected-component leaf extraction -> seeded cluster composition '
        + '-> edge dilation -> desaturate + per-channel linear mean normalisation -> deterministic PNG re-encode',
      determinism: 'string-seeded mulberry32 only; re-runnable with --check, which fails if any output byte changes',
    },
  };
  const provenanceBuffer = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  const provenanceTarget = path.join(ASSETS, PROVENANCE_OUTPUT);
  if (CHECK_ONLY) {
    const previous = (await exists(provenanceTarget)) ? await readFile(provenanceTarget) : null;
    if (!previous || !previous.equals(provenanceBuffer)) throw new Error('--check: provenance would change');
  } else {
    await writeFile(provenanceTarget, provenanceBuffer);
  }

  const total = written.reduce((sum, w) => sum + w.bytes, 0) + provenanceBuffer.length;
  console.log(`\n${written.length + 1} files, ${total} B total added under public/assets/`);
  for (const w of written) console.log(`  ${String(w.bytes).padStart(9)} B  ${w.name}${w.changed ? '' : '  (unchanged)'}`);
  console.log(`  ${String(provenanceBuffer.length).padStart(9)} B  ${PROVENANCE_OUTPUT}`);
  console.log(CHECK_ONLY ? '\nworld-assets-cc0-v1 reproducible: no output changed' : '\nworld-assets-cc0-v1 OK');
}

// Importable: `ATLAS` is the single description of the sheet layout and the
// contract check reads it from here. Only build when run as the entry point.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
