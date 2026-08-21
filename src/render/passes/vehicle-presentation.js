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
  createMaterialAnchor,
  applyVehicleEnvironment,
  disposeVehicleMaterials,
  nightnessFor,
  wetnessFor,
  VEHICLE_ENV_CLASS,
} from '../../vehicles/vehicle-fleet.js';

export const VEHICLE_PRESENTATION_ID = 'vehicle-presentation';
export const VEHICLE_PRESENTATION_VERSION = 'vehicle-presentation-v1';

/**
 * Distance rings from `ctx.focus`.
 *
 * `lod` selects the geometry variant. The radii are set by what a vehicle
 * actually resolves to on a 1600x900 frame at 47 deg: a 1.8 m wide car spans
 * about 60 px at 55 m, 40 px at 80 m, 30 px at 110 m and 10 px at 320 m. Past
 * 320 m a vehicle is a ten-pixel silhouette and a parked one is not worth a
 * triangle.
 *
 * ROUND 3 BUDGET CHANGE, stated so it is not a silent drift. The near ring was
 * 55 m. Measured on the shipped slice it held 20 of its 60 allowed vehicles and
 * 39,192 of its 120,000 allowed triangles - a third of the cap, because the
 * ring was small AND, until this round, centred on a datum nobody stood at. A
 * 40-pixel-wide car still shows its wheels, mirrors and door shut lines, so the
 * ring is taken out to 80 m, where the headroom pays for the vehicles that
 * actually fill a hero street frame. The caps themselves are unchanged and the
 * verifier asserts them; a denser block now spends more of a budget it already
 * had rather than being granted a new one.
 *
 * `maxVehicles` and `maxTriangles` are hard caps applied nearest-first, so a
 * dense downtown block never spends the whole budget on the far ring.
 */
