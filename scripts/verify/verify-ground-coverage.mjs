// Self-check for src/world/ground-coverage.js
//
// Runs headless under plain node: no browser, no DOM, no canvas, no renderer,
// no new dependency.
//
//   npm run verify:ground-coverage
//
// THIS CHECK IS DRIVEN BY THE REAL DATASET, NOT A FIXTURE.
//
// The previous round's coverage assertion passed on a hand-built fixture while
// the shipped city still had holes, which means the fixture was not evidence.
// So this script loads public/data/sf/sf-city.json (the same 37 MB payload the
// app fetches), runs the same slice the app runs
// (`loadSfData({ center: [1600, 400], radius: 720, maxBuildings: 900 })`), and
// asserts coverage over the geometry that slice actually produces.
//
// What it proves:
//   1. module contract (exports, frozen defaults, budget, one draw call)
//   2. REAL-SLICE COVERAGE. A dense grid of world points across the loaded
//      slice is tested against the XZ projection of every emitted ground
//      triangle. Reports the covered percentage BEFORE (base plane as
//      `CityRenderer.makeGround` actually places it + street-surface-v2) and
//      AFTER (the same plus this module's carpet), and the world coordinates of
//      the worst uncovered clusters.
//   3. WINDING. Every emitted carpet triangle is non-degenerate and its index
//      order gives a +Y geometric normal. A downward-facing ground triangle is
//      as invisible as a hole.
//   4. VERTICAL SAFETY. The carpet - interpolated across its cells, not merely
//      sampled at its vertices - stays clear below the gutter invert
//      (heightAt + roadLift - gutterDepth) everywhere a road exists.
//   5. HORIZON REACH (round 2). Every ray from every quality-card camera pose
//      that points BELOW the horizon and can reach the ground inside the
//      camera's far plane must land on the carpet. Round 1's round of captures
//      reported `holeRatio 0.0104` on the canyon card; the three offending
//      probe samples were ABOVE the horizon, looking up a gap between two
//      towers at the sky, which is the correct answer and not a hole. But the
//      same sweep did find a real defect: `horizonRadius` was 3600 m measured
//      from the bounds CENTRE while the camera far plane is 4200 m measured
//      from the CAMERA, so a near-horizon ray from the far corner of the
//      window ran out of ground and hit the sky dome below the horizon. That
//      is the thin sliver of sky under the skyline in the canyon card.
//   5. EYE-LEVEL RAYS. The eight quality-card camera poses are reproduced from
//      the real slice with the same code path scripts/qa/capture-quality-cards-v1.mjs
//      uses, and the same 24 x 12 ray grid through the lower 45% of the frame is
//      cast analytically against a triangle soup of ground + street surface +
//      building shells + bay plane. A ray with no non-sky hit inside 400 m is a
//      hole, exactly as the capture script defines it. Reports the modelled
//      holeRatio per card before and after.
//   6. determinism, finiteness, index range, and no mutation of the source city
//
// Modelling limits, stated so the numbers are not over-read: the ray soup
// contains ground, the full street surface, building shells and the bay plane.
// It does NOT contain trees, parked cars, lamps, awnings, signals, pedestrians
// or contact shadows, all of which also stop rays in the real frame. The
// modelled BEFORE holeRatio is therefore an upper bound on the real one, and
// the modelled AFTER number is the honest one only because the carpet is a
// closed surface under everything.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// The app fetches its data over HTTP. Serve the repo's public/ directory to it
// so the module under test sees byte-identical input to the shipped route.
globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^https?:\/\/[^/]+/, '');
  if (rel.endsWith('.gz')) return { ok: false, status: 415 };
  try {
    const text = await readFile(path.join(ROOT, 'public', rel), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  } catch {
    return { ok: false, status: 404 };
  }
};

const { loadSfData } = await import(path.join(ROOT, 'src/citygen/sf-data.js'));
const streetMod = await import(path.join(ROOT, 'src/world/streets/street-surface-v2.js'));
const { buildStreetSurfaceData, STREET_SURFACE_V2_PALETTES } = streetMod;
const { MATERIAL_CLASSES } = await import(path.join(ROOT, 'src/render/environment-ibl.js'));
const mod = await import(path.join(ROOT, 'src/world/ground-coverage.js'));

const {
  GROUND_COVERAGE_ID,
  GROUND_COVERAGE_BUDGET,
  GROUND_COVERAGE_DEFAULTS,
  resolveGroundCoverageOptions,
  buildGroundCoverageData,
  sampleGroundCoverage,
} = mod;

let checks = 0;
const failures = [];

function assert(condition, message) {
  checks += 1;
  if (condition) console.log(`  ok   ${message}`);
  else { failures.push(message); console.log(`  FAIL ${message}`); }
}

function section(title) { console.log(`\n${title}`); }
function pct(v) { return `${(v * 100).toFixed(3)}%`; }

// ---------------------------------------------------------------------------
// triangle soup + XZ bucket index (coverage queries and ray casts)
// ---------------------------------------------------------------------------

const CELL = 12;

function makeSoup(cell = CELL) {
  return { tris: [], tags: [], buckets: new Map(), cell, stamp: new Int32Array(0), stampId: 0 };
}

function addTriangle(soup, ax, ay, az, bx, by, bz, cx, cy, cz, tag) {
  const index = soup.tris.length / 9;
  soup.tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  soup.tags.push(tag);
  const minX = Math.min(ax, bx, cx);
  const maxX = Math.max(ax, bx, cx);
  const minZ = Math.min(az, bz, cz);
  const maxZ = Math.max(az, bz, cz);
  const c = soup.cell;
  for (let gz = Math.floor(minZ / c); gz <= Math.floor(maxZ / c); gz += 1) {
    for (let gx = Math.floor(minX / c); gx <= Math.floor(maxX / c); gx += 1) {
      const key = gx * 100003 + gz;
      let list = soup.buckets.get(key);
      if (!list) { list = []; soup.buckets.set(key, list); }
      list.push(index);
    }
  }
}

function addIndexedMesh(soup, positions, indices, tag) {
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    addTriangle(soup,
      positions[a], positions[a + 1], positions[a + 2],
      positions[b], positions[b + 1], positions[b + 2],
      positions[c], positions[c + 1], positions[c + 2], tag);
  }
}

function sealSoup(soup) {
  soup.stamp = new Int32Array(soup.tris.length / 9);
}

/** Is (x, z) inside the XZ projection of any triangle tagged as ground? */
function coveredAt(soup, x, z, allow) {
  const key = Math.floor(x / soup.cell) * 100003 + Math.floor(z / soup.cell);
  const list = soup.buckets.get(key);
  if (!list) return null;
  for (const index of list) {
    if (allow && !allow.has(soup.tags[index])) continue;
    const t = index * 9;
    const ax = soup.tris[t]; const az = soup.tris[t + 2];
    const bx = soup.tris[t + 3]; const bz = soup.tris[t + 5];
    const cx = soup.tris[t + 6]; const cz = soup.tris[t + 8];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return soup.tags[index];
  }
  return null;
}

