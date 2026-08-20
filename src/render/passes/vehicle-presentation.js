// vehicle-presentation - presentation pass.
//
// Owner: Rendering / vehicles. Contract: src/render/pass-registry.js.
//
// WHAT THIS FIXES
//
// Every vehicle in the shipped world - parked and moving - is a slab. A flat
// box for the body, a smaller box for the cab, and nothing else: no wheels that
// read, no glass, no lamps, no bumper, no grille, no mirror, no plate. In the
// hero street and character cards those slabs stand three to eight metres from
// the camera, and `Docs/VISUAL_QUALITY_GATE.md` names "primitive vehicles
// dominate a hero street frame" as an automatic rejection condition.
//
// This pass replaces both populations from one catalogue:
//
//   PARKED. Kerb stalls are laid out along the carriageway from the street
//   contract, packed by the ACTUAL length of the vehicle that takes the stall
//   rather than a fixed pitch, set off from the kerb by a plausible gap, and
//   rejected with a recorded reason when they do not fit. Every vehicle is
//   pitched and rolled onto the local road plane, so all four wheels touch the
//   carriageway on a San Francisco hill instead of one corner floating.
//
//   MOVING. `src/citygen/traffic.js` owns the vehicles' identity, path and
//   speed. This pass MIRRORS them: it reads the simulation's own transforms out
//   of the scene graph every frame and writes nothing back. Steering angle,
//   wheel spin, brake lamps and indicators are derived from the mirrored motion
//   - presentation state computed from simulation state, never the reverse.
//
// GROUNDING. The carriageway is not bare terrain. It is `roadLift` above the
// terrain, with a crown and a gutter, and the footway is 45 mm above that. The
// datum comes from `ctx.streetSurfaceOptions` - the exact options the paved
// surface was built with - and never from an assumption.
//
// BUDGET. Three distance rings from `ctx.focus` decide the level of detail and
// whether a vehicle exists at all; the mirrored traffic is always built at the
// near level of detail because it is the most looked-at thing in the frame.
// Rings, caps and the measured cost are all in the returned diagnostics.
//
// Determinism: no Math.random, no Date.now in placement. Every choice is a hash
// of a segment id, so two builds of one city are bit-identical.

import * as THREE from 'three';
import {
  buildStreetscapePlan,
  carriagewaySurfaceY,
  streetStationAt,
  streetRandom,
  streetHash32,
  STREET_SURFACE_V2_DEFAULTS,
} from '../../world/streets/street-surface-v2.js';
import {
  VEHICLE_SPECS,
  VEHICLE_SPEC_BY_ID,
  VEHICLE_CATALOGUE_VERSION,
  PAINT_SETS,
  RIM_FINISHES,
  PARKING_WEIGHT,
  TRAFFIC_KIND_MAP,
  TRIM,
  pickWeighted,
  classBand,
} from '../../vehicles/vehicle-catalogue.js';
import { hexToLinear } from '../../vehicles/vehicle-geometry.js';
import {
  createVehicleAssets,
  createVehicleMaterials,
  createVehicleFleet,
  applyVehicleEnvironment,
  disposeVehicleMaterials,
  nightnessFor,
  wetnessFor,
} from '../../vehicles/vehicle-fleet.js';

export const VEHICLE_PRESENTATION_ID = 'vehicle-presentation';
export const VEHICLE_PRESENTATION_VERSION = 'vehicle-presentation-v1';

/**
 * Distance rings from `ctx.focus`.
 *
 * `lod` selects the geometry variant. The radii are set by what a vehicle
 * actually resolves to on a 1600x900 frame at 47 deg: a 1.8 m wide car spans
 * about 60 px at 55 m, 30 px at 110 m and 10 px at 320 m. Separate wheels, door
 * shut lines, mirrors and wipers stop paying for themselves past 55 m; a
 * separate glazing draw call stops paying past 110 m; past 320 m a vehicle is
 * a ten-pixel silhouette and a parked one is not worth a triangle.
 *
 * `maxVehicles` and `maxTriangles` are hard caps applied nearest-first, so a
 * dense downtown block never spends the whole budget on the far ring.
 */
export const VEHICLE_RINGS = Object.freeze([
  Object.freeze({ id: 'near', radius: 55, lod: 0, maxVehicles: 60, maxTriangles: 120000 }),
  Object.freeze({ id: 'mid', radius: 110, lod: 1, maxVehicles: 140, maxTriangles: 90000 }),
  Object.freeze({ id: 'far', radius: 320, lod: 2, maxVehicles: 360, maxTriangles: 80000 }),
]);

/** Mirrored traffic is always near-detail, and capped separately. */
export const TRAFFIC_MIRROR = Object.freeze({
  maxVehicles: 48,
  perTypeCapacity: 14,
  lod: 0,
  maxTriangles: 100000,
});

export const VEHICLE_BUDGET = Object.freeze({
  maxTriangles: 400000,
  maxDrawCalls: 96,
  rings: VEHICLE_RINGS,
  traffic: TRAFFIC_MIRROR,
});

/**
 * Kerb geometry, metres.
 *
 * `gap` is the distance from the vehicle's kerbside flank to the kerb line.
 * A legal parked car in a North American city is within 0.3 m of the kerb;
 * 0.18-0.62 m is the band a reviewer would accept as "parked, not abandoned".
 */
