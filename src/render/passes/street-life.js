// street-life - presentation pass.
//
// Owner: Pedestrians/life. Contract: src/render/pass-registry.js.
//
// WHAT THIS FIXES
//
// The captured 11:00 downtown street card contains no people. Not "few" - none.
// The rubric dimension "NPC and traffic life" scores about 1/5 on it, and the
// empty pavement drags composition and place identity down with it.
//
// Two different things were missing, and they need two different fixes:
//
//   1. DENSITY. The walking population and the recycler that keeps it near the
//      camera are simulation-owned and are fixed in src/citygen/traffic.js.
//   2. PURPOSE. A crowd of people all walking at 1.4 m/s in straight lines is a
//      conveyor belt. What makes a street read as a place is the people who are
//      NOT walking: queueing at the crossing, standing in pairs talking, on a
//      phone against a wall, sitting on a step, looking in a window, waiting in
//      a doorway. None of that is path-following, so none of it can come out of
//      the walking simulation. That is what this pass builds.
//
// It also fills the kerb directly in front of the camera. The legacy map-wide
// parked-car layer spends its whole 520-car budget on whichever segments happen
// to come first in the source array, so on the measured capture pose the
// nearest parked car in shot is 224 m away. This pass streams kerb occupancy
// from the camera outwards and skips any stall the legacy layer already filled.
//
// WHAT IT IS NOT. It never writes simulation state, never moves a path, never
// spawns an agent the simulation knows about, and never creates a renderer, a
// loop, a clock or a scene root. Its figures are scenery: they occupy the two
// edges of the footway - against the kerb and against the property line - while
// the simulated walkers own the through-route between them, so the two
// populations share a pavement without ever standing in each other.
//
// SOURCES OF TRUTH
//   * street geometry     `buildStreetscapePlan` (src/world/streets/street-surface-v2.js)
//                         - the same node set, trims and corner arcs the paved
//                           surface was built from. No mesh is reverse-engineered.
//   * figure appearance   `identityVariation` / `identityWardrobe` and the rig
//                         from src/simulation/pedestrians/pedestrian-presentation.js,
//                         so a standing figure and a walking one are the same
//                         person vocabulary, not two different art styles.
//   * ground              `sidewalkSurfaceY` / `carriagewaySurfaceY` against the
//                         city datum, evaluated once per figure at build time.
//
// DETERMINISM. No Math.random, no Date.now. Every choice is a hash of a source
// id, so two builds of one city are bit-identical.

import * as THREE from 'three';
import {
  buildStreetscapePlan,
  sidewalkBand,
  sidewalkSurfaceY,
  carriagewaySurfaceY,
  streetStationAt,
  STREET_SURFACE_V2_DEFAULTS,
} from '../../world/streets/street-surface-v2.js';
import {
  PEDESTRIAN_BONE_NAMES,
  REST_POSE,
  buildInstancedPartGeometries,
  buildWardrobeGeometries,
  identitySeed,
  identityRandom,
  identityVariation,
  identityWardrobe,
  appearanceSignature,
  evaluateActivityPose,
  mirrorActivityPose,
  ACTIVITY_ROOT_DROP,
  contactShadowFor,
  CONTACT_SHADOW,
} from '../../simulation/pedestrians/pedestrian-presentation.js';

export const STREET_LIFE_ID = 'street-life';
export const STREET_LIFE_VERSION = 'street-life-v1';

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------
//
// Captures run through a SOFTWARE GL backend on a four-core box, so the ring
// radii below are chosen by what a figure is worth at that distance, not by
// what fits in a GPU:
//
//   near  <= 46 m   A figure is 40-190 px tall. Individual limbs, wardrobe and
//                   the activity's motion all read, so it gets per-bone
//                   articulation: 15 body meshes + 8 wardrobe meshes, one
//                   instance each, 244 tri per figure.
//   mid   <= 132 m  A figure is 14-40 px tall. Limb positions are sub-pixel;
//                   the silhouette, the colour and the fact that something is
//                   standing there are all that survive. One root matrix, no
//                   articulation, 136 tri per figure.
//   past 132 m      Not drawn at all. The walking crowd's own far band already
//                   populates 132-220 m, and a motionless figure at that range
//                   is a smudge that costs a matrix.
//
// Per-ring caps are hard: the planner sorts by distance and stops, so the cost
// of this pass is bounded by the caps and NOT by the size of the city.
export const STREET_LIFE_RINGS = Object.freeze([
  Object.freeze({ id: 'near', radius: 46, budget: 56, articulated: true }),
  Object.freeze({ id: 'mid', radius: 132, budget: 200, articulated: false }),
]);

export const STREET_LIFE_BUDGET = Object.freeze({
  rings: STREET_LIFE_RINGS,
  /** Kerb stalls drawn, nearest first, inside `parkingRadius`. */
  parkedCars: 72,
  parkingRadius: 150,
  /** Planning caps, so a huge city cannot blow memory on records it never draws. */
  maxAnchors: 6000,
  maxParkingSpots: 9000,
  /** Measured ceilings; exceeding either is a regression, not a tuning choice. */
  maxTriangles: 90000,
  maxDrawCalls: 40,
});

/**
 * Standing figures per metre of kerb, before class, district and hour scaling.
 *
 * Calibration: a busy downtown block face is about 100 m long and carries three
 * to six people who are stationary at any instant - a pair talking, someone on
 * a phone, one or two at the corner waiting for the light. 0.042/m puts four on
 * that block face. Anything near 0.1/m produces a protest march.
 */
export const STREET_LIFE_LINE_DENSITY = 0.042;

/** How heavily each street class is populated with stationary figures. */
export const STREET_LIFE_CLASS_WEIGHT = Object.freeze({
  primary: 1.0,
  primary_link: 0.7,
  secondary: 0.95,
  secondary_link: 0.7,
  tertiary: 0.78,
  tertiary_link: 0.6,
  residential: 0.5,
  living_street: 0.55,
  unclassified: 0.45,
  pedestrian: 1.2,
  service: 0.16,
  alley: 0.16,
  track: 0.1,
  trunk: 0.25,
  motorway: 0,
});

/**
 * Footfall by hour. Midday and the evening commute are the busy windows, the
 * small hours are nearly empty. Shared shape with the traffic simulation's own
 * curve so the standing population and the walking population rise and fall
 * together instead of contradicting each other.
 */
