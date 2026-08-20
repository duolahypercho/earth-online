// Street surface v2 - real road construction around an authoritative centreline.
//
// Subsystem: Terrain/buildings/streets (src/world/streets/). This module owns
// *presentation geometry only*. It never moves, resamples, or rewrites a
// centreline, a width, a lane count or an intersection position: every vertex
// it emits is derived from `city.segments` / `city.intersections` exactly as
// they arrive, and the source objects are treated as frozen input.
//
// It exists to move the "Street and road realism" rubric dimension
// (Docs/VISUAL_QUALITY_GATE.md, weight 18, gate >= 4.0) off the flat-ribbon
// baseline by adding the construction a real street has:
//
//   * a cambered carriageway (crowned centre, 2% cross fall) so the driving
//     surface is not a perfect plane;
//   * a gutter channel at each edge that drains below the road datum;
//   * a raised curb with a real vertical face (default 0.15 m) and a proper
//     curb return (fillet arc) at every junction corner;
//   * a sidewalk that starts at curb-top level and cross-falls away from the
//     road, mitred through polyline bends so the ribbon has no V-shaped seams;
//   * lane markings driven by `segment.lanes` / `segment.oneway`: edge lines,
//     a solid single or double centre line on two-way streets, dashed lane
//     dividers, and stop bars on approaches to a signalised node;
//   * zebra crosswalk bands aligned to each approach at signalised nodes;
//   * kerb ramps on every junction corner;
//   * a junction pad that the approach carriageways are trimmed back to, so
//     road surfaces meet instead of overlapping.
//
// Coordinate and width conventions (matched to `CityRenderer.buildRoadNetwork`,
// src/citygen/renderer.js:3656 - read that before changing anything here):
//
//   * world units are metres, streets live in the XZ plane, +Y is up;
//   * for an edge a->b the tangent is d = (b-a)/|b-a| and the lateral basis is
//     n = (-d.z, d.x), identical to the renderer's `nx`/`nz`;
//   * `segment.width` is the CARRIAGEWAY width; the carriageway therefore spans
//     exactly u in [-width/2, +width/2] along n, and nothing else may claim
//     that band;
//   * `sidewalkLeft` / `sidewalkRight` (falling back to `sidewalkW`) are FOOTWAY
//     widths measured outward from the carriageway edge, so the outer sidewalk
//     edge is at |u| = width/2 + sidewalkW. Per the repo convention (see
//     src/citygen/traffic.js:323 and src/citygen/renderer.js:7580) the +n side
//     carries `sidewalkLeft` and the -n side carries `sidewalkRight`;
//   * the road datum is y = roadLift + heightAt(x, z), with `roadLift` read from
//     `city.meta.streetDesign.roadLift` exactly like the renderer does.
//
// Z-FIGHTING POLICY (deliberate, do not "simplify" this away):
//
//   Painted markings sit `markingLift` = 0.012 m (12 mm) above the carriageway
//   surface *sampled at the same lateral station*, so a marking follows the
//   camber instead of intersecting it. 12 mm is chosen from the canonical
//   camera (src/citygen/renderer.js:1619 - near 0.5 m, far 4200 m, 24-bit
//   depth): the resolvable world-space depth delta of that projection is about
//   z^2 / (near * 2^24), i.e. ~2.7 mm at 150 m and ~11 mm at 300 m, so 12 mm
//   clears the depth buffer over the whole range a marking is still more than
//   a pixel wide. A constant world offset alone is NOT enough at pedestrian eye
//   level, where the road is viewed at a grazing angle and the depth slope
//   across a single marking quad is large, so the marking material additionally
//   uses polygonOffset with factor -4 / units -8 (negative pulls the fragment
//   toward the camera; the factor term scales with the depth slope and is what
//   actually fixes the grazing case) plus renderOrder 2. Kerb ramps overlay the
//   curb they cut through and are pushed 6 mm out along the corner bisector for
//   the same reason; everything else in this module is a real, non-coplanar
//   surface and needs no offset at all.
//
// Determinism: no Math.random, no Date.now, no iteration over unordered sets.
// The only "variation" is a 32-bit string hash of `segment.id` used for a +/-2%
// asphalt tone jitter, so two runs on the same city produce bit-identical
// buffers.

import * as THREE from 'three';

export const STREET_SURFACE_V2_ID = 'street-surface-v2';

/** Layer order is stable and is part of the contract the self-check asserts. */
export const STREET_SURFACE_V2_LAYERS = Object.freeze([
  'carriageway', // cambered driving surface + gutter pans + junction pads
  'curbFace',    // vertical curb faces (straight runs + corner returns)
  'curbTop',     // curb top surface
  'sidewalk',    // footway from the back of curb outward
  'ramp',        // kerb ramps at corners
  'marking',     // edge / centre / lane / stop-bar paint
  'crosswalk',   // zebra bands
]);

/** Which mesh (and therefore which material and draw call) each layer lands in. */
export const STREET_SURFACE_V2_MESH_GROUPS = Object.freeze({
  carriageway: ['carriageway'],
  concrete: ['curbFace', 'curbTop', 'sidewalk', 'ramp'],
  markings: ['marking', 'crosswalk'],
});

// Budget. Measured on the canonical cross-section this module is tuned for
// (two-way, 4 lanes, 12 m carriageway, 3 m sidewalk both sides, 6 m station
// step): ~470 triangles per 100 m of street, and ~330 triangles for a
// signalised four-way junction. The caps below leave headroom for wider
// arterials without letting a regression through unnoticed.
export const STREET_SURFACE_V2_BUDGET = Object.freeze({
  maxTrianglesPer100m: 900,
  maxTrianglesPerIntersection: 700,
  maxDrawCalls: 3,
});

const HIDDEN_PATH_CLASSES = Object.freeze([
  'footway', 'path', 'steps', 'cycleway', 'pedestrian', 'corridor', 'platform',
]);

const UNMARKED_CLASSES = Object.freeze(['service', 'living_street', 'track', 'unclassified']);

