// street-surface-detail - presentation pass.
//
// Owner: Terrain/streets (src/world/streets is the truth; this file is the
// presentation adapter). Contract: src/render/pass-registry.js.
//
// WHAT THIS FIXES
//
// The paved surface built by src/world/streets/street-surface-v2.js is
// geometrically correct - cambered carriageway, gutter pan, curb, footway,
// filleted junction pads, kerb ramps - but it is *undressed*. On the shipped
// San Francisco slice the whole 54 km of street carries only edge lines, a
// centre line and dashed lane dividers, because the only paint v2 emits at a
// junction is gated on `node.signalId`, and the source city records 7 signals
// against 225 junctions. So 218 real intersections have no crossing, no stop
// bar and no lane assignment, the road has no drainage, no covers, no patching
// and no wear, and the footway is an unbroken slab with no scored joints and
// no detectable-warning pad at any corner. That reads as a prototype ribbon.
//
// This pass adds the construction detail, city-wide, entirely from the street
// contract (`city.segments` / `city.streets`: `points`, `asphaltWidth` /
// `width`, `sidewalkWidth` / `sidewalkW`, `className` / `highway`,
// `streetName`, `oneway`, `lanes`, plus `city.intersections` and
// `city.signals`). It never reads a mesh, never infers a lane from geometry
// and never writes simulation state.
//
//   1. ROAD SURFACE TRUTH
//      - marked crossings at every junction that earns one, in the two
//        real families (continental ladder on arterials, transverse pair on
//        collectors), at the legal band depth;
//      - stop bars on the approaches that actually stop, decided by street
//        class rank across the node, not by guesswork;
//      - lane-assignment arrows in the approach lanes, with the available
//        movements derived from the ANGLES OF THE OTHER APPROACHES, so a T
//        junction never gets a through arrow into a wall;
//      - deterministic paint wear: some nodes freshly repainted, some faded
//        two thirds of the way back to asphalt, per-stripe jitter on top.
//   2. CONSTRUCTION DETAIL
//      - curb inlets in the gutter upstream of every corner, plus mid-block
//        inlets at the LOW POINT of a long segment (sampled from the same
//        height field the surface is built on, so they really are low points);
//      - manhole, valve and utility covers at plausible spacing, in the
//        carriageway and on the footway;
//      - trench patches with tar-sealed edges, longitudinal cold joints on the
//        lane lines, tar crack chains that follow the gutter lip and the lane
//        joint - stress lines, not noise - and polished wheel paths.
//   3. SIDEWALK TRUTH
//      - scored panel joints at a real panel size (1.2-1.8 m, fixed per
//        street), wider expansion joints every sixth panel, a longitudinal
//        joint on wide footways;
//      - detectable-warning pads with truncated domes on the kerb ramps the
//        surface builder already cut;
//      - driveway aprons where a service way meets a street's footway;
//      - staining along the curb and the property line.
//
// BUDGET AND RINGS (this runs over thousands of segments and the QA capture
// path is a SOFTWARE GL backend, where a runaway triangle count makes the
// review loop unusable). Every item is assigned to a distance ring measured
// from `ctx.focus`, the build focus, and each ring carries a different feature
// set and a hard triangle cap. Rings are baked at build time, like every other
// static ring in this renderer; nothing here allocates per frame.
//
// Z-FIGHTING POLICY. Every decal here is a lift above the SAME cambered
// surface sample the paved geometry uses, plus polygonOffset, following the
// policy documented at the top of street-surface-v2.js. The lift ladder is
// deliberate and ordered: wear (6 mm) < crack (8 mm) < cover (10 mm) <
// segment paint (12 mm, v2) < junction paint (15 mm, v2 and this pass). A
// crossing therefore wins over the lane line it crosses, and a patch never
// wins over the paint on top of it.
//
// Determinism: no Math.random, no Date.now, no unordered iteration. Every
// variation is a string hash of a source id.

import * as THREE from 'three';
import { applyDetailMaps, uvScalePerMetre } from '../detail-maps.js';
import {
  buildStreetscapePlan,
  sidewalkBand,
  sidewalkSurfaceY,
  carriagewaySurfaceY,
  curbTopSurfaceY,
  streetStationAt,
  streetRandom,
  streetHash32,
  wheelTrackWeight,
  getPaintMapTexture,
  STREET_SURFACE_V2_DEFAULTS,
} from '../../world/streets/street-surface-v2.js';

export const STREET_DETAIL_ID = 'street-surface-detail';
export const STREET_DETAIL_VERSION = 'street-surface-detail-v1';

/**
 * Distance rings from `ctx.focus`.
 *
 * ROUND 2 CORRECTION - READ THIS BEFORE CHANGING A RADIUS.
 *
 * Round 1 shipped three rings whose outermost radius was 900 m, on the
 * assumption that `ctx.focus` is near the camera. It is not. `CityRenderer`
 * takes the build focus from `this.camera.position` at the moment `buildCity`
 * runs, and the app reframes the camera AFTER the build, so on the shipped
 * route the focus is the startup camera at (180, 260) while the loaded window
 * is centred on (1600, 400). Every quality-card pose was 1450-1510 m from that
 * focus. Measured on the shipped slice, the whole city therefore received
 * 2558 triangles of detail - 36 crossings and 28 stop bars, none of them
 * anywhere near a camera - and the eight captured frames contained none of
 * this pass's work at all.
 *
 * So a ring may no longer decide whether something EXISTS. The outermost ring
 * has `radius: null`, which resolves to the whole loaded window, and it
 * carries every structural feature: crossings, stop bars, lane arrows,
 * drainage, covers, patching, ramp pads, expansion joints, aprons. The inner
 * rings only add the features whose cost scales with METRES OF STREET rather
 * than with junction or segment count - panel joints at true panel pitch,
 * wheel polish, crack chains, stains, truncated domes. A wrong focus now
 * costs fine detail near the camera; it can no longer empty the city.
 */
export const STREET_DETAIL_RINGS = Object.freeze([
  Object.freeze({
    id: 'near',
    radius: 140,
    maxTriangles: 170000,
    features: Object.freeze([
      'crossing', 'stopBar', 'laneArrow', 'inlet', 'cover', 'sidewalkCover',
      'patch', 'coldJoint', 'crack', 'wheelPath', 'gutterGrime',
      'panelJoint', 'expansionJoint', 'longJoint', 'stain',
      'rampPad', 'rampDome', 'driveway',
    ]),
  }),
  Object.freeze({
    id: 'mid',
    radius: 420,
    maxTriangles: 170000,
    features: Object.freeze([
      'crossing', 'stopBar', 'laneArrow', 'inlet', 'cover', 'sidewalkCover',
      'patch', 'coldJoint', 'gutterGrime', 'panelJoint', 'expansionJoint',
      'longJoint', 'rampPad', 'driveway',
    ]),
  }),
  Object.freeze({
    // `radius: null` = the whole loaded window. Resolved per build from
    // `city.meta.bounds` and the focus, so nothing inside the world is ever
    // undressed no matter where the focus lands.
    id: 'window',
    radius: null,
    maxTriangles: 260000,
    features: Object.freeze([
      'crossing', 'stopBar', 'laneArrow', 'inlet', 'cover',
      'patch', 'coldJoint', 'gutterGrime', 'expansionJoint', 'rampPad', 'driveway',
    ]),
  }),
]);

/** Hard bounds on the resolved window radius, so an enormous map still ends. */
export const STREET_DETAIL_WINDOW = Object.freeze({ minRadius: 900, maxRadius: 2600, margin: 140 });

export const STREET_DETAIL_BUDGET = Object.freeze({
  maxTriangles: 520000,
  maxDrawCalls: 6,
  rings: STREET_DETAIL_RINGS,
});

/** Vertical offsets above the surface being decorated. See the header. */
export const STREET_DETAIL_LIFTS = Object.freeze({
  wear: 0.006,
  crack: 0.008,
  cover: 0.010,
  paint: 0.015,      // matches street-surface-v2's junctionPaintLift
  stain: 0.003,
  apron: 0.0035,
  joint: 0.0045,
  rampPad: 0.008,
  dome: 0.010,
});

/** Legal / practical marking dimensions, in metres. */
export const STREET_DETAIL_MARKINGS = Object.freeze({
  crosswalkMinWidth: 1.8,     // narrowest legal marked crossing
  crosswalkMaxWidth: 4.9,     // widest this pass will paint
  ladderStripeWidth: 0.45,
  ladderStripePitch: 0.85,
  transverseLineWidth: 0.3,
  stopBarDepth: 0.55,
  stopBarMin: 0.3,
  stopBarMax: 0.6,
  arrowLength: 3.4,
  arrowShaftWidth: 0.32,
  arrowHeadWidth: 0.95,
});

/**
 * Fixed tones: hardware, paint and the detectable-warning pads, which are the
 * same colour whatever the road is made of.
 */
const PALETTE = Object.freeze({
  coverIron: '#6a6c6a',
  coverIronLight: '#83857f',
  coverConcrete: '#b6b2a6',
  grate: '#4c4f4d',
  domePadYellow: '#d8a521',
  domePadRed: '#9c4128',
  domeCap: '#e2b845',
});

/**
 * WEAR IS A MULTIPLIER, NOT A COLOUR (round 5). READ THIS BEFORE EDITING.
 *
 * Everything in this pass that is a MODIFICATION of the surface underneath it
 * - a patch, a tar seal, a polished wheel path, gutter grime, a scored joint,
 * a stain, an apron - has to end up DARKER or LIGHTER THAN WHAT IT MODIFIES,
 * by a stated ratio, on any palette. Rounds 1-4 got that wrong twice over:
 *
 *   1. The tone was derived from the palette TINT alone, while the surface it
 *      lands on renders as tint x albedo map. The carriageway tint is a pale
 *      #dde0e1 multiplied by a dark asphalt photo, so the road renders at
 *      linear 0.0595 - and `scale(asphalt, 0.7)`, with no map on it, rendered
 *      at linear 0.326. The "dark patch" was 5.5x BRIGHTER than the road it
 *      was patching. Every decal in the pass had the same defect, because none
 *      of the five materials carried a map of any kind.
 *   2. `scale()` multiplies the sRGB CODE VALUE, so the number in the source
 *      was never the ratio the renderer produced: 0.7 of the code is 0.45 of
 *      the light, and 0.5 of the code is 0.22 of the light.
 *
 * Both halves are fixed here. The materials now carry the SAME albedo maps the
 * street surface carries, on UVs baked at the SAME metres-per-repeat, so a
 * decal samples the same texel as the surface it sits on; and the tone is the
 * surface's own tint scaled by a LINEAR factor, so `patchDark: 0.58` means the
 * patch reflects 58% of what the road beside it reflects, on every palette,
 * whatever the map underneath is doing.
 */
export const STREET_WEAR_MULTIPLIERS = Object.freeze({
  // carriageway
  patchDark: 0.58,      // fresh dense-graded overlay, darker than aged asphalt
  patchLight: 1.30,     // an old, oxidised, sun-bleached cut
  tar: 0.30,            // crack sealant and cold-joint seal: near-black
  wheelPolish: 0.86,    // aggregate polished by tyres: slightly darker, glossier
  gutterGrime: 0.66,    // silt and oil against the kerb line
  // footway
  jointLip: 0.86,       // the tooled shoulder either side of a score joint
  jointDeep: 0.44,      // the bottom of the groove, which never sees the sky
  stain: 0.76,          // downpipe and kerb-runoff washes
  apron: 0.94,          // a driveway apron is a separate, later pour
  // paint
  paintWorn: 0.26,      // a stripe scrubbed back to a ghost
});

function wearTones(o, className) {
  const asphalt = hexToSrgb(o.colors.asphalt[className] || o.colors.asphalt.default);
  const sidewalk = hexToSrgb(o.colors.sidewalk);
  const gutter = hexToSrgb(o.colors.gutter);
  const k = STREET_WEAR_MULTIPLIERS;
  return {
    patchDark: mulLinear(asphalt, k.patchDark),
    patchLight: mulLinear(asphalt, k.patchLight),
    tar: mulLinear(asphalt, k.tar),
    wheelPolish: mulLinear(asphalt, k.wheelPolish),
    gutterGrime: mulLinear(gutter, k.gutterGrime),
    jointLip: mulLinear(sidewalk, k.jointLip),
    jointDeep: mulLinear(sidewalk, k.jointDeep),
    stain: mulLinear(sidewalk, k.stain),
    apron: mulLinear(sidewalk, k.apron),
    paintFresh: hexToSrgb(o.colors.markingWhite),
    paintWorn: mulLinear(hexToSrgb(o.colors.markingWhite), k.paintWorn),
  };
}

const UP = Object.freeze({ x: 0, y: 1, z: 0 });

// ---------------------------------------------------------------------------
// buffers
// ---------------------------------------------------------------------------

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToSrgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function linearToSrgb(c) {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * (v ** (1 / 2.4)) - 0.055;
}

/**
 * Multiply a stored sRGB colour by a LINEAR factor: `mulLinear(c, 0.5)` halves
 * the light the surface reflects. See STREET_WEAR_MULTIPLIERS.
 */