/** Moller-Trumbore, double sided. Returns t or Infinity. */
function rayTriangle(soup, index, ox, oy, oz, dx, dy, dz) {
  const t = index * 9;
  const ax = soup.tris[t]; const ay = soup.tris[t + 1]; const az = soup.tris[t + 2];
  const e1x = soup.tris[t + 3] - ax; const e1y = soup.tris[t + 4] - ay; const e1z = soup.tris[t + 5] - az;
  const e2x = soup.tris[t + 6] - ax; const e2y = soup.tris[t + 7] - ay; const e2z = soup.tris[t + 8] - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const sx = ox - ax; const sy = oy - ay; const sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
  const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return hit > 1e-4 ? hit : Infinity;
}

/**
 * Closest hit inside `maxDist`, via 2D Amanatides-Woo traversal of the XZ
 * bucket grid. Returns { t, tag } or null.
 */
function raycast(soup, ox, oy, oz, dx, dy, dz, maxDist) {
  soup.stampId += 1;
  const id = soup.stampId;
  const c = soup.cell;
  let gx = Math.floor(ox / c);
  let gz = Math.floor(oz / c);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(c / dx) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(c / dz) : Infinity;
  let tMaxX = stepX > 0 ? ((gx + 1) * c - ox) / dx
    : stepX < 0 ? (gx * c - ox) / dx : Infinity;
  let tMaxZ = stepZ > 0 ? ((gz + 1) * c - oz) / dz
    : stepZ < 0 ? (gz * c - oz) / dz : Infinity;
  let best = Infinity;
  let bestTag = null;
  let travelled = 0;
  for (let guard = 0; guard < 20000; guard += 1) {
    const list = soup.buckets.get(gx * 100003 + gz);
    if (list) {
      for (const index of list) {
        if (soup.stamp[index] === id) continue;
        soup.stamp[index] = id;
        const t = rayTriangle(soup, index, ox, oy, oz, dx, dy, dz);
        if (t < best) { best = t; bestTag = soup.tags[index]; }
      }
    }
    const next = Math.min(tMaxX, tMaxZ);
    if (best <= next) break;
    travelled = next;
    if (travelled > maxDist) break;
    if (tMaxX < tMaxZ) { gx += stepX; tMaxX += tDeltaX; } else { gz += stepZ; tMaxZ += tDeltaZ; }
  }
  if (best > maxDist || bestTag === null) return null;
  return { t: best, tag: bestTag };
}

// ---------------------------------------------------------------------------
// real slice
// ---------------------------------------------------------------------------

section('real dataset');
const loadStart = Date.now();
const city = await loadSfData({ center: [1600, 400], radius: 720, maxBuildings: 900 });
const loadMs = Date.now() - loadStart;
const osmBuildings = (city.buildings || []).filter((b) => String(b.id).startsWith('sf-building-')).length;
console.log(`  loaded public/data/sf/sf-city.json in ${loadMs} ms`);
console.log(`  slice center=[1600,400] radius=720 maxBuildings=900`);
console.log(`  segments=${city.segments.length} buildings=${city.buildings.length} intersections=${city.intersections.length}`);
console.log(`  bounds x ${city.meta.bounds.minX.toFixed(1)}..${city.meta.bounds.maxX.toFixed(1)}  z ${city.meta.bounds.minZ.toFixed(1)}..${city.meta.bounds.maxZ.toFixed(1)}`);
assert(city.meta.generator === 'sf-builtin', 'slice comes from the real prebuilt SF payload');
assert(city.buildings.length > 200 && osmBuildings === city.buildings.length,
  `every building is a real OSM building (${osmBuildings}/${city.buildings.length})`);
assert(city.segments.length > 1000, `slice has the real street network (${city.segments.length} segments)`);

// The renderer applies a render-only vertical scale before it hands heightAt to
// anything that builds geometry (CityRenderer.setCity, terrainVisualScale).
// Every consumer below uses the SAME function the app uses.
const TERRAIN_VISUAL_SCALE = 1.12;
const sourceHeightAt = city.terrain.heightAt;
const heightAt = (x, z) => {
  const v = Number(sourceHeightAt(x, z));
  return Number.isFinite(v) ? v * TERRAIN_VISUAL_SCALE : 0;
};

// Exactly the options CityRenderer.buildRoadNetwork passes for a real SF map.
const LEGACY_SIDEWALK_LIFT = 0.102;
const STREET_GUTTER_DEPTH = 0.04;
const roadDatum = Number(city.meta.streetDesign?.roadLift ?? 0.45);
const streetStart = Date.now();
const street = buildStreetSurfaceData(city, {
  roadLift: roadDatum,
  gutterDepth: STREET_GUTTER_DEPTH,
  curbFaceHeight: LEGACY_SIDEWALK_LIFT + STREET_GUTTER_DEPTH + 0.008,
  heightAt,
  palette: 'sf',
  inferNodes: true,
});
console.log(`  street-surface-v2 on the real slice: ${street.stats.trianglesTotal} triangles, `
  + `${street.stats.segments} segments, ${street.stats.nodes} nodes, ${Date.now() - streetStart} ms`);

// ---------------------------------------------------------------------------
// 1. module contract
// ---------------------------------------------------------------------------

section('1. module contract');
assert(GROUND_COVERAGE_ID === 'ground-coverage-v1', 'stable module id');
assert(Object.isFrozen(GROUND_COVERAGE_DEFAULTS) && Object.isFrozen(GROUND_COVERAGE_BUDGET),
  'defaults and budget are frozen');
assert(typeof buildGroundCoverageData === 'function'
  && typeof mod.buildGroundCoverage === 'function'
  && typeof mod.disposeGroundCoverage === 'function'
  && typeof resolveGroundCoverageOptions === 'function'
  && typeof sampleGroundCoverage === 'function', 'exports the documented API');

const cityBefore = JSON.stringify({ segments: city.segments, meta: city.meta, buildings: city.buildings.length });
const buildStart = Date.now();
const data = buildGroundCoverageData(city, { heightAt });
const buildMs = Date.now() - buildStart;
const s = data.stats;
console.log(`  carpet: ${s.triangles} triangles, ${s.vertices} vertices, `
  + `${s.gridX}x${s.gridZ} grid, cell ${s.cellSize} m, ${buildMs} ms`);
console.log(`  extent x ${s.extent.minX.toFixed(1)}..${s.extent.maxX.toFixed(1)}  `
  + `z ${s.extent.minZ.toFixed(1)}..${s.extent.maxZ.toFixed(1)} (apron reach ${s.apronReach} m)`);
assert(JSON.stringify({ segments: city.segments, meta: city.meta, buildings: city.buildings.length }) === cityBefore,
  'source city is not mutated');
assert(s.triangles <= GROUND_COVERAGE_BUDGET.maxTriangles,
  `triangle budget holds (${s.triangles} <= ${GROUND_COVERAGE_BUDGET.maxTriangles})`);
assert(s.nonFinite === 0, 'no NaN/Inf in emitted positions');
assert(data.indices.every((i) => Number.isInteger(i) && i >= 0 && i < s.vertices),
  'every index is in range');
assert(data.positions.length === s.vertices * 3 && data.normals.length === s.vertices * 3
  && data.colors.length === s.vertices * 3 && data.uvs.length === s.vertices * 2,
  'attribute lengths agree with the vertex count');
assert(data.colors.every((c) => Number.isFinite(c) && c >= 0 && c <= 1), 'colors are finite sRGB in [0,1]');

// ---------------------------------------------------------------------------
// 2. winding + degeneracy
// ---------------------------------------------------------------------------