export const VEHICLE_RINGS = Object.freeze([
  Object.freeze({ id: 'near', radius: 80, lod: 0, maxVehicles: 60, maxTriangles: 120000 }),
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

/**
 * HEADLIGHTS THAT ARE LIGHTS.
 *
 * Round 4's night card has tail lights that glow and headlights that glow, and
 * not one photon of either lands on the road: every lamp in this pass was an
 * emissive material and nothing else, so a lit vehicle was a sticker. The
 * quality gate's automatic rejection condition for a night scene is exactly
 * that - "carried solely by emissive windows rather than local lighting and
 * material response".
 *
 * This is a POOL, not a light per vehicle. It is bounded three ways, because an
 * unbounded local light pool is how a night frame's cost runs away:
 *
 *   * only MIRRORED (moving) vehicles are lit - a parked car at the kerb has
 *     nobody in it, and lighting the parked row would put 40 pairs of beams on
 *     one block;
 *   * only the nearest `maxVehicles` of them, and only inside `radius`, which
 *     is well inside the near ring, so a vehicle that leaves the ring releases
 *     its pair on the next frame - there is no per-vehicle allocation to leak;
 *   * `maxLights` is a hard ceiling on the whole pass, declared in
 *     `VEHICLE_BUDGET` and reported live in the diagnostics.
 *
 * None of them cast shadows. Eight shadow-casting spots would need eight extra
 * depth passes per frame, which is not a trade a headlight is worth.
 *
 * The renderer's own camera-local practical pool is a SEPARATE budget owned by
 * `src/citygen/renderer.js`. These lights are created, updated, counted and
 * released entirely inside this pass and are never handed to it, so the two
 * cannot double-allocate the same vehicle.
 */
export const VEHICLE_LIGHTS = Object.freeze({
  /** Mirrored vehicles that get a real beam pair, nearest first. */
  maxVehicles: 4,
  perVehicle: 2,
  maxLights: 8,
  /** Only inside this distance from the camera; the near ring reaches 80 m. */
  radius: 55,
  /** A low-beam pattern: wide enough to light a lane, short enough to fall off. */
  angle: 0.42,
  penumbra: 0.55,
  distance: 38,
  decay: 2,
  /** Peak intensity at full night, before the lamps-on ramp. */
  intensity: 22,
  colour: 0xfff1da,
  /** Where the beam is aimed, in the vehicle's own frame. */
  aimAhead: 14,
  aimDrop: 1.15,
  /** The same ramp the emissive lamps use, so glass and beam switch together. */
  onAtNightness: 0.35,
});

export const VEHICLE_BUDGET = Object.freeze({
  maxTriangles: 400000,
  maxDrawCalls: 96,
  rings: VEHICLE_RINGS,
  traffic: TRAFFIC_MIRROR,
  lights: VEHICLE_LIGHTS,
  maxLights: VEHICLE_LIGHTS.maxLights,
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
    curbFaceHeight: 0.102 + 0.04 + defaults.curbTopFall,   // renderer.js LEGACY_SIDEWALK_LIFT
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
 * The road DATUM under a point, sampled the way the drawn ribbon samples it.
 *
 * ROUND 5 CORRECTION - READ THIS BEFORE SIMPLIFYING IT BACK.
 *
 * `street-surface-v2.emitSegment` builds one datum per CENTRELINE station and
 * sweeps the whole cross-section - crown, gutter, kerb - off that single
 * number: `datums = stations.map((st) => ctx.datum(st.x, st.z))`. It never
 * samples the terrain at a lateral offset. Sampling `heightAt` under the WHEEL
 * therefore reads a different height than the asphalt the wheel stands on
 * wherever the terrain cross-falls: the error is the terrain's cross-grade
 * times the wheel's lateral offset, which for a kerbside wheel 4 m off the
 * centreline on a 10% cross-grade is 0.4 m of float. Projecting the wheel back
 * onto its own centreline before sampling the terrain removes that term
 * exactly, and is a no-op on flat ground.
 */
function centrelineDatumAt(segment, x, z, datumAt) {
  let bestD2 = Infinity;
  let px = x;
  let pz = z;
  for (let i = 0; i < segment.points.length - 1; i += 1) {
    const a = segment.points[i];
    const b = segment.points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (!(len2 > 1e-12)) continue;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
    const qx = a.x + dx * t;
    const qz = a.z + dz * t;
    const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
    if (d2 < bestD2) { bestD2 = d2; px = qx; pz = qz; }
  }
  return datumAt(px, pz);
}

/**
 * Fit a vehicle onto the carriageway around a world centre.
 *
 * The four wheel contact patches are sampled on the real cross-section - the
 * crown, the gutter fall and the terrain under them - and the body is pitched
 * and rolled onto the plane they define. On a flat street this is a no-op; on a
 * San Francisco grade it is the difference between four wheels on the road and
 * one corner in the air.
 *
 * Shared by the parked layout (which knows its station and lateral offset) and
 * by the traffic mirror (which only knows where the simulation put the vehicle).
 */
export function drawnCarriagewayY(segment, x, z, options, datumAt, slack = 0) {
  const hit = segmentProjection(segment, x, z);
  if (!hit) return null;
  // `slack` past the kerb line is for the FALLBACK only: a wheel that overhangs
  // the kerb still rests on the road. It must not be allowed into the
  // topmost-surface test, where it would let a neighbouring street's kerb line
  // win over the asphalt the vehicle is actually standing on.
  if (Math.abs(hit.lateral) > segment.half + slack) return null;
  const u = clamp(hit.lateral, -segment.half, segment.half);
  // Between the trims the SEGMENT RIBBON owns the surface. Past them the
  // JUNCTION PAD owns it, and this cross-section is only an approximation of
  // the pad - so the flag is carried out and a pad is never allowed to lift a
  // wheel above real ribbon. `createDrawnRoadIndex` resolves the pad exactly
  // wherever the drawn mesh is available; this is the fallback for the rest.
  const inRibbon = hit.station >= segment.trimStart - 0.05
    && hit.station <= segment.length - segment.trimEnd + 0.05;
  const datum = centrelineDatumAt(segment, x, z, datumAt);
  return { y: carriagewaySurfaceY(datum, u, segment.half, options), ribbon: inRibbon };
}

/**
 * Height of the TOPMOST drawn carriageway under a point.
 *
 * Ribbons overlap: a narrow alley crossing a wide street lays its own asphalt
 * across the other's, and the one a camera sees is whichever is higher there.
 * Grounding on the nearest centreline instead of the highest surface put a
 * wheel up to 165 mm under the asphalt at those crossings. Measured over 2257
 * wheel contacts on the shipped slice, taking the maximum is the difference
 * between a 165 mm worst case and a sub-centimetre one.
 */
export function topCarriagewayY(index, x, z, options, datumAt, fallbackSegment = null) {
  let ribbon = null;
  let pad = null;
  const candidates = index?.candidates ? index.candidates(x, z) : null;
  if (candidates) {
    for (const segment of candidates) {
      const y = drawnCarriagewayY(segment, x, z, options, datumAt);
      if (y === null) continue;
      // A segment whose ribbon is trimmed away here draws nothing of its own:
      // the junction pad does, and the pad is only an approximation of it. Real
      // ribbon always wins over an approximated pad, so a wheel is never lifted
      // onto a surface that may not be there.
      if (y.ribbon) { if (ribbon === null || y.y > ribbon) ribbon = y.y; }
      else if (pad === null || y.y > pad) pad = y.y;
    }
  }
  if (ribbon !== null) return ribbon;
  const back = fallbackSegment ? drawnCarriagewayY(fallbackSegment, x, z, options, datumAt, 1.0) : null;
  if (back) return back.y;
  return pad;
}

export function groundVehicleAt(spec, segment, cx, cz, yaw, options, datumAt, index = null, road = null) {
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
      // The drawn geometry first - it has no model error - then the modelled
      // cross-section for anything outside the indexed window.
      const drawn = road ? road.heightAt(x, z) : null;
      const own = drawnCarriagewayY(segment, x, z, options, datumAt, 1.0);
      const top = drawn !== null ? drawn : (index
        ? topCarriagewayY(index, x, z, options, datumAt, segment)
        : (own ? own.y : null));
      const y = top === null
        ? carriagewaySurfaceY(centrelineDatumAt(segment, x, z, datumAt),
          clamp(lateralOf(segment, x, z), -segment.half, segment.half), segment.half, options)
        : top;
      samples.push({
        x, z, y,
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

/**
 * Fit a vehicle onto the carriageway at a station and lateral offset.
 * Thin wrapper over `groundVehicleAt`, kept because the parked layout works in
 * (station, u) and the verifier calls it by that signature.
 */
export function groundVehicle(spec, segment, station, u, yaw, options, datumAt, index = null, road = null) {
  const frame = streetStationAt(segment, clamp(station, 0, segment.length));
  const cx = frame.x + frame.nx * u * frame.miter;
  const cz = frame.z + frame.nz * u * frame.miter;
  return groundVehicleAt(spec, segment, cx, cz, yaw, options, datumAt, index, road);
}

/**
 * The DRAWN carriageway, indexed as triangles.
 *
 * ROUND 5. Everything above models the surface: it re-evaluates the same cross
 * section the ribbon was swept with. That is exact on an open ribbon and only
 * approximate where `street-surface-v2` laps two paved surfaces over each other
 * - a junction pad across an approach, a narrow street's ribbon under a wide
 * one's - because the model does not know which of them is on top. Measured on
 * the shipped slice that is 353 of 544 test bodies standing over a step, with
 * up to 110 mm between the modelled height and the asphalt actually drawn.
 *
 * A model cannot resolve that. The geometry can: this reads the carriageway
 * mesh the renderer built, buckets its triangles into a uniform grid, and
 * answers "what is the height of the topmost asphalt at this point" by
 * barycentric lookup. Grounding then has no model error at all, by
 * construction, and follows any future change to the street module for free.
 *
 * Windowed on the LOD centre so the memory is bounded by the ring budget rather
 * than by the size of the city, and rebuilt with the rings.
 *
 * @param {object} mesh THREE.Mesh - `street-surface-v2:carriageway`
 * @param {{x:number,z:number}} centre
 */
export function createDrawnRoadIndex(mesh, { centre = { x: 0, z: 0 }, radius = 400, cell = 6 } = {}) {
  const geometry = mesh?.geometry;
  const position = geometry?.getAttribute?.('position');
  if (!position) return null;
  const index = geometry.getIndex?.() || null;
  const count = index ? index.count : position.count;
  const matrix = mesh.matrixWorld && mesh.matrixWorld.isMatrix4 ? mesh.matrixWorld : null;
  if (matrix) mesh.updateWorldMatrix?.(true, false);
  const e = matrix ? matrix.elements : null;
  const put = (i, out, at) => {
    const x = position.getX(i); const y = position.getY(i); const z = position.getZ(i);
    if (!e) { out[at] = x; out[at + 1] = y; out[at + 2] = z; return; }
    const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
    out[at] = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
    out[at + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
    out[at + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
  };
  const tris = [];
  const grid = new Map();
  const r2 = radius * radius;
  const tri = new Array(9);
  for (let i = 0; i < count; i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;
    put(a, tri, 0); put(b, tri, 3); put(c, tri, 6);
    const cx = (tri[0] + tri[3] + tri[6]) / 3;
    const cz = (tri[2] + tri[5] + tri[8]) / 3;
    const dx = cx - centre.x; const dz = cz - centre.z;
    if (dx * dx + dz * dz > r2) continue;
    const ti = tris.push(tri.slice()) - 1;
    const minX = Math.min(tri[0], tri[3], tri[6]); const maxX = Math.max(tri[0], tri[3], tri[6]);
    const minZ = Math.min(tri[2], tri[5], tri[8]); const maxZ = Math.max(tri[2], tri[5], tri[8]);
    for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
      for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
        const k = `${gx}:${gz}`;
        let list = grid.get(k);
        if (!list) { list = []; grid.set(k, list); }
        list.push(ti);
      }
    }
  }
  return {
    triangles: tris.length,
    cells: grid.size,
    radius,
    centre: { x: centre.x, z: centre.z },
    /** Topmost drawn asphalt at a world point, or null where none is drawn. */
    heightAt(x, z) {
      const list = grid.get(`${Math.floor(x / cell)}:${Math.floor(z / cell)}`);
      if (!list) return null;
      let best = null;
      for (let i = 0; i < list.length; i += 1) {
        const t = tris[list[i]];
        const x0 = t[0]; const y0 = t[1]; const z0 = t[2];
        const x1 = t[3]; const y1 = t[4]; const z1 = t[5];
        const x2 = t[6]; const y2 = t[7]; const z2 = t[8];
        const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
        if (d > -1e-12 && d < 1e-12) continue;
        const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
        if (l0 < -1e-6) continue;
        const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
        if (l1 < -1e-6) continue;
        const l2 = 1 - l0 - l1;
        if (l2 < -1e-6) continue;
        const y = l0 * y0 + l1 * y1 + l2 * y2;
        if (best === null || y > best) best = y;
      }
      return best;
    },
  };
}

/** The carriageway mesh the renderer drew, or null when it is not in the root. */
export function findDrawnRoadMesh(root) {
  if (!root) return null;
  if (typeof root.getObjectByName === 'function') {
    const named = root.getObjectByName('street-surface-v2:carriageway');
    if (named?.geometry) return named;
  }
  let found = null;
  root.traverse?.((node) => {
    if (found || !node?.isMesh) return;
    if (node.name === 'street-surface-v2:carriageway') found = node;
  });
  return found;
}

/**
 * Uniform-grid index over the streetscape plan.
 *
 * The parked layout always knows which segment a vehicle belongs to; the
 * traffic mirror does not - it is handed a world position by the simulation and
 * has to find the carriageway under it before it can put the wheels on it.
 * Built once per plan, O(spans); a lookup is one bucket plus a short scan.
 */
export function createSegmentIndex(plan, cell = 24) {
  const buckets = new Map();
  const key = (cx, cz) => `${cx}:${cz}`;
  let spans = 0;
  for (const segment of plan?.segments || []) {
    const points = segment.points;
    if (!Array.isArray(points) || points.length < 2) continue;
    const reach = segment.half + 1.5;
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (!finite(a?.x) || !finite(b?.x)) continue;
      spans += 1;
      const minX = Math.min(a.x, b.x) - reach;
      const maxX = Math.max(a.x, b.x) + reach;
      const minZ = Math.min(a.z, b.z) - reach;
      const maxZ = Math.max(a.z, b.z) + reach;
      for (let cz = Math.floor(minZ / cell); cz <= Math.floor(maxZ / cell); cz += 1) {
        for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx += 1) {
          const k = key(cx, cz);
          let list = buckets.get(k);
          if (!list) { list = new Set(); buckets.set(k, list); }
          list.add(segment);
        }
      }
    }
  }
  const empty = [];
  return {
    spans,
    cells: buckets.size,
    /** Every plan segment whose cell covers a world point. */
    candidates(x, z) {
      return buckets.get(key(Math.floor(x / cell), Math.floor(z / cell))) || empty;
    },
    /** The carriageway segment covering a world point, nearest centreline wins. */
    locate(x, z) {
      const list = buckets.get(key(Math.floor(x / cell), Math.floor(z / cell)));
      if (!list) return null;
      let best = null;
      for (const segment of list) {
        const hit = segmentProjection(segment, x, z);
        if (!hit) continue;
        // Inside the paved carriageway, plus a small gutter-side slack so a
        // vehicle straddling the kerb line still grounds on its own street.
        if (Math.abs(hit.lateral) > segment.half + 1.0) continue;
        if (best && hit.distance >= best.distance) continue;
        best = { segment, lateral: hit.lateral, station: hit.station, distance: hit.distance };
      }
      return best;
    },
  };
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
  index = null,
  road = null,
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
        const placement = groundVehicle(spec, segment, station, u, yaw, options, datumAt, index, road);
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
export function findTrafficMirror(scene, traffic = null) {
  // Preferred path: the renderer hands the live simulation over on the pass
  // context. Reading `traffic.cars` is O(cars) and needs no scene scan.
  const simCars = Array.isArray(traffic?.cars) ? traffic.cars : null;
  if (simCars) {
    const groups = [];
    for (const car of simCars) {
      const group = car?.group;
      if (group && group.userData?.rig) groups.push(group);
    }
    if (groups.length) {
      const placeholders = [];
      const batch = traffic.vehicleBatch?.group;
      if (batch) placeholders.push(batch);
      return { container: traffic.vehicleGroup || traffic.group || batch || groups[0].parent, placeholders, cars: groups, source: 'ctx.traffic' };
    }
  }
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
  return { container, placeholders, cars, source: 'scene-scan' };
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

/**
 * Assign every planned vehicle to a ring, nearest first, against the per-ring
 * caps. Pure data: no geometry is touched beyond asking the (cached) asset
 * library what a body costs.
 *
 * Shared by the first build and by every LOD re-centre, so a refreshed
 * population is assigned by exactly the same rule as a built one.
 */
function assignVehicleRings(assets, planned, baseRejections) {
  const ringRecords = VEHICLE_RINGS.map((ring) => ({
    id: ring.id, radius: ring.radius, lod: ring.lod, vehicles: 0, triangles: 0,
    maxVehicles: ring.maxVehicles, maxTriangles: ring.maxTriangles,
  }));
  const sorted = [...planned].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const kept = [];
  const rejections = { ...baseRejections };
  const bump = (reason) => { rejections[reason] = (rejections[reason] || 0) + 1; };
  for (const vehicle of sorted) {
    const ring = ringFor(vehicle.distance);
    if (!ring) { bump('beyond-far-ring'); continue; }
    // A full ring DEMOTES, it does not delete. A vehicle that cannot fit its
    // own ring's budget falls outward to the next tier and draws at a coarser
    // level of detail; only a vehicle that fits nowhere is dropped. Dropping
    // it instead would punch a hole in the parked line at exactly the distance
    // where the line is most visible, which is the opposite of what a budget
    // is for. Vehicles are considered nearest-first, so the near tier still
    // gets first claim on every tier's budget.
    const home = VEHICLE_RINGS.indexOf(ring);
    let placed = false;
    for (let index = home; index < VEHICLE_RINGS.length; index += 1) {
      const tier = VEHICLE_RINGS[index];
      const record = ringRecords[index];
      if (record.vehicles >= tier.maxVehicles) { bump(`ring-${tier.id}-vehicle-cap`); continue; }
      const cost = triangleCostOf(assets, vehicle.typeId, tier.lod);
      if (record.triangles + cost > tier.maxTriangles) { bump(`ring-${tier.id}-triangle-cap`); continue; }
      record.vehicles += 1;
      record.triangles += cost;
      vehicle.ring = tier.id;
      vehicle.lod = tier.lod;
      if (index !== home) bump(`demoted-${ring.id}-to-${tier.id}`);
      kept.push(vehicle);
      placed = true;
      break;
    }
    if (!placed) bump('no-ring-has-room');
  }
  return { kept, ringRecords, rejections };
}

/** One static instanced fleet holding the parked population. */
function createParkedFleet(assets, materials, kept) {
  const capacity = new Map();
  for (const vehicle of kept) {
    const key = `${vehicle.typeId}:${vehicle.lod}`;
    capacity.set(key, (capacity.get(key) || 0) + 1);
  }
  if (!capacity.size) return null;
  const fleet = createVehicleFleet({ name: 'vehicle-parked', assets, materials, capacity });
  fleet.begin();
  for (const vehicle of kept) {
    fleet.push({
      typeId: vehicle.typeId,
      lod: vehicle.lod,
      x: vehicle.x, y: vehicle.y, z: vehicle.z,
      yaw: vehicle.yaw, pitch: vehicle.pitch, roll: vehicle.roll,
      paint: hexToLinear(vehicle.paintHex),
      rim: hexToLinear(vehicle.rimHex),
      // A parked vehicle is unlit: no brake, no indicator, wheels straight.
      steer: 0, spin: 0, brake: false, indicator: 0,
      hazard: vehicle.hazard, blink: false,
    });
  }
  fleet.commit();
  return fleet;
}

/** Wheel-contact audit over what was actually placed. */
function groundingAudit(plan, options, kept, index = null, road = null) {
  let worst = 0;
  let sum = 0;
  let samples = 0;
  const datumAt = options.heightAt
    ? (x, z) => options.roadLift + options.heightAt(x, z)
    : () => options.roadLift;
  for (const vehicle of kept) {
    const segment = plan.segmentById.get(vehicle.segmentId);
    if (!segment) continue;
    for (const contact of wheelContactPoints(vehicle.spec, vehicle)) {
      const drawn = road ? road.heightAt(contact.x, contact.z) : null;
      const expected = drawn !== null
        ? drawn
        : topCarriagewayY(index, contact.x, contact.z, options, datumAt, segment);
      if (expected === null) continue;
      const error = Math.abs(contact.y - expected);
      sum += error;
      samples += 1;
      if (error > worst) worst = error;
    }
  }
  return {
    samples,
    worstContactError: worst,
    meanContactError: samples ? sum / samples : 0,
    tolerance: 0.010,
    withinTolerance: worst <= 0.010,
  };
}

/** Appearance spread and per-class census over the placed population. */
function populationStats(kept) {
  const appearance = new Set();
  const byType = {};
  for (const vehicle of kept) {
    appearance.add(`${vehicle.typeId}|${vehicle.paintHex}|${vehicle.rimHex}|${vehicle.lod}`);
    byType[vehicle.typeId] = (byType[vehicle.typeId] || 0) + 1;
  }
  return { uniqueAppearances: appearance.size, byType };
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
  // The drawn carriageway, indexed for point lookup. Both populations ground
  // through it: the parked layout so a kerbside wheel reads the ribbon it is
  // actually on, the traffic mirror so a moving vehicle can be grounded from a
  // world position alone.
  const segmentIndex = createSegmentIndex(plan);
  const roadMesh = findDrawnRoadMesh(ctx?.root);
  const roadIndex = roadMesh
    ? createDrawnRoadIndex(roadMesh, { centre: focus, radius: DRAWN_ROAD_WINDOW.radius })
    : null;
  const planned = planParkedVehicles(plan, {
    focus,
    seed,
    index: segmentIndex,
    road: roadIndex,
    occupancy: hideLegacy ? null : occupancy,
    buildings,
    emptyStallRate: overrides.emptyStallRate ?? 0.16,
    maxVehicles: overrides.maxVehicles ?? 900,
  });

  const assets = overrides.assets || createVehicleAssets(TRIM);
  const materials = overrides.materials || createVehicleMaterials();

  // Ring assignment, nearest first, against the per-ring caps.
  const { kept, ringRecords, rejections } = assignVehicleRings(assets, planned.vehicles, planned.rejections);

  const group = new THREE.Group();
  group.name = VEHICLE_PRESENTATION_ID;
  group.userData = { kind: 'vehicle-presentation', version: VEHICLE_PRESENTATION_VERSION };

  // The environment grader caches its material buckets from ONE traverse of the
  // city root. Anchor every vehicle material to the root now, so the lazily
  // built traffic fleet - and a city with no kerb parking at all - still get an
  // environment map. See `createMaterialAnchor`.
  const anchor = createMaterialAnchor(materials);
  group.add(anchor);

  const parked = createParkedFleet(assets, materials, kept);
  if (parked) group.add(parked.group);

  // The mirrored traffic fleet is built the first time the simulation is found
  // in the scene, with the exact per-type capacity that simulation asked for.
  // Allocating all ten classes up front would leave dead meshes in the render
  // list on every city that never spawns a bus.
  applyVehicleEnvironment(materials, { hour: ctx?.hour, weather: ctx?.weather });
  const parkedStats = parked ? parked.stats() : { triangles: 0, drawCalls: 0, meshes: [] };
  const trafficStats = { triangles: 0, drawCalls: 0, meshes: [] };

  const grounding = groundingAudit(plan, options, kept, segmentIndex, roadIndex);
  const { uniqueAppearances, byType } = populationStats(kept);

  const state = {
    id: VEHICLE_PRESENTATION_ID,
    assets,
    materials,
    ownsAssets: !overrides.assets,
    ownsMaterials: !overrides.materials,
    parked,
    traffic: null,
    group,
    plan,
    options,
    // The drawn carriageway, indexed for point lookup, plus the same datum
    // sampler the parked layout grounds on. The traffic mirror needs both to
    // put a moving vehicle's wheels on the road it is driving down.
    segmentIndex,
    roadMesh,
    roadIndex,
    datumAt: options.heightAt
      ? (x, z) => options.roadLift + options.heightAt(x, z)
      : () => options.roadLift,
    focus,
    // The datum the rings are centred on RIGHT NOW. `focus` is the BUILD
    // focus; `centre` follows the camera. See the LOD-centre note below.
    centre: { x: focus.x, z: focus.z },
    refreshes: 0,
    lastRefreshMs: 0,
    seed,
    // Everything a re-centre needs to re-plan without re-reading the world.
    buildings,
    occupancy,
    emptyStallRate: overrides.emptyStallRate ?? 0.16,
    maxVehicles: overrides.maxVehicles ?? 900,
    vehicles: kept,
    hideLegacy,
    hiddenLegacy: [],
    mirror: null,
    mirrorScan: 0,
    mirrorState: new Map(),
    lightPool: null,
    lightMatrices: [],
    lightScratch: new THREE.Vector3(),
    lightMatrix: new THREE.Matrix4(),
    lightQuat: new THREE.Quaternion(),
    lightEuler: new THREE.Euler(0, 0, 0, 'YXZ'),
    lightScale: new THREE.Vector3(1, 1, 1),
    lightPos: new THREE.Vector3(),
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

  const diagnostics = {
    version: VEHICLE_PRESENTATION_VERSION,
    catalogue: VEHICLE_CATALOGUE_VERSION,
    implemented: true,
    focus,
    // Which datum the rings are centred on RIGHT NOW: the build focus on the
    // first build, the live camera after a re-centre.
    centreSource: 'focus',
    refreshes: 0,
    lastRefreshMs: 0,
    refreshMetres: VEHICLE_FOCUS.refreshMetres,
    plan: plan.stats,
    surface: {
      roadLift: options.roadLift,
      source: ctx?.streetSurfaceOptions ? 'ctx.streetSurfaceOptions' : 'renderer-defaults',
      requestedRoadLift: requested.roadLift,
      hasTerrain: Boolean(options.heightAt),
      // Grounding source. `drawn-geometry` means wheel heights came out of the
      // carriageway mesh the renderer built, with no model in between.
      groundingSource: roadIndex ? 'drawn-geometry' : 'modelled-cross-section',
      drawnRoadTriangles: roadIndex ? roadIndex.triangles : 0,
      drawnRoadRadius: roadIndex ? roadIndex.radius : 0,
      drawnRoadRebuilds: 0,
    },
    catalogueSize: VEHICLE_SPECS.length,
    counts: byType,
    planned: planned.vehicles.length,
    placed: kept.length,
    rejections,
    uniqueAppearances,
    legacyVehiclePoints: occupancy ? occupancy.points : 0,
    legacyPolicy: hideLegacy ? 'hide-and-own-the-kerb' : 'defer-and-dedupe',
    buildingFootprints: buildings.count,
    rings: ringRecords.map((record) => ({
      ...record,
      withinBudget: record.vehicles <= record.maxVehicles && record.triangles <= record.maxTriangles,
    })),
    grounding,
    traffic: {
      capacity: TRAFFIC_MIRROR.maxVehicles,
      perTypeCapacity: TRAFFIC_MIRROR.perTypeCapacity,
      mirrored: 0,
      bound: false,
      source: null,
    },
    night: {
      nightness: nightnessFor(ctx?.hour),
      wetness: wetnessFor(ctx?.weather),
      lampsLit: nightnessFor(ctx?.hour) > VEHICLE_LIGHTS.onAtNightness,
      headEmissive: materials.lamps.head.emissiveIntensity,
      tailEmissive: materials.lamps.tail.emissiveIntensity,
    },
    // Real lights, as opposed to emissive quads. Owned and counted here; see
    // VEHICLE_LIGHTS for why the pool is bounded the way it is.
    lights: {
      pooled: 0,
      active: 0,
      litVehicles: 0,
      maxLights: VEHICLE_LIGHTS.maxLights,
      maxVehicles: VEHICLE_LIGHTS.maxVehicles,
      radius: VEHICLE_LIGHTS.radius,
      castShadow: false,
      withinBudget: true,
      population: 'mirrored-traffic-near',
    },
    // Declared so a reviewer can see, without opening the renderer, that these
    // materials are eligible for the environment map and the wet grade.
    envClasses: { ...VEHICLE_ENV_CLASS },
    materialAnchor: anchor.name,
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
  const hit = segmentProjection(segment, x, z);
  return hit ? hit.lateral : 0;
}

/**
 * Nearest point on a plan segment's centreline: signed lateral offset, arc
 * station, and the planar distance to the centreline. `lateralOf` is the
 * lateral component of this; the traffic mirror needs all three.
 */
export function segmentProjection(segment, x, z) {
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
  return best;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

const MIRROR_RESCAN_SECONDS = 2;

// ---------------------------------------------------------------------------
// headlights
// ---------------------------------------------------------------------------

/**
 * Allocate the whole light pool once, dark and hidden.
 *
 * Every slot is a spot light plus its own target object, both parented to the
 * pass group so the pass's dispose releases them and nothing else in the scene
 * has to know they exist.
 */
function createVehicleLightPool(group) {
  const slots = [];
  for (let i = 0; i < VEHICLE_LIGHTS.maxLights; i += 1) {
    const light = new THREE.SpotLight(
      VEHICLE_LIGHTS.colour, 0,
      VEHICLE_LIGHTS.distance, VEHICLE_LIGHTS.angle,
      VEHICLE_LIGHTS.penumbra, VEHICLE_LIGHTS.decay,
    );
    light.name = `vehicle-headlight-${i}`;
    light.castShadow = false;
    light.visible = false;
    light.userData = { pass: VEHICLE_PRESENTATION_ID, kind: 'headlight' };
    const target = new THREE.Object3D();
    target.name = `vehicle-headlight-target-${i}`;
    light.target = target;
    group.add(light);
    group.add(target);
    slots.push({ light, target, vehicle: null });
  }
  return { slots, active: 0 };
}

/** Park every slot: dark, hidden, and holding no vehicle. */
function releaseVehicleLights(pool, from = 0) {
  if (!pool) return;
  for (let i = from; i < pool.slots.length; i += 1) {
    const slot = pool.slots[i];
    if (slot.light.visible === false && slot.light.intensity === 0) continue;
    slot.light.visible = false;
    slot.light.intensity = 0;
    slot.vehicle = null;
  }
}

/**
 * Point the pool at the nearest lit vehicles.
 *
 * `lit` is already sorted nearest-first and truncated to `maxVehicles`; each
 * entry carries the world matrix the fleet drew the vehicle with, so a beam
 * leaves the same lamp the emissive quad is on rather than a guessed offset.
 */
function aimVehicleLights(pool, lit, nightness, scratch) {
  if (!pool) return 0;
  let used = 0;
  for (const entry of lit) {
    const heads = entry.heads;
    for (let i = 0; i < heads.length && used < pool.slots.length; i += 1) {
      const lamp = heads[i];
      const slot = pool.slots[used];
      scratch.set(lamp.x, lamp.y, lamp.z).applyMatrix4(entry.matrix);
      slot.light.position.copy(scratch);
      // Aim from the lamp, along the vehicle's own +Z, dropped so the cone
      // lands on the carriageway instead of on the next storey of the block.
      scratch.set(lamp.x, lamp.y - VEHICLE_LIGHTS.aimDrop, lamp.z + VEHICLE_LIGHTS.aimAhead)
        .applyMatrix4(entry.matrix);
      slot.target.position.copy(scratch);
      slot.target.updateMatrixWorld();
      slot.light.intensity = VEHICLE_LIGHTS.intensity * nightness;
      slot.light.visible = true;
      slot.vehicle = entry.id;
      used += 1;
    }
    if (used >= pool.slots.length) break;
  }
  releaseVehicleLights(pool, used);
  pool.active = used;
  return used;
}

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

// ---------------------------------------------------------------------------
// LOD centre
// ---------------------------------------------------------------------------
//
// ROUND 3 CORRECTION - READ THIS BEFORE CHANGING THE THRESHOLD.
//
// `ctx.focus` is the renderer's BUILD focus: it is sampled once, when the city
// is built, and the camera then moves away from it. Measured on the round-3
// capture set the rings were still centred on (1588.8, 369.5) while the street
// card stood at (1447.1, 1003.8), 640 m away. Every vehicle in every captured
// frame therefore drew a lod1 or lod2 body - no separate glazing, no wheels,
// details 'none' - which is the "primitive vehicle silhouette" the quality gate
// names as an automatic rejection condition. It is also why no parked vehicle
// cast a shadow: `createVehicleFleet` grants `castShadow` to lod0 paint (and to
// lod1 paint for van/truck/bus/pickup), so a population pinned at lod1/lod2 has
// almost no casters. The flag was always set; nothing was standing in the ring
// that uses it. DO NOT "fix" this by adding a castShadow flag somewhere.
//
// `recentreVehiclePresentation` re-plans the parked population around a new
// centre and rebuilds ONLY the parked fleet. The asset library, the materials,
// the streetscape plan, the building index, the traffic mirror and its
// per-vehicle presentation state are all kept, so a refresh costs a re-plan
// plus one instanced-fleet allocation - not a pass rebuild.
//
// The rebuild is SYNCHRONOUS and completes inside the update call, so a camera
// teleport - which is how every capture card is posed - is fully re-centred in
// the frame it is posed for. Nothing is interpolated.
//
// Threshold choice: the near ring reaches 80 m, so re-centring every 30 m keeps
// at least 50 m of lod0 kerb ahead of the eye.
export const VEHICLE_FOCUS = Object.freeze({
  refreshMetres: 30,
});

/**
 * The drawn-road grounding window.
 *
 * `radius` covers the near ring (80 m) and the mid ring (110 m) plus the 60 m
 * the centre may drift before the window is rebuilt, so every vehicle a
 * reviewer can resolve is grounded on real geometry; the far ring's ten-pixel
 * silhouettes fall back to the modelled cross-section. Measured on the shipped
 * slice: 3.9k triangles and 41 ms to build, against 15.9k and 154 ms at 400 m.
 *
 * `rebuildMetres` is deliberately larger than `refreshMetres`: re-planning the
 * kerb is cheap, re-bucketing the asphalt is not, and the window only has to be
 * rebuilt when the rings are about to walk out of it.
 */
export const DRAWN_ROAD_WINDOW = Object.freeze({
  radius: 200,
  rebuildMetres: 60,
});

/**
 * Re-centre the parked population on `centre`. Returns the elapsed
 * milliseconds. Safe to call with no state.
 */
export function recentreVehiclePresentation(state, centre) {
  if (!state || !state.plan) return 0;
  const startedAt = Date.now();
  // The drawn-road window follows the rings: a vehicle outside it falls back to
  // the modelled cross-section, which is exact everywhere except where two
  // paved surfaces lap.
  if (state.roadMesh) {
    const held = state.roadIndex?.centre;
    const drift = held ? Math.hypot(centre.x - held.x, centre.z - held.z) : Infinity;
    if (drift >= DRAWN_ROAD_WINDOW.rebuildMetres) {
      state.roadIndex = createDrawnRoadIndex(state.roadMesh, {
        centre, radius: DRAWN_ROAD_WINDOW.radius,
      });
      state.roadRebuilds = (state.roadRebuilds || 0) + 1;
    }
  }
  const planned = planParkedVehicles(state.plan, {
    focus: centre,
    seed: state.seed,
    index: state.segmentIndex,
    road: state.roadIndex,
    occupancy: state.hideLegacy ? null : state.occupancy,
    buildings: state.buildings,
    emptyStallRate: state.emptyStallRate,
    maxVehicles: state.maxVehicles,
  });
  const { kept, ringRecords, rejections } = assignVehicleRings(
    state.assets, planned.vehicles, planned.rejections,
  );
  const parked = createParkedFleet(state.assets, state.materials, kept);
  // Swap, then release: the old fleet's meshes stay in the group until the new
  // ones are in place, so a refresh can never leave the kerb empty.
  if (parked) state.group.add(parked.group);
  state.parked?.dispose();
  state.parked = parked;
  state.vehicles = kept;
  state.centre = { x: centre.x, z: centre.z };
  state.refreshes += 1;
  state.lastRefreshMs = Date.now() - startedAt;

  const stats = parked ? parked.stats() : { triangles: 0, drawCalls: 0, meshes: [] };
  // `totals` counts the PARKED fleet, exactly as the first build does. The
  // mirrored traffic fleet is reported separately under `traffic` and is
  // budgeted separately by TRAFFIC_MIRROR; folding it in here on a refresh but
  // not on a build would make the two numbers incomparable.
  const { uniqueAppearances, byType } = populationStats(kept);
  const d = state.diagnostics;
  d.focus = { x: centre.x, z: centre.z };
  d.centreSource = 'camera';
  d.counts = byType;
  d.planned = planned.vehicles.length;
  d.placed = kept.length;
  d.rejections = rejections;
  d.uniqueAppearances = uniqueAppearances;
  d.rings = ringRecords.map((record) => ({
    ...record,
    withinBudget: record.vehicles <= record.maxVehicles && record.triangles <= record.maxTriangles,
  }));
  d.grounding = groundingAudit(state.plan, state.options, kept, state.segmentIndex, state.roadIndex);
  d.meshes = [...stats.meshes];
  d.totals = {
    vehicles: kept.length,
    triangles: stats.triangles,
    drawCalls: stats.drawCalls,
    maxTriangles: VEHICLE_BUDGET.maxTriangles,
    maxDrawCalls: VEHICLE_BUDGET.maxDrawCalls,
    withinTriangleBudget: stats.triangles <= VEHICLE_BUDGET.maxTriangles,
    withinDrawCallBudget: stats.drawCalls <= VEHICLE_BUDGET.maxDrawCalls,
  };
  d.refreshes = state.refreshes;
  d.lastRefreshMs = state.lastRefreshMs;
  if (d.surface) {
    d.surface.drawnRoadTriangles = state.roadIndex ? state.roadIndex.triangles : 0;
    d.surface.drawnRoadRebuilds = state.roadRebuilds || 0;
  }
  return state.lastRefreshMs;
}

export function updateVehiclePresentation(state, ctx, delta) {
  if (!state) return;
  // LOD centre. Steady state is one subtraction and a hypot; the re-plan only
  // runs on a threshold crossing.
  const eye = ctx?.camera?.position;
  if (eye && finite(eye.x) && finite(eye.z) && state.centre) {
    if (Math.hypot(eye.x - state.centre.x, eye.z - state.centre.z) >= VEHICLE_FOCUS.refreshMetres) {
      recentreVehiclePresentation(state, { x: eye.x, z: eye.z });
    }
  }
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
    const found = findTrafficMirror(ctx?.scene || ctx?.root, ctx?.traffic || null);
    if (found && found.cars.length) {
      const changed = !state.mirror || state.mirror.container !== found.container
        || state.mirror.cars.length !== found.cars.length;
      state.mirror = found;
      state.diagnostics.traffic.bound = true;
      state.diagnostics.traffic.source = found.source;
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
  let grounded = 0;
  let offStreet = 0;
  let worstLift = 0;
  const litCandidates = [];
  const nightnessNow = state.materials.state.nightness;
  const lampsOnNow = nightnessNow > VEHICLE_LIGHTS.onAtNightness;
  if (state.mirror) {
    const night = nightnessNow;
    const lampsOn = lampsOnNow;
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
      // GROUNDING (round 5). `src/citygen/traffic.js` owns where a vehicle IS.
      // What the asphalt under it is doing is this pass's business, because
      // this pass is what draws the vehicle.
      //
      // Until this round the mirror wrote the simulation's own y straight into
      // the fleet, and that y was the flat road datum `terrain + roadLift` -
      // the carriageway CROWN minus `crossSlope * half`. Measured against the
      // drawn triangles that is 48 mm below the asphalt on average and 128 mm
      // below it on the crown of a wide street. The body sinks by that much,
      // and the contact patch the fleet writes 20 mm above the vehicle origin
      // ends up BURIED under the road, so a moving vehicle loses the one piece
      // of shading that ties it to the surface and reads as levitating.
      //
      // The contact height is re-derived here from the DRAWN carriageway under
      // the vehicle's own four wheels, and the body takes the pitch and roll of
      // the plane they define. It is presentation only: the simulation's
      // transform is read, never written.
      let groundY = py;
      let groundPitch = 0;
      let groundRoll = 0;
      const hit = state.segmentIndex?.locate(px, pz) || null;
      if (hit) {
        const placed = groundVehicleAt(
          spec, hit.segment, px, pz, yaw, state.options, state.datumAt,
          state.segmentIndex, state.roadIndex,
        );
        if (finite(placed.y)) {
          groundY = placed.y;
          groundPitch = placed.pitch;
          groundRoll = placed.roll;
          grounded += 1;
          const lift = placed.y - py;
          if (Math.abs(lift) > Math.abs(worstLift)) worstLift = lift;
        }
      } else {
        // Junction interiors belong to no segment corridor. The drawn mesh
        // still has asphalt there, so the body is set down on it flat rather
        // than left on the simulation datum.
        const pad = state.roadIndex ? state.roadIndex.heightAt(px, pz) : null;
        if (pad !== null && finite(pad)) {
          groundY = pad;
          grounded += 1;
          const lift = pad - py;
          if (Math.abs(lift) > Math.abs(worstLift)) worstLift = lift;
        } else {
          offStreet += 1;
        }
      }
      const ok = fleet.push({
        typeId: record.typeId,
        lod: TRAFFIC_MIRROR.lod,
        x: px,
        y: groundY,
        z: pz,
        yaw,
        pitch: groundPitch,
        // Body roll is the road's camber plus a little weight transfer in a
        // turn; the two add, and the cornering term stays inside its old band.
        roll: groundRoll + clamp(-yawRate * Math.min(speed, 14) * 0.006, -0.05, 0.05),
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
      if (!ok || !lampsOn || !eye) continue;
      // Headlight candidates: nearest first, inside the lit radius. The pool is
      // handed the vehicle's own world matrix so the beam starts at the lamp.
      const range = Math.hypot(px - eye.x, pz - eye.z);
      if (range > VEHICLE_LIGHTS.radius) continue;
      const built = state.assets.body(record.typeId, TRAFFIC_MIRROR.lod);
      const heads = built?.lamps?.filter((lamp) => lamp.kind === 'head') || [];
      if (!heads.length) continue;
      state.lightEuler.set(groundPitch, yaw, groundRoll, 'YXZ');
      state.lightQuat.setFromEuler(state.lightEuler);
      state.lightPos.set(px, groundY, pz);
      // Pooled matrices: the mirror runs every frame and must not allocate.
      let matrix = state.lightMatrices[litCandidates.length];
      if (!matrix) {
        matrix = new THREE.Matrix4();
        state.lightMatrices[litCandidates.length] = matrix;
      }
      matrix.compose(state.lightPos, state.lightQuat, state.lightScale);
      litCandidates.push({ id: record.typeId, range, heads, matrix });
    }
  }
  fleet.commit();

  // Lights, after the bodies: the pool follows what was actually drawn.
  if (lampsOnNow && litCandidates.length) {
    if (!state.lightPool) {
      state.lightPool = createVehicleLightPool(state.group);
      state.diagnostics.lights.pooled = state.lightPool.slots.length;
    }
    litCandidates.sort((a, b) => a.range - b.range);
    const lit = litCandidates.slice(0, VEHICLE_LIGHTS.maxVehicles);
    const active = aimVehicleLights(state.lightPool, lit, nightnessNow, state.lightScratch);
    state.diagnostics.lights.active = active;
    state.diagnostics.lights.litVehicles = lit.length;
    state.diagnostics.lights.withinBudget = active <= VEHICLE_LIGHTS.maxLights;
  } else if (state.lightPool) {
    releaseVehicleLights(state.lightPool);
    state.lightPool.active = 0;
    state.diagnostics.lights.active = 0;
    state.diagnostics.lights.litVehicles = 0;
  }
  const stats = fleet.stats();
  state.diagnostics.traffic.mirrored = mirrored;
  state.diagnostics.traffic.grounded = grounded;
  state.diagnostics.traffic.offStreet = offStreet;
  // How far the drawn contact height had to move from the simulation datum.
  // A non-zero number here is the camber the flat datum cannot express, not an
  // error: it is what stops the wheels sinking into the crown.
  state.diagnostics.traffic.worstGroundLift = worstLift;
  state.diagnostics.traffic.triangles = stats.triangles;
  state.diagnostics.traffic.drawCalls = stats.drawCalls;
  state.diagnostics.traffic.withinBudget = stats.triangles <= TRAFFIC_MIRROR.maxTriangles;
}

export function disposeVehiclePresentation(state) {
  if (!state) return;
  if (state.lightPool) {
    for (const slot of state.lightPool.slots) {
      slot.light.visible = false;
      slot.light.intensity = 0;
      slot.light.parent?.remove(slot.light);
      slot.target.parent?.remove(slot.target);
      slot.light.dispose?.();
      slot.vehicle = null;
    }
    state.lightPool = null;
  }
  for (const node of state.hiddenLegacy) node.visible = true;
  state.hiddenLegacy.length = 0;
  state.parked?.dispose();
  state.traffic?.dispose();
  if (state.ownsAssets !== false) state.assets?.dispose();
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

  /** Test seam: the live diagnostics without going through the registry. */
  __diagnostics() {
    return activeState?.diagnostics || null;
  },

  /** Test seam: the live pass state. */
  __state() {
    return activeState;
  },
};
