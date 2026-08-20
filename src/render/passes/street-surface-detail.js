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
import {
  buildStreetscapePlan,
  sidewalkBand,
  sidewalkSurfaceY,
  carriagewaySurfaceY,
  curbTopSurfaceY,
  streetStationAt,
  streetRandom,
  streetHash32,
} from '../../world/streets/street-surface-v2.js';

export const STREET_DETAIL_ID = 'street-surface-detail';
export const STREET_DETAIL_VERSION = 'street-surface-detail-v1';

/**
 * Distance rings from `ctx.focus`, in metres, with the feature set each ring
 * carries and its triangle cap. Measured numbers are in the diagnostics the
 * pass returns; the caps below are the regression bound, not the measurement.
 */
export const STREET_DETAIL_RINGS = Object.freeze([
  Object.freeze({
    id: 'near',
    radius: 120,
    maxTriangles: 150000,
    features: Object.freeze([
      'crossing', 'stopBar', 'laneArrow', 'inlet', 'cover', 'sidewalkCover',
      'patch', 'coldJoint', 'crack', 'wheelPath', 'gutterGrime',
      'panelJoint', 'expansionJoint', 'longJoint', 'stain',
      'rampPad', 'rampDome', 'driveway',
    ]),
  }),
  Object.freeze({
    id: 'mid',
    radius: 340,
    maxTriangles: 120000,
    features: Object.freeze([
      'crossing', 'stopBar', 'laneArrow', 'inlet', 'cover',
      'patch', 'coldJoint', 'gutterGrime', 'expansionJoint', 'rampPad', 'driveway',
    ]),
  }),
  Object.freeze({
    id: 'far',
    radius: 900,
    maxTriangles: 90000,
    features: Object.freeze(['crossing', 'stopBar', 'patch', 'gutterGrime']),
  }),
]);