section('2. winding: every ground triangle faces up');
let downFacing = 0;
let degenerate = 0;
let minArea = Infinity;
for (let i = 0; i < data.indices.length; i += 3) {
  const a = data.indices[i] * 3;
  const b = data.indices[i + 1] * 3;
  const c = data.indices[i + 2] * 3;
  const abx = data.positions[b] - data.positions[a];
  const aby = data.positions[b + 1] - data.positions[a + 1];
  const abz = data.positions[b + 2] - data.positions[a + 2];
  const acx = data.positions[c] - data.positions[a];
  const acy = data.positions[c + 1] - data.positions[a + 1];
  const acz = data.positions[c + 2] - data.positions[a + 2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const area = Math.hypot(nx, ny, nz) / 2;
  if (area < 1e-6) degenerate += 1;
  if (area < minArea) minArea = area;
  if (ny <= 0) downFacing += 1;
}
console.log(`  triangles=${data.indices.length / 3} minArea=${minArea.toFixed(4)} m^2`);
assert(downFacing === 0, `no triangle is wound downward (${downFacing} down-facing)`);
assert(degenerate === 0, `no degenerate triangle (${degenerate})`);
assert(data.normals.every((_, i) => i % 3 !== 1 || data.normals[i] > 0),
  'every vertex normal has a positive Y component');

// ---------------------------------------------------------------------------
// 3. vertical safety under the road
// ---------------------------------------------------------------------------

section('3. vertical safety: the carpet stays under the pavement');
console.log(`  roadLift=${s.roadLift} gutterDepth=${s.gutterDepth} sink=${s.sink}`);
console.log(`  minRoadClearance=${s.minRoadClearance} m over ${s.clearanceSamples} road-adjacent samples `
  + `(worst at x=${s.worstClearanceAt?.x} z=${s.worstClearanceAt?.z})`);
console.log(`  interpolation error: core ${s.maxCoreInterpolationError} m, incl. apron ${s.maxInterpolationError} m`);
assert(s.minRoadClearance >= GROUND_COVERAGE_DEFAULTS.minRoadClearance,
  `carpet clears the gutter invert by >= ${GROUND_COVERAGE_DEFAULTS.minRoadClearance} m everywhere a road exists`);
// Independent spot check against the built surface, not the builder's own stat.
let sampledClearanceMin = Infinity;
for (const segment of city.segments) {
  const p = segment.points?.[0];
  if (!p) continue;
  const probe = sampleGroundCoverage(data, p.x, p.z);
  if (!probe.covered) { sampledClearanceMin = -Infinity; break; }
  sampledClearanceMin = Math.min(sampledClearanceMin,
    (heightAt(p.x, p.z) + roadDatum - STREET_GUTTER_DEPTH) - probe.y);
}
assert(sampledClearanceMin >= GROUND_COVERAGE_DEFAULTS.minRoadClearance,
  `every segment start point sits over carpet with >= ${GROUND_COVERAGE_DEFAULTS.minRoadClearance} m clearance `
  + `(min ${sampledClearanceMin.toFixed(3)} m)`);

// ---------------------------------------------------------------------------
// 4. REAL-SLICE COVERAGE, before and after
// ---------------------------------------------------------------------------

section('4. real-slice ground coverage');

// The base ground plane exactly as CityRenderer.makeGround emits it: a
// PlaneGeometry sized from bounds, whose VERTICES are never translated to the
// bounds centre, added to city-root at the world origin.
function legacyBasePlaneTriangles(soup) {
  const b = city.meta.bounds;
  const width = b.maxX - b.minX + 520;
  const depth = b.maxZ - b.minZ + 520;
  const seg = 96;
  const y = -0.22;
  for (let j = 0; j < seg; j += 1) {
    for (let i = 0; i < seg; i += 1) {
      const x0 = -width / 2 + (width * i) / seg;
      const x1 = -width / 2 + (width * (i + 1)) / seg;
      const z0 = -depth / 2 + (depth * j) / seg;
      const z1 = -depth / 2 + (depth * (j + 1)) / seg;
      addTriangle(soup, x0, y, z0, x0, y, z1, x1, y, z0, 'legacy-base-plane');
      addTriangle(soup, x1, y, z0, x0, y, z1, x1, y, z1, 'legacy-base-plane');
    }
  }
}

function streetTriangles(soup) {
  for (const name of Object.keys(street.layers)) {
    const layer = street.layers[name];
    addIndexedMesh(soup, layer.positions, layer.indices, `street:${name}`);
  }
}

function carpetTriangles(soup) {
  addIndexedMesh(soup, data.positions, data.indices, 'ground-coverage');
}

const GROUND_TAGS_BEFORE = new Set(['legacy-base-plane',
  ...Object.keys(street.layers).map((n) => `street:${n}`)]);
const GROUND_TAGS_AFTER = new Set([...GROUND_TAGS_BEFORE, 'ground-coverage']);

const beforeSoup = makeSoup();
legacyBasePlaneTriangles(beforeSoup);
streetTriangles(beforeSoup);
sealSoup(beforeSoup);

const afterSoup = makeSoup();
legacyBasePlaneTriangles(afterSoup);
streetTriangles(afterSoup);
carpetTriangles(afterSoup);
sealSoup(afterSoup);

const GRID = 200; // 200 x 200 = 40 000 world points across the loaded slice
const b = city.meta.bounds;
function measureCoverage(soup, allow) {
  const uncovered = [];
  const flags = new Uint8Array(GRID * GRID);
  let covered = 0;
  for (let j = 0; j < GRID; j += 1) {
    const z = b.minZ + ((b.maxZ - b.minZ) * (j + 0.5)) / GRID;
    for (let i = 0; i < GRID; i += 1) {
      const x = b.minX + ((b.maxX - b.minX) * (i + 0.5)) / GRID;
      if (coveredAt(soup, x, z, allow)) { covered += 1; flags[j * GRID + i] = 1; }
      else uncovered.push({ i, j, x, z });
    }
  }
  return { covered, total: GRID * GRID, ratio: covered / (GRID * GRID), uncovered, flags };
}

/** Flood-fill the uncovered samples into clusters, biggest first. */
function clusterHoles(result) {
  const seen = new Uint8Array(GRID * GRID);
  const clusters = [];
  for (const start of result.uncovered) {
    const startKey = start.j * GRID + start.i;
    if (seen[startKey]) continue;
    const stack = [startKey];
    seen[startKey] = 1;
    let count = 0;
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    while (stack.length) {
      const key = stack.pop();
      const i = key % GRID;
      const j = (key - i) / GRID;
      count += 1;
      const x = b.minX + ((b.maxX - b.minX) * (i + 0.5)) / GRID;
      const z = b.minZ + ((b.maxZ - b.minZ) * (j + 0.5)) / GRID;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di; const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= GRID || nj >= GRID) continue;
        const nk = nj * GRID + ni;
        if (seen[nk] || result.flags[nk]) continue;
        seen[nk] = 1;
        stack.push(nk);
      }
    }
    clusters.push({
      samples: count,
      centre: { x: +((minX + maxX) / 2).toFixed(1), z: +((minZ + maxZ) / 2).toFixed(1) },
      box: { minX: +minX.toFixed(1), maxX: +maxX.toFixed(1), minZ: +minZ.toFixed(1), maxZ: +maxZ.toFixed(1) },
    });
  }
  clusters.sort((a, c) => c.samples - a.samples);
  return clusters;
}

