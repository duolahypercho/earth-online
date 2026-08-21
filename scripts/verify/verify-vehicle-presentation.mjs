// Self-check for src/render/passes/vehicle-presentation.js and src/vehicles/*
//
// Runs headless under plain node: no browser, no DOM, no canvas, no capture,
// no new dependency. Exits non-zero on the first failed assertion group.
//
//   node scripts/verify/verify-vehicle-presentation.mjs
//
// What it proves:
//   1. the module satisfies the presentation-pass registry contract, and
//      build/update/dispose survive a degenerate world: no city, no segments,
//      one-point and zero-width segments, NaN coordinates, no terrain, no
//      root, no focus, and both spellings of the street contract
//   2. every catalogued class is a real vehicle: its MEASURED bounding box
//      matches the dimensions it declares, and every declared dimension sits
//      inside a plausible range for its body class
//   3. the construction survives a close-up: separate wheels with a tyre and a
//      rim, glazing, lamp geometry, plates, and a wheel that sits in a real
//      arch rather than inside the body
//   4. wheels touch the carriageway - measured against the SAME cross-section
//      the paved ribbon was swept with - on flat ground and on a 12% grade
//   5. no parked vehicle overlaps another, none crosses the kerb line, none
//      stands in a building footprint, and the kerb offset is inside a stated
//      band
//   6. output is deterministic for a seed, varies across seeds, and carries a
//      stated minimum number of distinct appearances
//   7. lamps are emissive at night and off/dim by day, driven by the pass
//      context's hour, and wet weather changes the paint response
//   8. the traffic mirror reads the simulation and never writes to it
//   9. per-ring vehicle/triangle caps, the total triangle budget and the
//      draw-call budget hold at a stated real city size

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { validatePass } from '../../src/render/pass-registry.js';
import pass, {
  VEHICLE_PRESENTATION_ID,
  VEHICLE_PRESENTATION_VERSION,
  VEHICLE_RINGS,
  VEHICLE_BUDGET,
  TRAFFIC_MIRROR,
  KERB,
  buildVehiclePresentation,
  updateVehiclePresentation,
  disposeVehiclePresentation,
  wheelContactPoints,
  vehicleFootprint,
  quadsOverlap,
  lateralOf,
} from '../../src/render/passes/vehicle-presentation.js';
import {
  VEHICLE_SPECS,
  VEHICLE_TYPE_IDS,
  CLASS_DIMENSION_RANGE,
  CIVILIAN_PAINT,
  TRIM,
} from '../../src/vehicles/vehicle-catalogue.js';
import {
  buildVehicleGeometry,
  buildWheelGeometry,
  buildLampGeometry,
  buildPlateGeometry,
  bodySillAt,
  bodyHalfWidthAt,
  VEHICLE_LOD_CONFIG,
} from '../../src/vehicles/vehicle-geometry.js';
import {
  createVehicleMaterials,
  createMaterialAnchor,
  applyVehicleEnvironment,
  nightnessFor,
  wetnessFor,
  VEHICLE_ENV_CLASS,
} from '../../src/vehicles/vehicle-fleet.js';
import { buildStreetSurfaceData } from '../../src/world/streets/street-surface-v2.js';
import { MATERIAL_CLASSES, envMapIntensityFor } from '../../src/render/environment-ibl.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// stated tolerances
// ---------------------------------------------------------------------------

/** Measured bounding box vs declared dimensions, metres. */
const DIM_TOLERANCE = Object.freeze({
  // Bumper valance and door trim stand a few millimetres proud of the body, and
  // the near level of detail adds mirrors and roof furniture. Length and height
  // are held tight; width is checked against BOTH the body width and the
  // over-mirror width.
  length: 0.05,
  height: 0.05,
  widthUnder: 0.03,
  widthOver: 0.05,
  // The far level of detail decimates the section, so it is allowed to shrink.
  farShrink: 0.06,
});

/** Wheel contact patch vs the carriageway surface under it, metres. */
const CONTACT_TOLERANCE = 0.010;

/** Minimum distinct (class, paint, wheel finish) combinations city-wide. */
const MIN_DISTINCT_APPEARANCES = 120;

/** Stated city size the budgets are measured at. */
const CITY = Object.freeze({ center: [1435, 993], radius: 720, maxBuildings: 900 });

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

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const META = {
  generator: 'sf-builtin',
  seed: 'verify-vehicle-presentation',
  seedInt: 41,
  streetDesign: { roadLift: 0.45 },
  bounds: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
};

function segment(id, points, overrides = {}) {
  const width = overrides.width ?? 12.8;
  const walk = overrides.sidewalkW ?? 3;
  return {
    id,
    streetId: overrides.streetId ?? `street-${id}`,
    streetName: overrides.streetName ?? `Fixture ${id}`,
    highway: overrides.highway ?? 'secondary',
    lanes: overrides.lanes ?? 4,
    oneway: false,
    width,
    sidewalkW: walk,
    sidewalkLeft: walk,
    sidewalkRight: walk,
    points,
    signalId: null,
    intersectionId: null,
  };
}

/** A four-by-four grid, split at every crossing so the junctions are real. */
function gridCity() {
  const segments = [];
  const lines = [-60, 0, 60];
  const stations = [-120, -60, 0, 60, 120];
  for (const z of lines) {
    for (let i = 0; i < stations.length - 1; i += 1) {
      segments.push(segment(`h${z}-${i}`, [{ x: stations[i], z }, { x: stations[i + 1], z }], { streetId: `h${z}` }));
    }
  }
  for (const x of lines) {
    for (let i = 0; i < stations.length - 1; i += 1) {
      segments.push(segment(`v${x}-${i}`, [{ x, z: stations[i] }, { x, z: stations[i + 1] }],
        { streetId: `v${x}`, highway: 'tertiary', lanes: 2, width: 11.2, sidewalkW: 2.6 }));
    }
  }
  const buildings = [];
  for (let i = 0; i < 8; i += 1) {
    const x = -100 + i * 24;
    buildings.push({
      id: `b-${i}`,
      height: 14,
      polygon: [{ x, z: 12 }, { x: x + 18, z: 12 }, { x: x + 18, z: 44 }, { x, z: 44 }],
    });
  }
  return { meta: META, segments, intersections: [], signals: [], blocks: [], buildings };
}

function altSpellingCity() {
  return {
    meta: META,
    segments: [{
      id: 'alt-1',
      streetName: 'Market Street',
      className: 'primary',
      asphaltWidth: 16,
      sidewalkWidth: 3.4,
      points: [{ x: -70, z: 12 }, { x: 70, z: 12 }],
    }],
    blocks: [],
    signals: [],
  };
}

function makeCtx(city, overrides = {}) {
  return {
    root: overrides.root === undefined ? new THREE.Group() : overrides.root,
    scene: overrides.scene === undefined ? new THREE.Group() : overrides.scene,
    city,
    heightAt: overrides.heightAt === undefined ? () => 0 : overrides.heightAt,
    isSanFrancisco: true,
    seed: overrides.seed ?? 'verify-vehicle-presentation',
    focus: overrides.focus === undefined ? { x: 0, z: 0 } : overrides.focus,
    hour: overrides.hour ?? 11,
    weather: overrides.weather ?? 'clear',
    registerGeometry: (geometry) => geometry,
    legacyGroup: () => null,
    ...overrides,
  };
}

