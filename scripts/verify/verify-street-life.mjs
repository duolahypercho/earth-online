// Self-check for the street-life presentation pass and the street-level
// population that feeds it.
//
// Runs headless under plain node: no browser, no DOM, no GL, no capture, no new
// dependency. Exits non-zero on the first failed assertion.
//
//   node scripts/verify/verify-street-life.mjs
//
// What it proves
//
//   1. the pass satisfies the registry contract and is registered exactly once;
//   2. a degenerate world - no city, no segments, zero-length segments, NaN
//      coordinates, no sidewalks, no buildings, no signals, no camera - builds,
//      updates and disposes without throwing and without emitting content;
//   3. appearance is deterministic per agent id, and a crowd of N agents
//      carries at least MIN_DISTINCT_SHARE distinct appearance signatures;
//   4. GROUNDING: every figure's foot plane matches the footway surface the
//      street contract puts under it, on flat ground and on a 6% slope, to
//      GROUNDING_TOLERANCE_M; simulated walkers stand on the same plane; and
//      nothing is placed below the carriageway;
//   5. ANTI-SKATING: stride length tracks velocity inside a stated band and the
//      world-space ground speed of a planted foot is zero, at every speed a
//      walker in this city can reach;
//   6. presentation never writes simulation state - proven by deep-freezing the
//      simulation records around a presentation update, and by snapshotting the
//      live TrafficSim arrays around another;
//   7. density and budget hold at the stated city size: ring populations, hard
//      per-ring caps, draw calls and triangles.

import * as THREE from 'three';
import { validatePass } from '../../src/render/pass-registry.js';
import { PASSES } from '../../src/render/passes/index.js';
import streetLife, {
  STREET_LIFE_ID,
  STREET_LIFE_VERSION,
  STREET_LIFE_RINGS,
  STREET_LIFE_BUDGET,
  STREET_LIFE_LINE_DENSITY,
  streetLifeHourFactor,
  streetLifeSurfaceOptions,
  planStreetLifeAnchors,
  WALKER_LANE_CLEARANCE_M,
  planKerbParking,
  buildDistrictDensity,
  collectStreetOccupancy,
} from '../../src/render/passes/street-life.js';
import { MATERIAL_CLASSES } from '../../src/render/environment-ibl.js';
import {
  buildStreetscapePlan,
  sidewalkSurfaceY,
  carriagewaySurfaceY,
  streetStationAt,
} from '../../src/world/streets/street-surface-v2.js';
import {
  createCrowdPresentation,
  appearanceSignature,
  identityVariation,
  identityWardrobe,
  evaluateActivityPose,
  strideLengthForSpeed,
  cadenceForSpeed,
  legLengthForHeight,
  advanceGaitPhase,
  footGroundSpeed,
  footPlant,
  dutyFactorForSpeed,
  ACTIVITY_POSES,
  GAIT,
  ARTICULATING_JOINTS,
  BODY_PARTS,
  PEDESTRIAN_BONE_NAMES,
  REST_POSE,
  jointClosure,
  buildInstancedPartGeometries,
  mirrorActivityPose,
  buildLocomotionClips,
  LOCOMOTION_STATES,
} from '../../src/simulation/pedestrians/pedestrian-presentation.js';
import {
  TrafficSim,
  STREET_POPULATION,
  hourFootfall,
} from '../../src/citygen/traffic.js';

// --------------------------------------------------------------- thresholds

/** A figure's sole may sit this far from the surface the contract puts under it. */
const GROUNDING_TOLERANCE_M = 1e-6;
/** Simulated walkers are placed analytically, so their tolerance is tighter. */
const WALKER_GROUNDING_TOLERANCE_M = 1e-9;
/**
 * Stride / (2 x leg length) must stay inside this band over walking speeds.
 * For a 0.92 m leg that is a 0.63 m stride at a 0.4 m/s shuffle and a 2.21 m
 * stride at a 2.4 m/s hurry, which brackets measured adult gait. Outside the
 * band a figure is either mincing or doing the splits, and both read as
 * skating even when the contact maths is exact.
 */
const STRIDE_BAND = Object.freeze({ min: 0.34, max: 1.20 });
/** A planted foot may not move faster than this in world space. */
const MAX_STANCE_FOOT_SPEED = 1e-9;
/**
 * Every articulating joint must stay closed by this margin, in metres, at every
 * joint angle and every detail tier that articulates.
 *
 * REGRESSION SENTINEL. The first version of this rig was a box torso with bare
 * cylinder limbs and no joint geometry at all. Measured on that rig:
 *   * the upper-arm cylinder's top rim sat 73 mm clear of the torso AT REST and
 *     never closed at any angle;
 *   * the elbow rims opened to 66 mm at a right angle.
 * Because the upper arm carries the shirt colour and the forearm carries the
 * skin colour, that read on screen as a shirt-coloured stub lost against the
 * torso plus a skin-coloured stick floating beside the body - reported by four
 * separate review frames as detached forearms and a broken rig, which is a
 * critical-artifact reject. This assertion is what stops it coming back.
 */
const MIN_JOINT_MARGIN_M = 0.010;
/**
 * A bone may never sit further from its parent than its own rest length allows.
 *
 * Under a UNIFORM identity scale the distance is exact to machine precision. The
 * crowd also applies a deliberately NON-uniform scale - `(h*b, h, h*b)`, where
 * `b` is the identity's build - so a stocky agent is wider without being taller.
 * Rotating a bone chain inside an anisotropic scale shears it, which stretches a
 * limb by at most the anisotropy itself: 2 % of a 0.4 m thigh is 8 mm. That is
 * absorbed by the 10-49 mm joint margins above, and it is the ONLY stretch
 * allowed; anything larger means a bone is being translated, which is what a
 * matrix written in the wrong space looks like.
 */
const BONE_LENGTH_TOLERANCE_M = 1e-9;
const BUILD_ANISOTROPY = 0.12;
/** Distinct appearance signatures required over N agents. */
const MIN_DISTINCT_SHARE = 0.97;
const APPEARANCE_SAMPLE = 1024;
/** Ring populations required on the reference city at the reference pose. */
const DENSITY_FLOOR = Object.freeze({
  walkersWithin30: 8,
  walkersWithin80: 30,
  walkersWithin120: 55,
  vehiclesWithin120: 12,
  standingWithin132: 24,
  kerbCarsWithin150: 12,
});

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

function near(a, b, tolerance) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

// --------------------------------------------------------------- fixtures

/**
 * A structurally real grid city: `blocks` x `blocks` city blocks of `span`
 * metres, two street classes, buildings on every block, signals on the main
 * avenues. Big enough that ring budgets and decimation actually bite.
 */