const before = measureCoverage(beforeSoup, GROUND_TAGS_BEFORE);
const after = measureCoverage(afterSoup, GROUND_TAGS_AFTER);
const sampleSpacingX = (b.maxX - b.minX) / GRID;
const sampleSpacingZ = (b.maxZ - b.minZ) / GRID;
console.log(`  sampled ${GRID}x${GRID} = ${GRID * GRID} world points over the slice `
  + `(${sampleSpacingX.toFixed(1)} m x ${sampleSpacingZ.toFixed(1)} m spacing)`);
console.log(`  BEFORE (makeGround base plane + street-surface-v2): ${pct(before.ratio)} covered `
  + `(${before.uncovered.length} uncovered samples)`);
console.log(`  AFTER  (+ ground-coverage carpet):                  ${pct(after.ratio)} covered `
  + `(${after.uncovered.length} uncovered samples)`);
const beforeClusters = clusterHoles(before);
console.log(`  worst uncovered clusters BEFORE (${beforeClusters.length} clusters):`);
for (const c of beforeClusters.slice(0, 5)) {
  console.log(`    ${String(c.samples).padStart(6)} samples  centre x=${c.centre.x} z=${c.centre.z}  `
    + `box x ${c.box.minX}..${c.box.maxX} z ${c.box.minZ}..${c.box.maxZ}`);
}
if (after.uncovered.length) {
  console.log('  worst uncovered clusters AFTER:');
  for (const c of clusterHoles(after).slice(0, 5)) {
    console.log(`    ${String(c.samples).padStart(6)} samples  centre x=${c.centre.x} z=${c.centre.z}  `
      + `box x ${c.box.minX}..${c.box.maxX} z ${c.box.minZ}..${c.box.maxZ}`);
  }
}
assert(before.ratio < 0.999,
  `the shipped build really is holed (before = ${pct(before.ratio)}) - if this passes, the premise changed`);
assert(after.ratio === 1, `every sampled world point in the slice is covered after (${pct(after.ratio)})`);

// The carpet alone must be enough: it cannot depend on the misplaced base plane.
const carpetOnly = makeSoup();
carpetTriangles(carpetOnly);
sealSoup(carpetOnly);
const alone = measureCoverage(carpetOnly, new Set(['ground-coverage']));
console.log(`  carpet alone (base plane removed):                  ${pct(alone.ratio)} covered`);
assert(alone.ratio === 1, `the carpet covers the slice on its own (${pct(alone.ratio)})`);

// A punched hole must fail the same check, or the check proves nothing. Punch
// the cell under the slice centre, not an apron cell the sample grid never
// visits - a negative control that lands outside the sampled area proves the
// opposite of what it claims to.
const punched = buildGroundCoverageData(city, { heightAt });
const punchCell = sampleGroundCoverage(punched, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2).cell;
const punchQuad = punchCell.j * (punched.stats.gridX - 1) + punchCell.i;
const cut = punched.indices.splice(punchQuad * 6, 6);
const punchedSoup = makeSoup();
addIndexedMesh(punchedSoup, punched.positions, punched.indices, 'ground-coverage');
sealSoup(punchedSoup);
const punchedResult = measureCoverage(punchedSoup, new Set(['ground-coverage']));
assert(cut.length === 6 && punchedResult.ratio < 1,
  `a deliberately removed cell fails the same coverage check (${pct(punchedResult.ratio)})`);

// ---------------------------------------------------------------------------
// 5. eye-level ray holes on the eight quality-card poses
// ---------------------------------------------------------------------------

section('5. eye-level hole rays on the real quality-card poses');

// Building shells, for ray occlusion only. Side walls of a closed prism stop
// every non-vertical ray that enters the footprint, so no roof cap is needed.
function buildingShells(soup) {
  for (const building of city.buildings) {
    const poly = building.polygon || [];
    if (poly.length < 3) continue;
    const h = Number(building.height) || 6;
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i];
      const c = poly[(i + 1) % poly.length];
      if (!a || !c) continue;
      const ay = heightAt(a.x, a.z);
      const cy = heightAt(c.x, c.z);
      addTriangle(soup, a.x, ay, a.z, c.x, cy, c.z, a.x, ay + h, a.z, 'building');
      addTriangle(soup, c.x, cy, c.z, c.x, cy + h, c.z, a.x, ay + h, a.z, 'building');
    }
  }
}

// makeWater: PlaneGeometry(680, depth) at (maxX - 70, 0.5, centreZ).
function bayPlane(soup) {
  const wx = b.maxX - 70;
  const cz = (b.minZ + b.maxZ) / 2;
  const hw = 340;
  const hd = (b.maxZ - b.minZ + 520) / 2;
  addTriangle(soup, wx - hw, 0.5, cz - hd, wx - hw, 0.5, cz + hd, wx + hw, 0.5, cz - hd, 'water');
  addTriangle(soup, wx + hw, 0.5, cz - hd, wx - hw, 0.5, cz + hd, wx + hw, 0.5, cz + hd, 'water');
}

const raySoupBefore = makeSoup(16);
legacyBasePlaneTriangles(raySoupBefore);
streetTriangles(raySoupBefore);
buildingShells(raySoupBefore);
bayPlane(raySoupBefore);
sealSoup(raySoupBefore);

const raySoupAfter = makeSoup(16);
legacyBasePlaneTriangles(raySoupAfter);
streetTriangles(raySoupAfter);
buildingShells(raySoupAfter);
bayPlane(raySoupAfter);
carpetTriangles(raySoupAfter);
sealSoup(raySoupAfter);

// --- pose selection, transcribed from scripts/qa/capture-quality-cards-v1.mjs
const EYE = 1.65;
const segs = (city.segments || []).filter((sg) => (sg.points || []).length >= 2);
const segLen = (sg) => {
  let L = 0;
  for (let i = 1; i < sg.points.length; i += 1) {
    L += Math.hypot(sg.points[i].x - sg.points[i - 1].x, sg.points[i].z - sg.points[i - 1].z);
  }
  return L;
};
const midOf = (sg) => sg.points[Math.floor(sg.points.length / 2)];
const blds = (city.buildings || []).map((bl) => {
  const poly = bl.polygon || [];
  if (!poly.length) return null;
  let x = 0; let z = 0;
  for (const p of poly) { x += p.x; z += p.z; }
  return { x: x / poly.length, z: z / poly.length, h: bl.height || 0 };
}).filter(Boolean);
const tallnessAt = (p, radius = 70) => {
  let sum = 0; let n = 0;
  for (const bl of blds) {
    if (Math.abs(bl.x - p.x) > radius || Math.abs(bl.z - p.z) > radius) continue;
    if (Math.hypot(bl.x - p.x, bl.z - p.z) <= radius) { sum += bl.h; n += 1; }
  }
  return { avg: n ? sum / n : 0, count: n };
};
const polys = (city.buildings || []).map((bl) => bl.polygon).filter((p) => p && p.length > 2);
const insideAny = (pt) => {
  for (const poly of polys) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]; const c = poly[j];
      if (((a.z > pt.z) !== (c.z > pt.z))
        && (pt.x < ((c.x - a.x) * (pt.z - a.z)) / ((c.z - a.z) || 1e-9) + a.x)) hit = !hit;
    }
    if (hit) return true;
  }
  return false;
};
const namedSegs = (needle) => segs.filter((sg) => (sg.streetName || '').toLowerCase().includes(needle));
const longest = (list) => list.slice().sort((a, c) => segLen(c) - segLen(a))[0];