function signatureOf(object) {
  const parts = [];
  object?.traverse?.((node) => {
    if (!node.isInstancedMesh) return;
    let hash = 2166136261;
    const mix = (value) => {
      hash ^= Math.round(value * 1e4) & 0xffffffff;
      hash = Math.imul(hash, 16777619) >>> 0;
    };
    const array = node.instanceMatrix.array;
    for (let i = 0; i < array.length; i += 1) mix(array[i]);
    if (node.instanceColor) for (let i = 0; i < node.instanceColor.array.length; i += 1) mix(node.instanceColor.array[i]);
    parts.push(`${node.name}:${node.count}:${hash >>> 0}`);
  });
  return parts.sort().join('|');
}

function measureGeometryBox(built) {
  const box = new THREE.Box3();
  box.makeEmpty();
  const point = new THREE.Vector3();
  for (const geometry of [built.paint, built.glass, built.trim]) {
    if (!geometry) continue;
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i);
      box.expandByPoint(point);
    }
  }
  for (const wheel of built.wheels) {
    box.expandByPoint(point.set(wheel.x - wheel.width / 2, 0, wheel.z - wheel.radius));
    box.expandByPoint(point.set(wheel.x + wheel.width / 2, wheel.radius * 2, wheel.z + wheel.radius));
  }
  for (const lamp of built.lamps) {
    box.expandByPoint(point.set(lamp.x - lamp.w / 2, lamp.y - lamp.h / 2, lamp.z - lamp.d / 2));
    box.expandByPoint(point.set(lamp.x + lamp.w / 2, lamp.y + lamp.h / 2, lamp.z + lamp.d / 2));
  }
  for (const plate of built.plates) {
    box.expandByPoint(point.set(plate.x - plate.w / 2, plate.y - plate.h / 2, plate.z - 0.02));
    box.expandByPoint(point.set(plate.x + plate.w / 2, plate.y + plate.h / 2, plate.z + 0.02));
  }
  const size = box.getSize(new THREE.Vector3());
  return { box, width: size.x, height: size.y, length: size.z };
}

/** Independent piecewise-linear read of a spec's own control stations. */
function profileTopAt(spec, z) {
  const stations = spec.profile;
  if (z <= stations[0].z) return stations[0].top;
  const last = stations[stations.length - 1];
  if (z >= last.z) return last.top;
  for (let i = 0; i < stations.length - 1; i += 1) {
    const a = stations[i];
    const b = stations[i + 1];
    if (z >= a.z && z <= b.z) {
      const span = b.z - a.z;
      return a.top + (b.top - a.top) * (span > 1e-9 ? (z - a.z) / span : 0);
    }
  }
  return last.top;
}

function paintOnlyWidth(built) {
  const geometry = built.paint;
  if (!geometry) return 0;
  const position = geometry.getAttribute('position');
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return max - min;
}

// ---------------------------------------------------------------------------
section('1. registry contract');
// ---------------------------------------------------------------------------
{
  const problems = validatePass(pass);
  assert(problems.length === 0, `pass satisfies the registry contract (${problems.join('; ') || 'clean'})`);
  assert(pass.id === VEHICLE_PRESENTATION_ID && pass.id === 'vehicle-presentation', 'id is vehicle-presentation');
  assert(pass.order === 45, `order is 45, between street-furniture and street-life (${pass.order})`);
  assert(typeof VEHICLE_PRESENTATION_VERSION === 'string', `version tag ${VEHICLE_PRESENTATION_VERSION}`);
  const ctx = makeCtx(gridCity());
  const result = pass.build(ctx);
  assert(result.object === null || typeof result.object.traverse === 'function', 'build returns an Object3D or null');
  const d = result.diagnostics;
  assert(d.implemented === true, 'diagnostics report the pass as implemented');
  assert(Object.keys(d.counts).length >= 6, `diagnostics carry per-class counts (${Object.keys(d.counts).length} classes)`);
  assert(typeof d.rejections === 'object' && Object.keys(d.rejections).length > 0,
    `diagnostics carry placement rejections with reasons (${Object.keys(d.rejections).join(', ')})`);
  assert(Array.isArray(d.rings) && d.rings.length === VEHICLE_RINGS.length,
    'diagnostics carry one record per distance ring');
  assert(d.rings.every((r) => Number.isFinite(r.vehicles) && Number.isFinite(r.triangles)),
    'per-ring vehicle and triangle counts are finite');
  assert(Number.isFinite(d.uniqueAppearances) && d.uniqueAppearances > 0,
    `diagnostics carry unique appearance signatures (${d.uniqueAppearances})`);
  assert(d.grounding && Number.isFinite(d.grounding.worstContactError),
    'diagnostics carry grounding statistics');
  assert(d.totals && Number.isFinite(d.totals.triangles) && Number.isFinite(d.totals.drawCalls),
    `diagnostics carry triangle and draw-call cost (${d.totals.triangles} tri, ${d.totals.drawCalls} draws)`);
  assert(d.traffic && Number.isFinite(d.traffic.capacity), 'diagnostics carry the traffic mirror state');
  pass.update(ctx, 0.016);
  pass.dispose();
}

// ---------------------------------------------------------------------------
section('2. degenerate worlds never throw');
// ---------------------------------------------------------------------------
{
  const cases = [
    ['no ctx at all', undefined],
    ['null city', makeCtx(null)],
    ['empty city object', makeCtx({})],
    ['no segments', makeCtx({ meta: META, segments: [] })],
    ['segments is not an array', makeCtx({ meta: META, segments: 'nope' })],
    ['segment with one point', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }])] })],
    ['zero width', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }, { x: 40, z: 0 }], { width: 0 })] })],
    ['negative width', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }, { x: 40, z: 0 }], { width: -4 })] })],
    ['NaN points', makeCtx({ meta: META, segments: [segment('a', [{ x: NaN, z: 0 }, { x: 40, z: Infinity }])] })],
    ['no footway', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }, { x: 60, z: 0 }], { sidewalkW: 0 })] })],
    ['className/asphaltWidth spelling', makeCtx(altSpellingCity())],
    ['no focus', makeCtx(gridCity(), { focus: null })],
    ['NaN focus', makeCtx(gridCity(), { focus: { x: NaN, z: NaN } })],
    ['no root to read other layers from', makeCtx(gridCity(), { root: null })],
    ['no scene to mirror traffic from', makeCtx(gridCity(), { scene: null })],
    ['no heightAt', makeCtx(gridCity(), { heightAt: null })],
    ['heightAt returns NaN', makeCtx(gridCity(), { heightAt: () => NaN })],
    ['no buildings', makeCtx({ meta: META, segments: gridCity().segments, buildings: null })],
    ['building with a broken polygon', makeCtx({ meta: META, segments: gridCity().segments, buildings: [{ id: 'x', polygon: [{ x: NaN, z: 1 }] }] })],
    ['hour and weather missing', makeCtx(gridCity(), { hour: undefined, weather: undefined })],
  ];
  for (const [label, ctx] of cases) {
    let ok = true;
    let detail = '';
    try {
      const result = pass.build(ctx);
      if (result?.object) {
        result.object.traverse((node) => {
          if (!node.isInstancedMesh) return;
          for (let i = 0; i < node.count * 16; i += 1) {
            if (!Number.isFinite(node.instanceMatrix.array[i])) { ok = false; detail = 'non-finite instance matrix'; return; }
          }
        });
      }
      // Two updates so the traffic-mirror scan and the environment path both run.
      pass.update(ctx, 0.016);
      pass.update(ctx, 3.0);
      pass.dispose();
    } catch (error) {
      ok = false;
      detail = String(error?.message || error);
    }
    assert(ok, `build/update/dispose survives: ${label}${detail ? ` (${detail})` : ''}`);
  }
}

