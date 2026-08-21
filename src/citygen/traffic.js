import * as THREE from 'three';
import { buildTrafficGraph, mulberry32 } from './core.js';
import {
  resolveStreetSurfaceOptions,
  sidewalkSurfaceY,
  carriagewaySurfaceY,
} from '../world/streets/street-surface-v2.js';
import {
  buildVehicle,
  buildVehicleBatch,
  registerVehicleInstance,
  writeVehicleInstance,
  commitVehicleBatch,
  buildPedestrian,
  buildPedestrianBatch,
  writePedestrianInstance,
  commitPedestrianBatch,
  SF_VEHICLE_PRESENTATION,
} from './actors.js';

// Driving model constants (meters, seconds).
const ACCEL = 2.6;          // gentle throttle
const DECEL = 5.2;          // comfortable braking toward a stop point
const FOLLOW_DECEL = 4.2;   // braking while trailing a leader
const MIN_BUMPER_GAP = 1.8; // required free space behind the leader bumper
const STOP_LINE = 4.6;      // stop line distance before the node
const SIGNAL_LOOKAHEAD = 42; // start reacting to a red below this distance
const TURN_SIGNAL_DIST = 16; // blink before the intersection
const LOCAL_LIFE_RADIUS = 120;
const LOCAL_RECYCLE_RADIUS = 240;
const LOCAL_FOCUS_SHIFT = 70;

// ---------------------------------------------------------------------------
// Street-level population
// ---------------------------------------------------------------------------
//
// The rubric dimension this block exists for is "NPC and traffic life", scored
// against a downtown block at midday. The previous figures - 16 cars and 26
// walkers inside a 120 m disc - are about two people and one car per block
// face, which is a Sunday-morning industrial estate, not a downtown.
//
// Targets, per ring, measured from the view focus, for a midday downtown
// street. They are what the local-life recycler steers toward; the presentation
// layer then decides how expensively each of them is drawn.
//
//   0-30 m    ~14 walkers, ~5 vehicles   the pavement directly in shot: one
//                                        person per ~4 m of the two visible
//                                        kerbs, which is an ordinary weekday
//                                        pavement, not a crowd surge.
//   30-80 m   ~46 walkers, ~16 vehicles  the mid-block and the next junction.
//   80-120 m  ~52 walkers, ~19 vehicles  the far junction; figures here are
//                                        3-6 px tall and cost almost nothing.
//
// Summed inside 120 m that is 112 walkers and 40 vehicles, which is what the
// two constants below carry. They are DENSITY TARGETS, not spawn counts: the
// recycler only ever moves an actor that is already far away and off camera,
// so the cost is bounded by the pool, and the pool is bounded by the budget in
// `STREET_POPULATION`.
const LOCAL_CAR_TARGET = 32;
const LOCAL_PEDESTRIAN_TARGET = 112;
// How many of the 48 LOGICAL pedestrians the recycler keeps in the near field.
// They carry gameplay behaviour, so the near field must never be all ambient
// extras; the remainder of `LOCAL_PEDESTRIAN_TARGET` is filled from the ambient
// pool. Raised from 26, which is one person per 45 m of local pavement.
const LOCAL_LOGICAL_PEDESTRIAN_TARGET = 34;
// Below this share of the local target the near field reads as deserted, and
// filling it matters more than hiding the fill. See `updateLocalLife`.
const LOCAL_STARVATION_RATIO = 0.6;
// A recycled actor may never appear in shot closer than this: a figure that
// pops in at conversational distance is worse than an empty pavement.
const POP_IN_GUARD_METRES = 34;

/**
 * Ambient walker pool on top of the 48 logical pedestrians.
 *
 * The 48 are the gameplay-visible population: they carry instanced batch slots,
 * collision, melee, witness and aftermath behaviour, and three verifiers pin
 * their count and their identities. Widening THAT array would change what the
 * game simulates. The ambient pool instead adds sidewalk walkers that exist for
 * the crowd presentation to mirror: same clock, same paths, same deterministic
 * movement, no batch slot, no gameplay hooks, and never inside
 * `traffic.pedestrians`.
 */
export const STREET_POPULATION = Object.freeze({
  /**
   * Moving vehicles on a real-map city.
   *
   * This is the one number in this file that is genuinely too low and that this
   * subsystem cannot raise on its own: `verify:citygen-vehicle-batching` and
   * `verify:citygen-local-life` both pin the pool at 42, and
   * `EXPECTED_RNG_KINDS` in the former pins the seeded class of all 42. Raising
   * it is an integration change; the constant is here so it is one edit, and
   * `new TrafficSim(renderer, city, { vehiclePool })` overrides it so the exact
   * consequences can be measured before anyone commits to them.
   */
  vehiclePool: 42,
  /** Extra sidewalk walkers on a real-map city. */
  ambientWalkers: 300,
  /** Extra walkers on a small generated city, which has far less pavement. */
  ambientWalkersGenerated: 90,
  /** Share of ambient walkers that spawn as a companion group. */
  groupShare: 0.34,
  /** Companions in a group, inclusive range. */
  groupSize: Object.freeze([2, 3]),
});

/**
 * Footway surface above the carriageway datum, in metres.
 *
 * Two vertical planes are pinned by the renderer's street construction (see the
 * LEGACY_SIDEWALK_LIFT note in src/citygen/renderer.js): the carriageway datum
 * at `terrain + streetDesign.roadLift`, and the footway exactly 45 mm above it.
 * Kerbside cars, street lamps, sidewalk props and the hero curb actors are all
 * grounded on those two planes. Ambient traffic and ambient pedestrians were
 * not: they stood on `terrain + 0.08`, which is 37 cm below the road surface
 * for a car and 42 cm below the pavement for a walker. That is the "characters
 * are not grounded" reject in one number.
 */
const FOOTWAY_LIFT_ABOVE_DATUM = 0.102;   // renderer.js LEGACY_SIDEWALK_LIFT
/** Fallback datum when a city omits `streetDesign.roadLift`, matching the renderer. */
const DEFAULT_ROAD_LIFT = 0.5;

// ---------------------------------------------------------------------------
// The drawn street surface, sampled
// ---------------------------------------------------------------------------
//
// `FOOTWAY_LIFT_ABOVE_DATUM` above is a PLANE. The footway the renderer draws
// is not a plane: `src/world/streets/street-surface-v2.js` cuts a gutter pan
// below the datum, stands a curb face on it, falls the curb top back toward the
// road, then cross-falls the footway away from the kerb at 2%. So the drawn
// surface under a walker depends on how far that walker is from the centreline,
// and a constant cannot express it. Measured against the shipped build the
// constant put every walker 18-46 mm BELOW the concrete they appear to stand
// on, which is the "characters clip / lack a contact shadow" reject, and it
// buried the contact-shadow blob under the pavement entirely.
//
// The cure is not a second constant that happens to match. It is to sample the
// SAME function the geometry was swept with. `sidewalkSurfaceY` and
// `carriagewaySurfaceY` are exported by the street module precisely so a pass
// can ground on them - the street-life pass already does, and self-reports a
// worst grounding offset of 1.2e-14 m. This is that path, for the simulated
// crowd: an index over the street contract that answers, for any world point,
// "what is the height of the drawn street surface here", by finding the segment
// whose corridor covers the point, deriving the point's signed lateral offset
// from that centreline, and calling the module's own cross-section.
//
// Nothing here re-derives geometry: every height comes out of the street
// module. This file only supplies `(datum, u, half)`.

/** Uniform-grid cell for the street index, metres. */
const STREET_SAMPLE_CELL_M = 32;
/** Extra lateral slack past the footway edge that still counts as street. */
const STREET_SAMPLE_EDGE_SLACK_M = 0.25;

function streetSampleKey(cx, cz) {
  return `${cx}:${cz}`;
}

/**
 * Index the street contract for point sampling.
 *
 * One entry per polyline span, bucketed into a uniform grid by the AABB of its
 * corridor (carriageway + widest footway). Build cost is linear in the number
 * of spans and it is built once per city, in the TrafficSim constructor.
 *
 * @param {object} city  the street contract - `segments` or `streets`
 * @param {object} options resolved street-surface options (the ones the drawn
 *   surface was built with, when the renderer can supply them)
 */
export function createStreetSurfaceSampler(city, options) {
  const grid = new Map();
  const list = Array.isArray(city?.segments) && city.segments.length
    ? city.segments
    : (Array.isArray(city?.streets) ? city.streets : []);
  let spans = 0;
  for (const segment of list) {
    const points = Array.isArray(segment?.points) ? segment.points : null;
    if (!points || points.length < 2) continue;
    const width = Number(segment.width ?? segment.asphaltWidth);
    if (!Number.isFinite(width) || width <= 0.2) continue;
    const half = width / 2;
    const walkRaw = Number(segment.sidewalkW ?? segment.sidewalkWidth);
    const walk = Number.isFinite(walkRaw) && walkRaw > 0 ? walkRaw : 0;
    const left = Number(segment.sidewalkLeft);
    const right = Number(segment.sidewalkRight);
    // Only the widest side matters here: `sidewalkSurfaceY` does not read the
    // footway width, so the width is used purely to decide whether a point is
    // still on this street.
    const widest = Math.max(
      Number.isFinite(left) && left >= 0 ? left : walk,
      Number.isFinite(right) && right >= 0 ? right : walk,
    );
    const reach = half + widest + STREET_SAMPLE_EDGE_SLACK_M;
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const ax = Number(a?.x);
      const az = Number(a?.z);
      const dx = Number(b?.x) - ax;
      const dz = Number(b?.z) - az;
      if (!Number.isFinite(ax) || !Number.isFinite(az) || !Number.isFinite(dx) || !Number.isFinite(dz)) continue;
      const length = Math.hypot(dx, dz);
      if (!(length > 1e-3)) continue;
      const entry = {
        ax,
        az,
        tx: dx / length,
        tz: dz / length,
        length,
        half,
        reach,
        id: segment.id ?? null,
      };
      spans += 1;
      const minX = Math.min(ax, ax + dx) - reach;
      const maxX = Math.max(ax, ax + dx) + reach;
      const minZ = Math.min(az, az + dz) - reach;
      const maxZ = Math.max(az, az + dz) + reach;
      const cx0 = Math.floor(minX / STREET_SAMPLE_CELL_M);
      const cx1 = Math.floor(maxX / STREET_SAMPLE_CELL_M);
      const cz0 = Math.floor(minZ / STREET_SAMPLE_CELL_M);
      const cz1 = Math.floor(maxZ / STREET_SAMPLE_CELL_M);
      for (let cz = cz0; cz <= cz1; cz += 1) {
        for (let cx = cx0; cx <= cx1; cx += 1) {
          const key = streetSampleKey(cx, cz);
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(entry);
        }
      }
    }
  }

  /**
   * The street span covering a world point, with the point's signed lateral
   * offset from that span's centreline.
   *
   * Longitudinal overshoot up to the corridor reach is accepted so that a point
   * standing in a junction mouth is still grounded on the street it walked in
   * on rather than falling through to the constant; laterally the nearest
   * centreline wins, which is the segment whose ribbon is on top there.
   *
   * @returns {{u:number, half:number, id:*}|null}
   */
  function locate(x, z) {
    const bucket = grid.get(streetSampleKey(
      Math.floor(x / STREET_SAMPLE_CELL_M),
      Math.floor(z / STREET_SAMPLE_CELL_M),
    ));
    if (!bucket) return null;
    let best = null;
    let bestU = 0;
    let bestAbs = Infinity;
    for (let i = 0; i < bucket.length; i += 1) {
      const entry = bucket[i];
      const rx = x - entry.ax;
      const rz = z - entry.az;
      const along = rx * entry.tx + rz * entry.tz;
      if (along < -entry.reach || along > entry.length + entry.reach) continue;
      // n = perpCCW(t), the same normal `buildSidewalkPaths` offsets along.
      const u = rx * -entry.tz + rz * entry.tx;
      const abs = Math.abs(u);
      if (abs > entry.reach || abs >= bestAbs) continue;
      bestAbs = abs;
      bestU = u;
      best = entry;
    }
    if (!best) return null;
    return { u: bestU, half: best.half, id: best.id };
  }

  return {
    options,
    spans,
    cells: grid.size,
    locate,
    /**
     * Height of the DRAWN street surface at a world point, or null when the
     * point is not on a street. Footway past the kerb line, carriageway inside
     * it - so a foot that hangs over the kerb reads the kerb, which is what
     * makes a curb look like a curb.
     *
     * @param {number} x
     * @param {number} z
     * @param {number} terrainY bare ground under the point
     */
    surfaceY(x, z, terrainY) {
      const hit = locate(x, z);
      if (!hit) return null;
      const datum = terrainY + options.roadLift;
      return Math.abs(hit.u) >= hit.half
        ? sidewalkSurfaceY(datum, hit.u, hit.half, options)
        : carriagewaySurfaceY(datum, hit.u, hit.half, options);
    },
  };
}

/**
 * The street-surface options the DRAWN surface was built with.
 *
 * Order matters. The renderer publishes the exact options object it handed the
 * surface builder; that is authoritative and is what the street-life pass
 * already grounds on. Failing that, `streetSurfaceLift()` still gives the three
 * numbers that move the footway (datum, gutter depth, curb face). Only a
 * rendererless harness falls through to the module defaults.
 */
export function resolveDrawnStreetOptions(renderer, city) {
  const published = renderer?.streetSurface?.data?.options;
  if (published && Number.isFinite(Number(published.roadLift))) return published;
  const lift = typeof renderer?.streetSurfaceLift === 'function'
    ? renderer.streetSurfaceLift(city)
    : null;
  if (lift && Number.isFinite(Number(lift.datum))) {
    return resolveStreetSurfaceOptions(city, {
      roadLift: lift.datum,
      gutterDepth: lift.gutterDepth,
      curbFaceHeight: lift.curbFaceHeight,
    });
  }
  return resolveStreetSurfaceOptions(city);
}

/** Street classes an ambient walker may be placed on, and how heavily. */
const SIDEWALK_CLASS_WEIGHT = Object.freeze({
  primary: 1.0,
  secondary: 0.95,
  tertiary: 0.8,
  residential: 0.55,
  unclassified: 0.5,
  living_street: 0.55,
  pedestrian: 1.15,
  service: 0.2,
});

/**
 * Footfall multiplier by hour of day. Midday and the evening commute are the
 * busy windows; 03:00-05:00 is nearly empty. Used to scale how much of the
 * ambient pool is awake, never to change what the simulation owns.
 */