function placeCamera(pose) {
  let chosen = null;
  if (pose === 'canyon') {
    let best = null; let bestScore = -1;
    for (const sg of segs) {
      if (segLen(sg) < 25) continue;
      const t = tallnessAt(midOf(sg));
      if (t.count < 3) continue;
      if (t.avg > bestScore) { bestScore = t.avg; best = sg; }
    }
    chosen = best || longest(segs);
  } else if (pose === 'waterfront') {
    const emb = namedSegs('embarcadero');
    if (!emb.length) return { ok: false, reason: 'no Embarcadero in loaded window' };
    chosen = longest(emb);
  } else if (pose === 'intersection') {
    const withSig = (city.intersections || []).filter((it) => it.position);
    if (!withSig.length) return { ok: false, reason: 'no intersections' };
    const inter = withSig.slice().sort((a, c) => (c.streetIds?.length || 0) - (a.streetIds?.length || 0))[0];
    const near = segs
      .map((sg) => ({ sg, d: Math.hypot(midOf(sg).x - inter.position.x, midOf(sg).z - inter.position.z) }))
      .sort((a, c) => a.d - c.d)[0];
    chosen = { ...(near?.sg || longest(segs)), __focus: inter.position };
  } else {
    const MIN_NEIGHBOURS = 8;
    const scored = [];
    for (const sg of segs) {
      if (segLen(sg) < 35) continue;
      const t = tallnessAt(midOf(sg), 60);
      if (t.count < MIN_NEIGHBOURS) continue;
      scored.push({ sg, score: t.count * 1.6 + Math.min(t.avg, 45) * 0.9 + (sg.width || 0) * 1.4, t });
    }
    scored.sort((a, c) => c.score - a.score);
    if (!scored.length) return { ok: false, reason: 'no dense street segment' };
    chosen = scored[0].sg;
    chosen = { ...chosen, __candidates: scored.slice(0, 14).map((c) => c.sg) };
  }
  const pts = chosen.points;
  const i = Math.max(1, Math.floor(pts.length / 2));
  const a = pts[i - 1]; const c = pts[i];
  const len = Math.hypot(c.x - a.x, c.z - a.z) || 1;
  const ux = (c.x - a.x) / len; const uz = (c.z - a.z) / len;
  const nx = -uz; const nz = ux;
  const halfRoad = (chosen.width || 7) / 2;
  const walk = halfRoad + Math.max(1.2, (chosen.sidewalkW || 2) * 0.55);
  let eye; let target; let eyeLift = EYE;
  if (pose === 'intersection') {
    const f = chosen.__focus;
    eye = { x: f.x - ux * 22 + nx * walk, z: f.z - uz * 22 + nz * walk };
    target = { x: f.x, z: f.z };
  } else if (pose === 'character') {
    const stand = { x: a.x + nx * (halfRoad + 0.6), z: a.z + nz * (halfRoad + 0.6) };
    eye = { x: stand.x - ux * 4.2 + nx * 1.1, z: stand.z - uz * 4.2 + nz * 1.1 };
    target = stand;
    eyeLift = EYE + 0.35;
  } else if (pose === 'traversal') {
    eye = { x: a.x - ux * 30 + nx * walk, z: a.z - uz * 30 + nz * walk };
    target = { x: a.x + ux * 140, z: a.z + uz * 140 };
  } else {
    eye = { x: a.x + nx * walk, z: a.z + nz * walk };
    target = { x: a.x + ux * 90 + nx * (walk * 0.35), z: a.z + uz * 90 + nz * (walk * 0.35) };
  }
  if (insideAny(eye)) {
    const flipped = { x: a.x - nx * walk, z: a.z - nz * walk };
    if (!insideAny(flipped)) {
      eye = flipped;
      target = { x: a.x + ux * 90 - nx * (walk * 0.35), z: a.z + uz * 90 - nz * (walk * 0.35) };
    } else {
      for (const alt of (chosen.__candidates || []).slice(1)) {
        const ap = alt.points; const ai = Math.max(1, Math.floor(ap.length / 2));
        const aa = ap[ai - 1]; const ab = ap[ai];
        const al = Math.hypot(ab.x - aa.x, ab.z - aa.z) || 1;
        const aux = (ab.x - aa.x) / al; const auz = (ab.z - aa.z) / al;
        const anx = -auz; const anz = aux;
        const aw = (alt.width || 7) / 2 + Math.max(1.2, (alt.sidewalkW || 2) * 0.55);
        const cand = { x: aa.x + anx * aw, z: aa.z + anz * aw };
        if (!insideAny(cand)) {
          eye = cand;
          target = { x: aa.x + aux * 90 + anx * (aw * 0.35), z: aa.z + auz * 90 + anz * (aw * 0.35) };
          break;
        }
      }
    }
  }
  const eyeY = heightAt(eye.x, eye.z) + eyeLift;
  const tgtY = heightAt(target.x, target.z)
    + (pose === 'canyon' ? 22 : (pose === 'character' ? 1.1 : EYE * 0.92));
  return {
    ok: true,
    eye: { x: eye.x, y: eyeY, z: eye.z },
    target: { x: target.x, y: tgtY, z: target.z },
    fov: pose === 'canyon' ? 58 : 47,
  };
}

