// Wheel-contact grounding check for the vehicle populations.
//
// Runs headless under plain node: no browser, no DOM, no canvas, no capture.
// Exits non-zero on the first failed assertion group.
//
//   node scripts/verify/verify-vehicle-grounding.mjs
//
// WHY THIS EXISTS
//
// `verify-vehicle-presentation.mjs` already measures wheel contacts, but it
// measures them against `carriagewaySurfaceY(...)` - the same function the
// placement code calls. That is self-consistent by construction: it proves the
// placement agrees with its own model of the road, not with the road the
// renderer actually draws. A vehicle can pass that check and still float,
// which is exactly what the round-4 evidence showed for the moving population.
//
// This measures against the DRAWN TRIANGLES. It builds the street surface with
// `buildStreetSurfaceData` - the same call `src/citygen/renderer.js` makes -
// indexes the carriageway triangle soup, and asks, for every wheel contact
// point, what the height of the asphalt under it is by barycentric lookup in
// the triangle that covers it. Nothing here re-derives a cross-section.
//
// What it proves:
//   1. every PARKED wheel contact is on the drawn carriageway
//   2. every MOVING wheel contact is on the drawn carriageway, through the same
//      path the traffic mirror grounds on
//   3. the flat road datum the simulation used to place vehicles on is NOT
//      within that tolerance - so the test is measuring something real
//   4. `TrafficSim.vehicleGroundY` grounds on the same surface, at the wheels

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  buildStreetSurfaceData,
  buildStreetscapePlan,
  buildStreetSurfaceV2,
} from '../../src/world/streets/street-surface-v2.js';
import {
  VEHICLE_BUDGET,
  VEHICLE_LIGHTS,
  buildVehiclePresentation,
  createDrawnRoadIndex,
  createSegmentIndex,
  findDrawnRoadMesh,
  groundVehicleAt,
  disposeVehiclePresentation,
  updateVehiclePresentation,
  wheelContactPoints,
} from '../../src/render/passes/vehicle-presentation.js';
import { VEHICLE_SPEC_BY_ID } from '../../src/vehicles/vehicle-catalogue.js';
import { createStreetSurfaceSampler } from '../../src/citygen/traffic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// The window `src/citygen/main.js` boots `/` on.
const CITY = Object.freeze({ center: [1600, 400], radius: 720, maxBuildings: 900 });
// The hero corridor every quality card is posed on.
const POSE = Object.freeze({ x: 1447.11, z: 1003.77 });

/**
 * Wheel contact vs the drawn asphalt under it, metres.
 *
 * The ribbon is swept on cross-sections at most `maxStep` (6 m) apart and
 * chords between them, so a vehicle grounded on the continuous cross-section
 * sits a sagitta above or below the chord wherever the terrain curves. On the
 * shipped slice that term is sub-centimetre; 25 mm leaves room for it without
 * leaving room for a float a reviewer can see. 25 mm at 12 m is a fifth of a
 * pixel on a 1600 x 900 frame.
 */
const CONTACT_TOLERANCE = 0.025;

/** What the OLD flat datum was wrong by, and must still be wrong by. */
const FLAT_DATUM_MIN_ERROR = 0.03;

let checks = 0;
const failures = [];
function assert(condition, message) {
  checks += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures.push(message);
}
function section(title) { console.log(`\n${title}`); }

// ---------------------------------------------------------------------------
// the drawn surface, as triangles
// ---------------------------------------------------------------------------