function gridCity({ blocks = 9, span = 92, seed = 'verify-street-life' } = {}) {
  const segments = [];
  const buildings = [];
  const signals = [];
  const extent = blocks * span;
  const half = extent / 2;
  const classFor = (i) => (i % 3 === 0 ? 'secondary' : 'residential');
  const widthFor = (className) => (className === 'secondary' ? 12.8 : 8.2);
  let id = 0;
  for (let i = 0; i <= blocks; i += 1) {
    const className = classFor(i);
    const width = widthFor(className);
    const at = -half + i * span;
    for (let j = 0; j < blocks; j += 1) {
      const a = -half + j * span;
      const b = a + span;
      segments.push({
        id: `seg-h-${id += 1}`,
        streetId: `street-h-${i}`,
        streetName: `${i}th Street`,
        highway: className,
        lanes: className === 'secondary' ? 4 : 2,
        width,
        sidewalkW: 2.5,
        points: [{ x: a, z: at }, { x: b, z: at }],
        signalId: className === 'secondary' ? `signal-h-${i}-${j}` : null,
      });
      segments.push({
        id: `seg-v-${id += 1}`,
        streetId: `street-v-${i}`,
        streetName: `Avenue ${i}`,
        highway: className,
        lanes: className === 'secondary' ? 4 : 2,
        width,
        sidewalkW: 2.5,
        points: [{ x: at, z: a }, { x: at, z: b }],
        signalId: null,
      });
      if (className === 'secondary') {
        signals.push({ id: `signal-h-${i}-${j}`, x: a, z: at, phase: (i + j) % 2 });
      }
    }
  }
  for (let i = 0; i < blocks; i += 1) {
    for (let j = 0; j < blocks; j += 1) {
      const x0 = -half + i * span + 9;
      const z0 = -half + j * span + 9;
      const w = span - 18;
      const levels = 3 + ((i * 7 + j * 3) % 12);
      buildings.push({
        id: `building-${i}-${j}`,
        height: levels * 3.4,
        levels,
        material: (i + j) % 2 ? 'brick' : 'stucco',
        polygon: [
          { x: x0, z: z0 }, { x: x0 + w, z: z0 }, { x: x0 + w, z: z0 + w }, { x: x0, z: z0 + w },
        ],
      });
    }
  }
  return {
    schemaVersion: 3,
    meta: {
      name: 'verify grid',
      seed,
      seedInt: 4242,
      generator: 'openstreetmap',
      center: { x: 0, z: 0 },
      bounds: { minX: -half - 40, maxX: half + 40, minZ: -half - 40, maxZ: half + 40 },
      streetDesign: { streetScale: 1, sidewalkScale: 1, curbHeight: 0.16, roadLift: 0.45 },
    },
    blocks: [],
    buildings,
    streets: segments,
    segments,
    intersections: [],
    signals,
    parks: [],
    water: [],
  };
}

/** A 6% slope running along +X, so grounding has something to follow. */
const slopedHeight = (x, z) => x * 0.06 + Math.sin(z * 0.01) * 0.4;
const flatHeight = () => 0;

function makeContext(city, { heightAt = flatHeight, hour = 12, camera = null, root = null } = {}) {
  const scene = new THREE.Scene();
  const view = camera || (() => {
    const cam = new THREE.PerspectiveCamera(47, 16 / 9, 0.5, 4200);
    cam.position.set(0, 1.8, 0);
    cam.lookAt(0, 1.7, 60);
    cam.updateMatrixWorld(true);
    return cam;
  })();
  return {
    root: root || new THREE.Group(),
    city,
    scene,
    camera: view,
    renderer: null,
    rendererBackend: 'verify',
    terrain: { heightAt },
    heightAt,
    isSanFrancisco: false,
    seed: 4242,
    rng: () => () => 0.5,
    focus: { x: 0, z: 0 },
    hour,
    weather: 'clear',
    day: true,
    registerGeometry: (geometry) => geometry,
    legacyGroup: () => null,
  };
}

/** Minimal renderer shim: everything TrafficSim reads and nothing more. */
function makeTrafficRenderer(city, camera, heightAt) {
  return {
    scene: new THREE.Scene(),
    camera,
    controls: { target: new THREE.Vector3(camera.position.x, 0, camera.position.z + 20) },
    terrain: { heightAt },
  };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return value;
}

function snapshot(agents) {
  return JSON.stringify(agents.map((agent) => ({
    id: agent.id ?? agent.instanceIndex,
    s: agent.s,
    seg: agent.seg,
    dir: agent.dir,
    speed: agent.speed,
    total: agent.total,
    activity: agent.activity ?? null,
    activityTimer: agent.activityTimer ?? null,
    lateral: agent.lateral ?? null,
    p: [agent.group.position.x, agent.group.position.y, agent.group.position.z],
    r: agent.group.rotation.y,
  })));
}

// ---------------------------------------------------------------------------
section('1. registry contract');

assert(validatePass(streetLife).length === 0, `pass satisfies the registry contract: ${validatePass(streetLife).join('; ') || 'clean'}`);
assert(streetLife.id === STREET_LIFE_ID && streetLife.id === 'street-life', `id is ${streetLife.id}`);
assert(Number.isFinite(streetLife.order), `order is ${streetLife.order}`);
assert(typeof streetLife.update === 'function' && typeof streetLife.dispose === 'function', 'exposes update and dispose');
assert(PASSES.filter((pass) => pass.id === 'street-life').length === 1, 'registered exactly once in the static pass list');
assert(
  PASSES.filter((pass) => pass.id === 'street-life')[0] === streetLife,
  'the registered module is this module (no second instance)',
);
assert(typeof STREET_LIFE_VERSION === 'string' && STREET_LIFE_VERSION.length > 0, `version ${STREET_LIFE_VERSION}`);

// ---------------------------------------------------------------------------
section('2. degenerate worlds');

const degenerate = [
  ['no ctx at all', undefined],
  ['null city', makeContext(null)],
  ['city with no segments', makeContext({ meta: { seedInt: 1 }, segments: [], buildings: [], signals: [] })],
  ['segments array missing', makeContext({ meta: { seedInt: 1 } })],
  ['zero-length segment', makeContext({
    meta: { seedInt: 1, bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 }, streetDesign: { roadLift: 0.45 } },
    segments: [{ id: 'z', highway: 'residential', width: 8, sidewalkW: 2, points: [{ x: 0, z: 0 }, { x: 0, z: 0 }] }],
    buildings: [], signals: [],
  })],
  ['NaN coordinates', makeContext({
    meta: { seedInt: 1, bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 } },
    segments: [{ id: 'n', highway: 'primary', width: NaN, sidewalkW: 2, points: [{ x: NaN, z: 0 }, { x: 5, z: NaN }] }],
    buildings: [{ id: 'b', polygon: [{ x: NaN, z: 0 }] }], signals: null,
  })],
  ['no sidewalk anywhere', makeContext({
    meta: { seedInt: 1, bounds: { minX: -200, maxX: 200, minZ: -20, maxZ: 20 }, streetDesign: { roadLift: 0.45 } },
    segments: [{ id: 's', highway: 'primary', width: 14, sidewalkW: 0, points: [{ x: -150, z: 0 }, { x: 150, z: 0 }] }],
    buildings: [], signals: [],
  })],
  ['no camera and no focus', (() => {
    const ctx = makeContext(gridCity({ blocks: 3, span: 80 }));
    ctx.camera = null;
    ctx.focus = null;
    return ctx;
  })()],
];

let degenerateFailures = 0;
for (const [label, ctx] of degenerate) {
  let result = null;
  let threw = null;
  try {
    result = streetLife.build(ctx);
    streetLife.update(ctx, 1 / 60);
    streetLife.update(ctx, 0);
    streetLife.update(ctx, NaN);
    streetLife.dispose();
  } catch (error) {
    threw = error;
  }
  if (threw) degenerateFailures += 1;
  assert(!threw, `${label}: build/update/dispose does not throw${threw ? ` (${threw.message})` : ''}`);
  if (!threw) {
    const shape = result && typeof result === 'object'
      && (result.object === null || typeof result.object?.traverse === 'function')
      && result.diagnostics && typeof result.diagnostics === 'object';
    assert(shape, `${label}: returns a valid PassResult`);
    assert(!result?.diagnostics?.failure, `${label}: no internal failure recorded`);
  }
}
assert(degenerateFailures === 0, `${degenerate.length} degenerate worlds survived`);

// double dispose and update-before-build are also non-events
let lifecycleThrew = null;
try {
  streetLife.dispose();
  streetLife.update(makeContext(gridCity({ blocks: 2, span: 70 })), 1 / 60);
  streetLife.dispose();
} catch (error) {
  lifecycleThrew = error;
}
assert(!lifecycleThrew, `update before build and double dispose are non-events${lifecycleThrew ? ` (${lifecycleThrew.message})` : ''}`);

// ---------------------------------------------------------------------------
section('3. appearance identity');