export const STREET_SURFACE_V2_DEFAULTS = Object.freeze({
  // vertical construction
  roadLift: 0.5,
  crossSlope: 0.02,        // carriageway cross fall, crown = crossSlope * halfWidth
  gutterWidth: 0.45,       // width of the drainage pan measured in from the curb
  gutterDepth: 0.03,       // gutter invert below the road datum
  curbFaceHeight: 0.15,    // EXPOSED curb face: invert -> curb top
  curbTopWidth: 0.16,
  curbTopFall: 0.008,      // curb top falls this much toward the road
  sidewalkCrossSlope: 0.02,
  minSidewalkWidth: 0.5,   // below this a side gets no curb and no footway
  // sampling
  maxStep: 6,              // max metres between cross-sections (terrain follow)
  nodeSnap: 0.6,           // endpoint-to-intersection match radius (renderer uses 0.5)
  // corners
  cornerRadius: 4.5,
  cornerMinAngleDeg: 25,
  cornerMaxAngleDeg: 155,
  cornerArcStepDeg: 15,
  // kerb ramps
  rampWidth: 1.6,
  rampRun: 1.2,
  rampLift: 0.006,
  // paint
  markingLift: 0.012,
  edgeLineWidth: 0.12,
  centreLineWidth: 0.14,
  centreLineGap: 0.32,
  laneLineWidth: 0.12,
  dashMark: 3,
  dashGap: 6,
  minMarkedHalfWidth: 2.2,
  // junction paint
  crosswalkBandDepth: 2.4,
  crosswalkStripePitch: 0.8,
  crosswalkStripeWidth: 0.45,
  crosswalkEdgeInset: 0.3,
  crosswalkClearance: 0.35,
  stopBarDepth: 0.5,
  stopBarClearance: 1.2,
  stopBarEdgeInset: 0.15,
  // Junction paint sits 3 mm above segment paint so a zebra band or a stop bar
  // that crosses an edge line / centre line / lane divider wins cleanly instead
  // of fighting it. Both values are still world-space lifts above the SAME
  // cambered carriageway sample, so nothing floats.
  junctionPaintLift: 0.015,
  // +1: traffic travelling a->b keeps to the +n half. Flip to -1 if the world's
  // handedness puts right-hand traffic on the other side; only stop bars and
  // the stopping half of a two-way approach depend on it.
  drivingSideSign: 1,
  // presentation
  palette: 'sf',
  // Opt-in: also treat any place where 3+ authoritative centrelines already
  // share an endpoint as a junction, even when `city.intersections` has no
  // record for it. Off by default so the authored intersection list stays the
  // source of truth; turn it on when the active city exposes far fewer
  // intersections than it has real crossings.
  inferNodes: false,
  excludeHighways: HIDDEN_PATH_CLASSES,
  unmarkedHighways: UNMARKED_CLASSES,
  uvMetersPerRepeat: Object.freeze({ carriageway: 4, concrete: 2.6, marking: 1 }),
  heightAt: null,
});

const PALETTES = Object.freeze({
  sf: Object.freeze({
    asphalt: Object.freeze({
      motorway: '#c9d0d6', trunk: '#cdd3d8', primary: '#d2d7db', secondary: '#d6dadd',
      tertiary: '#d9dcde', residential: '#dde0e1', service: '#e2e3e1', default: '#dde0e1',
    }),
    junction: '#d4d8da',
    gutter: '#bfc4c6',
    curbFace: '#cfc9bd',
    curbTop: '#e2ddd1',
    sidewalk: '#eee7da',
    ramp: '#e6dfce',
    markingWhite: '#f4efe2',
    markingYellow: '#e6b93f',
    crosswalk: '#fbf6ea',
  }),
  stylised: Object.freeze({
    asphalt: Object.freeze({
      motorway: '#5d6570', trunk: '#626a74', primary: '#6b737d', secondary: '#747c84',
      tertiary: '#7d848b', residential: '#858b90', service: '#8d9294', default: '#858b90',
    }),
    junction: '#5d5c5a',
    gutter: '#4f545a',
    curbFace: '#a98a66',
    curbTop: '#c0936b',
    sidewalk: '#e2c79a',
    ramp: '#d8bd90',
    markingWhite: '#efe8d4',
    markingYellow: '#e6b93f',
    crosswalk: '#fff4dc',
  }),
});

// ---------------------------------------------------------------------------
// small deterministic math helpers
// ---------------------------------------------------------------------------