/** Uniform-grid index over one layer's triangle soup. */
function indexLayer(layer, cell = 8) {
  const pos = layer.positions;
  const idx = layer.indices;
  const grid = new Map();
  const tris = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3; const b = idx[i + 1] * 3; const c = idx[i + 2] * 3;
    const t = [
      pos[a], pos[a + 1], pos[a + 2],
      pos[b], pos[b + 1], pos[b + 2],
      pos[c], pos[c + 1], pos[c + 2],
    ];
    const ti = tris.push(t) - 1;
    const minX = Math.min(t[0], t[3], t[6]); const maxX = Math.max(t[0], t[3], t[6]);
    const minZ = Math.min(t[2], t[5], t[8]); const maxZ = Math.max(t[2], t[5], t[8]);
    for (let cz = Math.floor(minZ / cell); cz <= Math.floor(maxZ / cell); cz += 1) {
      for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx += 1) {
        const k = `${cx}:${cz}`;
        let list = grid.get(k);
        if (!list) { list = []; grid.set(k, list); }
        list.push(ti);
      }
    }
  }
  return { tris, grid, cell };
}

/**
 * Every drawn surface height at a world point.
 *
 * A point can carry more than one: `street-surface-v2` lays a junction pad
 * across the ribbons that meet at it and lets a narrow street's ribbon run
 * under a wider one's, so two paved surfaces overlap with a step between them.
 * A wheel there is correctly grounded when it rests on ONE of them and floats
 * above NONE of them, which is what the two errors below measure.
 */
function probeAll(index, x, z) {
  const list = index.grid.get(`${Math.floor(x / index.cell)}:${Math.floor(z / index.cell)}`);
  if (!list) return [];
  const out = [];
  for (const ti of list) {
    const t = index.tris[ti];
    const x0 = t[0]; const y0 = t[1]; const z0 = t[2];
    const x1 = t[3]; const y1 = t[4]; const z1 = t[5];
    const x2 = t[6]; const y2 = t[7]; const z2 = t[8];
    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(d) < 1e-12) continue;
    const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
    const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
    out.push(l0 * y0 + l1 * y1 + l2 * y2);
  }
  return out;
}

/**
 * Least-squares plane through four (dx, dz, y) samples, evaluated back at each.
 * A rigid four-wheel body can only ever sit on the best-fit plane through the
 * surface under its wheels: where the asphalt under one wheel steps 100 mm - as
 * it does wherever `street-surface-v2` laps one ribbon over another - a real
 * vehicle lifts a wheel and there is no placement that touches all four. The
 * gate is therefore "the placement matches the best plane a rigid body could
 * achieve", not "every wheel is on its own surface".
 */
function planeResidual(samples) {
  const n = samples.length;
  if (n < 3) return { residual: 0, spread: 0 };
  let mx = 0; let mz = 0; let my = 0;
  for (const p of samples) { mx += p.dx; mz += p.dz; my += p.y; }
  mx /= n; mz /= n; my /= n;
  let cxx = 0; let cxz = 0; let czz = 0; let cxy = 0; let czy = 0;
  for (const p of samples) {
    const dx = p.dx - mx; const dz = p.dz - mz; const dy = p.y - my;
    cxx += dx * dx; cxz += dx * dz; czz += dz * dz; cxy += dx * dy; czy += dz * dy;
  }
  const det = cxx * czz - cxz * cxz;
  let a = 0; let b = 0;
  if (Math.abs(det) > 1e-9) {
    a = (cxy * czz - czy * cxz) / det;
    b = (czy * cxx - cxy * cxz) / det;
  }
  const c = my - a * mx - b * mz;
  let residual = 0;
  let lo = Infinity; let hi = -Infinity;
  for (const p of samples) {
    const fit = c + a * p.dx + b * p.dz;
    const d = Math.abs(p.contact - fit);
    if (d > residual) residual = d;
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  return { residual, spread: hi - lo };
}

/**
 * `float` is how far the contact stands above the HIGHEST asphalt under it -
 * the defect a reviewer sees as a vehicle levitating, and the one that buries
 * or lifts the contact patch. `rest` is the distance to the NEAREST asphalt
 * under it - the test that it is standing on a real surface at all.
 */
function contactError(index, x, z, y) {
  const heights = probeAll(index, x, z);
  if (!heights.length) return null;
  let top = -Infinity;
  let rest = Infinity;
  for (const h of heights) {
    if (h > top) top = h;
    const d = Math.abs(y - h);
    if (d < rest) rest = d;
  }
  return { float: y - top, rest, surfaces: heights.length };
}

/** Height of the drawn surface at a world point, or null when it is not paved. */
function probe(index, x, z) {
  const list = index.grid.get(`${Math.floor(x / index.cell)}:${Math.floor(z / index.cell)}`);
  if (!list) return null;
  let best = null;
  for (const ti of list) {
    const t = index.tris[ti];
    const x0 = t[0]; const y0 = t[1]; const z0 = t[2];
    const x1 = t[3]; const y1 = t[4]; const z1 = t[5];
    const x2 = t[6]; const y2 = t[7]; const z2 = t[8];
    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(d) < 1e-12) continue;
    const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
    const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
    const y = l0 * y0 + l1 * y1 + l2 * y2;
    if (best === null || y > best) best = y;
  }
  return best;
}

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------

globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^https?:\/\/[^/]+/, '');
  if (rel.endsWith('.gz')) return { ok: false, status: 415 };
  try {
    const text = await readFile(join(REPO, 'public', rel), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  } catch { return { ok: false, status: 404 }; }
};

const { loadSfData } = await import(join(REPO, 'src/citygen/sf-data.js'));
const city = await loadSfData(CITY);
const heightAt = (x, z) => city.terrain.heightAt(x, z);

// The exact options src/citygen/renderer.js hands the surface builder.
const SURFACE_OVERRIDES = {
  roadLift: Number(city.meta?.streetDesign?.roadLift ?? 0.45),
  gutterDepth: 0.04,
  curbFaceHeight: 0.102 + 0.04 + 0.008,
  heightAt,
  palette: 'sf',
  inferNodes: true,
};
const surface = buildStreetSurfaceData(city, SURFACE_OVERRIDES);
const road = indexLayer(surface.layers.carriageway);
console.log(`world: ${city.segments.length} source segments, `
  + `${surface.stats.trianglesTotal} street triangles, ${road.tris.length} carriageway triangles`);

// ---------------------------------------------------------------------------
section('1. parked wheels rest on the drawn carriageway');
// ---------------------------------------------------------------------------

// The same objects the renderer puts in the city root, so the pass grounds on
// the geometry a camera would see rather than on a model of it.
const drawn = buildStreetSurfaceV2(city, SURFACE_OVERRIDES);
const worldRoot = new THREE.Group();
worldRoot.name = 'city-root';
worldRoot.add(drawn.group);
worldRoot.updateMatrixWorld(true);

const built = buildVehiclePresentation({
  city,
  root: worldRoot,
  focus: POSE,
  heightAt,
  seed: city.meta.seed,
  streetSurfaceOptions: surface.options,
});
console.log(`  grounding source: ${built.diagnostics.surface.groundingSource},`
  + ` ${built.diagnostics.surface.drawnRoadTriangles} carriageway triangles indexed`);
assert(built.diagnostics.surface.groundingSource === 'drawn-geometry',
  'the pass grounds on the carriageway mesh the renderer drew');