// ---------------------------------------------------------------------------
section('3. the catalogue is a set of real vehicles');
// ---------------------------------------------------------------------------
{
  assert(VEHICLE_SPECS.length >= 10, `catalogue carries at least 10 classes (${VEHICLE_SPECS.length})`);
  const classes = new Set(VEHICLE_SPECS.map((s) => s.bodyClass));
  for (const required of ['car', 'suv', 'pickup', 'van', 'truck', 'bus']) {
    assert(classes.has(required), `catalogue covers the ${required} body class`);
  }
  for (const required of ['compactHatch', 'sedan', 'wagon', 'compactSuv', 'pickup', 'deliveryVan', 'boxTruck', 'cityBus', 'taxi', 'patrolSedan']) {
    assert(VEHICLE_TYPE_IDS.includes(required), `catalogue contains ${required}`);
  }
  // Distinct silhouettes: no two classes may share length AND height AND width.
  const shapes = new Set(VEHICLE_SPECS.map((s) => `${s.length}|${s.width}|${s.height}`));
  assert(shapes.size === VEHICLE_SPECS.length, `every class has its own footprint (${shapes.size}/${VEHICLE_SPECS.length})`);

  for (const spec of VEHICLE_SPECS) {
    const range = CLASS_DIMENSION_RANGE[spec.bodyClass];
    assert(!!range, `${spec.id}: has a declared plausible range for class ${spec.bodyClass}`);
    if (!range) continue;
    for (const key of ['length', 'width', 'height', 'wheelbase']) {
      const [lo, hi] = range[key];
      assert(spec[key] >= lo && spec[key] <= hi,
        `${spec.id}: ${key} ${spec[key]} m is inside the ${spec.bodyClass} range ${lo}-${hi} m`);
    }
    // Proportions a real vehicle has to obey.
    assert(spec.wheelbase < spec.length - 0.6,
      `${spec.id}: wheelbase ${spec.wheelbase} leaves real overhangs (length ${spec.length})`);
    assert(spec.frontOverhang > 0.2 && spec.rearOverhang > 0.2,
      `${spec.id}: front/rear overhang ${spec.frontOverhang.toFixed(2)}/${spec.rearOverhang.toFixed(2)} m are positive`);
    assert(spec.trackFront < spec.width && spec.trackFront > spec.width * 0.7,
      `${spec.id}: front track ${spec.trackFront} m sits inside the body width ${spec.width} m`);
    assert(spec.wheelRadius > 0.28 && spec.wheelRadius < 0.62,
      `${spec.id}: wheel radius ${spec.wheelRadius} m is a real road wheel`);
    assert(spec.mirrorReach > 0.05 && spec.mirrorReach < 0.45,
      `${spec.id}: mirror reach ${spec.mirrorReach} m is plausible`);
  }
}