function mulLinear(rgb, k) {
  const f = k < 0 ? 0 : k;
  return [
    linearToSrgb(srgbToLinear(rgb[0]) * f),
    linearToSrgb(srgbToLinear(rgb[1]) * f),
    linearToSrgb(srgbToLinear(rgb[2]) * f),
  ];
}

/**
 * `uvMetres` is how many world metres one UV unit spans, so the decal's UVs
 * land on the SAME texel of the SAME albedo map as the surface it decorates.
 * Round 4 baked every buffer at a fixed 2 m and no buffer had a map on it.
 */
function makeBuffer(name, uvMetres = 2) {
  return {
    name,
    uvScale: 1 / (Number(uvMetres) > 0 ? Number(uvMetres) : 2),
    positions: [], normals: [], colors: [], uvs: [], indices: [], triangles: 0,
  };
}

/**
 * Emit a convex planar polygon as a triangle fan, with the winding forced to
 * agree with `normal`. Forcing it here rather than trusting every call site is
 * what keeps a back-facing decal from appearing as a hole at grazing angles.
 */
function pushFace(buffer, points, color, normal = UP) {
  const count = points.length;
  if (count < 3) return 0;
  // Newell normal of the ring as given.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % count];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const area2 = Math.hypot(nx, ny, nz);
  if (!(area2 > 1e-9)) return 0;
  const flip = (nx * normal.x + ny * normal.y + nz * normal.z) < 0;
  const ring = flip ? [...points].reverse() : points;
  const base = buffer.positions.length / 3;
  const perVertex = Array.isArray(color[0]);
  for (let i = 0; i < count; i += 1) {
    const p = ring[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return 0;
    buffer.positions.push(p.x, p.y, p.z);
    buffer.normals.push(normal.x, normal.y, normal.z);
    const c = perVertex ? color[flip ? count - 1 - i : i] : color;
    buffer.colors.push(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]));
    buffer.uvs.push(p.x * buffer.uvScale, p.z * buffer.uvScale);
  }
  for (let i = 1; i < count - 1; i += 1) {
    buffer.indices.push(base, base + i, base + i + 1);
    buffer.triangles += 1;
  }
  return count - 2;
}

