#!/usr/bin/env node
// Contract check for the vendored CC0 world-asset slate and the geometry that
// consumes it.
//
//   node scripts/world-assets/verify-world-assets-cc0-v1.mjs
//
// Two things can silently drift and neither shows up in a screenshot:
//
//   1. the atlas layout in src/render/passes/street-furniture.js and the layout
//      in build-world-assets-cc0-v1.mjs are two copies of one fact - a render
//      pass may not import a build script - so a cell moved in one and not the
//      other would sample the wrong leaves, or bark, or nothing;
//   2. the tree's non-leaf geometry has to land on OPAQUE texels, because the
//      whole tree is drawn with one alpha-tested material. A trunk that lands
//      on a transparent texel is discarded and the crown floats.
//
// Both are asserted here against the shipped PNG's own pixels, plus the file
// hashes recorded in the provenance and the pass's triangle budgets.
//
// Exits non-zero on the first failure.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng } from './lib/png.mjs';
import { ATLAS as GENERATOR_ATLAS } from './build-world-assets-cc0-v1.mjs';
import {
  STREET_TREE_ATLAS,
  STREET_TREE_SPECIES,
  STREET_TREE_BUDGET,
  streetTreeVariantCount,
  buildStreetTreeGeometry,
  createStreetFurnitureMaterials,
} from '../../src/render/passes/street-furniture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ASSETS = path.join(REPO, 'public', 'assets');