// ---------------------------------------------------------------------------
section('4. measured geometry matches the declared dimensions');
// ---------------------------------------------------------------------------
{
  for (const spec of VEHICLE_SPECS) {
    for (const config of VEHICLE_LOD_CONFIG) {
      const built = buildVehicleGeometry(spec, config.lod, TRIM);
      const measured = measureGeometryBox(built);
      const far = config.lod === 2;
      const lengthLow = spec.length - (far ? DIM_TOLERANCE.farShrink : DIM_TOLERANCE.length);
      const lengthHigh = spec.length + DIM_TOLERANCE.length;
      assert(measured.length >= lengthLow && measured.length <= lengthHigh,
        `${spec.id} lod${config.lod}: measured length ${measured.length.toFixed(3)} m matches declared ${spec.length} m`);
      const heightLow = spec.height - (far ? DIM_TOLERANCE.farShrink : DIM_TOLERANCE.height);
      const heightHigh = spec.overallHeight + DIM_TOLERANCE.height;
      assert(measured.height >= heightLow && measured.height <= heightHigh,
        `${spec.id} lod${config.lod}: measured height ${measured.height.toFixed(3)} m is within [${heightLow.toFixed(2)}, ${heightHigh.toFixed(2)}] m`);
      assert(measured.width >= spec.width - DIM_TOLERANCE.widthUnder
        && measured.width <= spec.overallWidth + DIM_TOLERANCE.widthOver,
        `${spec.id} lod${config.lod}: measured width ${measured.width.toFixed(3)} m is within [${spec.width} , ${spec.overallWidth.toFixed(2)}] m over mirrors`);
      const bodyWidth = paintOnlyWidth(built);
      assert(Math.abs(bodyWidth - spec.width) <= 0.03 || config.lod === 2,
        `${spec.id} lod${config.lod}: painted body width ${bodyWidth.toFixed(3)} m equals the declared body width ${spec.width} m`);
      // The origin must be the tyre contact patch: nothing below y = 0.
      assert(measured.box.min.y >= -1e-3,
        `${spec.id} lod${config.lod}: nothing hangs below the contact patch (min y ${measured.box.min.y.toFixed(4)})`);
      for (const geometry of [built.paint, built.glass, built.trim]) {
        if (!geometry) continue;
        const position = geometry.getAttribute('position');
        let bad = 0;
        for (let i = 0; i < position.array.length; i += 1) if (!Number.isFinite(position.array[i])) bad += 1;
        assert(bad === 0, `${spec.id} lod${config.lod} ${geometry.name}: no NaN/Inf vertices`);
        assert(geometry.getAttribute('color') !== undefined,
          `${spec.id} lod${config.lod} ${geometry.name}: carries baked vertex colour`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
section('5. construction survives a three-metre close-up');
// ---------------------------------------------------------------------------
{
  const wheelSet = buildWheelGeometry(0, TRIM);
  assert(!!wheelSet.tyre && !!wheelSet.rimLeft && !!wheelSet.rimRight,
    'a wheel is a tyre plus a rim, and the rim is built for both sides');
  const tyreTri = wheelSet.tyre.getIndex().count / 3;
  const rimTri = wheelSet.rimRight.getIndex().count / 3;
  assert(tyreTri >= 60 && rimTri >= 40, `tyre ${tyreTri} tri and rim ${rimTri} tri resolve as round at 3 m`);
  assert(!!buildLampGeometry(0xffffff), 'lamps are real lens geometry, not a decal');
  assert(!!buildPlateGeometry(), 'a licence plate is real geometry');

  for (const spec of VEHICLE_SPECS) {
    const built = buildVehicleGeometry(spec, 0, TRIM);
    const expectedWheels = spec.dualRear ? 6 : 4;
    assert(built.wheels.length === expectedWheels,
      `${spec.id}: ${built.wheels.length} separate wheels (${spec.dualRear ? 'dual rear axle' : 'single rear axle'})`);
    assert(built.wheels.some((w) => w.steer) && built.wheels.some((w) => !w.steer),
      `${spec.id}: the front wheels steer and the rear wheels do not`);
    assert(!!built.glass, `${spec.id}: carries separate glazing geometry`);
    assert(!!built.trim, `${spec.id}: carries separate chrome/dark trim geometry`);
    const kinds = new Set(built.lamps.map((l) => l.kind));
    for (const kind of ['head', 'tail', 'brake', 'indicator']) {
      assert(kinds.has(kind), `${spec.id}: has ${kind} lamps`);
    }
    assert(built.plates.length >= 1, `${spec.id}: carries at least a rear licence plate`);
    assert(built.triangles >= 500, `${spec.id}: near body is ${built.triangles} triangles, not a box`);

    // No wheel is inside the body: the arch crown clears the tyre, and the tyre
    // sits inside the body width.
    for (const wheel of built.wheels) {
      const sill = bodySillAt(spec, wheel.z);
      assert(sill >= wheel.radius * 2 - 1e-6,
        `${spec.id}: wheel arch crown ${sill.toFixed(3)} m clears the top of the ${(wheel.radius * 2).toFixed(2)} m tyre at z=${wheel.z.toFixed(2)}`);
      assert(Math.abs(wheel.x) + wheel.width / 2 <= spec.width / 2 + 1e-6,
        `${spec.id}: wheel outer face ${(Math.abs(wheel.x) + wheel.width / 2).toFixed(3)} m is inside the body half-width ${(spec.width / 2).toFixed(3)} m`);
    }
    // A windscreen has to be raked, not vertical.
    if (spec.glazing.windscreen) {
      const cowl = spec.roof[spec.roof.length - 1];
      const crown = spec.roof.reduce((best, s) => (s.top > best.top ? s : best), spec.roof[0]);
      const dz = Math.abs(cowl.z - crown.z);
      const dy = Math.abs(crown.top - cowl.top);
      const rakeDeg = (Math.atan2(dz, Math.max(1e-3, dy)) * 180) / Math.PI;
      assert(rakeDeg > 18 && rakeDeg < 80,
        `${spec.id}: windscreen rake ${rakeDeg.toFixed(0)} deg from vertical is a real screen`);
    }
    // Section width falls away from the centre: the flank is not a flat slab.
    const midZ = (spec.frontAxleZ + spec.rearAxleZ) / 2;
    const sectionTop = profileTopAt(spec, midZ);
    const wide = bodyHalfWidthAt(spec, midZ, (bodySillAt(spec, midZ) + sectionTop) / 2);
    const narrow = bodyHalfWidthAt(spec, midZ, sectionTop - 0.08);
    assert(narrow < wide - 0.005,
      `${spec.id}: the body section tucks in toward the shoulder (${wide.toFixed(3)} -> ${narrow.toFixed(3)} m)`);
  }
}

// ---------------------------------------------------------------------------
section('6. wheels touch the carriageway on flat ground and on a grade');
// ---------------------------------------------------------------------------
/**
 * The DRAWN carriageway, as triangles, indexed for point lookup.
 *
 * ROUND 5 ADJUDICATION - READ THIS BEFORE SIMPLIFYING IT BACK TO A FORMULA.
 *
 * This audit used to compare each wheel against
 * `carriagewaySurfaceY(roadLift + heightAt(wheelX, wheelZ), ...)`, i.e. the
 * terrain sampled UNDER THE WHEEL plus the cross-section. That is not the
 * surface the renderer draws. `street-surface-v2.emitSegment` takes ONE datum
 * per centreline station - `datums = stations.map((st) => ctx.datum(st.x, st.z))`
 * - and sweeps the whole cross-section from it; it never samples the terrain at
 * a lateral offset. Wherever the terrain cross-falls, terrain-under-the-wheel
 * and the drawn asphalt are different surfaces, and they differ by the terrain
 * cross-grade times the wheel's lateral offset - 0.84 m on the 12% fixture
 * below.
 *
 * Worse, the old expression was the same expression the placement code used, so
 * it could only ever prove that the placement agreed with its own model. It
 * reported 0.0019 m worst error on the round-4 build.
 *
 * The expectation is therefore taken from the GEOMETRY: the street module is
 * asked for the same surface data the renderer builds, and the height of the
 * asphalt under a wheel is read out of the triangle that covers it. Nothing
 * here re-derives a cross-section, so the audit cannot agree with the placement
 * by construction.
 */
function drawnCarriageway(city, options, cell = 8) {
  const surface = buildStreetSurfaceData(city, { ...options });
  const layer = surface.layers.carriageway;
  const grid = new Map();
  const tris = [];
  const pos = layer.positions;
  const idx = layer.indices;
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
    for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
      for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
        const key = `${gx}:${gz}`;
        let list = grid.get(key);
        if (!list) { list = []; grid.set(key, list); }
        list.push(ti);
      }
    }
  }
  /** Every drawn asphalt height at a world point - two where ribbons lap. */
  return function heightsAt(x, z) {
    const list = grid.get(`${Math.floor(x / cell)}:${Math.floor(z / cell)}`);
    if (!list) return [];
    const out = [];
    for (const ti of list) {
      const t = tris[ti];
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
  };
}

function contactAudit(built, city) {
  const heightsAt = drawnCarriageway(city, built.plan.options);
  let worst = 0;
  let worstFloat = 0;
  let worstAt = null;
  let sum = 0;
  let n = 0;
  let offMesh = 0;
  for (const vehicle of built.vehicles) {
    for (const contact of wheelContactPoints(vehicle.spec, vehicle)) {
      const heights = heightsAt(contact.x, contact.z);
      if (!heights.length) { offMesh += 1; continue; }
      // Where two ribbons lap there are two asphalt surfaces under one point. A
      // wheel is grounded when it rests on ONE of them, so the error is the
      // distance to the NEAREST; `float` is how far it stands above the
      // HIGHEST, which is the gap a camera sees.
      let error = Infinity;
      let top = -Infinity;
      for (const h of heights) {
        const d = Math.abs(contact.y - h);
        if (d < error) error = d;
        if (h > top) top = h;
      }
      if (!Number.isFinite(error)) return { worst: Infinity, mean: Infinity, samples: n, offMesh, worstFloat: Infinity, worstAt };
      sum += error;
      n += 1;
      if (error > worst) {
        worst = error;
        worstAt = `${vehicle.typeId} on ${vehicle.segmentId} at (${contact.x.toFixed(2)}, ${contact.z.toFixed(2)}):`
          + ` wheel ${contact.y.toFixed(3)} m, asphalt ${top.toFixed(3)} m`;
      }
      if (contact.y - top > worstFloat) worstFloat = contact.y - top;
    }
  }
  return { worst, mean: n ? sum / n : 0, samples: n, offMesh, worstFloat, worstAt };
}

{
  const flat = buildVehiclePresentation(makeCtx(gridCity(), { heightAt: () => 0 }));
  const flatAudit = contactAudit(flat, gridCity());
  assert(flatAudit.samples > 200,
    `flat ground: ${flatAudit.samples} wheel contacts measured against the drawn asphalt (${flatAudit.offMesh} off the mesh)`);
  assert(flatAudit.offMesh === 0, `flat ground: every wheel is over drawn asphalt (${flatAudit.offMesh} are not)`);
  assert(flatAudit.worst <= CONTACT_TOLERANCE,
    `flat ground: worst wheel-to-drawn-asphalt error ${(flatAudit.worst * 1000).toFixed(2)} mm <= ${CONTACT_TOLERANCE * 1000} mm`
    + ` (worst float ${(flatAudit.worstFloat * 1000).toFixed(2)} mm)${flatAudit.worstAt ? ` - ${flatAudit.worstAt}` : ''}`);

  // A 12% grade with cross-fall and curvature - steeper than any real street.
  const slopeCtx = makeCtx(gridCity(), { heightAt: (x, z) => x * 0.12 + z * 0.05 + Math.sin(x * 0.02) * 2 });
  const sloped = buildVehiclePresentation(slopeCtx);
  const slopeAudit = contactAudit(sloped, gridCity());
  assert(slopeAudit.samples > 200,
    `12% grade: ${slopeAudit.samples} wheel contacts measured against the drawn asphalt (${slopeAudit.offMesh} off the mesh)`);
  assert(slopeAudit.offMesh === 0, `12% grade: every wheel is over drawn asphalt (${slopeAudit.offMesh} are not)`);
  assert(slopeAudit.worst <= CONTACT_TOLERANCE,
    `12% grade: worst wheel-to-drawn-asphalt error ${(slopeAudit.worst * 1000).toFixed(2)} mm <= ${CONTACT_TOLERANCE * 1000} mm`
    + ` (worst float ${(slopeAudit.worstFloat * 1000).toFixed(2)} mm)${slopeAudit.worstAt ? ` - ${slopeAudit.worstAt}` : ''}`);
  const pitched = sloped.vehicles.filter((v) => Math.abs(v.pitch) > 0.02).length;
  assert(pitched > sloped.vehicles.length * 0.4,
    `12% grade: ${pitched}/${sloped.vehicles.length} vehicles are pitched onto the road plane, not left level`);
  assert(flat.vehicles.every((v) => Math.abs(v.pitch) < 0.02 && Math.abs(v.roll) < 0.05),
    'flat ground: no vehicle is spuriously pitched');

  // Grounding is against the carriageway datum, never bare terrain.
  const roadLift = flat.plan.options.roadLift;
  assert(roadLift > 0.1, `the carriageway datum is ${roadLift} m above terrain, and is used`);
  assert(flat.vehicles.every((v) => v.y > roadLift - 0.12),
    'no vehicle is grounded on bare terrain below the carriageway datum');
  const ctxOptions = makeCtx(gridCity(), { streetSurfaceOptions: { roadLift: 1.75, heightAt: () => 0 } });
  const lifted = buildVehiclePresentation(ctxOptions);
  assert(lifted.diagnostics.surface.source === 'ctx.streetSurfaceOptions',
    'the pass reads the carriageway options the renderer actually built with');
  assert(lifted.vehicles.every((v) => v.y > 1.6),
    `a different roadLift moves every vehicle with it (min y ${Math.min(...lifted.vehicles.map((v) => v.y)).toFixed(3)})`);
  disposeVehiclePresentation(flat.state);
  disposeVehiclePresentation(sloped.state);
  disposeVehiclePresentation(lifted.state);
}

// ---------------------------------------------------------------------------
section('7. nothing overlaps, nothing crosses the kerb');
// ---------------------------------------------------------------------------
{
  const built = buildVehiclePresentation(makeCtx(gridCity(), { heightAt: (x, z) => Math.sin(x * 0.01) * 3 + z * 0.02 }));
  const vehicles = built.vehicles;
  assert(vehicles.length > 60, `a grid city parks ${vehicles.length} vehicles`);

  let overlaps = 0;
  for (let i = 0; i < vehicles.length; i += 1) {
    for (let j = i + 1; j < vehicles.length; j += 1) {
      const a = vehicles[i];
      const b = vehicles[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) > (a.spec.length + b.spec.length) / 2 + 1) continue;
      if (quadsOverlap(
        vehicleFootprint(a.spec, a.x, a.z, a.yaw),
        vehicleFootprint(b.spec, b.x, b.z, b.yaw),
      )) overlaps += 1;
    }
  }
  assert(overlaps === 0, `no two parked vehicles overlap (${overlaps})`);

  let overKerb = 0;
  let insideBuilding = 0;
  let outOfBand = 0;
  let minGap = Infinity;
  let maxGap = -Infinity;
  const city = gridCity();
  for (const vehicle of vehicles) {
    const segment = built.plan.segmentById.get(vehicle.segmentId);
    if (!segment) { outOfBand += 1; continue; }
    // Every corner of the footprint must stay inside the carriageway.
    for (const corner of vehicleFootprint(vehicle.spec, vehicle.x, vehicle.z, vehicle.yaw)) {
      if (Math.abs(lateralOf(segment, corner.x, corner.z)) > segment.half + 1e-3) overKerb += 1;
    }
    const gap = segment.half - (Math.abs(vehicle.u) + vehicle.spec.width / 2);
    if (gap < minGap) minGap = gap;
    if (gap > maxGap) maxGap = gap;
    if (gap < KERB.minGap - 1e-6 || gap > KERB.maxGap + 1e-6) outOfBand += 1;
    for (const building of city.buildings) {
      const polygon = building.polygon;
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const a = polygon[i];
        const b = polygon[j];
        if ((a.z > vehicle.z) !== (b.z > vehicle.z)
          && vehicle.x < ((b.x - a.x) * (vehicle.z - a.z)) / ((b.z - a.z) || 1e-12) + a.x) inside = !inside;
      }
      if (inside) insideBuilding += 1;
    }
  }
  assert(overKerb === 0, `no parked vehicle crosses the kerb line (${overKerb} corners outside)`);
  assert(insideBuilding === 0, `no parked vehicle stands in a building footprint (${insideBuilding})`);
  assert(outOfBand === 0,
    `every kerb offset is inside the stated ${KERB.minGap}-${KERB.maxGap} m band (measured ${minGap.toFixed(3)}-${maxGap.toFixed(3)} m, ${outOfBand} outside)`);

  // A vehicle parked on the +n side must face the opposite way to one on -n.
  const plus = vehicles.filter((v) => v.side > 0);
  const minus = vehicles.filter((v) => v.side < 0);
  assert(plus.length > 0 && minus.length > 0, `both kerbs are used on wide streets (${plus.length}/${minus.length})`);

  // A running lane always survives.
  let blocked = 0;
  for (const vehicle of vehicles) {
    const segment = built.plan.segmentById.get(vehicle.segmentId);
    const inner = Math.abs(vehicle.u) - vehicle.spec.width / 2;
    const both = segment.half >= KERB.bothSidesHalfWidth;
    const running = both ? inner * 2 : inner + segment.half;
    if (running < KERB.minRunningLane - 1e-6) blocked += 1;
  }
  assert(blocked === 0, `every parked street keeps a ${KERB.minRunningLane} m running lane (${blocked} blocked)`);
  disposeVehiclePresentation(built.state);
}

// ---------------------------------------------------------------------------
section('8. deterministic per seed, varied across seeds');
// ---------------------------------------------------------------------------
{
  const a = buildVehiclePresentation(makeCtx(gridCity(), { seed: 'seed-a' }));
  const b = buildVehiclePresentation(makeCtx(gridCity(), { seed: 'seed-a' }));
  const c = buildVehiclePresentation(makeCtx(gridCity(), { seed: 'seed-b' }));
  const sa = signatureOf(a.object);
  assert(sa.length > 0 && sa === signatureOf(b.object), 'two builds of one city at one seed are bit-identical');
  assert(sa !== signatureOf(c.object), 'a different seed produces different vehicles');
  assert(a.vehicles.length === b.vehicles.length, `vehicle count is stable across builds (${a.vehicles.length})`);

  const appearances = new Set(a.vehicles.map((v) => `${v.typeId}|${v.paintHex}|${v.rimHex}`));
  assert(appearances.size >= 40, `a grid city carries ${appearances.size} distinct appearances`);
  const types = new Set(a.vehicles.map((v) => v.typeId));
  assert(types.size >= 7, `a grid city carries ${types.size} distinct vehicle classes`);

  // The paint distribution has to look like a street, not a paint chart.
  const achromatic = new Set(CIVILIAN_PAINT
    .filter((p) => /white|black|grey|silver|graphite|slate/.test(p.name))
    .map((p) => p.hex));
  const share = a.vehicles.filter((v) => achromatic.has(v.paintHex)).length / a.vehicles.length;
  assert(share > 0.45 && share < 0.92,
    `${(share * 100).toFixed(0)}% of the parked population is white/black/grey/silver, like a real street`);

  const source = gridCity();
  const before = JSON.stringify(source);
  buildVehiclePresentation(makeCtx(source));
  assert(JSON.stringify(source) === before, 'the source city is never mutated');
  disposeVehiclePresentation(a.state);
  disposeVehiclePresentation(b.state);
  disposeVehiclePresentation(c.state);
}

// ---------------------------------------------------------------------------
section('9. night lamps and wet weather follow the runtime clock');
// ---------------------------------------------------------------------------
{
  assert(nightnessFor(12) === 0 && nightnessFor(22) === 1 && nightnessFor(3) === 1,
    'nightness is 0 at midday and 1 at 22:00 and 03:00');
  assert(nightnessFor(18.5) > 0 && nightnessFor(18.5) < 1, 'nightness ramps through dusk');
  assert(wetnessFor('clear') === 0 && wetnessFor('rain') === 1, 'wetness follows the weather the context reports');

  const materials = createVehicleMaterials();
  applyVehicleEnvironment(materials, { hour: 12, weather: 'clear' });
  const dayHead = materials.lamps.head.emissiveIntensity;
  const dayTail = materials.lamps.tail.emissiveIntensity;
  const dayPaintRoughness = materials.paint.roughness;
  const dayPlate = materials.plate.emissiveIntensity;
  applyVehicleEnvironment(materials, { hour: 22, weather: 'clear' });
  const nightHead = materials.lamps.head.emissiveIntensity;
  const nightTail = materials.lamps.tail.emissiveIntensity;
  const nightPlate = materials.plate.emissiveIntensity;
  assert(dayHead === 0 && dayTail === 0, `head and tail lamps are off by day (${dayHead}, ${dayTail})`);
  assert(nightHead > 1 && nightTail > 0, `head and tail lamps are emissive at night (${nightHead}, ${nightTail})`);
  assert(nightPlate > dayPlate, `the plate is retro-reflective at night (${dayPlate} -> ${nightPlate})`);
  assert(materials.lamps.brake.emissiveIntensity > materials.lamps.tail.emissiveIntensity,
    'a brake lamp is brighter than the tail lamp it sits beside');
  applyVehicleEnvironment(materials, { hour: 12, weather: 'drizzle' });
  // Wetness is the RENDERER's grader's job now, because it owns roughness and
  // colour for every classified material. This pass must not touch either, or
  // it poisons the `dryRoughness` the grader caches on first sight.
  assert(materials.paint.roughness === dayPaintRoughness,
    `the pass never writes roughness itself (${dayPaintRoughness} unchanged)`);
  assert(materials.tyre.roughness === 0.93, 'the pass never writes tyre roughness itself');
  assert(materials.contact.opacity < 0.42, 'the unlit contact patch, which no grader can reach, does follow the weather');
  assert(materials.glass !== materials.paint && materials.trim !== materials.paint
    && materials.tyre !== materials.paint && materials.rim !== materials.paint,
    'paint, glass, trim, rubber and rim are separate materials with separate responses');
  assert(materials.paint.clearcoat > 0.5, `automotive paint is a clear coat (${materials.paint.clearcoat})`);

  // Driven from the pass context, not from a clock this pass owns.
  const dayBuild = buildVehiclePresentation(makeCtx(gridCity(), { hour: 11 }));
  assert(dayBuild.materials.lamps.head.emissiveIntensity === 0, 'a pass built at 11:00 has its lamps off');
  disposeVehiclePresentation(dayBuild.state);
  const nightCtx = makeCtx(gridCity(), { hour: 21.5, weather: 'rain' });
  const nightBuild = buildVehiclePresentation(nightCtx);
  assert(nightBuild.materials.lamps.head.emissiveIntensity > 1, 'a pass built at 21:30 has its lamps lit');
  assert(nightBuild.diagnostics.night.nightness === 1 && nightBuild.diagnostics.night.wetness === 1,
    'diagnostics report the night and wet state the context asked for');
  // Moving the context clock moves the lamps.
  nightCtx.hour = 12;
  nightCtx.weather = 'clear';
  updateVehiclePresentation(nightBuild.state, nightCtx, 0.016);
  assert(nightBuild.materials.lamps.head.emissiveIntensity === 0,
    'moving the runtime clock to midday switches the lamps off again');
  disposeVehiclePresentation(nightBuild.state);
}

// ---------------------------------------------------------------------------
section('9b. every material is eligible for the environment map');
// ---------------------------------------------------------------------------
//
// This is the check that would have caught round 2. The renderer's
// `applyEnvironmentGrading` only hands the prefiltered environment texture to
// materials that declare `userData.envClass`, and the shipped light rig
// delivers most of its fill through that texture (measured on the 11:00 card:
// sun 6.48, hemi 0.27, ambient 0.06, environmentIntensity 0.8). An undeclared
// vehicle material is lit by almost nothing in daylight and by nothing after
// dark - the round-2 night card measured rgb (0,0,0) across a whole vehicle.
{
  const materials = createVehicleMaterials();
  const classified = [];
  for (const material of materials.all) {
    if (material === materials.contact) continue;
    const envClass = material.userData?.envClass;
    assert(typeof envClass === 'string' && MATERIAL_CLASSES.includes(envClass),
      `${material.name} declares a known environment class (${envClass || 'NONE'})`);
    assert('envMapIntensity' in material,
      `${material.name} carries envMapIntensity, which the grader requires`);
    if (envClass) classified.push([material.name, envClass]);
  }
  assert(classified.length >= 10, `every vehicle material is classified (${classified.length})`);
  assert(materials.contact.userData?.envClass === undefined,
    'the unlit contact patch is deliberately unclassified: an envMap would break it');
  for (const [, envClass] of classified) {
    let ok = true;
    try { envMapIntensityFor(envClass, { hour: 21.5, weather: 'clear' }); } catch { ok = false; }
    assert(ok, `the environment table accepts ${envClass} at night`);
  }
  assert(VEHICLE_ENV_CLASS.paint === 'painted-metal' && VEHICLE_ENV_CLASS.glass === 'facade-glass',
    'paint grades as painted metal and glass as glass');
  const nightPaint = envMapIntensityFor('painted-metal', { hour: 21.5, weather: 'clear' });
  assert(nightPaint > 0.4,
    `a classified vehicle still receives environment light after dark (${nightPaint})`);

  // The anchor is what guarantees the grader SEES those materials: it caches
  // its buckets from one traverse, and the traffic fleet is built later.
  const anchor = createMaterialAnchor(materials);
  const anchorClasses = new Set(anchor.material.map((m) => m.userData?.envClass));
  assert(anchor.material.length >= 10 && anchorClasses.size >= 3,
    `the material anchor exposes every class to one traverse (${anchor.material.length} materials, ${anchorClasses.size} classes)`);

  // A built world must expose them from the root the grader walks.
  const built = buildVehiclePresentation(makeCtx(gridCity()));
  const seen = new Set();
  built.object.traverse((node) => {
    const list = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const material of list) {
      if (material?.userData?.envClass) seen.add(material.userData.envClass);
    }
  });
  assert(seen.size >= 3 && seen.has('painted-metal') && seen.has('facade-glass'),
    `a built world exposes ${seen.size} environment classes on the city root`);
  disposeVehiclePresentation(built.state);
}