function hash32(value) {
  const text = String(value ?? '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function finite(value) {
  return Number.isFinite(value);
}

function hexToSrgb(hex) {
  const text = String(hex).replace('#', '');
  const n = parseInt(text.length === 3
    ? text.split('').map((c) => c + c).join('')
    : text, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function scaleColor(rgb, factor) {
  return [clamp(rgb[0] * factor, 0, 1), clamp(rgb[1] * factor, 0, 1), clamp(rgb[2] * factor, 0, 1)];
}

function mixColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function perpCCW(u) {
  // Rotate +90 degrees in atan2(z, x) space. For an edge tangent d this is the
  // renderer's n = (-d.z, d.x).
  return { x: -u.z, z: u.x };
}

function cross2(a, b) {
  return a.x * b.z - a.z * b.x;
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

// ---------------------------------------------------------------------------
// buffer layers (plain arrays - no THREE, so the geometry is node-testable)
// ---------------------------------------------------------------------------

function makeLayer(name, uvMetersPerRepeat) {
  return {
    name,
    uvMetersPerRepeat,
    positions: [],
    normals: [],
    colors: [],
    uvs: [],
    indices: [],
    triangles: 0,
  };
}

function faceNormal(p0, p1, p2) {
  const ax = p1.x - p0.x;
  const ay = p1.y - p0.y;
  const az = p1.z - p0.z;
  const bx = p2.x - p0.x;
  const by = p2.y - p0.y;
  const bz = p2.z - p0.z;
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return { x: 0, y: 1, z: 0 };
  nx /= len; ny /= len; nz /= len;
  return { x: nx, y: ny, z: nz };
}

function pushVertex(layer, p, n, color) {
  layer.positions.push(p.x, p.y, p.z);
  layer.normals.push(n.x, n.y, n.z);
  layer.colors.push(color[0], color[1], color[2]);
  layer.uvs.push(p.x / layer.uvMetersPerRepeat, p.z / layer.uvMetersPerRepeat);
}

function colorAt(color, index) {
  return Array.isArray(color[0]) ? color[index] : color;
}

function pushTriangle(layer, p0, p1, p2, color, ref) {
  if (!finite(p0.x + p0.y + p0.z + p1.x + p1.y + p1.z + p2.x + p2.y + p2.z)) return false;
  let a = p0; let b = p1; let c = p2;
  let ia = 0; let ib = 1; let ic = 2;
  let n = faceNormal(a, b, c);
  if (ref && (n.x * ref.x + n.y * ref.y + n.z * ref.z) < 0) {
    b = p2; c = p1; ib = 2; ic = 1;
    n = faceNormal(a, b, c);
  }
  const base = layer.positions.length / 3;
  pushVertex(layer, a, n, colorAt(color, ia));
  pushVertex(layer, b, n, colorAt(color, ib));
  pushVertex(layer, c, n, colorAt(color, ic));
  layer.indices.push(base, base + 1, base + 2);
  layer.triangles += 1;
  return true;
}

/**
 * Quad p0->p1->p2->p3. `ref` is the direction the face must point at; the
 * winding is flipped when it does not, which makes every emitter here immune to
 * getting the corner order backwards.
 */
function pushQuad(layer, p0, p1, p2, p3, color, ref) {
  const pts = [p0, p1, p2, p3];
  for (const p of pts) {
    if (!finite(p.x) || !finite(p.y) || !finite(p.z)) return false;
  }
  let order = [0, 1, 2, 3];
  let n = faceNormal(pts[0], pts[1], pts[3]);
  if (ref && (n.x * ref.x + n.y * ref.y + n.z * ref.z) < 0) {
    order = [0, 3, 2, 1];
    n = faceNormal(pts[order[0]], pts[order[1]], pts[order[3]]);
  }
  const base = layer.positions.length / 3;
  for (let i = 0; i < 4; i += 1) {
    pushVertex(layer, pts[order[i]], n, colorAt(color, order[i]));
  }
  layer.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  layer.triangles += 2;
  return true;
}

const UP = Object.freeze({ x: 0, y: 1, z: 0 });

// ---------------------------------------------------------------------------
// polyline sampling
// ---------------------------------------------------------------------------

function dedupePoints(points) {
  const out = [];
  for (const p of points || []) {
    const x = Number(p?.x);
    const z = Number(p?.z);
    if (!finite(x) || !finite(z)) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(x - last.x, z - last.z) < 1e-4) continue;
    out.push({ x, z });
  }
  return out;
}

function arcTable(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  return cum;
}

function edgeDir(points, i) {
  const a = points[i];
  const b = points[i + 1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

function edgeIndexAt(cum, s) {
  let lo = 0;
  for (let i = 0; i < cum.length - 1; i += 1) {
    if (s >= cum[i] - 1e-9) lo = i;
  }
  return Math.min(lo, cum.length - 2);
}

/**
 * Station frame at arc length `s`. At an interior vertex the lateral basis is
 * mitred (averaged normal, offset scaled by 1/cos(theta/2)) so consecutive
 * ribbon quads share an edge exactly instead of leaving the V-shaped notch the
 * baseline road ribbons have at every bend.
 */
function frameAt(points, cum, s, allowMiter) {
  const i = edgeIndexAt(cum, s);
  const a = points[i];
  const b = points[i + 1];
  const segLen = (cum[i + 1] - cum[i]) || 1;
  const t = (s - cum[i]) / segLen;
  const d = edgeDir(points, i);
  let nx = -d.z;
  let nz = d.x;
  let miter = 1;
  if (allowMiter && i > 0 && Math.abs(s - cum[i]) < 1e-6) {
    const dp = edgeDir(points, i - 1);
    let ax = -dp.z + nx;
    let az = dp.x + nz;
    const al = Math.hypot(ax, az);
    if (al > 1e-6) {
      ax /= al; az /= al;
      const c = ax * nx + az * nz;
      if (c > 0.25) { nx = ax; nz = az; miter = 1 / c; }
    }
  }
  return {
    s,
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    nx,
    nz,
    miter,
    tx: d.x,
    tz: d.z,
  };
}

function buildStations(points, cum, s0, s1, maxStep) {
  const total = cum[cum.length - 1];
  const start = clamp(s0, 0, total);
  const end = clamp(s1, 0, total);
  const keys = [start];
  for (let i = 1; i < cum.length - 1; i += 1) {
    if (cum[i] > start + 1e-6 && cum[i] < end - 1e-6) keys.push(cum[i]);
  }
  keys.push(end);
  const arcs = [];
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    const span = b - a;
    if (span <= 1e-6) continue;
    const steps = Math.max(1, Math.ceil(span / maxStep));
    for (let k = 0; k < steps; k += 1) arcs.push(a + span * (k / steps));
  }
  arcs.push(end);
  return arcs.map((s) => frameAt(points, cum, s, true));
}

function offsetPoint(station, u, y) {
  return {
    x: station.x + station.nx * u * station.miter,
    y,
    z: station.z + station.nz * u * station.miter,
  };
}

// ---------------------------------------------------------------------------
// cross section
// ---------------------------------------------------------------------------

/** Lateral stations of the carriageway cross-section, from -half to +half. */
function sectionOffsets(half, o) {
  const gutterStart = Math.max(0, half - o.gutterWidth);
  if (gutterStart <= 0.05) return [-half, 0, half];
  return [-half, -gutterStart, 0, gutterStart, half];
}

/**
 * Carriageway surface height at lateral offset `u`.
 * Crown at the centre, linear cross fall out to the gutter lip, then a steeper
 * fall into the gutter invert at |u| = half. The carriageway therefore occupies
 * exactly [-half, +half] = segment.width and is never planar.
 */
function crossSectionY(datum, u, half, o) {
  const a = Math.min(Math.abs(u), half);
  const crown = o.crossSlope * half;
  const gutterStart = Math.max(0, half - o.gutterWidth);
  if (a <= gutterStart) return datum + crown * (1 - a / half);
  const lip = datum + crown * (1 - gutterStart / half);
  const invert = datum - o.gutterDepth;
  const t = (a - gutterStart) / Math.max(1e-6, half - gutterStart);
  return lip + (invert - lip) * t;
}

function curbTopY(datum, o) {
  return datum - o.gutterDepth + o.curbFaceHeight;
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export function resolveStreetSurfaceOptions(city, overrides = {}) {
  const meta = city?.meta || {};
  const design = meta.streetDesign || {};
  const generator = meta.generator;
  const realMap = generator === 'sf-builtin' || generator === 'openstreetmap';
  const base = {
    ...STREET_SURFACE_V2_DEFAULTS,
    roadLift: finite(Number(design.roadLift)) ? Number(design.roadLift) : STREET_SURFACE_V2_DEFAULTS.roadLift,
    palette: realMap ? 'sf' : 'stylised',
  };
  const merged = { ...base, ...overrides };
  merged.uvMetersPerRepeat = { ...base.uvMetersPerRepeat, ...(overrides.uvMetersPerRepeat || {}) };
  merged.excludeSet = new Set(merged.excludeHighways || []);
  merged.unmarkedSet = new Set(merged.unmarkedHighways || []);
  merged.colors = PALETTES[merged.palette] || PALETTES.sf;
  merged.heightAt = typeof merged.heightAt === 'function' ? merged.heightAt : null;
  return merged;
}

/**
 * Lane marking plan for one segment. Pure and exported so the lane logic can be
 * asserted directly without inspecting buffers.
 * Returns lines ordered deterministically: edges, centre, then dividers.
 * `u` is the lateral offset in metres from the centreline along n.
 */
export function planSegmentMarkings(segment, options = {}) {
  const o = options.colors ? options : resolveStreetSurfaceOptions(null, options);
  const width = Number(segment?.width) || 0;
  const half = width / 2;
  const lines = [];
  if (!(half >= o.minMarkedHalfWidth)) return lines;
  if (o.unmarkedSet.has(segment.highway)) return lines;
  const lanes = Math.max(1, Math.round(Number(segment.lanes) || 2));
  const oneway = segment.oneway === true || segment.oneway === 'yes'
    || segment.oneway === 1 || segment.oneway === '1'
    || segment.oneway === 'increasing' || segment.oneway === 'decreasing';
  const edgeU = Math.max(0.35, half - o.gutterWidth - 0.1);
  lines.push({ role: 'edge', u: edgeU, width: o.edgeLineWidth, dashed: false, paint: 'white' });
  lines.push({ role: 'edge', u: -edgeU, width: o.edgeLineWidth, dashed: false, paint: 'white' });
  if (oneway) {
    for (let j = 1; j < lanes; j += 1) {
      lines.push({
        role: 'divider',
        u: -half + (width * j) / lanes,
        width: o.laneLineWidth,
        dashed: true,
        paint: 'white',
      });
    }
    return lines;
  }
  if (lanes >= 4) {
    lines.push({ role: 'centre', u: o.centreLineGap / 2, width: o.centreLineWidth, dashed: false, paint: 'yellow' });
    lines.push({ role: 'centre', u: -o.centreLineGap / 2, width: o.centreLineWidth, dashed: false, paint: 'yellow' });
  } else {
    lines.push({ role: 'centre', u: 0, width: o.centreLineWidth, dashed: false, paint: 'yellow' });
  }
  const perSide = Math.max(1, Math.floor(lanes / 2));
  for (let j = 1; j < perSide; j += 1) {
    const u = (half * j) / perSide;
    lines.push({ role: 'divider', u, width: o.laneLineWidth, dashed: true, paint: 'white' });
    lines.push({ role: 'divider', u: -u, width: o.laneLineWidth, dashed: true, paint: 'white' });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// nodes and corners
// ---------------------------------------------------------------------------

function sidewalkWidths(segment) {
  const fallback = Math.max(0, Number(segment.sidewalkW) || 0);
  const left = Number(segment.sidewalkLeft);
  const right = Number(segment.sidewalkRight);
  return {
    left: Math.max(0, finite(left) ? left : fallback),
    right: Math.max(0, finite(right) ? right : fallback),
  };
}

function prepareSegments(city, o) {
  const out = [];
  for (const segment of city?.segments || []) {
    if (o.excludeSet.has(segment.highway)) continue;
    const points = dedupePoints(segment.points);
    if (points.length < 2) continue;
    const width = Number(segment.width);
    if (!finite(width) || width <= 0.2) continue;
    const cum = arcTable(points);
    const length = cum[cum.length - 1];
    if (!(length > 0.2)) continue;
    out.push({
      segment,
      points,
      cum,
      length,
      half: width / 2,
      walks: sidewalkWidths(segment),
      trimStart: 0,
      trimEnd: 0,
    });
  }
  return out;
}

function makeApproach(entry, atStart) {
  const { points, cum, length } = entry;
  const last = points.length - 1;
  const u = atStart
    ? edgeDir(points, 0)
    : { x: -edgeDir(points, last - 1).x, z: -edgeDir(points, last - 1).z };
  const oneway = entry.segment.oneway === true || entry.segment.oneway === 'yes'
    || entry.segment.oneway === 1 || entry.segment.oneway === '1';
  return {
    entry,
    atStart,
    u,
    angle: normAngle(Math.atan2(u.z, u.x)),
    half: entry.half,
    runLength: length,
    // +m = perpCCW(u). At the polyline start u is the tangent so +m is +n
    // (sidewalkLeft); at the end u is the reversed tangent so +m is -n.
    widthCCW: atStart ? entry.walks.left : entry.walks.right,
    widthCW: atStart ? entry.walks.right : entry.walks.left,
    // For a one-way segment, traffic follows the point order: it reaches this
    // node only when the node is the polyline end.
    flowsToward: oneway ? !atStart : true,
    oneway,
    arc: cum,
    trim: 0,
  };
}

/**
 * Uniform grid over segment endpoints. Deterministic: buckets are filled in
 * `city.segments` order and every query result is re-sorted by segment index.
 */
function buildEndpointIndex(entries, o) {
  const cell = Math.max(1, o.nodeSnap * 4);
  const map = new Map();
  const list = [];
  entries.forEach((entry, entryIndex) => {
    const first = entry.points[0];
    const last = entry.points[entry.points.length - 1];
    for (const item of [
      { entry, entryIndex, atStart: true, x: first.x, z: first.z },
      { entry, entryIndex, atStart: false, x: last.x, z: last.z },
    ]) {
      list.push(item);
      const key = `${Math.floor(item.x / cell)}|${Math.floor(item.z / cell)}`;
      const bucket = map.get(key);
      if (bucket) bucket.push(item); else map.set(key, [item]);
    }
  });
  return { cell, map, list };
}

function queryEndpoints(index, x, z, radius) {
  const cx = Math.floor(x / index.cell);
  const cz = Math.floor(z / index.cell);
  const out = [];
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      const bucket = index.map.get(`${cx + i}|${cz + j}`);
      if (!bucket) continue;
      for (const item of bucket) {
        if (Math.hypot(item.x - x, item.z - z) <= radius) out.push(item);
      }
    }
  }
  out.sort((a, b) => (a.entryIndex - b.entryIndex) || ((a.atStart ? 0 : 1) - (b.atStart ? 0 : 1)));
  return out;
}

function makeNode(id, position, items, signalId, intersection) {
  const approaches = items.map((item) => makeApproach(item.entry, item.atStart));
  approaches.sort((a, b) => (a.angle - b.angle) || (a.half - b.half));
  return { intersection: intersection || null, id, position, approaches, signalId, corners: [] };
}

function collectNodes(city, entries, o) {
  const index = buildEndpointIndex(entries, o);
  const nodes = [];
  const consumed = new Set();
  for (const intersection of city?.intersections || []) {
    const p = intersection?.position;
    if (!p || !finite(Number(p.x)) || !finite(Number(p.z))) continue;
    const position = { x: Number(p.x), z: Number(p.z) };
    const items = queryEndpoints(index, position.x, position.z, o.nodeSnap);
    // 2 approaches is a continuation of one street, not a junction.
    if (items.length < 3) continue;
    for (const item of items) consumed.add(item);
    nodes.push(makeNode(intersection.id, position, items, intersection.signalId ?? null, intersection));
  }
  if (o.inferNodes) {
    // Presentation-only nodes where three or more centrelines already share an
    // endpoint but the source city has no `intersections` record. This adds no
    // topology: the endpoints, and therefore the node positions, come straight
    // from the authoritative centrelines. Inferred nodes are never signalised,
    // so they get curb returns, ramps and a junction pad but no paint.
    for (const item of index.list) {
      if (consumed.has(item)) continue;
      const items = queryEndpoints(index, item.x, item.z, o.nodeSnap).filter((i) => !consumed.has(i));
      if (items.length < 3) continue;
      for (const i of items) consumed.add(i);
      nodes.push(makeNode(
        `inferred:${item.entryIndex}:${item.atStart ? 'a' : 'b'}`,
        { x: item.x, z: item.z },
        items,
        null,
        null,
      ));
    }
  }
  nodes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return nodes;
}

/**
 * Fillet between the curb lines of two consecutive approaches (A then B going
 * counter-clockwise). Returns the arc centre, radius, tangent points and the
 * along-approach distances of those tangent points from the node centre.
 */
function solveCorner(position, A, B, o) {
  const sweep = normAngle(B.angle - A.angle);
  const minAngle = (o.cornerMinAngleDeg * Math.PI) / 180;
  const maxAngle = (o.cornerMaxAngleDeg * Math.PI) / 180;
  if (!(sweep > minAngle && sweep < maxAngle)) return null;
  const ma = perpCCW(A.u);
  const mb = perpCCW(B.u);
  const a0 = { x: position.x + ma.x * A.half, z: position.z + ma.z * A.half };
  const b0 = { x: position.x - mb.x * B.half, z: position.z - mb.z * B.half };
  const den = cross2(A.u, B.u);
  if (Math.abs(den) < 1e-4) return null;
  const t = cross2({ x: b0.x - a0.x, z: b0.z - a0.z }, B.u) / den;
  const corner = { x: a0.x + A.u.x * t, z: a0.z + A.u.z * t };
  if (!finite(corner.x) || !finite(corner.z)) return null;
  const halfAngle = sweep / 2;
  const baseA = (corner.x - position.x) * A.u.x + (corner.z - position.z) * A.u.z;
  const baseB = (corner.x - position.x) * B.u.x + (corner.z - position.z) * B.u.z;
  let r = Math.min(o.cornerRadius, 0.9 * Math.min(A.half, B.half) + 1.5);
  for (let i = 0; i < 8; i += 1) {
    const d = r / Math.tan(halfAngle);
    const dA = baseA + d;
    const dB = baseB + d;
    const tooLong = dA > 0.4 * A.runLength || dB > 0.4 * B.runLength;
    if (!tooLong) {
      if (!(dA > 0.05 && dB > 0.05)) return null;
      let bx = A.u.x + B.u.x;
      let bz = A.u.z + B.u.z;
      const bl = Math.hypot(bx, bz);
      if (bl < 1e-6) return null;
      bx /= bl; bz /= bl;
      const centreDist = r / Math.sin(halfAngle);
      const centre = { x: corner.x + bx * centreDist, z: corner.z + bz * centreDist };
      const ta = { x: corner.x + A.u.x * d, z: corner.z + A.u.z * d };
      const tb = { x: corner.x + B.u.x * d, z: corner.z + B.u.z * d };
      return { centre, radius: r, ta, tb, dA, dB, corner, sweep, bisector: { x: bx, z: bz }, A, B };
    }
    r *= 0.6;
    if (r < 0.8) return null;
  }
  return null;
}

function arcPoints(corner, o) {
  const a0 = Math.atan2(corner.ta.z - corner.centre.z, corner.ta.x - corner.centre.x);
  const a1 = Math.atan2(corner.tb.z - corner.centre.z, corner.tb.x - corner.centre.x);
  const delta = signedAngle(a1 - a0);
  const step = (o.cornerArcStepDeg * Math.PI) / 180;
  const count = clamp(Math.ceil(Math.abs(delta) / step), 2, 16);
  const list = [];
  for (let i = 0; i <= count; i += 1) {
    const ang = a0 + (delta * i) / count;
    list.push({ angle: ang, x: corner.centre.x + Math.cos(ang) * corner.radius, z: corner.centre.z + Math.sin(ang) * corner.radius });
  }
  return list;
}

// ---------------------------------------------------------------------------
// segment surface
// ---------------------------------------------------------------------------

function carriagewayColor(base, gutter, u, half, o) {
  const gutterStart = Math.max(0, half - o.gutterWidth);
  const a = Math.min(Math.abs(u), half);
  if (a <= gutterStart) return base;
  const t = (a - gutterStart) / Math.max(1e-6, half - gutterStart);
  return mixColor(base, gutter, t * 0.85);
}

function emitSegment(entry, layers, o, ctx, stats) {
  const { points, cum, length, half } = entry;
  const s0 = clamp(entry.trimStart, 0, length);
  const s1 = clamp(length - entry.trimEnd, 0, length);
  if (s1 - s0 < 0.6) return;
  const stations = buildStations(points, cum, s0, s1, o.maxStep);
  if (stations.length < 2) return;
  stats.streetLengthMeters += s1 - s0;

  const palette = o.colors;
  const asphaltHex = palette.asphalt[entry.segment.highway] || palette.asphalt.default;
  const jitter = 1 + (((hash32(entry.segment.id) % 41) - 20) / 1000); // +/-2%, deterministic
  const asphalt = scaleColor(hexToSrgb(asphaltHex), jitter);
  const gutterColor = hexToSrgb(palette.gutter);
  const curbFaceColor = hexToSrgb(palette.curbFace);
  const curbTopColor = hexToSrgb(palette.curbTop);
  const sidewalkColor = hexToSrgb(palette.sidewalk);

  const offs = sectionOffsets(half, o);
  const datums = stations.map((st) => ctx.datum(st.x, st.z));

  // Cambered carriageway + gutter pans.
  for (let i = 0; i < stations.length - 1; i += 1) {
    const A = stations[i];
    const B = stations[i + 1];
    for (let k = 0; k < offs.length - 1; k += 1) {
      const u0 = offs[k];
      const u1 = offs[k + 1];
      const c0 = carriagewayColor(asphalt, gutterColor, u0, half, o);
      const c1 = carriagewayColor(asphalt, gutterColor, u1, half, o);
      pushQuad(layers.carriageway,
        offsetPoint(A, u0, crossSectionY(datums[i], u0, half, o)),
        offsetPoint(B, u0, crossSectionY(datums[i + 1], u0, half, o)),
        offsetPoint(B, u1, crossSectionY(datums[i + 1], u1, half, o)),
        offsetPoint(A, u1, crossSectionY(datums[i], u1, half, o)),
        [c0, c0, c1, c1], UP);
    }
  }

  // Curb + footway, per side. sideSign +1 is the +n side and carries
  // sidewalkLeft, matching the repo convention.
  for (const side of [1, -1]) {
    const walk = side > 0 ? entry.walks.left : entry.walks.right;
    if (!(walk >= o.minSidewalkWidth)) continue;
    for (let i = 0; i < stations.length - 1; i += 1) {
      const A = stations[i];
      const B = stations[i + 1];
      const dA = datums[i];
      const dB = datums[i + 1];
      const invertA = dA - o.gutterDepth;
      const invertB = dB - o.gutterDepth;
      const topA = curbTopY(dA, o);
      const topB = curbTopY(dB, o);
      const faceRef = { x: -side * A.nx, y: 0, z: -side * A.nz };
      pushQuad(layers.curbFace,
        offsetPoint(A, side * half, invertA),
        offsetPoint(B, side * half, invertB),
        offsetPoint(B, side * half, topB),
        offsetPoint(A, side * half, topA),
        curbFaceColor, faceRef);
      const backU = side * (half + o.curbTopWidth);
      pushQuad(layers.curbTop,
        offsetPoint(A, side * half, topA),
        offsetPoint(B, side * half, topB),
        offsetPoint(B, backU, topB + o.curbTopFall),
        offsetPoint(A, backU, topA + o.curbTopFall),
        curbTopColor, UP);
      if (walk > o.curbTopWidth + 0.05) {
        const outU = side * (half + walk);
        const rise = o.sidewalkCrossSlope * (walk - o.curbTopWidth);
        pushQuad(layers.sidewalk,
          offsetPoint(A, backU, topA + o.curbTopFall),
          offsetPoint(B, backU, topB + o.curbTopFall),
          offsetPoint(B, outU, topB + o.curbTopFall + rise),
          offsetPoint(A, outU, topA + o.curbTopFall + rise),
          sidewalkColor, UP);
      }
    }
  }

  // Paint.
  const lines = planSegmentMarkings(entry.segment, o);
  stats.markingLines += lines.length;
  const white = hexToSrgb(palette.markingWhite);
  const yellow = hexToSrgb(palette.markingYellow);
  for (const line of lines) {
    const color = line.paint === 'yellow' ? yellow : white;
    if (line.dashed) stats.dashedLines += 1;
    const emitSpan = (fa, fb) => {
      const da = ctx.datum(fa.x, fa.z);
      const db = ctx.datum(fb.x, fb.z);
      const uL = line.u - line.width / 2;
      const uR = line.u + line.width / 2;
      pushQuad(layers.marking,
        offsetPoint(fa, uL, crossSectionY(da, uL, half, o) + o.markingLift),
        offsetPoint(fb, uL, crossSectionY(db, uL, half, o) + o.markingLift),
        offsetPoint(fb, uR, crossSectionY(db, uR, half, o) + o.markingLift),
        offsetPoint(fa, uR, crossSectionY(da, uR, half, o) + o.markingLift),
        color, UP);
    };
    if (!line.dashed) {
      for (let i = 0; i < stations.length - 1; i += 1) emitSpan(stations[i], stations[i + 1]);
      stats.markingQuads += stations.length - 1;
      continue;
    }
    const cycle = o.dashMark + o.dashGap;
    let dashes = 0;
    for (let s = s0; s < s1 - 0.4; s += cycle) {
      const e = Math.min(s + o.dashMark, s1);
      if (e - s < 0.4) continue;
      emitSpan(frameAt(points, cum, s, false), frameAt(points, cum, e, false));
      dashes += 1;
    }
    stats.markingQuads += dashes;
  }
}

// ---------------------------------------------------------------------------
// junction
// ---------------------------------------------------------------------------

function approachEndFrame(app) {
  const { points, cum, length } = app.entry;
  const s = app.atStart ? app.trim : length - app.trim;
  return frameAt(points, cum, clamp(s, 0, length), false);
}

/**
 * Pass 1 for a junction: solve the corner fillets and decide how far every
 * approach carriageway is trimmed back. This runs for every node before any
 * geometry is emitted, because a segment's paint needs the trims at BOTH of its
 * ends before it can be laid out.
 */
function planJunction(node, o) {
  const approaches = node.approaches;
  const count = approaches.length;

  // Corner fillets between consecutive approaches (CCW).
  const corners = approaches.map((a, i) => solveCorner(node.position, a, approaches[(i + 1) % count], o));
  node.corners = corners;

  // Trim each approach back past the tangent points of both of its corners.
  for (let i = 0; i < count; i += 1) {
    const app = approaches[i];
    const other = approaches.filter((_, j) => j !== i);
    const defaultTrim = Math.max(...other.map((a) => a.half)) + 0.3;
    const next = corners[i];
    const prev = corners[(i - 1 + count) % count];
    let trim = defaultTrim;
    if (next) trim = Math.max(trim, next.dA);
    if (prev) trim = Math.max(trim, prev.dB);
    app.trim = clamp(trim, 0, 0.42 * app.runLength);
    if (app.atStart) app.entry.trimStart = Math.max(app.entry.trimStart, app.trim);
    else app.entry.trimEnd = Math.max(app.entry.trimEnd, app.trim);
  }
}

/** Pass 2 for a junction: pad, curb returns, kerb ramps, crosswalks, stop bars. */
function emitJunction(node, layers, o, ctx, stats) {
  const palette = o.colors;
  const approaches = node.approaches;
  const count = approaches.length;
  const corners = node.corners;
  const maxHalf = Math.max(...approaches.map((a) => a.half));

  // Junction pad: a fan from the node crown out to a boundary made of each
  // approach's full cross-section plus the corner arcs, so the pad meets the
  // trimmed carriageways vertex-for-vertex instead of overlapping them.
  const boundary = [];
  for (let i = 0; i < count; i += 1) {
    const app = approaches[i];
    const frame = approachEndFrame(app);
    const offs = sectionOffsets(app.half, o);
    for (const off of offs) {
      const u = app.atStart ? off : -off;
      const x = frame.x + frame.nx * u;
      const z = frame.z + frame.nz * u;
      boundary.push({ x, y: crossSectionY(ctx.datum(x, z), off, app.half, o), z });
    }
    const corner = corners[i];
    if (corner) {
      for (const p of arcPoints(corner, o)) {
        boundary.push({ x: p.x, y: ctx.datum(p.x, p.z) - o.gutterDepth, z: p.z });
      }
    }
  }
  const junctionColor = hexToSrgb(palette.junction);
  const gutterColor = hexToSrgb(palette.gutter);
  const apexDatum = ctx.datum(node.position.x, node.position.z);
  const apex = { x: node.position.x, y: apexDatum + o.crossSlope * maxHalf * 0.6, z: node.position.z };
  const before = layers.carriageway.triangles;
  for (let i = 0; i < boundary.length; i += 1) {
    const a = boundary[i];
    const b = boundary[(i + 1) % boundary.length];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 1e-6) continue;
    pushTriangle(layers.carriageway, apex, a, b, [junctionColor, gutterColor, gutterColor], UP);
  }
  stats.junctionPads += 1;
  stats.junctionPadTriangles += layers.carriageway.triangles - before;

  // Curb returns, corner footway and kerb ramps.
  for (let i = 0; i < count; i += 1) {
    const corner = corners[i];
    if (!corner) continue;
    stats.corners += 1;
    const walkA = approaches[i].widthCCW;
    const walkB = approaches[(i + 1) % count].widthCW;
    const walk = Math.min(walkA, walkB);
    if (!(walk >= o.minSidewalkWidth)) continue;
    emitCornerReturn(corner, walk, layers, o, ctx, stats);
  }

  // Crosswalks and stop bars.
  if (node.signalId !== null && node.signalId !== undefined) {
    for (const app of approaches) emitApproachPaint(node, app, layers, o, ctx, stats);
  }
}

function emitCornerReturn(corner, walk, layers, o, ctx, stats) {
  const palette = o.colors;
  const curbFaceColor = hexToSrgb(palette.curbFace);
  const curbTopColor = hexToSrgb(palette.curbTop);
  const sidewalkColor = hexToSrgb(palette.sidewalk);
  const rampColor = hexToSrgb(palette.ramp);
  const centre = corner.centre;
  const radius = corner.radius;
  const backRadius = Math.max(0.25, radius - o.curbTopWidth);
  const innerRadius = Math.max(0.2, radius - walk);
  const a0 = Math.atan2(corner.ta.z - centre.z, corner.ta.x - centre.x);
  const a1 = Math.atan2(corner.tb.z - centre.z, corner.tb.x - centre.x);
  const delta = signedAngle(a1 - a0);
  const step = (o.cornerArcStepDeg * Math.PI) / 180;
  const segments = clamp(Math.ceil(Math.abs(delta) / step), 2, 16);

  // Kerb ramp occupies an angular window centred on the corner bisector.
  const rampHalfAngle = Math.min(Math.abs(delta) * 0.34, (o.rampWidth / 2) / radius);
  const rampBack = clamp(radius - o.curbTopWidth - o.rampRun, innerRadius, backRadius - 0.05);
  const hasRamp = rampHalfAngle > 0.02 && rampBack < backRadius - 0.04;
  if (hasRamp) stats.ramps += 1;
  const mid = a0 + delta / 2;
  const rampLo = mid - rampHalfAngle * Math.sign(delta || 1);
  const rampHi = mid + rampHalfAngle * Math.sign(delta || 1);

  const angles = [];
  for (let i = 0; i <= segments; i += 1) angles.push(a0 + (delta * i) / segments);
  if (hasRamp) angles.push(rampLo, rampHi);
  angles.sort((p, q) => (delta >= 0 ? p - q : q - p));

  const pointAt = (angle, r) => ({ x: centre.x + Math.cos(angle) * r, z: centre.z + Math.sin(angle) * r });
  const inRamp = (angle) => {
    if (!hasRamp) return false;
    const lo = Math.min(rampLo, rampHi);
    const hi = Math.max(rampLo, rampHi);
    return angle > lo - 1e-9 && angle < hi + 1e-9;
  };
  const sidewalkYAt = (datum, r) => curbTopY(datum, o) + o.curbTopFall
    + o.sidewalkCrossSlope * Math.max(0, (radius - r) - o.curbTopWidth);

  for (let i = 0; i < angles.length - 1; i += 1) {
    const ang0 = angles[i];
    const ang1 = angles[i + 1];
    if (Math.abs(ang1 - ang0) < 1e-6) continue;
    const midAngle = (ang0 + ang1) / 2;
    const ramped = inRamp(midAngle);
    const f0 = pointAt(ang0, radius);
    const f1 = pointAt(ang1, radius);
    const d0 = ctx.datum(f0.x, f0.z);
    const d1 = ctx.datum(f1.x, f1.z);
    const inv0 = d0 - o.gutterDepth;
    const inv1 = d1 - o.gutterDepth;
    const outward0 = { x: Math.cos(ang0), y: 0, z: Math.sin(ang0) };
    if (!ramped) {
      // Curb face and curb top follow the fillet.
      pushQuad(layers.curbFace,
        { x: f0.x, y: inv0, z: f0.z },
        { x: f1.x, y: inv1, z: f1.z },
        { x: f1.x, y: curbTopY(d1, o), z: f1.z },
        { x: f0.x, y: curbTopY(d0, o), z: f0.z },
        curbFaceColor, outward0);
      const b0 = pointAt(ang0, backRadius);
      const b1 = pointAt(ang1, backRadius);
      pushQuad(layers.curbTop,
        { x: f0.x, y: curbTopY(d0, o), z: f0.z },
        { x: f1.x, y: curbTopY(d1, o), z: f1.z },
        { x: b1.x, y: curbTopY(d1, o) + o.curbTopFall, z: b1.z },
        { x: b0.x, y: curbTopY(d0, o) + o.curbTopFall, z: b0.z },
        curbTopColor, UP);
    } else {
      // Ramp surface: sidewalk level at the back, gutter invert at the face.
      const r0 = pointAt(ang0, rampBack);
      const r1 = pointAt(ang1, rampBack);
      pushQuad(layers.ramp,
        { x: f0.x, y: inv0 + o.rampLift, z: f0.z },
        { x: f1.x, y: inv1 + o.rampLift, z: f1.z },
        { x: r1.x, y: sidewalkYAt(d1, rampBack), z: r1.z },
        { x: r0.x, y: sidewalkYAt(d0, rampBack), z: r0.z },
        rampColor, UP);
      stats.rampStrips += 1;
    }
    // Corner footway: from the back of the curb (or the back of the ramp)
    // inward to the block edge.
    const outerR = ramped ? rampBack : backRadius;
    if (innerRadius < outerR - 0.05) {
      const p0 = pointAt(ang0, outerR);
      const p1 = pointAt(ang1, outerR);
      const q0 = pointAt(ang0, innerRadius);
      const q1 = pointAt(ang1, innerRadius);
      pushQuad(layers.sidewalk,
        { x: p0.x, y: sidewalkYAt(d0, outerR), z: p0.z },
        { x: p1.x, y: sidewalkYAt(d1, outerR), z: p1.z },
        { x: q1.x, y: sidewalkYAt(d1, innerRadius), z: q1.z },
        { x: q0.x, y: sidewalkYAt(d0, innerRadius), z: q0.z },
        sidewalkColor, UP);
    }
  }

  // Ramp flares close the curb where the ramp cuts through it.
  if (hasRamp) {
    for (const ang of [rampLo, rampHi]) {
      const f = pointAt(ang, radius);
      const b = pointAt(ang, backRadius);
      const r = pointAt(ang, rampBack);
      const d = ctx.datum(f.x, f.z);
      const tangential = { x: -Math.sin(ang), y: 0, z: Math.cos(ang) };
      pushQuad(layers.ramp,
        { x: f.x, y: d - o.gutterDepth, z: f.z },
        { x: f.x, y: curbTopY(d, o), z: f.z },
        { x: b.x, y: curbTopY(d, o) + o.curbTopFall, z: b.z },
        { x: r.x, y: sidewalkYAt(d, rampBack), z: r.z },
        rampColor, tangential);
    }
  }
}

function emitApproachPaint(node, app, layers, o, ctx, stats) {
  const palette = o.colors;
  const crosswalkColor = hexToSrgb(palette.crosswalk);
  const white = hexToSrgb(palette.markingWhite);
  const u = app.u;
  const m = perpCCW(u);
  const half = app.half;
  const available = app.runLength - (app.atStart ? app.entry.trimEnd : app.entry.trimStart);
  const bandStart = app.trim + o.crosswalkClearance;
  const bandEnd = bandStart + o.crosswalkBandDepth;
  if (bandEnd + 0.4 > available) return;
  const at = (d, v) => ({ x: node.position.x + u.x * d + m.x * v, z: node.position.z + u.z * d + m.z * v });
  const yAt = (p, v) => crossSectionY(ctx.datum(p.x, p.z), v, half, o) + o.junctionPaintLift;

  // Zebra band, stripes parallel to the approach axis, aligned to the approach.
  const usable = Math.max(0, half * 2 - o.crosswalkEdgeInset * 2);
  const stripes = Math.max(2, Math.floor(usable / o.crosswalkStripePitch));
  for (let i = 0; i < stripes; i += 1) {
    const v = -half + o.crosswalkEdgeInset + (usable * (i + 0.5)) / stripes;
    const v0 = v - o.crosswalkStripeWidth / 2;
    const v1 = v + o.crosswalkStripeWidth / 2;
    const p00 = at(bandStart, v0);
    const p01 = at(bandStart, v1);
    const p10 = at(bandEnd, v0);
    const p11 = at(bandEnd, v1);
    pushQuad(layers.crosswalk,
      { x: p00.x, y: yAt(p00, v0), z: p00.z },
      { x: p10.x, y: yAt(p10, v0), z: p10.z },
      { x: p11.x, y: yAt(p11, v1), z: p11.z },
      { x: p01.x, y: yAt(p01, v1), z: p01.z },
      crosswalkColor, UP);
  }
  stats.crosswalkBands += 1;

  // Stop bar behind the band, across the lanes that actually stop here.
  if (!app.flowsToward) return;
  const barStart = bandEnd + o.stopBarClearance;
  const barEnd = barStart + o.stopBarDepth;
  if (barEnd + 0.3 > available) return;
  // Traffic arrives travelling along -u; its driving side is
  // -perpCCW(u) * drivingSideSign, i.e. the -m half when drivingSideSign is +1.
  const stopSign = -o.drivingSideSign;
  const vLo = app.oneway ? -half + o.stopBarEdgeInset : Math.min(0, stopSign * (half - o.stopBarEdgeInset));
  const vHi = app.oneway ? half - o.stopBarEdgeInset : Math.max(0, stopSign * (half - o.stopBarEdgeInset));
  const c00 = at(barStart, vLo);
  const c01 = at(barStart, vHi);
  const c10 = at(barEnd, vLo);
  const c11 = at(barEnd, vHi);
  pushQuad(layers.marking,
    { x: c00.x, y: yAt(c00, vLo), z: c00.z },
    { x: c10.x, y: yAt(c10, vLo), z: c10.z },
    { x: c11.x, y: yAt(c11, vHi), z: c11.z },
    { x: c01.x, y: yAt(c01, vHi), z: c01.z },
    white, UP);
  stats.stopBars += 1;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

function emptyStats() {
  return {
    segments: 0,
    nodes: 0,
    junctionPads: 0,
    junctionPadTriangles: 0,
    corners: 0,
    ramps: 0,
    rampStrips: 0,
    crosswalkBands: 0,
    stopBars: 0,
    markingLines: 0,
    dashedLines: 0,
    markingQuads: 0,
    streetLengthMeters: 0,
    nonFinite: 0,
    triangles: {},
    trianglesTotal: 0,
    segmentTriangles: 0,
    intersectionTriangles: 0,
    trianglesPer100m: 0,
    trianglesPerIntersection: 0,
  };
}

function auditLayer(layer) {
  let bad = 0;
  for (const value of layer.positions) if (!Number.isFinite(value)) bad += 1;
  for (const value of layer.normals) if (!Number.isFinite(value)) bad += 1;
  for (const value of layer.uvs) if (!Number.isFinite(value)) bad += 1;
  for (const value of layer.colors) if (!Number.isFinite(value)) bad += 1;
  const vertexCount = layer.positions.length / 3;
  for (const index of layer.indices) {
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) bad += 1;
  }
  return bad;
}

/**
 * Pure geometry pass. No THREE, no DOM, no renderer - safe to call from node.
 *
 * @param {object} city  needs `segments`, `intersections`, optional `meta`.
 * @param {object} [overrides] any key of STREET_SURFACE_V2_DEFAULTS, plus
 *        `heightAt(x, z)` to follow terrain (defaults to a flat datum).
 * @returns {{ id, layers, stats, options }} layers hold plain number arrays
 *        (positions/normals/colors/uvs/indices) in metres and sRGB 0..1.
 */
export function buildStreetSurfaceData(city, overrides = {}) {
  const o = resolveStreetSurfaceOptions(city, overrides);
  const layers = {};
  for (const name of STREET_SURFACE_V2_LAYERS) {
    const group = Object.keys(STREET_SURFACE_V2_MESH_GROUPS)
      .find((key) => STREET_SURFACE_V2_MESH_GROUPS[key].includes(name));
    layers[name] = makeLayer(name, o.uvMetersPerRepeat[group] || 1);
  }
  const stats = emptyStats();
  const heightAt = o.heightAt;
  const ctx = {
    datum: heightAt
      ? (x, z) => {
        const h = Number(heightAt(x, z));
        return o.roadLift + (finite(h) ? h : 0);
      }
      : () => o.roadLift,
  };

  const entries = prepareSegments(city, o);
  const nodes = collectNodes(city, entries, o);
  stats.segments = entries.length;
  stats.nodes = nodes.length;

  for (const node of nodes) planJunction(node, o);

  for (const node of nodes) emitJunction(node, layers, o, ctx, stats);
  for (const name of STREET_SURFACE_V2_LAYERS) stats.intersectionTriangles += layers[name].triangles;

  for (const entry of entries) emitSegment(entry, layers, o, ctx, stats);

  let total = 0;
  for (const name of STREET_SURFACE_V2_LAYERS) {
    stats.triangles[name] = layers[name].triangles;
    total += layers[name].triangles;
    stats.nonFinite += auditLayer(layers[name]);
  }
  stats.trianglesTotal = total;
  stats.segmentTriangles = total - stats.intersectionTriangles;
  stats.trianglesPer100m = stats.streetLengthMeters > 0
    ? (stats.segmentTriangles / stats.streetLengthMeters) * 100
    : 0;
  stats.trianglesPerIntersection = stats.nodes > 0
    ? stats.intersectionTriangles / stats.nodes
    : 0;
  stats.budget = {
    ...STREET_SURFACE_V2_BUDGET,
    withinTrianglesPer100m: stats.trianglesPer100m <= STREET_SURFACE_V2_BUDGET.maxTrianglesPer100m,
    withinTrianglesPerIntersection:
      stats.trianglesPerIntersection <= STREET_SURFACE_V2_BUDGET.maxTrianglesPerIntersection,
  };
  return { id: STREET_SURFACE_V2_ID, layers, stats, options: o };
}

function concatLayers(layers, names) {
  const positions = [];
  const normals = [];
  const colors = [];
  const uvs = [];
  const indices = [];
  for (const name of names) {
    const layer = layers[name];
    const base = positions.length / 3;
    for (const v of layer.positions) positions.push(v);
    for (const v of layer.normals) normals.push(v);
    for (const v of layer.uvs) uvs.push(v);
    for (const v of layer.colors) colors.push(srgbToLinear(v));
    for (const v of layer.indices) indices.push(base + v);
  }
  return { positions, normals, colors, uvs, indices };
}

function toGeometry(parts) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(parts.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(parts.normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(parts.colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(parts.uvs, 2));
  geometry.setIndex(parts.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Build the THREE objects. Stock materials only - no ShaderMaterial, no
 * onBeforeCompile, no node/TSL material, so this runs unchanged on the WebGL2
 * fallback path.
 *
 * @param {object} city
 * @param {object} [overrides] as buildStreetSurfaceData, plus:
 *        `maps: { carriageway, concrete }` optional THREE.Texture pairs used as
 *        map + bumpMap (the renderer already loads these for SF ground).
 * @returns {{ id, group, meshes, geometries, materials, data, stats }}
 */
export function buildStreetSurfaceV2(city, overrides = {}) {
  const data = buildStreetSurfaceData(city, overrides);
  const maps = overrides.maps || {};
  const group = new THREE.Group();
  group.name = STREET_SURFACE_V2_ID;
  group.userData = { kind: 'street-surface-v2', version: 2 };

  const geometries = {};
  const materials = {};
  const meshes = {};

  const carriagewayTexture = maps.carriageway || null;
  const concreteTexture = maps.concrete || null;

  materials.carriageway = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: carriagewayTexture,
    bumpMap: carriagewayTexture,
    bumpScale: carriagewayTexture ? 0.032 : 1,
    roughness: 0.94,
    metalness: 0,
  });
  materials.concrete = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: concreteTexture,
    bumpMap: concreteTexture,
    bumpScale: concreteTexture ? 0.018 : 1,
    roughness: 0.92,
    metalness: 0,
  });
  // Paint: see the Z-FIGHTING POLICY note at the top of this file. The 12 mm
  // world lift handles the general case; polygonOffset handles the grazing
  // pedestrian-eye case where the depth slope across one quad is large.
  materials.markings = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.58,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });

  for (const key of Object.keys(STREET_SURFACE_V2_MESH_GROUPS)) {
    const parts = concatLayers(data.layers, STREET_SURFACE_V2_MESH_GROUPS[key]);
    if (!parts.indices.length) continue;
    const geometry = toGeometry(parts);
    geometry.name = `${STREET_SURFACE_V2_ID}:${key}`;
    geometries[key] = geometry;
    const mesh = new THREE.Mesh(geometry, materials[key]);
    mesh.name = geometry.name;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (key === 'markings') mesh.renderOrder = 2;
    mesh.userData = {
      kind: key === 'carriageway' ? 'roads' : key === 'concrete' ? 'sidewalks' : 'road-markings',
      source: STREET_SURFACE_V2_ID,
    };
    meshes[key] = mesh;
    group.add(mesh);
  }

  return {
    id: STREET_SURFACE_V2_ID,
    group,
    meshes,
    geometries,
    materials,
    data,
    stats: data.stats,
    drawCalls: Object.keys(meshes).length,
  };
}

/** Release everything buildStreetSurfaceV2 allocated. */
export function disposeStreetSurfaceV2(result) {
  if (!result) return;
  for (const geometry of Object.values(result.geometries || {})) geometry.dispose?.();
  for (const material of Object.values(result.materials || {})) material.dispose?.();
  result.group?.clear?.();
}