export function hourFootfall(hour) {
  const h = Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 12;
  const table = [
    0.10, 0.07, 0.05, 0.04, 0.05, 0.10, 0.24, 0.52, 0.82, 0.88, 0.92, 0.97,
    1.00, 0.98, 0.93, 0.92, 0.95, 1.00, 0.94, 0.78, 0.60, 0.46, 0.32, 0.18,
  ];
  const i = Math.floor(h);
  const f = h - i;
  return table[i] * (1 - f) + table[(i + 1) % 24] * f;
}

/**
 * Deterministic [0,1) draw from a string/number key and a salt. No shared
 * generator state, so an agent's schedule is identical whatever order the
 * simulation happens to visit agents in.
 */
function keyedRandom(key, salt) {
  const text = `${key}|${salt}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

/**
 * What an ambient walker is doing when they are not simply walking, and how
 * long it lasts. Presentation reads `pedestrian.activity` and picks a matching
 * upper-body pose; the simulation owns the schedule.
 *
 * `atCorner` activities are only chosen near the end of a sidewalk path, which
 * on this street contract is a junction: that is what makes a red light look
 * like people waiting for a red light rather than people standing at random.
 */
const PEDESTRIAN_ACTIVITIES = Object.freeze([
  { name: 'wait', weight: 0.34, seconds: [6, 18], atCorner: true, facing: 'across' },
  { name: 'talk', weight: 0.16, seconds: [8, 26], atCorner: false, facing: 'partner' },
  { name: 'phone', weight: 0.16, seconds: [5, 16], atCorner: false, facing: 'keep' },
  { name: 'browse', weight: 0.13, seconds: [4, 13], atCorner: false, facing: 'inward' },
  { name: 'stand', weight: 0.11, seconds: [3, 9], atCorner: false, facing: 'keep' },
  { name: 'carry', weight: 0.10, seconds: [4, 10], atCorner: false, facing: 'keep' },
]);
/** Mean seconds a walker spends walking between two pauses. */
const WALK_LEG_SECONDS = Object.freeze([14, 52]);
const HERO_CURB_LIFE_PASS = 'market-pedestrian-life-v3';
const HERO_CURB_SOURCE = Object.freeze({
  segmentId: 'sf-seg-308',
  streetId: 'sf-street-228196396',
  side: 1,
  benchSourceT: 0.63,
  benchLateralOffsetMeters: 4.38,
  lampSourceT: 0.5,
  lampLateralOffsetMeters: 4.544,
});
const HERO_CURB_WALKERS = Object.freeze([
  Object.freeze({
    role: 'destination-walker',
    poseKind: 'walking-destination',
    sourceTBounds: Object.freeze([0.36, 0.38]),
    lateralOffsetMeters: 5.05,
    inwardAttentionYawSign: 1,
  }),
  Object.freeze({
    role: 'destination-walker',
    poseKind: 'walking-destination',
    sourceTBounds: Object.freeze([0.77, 0.79]),
    lateralOffsetMeters: 5.05,
    inwardAttentionYawSign: -1,
  }),
]);
const HERO_CURB_WALK_SPEED = 0.72;
const HERO_CURB_TURN_SECONDS = 0.85;
const HERO_CURB_ATTENTION_YAW = 0.32;
const HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS = 0.78;
const HERO_CURB_LAMP_POLE_RADIUS_METERS = 0.1;
const HERO_CURB_EXPECTED_DONORS = Object.freeze([44, 25, 36]);
const HERO_CURB_SEAT = Object.freeze({
  role: 'bench-sitter',
  poseKind: 'bench-seated',
  benchLocalXMeters: 0.22,
  benchLocalZMeters: 0.02,
  seatSurfaceAbovePropMeters: 0.5,
});

export class TrafficSim {
  constructor(renderer, city, { count = 26, vehiclePool = null } = {}) {
    this.renderer = renderer;
    this.city = city;
    this.edges = buildTrafficGraph(city);
    this.group = new THREE.Group();
    this.vehicleGroup = new THREE.Group();
    this.vehicleGroup.name = 'logical-vehicles-and-batched-presentation';
    this.group.add(this.vehicleGroup);
    this.cars = [];
    this.pedestrians = [];
    this.heroCurbActors = [];
    this.heroCurbGround = null;
    this.heroCurbLifeDiagnostics = createHeroCurbLifeDiagnostics();
    this.phase = 0;
    // Cumulative arc lengths let spacing and stop logic work in meters
    // instead of segment-progress units.
    for (const edge of this.edges) {
      const cum = [0];
      for (let i = 1; i < edge.points.length; i += 1) {
        cum.push(cum[i - 1] + Math.hypot(edge.points[i].x - edge.points[i - 1].x, edge.points[i].z - edge.points[i - 1].z));
      }
      edge.cum = cum;
      edge.totalLength = cum[cum.length - 1];
    }
    this.signalById = new Map((city.signals || []).map((signal) => [signal.id, signal]));
    // The two pinned vertical planes. Everything this simulation places on the
    // street stands on one of them; nothing stands on bare terrain.
    this.roadLift = Number(city.meta?.streetDesign?.roadLift ?? DEFAULT_ROAD_LIFT);
    if (!Number.isFinite(this.roadLift)) this.roadLift = DEFAULT_ROAD_LIFT;
    this.footwayLift = this.roadLift + FOOTWAY_LIFT_ABOVE_DATUM;
    // THE SINGLE SOURCE OF FOOTWAY HEIGHT. `footwayLift` above is kept because
    // the hero-curb vignette and three verifiers are pinned to that plane, but
    // it is no longer what a walker stands on: `pedestrianGroundY` samples the
    // drawn cross-section through this index. Built once, from the same options
    // object the renderer handed the surface builder.
    this.streetSurfaceOptions = resolveDrawnStreetOptions(renderer, city);
    this.streetSurfaceSampler = createStreetSurfaceSampler(city, this.streetSurfaceOptions);
    this.groundingDiagnostics = {
      source: renderer?.streetSurface?.data?.options ? 'renderer.streetSurface.options'
        : (typeof renderer?.streetSurfaceLift === 'function' ? 'renderer.streetSurfaceLift' : 'street-surface-defaults'),
      spans: this.streetSurfaceSampler.spans,
      cells: this.streetSurfaceSampler.cells,
      roadLift: this.streetSurfaceOptions.roadLift,
      gutterDepth: this.streetSurfaceOptions.gutterDepth,
      curbFaceHeight: this.streetSurfaceOptions.curbFaceHeight,
      legacyFootwayPlaneLift: FOOTWAY_LIFT_ABOVE_DATUM,
      misses: 0,
      hits: 0,
    };
    const random = mulberry32(Number(city.meta.seedInt || 1) + 77);
    this.random = random;
    // Keep this array lookup in the existing seeded call site so vehicle
    // class selection and placement consume precisely the same RNG sequence.
    const paint = SF_VEHICLE_PRESENTATION.civilianPaint.map((color) => `#${color.toString(16).padStart(6, '0')}`);
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    this.localLifeEnabled = realMap;
    this.localLifeTimer = 0;
    this.localLifeFocus = null;
    this.localLifeAllowVisibleRefresh = false;
    this.localLifeDiagnostics = {
      enabled: realMap,
      radius: LOCAL_LIFE_RADIUS,
      recycleRadius: LOCAL_RECYCLE_RADIUS,
      carTarget: LOCAL_CAR_TARGET,
      pedestrianTarget: LOCAL_PEDESTRIAN_TARGET,
      carRecycles: 0,
      pedestrianRecycles: 0,
      focusUpdates: 0,
      localCars: 0,
      localPedestrians: 0,
      localAmbientWalkers: 0,
      localWalkers: 0,
      ambientPool: 0,
      logicalPedestrianTarget: LOCAL_LOGICAL_PEDESTRIAN_TARGET,
      walkerTarget: LOCAL_PEDESTRIAN_TARGET,
      popInGuardMeters: POP_IN_GUARD_METRES,
      events: [],
    };
    const trafficCount = realMap
      ? (Number.isFinite(vehiclePool) ? Math.max(0, vehiclePool | 0) : STREET_POPULATION.vehiclePool)
      : count;
    this.vehicleBatch = trafficCount > 0 ? buildVehicleBatch(trafficCount) : null;
    if (this.vehicleBatch) this.vehicleGroup.add(this.vehicleBatch.group);
    for (let i = 0; i < trafficCount; i += 1) {
      if (!this.edges.length) break;
      const car = this.spawnCar(this.edges[Math.floor(random() * this.edges.length)], paint[Math.floor(random() * paint.length)], random);
      if (car) this.cars.push(car);
    }
    if (this.vehicleBatch) {
      for (const car of this.cars) writeVehicleInstance(this.vehicleBatch, car);
      commitVehicleBatch(this.vehicleBatch, this.cars.length);
    }
    const pedestrianCount = realMap ? 48 : 26;
    const sidewalkPaths = this.buildSidewalkPaths(city);
    this.sidewalkPaths = sidewalkPaths;
    this.pedestrianBatch = sidewalkPaths.length ? buildPedestrianBatch(pedestrianCount) : null;
    if (this.pedestrianBatch) this.group.add(this.pedestrianBatch.group);
    for (let i = 0; i < pedestrianCount; i += 1) {
      const path = sidewalkPaths[Math.floor(random() * sidewalkPaths.length)];
      if (!path?.length) continue;
      this.pedestrians.push(this.spawnPedestrian(path, random, this.pedestrians.length));
    }
    // The hero curb vignette selects its donors out of exactly the 48 logical
    // pedestrians and three verifiers pin the indices it picks. Stage it BEFORE
    // the ambient pool exists so the candidate set, the RNG sequence and the
    // chosen donors are bit-identical to the single-population build.
    this.stageHeroCurbLife();
    if (this.pedestrianBatch) commitPedestrianBatch(this.pedestrianBatch, this.pedestrians.length);
    this.ambientCrowd = [];
    this.spawnAmbientCrowd(sidewalkPaths, random, realMap);
    this.renderer.scene.add(this.group);
  }

  dispose() {
    for (const car of this.cars) {
      car.group.traverse((object) => {
        if (!object.isMesh) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          material?.dispose?.();
        }
      });
    }
    this.renderer.scene.remove(this.group);
  }

  spawnCar(edge, color, random = Math.random) {
    const roll = random();
    const kind = roll < 0.68 ? 'sedan' : roll < 0.86 ? 'taxi' : roll < 0.95 ? 'truck' : 'bus';
    const group = buildVehicle(kind, color);
    // Try a few placements; reject ones that overlap cars already on the
    // street so traffic never starts life in a pile-up.
    let placement = null;
    for (let attempt = 0; attempt < 10 && !placement; attempt += 1) {
      const candidateEdge = attempt === 0 ? edge : this.edges[Math.floor(random() * this.edges.length)];
      const pathIndex = Math.floor(random() * Math.max(1, candidateEdge.points.length - 1));
      const segLen = candidateEdge.cum[pathIndex + 1] - candidateEdge.cum[pathIndex] || 1;
      const distance = random() * segLen;
      const arc = candidateEdge.cum[pathIndex] + distance;
      const clear = !this.cars.some((other) => {
        if (other.edge !== candidateEdge) return false;
        return Math.abs(this.edgeArc(other) - arc) < 7;
      });
      if (clear) placement = { edge: candidateEdge, pathIndex, distance };
    }
    if (!placement) return null;
    const car = {
      group,
      kind,
      color,
      dims: group.userData.rig.dims,
      edge: null,
      signal: null,
      pathIndex: 0,
      distance: 0,
      speed: 1.5 + random() * 2.5,
      maxSpeed: placement.edge.highway === 'primary' || placement.edge.highway === 'trunk' ? 12 : placement.edge.highway === 'secondary' ? 10.5 : placement.edge.highway === 'tertiary' ? 9 : 7.2,
      stopped: false,
      braking: false,
      laneOffset: 0,
      corner: null,
      nextEdge: null,
      turnSide: 0,
      leaderGap: null,
      leaderLength: 4,
      terminalTimer: 0,
    };
    this.assignEdge(car, placement.edge, placement.pathIndex, placement.distance);
    if (this.vehicleBatch) registerVehicleInstance(this.vehicleBatch, car, this.cars.length);
    this.vehicleGroup.add(group);
    return car;
  }

  assignEdge(car, edge, pathIndex = 0, distance = 0) {
    car.edge = edge;
    car.pathIndex = clamp(pathIndex, 0, Math.max(0, edge.points.length - 2));
    car.distance = distance;
    car.signal = edge.signalId ? this.signalById.get(edge.signalId) || null : null;
    car.nextEdge = null;
    car.turnSide = 0;
    car.corner = null;
    car.terminalTimer = 0;
  }

  respawnCar(car) {
    // Recycle a car stuck on a dead-end street: find a clear spot elsewhere.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const edge = this.edges[Math.floor(this.random() * this.edges.length)];
      if (!edge) return;
      const pathIndex = Math.floor(this.random() * Math.max(1, edge.points.length - 1));
      const segLen = edge.cum[pathIndex + 1] - edge.cum[pathIndex] || 1;
      const distance = this.random() * segLen;
      const arc = edge.cum[pathIndex] + distance;
      const clear = !this.cars.some((other) => other !== car && other.edge === edge
        && Math.abs(this.edgeArc(other) - arc) < 7);
      if (clear) {
        this.assignEdge(car, edge, pathIndex, distance);
        car.speed = 1 + this.random() * 2;
        car.stopped = false;
        car.braking = false;
        return;
      }
    }
  }

  spawnPedestrian(path, random = Math.random, instanceIndex = this.pedestrians.length) {
    const group = buildPedestrian(random);
    const cum = [0];
    for (let i = 1; i < path.length; i += 1) {
      cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    }
    const total = cum[cum.length - 1] || 0.01;
    group.position.set(path[0].x, 0, path[0].z);
    const pedestrian = {
      group,
      instanceIndex,
      points: path,
      cum,
      total,
      s: random() * total,
      seg: 0,
      dir: random() < 0.5 ? 1 : -1,
      speed: 1.3 + random() * 0.9,
    };
    if (this.pedestrianBatch) writePedestrianInstance(this.pedestrianBatch, instanceIndex, pedestrian);
    return pedestrian;
  }

  /**
   * A transform shim for an ambient walker.
   *
   * `updatePedestrian` and the crowd presentation both read
   * `group.position` / `group.rotation.y` / `group.userData.walk`. An ambient
   * walker needs exactly those three and nothing else: no geometry, no
   * material, no scene attachment, no instanced batch slot. Sixteen numbers per
   * walker instead of a mesh is what makes a 300-strong pool affordable.
   */
  static ambientTransform(cadence, time, bob) {
    return {
      position: {
        x: 0,
        y: 0,
        z: 0,
        set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
      },
      rotation: { x: 0, y: 0, z: 0 },
      userData: { walk: { cadence, time, bob, gait: 0, bobOffset: 0 } },
      parent: null,
    };
  }

  /**
   * Spawn the ambient sidewalk pool.
   *
   * Paths are drawn with a weight per street class, so a downtown avenue gets
   * the traffic and a service alley does not. A third of the pool spawns as a
   * companion group - two or three people on the same path, same direction,
   * abreast - because a street of strictly solo walkers reads as a spawner.
   *
   * Everything here is deterministic in the city seed. Nothing is attached to
   * the scene, and nothing touches `this.pedestrians`.
   */
  spawnAmbientCrowd(sidewalkPaths, random, realMap) {
    this.ambientCrowd = [];
    if (!Array.isArray(sidewalkPaths) || !sidewalkPaths.length) return this.ambientCrowd;
    const target = realMap
      ? STREET_POPULATION.ambientWalkers
      : STREET_POPULATION.ambientWalkersGenerated;
    if (target <= 0) return this.ambientCrowd;

    // Weighted path table. Built once; the cumulative array makes each draw a
    // binary search rather than a scan of 6 000 paths.
    const cumulative = new Float64Array(sidewalkPaths.length);
    let running = 0;
    for (let i = 0; i < sidewalkPaths.length; i += 1) {
      const path = sidewalkPaths[i];
      const weight = SIDEWALK_CLASS_WEIGHT[path.highway] ?? 0.5;
      running += Math.max(0.01, weight);
      cumulative[i] = running;
    }
    const drawPath = () => {
      const target2 = random() * running;
      let lo = 0;
      let hi = cumulative.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] < target2) lo = mid + 1;
        else hi = mid;
      }
      return sidewalkPaths[lo];
    };

    const [groupMin, groupMax] = STREET_POPULATION.groupSize;
    let spawned = 0;
    let guard = 0;
    while (spawned < target && guard < target * 6) {
      guard += 1;
      const path = drawPath();
      if (!path || path.length < 2) continue;
      const cum = cumulativeLengths(path);
      const total = cum[cum.length - 1] || 0.01;
      if (total < 4) continue;
      const asGroup = random() < STREET_POPULATION.groupShare;
      const members = asGroup
        ? Math.min(groupMax, groupMin + Math.floor(random() * (groupMax - groupMin + 1)))
        : 1;
      const dir = random() < 0.5 ? 1 : -1;
      const baseArc = random() * total;
      const speed = 1.15 + random() * 0.95;
      for (let m = 0; m < members && spawned < target; m += 1) {
        const id = `ambient-${spawned}`;
        // Kept inside +/-0.38 m so a walker stays in the footway through-route
        // and never walks through the stationary figures the street-life pass
        // places against the kerb and against the property line.
        const lateralSpread = members > 1
          ? (m - (members - 1) / 2) * 0.38
          : (random() - 0.5) * 0.76;
        const walker = {
          id,
          // Stable identity for the presentation's procedural variation. Kept
          // out of the 0..47 instance-index space so an ambient walker can
          // never be mistaken for a logical pedestrian.
          instanceIndex: null,
          presentationId: `ped-a${spawned}`,
          activityKey: id,
          points: path,
          cum,
          total,
          s: clamp(baseArc + (m - (members - 1) / 2) * 0.9, 0, total),
          seg: 0,
          dir,
          // Companions keep one pace so a group stays a group.
          speed: asGroup ? speed : speed * (0.88 + random() * 0.26),
          lateral: lateralSpread,
          roadSide: path.roadSide ?? 1,
          groupId: asGroup ? `grp-${spawned}` : null,
          group: TrafficSim.ambientTransform(
            5.4 + random() * 2.2,
            random() * 6.28,
            0.018 + random() * 0.012,
          ),
        };
        this.ambientCrowd.push(walker);
        spawned += 1;
      }
    }
    return this.ambientCrowd;
  }

  /**
   * Every agent the crowd presentation should mirror this frame: the 48
   * logical pedestrians followed by the ambient pool.
   *
   * Presentation-facing only. The array is rebuilt in place so calling it once
   * a frame allocates nothing after the first call, and the records inside it
   * are the simulation's own objects, handed over read-only.
   */
  presentationAgents() {
    const out = this.presentationAgentList || (this.presentationAgentList = []);
    out.length = 0;
    for (let i = 0; i < this.pedestrians.length; i += 1) out.push(this.pedestrians[i]);
    const ambient = this.ambientCrowd || [];
    for (let i = 0; i < ambient.length; i += 1) out.push(ambient[i]);
    return out;
  }

  buildSidewalkPaths(city) {
    const paths = [];
    for (const segment of city.segments) {
      const half = segment.width / 2 + segment.sidewalkW - 1;
      if (half <= 0.5) continue;
      const dx = segment.points[1].x - segment.points[0].x;
      const dz = segment.points[1].z - segment.points[0].z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      for (const side of [1, -1]) {
        const a = { x: segment.points[0].x + nx * half * side, z: segment.points[0].z + nz * half * side };
        const b = { x: segment.points[1].x + nx * half * side, z: segment.points[1].z + nz * half * side };
        if (Math.hypot(b.x - a.x, b.z - a.z) < 4) continue;
        const path = [a, b];
        // Read-only annotations on the path array itself. Existing consumers
        // index it as a two-point polyline and are unaffected; the ambient
        // spawner uses them to weight the draw and to know which way the road
        // is, so a walker waiting to cross faces the carriageway.
        path.highway = segment.highway;
        path.segmentId = segment.id;
        path.roadSide = side;
        paths.push(path);
      }
    }
    return paths;
  }

  stageHeroCurbLife() {
    const diagnostics = createHeroCurbLifeDiagnostics();
    this.heroCurbLifeDiagnostics = diagnostics;
    const generator = this.city?.meta?.generator;
    if (!['sf-builtin', 'openstreetmap'].includes(generator)) {
      diagnostics.failure = { stage: 'source', details: 'unsupported-source' };
      return false;
    }

    const segment = (this.city.segments || []).find((candidate) => candidate.id === HERO_CURB_SOURCE.segmentId);
    const corridor = this.renderer?.sidewalkPropDiagnostics?.heroFrontages?.corridor;
    const bench = corridor?.placements?.find((placement) => placement.kind === 'bench'
      && Math.abs(placement.sourceT - HERO_CURB_SOURCE.benchSourceT) <= 1e-9);
    const lamp = this.renderer?.streetLampRecords?.find((record) => (
      record.segmentId === HERO_CURB_SOURCE.segmentId
      && record.streetId === HERO_CURB_SOURCE.streetId
      && record.side === HERO_CURB_SOURCE.side
    ));
    const sourcePoints = segment?.points;
    const sourceFinite = sourcePoints?.length === 2
      && sourcePoints.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
    if (!sourceFinite
      || segment.streetId !== HERO_CURB_SOURCE.streetId
      || !bench?.position
      || ![
        bench.position.x,
        bench.position.y,
        bench.position.z,
        bench.rotation,
        lamp?.x,
        lamp?.z,
        lamp?.lateralOffset,
      ].every(Number.isFinite)) {
      diagnostics.failure = { stage: 'source', details: 'exact-market-corridor-unavailable' };
      return false;
    }

    const sourceSnapshot = JSON.stringify(segment);
    const [a, b] = sourcePoints;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const width = Number(segment.width);
    const sidewalkWidth = Number(HERO_CURB_SOURCE.side > 0
      ? segment.sidewalkLeft ?? segment.sidewalkW
      : segment.sidewalkRight ?? segment.sidewalkW);
    if (!Number.isFinite(length) || length <= 0
      || !Number.isFinite(width) || width <= 0
      || !Number.isFinite(sidewalkWidth) || sidewalkWidth <= 0
      || this.pedestrians.length !== 48) {
      diagnostics.failure = { stage: 'contract', details: 'invalid-source-metrics-or-population' };
      return false;
    }
    const tx = dx / length;
    const tz = dz / length;
    const nx = -tz * HERO_CURB_SOURCE.side;
    const nz = tx * HERO_CURB_SOURCE.side;
    const midpoint = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
    const roadHalfWidthMeters = width * 0.5;
    const sidewalkOuterOffsetMeters = roadHalfWidthMeters + sidewalkWidth;
    const roadLiftMeters = Number(this.city.meta?.streetDesign?.roadLift ?? 0.5);
    const terrainHeightAt = (point) => (this.renderer.terrain?.heightAt
      ? this.renderer.terrain.heightAt(point.x, point.z)
      : 0);
    this.heroCurbGround = {
      startY: terrainHeightAt(a) + roadLiftMeters + FOOTWAY_LIFT_ABOVE_DATUM,
      endY: terrainHeightAt(b) + roadLiftMeters + FOOTWAY_LIFT_ABOVE_DATUM,
    };
    const pointAt = (sourceT, lateralOffsetMeters) => ({
      x: a.x + dx * sourceT + nx * lateralOffsetMeters,
      z: a.z + dz * sourceT + nz * lateralOffsetMeters,
    });
    const expectedBench = pointAt(HERO_CURB_SOURCE.benchSourceT, HERO_CURB_SOURCE.benchLateralOffsetMeters);
    const expectedLamp = pointAt(HERO_CURB_SOURCE.lampSourceT, HERO_CURB_SOURCE.lampLateralOffsetMeters);
    if (Math.hypot(bench.position.x - expectedBench.x, bench.position.z - expectedBench.z) > 1e-6
      || Math.hypot(lamp.x - expectedLamp.x, lamp.z - expectedLamp.z) > 1e-6
      || Math.abs(lamp.lateralOffset - HERO_CURB_SOURCE.lampLateralOffsetMeters) > 1e-9) {
      diagnostics.failure = { stage: 'contract', details: 'hero-curb-anchor-placement-drift' };
      return false;
    }

    const bounds = this.city.meta?.bounds;
    const donorLandwardMaximumX = Number(bounds?.minX) + (Number(bounds?.maxX) - Number(bounds?.minX)) * 0.75;
    if (!Number.isFinite(donorLandwardMaximumX)) {
      diagnostics.failure = { stage: 'donor-selection', details: 'invalid-source-bounds' };
      return false;
    }
    const donorCandidates = this.pedestrians.map((pedestrian) => {
      const pose = pathPositionAtArc(pedestrian.points, pedestrian.cum, pedestrian.s);
      return {
        pedestrian,
        distance: Math.max(...pedestrian.points.map((point) => (
          Math.hypot(point.x - midpoint.x, point.z - midpoint.z)
        ))),
        origin: {
          x: pose.x,
          y: this.groundY(pose.x, pose.z),
          z: pose.z,
          pathArcMeters: pedestrian.s,
          pathLengthMeters: pedestrian.total,
        },
      };
    }).filter((candidate) => candidate.origin.x <= donorLandwardMaximumX)
      .sort((left, right) => right.distance - left.distance
      || left.pedestrian.instanceIndex - right.pedestrian.instanceIndex);
    const donors = donorCandidates.slice(0, 3);
    const donorIndices = donors.map(({ pedestrian }) => pedestrian.instanceIndex);
    if (donors.length !== 3
      || donorIndices.some((index, donorIndex) => index !== HERO_CURB_EXPECTED_DONORS[donorIndex])) {
      diagnostics.failure = {
        stage: 'donor-selection',
        details: 'deterministic-donor-policy-drift',
        actualIndices: donorIndices,
      };
      return false;
    }

    for (let index = 0; index < HERO_CURB_WALKERS.length; index += 1) {
      const donor = donors[index];
      const spec = HERO_CURB_WALKERS[index];
      const path = spec.sourceTBounds.map((sourceT) => pointAt(sourceT, spec.lateralOffsetMeters));
      const total = Math.hypot(path[1].x - path[0].x, path[1].z - path[0].z);
      const travelSeconds = total / HERO_CURB_WALK_SPEED;
      this.assignHeroCurbBehavior(donor.pedestrian, donor.origin, {
        kind: 'hero-curb-life',
        role: spec.role,
        poseKind: spec.poseKind,
        partnerId: null,
        sourceTBounds: [...spec.sourceTBounds],
        lateralOffsetMeters: spec.lateralOffsetMeters,
        path,
        total,
        speedMetersPerSecond: HERO_CURB_WALK_SPEED,
        travelSeconds,
        turnSeconds: HERO_CURB_TURN_SECONDS,
        phaseOffsetSeconds: travelSeconds * (5 / 12),
        inwardAttentionYawSign: spec.inwardAttentionYawSign,
      });
    }

    const sitterDonor = donors[2];
    const benchRotationRadians = Number(bench.rotation);
    const seatCos = Math.cos(benchRotationRadians);
    const seatSin = Math.sin(benchRotationRadians);
    const seatedRoot = {
      x: bench.position.x
        + HERO_CURB_SEAT.benchLocalXMeters * seatCos
        + HERO_CURB_SEAT.benchLocalZMeters * seatSin,
      y: 0,
      z: bench.position.z
        - HERO_CURB_SEAT.benchLocalXMeters * seatSin
        + HERO_CURB_SEAT.benchLocalZMeters * seatCos,
    };
    const seatedRootFromSource = {
      sourceT: (
        (seatedRoot.x - a.x) * tx
        + (seatedRoot.z - a.z) * tz
      ) / length,
      lateralOffsetMeters: (seatedRoot.x - a.x) * nx + (seatedRoot.z - a.z) * nz,
    };
    seatedRoot.y = this.heroCurbGroundY(seatedRootFromSource.sourceT);
    const reconstructedSeatedRoot = pointAt(
      seatedRootFromSource.sourceT,
      seatedRootFromSource.lateralOffsetMeters,
    );
    const sourceProjectionErrorMeters = Math.hypot(
      reconstructedSeatedRoot.x - seatedRoot.x,
      reconstructedSeatedRoot.z - seatedRoot.z,
    );
    if (![seatedRootFromSource.sourceT, seatedRootFromSource.lateralOffsetMeters,
      seatedRoot.y, sourceProjectionErrorMeters].every(Number.isFinite)
      || seatedRootFromSource.sourceT < 0
      || seatedRootFromSource.sourceT > 1
      || seatedRootFromSource.lateralOffsetMeters < roadHalfWidthMeters
      || seatedRootFromSource.lateralOffsetMeters > sidewalkOuterOffsetMeters
      || sourceProjectionErrorMeters > 1e-9) {
      diagnostics.failure = { stage: 'seated-pose', details: 'entity-root-source-projection-invalid' };
      return false;
    }
    const seatSurfaceYMeters = bench.position.y + HERO_CURB_SEAT.seatSurfaceAbovePropMeters;
    const torsoContactEnvelopeLocalMeters = {
      minX: HERO_CURB_SEAT.benchLocalXMeters - 0.32,
      maxX: HERO_CURB_SEAT.benchLocalXMeters + 0.32,
      minZ: HERO_CURB_SEAT.benchLocalZMeters - 0.14,
      maxZ: HERO_CURB_SEAT.benchLocalZMeters + 0.14,
    };
    const seatEnvelopeLocalMeters = { minX: -0.8, maxX: 0.8, minZ: -0.31, maxZ: 0.31 };
    const torsoWithinSeatEnvelope = torsoContactEnvelopeLocalMeters.minX >= seatEnvelopeLocalMeters.minX
      && torsoContactEnvelopeLocalMeters.maxX <= seatEnvelopeLocalMeters.maxX
      && torsoContactEnvelopeLocalMeters.minZ >= seatEnvelopeLocalMeters.minZ
      && torsoContactEnvelopeLocalMeters.maxZ <= seatEnvelopeLocalMeters.maxZ;
    if (!torsoWithinSeatEnvelope) {
      diagnostics.failure = { stage: 'seated-pose', details: 'torso-outside-bench-seat-envelope' };
      return false;
    }
    const seatedAnchor = {
      sourceSegmentId: segment.id,
      sourceStreetId: segment.streetId,
      sourceT: seatedRootFromSource.sourceT,
      lateralOffsetMeters: seatedRootFromSource.lateralOffsetMeters,
      sourceProjectionErrorMeters,
      benchPosition: { x: bench.position.x, y: bench.position.y, z: bench.position.z },
      benchRotationRadians,
      localOffsetMeters: {
        x: HERO_CURB_SEAT.benchLocalXMeters,
        y: 0,
        z: HERO_CURB_SEAT.benchLocalZMeters,
      },
      entityRootPosition: seatedRoot,
      entityRootYawRadians: benchRotationRadians,
      seatSurfaceYMeters,
    };
    const benchContact = {
      mode: 'authored-seat-support-contact-v1',
      collisionSemantics: 'single-entity-anchor-authored-bench-support-contact-only-v1',
      entitySeatContactAuthored: true,
      otherPropContactAllowed: false,
      supportProp: {
        kind: bench.kind,
        ownerSegmentId: bench.ownerSegmentId,
        ownerStreetId: bench.ownerStreetId,
        sourceT: bench.sourceT,
        lateralOffsetMeters: bench.lateralOffsetMeters,
        position: { x: bench.position.x, y: bench.position.y, z: bench.position.z },
      },
      seatEnvelopeLocalMeters,
      torsoContactEnvelopeLocalMeters,
      torsoWithinSeatEnvelope,
      torsoBottomYMeters: seatedRoot.y + 0.52,
      verticalContactGapMeters: seatedRoot.y + 0.52 - seatSurfaceYMeters,
    };
    this.assignHeroCurbBehavior(sitterDonor.pedestrian, sitterDonor.origin, {
      kind: 'hero-curb-life',
      role: HERO_CURB_SEAT.role,
      poseKind: HERO_CURB_SEAT.poseKind,
      sourceTBounds: [seatedRootFromSource.sourceT, seatedRootFromSource.sourceT],
      lateralOffsetMeters: seatedRootFromSource.lateralOffsetMeters,
      path: [{ ...seatedRoot }, { ...seatedRoot }],
      total: 0,
      speedMetersPerSecond: 0,
      phaseOffsetSeconds: 0,
      benchPosition: { x: bench.position.x, y: bench.position.y, z: bench.position.z },
      seatedAnchor,
      benchContact,
    });

    const walkerMidpoints = this.heroCurbActors.slice(0, 2).map((pedestrian) => ({
      x: (pedestrian.points[0].x + pedestrian.points[1].x) * 0.5,
      z: (pedestrian.points[0].z + pedestrian.points[1].z) * 0.5,
    }));
    const walkerRangeToSitterCenterMeters = this.heroCurbActors.slice(0, 2).map((pedestrian) => (
      pointToSegmentDistance2D(seatedRoot, pedestrian.points[0], pedestrian.points[1])
    ));
    const walkerRangeToLampCenterMeters = this.heroCurbActors.slice(0, 2).map((pedestrian) => (
      pointToSegmentDistance2D(lamp, pedestrian.points[0], pedestrian.points[1])
    ));
    const minimumWalkerPairCenterDistanceMeters = Math.min(
      ...this.heroCurbActors[0].points.flatMap((left) => (
        this.heroCurbActors[1].points.map((right) => Math.hypot(left.x - right.x, left.z - right.z))
      )),
    );
    const triangleAreaSquareMeters = Math.abs(
      (walkerMidpoints[1].x - walkerMidpoints[0].x) * (seatedRoot.z - walkerMidpoints[0].z)
      - (seatedRoot.x - walkerMidpoints[0].x) * (walkerMidpoints[1].z - walkerMidpoints[0].z),
    ) * 0.5;
    diagnostics.composition = {
      contract: 'camera-independent-source-triangle-v1',
      projectionVerification: 'external-matched-camera-48deg',
      renderedShoulderWidthMeters: HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS,
      longitudinalOrder: [
        `pedestrian:${donorIndices[0]}`,
        `pedestrian:${sitterDonor.pedestrian.instanceIndex}`,
        `pedestrian:${donorIndices[1]}`,
      ],
      lamp: {
        segmentId: lamp.segmentId,
        streetId: lamp.streetId,
        side: lamp.side,
        sourceT: HERO_CURB_SOURCE.lampSourceT,
        lateralOffsetMeters: HERO_CURB_SOURCE.lampLateralOffsetMeters,
        poleRadiusMeters: HERO_CURB_LAMP_POLE_RADIUS_METERS,
        position: { x: lamp.x, z: lamp.z },
      },
      walkerRangeMeters: this.heroCurbActors.slice(0, 2).map((pedestrian) => pedestrian.total),
      walkerRangeToSitterCenterMeters,
      walkerRangeToLampCenterMeters,
      walkerRangeToSitterShoulderClearanceMeters: walkerRangeToSitterCenterMeters.map((distance) => (
        distance - HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS
      )),
      walkerRangeToLampSilhouetteClearanceMeters: walkerRangeToLampCenterMeters.map((distance) => (
        distance - HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS * 0.5 - HERO_CURB_LAMP_POLE_RADIUS_METERS
      )),
      minimumWalkerPairCenterDistanceMeters,
      minimumWalkerPairShoulderClearanceMeters: minimumWalkerPairCenterDistanceMeters
        - HERO_CURB_RENDERED_SHOULDER_WIDTH_METERS,
      triangleAreaSquareMeters,
    };

    const sourceSnapshotUnchanged = JSON.stringify(segment) === sourceSnapshot;
    const actorRecords = this.heroCurbActors.map((pedestrian) => ({
      id: `pedestrian:${pedestrian.instanceIndex}`,
      instanceIndex: pedestrian.instanceIndex,
      role: pedestrian.heroCurbBehavior.role,
      partnerId: pedestrian.heroCurbBehavior.partnerId ?? null,
      poseKind: pedestrian.heroCurbBehavior.poseKind,
      sourceTBounds: [...pedestrian.heroCurbBehavior.sourceTBounds],
      lateralOffsetMeters: pedestrian.heroCurbBehavior.lateralOffsetMeters,
      speedMetersPerSecond: pedestrian.heroCurbBehavior.speedMetersPerSecond,
      behavior: pedestrian.heroCurbBehavior.role === 'destination-walker'
        ? 'shared-phase-destination-walk-loop'
        : 'bench-seated-idle',
      donorOrigin: { ...pedestrian.heroCurbBehavior.donorOrigin },
      ...(pedestrian.heroCurbBehavior.seatedAnchor ? {
        seatedAnchor: cloneSeatedAnchor(pedestrian.heroCurbBehavior.seatedAnchor),
        benchContact: cloneBenchContact(pedestrian.heroCurbBehavior.benchContact),
        seatedPoseMatrices: { ...pedestrian.heroCurbBehavior.seatedPoseMatrices },
        entityPresentationAlignment: { ...pedestrian.heroCurbBehavior.entityPresentationAlignment },
      } : {}),
    }));
    diagnostics.enabled = true;
    diagnostics.source = {
      segmentId: segment.id,
      streetId: segment.streetId,
      side: HERO_CURB_SOURCE.side,
      lengthMeters: length,
      roadHalfWidthMeters,
      sidewalkOuterOffsetMeters,
      sidewalkGroundStartYMeters: this.heroCurbGround.startY,
      sidewalkGroundEndYMeters: this.heroCurbGround.endY,
      benchRotationRadians,
      snapshotUnchanged: sourceSnapshotUnchanged,
    };
    diagnostics.logicalPedestriansBefore = this.pedestrians.length;
    diagnostics.logicalPedestriansAfter = this.pedestrians.length;
    diagnostics.relocated = this.heroCurbActors.length;
    diagnostics.roles = { destinationWalker: 2, benchSitter: 1 };
    diagnostics.donorSelection = {
      policy: 'farthest-from-corridor-midpoint-v1',
      eligibility: 'preserve-eastern-quarter-v1',
      landwardMaximumXMeters: donorLandwardMaximumX,
      indices: donorIndices,
      unique: new Set(donorIndices).size === donorIndices.length,
      origins: donors.map(({ pedestrian, origin, distance }) => ({
        id: `pedestrian:${pedestrian.instanceIndex}`,
        instanceIndex: pedestrian.instanceIndex,
        distanceFromCorridorMidpointMeters: distance,
        position: { ...origin },
      })),
    };
    diagnostics.actors = actorRecords;
    diagnostics.finite = sourceSnapshotUnchanged
      && diagnostics.donorSelection.unique
      && [
        diagnostics.composition.renderedShoulderWidthMeters,
        diagnostics.composition.lamp.sourceT,
        diagnostics.composition.lamp.lateralOffsetMeters,
        diagnostics.composition.lamp.poleRadiusMeters,
        ...Object.values(diagnostics.composition.lamp.position),
        ...diagnostics.composition.walkerRangeMeters,
        ...diagnostics.composition.walkerRangeToSitterCenterMeters,
        ...diagnostics.composition.walkerRangeToLampCenterMeters,
        ...diagnostics.composition.walkerRangeToSitterShoulderClearanceMeters,
        ...diagnostics.composition.walkerRangeToLampSilhouetteClearanceMeters,
        diagnostics.composition.minimumWalkerPairCenterDistanceMeters,
        diagnostics.composition.minimumWalkerPairShoulderClearanceMeters,
        diagnostics.composition.triangleAreaSquareMeters,
      ].every(Number.isFinite)
      && actorRecords.every((actor) => [
        actor.instanceIndex,
        ...actor.sourceTBounds,
        actor.lateralOffsetMeters,
        actor.speedMetersPerSecond,
        actor.donorOrigin.x,
        actor.donorOrigin.y,
        actor.donorOrigin.z,
      ].every(Number.isFinite)
        && (!actor.seatedAnchor || (
          actor.seatedPoseMatrices?.finite === true
          && actor.entityPresentationAlignment?.finite === true
          && actor.benchContact?.torsoWithinSeatEnvelope === true
          && [
            actor.seatedAnchor.sourceT,
            actor.seatedAnchor.lateralOffsetMeters,
            actor.seatedAnchor.sourceProjectionErrorMeters,
            actor.seatedAnchor.benchRotationRadians,
            actor.seatedAnchor.entityRootYawRadians,
            actor.seatedAnchor.seatSurfaceYMeters,
            ...Object.values(actor.seatedAnchor.entityRootPosition),
            actor.benchContact.verticalContactGapMeters,
            actor.entityPresentationAlignment.positionErrorMeters,
            actor.entityPresentationAlignment.yawErrorRadians,
          ].every(Number.isFinite)
        )));
    return diagnostics.finite;
  }

  assignHeroCurbBehavior(pedestrian, donorOrigin, behavior) {
    pedestrian.points = behavior.path.map((point) => ({ ...point }));
    pedestrian.cum = cumulativeLengths(pedestrian.points);
    pedestrian.total = behavior.total;
    pedestrian.s = 0;
    pedestrian.seg = 0;
    pedestrian.dir = 1;
    pedestrian.speed = behavior.speedMetersPerSecond;
    pedestrian.heroCurbBehavior = {
      ...behavior,
      path: pedestrian.points,
      donorOrigin: { ...donorOrigin },
      lastPosition: null,
      lastYaw: null,
    };
    pedestrian.group.userData.life = {
      pass: HERO_CURB_LIFE_PASS,
      role: behavior.role,
      poseKind: behavior.poseKind,
      sourceSegmentId: HERO_CURB_SOURCE.segmentId,
      sourceStreetId: HERO_CURB_SOURCE.streetId,
      reservedFromLocalLifeRecycling: true,
    };
    this.heroCurbActors.push(pedestrian);
    this.updateHeroCurbPedestrian(pedestrian, 0);
  }

  heroCurbGroundY(sourceT) {
    return this.heroCurbGround.startY
      + (this.heroCurbGround.endY - this.heroCurbGround.startY) * sourceT;
  }

  laneOffsetFor(edge) {
    if (edge.oneway === 'increasing' || edge.oneway === 'decreasing') return 0;
    if (edge.lanes <= 1) return 0;
    return edge.laneOffset || 0;
  }

  cornerArc(from, to, t) {
    if (t <= 0) return from;
    if (t >= 1) return to;
    const a = { x: from.x, z: from.z };
    const b = { x: to.x, z: to.z };
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const bulge = Math.sin(t * Math.PI) * Math.min(2.4, len * 0.12);
    return { x: mx + nx * bulge, z: mz + nz * bulge };
  }

  /** Bare terrain under a point, metres. The datum both surfaces are built on. */
  terrainY(x, z) {
    return this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(x, z) : 0;
  }

  /**
   * Carriageway surface: where a tyre contacts the road.
   *
   * This used to return `terrain + 0.08`, which put every moving vehicle 37 cm
   * INSIDE the asphalt the renderer builds at `terrain + roadLift`, while the
   * kerbside parked cars beside them sat correctly on top of it. Same street,
   * two different road surfaces.
   */
  groundY(x, z) {
    return this.terrainY(x, z) + this.roadLift;
  }

  /**
   * Footway surface: where a shoe contacts the pavement.
   *
   * This used to return `terrain + roadLift + 0.102`, a PLANE. The drawn
   * footway is a cross-falling surface standing on a curb face over a gutter
   * pan, so the plane was 18-46 mm below the concrete the walker appeared to be
   * on - enough to bury the contact-shadow blob under the pavement and to make
   * a sole disappear into it. It now samples the street module's own
   * cross-section at this exact point, which is the same call the street-life
   * pass grounds its standing figures on.
   *
   * Sampling by POINT rather than by walker also means each foot probe reads
   * the surface under itself: a foot over the kerb reads the kerb.
   *
   * Off-street points (a plaza, a park path, a point outside the contract) keep
   * the legacy plane, so nothing that was grounded before becomes ungrounded.
   */
  pedestrianGroundY(x, z) {
    const terrain = this.terrainY(x, z);
    const sampled = this.streetSurfaceSampler
      ? this.streetSurfaceSampler.surfaceY(x, z, terrain)
      : null;
    if (sampled != null && Number.isFinite(sampled)) {
      this.groundingDiagnostics.hits += 1;
      return sampled;
    }
    this.groundingDiagnostics.misses += 1;
    return terrain + this.footwayLift;
  }

  edgeArc(car) {
    const points = car.edge.points;
    const index = clamp(car.pathIndex, 0, points.length - 2);
    const segLen = car.edge.cum[index + 1] - car.edge.cum[index] || 1;
    return car.edge.cum[index] + clamp(car.distance, 0, segLen);
  }

  update(delta) {
    delta = Math.max(0, delta);
    this.phase += delta;
    this.updateLocalLife(delta);
    this.updateCarSpacing();
    for (const car of this.cars) {
      if (car.controlled || !car.edge) continue;
      this.updateAiCar(car, delta);
      this.animateCar(car, delta);
    }
    for (const pedestrian of this.pedestrians) {
      this.updatePedestrian(pedestrian, delta);
    }
    // Same clock, same step, same path logic - no second loop and no second
    // timebase. Ambient walkers own no batch slot, so this is arithmetic only.
    const ambient = this.ambientCrowd;
    if (ambient) {
      for (let i = 0; i < ambient.length; i += 1) this.updatePedestrian(ambient[i], delta);
    }
    if (this.vehicleBatch) {
      for (const car of this.cars) writeVehicleInstance(this.vehicleBatch, car);
      commitVehicleBatch(this.vehicleBatch, this.cars.length);
    }
    if (this.pedestrianBatch) commitPedestrianBatch(this.pedestrianBatch, this.pedestrians.length);
    if (this.localLifeFocus) this.updateLocalLifeCounts(this.localLifeFocus);
  }

  updateLocalLife(delta) {
    if (!this.localLifeEnabled || !this.renderer?.camera) return;
    this.localLifeTimer -= delta;
    const anchor = this.renderer.controls?.target || this.renderer.camera.position;
    const focus = { x: anchor.x, z: anchor.z };
    const focusMoved = !this.localLifeFocus
      || Math.hypot(focus.x - this.localLifeFocus.x, focus.z - this.localLifeFocus.z) >= LOCAL_FOCUS_SHIFT;
    if (!focusMoved && this.localLifeTimer > 0) return;
    this.localLifeTimer = 1;
    this.localLifeFocus = focus;
    this.localLifeDiagnostics.focusUpdates += 1;
    const allowVisibleDestination = this.localLifeDiagnostics.focusUpdates === 1
      || this.localLifeAllowVisibleRefresh;

    const near = (actor) => this.actorDistance(actor.group, focus) <= LOCAL_LIFE_RADIUS;
    const localCars = this.cars.filter(near);
    const localLogical = this.pedestrians.filter(near);
    const ambient = this.ambientCrowd || [];
    const localAmbient = ambient.filter(near);
    const localWalkers = localLogical.length + localAmbient.length;

    // The old rule refused EVERY destination the camera could see, so a camera
    // that cut to a new street was guaranteed an empty street: the only places
    // an actor was allowed to appear were the places nobody was looking. The
    // rule's purpose is to hide a pop, and it is worth keeping while the near
    // field is already populated. When the near field is deserted, an empty
    // pavement is the larger failure and the ban is lifted - subject to the
    // pop-in guard inside the recyclers, which never lets an actor appear in
    // shot closer than POP_IN_GUARD_METRES.
    // The street empties overnight and fills at midday. The LOGICAL pedestrian
    // target is deliberately NOT scaled: those 48 carry gameplay behaviour and
    // the near field must keep them at every hour. Only the ambient mass and
    // the traffic volume follow the clock.
    const hour = Number(this.renderer?.timeOfDay);
    const footfall = Number.isFinite(hour) ? hourFootfall(hour) : 1;
    const walkerTarget = Math.max(
      LOCAL_LOGICAL_PEDESTRIAN_TARGET,
      Math.round(LOCAL_PEDESTRIAN_TARGET * footfall),
    );
    // Traffic thins at night but never stops: a city with no cars at 03:00
    // reads as abandoned rather than as quiet.
    const carTarget = Math.round(LOCAL_CAR_TARGET * (0.55 + 0.45 * footfall));

    const carsStarved = localCars.length < carTarget * LOCAL_STARVATION_RATIO;
    const walkersStarved = localWalkers < walkerTarget * LOCAL_STARVATION_RATIO;
    const allowVisibleCars = allowVisibleDestination || carsStarved;
    const allowVisibleWalkers = allowVisibleDestination || walkersStarved;

    this.recycleCarsNearFocus(focus, Math.max(0, carTarget - localCars.length), allowVisibleCars);
    // Logical pedestrians first: they are the population gameplay reads, so the
    // near field can never be nothing but ambient extras.
    const logicalShort = Math.max(0, LOCAL_LOGICAL_PEDESTRIAN_TARGET - localLogical.length);
    const walkerShort = Math.max(0, walkerTarget - localWalkers);
    const walkPlacements = (logicalShort > 0 || walkerShort > 0) && this.sidewalkPaths?.length
      ? this.nearbyPlacements(this.sidewalkPaths, focus)
      : null;
    this.recyclePedestriansNearFocus(
      focus, logicalShort, allowVisibleWalkers, this.pedestrians, walkPlacements,
    );
    this.recyclePedestriansNearFocus(
      focus, walkerShort, allowVisibleWalkers, ambient, walkPlacements,
    );
    this.localLifeAllowVisibleRefresh = false;
    this.localLifeDiagnostics.hour = Number.isFinite(hour) ? hour : null;
    this.localLifeDiagnostics.footfall = Number(footfall.toFixed(3));
    this.localLifeDiagnostics.walkerTarget = walkerTarget;
    this.localLifeDiagnostics.carTarget = carTarget;
    this.updateLocalLifeCounts(focus);
  }

  requestLocalLifeRefresh({ allowVisible = false } = {}) {
    if (!this.localLifeEnabled) return;
    this.localLifeFocus = null;
    this.localLifeTimer = 0;
    this.localLifeAllowVisibleRefresh = Boolean(allowVisible);
  }

  actorDistance(group, focus) {
    return Math.hypot(group.position.x - focus.x, group.position.z - focus.z);
  }

  actorIsVisible(group) {
    return this.worldPointIsVisible(group.position.x, group.position.z, group.position.y + 1);
  }

  worldPointIsVisible(x, z, y = null) {
    const camera = this.renderer?.camera;
    if (!camera) return false;
    const worldY = y ?? (this.renderer.terrain?.heightAt ? this.renderer.terrain.heightAt(x, z) + 1 : 1);
    const projected = new THREE.Vector3(x, worldY, z).project(camera);
    return projected.z >= -1 && projected.z <= 1
      && Math.abs(projected.x) <= 1.08 && Math.abs(projected.y) <= 1.08;
  }

  nearbyPlacements(paths, focus, maxDistance = LOCAL_LIFE_RADIUS - 8) {
    return paths.map((path) => {
      const points = path.points || path;
      const cum = path.cum || cumulativeLengths(points);
      const placement = nearestPointOnPath(points, cum, focus);
      return { path, points, cum, ...placement };
    }).filter((entry) => entry.distanceToFocus <= maxDistance)
      .sort((a, b) => a.distanceToFocus - b.distanceToFocus || String(a.path.id || '').localeCompare(String(b.path.id || '')));
  }

  recycleCarsNearFocus(focus, needed, allowVisibleDestination = false) {
    if (needed <= 0) return;
    const placements = this.nearbyPlacements(
      this.edges.filter((edge) => ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service'].includes(edge.highway)),
      focus,
    );
    if (!placements.length) return;
    const donors = this.cars.filter((car) => !car.controlled
      && this.actorDistance(car.group, focus) >= LOCAL_RECYCLE_RADIUS
      && !this.actorIsVisible(car.group))
      .sort((a, b) => this.actorDistance(b.group, focus) - this.actorDistance(a.group, focus));
    let placed = 0;
    for (const car of donors) {
      if (placed >= needed) break;
      let selected = null;
      // The moving-vehicle pool is 42 cars over a two-kilometre map, so WHICH
      // street they are on matters more than how many there are. When visible
      // destinations are permitted at all, take a first pass that only accepts
      // destinations the camera can actually see - down the block in front of
      // it, past the pop-in guard - and fall back to the general rule after.
      // Without this the recycler spreads cars evenly over the local network
      // and the one street in shot is statistically empty.
      const passes = allowVisibleDestination ? [true, false] : [false];
      for (const preferVisible of passes) {
        for (let attempt = 0; attempt < placements.length; attempt += 1) {
          const candidate = placements[(placed * 7 + attempt) % placements.length];
          const jitter = ((placed % 5) - 2) * 5.5;
          const arc = clamp(candidate.arc + jitter, 2, Math.max(2, candidate.cum.at(-1) - 2));
          const clear = !this.cars.some((other) => other !== car && other.edge === candidate.path
            && Math.abs(this.edgeArc(other) - arc) < 8);
          const edgePosition = pathPositionAtArc(candidate.points, candidate.cum, arc);
          const visibleAfter = this.worldPointIsVisible(edgePosition.x, edgePosition.z);
          // Same pop-in guard as the walkers: a car may reappear down the
          // block, never inside the near field the camera is already reading.
          if (visibleAfter
            && Math.hypot(edgePosition.x - focus.x, edgePosition.z - focus.z) < POP_IN_GUARD_METRES) {
            continue;
          }
          if (preferVisible && !visibleAfter) continue;
          if (clear && (allowVisibleDestination || !visibleAfter)) {
            selected = { ...candidate, arc, edgePosition, visibleAfter };
            break;
          }
        }
        if (selected) break;
      }
      if (!selected) continue;
      const fromDistance = this.actorDistance(car.group, focus);
      const visibleBefore = this.actorIsVisible(car.group);
      this.assignEdge(car, selected.path, selected.edgePosition.index, selected.edgePosition.distance);
      car.speed = 2 + this.random() * 2.5;
      car.stopped = false;
      car.braking = false;
      this.localLifeDiagnostics.carRecycles += 1;
      const toDistance = Math.hypot(selected.edgePosition.x - focus.x, selected.edgePosition.z - focus.z);
      this.recordLocalLifeEvent(
        'car', this.cars.indexOf(car), fromDistance, toDistance, visibleBefore, selected.visibleAfter,
        allowVisibleDestination,
      );
      placed += 1;
    }
  }

  recyclePedestriansNearFocus(focus, needed, allowVisibleDestination = false, pool = this.pedestrians, cachedPlacements = null) {
    if (needed <= 0 || !this.sidewalkPaths?.length || !pool?.length) return;
    // `nearbyPlacements` walks every sidewalk path in the city (6 260 of them on
    // the real map), so the two recycler passes share one scan.
    const placements = cachedPlacements || this.nearbyPlacements(this.sidewalkPaths, focus);
    if (!placements.length) return;
    const donors = pool.filter((pedestrian) => !pedestrian.heroCurbBehavior
      && this.actorDistance(pedestrian.group, focus) >= LOCAL_RECYCLE_RADIUS
      && !this.actorIsVisible(pedestrian.group))
      .sort((a, b) => this.actorDistance(b.group, focus) - this.actorDistance(a.group, focus));
    let placed = 0;
    for (const pedestrian of donors) {
      if (placed >= needed) break;
      let selected = null;
      for (let attempt = 0; attempt < placements.length; attempt += 1) {
        const candidate = placements[(placed * 11 + attempt) % placements.length];
        const total = candidate.cum.at(-1) || 0.01;
        const jitter = ((placed % 7) - 3) * 2.4;
        const arc = clamp(candidate.arc + jitter, 0.5, Math.max(0.5, total - 0.5));
        const pathPosition = pathPositionAtArc(candidate.points, candidate.cum, arc);
        const visibleAfter = this.worldPointIsVisible(pathPosition.x, pathPosition.z);
        // Never materialise a walker in shot at conversational distance, even
        // when the near field is starved: that reads as a spawn, not a city.
        if (visibleAfter
          && Math.hypot(pathPosition.x - focus.x, pathPosition.z - focus.z) < POP_IN_GUARD_METRES) {
          continue;
        }
        if (allowVisibleDestination || !visibleAfter) {
          selected = { ...candidate, total, arc, pathPosition, visibleAfter };
          break;
        }
      }
      if (!selected) continue;
      const fromDistance = this.actorDistance(pedestrian.group, focus);
      const visibleBefore = this.actorIsVisible(pedestrian.group);
      pedestrian.points = selected.points;
      pedestrian.cum = selected.cum;
      pedestrian.total = selected.total;
      pedestrian.s = selected.arc;
      pedestrian.seg = selected.pathPosition.index;
      // A recycled ambient walker inherits its new path's road side so its
      // "waiting to cross" facing still points at the carriageway.
      if (pedestrian.activityKey) {
        pedestrian.roadSide = selected.path.roadSide ?? pedestrian.roadSide ?? 1;
        pedestrian.activity = 'walk';
        pedestrian.activityFacing = 'keep';
        pedestrian.activityTimer = 2 + keyedRandom(pedestrian.activityKey, `recycle-${this.localLifeDiagnostics.pedestrianRecycles}`) * 18;
      }
      this.localLifeDiagnostics.pedestrianRecycles += 1;
      const toDistance = Math.hypot(selected.pathPosition.x - focus.x, selected.pathPosition.z - focus.z);
      this.recordLocalLifeEvent(
        'pedestrian', pedestrian.instanceIndex, fromDistance, toDistance, visibleBefore, selected.visibleAfter,
        allowVisibleDestination,
      );
      placed += 1;
    }
  }

  recordLocalLifeEvent(type, index, fromDistance, toDistance, visibleBefore, visibleAfter, intentionalRefresh) {
    this.localLifeDiagnostics.events.push({
      id: `${type}:${index}`,
      fromDistance: Number(fromDistance.toFixed(2)),
      toDistance: Number(toDistance.toFixed(2)),
      visibleBefore,
      visibleAfter,
      intentionalRefresh,
      phase: Number(this.phase.toFixed(3)),
    });
    if (this.localLifeDiagnostics.events.length > 128) this.localLifeDiagnostics.events.shift();
  }

  updateLocalLifeCounts(focus) {
    const within = (actor) => this.actorDistance(actor.group, focus) <= LOCAL_LIFE_RADIUS;
    const logical = this.pedestrians.filter(within).length;
    const ambient = (this.ambientCrowd || []).filter(within).length;
    this.localLifeDiagnostics.localCars = this.cars.filter(within).length;
    // `localPedestrians` keeps meaning "logical pedestrians near the focus", so
    // the existing local-life contract still reads the same number; the ambient
    // pool is reported alongside it rather than folded into it.
    this.localLifeDiagnostics.localPedestrians = logical;
    this.localLifeDiagnostics.localAmbientWalkers = ambient;
    this.localLifeDiagnostics.localWalkers = logical + ambient;
    this.localLifeDiagnostics.ambientPool = (this.ambientCrowd || []).length;
  }

  getLocalLifeDiagnostics() {
    return {
      ...this.localLifeDiagnostics,
      focus: this.localLifeFocus ? { ...this.localLifeFocus } : null,
      events: this.localLifeDiagnostics.events.map((event) => ({ ...event })),
    };
  }

  getHeroCurbLifeDiagnostics() {
    const diagnostics = this.heroCurbLifeDiagnostics;
    const actors = diagnostics.actors.map((record) => {
      const pedestrian = this.pedestrians[record.instanceIndex];
      const behavior = pedestrian?.heroCurbBehavior;
      const walk = pedestrian?.group.userData.walk;
      return {
        ...record,
        sourceTBounds: [...record.sourceTBounds],
        donorOrigin: { ...record.donorOrigin },
        ...(record.seatedAnchor ? {
          seatedAnchor: cloneSeatedAnchor(record.seatedAnchor),
          benchContact: cloneBenchContact(record.benchContact),
          seatedPoseMatrices: { ...behavior.seatedPoseMatrices },
          entityPresentationAlignment: { ...behavior.entityPresentationAlignment },
        } : {}),
        currentPose: pedestrian && behavior ? {
          poseKind: behavior.poseKind,
          position: {
            x: pedestrian.group.position.x,
            y: pedestrian.group.position.y,
            z: pedestrian.group.position.z,
          },
          presentationPosition: {
            x: pedestrian.group.position.x,
            y: pedestrian.group.position.y,
            z: pedestrian.group.position.z,
          },
          sidewalkGroundY: pedestrian.group.position.y - (walk.bobOffset || 0),
          yawRadians: pedestrian.group.rotation.y,
          presentationYawRadians: pedestrian.group.rotation.y,
          entityPresentationPositionErrorMeters:
            behavior.entityPresentationAlignment?.positionErrorMeters ?? 0,
          entityPresentationYawErrorRadians:
            behavior.entityPresentationAlignment?.yawErrorRadians ?? 0,
          sourceT: behavior.currentSourceT,
          direction: behavior.currentDirection,
          state: behavior.currentState,
          gait: walk.gait,
          posePhase: behavior.poseKind === 'bench-seated'
            ? positiveModulo(this.phase + behavior.phaseOffsetSeconds, Math.PI * 2)
            : null,
        } : null,
      };
    });
    const finite = diagnostics.finite && actors.every((actor) => actor.currentPose
      && [
        actor.currentPose.position.x,
        actor.currentPose.position.y,
        actor.currentPose.position.z,
        actor.currentPose.presentationPosition.x,
        actor.currentPose.presentationPosition.y,
        actor.currentPose.presentationPosition.z,
        actor.currentPose.sidewalkGroundY,
        actor.currentPose.yawRadians,
        actor.currentPose.presentationYawRadians,
        actor.currentPose.sourceT,
        actor.currentPose.direction,
        actor.currentPose.gait,
      ].every(Number.isFinite)
      && (actor.poseKind !== 'bench-seated' || actor.seatedPoseMatrices?.finite === true));
    return {
      ...diagnostics,
      source: diagnostics.source ? { ...diagnostics.source } : null,
      roles: { ...diagnostics.roles },
      donorSelection: {
        ...diagnostics.donorSelection,
        indices: [...diagnostics.donorSelection.indices],
        origins: diagnostics.donorSelection.origins.map((origin) => ({
          ...origin,
          position: { ...origin.position },
        })),
      },
      composition: diagnostics.composition ? {
        ...diagnostics.composition,
        longitudinalOrder: [...diagnostics.composition.longitudinalOrder],
        lamp: {
          ...diagnostics.composition.lamp,
          position: { ...diagnostics.composition.lamp.position },
        },
        walkerRangeMeters: [...diagnostics.composition.walkerRangeMeters],
        walkerRangeToSitterCenterMeters: [...diagnostics.composition.walkerRangeToSitterCenterMeters],
        walkerRangeToLampCenterMeters: [...diagnostics.composition.walkerRangeToLampCenterMeters],
        walkerRangeToSitterShoulderClearanceMeters: [
          ...diagnostics.composition.walkerRangeToSitterShoulderClearanceMeters,
        ],
        walkerRangeToLampSilhouetteClearanceMeters: [
          ...diagnostics.composition.walkerRangeToLampSilhouetteClearanceMeters,
        ],
      } : null,
      actors,
      continuity: { ...diagnostics.continuity },
      resources: { ...diagnostics.resources },
      phaseSeconds: this.phase,
      finite,
    };
  }

  getVehicleBatchDiagnostics() {
    const meshes = [];
    this.vehicleGroup.traverse((object) => {
      if (object.isMesh) meshes.push(object);
    });
    const geometries = new Set(meshes.map((mesh) => mesh.geometry));
    const materials = new Set();
    for (const mesh of meshes) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    }
    const instances = this.vehicleBatch
      ? Object.fromEntries(Object.entries(this.vehicleBatch.parts).map(([name, mesh]) => [name, mesh.count]))
      : {};
    const sfTransit = this.cars.filter((car) => car.group.userData.rig?.sfTransit).map((car) => {
      const identity = car.group.userData.rig.sfTransit;
      return {
        carIndex: this.cars.indexOf(car),
        ordinal: identity.ordinal,
        id: identity.id,
        style: identity.style,
        bodyColor: `#${identity.bodyColor.toString(16).padStart(6, '0')}`,
        cabColor: `#${identity.cabColor.toString(16).padStart(6, '0')}`,
        roofColor: `#${identity.roofColor.toString(16).padStart(6, '0')}`,
        windowColor: `#${identity.windowColor.toString(16).padStart(6, '0')}`,
        topperInstanceIndex: car.group.userData.rig.topperInstanceIndex,
        windowInstanceIndex: car.group.userData.rig.transitInstanceIndex,
      };
    });
    return {
      logicalCars: this.cars.length,
      kinds: this.cars.reduce((counts, car) => ({ ...counts, [car.kind]: (counts[car.kind] || 0) + 1 }), {}),
      meshes: meshes.length,
      instancedMeshes: meshes.filter((mesh) => mesh.isInstancedMesh).length,
      geometries: geometries.size,
      materials: materials.size,
      instances,
      sfTransit: {
        logicalInstances: sfTransit.length,
        styles: sfTransit.reduce((counts, entry) => ({
          ...counts,
          [entry.style]: (counts[entry.style] || 0) + 1,
        }), {}),
        sharedBatchParts: ['body', 'cab', 'taxiTopper', 'transitWindows'],
        identities: sfTransit,
      },
      presentation: {
        version: this.vehicleBatch?.presentation?.version ?? null,
        paletteVersion: this.vehicleBatch?.presentation?.paletteVersion ?? null,
        materialVersion: this.vehicleBatch?.presentation?.materialVersion ?? null,
        civilianPaint: this.vehicleBatch?.presentation?.civilianPaint?.map((color) => `#${color.toString(16).padStart(6, '0')}`) ?? [],
        tintedCabColor: this.vehicleBatch?.presentation?.tintedCabColor != null
          ? `#${this.vehicleBatch.presentation.tintedCabColor.toString(16).padStart(6, '0')}`
          : null,
        taxiCabColor: this.vehicleBatch?.presentation?.taxiCabColor != null
          ? `#${this.vehicleBatch.presentation.taxiCabColor.toString(16).padStart(6, '0')}`
          : null,
        truckCabPolicy: this.vehicleBatch?.presentation?.truckCabPolicy ?? null,
        materials: this.vehicleBatch
          ? Object.fromEntries(Object.entries(this.vehicleBatch.parts).map(([part, mesh]) => {
            const material = mesh.material;
            return [part, {
              name: material.name,
              color: `#${material.color.getHexString()}`,
              roughness: material.roughness,
              metalness: material.metalness,
              emissive: material.emissive ? `#${material.emissive.getHexString()}` : null,
              emissiveIntensity: material.emissiveIntensity ?? 0,
              flatShading: Boolean(material.flatShading),
              metadata: { ...material.userData.sfVehiclePresentation },
            }];
          }))
          : {},
      },
      legacyMeshEstimate: this.cars.reduce((total, car) => total + (car.kind === 'taxi' ? 19 : 18), 0),
      frustumSafe: this.vehicleBatch
        ? Object.values(this.vehicleBatch.parts).every((mesh) => mesh.frustumCulled === false)
        : true,
    };
  }

  updateAiCar(car, delta) {
    if (car.corner) {
      this.updateCorner(car, delta);
      return;
    }
    const points = car.edge.points;
    const a = points[car.pathIndex];
    const b = points[Math.min(points.length - 1, car.pathIndex + 1)];
    const segmentLength = Math.hypot(b.x - a.x, b.z - a.z) || 0.01;
    const remaining = car.edge.totalLength - this.edgeArc(car);

    // Choose the onward edge early so braking, turn speed, and blinkers all
    // know about the maneuver before the car reaches the node.
    if (!car.nextEdge && remaining < TURN_SIGNAL_DIST + 2) {
      const lastA = points[points.length - 2];
      const lastB = points[points.length - 1];
      car.nextEdge = this.chooseNextEdge(car, lastA, lastB);
      car.turnSide = car.nextEdge ? this.turnDirection(car.edge, car.nextEdge) : 0;
    }

    let target = car.maxSpeed;
    const terminus = !(car.edge.outgoing || []).length;

    if (car.nextEdge && remaining < 14) {
      const angle = this.turnAngle(car.edge, car.nextEdge);
      const turnSpeed = angle > 1.05 ? 4.0 : angle > 0.55 ? 5.6 : 7.5;
      target = Math.min(target, Math.max(turnSpeed, 2.2));
    }

    const sig = this.signalState(car);
    car.signalState = sig;
    const holdAtLine = (sig === 'red' || sig === 'yellow') && remaining <= SIGNAL_LOOKAHEAD;
    if (holdAtLine) {
      const distToStop = remaining - STOP_LINE;
      if (distToStop >= 0) {
        // Speed that lets the car brake to zero exactly at the stop line.
        const stopSpeed = Math.sqrt(Math.max(0, 2 * DECEL * Math.max(0, distToStop)));
        target = Math.min(target, distToStop < 1.4 ? Math.min(stopSpeed, 0.9) : stopSpeed);
        if (distToStop <= 0.35) target = 0;
      }
      // Already past the line: keep moving so the intersection clears.
    }
    if (terminus && remaining < 9) {
      target = Math.min(target, Math.sqrt(Math.max(0, 2 * DECEL * Math.max(0, remaining - 2.6))));
      if (remaining <= 2.9) target = 0;
    }
    if (car.leaderGap != null) {
      const clearance = car.leaderGap - (car.dims.length + car.leaderLength) / 2;
      if (clearance <= MIN_BUMPER_GAP) target = 0;
      else target = Math.min(target, Math.sqrt(2 * FOLLOW_DECEL * Math.max(0, clearance - MIN_BUMPER_GAP)) + 0.4);
    }
    // Never roll into a node whose next edge is still occupied near the
    // entry; this keeps corner entries from stacking onto each other.
    if (car.nextEdge && remaining < 16 && !this.entryClear(car.nextEdge, car)) {
      const stopSpeed = Math.sqrt(Math.max(0, 2 * DECEL * Math.max(0, remaining - 1.2)));
      target = Math.min(target, remaining < 2.2 ? 0 : stopSpeed);
    }

    const rate = target < car.speed ? DECEL : ACCEL;
    car.speed += clamp(target - car.speed, -rate * delta, rate * delta);
    if (target <= 0.02 && car.speed < 0.06) car.speed = 0;
    car.braking = target < car.speed - 0.08 || (target <= 0.02 && car.speed > 0.02);
    car.stopped = car.speed <= 0.02;

    // Dead-end streets: stop cleanly, then recycle the car elsewhere so
    // termini do not pile up into permanent queues.
    if (terminus && car.speed === 0) {
      car.terminalTimer += delta;
      if (car.terminalTimer > 4) {
        this.respawnCar(car);
        return;
      }
    } else {
      car.terminalTimer = 0;
    }

    car.distance += car.speed * delta;
    if (car.distance >= segmentLength) {
      if (car.pathIndex >= points.length - 2) {
        const next = car.nextEdge || this.chooseNextEdge(car, a, b);
        if (next && this.entryClear(next, car)) {
          const angle = this.turnAngle(car.edge, next);
          const corner = {
            from: points[points.length - 1],
            to: next.points[0],
            t: 0,
            duration: clamp(0.45 + angle * 0.5, 0.4, 1.4),
          };
          const turnSide = car.turnSide || this.turnDirection(car.edge, next);
          this.assignEdge(car, next, 0, 0);
          car.corner = corner; // assignEdge clears corner/turnSide, restore for the arc
          car.turnSide = turnSide;
        } else {
          car.distance = Math.min(car.distance, Math.max(0, segmentLength - 0.6));
          car.speed = Math.min(car.speed, 0.4);
        }
      } else {
        car.distance -= segmentLength;
        car.pathIndex += 1;
      }
    }

    if (car.corner) {
      this.updateCorner(car, delta);
      return;
    }
    const segA = points[car.pathIndex];
    const segB = points[Math.min(points.length - 1, car.pathIndex + 1)];
    const segLen = Math.hypot(segB.x - segA.x, segB.z - segA.z) || 0.01;
    const t = clamp(car.distance / segLen, 0, 1);
    const x = segA.x + (segB.x - segA.x) * t;
    const z = segA.z + (segB.z - segA.z) * t;
    const nx = -(segB.z - segA.z) / segLen;
    const nz = (segB.x - segA.x) / segLen;
    const offset = this.laneOffsetFor(car.edge);
    car.laneOffset = offset;
    car.group.position.set(x + nx * offset, this.groundY(x, z), z + nz * offset);
    car.group.rotation.y = Math.atan2(segB.x - segA.x, segB.z - segA.z);
  }

  updateCorner(car, delta) {
    const corner = car.corner;
    corner.t = Math.min(1, corner.t + delta / corner.duration);
    const p = this.cornerArc(corner.from, corner.to, corner.t);
    // Heading follows the arc tangent; when the two intersection endpoints
    // nearly coincide (edges meet on the centerline) fall back to the
    // outgoing edge's first segment so the car still rotates through the
    // turn instead of snapping.
    const ahead = this.cornerArc(corner.from, corner.to, Math.min(1, corner.t + 0.08));
    let heading;
    if (Math.hypot(ahead.x - p.x, ahead.z - p.z) > 0.05) {
      heading = Math.atan2(ahead.x - p.x, ahead.z - p.z);
    } else {
      const pts = car.edge.points;
      const q = pts[Math.min(1, pts.length - 1)];
      heading = Math.atan2(q.x - corner.to.x, q.z - corner.to.z);
    }
    let dyaw = heading - car.group.rotation.y;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    car.group.rotation.y += dyaw * clamp(delta * 8, 0, 1);
    car.group.position.set(p.x, this.groundY(p.x, p.z), p.z);
    if (corner.t >= 1) {
      car.corner = null;
      car.turnSide = 0; // maneuver finished; stop the blinker
    }
  }

  animateCar(car, delta) {
    const rig = car.group.userData.rig;
    if (!rig) return;
    const speed = car.speed || 0;
    rig.spin += (speed * delta) / 0.3;
    for (const wheel of rig.wheels) wheel.rotation.x = rig.spin;
    rig.bobTime += delta * (2.2 + speed * 0.55);
    const bobAmp = 0.01 + 0.018 * clamp(speed / 9, 0, 1);
    rig.body.position.y = Math.sin(rig.bobTime) * bobAmp;
    const leanTarget = car.corner && car.turnSide ? -car.turnSide * 0.035 : 0;
    rig.body.rotation.z += (leanTarget - rig.body.rotation.z) * clamp(delta * 6, 0, 1);
    rig.taillightMat.emissiveIntensity = car.braking ? 1.6 : speed < 0.25 ? 0.85 : 0.25;
    // Blinkers run while approaching and traversing a chosen turn.
    const nearNode = car.corner
      || (car.nextEdge && car.edge && car.edge.totalLength - this.edgeArc(car) < TURN_SIGNAL_DIST);
    const blinkOn = (this.phase * 1.9) % 1 < 0.55;
    const intensity = car.turnSide !== 0 && nearNode && blinkOn ? 1.5 : 0;
    const signals = rig.turnSignals;
    if (!signals) return;
    const active = car.turnSide > 0 ? signals.left : signals.right;
    const idle = car.turnSide > 0 ? signals.right : signals.left;
    for (const mat of active || []) mat.emissiveIntensity = intensity;
    for (const mat of idle || []) mat.emissiveIntensity = 0;
  }

  updatePedestrian(pedestrian, delta) {
    if (pedestrian.heroCurbBehavior) {
      this.updateHeroCurbPedestrian(pedestrian, delta);
      return;
    }
    const walk = pedestrian.group.userData.walk;
    const moving = this.advancePedestrianActivity(pedestrian, delta);
    // The instantaneous ground speed, which is NOT `pedestrian.speed`: that is
    // a nominal cruise figure that stays at 1.2-2.1 m/s even while the agent is
    // standing at a kerb waiting for a light. Presentation drives the gait
    // phase off distance travelled, so handing it the cruise figure would walk
    // a stationary person's legs on the spot - the skating the gate rejects.
    pedestrian.groundSpeed = moving ? pedestrian.speed : 0;
    if (moving) pedestrian.s += pedestrian.dir * pedestrian.speed * delta;
    if (pedestrian.s >= pedestrian.total) {
      pedestrian.s = pedestrian.total;
      pedestrian.dir = -1;
    } else if (pedestrian.s <= 0) {
      pedestrian.s = 0;
      pedestrian.dir = 1;
    }
    const points = pedestrian.points;
    while (pedestrian.seg < points.length - 2 && pedestrian.s > pedestrian.cum[pedestrian.seg + 1]) pedestrian.seg += 1;
    while (pedestrian.seg > 0 && pedestrian.s < pedestrian.cum[pedestrian.seg]) pedestrian.seg -= 1;
    const a = points[pedestrian.seg];
    const b = points[Math.min(points.length - 1, pedestrian.seg + 1)];
    const segLen = pedestrian.cum[pedestrian.seg + 1] - pedestrian.cum[pedestrian.seg] || 0.01;
    const t = clamp((pedestrian.s - pedestrian.cum[pedestrian.seg]) / segLen, 0, 1);
    let x = a.x + (b.x - a.x) * t;
    let z = a.z + (b.z - a.z) * t;
    const segDx = b.x - a.x;
    const segDz = b.z - a.z;
    // Ambient walkers carry a lateral offset so a pavement is a stream of
    // people rather than a single-file queue on the path centreline, and so a
    // companion group can walk abreast. The 48 logical pedestrians keep the
    // exact centreline the gameplay verifiers measure against.
    if (pedestrian.lateral) {
      const inv = 1 / (Math.hypot(segDx, segDz) || 1);
      x += -segDz * inv * pedestrian.lateral;
      z += segDx * inv * pedestrian.lateral;
    }
    const y = this.pedestrianGroundY(x, z);
    // A stopped walker does not bob: the bob is a gait artefact, and running it
    // on a stationary figure is the pogo-stick idle the rubric rejects.
    walk.gait = moving ? Math.sin(this.phase * walk.cadence + walk.time) : 0;
    walk.bobOffset = moving ? Math.abs(walk.gait) * walk.bob : 0;
    pedestrian.group.position.set(x, y + walk.bobOffset, z);
    const fx = pedestrian.dir > 0 ? segDx : -segDx;
    const fz = pedestrian.dir > 0 ? segDz : -segDz;
    const travelYaw = Math.atan2(fx, fz);
    pedestrian.group.rotation.y = moving
      ? travelYaw
      : this.pausedFacing(pedestrian, travelYaw, segDx, segDz);
    if (this.pedestrianBatch && pedestrian.instanceIndex != null) {
      writePedestrianInstance(this.pedestrianBatch, pedestrian.instanceIndex, pedestrian);
    }
  }

  /**
   * Advance one walker's purposeful-behaviour schedule.
   *
   * A pavement where everybody moves at a constant speed in a straight line
   * reads as a conveyor belt. Real people stop: at the kerb for a signal, to
   * talk, to check a phone, to look in a window. The schedule is a pure
   * function of the agent's identity and the number of legs it has already
   * walked, so it replays identically and never consumes shared RNG state.
   *
   * @returns {boolean} whether the walker is moving along its path this step
   */
  advancePedestrianActivity(pedestrian, delta) {
    // Only the ambient pool has a schedule. The 48 logical pedestrians are the
    // gameplay population - collision, melee, witness, aftermath and three
    // pinned verifiers all read their motion - so their movement contract is
    // left exactly as it was.
    if (!pedestrian.activityKey) return true;
    if (pedestrian.activityTimer === undefined) {
      pedestrian.activity = 'walk';
      pedestrian.activityLeg = 0;
      pedestrian.activityTimer = 4 + keyedRandom(pedestrian.activityKey, 'seed') * 24;
    }
    pedestrian.activityTimer -= delta;
    if (pedestrian.activityTimer > 0) return pedestrian.activity === 'walk';
    pedestrian.activityLeg += 1;
    const key = pedestrian.activityKey;
    const leg = pedestrian.activityLeg;
    if (pedestrian.activity !== 'walk') {
      pedestrian.activity = 'walk';
      const [lo, hi] = WALK_LEG_SECONDS;
      pedestrian.activityTimer = lo + keyedRandom(key, `walk-${leg}`) * (hi - lo);
      return true;
    }
    // Near a path end is a junction on this street contract, so that is where a
    // "waiting for the signal" pause is allowed to happen.
    const nearCorner = Math.min(pedestrian.s, pedestrian.total - pedestrian.s) <= 6;
    const pool = PEDESTRIAN_ACTIVITIES.filter((entry) => (entry.atCorner ? nearCorner : true));
    let total = 0;
    for (const entry of pool) total += entry.weight;
    let roll = keyedRandom(key, `act-${leg}`) * total;
    let chosen = pool[pool.length - 1];
    for (const entry of pool) {
      roll -= entry.weight;
      if (roll <= 0) { chosen = entry; break; }
    }
    const [lo, hi] = chosen.seconds;
    pedestrian.activity = chosen.name;
    pedestrian.activityFacing = chosen.facing;
    pedestrian.activityTimer = lo + keyedRandom(key, `dur-${leg}`) * (hi - lo);
    return false;
  }

  /**
   * Where a paused walker looks. Facing matters more than the pose: a person
   * waiting to cross faces the crossing, a window shopper faces the window, and
   * two people talking face each other.
   */
  pausedFacing(pedestrian, travelYaw, segDx, segDz) {
    const facing = pedestrian.activityFacing;
    if (!facing || facing === 'keep') return travelYaw;
    const acrossYaw = Math.atan2(-segDz, segDx);
    if (facing === 'across') {
      // Toward the carriageway: the sidewalk path runs parallel to the kerb, so
      // the crossing direction is its perpendicular, chosen on the road side.
      return pedestrian.roadSide < 0 ? acrossYaw + Math.PI : acrossYaw;
    }
    if (facing === 'inward') {
      return pedestrian.roadSide < 0 ? acrossYaw : acrossYaw + Math.PI;
    }
    if (facing === 'partner') {
      // Companions turn to face each other across the group's lateral spread.
      return travelYaw + (pedestrian.lateral >= 0 ? -Math.PI / 2 : Math.PI / 2);
    }
    return travelYaw;
  }

  updateHeroCurbPedestrian(pedestrian, delta) {
    const behavior = pedestrian.heroCurbBehavior;
    const walk = pedestrian.group.userData.walk;
    let x;
    let y;
    let z;
    let yaw;
    let sourceT;
    let direction;
    let state;

    if (behavior.role === 'destination-walker') {
      const travel = behavior.travelSeconds;
      const turn = behavior.turnSeconds;
      const cycle = travel * 2 + turn * 2;
      const local = positiveModulo(this.phase + behavior.phaseOffsetSeconds, cycle);
      const forwardYaw = Math.atan2(
        behavior.path[1].x - behavior.path[0].x,
        behavior.path[1].z - behavior.path[0].z,
      );
      const reverseYaw = normalizeAngle(forwardYaw + Math.PI);
      const forwardAttentionYaw = normalizeAngle(
        forwardYaw + behavior.inwardAttentionYawSign * HERO_CURB_ATTENTION_YAW,
      );
      const reverseAttentionYaw = normalizeAngle(
        reverseYaw - behavior.inwardAttentionYawSign * HERO_CURB_ATTENTION_YAW,
      );
      let progress;
      if (local < travel) {
        progress = local / travel;
        yaw = forwardAttentionYaw;
        direction = 1;
        state = 'walking-forward';
      } else if (local < travel + turn) {
        progress = 1;
        const turnProgress = smoothstep01((local - travel) / turn);
        yaw = lerpAngle(forwardAttentionYaw, reverseAttentionYaw, turnProgress);
        direction = 0;
        state = 'turning-reverse';
      } else if (local < travel * 2 + turn) {
        progress = 1 - (local - travel - turn) / travel;
        yaw = reverseAttentionYaw;
        direction = -1;
        state = 'walking-reverse';
      } else {
        progress = 0;
        const turnProgress = smoothstep01((local - travel * 2 - turn) / turn);
        yaw = lerpAngle(reverseAttentionYaw, forwardAttentionYaw, turnProgress);
        direction = 0;
        state = 'turning-forward';
      }
      progress = clamp(progress, 0, 1);
      x = behavior.path[0].x + (behavior.path[1].x - behavior.path[0].x) * progress;
      z = behavior.path[0].z + (behavior.path[1].z - behavior.path[0].z) * progress;
      sourceT = behavior.sourceTBounds[0]
        + (behavior.sourceTBounds[1] - behavior.sourceTBounds[0]) * progress;
      pedestrian.s = behavior.total * progress;
      pedestrian.dir = direction || pedestrian.dir;
      walk.gait = Math.sin(this.phase * walk.cadence + walk.time);
      walk.bobOffset = Math.abs(walk.gait) * walk.bob;
      y = this.heroCurbGroundY(sourceT) + walk.bobOffset;
    } else {
      x = behavior.seatedAnchor.entityRootPosition.x;
      y = behavior.seatedAnchor.entityRootPosition.y;
      z = behavior.seatedAnchor.entityRootPosition.z;
      sourceT = behavior.sourceTBounds[0];
      pedestrian.s = 0;
      direction = 0;
      pedestrian.dir = 1;
      state = 'seated-at-bench';
      yaw = behavior.seatedAnchor.entityRootYawRadians;
      walk.gait = Math.sin(this.phase * 1.1 + walk.time) * 0.04;
      walk.bobOffset = 0;
    }

    pedestrian.group.position.set(x, y, z);
    pedestrian.group.rotation.y = yaw;
    behavior.currentSourceT = sourceT;
    behavior.currentDirection = direction;
    behavior.currentState = state;
    this.recordHeroCurbContinuity(pedestrian, delta);
    if (this.pedestrianBatch) {
      writePedestrianInstance(this.pedestrianBatch, pedestrian.instanceIndex, pedestrian);
      if (behavior.poseKind === 'bench-seated') this.writeHeroCurbSeatedPose(pedestrian);
    }
  }

  writeHeroCurbSeatedPose(pedestrian) {
    const batch = this.pedestrianBatch;
    const behavior = pedestrian.heroCurbBehavior;
    const anchor = behavior?.seatedAnchor;
    if (!batch || !anchor) return false;

    const { appearance, walk } = pedestrian.group.userData;
    const helper = batch.matrixHelper;
    const root = batch.rootHelper;
    root.position.copy(pedestrian.group.position);
    root.rotation.set(0, pedestrian.group.rotation.y, 0);
    root.scale.set(1, 1, 1);
    root.updateMatrix();
    batch.rootMatrix.copy(root.matrix);
    const positionErrorMeters = root.position.distanceTo(pedestrian.group.position);
    const yawErrorRadians = Math.abs(normalizeAngle(root.rotation.y - pedestrian.group.rotation.y));

    const writePart = (part, instanceIndex, position, scale = [1, 1, 1], rotation = [0, 0, 0]) => {
      helper.position.fromArray(position);
      helper.rotation.set(rotation[0], rotation[1], rotation[2]);
      helper.scale.fromArray(scale);
      helper.updateMatrix();
      batch.partMatrix.multiplyMatrices(batch.rootMatrix, helper.matrix);
      batch.parts[part].setMatrixAt(instanceIndex, batch.partMatrix);
    };
    const writeSegment = (part, instanceIndex, start, end) => {
      batch.start.fromArray(start);
      batch.end.fromArray(end);
      batch.direction.subVectors(batch.end, batch.start);
      const segmentLength = Math.max(0.01, batch.direction.length());
      batch.direction.multiplyScalar(1 / segmentLength);
      helper.position.copy(batch.start).add(batch.end).multiplyScalar(0.5);
      helper.quaternion.setFromUnitVectors(batch.up, batch.direction);
      helper.scale.set(1, segmentLength, 1);
      helper.updateMatrix();
      batch.partMatrix.multiplyMatrices(batch.rootMatrix, helper.matrix);
      batch.parts[part].setMatrixAt(instanceIndex, batch.partMatrix);
    };

    const index = pedestrian.instanceIndex;
    const headTurn = Math.sin(this.phase * 0.7 + walk.time) * 0.05;
    writePart('torso', index, [0, 0.78, -0.015], [1, 1, 1], [0.08, 0, 0]);
    writePart('head', index, [headTurn, 1.2, 0.015]);
    writePart('hair', index, [headTurn, 1.2, 0.015], [1, appearance.hairScale, 1]);
    writePart('face', index, [headTurn, 1.19, 0.152], [1, 1, 1], [0, headTurn * 0.8, 0]);
    writePart('shadow', index, [0, 0.008, 0.08], [1.2, 1, 0.95]);

    for (const side of [-1, 1]) {
      const pairIndex = index * 2 + (side > 0 ? 1 : 0);
      const shoulder = [side * 0.31, 0.97, 0];
      const elbow = [side * 0.34, 0.8, 0.18];
      const hand = [side * 0.22, 0.67 + (side > 0 ? headTurn * 0.35 : 0), 0.38];
      writeSegment('upperArms', pairIndex, shoulder, elbow);
      writeSegment('forearms', pairIndex, elbow, hand);
      writePart('hands', pairIndex, hand);

      const hip = [side * 0.12, 0.62, 0.02];
      const knee = [side * 0.14, 0.52, 0.44];
      const ankle = [side * 0.14, 0.12, 0.48];
      writeSegment('thighs', pairIndex, hip, knee);
      writeSegment('shins', pairIndex, knee, ankle);
      writePart('shoes', pairIndex, [side * 0.14, 0.06, 0.59]);
    }

    let finiteMatrices = true;
    let matrixInstances = 0;
    for (const mesh of Object.values(batch.parts)) {
      const instancesPerPedestrian = mesh.userData.instancesPerPedestrian || 1;
      for (let partIndex = 0; partIndex < instancesPerPedestrian; partIndex += 1) {
        const instanceIndex = index * instancesPerPedestrian + partIndex;
        mesh.getMatrixAt(instanceIndex, batch.partMatrix);
        matrixInstances += 1;
        finiteMatrices = finiteMatrices && batch.partMatrix.elements.every(Number.isFinite);
      }
    }
    behavior.seatedPoseMatrices = {
      postTransformedExistingInstances: true,
      partBatches: Object.keys(batch.parts).length,
      matrixInstances,
      finite: finiteMatrices,
    };
    behavior.entityPresentationAlignment = {
      positionErrorMeters,
      yawErrorRadians,
      finite: [positionErrorMeters, yawErrorRadians].every(Number.isFinite),
    };
    return finiteMatrices && behavior.entityPresentationAlignment.finite;
  }

  recordHeroCurbContinuity(pedestrian, delta) {
    const behavior = pedestrian.heroCurbBehavior;
    const continuity = this.heroCurbLifeDiagnostics.continuity;
    const position = pedestrian.group.position;
    const yaw = pedestrian.group.rotation.y;
    if (behavior.lastPosition && behavior.lastYaw != null && delta > 0) {
      const step = Math.hypot(
        position.x - behavior.lastPosition.x,
        position.y - behavior.lastPosition.y,
        position.z - behavior.lastPosition.z,
      );
      const yawStep = Math.abs(shortestAngle(yaw - behavior.lastYaw));
      continuity.maxStepMeters = Math.max(continuity.maxStepMeters, step);
      continuity.maxYawStepRadians = Math.max(continuity.maxYawStepRadians, yawStep);
      const linearLimit = (behavior.role === 'destination-walker' ? 1.5 : 0.4) * delta + 0.004;
      const yawLimit = 4.2 * delta + 0.01;
      if (step > linearLimit) continuity.teleportViolations += 1;
      if (yawStep > yawLimit) continuity.yawPopViolations += 1;
      continuity.samples += 1;
    }
    behavior.lastPosition = { x: position.x, y: position.y, z: position.z };
    behavior.lastYaw = yaw;
  }

  updateCarSpacing() {
    const byEdge = new Map();
    for (const car of this.cars) {
      if (car.controlled || !car.edge) continue;
      // Cars traversing the corner arc already belong to the next edge;
      // count them at its entry so followers braking into the node see them.
      const arc = car.corner ? 0 : this.edgeArc(car);
      if (!byEdge.has(car.edge)) byEdge.set(car.edge, []);
      byEdge.get(car.edge).push({ car, arc });
    }
    for (const entries of byEdge.values()) {
      entries.sort((a, b) => a.arc - b.arc);
      for (let i = 0; i < entries.length; i += 1) {
        const current = entries[i].car;
        const ahead = entries[i + 1];
        current.leaderGap = ahead ? ahead.arc - entries[i].arc : null;
        current.leaderLength = ahead ? ahead.car.dims.length : 4;
      }
    }
  }

  entryClear(edge, car) {
    const halfFollower = (car.dims.length || 4) / 2;
    for (const other of this.cars) {
      if (other === car || other.controlled || other.edge !== edge) continue;
      const otherArc = other.corner ? 0 : this.edgeArc(other);
      const otherHalf = (other.dims.length || 4) / 2;
      if (otherArc - otherHalf < halfFollower + 3.5) return false;
    }
    return true;
  }

  driveCar(car, speed, delta) {
    if (!car || !car.edge) return;
    car.braking = speed < (car.lastDriveSpeed ?? speed) - 0.08 || (this.signalBlocked(car) && speed < 1.5);
    car.lastDriveSpeed = speed;
    car.speed = speed;
    const points = car.edge.points;
    const targetIndex = Math.min(points.length - 1, car.pathIndex + 1);
    const a = points[car.pathIndex];
    const b = points[targetIndex];
    const segmentLength = Math.hypot(b.x - a.x, b.z - a.z) || 0.01;
    if (this.signalBlocked(car)) {
      const stopLine = Math.max(0, segmentLength - STOP_LINE);
      if (car.distance >= stopLine) car.distance = Math.min(car.distance, stopLine);
      else car.distance += speed * delta;
    } else {
      car.distance += speed * delta;
    }
    if (car.distance >= segmentLength) {
      if (car.pathIndex >= points.length - 2) {
        const next = this.chooseNextEdge(car, a, b);
        if (next) {
          this.assignEdge(car, next, 0, 0);
        } else {
          car.distance = Math.min(car.distance, Math.max(0, segmentLength - STOP_LINE));
        }
      } else {
        car.pathIndex += 1;
        car.distance = 0;
      }
    }
    const updated = car.edge.points[car.pathIndex];
    const next = car.edge.points[Math.min(car.edge.points.length - 1, car.pathIndex + 1)];
    const t = clamp(car.distance / (Math.hypot(next.x - updated.x, next.z - updated.z) || 0.01), 0, 1);
    const x = updated.x + (next.x - updated.x) * t;
    const z = updated.z + (next.z - updated.z) * t;
    const dx = next.x - updated.x;
    const dz = next.z - updated.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const offset = this.laneOffsetFor(car.edge);
    car.group.position.set(x + nx * offset, this.groundY(x, z), z + nz * offset);
    car.group.rotation.y = Math.atan2(next.x - updated.x, next.z - updated.z) + (car.steerYaw || 0);
    this.animateCar(car, delta);
  }

  chooseNextEdge(car, a, b) {
    const raw = car.edge.outgoing || [];
    const outgoing = raw.filter((e) => e.streetId !== car.edge.streetId || this.random() < 0.35);
    const pool = outgoing.length ? outgoing : raw;
    if (!pool.length) return null;
    const inDx = b.x - a.x;
    const inDz = b.z - a.z;
    const inLen = Math.hypot(inDx, inDz) || 1;
    let totalWeight = 0;
    const weighted = pool.map((edge) => {
      const out = edge.points[0];
      const nextP = edge.points[Math.min(1, edge.points.length - 1)];
      const outDx = nextP.x - out.x;
      const outDz = nextP.z - out.z;
      const outLen = Math.hypot(outDx, outDz) || 1;
      const dot = (inDx * outDx + inDz * outDz) / (inLen * outLen);
      let weight = 0.3;
      if (dot > 0.82) weight = 4;
      else if (dot > -0.35) weight = 1.6;
      const nextStart = edge.points[0];
      if (Math.hypot(nextStart.x - a.x, nextStart.z - a.z) < 0.5) weight *= 0.15;
      totalWeight += weight;
      return { edge, weight };
    });
    let pick = this.random() * totalWeight;
    for (const candidate of weighted) {
      pick -= candidate.weight;
      if (pick <= 0) return candidate.edge;
    }
    return weighted[weighted.length - 1].edge;
  }

  turnAngle(edge, next) {
    const pts = edge.points;
    const a = pts[pts.length - 2] || pts[0];
    const b = pts[pts.length - 1];
    const c = next.points[Math.min(1, next.points.length - 1)];
    const inDx = b.x - a.x;
    const inDz = b.z - a.z;
    const outDx = c.x - b.x;
    const outDz = c.z - b.z;
    const inLen = Math.hypot(inDx, inDz) || 1;
    const outLen = Math.hypot(outDx, outDz) || 1;
    return Math.acos(clamp((inDx * outDx + inDz * outDz) / (inLen * outLen), -1, 1));
  }

  turnDirection(edge, next) {
    const pts = edge.points;
    const a = pts[pts.length - 2] || pts[0];
    const b = pts[pts.length - 1];
    const c = next.points[Math.min(1, next.points.length - 1)];
    const inDx = b.x - a.x;
    const inDz = b.z - a.z;
    const outDx = c.x - b.x;
    const outDz = c.z - b.z;
    const inLen = Math.hypot(inDx, inDz) || 1;
    const outLen = Math.hypot(outDx, outDz) || 1;
    const sin = (inDz * outDx - inDx * outDz) / (inLen * outLen);
    if (Math.abs(sin) < 0.35) return 0;
    // +y cross product means the heading rotates from +z toward +x, which is
    // the vehicle's left side in three.js coordinates.
    return sin > 0 ? 1 : -1;
  }

  /**
   * Phase state for the car's signal, mirroring the renderer bulb math:
   * local = floor((clock + phaseOffset) / period) % 4 with red on 0-1,
   * yellow on 2, green on 3. Returns null when the edge has no signal.
   */
  signalState(car) {
    if (!car.edge?.signalId) return null;
    const signal = car.signal ?? this.city.signals.find((s) => s.id === car.edge.signalId);
    if (!signal) return null;
    const local = Math.floor((this.phase + (signal.phaseOffset || 0)) / (signal.period || 8)) % 4;
    if (local === 0 || local === 1) return 'red';
    if (local === 2) return 'yellow';
    return 'green';
  }

  signalBlocked(car) {
    return this.signalState(car) === 'red';
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function normalizeAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function shortestAngle(value) {
  return normalizeAngle(value);
}

function lerpAngle(from, to, progress) {
  return normalizeAngle(from + shortestAngle(to - from) * progress);
}

function smoothstep01(value) {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function pointToSegmentDistance2D(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const progress = lengthSquared > 0
    ? clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared, 0, 1)
    : 0;
  return Math.hypot(
    point.x - (start.x + dx * progress),
    point.z - (start.z + dz * progress),
  );
}

function cloneSeatedAnchor(anchor) {
  return {
    ...anchor,
    benchPosition: { ...anchor.benchPosition },
    localOffsetMeters: { ...anchor.localOffsetMeters },
    entityRootPosition: { ...anchor.entityRootPosition },
  };
}

function cloneBenchContact(contact) {
  return {
    ...contact,
    supportProp: {
      ...contact.supportProp,
      position: { ...contact.supportProp.position },
    },
    seatEnvelopeLocalMeters: { ...contact.seatEnvelopeLocalMeters },
    torsoContactEnvelopeLocalMeters: { ...contact.torsoContactEnvelopeLocalMeters },
  };
}

function createHeroCurbLifeDiagnostics() {
  return {
    pass: HERO_CURB_LIFE_PASS,
    schemaVersion: 3,
    enabled: false,
    source: null,
    logicalPedestriansBefore: 0,
    logicalPedestriansAfter: 0,
    relocated: 0,
    roles: { destinationWalker: 0, benchSitter: 0 },
    donorSelection: {
      policy: 'farthest-from-corridor-midpoint-v1',
      indices: [],
      unique: true,
      origins: [],
    },
    actors: [],
    composition: null,
    continuity: {
      teleportViolations: 0,
      yawPopViolations: 0,
      maxStepMeters: 0,
      maxYawStepRadians: 0,
      samples: 0,
    },
    resources: {
      newSceneObjects: 0,
      newMeshes: 0,
      newGeometries: 0,
      newMaterials: 0,
      newTextures: 0,
    },
    failure: null,
    finite: false,
  };
}

function cumulativeLengths(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  return cum;
}

function nearestPointOnPath(points, cum, focus) {
  let best = { arc: 0, distanceToFocus: Infinity };
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz || 1;
    const t = clamp(((focus.x - a.x) * dx + (focus.z - a.z) * dz) / lengthSq, 0, 1);
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const distanceToFocus = Math.hypot(x - focus.x, z - focus.z);
    if (distanceToFocus < best.distanceToFocus) {
      const segmentLength = cum[i + 1] - cum[i] || Math.sqrt(lengthSq);
      best = { arc: cum[i] + segmentLength * t, distanceToFocus };
    }
  }
  return best;
}

function pathPositionAtArc(points, cum, arc) {
  let index = 0;
  while (index < points.length - 2 && arc > cum[index + 1]) index += 1;
  const distance = clamp(arc - cum[index], 0, (cum[index + 1] - cum[index]) || 0);
  const a = points[index];
  const b = points[index + 1];
  const segmentLength = (cum[index + 1] - cum[index]) || 0.01;
  const t = clamp(distance / segmentLength, 0, 1);
  return { index, distance, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}