// ---------------------------------------------------------------------------
section('9c. glazing is visible from outside the bodywork');
// ---------------------------------------------------------------------------
//
// The other round-2 defect. Panes were inset 14-16 mm INTO an opaque shell on
// the reasoning that a window is a recess, so the whole catalogue rendered with
// no glass at all. A corner being proud is not enough either: a flat quad
// between two proud corners still sank 23 mm into a curved greenhouse.
{
  const raycaster = new THREE.Raycaster();
  raycaster.far = 40;
  for (const spec of VEHICLE_SPECS) {
    const built = buildVehicleGeometry(spec, 0, TRIM);
    const paintMesh = new THREE.Mesh(built.paint, new THREE.MeshBasicMaterial());
    const glassMesh = new THREE.Mesh(built.glass, new THREE.MeshBasicMaterial());
    paintMesh.updateMatrixWorld(true);
    glassMesh.updateMatrixWorld(true);
    const position = built.glass.getAttribute('position');
    const index = built.glass.getIndex();
    const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
    const centroid = new THREE.Vector3(); const normal = new THREE.Vector3();
    const e0 = new THREE.Vector3(); const e1 = new THREE.Vector3();
    const from = new THREE.Vector3(); const dir = new THREE.Vector3();
    const axis = new THREE.Vector3(); const away = new THREE.Vector3();
    let triangles = 0;
    let visible = 0;
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(position, index.getX(i));
      b.fromBufferAttribute(position, index.getX(i + 1));
      c.fromBufferAttribute(position, index.getX(i + 2));
      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      e0.subVectors(b, a); e1.subVectors(c, a);
      normal.crossVectors(e0, e1).normalize();
      axis.set(0, spec.height * 0.45, centroid.z);
      if (normal.dot(away.subVectors(centroid, axis)) < 0) normal.negate();
      from.copy(centroid).addScaledVector(normal, 6);
      dir.copy(normal).negate();
      raycaster.set(from, dir);
      const hits = raycaster.intersectObjects([paintMesh, glassMesh], false);
      triangles += 1;
      if (hits.length && hits[0].object === glassMesh) visible += 1;
    }
    const share = triangles ? visible / triangles : 0;
    assert(triangles >= 12, `${spec.id}: carries real glazing (${triangles} glass triangles)`);
    assert(share >= 0.95,
      `${spec.id}: ${(share * 100).toFixed(0)}% of its glass is in front of the bodywork, not buried in it (${visible}/${triangles})`);
  }
}