const signatures = new Set();
for (let i = 0; i < APPEARANCE_SAMPLE; i += 1) signatures.add(appearanceSignature(`agent-${i}`));
const distinctShare = signatures.size / APPEARANCE_SAMPLE;
assert(
  distinctShare >= MIN_DISTINCT_SHARE,
  `${signatures.size}/${APPEARANCE_SAMPLE} distinct appearance signatures (${(distinctShare * 100).toFixed(1)}% >= ${MIN_DISTINCT_SHARE * 100}%)`,
);

let stable = true;
for (let i = 0; i < 256; i += 1) {
  const id = `agent-${i}`;
  if (appearanceSignature(id) !== appearanceSignature(id)) stable = false;
  const a = identityVariation(id);
  const b = identityVariation(id);
  if (a.heightScale !== b.heightScale || a.colors.top !== b.colors.top) stable = false;
  const wa = identityWardrobe(id);
  const wb = identityWardrobe(id);
  if (wa.silhouetteBits !== wb.silhouetteBits) stable = false;
}
assert(stable, 'appearance, proportions and wardrobe are pure functions of the agent id');

let neighbourCollisions = 0;
for (let i = 0; i < APPEARANCE_SAMPLE - 1; i += 1) {
  if (appearanceSignature(`agent-${i}`) === appearanceSignature(`agent-${i + 1}`)) neighbourCollisions += 1;
}
assert(neighbourCollisions === 0, `no two consecutive agent ids share an appearance (${neighbourCollisions} collisions)`);

let wardrobeCarriers = 0;
for (let i = 0; i < APPEARANCE_SAMPLE; i += 1) {
  if (identityWardrobe(`agent-${i}`).silhouetteBits !== 0) wardrobeCarriers += 1;
}
const wardrobeShare = wardrobeCarriers / APPEARANCE_SAMPLE;
assert(
  wardrobeShare > 0.5 && wardrobeShare < 0.98,
  `${(wardrobeShare * 100).toFixed(1)}% of the crowd carries a silhouette-breaking item (bag, coat, hat, hair, scarf, case)`,
);

// activity vocabulary
const overlayBuffer = {};
let poseFinite = true;
let poseVaries = 0;
for (const activity of ACTIVITY_POSES) {
  const pose = evaluateActivityPose(activity, 3.5, 'agent-7', overlayBuffer);
  if (!pose) { poseFinite = false; continue; }
  for (const bone in pose) {
    for (const value of pose[bone]) if (!Number.isFinite(value)) poseFinite = false;
  }
  const later = evaluateActivityPose(activity, 5.9, 'agent-7', {});
  for (const bone in pose) {
    if (later[bone] && Math.abs(later[bone][0] - pose[bone][0]) > 1e-6) { poseVaries += 1; break; }
  }
}
assert(poseFinite, `all ${ACTIVITY_POSES.length} activity overlays evaluate finite`);
assert(poseVaries >= ACTIVITY_POSES.length - 1, `${poseVaries}/${ACTIVITY_POSES.length} activity overlays move over time (no statues)`);

let overlayDeterministic = true;
for (const activity of ACTIVITY_POSES) {
  const a = evaluateActivityPose(activity, 2.25, 'agent-11', {});
  const b = evaluateActivityPose(activity, 2.25, 'agent-11', {});
  for (const bone in a) {
    for (let i = 0; i < 3; i += 1) if (a[bone][i] !== b[bone][i]) overlayDeterministic = false;
  }
}
assert(overlayDeterministic, 'activity overlays are deterministic in (activity, time, id)');

// ---------------------------------------------------------------------------
section('4. grounding');

const city = gridCity();
const surfaceOptions = streetLifeSurfaceOptions(city);
assert(
  near(surfaceOptions.roadLift, 0.45, 1e-12)
  && near(surfaceOptions.gutterDepth, 0.04, 1e-12)
  && near(surfaceOptions.curbFaceHeight, 0.15, 1e-9),
  `surface options mirror the renderer's pinned planes: datum ${surfaceOptions.roadLift} m, curb face ${surfaceOptions.curbFaceHeight.toFixed(3)} m`,
);

for (const [label, heightAt] of [['flat ground', flatHeight], ['6% slope', slopedHeight]]) {
  const plan = buildStreetscapePlan(city, { ...surfaceOptions, heightAt, inferNodes: true });
  const planned = planStreetLifeAnchors(plan, {
    hour: 12,
    density: buildDistrictDensity(city),
    occupancy: null,
    heightAt,
  });
  assert(planned.anchors.length > 200, `${label}: ${planned.anchors.length} figures planned`);

  let maxError = 0;
  let sumError = 0;
  let belowRoad = 0;
  let offFootway = 0;
  for (const anchor of planned.anchors) {
    const segment = plan.segmentById.get(anchor.segmentId);
    const frame = streetStationAt(segment, 0);
    const last = segment.points[segment.points.length - 1];
    const along = { x: last.x - frame.x, z: last.z - frame.z };
    const length = Math.hypot(along.x, along.z) || 1;
    const nx = -along.z / length;
    const nz = along.x / length;
    const u = (anchor.x - frame.x) * nx + (anchor.z - frame.z) * nz;
    const datum = heightAt(anchor.x, anchor.z) + plan.options.roadLift;
    const expected = sidewalkSurfaceY(datum, u, segment.half, plan.options);
    const error = Math.abs(anchor.y - expected);
    if (error > maxError) maxError = error;
    sumError += error;
    // The lowest point of the built street cross-section is the gutter invert;
    // anything under that is inside the road slab, not on the pavement.
    if (anchor.y < datum - plan.options.gutterDepth - 1e-9) belowRoad += 1;
    if (Math.abs(u) < segment.half || Math.abs(u) > segment.half + 2.5 + 1e-9) offFootway += 1;
  }
  assert(
    maxError <= GROUNDING_TOLERANCE_M,
    `${label}: worst foot-to-footway offset ${maxError.toExponential(2)} m <= ${GROUNDING_TOLERANCE_M} m (mean ${(sumError / planned.anchors.length).toExponential(2)} m)`,
  );
  assert(belowRoad === 0, `${label}: no figure stands below the gutter invert - nothing is sunk into the road slab (${belowRoad})`);

  // No stationary figure may stand in the lane the walking simulation uses:
  // `buildSidewalkPaths` puts its walkers 1.0 m in from the property line.
  let inWalkerLane = 0;
  let closestToLane = Infinity;
  for (const anchor of planned.anchors) {
    const segment = plan.segmentById.get(anchor.segmentId);
    const frame = streetStationAt(segment, 0);
    const last = segment.points[segment.points.length - 1];
    const along = { x: last.x - frame.x, z: last.z - frame.z };
    const length = Math.hypot(along.x, along.z) || 1;
    const u = Math.abs((anchor.x - frame.x) * (-along.z / length) + (anchor.z - frame.z) * (along.x / length));
    const walkerLane = segment.half + (anchor.side > 0 ? segment.walks.left : segment.walks.right) - 1.0;
    const gap = walkerLane - u;
    if (gap < WALKER_LANE_CLEARANCE_M - 1e-9) inWalkerLane += 1;
    if (gap < closestToLane) closestToLane = gap;
  }
  assert(
    inWalkerLane === 0,
    `${label}: every figure clears the walking lane by >= ${WALKER_LANE_CLEARANCE_M} m (worst ${closestToLane.toFixed(3)} m, ${inWalkerLane} violations)`,
  );
  assert(offFootway === 0, `${label}: every figure is inside the footway band (${offFootway} outside)`);

  const parking = planKerbParking(plan, { occupancy: null, heightAt });
  let carMax = 0;
  let carsOnFootway = 0;
  for (const spot of parking.spots) {
    const segment = plan.segmentById.get(spot.segmentId);
    const frame = streetStationAt(segment, 0);
    const last = segment.points[segment.points.length - 1];
    const along = { x: last.x - frame.x, z: last.z - frame.z };
    const length = Math.hypot(along.x, along.z) || 1;
    const u = (spot.x - frame.x) * (-along.z / length) + (spot.z - frame.z) * (along.x / length);
    const datum = heightAt(spot.x, spot.z) + plan.options.roadLift;
    const expected = carriagewaySurfaceY(datum, u, segment.half, plan.options);
    carMax = Math.max(carMax, Math.abs(spot.y - expected));
    if (Math.abs(u) > segment.half) carsOnFootway += 1;
  }
  assert(
    carMax <= GROUNDING_TOLERANCE_M,
    `${label}: worst kerb-car tyre-to-carriageway offset ${carMax.toExponential(2)} m`,
  );
  assert(carsOnFootway === 0, `${label}: no kerb car is parked on the pavement (${carsOnFootway})`);
}