export const KERB = Object.freeze({
  minGap: 0.18,
  maxGap: 0.62,
  targetGap: 0.32,
  /**
   * Clear carriageway that must remain once the parked vehicles are on it.
   * A single 3.0 m running lane is the practical minimum on a city street; a
   * street that cannot hold that plus two parked flanks gets parking on ONE
   * side only, which is exactly how a 6.4 m alley works in the real city.
   */
  minRunningLane: 3.0,
  /** Both kerbs are used only above this carriageway half-width. */
  bothSidesHalfWidth: 4.3,
  /** No stall inside this distance of a junction mouth (daylighting). */
  endClearance: 6.5,
  /** Longitudinal gap between two parked vehicles. */
  minPitchGap: 0.85,
  maxPitchGap: 2.6,
  /** A stall this close to a vehicle another layer already placed is taken. */
  dedupeRadius: 3.0,
});

/** Streets that carry kerb parking at all, by class name. */
const PARKABLE_CLASSES = new Set([
  'residential', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link', 'unclassified', 'living_street', 'service',
]);

const TAU = Math.PI * 2;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * The exact options the paved carriageway was built with.
 *
 * `ctx.streetSurfaceOptions` is authoritative when the renderer supplies it.
 * The fallback reproduces the renderer's own defaults rather than assuming bare
 * terrain, because a vehicle placed on bare terrain sinks `roadLift` metres.
 */
export function vehicleSurfaceOptions(ctx, overrides = {}) {
  if (ctx?.streetSurfaceOptions) return { ...ctx.streetSurfaceOptions, ...overrides };
  const city = ctx?.city;
  const defaults = STREET_SURFACE_V2_DEFAULTS;
  const roadLift = Number(city?.meta?.streetDesign?.roadLift);
  const heightAt = typeof ctx?.heightAt === 'function' ? ctx.heightAt : null;
  const generator = city?.meta?.generator;
  return {
    roadLift: finite(roadLift) ? roadLift : defaults.roadLift,
    gutterDepth: 0.04,
    curbFaceHeight: 0.045 + 0.04 + defaults.curbTopFall,
    heightAt: heightAt ? (x, z) => {
      const h = Number(heightAt(x, z));
      return Number.isFinite(h) ? h : 0;
    } : null,
    palette: ctx?.isSanFrancisco ? 'sf' : 'stylised',
    inferNodes: generator === 'sf-builtin' || generator === 'openstreetmap',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// overlap tests
// ---------------------------------------------------------------------------

/** Oriented footprint of a vehicle in plan, as four world corners. */
export function vehicleFootprint(spec, x, z, yaw, margin = 0) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hl = spec.length / 2 + margin;
  const hw = spec.width / 2 + margin;
  const corners = [];
  for (const [sw, sl] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    // Local +Z is forward and local +X is left; world = yaw about Y.
    const lx = sw * hw;
    const lz = sl * hl;
    corners.push({ x: x + lx * c + lz * s, z: z - lx * s + lz * c });
  }
  return corners;
}

/** Separating-axis test between two convex quads in plan. */
export function quadsOverlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i += 1) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const ax = -(q.z - p.z);
      const az = q.x - p.x;
      let minA = Infinity; let maxA = -Infinity;
      let minB = Infinity; let maxB = -Infinity;
      for (const v of a) {
        const d = v.x * ax + v.z * az;
        if (d < minA) minA = d;
        if (d > maxA) maxA = d;
      }
      for (const v of b) {
        const d = v.x * ax + v.z * az;
        if (d < minB) minB = d;
        if (d > maxB) maxB = d;
      }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

function makeGrid(cell = 8) {
  return { cell, buckets: new Map() };
}

function gridKeys(grid, corners) {
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }
  const keys = [];
  for (let gx = Math.floor(minX / grid.cell); gx <= Math.floor(maxX / grid.cell); gx += 1) {
    for (let gz = Math.floor(minZ / grid.cell); gz <= Math.floor(maxZ / grid.cell); gz += 1) {
      keys.push(`${gx}:${gz}`);
    }
  }
  return keys;
}

function gridHit(grid, corners) {
  for (const key of gridKeys(grid, corners)) {
    const list = grid.buckets.get(key);
    if (!list) continue;
    for (const other of list) if (quadsOverlap(corners, other)) return true;
  }
  return false;
}

function gridAdd(grid, corners) {
  for (const key of gridKeys(grid, corners)) {
    const list = grid.buckets.get(key);
    if (list) list.push(corners);
    else grid.buckets.set(key, [corners]);
  }
}

// ---------------------------------------------------------------------------
// legacy occupancy and building footprints
// ---------------------------------------------------------------------------

const LEGACY_VEHICLE_NAME = /parked-car|kerb-car|vehicle-.*-instances|car-bodies|car-cabs/i;

/**
 * Positions of vehicles other layers have already put on the street, read out
 * of the finished scene graph. Used so this pass never double-books a stall
 * while the legacy slab layer is still in the world.
 */
export function collectExistingVehicles(root, { cell = 8, maxPoints = 20000 } = {}) {
  const buckets = new Map();
  let points = 0;
  const position = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const add = (x, z) => {
    points += 1;
    const key = `${Math.floor(x / cell)}:${Math.floor(z / cell)}`;
    const list = buckets.get(key);
    if (list) list.push(x, z); else buckets.set(key, [x, z]);
  };
  if (root && typeof root.traverse === 'function') {
    root.traverse((node) => {
      if (points >= maxPoints) return;
      if (!node.isInstancedMesh || !node.instanceMatrix) return;
      if (node.userData?.pass === VEHICLE_PRESENTATION_ID) return;
      if (!LEGACY_VEHICLE_NAME.test(node.name || '')) return;
      const count = Math.min(node.count ?? 0, node.instanceMatrix.count ?? 0);
      for (let i = 0; i < count && points < maxPoints; i += 1) {
        matrix.fromArray(node.instanceMatrix.array, i * 16);
        position.setFromMatrixPosition(matrix);
        if (!finite(position.x) || !finite(position.z)) continue;
        add(position.x, position.z);
      }
    });
  }
  return {
    points,
    blocked(x, z, margin) {
      const gx = Math.floor(x / cell);
      const gz = Math.floor(z / cell);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const list = buckets.get(`${gx + dx}:${gz + dz}`);
          if (!list) continue;
          for (let i = 0; i < list.length; i += 2) {
            const ex = list[i]; const ez = list[i + 1];
            if ((ex - x) * (ex - x) + (ez - z) * (ez - z) < margin * margin) return true;
          }
        }
      }
      return false;
    },
  };
}