function auditContacts(vehicles, radius) {
  const acc = {
    worstFloat: 0, worstFloatId: null, worstResidual: 0, worstResidualId: null,
    sumRest: 0, samples: 0, offMesh: 0, overlapped: 0, stepped: 0, vehicles: 0,
    worstStep: 0,
  };
  for (const v of vehicles) {
    if (radius && Math.hypot(v.x - POSE.x, v.z - POSE.z) > radius) continue;
    const samples = [];
    for (const c of wheelContactPoints(v.spec, v)) {
      const e = contactError(road, c.x, c.z, c.y);
      if (!e) { acc.offMesh += 1; continue; }
      acc.samples += 1;
      acc.sumRest += e.rest;
      if (e.surfaces > 1) acc.overlapped += 1;
      if (e.float > acc.worstFloat) { acc.worstFloat = e.float; acc.worstFloatId = v.id ?? v.typeId; }
      samples.push({ dx: c.x - v.x, dz: c.z - v.z, y: c.y - e.float, contact: c.y });
    }
    if (samples.length < 3) continue;
    acc.vehicles += 1;
    const fit = planeResidual(samples);
    if (fit.spread > CONTACT_TOLERANCE) { acc.stepped += 1; }
    if (fit.spread > acc.worstStep) acc.worstStep = fit.spread;
    if (fit.residual > acc.worstResidual) {
      acc.worstResidual = fit.residual;
      acc.worstResidualId = v.id ?? v.typeId;
    }
  }
  acc.meanRest = acc.samples ? acc.sumRest / acc.samples : 0;
  return acc;
}

const parked = auditContacts(built.state.vehicles, 110);
console.log(`  parked: ${parked.samples} wheel contacts inside 110 m, ${parked.offMesh} off the mesh,`
  + ` ${parked.overlapped} over overlapping asphalt`);
assert(parked.samples > 100, `enough parked wheel contacts to mean something (${parked.samples})`);
console.log(`  parked: ${parked.vehicles} vehicles, ${parked.stepped} standing over a step in the asphalt`
  + ` (worst step ${(parked.worstStep * 1000).toFixed(0)} mm)`);
assert(parked.worstResidual <= CONTACT_TOLERANCE,
  `every parked body sits on the best plane through the drawn asphalt under its wheels:`
  + ` worst residual ${(parked.worstResidual * 1000).toFixed(1)} mm <= ${CONTACT_TOLERANCE * 1000} mm`
  + (parked.worstResidualId ? ` (${parked.worstResidualId})` : ''));
assert(parked.worstFloat <= CONTACT_TOLERANCE,
  `no parked wheel stands above the asphalt: worst ${(parked.worstFloat * 1000).toFixed(1)} mm`
  + ` <= ${CONTACT_TOLERANCE * 1000} mm` + (parked.worstFloatId ? ` (${parked.worstFloatId})` : ''));
assert(parked.meanRest <= CONTACT_TOLERANCE / 4,
  `mean parked contact error ${(parked.meanRest * 1000).toFixed(2)} mm <= ${(CONTACT_TOLERANCE * 250).toFixed(1)} mm`);

// ---------------------------------------------------------------------------
section('2. a moving vehicle grounds on the drawn carriageway');
// ---------------------------------------------------------------------------
//
// The traffic mirror is handed a world position and a heading by the
// simulation. This walks a vehicle down the centreline and both lanes of every
// carriageway near the pose and grounds it exactly the way the mirror does.

const plan = buildStreetscapePlan(city, SURFACE_OVERRIDES);
const index = createSegmentIndex(plan);
const roadIndex = createDrawnRoadIndex(findDrawnRoadMesh(worldRoot), { centre: POSE });
const datumAt = (x, z) => surface.options.roadLift + heightAt(x, z);
assert(roadIndex && roadIndex.triangles > 2000,
  `the drawn-road window is populated (${roadIndex ? roadIndex.triangles : 0} triangles,`
  + ` ${roadIndex ? roadIndex.cells : 0} cells)`);
assert(index.spans > 200, `the plan index covers the city (${index.spans} spans, ${index.cells} cells)`);