// The simulation's own walkers must stand on the same plane.
{
  const camera = new THREE.PerspectiveCamera(47, 16 / 9, 0.5, 4200);
  camera.position.set(0, 1.8, -20);
  camera.lookAt(0, 1.7, 200);
  camera.updateMatrixWorld(true);
  const renderer = makeTrafficRenderer(city, camera, slopedHeight);
  const traffic = new TrafficSim(renderer, city);
  for (let i = 0; i < 60; i += 1) traffic.update(1 / 30);
  let maxWalker = 0;
  const agents = traffic.presentationAgents();
  for (const agent of agents) {
    if (agent.heroCurbBehavior) continue;
    const expected = slopedHeight(agent.group.position.x, agent.group.position.z) + traffic.footwayLift;
    const bob = agent.group.userData.walk.bobOffset || 0;
    maxWalker = Math.max(maxWalker, Math.abs(agent.group.position.y - bob - expected));
  }
  assert(
    maxWalker <= WALKER_GROUNDING_TOLERANCE_M,
    `simulated walkers stand on the footway plane: worst offset ${maxWalker.toExponential(2)} m over ${agents.length} agents`,
  );
  let maxCar = 0;
  for (const car of traffic.cars) {
    const expected = slopedHeight(car.group.position.x, car.group.position.z) + traffic.roadLift;
    maxCar = Math.max(maxCar, Math.abs(car.group.position.y - expected));
  }
  assert(
    maxCar <= WALKER_GROUNDING_TOLERANCE_M,
    `moving vehicles sit on the carriageway datum: worst offset ${maxCar.toExponential(2)} m over ${traffic.cars.length} cars`,
  );
  assert(
    near(traffic.footwayLift - traffic.roadLift, 0.102, 1e-12),
    `the footway is exactly 102 mm above the carriageway datum (${(traffic.footwayLift - traffic.roadLift).toFixed(4)} m)`,
  );
}

// ---------------------------------------------------------------------------
section('5. animation speed and anti-skating');

{
  let bandMin = Infinity;
  let bandMax = -Infinity;
  let worstFootSpeed = 0;
  let stanceSamples = 0;
  let monotone = true;
  let previousStride = -Infinity;
  for (let v = 0.4; v <= 2.4001; v += 0.05) {
    const legLength = legLengthForHeight(GAIT.referenceHeight);
    const stride = strideLengthForSpeed(v, legLength);
    const ratio = stride / (2 * legLength);
    bandMin = Math.min(bandMin, ratio);
    bandMax = Math.max(bandMax, ratio);
    if (stride < previousStride) monotone = false;
    previousStride = stride;
    const duty = dutyFactorForSpeed(v);
    for (let p = 0; p < 1; p += 1 / 256) {
      for (const side of ['left', 'right']) {
        // Only a foot in CONTACT can skate. A foot in swing is supposed to be
        // travelling: that is what a step is.
        const plant = footPlant({ phase: p, side, strideLength: stride, duty, lift: 0.08 });
        if (!plant.contact) continue;
        const speed = footGroundSpeed({ phase: p, side, strideLength: stride, duty, speed: v });
        if (Math.abs(speed) > worstFootSpeed) worstFootSpeed = Math.abs(speed);
        stanceSamples += 1;
      }
    }
  }
  assert(
    bandMin >= STRIDE_BAND.min && bandMax <= STRIDE_BAND.max,
    `stride/(2 x leg) stays in [${STRIDE_BAND.min}, ${STRIDE_BAND.max}] over 0.4-2.4 m/s: measured [${bandMin.toFixed(3)}, ${bandMax.toFixed(3)}]`,
  );
  assert(monotone, 'stride length is non-decreasing in speed');
  assert(
    worstFootSpeed <= MAX_STANCE_FOOT_SPEED,
    `worst planted-foot world speed ${worstFootSpeed.toExponential(2)} m/s <= ${MAX_STANCE_FOOT_SPEED} m/s over ${stanceSamples} stance samples`,
  );

  // The gait phase is an odometer: the same distance produces the same phase
  // however it is chopped into frames, and a stopped agent's phase is frozen.
  const legLength = legLengthForHeight();
  const stride = strideLengthForSpeed(1.4, legLength);
  let coarse = 0.2;
  coarse = advanceGaitPhase(coarse, 1.4, stride, 0.5);
  let fine = 0.2;
  for (let i = 0; i < 50; i += 1) fine = advanceGaitPhase(fine, 1.4, stride, 0.01);
  assert(near(coarse, fine, 1e-12), `gait phase is distance, not time: 1x0.5 s = ${coarse.toFixed(9)} vs 50x0.01 s = ${fine.toFixed(9)}`);
  assert(advanceGaitPhase(0.37, 0, stride, 1) === 0.37, 'a stopped agent does not advance its gait phase');

  // Cadence at a real walking speed lands on measured adult gait.
  const stepsPerMinute = cadenceForSpeed(1.4, legLength) * 60;
  assert(
    stepsPerMinute > 95 && stepsPerMinute < 125,
    `cadence at 1.4 m/s is ${stepsPerMinute.toFixed(1)} steps/min (adult range 95-125)`,
  );
}

// ---------------------------------------------------------------------------
section('6. presentation never writes simulation state');

{
  // 6a. Frozen records. ESM modules are strict, so any assignment onto a frozen
  // simulation record raises a TypeError rather than silently succeeding.
  const frozenAgents = [];
  for (let i = 0; i < 120; i += 1) {
    frozenAgents.push(deepFreeze({
      instanceIndex: i,
      id: `frozen-${i}`,
      speed: 1.1 + (i % 7) * 0.12,
      activity: ACTIVITY_POSES[i % ACTIVITY_POSES.length],
      pose: i % 23 === 0 ? 'sit' : 'walk',
      group: {
        position: { x: (i % 12) * 3.1, y: 0.495, z: Math.floor(i / 12) * 3.7 },
        rotation: { x: 0, y: (i % 9) * 0.4, z: 0 },
        userData: { walk: { bobOffset: 0 } },
      },
    }));
  }
  const crowd = createCrowdPresentation({ sampleGround: (x, z) => slopedHeight(x, z) + 0.495 });
  let mutationThrew = null;
  let stats = null;
  try {
    for (let frame = 0; frame < 12; frame += 1) {
      stats = crowd.update(frozenAgents, 1 / 30, { x: 0, y: 1.7, z: 0 });
    }
  } catch (error) {
    mutationThrew = error;
  }
  assert(!mutationThrew, `a deep-frozen simulation array survives 12 presentation frames${mutationThrew ? ` (${mutationThrew.message})` : ''}`);
  assert(stats && stats.agents === frozenAgents.length, `all ${frozenAgents.length} frozen agents were mirrored`);
  assert(stats && stats.grounded === stats.agents, `every mirrored agent is grounded (${stats?.grounded}/${stats?.agents})`);
  assert(
    stats && stats.activityOverlays > 0 && Object.keys(stats.activities).length > 1,
    `activity overlays are running: ${JSON.stringify(stats?.activities)}`,
  );
  crowd.dispose();
}