function buildBuildingIndex(city) {
  const cell = 40;
  const buckets = new Map();
  let count = 0;
  for (const building of Array.isArray(city?.buildings) ? city.buildings : []) {
    const polygon = building?.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    let ok = true;
    for (const p of polygon) {
      if (!finite(p?.x) || !finite(p?.z)) { ok = false; break; }
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    if (!ok) continue;
    count += 1;
    const record = { polygon, minX, maxX, minZ, maxZ };
    for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
      for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
        const key = `${gx}:${gz}`;
        const list = buckets.get(key);
        if (list) list.push(record); else buckets.set(key, [record]);
      }
    }
  }
  return {
    count,
    inside(x, z) {
      const list = buckets.get(`${Math.floor(x / cell)}:${Math.floor(z / cell)}`);
      if (!list) return false;
      for (const record of list) {
        if (x < record.minX || x > record.maxX || z < record.minZ || z > record.maxZ) continue;
        let inside = false;
        const polygon = record.polygon;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
          const a = polygon[i];
          const b = polygon[j];
          if ((a.z > z) !== (b.z > z)
            && x < ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || 1e-12) + a.x) inside = !inside;
        }
        if (inside) return true;
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// grounding
// ---------------------------------------------------------------------------

/**
 * Fit a vehicle onto the carriageway.
 *
 * The four wheel contact patches are sampled on the real cross-section - the
 * crown, the gutter fall and the terrain under them - and the body is pitched
 * and rolled onto the plane they define. On a flat street this is a no-op; on a
 * San Francisco grade it is the difference between four wheels on the road and
 * one corner in the air.
 */
export function groundVehicle(spec, segment, station, u, yaw, options, datumAt) {
  const frame = streetStationAt(segment, clamp(station, 0, segment.length));
  const cx = frame.x + frame.nx * u * frame.miter;
  const cz = frame.z + frame.nz * u * frame.miter;
  // World directions of the vehicle's own axes. Rotation about +Y maps local
  // +Z to (sin yaw, cos yaw) and local +X - the vehicle's LEFT - to
  // (cos yaw, -sin yaw).
  const fx = Math.sin(yaw); const fz = Math.cos(yaw);
  const lx = Math.cos(yaw); const lz = -Math.sin(yaw);

  const axles = [
    { z: spec.frontAxleZ, track: spec.trackFront },
    { z: spec.rearAxleZ, track: spec.trackRear },
  ];
  const samples = [];
  for (const axle of axles) {
    for (const side of [1, -1]) {
      const ox = (side * axle.track) / 2;
      const x = cx + lx * ox + fx * axle.z;
      const z = cz + lz * ox + fz * axle.z;
      const lateral = lateralOf(segment, x, z);
      samples.push({
        x, z, y: carriagewaySurfaceY(datumAt(x, z), lateral, segment.half, options),
        dx: lx * ox + fx * axle.z, dz: lz * ox + fz * axle.z,
      });
    }
  }

  // Least-squares plane through the four contact patches, in world space:
  // y = c + a * dx + b * dz around the vehicle centre.
  let sxx = 0; let sxz = 0; let szz = 0; let sxy = 0; let szy = 0; let sy = 0;
  for (const p of samples) {
    sxx += p.dx * p.dx; sxz += p.dx * p.dz; szz += p.dz * p.dz;
    sxy += p.dx * p.y; szy += p.dz * p.y; sy += p.y;
  }
  const n = samples.length;
  // Centre the system so `c` is the height at the vehicle origin.
  const mx = samples.reduce((t, p) => t + p.dx, 0) / n;
  const mz = samples.reduce((t, p) => t + p.dz, 0) / n;
  const my = sy / n;
  const cxx = sxx - n * mx * mx;
  const cxz = sxz - n * mx * mz;
  const czz = szz - n * mz * mz;
  const cxy = sxy - n * mx * my;
  const czy = szy - n * mz * my;
  const det = cxx * czz - cxz * cxz;
  let a = 0;
  let b = 0;
  if (Math.abs(det) > 1e-9) {
    a = (cxy * czz - czy * cxz) / det;
    b = (czy * cxx - cxy * cxz) / det;
  }
  const c = my - a * mx - b * mz;

  // Gradients along the vehicle's own axes.
  const forwardGrade = a * fx + b * fz;
  const leftGrade = a * lx + b * lz;
  // A positive rotation about +X pitches the nose DOWN, so climbing needs a
  // negative pitch; a positive rotation about +Z raises local +X, the left.
  const pitch = -Math.atan(forwardGrade);
  const roll = Math.atan(leftGrade);
  return { x: cx, y: c, z: cz, pitch, roll, samples, plane: { a, b, c } };
}

/** Wheel contact points of a placed vehicle, in world space. */
export function wheelContactPoints(spec, placement) {
  const euler = new THREE.Euler(placement.pitch || 0, placement.yaw || 0, placement.roll || 0, 'YXZ');
  const quaternion = new THREE.Quaternion().setFromEuler(euler);
  const base = new THREE.Matrix4().compose(
    new THREE.Vector3(placement.x, placement.y, placement.z),
    quaternion,
    new THREE.Vector3(1, 1, 1),
  );
  const out = [];
  const axles = [
    { z: spec.frontAxleZ, track: spec.trackFront },
    { z: spec.rearAxleZ, track: spec.trackRear },
  ];
  const point = new THREE.Vector3();
  for (const axle of axles) {
    for (const side of [1, -1]) {
      point.set((side * axle.track) / 2, 0, axle.z).applyMatrix4(base);
      out.push({ x: point.x, y: point.y, z: point.z, side, axleZ: axle.z });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

function ringFor(distance) {
  for (const ring of VEHICLE_RINGS) if (distance <= ring.radius) return ring;
  return null;
}

function segmentReach(focus, segment) {
  let best = Infinity;
  for (let i = 0; i < segment.points.length - 1; i += 1) {
    const a = segment.points[i];
    const b = segment.points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = 0;
    if (len2 > 1e-9) t = clamp(((focus.x - a.x) * dx + (focus.z - a.z) * dz) / len2, 0, 1);
    const d = Math.hypot(focus.x - (a.x + dx * t), focus.z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

function reject(state, reason) {
  state.rejections[reason] = (state.rejections[reason] || 0) + 1;
}

function paintFor(spec, draw) {
  const set = PAINT_SETS[spec.paintSet] || PAINT_SETS.civilian;
  return pickWeighted(set, draw);
}

/**
 * Lay out the parked population on the kerb, as plain data. Exported so the
 * verifier can re-measure every decision without building geometry.
 */
export function planParkedVehicles(plan, {
  focus = { x: 0, z: 0 },
  seed = 'city',
  occupancy = null,
  buildings = null,
  emptyStallRate = 0.16,
  maxVehicles = 900,
} = {}) {
  const options = plan.options;
  const heightAt = options.heightAt;
  const datumAt = heightAt ? (x, z) => options.roadLift + heightAt(x, z) : () => options.roadLift;
  const state = { rejections: {}, counts: {}, sides: 0, segments: 0 };
  const vehicles = [];
  const grid = makeGrid(8);
  const farRadius = VEHICLE_RINGS[VEHICLE_RINGS.length - 1].radius;

  const ordered = [...plan.segments]
    .map((segment) => ({ segment, reach: segmentReach(focus, segment) }))
    .sort((a, b) => a.reach - b.reach || String(a.segment.id).localeCompare(String(b.segment.id)));

  for (const { segment, reach } of ordered) {
    if (vehicles.length >= maxVehicles) { reject(state, 'global-cap'); break; }
    if (!(reach <= farRadius + segment.length * 0.5)) { reject(state, 'out-of-range'); continue; }
    if (!PARKABLE_CLASSES.has(segment.className)) { reject(state, 'class-not-parkable'); continue; }
    if (!(segment.half >= 3.1)) { reject(state, 'carriageway-too-narrow'); continue; }
    state.segments += 1;
    const band = classBand(segment.classRank);
    const start = segment.trimStart + KERB.endClearance;
    const end = segment.length - segment.trimEnd - KERB.endClearance;
    if (!(end - start > 4.2)) { reject(state, 'no-usable-kerb'); continue; }

    // How many kerbs this carriageway can actually give up.
    const bothSides = segment.half >= KERB.bothSidesHalfWidth;
    const sides = bothSides
      ? [1, -1]
      : [streetHash32(`${seed}|side|${segment.id}`) % 2 === 0 ? 1 : -1];
    const lanes = bothSides ? 2 : 1;
    // Only classes that still leave a running lane may be drawn for this kerb.
    const candidates = VEHICLE_SPECS.filter((spec) => {
      if (!((PARKING_WEIGHT[spec.id]?.[band] || 0) > 0)) return false;
      const consumed = lanes * (spec.width + KERB.targetGap);
      return segment.half * 2 - consumed >= KERB.minRunningLane;
    });
    if (!candidates.length) { reject(state, 'no-class-fits-carriageway'); continue; }

    for (const side of sides) {
      state.sides += 1;
      const random = streetRandom(`${seed}|park|${segment.id}|${side}`);
      let cursor = start;
      let guard = 0;
      while (cursor < end && guard < 400) {
        guard += 1;
        if (vehicles.length >= maxVehicles) break;
        // Which class takes this stall. The candidate set was already narrowed
        // to classes this carriageway can actually carry, so a draw never
        // wastes a stall on a vehicle that will be rejected for width.
        const spec = pickWeighted(candidates, random(), (s) => PARKING_WEIGHT[s.id][band]);
        const pitchGap = KERB.minPitchGap + random() * (KERB.maxPitchGap - KERB.minPitchGap);
        const slot = spec.length + pitchGap;
        if (cursor + slot > end) { reject(state, 'stall-does-not-fit'); break; }
        const station = cursor + spec.length / 2 + pitchGap * 0.35;
        cursor += slot;

        // Some stalls are empty: driveways, hydrants, street cleaning.
        if (random() < emptyStallRate) { reject(state, 'stall-empty'); continue; }

        // Lateral. Kerb line is at |u| = segment.half.
        const gapDraw = random();
        const kerbGap = KERB.minGap + gapDraw * (KERB.maxGap - KERB.minGap) * 0.7
          + (KERB.targetGap - KERB.minGap) * 0.3;
        const u = (segment.half - kerbGap - spec.width / 2) * side;
        // Clear carriageway left once this flank (and the opposite one, when
        // both kerbs are parked) is taken.
        const inner = Math.abs(u) - spec.width / 2;
        const running = lanes === 2 ? inner * 2 : inner + segment.half;
        if (!(running >= KERB.minRunningLane)) { reject(state, 'no-running-lane'); continue; }
        if (Math.abs(u) + spec.width / 2 > segment.half - 0.02) { reject(state, 'over-the-kerb'); continue; }

        const frame = streetStationAt(segment, clamp(station, 0, segment.length));
        const skew = (random() - 0.5) * 0.05;
        const along = side > 0 ? 1 : -1;
        const yaw = Math.atan2(frame.tx * along, frame.tz * along) + skew;
        const placement = groundVehicle(spec, segment, station, u, yaw, options, datumAt);
        if (!finite(placement.x) || !finite(placement.y) || !finite(placement.z)) {
          reject(state, 'non-finite-placement');
          continue;
        }
        placement.yaw = yaw;

        if (buildings?.inside(placement.x, placement.z)) { reject(state, 'inside-building'); continue; }
        if (occupancy?.blocked(placement.x, placement.z, KERB.dedupeRadius)) {
          reject(state, 'stall-already-taken');
          continue;
        }
        const corners = vehicleFootprint(spec, placement.x, placement.z, yaw, 0.05);
        if (gridHit(grid, corners)) { reject(state, 'overlaps-another-vehicle'); continue; }
        gridAdd(grid, corners);

        const paint = paintFor(spec, random());
        const rim = pickWeighted(RIM_FINISHES, random());
        vehicles.push({
          id: `${segment.id}:${side}:${vehicles.length}`,
          typeId: spec.id,
          spec,
          segmentId: segment.id,
          side,
          station,
          u,
          kerbGap,
          x: placement.x,
          y: placement.y,
          z: placement.z,
          yaw,
          pitch: placement.pitch,
          roll: placement.roll,
          paintHex: paint.hex,
          paintName: paint.name,
          rimHex: rim.hex,
          rimName: rim.name,
          hazard: random() < 0.035,
          distance: Math.hypot(placement.x - focus.x, placement.z - focus.z),
          corners,
        });
        state.counts[spec.id] = (state.counts[spec.id] || 0) + 1;
      }
    }
  }
  return { vehicles, rejections: state.rejections, counts: state.counts, stats: { segments: state.segments, sides: state.sides } };
}

// ---------------------------------------------------------------------------
// traffic mirror
// ---------------------------------------------------------------------------

const TRAFFIC_GROUP_NAMES = [
  'logical-vehicles-and-batched-presentation',
  'vehicle-presentation-batch',
];

/**
 * Find the traffic simulation's own vehicle groups in the scene.
 *
 * This is a READ. `src/citygen/traffic.js` owns those transforms; this pass
 * copies them and never writes to them. The only thing it does write is the
 * `visible` flag of the simulation's placeholder batch, which is presentation,
 * not simulation state, and is restored on dispose.
 */
export function findTrafficMirror(scene) {
  if (!scene || typeof scene.traverse !== 'function') return null;
  let container = null;
  const placeholders = [];
  scene.traverse((node) => {
    if (!node?.name) return;
    if (node.name === TRAFFIC_GROUP_NAMES[0]) container = node;
    if (node.name === TRAFFIC_GROUP_NAMES[1]) placeholders.push(node);
  });
  if (!container) return null;
  const cars = [];
  for (const child of container.children) {
    const rig = child?.userData?.rig;
    if (!rig || typeof rig.kind !== 'string') continue;
    cars.push(child);
  }
  return { container, placeholders, cars };
}

function trafficTypeFor(kind, salt) {
  const list = TRAFFIC_KIND_MAP[kind] || TRAFFIC_KIND_MAP.sedan;
  return list[streetHash32(`traffic|${kind}|${salt}`) % list.length];
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function triangleCostOf(assets, typeId, lod) {
  const built = assets.body(typeId, lod);
  if (!built) return 0;
  let each = built.triangles;
  const wheelSet = assets.wheel(lod);
  if (built.config.instancedWheels && wheelSet) {
    const tri = (g) => (g ? Math.floor((g.getIndex()?.count ?? 0) / 3) : 0);
    each += built.allWheels.length * tri(wheelSet.tyre)
      + built.allWheels.filter((w) => !w.inner).length * tri(wheelSet.rimRight);
  }
  if (built.config.instancedLamps) {
    each += built.lamps.length * Math.floor((assets.lamp().getIndex()?.count ?? 0) / 3);
  }
  if (built.config.plates) {
    each += built.plates.length * Math.floor((assets.plate().getIndex()?.count ?? 0) / 3);
  }
  return each;
}

export function buildVehiclePresentation(ctx, overrides = {}) {
  const startedAt = Date.now();
  const city = ctx?.city;
  const requested = vehicleSurfaceOptions(ctx, overrides.surface || {});
  const plan = buildStreetscapePlan(city, requested);
  // `plan.options` is the RESOLVED cross-section - crown, gutter, curb face and
  // terrain sampler - that the paved ribbon was swept with. Everything below
  // grounds against that, never against the partial request above.
  const options = plan.options;
  const bounds = city?.meta?.bounds;
  const focus = ctx?.focus && finite(ctx.focus.x) && finite(ctx.focus.z)
    ? { x: ctx.focus.x, z: ctx.focus.z }
    : bounds && finite(bounds.minX)
      ? { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 }
      : { x: 0, z: 0 };
  const seed = String(ctx?.seed ?? city?.meta?.seed ?? 'city');

  // Who owns the kerb.
  //
  // By default this pass owns it: the legacy slab layers are hidden on the
  // first update and the plan therefore ignores them, so no stall is left
  // empty by a slab that is about to disappear. Set `hideLegacy: false` and the
  // pass instead defers - it dedupes against whatever is already parked and
  // leaves it visible - which is the safe mode while both layers coexist.
  const hideLegacy = overrides.hideLegacy !== false;
  const occupancy = collectExistingVehicles(ctx?.root);
  const buildings = buildBuildingIndex(plan.city);
  const planned = planParkedVehicles(plan, {
    focus,
    seed,
    occupancy: hideLegacy ? null : occupancy,
    buildings,
    emptyStallRate: overrides.emptyStallRate ?? 0.16,
    maxVehicles: overrides.maxVehicles ?? 900,
  });

  const assets = createVehicleAssets(TRIM);
  const materials = overrides.materials || createVehicleMaterials();

  // Ring assignment, nearest first, against the per-ring caps.
  const ringRecords = VEHICLE_RINGS.map((ring) => ({
    id: ring.id, radius: ring.radius, lod: ring.lod, vehicles: 0, triangles: 0,
    maxVehicles: ring.maxVehicles, maxTriangles: ring.maxTriangles,
  }));
  const sorted = [...planned.vehicles].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const kept = [];
  const rejections = { ...planned.rejections };
  const bump = (reason) => { rejections[reason] = (rejections[reason] || 0) + 1; };
  for (const vehicle of sorted) {
    const ring = ringFor(vehicle.distance);
    if (!ring) { bump('beyond-far-ring'); continue; }
    const index = VEHICLE_RINGS.indexOf(ring);
    const record = ringRecords[index];
    if (record.vehicles >= ring.maxVehicles) { bump(`ring-${ring.id}-vehicle-cap`); continue; }
    const cost = triangleCostOf(assets, vehicle.typeId, ring.lod);
    if (record.triangles + cost > ring.maxTriangles) { bump(`ring-${ring.id}-triangle-cap`); continue; }
    record.vehicles += 1;
    record.triangles += cost;
    vehicle.ring = ring.id;
    vehicle.lod = ring.lod;
    kept.push(vehicle);
  }

  const parkedCapacity = new Map();
  for (const vehicle of kept) {
    const key = `${vehicle.typeId}:${vehicle.lod}`;
    parkedCapacity.set(key, (parkedCapacity.get(key) || 0) + 1);
  }

  const group = new THREE.Group();
  group.name = VEHICLE_PRESENTATION_ID;
  group.userData = { kind: 'vehicle-presentation', version: VEHICLE_PRESENTATION_VERSION };

  const parked = parkedCapacity.size
    ? createVehicleFleet({ name: 'vehicle-parked', assets, materials, capacity: parkedCapacity })
    : null;
  if (parked) {
    parked.begin();
    for (const vehicle of kept) {
      const paint = hexToLinear(vehicle.paintHex);
      const rim = hexToLinear(vehicle.rimHex);
      parked.push({
        typeId: vehicle.typeId,
        lod: vehicle.lod,
        x: vehicle.x, y: vehicle.y, z: vehicle.z,
        yaw: vehicle.yaw, pitch: vehicle.pitch, roll: vehicle.roll,
        paint, rim,
        // A parked vehicle is unlit: no brake, no indicator, wheels straight.
        steer: 0, spin: 0, brake: false, indicator: 0,
        hazard: vehicle.hazard, blink: false,
      });
    }
    parked.commit();
    group.add(parked.group);
  }

  // The mirrored traffic fleet is built the first time the simulation is found
  // in the scene, with the exact per-type capacity that simulation asked for.
  // Allocating all ten classes up front would leave dead meshes in the render
  // list on every city that never spawns a bus.
  const parkedStats = parked ? parked.stats() : { triangles: 0, drawCalls: 0, meshes: [] };
  const trafficStats = { triangles: 0, drawCalls: 0, meshes: [] };

  // Grounding audit over what was actually placed.
  let worstContact = 0;
  let contactSum = 0;
  let contactSamples = 0;
  const datumAt = options.heightAt
    ? (x, z) => options.roadLift + options.heightAt(x, z)
    : () => options.roadLift;
  for (const vehicle of kept) {
    const segment = plan.segmentById.get(vehicle.segmentId);
    if (!segment) continue;
    for (const contact of wheelContactPoints(vehicle.spec, vehicle)) {
      const lateral = lateralOf(segment, contact.x, contact.z);
      const expected = carriagewaySurfaceY(datumAt(contact.x, contact.z), lateral, segment.half, options);
      const error = Math.abs(contact.y - expected);
      contactSum += error;
      contactSamples += 1;
      if (error > worstContact) worstContact = error;
    }
  }

  const appearance = new Set();
  const byType = {};
  for (const vehicle of kept) {
    appearance.add(`${vehicle.typeId}|${vehicle.paintHex}|${vehicle.rimHex}|${vehicle.lod}`);
    byType[vehicle.typeId] = (byType[vehicle.typeId] || 0) + 1;
  }

  const state = {
    id: VEHICLE_PRESENTATION_ID,
    assets,
    materials,
    ownsMaterials: !overrides.materials,
    parked,
    traffic: null,
    group,
    plan,
    options,
    focus,
    seed,
    vehicles: kept,
    hideLegacy,
    hiddenLegacy: [],
    mirror: null,
    mirrorScan: 0,
    mirrorState: new Map(),
    blinkPhase: 0,
    lastHour: null,
    lastWeather: null,
    diagnosticsLive: {
      trafficMirrored: 0,
      trafficPlaceholdersHidden: 0,
      legacyHidden: 0,
      lastNightness: nightnessFor(ctx?.hour),
      lastWetness: wetnessFor(ctx?.weather),
    },
  };

  applyVehicleEnvironment(materials, { hour: ctx?.hour, weather: ctx?.weather });

  const diagnostics = {
    version: VEHICLE_PRESENTATION_VERSION,
    catalogue: VEHICLE_CATALOGUE_VERSION,
    implemented: true,
    focus,
    plan: plan.stats,
    surface: {
      roadLift: options.roadLift,
      source: ctx?.streetSurfaceOptions ? 'ctx.streetSurfaceOptions' : 'renderer-defaults',
      requestedRoadLift: requested.roadLift,
      hasTerrain: Boolean(options.heightAt),
    },
    catalogueSize: VEHICLE_SPECS.length,
    counts: byType,
    planned: planned.vehicles.length,
    placed: kept.length,
    rejections,
    uniqueAppearances: appearance.size,
    legacyVehiclePoints: occupancy ? occupancy.points : 0,
    legacyPolicy: hideLegacy ? 'hide-and-own-the-kerb' : 'defer-and-dedupe',
    buildingFootprints: buildings.count,
    rings: ringRecords.map((record) => ({
      ...record,
      withinBudget: record.vehicles <= record.maxVehicles && record.triangles <= record.maxTriangles,
    })),
    grounding: {
      samples: contactSamples,
      worstContactError: worstContact,
      meanContactError: contactSamples ? contactSum / contactSamples : 0,
      tolerance: 0.010,
      withinTolerance: worstContact <= 0.010,
    },
    traffic: {
      capacity: TRAFFIC_MIRROR.maxVehicles,
      perTypeCapacity: TRAFFIC_MIRROR.perTypeCapacity,
      mirrored: 0,
      bound: false,
    },
    night: {
      nightness: nightnessFor(ctx?.hour),
      wetness: wetnessFor(ctx?.weather),
      lampsLit: false,
    },
    meshes: [...parkedStats.meshes, ...trafficStats.meshes],
    totals: {
      vehicles: kept.length,
      triangles: parkedStats.triangles + trafficStats.triangles,
      drawCalls: parkedStats.drawCalls + trafficStats.drawCalls,
      maxTriangles: VEHICLE_BUDGET.maxTriangles,
      maxDrawCalls: VEHICLE_BUDGET.maxDrawCalls,
      withinTriangleBudget: parkedStats.triangles + trafficStats.triangles <= VEHICLE_BUDGET.maxTriangles,
      withinDrawCallBudget: parkedStats.drawCalls + trafficStats.drawCalls <= VEHICLE_BUDGET.maxDrawCalls,
    },
    buildMs: Date.now() - startedAt,
  };
  state.diagnostics = diagnostics;

  return { object: group, diagnostics, vehicles: kept, plan, state, assets, materials };
}

/** Signed lateral offset of a world point from a plan segment's centreline. */
export function lateralOf(segment, x, z) {
  let best = null;
  for (let i = 0; i < segment.points.length - 1; i += 1) {
    const a = segment.points[i];
    const b = segment.points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-9)) continue;
    const ux = dx / len;
    const uz = dz / len;
    const t = clamp((x - a.x) * ux + (z - a.z) * uz, 0, len);
    const px = a.x + ux * t;
    const pz = a.z + uz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (best && distance >= best.distance) continue;
    best = {
      distance,
      lateral: (x - px) * -uz + (z - pz) * ux,
      station: segment.cum[i] + t,
    };
  }
  return best ? best.lateral : 0;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

const MIRROR_RESCAN_SECONDS = 2;

function hideLegacyVehicles(state, root) {
  if (!root || typeof root.traverse !== 'function') return;
  root.traverse((node) => {
    if (!node.isInstancedMesh && !node.isMesh) return;
    if (node.userData?.pass === VEHICLE_PRESENTATION_ID) return;
    if (!/parked-car|kerb-car/i.test(node.name || '')) return;
    if (node.visible === false) return;
    node.visible = false;
    state.hiddenLegacy.push(node);
  });
  state.diagnosticsLive.legacyHidden = state.hiddenLegacy.length;
}

/**
 * Size the mirrored fleet to the simulation that was actually found. Runs once
 * per bind - not per frame - and never while a frame is being written.
 */
function bindTrafficFleet(state, found) {
  const histogram = new Map();
  for (const car of found.cars) {
    const rig = car.userData?.rig;
    if (!rig) continue;
    let record = state.mirrorState.get(car);
    if (!record) {
      const typeId = trafficTypeFor(rig.kind, car.uuid || String(state.mirrorState.size));
      const spec = VEHICLE_SPEC_BY_ID[typeId] || VEHICLE_SPEC_BY_ID.sedan;
      const random = streetRandom(`${state.seed}|traffic|${typeId}|${car.uuid || state.mirrorState.size}`);
      record = {
        typeId,
        spec,
        paint: hexToLinear(paintFor(spec, random()).hex),
        rim: hexToLinear(pickWeighted(RIM_FINISHES, random()).hex),
        lastX: car.position?.x ?? 0,
        lastZ: car.position?.z ?? 0,
        lastYaw: car.rotation?.y ?? 0,
        speed: 0,
        yawRate: 0,
        spin: 0,
      };
      state.mirrorState.set(car, record);
    }
    histogram.set(record.typeId, (histogram.get(record.typeId) || 0) + 1);
  }
  const capacity = new Map();
  let total = 0;
  for (const [typeId, count] of histogram) {
    const slots = Math.min(TRAFFIC_MIRROR.perTypeCapacity, count + 2);
    capacity.set(`${typeId}:${TRAFFIC_MIRROR.lod}`, slots);
    total += slots;
  }
  if (!total) return;
  state.traffic?.dispose();
  state.traffic = createVehicleFleet({
    name: 'vehicle-traffic', assets: state.assets, materials: state.materials, capacity,
  });
  state.traffic.begin();
  state.traffic.commit();
  state.group.add(state.traffic.group);
}

export function updateVehiclePresentation(state, ctx, delta) {
  if (!state) return;
  const step = Number.isFinite(delta) ? clamp(delta, 0, 0.25) : 0;
  state.blinkPhase = (state.blinkPhase + step) % 1.2;
  const blink = state.blinkPhase < 0.6;

  // Environment: read the one runtime clock, never keep a second one.
  const hour = ctx?.hour;
  const weather = ctx?.weather;
  if (hour !== state.lastHour || weather !== state.lastWeather) {
    state.lastHour = hour;
    state.lastWeather = weather;
    applyVehicleEnvironment(state.materials, { hour, weather });
    const night = state.materials.state.nightness;
    state.diagnostics.night.nightness = night;
    state.diagnostics.night.wetness = state.materials.state.wetness;
    state.diagnostics.night.lampsLit = night > 0.35;
  }

  // Legacy slab layers, once.
  if (!state.legacyHiddenDone) {
    state.legacyHiddenDone = true;
    if (state.hideLegacy) hideLegacyVehicles(state, ctx?.root);
    state.diagnostics.legacyHiddenMeshes = state.hiddenLegacy.length;
  }

  // Traffic mirror.
  state.mirrorScan -= step;
  if (!state.mirror || state.mirrorScan <= 0) {
    state.mirrorScan = MIRROR_RESCAN_SECONDS;
    const found = findTrafficMirror(ctx?.scene || ctx?.root);
    if (found && found.cars.length) {
      const changed = !state.mirror || state.mirror.container !== found.container
        || state.mirror.cars.length !== found.cars.length;
      state.mirror = found;
      state.diagnostics.traffic.bound = true;
      if (changed) bindTrafficFleet(state, found);
      for (const placeholder of found.placeholders) {
        if (placeholder.visible !== false) {
          placeholder.visible = false;
          state.hiddenLegacy.push(placeholder);
        }
      }
      state.diagnosticsLive.trafficPlaceholdersHidden = found.placeholders.length;
    } else if (found && !found.cars.length) {
      state.mirror = null;
    }
  }

  const fleet = state.traffic;
  if (!fleet) {
    state.diagnostics.traffic.mirrored = 0;
    return;
  }
  fleet.begin();
  let mirrored = 0;
  if (state.mirror) {
    const night = state.materials.state.nightness;
    const lampsOn = night > 0.35;
    for (const car of state.mirror.cars) {
      if (mirrored >= TRAFFIC_MIRROR.maxVehicles) break;
      const rig = car.userData?.rig;
      if (!rig) continue;
      const px = car.position?.x;
      const pz = car.position?.z;
      const py = car.position?.y;
      if (!finite(px) || !finite(py) || !finite(pz)) continue;
      const yaw = Number(car.rotation?.y) || 0;
      const record = state.mirrorState.get(car);
      if (!record) continue;
      const spec = record.spec;
      // Presentation state derived from the simulation's motion. The
      // simulation is never written to.
      const dx = px - record.lastX;
      const dz = pz - record.lastZ;
      const travelled = Math.hypot(dx, dz);
      const speed = step > 1e-4 ? travelled / step : record.speed;
      let dyaw = yaw - record.lastYaw;
      while (dyaw > Math.PI) dyaw -= TAU;
      while (dyaw < -Math.PI) dyaw += TAU;
      const yawRate = step > 1e-4 ? dyaw / step : record.yawRate;
      const decelerating = speed < record.speed - 0.6;
      record.lastX = px;
      record.lastZ = pz;
      record.lastYaw = yaw;
      record.speed = speed;
      record.yawRate = yawRate;
      record.spin = (record.spin - travelled / Math.max(0.1, spec.wheelRadius)) % TAU;
      // Bicycle model: steer angle from yaw rate and speed.
      const steer = clamp(Math.atan((yawRate * spec.wheelbase) / Math.max(1.2, speed)), -0.62, 0.62);
      const indicator = Math.abs(yawRate) > 0.12 ? (yawRate > 0 ? 1 : -1) : 0;
      const ok = fleet.push({
        typeId: record.typeId,
        lod: TRAFFIC_MIRROR.lod,
        x: px,
        y: py,
        z: pz,
        yaw,
        pitch: 0,
        roll: clamp(-yawRate * Math.min(speed, 14) * 0.006, -0.05, 0.05),
        paint: record.paint,
        rim: record.rim,
        steer,
        spin: record.spin,
        brake: decelerating || speed < 0.4,
        indicator,
        hazard: false,
        blink,
        lampsOn,
      });
      if (ok) mirrored += 1;
    }
  }
  fleet.commit();
  const stats = fleet.stats();
  state.diagnostics.traffic.mirrored = mirrored;
  state.diagnostics.traffic.triangles = stats.triangles;
  state.diagnostics.traffic.drawCalls = stats.drawCalls;
  state.diagnostics.traffic.withinBudget = stats.triangles <= TRAFFIC_MIRROR.maxTriangles;
}

export function disposeVehiclePresentation(state) {
  if (!state) return;
  for (const node of state.hiddenLegacy) node.visible = true;
  state.hiddenLegacy.length = 0;
  state.parked?.dispose();
  state.traffic?.dispose();
  state.assets?.dispose();
  if (state.ownsMaterials) disposeVehicleMaterials(state.materials);
  state.mirror = null;
  state.mirrorState.clear();
}

// ---------------------------------------------------------------------------
// pass module
// ---------------------------------------------------------------------------

let activeState = null;

export default {
  id: VEHICLE_PRESENTATION_ID,
  order: 45,
  build(ctx) {
    if (activeState) {
      try { disposeVehiclePresentation(activeState); } catch { /* keep building */ }
      activeState = null;
    }
    const result = buildVehiclePresentation(ctx);
    activeState = result.state;
    return { object: result.object, diagnostics: result.diagnostics };
  },
  update(ctx, delta) {
    updateVehiclePresentation(activeState, ctx, delta);
  },
  dispose() {
    disposeVehiclePresentation(activeState);
    activeState = null;
  },
};