export const STREET_DETAIL_BUDGET = Object.freeze({
  maxTriangles: 360000,
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
 * Everything that is a MODIFICATION of the surface underneath it - a patch, a
 * tar seal, a polished wheel path, gutter grime, a scored joint, a stain, an
 * apron - is derived from the active palette's own tone for that surface, not
 * from a fixed hex. The canonical San Francisco palette is a pale concrete
 * road; the stylised palette is dark asphalt. A fixed "patch grey" is darker
 * than one and lighter than the other, so it reads as a patch in one world and
 * as a spill in the other.
 */
function wearTones(o, className) {
  const asphalt = hexToSrgb(o.colors.asphalt[className] || o.colors.asphalt.default);
  const sidewalk = hexToSrgb(o.colors.sidewalk);
  return {
    patchDark: scale(asphalt, 0.7),
    patchLight: scale(asphalt, 1.06),
    tar: scale(asphalt, 0.44),
    wheelPolish: scale(asphalt, 0.9),
    gutterGrime: mix(hexToSrgb(o.colors.gutter), scale(asphalt, 0.62), 0.5),
    jointDark: scale(sidewalk, 0.86),
    jointDeep: scale(sidewalk, 0.75),
    stain: scale(sidewalk, 0.92),
    apron: scale(sidewalk, 0.965),
    paintFresh: hexToSrgb(o.colors.markingWhite),
    // Fully worn paint is faded, never darker than the road it is painted on.
    paintWorn: mix(hexToSrgb(o.colors.markingWhite), scale(asphalt, 1.02), 0.75),
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

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scale(rgb, k) {
  return [Math.min(1, rgb[0] * k), Math.min(1, rgb[1] * k), Math.min(1, rgb[2] * k)];
}

function makeBuffer(name) {
  return { name, positions: [], normals: [], colors: [], uvs: [], indices: [], triangles: 0 };
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
    buffer.uvs.push(p.x * 0.5, p.z * 0.5);
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
  sidewalkLift: 0.045,   // renderer.js LEGACY_SIDEWALK_LIFT
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
// build state
// ---------------------------------------------------------------------------

function makeState(plan, focus, options, seedTag) {
  const rings = STREET_DETAIL_RINGS.map((ring) => ({ ...ring, used: 0, features: new Set(ring.features) }));
  const buffers = {
    paint: makeBuffer('paint'),
    wear: makeBuffer('wear'),
    metal: makeBuffer('metal'),
    concrete: makeBuffer('concrete'),
    dome: makeBuffer('dome'),
  };
  const o = plan.options;
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

/** Arrow outline(s) in approach-local (distance-back, lateral) coordinates. */
function arrowShapes(movement, dTail, centre) {
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
    const reach = wantsThrough ? 1.05 : 1.5;
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
      { d: barbD, v: vEnd + turn * headLength },
    ]);
  }
  return shapes;
}

function emitJunctionPaint(state, node) {
  const o = state.o;
  const tones = wearTones(o, node.approaches[0]?.className || 'default');
  const fresh = tones.paintFresh;
  const worn = tones.paintWorn;
  // Repainting is a per-junction event, so the wear of every mark at one node
  // is correlated. 0 = repainted last month, 1 = due for repainting.
  const nodeWear = ((streetHash32(`${state.seedTag}:repaint:${node.id}`) % 1000) / 1000) ** 1.4;
  const crossings = junctionEarnsCrossings(node);
  const width = crossingWidthFor(node);
  const ladder = node.maxClassRank >= 5;

  for (const approach of node.approaches) {
    const half = approach.half;
    const u = approach.u;
    const m = perpCCW(u);
    const pos = node.position;
    const at = (d, v) => ({ x: pos.x + u.x * d + m.x * v, z: pos.z + u.z * d + m.z * v });
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
            const wear = clamp(nodeWear * (0.72 + rng() * 0.5), 0, 1);
            const color = mix(fresh, worn, wear);
            pushFace(state.buffers.paint, [
              point(bandStart, v0), point(bandEnd, v0), point(bandEnd, v1), point(bandStart, v1),
            ], color, UP);
          }
        } else {
          const lineWidth = STREET_DETAIL_MARKINGS.transverseLineWidth;
          const v0 = -half + o.crosswalkEdgeInset;
          const v1 = half - o.crosswalkEdgeInset;
          for (const d of [bandStart + lineWidth / 2, bandEnd - lineWidth / 2]) {
            const wear = clamp(nodeWear * (0.8 + rng() * 0.4), 0, 1);
            const color = mix(fresh, worn, wear);
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
        const color = mix(fresh, worn, clamp(nodeWear * 0.9, 0, 1));
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
          const color = mix(fresh, worn, clamp(nodeWear * (0.6 + rng() * 0.5), 0, 1));
          for (const shape of arrowShapes(lane.movement, dTail, lane.centre)) {
            pushFace(state.buffers.paint, shape.map((s) => point(s.d, s.v)), color, UP);
          }
        });
        if (emitted > 0) {
          state.records.laneArrows.push({
            nodeId: node.id,
            segmentId: approach.segmentId,
            movement: lane.movement,
            lane: lane.lane,
            laneWidth: lane.width,
            centre: lane.centre,
            half,
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
    const pointAt = (s, v) => walkPoint(s, v, STREET_DETAIL_LIFTS.joint);
    const stainAt = (s, v) => walkPoint(s, v, STREET_DETAIL_LIFTS.stain);
    // Scored transverse joints, with a wider expansion joint every sixth panel.
    const count = Math.floor((s1 - s0) / panel);
    for (let i = 1; i < count; i += 1) {
      const s = s0 + panel * i;
      const expansion = i % 6 === 0;
      const width = expansion ? 0.05 : 0.022;
      const color = expansion ? tones.jointDeep : tones.jointDark;
      const st = streetStationAt(segment, s, false);
      const cx = st.x + st.nx * st.miter * ((inner + outer) / 2);
      const cz = st.z + st.nz * st.miter * ((inner + outer) / 2);
      emitItem(state, cx, cz, expansion ? 'expansionJoint' : 'panelJoint', () => {
        pushFace(state.buffers.concrete, [
          pointAt(s - width / 2, inner), pointAt(s + width / 2, inner),
          pointAt(s + width / 2, outer), pointAt(s - width / 2, outer),
        ], color, UP);
      });
    }
    // A wide footway is scored down the middle as well.
    if (band.usable >= 2.6) {
      const lateral = side * (band.inner + band.usable / 2);
      const st = streetStationAt(segment, (s0 + s1) / 2, false);
      emitItem(state, st.x + st.nx * lateral, st.z + st.nz * lateral, 'longJoint', () => {
        ribbon(state, segment, s0, s1, lateral, 0.022,
          tones.jointDark, state.buffers.concrete, STREET_DETAIL_LIFTS.joint, 6, true);
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
      const emitted = emitItem(state, anchor.x, anchor.z, 'rampPad', () => {
        pushFace(state.buffers.concrete, [
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

const MATERIAL_SPECS = Object.freeze({
  paint: { roughness: 0.58, metalness: 0, offset: [-4, -8], renderOrder: 3 },
  wear: { roughness: 0.97, metalness: 0, offset: [-3, -6], renderOrder: 2 },
  metal: { roughness: 0.6, metalness: 0.55, offset: [-4, -8], renderOrder: 3 },
  concrete: { roughness: 0.93, metalness: 0, offset: [-3, -6], renderOrder: 2 },
  dome: { roughness: 0.66, metalness: 0.1, offset: null, renderOrder: 0 },
});

function buildMeshes(state, group) {
  const meshes = [];
  for (const [name, buffer] of Object.entries(state.buffers)) {
    if (buffer.triangles === 0) continue;
    const spec = MATERIAL_SPECS[name];
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: spec.roughness,
      metalness: spec.metalness,
      ...(spec.offset
        ? { polygonOffset: true, polygonOffsetFactor: spec.offset[0], polygonOffsetUnits: spec.offset[1] }
        : {}),
    });
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

export function buildStreetSurfaceDetail(ctx, overrides = {}) {
  const startedAt = Date.now();
  const city = ctx?.city;
  const options = surfaceOptionsFor(ctx, overrides);
  const plan = buildStreetscapePlan(city, options);
  const bounds = city?.meta?.bounds;
  const focus = ctx?.focus && Number.isFinite(ctx.focus.x) && Number.isFinite(ctx.focus.z)
    ? { x: ctx.focus.x, z: ctx.focus.z }
    : bounds
      ? { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 }
      : { x: 0, z: 0 };
  const state = makeState(plan, focus, options, ctx?.seed ?? city?.meta?.seed ?? 'city');
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
    if (distance <= midRadius + 40) emitNodeDrainage(state, node);
    if (distance <= midRadius + 40) emitRampPads(state, node);
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

  const group = new THREE.Group();
  group.name = STREET_DETAIL_ID;
  group.userData = { kind: 'street-surface-detail', version: STREET_DETAIL_VERSION };
  const meshes = buildMeshes(state, group);

  const triangles = totalTriangles(state);
  const drawCalls = meshes.length;
  const segmentIds = [...state.usedSegments];
  const nodeIds = [...state.usedNodes];
  const diagnostics = {
    version: STREET_DETAIL_VERSION,
    implemented: true,
    focus,
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
  diagnostics.markings = {
    crossings: state.records.crossings.length,
    stopBars: state.records.stopBars.length,
    laneArrows: state.records.laneArrows.length,
    inlets: state.records.inlets.length,
    rampPads: state.records.rampPads.length,
  };
  return { object: triangles > 0 ? group : null, diagnostics, state, plan, records: state.records };
}

export default {
  id: STREET_DETAIL_ID,
  order: 30,
  build(ctx) {
    const result = buildStreetSurfaceDetail(ctx);
    return { object: result.object, diagnostics: result.diagnostics };
  },
};