export function streetLifeHourFactor(hour) {
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
 * What the figures are doing, where they stand, and which way they face.
 *
 * ZONES. `sidewalkBand` splits a footway into a furnishing strip at the back of
 * the kerb and a pedestrian through-route reserved at the property-line end -
 * and the walking simulation puts its walkers 1.0 m in from the property line,
 * i.e. squarely in that through-route. So every stationary figure stands in the
 * furnishing strip, which is both where the street contract says non-moving
 * things belong and where people really do stand: at the kerb, by the meter, on
 * the kerb edge. Placing them against the shopfront instead would put them
 * inside the walking lane on a 2.5 m footway, which is most of this city.
 *
 *   zone     'strip'    the furnishing strip, back of the kerb outward
 *            'kerbEdge' sitting on the kerb itself, feet toward the gutter
 *   facing   'road'     out across the carriageway (waiting to cross)
 *            'building' back at the shopfront
 *            'along'    along the street
 *            'pair'     at the other half of a conversation
 *   corner   only chosen within `CORNER_ZONE_METRES` of a junction
 */
const ACTIVITY_CATALOGUE = Object.freeze([
  { activity: 'wait', zone: 'strip', facing: 'road', weight: 0.7, corner: true },
  { activity: 'phone', zone: 'strip', facing: 'along', weight: 0.85, corner: false },
  { activity: 'talk', zone: 'strip', facing: 'pair', weight: 1.0, corner: false, pair: 'listen' },
  { activity: 'browse', zone: 'strip', facing: 'building', weight: 0.7, corner: false },
  { activity: 'lean', zone: 'strip', facing: 'road', weight: 0.5, corner: false },
  { activity: 'sit', zone: 'kerbEdge', facing: 'road', weight: 0.4, corner: false },
  { activity: 'carry', zone: 'strip', facing: 'along', weight: 0.45, corner: false },
  { activity: 'stand', zone: 'strip', facing: 'along', weight: 0.5, corner: false },
]);

/**
 * Clearance the walking simulation's through-route keeps from a stationary
 * figure. `buildSidewalkPaths` walks its agents 1.0 m in from the property
 * line with up to 0.38 m of lateral scatter, so on the narrowest footway this
 * pass populates the two never come closer than this.
 */
export const WALKER_LANE_CLEARANCE_M = 0.45;

/** How close to a junction a figure has to be to count as "at the corner". */
const CORNER_ZONE_METRES = 7;
/** Extra waiting figures placed at each signalised junction approach. */
const CROSSING_QUEUE = Object.freeze({ min: 1, max: 4, spacing: 0.78 });
/** Plan-radius of a standing figure, for the overlap test against street props. */
const FIGURE_RADIUS = 0.34;
/** Kerb stall pitch: a 4.6 m car plus a 1.8 m manoeuvring gap. */
const PARKING_PITCH = 6.4;
/** No stall inside this distance of a junction mouth. */
const PARKING_END_CLEARANCE = 8.5;
/** A stall this close to a legacy parked car is already taken. */
const PARKING_DEDUPE_RADIUS = 3.2;

const TAU = Math.PI * 2;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The two vertical planes the renderer pins for the whole street.
 *
 * `src/citygen/renderer.js` builds the surface with a gutter cut 40 mm below
 * the carriageway datum and a curb face sized so the footway lands exactly
 * 45 mm above that datum, because street lamps, sidewalk props and the seated
 * hero actors are already grounded there. Reproduced here rather than imported
 * so this pass shares no mutable state with the renderer, and asserted against
 * the same numbers by the verifier.
 */
export function streetLifeSurfaceOptions(city) {
  const defaults = STREET_SURFACE_V2_DEFAULTS;
  const roadLift = Number(city?.meta?.streetDesign?.roadLift ?? defaults.roadLift);
  const datum = Number.isFinite(roadLift) ? roadLift : defaults.roadLift;
  const gutterDepth = 0.04;
  const legacyFootwayLift = 0.045;
  return {
    roadLift: datum,
    gutterDepth,
    curbFaceHeight: legacyFootwayLift + gutterDepth + defaults.curbTopFall,
  };
}

// ---------------------------------------------------------------------------
// district density
// ---------------------------------------------------------------------------

/**
 * Coarse building-mass grid, used to tell a downtown block from a warehouse
 * street without a per-anchor spatial query. One cell per `cellSize` metres
 * holding total floor area; `at()` returns a 0..1 density that saturates at
 * `fullMass`, so a tower cluster and a two-storey terrace get different crowds.
 */
export function buildDistrictDensity(city, { cellSize = 110, fullMass = 26000 } = {}) {
  const bounds = city?.meta?.bounds;
  const buildings = Array.isArray(city?.buildings) ? city.buildings : [];
  const minX = Number(bounds?.minX);
  const minZ = Number(bounds?.minZ);
  const maxX = Number(bounds?.maxX);
  const maxZ = Number(bounds?.maxZ);
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) {
    return { at: () => 0.6, cells: 0, cellSize };
  }
  const width = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const height = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const grid = new Float64Array(width * height);
  for (const building of buildings) {
    const polygon = building?.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    let area = 0;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      area += a.x * b.z - b.x * a.z;
      cx += a.x;
      cz += a.z;
    }
    area = Math.abs(area / 2);
    cx /= polygon.length;
    cz /= polygon.length;
    const levels = Math.max(1, Number(building.levels) || Math.round((Number(building.height) || 8) / 3.3));
    const gx = clamp(Math.floor((cx - minX) / cellSize), 0, width - 1);
    const gz = clamp(Math.floor((cz - minZ) / cellSize), 0, height - 1);
    grid[gz * width + gx] += area * levels;
  }
  return {
    cells: width * height,
    cellSize,
    at(x, z) {
      const gx = clamp(Math.floor((x - minX) / cellSize), 0, width - 1);
      const gz = clamp(Math.floor((z - minZ) / cellSize), 0, height - 1);
      // Blur over the 3x3 neighbourhood: a block's crowd does not stop dead at
      // a grid line.
      let sum = 0;
      let n = 0;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const ix = gx + dx;
          const iz = gz + dz;
          if (ix < 0 || iz < 0 || ix >= width || iz >= height) continue;
          sum += grid[iz * width + ix];
          n += 1;
        }
      }
      const mass = n ? sum / n : 0;
      // Even a quiet street has somebody on it: floor at 0.22.
      return 0.22 + 0.78 * clamp(mass / fullMass, 0, 1);
    },
  };
}

// ---------------------------------------------------------------------------
// exclusions
// ---------------------------------------------------------------------------