const TEST_TYPES = ['sedan', 'deliveryVan', 'boxTruck', 'cityBus'];
let moving = {
  worstFloat: 0, worstResidual: 0, worstStep: 0, sum: 0, n: 0,
  floatAt: null, residualAt: null, stepped: 0, bodies: 0,
};
let flat = { worst: 0, sum: 0, n: 0, inTolerance: 0 };
let placedVehicles = 0;
for (const segment of plan.segments) {
  if (Math.hypot(segment.points[0].x - POSE.x, segment.points[0].z - POSE.z) > 160) continue;
  const start = segment.trimStart + 6;
  const end = segment.length - segment.trimEnd - 6;
  if (!(end - start > 4)) continue;
  for (let s = start; s <= end; s += 7) {
    for (const laneFraction of [0, 0.5, -0.5]) {
      const typeId = TEST_TYPES[Math.floor(s + placedVehicles) % TEST_TYPES.length];
      const spec = VEHICLE_SPEC_BY_ID[typeId];
      const i = Math.max(0, Math.min(segment.points.length - 2,
        segment.points.findIndex((p, k) => k < segment.points.length - 1 && segment.cum[k + 1] >= s)));
      const a = segment.points[i];
      const b = segment.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const t = Math.max(0, Math.min(1, (s - segment.cum[i]) / len));
      const tx = (b.x - a.x) / len; const tz = (b.z - a.z) / len;
      const u = laneFraction * segment.half;
      const cx = a.x + (b.x - a.x) * t + -tz * u;
      const cz = a.z + (b.z - a.z) * t + tx * u;
      const yaw = Math.atan2(tx, tz);
      const hit = index.locate(cx, cz);
      if (!hit) continue;
      const placed = groundVehicleAt(spec, hit.segment, cx, cz, yaw, plan.options, datumAt, index, roadIndex);
      if (!Number.isFinite(placed.y)) continue;
      placedVehicles += 1;
      // What the simulation's flat datum would have produced instead.
      const flatY = datumAt(cx, cz);
      const bodySamples = [];
      for (const c of wheelContactPoints(spec, { ...placed, yaw })) {
        const e = contactError(road, c.x, c.z, c.y);
        if (!e) continue;
        moving.sum += e.rest; moving.n += 1;
        if (e.float > moving.worstFloat) {
          moving.worstFloat = e.float;
          moving.floatAt = `${segment.id}@${s.toFixed(0)}m u=${u.toFixed(2)}`;
        }
        bodySamples.push({ dx: c.x - placed.x, dz: c.z - placed.z, y: c.y - e.float, contact: c.y });
        const flatE = contactError(road, c.x, c.z, flatY);
        if (!flatE) continue;
        flat.sum += flatE.rest; flat.n += 1;
        if (Math.abs(flatE.float) > Math.abs(flat.worst)) flat.worst = flatE.float;
        if (flatE.rest <= CONTACT_TOLERANCE) flat.inTolerance += 1;
      }
      if (bodySamples.length >= 3) {
        moving.bodies += 1;
        const fit = planeResidual(bodySamples);
        if (fit.spread > CONTACT_TOLERANCE) moving.stepped += 1;
        if (fit.spread > moving.worstStep) moving.worstStep = fit.spread;
        if (fit.residual > moving.worstResidual) {
          moving.worstResidual = fit.residual;
          moving.residualAt = `${segment.id}@${s.toFixed(0)}m u=${u.toFixed(2)}`;
        }
      }
    }
  }
}
console.log(`  moving: ${placedVehicles} placements, ${moving.n} wheel contacts measured`);
assert(moving.n > 500, `enough moving wheel contacts to mean something (${moving.n})`);
console.log(`  moving: ${moving.bodies} bodies, ${moving.stepped} over a step in the asphalt`
  + ` (worst step ${(moving.worstStep * 1000).toFixed(0)} mm)`);
assert(moving.worstResidual <= CONTACT_TOLERANCE,
  `every moving body sits on the best plane through the drawn asphalt under its wheels:`
  + ` worst residual ${(moving.worstResidual * 1000).toFixed(1)} mm <= ${CONTACT_TOLERANCE * 1000} mm`
  + (moving.residualAt ? ` (${moving.residualAt})` : ''));
assert(moving.worstFloat <= CONTACT_TOLERANCE,
  `no moving wheel stands above the asphalt: worst ${(moving.worstFloat * 1000).toFixed(1)} mm`
  + ` <= ${CONTACT_TOLERANCE * 1000} mm` + (moving.floatAt ? ` (${moving.floatAt})` : ''));