// ---------------------------------------------------------------------------
section('10. the traffic mirror reads the simulation and never writes it');
// ---------------------------------------------------------------------------
{
  const scene = new THREE.Group();
  const root = new THREE.Group();
  scene.add(root);
  const container = new THREE.Group();
  container.name = 'logical-vehicles-and-batched-presentation';
  const placeholder = new THREE.Group();
  placeholder.name = 'vehicle-presentation-batch';
  container.add(placeholder);
  const cars = [];
  for (let i = 0; i < 24; i += 1) {
    const car = new THREE.Group();
    car.userData.rig = { kind: ['sedan', 'taxi', 'truck', 'bus'][i % 4], dims: {}, spin: 0 };
    car.position.set(i * 4 - 40, 0.45, 6);
    car.rotation.y = 0.2;
    container.add(car);
    cars.push(car);
  }
  scene.add(container);
  const ctx = makeCtx(gridCity(), { root, scene, hour: 22 });
  const built = buildVehiclePresentation(ctx);
  const state = built.state;

  // Drive the simulation forward the way the traffic sim would, and snapshot
  // around each update: the pass may read those transforms, never write them.
  let untouched = true;
  const snapshot = () => cars.map((car) => JSON.stringify({
    p: car.position.toArray(), r: car.rotation.toArray().slice(0, 3), u: car.userData.rig,
  })).join('|');
  for (let frame = 0; frame < 6; frame += 1) {
    for (const car of cars) {
      car.position.z += 0.35;
      car.rotation.y += 0.03;
    }
    const before = snapshot();
    updateVehiclePresentation(state, ctx, 1 / 60);
    if (snapshot() !== before) untouched = false;
  }
  assert(untouched, 'the pass never writes a simulation transform, rig or identity');
  assert(state.diagnostics.traffic.mirrored === cars.length,
    `every simulated vehicle is mirrored (${state.diagnostics.traffic.mirrored}/${cars.length})`);
  assert(state.diagnostics.traffic.bound === true, 'the mirror binds to the simulation it found');
  assert(placeholder.visible === false, 'the simulation placeholder batch is hidden while mirrored');
  assert(state.diagnostics.traffic.triangles <= TRAFFIC_MIRROR.maxTriangles,
    `mirrored traffic holds its triangle budget (${state.diagnostics.traffic.triangles} <= ${TRAFFIC_MIRROR.maxTriangles})`);

  // Steering and spin are derived from the mirrored motion.
  let steered = 0;
  let spun = 0;
  for (const record of state.mirrorState.values()) {
    if (Math.abs(record.yawRate) > 1e-3) steered += 1;
    if (Math.abs(record.spin) > 1e-3) spun += 1;
  }
  assert(steered === cars.length, `steering angle is derived for every mirrored vehicle (${steered})`);
  assert(spun === cars.length, `wheel spin is derived for every mirrored vehicle (${spun})`);

  disposeVehiclePresentation(state);
  assert(placeholder.visible === true, 'dispose restores the simulation placeholder batch');
}