// The same 24 x 12 grid over the lower 45% of the frame the capture script uses.
const COLS = 24;
const ROWS = 12;
const ASPECT = 1280 / 720;
function castCard(soup, pose) {
  const fwd = {
    x: pose.target.x - pose.eye.x,
    y: pose.target.y - pose.eye.y,
    z: pose.target.z - pose.eye.z,
  };
  const fl = Math.hypot(fwd.x, fwd.y, fwd.z) || 1;
  fwd.x /= fl; fwd.y /= fl; fwd.z /= fl;
  // three.js camera basis for lookAt with worldUp = (0, 1, 0):
  //   right = normalize(cross(forward, up)) = normalize(-f.z, 0, f.x)
  //   up    = cross(right, forward)
  const rx = -fwd.z;
  const rz = fwd.x;
  const rl = Math.hypot(rx, rz) || 1;
  const right = { x: rx / rl, y: 0, z: rz / rl };
  const up = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  const tanV = Math.tan((pose.fov * Math.PI) / 360);
  const tanH = tanV * ASPECT;
  let holes = 0;
  let solid = 0;
  let aboveHorizon = 0;
  let groundHoles = 0;
  const worst = [];
  for (let iy = 0; iy < ROWS; iy += 1) {
    const sy = 0.55 + ((iy + 0.5) / ROWS) * 0.45;
    const ndcY = -(sy * 2 - 1);
    for (let ix = 0; ix < COLS; ix += 1) {
      const sx = (ix + 0.5) / COLS;
      const ndcX = sx * 2 - 1;
      const dx = fwd.x + right.x * ndcX * tanH + up.x * ndcY * tanV;
      const dy = fwd.y + right.y * ndcX * tanH + up.y * ndcY * tanV;
      const dz = fwd.z + right.z * ndcX * tanH + up.z * ndcY * tanV;
      const dl = Math.hypot(dx, dy, dz) || 1;
      const hit = raycast(soup, pose.eye.x, pose.eye.y, pose.eye.z,
        dx / dl, dy / dl, dz / dl, 400);
      if (!hit) {
        holes += 1;
        if (dy > 0) aboveHorizon += 1;
        else {
          groundHoles += 1;
          if (worst.length < 6) {
            worst.push({ sx: +sx.toFixed(3), sy: +sy.toFixed(3), pitchDeg: +((Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI).toFixed(1) });
          }
        }
      } else solid += 1;
    }
  }
  const total = holes + solid;
  return {
    samples: total,
    holes,
    solid,
    aboveHorizon,
    // A ray pitched at or below the horizon MUST find ground. That is the part
    // of the metric ground geometry can control, and it is gated at zero.
    groundHoles,
    holeRatio: +(holes / total).toFixed(4),
    groundHoleRatio: +(groundHoles / total).toFixed(4),
    worst,
  };
}

const CARDS = [
  { id: '01-street-day', pose: 'street' },
  { id: '02-intersection', pose: 'intersection' },
  { id: '03-canyon-golden', pose: 'canyon' },
  { id: '04-waterfront', pose: 'waterfront' },
  { id: '05-wet-street', pose: 'street' },
  { id: '06-night-street', pose: 'street' },
  { id: '07-character-curb', pose: 'character' },
  { id: '08-traversal', pose: 'traversal' },
];

console.log('  card                before    after   sky   (modelled lower-frame hole ratio)');
let worstAfter = 0;
let worstAfterCard = null;
let worstGround = 0;
let worstGroundCard = null;
let sumAfter = 0;
const cardRows = [];
// The capture script does NOT reset the camera when a pose cannot be resolved:
// `placeCamera` returns { ok: false } and the previous card's pinned pose stays
// in place, so that card is shot from where the last one stood. Reproduce that
// instead of skipping, or the modelled set is not the captured set. (This is
// why the real 04-waterfront run reported exactly card 03's hole ratio: the
// loaded window has no Embarcadero and the camera never moved.)
let lastPose = null;
for (const card of CARDS) {
  let pose = placeCamera(card.pose);
  let note = '';
  if (!pose.ok) {
    if (!lastPose) { console.log(`  ${card.id.padEnd(18)}  pose unavailable and no previous pose: ${pose.reason}`); continue; }
    note = `  [pose unavailable (${pose.reason}); camera held at the previous card, as the capture script does]`;
    pose = lastPose;
  }
  lastPose = pose;
  const bRes = castCard(raySoupBefore, pose);
  const aRes = castCard(raySoupAfter, pose);
  cardRows.push({ card, pose, bRes, aRes });
  if (aRes.holeRatio > worstAfter) { worstAfter = aRes.holeRatio; worstAfterCard = card.id; }
  if (aRes.groundHoleRatio > worstGround) { worstGround = aRes.groundHoleRatio; worstGroundCard = card.id; }
  sumAfter += aRes.holeRatio;
  console.log(`  ${card.id.padEnd(18)} ${(bRes.holeRatio * 100).toFixed(1).padStart(6)}% `
    + `${(aRes.holeRatio * 100).toFixed(1).padStart(7)}% ${String(aRes.aboveHorizon).padStart(5)}   `
    + `eye=(${pose.eye.x.toFixed(1)}, ${pose.eye.y.toFixed(2)}, ${pose.eye.z.toFixed(1)}) fov=${pose.fov}${note}`);
  if (aRes.groundHoles) {
    console.log(`      ground holes: ${aRes.groundHoles} - ${JSON.stringify(aRes.worst)}`);
  }
}
const meanAfter = cardRows.length ? sumAfter / cardRows.length : 1;
console.log(`  mean after = ${(meanAfter * 100).toFixed(2)}%   worst after = `
  + `${(worstAfter * 100).toFixed(2)}% (${worstAfterCard})   worst ground-hole = `
  + `${(worstGround * 100).toFixed(2)}% (${worstGroundCard || 'none'})`);
console.log('  "sky" counts rays that leave the camera pitched ABOVE the horizon. No ground');
console.log('  surface can intercept those; they are a property of the card\'s look target.');
assert(cardRows.length === CARDS.length, `all ${CARDS.length} cards modelled (${cardRows.length})`);
assert(cardRows.every((r) => r.aRes.holeRatio <= r.bRes.holeRatio), 'no card gets worse');
// HARD GATE: every ray at or below the horizon must land on something solid
// inside 400 m. This is the whole of what ground coverage is responsible for.
assert(worstGround === 0,
  `no card has a single below-horizon ray that finds no ground (worst ${(worstGround * 100).toFixed(2)}%)`);
// Reported, and gated, for the cards whose framing keeps the lower band below
// the horizon. 03-canyon-golden looks at a point 22 m up with a 58 deg fov, so
// part of its "lower 45%" band is aimed at open sky between the roof lines;
// those rays are counted honestly rather than excused, and they are the ONLY
// residue left anywhere.
for (const r of cardRows) {
  const skyOnly = r.aRes.holes > 0 && r.aRes.holes === r.aRes.aboveHorizon;
  assert(r.aRes.holeRatio < 0.01 || skyOnly,
    `${r.card.id}: ${(r.aRes.holeRatio * 100).toFixed(2)}% holes`
    + (skyOnly ? ` - all ${r.aRes.holes} are above-horizon sky rays, not ground holes` : ''));
}
assert(cardRows.every((r) => sampleGroundCoverage(data, r.pose.eye.x, r.pose.eye.z).covered),
  'every card camera stands over the carpet');

// ---------------------------------------------------------------------------
// 6. determinism
// ---------------------------------------------------------------------------

section('6. determinism');
const again = buildGroundCoverageData(city, { heightAt });
assert(JSON.stringify(again.positions) === JSON.stringify(data.positions)
  && JSON.stringify(again.indices) === JSON.stringify(data.indices)
  && JSON.stringify(again.colors) === JSON.stringify(data.colors)
  && JSON.stringify(again.uvs) === JSON.stringify(data.uvs),
  'two builds of the same city are bit-identical');
const src = await readFile(path.join(ROOT, 'src/world/ground-coverage.js'), 'utf8');
// Strip comments first: the module's own header documents the rule in prose and
// a naive grep would match the documentation instead of the code.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
assert(!/Math\.random|Date\.now|new Date\(/.test(code),
  'no Math.random / Date.now / new Date() in module code');

// ---------------------------------------------------------------------------
// 7. THREE build (stock materials only, WebGL2-safe, world-space vertices)
// ---------------------------------------------------------------------------

section('7. THREE build');
{
  const THREE = await import('three');
  const built = mod.buildGroundCoverage(city, { heightAt });
  assert(built.drawCalls === 1 && built.group.children.length === 1,
    'one mesh, one draw call');
  assert(built.material.isMeshStandardMaterial === true
    && built.material.type === 'MeshStandardMaterial',
    'stock MeshStandardMaterial - no ShaderMaterial, no node/TSL material');
  assert(!Object.prototype.hasOwnProperty.call(built.material, 'onBeforeCompile'),
    'onBeforeCompile is untouched (WebGPURenderer would silently blank it)');
  assert(built.material.vertexColors === true && built.material.metalness === 0,
    'vertex-coloured, non-metallic ground');
  assert(built.mesh.receiveShadow === true && built.mesh.castShadow === false,
    'ground receives shadow and casts none');
  // The whole defect this module fixes was a mesh whose vertices were not where
  // the world is. Prove the built geometry is in ABSOLUTE world metres and that
  // the group carries no offset the integrator could forget about.
  built.geometry.computeBoundingBox();
  const box = built.geometry.boundingBox;
  assert(box.min.x <= b.minX && box.max.x >= b.maxX && box.min.z <= b.minZ && box.max.z >= b.maxZ,
    `geometry bounding box contains the whole slice `
    + `(x ${box.min.x.toFixed(0)}..${box.max.x.toFixed(0)}, z ${box.min.z.toFixed(0)}..${box.max.z.toFixed(0)})`);
  assert(built.group.position.x === 0 && built.group.position.y === 0 && built.group.position.z === 0
    && built.mesh.position.x === 0 && built.mesh.position.y === 0 && built.mesh.position.z === 0,
    'group and mesh sit at the origin: vertices are world coordinates, add at identity');
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  assert(Math.abs(centre.x - s.centre.x) < 400 && Math.abs(centre.z - s.centre.z) < 400,
    `geometry is centred on the slice, not on the world origin `
    + `(centre x=${centre.x.toFixed(0)} z=${centre.z.toFixed(0)}, slice centre x=${s.centre.x} z=${s.centre.z})`);
  const position = built.geometry.getAttribute('position');
  assert(position && built.geometry.getAttribute('normal') && built.geometry.getAttribute('color')
    && built.geometry.getAttribute('uv') && built.geometry.index,
    'geometry carries position, normal, color, uv and an index buffer');
  assert(built.geometry.boundingSphere && Number.isFinite(built.geometry.boundingSphere.radius),
    'bounding sphere is finite (a NaN sphere silently disables raycasting)');
  mod.disposeGroundCoverage(built);
  assert(built.group.children.length === 0, 'dispose releases the group contents');
  console.log(`  built against three r${THREE.REVISION}`);
}

// ---------------------------------------------------------------------------
section('5. horizon reach: every below-horizon ray lands on ground');
// ---------------------------------------------------------------------------
{
  // The eight round-1 quality-card poses, verbatim from
  // .qa-round1/capture-report.json, at the viewport they were captured at.
  const POSES = [
    ['01/05/06-street', { x: 1435.49, y: 2.35, z: 993.43 }, { x: 1379.47, y: 2.25, z: 1064.06 }, 47],
    ['02-intersection', { x: 1668.84, y: 2.17, z: -0.05 }, { x: 1678.9, y: 2.03, z: -21.1 }, 47],
    ['03/04-canyon', { x: 1446.56, y: 2.34, z: 916.81 }, { x: 1515.56, y: 22.71, z: 974.62 }, 58],
    ['07-character', { x: 1438.04, y: 2.70, z: 990.08 }, { x: 1436.07, y: 1.80, z: 993.95 }, 47],
    ['08-traversal', { x: 1455.42, y: 2.30, z: 971.01 }, { x: 1348.29, y: 2.22, z: 1103.24 }, 47],
  ];
  const VIEW = { w: 1600, h: 900 };
  const CAMERA_FAR = 4200; // CityRenderer.buildCity pins this

  const rayGrid = (eye, target, fov) => {
    const f = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
    const fl = Math.hypot(f.x, f.y, f.z);
    f.x /= fl; f.y /= fl; f.z /= fl;
    let r = { x: f.y * 0 - f.z * 1, y: f.z * 0 - f.x * 0, z: f.x * 1 - f.y * 0 };
    const rl = Math.hypot(r.x, r.y, r.z);
    r = { x: r.x / rl, y: r.y / rl, z: r.z / rl };
    const u = {
      x: r.y * f.z - r.z * f.y,
      y: r.z * f.x - r.x * f.z,
      z: r.x * f.y - r.y * f.x,
    };
    const tanV = Math.tan((fov * Math.PI) / 360);
    const aspect = VIEW.w / VIEW.h;
    const out = [];
    for (let py = 0; py < VIEW.h; py += 4) {
      for (let px = 0; px < VIEW.w; px += 5) {
        const dx = ((px + 0.5) / VIEW.w * 2 - 1) * tanV * aspect;
        const dy = (1 - (py + 0.5) / VIEW.h * 2) * tanV;
        const d = {
          x: f.x + r.x * dx + u.x * dy,
          y: f.y + r.y * dx + u.y * dy,
          z: f.z + r.z * dx + u.z * dy,
        };
        const dl = Math.hypot(d.x, d.y, d.z);
        out.push({ x: d.x / dl, y: d.y / dl, z: d.z / dl });
      }
    }
    return out;
  };

  const xs = data.grid.xs;
  const zs = data.grid.zs;
  const inGrid = (x, z) => x >= xs[0] && x <= xs[xs.length - 1] && z >= zs[0] && z <= zs[zs.length - 1];
  const carpetY = (x, z) => heightAt(x, z) - data.options.sink;

  let totalBelow = 0;
  let totalEscaped = 0;
  let totalUnreachable = 0;
  let worstReachable = null;
  for (const [name, eye, target, fov] of POSES) {
    let below = 0;
    let escaped = 0;
    let unreachable = 0;
    for (const d of rayGrid(eye, target, fov)) {
      if (d.y >= -1e-9) continue; // above the horizon: sky is the right answer
      below += 1;
      // A ray this shallow cannot reach the ground inside the far plane no
      // matter how far the carpet is extended; that residue belongs to the
      // atmosphere, not to this module.
      const reachable = (eye.y - carpetY(eye.x, eye.z)) / -d.y <= CAMERA_FAR;
      let t = 1;
      let hit = false;
      for (let k = 0; k < 96; k += 1) {
        const x = eye.x + d.x * t;
        const z = eye.z + d.z * t;
        const y = eye.y + d.y * t;
        if (!inGrid(x, z)) break;
        const cy = carpetY(x, z);
        if (y <= cy + 1e-3) { hit = true; break; }
        t += Math.max(0.5, ((y - cy) / -d.y) * 0.9);
        if (t > CAMERA_FAR) break;
      }
      if (hit) continue;
      escaped += 1;
      if (!reachable) unreachable += 1;
      else if (!worstReachable) worstReachable = { name, dy: d.y };
    }
    totalBelow += below;
    totalEscaped += escaped;
    totalUnreachable += unreachable;
    console.log(`  ${name.padEnd(16)} below-horizon rays ${below}, escaped ${escaped} `
      + `(${escaped - unreachable} of them could have reached the ground inside the far plane)`);
  }
  const reachableEscapes = totalEscaped - totalUnreachable;
  assert(totalBelow > 100000, `swept ${totalBelow} below-horizon rays across the eight card poses`);
  assert(reachableEscapes === 0,
    `every below-horizon ray that can reach the ground inside the ${CAMERA_FAR} m far plane lands on the carpet `
    + `(${reachableEscapes} escaped${worstReachable ? `, first on ${worstReachable.name}` : ''})`);
  console.log(`  ${totalUnreachable} of ${totalBelow} rays graze the horizon so closely that their ground `
    + 'intersection is beyond the camera far plane; no carpet size can catch those.');
  assert(data.options.horizonRadius >= 5000,
    `the apron reaches past the far plane from the worst corner of the window (${data.options.horizonRadius} m)`);
  assert(data.stats.triangles <= mod.GROUND_COVERAGE_BUDGET.maxTriangles,
    `extending the apron cost no budget (${data.stats.triangles} <= ${mod.GROUND_COVERAGE_BUDGET.maxTriangles} triangles)`);
}


// ---------------------------------------------------------------------------
section('8. tone: the carpet reads as ground, not as the brightest thing in frame');
// ---------------------------------------------------------------------------
{
  // THE ROUND-2 DEFECT, measured on the shipped capture set:
  //   01-street-day  region [1200,500,1580,700] mean luma 209.6, against a
  //                  footway at 184.5 in [850,700,1150,880];
  //   06-night-street region [1150,480,1350,620] mean luma 80.5, against a
  //                  footway at 62.1 - the brightest ground in a night frame;
  //   03-canyon-golden 16.5% of the frame, with no paved surface anywhere in
  //                  the lower half, so the card's whole ground was this.
  //
  // The rule, asserted against the STREET module's own palette rather than a
  // copied number, so changing a hex there without changing one here fails:
  // no ground tone may be lighter than the footway it lies beside, and none
  // may be lighter than the verge that grades down onto it.
  const luma = (hex) => {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  for (const name of Object.keys(mod.GROUND_COVERAGE_PALETTES)) {
    const ground = mod.GROUND_COVERAGE_PALETTES[name];
    const street = STREET_SURFACE_V2_PALETTES[name];
    assert(street, `ground palette '${name}' has a matching street palette to be measured against`);
    if (!street) continue;
    const footway = luma(street.sidewalk);
    const verge = luma(street.verge);
    let brightest = 0;
    let brightestName = '';
    for (const key of mod.GROUND_COVERAGE_LAND_CLASSES) {
      if (!ground[key]) continue;
      const l = luma(ground[key]);
      if (l > brightest) { brightest = l; brightestName = key; }
    }
    console.log(`  ${name}: brightest ground tone '${brightestName}' ${(brightest * 255).toFixed(1)}, `
      + `footway ${(footway * 255).toFixed(1)}, verge ${(verge * 255).toFixed(1)}`);
    assert(brightest <= footway,
      `${name}: no ground tone is lighter than the street footway `
      + `(${(brightest * 255).toFixed(1)} <= ${(footway * 255).toFixed(1)})`);
    assert(brightest <= verge,
      `${name}: no ground tone is lighter than the verge that grades onto it `
      + `(${(brightest * 255).toFixed(1)} <= ${(verge * 255).toFixed(1)})`);
  }

  // The same rule on the buffer that actually ships, not just on the palette,
  // so a regression in the mixing is caught as well as one in a hex.
  const footwayLuma = (() => {
    const n = parseInt(STREET_SURFACE_V2_PALETTES.sf.sidewalk.replace('#', ''), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  })();
  console.log(`  emitted vertex tone: min ${(s.tone.minLuma * 255).toFixed(1)} `
    + `mean ${(s.tone.meanLuma * 255).toFixed(1)} max ${(s.tone.maxLuma * 255).toFixed(1)} `
    + `(spread ${(s.tone.spread * 255).toFixed(1)})`);
  assert(s.tone.maxLuma <= footwayLuma,
    `the brightest vertex the carpet emits is still no lighter than the footway `
    + `(${(s.tone.maxLuma * 255).toFixed(1)} <= ${(footwayLuma * 255).toFixed(1)})`);
  assert(s.tone.maxLuma <= footwayLuma * 0.72,
    `the carpet is toned clearly BELOW the footway, not merely level with it `
    + `(${(s.tone.maxLuma * 255).toFixed(1)} <= ${(footwayLuma * 0.72 * 255).toFixed(1)})`);

  // It is not one flat fill. Round 2's only variation was a +/-2.5% per-vertex
  // hash, which is invisible; the mottling field has to produce a real spread.
  assert(s.tone.spread * 255 >= 12,
    `the carpet carries real tonal variation across the slice `
    + `(${(s.tone.spread * 255).toFixed(1)} luma of spread over ${s.vertices} vertices)`);
  // And the variation is spatial, not just per-vertex noise: neighbouring
  // vertices must correlate, or the carpet is speckle rather than mottling.
  {
    const xs = data.grid.xs;
    const zs = data.grid.zs;
    const nx = xs.length;
    const toneAt = (i, j) => {
      const k = j * nx + i;
      return 0.2126 * data.colors[k * 3] + 0.7152 * data.colors[k * 3 + 1] + 0.0722 * data.colors[k * 3 + 2];
    };
    let neighbour = 0;
    let distant = 0;
    let samples = 0;
    for (let j = 8; j < zs.length - 8; j += 3) {
      for (let i = 8; i < nx - 8; i += 3) {
        neighbour += Math.abs(toneAt(i, j) - toneAt(i + 1, j));
        distant += Math.abs(toneAt(i, j) - toneAt(i + 7, j));
        samples += 1;
      }
    }
    const near = neighbour / samples;
    const far = distant / samples;
    console.log(`  mean |tone difference|: adjacent vertices ${(near * 255).toFixed(2)}, `
      + `seven cells apart ${(far * 255).toFixed(2)}`);
    assert(far > near * 1.25,
      `tone varies over distance rather than pixel to pixel `
      + `(${(far * 255).toFixed(2)} at 7 cells vs ${(near * 255).toFixed(2)} adjacent)`);
  }
}

// ---------------------------------------------------------------------------
section('9. material identity: the carpet declares what it is and what it needs');
// ---------------------------------------------------------------------------
{
  const built = mod.buildGroundCoverage(city, { heightAt });
  const identity = built.material.userData;
  // Identity. A future change that swaps this surface for something else, or
  // quietly drops its dressing request, has to change these too - and the
  // street-surface-detail pass finds the material by exactly this pair.
  assert(identity.source === GROUND_COVERAGE_ID,
    `the material names its source (${identity.source})`);
  assert(identity.layer === 'ground-carpet',
    `the material names its layer, so it cannot be confused with the footway (${identity.layer})`);
  assert(mod.GROUND_COVERAGE_MATERIAL.source === GROUND_COVERAGE_ID
    && mod.GROUND_COVERAGE_MATERIAL.layer === 'ground-carpet',
    'the exported identity matches the material the module builds');
  assert(identity.tonePolicy === 'never-lighter-than-footway-or-verge',
    `the material records the tone rule its palette was chosen under (${identity.tonePolicy})`);
  // Dressing request. The renderer deliberately gives this surface no albedo
  // texture; without a detail-map class it is the only large surface in the
  // world with no map of any kind, which is how it became a flat card.
  assert(typeof identity.detailClass === 'string' && identity.detailClass.length > 0,
    `the material requests a detail-map class (${identity.detailClass})`);
  assert(identity.detailApplied === false,
    'the material starts undressed and records when a pass has dressed it, so dressing is idempotent');
  assert(Number.isFinite(identity.uvMetersPerRepeat) && identity.uvMetersPerRepeat > 0,
    `the material publishes its UV scale so a pass can compute a repeat (${identity.uvMetersPerRepeat} m)`);
  // Environment class. Without this the renderer's grading and the whole
  // wet-weather response never reach 8-17% of a captured frame.
  assert(MATERIAL_CLASSES.includes(identity.envClass),
    `the material declares an environment class the grader knows (${identity.envClass})`);
  assert(identity.envClass === mod.GROUND_COVERAGE_MATERIAL.envClass,
    'the built material carries the exported environment class');
  mod.disposeGroundCoverage(built);
}

// ---------------------------------------------------------------------------

console.log(`\n${failures.length ? 'FAILED' : 'PASSED'}: ${checks - failures.length}/${checks} checks`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