function bufferToGeometry(buffer) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffer.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(buffer.normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(buffer.colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(buffer.uvs, 2));
  geometry.setIndex(buffer.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------
// small geometry helpers
// ---------------------------------------------------------------------------

function perpCCW(u) {
  return { x: -u.z, z: u.x };
}

function normAngle(a) {
  let v = a % (Math.PI * 2);
  if (v < 0) v += Math.PI * 2;
  return v;
}

function signedAngle(a) {
  let v = a % (Math.PI * 2);
  if (v > Math.PI) v -= Math.PI * 2;
  if (v <= -Math.PI) v += Math.PI * 2;
  return v;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Regular polygon in the XZ plane at a fixed height. */
function discPoints(cx, cz, radius, sides, y, phase = 0) {
  const out = [];
  for (let i = 0; i < sides; i += 1) {
    const a = phase + (i / sides) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * radius, y, z: cz + Math.sin(a) * radius });
  }
  return out;
}

// ---------------------------------------------------------------------------
// coupling to the built surface
// ---------------------------------------------------------------------------
//
// The decals in this pass are lifts above the surface street-surface-v2 built,
// so they only stay on that surface if they are built with the SAME options
// the renderer handed it. Those options are currently constants inside
// src/citygen/renderer.js (`LEGACY_SIDEWALK_LIFT`, `STREET_GUTTER_DEPTH`,
// `streetSurfaceLift()`), which this pass may not edit, so they are mirrored
// here and the mirror is asserted against the renderer source by
// scripts/verify/verify-street-detail.mjs. `ctx.streetSurfaceOptions`, when the
// integration owner adds it, wins over the mirror and retires the duplication.

export const STREET_SURFACE_COUPLING = Object.freeze({
  gutterDepth: 0.04,     // renderer.js STREET_GUTTER_DEPTH
  sidewalkLift: 0.102,   // renderer.js LEGACY_SIDEWALK_LIFT
  curbTopFall: 0.008,    // street-surface-v2 STREET_SURFACE_V2_DEFAULTS.curbTopFall
});

/** The exact overrides `CityRenderer.buildRoadNetwork` gives the surface. */
export function surfaceOptionsFor(ctx, overrides = {}) {
  if (ctx?.streetSurfaceOptions) return { ...ctx.streetSurfaceOptions, ...overrides };
  const city = ctx?.city;
  const generator = city?.meta?.generator;
  const realMap = generator === 'sf-builtin' || generator === 'openstreetmap';
  const roadLift = Number(city?.meta?.streetDesign?.roadLift);
  const heightAt = typeof ctx?.heightAt === 'function' ? ctx.heightAt : null;
  return {
    roadLift: Number.isFinite(roadLift) ? roadLift : 0.5,
    gutterDepth: STREET_SURFACE_COUPLING.gutterDepth,
    curbFaceHeight: STREET_SURFACE_COUPLING.sidewalkLift
      + STREET_SURFACE_COUPLING.gutterDepth
      + STREET_SURFACE_COUPLING.curbTopFall,
    heightAt: heightAt ? (x, z) => {
      const h = Number(heightAt(x, z));
      return Number.isFinite(h) ? h : 0;
    } : null,
    palette: ctx?.isSanFrancisco ? 'sf' : 'stylised',
    inferNodes: realMap,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// focus and window
// ---------------------------------------------------------------------------

/**
 * Where the rings are centred, and how far the outermost one has to reach.
 *
 * A focus outside the loaded window is not a focus, it is a bug in the caller,
 * and round 1 proved it silently empties the city. So a focus is only accepted
 * when it lands inside `city.meta.bounds` grown by a tenth; otherwise the
 * bounds centre is used and the substitution is recorded in the diagnostics
 * rather than hidden.
 */
export function resolveFocus(ctx, city) {
  const bounds = city?.meta?.bounds;
  const centre = bounds
    ? { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 }
    : { x: 0, z: 0 };
  const given = ctx?.focus;
  if (!given || !Number.isFinite(given.x) || !Number.isFinite(given.z)) {
    return { ...centre, source: bounds ? 'bounds-centre' : 'origin', rejected: null };
  }
  if (bounds) {
    const padX = (bounds.maxX - bounds.minX) * 0.1;
    const padZ = (bounds.maxZ - bounds.minZ) * 0.1;
    const inside = given.x >= bounds.minX - padX && given.x <= bounds.maxX + padX
      && given.z >= bounds.minZ - padZ && given.z <= bounds.maxZ + padZ;
    if (!inside) {
      return {
        ...centre,
        source: 'bounds-centre',
        rejected: { x: given.x, z: given.z, reason: 'focus outside city.meta.bounds' },
      };
    }
  }
  return { x: given.x, z: given.z, source: 'ctx', rejected: null };
}

/** Radius that reaches every corner of the loaded window from `focus`. */
export function windowRadius(focus, bounds, limits = STREET_DETAIL_WINDOW) {
  if (!bounds) return limits.minRadius;
  let far = 0;
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const z of [bounds.minZ, bounds.maxZ]) {
      far = Math.max(far, Math.hypot(x - focus.x, z - focus.z));
    }
  }
  return clamp(far + limits.margin, limits.minRadius, limits.maxRadius);
}

// ---------------------------------------------------------------------------
// build state
// ---------------------------------------------------------------------------

function makeState(plan, focus, options, seedTag, outerRadius) {
  const rings = STREET_DETAIL_RINGS.map((ring) => ({
    ...ring,
    radius: ring.radius == null ? outerRadius : ring.radius,
    used: 0,
    features: new Set(ring.features),
  }));
  const o = plan.options;
  // One UV unit per buffer = one repeat of the map that buffer's material
  // carries, in world metres, exactly as street-surface-v2 bakes the surface
  // underneath. `metal` and `dome` carry no albedo, only a fine detail relief,
  // so they state their own tile.
  const uv = o.uvMetersPerRepeat || SURFACE_UV_METRES;
  const buffers = {
    paint: makeBuffer('paint', uv.marking || SURFACE_UV_METRES.marking),
    wear: makeBuffer('wear', uv.carriageway || SURFACE_UV_METRES.carriageway),
    metal: makeBuffer('metal', HARDWARE_UV_METRES),
    concrete: makeBuffer('concrete', uv.concrete || SURFACE_UV_METRES.concrete),
    dome: makeBuffer('dome', HARDWARE_UV_METRES),
  };
  const heightAt = o.heightAt;
  return {
    plan,
    o,
    options,
    focus,
    // Every hash and every random stream in this pass is prefixed with the
    // city seed, so one seed is bit-identical run to run and two seeds differ.
    seedTag: String(seedTag ?? 'city'),
    rings,
    buffers,
    counts: {},
    rejections: {},
    ringTriangles: rings.map((ring) => ({ id: ring.id, radius: ring.radius, triangles: 0, items: 0 })),
    usedSegments: new Set(),
    usedNodes: new Set(),
    source: null,
    // Measured records of every anchored marking, so a verifier can assert
    // against what was emitted instead of re-deriving it from buffers.
    records: { crossings: [], stopBars: [], laneArrows: [], inlets: [], rampPads: [] },
    datum: heightAt
      ? (x, z) => o.roadLift + heightAt(x, z)
      : () => o.roadLift,
  };
}

function totalTriangles(state) {
  let total = 0;
  for (const buffer of Object.values(state.buffers)) total += buffer.triangles;
  return total;
}

function reject(state, feature, reason) {
  const key = `${feature}:${reason}`;
  state.rejections[key] = (state.rejections[key] || 0) + 1;
}

/** Which ring an item at (x, z) belongs to, or null when it is out of range. */
function ringAt(state, x, z) {
  const dx = x - state.focus.x;
  const dz = z - state.focus.z;
  const d2 = dx * dx + dz * dz;
  for (const ring of state.rings) {
    if (d2 <= ring.radius * ring.radius) return ring;
  }
  return null;
}

/**
 * Run `fn` only if the item's ring carries `feature` and the ring still has
 * triangles left, and charge whatever it emitted to that ring. Every rejection
 * is recorded with its reason so the diagnostics can explain a missing item.
 */
function emitItem(state, x, z, feature, fn) {
  const ring = ringAt(state, x, z);
  if (!ring) { reject(state, feature, 'out-of-range'); return 0; }
  if (!ring.features.has(feature)) { reject(state, feature, `ring-${ring.id}`); return 0; }
  if (ring.used >= ring.maxTriangles) { reject(state, feature, 'ring-budget'); return 0; }
  const before = totalTriangles(state);
  fn();
  const delta = totalTriangles(state) - before;
  if (delta <= 0) { reject(state, feature, 'degenerate'); return 0; }
  ring.used += delta;
  const record = state.ringTriangles[state.rings.indexOf(ring)];
  record.triangles += delta;
  record.items += 1;
  state.counts[feature] = (state.counts[feature] || 0) + 1;
  // Provenance: which source records actually produced content.
  const source = state.source;
  if (source) {
    if (source.kind === 'node') state.usedNodes?.add(source.id);
    else state.usedSegments?.add(source.id);
  }
  return delta;
}

// ---------------------------------------------------------------------------
// 1. junction paint: crossings, stop bars, lane arrows
// ---------------------------------------------------------------------------

/**
 * Does this junction earn marked crossings?
 *
 * A signalised node is excluded because street-surface-v2 already paints it;
 * painting it again would put two zebra bands in the same 15 mm of air. Every
 * other node is judged on the street contract alone: a real junction (three or
 * more approaches) where at least one approach is a collector or better.
 */
export function junctionEarnsCrossings(node) {
  if (!node || node.signalised) return false;
  if (node.degree < 3) return false;
  if (node.maxClassRank < 4) return false;
  // A crossing is marked where a footway has to continue ACROSS a leg, which
  // needs at least three legs that carry a footway at all. Two streets plus a
  // service alley is a driveway, not a junction, and gets no ladder.
  return node.approaches.filter((a) => a.classRank >= 3).length >= 3;
}

/**
 * Which approaches stop here, from class rank alone.
 *
 * Two real controls fall out of the contract: a minor approach stops for a
 * major one, and an all-way stop appears where every approach is the same
 * class and that class is a collector or below - which is exactly the
 * four-way-stop residential grid.
 */
export function approachStops(node, approach) {
  if (!approach.flowsToward) return false;
  if (approach.classRank < node.maxClassRank) return true;
  // An unsignalised junction of equal-class streets is stop-controlled - the
  // four-way stop that fills a real city grid. Trunk and motorway ranks are
  // excluded: those are grade-separated or signalised, never stop-controlled.
  return node.minClassRank === node.maxClassRank && node.maxClassRank <= 6 && node.degree >= 3;
}

/** Marked crossing width for a node, inside the legal band. */
export function crossingWidthFor(node) {
  const { crosswalkMinWidth, crosswalkMaxWidth } = STREET_DETAIL_MARKINGS;
  const width = node.maxClassRank >= 6 ? 3.6 : node.maxClassRank >= 5 ? 3.0 : 2.4;
  return clamp(width, crosswalkMinWidth, crosswalkMaxWidth);
}

/**
 * Movements available from one approach, derived from the ANGLES of the other
 * approaches at the same node and from their one-way direction. Nothing here
 * looks at a mesh, and nothing assumes a four-way grid.
 *
 * Handedness follows street-surface-v2: traffic arriving at the node travels
 * along -u and keeps to the -perpCCW(u) half, so the curb side of an arriving
 * vehicle is -m and a turn toward -m is the near-side ("right") turn.
 */
export function movementsFrom(node, approach) {
  const u = approach.u;
  const m = perpCCW(u);
  const out = { through: false, near: false, far: false };
  const throughCos = Math.cos((25 * Math.PI) / 180);
  for (const other of node.approaches) {
    if (other === approach) continue;
    // A one-way street whose traffic flows toward this node cannot be exited on.
    if (other.oneway && other.flowsToward) continue;
    const dotForward = -(other.u.x * u.x + other.u.z * u.z);
    const dotLateral = other.u.x * m.x + other.u.z * m.z;
    if (dotForward > throughCos) { out.through = true; continue; }
    if (dotForward < -throughCos) continue; // a U-turn back down the same leg
    if (dotLateral < -0.25) out.near = true;
    else if (dotLateral > 0.25) out.far = true;
  }
  return out;
}

/**
 * Lane assignment for the approach lanes of one approach, curb lane first.
 * Returns one entry per approach lane: `{ lane, centre, width, movement }`
 * where `centre` is the lateral offset along m.
 */
export function laneAssignment(node, approach) {
  const half = approach.half;
  const lanes = Math.max(1, approach.lanes);
  const moves = movementsFrom(node, approach);
  const count = approach.oneway ? lanes : Math.max(1, Math.floor(lanes / 2));
  const span = approach.oneway ? half * 2 : half;
  const laneWidth = span / count;
  const out = [];
  for (let k = 0; k < count; k += 1) {
    const centre = -half + laneWidth * (k + 0.5);
    let movement = 'through';
    if (!moves.through) movement = moves.near ? 'near' : moves.far ? 'far' : null;
    else if (count === 1) movement = 'through';
    else if (k === 0) movement = moves.near ? (count >= 3 ? 'near' : 'through-near') : 'through';
    else if (k === count - 1) movement = moves.far ? (count >= 3 ? 'far' : 'through-far') : 'through';
    if (!movement) continue;
    out.push({ lane: k, centre, width: laneWidth, movement });
  }
  return out;
}

/**
 * Arrow outline(s) in approach-local (distance-back, lateral) coordinates.
 *
 * ROUND 3 FIX. The turn barb used to run a fixed 1.5 m sideways and then put a
 * 1.15 m arrow head beyond that, so on a narrow approach the head crossed the
 * kerb line: on the shipped slice, `sf-seg-456` has half = 3.2 m and a single
 * stopping lane centred at -1.6 m, which put the near-turn head at -4.25 m -
 * 1.05 m onto the footway. That was 279 of 22 269 junction-paint vertices,
 * every one of them at exactly that overshoot. The barb and its head are now
 * fitted into whatever lateral room the carriageway actually has, and shrink
 * together rather than the head being appended past the end.
 *
 * @param {number} half half the carriageway width of this approach, metres
 */
function arrowShapes(movement, dTail, centre, half) {
  const { arrowLength, arrowShaftWidth, arrowHeadWidth } = STREET_DETAIL_MARKINGS;
  const headLength = 1.15;
  const hw = arrowShaftWidth / 2;
  const stemEnd = dTail - (arrowLength - headLength);
  const tip = dTail - arrowLength;
  const shapes = [];
  const wantsThrough = movement === 'through' || movement.startsWith('through-');
  if (wantsThrough) {
    shapes.push([
      { d: dTail, v: centre - hw }, { d: dTail, v: centre + hw },
      { d: stemEnd, v: centre + hw }, { d: stemEnd, v: centre - hw },
    ]);
    shapes.push([
      { d: stemEnd, v: centre - arrowHeadWidth / 2 },
      { d: stemEnd, v: centre + arrowHeadWidth / 2 },
      { d: tip, v: centre },
    ]);
  }
  const turn = movement === 'near' || movement === 'through-near' ? -1
    : movement === 'far' || movement === 'through-far' ? 1 : 0;
  if (turn !== 0) {
    // A turn barb leaves the shaft, runs sideways, and ends in a head that
    // points across the carriageway.
    const barbD = wantsThrough ? dTail - 1.0 : dTail - (arrowLength - headLength);
    const wantReach = wantsThrough ? 1.05 : 1.5;
    // Room left on the turn side, inside the kerb line with the same 0.25 m
    // inset a real lane line keeps.
    const edge = Math.max(0.3, (Number.isFinite(half) ? half : Infinity) - 0.25);
    const room = turn > 0 ? edge - centre : centre + edge;
    const wanted = wantReach + headLength;
    const fitted = Math.max(0.5, Math.min(wanted, room));
    const head = Math.min(headLength, fitted * 0.45);
    const reach = fitted - head;
    const vEnd = centre + turn * reach;
    if (!wantsThrough) {
      shapes.push([
        { d: dTail, v: centre - hw }, { d: dTail, v: centre + hw },
        { d: barbD, v: centre + hw }, { d: barbD, v: centre - hw },
      ]);
    }
    shapes.push([
      { d: barbD + hw, v: centre }, { d: barbD + hw, v: vEnd },
      { d: barbD - hw, v: vEnd }, { d: barbD - hw, v: centre },
    ]);
    shapes.push([
      { d: barbD + arrowHeadWidth / 2, v: vEnd },
      { d: barbD - arrowHeadWidth / 2, v: vEnd },
      { d: barbD, v: vEnd + turn * head },
    ]);
  }
  return shapes;
}

function emitJunctionPaint(state, node) {
  const o = state.o;
  const tones = wearTones(o, node.approaches[0]?.className || 'default');
  const fresh = tones.paintFresh;
  // Repainting is a per-junction event, so the wear of every mark at one node
  // is correlated. 0 = repainted last month, 1 = due for repainting.
  const nodeWear = ((streetHash32(`${state.seedTag}:repaint:${node.id}`) % 1000) / 1000) ** 1.4;
  // PAINT WEAR IS A LINEAR MULTIPLIER ON THE PAINT (round 5).
  //
  // Round 4 interpolated between markingWhite and a "worn" tone that was
  // itself the road tint brightened by 2%, so the whole ramp from fresh to
  // scrubbed-out spanned 13% of linear luminance: every stripe of every
  // crossing in the city was the same value to within a couple of code
  // points, and card 01 measured eight stripes inside a 0.9% spread. A stripe
  // that has been driven over for four years reflects a QUARTER of what a
  // stripe repainted last month reflects, so the ramp is now a ratio with a
  // floor at STREET_WEAR_MULTIPLIERS.paintWorn.
  const paintFloor = STREET_WEAR_MULTIPLIERS.paintWorn;
  const paintTone = (age, track) => mulLinear(
    fresh, clamp(1 - 0.52 * age - 0.42 * track, paintFloor, 1),
  );
  const crossings = junctionEarnsCrossings(node);
  const width = crossingWidthFor(node);
  const ladder = node.maxClassRank >= 5;

  for (const approach of node.approaches) {
    const half = approach.half;
    const u = approach.u;
    const m = perpCCW(u);
    const pos = node.position;
    // JUNCTION PAINT FOLLOWS THE CENTRELINE, NOT A RAY (round 3). See the
    // matching note in street-surface-v2's `emitApproachPaint`. This pass has
    // the worse case of the two: a lane arrow sits 14-25 m back from the node,
    // so on a bending approach a straight extrapolation drifts by metres and
    // stamps a carriageway arrow onto the footway. The arrow is now laid on
    // the approach's own station frame. `v` is measured on the approach axis,
    // so it flips sign at an end approach, where `u` is the reversed tangent.
    const segment = approach.segment;
    const lateralSign = approach.atStart ? 1 : -1;
    const straightAt = (d, v) => ({ x: pos.x + u.x * d + m.x * v, z: pos.z + u.z * d + m.z * v });
    const at = (d, v) => {
      if (!segment || !Number.isFinite(segment.length)) return straightAt(d, v);
      const station = approach.atStart ? d : segment.length - d;
      const frame = streetStationAt(segment, station, true);
      const lat = v * lateralSign;
      return { x: frame.x + frame.nx * lat * frame.miter, z: frame.z + frame.nz * lat * frame.miter };
    };
    const yAt = (p, v) => carriagewaySurfaceY(state.datum(p.x, p.z), v, half, o) + STREET_DETAIL_LIFTS.paint;
    const point = (d, v) => {
      const p = at(d, v);
      return { x: p.x, y: yAt(p, v), z: p.z };
    };
    const runAvailable = approach.runLength
      - (approach.atStart ? approach.segment.trimEnd : approach.segment.trimStart);
    const bandStart = approach.trim + o.crosswalkClearance;
    const bandEnd = bandStart + width;
    const rng = streetRandom(`${state.seedTag}:paint:${node.id}:${approach.segmentId}`);

    const drawCrossing = crossings && approach.classRank >= 3 && bandEnd + 0.4 <= runAvailable;
    if (drawCrossing) {
      const anchor = at((bandStart + bandEnd) / 2, 0);
      const emitted = emitItem(state, anchor.x, anchor.z, 'crossing', () => {
        const usable = Math.max(0, half * 2 - o.crosswalkEdgeInset * 2);
        if (ladder) {
          const pitch = STREET_DETAIL_MARKINGS.ladderStripePitch;
          const stripeWidth = STREET_DETAIL_MARKINGS.ladderStripeWidth;
          const stripes = Math.max(2, Math.floor(usable / pitch));
          for (let i = 0; i < stripes; i += 1) {
            const v = -half + o.crosswalkEdgeInset + (usable * (i + 0.5)) / stripes;
            const v0 = v - stripeWidth / 2;
            const v1 = v + stripeWidth / 2;
            // The bars of a continental crossing run PARALLEL to the traffic
            // that crosses them, so a wheel path lies along one bar and leaves
            // its neighbour alone. That comb - not noise - is what makes the
            // eight bars of a real crossing eight different values.
            const age = clamp(nodeWear * (0.72 + rng() * 0.5), 0, 1);
            const track = wheelTrackWeight(v, half, approach.lanes);
            pushFace(state.buffers.paint, [
              point(bandStart, v0), point(bandEnd, v0), point(bandEnd, v1), point(bandStart, v1),
            ], paintTone(age, track), UP);
          }
        } else {
          const lineWidth = STREET_DETAIL_MARKINGS.transverseLineWidth;
          const v0 = -half + o.crosswalkEdgeInset;
          const v1 = half - o.crosswalkEdgeInset;
          for (const d of [bandStart + lineWidth / 2, bandEnd - lineWidth / 2]) {
            // A transverse pair is crossed by every wheel on the approach, so
            // it takes an averaged scrub rather than the comb.
            const color = paintTone(clamp(nodeWear * (0.8 + rng() * 0.4), 0, 1), 0.5);
            pushFace(state.buffers.paint, [
              point(d - lineWidth / 2, v0), point(d + lineWidth / 2, v0),
              point(d + lineWidth / 2, v1), point(d - lineWidth / 2, v1),
            ], color, UP);
          }
        }
      });
      if (emitted > 0) {
        state.records.crossings.push({
          nodeId: node.id,
          intersectionId: node.raw?.intersection?.id ?? null,
          signalId: node.signalId,
          signalised: node.signalised,
          inferred: node.inferred,
          degree: node.degree,
          segmentId: approach.segmentId,
          style: ladder ? 'ladder' : 'transverse',
          width,
          bandStart,
          bandEnd,
          roadWidth: half * 2,
          x: anchor.x,
          z: anchor.z,
        });
      }
    }

    // Stop bar. It sits behind the crossing when there is one, and at the same
    // station a crossing would have used when there is not, so a stopped
    // vehicle never blocks the crossing.
    //
    // A signalised node is the surface builder's: it has already painted both
    // the zebra band and the stop bar there, so this pass paints neither and
    // only needs to know WHERE that paint ends, so its lane arrows land behind
    // it instead of on top of it.
    const stops = !node.signalised && approachStops(node, approach);
    const paintedBandEnd = node.signalised
      ? approach.trim + o.crosswalkClearance + o.crosswalkBandDepth
      : drawCrossing ? bandEnd : approach.trim + o.crosswalkClearance;
    const barStart = paintedBandEnd + o.stopBarClearance;
    const barDepth = clamp(STREET_DETAIL_MARKINGS.stopBarDepth,
      STREET_DETAIL_MARKINGS.stopBarMin, STREET_DETAIL_MARKINGS.stopBarMax);
    const barEnd = barStart + (node.signalised ? o.stopBarDepth : barDepth);
    const drawStopBar = stops && barEnd + 0.3 <= runAvailable;
    if (drawStopBar) {
      const anchor = at((barStart + barEnd) / 2, 0);
      const emitted = emitItem(state, anchor.x, anchor.z, 'stopBar', () => {
        // The stopping half is -m, matching street-surface-v2's driving-side
        // convention; a one-way approach stops across its whole width.
        const vLo = -half + o.stopBarEdgeInset;
        const vHi = approach.oneway ? half - o.stopBarEdgeInset : 0;
        const color = paintTone(clamp(nodeWear * 0.9, 0, 1), 0.35);
        pushFace(state.buffers.paint, [
          point(barStart, vLo), point(barEnd, vLo), point(barEnd, vHi), point(barStart, vHi),
        ], color, UP);
      });
      if (emitted > 0) {
        state.records.stopBars.push({
          nodeId: node.id,
          intersectionId: node.raw?.intersection?.id ?? null,
          signalised: node.signalised,
          segmentId: approach.segmentId,
          depth: barDepth,
          barStart,
          barEnd,
          behindCrossing: drawCrossing,
          oneway: approach.oneway,
          x: anchor.x,
          z: anchor.z,
        });
      }
    }

    // Lane-assignment arrows, only where the approach is a collector or better
    // and there is room behind the stop line for a full arrow.
    if (approach.classRank < 4 || !approach.flowsToward) continue;
    const assignment = laneAssignment(node, approach);
    // Behind whatever stop line exists here, whether this pass painted it or
    // the surface builder did.
    const stopLineEnd = drawStopBar || node.signalised ? barEnd : barStart;
    const firstTail = stopLineEnd + 1.8 + STREET_DETAIL_MARKINGS.arrowLength;
    for (const lane of assignment) {
      if (lane.width < 2.2) { reject(state, 'laneArrow', 'lane-too-narrow'); continue; }
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const dTail = firstTail + repeat * 11;
        if (dTail + 0.5 > runAvailable) { reject(state, 'laneArrow', 'no-room'); continue; }
        const anchor = at(dTail, lane.centre);
        const emitted = emitItem(state, anchor.x, anchor.z, 'laneArrow', () => {
          // An arrow is painted in the middle of a lane, between the two wheel
          // paths, so it is the last mark on the road to be scrubbed away.
          const color = paintTone(clamp(nodeWear * (0.6 + rng() * 0.5), 0, 1), 0.12);
          for (const shape of arrowShapes(lane.movement, dTail, lane.centre, half)) {
            pushFace(state.buffers.paint, shape.map((s) => point(s.d, s.v)), color, UP);
          }
        });
        if (emitted > 0) {
          // The measured lateral extent of the arrow that was actually
          // emitted, so a verifier asserts what is on the road rather than
          // re-deriving it from the movement name.
          let maxLateral = 0;
          for (const shape of arrowShapes(lane.movement, dTail, lane.centre, half)) {
            for (const s of shape) maxLateral = Math.max(maxLateral, Math.abs(s.v));
          }
          state.records.laneArrows.push({
            nodeId: node.id,
            segmentId: approach.segmentId,
            movement: lane.movement,
            lane: lane.lane,
            laneWidth: lane.width,
            centre: lane.centre,
            half,
            maxLateral,
            dTail,
            x: anchor.x,
            z: anchor.z,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. construction detail: drainage, covers, patching, wear
// ---------------------------------------------------------------------------

/** Which sides of an approach carry a curb, and therefore a gutter to drain. */
function curbedSides(approach, o) {
  const sides = [];
  if (approach.walkCCW >= o.minSidewalkWidth) sides.push(1);
  if (approach.walkCW >= o.minSidewalkWidth) sides.push(-1);
  return sides;
}

/**
 * A curb inlet: the grate in the gutter pan plus the throat cut into the curb
 * face above it. Emitted in a frame given by an origin, a forward unit vector
 * and the lateral sign of the curb it drains.
 */
function emitInlet(state, origin, u, half, side, tag) {
  const o = state.o;
  const m = perpCCW(u);
  const grateLength = 0.95;
  const outer = half - 0.03;
  const inner = half - 0.44;
  const at = (d, v) => ({ x: origin.x + u.x * d + m.x * v * side, z: origin.z + u.z * d + m.z * v * side });
  const point = (d, v) => {
    const p = at(d, v);
    return {
      x: p.x,
      y: carriagewaySurfaceY(state.datum(p.x, p.z), v * side, half, o) + STREET_DETAIL_LIFTS.cover,
      z: p.z,
    };
  };
  const anchor = at(0, (inner + outer) / 2);
  const emitted = emitItem(state, anchor.x, anchor.z, tag, () => {
    const frame = hexToSrgb(PALETTE.coverIron);
    const slot = hexToSrgb(PALETTE.grate);
    pushFace(state.buffers.metal, [
      point(-grateLength / 2, inner), point(grateLength / 2, inner),
      point(grateLength / 2, outer), point(-grateLength / 2, outer),
    ], frame, UP);
    // Five slots running with the gutter, which is how a curb inlet is cast.
    for (let i = 0; i < 5; i += 1) {
      const v0 = inner + 0.06 + ((outer - inner - 0.12) * i) / 5;
      const v1 = v0 + (outer - inner - 0.12) / 5 * 0.55;
      pushFace(state.buffers.metal, [
        point(-grateLength / 2 + 0.07, v0), point(grateLength / 2 - 0.07, v0),
        point(grateLength / 2 - 0.07, v1), point(-grateLength / 2 + 0.07, v1),
      ], slot, UP);
    }
    // The throat in the curb face above the pan.
    const invert = (x, z) => state.datum(x, z) - o.gutterDepth;
    const face = { x: -m.x * side, y: 0, z: -m.z * side };
    const a = at(-grateLength / 2, half);
    const b = at(grateLength / 2, half);
    const throat = Math.min(0.085, o.curbFaceHeight - 0.01);
    pushFace(state.buffers.metal, [
      { x: a.x, y: invert(a.x, a.z) + 0.004, z: a.z },
      { x: b.x, y: invert(b.x, b.z) + 0.004, z: b.z },
      { x: b.x, y: invert(b.x, b.z) + throat, z: b.z },
      { x: a.x, y: invert(a.x, a.z) + throat, z: a.z },
    ], slot, face);
  });
  if (emitted > 0) {
    state.records.inlets.push({
      x: anchor.x, z: anchor.z, side, half, gutterLateral: (inner + outer) / 2, source: state.source?.id ?? null,
    });
  }
  return emitted;
}

function emitNodeDrainage(state, node) {
  const o = state.o;
  for (const approach of node.approaches) {
    const u = approach.u;
    const d = approach.trim + 1.5;
    const runAvailable = approach.runLength
      - (approach.atStart ? approach.segment.trimEnd : approach.segment.trimStart);
    if (d + 1.2 > runAvailable) { reject(state, 'inlet', 'no-room'); continue; }
    const origin = {
      x: node.position.x + u.x * d,
      z: node.position.z + u.z * d,
    };
    for (const side of curbedSides(approach, o)) {
      emitInlet(state, origin, u, approach.half, side, 'inlet');
    }
  }
}

/**
 * Mid-block drainage. A long block gets an inlet pair where the road is
 * actually lowest, found by sampling the same height field the surface is
 * built on - not at an arbitrary fraction of the block.
 */
function emitMidBlockDrainage(state, segment) {
  const o = state.o;
  const s0 = segment.trimStart + 6;
  const s1 = segment.length - segment.trimEnd - 6;
  if (s1 - s0 < 78) { reject(state, 'inlet', 'block-too-short'); return; }
  let bestS = s0;
  let bestY = Infinity;
  const samples = Math.min(48, Math.max(8, Math.round((s1 - s0) / 4)));
  for (let i = 0; i <= samples; i += 1) {
    const s = s0 + ((s1 - s0) * i) / samples;
    const st = streetStationAt(segment, s, false);
    const y = state.datum(st.x, st.z);
    if (y < bestY) { bestY = y; bestS = s; }
  }
  const st = streetStationAt(segment, bestS, false);
  const u = { x: st.tx, z: st.tz };
  for (const side of [1, -1]) {
    const walk = side > 0 ? segment.walks.left : segment.walks.right;
    if (!(walk >= o.minSidewalkWidth)) continue;
    emitInlet(state, { x: st.x, z: st.z }, u, segment.half, side, 'inlet');
  }
}

/** Round utility cover, drawn as a low-sided disc with a lighter rim. */
function emitRoundCover(state, x, z, radius, lateral, half, onFootway, tag) {
  const o = state.o;
  const datum = state.datum(x, z);
  const y = (onFootway
    ? sidewalkSurfaceY(datum, lateral, half, o)
    : carriagewaySurfaceY(datum, lateral, half, o)) + STREET_DETAIL_LIFTS.cover;
  const phase = (streetHash32(`${state.seedTag}:${tag}:${Math.round(x * 10)}:${Math.round(z * 10)}`) % 360) * Math.PI / 180;
  return emitItem(state, x, z, tag, () => {
    pushFace(state.buffers.metal, discPoints(x, z, radius, 12, y, phase),
      hexToSrgb(PALETTE.coverIronLight), UP);
    pushFace(state.buffers.metal, discPoints(x, z, radius * 0.78, 12, y + 0.001, phase),
      hexToSrgb(PALETTE.coverIron), UP);
  });
}

/** Rectangular utility plate, aligned to the street it sits on. */
function emitPlateCover(state, station, lateral, half, length, width, onFootway, colorHex, tag) {
  const o = state.o;
  const nx = station.nx * station.miter;
  const nz = station.nz * station.miter;
  const corner = (ds, dv) => {
    const x = station.x + station.tx * ds + nx * (lateral + dv);
    const z = station.z + station.tz * ds + nz * (lateral + dv);
    const datum = state.datum(x, z);
    const y = (onFootway
      ? sidewalkSurfaceY(datum, lateral + dv, half, o)
      : carriagewaySurfaceY(datum, lateral + dv, half, o)) + STREET_DETAIL_LIFTS.cover;
    return { x, y, z };
  };
  const cx = station.x + nx * lateral;
  const cz = station.z + nz * lateral;
  return emitItem(state, cx, cz, tag, () => {
    pushFace(state.buffers.metal, [
      corner(-length / 2, -width / 2), corner(length / 2, -width / 2),
      corner(length / 2, width / 2), corner(-length / 2, width / 2),
    ], hexToSrgb(colorHex), UP);
  });
}

/**
 * Covers along one segment. Spacing is the real thing: sanitary manholes every
 * 30-70 m near the crown, valve and vault covers clustered toward the gutter,
 * and small service boxes on the footway.
 */
function emitCovers(state, segment) {
  const o = state.o;
  const rng = streetRandom(`${state.seedTag}:covers:${segment.id}`);
  const s0 = segment.trimStart + 4;
  const s1 = segment.length - segment.trimEnd - 4;
  if (s1 <= s0) { reject(state, 'cover', 'no-run'); return; }
  let s = s0 + rng() * 18;
  while (s < s1) {
    const station = streetStationAt(segment, s, false);
    const roll = rng();
    if (roll < 0.45) {
      const lateral = (rng() - 0.5) * segment.half * 0.7;
      const x = station.x + station.nx * station.miter * lateral;
      const z = station.z + station.nz * station.miter * lateral;
      emitRoundCover(state, x, z, 0.33, lateral, segment.half, false, 'cover');
    } else if (roll < 0.72) {
      const side = rng() < 0.5 ? 1 : -1;
      const lateral = side * (segment.half - o.gutterWidth - 0.35 - rng() * 0.6);
      const x = station.x + station.nx * station.miter * lateral;
      const z = station.z + station.nz * station.miter * lateral;
      emitRoundCover(state, x, z, 0.13, lateral, segment.half, false, 'cover');
    } else {
      const side = rng() < 0.5 ? 1 : -1;
      const lateral = side * (segment.half - o.gutterWidth * 0.5 - rng() * 1.2);
      emitPlateCover(state, station, lateral, segment.half, 0.62, 0.44, false,
        PALETTE.coverIron, 'cover');
    }
    // Footway service boxes: water, gas, telecom, all on the curb third.
    if (rng() < 0.5) {
      const side = rng() < 0.5 ? 1 : -1;
      const band = sidewalkBand(segment, side, o);
      if (band) {
        const lateral = side * (band.inner + 0.25 + rng() * Math.max(0.05, band.usable * 0.35));
        emitPlateCover(state, station, lateral, segment.half,
          0.4 + rng() * 0.25, 0.3 + rng() * 0.2, true,
          rng() < 0.5 ? PALETTE.coverConcrete : PALETTE.coverIron, 'sidewalkCover');
      }
    }
    s += 26 + rng() * 42;
  }
}

/** A thin ribbon of quads along the segment at a fixed lateral offset. */
function ribbon(state, segment, s0, s1, lateral, width, color, buffer, lift, step, onFootway) {
  const o = state.o;
  const spans = Math.max(1, Math.ceil((s1 - s0) / step));
  const pointAt = (s, v) => {
    const st = streetStationAt(segment, s, false);
    const x = st.x + st.nx * st.miter * v;
    const z = st.z + st.nz * st.miter * v;
    const datum = state.datum(x, z);
    const y = (onFootway
      ? sidewalkSurfaceY(datum, v, segment.half, o)
      : carriagewaySurfaceY(datum, v, segment.half, o)) + lift;
    return { x, y, z };
  };
  for (let i = 0; i < spans; i += 1) {
    const a = s0 + ((s1 - s0) * i) / spans;
    const b = s0 + ((s1 - s0) * (i + 1)) / spans;
    pushFace(buffer, [
      pointAt(a, lateral - width / 2), pointAt(b, lateral - width / 2),
      pointAt(b, lateral + width / 2), pointAt(a, lateral + width / 2),
    ], color, UP);
  }
}

/**
 * Asphalt wear that follows the way a road is actually built and used:
 * a cold joint on every lane line (that is where two paving passes meet),
 * polished wheel paths either side of each lane centre, a grimy gutter, tar
 * crack chains that follow those same stress lines, and trench patches with
 * sealed edges.
 */
function emitAsphaltWear(state, segment) {
  const o = state.o;
  const s0 = segment.trimStart + 1.5;
  const s1 = segment.length - segment.trimEnd - 1.5;
  if (s1 - s0 < 3) { reject(state, 'patch', 'no-run'); return; }
  const mid = streetStationAt(segment, (s0 + s1) / 2, false);
  const rng = streetRandom(`${state.seedTag}:wear:${segment.id}`);
  const tones = wearTones(o, segment.className);
  const half = segment.half;
  const lanes = Math.max(1, segment.lanes);
  const laneWidth = (half * 2) / lanes;

  // Gutter grime, both sides, all rings: it is the cheapest thing here and it
  // is what stops the carriageway edge reading as a clean printed strip.
  for (const side of [1, -1]) {
    const lateral = side * (half - o.gutterWidth * 0.45);
    emitItem(state, mid.x + mid.nx * lateral, mid.z + mid.nz * lateral, 'gutterGrime', () => {
      ribbon(state, segment, s0, s1, lateral, o.gutterWidth * 0.8,
        tones.gutterGrime, state.buffers.wear, STREET_DETAIL_LIFTS.wear, 22, false);
    });
  }

  // Longitudinal cold joints on the lane lines.
  for (let k = 1; k < lanes; k += 1) {
    const lateral = -half + laneWidth * k;
    emitItem(state, mid.x + mid.nx * lateral, mid.z + mid.nz * lateral, 'coldJoint', () => {
      ribbon(state, segment, s0, s1, lateral, 0.07,
        tones.tar, state.buffers.wear, STREET_DETAIL_LIFTS.crack, 26, false);
    });
  }

  // Polished wheel paths, two per lane at the real track width.
  for (let k = 0; k < lanes; k += 1) {
    const centre = -half + laneWidth * (k + 0.5);
    for (const track of [-0.82, 0.82]) {
      const lateral = centre + track;
      if (Math.abs(lateral) > half - 0.25) continue;
      emitItem(state, mid.x + mid.nx * lateral, mid.z + mid.nz * lateral, 'wheelPath', () => {
        ribbon(state, segment, s0, s1, lateral, 0.34,
          tones.wheelPolish, state.buffers.wear, STREET_DETAIL_LIFTS.wear, 18, false);
      });
    }
  }

  // Tar crack chains. They follow the stress lines that already exist - the
  // gutter lip and the lane joints - and wander a few centimetres, rather than
  // being scattered noise.
  const crackLines = [half - o.gutterWidth, -(half - o.gutterWidth)];
  for (let k = 1; k < lanes; k += 1) crackLines.push(-half + laneWidth * k);
  for (const line of crackLines) {
    if (rng() > 0.55) continue;
    const runLength = 6 + rng() * 22;
    const start = s0 + rng() * Math.max(0.001, (s1 - s0) - runLength);
    if (start + runLength > s1) continue;
    const steps = Math.max(3, Math.round(runLength / 3.5));
    const anchorStation = streetStationAt(segment, start + runLength / 2, false);
    emitItem(state,
      anchorStation.x + anchorStation.nx * line,
      anchorStation.z + anchorStation.nz * line, 'crack', () => {
        let lateral = line + (rng() - 0.5) * 0.2;
        for (let i = 0; i < steps; i += 1) {
          const a = start + (runLength * i) / steps;
          const b = start + (runLength * (i + 1)) / steps;
          const nextLateral = clamp(lateral + (rng() - 0.5) * 0.32, -half + 0.2, half - 0.2);
          const pointAt = (s, v) => {
            const st = streetStationAt(segment, s, false);
            const x = st.x + st.nx * st.miter * v;
            const z = st.z + st.nz * st.miter * v;
            return {
              x,
              y: carriagewaySurfaceY(state.datum(x, z), v, half, o) + STREET_DETAIL_LIFTS.crack,
              z,
            };
          };
          const w = 0.05 + rng() * 0.05;
          pushFace(state.buffers.wear, [
            pointAt(a, lateral - w), pointAt(b, nextLateral - w),
            pointAt(b, nextLateral + w), pointAt(a, lateral + w),
          ], tones.tar, UP);
          lateral = nextLateral;
        }
      });
  }

  // Trench patches. A utility cut is either a transverse trench across the
  // lanes or a longitudinal one down a lane, and both are sealed at the edge.
  const patches = Math.min(3, Math.floor(rng() * 3.4));
  for (let i = 0; i < patches; i += 1) {
    const transverse = rng() < 0.55;
    const along = transverse ? 1.1 + rng() * 1.6 : 3 + rng() * 8;
    const across = transverse ? half * (0.7 + rng() * 1.3) : 1.4 + rng() * 1.4;
    const s = s0 + rng() * Math.max(0.001, (s1 - s0) - along);
    if (s + along > s1) continue;
    const lateral = clamp((rng() - 0.5) * (half * 2 - across), -half + across / 2, half - across / 2);
    const station = streetStationAt(segment, s + along / 2, false);
    const cx = station.x + station.nx * station.miter * lateral;
    const cz = station.z + station.nz * station.miter * lateral;
    const dark = rng() < 0.6;
    emitItem(state, cx, cz, 'patch', () => {
      const color = dark ? tones.patchDark : tones.patchLight;
      const pointAt = (ds, dv) => {
        const st = streetStationAt(segment, clamp(s + along / 2 + ds, 0, segment.length), false);
        const v = lateral + dv;
        const x = st.x + st.nx * st.miter * v;
        const z = st.z + st.nz * st.miter * v;
        return { x, y: carriagewaySurfaceY(state.datum(x, z), v, half, o) + STREET_DETAIL_LIFTS.wear, z };
      };
      pushFace(state.buffers.wear, [
        pointAt(-along / 2, -across / 2), pointAt(along / 2, -across / 2),
        pointAt(along / 2, across / 2), pointAt(-along / 2, across / 2),
      ], color, UP);
      // Sealed edges: four tar strips, 8 cm wide, overlapping the patch.
      const tar = tones.tar;
      const seal = 0.08;
      for (const [a0, a1, v0, v1] of [
        [-along / 2 - seal, -along / 2 + seal, -across / 2 - seal, across / 2 + seal],
        [along / 2 - seal, along / 2 + seal, -across / 2 - seal, across / 2 + seal],
        [-along / 2, along / 2, -across / 2 - seal, -across / 2 + seal],
        [-along / 2, along / 2, across / 2 - seal, across / 2 + seal],
      ]) {
        pushFace(state.buffers.wear, [
          pointAt(a0, v0), pointAt(a1, v0), pointAt(a1, v1), pointAt(a0, v1),
        ], tar, UP);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 3. sidewalk truth: scored joints, stains, ramp pads, driveway aprons
// ---------------------------------------------------------------------------

/**
 * Panel length for one street, fixed per street so a whole block scores to the
 * same module the way a real pour does. Real city footway panels are
 * 1.2-1.8 m; this picks inside that range and never outside it.
 */
export function panelLengthFor(segment, seedTag = 'city') {
  const key = String(segment.streetId || segment.id);
  return 1.2 + ((streetHash32(`${seedTag}:panel:${key}`) % 7) / 10);
}

/**
 * A REAL SCORE JOINT, NOT A GREY LINE (round 5). READ THIS BEFORE EDITING.
 *
 * Round 4 drew every footway joint as one flat 22 mm quad, 14% darker than the
 * slab, lying at a constant lift above it. At any distance past about 4 m that
 * is a pencil line on paper: it has no shading term of its own, so it cannot
 * change with the sun, it produces no contact darkening, and it disappears
 * entirely in overcast light. A jointing tool leaves a groove with a radiused
 * shoulder either side, and what makes that groove legible in real light is
 * that the two facets face in DIFFERENT DIRECTIONS and the bottom of the
 * groove is occluded from most of the sky.
 *
 * So the joint is now two quads meeting at a depressed centre line, with real
 * per-facet normals and a darker tone at the bottom than at the shoulders.
 *
 * WHY THE GROOVE IS BUILT UPWARD FROM THE SURFACE, NOT CUT INTO IT. The
 * footway slab is a solid mesh with no groove in it, so a facet sunk below the
 * slab is behind it and gets depth-rejected in exactly the places the groove
 * would be visible. The shoulders therefore sit at `lift + depth` and the
 * centre line at `lift`, i.e. the whole groove is above the surface it scores
 * and only the RELIEF between shoulder and centre is real. That relief is what
 * the ambient-occlusion resolve in src/render/post-chain.js integrates, and it
 * is what the sun shades: geometrically it is a tooled lip standing 9 mm
 * proud, which is also what a jointing tool actually leaves behind.
 *
 * `walkPoint(s, v, lift)` supplies the CAMBERED footway height at (s, v), so
 * the groove follows the cross-fall of the walk instead of floating over it.
 */
export const STREET_JOINT_GROOVE = Object.freeze({
  panelHalfWidth: 0.013,     // 26 mm overall, the width of a tooled score joint
  expansionHalfWidth: 0.026, // 52 mm, a sealed expansion joint
  depth: 0.009,              // shoulder to groove bottom
});

/**
 * Emit one V-groove between two points on the footway, as two quads sharing a
 * depressed centre line. `at(s, v, lift)` must return a point on the surface
 * being scored. `axis` is 'along' (the groove runs along v, i.e. across the
 * walk) or 'across' (the groove runs along s, i.e. down the walk).
 */
function pushGroove(buffer, at, s, v0, v1, halfWidth, tones, axis) {
  const { depth } = STREET_JOINT_GROOVE;
  const lip = STREET_DETAIL_LIFTS.joint + depth;
  const floor = STREET_DETAIL_LIFTS.joint;
  const shoulder = tones.jointLip;
  const bottom = tones.jointDeep;
  // Facet normal: rises `depth` over `halfWidth`, tilted away from the centre.
  const run = Math.hypot(halfWidth, depth) || 1;
  const nUp = halfWidth / run;
  const nOut = depth / run;
  let faces = 0;
  for (const sign of [-1, 1]) {
    const outer = axis === 'along'
      ? [at(s + sign * halfWidth, v0, lip), at(s + sign * halfWidth, v1, lip)]
      : [at(v0, s + sign * halfWidth, lip), at(v1, s + sign * halfWidth, lip)];
    const inner = axis === 'along'
      ? [at(s, v0, floor), at(s, v1, floor)]
      : [at(v0, s, floor), at(v1, s, floor)];
    // The facet climbs from the groove floor out to the shoulder, so its
    // normal leans back INTO the groove. Taken from the emitted points rather
    // than from the axis argument, so it cannot be inverted by a sign
    // convention: an inverted pair reads as a raised ridge, not a groove.
    const ox = outer[0].x - inner[0].x;
    const oz = outer[0].z - inner[0].z;
    const ol = Math.hypot(ox, oz) || 1;
    const normal = { x: -(ox / ol) * nOut, y: nUp, z: -(oz / ol) * nOut };
    faces += pushFace(buffer, [outer[0], outer[1], inner[1], inner[0]],
      [shoulder, shoulder, bottom, bottom], normal);
  }
  return faces;
}

function emitSidewalkDetail(state, segment) {
  const o = state.o;
  const s0 = segment.trimStart + 0.4;
  const s1 = segment.length - segment.trimEnd - 0.4;
  if (s1 - s0 < 1.2) { reject(state, 'panelJoint', 'no-run'); return; }
  const panel = panelLengthFor(segment, state.seedTag);
  const tones = wearTones(o, segment.className);
  const rng = streetRandom(`${state.seedTag}:walk:${segment.id}`);

  for (const side of [1, -1]) {
    const band = sidewalkBand(segment, side, o);
    if (!band) { reject(state, 'panelJoint', 'no-footway'); continue; }
    const inner = side * band.inner;
    const outer = side * band.outer;
    const walkPoint = (s, v, lift) => {
      const st = streetStationAt(segment, clamp(s, 0, segment.length), false);
      const x = st.x + st.nx * st.miter * v;
      const z = st.z + st.nz * st.miter * v;
      return { x, y: sidewalkSurfaceY(state.datum(x, z), v, segment.half, o) + lift, z };
    };
    const stainAt = (s, v) => walkPoint(s, v, STREET_DETAIL_LIFTS.stain);
    // Scored transverse joints, with a wider expansion joint every sixth panel.
    const count = Math.floor((s1 - s0) / panel);
    for (let i = 1; i < count; i += 1) {
      const s = s0 + panel * i;
      const expansion = i % 6 === 0;
      const halfWidth = expansion
        ? STREET_JOINT_GROOVE.expansionHalfWidth
        : STREET_JOINT_GROOVE.panelHalfWidth;
      const st = streetStationAt(segment, s, false);
      const cx = st.x + st.nx * st.miter * ((inner + outer) / 2);
      const cz = st.z + st.nz * st.miter * ((inner + outer) / 2);
      emitItem(state, cx, cz, expansion ? 'expansionJoint' : 'panelJoint', () => {
        pushGroove(state.buffers.concrete, walkPoint, s, inner, outer, halfWidth, tones, 'along');
      });
    }
    // SCORED INTO SQUARES, NOT INTO STRIPS (round 5).
    //
    // Round 4 only scored a footway down its length when the usable band
    // reached 2.6 m, and the shipped San Francisco slice carries a 2.5 m
    // footway. Every walk in every card was therefore scored into transverse
    // STRIPS 1.2-1.8 m by 2.5 m - a 1:1.6 module that no city pours, because a
    // panel that long cracks down its own middle. A real walk is scored close
    // to square, so the number of longitudinal joints is whatever it takes to
    // bring the cell width back to about the panel length.
    const longCells = Math.max(1, Math.round(band.usable / panel));
    for (let j = 1; j < longCells; j += 1) {
      const lateral = side * (band.inner + (band.usable * j) / longCells);
      const st = streetStationAt(segment, (s0 + s1) / 2, false);
      emitItem(state, st.x + st.nx * lateral, st.z + st.nz * lateral, 'longJoint', () => {
        const spans = Math.max(1, Math.ceil((s1 - s0) / 6));
        for (let k = 0; k < spans; k += 1) {
          const a = s0 + ((s1 - s0) * k) / spans;
          const b = s0 + ((s1 - s0) * (k + 1)) / spans;
          pushGroove(state.buffers.concrete, walkPoint, lateral, a, b,
            STREET_JOINT_GROOVE.panelHalfWidth, tones, 'across');
        }
      });
    }
    // Staining: dark washes at the curb where water runs off, and at the
    // property line under downpipes and awnings.
    const stains = Math.floor((s1 - s0) / 14);
    for (let i = 0; i < stains; i += 1) {
      if (rng() > 0.55) continue;
      const s = s0 + ((s1 - s0) * (i + rng())) / Math.max(1, stains);
      if (s <= s0 || s >= s1) continue;
      const atCurb = rng() < 0.6;
      const lateral = side * (atCurb
        ? band.inner + 0.1 + rng() * 0.35
        : band.outer - 0.15 - rng() * 0.4);
      const along = 0.8 + rng() * 1.8;
      const across = 0.35 + rng() * 0.5;
      const st = streetStationAt(segment, s, false);
      const cx = st.x + st.nx * st.miter * lateral;
      const cz = st.z + st.nz * st.miter * lateral;
      emitItem(state, cx, cz, 'stain', () => {
        pushFace(state.buffers.concrete, [
          stainAt(s - along / 2, lateral - side * across / 2),
          stainAt(s + along / 2, lateral - side * across / 2),
          stainAt(s + along / 2, lateral + side * across / 2),
          stainAt(s - along / 2, lateral + side * across / 2),
        ], tones.stain, UP);
      });
    }
  }
}

/** A truncated dome, as a small four-sided cap on the pad. */
function pushDome(buffer, cx, cy, cz, halfSize, height, color, ax, az) {
  const bx = -az;
  const bz = ax;
  const corners = [
    { x: cx + (ax + bx) * halfSize, z: cz + (az + bz) * halfSize },
    { x: cx + (ax - bx) * halfSize, z: cz + (az - bz) * halfSize },
    { x: cx + (-ax - bx) * halfSize, z: cz + (-az - bz) * halfSize },
    { x: cx + (-ax + bx) * halfSize, z: cz + (-az + bz) * halfSize },
  ];
  const top = { x: cx, y: cy + height, z: cz };
  const capHalf = halfSize * 0.45;
  const capCorners = corners.map((c) => ({
    x: cx + (c.x - cx) * (capHalf / halfSize),
    y: top.y,
    z: cz + (c.z - cz) * (capHalf / halfSize),
  }));
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const ca = capCorners[i];
    const cb = capCorners[(i + 1) % 4];
    const mx = (a.x + b.x) / 2 - cx;
    const mz = (a.z + b.z) / 2 - cz;
    const len = Math.hypot(mx, mz) || 1;
    pushFace(buffer, [
      { x: a.x, y: cy, z: a.z }, { x: b.x, y: cy, z: b.z }, cb, ca,
    ], color, { x: (mx / len) * 0.75, y: 0.66, z: (mz / len) * 0.75 });
  }
  pushFace(buffer, capCorners, color, UP);
}

/**
 * Detectable-warning pads on the kerb ramps street-surface-v2 already cut.
 *
 * The ramp geometry is not re-derived: this walks the SAME corner path
 * stations and the SAME ramp angular window the curb ring used, so the pad
 * lands on the ramp rather than beside it.
 */
function emitRampPads(state, node) {
  const o = state.o;
  const rampReach = o.curbTopWidth + o.rampRun;
  const padDepth = 0.62;
  const padColor = hexToSrgb(streetHash32(`${state.seedTag}:pad:${node.id}`) % 2 === 0
    ? PALETTE.domePadYellow : PALETTE.domePadRed);
  const domeColor = hexToSrgb(PALETTE.domeCap);
  for (const path of node.paths || []) {
    const window = path.ramp;
    if (!window) { reject(state, 'rampPad', 'no-ramp'); continue; }
    const stations = path.stations || [];
    for (let i = 0; i < stations.length - 1; i += 1) {
      const a = stations[i];
      const b = stations[i + 1];
      if (a.ang === undefined || b.ang === undefined) continue;
      if (!(a.walk > rampReach + 0.05) || !(b.walk > rampReach + 0.05)) continue;
      const midAng = (a.ang + b.ang) / 2;
      if (!(midAng > window.lo - 1e-9 && midAng < window.hi + 1e-9)) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) < 1e-6) continue;
      const surfaceAt = (st, dist) => {
        const scaleFactor = Number.isFinite(st.scale) && st.scale > 0 ? st.scale : 1;
        const x = st.x + st.out.x * dist * scaleFactor;
        const z = st.z + st.out.z * dist * scaleFactor;
        const datum = state.datum(st.x, st.z);
        const invert = datum - o.gutterDepth + o.rampLift;
        const back = curbTopSurfaceY(datum, o) + o.curbTopFall
          + o.sidewalkCrossSlope * Math.max(0, rampReach - o.curbTopWidth);
        const t = clamp(dist / rampReach, 0, 1);
        return { x, y: invert + (back - invert) * t, z };
      };
      const anchor = surfaceAt(a, padDepth / 2);
      // The pad goes in the DOME buffer, not the concrete one (round 5). A
      // detectable-warning pad is a manufactured cast panel bolted onto the
      // ramp, not a modification of the concrete, and the concrete buffer now
      // multiplies its vertex colour by the footway albedo photograph. Safety
      // yellow multiplied by a concrete photograph is a dull ochre, which is
      // the one thing this element must never be. The pad and its domes are
      // one object, so they now share one buffer and one material - and the
      // dome material carries the same polygonOffset the pad had before.
      const emitted = emitItem(state, anchor.x, anchor.z, 'rampPad', () => {
        pushFace(state.buffers.dome, [
          surfaceAt(a, 0.05), surfaceAt(b, 0.05),
          surfaceAt(b, 0.05 + padDepth), surfaceAt(a, 0.05 + padDepth),
        ], padColor, UP);
      });
      if (emitted > 0) {
        state.records.rampPads.push({
          nodeId: node.id, x: anchor.x, y: anchor.y, z: anchor.z, depth: padDepth,
        });
      }
      const spanLength = Math.hypot(a.x - b.x, a.z - b.z);
      const alongCount = Math.max(1, Math.round(spanLength / 0.14));
      const acrossCount = Math.max(2, Math.round(padDepth / 0.14));
      emitItem(state, anchor.x, anchor.z, 'rampDome', () => {
        const ax = (b.x - a.x) / spanLength;
        const az = (b.z - a.z) / spanLength;
        for (let p = 0; p < alongCount; p += 1) {
          const t = (p + 0.5) / alongCount;
          const st = {
            x: a.x + (b.x - a.x) * t,
            z: a.z + (b.z - a.z) * t,
            out: { x: a.out.x + (b.out.x - a.out.x) * t, z: a.out.z + (b.out.z - a.out.z) * t },
            scale: a.scale,
          };
          for (let q = 0; q < acrossCount; q += 1) {
            const dist = 0.05 + (padDepth * (q + 0.5)) / acrossCount;
            const s = surfaceAt(st, dist);
            pushDome(state.buffers.dome, s.x, s.y + STREET_DETAIL_LIFTS.dome - 0.004, s.z,
              0.029, 0.021, domeColor, ax, az);
          }
        }
      });
    }
  }
}

/**
 * Driveway aprons. A service way that ends on another street's footway is a
 * driveway; the footway there is re-poured as a flared apron and the curb is
 * depressed. Both facts come from the street contract, not from a mesh.
 */
function emitDriveways(state, index) {
  const o = state.o;
  const tones = wearTones(o, 'default');
  const apron = tones.apron;
  const joint = tones.jointDeep;
  for (const segment of state.plan.segments) {
    if (segment.classRank > 2) continue;
    state.source = { kind: 'segment', id: segment.id };
    for (const end of [0, 1]) {
      if (end === 0 ? segment.nodeStart : segment.nodeEnd) continue;
      const p = end === 0 ? segment.points[0] : segment.points[segment.points.length - 1];
      const host = nearestHostBand(index, state, p, segment, end === 0 ? 0 : 1);
      if (!host) { reject(state, 'driveway', 'no-host-footway'); continue; }
      const width = clamp(segment.width + 1.4, 3, 7);
      const flare = 0.9;
      const band = host.band;
      const sign = host.side;
      const hostPoint = (s, v, lift) => {
        const st = streetStationAt(host.segment, clamp(s, 0, host.segment.length), false);
        const x = st.x + st.nx * st.miter * v;
        const z = st.z + st.nz * st.miter * v;
        return { x, y: sidewalkSurfaceY(state.datum(x, z), v, host.segment.half, o) + lift, z };
      };
      const pointAt = (s, v) => hostPoint(s, v, STREET_DETAIL_LIFTS.apron);
      const jointAt = (s, v) => hostPoint(s, v, STREET_DETAIL_LIFTS.joint);
      const s = host.station;
      const inner = sign * band.inner;
      const outer = sign * band.outer;
      emitItem(state, p.x, p.z, 'driveway', () => {
        pushFace(state.buffers.concrete, [
          pointAt(s - width / 2 - flare, inner), pointAt(s + width / 2 + flare, inner),
          pointAt(s + width / 2, outer), pointAt(s - width / 2, outer),
        ], apron, UP);
        // The two flare joints and the back joint, which is how an apron reads
        // from the footway even before the curb depression is visible.
        for (const [a, b, va, vb] of [
          [s - width / 2 - flare, s - width / 2, inner, outer],
          [s + width / 2 + flare, s + width / 2, inner, outer],
        ]) {
          pushFace(state.buffers.concrete, [
            jointAt(a - 0.02, va), jointAt(a + 0.02, va),
            jointAt(b + 0.02, vb), jointAt(b - 0.02, vb),
          ], joint, UP);
        }
      });
    }
  }
}

/** Uniform grid over the plan's host segments, for the driveway search. */
function buildHostIndex(plan) {
  const cell = 24;
  const map = new Map();
  for (const segment of plan.segments) {
    if (segment.classRank < 3) continue;
    const minX = Math.min(...segment.points.map((q) => q.x));
    const maxX = Math.max(...segment.points.map((q) => q.x));
    const minZ = Math.min(...segment.points.map((q) => q.z));
    const maxZ = Math.max(...segment.points.map((q) => q.z));
    for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
      for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
        const key = `${gx}|${gz}`;
        const bucket = map.get(key);
        if (bucket) bucket.push(segment); else map.set(key, [segment]);
      }
    }
  }
  return { cell, map };
}

/**
 * The street whose footway a driveway crosses.
 *
 * A source driveway's endpoint is authored either on the host's centreline
 * (the common OSM case, where the service way is drawn all the way into the
 * carriageway) or somewhere in its footway band, so the test is "does this
 * endpoint lie inside the host's paved corridor", not "is it exactly on the
 * footway". The apron is then placed on the footway band on the side the
 * driveway actually approaches from, and a driveway that runs PARALLEL to the
 * host - an alley beside it, not into it - is rejected outright.
 */
function nearestHostBand(index, state, p, driveway, endIndex) {
  const o = state.o;
  const gx = Math.floor(p.x / index.cell);
  const gz = Math.floor(p.z / index.cell);
  const points = driveway.points;
  const other = endIndex === 0 ? points[1] : points[points.length - 2];
  let dx = other.x - p.x;
  let dz = other.z - p.z;
  const dl = Math.hypot(dx, dz);
  if (!(dl > 1e-6)) return null;
  dx /= dl; dz /= dl;
  let best = null;
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      const bucket = index.map.get(`${gx + i}|${gz + j}`);
      if (!bucket) continue;
      for (const segment of bucket) {
        if (segment === driveway) continue;
        const hit = projectOnSegment(segment, p);
        if (!hit) continue;
        if (hit.station < segment.trimStart + 3 || hit.station > segment.length - segment.trimEnd - 3) continue;
        const outer = segment.half + Math.max(segment.walks.left, segment.walks.right);
        if (Math.abs(hit.lateral) > outer + 1.0) continue;
        // The driveway has to run INTO the host, not alongside it.
        const st = streetStationAt(segment, hit.station, false);
        if (Math.abs(dx * st.tx + dz * st.tz) > 0.62) continue;
        // The apron goes on the side the driveway comes from; when the
        // endpoint is authored on the centreline, that is the side the rest of
        // the driveway lies on.
        const lateralOfOther = (other.x - st.x) * st.nx + (other.z - st.z) * st.nz;
        const side = (Math.abs(hit.lateral) > segment.half * 0.4 ? hit.lateral : lateralOfOther) >= 0 ? 1 : -1;
        const band = sidewalkBand(segment, side, o);
        if (!band) continue;
        const score = hit.distance - segment.classRank * 0.35;
        if (!best || score < best.score) best = { segment, station: hit.station, side, band, score };
      }
    }
  }
  return best;
}

/** Arc-length station and signed lateral offset of `p` on a plan segment. */
function projectOnSegment(segment, p) {
  let best = null;
  for (let i = 0; i < segment.points.length - 1; i += 1) {
    const a = segment.points[i];
    const b = segment.points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-6)) continue;
    const ux = dx / len;
    const uz = dz / len;
    const t = clamp((p.x - a.x) * ux + (p.z - a.z) * uz, 0, len);
    const px = a.x + ux * t;
    const pz = a.z + uz * t;
    const distance = Math.hypot(p.x - px, p.z - pz);
    if (best && distance >= best.distance) continue;
    const lateral = (p.x - px) * -uz + (p.z - pz) * ux;
    best = { station: segment.cum[i] + t, lateral, distance };
  }
  return best;
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

/** Shortest distance from the build focus to a segment's centreline. */
function segmentReach(state, segment) {
  let best = Infinity;
  for (let i = 0; i < segment.points.length - 1; i += 1) {
    const a = segment.points[i];
    const b = segment.points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = 0;
    if (len2 > 1e-9) {
      t = clamp(((state.focus.x - a.x) * dx + (state.focus.z - a.z) * dz) / len2, 0, 1);
    }
    const d = Math.hypot(state.focus.x - (a.x + dx * t), state.focus.z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * `envClass` is a member of `MATERIAL_CLASSES` in src/render/environment-ibl.js
 * and it is REQUIRED on every lit material this pass creates. The renderer's
 * environment grading and the whole wet-weather response only reach materials
 * that declare one; a material without a class gets no environment map, no
 * `envMapIntensity` and no rain response, which is what left the road reading
 * dry in the round-2 drizzle card. The verifier asserts every spec here
 * declares a class the grader knows.
 */
const MATERIAL_SPECS = Object.freeze({
  paint: {
    roughness: 0.58, metalness: 0, offset: [-4, -8], renderOrder: 3,
    envClass: 'painted-metal', surface: 'paint', detailClass: null, bumpScale: 0.004,
  },
  wear: {
    roughness: 0.97, metalness: 0, offset: [-3, -6], renderOrder: 2,
    envClass: 'asphalt', surface: 'carriageway', detailClass: 'asphalt',
    normalScale: 0.9, aoMapIntensity: 0.55, bumpScale: 0.024,
  },
  metal: {
    roughness: 0.6, metalness: 0.55, offset: [-4, -8], renderOrder: 3,
    envClass: 'painted-metal', surface: null, detailClass: 'painted-concrete',
    normalScale: 0.7, aoMapIntensity: 0.5,
  },
  concrete: {
    roughness: 0.93, metalness: 0, offset: [-3, -6], renderOrder: 2,
    envClass: 'sidewalk', surface: 'concrete', detailClass: 'sidewalk-concrete',
    normalScale: 0.85, aoMapIntensity: 0.6, bumpScale: 0.014,
  },
  dome: {
    roughness: 0.66, metalness: 0.1, offset: [-3, -6], renderOrder: 2,
    envClass: 'painted-metal', surface: null, detailClass: null,
  },
});

/**
 * Mean of each detail class's baked roughness channel. three MULTIPLIES
 * `material.roughness` by the map, so a call site that wants a measured
 * roughness has to divide it out first. Mirrors DETAIL_ROUGHNESS_MEAN in
 * src/citygen/renderer.js, which this pass may not import.
 */
const DETAIL_ROUGHNESS_MEAN = Object.freeze({
  asphalt: 0.925,
  'sidewalk-concrete': 0.875,
  'painted-concrete': 0.685,
});

/** Detail-map bake settings. Resolution is the renderer's, per class. */
const DETAIL_RESOLUTION = 256;

/** Fallback UV tiles, used only when the context exposes no surface options. */
const SURFACE_UV_METRES = STREET_SURFACE_V2_DEFAULTS.uvMetersPerRepeat;

/**
 * UV tile for the two buffers that carry no albedo (covers, tactile domes).
 * A manhole cover is 0.6 m across, so a 6.5 m detail tile would put one texel
 * of relief on it; 0.6 m puts a whole tile on it.
 */
const HARDWARE_UV_METRES = 0.6;

/**
 * The albedo maps this pass's decals must share with the surface they lie on,
 * and how many world metres one repeat of each covers.
 *
 * `ctx.streetSurfaceOptions` is the EXACT options object the renderer handed
 * street-surface-v2, so `maps` here is the same THREE.Texture instance the
 * carriageway and footway are rendering with, at the same `repeat` (1) and the
 * same wrapping. No clone, no second upload, no extra texture bytes: the pass
 * adds 65 536 bytes of paint tile and nothing else.
 */
export function streetDetailSurfaceMaps(ctx) {
  const options = ctx?.streetSurfaceOptions || null;
  const maps = options?.maps || {};
  const uv = options?.uvMetersPerRepeat || SURFACE_UV_METRES;
  return {
    carriageway: maps.carriageway || null,
    concrete: maps.concrete || null,
    paint: maps.paint === null ? null : (maps.paint || getPaintMapTexture()),
    uvMetersPerRepeat: {
      carriageway: uv.carriageway || SURFACE_UV_METRES.carriageway,
      concrete: uv.concrete || SURFACE_UV_METRES.concrete,
      marking: uv.marking || SURFACE_UV_METRES.marking,
    },
  };
}

/**
 * One material per buffer. Created ONCE per city and reused across every LOD
 * re-centre, because the renderer caches its environment-grading buckets from
 * a single traverse taken after the passes are built: a material that first
 * appeared during a refresh would never be handed an environment map and would
 * render unlit for the rest of the session. Same reason facade-articulation
 * builds its material set up front.
 */
export function createStreetDetailMaterials(surfaceMaps = null) {
  const maps = surfaceMaps || { carriageway: null, concrete: null, paint: null,
    uvMetersPerRepeat: SURFACE_UV_METRES };
  const uv = maps.uvMetersPerRepeat || SURFACE_UV_METRES;
  const materials = {};
  for (const [name, spec] of Object.entries(MATERIAL_SPECS)) {
    const albedo = spec.surface ? maps[spec.surface] || null : null;
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: spec.roughness,
      metalness: spec.metalness,
      ...(albedo ? { map: albedo, bumpMap: albedo, bumpScale: spec.bumpScale ?? 0.01 } : {}),
      ...(spec.offset
        ? { polygonOffset: true, polygonOffsetFactor: spec.offset[0], polygonOffsetUnits: spec.offset[1] }
        : {}),
    });
    // Micro-relief. Without a normal / roughness / AO map a decal is a flat
    // painted card that cannot catch a grazing sun or a wet-street reflection,
    // which is what made the whole pass read as printed vinyl in round 4. The
    // tile is the SAME size the surface underneath uses, so the relief is
    // continuous across the decal edge rather than restarting at it.
    if (spec.detailClass) {
      const tileMetres = spec.surface
        ? (uv[spec.surface] || SURFACE_UV_METRES[spec.surface] || 1)
        : HARDWARE_UV_METRES;
      const perMetre = uvScalePerMetre(spec.detailClass);
      const repeat = { x: tileMetres * perMetre.x, y: tileMetres * perMetre.y };
      const mean = DETAIL_ROUGHNESS_MEAN[spec.detailClass] || 1;
      try {
        applyDetailMaps(material, spec.detailClass, {
          resolution: DETAIL_RESOLUTION,
          repeat,
          useMetalnessMap: false,
          normalScale: spec.normalScale ?? 0.8,
          aoMapIntensity: spec.aoMapIntensity ?? 0.5,
          roughnessScale: clamp(spec.roughness / mean, 0, 1),
        });
        material.metalness = spec.metalness;
      } catch {
        // A detail bake is an enhancement, never a reason to lose the decal.
        material.roughness = spec.roughness;
      }
    }
    material.userData = { envClass: spec.envClass, surface: spec.surface || null };
    material.name = `${STREET_DETAIL_ID}:${name}`;
    materials[name] = material;
  }
  return materials;
}

export function disposeStreetDetailMaterials(materials) {
  if (!materials) return;
  for (const material of Object.values(materials)) material?.dispose?.();
}

function buildMeshes(state, group, materials) {
  const meshes = [];
  for (const [name, buffer] of Object.entries(state.buffers)) {
    if (buffer.triangles === 0) continue;
    const spec = MATERIAL_SPECS[name];
    const material = materials[name];
    const mesh = new THREE.Mesh(bufferToGeometry(buffer), material);
    mesh.name = `${STREET_DETAIL_ID}:${name}`;
    mesh.renderOrder = spec.renderOrder;
    // Every surface here is a thin decal on ground the surface builder already
    // shadows. Casting from it produces acne, not contact.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData = { kind: 'road-markings', pass: STREET_DETAIL_ID, layer: name };
    group.add(mesh);
    meshes.push({ name, triangles: buffer.triangles, drawCalls: 1 });
  }
  return meshes;
}

// ---------------------------------------------------------------------------
// ground carpet dressing
// ---------------------------------------------------------------------------

/**
 * The identity `src/world/ground-coverage.js` stamps on the carpet material.
 * Kept as a literal rather than an import so this pass never depends on the
 * world module's build succeeding; a missing carpet is simply not dressed.
 */
export const GROUND_CARPET_MATERIAL = Object.freeze({
  source: 'ground-coverage-v1',
  layer: 'ground-carpet',
});

/**
 * Detail-map settings for the carpet. Deliberately weaker than the footway's:
 * this is open ground seen at a grazing angle, so it wants a low-frequency
 * roughness break-up and a shallow normal, not sidewalk relief.
 */
export const GROUND_DETAIL = Object.freeze({
  // Metres of world per detail-map repeat. Coarser than the footway's 2.6 m
  // tile because the carpet is yard, alley and open land, not slabs.
  metresPerRepeat: 6.5,
  normalScale: 0.55,
  aoMapIntensity: 0.45,
  roughness: 0.97,
  resolution: 256,
});

/**
 * Give the ground carpet the same class of surface response the paved surface
 * has.
 *
 * WHY THIS LIVES HERE. `src/world/ground-coverage.js` is a world module and
 * must not import a render module, and the renderer deliberately does not hand
 * the carpet an albedo texture (its SF ground textures load lazily, so passing
 * them at build time would texture the carpet on a rebuild and leave it bare
 * on the first build - one city rendering two ways). The result measured in
 * the round-2 capture was the only large surface in the world with no map of
 * any kind: mean luma 209.6 in `01-street-day` against a footway at 184.5,
 * Otsu separation 14.3 over a region that contains a surface boundary, and
 * 16.5% of `03-canyon-golden` with nothing else under the camera at all.
 *
 * Normal / roughness / AO are DATA maps, not albedo, so they are stable
 * whatever the lazy albedo load does, and applying them here is idempotent:
 * the material records `detailApplied` and a second build skips it.
 *
 * @returns {{applied: boolean, reason?: string, class?: string, repeat?: object}}
 */
export function dressGroundCarpet(ctx) {
  const root = ctx?.root;
  if (!root || typeof root.getObjectByName !== 'function') {
    return { applied: false, reason: 'no-root' };
  }
  const group = root.getObjectByName(GROUND_CARPET_MATERIAL.source);
  if (!group) return { applied: false, reason: 'no-carpet' };
  let material = null;
  let mesh = null;
  group.traverse((node) => {
    if (material) return;
    const candidate = Array.isArray(node.material) ? node.material[0] : node.material;
    if (!candidate) return;
    const identity = candidate.userData || {};
    if (identity.source === GROUND_CARPET_MATERIAL.source
      && identity.layer === GROUND_CARPET_MATERIAL.layer) {
      material = candidate;
      mesh = node;
    }
  });
  if (!material) return { applied: false, reason: 'no-declared-material' };
  if (material.userData.detailApplied) {
    return { applied: false, reason: 'already-dressed', class: material.userData.detailClass };
  }
  if (!mesh?.geometry?.getAttribute?.('uv')) {
    return { applied: false, reason: 'no-uv' };
  }
  const className = material.userData.detailClass || 'sidewalk-concrete';
  const metres = Number(material.userData.uvMetersPerRepeat) || 8;
  // The carpet bakes world-XZ UVs as x / `uvMetersPerRepeat`, so a UV unit is
  // `metres` of world. To land one detail tile every
  // GROUND_DETAIL.metresPerRepeat metres the texture repeat per UV unit is
  // metres / target. (`uvScalePerMetre` is what the renderer uses for surfaces
  // whose UVs are already in metres; it is recorded here for comparison, not
  // used, because this surface states its own target tile size.)
  const naturalTile = 1 / (uvScalePerMetre(className).x || 1);
  const tile = GROUND_DETAIL.metresPerRepeat;
  const perUv = metres / tile;
  const repeat = { x: perUv, y: perUv };
  try {
    applyDetailMaps(material, className, {
      resolution: GROUND_DETAIL.resolution,
      repeat,
      useMetalnessMap: false,
      normalScale: GROUND_DETAIL.normalScale,
      aoMapIntensity: GROUND_DETAIL.aoMapIntensity,
      roughnessScale: GROUND_DETAIL.roughness,
    });
  } catch (error) {
    return { applied: false, reason: `detail-maps-failed: ${String(error?.message || error)}` };
  }
  material.metalness = 0;
  material.userData.detailApplied = true;
  material.userData.detailRepeat = repeat;
  return {
    applied: true,
    class: className,
    repeat: { x: +repeat.x.toFixed(3), y: +repeat.y.toFixed(3) },
    metresPerRepeat: tile,
    classNaturalTileMetres: +naturalTile.toFixed(3),
    uvMetersPerRepeat: metres,
  };
}

export function buildStreetSurfaceDetail(ctx, overrides = {}) {
  const startedAt = Date.now();
  const city = ctx?.city;
  const options = surfaceOptionsFor(ctx, overrides);
  const plan = buildStreetscapePlan(city, options);
  const bounds = city?.meta?.bounds;
  const focus = resolveFocus(ctx, city);
  const outerRadius = windowRadius(focus, bounds);
  const state = makeState(plan, focus, options, ctx?.seed ?? city?.meta?.seed ?? 'city', outerRadius);
  const farRadius = state.rings[state.rings.length - 1].radius;
  const midRadius = state.rings[Math.min(1, state.rings.length - 1)].radius;
  const nearRadius = state.rings[0].radius;

  // Nodes first: a junction is the highest-value detail per triangle, so it
  // gets first claim on every ring's budget.
  for (const node of plan.nodes) {
    const distance = Math.hypot(node.position.x - focus.x, node.position.z - focus.z);
    if (distance > farRadius + 60) { reject(state, 'node', 'out-of-range'); continue; }
    state.source = { kind: 'node', id: node.id };
    emitJunctionPaint(state, node);
    // ROUND 3 CORRECTION. These two were gated on `midRadius + 40` while their
    // features are declared in EVERY ring, so with the shipped build focus
    // (which is the pre-reframe startup camera, see the ring note above) no
    // corner in the captured window got a detectable-warning pad and no
    // junction got a kerb inlet. Measured on the round-2 capture, the corner
    // in `01-street-day` is a bare 1.6 m x 1.36 m kerb ramp with no pad on it,
    // which is what makes it read as a chamfer rather than a ramp. A ring may
    // set the level of detail; it may not decide that a structural item does
    // not exist. The ring feature sets already do the right thing here:
    // `rampDome` is near-only, `rampPad` and `inlet` are everywhere.
    if (distance <= farRadius) emitNodeDrainage(state, node);
    if (distance <= farRadius) emitRampPads(state, node);
  }

  for (const segment of plan.segments) {
    const reach = segmentReach(state, segment);
    if (reach > farRadius) { reject(state, 'segment', 'out-of-range'); continue; }
    state.source = { kind: 'segment', id: segment.id };
    emitAsphaltWear(state, segment);
    if (reach <= midRadius) emitCovers(state, segment);
    if (reach <= midRadius) emitSidewalkDetail(state, segment);
    if (reach <= nearRadius) emitMidBlockDrainage(state, segment);
  }

  emitDriveways(state, buildHostIndex(plan));

  const groundDressing = dressGroundCarpet(ctx);

  const group = new THREE.Group();
  group.name = STREET_DETAIL_ID;
  group.userData = { kind: 'street-surface-detail', version: STREET_DETAIL_VERSION };
  const materials = overrides.materials || createStreetDetailMaterials(streetDetailSurfaceMaps(ctx));
  const meshes = buildMeshes(state, group, materials);

  const triangles = totalTriangles(state);
  const drawCalls = meshes.length;
  const segmentIds = [...state.usedSegments];
  const nodeIds = [...state.usedNodes];
  const diagnostics = {
    version: STREET_DETAIL_VERSION,
    implemented: true,
    focus: { x: focus.x, z: focus.z },
    // Round 1 shipped with a focus 1450 m from every camera and nobody could
    // see it in the diagnostics. Now the substitution is on the record.
    focusSource: focus.source,
    focusRejected: focus.rejected,
    // Which datum the rings are centred on RIGHT NOW: the build focus on the
    // first build, the live camera after a re-centre. Round 3 shipped rings
    // frozen on the build focus 640 m from the capture eye; this is the field
    // that makes that visible without opening a frame.
    centreSource: overrides.centreSource || focus.source,
    windowRadius: outerRadius,
    plan: plan.stats,
    counts: state.counts,
    rejections: state.rejections,
    rings: state.rings.map((ring, i) => ({
      id: ring.id,
      radius: ring.radius,
      maxTriangles: ring.maxTriangles,
      triangles: state.ringTriangles[i].triangles,
      items: state.ringTriangles[i].items,
      withinBudget: state.ringTriangles[i].triangles <= ring.maxTriangles,
      features: [...ring.features],
    })),
    meshes,
    totals: {
      triangles,
      drawCalls,
      withinTriangleBudget: triangles <= STREET_DETAIL_BUDGET.maxTriangles,
      withinDrawCallBudget: drawCalls <= STREET_DETAIL_BUDGET.maxDrawCalls,
    },
    lifts: STREET_DETAIL_LIFTS,
    sourceSegmentIds: segmentIds.slice(0, 256),
    sourceSegmentCount: segmentIds.length,
    sourceNodeIds: nodeIds.slice(0, 128),
    sourceNodeCount: nodeIds.length,
    buildMs: Date.now() - startedAt,
  };
  diagnostics.groundDressing = groundDressing;
  // What the decals are actually sampling. Round 4's frames could not be
  // explained from the diagnostics because nothing recorded that every decal
  // material was mapless; this makes the binding visible without a capture.
  diagnostics.surfaces = {
    uvMetersPerRepeat: {
      carriageway: state.buffers.wear.uvScale > 0 ? 1 / state.buffers.wear.uvScale : null,
      concrete: state.buffers.concrete.uvScale > 0 ? 1 / state.buffers.concrete.uvScale : null,
      marking: state.buffers.paint.uvScale > 0 ? 1 / state.buffers.paint.uvScale : null,
    },
    maps: Object.fromEntries(Object.entries(materials).map(([name, material]) => [name, {
      albedo: material?.map?.name || null,
      normal: Boolean(material?.normalMap),
      roughness: Boolean(material?.roughnessMap),
      ao: Boolean(material?.aoMap),
    }])),
    wearMultipliers: STREET_WEAR_MULTIPLIERS,
    jointGroove: STREET_JOINT_GROOVE,
  };
  diagnostics.markings = {
    crossings: state.records.crossings.length,
    stopBars: state.records.stopBars.length,
    laneArrows: state.records.laneArrows.length,
    inlets: state.records.inlets.length,
    rampPads: state.records.rampPads.length,
  };
  return {
    object: triangles > 0 ? group : null,
    diagnostics, state, plan, materials, records: state.records,
  };
}

// ---------------------------------------------------------------------------
// pass module: the LOD centre follows the camera
// ---------------------------------------------------------------------------
//
// ROUND 3 CORRECTION - READ THIS BEFORE CHANGING THE THRESHOLD.
//
// The ring note at the top of this file explains why the outer ring covers the
// whole window: a wrong focus must never empty the city. It does not fix the
// other half of the same bug. `ctx.focus` is sampled ONCE, when the city is
// built, and the player - or the capture harness - then moves away from it.
// Measured on the round-3 capture set the rings were still centred on
// (1588.8, 369.5) while the street card stood at (1447.1, 1003.8), 640 m away,
// and the footway directly under the lens was therefore built at the window
// tier: 2994 panel joints, 3454 wheel paths and 1010 tactile domes were
// rejected with a `ring-window` reason, so the slab under the camera had no
// scored joints, no polish and no truncated domes on its kerb ramps.
//
// `update` re-centres the rings on the live camera once it has moved past
// STREET_DETAIL_FOCUS.refreshMetres, exactly as facade-articulation does. The
// rebuild is SYNCHRONOUS and completes inside the update call, so a camera
// teleport - which is how every capture card is posed - is fully re-centred in
// the frame it is posed for. Nothing is interpolated.
//
// Threshold choice. The near ring reaches 140 m, so re-centring every 45 m
// keeps at least 95 m of fully detailed footway ahead of the eye while costing
// one rebuild per 45 m travelled instead of one per frame. Measured rebuild
// cost on the shipped slice is ~0.75 s in the browser (`buildMs` in the
// diagnostics), which is why the threshold is not tighter.
export const STREET_DETAIL_FOCUS = Object.freeze({
  refreshMetres: 45,
});

/** Live pass state. A pass module is a singleton, so this is its whole world. */
const passState = {
  group: null,
  materials: null,
  centre: null,
  refreshes: 0,
  lastRefreshMs: 0,
  diagnostics: { version: STREET_DETAIL_VERSION, implemented: false },
};

/**
 * A read-only view of `ctx` whose focus is the live camera. `Object.create`
 * rather than a spread: the renderer's context exposes `hour`, `weather` and
 * `traffic` as getters, and a spread would freeze them at their current value.
 */
function cameraCentredContext(ctx, x, z) {
  const view = Object.create(ctx);
  view.focus = { x, z };
  return view;
}

/** Replace the pass group's contents with a fresh build, in place. */
function adoptContent(group, next) {
  for (const child of [...group.children]) {
    child.geometry?.dispose?.();
    group.remove(child);
  }
  if (!next) return;
  for (const child of [...next.children]) group.add(child);
}

export default {
  id: STREET_DETAIL_ID,
  order: 30,
  build(ctx) {
    passState.materials = createStreetDetailMaterials(streetDetailSurfaceMaps(ctx));
    const result = buildStreetSurfaceDetail(ctx, { materials: passState.materials });
    passState.group = result.object;
    passState.centre = { x: result.diagnostics.focus.x, z: result.diagnostics.focus.z };
    passState.refreshes = 0;
    passState.lastRefreshMs = 0;
    result.diagnostics.refreshes = 0;
    result.diagnostics.lastRefreshMs = 0;
    result.diagnostics.refreshMetres = STREET_DETAIL_FOCUS.refreshMetres;
    passState.diagnostics = result.diagnostics;
    return { object: result.object, diagnostics: result.diagnostics };
  },

  /**
   * Re-centre the rings on the live camera. Steady state is one subtraction
   * and a hypot; everything else only runs on a threshold crossing.
   */
  update(ctx) {
    if (!passState.group || !passState.centre) return;
    const camera = ctx?.camera?.position;
    if (!camera || !Number.isFinite(camera.x) || !Number.isFinite(camera.z)) return;
    const moved = Math.hypot(camera.x - passState.centre.x, camera.z - passState.centre.z);
    if (moved < STREET_DETAIL_FOCUS.refreshMetres) return;
    const startedAt = Date.now();
    const next = buildStreetSurfaceDetail(
      cameraCentredContext(ctx, camera.x, camera.z),
      { materials: passState.materials, centreSource: 'camera' },
    );
    // The centre is the CAMERA, not the focus the build settled on. A camera
    // outside `city.meta.bounds` has its focus substituted for the bounds
    // centre (see `resolveFocus`); recording that substitute would leave the
    // stored centre a long way from the camera and rebuild the pass every
    // frame for as long as it stood there.
    passState.centre = { x: camera.x, z: camera.z };
    adoptContent(passState.group, next.object);
    passState.refreshes += 1;
    passState.lastRefreshMs = Date.now() - startedAt;
    Object.assign(passState.diagnostics, next.diagnostics, {
      refreshes: passState.refreshes,
      lastRefreshMs: passState.lastRefreshMs,
      refreshMetres: STREET_DETAIL_FOCUS.refreshMetres,
      // The carpet is dressed once and the dressing is idempotent, so a
      // refresh reports 'already-dressed'. Keep the result that says what was
      // actually done, or a capture report taken after a re-centre would read
      // as though the carpet had never been dressed at all.
      groundDressing: passState.diagnostics.groundDressing?.applied
        ? passState.diagnostics.groundDressing
        : next.diagnostics.groundDressing,
    });
  },

  dispose() {
    // The registry disposes the returned object's geometry and the materials
    // that are still attached to it. A material whose buffer ended up empty
    // was never attached, so release the whole set here and drop the
    // singleton's references, so a rebuilt city starts clean.
    disposeStreetDetailMaterials(passState.materials);
    passState.group = null;
    passState.materials = null;
    passState.centre = null;
    passState.refreshes = 0;
    passState.lastRefreshMs = 0;
  },

  /** Test seam: the live diagnostics without going through the registry. */
  __diagnostics() {
    return passState.diagnostics;
  },
};