{
  // 6b. The live simulation. Snapshot the arrays, run a presentation update
  // over them, and assert byte equality of the snapshot.
  const camera = new THREE.PerspectiveCamera(47, 16 / 9, 0.5, 4200);
  camera.position.set(0, 1.8, -30);
  camera.lookAt(0, 1.7, 200);
  camera.updateMatrixWorld(true);
  const traffic = new TrafficSim(makeTrafficRenderer(city, camera, flatHeight), city);
  for (let i = 0; i < 40; i += 1) traffic.update(1 / 30);
  const agents = traffic.presentationAgents();
  const before = snapshot(agents);
  const crowd = createCrowdPresentation({ sampleGround: (x, z) => flatHeight(x, z) + traffic.footwayLift });
  for (let i = 0; i < 8; i += 1) crowd.update(agents, 1 / 30, camera);
  const after = snapshot(agents);
  crowd.dispose();
  assert(before === after, `TrafficSim records are byte-identical across 8 crowd frames (${agents.length} agents)`);

  // The street-life pass may not write the city contract either.
  const frozenCity = deepFreeze(gridCity({ blocks: 5, span: 88 }));
  const ctx = makeContext(frozenCity, { heightAt: slopedHeight, hour: 11 });
  let passThrew = null;
  try {
    streetLife.build(ctx);
    for (let i = 0; i < 40; i += 1) streetLife.update(ctx, 1 / 30);
  } catch (error) {
    passThrew = error;
  }
  assert(!passThrew, `the pass builds and runs against a deep-frozen city${passThrew ? ` (${passThrew.message})` : ''}`);
  streetLife.dispose();
}

// ---------------------------------------------------------------------------
section('7. density, decimation and budget');

{
  const camera = new THREE.PerspectiveCamera(47, 16 / 9, 0.5, 4200);
  // Stand on a kerb of the reference grid, looking down an avenue.
  camera.position.set(-6.9, 1.8, -140);
  camera.lookAt(-6.9, 1.7, 200);
  camera.updateMatrixWorld(true);
  const traffic = new TrafficSim(makeTrafficRenderer(city, camera, flatHeight), city);
  // Long enough for the local-life recycler to converge on its targets.
  for (let i = 0; i < 400; i += 1) traffic.update(1 / 30);
  const focus = { x: camera.position.x, z: camera.position.z };
  const distance = (actor) => Math.hypot(actor.group.position.x - focus.x, actor.group.position.z - focus.z);
  const walkers = traffic.presentationAgents();
  const within = (list, radius) => list.filter((a) => distance(a) <= radius).length;

  assert(
    traffic.pedestrians.length === 48,
    `the logical pedestrian population is untouched at ${traffic.pedestrians.length}`,
  );
  assert(
    traffic.ambientCrowd.length === STREET_POPULATION.ambientWalkers,
    `${traffic.ambientCrowd.length} ambient walkers added on top of it`,
  );
  assert(
    traffic.ambientCrowd.every((walker) => walker.instanceIndex === null),
    'no ambient walker owns an instanced-batch slot',
  );
  assert(
    traffic.pedestrians.every((pedestrian) => !traffic.ambientCrowd.includes(pedestrian)),
    'the two populations are disjoint',
  );
  const w30 = within(walkers, 30);
  const w80 = within(walkers, 80);
  const w120 = within(walkers, 120);
  const v120 = within(traffic.cars, 120);
  assert(w30 >= DENSITY_FLOOR.walkersWithin30, `${w30} walkers within 30 m (floor ${DENSITY_FLOOR.walkersWithin30})`);
  assert(w80 >= DENSITY_FLOOR.walkersWithin80, `${w80} walkers within 80 m (floor ${DENSITY_FLOOR.walkersWithin80})`);
  assert(w120 >= DENSITY_FLOOR.walkersWithin120, `${w120} walkers within 120 m (floor ${DENSITY_FLOOR.walkersWithin120})`);
  assert(v120 >= DENSITY_FLOOR.vehiclesWithin120, `${v120} moving vehicles within 120 m (floor ${DENSITY_FLOOR.vehiclesWithin120})`);
  assert(w30 <= w80 && w80 <= w120, `ring counts are nested: ${w30} <= ${w80} <= ${w120}`);

  const purposeful = walkers.filter((a) => a.activity && a.activity !== 'walk');
  assert(
    purposeful.length > 0 && purposeful.length < walkers.length * 0.5,
    `${purposeful.length}/${walkers.length} walkers are mid-activity (waiting, talking, on a phone, browsing) - visible purpose without a frozen street`,
  );
  const activityKinds = new Set(purposeful.map((a) => a.activity));
  assert(activityKinds.size >= 3, `at least three distinct activities in flight: ${[...activityKinds].join(', ')}`);
  const stationary = purposeful.filter((a) => (a.group.userData.walk.bobOffset || 0) === 0);
  assert(stationary.length === purposeful.length, 'a stopped walker does not bob on the spot');
  const honestSpeed = purposeful.filter((a) => a.groundSpeed === 0);
  assert(
    honestSpeed.length === purposeful.length,
    `a stopped walker reports zero ground speed, not its cruise speed (${honestSpeed.length}/${purposeful.length}) - this is the anti-skating contract at the simulation boundary`,
  );
  const walking = walkers.filter((a) => !a.activity || a.activity === 'walk');
  assert(
    walking.every((a) => a.groundSpeed === undefined || a.groundSpeed > 0),
    'a walking agent reports a positive ground speed',
  );

  // The presentation mirrors the whole population inside its own budget.
  const crowd = createCrowdPresentation({ sampleGround: (x, z) => flatHeight(x, z) + traffic.footwayLift });
  let crowdStats = null;
  for (let i = 0; i < 6; i += 1) crowdStats = crowd.update(walkers, 1 / 30, camera);
  assert(crowdStats.agents === walkers.length, `crowd mirrored all ${walkers.length} agents`);
  assert(
    crowdStats.skinned <= crowdStats.budget.skinned
    && crowdStats.instanced <= crowdStats.budget.instanced
    && crowdStats.far <= crowdStats.budget.far,
    `crowd bands respect their caps: ${crowdStats.skinned}/${crowdStats.budget.skinned} skinned, ${crowdStats.instanced}/${crowdStats.budget.instanced} instanced, ${crowdStats.far}/${crowdStats.budget.far} far`,
  );
  assert(
    crowdStats.uniqueAppearances >= Math.min(crowdStats.agents, 100) * 0.95,
    `${crowdStats.uniqueAppearances} distinct appearances drawn across ${crowdStats.agents} mirrored agents`,
  );
  assert(crowdStats.draws <= 80, `crowd draw calls ${crowdStats.draws} <= 80`);
  crowd.dispose();

  // Street-life pass at the same pose.
  const root = new THREE.Group();
  const ctx = makeContext(city, { heightAt: flatHeight, hour: 11, camera, root });
  const built = streetLife.build(ctx);
  root.add(built.object);
  for (let i = 0; i < 40; i += 1) streetLife.update(ctx, 1 / 30);
  const diagnostics = built.diagnostics;
  const nearRing = STREET_LIFE_RINGS[0];
  const midRing = STREET_LIFE_RINGS[1];
  assert(diagnostics.figures.planned > 400, `${diagnostics.figures.planned} stationary figures planned city-wide`);
  assert(
    diagnostics.figures.near <= nearRing.budget && diagnostics.figures.mid <= midRing.budget,
    `ring caps hold: ${diagnostics.figures.near}/${nearRing.budget} near, ${diagnostics.figures.mid}/${midRing.budget} mid`,
  );
  assert(
    diagnostics.figures.near + diagnostics.figures.mid >= DENSITY_FLOOR.standingWithin132,
    `${diagnostics.figures.near + diagnostics.figures.mid} stationary figures drawn within ${midRing.radius} m (floor ${DENSITY_FLOOR.standingWithin132})`,
  );
  assert(
    diagnostics.figures.culled > diagnostics.figures.near + diagnostics.figures.mid,
    `distance decimation is doing real work: ${diagnostics.figures.culled} figures culled`,
  );
  assert(
    diagnostics.parking.drawn >= DENSITY_FLOOR.kerbCarsWithin150,
    `${diagnostics.parking.drawn} kerb cars drawn within ${STREET_LIFE_BUDGET.parkingRadius} m (floor ${DENSITY_FLOOR.kerbCarsWithin150})`,
  );
  assert(
    diagnostics.parking.drawn <= STREET_LIFE_BUDGET.parkedCars,
    `kerb-car cap holds: ${diagnostics.parking.drawn} <= ${STREET_LIFE_BUDGET.parkedCars}`,
  );
  assert(
    diagnostics.cost.drawCalls <= STREET_LIFE_BUDGET.maxDrawCalls,
    `pass draw calls ${diagnostics.cost.drawCalls} <= ${STREET_LIFE_BUDGET.maxDrawCalls}`,
  );
  assert(
    diagnostics.cost.triangles <= STREET_LIFE_BUDGET.maxTriangles,
    `pass triangles ${diagnostics.cost.triangles} <= ${STREET_LIFE_BUDGET.maxTriangles}`,
  );
  assert(
    diagnostics.grounding.maxOffset <= GROUNDING_TOLERANCE_M,
    `self-reported grounding max ${diagnostics.grounding.maxOffset.toExponential(2)} m, mean ${diagnostics.grounding.meanOffset.toExponential(2)} m over ${diagnostics.grounding.samples} figures`,
  );
  assert(
    diagnostics.appearance.uniqueSignatures >= diagnostics.appearance.total * MIN_DISTINCT_SHARE,
    `${diagnostics.appearance.uniqueSignatures}/${diagnostics.appearance.total} distinct figure appearances`,
  );
  const activityKindCount = Object.keys(diagnostics.activities).length;
  assert(
    activityKindCount >= 6,
    `${activityKindCount} distinct activities in the planned population: ${JSON.stringify(diagnostics.activities)}`,
  );
  const waitShare = (diagnostics.activities.wait || 0) / diagnostics.figures.planned;
  assert(waitShare < 0.45, `no single activity dominates: waiting is ${(waitShare * 100).toFixed(1)}% of the population`);

  // Determinism: a second build of the same city is identical.
  const rootB = new THREE.Group();
  const ctxB = makeContext(city, { heightAt: flatHeight, hour: 11, camera, root: rootB });
  const firstSignature = JSON.stringify({
    figures: diagnostics.figures.planned,
    parking: diagnostics.parking.planned,
    activities: diagnostics.activities,
    appearance: diagnostics.appearance,
  });
  streetLife.dispose();
  const builtB = streetLife.build(ctxB);
  const secondSignature = JSON.stringify({
    figures: builtB.diagnostics.figures.planned,
    parking: builtB.diagnostics.parking.planned,
    activities: builtB.diagnostics.activities,
    appearance: builtB.diagnostics.appearance,
  });
  assert(firstSignature === secondSignature, 'two builds of the same city are identical');
  streetLife.dispose();

  // The walking population follows the clock too, and the logical floor holds.
  {
    const nightCamera = new THREE.PerspectiveCamera(47, 16 / 9, 0.5, 4200);
    nightCamera.position.set(-6.9, 1.8, -140);
    nightCamera.lookAt(-6.9, 1.7, 200);
    nightCamera.updateMatrixWorld(true);
    const renderer = makeTrafficRenderer(city, nightCamera, flatHeight);
    renderer.timeOfDay = 3;
    const night = new TrafficSim(renderer, city);
    for (let i = 0; i < 200; i += 1) night.update(1 / 30);
    const nightDiagnostics = night.getLocalLifeDiagnostics();
    renderer.timeOfDay = 12;
    const day = new TrafficSim(renderer, city);
    for (let i = 0; i < 200; i += 1) day.update(1 / 30);
    const dayDiagnostics = day.getLocalLifeDiagnostics();
    assert(
      nightDiagnostics.walkerTarget < dayDiagnostics.walkerTarget,
      `the local walker target follows the clock: ${nightDiagnostics.walkerTarget} at 03:00 vs ${dayDiagnostics.walkerTarget} at 12:00`,
    );
    assert(
      nightDiagnostics.walkerTarget >= nightDiagnostics.logicalPedestrianTarget,
      `the gameplay population is never thinned by the clock: ${nightDiagnostics.walkerTarget} >= ${nightDiagnostics.logicalPedestrianTarget}`,
    );
    assert(
      nightDiagnostics.carTarget >= 15 && nightDiagnostics.carTarget < dayDiagnostics.carTarget,
      `traffic thins overnight but never stops: ${nightDiagnostics.carTarget} at 03:00 vs ${dayDiagnostics.carTarget} at 12:00`,
    );
  }

  // Hour scaling actually scales.
  const noon = streetLifeHourFactor(12);
  const small = streetLifeHourFactor(4);
  assert(noon > small * 5, `hour scaling is real: midday ${noon.toFixed(2)} vs 04:00 ${small.toFixed(2)}`);
  assert(
    Math.abs(streetLifeHourFactor(12) - hourFootfall(12)) < 1e-12
    && Math.abs(streetLifeHourFactor(3) - hourFootfall(3)) < 1e-12,
    'the standing and the walking populations share one footfall curve',
  );
  assert(
    STREET_LIFE_LINE_DENSITY > 0.02 && STREET_LIFE_LINE_DENSITY < 0.08,
    `stationary line density ${STREET_LIFE_LINE_DENSITY}/m stays inside the defensible band (0.02-0.08)`,
  );
}