/**
 * A hash grid of everything already standing on this street, harvested from the
 * finished scene graph rather than guessed at.
 *
 * Passes with a lower `order` (street furniture, and the legacy renderer's own
 * lamps, props, trees and parked cars) have already added their content to
 * `ctx.root` by the time this runs, so their instance translations are readable
 * facts. Only compact instanced content is harvested: a road ribbon or a
 * building shell is a single big merged mesh and is filtered out by its
 * bounding radius, which is also what keeps this scan cheap.
 */
export function collectStreetOccupancy(root, {
  cell = 6,
  maxPoints = 24000,
  maxRadius = 7,
  match = null,
} = {}) {
  const buckets = new Map();
  let points = 0;
  const position = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const add = (x, z, radius) => {
    if (points >= maxPoints) return;
    points += 1;
    const key = `${Math.floor(x / cell)}:${Math.floor(z / cell)}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(x, z, radius);
  };
  if (root && typeof root.traverse === 'function') {
    root.traverse((node) => {
      if (points >= maxPoints) return;
      if (!node.isInstancedMesh || !node.geometry) return;
      if (match && !match.test(node.name || '')) return;
      const geometry = node.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const radius = geometry.boundingSphere ? geometry.boundingSphere.radius : 0;
      if (!(radius > 0) || radius > maxRadius) return;
      const count = Math.min(node.count ?? 0, node.instanceMatrix?.count ?? 0);
      const footprint = Math.min(radius, 1.4);
      for (let i = 0; i < count; i += 1) {
        matrix.fromArray(node.instanceMatrix.array, i * 16);
        position.setFromMatrixPosition(matrix);
        add(position.x, position.z, footprint);
      }
    });
  }
  return {
    points,
    cell,
    /** True when `(x,z)` is within `margin` metres of anything already there. */
    blocked(x, z, margin) {
      const gx = Math.floor(x / cell);
      const gz = Math.floor(z / cell);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const list = buckets.get(`${gx + dx}:${gz + dz}`);
          if (!list) continue;
          for (let i = 0; i < list.length; i += 3) {
            const ex = list[i];
            const ez = list[i + 1];
            const er = list[i + 2];
            const reach = margin + er;
            if ((ex - x) * (ex - x) + (ez - z) * (ez - z) < reach * reach) return true;
          }
        }
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// anchor planning
// ---------------------------------------------------------------------------

function pickActivity(seed, salt, atCorner) {
  let total = 0;
  for (const entry of ACTIVITY_CATALOGUE) {
    if (entry.corner && !atCorner) continue;
    total += entry.weight;
  }
  let roll = identityRandom(seed, salt) * total;
  let chosen = null;
  for (const entry of ACTIVITY_CATALOGUE) {
    if (entry.corner && !atCorner) continue;
    chosen = entry;
    roll -= entry.weight;
    if (roll <= 0) break;
  }
  return chosen || ACTIVITY_CATALOGUE[ACTIVITY_CATALOGUE.length - 1];
}

/** Yaw that faces `(dx, dz)`; the rig's forward is +Z at yaw 0. */
function yawTo(dx, dz) {
  return Math.atan2(dx, dz);
}

/**
 * Every stationary figure in the city, as plain data.
 *
 * Placement rules, in order:
 *   1. only on a side that actually has a footway wide enough to stand on;
 *   2. inside the footway band, at the kerb edge or the property-line edge,
 *      never in the through-route the walking simulation uses;
 *   3. never within `FIGURE_RADIUS + item radius` of a prop already there;
 *   4. never within 0.7 m of another figure, except a conversation pair, which
 *      is deliberately 0.92 m apart and facing;
 *   5. grounded on `sidewalkSurfaceY` at its own lateral offset, so a figure on
 *      a cross-falling footway stands on the footway and not through it.
 *
 * @returns {{anchors: Array, rejected: object, sampledSegments: number}}
 */
export function planStreetLifeAnchors(plan, {
  hour = 12,
  density = null,
  occupancy = null,
  heightAt = () => 0,
  maxAnchors = STREET_LIFE_BUDGET.maxAnchors,
} = {}) {
  const anchors = [];
  const rejected = { noBand: 0, tooShort: 0, blocked: 0, crowded: 0, capped: 0 };
  const options = plan.options;
  const hourFactor = streetLifeHourFactor(hour);
  const districtAt = density ? (x, z) => density.at(x, z) : () => 0.7;
  // Figures already placed, so two of them cannot occupy one square metre.
  const placed = new Map();
  const claim = (x, z, radius) => {
    const key = `${Math.floor(x / 2)}:${Math.floor(z / 2)}`;
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const list = placed.get(`${Math.floor(x / 2) + dx}:${Math.floor(z / 2) + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          const ddx = list[i] - x;
          const ddz = list[i + 1] - z;
          if (ddx * ddx + ddz * ddz < radius * radius) return false;
        }
      }
    }
    let list = placed.get(key);
    if (!list) {
      list = [];
      placed.set(key, list);
    }
    list.push(x, z);
    return true;
  };

  let sampledSegments = 0;
  for (const segment of plan.segments) {
    if (anchors.length >= maxAnchors) { rejected.capped += 1; break; }
    const classWeight = STREET_LIFE_CLASS_WEIGHT[segment.className] ?? 0.4;
    if (classWeight <= 0) continue;
    const usableStart = segment.trimStart;
    const usableEnd = segment.length - segment.trimEnd;
    const usable = usableEnd - usableStart;
    if (!(usable > 6)) { rejected.tooShort += 1; continue; }
    sampledSegments += 1;
    const seed = identitySeed(`street-life:${segment.id}`);

    for (const side of [1, -1]) {
      const band = sidewalkBand(segment, side, options, 1.2);
      if (!band) { rejected.noBand += 1; continue; }
      const midStation = streetStationAt(segment, (usableStart + usableEnd) / 2);
      const district = districtAt(midStation.x, midStation.z);
      const expected = usable * STREET_LIFE_LINE_DENSITY * classWeight * district * hourFactor;
      // Deterministic rounding: the fractional part becomes a probability, so a
      // short block still occasionally gets its one person.
      const whole = Math.floor(expected);
      const extra = identityRandom(seed, `count-${side}`) < (expected - whole) ? 1 : 0;
      let count = whole + extra;
      // Junction approaches get a queue on top of the line density: that is
      // what makes a red light look like a red light.
      const queues = [];
      for (const [node, station] of [[segment.nodeStart, usableStart + 1.8], [segment.nodeEnd, usableEnd - 1.8]]) {
        if (!node || node.degree < 3) continue;
        // A queue belongs at a crossing people actually wait at: a signalised
        // junction, or one where a collector or better meets the street. Every
        // three-way service turn-off getting a queue is what turns a city into
        // a crowd of people standing about doing nothing.
        if (!node.signalised && node.maxClassRank < 5) continue;
        const queueSeed = identityRandom(seed, `queue-${side}-${station.toFixed(1)}`);
        if (queueSeed > 0.5) continue;
        const size = Math.round(
          CROSSING_QUEUE.min + (queueSeed * 2) * (CROSSING_QUEUE.max - CROSSING_QUEUE.min)
          * district * hourFactor,
        );
        if (size > 0) queues.push({ station, size });
      }
      count = Math.min(count, 24);

      const emit = (station, forcedActivity, groupId, pairIndex) => {
        if (anchors.length >= maxAnchors) return false;
        const s = clamp(station, usableStart + 0.6, usableEnd - 0.6);
        const frame = streetStationAt(segment, s);
        const atCorner = Math.min(s - usableStart, usableEnd - s) <= CORNER_ZONE_METRES
          && (segment.nodeStart || segment.nodeEnd);
        const salt = `act-${side}-${s.toFixed(2)}`;
        const entry = forcedActivity
          || pickActivity(seed, salt, Boolean(atCorner));
        // Lateral offset inside the band, measured from the centreline.
        const jitter = identityRandom(seed, `lat-${salt}`) * 0.16;
        const offset = entry.zone === 'kerbEdge'
          // Perched on the kerb top, which is a seat every city provides.
          ? band.inner - 0.06
          : band.inner + 0.34 + jitter;
        if (offset < band.inner - 0.1) return false;
        // Never inside the lane the walking simulation uses.
        const walkerLane = band.outer - 1.0;
        if (offset > walkerLane - WALKER_LANE_CLEARANCE_M) return false;
        const u = offset * side;
        const x = frame.x + frame.nx * u * frame.miter;
        const z = frame.z + frame.nz * u * frame.miter;
        if (occupancy && occupancy.blocked(x, z, FIGURE_RADIUS)) { rejected.blocked += 1; return false; }
        if (!claim(x, z, groupId ? 0.55 : 0.78)) { rejected.crowded += 1; return false; }
        const datum = heightAt(x, z) + options.roadLift;
        const y = sidewalkSurfaceY(datum, u, segment.half, options);
        // Facing.
        const outward = { x: frame.nx * side, z: frame.nz * side };
        let yaw;
        switch (entry.facing) {
          case 'road': yaw = yawTo(-outward.x, -outward.z); break;
          case 'building': yaw = yawTo(outward.x, outward.z); break;
          case 'pair': yaw = pairIndex === 1
            ? yawTo(-frame.tx, -frame.tz)
            : yawTo(frame.tx, frame.tz); break;
          default: yaw = yawTo(frame.tx, frame.tz) + (identityRandom(seed, `yaw-${salt}`) - 0.5) * 0.7;
        }
        const id = `sl-${segment.id}-${side > 0 ? 'l' : 'r'}-${anchors.length}`;
        anchors.push({
          id,
          seed: identitySeed(id),
          x,
          y,
          z,
          yaw,
          activity: entry.activity,
          seated: entry.activity === 'sit',
          groupId: groupId || null,
          segmentId: segment.id,
          side,
          className: segment.className,
        });
        return true;
      };

      for (const queue of queues) {
        for (let i = 0; i < queue.size; i += 1) {
          emit(queue.station + i * CROSSING_QUEUE.spacing, ACTIVITY_CATALOGUE[0], `q-${segment.id}-${side}-${queue.station.toFixed(0)}`, 0);
        }
      }
      for (let i = 0; i < count; i += 1) {
        const t = (i + 0.5 + (identityRandom(seed, `jit-${side}-${i}`) - 0.5) * 0.7) / Math.max(1, count);
        const station = usableStart + t * usable;
        const atCorner = Math.min(station - usableStart, usableEnd - station) <= CORNER_ZONE_METRES
          && (segment.nodeStart || segment.nodeEnd);
        const entry = pickActivity(seed, `pick-${side}-${i}`, Boolean(atCorner));
        if (entry.pair) {
          const groupId = `pair-${segment.id}-${side}-${i}`;
          const partner = ACTIVITY_CATALOGUE.find((candidate) => candidate.activity === entry.pair) || entry;
          emit(station, entry, groupId, 0);
          emit(station + 0.92, { ...partner, zone: entry.zone, facing: 'pair' }, groupId, 1);
        } else {
          emit(station, entry, null, 0);
        }
      }
    }
  }
  return { anchors, rejected, sampledSegments };
}