assert(moving.sum / Math.max(1, moving.n) <= CONTACT_TOLERANCE / 4,
  `mean moving contact error ${(moving.sum / Math.max(1, moving.n) * 1000).toFixed(2)} mm`
  + ` <= ${(CONTACT_TOLERANCE * 250).toFixed(1)} mm`);

// ---------------------------------------------------------------------------
section('3. the flat road datum really is wrong, so the check is not vacuous');
// ---------------------------------------------------------------------------

const flatMean = flat.sum / Math.max(1, flat.n);
console.log(`  flat datum: mean ${(flatMean * 1000).toFixed(1)} mm, worst ${(flat.worst * 1000).toFixed(1)} mm,`
  + ` ${flat.inTolerance}/${flat.n} contacts inside tolerance`);
assert(Math.abs(flat.worst) >= FLAT_DATUM_MIN_ERROR,
  `the datum the simulation used is off the drawn road by ${(Math.abs(flat.worst) * 1000).toFixed(1)} mm`
  + ` (>= ${FLAT_DATUM_MIN_ERROR * 1000} mm), i.e. this test can fail`);
assert(flat.inTolerance < flat.n * 0.5,
  `most flat-datum contacts miss the drawn road (${flat.inTolerance}/${flat.n} inside tolerance)`);

// ---------------------------------------------------------------------------
section('4. TrafficSim.vehicleGroundY grounds on the same surface, at the wheels');
// ---------------------------------------------------------------------------