// ---------------------------------------------------------------------------
section('11. budgets at a stated real city size');
// ---------------------------------------------------------------------------
{
  for (let i = 1; i < VEHICLE_RINGS.length; i += 1) {
    assert(VEHICLE_RINGS[i].radius > VEHICLE_RINGS[i - 1].radius,
      `ring ${VEHICLE_RINGS[i].id} is further out than ${VEHICLE_RINGS[i - 1].id}`);
    assert(VEHICLE_RINGS[i].lod > VEHICLE_RINGS[i - 1].lod,
      `ring ${VEHICLE_RINGS[i].id} is less detailed than the ring inside it`);
  }
  const ceiling = VEHICLE_RINGS.reduce((t, r) => t + r.maxTriangles, 0) + TRAFFIC_MIRROR.maxTriangles;
  assert(ceiling <= VEHICLE_BUDGET.maxTriangles,
    `the per-ring caps add up inside the stated total (${ceiling} <= ${VEHICLE_BUDGET.maxTriangles})`);

  const { readFile } = await import('node:fs/promises');
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
  const ctx = makeCtx(city, {
    focus: { x: CITY.center[0], z: CITY.center[1] },
    heightAt: (x, z) => city.terrain.heightAt(x, z),
    seed: city.meta.seed,
  });
  const started = Date.now();
  const built = buildVehiclePresentation(ctx);
  const elapsed = Date.now() - started;
  const d = built.diagnostics;
  console.log(`  city size: ${d.plan.segments} paved segments, ${d.plan.nodes} junctions, `
    + `${d.plan.streetLengthMeters.toFixed(0)} m of street, ${d.buildingFootprints} building footprints`);
  console.log(`  placed: ${JSON.stringify(d.counts)}`);
  console.log(`  rings: ${d.rings.map((r) => `${r.id}(lod${r.lod})=${r.vehicles} vehicles/${r.triangles} tri`).join('; ')}`);
  console.log(`  totals: ${d.totals.vehicles} vehicles, ${d.totals.triangles} triangles, ${d.totals.drawCalls} draw calls, ${elapsed} ms`);
  console.log(`  grounding: worst ${(d.grounding.worstContactError * 1000).toFixed(2)} mm, mean ${(d.grounding.meanContactError * 1000).toFixed(3)} mm`);

  assert(d.plan.segments > 900, `the stated city size really is city-wide (${d.plan.segments} segments)`);
  assert(d.totals.vehicles > 300, `the population is city-wide, not hero-corridor only (${d.totals.vehicles})`);
  assert(Object.keys(d.counts).filter((k) => d.counts[k] > 0).length >= 7,
    `the kerb carries a real mix of classes (${Object.keys(d.counts).join(', ')})`);
  assert(d.uniqueAppearances >= MIN_DISTINCT_APPEARANCES,
    `${d.uniqueAppearances} distinct appearances city-wide (>= ${MIN_DISTINCT_APPEARANCES})`);
  for (const ring of d.rings) {
    assert(ring.vehicles <= ring.maxVehicles, `ring ${ring.id} holds its vehicle cap (${ring.vehicles} <= ${ring.maxVehicles})`);
    assert(ring.triangles <= ring.maxTriangles, `ring ${ring.id} holds its triangle budget (${ring.triangles} <= ${ring.maxTriangles})`);
  }
  assert(d.rings[0].vehicles > 0, `the near ring is populated at the build focus (${d.rings[0].vehicles})`);
  assert(d.totals.triangles <= VEHICLE_BUDGET.maxTriangles,
    `total triangle budget holds (${d.totals.triangles} <= ${VEHICLE_BUDGET.maxTriangles})`);
  assert(d.totals.drawCalls <= VEHICLE_BUDGET.maxDrawCalls,
    `draw-call budget holds (${d.totals.drawCalls} <= ${VEHICLE_BUDGET.maxDrawCalls})`);
  assert(elapsed < 8000, `build stays inside a usable capture budget (${elapsed} ms)`);
  // The real city is the case the modelled fallback cannot serve: where
  // `street-surface-v2` laps a junction pad or a wider ribbon over a narrower
  // one, the modelled "topmost cross-section" is not the asphalt that was
  // drawn. This ctx carries no street mesh, so the pass is on that fallback
  // here. A failure below is a float in the FALLBACK, not a stale expectation:
  // re-measured against the drawn triangles the worst wheel of round 5 stands
  // 109.6 mm above the asphalt under it, at the same wheel the old expression
  // reported 109.23 mm on.
  const audit = contactAudit(built, city);
  console.log(`  drawn-asphalt audit: ${audit.samples} contacts, ${audit.offMesh} off the mesh,`
    + ` mean ${(audit.mean * 1000).toFixed(2)} mm, worst float ${(audit.worstFloat * 1000).toFixed(2)} mm`);
  assert(audit.worst <= CONTACT_TOLERANCE,
    `real city: worst wheel-to-drawn-asphalt error ${(audit.worst * 1000).toFixed(2)} mm <= ${CONTACT_TOLERANCE * 1000} mm`
    + `${audit.worstAt ? ` - ${audit.worstAt}` : ''}`);

  // Instancing, not one mesh per vehicle.
  let instanced = 0;
  let plain = 0;
  let nonFinite = 0;
  built.object.traverse((node) => {
    if (node.isInstancedMesh) {
      instanced += 1;
      for (let i = 0; i < node.count * 16; i += 1) {
        if (!Number.isFinite(node.instanceMatrix.array[i])) nonFinite += 1;
      }
    } else if (node.isMesh) plain += 1;
  });
  assert(instanced > 0 && plain === 1,
    `every vehicle is instanced; the only plain mesh is the material anchor (${instanced} instanced, ${plain} plain)`);
  const anchor = built.object.getObjectByName('vehicle-material-anchor');
  assert(!!anchor && anchor.visible === false && Array.isArray(anchor.material),
    'the material anchor is present, invisible, and carries the material list');
  assert(nonFinite === 0, `no NaN/Inf in any instance matrix (${nonFinite})`);
  assert(d.meshes.every((m) => m.instances > 0 && m.trianglesEach > 0),
    'every emitted mesh carries real instances and real geometry');

  // Shadow policy: only the near ring and the big bodies cast.
  let casters = 0;
  let nearCasters = 0;
  built.object.traverse((node) => {
    if (!node.isInstancedMesh || !node.castShadow) return;
    casters += 1;
    if (node.userData?.lod === 0) nearCasters += 1;
  });
  assert(casters > 0 && nearCasters > 0, `shadow casters are declared (${casters}, ${nearCasters} at the near level of detail)`);
  assert(casters < instanced, `not every mesh casts a shadow (${casters}/${instanced})`);
  let contactPatches = 0;
  built.object.traverse((node) => {
    if (node.isInstancedMesh && node.userData?.group === 'contact') contactPatches += node.count;
  });
  const closeVehicles = d.rings[0].vehicles + d.rings[1].vehicles;
  assert(contactPatches === closeVehicles,
    `every near and mid vehicle has a ground contact patch (${contactPatches}/${closeVehicles})`);
  assert(d.grounding.withinTolerance === true,
    `the pass reports its own grounding inside its stated ${d.grounding.tolerance * 1000} mm tolerance`);

  // Whole-city overlap sweep on the real data.
  let overlaps = 0;
  const cell = 16;
  const grid = new Map();
  for (const vehicle of built.vehicles) {
    const corners = vehicleFootprint(vehicle.spec, vehicle.x, vehicle.z, vehicle.yaw);
    const gx = Math.floor(vehicle.x / cell);
    const gz = Math.floor(vehicle.z / cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        for (const other of grid.get(`${gx + dx}:${gz + dz}`) || []) {
          if (quadsOverlap(corners, other)) overlaps += 1;
        }
      }
    }
    const key = `${gx}:${gz}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(corners); else grid.set(key, [corners]);
  }
  assert(overlaps === 0, `no two vehicles overlap anywhere in the real city (${overlaps})`);

  let overKerb = 0;
  let outOfBand = 0;
  for (const vehicle of built.vehicles) {
    const segment = built.plan.segmentById.get(vehicle.segmentId);
    if (!segment) { outOfBand += 1; continue; }
    for (const corner of vehicleFootprint(vehicle.spec, vehicle.x, vehicle.z, vehicle.yaw)) {
      if (Math.abs(lateralOf(segment, corner.x, corner.z)) > segment.half + 1e-3) overKerb += 1;
    }
    const gap = segment.half - (Math.abs(vehicle.u) + vehicle.spec.width / 2);
    if (gap < KERB.minGap - 1e-6 || gap > KERB.maxGap + 1e-6) outOfBand += 1;
  }
  assert(overKerb === 0, `no vehicle in the real city crosses the kerb (${overKerb} corners outside)`);
  assert(outOfBand === 0, `every kerb offset in the real city is inside the stated band (${outOfBand} outside)`);
  disposeVehiclePresentation(built.state);
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('vehicle-presentation OK');