/**
 * Kerb stalls, as plain data.
 *
 * Stalls sit on the carriageway surface 1.3 m in from the kerb line, which is
 * the same lateral offset and the same datum the legacy map-wide parked-car
 * layer uses, so the two layers form one continuous line of cars rather than
 * two offset ones. Any stall the legacy layer already filled is dropped.
 */
export function planKerbParking(plan, {
  occupancy = null,
  heightAt = () => 0,
  maxSpots = STREET_LIFE_BUDGET.maxParkingSpots,
  occupancyRate = 0.66,
} = {}) {
  const spots = [];
  const rejected = { narrow: 0, classFiltered: 0, taken: 0, empty: 0, capped: 0 };
  const options = plan.options;
  for (const segment of plan.segments) {
    if (spots.length >= maxSpots) { rejected.capped += 1; break; }
    const weight = STREET_LIFE_CLASS_WEIGHT[segment.className] ?? 0;
    if (!(weight > 0.3) || segment.className === 'pedestrian') { rejected.classFiltered += 1; continue; }
    if (segment.half < 3.4) { rejected.narrow += 1; continue; }
    const start = segment.trimStart + PARKING_END_CLEARANCE;
    const end = segment.length - segment.trimEnd - PARKING_END_CLEARANCE;
    if (!(end - start > PARKING_PITCH)) { rejected.narrow += 1; continue; }
    const seed = identitySeed(`kerb:${segment.id}`);
    const stalls = Math.floor((end - start) / PARKING_PITCH);
    for (const side of [1, -1]) {
      const band = sidewalkBand(segment, side, options, 1.2);
      if (!band) continue;
      for (let i = 0; i < stalls; i += 1) {
        if (spots.length >= maxSpots) break;
        const salt = `${side}-${i}`;
        if (identityRandom(seed, `use-${salt}`) > occupancyRate) { rejected.empty += 1; continue; }
        const s = start + (i + 0.5) * PARKING_PITCH;
        const frame = streetStationAt(segment, s);
        const u = (segment.half - 1.3) * side;
        const x = frame.x + frame.nx * u * frame.miter;
        const z = frame.z + frame.nz * u * frame.miter;
        if (occupancy && occupancy.blocked(x, z, PARKING_DEDUPE_RADIUS)) { rejected.taken += 1; continue; }
        const datum = heightAt(x, z) + options.roadLift;
        const y = carriagewaySurfaceY(datum, u, segment.half, options);
        // Nose in the direction of travel on that side of the road, with a
        // small parking error so the line is not machine-perfect.
        const along = side > 0 ? 1 : -1;
        const yaw = yawTo(frame.tx * along, frame.tz * along)
          + (identityRandom(seed, `skew-${salt}`) - 0.5) * 0.06;
        spots.push({
          id: `${segment.id}:${salt}`,
          seed: identitySeed(`kerb-car:${segment.id}:${salt}`),
          x,
          y,
          z,
          yaw,
          segmentId: segment.id,
        });
      }
    }
  }
  return { spots, rejected };
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** Parked-car paint: desaturated street colours, never a toybox. */
const CAR_PAINT = Object.freeze([
  0x9aa0a4, 0x2f3438, 0xb8bcbd, 0x3d4b57, 0x6d6257, 0x8c3a33, 0x2f4f45,
  0xc9c4b6, 0x4a4f55, 0x7a848c, 0x35414d, 0x5d4a3f,
]);

function boxInto(target, size, offset) {
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geometry.translate(offset[0], offset[1], offset[2]);
  target.push(geometry);
  return geometry;
}

/**
 * Concatenate non-indexed geometries carrying only position/normal/uv. Written
 * inline: `three/addons` is off the WebGPU renderer path, and this is 20 lines.
 */
function mergeSimple(list) {
  const parts = list.map((geometry) => geometry.toNonIndexed());
  let total = 0;
  for (const part of parts) total += part.attributes.position.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let v = 0;
  for (const part of parts) {
    position.set(part.attributes.position.array, v * 3);
    normal.set(part.attributes.normal.array, v * 3);
    if (part.attributes.uv) uv.set(part.attributes.uv.array, v * 2);
    v += part.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  for (const part of parts) part.dispose();
  for (const geometry of list) if (!parts.includes(geometry)) geometry.dispose();
  return out;
}

/**
 * A parked car in two pieces so the glass can be a different material: hull
 * (body plus four wheels, 116 tri) and cabin (12 tri). Origin at the tyre
 * contact patch, nose toward +Z, which matches the anchor yaw convention.
 */
export function buildParkedCarGeometry() {
  const hullParts = [];
  boxInto(hullParts, [1.80, 0.62, 4.34], [0, 0.70, 0]);
  boxInto(hullParts, [1.68, 0.20, 3.30], [0, 1.05, -0.05]);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.21, 8);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(sx * 0.83, 0.33, sz * 1.34);
      hullParts.push(wheel);
    }
  }
  const cabinParts = [];
  boxInto(cabinParts, [1.56, 0.54, 2.05], [0, 1.34, -0.18]);
  return {
    hull: mergeSimple(hullParts),
    cabin: mergeSimple(cabinParts),
  };
}