let checks = 0;
const failures = [];
function assert(condition, message) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures.push(message);
    console.log(`  FAIL ${message}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

const provenance = JSON.parse(await readFile(path.join(ASSETS, 'world-assets-cc0-v1.provenance.json'), 'utf8'));

// ---------------------------------------------------------------------------
section('1. provenance and licence');
// ---------------------------------------------------------------------------
assert(provenance.license === 'CC0-1.0', `every vendored source is CC0-1.0 (${provenance.license})`);
assert(typeof provenance.licenseUrl === 'string' && provenance.licenseUrl.startsWith('https://'),
  `the licence was verified at a URL, not assumed (${provenance.licenseUrl})`);
assert(Object.values(provenance.sources).every((s) => s.license === 'CC0-1.0' && /^[0-9a-f]{64}$/.test(s.sha256)),
  `every source archive carries a sha256 and a licence (${Object.keys(provenance.sources).length} sources)`);
assert(Object.values(provenance.sources).every((s) => s.pinned),
  'every source archive matched its pinned digest at build time');

let totalBytes = 0;
for (const [name, output] of Object.entries(provenance.outputs)) {
  const buffer = await readFile(path.join(ASSETS, name));
  totalBytes += buffer.length;
  const digest = createHash('sha256').update(buffer).digest('hex');
  assert(digest === output.sha256 && buffer.length === output.bytes,
    `${name}: on disk matches the provenance record (${buffer.length} B)`);
}
const provenanceBytes = (await readFile(path.join(ASSETS, 'world-assets-cc0-v1.provenance.json'))).length;
console.log(`  vendored bytes under public/assets/: ${totalBytes + provenanceBytes}`);

// ---------------------------------------------------------------------------
section('2. the pass and the generator describe the same atlas');
// ---------------------------------------------------------------------------
const atlasBuffer = await readFile(path.join(ASSETS, 'street-tree-leaf-atlas-v1.png'));
const atlas = decodePng(atlasBuffer);
assert(atlas.width === STREET_TREE_ATLAS.width && atlas.height === STREET_TREE_ATLAS.height,
  `the shipped sheet is the size the pass expects (${atlas.width}x${atlas.height})`);
assert(GENERATOR_ATLAS.normalisedMean === STREET_TREE_ATLAS.normalisedMean,
  `pass and generator agree on the normalised linear mean (${STREET_TREE_ATLAS.normalisedMean})`);
assert(Math.abs(STREET_TREE_ATLAS.tintGain - 1 / STREET_TREE_ATLAS.normalisedMean) < 1e-12,
  `the vertex tint gain is the reciprocal of the normalised mean (${STREET_TREE_ATLAS.tintGain.toFixed(4)})`);

const uvToPixel = (u, v) => ({
  x: Math.round(u * atlas.width),
  y: Math.round((1 - v) * atlas.height),
});
assert(STREET_TREE_ATLAS.cells.length === GENERATOR_ATLAS.cells.length,
  `the sheet carries ${GENERATOR_ATLAS.cells.length} leaf cells in both descriptions`);
for (let i = 0; i < GENERATOR_ATLAS.cells.length; i += 1) {
  const generated = GENERATOR_ATLAS.cells[i];
  const declared = STREET_TREE_ATLAS.cells[i];
  const topLeft = uvToPixel(declared.u0, declared.v1);
  const bottomRight = uvToPixel(declared.u1, declared.v0);
  const insetOk = topLeft.x >= generated.x && topLeft.y >= generated.y
    && bottomRight.x <= generated.x + GENERATOR_ATLAS.cellWidth
    && bottomRight.y <= generated.y + GENERATOR_ATLAS.cellHeight;
  assert(declared.id === generated.id && insetOk,
    `cell ${declared.id}: the pass's uv rect sits inside the generator's pixel cell `
    + `(${topLeft.x},${topLeft.y})-(${bottomRight.x},${bottomRight.y}) in `
    + `(${generated.x},${generated.y})+${GENERATOR_ATLAS.cellWidth}x${GENERATOR_ATLAS.cellHeight}`);
}

// ---------------------------------------------------------------------------
section('3. the bark strip is opaque, and it tiles');
// ---------------------------------------------------------------------------
const barkTop = uvToPixel(0, STREET_TREE_ATLAS.bark.v1).y;
const barkBottom = uvToPixel(0, STREET_TREE_ATLAS.bark.v0).y;
let barkTransparent = 0;
let barkPixels = 0;
for (let y = barkTop; y < barkBottom; y += 1) {
  for (let x = 0; x < atlas.width; x += 1) {
    barkPixels += 1;
    if (atlas.data[(y * atlas.width + x) * 4 + 3] !== 255) barkTransparent += 1;
  }
}
assert(barkTransparent === 0,
  `every texel the trunk can sample is fully opaque (${barkTransparent} of ${barkPixels} not opaque)`);

// The default uv a merged part inherits is (0, 0). That must land on bark.
const origin = uvToPixel(0, 0);
const originAlpha = atlas.data[(Math.min(atlas.height - 1, origin.y) * atlas.width + origin.x) * 4 + 3];
assert(originAlpha === 255,
  `uv (0, 0) - the default a part inherits - lands on opaque bark (alpha ${originAlpha})`);

const columnWidth = atlas.width / STREET_TREE_ATLAS.bark.tileColumns;
let seam = 0;
let seamMax = 0;
for (let y = barkTop; y < barkBottom; y += 1) {
  for (let c = 0; c < STREET_TREE_ATLAS.bark.tileColumns; c += 1) {
    const left = (y * atlas.width + c * columnWidth) * 4;
    const right = (y * atlas.width + ((c + 1) * columnWidth - 1 + atlas.width) % atlas.width) * 4;
    const d = Math.abs(atlas.data[left] - atlas.data[right]);
    seam += d;
    if (d > seamMax) seamMax = d;
  }
}
const seamMean = seam / ((barkBottom - barkTop) * STREET_TREE_ATLAS.bark.tileColumns);
// One column's last texel and the next column's first texel are neighbours in a
// periodic signal, so the step across the wrap must be the size of a normal
// neighbouring-texel step, not a discontinuity.
let neighbour = 0;
let neighbourCount = 0;
for (let y = barkTop; y < barkBottom; y += 8) {
  for (let x = 1; x < atlas.width; x += 1) {
    neighbour += Math.abs(atlas.data[(y * atlas.width + x) * 4] - atlas.data[(y * atlas.width + x - 1) * 4]);
    neighbourCount += 1;
  }
}
const neighbourMean = neighbour / neighbourCount;
assert(seamMean <= neighbourMean * 3,
  `the bark tiles across a trunk's wrap seam (mean step ${seamMean.toFixed(2)} vs `
  + `${neighbourMean.toFixed(2)} for an ordinary neighbour, worst ${seamMax})`);