// ---------------------------------------------------------------------------
section('8. limb attachment');

{
  // 8a. Pose-independent closure. A rotating joint is closed only if either the
  // joint point is inside the parent's solid, or the child carries a filler
  // centred on the joint that swallows the parent's terminal rim. Both are
  // invariant under rotation about the joint, so proving them once proves them
  // at every angle - which is stronger than sampling poses and hoping.
  const tiers = [
    { detail: 'mid', radialSegments: 5, label: 'instanced band / 28-90 m' },
    { detail: 'near', radialSegments: 6, label: 'skinned band and street-life near ring' },
  ];
  for (const tier of tiers) {
    let checked = 0;
    let worst = Infinity;
    let worstJoint = '';
    const open = [];
    for (const [parent, child] of ARTICULATING_JOINTS) {
      const closure = jointClosure(parent, child, tier);
      if (!closure.drawn) continue;
      checked += 1;
      if (closure.margin < worst) {
        worst = closure.margin;
        worstJoint = `${parent}->${child}`;
      }
      if (closure.margin < MIN_JOINT_MARGIN_M) {
        open.push(`${parent}->${child} margin ${(closure.margin * 1000).toFixed(1)}mm`
          + ` (parentCover ${(closure.parentCover * 1000).toFixed(1)}mm,`
          + ` childCover ${(closure.childCover * 1000).toFixed(1)}mm,`
          + ` parent rim ${(closure.parentTerminal * 1000).toFixed(1)}mm)`);
      }
    }
    assert(checked >= 10, `${tier.detail}: ${checked} articulating joints carry drawn geometry on both sides`);
    assert(
      open.length === 0,
      `${tier.detail} (${tier.label}): every joint closed by >= ${MIN_JOINT_MARGIN_M * 1000} mm`
      + ` at any angle; worst is ${worstJoint} at ${(worst * 1000).toFixed(1)} mm${open.length ? ` -- OPEN: ${open.join('; ')}` : ''}`,
    );
  }

  // 8b. Every joint filler is centred ON its joint. A filler that has drifted
  // off the joint stops being rotation-invariant, and the guarantee above
  // silently becomes a rest-pose coincidence.
  // "Centred on the joint" to within 6 mm: a shoe's ankle ball is nudged a few
  // millimetres back to sit inside the heel, which does not compromise the
  // rotation invariance the filler exists for.
  const fillers = BODY_PARTS.filter((part) => part.kind === 'ball' && part.offset.every((v) => Math.abs(v) < 0.006));
  const jointBones = new Set(ARTICULATING_JOINTS.map(([, child]) => child));
  const covered = new Set(fillers.map((part) => part.bone).filter((bone) => jointBones.has(bone)));
  assert(
    covered.size >= 12,
    `${covered.size} joints carry a filler centred exactly on the joint: ${[...covered].sort().join(', ')}`,
  );

  // 8c. Kinematic sweep. Pose the rig through every activity, both mirrorings
  // and 32 gait phases, and assert no bone ever leaves its parent's reach. This
  // is what catches a matrix written in the wrong space rather than a hole in
  // the geometry.
  const rig = (() => {
    const root = new THREE.Group();
    const byName = new Map();
    for (const name of PEDESTRIAN_BONE_NAMES) {
      const node = new THREE.Object3D();
      node.name = name;
      const rest = REST_POSE[name];
      node.position.set(rest.offset[0], rest.offset[1], rest.offset[2]);
      byName.set(name, node);
    }
    for (const name of PEDESTRIAN_BONE_NAMES) {
      const rest = REST_POSE[name];
      (rest.parent ? byName.get(rest.parent) : root).add(byName.get(name));
    }
    return { root, byName };
  })();
  const euler = new THREE.Euler(0, 0, 0, 'XYZ');
  const parentWorld = new THREE.Vector3();
  const childWorld = new THREE.Vector3();
  let sweep = 0;
  let worstError = 0;
  let worstPair = '';
  for (const activity of ACTIVITY_POSES) {
    for (const mirrored of [false, true]) {
      for (let step = 0; step < 32; step += 1) {
        const overlay = evaluateActivityPose(activity, step * 0.37, 11 + step, {});
        if (mirrored) mirrorActivityPose(overlay);
        for (const name of PEDESTRIAN_BONE_NAMES) {
          const angles = overlay[name];
          const node = rig.byName.get(name);
          if (angles) {
            euler.set(angles[0], angles[1], angles[2], 'XYZ');
            node.quaternion.setFromEuler(euler);
          } else {
            node.quaternion.identity();
          }
        }
        for (const [sx, sy, sz, budget] of [
          // Uniform scale: the chain must be exact to machine precision.
          [1.06, 1.06, 1.06, BONE_LENGTH_TOLERANCE_M],
          // The crowd's real anisotropic build scaling: a limb may shear by the
          // anisotropy and by nothing else.
          [1.12, 1.10, 1.12, 0],
        ]) {
          rig.root.scale.set(sx, sy, sz);
          rig.root.updateMatrixWorld(true);
          for (const name of PEDESTRIAN_BONE_NAMES) {
            const rest = REST_POSE[name];
            if (!rest.parent) continue;
            rig.byName.get(rest.parent).getWorldPosition(parentWorld);
            rig.byName.get(name).getWorldPosition(childWorld);
            const restLength = Math.hypot(rest.offset[0], rest.offset[1], rest.offset[2]);
            const lo = restLength * Math.min(sx, sy, sz);
            const hi = restLength * Math.max(sx, sy, sz);
            const actual = parentWorld.distanceTo(childWorld);
            const error = Math.max(lo - actual, actual - hi, 0);
            const allowed = budget || BONE_LENGTH_TOLERANCE_M;
            if (error > worstError) {
              worstError = error;
              worstPair = `${rest.parent}->${name}`;
            }
            if (error > allowed) sweep -= 1000000;
            sweep += 1;
          }
        }
      }
    }
  }
  assert(
    worstError <= BONE_LENGTH_TOLERANCE_M && sweep > 0,
    `no limb segment leaves its parent joint at any activity, mirroring or phase:`
    + ` worst deviation beyond the identity's own scale ${worstError.toExponential(2)} m`
    + ` at ${worstPair || 'none'} over ${Math.max(0, sweep)} bone/pose samples`,
  );

  // 8d. The same sweep, but with the locomotion clips driving the rig at every
  // point of the gait cycle, since that is the state most figures are in.
  {
    const clips = buildLocomotionClips();
    const mixer = new THREE.AnimationMixer(rig.root);
    const actions = LOCOMOTION_STATES.map((name) => {
      const action = mixer.clipAction(clips[name]);
      action.play();
      action.setEffectiveWeight(0);
      return action;
    });
    let clipSweep = 0;
    let clipWorst = 0;
    for (let s = 0; s < LOCOMOTION_STATES.length; s += 1) {
      for (const action of actions) action.setEffectiveWeight(0);
      actions[s].setEffectiveWeight(1);
      for (let step = 0; step < 32; step += 1) {
        actions[s].time = (step / 32) * clips[LOCOMOTION_STATES[s]].duration;
        mixer.update(0);
        rig.root.scale.set(1, 1, 1);
        rig.root.updateMatrixWorld(true);
        for (const name of PEDESTRIAN_BONE_NAMES) {
          const rest = REST_POSE[name];
          if (!rest.parent) continue;
          rig.byName.get(rest.parent).getWorldPosition(parentWorld);
          rig.byName.get(name).getWorldPosition(childWorld);
          const restLength = Math.hypot(rest.offset[0], rest.offset[1], rest.offset[2]);
          clipWorst = Math.max(clipWorst, Math.abs(parentWorld.distanceTo(childWorld) - restLength));
          clipSweep += 1;
        }
      }
    }
    // 1 micron, not machine epsilon: three stores keyframe quaternions as
    // float32 and slerps them, so a bone position round-trips to about 1e-8 m.
    // That is rounding, not motion; a bone actually being translated by a clip
    // shows up in millimetres.
    assert(
      clipWorst <= 1e-6,
      `the locomotion clips never translate a bone off its joint: worst ${clipWorst.toExponential(2)} m`
      + ` over ${clipSweep} bone/phase samples`,
    );
  }

  // 8e. Silhouette: the near tier has to actually contain the parts a reviewer
  // named as missing.
  const near = buildInstancedPartGeometries({ detail: 'near', radialSegments: 6 });
  const nearBones = new Set([...near.values()].map((entry) => entry.bone));
  for (const required of ['Neck', 'LeftHand', 'RightHand', 'Head', 'LeftFoot']) {
    assert(nearBones.has(required), `the near tier draws ${required}`);
  }
  let nearTriangles = 0;
  let hasShading = true;
  for (const entry of near.values()) {
    nearTriangles += entry.geometry.getAttribute('position').count / 3;
    if (!entry.geometry.getAttribute('color')) hasShading = false;
  }
  assert(hasShading, 'every near-tier chunk carries baked cavity shading in its colour attribute');
  assert(
    nearTriangles > 380 && nearTriangles < 900,
    `near-tier body is ${nearTriangles} triangles - enough for a face and hands, not enough to be a hero asset`,
  );
  const mid = buildInstancedPartGeometries({ detail: 'mid', radialSegments: 5 });
  let midTriangles = 0;
  for (const entry of mid.values()) midTriangles += entry.geometry.getAttribute('position').count / 3;
  assert(midTriangles < nearTriangles, `the tiers really are tiers: mid ${midTriangles} < near ${nearTriangles}`);
  assert(
    STREET_LIFE_RINGS[0].radius <= 40,
    `the near ring stops at ${STREET_LIFE_RINGS[0].radius} m, so the expensive body is only drawn where a limb is more than a few pixels`,
  );
}

