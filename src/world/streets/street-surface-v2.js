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
//     road surfaces meet instead of overlapping, cambered from a crown at the
//     node down to a gutter channel that runs unbroken round the whole node.
//
// WATERTIGHTNESS CONTRACT (this is the point of the module, not a detail):
//
//   The paved footprint - carriageway, both footways, corner returns and
//   junction pads - has NO holes. A hole here is not cosmetic: at eye level a
//   gap in the pavement lets the camera see straight through the ground and
//   pick up whatever distant geometry is behind it, which reads as a flat pale
//   polygon lying on the street. Four invariants keep it closed, and
//   scripts/verify/verify-street-surface-v2.mjs asserts the result directly by
//   sampling a dense grid over the expected footprint of twelve fixtures:
//
//   1. ONE TRIM PER SEGMENT END. The distance a segment is trimmed back at a
//      node is decided once, reconciled against the segment's own length, and
//      then written back into the junction approach. The pad, the curb ring
//      and the ribbon are all built from that single number, so they meet on
//      shared vertices instead of nearly-shared ones. A segment is never
//      dropped for being short: two trims that do not fit are scaled down
//      together.
//   2. ONE ENDPOINT, ONE NODE. An endpoint is claimed by exactly one node, so
//      two nearly coincident intersections cannot each trim the same segment
//      to a different station.
//   3. A CONTINUOUS CURB RING. Every consecutive pair of approaches gets a
//      curb path that starts on one ribbon's end cross-section and finishes on
//      the next one's - through the fillet when a fillet fits, through the
//      curb-line mitre or round the back of the node when it does not. There
//      is no "this corner has no fillet, emit nothing" case, which is what
//      used to strip the footway off the through side of every T junction.
//   4. CORNERS CLOSE ON BOTH CORRIDORS. A corner's footway is widened until it
//      clears both approaches' own footway bands, and the fillet radius is
//      never allowed below that width, so the corner's inner edge stays a
//      simple curve tangent to both instead of folding through the arc centre.
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
  'verge',       // graded bank from the back of the footway down to open ground
  'path',        // standalone pedestrian ways: plazas, alleys, mid-block walks
  'ramp',        // kerb ramps at corners
  'marking',     // edge / centre / lane / stop-bar paint
  'crosswalk',   // zebra bands
]);

/** Which mesh (and therefore which material and draw call) each layer lands in. */
export const STREET_SURFACE_V2_MESH_GROUPS = Object.freeze({
  carriageway: ['carriageway'],
  concrete: ['curbFace', 'curbTop', 'sidewalk', 'verge', 'path', 'ramp'],
  markings: ['marking', 'crosswalk'],
});

// Budget. Measured on the canonical cross-section this module is tuned for
// (two-way, 4 lanes, 12 m carriageway, 3 m sidewalk both sides, 6 m station
// step): 524 triangles per 100 m of street, and 400 triangles for a signalised
// four-way junction - 336 before the surface was made watertight, the extra 64
// being the pad's gutter channel and the corner rings' run-backs. A whole
// twelve-node grid city measures 489 tri/100 m and 310 tri per node, because
// most nodes are three-way. The caps below leave headroom for wider arterials
// and busier nodes without letting a regression through unnoticed.
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
  // THE BACK OF THE FOOTWAY (round 2).
  //
  // `roadLift` raises the whole street 0.45 m above the terrain the buildings
  // stand on, and src/world/ground-coverage.js puts its carpet a further
  // `groundSink` below that terrain. Measured on the shipped slice at the
  // eye-level traversal pose, the footway surface is y = 0.741 and the ground
  // beside it is y = -0.078: a 0.82 m cliff at the back of every footway, with
  // nothing modelled in between. Because the drop faces AWAY from a
  // pedestrian-height camera it is never visible as a step - the eye sees the
  // paved footway, then bare carpet three metres further out, and reads them
  // as one surface with an inexplicable material seam. Both round-1 reviewers
  // flagged that seam independently; on the traversal card the carpet was 46%
  // of the lower frame.
  //
  // The verge models the drop: one graded bank per station, sharing the
  // footway's own outer-edge vertices so it cannot crack, shaded from the
  // concrete slab edge at the top to open ground at the bottom.
  vergeReach: 2.2,         // lateral metres of bank beyond the footway edge
  groundSink: 0.26,        // ground-coverage GROUND_COVERAGE_DEFAULTS.sink
  vergeMaxDrop: 1.6,       // never model a bank taller than this
  // STANDALONE PEDESTRIAN WAYS (round 3).
  //
  // `excludeHighways` keeps footway / pedestrian / path / cycleway ways out of
  // the ROAD build, and correctly so: they carry no carriageway, no kerb and
  // no markings, and most of them are the OSM tracing of a sidewalk that the
  // adjacent street's own footway ribbon already paves. But they are 2167 of
  // the 3399 ways on the shipped slice, and the ones that are NOT beside a
  // road - plazas, mid-block passages, transit forecourts - were left with no
  // paved surface at all.
  //
  // Measured on the round-2 capture, card `03-canyon-golden` stands on one of
  // them (`sf-seg-301`, highway=footway, width 3.2 m). Rasterising this
  // module's own output into that camera gives: carriageway 0.0% of the frame,
  // sidewalk 0.2%, and the ground-coverage carpet 16.5% - i.e. the entire
  // lower half of that card is bare backstop carpet with no pavement anywhere.
  //
  // This paves them: a flat ribbon at footway level with the same graded bank
  // at each edge, no kerb and no paint, and a suppression test so a way that
  // merely retraces a street's own footway adds nothing.
  pavePedestrianWays: true,
  pedestrianHighways: Object.freeze(['footway', 'pedestrian', 'path', 'corridor', 'platform', 'cycleway']),
  pathMinWidth: 1.4,
  pathMaxWidth: 14,
  // How far past a road corridor's paved edge a pedestrian way still counts as
  // "already paved by that street".
  // Measured on the shipped slice: of 4001 pedestrian-way vertices, 28% fall
  // INSIDE a road corridor, and a further 37% within 4 m of its paved edge.
  // Those are OSM tracings of the sidewalk the street's own footway ribbon
  // already paves - the authored `sidewalkW` is nominal, so the real walk is
  // usually wider than the ribbon and the tracing sits just past its edge.
  // Paving them would lay a second ribbon alongside the first. 3 m past the
  // paved edge is where a way stops being a duplicate and starts being a real
  // separate surface.
  pathSuppressMargin: 3.0,
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
  // The residual kerb face left across a depressed kerb, so the kerb line is
  // continuous around a corner instead of stopping dead at every ramp.
  rampLipHeight: 0.022,
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
  crosswalkStripePitch: 0.85,
  crosswalkStripeWidth: 0.45,
  crosswalkEdgeInset: 0.3,
  crosswalkClearance: 0.35,
  stopBarDepth: 0.5,
  stopBarClearance: 1.2,
  stopBarEdgeInset: 0.15,
  // HOW FAR BACK FROM A NODE THE LONGITUDINAL PAINT STOPS (round 6).
  //
  // Round 4 ran the edge lines, the centre line and every lane divider the
  // whole length of the trimmed ribbon, straight under the crossing band and
  // the stop bar. Four of five reviewers read the result as several stripe
  // fields at incompatible angles stamped over each other, because a zebra
  // laid across continuous longitudinal lines IS two marking families in the
  // same square metre. A real carriageway stops its longitudinal lines at the
  // stop line and leaves the crossing and the intersection box unmarked.
  //
  // The reserved zone at an approach that earns junction paint therefore runs
  // from the pad edge out to the START of the stop bar, and the last stretch
  // of dashed divider before it is repainted solid, which is the lane-change
  // prohibition every approach to a junction carries.
  markingBoxClearance: 0.6,   // unmarked box past the pad edge at a bare node
  markingSolidApproach: 12,   // dashed dividers go solid this far before the box
  // Crossing family. ONE bar width and ONE bar pitch for the whole city, so
  // two crossings at one node cannot read as two different families. The
  // number of bars is whatever that fixed pitch fits, never a count that
  // rescales the pitch to the road width.
  crossingStripePitch: 0.85,
  crossingStripeWidth: 0.45,
  crossingMinStripes: 3,
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
  // Where two paved corridors overlap and no junction joins them, the busier
  // street stays continuous and the other one stops at its paved edge. See
  // `planCarriagewayYield`. `yieldClearFraction` is how much of the loser's own
  // paved half-reach the cut is pulled in by, which is what keeps the removal
  // inside pavement the winner is laying anyway.
  carriagewayYield: true,
  yieldClearFraction: 1.5,
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
    // The curb reads as CAST STONE, not as more sidewalk. Round 1's palette put
    // the curb top within 5% of the footway tone, and since the 0.093 m curb
    // face is occluded by the curb top from any pedestrian standing on the
    // footway (ray-cast on the shipped slice: the face is hit by 0.5-1% of
    // lower-frame samples, the top by up to 49 px at 4 m), the only thing the
    // eye had to go on was a tone difference that was not there. The curb top
    // is the element that is actually visible, so it carries the contrast.
    curbFace: '#c3bdb1',
    curbTop: '#cfcabe',
    sidewalk: '#eee7da',
    ramp: '#e6dfce',
    // Plaza / passage paving. Deliberately a shade below the street footway:
    // it is a different pour, it is walked on from every direction, and a
    // large flat area at the footway's own tone reads as a light box.
    path: '#ded5c4',
    verge: '#9a9384',
    // PAINT TONE (round 5). READ THIS BEFORE BRIGHTENING THESE THREE.
    //
    // Round 4 shipped markingWhite at linear 0.87 and the crosswalk band at
    // linear 0.90. Fresh thermoplastic and fresh cold paint measure 0.55-0.70
    // linear; nothing on a street is 0.87 except a specular highlight. The
    // consequence is measurable in two places: the day cards read as printed
    // decal because the paint has no headroom left above it, and in the night
    // card the markings hold near full value in a street with no key on it,
    // because a 0.87 albedo needs almost no light to stay bright.
    //
    // These are the DIFFUSE ALBEDO of the paint. The rendered value is this
    // tint multiplied by PAINT_MAP (bead speckle and wear break-up, mean
    // linear PAINT_MAP_STATS.meanLinear), so the fresh-texel value is the
    // number below and the area mean lands a little under it.
    markingWhite: '#d5d1c5',   // linear 0.620 mean, was 0.843
    markingYellow: '#d0a638',  // linear luma 0.411, was 0.514
    crosswalk: '#dad6cc',      // linear 0.660 mean, was 0.902
  }),
  stylised: Object.freeze({
    asphalt: Object.freeze({
      motorway: '#5d6570', trunk: '#626a74', primary: '#6b737d', secondary: '#747c84',
      tertiary: '#7d848b', residential: '#858b90', service: '#8d9294', default: '#858b90',
    }),
    junction: '#5d5c5a',
    gutter: '#4f545a',
    curbFace: '#9c7d5b',
    curbTop: '#b0855f',
    sidewalk: '#e2c79a',
    ramp: '#d8bd90',
    path: '#d2b78c',
    verge: '#7d7256',
    // Same treatment as the sf palette above: paint albedo, not paint highlight.
    markingWhite: '#d8d2c0',   // linear 0.620 mean, was 0.776
    markingYellow: '#d0a638',  // linear luma 0.411, was 0.514
    crosswalk: '#e1d8c2',      // linear 0.660 mean, was 0.873
  }),
});

/**
 * Read-only view of the street palettes. `src/world/ground-coverage.js` picks
 * its ground tones against the FOOTWAY and VERGE tones here, and its verifier
 * asserts the relationship against these values rather than against a copy, so
 * changing a hex there without changing this one fails the check.
 */
export const STREET_SURFACE_V2_PALETTES = PALETTES;

/**
 * The environment classes this module stamps on its three lit materials, by
 * mesh group. Members of `MATERIAL_CLASSES` in src/render/environment-ibl.js.
 * Exported so a verifier can assert them against that module's own list.
 */
export const STREET_SURFACE_V2_ENV_CLASSES = Object.freeze({
  carriageway: 'asphalt',
  concrete: 'sidewalk',
  markings: 'painted-metal',
});

// ---------------------------------------------------------------------------
// road paint albedo tile
// ---------------------------------------------------------------------------
//
// WHY PAINT NEEDS A TEXTURE AT ALL.
//
// Through round 4 the marking material was `vertexColors` and nothing else, so
// every square metre of paint in the city rendered as one flat value. Measured
// on card 01 the eight stripes of one crossing had means of 230.2-232.3 sRGB -
// a 0.9% spread across a crossing that in reality is scrubbed by two wheel
// paths, chipped at every edge and repainted in strips. A flat value is what
// makes paint read as a printed decal rather than as a 2 mm layer of resin and
// glass bead lying on top of the road.
//
// This tile supplies the part of that variation that is INSIDE the paint,
// independent of where the stripe is:
//   * bead speckle - retroreflective glass beads broadcast into hot binder,
//     which is what makes fresh paint sparkle rather than sit matte;
//   * wear break-up - the thin, translucent areas where the binder has been
//     scrubbed back toward the road, concentrated into blotches rather than
//     spread as uniform noise, because that is how paint actually fails;
//   * edge break-up - a fine ragged modulation at bead scale, so a stripe edge
//     sampled at a grazing angle is not a mathematically straight line.
// The part of the variation that depends on WHERE the stripe is - repaint age
// per junction, tyre tracks across the band - is vertex colour, and lives in
// `emitApproachPaint` and in the street-detail pass.
//
// Pure integer arithmetic, no canvas, no Math.random: the tile is identical in
// node and in the browser, which is what lets `PAINT_MAP_STATS` be asserted.
// It is one shared 128x128 RGBA tile for the whole city, 65 536 bytes of
// texture payload before mipmaps.

export const PAINT_MAP_RESOLUTION = 128;