// ---------------------------------------------------------------------------
section('4. every tree triangle samples a texel it is allowed to sample');
// ---------------------------------------------------------------------------
const alphaAt = (u, v) => {
  const x = Math.min(atlas.width - 1, Math.max(0, Math.round(u * atlas.width - 0.5)));
  const y = Math.min(atlas.height - 1, Math.max(0, Math.round((1 - v) * atlas.height - 0.5)));
  return atlas.data[(y * atlas.width + x) * 4 + 3];
};
const inRect = (u, v, r) => u >= r.u0 - 1e-6 && u <= r.u1 + 1e-6 && v >= r.v0 - 1e-6 && v <= r.v1 + 1e-6;

for (const coarse of [false, true]) {
  const tier = coarse ? 'window' : 'near';
  for (let variant = 0; variant < streetTreeVariantCount(coarse ? 1 : 0); variant += 1) {
    const geometry = buildStreetTreeGeometry(variant, coarse);
    const species = geometry.userData.treeSkeleton.species;
    const uv = geometry.getAttribute('uv');
    const position = geometry.getAttribute('position');
    let outside = 0;
    let barkVerts = 0;
    let cellVerts = 0;
    let barkTransparentVerts = 0;
    for (let i = 0; i < uv.count; i += 1) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      const cell = STREET_TREE_ATLAS.cells.find((c) => inRect(u, v, c));
      const isBark = inRect(u, v, { u0: 0, u1: 1, v0: STREET_TREE_ATLAS.bark.v0, v1: STREET_TREE_ATLAS.bark.v1 });
      if (cell) cellVerts += 1;
      else if (isBark) {
        barkVerts += 1;
        if (alphaAt(u, v) !== 255) barkTransparentVerts += 1;
      } else outside += 1;
    }
    const index = geometry.getIndex();
    const triangles = Math.floor((index ? index.count : position.count) / 3);
    const cap = coarse ? STREET_TREE_BUDGET.maxTrianglesPerTreeCoarse : STREET_TREE_BUDGET.maxTrianglesPerTree;
    assert(outside === 0,
      `${tier}/${species}: every vertex samples a declared region - a leaf cell or the bark strip `
      + `(${cellVerts} leaf, ${barkVerts} bark, ${outside} nowhere)`);
    assert(barkTransparentVerts === 0,
      `${tier}/${species}: no trunk or limb vertex samples a texel the alpha test would discard (${barkTransparentVerts})`);
    assert(cellVerts > 0 && barkVerts > 0,
      `${tier}/${species}: the tree really uses both regions (${cellVerts} leaf, ${barkVerts} bark)`);
    assert(triangles <= cap, `${tier}/${species}: ${triangles} triangles, within the ${cap} budget`);
    geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
section('5. the crown is alpha-tested, never sorted');
// ---------------------------------------------------------------------------
const materials = createStreetFurnitureMaterials();
assert(materials.foliage.transparent === false,
  'the foliage material stays out of the sorted transparent pass');
assert(materials.foliage.alphaTest === STREET_TREE_ATLAS.alphaTest && materials.foliage.alphaTest > 0,
  `the foliage material alpha-tests at ${materials.foliage.alphaTest}`);
assert(materials.foliage.userData.envClass === 'foliage',
  'the foliage material still declares its environment class');
assert(materials.prop.alphaTest === 0 && materials.prop.map === null,
  'the prop material is untouched by the atlas: no alpha test, no map');
const withAtlas = createStreetFurnitureMaterials({ foliageAtlas: { isTexture: true } });
assert(withAtlas.foliage.map !== null && withAtlas.foliage.userData.foliageAtlas === true,
  'an atlas handed to the pass is bound as the foliage map');

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.error('world-assets-cc0-v1 FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`street trees: ${STREET_TREE_SPECIES.length} near species, atlas ${atlasBuffer.length} B`);
console.log('world-assets-cc0-v1 OK');