/** A soft round blob, reused from the crowd's contact-shadow recipe. */
function buildBlobTexture(size = 32) {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const r = Math.min(1, Math.hypot(dx, dy));
      const a = Math.round(255 * (1 - r) * (1 - r) * (1 - r * 0.35));
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = a;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** One InstancedMesh per `"<bone>|<group>"` key, keyed the way the crowd is. */
function createBand(name, geometries, capacity, { castShadow }) {
  const group = new THREE.Group();
  group.name = name;
  const meshes = [];
  const materials = new Map();
  for (const [key, entry] of geometries) {
    let material = materials.get(entry.group);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: entry.group === 'shoes' ? 0.7 : 0.88,
        metalness: 0,
      });
      material.name = `street-life-${entry.group}`;
      materials.set(entry.group, material);
    }
    const mesh = new THREE.InstancedMesh(entry.geometry, material, Math.max(1, capacity));
    mesh.name = `${name}-${key.replace(/\|/g, '-')}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.setColorAt(0, new THREE.Color(0xffffff));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    meshes.push({ key, bone: entry.bone, group: entry.group, flag: entry.flag ?? null, mesh });
    group.add(mesh);
  }
  return { group, meshes, materials, capacity: Math.max(1, capacity) };
}

/** A bone-only Object3D tree used to evaluate one figure's pose at a time. */
function buildPoser() {
  const root = new THREE.Group();
  root.name = 'street-life-poser';
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
}

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

function viewPosition(ctx, out) {
  const camera = ctx?.camera;
  if (camera && camera.isCamera) {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    out.x = e[12];
    out.y = e[13];
    out.z = e[14];
    return out;
  }
  const focus = ctx?.focus;
  out.x = Number(focus?.x) || 0;
  out.y = Number(focus?.y) || 0;
  out.z = Number(focus?.z) || 0;
  return out;
}

function createStreetLife() {
  let state = null;

  function dispose() {
    if (!state) return;
    for (const band of [state.near, state.mid, state.nearWardrobe, state.midWardrobe]) {
      if (!band) continue;
      for (const item of band.meshes) {
        item.mesh.geometry.dispose();
        item.mesh.dispose();
      }
      for (const material of band.materials.values()) material.dispose();
    }
    state.shadowMesh?.geometry.dispose();
    state.shadowMesh?.dispose();
    state.shadowMaterial?.map?.dispose();
    state.shadowMaterial?.dispose();
    for (const mesh of state.carMeshes || []) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
    state = null;
  }

  function build(ctx) {
    dispose();
    const city = ctx?.city;
    const segments = Array.isArray(city?.segments) ? city.segments : [];
    const heightAt = typeof ctx?.heightAt === 'function' ? ctx.heightAt : () => 0;
    const diagnostics = {
      version: STREET_LIFE_VERSION,
      implemented: true,
      figures: { planned: 0, near: 0, mid: 0, culled: 0 },
      parking: { planned: 0, drawn: 0 },
      budget: STREET_LIFE_BUDGET,
    };
    if (!segments.length) {
      return { object: null, diagnostics: { ...diagnostics, reason: 'no-street-contract' } };
    }

    const overrides = streetLifeSurfaceOptions(city);
    const plan = buildStreetscapePlan(city, { ...overrides, heightAt, inferNodes: true });
    if (!plan.segments.length) {
      return { object: null, diagnostics: { ...diagnostics, reason: 'no-plan-segments' } };
    }

    const object = new THREE.Group();
    object.name = 'street-life';
    // Two occupancy sets, because they answer two different questions.
    // `occupancy` is everything standing on the footway, which is what a figure
    // must not be inside. `vehicles` is only the parked cars already on the
    // carriageway, which is what a kerb stall must not double-book - testing a
    // stall against footway props would reject the whole kerb.
    const occupancy = collectStreetOccupancy(ctx?.root);
    const vehicles = collectStreetOccupancy(ctx?.root, { match: /car|vehicle/i });
    const density = buildDistrictDensity(city);
    const hour = Number.isFinite(ctx?.hour) ? ctx.hour : 12;
    const planned = planStreetLifeAnchors(plan, { hour, density, occupancy, heightAt });
    const parking = planKerbParking(plan, { occupancy: vehicles, heightAt });

    const nearRing = STREET_LIFE_RINGS[0];
    const midRing = STREET_LIFE_RINGS[1];
    const near = createBand(
      'street-life-near',
      buildInstancedPartGeometries({ detail: 'mid', radialSegments: 5 }),
      nearRing.budget,
      { castShadow: true },
    );
    const nearWardrobe = createBand(
      'street-life-near-wardrobe',
      buildWardrobeGeometries({ detail: 'mid', radialSegments: 5 }),
      nearRing.budget,
      { castShadow: true },
    );
    const mid = createBand(
      'street-life-mid',
      buildInstancedPartGeometries({ detail: 'far', radialSegments: 4, mergeToRoot: true }),
      midRing.budget,
      { castShadow: false },
    );
    const midWardrobe = createBand(
      'street-life-mid-wardrobe',
      buildWardrobeGeometries({ detail: 'far', radialSegments: 4, mergeToRoot: true }),
      midRing.budget,
      { castShadow: false },
    );
    object.add(near.group, nearWardrobe.group, mid.group, midWardrobe.group);

    // Contact shadows. Same recipe as the walking crowd's, so a standing figure
    // and a walking one sit on the pavement the same way.
    const shadowTexture = buildBlobTexture();
    const shadowMaterial = new THREE.MeshBasicMaterial({
      map: shadowTexture,
      color: 0x080b0e,
      transparent: true,
      opacity: CONTACT_SHADOW.baseOpacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    shadowMaterial.name = 'street-life-contact-shadow';
    const shadowCapacity = nearRing.budget + midRing.budget + STREET_LIFE_BUDGET.parkedCars;
    const shadowMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      shadowMaterial,
      shadowCapacity,
    );
    shadowMesh.name = 'street-life-contact-shadows';
    shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shadowMesh.frustumCulled = false;
    shadowMesh.renderOrder = 2;
    shadowMesh.count = 0;
    object.add(shadowMesh);

    // Kerb parking.
    const carGeometry = buildParkedCarGeometry();
    const hullMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.46, metalness: 0.32, flatShading: true,
    });
    hullMaterial.name = 'street-life-car-hull';
    const cabinMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.16, metalness: 0.44, flatShading: true,
    });
    cabinMaterial.name = 'street-life-car-cabin';
    const carMeshes = [];
    for (const [geometry, material, label] of [
      [carGeometry.hull, hullMaterial, 'hull'],
      [carGeometry.cabin, cabinMaterial, 'cabin'],
    ]) {
      const mesh = new THREE.InstancedMesh(geometry, material, STREET_LIFE_BUDGET.parkedCars);
      mesh.name = `street-life-kerb-car-${label}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.setColorAt(0, new THREE.Color(0xffffff));
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      carMeshes.push(mesh);
      object.add(mesh);
    }

    // Per-figure appearance is resolved once and cached; it never changes.
    const figures = planned.anchors.map((anchor) => {
      const variation = identityVariation(anchor.seed);
      const wardrobe = identityWardrobe(anchor.seed);
      return {
        anchor,
        variation,
        wardrobe,
        signature: appearanceSignature(anchor.seed),
        // Standing on the footway means the sole is on the footway; the rig's
        // root is the pelvis, which is `hip height x scale` above it.
        rootY: anchor.y + (anchor.seated ? -ACTIVITY_ROOT_DROP.sit * variation.heightScale : 0),
        distance: Infinity,
        ring: null,
      };
    });

    state = {
      object,
      near,
      nearWardrobe,
      mid,
      midWardrobe,
      shadowMesh,
      shadowMaterial,
      carMeshes,
      figures,
      parking: parking.spots,
      poser: buildPoser(),
      overlay: {},
      time: 0,
      replanIn: 0,
      lastView: { x: Infinity, y: 0, z: Infinity },
      view: { x: 0, y: 0, z: 0 },
      active: { near: [], mid: [] },
      activeParking: [],
      scratch: {
        object3d: new THREE.Object3D(),
        colour: new THREE.Color(),
        euler: new THREE.Euler(0, 0, 0, 'XYZ'),
        quaternion: new THREE.Quaternion(),
      },
      diagnostics: {
        version: STREET_LIFE_VERSION,
        implemented: true,
        planVersion: plan.version,
        planStats: plan.stats,
        hour,
        surface: overrides,
        figures: {
          planned: figures.length,
          near: 0,
          mid: 0,
          culled: 0,
          rejected: planned.rejected,
          sampledSegments: planned.sampledSegments,
        },
        appearance: {
          uniqueSignatures: new Set(figures.map((f) => f.signature)).size,
          total: figures.length,
        },
        activities: figures.reduce((acc, f) => {
          acc[f.anchor.activity] = (acc[f.anchor.activity] || 0) + 1;
          return acc;
        }, {}),
        grounding: { maxOffset: 0, meanOffset: 0, samples: 0 },
        parking: {
          planned: parking.spots.length,
          drawn: 0,
          rejected: parking.rejected,
          legacyOccupancyPoints: occupancy.points,
          legacyVehiclePoints: vehicles.points,
        },
        budget: STREET_LIFE_BUDGET,
        cost: { triangles: 0, drawCalls: 0 },
      },
    };

    // Grounding self-report: how far each figure's foot plane is from the
    // footway surface the street contract says is under it. Zero by
    // construction; measured anyway, because "by construction" is how a
    // floating crowd ships.
    let maxOffset = 0;
    let sumOffset = 0;
    for (const figure of figures) {
      const segment = plan.segmentById.get(figure.anchor.segmentId);
      if (!segment) continue;
      const datum = heightAt(figure.anchor.x, figure.anchor.z) + plan.options.roadLift;
      // Re-derive the lateral offset from the placed point rather than trusting
      // the value that placed it.
      const frame = streetStationAt(segment, 0);
      const along = { x: segment.points.at(-1).x - frame.x, z: segment.points.at(-1).z - frame.z };
      const len = Math.hypot(along.x, along.z) || 1;
      const nx = -along.z / len;
      const nz = along.x / len;
      const u = (figure.anchor.x - frame.x) * nx + (figure.anchor.z - frame.z) * nz;
      const expected = sidewalkSurfaceY(datum, u, segment.half, plan.options);
      const offset = Math.abs(figure.anchor.y - expected);
      if (offset > maxOffset) maxOffset = offset;
      sumOffset += offset;
    }
    state.diagnostics.grounding = {
      maxOffset,
      meanOffset: figures.length ? sumOffset / figures.length : 0,
      samples: figures.length,
    };

    // First plan against whatever view the build already knows about, so the
    // pass is never empty for a frame.
    replan(ctx, true);
    return { object, diagnostics: state.diagnostics };
  }

  /** Re-select which figures and stalls are drawn, nearest first. */
  function replan(ctx, force = false) {
    if (!state) return;
    const view = viewPosition(ctx, state.view);
    const moved = Math.hypot(view.x - state.lastView.x, view.z - state.lastView.z);
    if (!force && moved < 6 && state.replanIn > 0) return;
    state.replanIn = 0.5;
    state.lastView.x = view.x;
    state.lastView.y = view.y;
    state.lastView.z = view.z;

    const nearRing = STREET_LIFE_RINGS[0];
    const midRing = STREET_LIFE_RINGS[1];
    const candidates = [];
    for (const figure of state.figures) {
      const dx = figure.anchor.x - view.x;
      const dz = figure.anchor.z - view.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > midRing.radius * midRing.radius) continue;
      figure.distance = Math.sqrt(d2);
      candidates.push(figure);
    }
    candidates.sort((a, b) => a.distance - b.distance
      || (a.anchor.id < b.anchor.id ? -1 : a.anchor.id > b.anchor.id ? 1 : 0));
    const nearList = state.active.near;
    const midList = state.active.mid;
    nearList.length = 0;
    midList.length = 0;
    for (const figure of candidates) {
      if (figure.distance <= nearRing.radius && nearList.length < nearRing.budget) {
        figure.ring = 'near';
        nearList.push(figure);
      } else if (midList.length < midRing.budget) {
        figure.ring = 'mid';
        midList.push(figure);
      } else {
        figure.ring = null;
      }
    }
    state.diagnostics.figures.near = nearList.length;
    state.diagnostics.figures.mid = midList.length;
    state.diagnostics.figures.culled = state.figures.length - nearList.length - midList.length;

    const parkingRadius2 = STREET_LIFE_BUDGET.parkingRadius * STREET_LIFE_BUDGET.parkingRadius;
    const stalls = [];
    for (const spot of state.parking) {
      const dx = spot.x - view.x;
      const dz = spot.z - view.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > parkingRadius2) continue;
      stalls.push({ spot, distance: Math.sqrt(d2) });
    }
    stalls.sort((a, b) => a.distance - b.distance
      || (a.spot.id < b.spot.id ? -1 : a.spot.id > b.spot.id ? 1 : 0));
    state.activeParking = stalls.slice(0, STREET_LIFE_BUDGET.parkedCars);
    writeParking();
    // A re-plan changed which figures exist, so every static buffer is stale.
    writeFrame(0, true);
  }

  function writeParking() {
    const { object3d, colour } = state.scratch;
    let index = 0;
    for (const stall of state.activeParking) {
      const spot = stall.spot;
      object3d.position.set(spot.x, spot.y, spot.z);
      object3d.rotation.set(0, spot.yaw, 0);
      object3d.scale.set(1, 1, 1);
      object3d.updateMatrix();
      const paint = CAR_PAINT[Math.floor(identityRandom(spot.seed, 'paint') * CAR_PAINT.length) % CAR_PAINT.length];
      for (let m = 0; m < state.carMeshes.length; m += 1) {
        const mesh = state.carMeshes[m];
        mesh.setMatrixAt(index, object3d.matrix);
        colour.setHex(m === 0 ? paint : 0x2b3238, THREE.SRGBColorSpace);
        mesh.setColorAt(index, colour);
      }
      index += 1;
    }
    for (const mesh of state.carMeshes) {
      mesh.count = index;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    state.diagnostics.parking.drawn = index;
  }

  /**
   * Write instance matrices.
   *
   * Only the near ring moves: those figures are running an activity overlay and
   * are re-posed every frame. A mid-ring figure, its contact shadow and every
   * parked car are motionless, so they are written once per re-plan and left
   * alone - which is what keeps the steady-state cost of a 160-figure street
   * proportional to the 56 figures that are actually animating.
   */
  function writeFrame(delta, statics = false) {
    if (!state) return;
    const { object3d, colour, euler, quaternion } = state.scratch;
    const poser = state.poser;
    state.time += delta;

    const nearCursor = new Map();
    let shadowIndex = 0;
    const shadowCapacity = state.shadowMesh.instanceMatrix.count;

    const writeShadow = (figure) => {
      if (shadowIndex >= shadowCapacity) return;
      const blob = contactShadowFor({
        speed: 0,
        heightScale: figure.variation.heightScale,
        buildScale: figure.variation.buildScale,
        groundClearance: 0,
        distance: figure.distance,
        sunElevationDeg: 45,
      });
      const fade = clamp(blob.opacity / CONTACT_SHADOW.baseOpacity, 0, 1);
      if (fade <= 0.08) return;
      object3d.position.set(figure.anchor.x, figure.anchor.y + blob.y, figure.anchor.z);
      object3d.rotation.set(0, figure.anchor.yaw, 0);
      const diameter = blob.radius * 2 * fade * (figure.anchor.seated ? 1.25 : 1);
      object3d.scale.set(diameter, 1, diameter * blob.lengthScale);
      object3d.updateMatrix();
      state.shadowMesh.setMatrixAt(shadowIndex, object3d.matrix);
      shadowIndex += 1;
    };

    // Near ring: full articulation. The overlay is evaluated per figure and the
    // bone tree is posed once, then read out into the instanced meshes.
    for (const figure of state.active.near) {
      const anchor = figure.anchor;
      const overlay = evaluateActivityPose(anchor.activity, state.time, anchor.seed, state.overlay);
      // Mirror half the population so a street of talkers is not a street of
      // people all gesturing with the same hand.
      if (anchor.seed & 1) mirrorActivityPose(overlay);
      for (const name of PEDESTRIAN_BONE_NAMES) {
        const node = poser.byName.get(name);
        const angles = overlay && overlay[name];
        if (angles) {
          euler.set(angles[0], angles[1], angles[2], 'XYZ');
          quaternion.setFromEuler(euler);
          node.quaternion.copy(quaternion);
        } else {
          node.quaternion.identity();
        }
      }
      const scaleXZ = figure.variation.heightScale * figure.variation.buildScale;
      poser.root.position.set(anchor.x, figure.rootY, anchor.z);
      poser.root.rotation.set(0, anchor.yaw, 0);
      poser.root.scale.set(scaleXZ, figure.variation.heightScale, scaleXZ);
      poser.root.updateMatrixWorld(true);

      for (const item of state.near.meshes) {
        const cursor = nearCursor.get(item.key) || 0;
        if (cursor >= state.near.capacity) continue;
        const node = poser.byName.get(item.bone);
        item.mesh.setMatrixAt(cursor, node.matrixWorld);
        colour.setHex(figure.variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
        item.mesh.setColorAt(cursor, colour);
        nearCursor.set(item.key, cursor + 1);
      }
      for (const item of state.nearWardrobe.meshes) {
        if (!figure.wardrobe.flags[item.flag]) continue;
        const cursor = nearCursor.get(item.key) || 0;
        if (cursor >= state.nearWardrobe.capacity) continue;
        const node = poser.byName.get(item.bone);
        item.mesh.setMatrixAt(cursor, node.matrixWorld);
        colour.setHex(figure.variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
        item.mesh.setColorAt(cursor, colour);
        nearCursor.set(item.key, cursor + 1);
      }
      if (statics) writeShadow(figure);
    }

    if (!statics) {
      // Near ring only: commit the animated meshes and leave every static
      // buffer exactly as the last re-plan left it.
      let animatedDraws = 0;
      let animatedTriangles = 0;
      for (const item of [...state.near.meshes, ...state.nearWardrobe.meshes]) {
        const count = nearCursor.get(item.key) || 0;
        item.mesh.count = count;
        item.mesh.instanceMatrix.needsUpdate = true;
        if (item.mesh.instanceColor) item.mesh.instanceColor.needsUpdate = true;
        if (count > 0) {
          animatedDraws += 1;
          animatedTriangles += Math.floor(item.mesh.geometry.getAttribute('position').count / 3) * count;
        }
      }
      state.diagnostics.cost.animatedDrawCalls = animatedDraws;
      state.diagnostics.cost.animatedTriangles = animatedTriangles;
      return;
    }

    // Mid ring: one root matrix per figure, no articulation. A seated figure
    // keeps its root drop so it does not stand up when it crosses the boundary.
    let midIndex = 0;
    const midWardrobeCursor = new Map();
    for (const figure of state.active.mid) {
      if (midIndex >= state.mid.capacity) break;
      const anchor = figure.anchor;
      const scaleXZ = figure.variation.heightScale * figure.variation.buildScale;
      // The mid geometry is baked in CHARACTER space - soles at y = 0 - so the
      // root matrix puts the FEET on the footway, not the pelvis.
      object3d.position.set(
        anchor.x,
        anchor.y - (anchor.seated ? ACTIVITY_ROOT_DROP.sit * figure.variation.heightScale : 0),
        anchor.z,
      );
      object3d.rotation.set(0, anchor.yaw, 0);
      object3d.scale.set(scaleXZ, figure.variation.heightScale, scaleXZ);
      object3d.updateMatrix();
      for (const item of state.mid.meshes) {
        item.mesh.setMatrixAt(midIndex, object3d.matrix);
        colour.setHex(figure.variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
        item.mesh.setColorAt(midIndex, colour);
      }
      for (const item of state.midWardrobe.meshes) {
        if (!figure.wardrobe.flags[item.flag]) continue;
        const cursor = midWardrobeCursor.get(item.key) || 0;
        if (cursor >= state.midWardrobe.capacity) continue;
        item.mesh.setMatrixAt(cursor, object3d.matrix);
        colour.setHex(figure.variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
        item.mesh.setColorAt(cursor, colour);
        midWardrobeCursor.set(item.key, cursor + 1);
      }
      midIndex += 1;
      writeShadow(figure);
    }

    let drawCalls = 0;
    let triangles = 0;
    const commit = (item, count) => {
      item.mesh.count = count;
      item.mesh.instanceMatrix.needsUpdate = true;
      if (item.mesh.instanceColor) item.mesh.instanceColor.needsUpdate = true;
      if (count > 0) {
        drawCalls += 1;
        const position = item.mesh.geometry.getAttribute('position');
        triangles += Math.floor(position.count / 3) * count;
      }
    };
    for (const item of state.near.meshes) commit(item, nearCursor.get(item.key) || 0);
    for (const item of state.nearWardrobe.meshes) commit(item, nearCursor.get(item.key) || 0);
    for (const item of state.mid.meshes) commit(item, midIndex);
    for (const item of state.midWardrobe.meshes) commit(item, midWardrobeCursor.get(item.key) || 0);
    state.shadowMesh.count = shadowIndex;
    state.shadowMesh.instanceMatrix.needsUpdate = true;
    if (shadowIndex > 0) drawCalls += 1;
    for (const mesh of state.carMeshes) {
      if (mesh.count > 0) {
        drawCalls += 1;
        triangles += Math.floor(mesh.geometry.getAttribute('position').count / 3) * mesh.count;
      }
    }
    state.diagnostics.cost = { triangles, drawCalls };
  }

  return {
    id: STREET_LIFE_ID,
    order: 50,
    build(ctx) {
      try {
        return build(ctx);
      } catch (error) {
        dispose();
        return {
          object: null,
          diagnostics: {
            version: STREET_LIFE_VERSION,
            implemented: true,
            failure: String(error?.message || error),
          },
        };
      }
    },
    update(ctx, delta) {
      if (!state) return;
      const step = Number.isFinite(delta) ? clamp(delta, 0, 0.25) : 0;
      state.replanIn -= step;
      const before = state.replanIn;
      replan(ctx, false);
      // `replan` already rewrote everything when it fired; otherwise animate
      // the near ring only.
      if (state.replanIn === before) writeFrame(step, false);
    },
    dispose,
    /** Test seam: the live state, for the headless verifier. */
    _state: () => state,
  };
}

export default createStreetLife();