/** Deterministic 32-bit avalanche, local so this module imports nothing. */
function paintHash(x, y, salt) {
  let h = Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ 0;
  h = Math.imul(h ^ (y + 0x165667b1), 0xc2b2ae35);
  h = Math.imul(h ^ (salt | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function paintFade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Value noise on an integer lattice, exactly periodic in u with period 1 and
 * in v with period 1, whatever `px` / `py` are. Separate axis periods are what
 * lets a scuff be anisotropic WITHOUT breaking the tile seam: scaling the
 * coordinate would change the period, scaling the lattice does not.
 */
function paintNoise(u, v, periodX, periodY, salt) {
  // Integer lattice periods only: a fractional period is not periodic in [0,1)
  // and would put a visible seam down every stripe in the city.
  const px = Math.max(1, Math.round(periodX));
  const py = Math.max(1, Math.round(periodY));
  const x = u * px;
  const y = v * py;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = paintFade(x - ix);
  const fy = paintFade(y - iy);
  const x0 = ((ix % px) + px) % px;
  const y0 = ((iy % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const n00 = paintHash(x0, y0, salt);
  const n10 = paintHash(x1, y0, salt);
  const n01 = paintHash(x0, y1, salt);
  const n11 = paintHash(x1, y1, salt);
  const a = n00 + (n10 - n00) * fx;
  const b = n01 + (n11 - n01) * fx;
  return a + (b - a) * fy;
}

function paintFbm(u, v, px, py, octaves, salt) {
  let amp = 1;
  let total = 0;
  let norm = 0;
  let ax = px;
  let ay = py;
  for (let o = 0; o < octaves; o += 1) {
    total += amp * paintNoise(u, v, ax, ay, salt + o * 977);
    norm += amp;
    amp *= 0.5;
    ax *= 2;
    ay *= 2;
  }
  return norm > 0 ? total / norm : 0;
}

function srgbEncode(linear) {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * (c ** (1 / 2.4)) - 0.055;
}

/**
 * The paint tile as a linear-luminance multiplier field in [0,1], sampled at
 * normalized tile coordinates. 1.0 is intact paint; low values are places the
 * road is showing through. Exported so a verifier can integrate it without
 * building a texture.
 *
 * Exactly periodic in both axes: `paintSurfaceValue(0, v)` and
 * `paintSurfaceValue(1, v)` agree, which is what makes the tile seamless on a
 * stripe that runs for tens of metres.
 */
export function paintSurfaceValue(u, v) {
  // Wear blotches: two octave bands, folded so the thin areas are compact
  // patches rather than an even fog of noise. Real paint fails in patches.
  const blotch = paintFbm(u, v, 3, 3, 4, 0x51ed);
  const coarse = paintFbm(u, v, 2, 2, 2, 0x2f19);
  const field = blotch * 0.66 + coarse * 0.34;
  // 0 over intact paint, rising to 1 in the middle of a thin patch.
  const wearT = Math.min(1, Math.max(0, field - 0.560) / 0.230);
  const wear = wearT * wearT * (3 - 2 * wearT);
  // Scuff: a fine scrub stretched along u, stronger where paint is thin.
  const scuff = paintFbm(u, v, 3, 22, 3, 0x7a11) - 0.5;
  // Bead speckle: near-texel-scale sparkle from broadcast glass bead clusters.
  const bead = paintNoise(u, v, PAINT_MAP_RESOLUTION / 2, PAINT_MAP_RESOLUTION / 2, 0x1d3b);
  const beadFine = paintNoise(u, v, PAINT_MAP_RESOLUTION, PAINT_MAP_RESOLUTION, 0x6c07);
  const speckle = (bead - 0.5) * 0.10 + (beadFine - 0.5) * 0.08;
  // A bead that catches the light. Rare, bright, one texel wide.
  const glint = beadFine > 0.955 ? 0.10 : 0;
  const base = 1 + speckle + glint + scuff * 0.30 * (0.25 + wear);
  const value = base * (1 - 0.80 * wear);
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * RGBA bytes for the paint tile, row-major, `PAINT_MAP_RESOLUTION` square.
 * The channel values are sRGB-encoded because the texture is sampled as colour.
 */
export function buildPaintMapRGBA(resolution = PAINT_MAP_RESOLUTION) {
  const n = Math.max(4, Math.round(resolution));
  const data = new Uint8Array(n * n * 4);
  let sumLinear = 0;
  let minLinear = 1;
  let maxLinear = 0;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const linear = paintSurfaceValue((x + 0.5) / n, (y + 0.5) / n);
      sumLinear += linear;
      if (linear < minLinear) minLinear = linear;
      if (linear > maxLinear) maxLinear = linear;
      // Intact paint is exactly neutral, so a texel at full value multiplies
      // the palette tint by 1 and nothing else. Where the paint is thin what
      // shows through is binder and road, which is warmer than the paint, so
      // the tilt is applied in proportion to the wear and vanishes at 1.0.
      const warmth = (1 - linear) * 0.12;
      const byte = (c) => Math.max(0, Math.min(255, Math.round(srgbEncode(c) * 255)));
      const i = (y * n + x) * 4;
      data[i] = byte(linear * (1 + warmth * 0.5));
      data[i + 1] = byte(linear);
      data[i + 2] = byte(linear * (1 - warmth));
      data[i + 3] = 255;
    }
  }
  return {
    data,
    width: n,
    height: n,
    meanLinear: sumLinear / (n * n),
    minLinear,
    maxLinear,
  };
}

/**
 * Integrated statistics of the shipped tile, so the palette above can be read
 * against the value the road actually renders: rendered paint = palette tint x
 * this mean. Computed once, lazily, and frozen.
 */
let paintMapStats = null;
export function getPaintMapStats() {
  if (!paintMapStats) {
    const image = buildPaintMapRGBA();
    paintMapStats = Object.freeze({
      resolution: image.width,
      meanLinear: image.meanLinear,
      minLinear: image.minLinear,
      maxLinear: image.maxLinear,
      bytes: image.data.length,
    });
  }
  return paintMapStats;
}

let paintTexture = null;

/**
 * The shared paint albedo tile. One texture for the whole city; it tiles every
 * `uvMetersPerRepeat.marking` metres of world, on the same world-XZ UVs the
 * marking layer already bakes, so it is continuous across every stripe.
 */
export function getPaintMapTexture() {
  if (paintTexture) return paintTexture;
  const image = buildPaintMapRGBA();
  const texture = new THREE.DataTexture(
    image.data, image.width, image.height, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  texture.name = 'street-surface-v2:paint-tile';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  paintTexture = texture;
  return paintTexture;
}

/** Drop the shared tile. Only a full teardown should call this. */
export function disposePaintMapTexture() {
  paintTexture?.dispose?.();
  paintTexture = null;
}

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

/**
 * Multiply a stored sRGB colour by a LINEAR factor.
 *
 * `scaleColor` scales the sRGB code value, which is not what "half as bright"
 * means: scaling an sRGB code by 0.7 is a linear factor of 0.45, and scaling
 * it by 0.5 is a linear factor of 0.22. Every place in this module that means
 * "this much of the light the surface underneath reflects" - paint wear, tyre
 * tracks - uses this instead, so the number in the source is the number the
 * renderer produces.
 */
function scaleLinearColor(rgb, factor) {
  const k = factor < 0 ? 0 : factor;
  return [
    clamp(srgbEncode(srgbToLinear(rgb[0]) * k), 0, 1),
    clamp(srgbEncode(srgbToLinear(rgb[1]) * k), 0, 1),
    clamp(srgbEncode(srgbToLinear(rgb[2]) * k), 0, 1),
  ];
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

/** Twice the area of the triangle - used as the degeneracy test. */
function doubleArea(p0, p1, p2) {
  const ax = p1.x - p0.x; const ay = p1.y - p0.y; const az = p1.z - p0.z;
  const bx = p2.x - p0.x; const by = p2.y - p0.y; const bz = p2.z - p0.z;
  return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
}

/**
 * Newell normal of a (possibly slightly non-planar, possibly tapered) quad.
 * Robust where `faceNormal(p0, p1, p3)` collapses because one corner of the
 * quad is degenerate - which happens on purpose wherever a ring strip tapers a
 * footway to zero width. Returns null only if all four points are collinear.
 */
function quadNormal(pts) {
  let nx = 0; let ny = 0; let nz = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}

// A triangle below this doubled area contributes no coverage and no shading; it
// is dropped so the buffers never carry a zero-area face whose winding is
// undefined (the self-check asserts there are none).
const MIN_DOUBLE_AREA = 1e-9;

function pushTriangle(layer, p0, p1, p2, color, ref) {
  if (!finite(p0.x + p0.y + p0.z + p1.x + p1.y + p1.z + p2.x + p2.y + p2.z)) return false;
  if (doubleArea(p0, p1, p2) < MIN_DOUBLE_AREA) return false;
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
 * getting the corner order backwards. A half that degenerates (a tapered strip
 * end) is skipped instead of being emitted as a zero-area face, so the buffers
 * carry only triangles with a well-defined winding.
 */
function pushQuad(layer, p0, p1, p2, p3, color, ref) {
  const pts = [p0, p1, p2, p3];
  for (const p of pts) {
    if (!finite(p.x) || !finite(p.y) || !finite(p.z)) return false;
  }
  let n = quadNormal(pts);
  if (!n) return false;
  let order = [0, 1, 2, 3];
  if (ref && (n.x * ref.x + n.y * ref.y + n.z * ref.z) < 0) {
    order = [0, 3, 2, 1];
    n = { x: -n.x, y: -n.y, z: -n.z };
  }
  const q = order.map((i) => pts[i]);
  const firstOk = doubleArea(q[0], q[1], q[2]) >= MIN_DOUBLE_AREA;
  const secondOk = doubleArea(q[0], q[2], q[3]) >= MIN_DOUBLE_AREA;
  if (!firstOk && !secondOk) return false;
  const base = layer.positions.length / 3;
  for (let i = 0; i < 4; i += 1) {
    pushVertex(layer, q[i], n, colorAt(color, order[i]));
  }
  if (firstOk) {
    layer.indices.push(base, base + 1, base + 2);
    layer.triangles += 1;
  }
  if (secondOk) {
    layer.indices.push(base, base + 2, base + 3);
    layer.triangles += 1;
  }
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
  const oneway = isOneway(segment);
  // LINE WIDTH IS THE HIERARCHY THE PAINT CAN CARRY. The number and the colour
  // of the lines are fixed by lane count and direction, so the only place the
  // street's CLASS can show on the road surface is the width of the stroke - an
  // arterial is restriped with a wider line than a residential block, and at
  // eye level that difference is what separates a through route from a side
  // street when the two meet. Rank 5 (secondary) and above get the wide stroke.
  const rank = streetClassRank(segment.highway ?? segment.className);
  const strokeScale = rank >= 6 ? 1.3 : rank >= 5 ? 1.15 : 1;
  const edgeU = Math.max(0.35, half - o.gutterWidth - 0.1);
  lines.push({ role: 'edge', u: edgeU, width: o.edgeLineWidth * strokeScale, dashed: false, paint: 'white' });
  lines.push({ role: 'edge', u: -edgeU, width: o.edgeLineWidth * strokeScale, dashed: false, paint: 'white' });
  if (oneway) {
    for (let j = 1; j < lanes; j += 1) {
      lines.push({
        role: 'divider',
        u: -half + (width * j) / lanes,
        width: o.laneLineWidth * strokeScale,
        dashed: true,
        paint: 'white',
      });
    }
    return lines;
  }
  if (lanes >= 4) {
    lines.push({ role: 'centre', u: o.centreLineGap / 2, width: o.centreLineWidth * strokeScale, dashed: false, paint: 'yellow' });
    lines.push({ role: 'centre', u: -o.centreLineGap / 2, width: o.centreLineWidth * strokeScale, dashed: false, paint: 'yellow' });
  } else {
    lines.push({ role: 'centre', u: 0, width: o.centreLineWidth * strokeScale, dashed: false, paint: 'yellow' });
  }
  const perSide = Math.max(1, Math.floor(lanes / 2));
  for (let j = 1; j < perSide; j += 1) {
    const u = (half * j) / perSide;
    lines.push({ role: 'divider', u, width: o.laneLineWidth * strokeScale, dashed: true, paint: 'white' });
    lines.push({ role: 'divider', u: -u, width: o.laneLineWidth * strokeScale, dashed: true, paint: 'white' });
  }
  return lines;
}

/**
 * ONE CROSSING FAMILY FOR THE WHOLE CITY (round 6). READ THIS BEFORE EDITING.
 *
 * Round 4 had two crossing generators with two different geometries: this
 * module painted signalised nodes with `floor(usable / 0.8)` bars, and
 * `src/render/passes/street-surface-detail.js` painted every other node with
 * `floor(usable / 0.85)` bars over a band whose depth changed with the node's
 * class. Both then rescaled the pitch to `usable / stripes`, so the ACTUAL bar
 * spacing came out different on every approach: measured at the junction the
 * hero cards stand on, the two 12.8 m legs got 14 bars at 0.871 m and the two
 * 6.4 m legs got 6 bars at 0.967 m - one node, two pitches. From a camera
 * standing in the box that is three or four bar fields at three or four angles
 * with three or four spacings, which is exactly what four of the five round-4
 * reviewers described.
 *
 * The pitch is now a CONSTANT. The bar count is whatever that constant fits
 * between the two kerb insets, and the field is centred on the approach axis
 * so the phase is symmetric about the centreline. Every crossing in the city
 * is therefore the same family, and both emitters call this one function.
 *
 * @param {number} half  half the approach carriageway width, metres
 * @param {object} o     resolved options
 * @returns {{ pitch, width, stripes: Array<{v, v0, v1}> }}
 */
export function planCrossingStripes(half, o) {
  const inset = o.crosswalkEdgeInset;
  const width = o.crossingStripeWidth;
  const pitch = Math.max(width + 0.15, o.crossingStripePitch);
  const usable = Math.max(0, half * 2 - inset * 2);
  const count = Math.max(o.crossingMinStripes, Math.floor((usable + (pitch - width)) / pitch));
  const span = count * pitch - (pitch - width);
  const stripes = [];
  for (let i = 0; i < count; i += 1) {
    const v = -span / 2 + width / 2 + i * pitch;
    if (Math.abs(v) + width / 2 > half - inset + 1e-6) continue;
    stripes.push({ v, v0: v - width / 2, v1: v + width / 2 });
  }
  return { pitch, width, stripes };
}

/**
 * Band depth of a marked crossing, from the class of the busiest street at the
 * node. Exported so the detail pass paints the same band this module does.
 */
export function crossingBandDepth(maxClassRank, o) {
  const base = o?.crosswalkBandDepth ?? STREET_SURFACE_V2_DEFAULTS.crosswalkBandDepth;
  if (maxClassRank >= 6) return base + 1.2;
  if (maxClassRank >= 5) return base + 0.6;
  return base;
}

/**
 * Does a junction carry marked crossings and stop lines at all?
 *
 * The rule lives here, not in the presentation pass, because the SURFACE has
 * to reserve the same zone the paint will occupy: the longitudinal lines have
 * to stop where the crossing starts, and this module lays the longitudinal
 * lines. Two readings of "does this node earn paint" would put the lane lines
 * back under the zebra, which is the round-4 defect.
 */
export function nodeEarnsJunctionPaint(signalised, degree, maxClassRank, footwayLegs) {
  if (signalised) return true;
  if (!(degree >= 3)) return false;
  if (!(maxClassRank >= 4)) return false;
  return footwayLegs >= 3;
}

// ---------------------------------------------------------------------------
// nodes and corners
// ---------------------------------------------------------------------------

/**
 * The one-way test, in one place.
 *
 * The shipped San Francisco slice writes `oneway` as `'increasing'`,
 * `'decreasing'` or `'both'`, not as a boolean. Round 4 had three different
 * readings of that field in this module: `planSegmentMarkings` understood the
 * directional strings, `makeApproach` did not, and `readSegmentContract` did.
 * The consequence was visible: every approach in the city reported
 * `oneway === false`, so a one-way street was given a half-width stop bar on
 * the wrong half and a stop bar at the end traffic LEAVES by. One reading now.
 */
function isOneway(segment) {
  const v = segment?.oneway;
  return v === true || v === 'yes' || v === 1 || v === '1'
    || v === 'increasing' || v === 'decreasing';
}

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
      // How much of each end the junction paint owns, so the longitudinal
      // lines stop at the stop line instead of running under the crossing.
      markingTrimStart: 0,
      markingTrimEnd: 0,
      // Arc-length spans this ribbon gives up to a higher-priority street it
      // crosses with no junction between them. See `planCarriagewayYield`.
      yieldSpans: [],
      walkYieldSpans: { left: [], right: [] },
      classRank: streetClassRank(segment.highway ?? segment.className),
      // The junction approach that owns each end, so the trim reconciliation
      // pass can write a corrected trim back into the approach the pad and the
      // curb ring are built from. Watertightness depends on those two numbers
      // being the same number, never two numbers that happen to agree.
      approachStart: null,
      approachEnd: null,
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
  const oneway = isOneway(entry.segment);
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
  for (const app of approaches) {
    if (app.atStart) app.entry.approachStart = app;
    else app.entry.approachEnd = app;
  }
  return { intersection: intersection || null, id, position, approaches, signalId, corners: [], paths: [] };
}

function collectNodes(city, entries, o) {
  const index = buildEndpointIndex(entries, o);
  const nodes = [];
  const consumed = new Set();
  for (const intersection of city?.intersections || []) {
    const p = intersection?.position;
    if (!p || !finite(Number(p.x)) || !finite(Number(p.z))) continue;
    const position = { x: Number(p.x), z: Number(p.z) };
    // An endpoint belongs to exactly ONE node. Two authored intersections
    // closer together than nodeSnap used to claim the same endpoints, and each
    // node then built its pad at its own trim while the segment was trimmed to
    // the larger of the two - which opens a gap the width of the difference.
    const items = queryEndpoints(index, position.x, position.z, o.nodeSnap)
      .filter((item) => !consumed.has(item));
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
 * Where the curb lines of two consecutive approaches (A then B going
 * counter-clockwise) would meet if they were not filleted, as distances along
 * each approach measured from the node centre. Pure geometry: it does not read
 * either approach's trim, so the same result drives both the decision of how
 * far to trim and the refit of the fillet once the trim is final.
 */
function cornerBase(position, A, B, o) {
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
  // The fillet radius is never allowed below the footway width the corner has
  // to carry. A radius shorter than the footway puts the arc centre INSIDE the
  // approach's paved corridor, the constant-width offset then folds back
  // through that centre, and the fold leaves a small unreachable lens behind
  // it. Keeping radius >= footway keeps the corner's inner edge a simple
  // curve that is tangent to both corridors instead.
  const walk = Math.max(A.widthCCW, B.widthCW);
  const room = Math.max(0.9 * Math.min(A.half, B.half) + 1.5, walk + 0.35);
  return {
    corner,
    sweep,
    baseA: (corner.x - position.x) * A.u.x + (corner.z - position.z) * A.u.z,
    baseB: (corner.x - position.x) * B.u.x + (corner.z - position.z) * B.u.z,
    nominalRadius: Math.min(Math.max(o.cornerRadius, walk + 0.35), room, 2.5 * o.cornerRadius),
  };
}

/**
 * Fillet that fits inside the trims the two approaches actually ended up with.
 * The radius is reduced until both tangent points sit at or before the trimmed
 * cross-section, which is what keeps the node boundary a simple, angularly
 * monotone ring around the node crown. When no radius fits, the caller falls
 * back to a straight curb chord - never to emitting nothing.
 */
function solveCornerArc(position, A, B, o) {
  const base = cornerBase(position, A, B, o);
  if (!base) return null;
  const halfAngle = base.sweep / 2;
  const slack = Math.min(A.trim - base.baseA, B.trim - base.baseB);
  if (!(slack > 0.12)) return null;
  const radius = Math.min(base.nominalRadius, slack * Math.tan(halfAngle));
  if (!(radius >= 0.4)) return null;
  const d = radius / Math.tan(halfAngle);
  const dA = base.baseA + d;
  const dB = base.baseB + d;
  if (!(dA > 0.05 && dB > 0.05)) return null;
  let bx = A.u.x + B.u.x;
  let bz = A.u.z + B.u.z;
  const bl = Math.hypot(bx, bz);
  if (bl < 1e-6) return null;
  bx /= bl; bz /= bl;
  const centreDist = radius / Math.sin(halfAngle);
  const centre = { x: base.corner.x + bx * centreDist, z: base.corner.z + bz * centreDist };
  return {
    centre,
    radius,
    ta: { x: base.corner.x + A.u.x * d, z: base.corner.z + A.u.z * d },
    tb: { x: base.corner.x + B.u.x * d, z: base.corner.z + B.u.z * d },
    dA,
    dB,
    corner: base.corner,
    sweep: base.sweep,
    bisector: { x: bx, z: bz },
  };
}

/**
 * Curb stations along the fillet, ordered ta -> tb. `out` is the unit direction
 * away from the road, i.e. toward the arc centre, which sits on the footway
 * side of the curb. Extra stations are inserted at the two kerb-ramp
 * boundaries so a ramp begins and ends on a real vertex instead of cutting a
 * strip in half.
 */
function arcStations(corner, o) {
  const a0 = Math.atan2(corner.ta.z - corner.centre.z, corner.ta.x - corner.centre.x);
  const a1 = Math.atan2(corner.tb.z - corner.centre.z, corner.tb.x - corner.centre.x);
  const delta = signedAngle(a1 - a0);
  const step = (o.cornerArcStepDeg * Math.PI) / 180;
  const count = clamp(Math.ceil(Math.abs(delta) / step), 2, 16);
  // ONE RAMP PER CROSSING, NOT ONE RAMP PER CORNER (round 6).
  //
  // Round 4 cut a single kerb ramp at the MIDDLE of every corner return, on
  // the corner bisector. The crossings are on the legs, so the ramp pointed
  // 45 degrees into the middle of the intersection box and served neither of
  // them: three of the five reviewers reported a tactile pad "with no
  // alignment to any crossing", and one measured the pad sitting on a raised
  // island with nothing under it. A real corner carries a perpendicular PAIR -
  // one ramp at each end of the return, each square to the crossing on its own
  // leg. The two ramps are therefore cut adjacent to the two tangent points,
  // where the arc is still parallel to that leg's kerb line, with a short run
  // of full-height kerb left at the tangent point for the flare to die into.
  //
  // A corner too tight to hold two ramps keeps the single mid-arc ramp, which
  // is the real diagonal ramp a tight corner is built with.
  const sweep = Math.abs(delta);
  const rampHalfAngle = Math.min(sweep * 0.34, (o.rampWidth / 2) / corner.radius);
  const hasRamp = rampHalfAngle > 0.02;
  const sign = delta >= 0 ? 1 : -1;
  const flare = Math.min(sweep * 0.12, Math.max(0.24, o.rampRun * 0.25) / corner.radius);
  const windows = [];
  if (hasRamp) {
    const pairSpan = 2 * (2 * rampHalfAngle + flare) + 0.5 * rampHalfAngle;
    if (sweep >= pairSpan) {
      for (const end of [0, 1]) {
        const centre = end === 0
          ? a0 + sign * (flare + rampHalfAngle)
          : a0 + delta - sign * (flare + rampHalfAngle);
        windows.push({
          lo: Math.min(centre - rampHalfAngle * sign, centre + rampHalfAngle * sign),
          hi: Math.max(centre - rampHalfAngle * sign, centre + rampHalfAngle * sign),
        });
      }
    } else {
      const mid = a0 + delta / 2;
      windows.push({
        lo: Math.min(mid - rampHalfAngle * sign, mid + rampHalfAngle * sign),
        hi: Math.max(mid - rampHalfAngle * sign, mid + rampHalfAngle * sign),
      });
    }
  }
  const angles = [];
  for (let i = 0; i <= count; i += 1) angles.push(a0 + (delta * i) / count);
  for (const w of windows) angles.push(w.lo, w.hi);
  angles.sort((p, q) => (delta >= 0 ? p - q : q - p));
  const stations = [];
  for (const ang of angles) {
    const last = stations[stations.length - 1];
    if (last && Math.abs(ang - last.ang) < 1e-6) continue;
    stations.push({
      ang,
      x: corner.centre.x + Math.cos(ang) * corner.radius,
      z: corner.centre.z + Math.sin(ang) * corner.radius,
      out: { x: -Math.cos(ang), z: -Math.sin(ang) },
      scale: 1,
    });
  }
  return {
    stations,
    // `ramp` stays the first window so nothing that only reads one breaks;
    // `ramps` is the real list and is what the curb ring and the detail pass's
    // detectable-warning pads iterate.
    ramp: windows[0] || null,
    ramps: windows,
  };
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
  // reconcileTrims() guarantees a run survives; only a genuinely sub-decimetre
  // source centreline lands here, and that carries no visible surface.
  if (s1 - s0 < 0.02) return;
  let stations = buildStations(points, cum, s0, s1, o.maxStep);
  if (stations.length < 2) return;
  // A ribbon that gives way to a busier street it crosses (see
  // `planCarriagewayYield`) is cut ON the corridor boundary, so the boundary
  // stations are spliced in before the strips are swept rather than the cut
  // being snapped to the nearest 6 m cross-section.
  {
    const extra = [];
    const cutLists = [entry.yieldSpans || []];
    if (entry.walkYieldSpans) {
      cutLists.push(entry.walkYieldSpans.left || [], entry.walkYieldSpans.right || []);
    }
    for (const list of cutLists) {
      for (const [ya, yb] of list) {
        for (const v of [ya, yb]) if (v > s0 + 1e-3 && v < s1 - 1e-3) extra.push(v);
      }
    }
    if (extra.length) {
      const merged = stations.concat(extra.map((v) => frameAt(points, cum, v, false)));
      merged.sort((a, b) => a.s - b.s);
      stations = [];
      for (const st of merged) {
        const last = stations[stations.length - 1];
        if (last && Math.abs(last.s - st.s) < 1e-4) continue;
        stations.push(st);
      }
    }
  }
  const spanKeep = [];
  let emittedRun = 0;
  for (let i = 0; i < stations.length - 1; i += 1) {
    const keep = !inYieldSpan(entry, (stations[i].s + stations[i + 1].s) / 2);
    spanKeep.push(keep);
    if (keep) emittedRun += stations[i + 1].s - stations[i].s;
  }
  if (!(emittedRun > 0.02)) return;
  stats.streetLengthMeters += emittedRun;
  stats.yieldedMeters += (s1 - s0) - emittedRun;

  const palette = o.colors;
  const asphaltHex = palette.asphalt[entry.segment.highway] || palette.asphalt.default;
  const jitter = 1 + (((hash32(entry.segment.id) % 41) - 20) / 1000); // +/-2%, deterministic
  const asphalt = scaleColor(hexToSrgb(asphaltHex), jitter);
  const gutterColor = hexToSrgb(palette.gutter);
  const curbFaceColor = hexToSrgb(palette.curbFace);
  const curbTopColor = hexToSrgb(palette.curbTop);
  const vergeColor = hexToSrgb(palette.verge || palette.sidewalk);
  // FOOTWAY TONE (round 3). The scored joints the detail pass adds read well,
  // but the slab BETWEEN them was one constant colour over the whole city:
  // measured on `01-street-day`, the footway region [850,700,1150,880] has an
  // Otsu separation of 9.0, i.e. a single population with no tonal life at all
  // across 54 000 pixels. Concrete is poured in lots, cures at different rates
  // and weathers unevenly, so the tone varies by street and along a street.
  //
  // Two deterministic scales, both hashes of source ids:
  //   * per STREET, +/-3.5%: two adjacent blocks are different pours;
  //   * per STATION, +/-2.5%: variation at the ~6 m station pitch, which is
  //     the scale a panel run of slabs actually varies at.
  // The 12 mm-lift paint and the detail-pass decals sit on top of this
  // unchanged, so nothing that already reads is disturbed.
  const sidewalkStreetJitter = 1
    + (((hash32(`walk:${entry.segment.streetId || entry.segment.id}`) % 71) - 35) / 1000);
  const sidewalkColor = scaleColor(hexToSrgb(palette.sidewalk), sidewalkStreetJitter);
  // The top of the bank is the cut edge of the concrete slab, not soil. Round 2
  // mixed only 35% of the way to the bank tone, which left the top of the bank
  // brighter than the ground it grades into; half-way keeps the bank reading as
  // a bank rather than as more footway.
  const slabEdgeColor = mixColor(sidewalkColor, vergeColor, 0.5);
  const walkToneAt = (index) => scaleColor(
    sidewalkColor,
    1 + (((hash32(`walk:${entry.segment.id}:${index}`) % 51) - 25) / 1000),
  );

  const offs = sectionOffsets(half, o);
  const datums = stations.map((st) => ctx.datum(st.x, st.z));

  // Cambered carriageway + gutter pans.
  for (let i = 0; i < stations.length - 1; i += 1) {
    if (!spanKeep[i]) continue;
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
    // The stretches of this side's kerb and footway that lie inside a busier
    // street's carriageway. See `planCarriagewayYield`: concrete does not lie
    // flat on somebody else's road.
    const walkGiven = (entry.walkYieldSpans
      && entry.walkYieldSpans[side > 0 ? 'left' : 'right']) || [];
    const walkDropped = (sv) => {
      for (let k = 0; k < walkGiven.length; k += 1) {
        if (sv >= walkGiven[k][0] && sv <= walkGiven[k][1]) return true;
      }
      return false;
    };
    for (let i = 0; i < stations.length - 1; i += 1) {
      if (!spanKeep[i]) continue;
      if (walkDropped((stations[i].s + stations[i + 1].s) / 2)) continue;
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
        const edgeYA = topA + o.curbTopFall + rise;
        const edgeYB = topB + o.curbTopFall + rise;
        // Per-station tone, and a slight film against the kerb where the
        // traffic side of the walk always dirties first.
        const walkA = walkToneAt(i);
        const walkB = walkToneAt(i + 1);
        const kerbA = scaleColor(walkA, 0.965);
        const kerbB = scaleColor(walkB, 0.965);
        pushQuad(layers.sidewalk,
          offsetPoint(A, backU, topA + o.curbTopFall),
          offsetPoint(B, backU, topB + o.curbTopFall),
          offsetPoint(B, outU, edgeYB),
          offsetPoint(A, outU, edgeYA),
          [kerbA, kerbB, walkB, walkA], UP);
        // The bank at the back of the footway. It starts on the SAME two
        // vertices the footway ends on, so the two surfaces cannot part.
        if (o.vergeReach > 0.05) {
          const groundA = dA - o.roadLift - o.groundSink;
          const groundB = dB - o.roadLift - o.groundSink;
          const footA = Math.max(groundA, edgeYA - o.vergeMaxDrop);
          const footB = Math.max(groundB, edgeYB - o.vergeMaxDrop);
          if (edgeYA - footA > 0.02 || edgeYB - footB > 0.02) {
            const vergeU = side * (half + walk + o.vergeReach);
            pushQuad(layers.verge,
              offsetPoint(A, outU, edgeYA),
              offsetPoint(B, outU, edgeYB),
              offsetPoint(B, vergeU, footB),
              offsetPoint(A, vergeU, footA),
              [slabEdgeColor, slabEdgeColor, vergeColor, vergeColor], UP);
          }
        }
      }
    }
  }

  // Paint. THE LONGITUDINAL LINES STOP WHERE THE JUNCTION PAINT STARTS.
  // `markingTrimStart/End` were reserved by `planNodePaint` from the same
  // trims and the same band depth the crossing is painted with, so a zebra can
  // never be laid over a lane line again, and the intersection box is left
  // clean.
  const hasStartNode = Boolean(entry.approachStart);
  const hasEndNode = Boolean(entry.approachEnd);
  const mStart = Math.max(s0, entry.markingTrimStart || 0);
  const mEnd = Math.min(s1, length - (entry.markingTrimEnd || 0));
  const lines = mEnd - mStart >= 1.0 ? planSegmentMarkings(entry.segment, o) : [];
  stats.markingLines += lines.length;
  const white = hexToSrgb(palette.markingWhite);
  const yellow = hexToSrgb(palette.markingYellow);
  // A street is repainted as a street, so its lines share an age; the edge
  // line then wears further than the centre line because it is the one that
  // sits in the grime at the gutter lip and under parked wheels, while a lane
  // divider lives BETWEEN the two wheel paths and is the last thing to go.
  const segAge = ((hash32(`repaint:${entry.segment.id}`) % 1000) / 1000) ** 1.3;
  for (const line of lines) {
    const base = line.paint === 'yellow' ? yellow : white;
    const exposure = line.role === 'edge' ? 1 : line.role === 'centre' ? 0.7 : 0.5;
    const color = scaleLinearColor(base, clamp(1 - 0.5 * segAge * exposure, 0.3, 1));
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
      let solids = 0;
      for (let i = 0; i < stations.length - 1; i += 1) {
        if (!spanKeep[i]) continue;
        const a = Math.max(stations[i].s, mStart);
        const b = Math.min(stations[i + 1].s, mEnd);
        if (b - a < 0.05) continue;
        emitSpan(
          Math.abs(a - stations[i].s) < 1e-6 ? stations[i] : frameAt(points, cum, a, false),
          Math.abs(b - stations[i + 1].s) < 1e-6 ? stations[i + 1] : frameAt(points, cum, b, false),
        );
        solids += 1;
      }
      stats.markingQuads += solids;
      continue;
    }
    // A DASHED DIVIDER GOES SOLID ON THE APPROACH. Lane changing is prohibited
    // for the last stretch before a junction, and the solid run is what makes
    // the approach read as an approach instead of as dashes that stop for no
    // reason. Only an end that actually has a node gets one.
    const cycle = o.dashMark + o.dashGap;
    let dashes = 0;
    const solidLo = hasStartNode ? Math.min(mStart + o.markingSolidApproach, mEnd) : mStart;
    const solidHi = hasEndNode ? Math.max(mEnd - o.markingSolidApproach, mStart) : mEnd;
    const emitRange = (a, b) => {
      if (b - a < 0.05) return false;
      if (inYieldSpan(entry, (a + b) / 2)) return false;
      emitSpan(frameAt(points, cum, a, false), frameAt(points, cum, b, false));
      return true;
    };
    if (hasStartNode && emitRange(mStart, solidLo)) dashes += 1;
    if (hasEndNode && emitRange(solidHi, mEnd)) dashes += 1;
    for (let s = solidLo; s < solidHi - 0.4; s += cycle) {
      const e = Math.min(s + o.dashMark, solidHi);
      if (e - s < 0.4) continue;
      if (emitRange(s, e)) dashes += 1;
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
  // allowMiter is deliberately true so this frame is the SAME frame
  // buildStations() opens the segment ribbon with, even when the trim happens
  // to land exactly on a polyline vertex. A mitred frame and an unmitred one
  // differ by the miter scale, and that difference is a crack.
  return frameAt(points, cum, clamp(s, 0, length), true);
}

/** +1 when the trimmed frame's normal points the same way as perpCCW(app.u). */
function frameSideCCW(app) {
  return app.atStart ? 1 : -1;
}

/**
 * One end of an approach's trimmed cross-section, at the curb line, described
 * the same way a corner station is: a point, the unit direction away from the
 * road, the miter scale that applies to offsets from it, and the footway width
 * that side of that segment carries. `ccw` picks the +perpCCW(u) side.
 */
function approachCurbStation(app, ccw, o) {
  const frame = approachEndFrame(app);
  const side = frameSideCCW(app) * (ccw ? 1 : -1);
  const raw = ccw ? app.widthCCW : app.widthCW;
  return {
    x: frame.x + frame.nx * side * app.half * frame.miter,
    z: frame.z + frame.nz * side * app.half * frame.miter,
    out: { x: side * frame.nx, z: side * frame.nz },
    scale: frame.miter,
    // A side whose footway is below minSidewalkWidth carries no curb on the
    // segment either, so the ring tapers to nothing there instead of ending in
    // mid-air.
    walk: raw >= o.minSidewalkWidth ? raw : 0,
  };
}

/**
 * Pass 1 for a junction: decide how far every approach carriageway is trimmed
 * back. This runs for every node before any geometry is emitted, because a
 * segment's ribbon and its paint need the trims at BOTH of its ends before
 * they can be laid out.
 */
function planJunction(node, o) {
  const approaches = node.approaches;
  const count = approaches.length;
  const want = approaches.map(() => 0);

  for (let i = 0; i < count; i += 1) {
    const app = approaches[i];
    // Clear of every other approach's carriageway.
    let base = app.half + 0.3;
    for (let j = 0; j < count; j += 1) {
      if (j !== i) base = Math.max(base, approaches[j].half + 0.3);
    }
    // Mouth separation. Two legs leaving the node at a shallow angle only
    // clear each other after half / tan(sweep/2) metres. Trimming short of
    // that leaves the two mouths overlapping and folds the pad boundary back
    // on itself, and a folded fan is a hole, not an overlap.
    const next = approaches[(i + 1) % count];
    const prev = approaches[(i - 1 + count) % count];
    const tight = count > 1
      ? Math.min(normAngle(next.angle - app.angle), normAngle(app.angle - prev.angle))
      : Math.PI;
    const halfSweep = clamp(tight / 2, 0.09, Math.PI / 2 - 1e-3);
    base = Math.max(base, Math.min(app.half / Math.tan(halfSweep), 4 * app.half + 6));
    want[i] = base;
  }

  // Room for the nominal fillet on both approaches of every corner.
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    if (i === j) continue;
    const geo = cornerBase(node.position, approaches[i], approaches[j], o);
    if (!geo) continue;
    const d = geo.nominalRadius / Math.tan(geo.sweep / 2);
    want[i] = Math.max(want[i], geo.baseA + d);
    want[j] = Math.max(want[j], geo.baseB + d);
  }

  for (let i = 0; i < count; i += 1) {
    const app = approaches[i];
    app.trim = clamp(want[i], 0.05, 0.45 * app.runLength);
    if (app.atStart) app.entry.trimStart = Math.max(app.entry.trimStart, app.trim);
    else app.entry.trimEnd = Math.max(app.entry.trimEnd, app.trim);
  }
}

/**
 * Pass 2, once every node has asked for its trims: make the two trims of a
 * segment fit inside the segment.
 *
 * A short block between two junctions can be asked for more trim than it is
 * long. Dropping such a segment - which is what a "too short to bother"
 * early-out does - removes the entire block surface and leaves the two pads
 * staring at each other across bare terrain. Scale both trims down together
 * instead, and write the corrected number back into the approach so the pad,
 * the curb ring and the ribbon all open at the same station.
 */
function reconcileTrims(entries) {
  for (const entry of entries) {
    const minRun = Math.min(0.5, 0.34 * entry.length);
    const total = entry.trimStart + entry.trimEnd;
    const budget = Math.max(0, entry.length - minRun);
    if (total > budget && total > 1e-9) {
      const k = budget / total;
      entry.trimStart *= k;
      entry.trimEnd *= k;
    }
    if (entry.approachStart) entry.approachStart.trim = entry.trimStart;
    if (entry.approachEnd) entry.approachEnd.trim = entry.trimEnd;
  }
}

/**
 * THE DRAWN CARRIAGEWAY MUST NOT LAP ITSELF (round 6). READ THIS BEFORE EDITING.
 *
 * Two authoritative centrelines can cross without an intersection record
 * between them - an alley crossing an arterial, a service road running through
 * a boulevard, a residential street that OSM traces straight across a trunk
 * road. `collectNodes` only ever joins ways that SHARE AN ENDPOINT, so at such
 * a crossing neither ribbon is trimmed and both are drawn in full, one over
 * the other.
 *
 * Measured on the shipped slice before this pass existed:
 *
 *   * 2.35% of the drawn carriageway carried two asphalt surfaces at once,
 *     18 344 samples over 899 clusters, worst vertical step 225 mm;
 *   * 2.97% of the drawn carriageway ALSO carried a footway or plaza surface,
 *     36 188 samples over 1073 clusters, and 90% of those were within 160 mm
 *     of the asphalt under them - a concrete slab lying flat on a road with no
 *     kerb face and no height step between them, which is what three of the
 *     five round-4 reviewers reported as "the two planes are coplanar" and "a
 *     stair-stepped zigzag seam";
 *   * the vehicle-grounding verifier measured 353 of 544 bodies straddling a
 *     step in the asphalt with a 72 mm worst case, and the traffic mirror's
 *     own datum was out by 71 mm at the same places.
 *
 * The construction rule is the one a real street follows: WHERE TWO PAVED
 * CORRIDORS OVERLAP AND NOTHING JOINS THEM, THE BUSIER STREET IS CONTINUOUS
 * AND THE OTHER ONE STOPS AT ITS EDGE. Priority is the contract's own class
 * rank, then carriageway width, then id - so the answer never depends on the
 * order the source happened to list the ways in.
 *
 * The loser's cross-section - carriageway, gutter, kerb, footway, verge and
 * paint - is dropped over the arc-length span where its centreline lies inside
 * the winner's PAVED corridor (half + footway), and the cut is bisected onto
 * the real boundary rather than snapped to the nearest 6 m station. The
 * footprint stays covered, because the winner paves it.
 *
 * WHAT THIS MOVES. `carriagewaySurfaceY` still returns the same number for a
 * given segment; what changes is which segment's surface is actually DRAWN at
 * a crossing. Anything that grounds by "nearest centreline wins" rather than
 * by sampling the drawn triangles will now disagree with the frame at these
 * 899 sites - src/citygen/traffic.js's `createStreetSurfaceSampler` picks the
 * nearest centreline and is the one to watch.
 */
function planCarriagewayYield(entries, nodes, o) {
  if (o.carriagewayYield === false) return { yielded: 0, yieldedMeters: 0 };
  // Which segments actually MEET this one at a junction. Two streets that meet
  // are resolved by the trims and the pad; only two that merely overlap are
  // this pass's business.
  const neighbours = new Map();
  for (const entry of entries) neighbours.set(entry.segment.id, new Set());
  for (const node of nodes || []) {
    for (const a of node.approaches) {
      const set = neighbours.get(a.entry.segment.id);
      if (!set) continue;
      for (const b of node.approaches) if (b !== a) set.add(b.entry.segment.id);
    }
  }
  const order = entries.slice().sort((a, b) => (
    (b.classRank - a.classRank)
    || (b.half - a.half)
    || String(a.segment.id).localeCompare(String(b.segment.id))
  ));
  // A corridor index that reports WHICH corridor covers a point, so a span can
  // be checked against the segment that actually took it.
  const cell = 24;
  const buckets = new Map();
  const edges = [];
  const addCorridor = (ax, az, bx, bz, half, id) => {
    const index = edges.push({ ax, az, bx, bz, half, id }) - 1;
    const minX = Math.min(ax, bx) - half;
    const maxX = Math.max(ax, bx) + half;
    const minZ = Math.min(az, bz) - half;
    const maxZ = Math.max(az, bz) + half;
    for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
      for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
        const key = `${gx}:${gz}`;
        const list = buckets.get(key);
        if (list) list.push(index); else buckets.set(key, [index]);
      }
    }
  };
  const coveredBy = (x, z, shrink) => {
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    let best = null;
    let bestDepth = 0;
    for (let j = -1; j <= 1; j += 1) {
      for (let i = -1; i <= 1; i += 1) {
        for (const index of buckets.get(`${gx + i}:${gz + j}`) || []) {
          const e = edges[index];
          const dx = e.bx - e.ax;
          const dz = e.bz - e.az;
          const len2 = dx * dx + dz * dz;
          let t = len2 > 1e-9 ? ((x - e.ax) * dx + (z - e.az) * dz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const depth = (e.half - shrink) - Math.hypot(x - (e.ax + dx * t), z - (e.az + dz * t));
          if (depth >= 0 && depth > bestDepth) { bestDepth = depth; best = e.id; }
        }
      }
    }
    return best;
  };
  // A SECOND INDEX, CARRIAGEWAY ONLY. The footway rule below is a different
  // question from the ribbon rule above and needs a different corridor: "is
  // this concrete lying on somebody's ROAD", not "is this ribbon inside
  // somebody's paved corridor".
  const roadCell = 24;
  const roadBuckets = new Map();
  const roadEdges = [];
  const addRoadway = (ax, az, bx, bz, half, owner, arc0) => {
    const index = roadEdges.push({ ax, az, bx, bz, half, owner, arc0 }) - 1;
    const minX = Math.min(ax, bx) - half;
    const maxX = Math.max(ax, bx) + half;
    const minZ = Math.min(az, bz) - half;
    const maxZ = Math.max(az, bz) + half;
    for (let gz = Math.floor(minZ / roadCell); gz <= Math.floor(maxZ / roadCell); gz += 1) {
      for (let gx = Math.floor(minX / roadCell); gx <= Math.floor(maxX / roadCell); gx += 1) {
        const key = `${gx}:${gz}`;
        const list = roadBuckets.get(key);
        if (list) list.push(index); else roadBuckets.set(key, [index]);
      }
    }
  };
  const onRoadway = (x, z) => {
    const gx = Math.floor(x / roadCell);
    const gz = Math.floor(z / roadCell);
    for (let j = -1; j <= 1; j += 1) {
      for (let i = -1; i <= 1; i += 1) {
        for (const index of roadBuckets.get(`${gx + i}:${gz + j}`) || []) {
          const e = roadEdges[index];
          const dx = e.bx - e.ax;
          const dz = e.bz - e.az;
          const len2 = dx * dx + dz * dz;
          const raw = len2 > 1e-9 ? ((x - e.ax) * dx + (z - e.az) * dz) / len2 : 0;
          const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
          // A margin inside the kerb line, not the kerb line itself: the drawn
          // carriageway edge is a chord between cross-sections and a mitred
          // frame moves it again at a bend, so a footway is only dropped where
          // it is WELL inside the other street's road rather than tangent to
          // it. Measured on the shipped slice, this is the difference between
          // a coverage bound met by 0.002 points and one met by 0.03.
          if (Math.hypot(x - (e.ax + dx * t), z - (e.az + dz * t)) > e.half - 0.35) continue;
          // ...AND THAT ROAD HAS TO ACTUALLY BE DRAWN HERE. A corridor is a
          // nominal band round a centreline; the ribbon inside it stops at
          // every junction trim and at every stretch the ribbon rule already
          // gave away. Dropping a footway over a stretch of road that is not
          // there is how this rule would open a hole instead of closing a
          // seam, so the winner's own trims and yield spans are checked before
          // its cover counts.
          const owner = e.owner;
          if (!owner) return true;
          // The UNCLAMPED projection, so a point that sits past the end of the
          // polyline lands outside the drawn arc range and is correctly read
          // as not covered. Clamping here is what made a corner beyond a
          // ribbon's own end look paved.
          const station = e.arc0 + Math.sqrt(len2) * raw;
          if (station < owner.trimStart - 0.05) continue;
          if (station > owner.length - owner.trimEnd + 0.05) continue;
          if (inYieldSpan(owner, station)) continue;
          return true;
        }
      }
    }
    return false;
  };
  let yielded = 0;
  let yieldedMeters = 0;
  for (const entry of order) {
    const reach = entry.half + Math.max(entry.walks.left, entry.walks.right);
    // THE CUT IS PULLED IN BY THE LOSER'S OWN PAVED HALF-REACH, AND THAT IS
    // WHAT KEEPS THE FOOTPRINT WATERTIGHT. The cut runs across the loser's
    // cross-section; the boundary it is cut at runs along the winner's edge.
    // At an oblique crossing those two lines are not parallel, so a cut taken
    // exactly on the winner's paved edge removes a wedge of the loser the
    // winner does not pave - a hole. Pulling the test in by a fraction of the
    // loser's own reach keeps the removed area inside pavement the winner is
    // laying anyway. `yieldClearFraction` is that fraction: 1 removes only
    // what is certainly covered, 0 removes everything that overlaps and opens
    // holes at skew crossings. Measured on the shipped slice, 0.4 is the
    // largest value that keeps the real-slice coverage bound and leaves no
    // uncovered sample further than 4 m from real pavement.
    const clear = reach * clamp(Number(o.yieldClearFraction) ?? 1, 0, 2);
    const at = (s) => frameAt(entry.points, entry.cum, clamp(s, 0, entry.length), false);
    const spans = [];
    const probeStep = Math.max(0.75, Math.min(2, entry.half + 0.5));
    let runStart = -1;
    let prevId = null;
    for (let s = 0; s <= entry.length + 1e-6; s += probeStep) {
      const p = Math.min(s, entry.length);
      const f = at(p);
      const id = coveredBy(f.x, f.z, clear);
      if (id && !prevId) runStart = p;
      if (!id && prevId) { spans.push([runStart, p, prevId]); runStart = -1; }
      prevId = id;
      if (p >= entry.length) break;
    }
    if (prevId && runStart >= 0) spans.push([runStart, entry.length, prevId]);
    const refine = (lo, hi, wantCovered) => {
      let a = lo;
      let b = hi;
      for (let i = 0; i < 12; i += 1) {
        const mid = (a + b) / 2;
        const f = at(mid);
        if (Boolean(coveredBy(f.x, f.z, clear)) === wantCovered) b = mid; else a = mid;
      }
      return (a + b) / 2;
    };
    for (const span of spans) {
      if (span[0] > 0) span[0] = refine(Math.max(0, span[0] - probeStep), span[0], true);
      if (span[1] < entry.length) span[1] = refine(span[1], Math.min(entry.length, span[1] + probeStep), false);
    }
    const s0 = entry.trimStart;
    const s1 = entry.length - entry.trimEnd;
    const mine = neighbours.get(entry.segment.id) || new Set();
    entry.yieldSpans = spans
      .filter(([a, b, id]) => {
        if (b - a < 1.0) return false;
        if (b <= s0 + 0.25 || a >= s1 - 0.25) return false;
        // A span that stops short of both ends of the centreline is a genuine
        // mid-block crossing: nothing at either end can be paving it.
        if (a > 0.25 && b < entry.length - 0.25) return true;
        // A span that runs out to an end is only this pass's business when the
        // covering street is not one this segment MEETS there. Where they do
        // meet, the node's trims and its pad own the geometry and cutting here
        // would remove ribbon the pad never reaches.
        //
        // MEASURED LIMIT OF THIS RULE. The remaining overlap on the shipped
        // slice is a DUPLICATE TRACING: a 3.2 m transit way drawn along the
        // whole length of a 12.8 m street and joined to it at a node at each
        // end (sf-seg-1135 / sf-seg-1136 / sf-seg-1137 is the worst of them).
        // Removing those was tried and rejected: the coverage sampler expects
        // every source centreline's own band to be paved, and the duplicate's
        // footway band reaches past the host street's pavement, so cutting it
        // opened uncovered ground more than 4 m from any pavement. Resolving a
        // duplicate centreline is a MAP-source question, not a presentation
        // one; this module will not delete a way the source insists exists.
        return !mine.has(id);
      })
      .map(([a, b]) => [a, b]);
    const kept = entry.yieldSpans;
    if (kept.length) {
      yielded += 1;
      for (const [a, b] of kept) yieldedMeters += Math.max(0, Math.min(b, s1) - Math.max(a, s0));
    }
    // NO FOOTWAY LIES FLAT ON SOMEBODY ELSE'S ROAD (round 6).
    //
    // The ribbon rule above cannot take out every overlap without opening
    // holes, and what survives it is the case the reviewers actually named:
    // measured before this rule, 2.97% of the drawn carriageway also carried a
    // concrete footway or plaza surface, and 90% of those samples were within
    // 160 mm of the asphalt under them - a slab lying on a road with no kerb
    // face and no height step, read by three of the five round-4 reviewers as
    // "the two planes are coplanar" and "a stair-stepped zigzag seam".
    //
    // A footway strip that lies inside a busier street's CARRIAGEWAY is
    // dropped. This one is watertight by construction and needs no pull-in:
    // the removed strip is inside a carriageway that is being drawn anyway, so
    // the same square metre is still paved - which is also why the coverage
    // sampler, whose footway probe is exactly the offset tested here, cannot
    // lose a sample to it.
    for (const side of [1, -1]) {
      const walk = side > 0 ? entry.walks.left : entry.walks.right;
      const spansW = [];
      if (walk >= o.minSidewalkWidth) {
        const lateral = side * (entry.half + walk * 0.5);
        const probeW = (sv) => {
          const f = frameAt(entry.points, entry.cum, clamp(sv, 0, entry.length), false);
          return onRoadway(f.x + f.nx * lateral * f.miter, f.z + f.nz * lateral * f.miter);
        };
        let runW = -1;
        let prevW = false;
        for (let sv = 0; sv <= entry.length + 1e-6; sv += probeStep) {
          const pv = Math.min(sv, entry.length);
          const hit = probeW(pv);
          if (hit && !prevW) runW = pv;
          if (!hit && prevW) { spansW.push([runW, pv]); runW = -1; }
          prevW = hit;
          if (pv >= entry.length) break;
        }
        if (prevW && runW >= 0) spansW.push([runW, entry.length]);
        const refineW = (lo, hi, want) => {
          let a = lo;
          let b = hi;
          for (let i = 0; i < 12; i += 1) {
            const mid = (a + b) / 2;
            if (probeW(mid) === want) b = mid; else a = mid;
          }
          return (a + b) / 2;
        };
        for (const span of spansW) {
          if (span[0] > 0) span[0] = refineW(Math.max(0, span[0] - probeStep), span[0], true);
          if (span[1] < entry.length) span[1] = refineW(span[1], Math.min(entry.length, span[1] + probeStep), false);
        }
      }
      entry.walkYieldSpans[side > 0 ? 'left' : 'right'] = spansW.filter(([a, b]) => b - a >= 0.5);
    }

    for (let i = 0; i < entry.points.length - 1; i += 1) {
      const a = entry.points[i];
      const b = entry.points[i + 1];
      addRoadway(a.x, a.z, b.x, b.z, entry.half, entry, entry.cum[i]);
    }

    // A WINNER CLAIMS ONLY WHAT IT CERTAINLY PAVES. The corridor this segment
    // offers as cover is its carriageway plus the NARROWER of its two
    // footways, because the wider side is the only one that would be claiming
    // pavement the other side does not have.
    const cover = entry.half + Math.max(0,
      Math.min(entry.walks.left, entry.walks.right) - CORNER_CLOSE_MARGIN);
    for (let i = 0; i < entry.points.length - 1; i += 1) {
      const a = entry.points[i];
      const b = entry.points[i + 1];
      addCorridor(a.x, a.z, b.x, b.z, cover, entry.segment.id);
    }
  }
  return { yielded, yieldedMeters };
}

/** Is arc length `s` inside one of the spans this ribbon gave away? */
function inYieldSpan(entry, s) {
  const spans = entry.yieldSpans;
  if (!spans || !spans.length) return false;
  for (let i = 0; i < spans.length; i += 1) {
    if (s >= spans[i][0] && s <= spans[i][1]) return true;
  }
  return false;
}

/**
 * Pass 2b: reserve the stretch of every approach that junction paint owns, so
 * the longitudinal markings can stop at it.
 *
 * Runs after `reconcileTrims`, because the zone is measured from the FINAL
 * trim, and before any geometry is emitted, because `emitSegment` lays the
 * lane lines. Writes:
 *
 *   node.earnsPaint          - one reading of "this junction is marked",
 *                              shared with the detail pass through
 *                              `nodeEarnsJunctionPaint`;
 *   node.bandDepth           - the crossing band depth for the whole node, so
 *                              four approaches cannot paint four depths;
 *   app.paintReach           - metres from the node the junction paint owns;
 *   entry.markingTrimStart/End - what `emitSegment` must keep clear.
 */
function planNodePaint(node, o) {
  const approaches = node.approaches;
  let maxRank = 0;
  let footwayLegs = 0;
  for (const app of approaches) {
    const rank = streetClassRank(app.entry.segment.highway ?? app.entry.segment.className);
    app.classRank = rank;
    if (rank > maxRank) maxRank = rank;
    if (rank >= 3 && Math.max(app.widthCCW, app.widthCW) >= o.minSidewalkWidth) footwayLegs += 1;
  }
  const signalised = node.signalId !== null && node.signalId !== undefined;
  node.maxClassRank = maxRank;
  node.earnsPaint = nodeEarnsJunctionPaint(signalised, approaches.length, maxRank, footwayLegs);
  node.bandDepth = crossingBandDepth(maxRank, o);
  for (const app of approaches) {
    // With paint: the pad edge, the crossing, and the gap in front of the stop
    // bar. Without: a short unmarked box only, so a bare node still reads as a
    // junction rather than as lane lines running into a blank plate.
    const reach = node.earnsPaint
      ? app.trim + o.crosswalkClearance + node.bandDepth + o.stopBarClearance
      : app.trim + o.markingBoxClearance;
    app.paintReach = reach;
    const entry = app.entry;
    if (app.atStart) entry.markingTrimStart = Math.max(entry.markingTrimStart || 0, reach);
    else entry.markingTrimEnd = Math.max(entry.markingTrimEnd || 0, reach);
  }
}

// A corner that closes on a street's footway edge EXACTLY is tangent to it,
// and a tangency is not a seal: one ULP the wrong way and a hairline of
// terrain shows through at grazing angles. Interior corner stations - never
// the two endpoints, which have to keep matching their ribbon - overshoot by
// this much so every corner closes with a real overlap.
const CORNER_CLOSE_MARGIN = 0.06;

/**
 * How far inward, from a corner curb station, the footway has to reach before
 * it is clear of one approach's own paved corridor. `ccw` picks the side of
 * that approach the corner is on. Returns 0 when the station is already
 * outside that corridor, or when the ray runs parallel to it.
 */
function cornerReach(position, app, ccw, station, cap) {
  const m = perpCCW(app.u);
  const sign = ccw ? 1 : -1;
  const lateral = ((station.x - position.x) * m.x + (station.z - position.z) * m.z) * sign;
  const rate = (station.out.x * m.x + station.out.z * m.z) * sign;
  if (!(rate > 1e-6)) return 0;
  const outer = app.half + (ccw ? app.widthCCW : app.widthCW);
  const reach = (outer - lateral) / rate + CORNER_CLOSE_MARGIN;
  if (!(reach > 0)) return 0;
  return Math.min(reach, cap);
}

/** Mitre of the two curb lines, when it falls inside both trimmed regions. */
function mitreStation(position, A, B) {
  const ma = perpCCW(A.u);
  const mb = perpCCW(B.u);
  const den = cross2(A.u, B.u);
  if (Math.abs(den) < 1e-4) return null;
  const a0 = { x: position.x + ma.x * A.half, z: position.z + ma.z * A.half };
  const b0 = { x: position.x - mb.x * B.half, z: position.z - mb.z * B.half };
  const t = cross2({ x: b0.x - a0.x, z: b0.z - a0.z }, B.u) / den;
  const k = { x: a0.x + A.u.x * t, z: a0.z + A.u.z * t };
  if (!finite(k.x) || !finite(k.z)) return null;
  const dA = (k.x - position.x) * A.u.x + (k.z - position.z) * A.u.z;
  const dB = (k.x - position.x) * B.u.x + (k.z - position.z) * B.u.z;
  if (!(dA > -1e-6 && dA <= A.trim + 1e-6 && dB > -1e-6 && dB <= B.trim + 1e-6)) return null;
  let ox = ma.x - mb.x;
  let oz = ma.z - mb.z;
  const ol = Math.hypot(ox, oz);
  if (ol < 1e-6) return null;
  return { x: k.x, z: k.z, out: { x: ox / ol, z: oz / ol }, scale: 1 };
}

/**
 * Interior stations for a corner no fillet fits.
 *
 * A single straight chord between the two trimmed cross-sections is only
 * correct when the two curb lines are genuinely collinear - the textbook
 * straight-through side of a T junction. As soon as the two streets differ in
 * width or in bearing, that chord cuts inside one approach's own curb line and
 * the footway offset from it falls short of that approach's outer footway
 * edge, for the whole length of the chord. That is a long, thin, wall-hugging
 * hole exactly where a pedestrian camera looks.
 *
 * So the chord is run through the curb-line mitre when one exists, subdivided,
 * and every interior station is widened until it clears BOTH approach
 * corridors. Where the two curb lines really are collinear every reach comes
 * back as the footway width itself and the result is the plain chord again.
 */
function chordPath(position, A, B, o, startStation, endStation) {
  const maxWalk = Math.max(startStation.walk, endStation.walk) + CORNER_CLOSE_MARGIN;
  if (!(maxWalk > 0)) return [];
  const cap = 2 * Math.max(A.half, B.half) + maxWalk + 1;
  const knots = [startStation];
  const mitre = mitreStation(position, A, B);
  if (mitre) {
    knots.push(mitre);
  } else if (normAngle(B.angle - A.angle) > (o.cornerMaxAngleDeg * Math.PI) / 180) {
    // Reflex or near-straight corner with no usable mitre: the two curb lines
    // never meet in front of the node, so the path has to run all the way in
    // along A's curb line, across the back of the node, and out along B's.
    // A single chord between the two trimmed cross-sections would cut that
    // whole wedge off and take both approaches' outer footway with it - the
    // wide-open back side of a junction whose legs all leave on one side.
    const ma = perpCCW(A.u);
    const mb = perpCCW(B.u);
    knots.push({ x: position.x + ma.x * A.half, z: position.z + ma.z * A.half, out: ma, scale: 1 });
    knots.push({ x: position.x - mb.x * B.half, z: position.z - mb.z * B.half, out: { x: -mb.x, z: -mb.z }, scale: 1 });
  }
  knots.push(endStation);
  const stations = [];
  for (let i = 0; i < knots.length - 1; i += 1) {
    const a = knots[i];
    const b = knots[i + 1];
    const steps = clamp(Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2), 1, 16);
    for (let k = 1; k <= steps; k += 1) {
      if (i === knots.length - 2 && k === steps) break; // the caller owns the last knot
      const t = k / steps;
      let ox = a.out.x + (b.out.x - a.out.x) * t;
      let oz = a.out.z + (b.out.z - a.out.z) * t;
      const ol = Math.hypot(ox, oz);
      if (ol < 1e-6) continue;
      ox /= ol; oz /= ol;
      const station = {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        out: { x: ox, z: oz },
        scale: 1,
        walk: maxWalk,
      };
      station.walk = Math.min(cap, Math.max(
        maxWalk,
        cornerReach(position, A, true, station, cap),
        cornerReach(position, B, false, station, cap),
      ));
      stations.push(station);
    }
  }
  return stations;
}

/**
 * Pass 3: with the trims final, build one continuous CURB PATH per corner.
 *
 * The path runs from the +perpCCW(u) curb vertex of approach A's trimmed
 * cross-section, back along A's curb line, round the fillet when one fits,
 * out along B's curb line and into the -perpCCW(u) curb vertex of approach B's
 * trimmed cross-section. Both ends ARE the segment ribbon's own end vertices,
 * so curb face, curb top and footway close against the segment exactly.
 *
 * This is what makes the surface watertight. The old code only ever emitted
 * the fillet arc itself, so it left two classes of hole:
 *   * every corner where the trim was longer than the tangent point (a wider
 *     cross street, an asymmetric pair of corners) lost the footway between
 *     the tangent point and the trimmed end; and
 *   * every corner with no fillet at all - most importantly the straight-
 *     through side of a T junction, where the sweep is ~180 degrees - lost the
 *     whole footway across the node while both segments were still trimmed
 *     back, which is a hole about 2 x trim long and a footway wide, sitting
 *     directly in front of a pedestrian-height camera.
 */
function finaliseJunction(node, o, stats) {
  const approaches = node.approaches;
  const count = approaches.length;
  node.corners = [];
  node.paths = [];
  for (let i = 0; i < count; i += 1) {
    const A = approaches[i];
    const B = approaches[(i + 1) % count];
    const corner = A === B ? null : solveCornerArc(node.position, A, B, o);
    node.corners.push(corner);
    const startStation = approachCurbStation(A, true, o);
    const endStation = approachCurbStation(B, false, o);
    const stations = [startStation];
    let ramp = null;
    let ramps = [];
    if (corner) {
      const arc = arcStations(corner, o);
      // Footway width ACROSS THE FILLET.
      //
      // The obvious choice - taper from A's width to B's - is wrong, and
      // wrong in a way that opens a crescent-shaped hole at every asymmetric
      // corner. The fillet centre sits at lateral (half + radius) from each
      // approach axis, so the un-paved pocket the ring leaves behind it begins
      // at lateral (half + arcWalk); any arcWalk below a street's own footway
      // width drags that pocket inside that street's paved corridor.
      //
      // So the corner is widened until it closes against BOTH approach
      // corridors: start from the wider of the two footways, then, at every
      // station, extend inward at least as far as the ray from that curb point
      // needs to travel to leave each approach's own footway band. That is a
      // corner flare, which is what a real corner has, and it is watertight by
      // construction rather than by luck.
      const arcWalk = Math.max(startStation.walk, endStation.walk) + CORNER_CLOSE_MARGIN;
      // Never past the arc centre: an inward offset larger than the radius
      // folds the strip through itself.
      const reachCap = Math.max(arcWalk, corner.radius);
      for (const st of arc.stations) {
        let walk = arcWalk;
        walk = Math.max(walk, cornerReach(node.position, A, true, st, reachCap));
        walk = Math.max(walk, cornerReach(node.position, B, false, st, reachCap));
        stations.push({ ...st, walk: Math.min(walk, reachCap) });
      }
      ramp = arc.ramp;
      ramps = arc.ramps || (arc.ramp ? [arc.ramp] : []);
      stats.corners += 1;
    } else {
      for (const st of chordPath(node.position, A, B, o, startStation, endStation)) stations.push(st);
      stats.cornerChords += 1;
    }
    stations.push(endStation);
    node.paths.push({ stations, ramp, ramps });
  }
}

/**
 * THE JUNCTION'S DATUM, TAKEN THE WAY THE RIBBON TAKES IT (round 7).
 *
 * `emitSegment` sweeps a whole cross-section - crown, gutter pan, kerb face,
 * kerb top, footway, bank - from ONE datum per CENTRELINE station:
 *
 *     const datums = stations.map((st) => ctx.datum(st.x, st.z));
 *
 * The junction used to take a datum PER VERTEX, at the vertex's own position:
 * `crossSectionY(ctx.datum(x, z), off, ...)` on the pad boundary,
 * `ctx.datum(st.x, st.z)` on every corner station and again inside
 * `emitCurbRing`. On a cross-grade those are two different surfaces, and they
 * part by (terrain cross-grade) x (lateral offset) at the exact vertex the pad
 * and the ribbon are supposed to share. Measured on the street-life fixture
 * before this change, INSIDE A SINGLE LAYER so no other surface can explain
 * it: a 246.8 mm step in the sidewalk over 0.10 m of ground at
 * (-328.3, -127.10) and a 239.8 mm step in the carriageway at (-326.0,
 * -127.10) - 0.06 cross-grade x 4.11 m lateral. The same street's carriageway
 * sampled ON the centreline through the same node stepped 0.4 mm.
 *
 * This returns the datum every part of one node is swept from:
 *
 *   * `approach[i]` - the datum of approach i's TRIMMED END FRAME, i.e. the
 *     identical number `emitSegment` opens that ribbon's first (or closes its
 *     last) cross-section with. Every pad-boundary vertex of that mouth and
 *     both curb stations of the two paths that meet it use it, so the pad, the
 *     curb ring and the ribbon share vertices by construction rather than by
 *     luck.
 *   * `path[i]` - one datum per station of corner path i, blended by
 *     CHORD LENGTH along the path from approach i's datum to approach
 *     i+1's. It is therefore exact at both ends (where the ring meets a
 *     ribbon) and smooth in between, which is what a real corner return is:
 *     the surface warps across the node instead of stepping.
 *
 * WHAT WOULD MAKE THIS WRONG. If `approachEndFrame` ever stopped being the
 * frame `buildStations` opens the ribbon on - a different arc length, a
 * different miter flag - the pad would part from the ribbon again by the
 * difference. `verify:street-surface-v2` measures that joint directly on the
 * drawn triangles; it does not model it.
 */
function junctionDatums(node, ctx) {
  const approaches = node.approaches;
  const approach = approaches.map((app) => {
    const frame = approachEndFrame(app);
    return ctx.datum(frame.x, frame.z);
  });
  const path = node.paths.map((p, i) => {
    const stations = p.stations;
    const a = approach[i];
    const b = approach[(i + 1) % approaches.length];
    let run = 0;
    const cum = [0];
    for (let k = 1; k < stations.length; k += 1) {
      run += Math.hypot(stations[k].x - stations[k - 1].x, stations[k].z - stations[k - 1].z);
      cum.push(run);
    }
    if (!(run > 1e-6)) return cum.map(() => a);
    return cum.map((c) => a + (b - a) * (c / run));
  });
  return { approach, path };
}

/** Pass 4: pad, curb ring, kerb ramps, crosswalks, stop bars. */
function emitJunction(node, layers, o, ctx, stats) {
  const palette = o.colors;
  const approaches = node.approaches;
  const count = approaches.length;
  const maxHalf = Math.max(...approaches.map((a) => a.half));
  const datums = junctionDatums(node, ctx);

  // Junction pad. The boundary is the closed curb line of the whole node:
  // every approach's full trimmed cross-section (so the pad shares vertices
  // with the carriageway ribbon rather than merely touching it) joined by the
  // corner paths. Each boundary vertex also carries the inward direction and
  // the run of its gutter, so the pad is built as a crown-to-lip cone plus a
  // real gutter channel that runs unbroken round the node and lines up with
  // the gutter pans of every approach - the pad used to be a bare cone with no
  // channel at all.
  const boundary = [];
  for (let i = 0; i < count; i += 1) {
    const app = approaches[i];
    const frame = approachEndFrame(app);
    const side = frameSideCCW(app);
    const offs = sectionOffsets(app.half, o);
    const gutterStart = Math.max(0, app.half - o.gutterWidth);
    // One datum for this whole mouth: the ribbon's own end-station datum.
    const datum = datums.approach[i];
    for (const off of offs) {
      const u = side * off;
      const x = frame.x + frame.nx * u * frame.miter;
      const z = frame.z + frame.nz * u * frame.miter;
      const edge = Math.abs(Math.abs(off) - app.half) < 1e-9;
      const sign = off === 0 ? 0 : Math.sign(off);
      boundary.push({
        x,
        z,
        datum,
        y: crossSectionY(datum, off, app.half, o),
        in: { x: -sign * side * frame.nx, z: -sign * side * frame.nz },
        run: edge ? (app.half - gutterStart) * frame.miter : 0,
        lipOff: gutterStart,
        half: app.half,
      });
    }
    const stations = node.paths[i].stations;
    const pathDatum = datums.path[i];
    for (let k = 1; k < stations.length - 1; k += 1) {
      const st = stations[k];
      boundary.push({
        x: st.x,
        z: st.z,
        datum: pathDatum[k],
        y: pathDatum[k] - o.gutterDepth,
        in: { x: -st.out.x, z: -st.out.z },
        run: o.gutterWidth,
        lipOff: null,
        half: null,
      });
    }
  }

  const junctionColor = hexToSrgb(palette.junction);
  const gutterColor = hexToSrgb(palette.gutter);
  const lipColor = mixColor(junctionColor, gutterColor, 0.45);
  const apexDatum = ctx.datum(node.position.x, node.position.z);
  // ONE CROWN RULE FOR THE WHOLE STREET (round 7). A ribbon crowns its
  // centreline at `crossSlope * half` above its datum; the pad apex used to be
  // crowned at `crossSlope * maxHalf * 0.6`, i.e. deliberately 40% short. The
  // pad and the ribbon it opens into therefore disagreed by
  // `crossSlope * half * 0.4` at the node - 51 mm modelled on the fixture's
  // 12.8 m avenue, and 42.5 mm measured under a car standing 0.56 m from a
  // node. The apex now carries the crown of the widest approach, which is the
  // crown a junction is really graded to: the major road runs through and the
  // minor road warps to meet it.
  const apex = { x: node.position.x, y: apexDatum + o.crossSlope * maxHalf, z: node.position.z };
  const lip = boundary.map((b) => {
    if (!(b.run > 1e-6)) return { x: b.x, y: b.y, z: b.z };
    return {
      x: b.x + b.in.x * b.run,
      z: b.z + b.in.z * b.run,
      // The gutter lip is `crossSlope * gutterWidth` above the datum on every
      // cross-section, whatever the half width, so the corner and the mouth
      // reach the same lip height from the same datum.
      y: b.lipOff === null
        ? b.datum + o.crossSlope * o.gutterWidth
        : crossSectionY(b.datum, b.lipOff, b.half, o),
    };
  });
  const before = layers.carriageway.triangles;
  let crownTriangles = 0;
  let gutterTriangles = 0;
  for (let i = 0; i < boundary.length; i += 1) {
    const j = (i + 1) % boundary.length;
    const t0 = layers.carriageway.triangles;
    pushTriangle(layers.carriageway, apex, lip[i], lip[j], [junctionColor, lipColor, lipColor], UP);
    const t1 = layers.carriageway.triangles;
    pushQuad(layers.carriageway,
      lip[i], lip[j],
      { x: boundary[j].x, y: boundary[j].y, z: boundary[j].z },
      { x: boundary[i].x, y: boundary[i].y, z: boundary[i].z },
      [lipColor, lipColor, gutterColor, gutterColor], UP);
    crownTriangles += t1 - t0;
    gutterTriangles += layers.carriageway.triangles - t1;
  }
  stats.junctionPads += 1;
  stats.junctionPadTriangles += layers.carriageway.triangles - before;
  stats.junctionCrownTriangles += crownTriangles;
  stats.junctionGutterTriangles += gutterTriangles;

  // Curb ring: curb face, curb top, footway and kerb ramps, continuous from
  // one approach cross-section round to the next.
  for (let i = 0; i < node.paths.length; i += 1) emitCurbRing(node.paths[i], datums.path[i], layers, o, stats);

  // Crosswalks and stop bars.
  if (node.signalId !== null && node.signalId !== undefined) {
    for (const app of approaches) emitApproachPaint(node, app, layers, o, ctx, stats);
  }
}

/**
 * Curb face + curb top + footway (or kerb ramp + footway) swept along one
 * corner path. Offsets are measured inward from the curb line along each
 * station's own `out` direction and scaled by that station's miter, which is
 * exactly how emitSegment lays out the same three strips, so the two meet
 * vertex for vertex.
 *
 * `datums` is one datum per station, from `junctionDatums` - the ribbon's own
 * end-station datum at each end of the path, blended by chord length in
 * between. It is NOT sampled under the station: a curb station stands
 * `half + radius` metres off every centreline, so a datum taken there parts
 * from the ribbon's by the terrain's cross-grade times that offset, which is
 * the 246.8 mm step this ring used to open in the sidewalk layer at a corner.
 */
function emitCurbRing(path, datums, layers, o, stats) {
  const stations = path.stations;
  if (stations.length < 2) return;
  let maxWalk = 0;
  for (const st of stations) maxWalk = Math.max(maxWalk, st.walk);
  if (!(maxWalk >= o.minSidewalkWidth)) return;

  const palette = o.colors;
  const curbFaceColor = hexToSrgb(palette.curbFace);
  const curbTopColor = hexToSrgb(palette.curbTop);
  const sidewalkColor = hexToSrgb(palette.sidewalk);
  const rampColor = hexToSrgb(palette.ramp);
  const rampReach = o.curbTopWidth + o.rampRun;

  const prepared = stations.map((st, i) => {
    const datum = datums[i];
    const scale = finite(st.scale) && st.scale > 0 ? st.scale : 1;
    const top = curbTopY(datum, o);
    const curbTop = Math.min(o.curbTopWidth, st.walk);
    return {
      st,
      top,
      invert: datum - o.gutterDepth,
      curbTop,
      rampBack: rampReach,
      rampable: st.walk > rampReach + 0.05,
      at: (dist, y) => ({ x: st.x + st.out.x * dist * scale, y, z: st.z + st.out.z * dist * scale }),
      walkY: (dist) => top + o.curbTopFall + o.sidewalkCrossSlope * Math.max(0, dist - o.curbTopWidth),
    };
  });

  const rampWindows = path.ramps && path.ramps.length
    ? path.ramps
    : (path.ramp ? [path.ramp] : []);
  const spanRamped = (a, b) => {
    if (!rampWindows.length) return false;
    if (a.st.ang === undefined || b.st.ang === undefined) return false;
    if (!a.rampable || !b.rampable) return false;
    const mid = (a.st.ang + b.st.ang) / 2;
    for (const w of rampWindows) {
      if (mid > w.lo - 1e-9 && mid < w.hi + 1e-9) return true;
    }
    return false;
  };

  const flags = [];
  for (let i = 0; i < prepared.length - 1; i += 1) flags.push(spanRamped(prepared[i], prepared[i + 1]));

  let rampSpans = 0;
  for (let i = 0; i < prepared.length - 1; i += 1) {
    const a = prepared[i];
    const b = prepared[i + 1];
    if (Math.hypot(a.st.x - b.st.x, a.st.z - b.st.z) < 1e-6) continue;
    if (!flags[i]) {
      pushQuad(layers.curbFace,
        { x: a.st.x, y: a.invert, z: a.st.z },
        { x: b.st.x, y: b.invert, z: b.st.z },
        { x: b.st.x, y: b.top, z: b.st.z },
        { x: a.st.x, y: a.top, z: a.st.z },
        curbFaceColor,
        { x: -(a.st.out.x + b.st.out.x) / 2, y: 0, z: -(a.st.out.z + b.st.out.z) / 2 });
      pushQuad(layers.curbTop,
        { x: a.st.x, y: a.top, z: a.st.z },
        { x: b.st.x, y: b.top, z: b.st.z },
        b.at(b.curbTop, b.walkY(b.curbTop)),
        a.at(a.curbTop, a.walkY(a.curbTop)),
        curbTopColor, UP);
      pushQuad(layers.sidewalk,
        a.at(a.curbTop, a.walkY(a.curbTop)),
        b.at(b.curbTop, b.walkY(b.curbTop)),
        b.at(b.st.walk, b.walkY(b.st.walk)),
        a.at(a.st.walk, a.walkY(a.st.walk)),
        sidewalkColor, UP);
    } else {
      // THE KERB DOES NOT VANISH AT A RAMP - IT IS DEPRESSED (round 6).
      //
      // Round 4 dropped the curb face entirely across a ramp span, so the kerb
      // line simply stopped for 1.6 m at every corner and the carriageway met
      // the concrete as a colour change with no vertical face. Three of the
      // five reviewers reported exactly that, one of them as "the two planes
      // are coplanar". A real depressed kerb keeps a low face across the ramp
      // - a 20-25 mm lip is what a wheel and a white stick both find - so the
      // kerb line is continuous the whole way round the corner.
      //
      // The lip goes in the RAMP layer, not `curbFace`: the surface contract
      // says a `curbFace` triangle is a FULL-height kerb, and the verifier
      // asserts no curb face collapses to less than half its declared height.
      // Same material, same tone, different declared meaning.
      const lipA = a.invert + o.rampLipHeight;
      const lipB = b.invert + o.rampLipHeight;
      if (o.rampLipHeight > 1e-4) {
        pushQuad(layers.ramp,
          { x: a.st.x, y: a.invert, z: a.st.z },
          { x: b.st.x, y: b.invert, z: b.st.z },
          { x: b.st.x, y: lipB, z: b.st.z },
          { x: a.st.x, y: lipA, z: a.st.z },
          curbFaceColor,
          { x: -(a.st.out.x + b.st.out.x) / 2, y: 0, z: -(a.st.out.z + b.st.out.z) / 2 });
      }
      pushQuad(layers.ramp,
        { x: a.st.x, y: lipA + o.rampLift, z: a.st.z },
        { x: b.st.x, y: lipB + o.rampLift, z: b.st.z },
        b.at(b.rampBack, b.walkY(b.rampBack)),
        a.at(a.rampBack, a.walkY(a.rampBack)),
        rampColor, UP);
      pushQuad(layers.sidewalk,
        a.at(a.rampBack, a.walkY(a.rampBack)),
        b.at(b.rampBack, b.walkY(b.rampBack)),
        b.at(b.st.walk, b.walkY(b.st.walk)),
        a.at(a.st.walk, a.walkY(a.st.walk)),
        sidewalkColor, UP);
      rampSpans += 1;
    }
  }

  // Ramp flares close the curb where the ramp cuts through it.
  for (let i = 1; i < flags.length; i += 1) {
    if (flags[i] === flags[i - 1]) continue;
    const s = prepared[i];
    const prev = prepared[i - 1].st;
    const next = prepared[i + 1].st;
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    const dir = flags[i] ? -1 : 1;
    tx = (tx / tl) * dir;
    tz = (tz / tl) * dir;
    pushQuad(layers.ramp,
      { x: s.st.x, y: s.invert + o.rampLipHeight, z: s.st.z },
      { x: s.st.x, y: s.top, z: s.st.z },
      s.at(s.curbTop, s.walkY(s.curbTop)),
      s.at(s.rampBack, s.walkY(s.rampBack)),
      rampColor, { x: tx, y: 0, z: tz });
  }

  stats.cornerRings += 1;
  if (rampSpans > 0) stats.ramps += 1;
  stats.rampStrips += rampSpans;
}

/**
 * How hard the wheel paths scrub a point `v` metres off the approach
 * centreline, in [0, 1]. Two tracks per lane at the real 1.64 m track width,
 * each about 0.3 m wide with a soft shoulder, which is why the stripes of a
 * crossing wear in a comb pattern rather than evenly.
 *
 * Exported so a verifier can assert the comb without reading a buffer.
 */
export function wheelTrackWeight(v, half, lanes) {
  const laneCount = Math.max(1, Math.round(lanes) || 1);
  const laneWidth = (half * 2) / laneCount;
  let worst = 0;
  for (let k = 0; k < laneCount; k += 1) {
    const centre = -half + laneWidth * (k + 0.5);
    for (const track of [-0.82, 0.82]) {
      const d = Math.abs(v - (centre + track));
      // 1 in the middle of the track, 0 beyond 0.42 m, smooth between.
      const t = clamp(1 - d / 0.42, 0, 1);
      const w = t * t * (3 - 2 * t);
      if (w > worst) worst = w;
    }
  }
  return worst;
}

function emitApproachPaint(node, app, layers, o, ctx, stats) {
  const palette = o.colors;
  const crosswalkColor = hexToSrgb(palette.crosswalk);
  const white = hexToSrgb(palette.markingWhite);
  // Repainting is a per-junction event, so every mark at one node shares an
  // age. 0 = repainted last month, 1 = overdue.
  const nodeAge = ((hash32(`repaint:${node.id}`) % 1000) / 1000) ** 1.3;
  const u = app.u;
  const m = perpCCW(u);
  const half = app.half;
  const available = app.runLength - (app.atStart ? app.entry.trimEnd : app.entry.trimStart);
  const bandStart = app.trim + o.crosswalkClearance;
  const bandEnd = bandStart + (node.bandDepth ?? o.crosswalkBandDepth);
  if (bandEnd + 0.4 > available) return;
  // JUNCTION PAINT FOLLOWS THE CENTRELINE, NOT A RAY (round 3).
  //
  // Rounds 1 and 2 placed every zebra band and stop bar with a straight
  // extrapolation from the node position along the approach direction. That is
  // exact only while the approach is straight: on a bent polyline the paint
  // drifts sideways at the rate the centreline turns, and a band 3-6 m from
  // the node on a curving approach walks off the carriageway and onto the
  // footway. Measured across the real slice, 279 of 22 269 junction-paint
  // vertices (1.25%) landed outside every carriageway band and every junction
  // pad before this change.
  //
  // The paint is now laid on the approach's OWN station frame, the same one
  // the carriageway cross-sections are built on, so it follows the road it is
  // painted on by construction. `v` is measured on the approach axis, so it
  // flips sign at an end approach, where u is the reversed tangent.
  const lateralSign = app.atStart ? 1 : -1;
  const stationFor = (d) => (app.atStart ? d : app.entry.length - d);
  const straightAt = (d, v) => ({
    x: node.position.x + u.x * d + m.x * v,
    z: node.position.z + u.z * d + m.z * v,
    datum: ctx.datum(node.position.x + u.x * d, node.position.z + u.z * d),
  });
  const at = (d, v) => {
    const entry = app.entry;
    if (!entry || !entry.points || entry.points.length < 2) return straightAt(d, v);
    const st = frameAt(entry.points, entry.cum, clamp(stationFor(d), 0, entry.length), true);
    const lat = v * lateralSign;
    return {
      x: st.x + st.nx * lat * st.miter,
      z: st.z + st.nz * lat * st.miter,
      // THE PAINT TAKES THE ROAD'S DATUM, NOT THE GROUND UNDER THE STRIPE.
      // A zebra bar reaches `half` metres off the centreline; sampling the
      // terrain at the bar's own corner put the outer end of every band on a
      // different surface from the asphalt it is painted on, by the cross-grade
      // times that offset. It is the same defect as the pad boundary's, and it
      // is why a crossing could sit proud of the road at one end. The datum is
      // now the one the carriageway cross-section at this station was swept
      // from, so the paint rides the road by construction.
      datum: ctx.datum(st.x, st.z),
    };
  };
  const yAt = (p, v) => crossSectionY(p.datum, v, half, o) + o.junctionPaintLift;

  // Zebra band, bars parallel to the approach axis, aligned to the approach.
  // The bar width and the bar pitch come from `planCrossingStripes`, which is
  // the ONE crossing family in this repo: the detail pass paints unsignalised
  // nodes from the same function, so a node can no longer carry two spacings.
  const family = planCrossingStripes(half, o);
  const laneCount = Math.max(1, Math.round(Number(app.entry.segment.lanes) || 2));
  for (let i = 0; i < family.stripes.length; i += 1) {
    const { v, v0, v1 } = family.stripes[i];
    const p00 = at(bandStart, v0);
    const p01 = at(bandStart, v1);
    const p10 = at(bandEnd, v0);
    const p11 = at(bandEnd, v1);
    // WHY EIGHT STRIPES MUST NOT BE THE SAME COLOUR (round 5).
    //
    // The stripes of a continental crossing run PARALLEL to the traffic that
    // crosses them, so a wheel path lies along a stripe rather than across it
    // and scrubs that whole stripe while leaving its neighbour intact. Round 4
    // painted every stripe one value and card 01 measured the result: eight
    // means inside 230.2-232.3 sRGB, a 0.9% spread, which is a printed decal.
    // Three independent terms now separate them - the junction's repaint age,
    // a per-stripe jitter for the strip-by-strip way a crew repaints, and the
    // comb of the wheel paths.
    const jitter = (hash32(`stripe:${node.id}:${app.entry.segment.id}:${i}`) % 1000) / 1000;
    const age = clamp(nodeAge * (0.62 + jitter * 0.72), 0, 1);
    const track = wheelTrackWeight(v, half, laneCount);
    const wear = clamp(1 - 0.52 * age - 0.42 * track, 0.18, 1);
    const stripeColor = scaleLinearColor(crosswalkColor, wear);
    pushQuad(layers.crosswalk,
      { x: p00.x, y: yAt(p00, v0), z: p00.z },
      { x: p10.x, y: yAt(p10, v0), z: p10.z },
      { x: p11.x, y: yAt(p11, v1), z: p11.z },
      { x: p01.x, y: yAt(p01, v1), z: p01.z },
      stripeColor, UP);
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
  // A one-way approach stops across its whole width; a two-way approach stops
  // only on the half its own traffic is on. `app.oneway` now reads the
  // contract's directional strings (see `isOneway`), which is what makes this
  // distinction real on the shipped slice instead of always taking the
  // two-way branch.
  const vLo = app.oneway ? -half + o.stopBarEdgeInset : Math.min(0, stopSign * (half - o.stopBarEdgeInset));
  const vHi = app.oneway ? half - o.stopBarEdgeInset : Math.max(0, stopSign * (half - o.stopBarEdgeInset));
  const c00 = at(barStart, vLo);
  const c01 = at(barStart, vHi);
  const c10 = at(barEnd, vLo);
  const c11 = at(barEnd, vHi);
  // The stop bar is crossed by every wheel on the approach rather than lying
  // under one track, so it takes the junction's repaint age and an averaged
  // scrub instead of the comb.
  const barTrack = wheelTrackWeight((vLo + vHi) / 2, half, Math.max(1,
    Math.round(Number(app.entry.segment.lanes) || 2)));
  const barWear = clamp(1 - 0.48 * nodeAge - 0.22 * barTrack, 0.22, 1);
  pushQuad(layers.marking,
    { x: c00.x, y: yAt(c00, vLo), z: c00.z },
    { x: c10.x, y: yAt(c10, vLo), z: c10.z },
    { x: c11.x, y: yAt(c11, vHi), z: c11.z },
    { x: c01.x, y: yAt(c01, vHi), z: c01.z },
    scaleLinearColor(white, barWear), UP);
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
    junctionCrownTriangles: 0,
    junctionGutterTriangles: 0,
    corners: 0,
    cornerChords: 0,
    cornerRings: 0,
    ramps: 0,
    rampStrips: 0,
    crosswalkBands: 0,
    stopBars: 0,
    markingLines: 0,
    dashedLines: 0,
    markingQuads: 0,
    streetLengthMeters: 0,
    yieldedMeters: 0,
    yieldedSegments: 0,
    paths: 0,
    pathRuns: 0,
    pathSuppressedStations: 0,
    pathLengthMeters: 0,
    pathTriangles: 0,
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

// ---------------------------------------------------------------------------
// standalone pedestrian ways
// ---------------------------------------------------------------------------

/**
 * Uniform XZ index of paved corridors, so "is this point already paved?" is a
 * bucket lookup rather than a scan. Deterministic: insertion order only
 * affects performance, never the answer.
 */
function makeCorridorIndex(cell = 24) {
  const buckets = new Map();
  const edges = [];
  const add = (ax, az, bx, bz, half) => {
    const index = edges.length;
    edges.push({ ax, az, bx, bz, half });
    const minX = Math.min(ax, bx) - half;
    const maxX = Math.max(ax, bx) + half;
    const minZ = Math.min(az, bz) - half;
    const maxZ = Math.max(az, bz) + half;
    for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
      for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
        const key = `${gx}:${gz}`;
        const list = buckets.get(key);
        if (list) list.push(index); else buckets.set(key, [index]);
      }
    }
  };
  const covers = (x, z, extra = 0) => {
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    for (let j = -1; j <= 1; j += 1) {
      for (let i = -1; i <= 1; i += 1) {
        for (const index of buckets.get(`${gx + i}:${gz + j}`) || []) {
          const e = edges[index];
          const dx = e.bx - e.ax;
          const dz = e.bz - e.az;
          const len2 = dx * dx + dz * dz;
          let t = len2 > 1e-9 ? ((x - e.ax) * dx + (z - e.az) * dz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = e.ax + dx * t;
          const qz = e.az + dz * t;
          if (Math.hypot(x - qx, z - qz) <= e.half + extra) return true;
        }
      }
    }
    return false;
  };
  return { add, covers, get count() { return edges.length; } };
}

/**
 * Pave every pedestrian way that is not already under a street's own paving.
 *
 * Construction, deliberately minimal: a flat ribbon at the SAME level the
 * adjacent footway sits at (curb top plus the curb-top fall), with the same
 * graded bank at each edge that `emitSegment` gives the back of a footway, so
 * a plaza never ends in a cliff onto the ground carpet. No kerb, no camber, no
 * gutter and no paint: a pedestrian way has none of those.
 *
 * SUPPRESSION. Two ways a ribbon here would be wrong:
 *   1. an OSM footway that traces a street's own sidewalk - the street already
 *      paved it, and a second ribbon at the same height is a z-fight;
 *   2. two pedestrian ways that cross or run together - the same problem
 *      between two ribbons of this pass.
 * Both are handled the same way: a station is dropped when it falls inside an
 * already-paved corridor, roads first and then previously emitted paths, and
 * only runs of two or more surviving stations are emitted. Paths are processed
 * in sorted id order so the result does not depend on source ordering.
 *
 * @returns {void} writes into `layers` and `stats`
 */
function emitPedestrianWays(city, entries, layers, o, ctx, stats) {
  if (!o.pavePedestrianWays) return;
  const paved = makeCorridorIndex(24);
  for (const entry of entries) {
    const reach = entry.half + Math.max(entry.walks.left, entry.walks.right);
    for (let i = 0; i < entry.points.length - 1; i += 1) {
      const a = entry.points[i];
      const b = entry.points[i + 1];
      paved.add(a.x, a.z, b.x, b.z, reach);
    }
  }
  const pathSet = new Set(o.pedestrianHighways || []);
  const candidates = [];
  for (const segment of city?.segments || []) {
    if (!pathSet.has(segment?.highway)) continue;
    const points = dedupePoints(segment.points);
    if (points.length < 2) continue;
    const width = Number(segment.width);
    if (!finite(width) || width < o.pathMinWidth) continue;
    const cum = arcTable(points);
    const length = cum[cum.length - 1];
    if (!(length > 1.0)) continue;
    candidates.push({ segment, points, cum, length, half: clamp(width, o.pathMinWidth, o.pathMaxWidth) / 2 });
  }
  candidates.sort((a, b) => String(a.segment.id).localeCompare(String(b.segment.id)));

  const palette = o.colors;
  const pathBase = hexToSrgb(palette.path || palette.sidewalk);
  const vergeColor = hexToSrgb(palette.verge || palette.sidewalk);
  const trianglesBefore = layers.path.triangles + layers.verge.triangles;

  for (const candidate of candidates) {
    const { points, cum, length, half } = candidate;
    const stations = buildStations(points, cum, 0, length, o.maxStep);
    if (stations.length < 2) continue;
    const keep = stations.map((st) => !paved.covers(st.x, st.z, o.pathSuppressMargin));
    stats.pathSuppressedStations += keep.filter((k) => !k).length;
    // Per-way tone, deterministic: two adjacent plaza slabs are never the
    // same pour.
    const jitter = 1 + (((hash32(`path:${candidate.segment.id}`) % 61) - 30) / 1000);
    const tone = scaleColor(pathBase, jitter);
    const slabEdge = mixColor(tone, vergeColor, 0.5);
    let emittedRun = false;
    let runStart = -1;
    const runs = [];
    for (let i = 0; i <= keep.length; i += 1) {
      if (i < keep.length && keep[i]) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        if (i - runStart >= 2) runs.push([runStart, i - 1]);
        runStart = -1;
      }
    }
    for (const [lo, hi] of runs) {
      for (let i = lo; i < hi; i += 1) {
        const A = stations[i];
        const B = stations[i + 1];
        const dA = ctx.datum(A.x, A.z);
        const dB = ctx.datum(B.x, B.z);
        const yA = curbTopY(dA, o) + o.curbTopFall;
        const yB = curbTopY(dB, o) + o.curbTopFall;
        // Slight cross tone drift along the way, so a long plaza is not one
        // flat fill. Same magnitude as the footway's.
        const step = 1 + (((hash32(`path:${candidate.segment.id}:${i}`) % 41) - 20) / 1200);
        const slab = scaleColor(tone, step);
        pushQuad(layers.path,
          offsetPoint(A, -half, yA),
          offsetPoint(B, -half, yB),
          offsetPoint(B, half, yB),
          offsetPoint(A, half, yA),
          slab, UP);
        stats.pathLengthMeters += Math.hypot(B.x - A.x, B.z - A.z);
        emittedRun = true;
        if (o.vergeReach > 0.05) {
          const groundA = dA - o.roadLift - o.groundSink;
          const groundB = dB - o.roadLift - o.groundSink;
          const footA = Math.max(groundA, yA - o.vergeMaxDrop);
          const footB = Math.max(groundB, yB - o.vergeMaxDrop);
          if (yA - footA > 0.02 || yB - footB > 0.02) {
            for (const side of [1, -1]) {
              const edgeU = side * half;
              const bankU = side * (half + o.vergeReach);
              pushQuad(layers.verge,
                offsetPoint(A, edgeU, yA),
                offsetPoint(B, edgeU, yB),
                offsetPoint(B, bankU, footB),
                offsetPoint(A, bankU, footA),
                [slabEdge, slabEdge, vergeColor, vergeColor], UP);
            }
          }
        }
      }
      stats.pathRuns += 1;
    }
    if (!emittedRun) continue;
    stats.paths += 1;
    // Only now does this way become "already paved", so a way cannot suppress
    // its own stations.
    for (const [lo, hi] of runs) {
      for (let i = lo; i < hi; i += 1) {
        paved.add(stations[i].x, stations[i].z, stations[i + 1].x, stations[i + 1].z, half);
      }
    }
  }
  stats.pathTriangles = (layers.path.triangles + layers.verge.triangles) - trianglesBefore;
}

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

  // Four passes, in this order, because each needs the previous one to be
  // complete for EVERY node before it can be right for any node:
  //   1. planJunction   - how far each approach wants to be trimmed back
  //   2. reconcileTrims - make both trims of a segment fit inside the segment
  //   3. finaliseJunction - fit the fillets to the trims and build curb paths
  //   4. emitJunction   - pad, gutter channel, curb ring, ramps, paint
  for (const node of nodes) planJunction(node, o);
  reconcileTrims(entries);
  for (const node of nodes) planNodePaint(node, o);
  const yieldStats = planCarriagewayYield(entries, nodes, o);
  stats.yieldedSegments = yieldStats ? yieldStats.yielded : 0;
  for (const node of nodes) finaliseJunction(node, o, stats);
  for (const node of nodes) emitJunction(node, layers, o, ctx, stats);
  for (const name of STREET_SURFACE_V2_LAYERS) stats.intersectionTriangles += layers[name].triangles;

  for (const entry of entries) emitSegment(entry, layers, o, ctx, stats);

  // Pedestrian ways last: they need every road corridor to exist first so the
  // suppression test knows what is already paved.
  emitPedestrianWays(city, entries, layers, o, ctx, stats);

  let total = 0;
  for (const name of STREET_SURFACE_V2_LAYERS) {
    stats.triangles[name] = layers[name].triangles;
    total += layers[name].triangles;
    stats.nonFinite += auditLayer(layers[name]);
  }
  stats.trianglesTotal = total;
  // Pedestrian-way triangles are not street triangles: they are not measured
  // against `streetLengthMeters` and must not move `trianglesPer100m`, which
  // is the number the road budget is stated in.
  stats.segmentTriangles = total - stats.intersectionTriangles - stats.pathTriangles;
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
  //
  // The paint tile carries the variation that lives INSIDE the paint - bead
  // speckle, wear break-up and a ragged edge modulation - on the same world-XZ
  // UVs the marking layer bakes, so it is continuous across a stripe and
  // across the gap to the next one. Round 4 had no map here at all, which is
  // why one crossing measured a 0.9% spread across eight stripes. `maps.paint`
  // opts out (a caller that wants flat paint, e.g. a geometry-only test).
  const paintTexture = maps.paint === null ? null : (maps.paint || getPaintMapTexture());
  materials.markings = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: paintTexture,
    bumpMap: paintTexture,
    bumpScale: paintTexture ? 0.004 : 1,
    roughness: 0.58,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });

  // ENVIRONMENT CLASS (round 3). THIS IS NOT DECORATION.
  //
  // `CityRenderer.applyEnvironmentGrading` and the wet-weather grade only
  // touch materials that declare `userData.envClass`. Rounds 1 and 2 shipped
  // these three without one, so the largest surface in every frame received no
  // environment map, no `envMapIntensity`, and none of the rain response: on
  // `05-wet-street.png` the lower-left road measures an Otsu separation of 8.7
  // - one flat tone, no reflection, no darkening - on a card where drizzle was
  // genuinely applied and the sky and fog did change.
  //
  // The names come from `MATERIAL_CLASSES` in src/render/environment-ibl.js
  // via `classifyMaterialClass`; they are written literally here because a
  // world module must not import a render module, and
  // `scripts/verify/verify-street-surface-v2.mjs` asserts every one of them
  // against that module's own exported list, so a rename there fails here
  // rather than silently dropping the road out of the grader's set again.
  for (const [key, envClass] of Object.entries(STREET_SURFACE_V2_ENV_CLASSES)) {
    if (!materials[key]) continue;
    materials[key].name = `${STREET_SURFACE_V2_ID}:${key}`;
    materials[key].userData = { ...materials[key].userData, envClass };
  }

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

// ---------------------------------------------------------------------------
// streetscape plan
// ---------------------------------------------------------------------------
//
// Everything above this line builds the *paved surface*. The two presentation
// passes that dress that surface - `street-surface-detail` (paint, drainage,
// covers, wear, scored joints, ramp pads) and `street-furniture` (hydrants,
// meters, poles, bins, racks, shelters, trees) - need exactly the same street
// truth this module already derives, and they need it to AGREE with the
// surface to the millimetre:
//
//   * the same node set, so a crossing lands on a junction the surface
//     actually built a pad for;
//   * the same trims, so a stop bar is not painted inside a junction pad;
//   * the same corner fillets, so a kerb ramp pad lands on the ramp the curb
//     ring cut, and a corner bollard is not planted in the carriageway;
//   * the same cross-section heights, so nothing floats or sinks.
//
// Recomputing that in a pass would be a second source of truth, and a second
// source of truth is how a ramp pad ends up 40 cm off the ramp. So the plan is
// produced here, by the passes that already exist, and handed out read-only.
//
// The plan is PURE DATA: no THREE, no DOM, plain numbers only, so a node
// verifier can assert against the same object the browser renders from.

export const STREETSCAPE_PLAN_VERSION = 'streetscape-plan-v1';

/**
 * Street class ordering, low to high. Used for "who stops for whom", how much
 * paint an approach earns, and how heavily a footway is furnished.
 * Unknown classes land on `residential`, which is the safe middle.
 */
const STREET_CLASS_RANK = Object.freeze({
  path: 0, steps: 0, footway: 0, cycleway: 0, pedestrian: 0, corridor: 0, platform: 0,
  track: 1, service: 1, alley: 1, driveway: 1,
  living_street: 2, unclassified: 2,
  residential: 3,
  tertiary: 4, tertiary_link: 4,
  secondary: 5, secondary_link: 5,
  primary: 6, primary_link: 6,
  trunk: 7, trunk_link: 7, motorway: 8, motorway_link: 8,
});

export function streetClassRank(className) {
  const key = String(className || '').toLowerCase();
  const rank = STREET_CLASS_RANK[key];
  return Number.isFinite(rank) ? rank : 3;
}

/**
 * The street contract is written two ways in this repo. The canonical runtime
 * emits `highway` / `width` / `sidewalkW`; the pass-registry contract and the
 * docs use `className` / `asphaltWidth` / `sidewalkWidth`. Both are the SAME
 * authoritative field - accept either, prefer neither, and never write back.
 */
export function readSegmentContract(segment) {
  if (!segment || typeof segment !== 'object') return null;
  const points = dedupePoints(segment.points);
  if (points.length < 2) return null;
  const width = Number(segment.width ?? segment.asphaltWidth);
  if (!finite(width) || width <= 0.2) return null;
  const walkRaw = Number(segment.sidewalkW ?? segment.sidewalkWidth);
  const walk = finite(walkRaw) && walkRaw > 0 ? walkRaw : 0;
  const left = Number(segment.sidewalkLeft);
  const right = Number(segment.sidewalkRight);
  const className = String(segment.highway ?? segment.className ?? 'residential').toLowerCase();
  const lanes = Math.max(1, Math.round(Number(segment.lanes) || Math.max(1, Math.round(width / 3.2))));
  const oneway = segment.oneway === true || segment.oneway === 'yes' || segment.oneway === 1
    || segment.oneway === '1' || segment.oneway === 'increasing' || segment.oneway === 'decreasing';
  return {
    id: String(segment.id ?? ''),
    streetId: segment.streetId ?? null,
    streetName: String(segment.streetName ?? segment.name ?? ''),
    className,
    classRank: streetClassRank(className),
    width,
    lanes,
    oneway,
    sidewalkW: walk,
    sidewalkLeft: finite(left) && left >= 0 ? left : walk,
    sidewalkRight: finite(right) && right >= 0 ? right : walk,
    points,
    signalId: segment.signalId ?? null,
    intersectionId: segment.intersectionId ?? null,
  };
}

/**
 * A read-only shadow of the city expressed in the field names the surface
 * builder reads. The source city object and every object inside it are
 * untouched; each shadow segment keeps `source` so a pass can still report the
 * authoritative id it came from.
 */
export function normalizeCityForStreetscape(city) {
  const segments = [];
  const list = Array.isArray(city?.segments) && city.segments.length
    ? city.segments
    : Array.isArray(city?.streets) ? city.streets : [];
  for (let i = 0; i < list.length; i += 1) {
    const contract = readSegmentContract(list[i]);
    if (!contract) continue;
    if (!contract.id) contract.id = `street-${i}`;
    segments.push({
      ...contract,
      highway: contract.className,
      sidewalkW: contract.sidewalkW,
      source: list[i],
      sourceIndex: i,
    });
  }
  return {
    meta: city?.meta || {},
    segments,
    intersections: Array.isArray(city?.intersections) ? city.intersections : [],
    signals: Array.isArray(city?.signals) ? city.signals : [],
    blocks: Array.isArray(city?.blocks) ? city.blocks : [],
    buildings: Array.isArray(city?.buildings) ? city.buildings : [],
  };
}

/**
 * Footway surface height at lateral offset `u`, matching `emitSegment` exactly:
 * curb top at the curb line, a small fall across the curb top, then the
 * footway cross-fall away from the road. Anything a pass places on the footway
 * must sit on this, or it floats.
 */
export function sidewalkSurfaceY(datum, u, half, o) {
  const a = Math.abs(u);
  const top = curbTopY(datum, o);
  if (a <= half) return top;
  const back = half + o.curbTopWidth;
  if (a <= back) return top + o.curbTopFall * ((a - half) / Math.max(1e-6, o.curbTopWidth));
  return top + o.curbTopFall + o.sidewalkCrossSlope * (a - back);
}

/** Carriageway surface height at lateral offset `u`. Re-exported for passes. */
export function carriagewaySurfaceY(datum, u, half, o) {
  return crossSectionY(datum, u, half, o);
}

/** Curb-top height above the gutter invert, i.e. the exposed curb face. */
export function curbTopSurfaceY(datum, o) {
  return curbTopY(datum, o);
}

/**
 * Station frame on a plan segment's centreline at arc length `s`.
 * `{ x, z, nx, nz, tx, tz, miter }` - identical to what the ribbon is swept on.
 */
export function streetStationAt(planSegment, s, allowMiter = true) {
  const total = planSegment.length;
  return frameAt(planSegment.points, planSegment.cum, clamp(Number(s) || 0, 0, total), allowMiter !== false);
}

/** World point at arc length `s`, lateral offset `u`, height `y`. */
export function streetPointAt(planSegment, s, u, y) {
  return offsetPoint(streetStationAt(planSegment, s), u, y);
}

/**
 * The furnishable footway band of one side of a segment, as lateral offsets
 * from the centreline. `side` is +1 for the +n side (which carries
 * `sidewalkLeft`) and -1 for the -n side, matching the repo convention.
 *
 * `inner` is the back of the curb: the first station that is footway rather
 * than curb top. `outer` is the property line. `clear` is the pedestrian
 * through-route reserved at the property-line end, which nothing may occupy.
 */
export function sidewalkBand(planSegment, side, o, clearWidth = 1.05) {
  const walk = side > 0 ? planSegment.walks.left : planSegment.walks.right;
  if (!(walk >= o.minSidewalkWidth)) return null;
  const inner = planSegment.half + o.curbTopWidth;
  const outer = planSegment.half + walk;
  const usable = outer - inner;
  if (!(usable > 0.25)) return null;
  // A narrow footway keeps a proportional through-route rather than a fixed
  // one, otherwise a 2.3 m SF footway would have no furnishing zone at all.
  // 1.05 m is the practical minimum walking route; the proportional cap keeps
  // a 1.5 m footway from being fully consumed by its own clearance.
  const clear = Math.min(clearWidth, usable * 0.45);
  return {
    side,
    walk,
    inner,
    outer,
    usable,
    clear,
    furnishInner: inner + 0.12,
    furnishOuter: outer - clear,
  };
}

/**
 * The plan every streetscape pass builds from.
 *
 * It runs the surface builder's own first three passes - prepare, node
 * collection, trim planning, trim reconciliation, fillet fitting - and stops
 * before any geometry is emitted. The result is therefore the identical node
 * set, the identical trims and the identical corner arcs the paved surface was
 * built from, which is the whole point.
 *
 * Degenerate input is not an error: a null city, a city with no segments,
 * two-point segments, zero-width segments and a missing `signals` array all
 * produce a valid, empty-or-partial plan.
 *
 * @param {object} city
 * @param {object} [overrides] same keys as buildStreetSurfaceData.
 */
export function buildStreetscapePlan(city, overrides = {}) {
  const shadow = normalizeCityForStreetscape(city);
  const o = resolveStreetSurfaceOptions(city, overrides);
  const entries = prepareSegments(shadow, o);
  const nodes = collectNodes(shadow, entries, o);
  for (const node of nodes) planJunction(node, o);
  reconcileTrims(entries);
  for (const node of nodes) planNodePaint(node, o);
  planCarriagewayYield(entries, nodes, o);
  const throwaway = emptyStats();
  for (const node of nodes) finaliseJunction(node, o, throwaway);

  const byId = new Map();
  const segments = entries.map((entry) => {
    const plan = {
      id: entry.segment.id,
      source: entry.segment.source || null,
      streetId: entry.segment.streetId,
      streetName: entry.segment.streetName,
      className: entry.segment.className,
      classRank: entry.segment.classRank,
      lanes: entry.segment.lanes,
      oneway: entry.segment.oneway,
      width: entry.segment.width,
      half: entry.half,
      walks: entry.walks,
      points: entry.points,
      cum: entry.cum,
      length: entry.length,
      trimStart: entry.trimStart,
      trimEnd: entry.trimEnd,
      signalId: entry.segment.signalId ?? null,
      nodeStart: null,
      nodeEnd: null,
      entry,
    };
    byId.set(plan.id, plan);
    return plan;
  });

  const planNodes = nodes.map((node) => {
    const approaches = node.approaches.map((app) => {
      const planSegment = byId.get(app.entry.segment.id) || null;
      return {
        node: null,
        segmentId: app.entry.segment.id,
        segment: planSegment,
        atStart: app.atStart,
        // Unit direction pointing AWAY from the node, along the approach.
        u: { x: app.u.x, z: app.u.z },
        angle: app.angle,
        half: app.half,
        trim: app.trim,
        runLength: app.runLength,
        // Footway width on the +perpCCW(u) and -perpCCW(u) sides of `u`.
        walkCCW: app.widthCCW,
        walkCW: app.widthCW,
        oneway: app.oneway,
        flowsToward: app.flowsToward,
        classRank: planSegment ? planSegment.classRank : 3,
        className: planSegment ? planSegment.className : 'residential',
        lanes: planSegment ? planSegment.lanes : 2,
        // Arc length of the node end of this approach on its own segment.
        stationAtNode: app.atStart ? 0 : app.entry.length,
        // The station the paved ribbon actually opens at.
        stationAtMouth: app.atStart ? app.trim : app.entry.length - app.trim,
        raw: app,
      };
    });
    const signalId = node.signalId ?? null;
    const maxClassRank = approaches.reduce((m, a) => Math.max(m, a.classRank), 0);
    const minClassRank = approaches.reduce((m, a) => Math.min(m, a.classRank), 9);
    const planNode = {
      id: String(node.id),
      position: { x: node.position.x, z: node.position.z },
      signalId,
      // A node the surface builder already painted. Anything a pass adds at a
      // signalised node would land on top of that paint.
      signalised: signalId !== null && signalId !== undefined,
      inferred: String(node.id).startsWith('inferred:'),
      degree: approaches.length,
      maxClassRank,
      minClassRank,
      approaches,
      corners: node.corners.map((corner) => (corner ? {
        centre: { x: corner.centre.x, z: corner.centre.z },
        radius: corner.radius,
        ta: { x: corner.ta.x, z: corner.ta.z },
        tb: { x: corner.tb.x, z: corner.tb.z },
        bisector: { x: corner.bisector.x, z: corner.bisector.z },
        sweep: corner.sweep,
      } : null)),
      paths: node.paths,
      raw: node,
    };
    for (const app of approaches) {
      app.node = planNode;
      if (!app.segment) continue;
      if (app.atStart) app.segment.nodeStart = planNode;
      else app.segment.nodeEnd = planNode;
    }
    return planNode;
  });

  let streetLength = 0;
  for (const plan of segments) streetLength += Math.max(0, plan.length - plan.trimStart - plan.trimEnd);

  return {
    version: STREETSCAPE_PLAN_VERSION,
    options: o,
    city: shadow,
    segments,
    segmentById: byId,
    nodes: planNodes,
    stats: {
      sourceSegments: Array.isArray(city?.segments) ? city.segments.length : 0,
      segments: segments.length,
      nodes: planNodes.length,
      signalisedNodes: planNodes.filter((n) => n.signalised).length,
      inferredNodes: planNodes.filter((n) => n.inferred).length,
      streetLengthMeters: streetLength,
    },
  };
}

/** 32-bit FNV-1a over a string. Exported so passes hash ids the same way. */
export function streetHash32(value) {
  return hash32(value);
}

/**
 * Deterministic 0..1 stream seeded by a string. No Math.random anywhere in the
 * streetscape: two runs of the same city must produce identical buffers.
 */
export function streetRandom(seed) {
  let t = (hash32(seed) + 0x6d2b79f5) >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