const { TrafficSim } = await import(join(REPO, 'src/citygen/traffic.js'));
const sampler = createStreetSurfaceSampler(city, surface.options);
// A minimal `this` for the method under test: the sampler it reads, the
// terrain it reads, and the flat fallback it falls back to.
const stub = {
  streetSurfaceSampler: sampler,
  roadLift: surface.options.roadLift,
  groundingDiagnostics: { vehicleHits: 0, vehicleMisses: 0 },
  terrainY: (x, z) => heightAt(x, z),
  groundY(x, z) { return this.terrainY(x, z) + this.roadLift; },
};
const rig = { layout: { wheels: [[-0.7, 1.1], [0.7, 1.1], [-0.7, -1.1], [0.7, -1.1]] } };
let simWorst = 0; let simN = 0; let simSum = 0;
for (const segment of plan.segments) {
  if (Math.hypot(segment.points[0].x - POSE.x, segment.points[0].z - POSE.z) > 120) continue;
  const start = segment.trimStart + 6;
  const end = segment.length - segment.trimEnd - 6;
  if (!(end - start > 4)) continue;
  for (let s = start; s <= end; s += 9) {
    for (const laneFraction of [0.45, -0.45]) {
      const a = segment.points[0];
      const b = segment.points[segment.points.length - 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const tx = (b.x - a.x) / len; const tz = (b.z - a.z) / len;
      const t = Math.max(0, Math.min(1, s / segment.length));
      const u = laneFraction * segment.half;
      const cx = a.x + (b.x - a.x) * t + -tz * u;
      const cz = a.z + (b.z - a.z) * t + tx * u;
      const yaw = Math.atan2(tx, tz);
      const y = TrafficSim.prototype.vehicleGroundY.call(stub, cx, cz, yaw, rig);
      const drawn = probe(road, cx, cz);
      if (drawn === null || !Number.isFinite(y)) continue;
      const error = y - drawn;
      simN += 1; simSum += Math.abs(error);
      if (Math.abs(error) > Math.abs(simWorst)) simWorst = error;
    }
  }
}
console.log(`  sim datum: ${simN} samples, hits ${stub.groundingDiagnostics.vehicleHits},`
  + ` misses ${stub.groundingDiagnostics.vehicleMisses}`);
assert(simN > 100, `enough simulation-datum samples (${simN})`);
// The simulation's own datum resolves an overlap by nearest centreline, not by
// which asphalt is on top: where two ribbons lap, it can sit on the lower one.
// The DRAWN vehicle does not inherit that - `updateVehiclePresentation` grounds
// the mirrored body on the topmost surface - so this bound covers the
// simulation's collision/camera datum, not what a reviewer sees.
const SIM_DATUM_TOLERANCE = 0.10;
assert(Math.abs(simWorst) <= SIM_DATUM_TOLERANCE,
  `worst simulation datum error ${(simWorst * 1000).toFixed(1)} mm <= ${SIM_DATUM_TOLERANCE * 1000} mm`);
assert(simSum / Math.max(1, simN) <= CONTACT_TOLERANCE,
  `mean simulation datum error ${(simSum / Math.max(1, simN) * 1000).toFixed(2)} mm <= ${CONTACT_TOLERANCE * 1000} mm`);
assert(stub.groundingDiagnostics.vehicleHits > simN * 0.8,
  `the simulation datum came from the street index, not the fallback plane `
  + `(${stub.groundingDiagnostics.vehicleHits} hits / ${stub.groundingDiagnostics.vehicleMisses} misses)`);

// ---------------------------------------------------------------------------
section('5. moving vehicles carry real headlights at night, inside a hard cap');
// ---------------------------------------------------------------------------
//
// Round 4's night card had emissive lamp quads and no light: the tail lamps
// glowed and nothing landed on the road. These are actual spot lights, so the
// budget matters as much as the effect.
{
  const scene = new THREE.Group();
  const lightRoot = new THREE.Group();
  scene.add(lightRoot);
  lightRoot.add(buildStreetSurfaceV2(city, SURFACE_OVERRIDES).group);
  lightRoot.updateMatrixWorld(true);
  const container = new THREE.Group();
  container.name = 'logical-vehicles-and-batched-presentation';
  scene.add(container);
  // Twenty vehicles crowded into the near ring, in the lanes of the street the
  // hero cards are posed on: far more than the pool can light.
  const lane = plan.segments
    .filter((seg) => seg.length - seg.trimStart - seg.trimEnd > 30)
    .map((seg) => ({ seg, d: Math.hypot(seg.points[0].x - POSE.x, seg.points[0].z - POSE.z) }))
    .sort((a, b) => a.d - b.d)[0].seg;
  const laneA = lane.points[0];
  const laneB = lane.points[lane.points.length - 1];
  const laneLen = Math.hypot(laneB.x - laneA.x, laneB.z - laneA.z) || 1;
  const laneTx = (laneB.x - laneA.x) / laneLen;
  const laneTz = (laneB.z - laneA.z) / laneLen;
  const cars = [];
  for (let i = 0; i < 20; i += 1) {
    const car = new THREE.Group();
    car.userData.rig = { kind: ['sedan', 'taxi', 'truck', 'bus'][i % 4], dims: {}, spin: 0 };
    const along = lane.trimStart + 4 + (i % 10) * 3;
    const across = (i < 10 ? 1 : -1) * lane.half * 0.45;
    const x = laneA.x + laneTx * along - laneTz * across;
    const z = laneA.z + laneTz * along + laneTx * across;
    car.position.set(x, datumAt(x, z), z);
    car.rotation.y = Math.atan2(laneTx, laneTz);
    container.add(car);
    cars.push(car);
  }
  const camera = { position: { x: cars[0].position.x, y: 2.4, z: cars[0].position.z } };
  const makeCtx = (hour) => ({
    city, root: lightRoot, scene, camera, hour, weather: 'clear',
    heightAt, seed: city.meta.seed, streetSurfaceOptions: surface.options,
    focus: { x: cars[0].position.x, z: cars[0].position.z },
    traffic: { cars, vehicleGroup: container, group: container },
  });
  const dayCtx = makeCtx(12);
  const lit = buildVehiclePresentation(dayCtx);
  const state = lit.state;
  const countLights = () => {
    let total = 0; let on = 0; let shadowed = 0;
    state.group.traverse((node) => {
      if (!node.isSpotLight) return;
      total += 1;
      if (node.visible && node.intensity > 0) on += 1;
      if (node.castShadow) shadowed += 1;
    });
    return { total, on, shadowed };
  };

  for (let frame = 0; frame < 3; frame += 1) updateVehiclePresentation(state, dayCtx, 1 / 60);
  const day = countLights();
  assert(day.on === 0, `no vehicle light burns by day (${day.on} on, ${day.total} pooled)`);

  const nightCtx = makeCtx(22);
  for (let frame = 0; frame < 3; frame += 1) updateVehiclePresentation(state, nightCtx, 1 / 60);
  const night = countLights();
  console.log(`  night: ${night.on}/${night.total} lights on,`
    + ` ${state.diagnostics.lights.litVehicles} vehicles lit,`
    + ` ${state.diagnostics.traffic.mirrored} mirrored`);
  assert(night.on > 0, `vehicles light the road at night (${night.on} spot lights on)`);
  assert(night.on <= VEHICLE_LIGHTS.maxLights,
    `the light pool holds its cap (${night.on} <= ${VEHICLE_LIGHTS.maxLights})`);
  assert(night.total <= VEHICLE_LIGHTS.maxLights,
    `no more lights are allocated than the cap (${night.total} <= ${VEHICLE_LIGHTS.maxLights})`);
  assert(night.on === Math.min(VEHICLE_LIGHTS.maxLights, cars.length * VEHICLE_LIGHTS.perVehicle),
    `every slot in the pool is used when the block is full of traffic (${night.on})`);
  assert(night.shadowed === 0, `no vehicle light casts a shadow map (${night.shadowed})`);
  assert(VEHICLE_BUDGET.maxLights === VEHICLE_LIGHTS.maxLights,
    `the light cap is declared in the pass budget (${VEHICLE_BUDGET.maxLights})`);
  assert(state.diagnostics.lights.withinBudget === true,
    'the pass reports its light pool inside its own stated budget');

  // Beams start at a headlamp and point at the road ahead of it, not at the sky.
  let aimedDown = 0;
  let onRoad = 0;
  state.group.traverse((node) => {
    if (!node.isSpotLight || !node.visible || !(node.intensity > 0)) return;
    const drop = node.position.y - node.target.position.y;
    if (drop > 0.2) aimedDown += 1;
    const surfaceY = probe(road, node.position.x, node.position.z);
    if (surfaceY !== null && node.position.y - surfaceY > 0.3 && node.position.y - surfaceY < 2.6) onRoad += 1;
  });
  assert(aimedDown === night.on, `every beam is aimed down at the carriageway (${aimedDown}/${night.on})`);
  assert(onRoad === night.on,
    `every beam leaves a headlamp at a plausible height above the road (${onRoad}/${night.on})`);

  // Daybreak releases the pool; the vehicles are still mirrored.
  for (let frame = 0; frame < 3; frame += 1) updateVehiclePresentation(state, dayCtx, 1 / 60);
  const back = countLights();
  assert(back.on === 0, `the pool is released when the lamps go off (${back.on} on)`);

  // Driving away releases them too - the cap is per RING, not per vehicle.
  for (const car of cars) car.position.x += 400;
  for (let frame = 0; frame < 3; frame += 1) updateVehiclePresentation(state, nightCtx, 1 / 60);
  const gone = countLights();
  assert(gone.on === 0, `vehicles outside the lit radius release their lights (${gone.on} on)`);

  disposeVehiclePresentation(state);
  let leaked = 0;
  scene.traverse((node) => { if (node.isSpotLight) leaked += 1; });
  assert(leaked === 0, `dispose removes every light from the scene (${leaked} left)`);
}

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log('\nFAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