// ---------------------------------------------------------------------------
section('9. locomotion variety');

{
  const sample = 256;
  // `cadenceBias` is deliberately the narrowest of these: cadence and walking
  // speed are physically coupled, so a crowd whose step rates differ by much
  // more than +/-6% at one speed reads as wrong rather than as varied. The
  // shape of the walk is varied by the other five instead.
  const fields = ['strideScale', 'armSwing', 'torsoTwist', 'postureLean', 'cadenceBias', 'headScan'];
  for (const field of fields) {
    const values = [];
    for (let i = 0; i < sample; i += 1) values.push(identityVariation(`walker-${i}`)[field]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = (max - min) / Math.max(1e-6, Math.abs(mean));
    assert(
      Number.isFinite(min) && spread >= 0.10,
      `${field} varies across the crowd: ${min.toFixed(3)}..${max.toFixed(3)} (spread ${(spread * 100).toFixed(0)}% of mean)`,
    );
    let stable = true;
    for (let i = 0; i < 32; i += 1) {
      if (identityVariation(`walker-${i}`)[field] !== identityVariation(`walker-${i}`)[field]) stable = false;
    }
    assert(stable, `${field} is a pure function of the agent id`);
  }

  // Two agents walking at the same speed, at the same point in the cycle, must
  // not be in the same pose. This is the check the "stiff and identical" note
  // asks for: the shared clip is fine, a shared RESULT is not.
  const ground = () => 0;
  const crowd = createCrowdPresentation({ sampleGround: ground });
  const agents = [];
  for (let i = 0; i < 24; i += 1) {
    agents.push({
      id: `w-${i}`, seed: `w-${i}`, x: i * 1.6, y: 0, z: 0,
      heading: 0, speed: 1.4, active: true, pose: 'walk',
    });
  }
  for (let f = 0; f < 40; f += 1) crowd.update(agents, 1 / 30, { x: 0, y: 1.7, z: 0 });
  // Read the skinned actors' bone rotations straight out of the scene graph.
  const poses = [];
  crowd.object3d.traverse((node) => {
    if (node.name !== 'Chest' && node.name !== 'LeftArm') return;
    poses.push(`${node.name}:${node.quaternion.x.toFixed(4)},${node.quaternion.y.toFixed(4)},${node.quaternion.z.toFixed(4)}`);
  });
  const distinctPoses = new Set(poses).size;
  assert(
    poses.length >= 20 && distinctPoses >= poses.length * 0.9,
    `${distinctPoses}/${poses.length} torso and shoulder poses are distinct across a crowd walking at one speed`,
  );
  crowd.dispose();
}

// ---------------------------------------------------------------------------
section('10. materials reach the lighting');

{
  // A crowd material that declares no `envClass` is invisible to the renderer's
  // per-class environment grading: it keeps dry reflectance on a wet street and
  // never receives the graded intensity everything else gets, which is what
  // makes figures standing in shade read as cut-outs pasted on the wall.
  const root = new THREE.Group();
  const ctx = makeContext(gridCity({ blocks: 4, span: 90 }), { heightAt: flatHeight, hour: 11, root });
  const built = streetLife.build(ctx);
  root.add(built.object);
  const materials = new Set();
  root.traverse((node) => {
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      // Only lit materials are graded. The contact-shadow blob is deliberately
      // an unlit MeshBasicMaterial: it is an occlusion decal, not a surface, and
      // giving it an environment response would make shadows glow.
      if (material.isMeshStandardMaterial) materials.add(material);
    }
  });
  const untagged = [...materials].filter((material) => !material.userData?.envClass);
  assert(materials.size > 0, `${materials.size} materials in the pass`);
  assert(
    untagged.length === 0,
    `every street-life material declares an envClass: ${untagged.map((m) => m.name).join(', ') || 'all tagged'}`,
  );
  const classes = new Set([...materials].map((material) => material.userData.envClass));
  for (const declared of classes) {
    assert(
      MATERIAL_CLASSES.includes(declared),
      `'${declared}' is a class the environment grader knows (${MATERIAL_CLASSES.length} declared classes)`,
    );
  }
  const bodyMaterials = [...materials].filter((material) => material.name.startsWith('street-life-')
    && !material.name.includes('car') && !material.name.includes('shadow'));
  assert(
    bodyMaterials.length > 0 && bodyMaterials.every((material) => material.vertexColors === true),
    `all ${bodyMaterials.length} figure materials multiply the baked cavity shading`,
  );
  assert(
    bodyMaterials.every((material) => material.metalness === 0 && material.roughness > 0.5),
    'figure materials stay dielectric and rough - clothing, not car paint',
  );
  streetLife.dispose();

  const crowd = createCrowdPresentation({ sampleGround: () => 0 });
  const crowdMaterials = new Set();
  crowd.object3d.traverse((node) => {
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      if (!material.isMeshStandardMaterial) continue;
      crowdMaterials.add(material);
    }
  });
  const crowdUntagged = [...crowdMaterials].filter((material) => !material.userData?.envClass);
  assert(
    crowdUntagged.length === 0,
    `every crowd material declares an envClass: ${crowdUntagged.map((m) => m.name).join(', ') || 'all tagged'}`,
  );
  crowd.dispose();
}

// ---------------------------------------------------------------------------
section('11. occupancy avoidance');

{
  // A street already carrying props: figures must route around them.
  const propCity = gridCity({ blocks: 4, span: 90 });
  const root = new THREE.Group();
  const geometry = new THREE.CylinderGeometry(0.3, 0.3, 1, 6);
  const props = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 400);
  props.name = 'sidewalk-props';
  const plan = buildStreetscapePlan(propCity, { ...streetLifeSurfaceOptions(propCity), heightAt: flatHeight, inferNodes: true });
  const object3d = new THREE.Object3D();
  let index = 0;
  const bare = planStreetLifeAnchors(plan, { hour: 12, density: buildDistrictDensity(propCity), heightAt: flatHeight });
  // Put a prop exactly on top of every second planned figure.
  for (let i = 0; i < bare.anchors.length && index < 400; i += 2) {
    const anchor = bare.anchors[i];
    object3d.position.set(anchor.x, anchor.y, anchor.z);
    object3d.updateMatrix();
    props.setMatrixAt(index, object3d.matrix);
    index += 1;
  }
  props.count = index;
  root.add(props);
  const occupancy = collectStreetOccupancy(root);
  assert(occupancy.points === index, `harvested ${occupancy.points} existing street occupants from the scene graph`);
  const avoided = planStreetLifeAnchors(plan, {
    hour: 12,
    density: buildDistrictDensity(propCity),
    occupancy,
    heightAt: flatHeight,
  });
  let insideProp = 0;
  for (const anchor of avoided.anchors) {
    if (occupancy.blocked(anchor.x, anchor.z, 0.34)) insideProp += 1;
  }
  assert(insideProp === 0, `no figure is placed inside existing street furniture (${insideProp} of ${avoided.anchors.length})`);
  assert(avoided.rejected.blocked > 0, `${avoided.rejected.blocked} placements were rejected for hitting a prop`);
  assert(avoided.anchors.length > 0, `${avoided.anchors.length} figures still fit around the props`);
  geometry.dispose();
}

// ---------------------------------------------------------------------------
console.log('\nmeasurements');
console.log(`      street-life ${STREET_LIFE_VERSION}, rings ${STREET_LIFE_RINGS.map((r) => `${r.id}<=${r.radius}m/${r.budget}`).join(' ')}`);
console.log(`      kerb parking ${STREET_LIFE_BUDGET.parkedCars} cars inside ${STREET_LIFE_BUDGET.parkingRadius} m`);
console.log(`      ambient walker pool ${STREET_POPULATION.ambientWalkers} on top of the 48 logical pedestrians`);
console.log(`      appearance space: ${signatures.size}/${APPEARANCE_SAMPLE} distinct over ${APPEARANCE_SAMPLE} ids`);

if (failures.length) {
  console.error(`\nFAIL ${failures.length}/${checks}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nPASS ${checks} checks`);
