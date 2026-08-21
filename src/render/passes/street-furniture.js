// street-furniture - presentation pass.
//
// Owner: Terrain/streets. Contract: src/render/pass-registry.js.
//
// WHAT THIS FIXES
//
// At pedestrian eye level the shipped street has almost nothing on it. The
// legacy renderer places at most a couple of hundred props across a whole
// city and a single alternating tree line, so a hero frame contains no
// hydrant, no meter, no sign pole, no bollard, no bin, no rack, no news box,
// no shelter, no bench, no planter and no mailbox. An empty footway reads as a
// grey slab no matter how well the slab itself is built.
//
// This pass furnishes the footway city-wide from the street contract:
//
//   * every item is placed inside the footway band of the segment it claims,
//     between the back of the curb and a reserved pedestrian through-route,
//     and is rejected with a recorded reason when it does not fit;
//   * placement clusters the way a real street does - corners carry the sign
//     poles, the hydrant, the bollards and the news boxes; mid-block carries
//     meters, trees, bins and racks; a transit stop earns a shelter and a flag;
//   * nothing overlaps: items are tested against each other, against the
//     building footprints in the city contract, and against the props the
//     legacy renderer has ALREADY put in the world at build time, which are
//     read out of the scene graph rather than guessed at;
//   * street trees carry a real pit - soil and a cast grate - so a trunk never
//     grows straight out of a concrete slab.
//
// BUDGET. Items are instanced per (kind, level of detail) so a kind costs one
// draw call per level, and each item is assigned to a distance ring from
// `ctx.focus` that decides its level of detail and whether it exists at all.
// The QA capture path is a software GL backend, so the ring radii and the caps
// below are deliberately conservative; both the measurement and the cap are in
// the diagnostics this pass returns.
//
// Determinism: no Math.random, no Date.now. Every choice is a hash of a source
// id, so two builds of one city are bit-identical.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  buildStreetscapePlan,
  sidewalkBand,
  sidewalkSurfaceY,
  streetStationAt,
  streetRandom,
  streetHash32,
} from '../../world/streets/street-surface-v2.js';
import { surfaceOptionsFor, resolveFocus, windowRadius } from './street-surface-detail.js';

export const STREET_FURNITURE_ID = 'street-furniture';
export const STREET_FURNITURE_VERSION = 'street-furniture-v1';

/**
 * Distance rings from `ctx.focus`. `lod` selects the geometry variant.
 *
 * ROUND 2 CORRECTION - READ THIS BEFORE CHANGING A RADIUS.
 *
 * Round 1's outermost ring was 440 m and carried only five kinds. `ctx.focus`
 * is the camera position at the moment `CityRenderer.buildCity` runs, and the
 * app reframes the camera AFTER the build, so on the shipped route the focus
 * was the startup camera at (180, 260) while every quality-card pose was
 * 1450-1510 m away. Measured on the shipped slice, this pass placed EXACTLY
 * ZERO items in the entire city and all eight captured frames contained no
 * street furniture at all.
 *
 * A ring may therefore no longer decide whether an item EXISTS. The outer ring
 * has `radius: null`, which resolves to the whole loaded window, and it
 * carries every kind - only at a coarser level of detail and a wider spacing.
 * A wrong focus now costs geometry detail, never the street's contents. Two
 * tiers instead of three also halves the draw calls, which matters on the
 * software GL backend the captures run on.
 */
export const STREET_FURNITURE_RINGS = Object.freeze([
  Object.freeze({ id: 'near', radius: 120, lod: 0, pitchScale: 1, maxItems: 1400, maxTriangles: 130000, kinds: null }),
  // ROUND 3 BUDGET CHANGE, stated so it is not a silent drift. The window
  // tier's cap was 170 000 triangles and it was BINDING: the real slice
  // measured exactly 170 000 used, i.e. items were being dropped from the tail
  // to fit. Replacing the cone tree with a broadleaf costs 40 more triangles
  // per tree at this tier (36 -> 76), and at 630 trees that would have thrown
  // roughly 680 other pieces of furniture out of the city to pay for it -
  // trading street contents for tree quality, which is exactly the trade the
  // ring note above forbids. The cap is raised to hold both. The pass-wide
  // ceiling (STREET_FURNITURE_BUDGET.maxTriangles) is unchanged at 300 000 and
  // the measured total is still well inside it; the verifier asserts both.
  Object.freeze({ id: 'window', radius: null, lod: 1, pitchScale: 2.0, maxItems: 5200, maxTriangles: 205000, kinds: null }),
]);

/** Hard bounds on the resolved window radius, so an enormous map still ends. */
export const STREET_FURNITURE_WINDOW = Object.freeze({ minRadius: 600, maxRadius: 2600, margin: 140 });

export const STREET_FURNITURE_BUDGET = Object.freeze({
  maxTriangles: 300000,
  maxDrawCalls: 40,
  rings: STREET_FURNITURE_RINGS,
});

/**
 * Where in the footway band a kind belongs.
 *   curb     - the furnishing strip against the back of the curb
 *   mid      - the middle of a wide footway
 *   building - hard against the property line, and only if a wall is there
 */
const ZONES = Object.freeze({ CURB: 'curb', MID: 'mid', BUILDING: 'building' });

/**
 * The furniture catalogue. `radius` is the plan footprint used for the overlap
 * test, `minWalk` the narrowest footway the kind may stand on, `gap` the
 * along-street spacing when a run of this kind is laid out, and `weight` the
 * relative chance per street class rank band (service/residential/collector/
 * arterial).
 */
export const STREET_FURNITURE_KINDS = Object.freeze({
  hydrant: { zone: ZONES.CURB, radius: 0.34, depth: 0.22, minWalk: 1.3, gap: 70, height: 0.78, weight: [1, 2, 2, 2], corner: 3 },
  parkingMeter: { zone: ZONES.CURB, radius: 0.2, depth: 0.11, minWalk: 1.2, gap: 6.5, height: 1.25, weight: [0, 2, 5, 5], corner: 0 },
  payStation: { zone: ZONES.CURB, radius: 0.3, depth: 0.16, minWalk: 1.5, gap: 60, height: 1.5, weight: [0, 1, 2, 3], corner: 1 },
  signPole: { zone: ZONES.CURB, radius: 0.16, depth: 0.06, minWalk: 1.1, gap: 34, height: 2.6, weight: [1, 2, 2, 2], corner: 5 },
  bollard: { zone: ZONES.CURB, radius: 0.16, depth: 0.09, minWalk: 1.2, gap: 1.6, height: 0.92, weight: [1, 1, 1, 1], corner: 2 },
  wasteBin: { zone: ZONES.CURB, radius: 0.36, depth: 0.32, minWalk: 1.6, gap: 45, height: 0.94, weight: [1, 2, 3, 4], corner: 3 },
  bikeRack: { zone: ZONES.CURB, radius: 0.55, depth: 0.1, minWalk: 1.6, gap: 24, height: 0.9, weight: [0, 1, 3, 3], corner: 1 },
  newsBox: { zone: ZONES.CURB, radius: 0.32, depth: 0.22, minWalk: 1.6, gap: 1.0, height: 1.18, weight: [0, 1, 2, 3], corner: 3 },
  mailbox: { zone: ZONES.CURB, radius: 0.42, depth: 0.24, minWalk: 1.7, gap: 120, height: 1.2, weight: [0, 1, 2, 2], corner: 2 },
  tree: { zone: ZONES.CURB, radius: 0.62, depth: 0.55, minWalk: 1.8, gap: 11, height: 6.4, weight: [1, 5, 5, 4], corner: 0, through: 0.95 },
  planter: { zone: ZONES.MID, radius: 0.55, depth: 0.34, minWalk: 2.2, gap: 40, height: 0.8, weight: [0, 1, 2, 2], corner: 1 },
  bench: { zone: ZONES.MID, radius: 0.9, depth: 0.3, minWalk: 2.3, gap: 55, height: 0.86, weight: [0, 2, 2, 2], corner: 0 },
  transitShelter: { zone: ZONES.CURB, radius: 2.1, depth: 0.66, minWalk: 2.45, gap: 210, height: 2.6, weight: [0, 1, 2, 3], corner: 0, through: 0.9 },
  busStopFlag: { zone: ZONES.CURB, radius: 0.18, depth: 0.06, minWalk: 1.2, gap: 210, height: 2.9, weight: [0, 1, 2, 3], corner: 0 },
  standpipe: { zone: ZONES.BUILDING, radius: 0.22, depth: 0.12, minWalk: 1.6, gap: 34, height: 1.05, weight: [0, 2, 3, 4], corner: 0 },
  wallMeter: { zone: ZONES.BUILDING, radius: 0.18, depth: 0.1, minWalk: 1.4, gap: 26, height: 1.5, weight: [0, 3, 3, 3], corner: 0 },
});

export const STREET_FURNITURE_KIND_IDS = Object.freeze(Object.keys(STREET_FURNITURE_KINDS));

const PALETTE = Object.freeze({
  hydrantBody: '#b23a2c',
  hydrantCap: '#c9c6bd',
  meterPole: '#63676a',
  meterHead: '#8b9094',
  poleGrey: '#7c8083',
  signWhite: '#eae6dc',
  signRed: '#a8342a',
  signGreen: '#2f5f45',
  signBlue: '#2b4c78',
  bollardBlack: '#3c3f42',
  binGreen: '#3f5346',
  binGrey: '#6d6f6d',
  rackSteel: '#9aa0a4',
  newsBoxNeutral: '#c9ccce',
  newsBoxA: '#2f5d86',
  newsBoxB: '#8a5c2c',
  newsBoxC: '#6a6f73',
  mailboxBlue: '#2b4c78',
  benchWood: '#8a6440',
  benchFrame: '#4d5154',
  planterConcrete: '#b9b3a4',
  planterSoil: '#4a3d30',
  shelterGlass: '#9fb6c4',
  shelterFrame: '#5b6064',
  shelterRoof: '#787d80',
  standpipeBrass: '#9a7c3c',
  standpipeBody: '#8e3a30',
  meterBoxGrey: '#8d908c',
  // Street-tree tones. Round 2's canopy was a saturated mid green that read as
  // poster paint in daylight and was still fully saturated in the night card.
  // These are the desaturated olive/khaki greens a dusty downtown street tree
  // actually shows, and the three tones are used per CLUSTER, not per cone, so
  // one crown carries all of them.
  trunk: '#5f5245',
  branch: '#6a5c4c',
  canopyA: '#55663f',
  canopyB: '#616f48',
  canopyC: '#485834',
  pitSoil: '#3f362c',
  pitGrate: '#5a5c58',
});

const UP = Object.freeze({ x: 0, y: 1, z: 0 });

/** Kinds thick enough for a shadow map texel to resolve. */
const SHADOW_CASTING_KINDS = new Set([
  'tree', 'transitShelter', 'bench', 'planter', 'mailbox', 'newsBox',
  'wasteBin', 'payStation', 'hydrant', 'bikeRack',
]);

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToLinear(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
  ];
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// item geometry
// ---------------------------------------------------------------------------
//
// Every kind is a small merged geometry with a baked vertex colour, built once
// per pass build and shared by every instance of that kind at that level of
// detail. Instances add their own tint through `InstancedMesh.setColorAt`, so
// two hydrants can differ without a second draw call.

function tint(geometry, hex, shade = 1) {
  const [r0, g0, b0] = hexToLinear(hex);
  const r = clamp(r0 * shade, 0, 1);
  const g = clamp(g0 * shade, 0, 1);
  const b = clamp(b0 * shade, 0, 1);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  if (!geometry.getAttribute('uv')) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geometry;
}

function box(w, h, d, hex, x = 0, y = 0, z = 0) {
  return tint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
}

function cyl(rTop, rBottom, h, sides, hex, x = 0, y = 0, z = 0) {
  return tint(new THREE.CylinderGeometry(rTop, rBottom, h, sides).translate(x, y, z), hex);
}

function cone(r, h, sides, hex, x = 0, y = 0, z = 0) {
  return tint(new THREE.ConeGeometry(r, h, sides).translate(x, y, z), hex);
}

function assemble(parts) {
  let list = parts.filter(Boolean);
  // `mergeGeometries` refuses a mix of indexed and non-indexed inputs. The
  // faceted leaf clusters (icosahedron / octahedron) are non-indexed by design
  // - flat facets need per-face normals - while the box and cylinder
  // primitives are indexed, so normalise before merging rather than forcing
  // every part into one representation at the call site.
  if (list.some((part) => !part.getIndex()) && list.some((part) => part.getIndex())) {
    list = list.map((part) => {
      if (!part.getIndex()) return part;
      const flat = part.toNonIndexed();
      part.dispose?.();
      return flat;
    });
  }
  const merged = mergeGeometries(list, false);
  for (const part of list) part?.dispose?.();
  if (merged) merged.computeBoundingSphere();
  return merged;
}

// ---------------------------------------------------------------------------
// street trees
// ---------------------------------------------------------------------------
//
// ROUND 3 REPLACEMENT - READ THIS BEFORE SIMPLIFYING IT BACK.
//
// Rounds 1 and 2 shipped a street tree made of one tapered cylinder and two or
// three stacked cones. In the round-2 capture set that shape is 8-15 m from a
// pedestrian-height camera in `01`, `02`, `05` and `06`, it is identical in
// every frame, and a solid cone is the one silhouette a broadleaf street tree
// never has. No texture rescues it: the defect is that the crown is a single
// closed convex shell, so no light passes through it, it has no internal
// structure, and its outline is a straight-sided triangle.
//
// What a real downtown street tree has, and what this builds:
//
//   * a TAPERING trunk that leans slightly and BRANCHES at a crotch, instead
//     of a bare stick that a cone is balanced on;
//   * primary limbs that carry the crown outward and upward;
//   * a crown made of SEPARATE leaf clusters with gaps between them, so the
//     silhouette is lobed and light reaches through it;
//   * per-cluster tone (sunlit crown top, shaded underside) so the crown has
//     internal form rather than one flat green;
//   * SPECIES variation along a block - three crown/trunk forms at the near
//     level of detail - on top of the per-instance scale, spin and tint that
//     the placement already varies.
//
// EVIDENCE THIS IS NOT A SHELL. `scripts/verify/verify-street-furniture.mjs`
// rasterises the built geometry's side silhouette and reports two numbers:
//   - `hullFill`: covered cells / cells inside the convex hull of the crown
//     silhouette. A cone or any convex solid measures ~1.0; this must measure
//     below `STREET_TREE_OPENNESS.maxHullFill`.
//   - `brokenScanlines`: horizontal scanlines across the crown whose covered
//     span is split into two or more runs, i.e. lines of sight that pass
//     straight through the crown.
// Both are measured on the geometry that ships, not on this description.
//
// BUDGET. Trees are instanced and they are everywhere, and the capture backend
// is a software rasteriser, so the cost is stated and asserted per tree and
// per city: see STREET_TREE_BUDGET.
//
// Determinism: the skeleton is generated from a fixed per-species seed with
// `streetRandom`, never from Math.random, so every build produces byte-identical
// geometry; the per-INSTANCE variation is a hash of the placement.

/** Per-tree and city-wide triangle ceilings for the tree geometry alone. */
export const STREET_TREE_BUDGET = Object.freeze({
  maxTrianglesPerTree: 300,   // near tier, one species instance
  maxTrianglesPerTreeCoarse: 90, // window tier
  maxTrianglesCity: 90000,    // every tree instance in a stated real city
});

/** The openness the crown must measure. See the note above for the method. */
export const STREET_TREE_OPENNESS = Object.freeze({
  // A convex shell - a cone, a sphere, a stack of either - has a silhouette
  // that IS its own convex hull, so it measures hullFill 1.0 and exactly zero
  // broken scanlines, whatever its texture. The verifier measures the round-2
  // cone alongside these to show the metric discriminates rather than just
  // passing. Measured on the shipped species: hullFill 0.75-0.86,
  // 21-65 broken scanlines of ~130.
  maxHullFill: 0.88,
  minBrokenScanlines: 12,
  minClusters: 7,
  minClustersCoarse: 5,
});

/**
 * Crown and trunk forms. Three at the near tier so a block does not read as
 * one stamp; the window tier uses the first form only, at four clusters, so a
 * distant tree costs about what the old cone tree cost.
 *
 * `lean` is degrees off vertical, `crotch` the fraction of trunk height where
 * the limbs leave it, `clusterR` the base leaf-cluster radius in metres and
 * `spread` how far out of the crown centre the clusters are pushed (1.0 puts
 * their centres on the crown radius).
 */
export const STREET_TREE_SPECIES = Object.freeze([
  Object.freeze({
    id: 'broad', trunkHeight: 2.55, baseRadius: 0.185, topRadius: 0.105,
    lean: 3.5, crotch: 0.82, limbs: 5, crownRadius: 1.42, crownHeight: 2.9,
    clusters: 9, clusterR: 0.72, spread: 1.0,
  }),
  Object.freeze({
    id: 'upright', trunkHeight: 3.2, baseRadius: 0.155, topRadius: 0.088,
    lean: 1.5, crotch: 0.86, limbs: 4, crownRadius: 1.08, crownHeight: 3.5,
    clusters: 8, clusterR: 0.66, spread: 1.02,
  }),
  Object.freeze({
    id: 'open', trunkHeight: 2.3, baseRadius: 0.215, topRadius: 0.12,
    lean: 5.5, crotch: 0.74, limbs: 6, crownRadius: 1.45, crownHeight: 2.45,
    clusters: 8, clusterR: 0.72, spread: 1.06,
  }),
]);

/**
 * The widest half-crown the geometry may reach, in metres, BEFORE the
 * per-instance scale. A street tree stands against the back of the kerb with
 * about `sidewalkWidth` metres to the property line, so a crown wider than
 * this at the largest instance scale would push its leaves through a facade -
 * an asset intersection, which is one of the quality gate's automatic
 * rejection conditions. Asserted per species.
 */
export const STREET_TREE_MAX_HALF_CROWN = 2.45;

/** How many distinct species geometries each level of detail carries. */
export function streetTreeVariantCount(lod) {
  return lod > 0 ? 1 : STREET_TREE_SPECIES.length;
}

/**
 * The parametric tree. Geometry is built FROM this, so a verifier that asserts
 * against the skeleton and against the built triangles is asserting the same
 * thing twice, not two things that can drift apart.
 *
 * Local frame: origin at the centre of the tree pit on the footway, +Y up.
 *
 * @param {number} variant index into STREET_TREE_SPECIES
 * @param {boolean} coarse window tier
 */
export function streetTreeSkeleton(variant, coarse = false) {
  const species = STREET_TREE_SPECIES[Math.abs(variant) % STREET_TREE_SPECIES.length];
  const rng = streetRandom(`street-tree:${species.id}:${coarse ? 'coarse' : 'near'}`);
  const lean = (species.lean * Math.PI) / 180;
  const leanDir = rng() * Math.PI * 2;
  const sections = coarse ? 2 : 3;
  const trunkTop = {
    x: Math.cos(leanDir) * Math.sin(lean) * species.trunkHeight,
    y: species.trunkHeight,
    z: Math.sin(leanDir) * Math.sin(lean) * species.trunkHeight,
  };
  // Trunk: `sections` frusta, radius falling from base to top, following the
  // lean. The taper is real, not a cosmetic top radius: the ratio is asserted.
  const trunk = [];
  for (let i = 0; i < sections; i += 1) {
    const t0 = i / sections;
    const t1 = (i + 1) / sections;
    const at = (t) => ({ x: trunkTop.x * t, y: species.trunkHeight * t, z: trunkTop.z * t });
    const radiusAt = (t) => species.baseRadius + (species.topRadius - species.baseRadius) * (t ** 0.8);
    trunk.push({ a: at(t0), b: at(t1), r0: radiusAt(t0), r1: radiusAt(t1) });
  }

  const crotch = {
    x: trunkTop.x * species.crotch,
    y: species.trunkHeight * species.crotch,
    z: trunkTop.z * species.crotch,
  };
  const crownCentre = { x: trunkTop.x, y: species.trunkHeight + species.crownHeight * 0.42, z: trunkTop.z };
  const crownRadius = species.crownRadius;

  // Leaf clusters on a flattened shell. The golden angle keeps successive
  // clusters far apart in plan, and the radial jitter keeps the outline lobed
  // rather than circular.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const count = coarse ? 6 : species.clusters;
  const clusters = [];
  for (let i = 0; i < count; i += 1) {
    // Golden angle in plan so successive clusters never stack in one view, and
    // a half-turn offset at the window tier so five clusters do not line up
    // into a column when the crown is seen from the side.
    const angle = i * GOLDEN + (coarse ? (i % 2) * Math.PI * 0.62 : 0) + rng() * 0.5;
    const band = count > 1 ? i / (count - 1) : 0.5;
    // Height band across the crown, low clusters pushed further out.
    const hy = (band - 0.5) * species.crownHeight * 0.95;
    const ring = Math.sqrt(Math.max(0.08, 1 - (2 * hy / (species.crownHeight || 1)) ** 2));
    // Every third cluster is a CORE cluster: pulled in toward the trunk and
    // grown slightly, so the crown has a dense middle to read as a mass. The
    // rest are outer lobes, which are what break the outline and let light
    // through. A crown of outer lobes alone reads as a bunch of balloons.
    const core = i % 3 === 1;
    const radial = crownRadius * species.spread * ring
      * (core ? 0.12 + 0.28 * rng() : 0.58 + 0.5 * rng());
    const r = species.clusterR * (coarse ? 1.24 : 1) * (core ? 1.16 : 1) * (0.78 + 0.44 * rng());
    clusters.push({
      x: crownCentre.x + Math.cos(angle) * radial,
      y: crownCentre.y + hy * (0.85 + 0.3 * rng()),
      z: crownCentre.z + Math.sin(angle) * radial,
      r,
      // 0 = deep shade under the crown, 1 = sunlit top. Baked into the vertex
      // colour so the crown has internal form with no extra draw call.
      light: clamp(0.24 + band * 0.76 + (rng() - 0.5) * 0.18, 0, 1),
    });
  }

  // Primary limbs run from the crotch to the inner end of a cluster, so every
  // cluster the eye can see is actually carried by something.
  const limbCount = coarse ? Math.min(2, clusters.length) : Math.min(species.limbs, clusters.length);
  const limbs = [];
  const order = clusters.map((c, i) => i).sort((a, b) => clusters[b].y - clusters[a].y);
  for (let i = 0; i < limbCount; i += 1) {
    const target = clusters[order[i % clusters.length]];
    const dx = target.x - crotch.x;
    const dy = target.y - crotch.y;
    const dz = target.z - crotch.z;
    limbs.push({
      a: crotch,
      b: { x: crotch.x + dx * 0.88, y: crotch.y + dy * 0.88, z: crotch.z + dz * 0.88 },
      r0: species.topRadius * 0.82,
      r1: species.topRadius * 0.3,
    });
  }

  const height = Math.max(...clusters.map((c) => c.y + c.r));
  return {
    species: species.id,
    variant: Math.abs(variant) % STREET_TREE_SPECIES.length,
    coarse,
    trunk,
    limbs,
    clusters,
    crownCentre,
    crownRadius,
    crownBottom: Math.min(...clusters.map((c) => c.y - c.r)),
    trunkHeight: species.trunkHeight,
    trunkBaseRadius: species.baseRadius,
    trunkTopRadius: species.topRadius,
    taperRatio: species.topRadius / species.baseRadius,
    height,
  };
}

/** A tapered limb from `a` to `b`, open-ended (no caps: they are never seen). */
function limb(a, b, r0, r1, sides, hex, shade = 1) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 1e-4)) return null;
  const geometry = new THREE.CylinderGeometry(Math.max(0.01, r1), Math.max(0.01, r0), length, sides, 1, true);
  const axis = new THREE.Vector3(dx / length, dy / length, dz / length);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  geometry.applyQuaternion(quaternion);
  geometry.translate(a.x + dx / 2, a.y + dy / 2, a.z + dz / 2);
  return tint(geometry, hex, shade);
}

/**
 * One leaf cluster. An icosahedron at the near tier (20 triangles) and an
 * octahedron at the window tier (8), squashed and spun so no two clusters in a
 * crown share an outline.
 */
function leafCluster(cluster, coarse, hex, spin) {
  const geometry = coarse
    ? new THREE.OctahedronGeometry(cluster.r, 0)
    : new THREE.IcosahedronGeometry(cluster.r, 0);
  geometry.scale(1, 0.74, 1);
  geometry.rotateY(spin);
  geometry.translate(cluster.x, cluster.y, cluster.z);
  // Sunlit top, shaded underside: 0.62 .. 1.12 of the base tone.
  return tint(geometry, hex, 0.62 + cluster.light * 0.5);
}

/**
 * Build one species' geometry at one level of detail. Pure: the same
 * (variant, coarse) pair always returns the same buffers.
 */
export function buildStreetTreeGeometry(variant, coarse = false) {
  const skeleton = streetTreeSkeleton(variant, coarse);
  const trunkSides = coarse ? 4 : 6;
  const limbSides = coarse ? 3 : 4;
  const parts = [];
  for (const section of skeleton.trunk) {
    parts.push(limb(section.a, section.b, section.r0, section.r1, trunkSides, PALETTE.trunk, 1));
  }
  for (const branch of skeleton.limbs) {
    parts.push(limb(branch.a, branch.b, branch.r0, branch.r1, limbSides, PALETTE.branch, 1.06));
  }
  const tones = [PALETTE.canopyA, PALETTE.canopyB, PALETTE.canopyC];
  skeleton.clusters.forEach((cluster, i) => {
    parts.push(leafCluster(cluster, coarse, tones[i % tones.length], (i * 1.7) % (Math.PI * 2)));
  });
  const merged = assemble(parts);
  if (merged) merged.userData = { treeSkeleton: skeleton };
  return merged;
}

/**
 * The catalogue geometry, by kind and level of detail.
 * Local frame: origin on the footway, +Y up, -Z toward the carriageway (an
 * item is rotated so -Z faces the road), +X along the street.
 */
function buildCatalogue(lod) {
  const coarse = lod > 0;
  // The coarse tier is what the whole loaded window gets, so it has to be
  // genuinely cheap: four-sided posts and no sub-100 mm parts.
  const sides = coarse ? 4 : 8;
  const g = {};

  g.hydrant = assemble([
    cyl(0.16, 0.19, 0.62, sides, PALETTE.hydrantBody, 0, 0.31, 0),
    cyl(0.11, 0.15, 0.13, sides, PALETTE.hydrantBody, 0, 0.68, 0),
    coarse ? null : cyl(0.075, 0.075, 0.06, 6, PALETTE.hydrantCap, 0, 0.76, 0),
    coarse ? null : cyl(0.055, 0.055, 0.1, 5, PALETTE.hydrantCap, 0, 0.44, -0.16).rotateX(Math.PI / 2),
    coarse ? null : cyl(0.055, 0.055, 0.1, 5, PALETTE.hydrantCap, 0, 0.44, 0.16).rotateX(Math.PI / 2),
    coarse ? null : box(0.34, 0.05, 0.34, PALETTE.hydrantBody, 0, 0.025, 0),
  ]);

  g.parkingMeter = assemble([
    cyl(0.032, 0.04, 1.05, coarse ? 4 : 6, PALETTE.meterPole, 0, 0.525, 0),
    box(0.12, 0.28, 0.16, PALETTE.meterHead, 0, 1.18, 0),
    coarse ? null : box(0.09, 0.11, 0.01, PALETTE.signWhite, 0, 1.22, -0.085),
  ]);

  g.payStation = assemble([
    cyl(0.05, 0.06, 0.75, coarse ? 4 : 6, PALETTE.meterPole, 0, 0.375, 0),
    box(0.34, 0.62, 0.22, PALETTE.meterHead, 0, 1.06, 0),
    coarse ? null : box(0.24, 0.2, 0.012, PALETTE.signWhite, 0, 1.2, -0.115),
    box(0.36, 0.06, 0.24, PALETTE.meterPole, 0, 1.4, 0),
  ]);

  g.signPole = assemble([
    cyl(0.032, 0.038, 2.6, coarse ? 4 : 6, PALETTE.poleGrey, 0, 1.3, 0),
    // Street-name blade, both directions, at the height a real blade sits.
    box(0.9, 0.16, 0.012, PALETTE.signGreen, 0.42, 2.42, 0),
    coarse ? null : box(0.012, 0.16, 0.9, PALETTE.signGreen, 0, 2.24, 0.42),
    // Regulatory plate below it.
    box(0.32, 0.42, 0.012, PALETTE.signWhite, 0, 1.82, -0.03),
    coarse ? null : box(0.26, 0.26, 0.012, PALETTE.signRed, 0, 1.34, -0.03),
  ]);

  g.bollard = assemble([
    cyl(0.075, 0.085, 0.86, coarse ? 4 : 6, PALETTE.bollardBlack, 0, 0.43, 0),
    coarse ? null : cyl(0.055, 0.078, 0.07, 6, PALETTE.bollardBlack, 0, 0.89, 0),
    coarse ? null : cyl(0.09, 0.09, 0.05, 6, PALETTE.rackSteel, 0, 0.6, 0),
  ]);

  g.wasteBin = assemble([
    cyl(0.29, 0.26, 0.82, sides, PALETTE.binGreen, 0, 0.41, 0),
    cyl(0.31, 0.31, 0.07, sides, PALETTE.binGrey, 0, 0.86, 0),
    coarse ? null : box(0.26, 0.2, 0.02, PALETTE.binGrey, 0, 0.62, -0.27),
  ]);

  g.bikeRack = assemble([
    box(0.06, 0.86, 0.06, PALETTE.rackSteel, -0.44, 0.43, 0),
    box(0.06, 0.86, 0.06, PALETTE.rackSteel, 0.44, 0.43, 0),
    box(0.94, 0.06, 0.06, PALETTE.rackSteel, 0, 0.86, 0),
    coarse ? null : box(0.2, 0.05, 0.2, PALETTE.rackSteel, -0.44, 0.025, 0),
    coarse ? null : box(0.2, 0.05, 0.2, PALETTE.rackSteel, 0.44, 0.025, 0),
  ]);

  g.newsBox = assemble([
    box(0.44, 0.78, 0.4, PALETTE.newsBoxNeutral, 0, 0.51, 0),
    box(0.46, 0.1, 0.42, PALETTE.newsBoxC, 0, 1.0, 0),
    coarse ? null : box(0.3, 0.3, 0.014, PALETTE.signWhite, 0, 0.72, -0.205),
    coarse ? null : box(0.1, 0.24, 0.1, PALETTE.newsBoxC, -0.14, 0.12, 0),
    coarse ? null : box(0.1, 0.24, 0.1, PALETTE.newsBoxC, 0.14, 0.12, 0),
  ]);

  g.mailbox = assemble([
    box(0.52, 0.72, 0.44, PALETTE.mailboxBlue, 0, 0.68, 0),
    cyl(0.26, 0.26, 0.52, coarse ? 4 : 8, PALETTE.mailboxBlue, 0, 1.04, 0).rotateZ(Math.PI / 2),
    coarse ? null : box(0.1, 0.32, 0.1, PALETTE.benchFrame, -0.18, 0.16, 0),
    coarse ? null : box(0.1, 0.32, 0.1, PALETTE.benchFrame, 0.18, 0.16, 0),
  ]);

  g.bench = assemble([
    box(1.72, 0.07, 0.16, PALETTE.benchWood, 0, 0.44, -0.16),
    box(1.72, 0.07, 0.16, PALETTE.benchWood, 0, 0.44, 0.02),
    coarse ? null : box(1.72, 0.07, 0.16, PALETTE.benchWood, 0, 0.44, 0.2),
    box(1.72, 0.16, 0.07, PALETTE.benchWood, 0, 0.72, 0.28),
    coarse ? null : box(0.08, 0.44, 0.5, PALETTE.benchFrame, -0.76, 0.22, 0.04),
    coarse ? null : box(0.08, 0.44, 0.5, PALETTE.benchFrame, 0.76, 0.22, 0.04),
    coarse ? box(1.6, 0.42, 0.42, PALETTE.benchFrame, 0, 0.21, 0.04) : null,
  ]);

  g.planter = assemble([
    box(1.05, 0.62, 0.66, PALETTE.planterConcrete, 0, 0.31, 0),
    box(0.9, 0.06, 0.52, PALETTE.planterSoil, 0, 0.63, 0),
    coarse ? null : leafCluster({ x: 0, y: 0.9, z: 0, r: 0.3, light: 0.8 }, true, PALETTE.canopyB, 0.7),
  ]);

  g.transitShelter = assemble([
    box(0.09, 2.45, 0.09, PALETTE.shelterFrame, -1.9, 1.22, -0.5),
    box(0.09, 2.45, 0.09, PALETTE.shelterFrame, 1.9, 1.22, -0.5),
    box(0.09, 2.45, 0.09, PALETTE.shelterFrame, -1.9, 1.22, 0.5),
    box(0.09, 2.45, 0.09, PALETTE.shelterFrame, 1.9, 1.22, 0.5),
    box(4.1, 0.12, 1.3, PALETTE.shelterRoof, 0, 2.5, 0),
    box(3.8, 1.9, 0.05, PALETTE.shelterGlass, 0, 1.4, 0.52),
    coarse ? null : box(0.9, 1.9, 0.05, PALETTE.shelterGlass, -1.6, 1.4, -0.52),
    coarse ? null : box(1.7, 0.07, 0.34, PALETTE.benchWood, 0.4, 0.5, 0.32),
    coarse ? null : box(0.07, 0.5, 0.34, PALETTE.shelterFrame, -0.42, 0.25, 0.32),
  ]);

  g.busStopFlag = assemble([
    cyl(0.03, 0.036, 2.8, coarse ? 4 : 6, PALETTE.poleGrey, 0, 1.4, 0),
    box(0.42, 0.62, 0.014, PALETTE.signBlue, 0, 2.5, -0.03),
    coarse ? null : box(0.3, 0.12, 0.014, PALETTE.signWhite, 0, 2.62, -0.04),
  ]);

  g.standpipe = assemble([
    cyl(0.055, 0.055, 0.95, coarse ? 4 : 6, PALETTE.standpipeBody, 0, 0.48, 0),
    cyl(0.05, 0.05, 0.16, coarse ? 4 : 6, PALETTE.standpipeBrass, 0, 0.86, -0.09).rotateX(Math.PI / 2),
    coarse ? null : cyl(0.05, 0.05, 0.16, 6, PALETTE.standpipeBrass, 0, 0.68, -0.09).rotateX(Math.PI / 2),
    box(0.2, 0.05, 0.2, PALETTE.standpipeBody, 0, 0.025, 0),
  ]);

  g.wallMeter = assemble([
    box(0.3, 0.42, 0.16, PALETTE.meterBoxGrey, 0, 1.32, 0),
    cyl(0.03, 0.03, 0.42, coarse ? 4 : 6, PALETTE.meterPole, 0, 0.9, 0),
    coarse ? null : cyl(0.09, 0.09, 0.04, 8, PALETTE.signWhite, 0, 1.38, -0.09).rotateX(Math.PI / 2),
  ]);

  // One geometry per species at the near tier, one at the window tier. Every
  // tree item carries the variant index it was placed with, so a block gets a
  // mix of forms out of the same instanced draw calls.
  for (let variant = 0; variant < streetTreeVariantCount(lod); variant += 1) {
    g[`tree#${variant}`] = buildStreetTreeGeometry(variant, coarse);
  }

  return g;
}

// ---------------------------------------------------------------------------
// occupancy
// ---------------------------------------------------------------------------

/** Uniform grid of plan circles. Everything placed is tested against it. */
function makeOccupancy(cell = 2.5) {
  return { cell, map: new Map(), count: 0 };
}

function occupancyKey(grid, x, z) {
  return `${Math.floor(x / grid.cell)}|${Math.floor(z / grid.cell)}`;
}

function occupancyHit(grid, x, z, radius) {
  const gx = Math.floor(x / grid.cell);
  const gz = Math.floor(z / grid.cell);
  const reach = Math.ceil((radius + grid.cell) / grid.cell);
  for (let i = -reach; i <= reach; i += 1) {
    for (let j = -reach; j <= reach; j += 1) {
      const bucket = grid.map.get(`${gx + i}|${gz + j}`);
      if (!bucket) continue;
      for (const c of bucket) {
        const dx = c.x - x;
        const dz = c.z - z;
        const rr = c.r + radius;
        if (dx * dx + dz * dz < rr * rr) return c;
      }
    }
  }
  return null;
}

function occupancyAdd(grid, x, z, radius, tag) {
  const key = occupancyKey(grid, x, z);
  const circle = { x, z, r: radius, tag };
  const bucket = grid.map.get(key);
  if (bucket) bucket.push(circle); else grid.map.set(key, [circle]);
  grid.count += 1;
  // A circle wider than a cell has to be registered in the cells it reaches,
  // otherwise a big item (a shelter) can be straddled by a small one.
  const reach = Math.ceil(radius / grid.cell);
  if (reach > 0) {
    const gx = Math.floor(x / grid.cell);
    const gz = Math.floor(z / grid.cell);
    for (let i = -reach; i <= reach; i += 1) {
      for (let j = -reach; j <= reach; j += 1) {
        if (i === 0 && j === 0) continue;
        const k = `${gx + i}|${gz + j}`;
        const b = grid.map.get(k);
        if (b) b.push(circle); else grid.map.set(k, [circle]);
      }
    }
  }
  return circle;
}

/**
 * Register everything the legacy renderer has already put in the world so this
 * pass cannot plant a bollard inside an existing tree.
 *
 * The scene is read, not guessed at: this walks `ctx.root` at build time and
 * takes the world-space centre of every small, low mesh and instanced mesh.
 * Dynamic content (pedestrians, vehicles) is skipped by name because its
 * build-time position is not where it will be, and anything above head height
 * (roof props, parapets) cannot conflict with a footway.
 */
const DYNAMIC_NAME = /ped|crowd|actor|npc|vehicle|car|traffic|bird|cloud/i;

function seedOccupancyFromScene(state, root) {
  if (!root || typeof root.traverse !== 'function') return 0;
  const grid = state.occupancy;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  let added = 0;
  root.traverse((node) => {
    if (added >= state.options.maxSceneOccupancy) return;
    if (!node.isMesh && !node.isInstancedMesh) return;
    // This pass's OWN previous placement is not an obstacle. The LOD re-centre
    // rebuilds the whole population from scratch against a fresh internal
    // occupancy grid, so reading last build's items back in would leave every
    // slot occupied and the refreshed street empty.
    if (node.userData?.pass === STREET_FURNITURE_ID) return;
    if (DYNAMIC_NAME.test(String(node.name || ''))) return;
    if (DYNAMIC_NAME.test(String(node.userData?.kind || ''))) return;
    const geometry = node.geometry;
    if (!geometry) return;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    if (!sphere || !Number.isFinite(sphere.radius)) return;
    node.updateWorldMatrix(true, false);
    const scaleFactor = Math.max(
      Math.abs(node.scale?.x ?? 1), Math.abs(node.scale?.y ?? 1), Math.abs(node.scale?.z ?? 1),
    );
    const radius = sphere.radius * (Number.isFinite(scaleFactor) ? scaleFactor : 1);
    // Too small to matter, or a whole-city surface rather than a prop.
    if (!(radius > 0.08 && radius < 8)) return;
    const record = (m) => {
      position.copy(sphere.center).applyMatrix4(m);
      if (position.y > 6) return;
      occupancyAdd(grid, position.x, position.z, Math.min(radius, 2.4), 'legacy');
      added += 1;
    };
    if (node.isInstancedMesh) {
      const count = Math.min(node.count ?? 0, state.options.maxSceneOccupancy - added);
      for (let i = 0; i < count; i += 1) {
        node.getMatrixAt(i, matrix);
        matrix.premultiply(node.matrixWorld);
        record(matrix);
      }
    } else {
      record(node.matrixWorld);
    }
  });
  return added;
}

/**
 * Uniform index over the paved carriageway and the junction pads, so nothing
 * can be planted in the roadway.
 *
 * An item is placed on the footway band of the segment it CLAIMS, which is not
 * the same as being clear of the road: where a service way crosses a street,
 * or a segment runs close to a sibling of the same street, the claimed footway
 * band lies on top of another segment's carriageway or inside a junction pad.
 * That is exactly how a bench ends up on a crosswalk. The claim is therefore
 * checked against every OTHER paved surface, not only the one it came from.
 */
function buildRoadwayIndex(plan) {
  const cell = 24;
  const segments = new Map();
  for (const segment of plan.segments) {
    for (let i = 0; i < segment.points.length - 1; i += 1) {
      const a = segment.points[i];
      const b = segment.points[i + 1];
      const entry = { a, b, half: segment.half, id: segment.id };
      const reach = segment.half + 3;
      for (let gx = Math.floor((Math.min(a.x, b.x) - reach) / cell); gx <= Math.floor((Math.max(a.x, b.x) + reach) / cell); gx += 1) {
        for (let gz = Math.floor((Math.min(a.z, b.z) - reach) / cell); gz <= Math.floor((Math.max(a.z, b.z) + reach) / cell); gz += 1) {
          const key = `${gx}|${gz}`;
          const bucket = segments.get(key);
          if (bucket) bucket.push(entry); else segments.set(key, [entry]);
        }
      }
    }
  }
  // Junction pads, as the closed curb ring the surface builder actually built.
  const pads = new Map();
  for (const node of plan.nodes) {
    const ring = [];
    for (const path of node.paths || []) {
      for (const station of path.stations || []) ring.push({ x: station.x, z: station.z });
    }
    if (ring.length < 3) continue;
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const entry = { ring, minX, maxX, minZ, maxZ, id: node.id };
    for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
      for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
        const key = `${gx}|${gz}`;
        const bucket = pads.get(key);
        if (bucket) bucket.push(entry); else pads.set(key, [entry]);
      }
    }
  }
  return { cell, segments, pads };
}

/** True when the plan circle touches any carriageway or junction pad. */
export function onPavedRoadway(index, x, z, radius) {
  const gx = Math.floor(x / index.cell);
  const gz = Math.floor(z / index.cell);
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      const key = `${gx + i}|${gz + j}`;
      for (const e of index.segments.get(key) || []) {
        const dx = e.b.x - e.a.x;
        const dz = e.b.z - e.a.z;
        const len2 = dx * dx + dz * dz;
        const t = len2 > 1e-12 ? clamp(((x - e.a.x) * dx + (z - e.a.z) * dz) / len2, 0, 1) : 0;
        if (Math.hypot(x - (e.a.x + dx * t), z - (e.a.z + dz * t)) < e.half + radius) return e.id;
      }
      for (const e of index.pads.get(key) || []) {
        if (x < e.minX - radius || x > e.maxX + radius || z < e.minZ - radius || z > e.maxZ + radius) continue;
        if (pointInPolygon(e.ring, x, z)) return e.id;
        // Also reject when the circle merely clips the ring's boundary.
        for (let k = 0, l = e.ring.length - 1; k < e.ring.length; l = k, k += 1) {
          const a = e.ring[l];
          const b = e.ring[k];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const len2 = dx * dx + dz * dz;
          const t = len2 > 1e-12 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1) : 0;
          if (Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) < radius) return e.id;
        }
      }
    }
  }
  return null;
}

/**
 * Is any part of an oriented item footprint on a carriageway or junction pad?
 * `(ox, oz)` is the unit vector from the item toward the road.
 */
function itemOnRoadway(state, kind, x, z, ox, oz) {
  const depth = Math.max(kind.depth, 0.18) + 0.06;
  const half = Math.max(0, kind.radius - kind.depth);
  // Along-street axis is perpendicular to the outward normal.
  const ax = -oz;
  const az = ox;
  for (const t of half > 0.05 ? [-half, 0, half] : [0]) {
    const hit = onPavedRoadway(state.roadway, x + ax * t, z + az * t, depth);
    if (hit) return hit;
  }
  return null;
}

/** Axis-aligned footprint index over the building contract. */
function buildBuildingIndex(city) {
  const cell = 24;
  const map = new Map();
  let count = 0;
  for (const building of city?.buildings || []) {
    const polygon = building?.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of polygon) {
      const x = Number(p?.x);
      const z = Number(p?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) continue;
    const boxRecord = { minX, maxX, minZ, maxZ, polygon };
    count += 1;
    for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
      for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
        const key = `${gx}|${gz}`;
        const bucket = map.get(key);
        if (bucket) bucket.push(boxRecord); else map.set(key, [boxRecord]);
      }
    }
  }
  return { cell, map, count };
}

function pointInPolygon(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.z > z) !== (b.z > z)
      && x < ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || 1e-12) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToPolygon(polygon, x, z) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-12 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1) : 0;
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Distance from (x, z) to the nearest building footprint; 0 when inside one.
 *
 * The polygon is tested, not its bounding box. A diagonal or L-shaped block -
 * and this city has plenty, including transit-station footprints hundreds of
 * metres across - has a bounding box that swallows whole streets, and an
 * AABB test on that box rejects every placement in the neighbourhood.
 */
function buildingDistance(index, x, z) {
  const gx = Math.floor(x / index.cell);
  const gz = Math.floor(z / index.cell);
  let best = Infinity;
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      const bucket = index.map.get(`${gx + i}|${gz + j}`);
      if (!bucket) continue;
      for (const b of bucket) {
        const dx = Math.max(b.minX - x, 0, x - b.maxX);
        const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
        const boxDistance = Math.hypot(dx, dz);
        if (boxDistance >= best) continue;
        if (boxDistance === 0 && pointInPolygon(b.polygon, x, z)) return 0;
        const d = distanceToPolygon(b.polygon, x, z);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

/** Class band index used by the weight table: service, residential, collector, arterial. */
function classBand(classRank) {
  if (classRank <= 2) return 0;
  if (classRank === 3) return 1;
  if (classRank === 4) return 2;
  return 3;
}

function ringFor(state, x, z) {
  const dx = x - state.focus.x;
  const dz = z - state.focus.z;
  const d2 = dx * dx + dz * dz;
  for (const ring of state.rings) {
    if (d2 <= ring.radius * ring.radius) return ring;
  }
  return null;
}

function reject(state, kind, reason) {
  const key = `${kind}:${reason}`;
  state.rejections[key] = (state.rejections[key] || 0) + 1;
}

/**
 * Choose a kind for one slot. Deterministic: a single 0..1 draw against the
 * cumulative weight of the kinds that are legal here, in catalogue order.
 */
function chooseKind(state, context, draw) {
  const { band, classRank, atCorner, ring, lastAt, station, buildingGap, wallReach } = context;
  let total = 0;
  const legal = [];
  for (const id of STREET_FURNITURE_KIND_IDS) {
    const kind = STREET_FURNITURE_KINDS[id];
    if (ring.kinds && !ring.kinds.includes(id)) continue;
    if (band.walk < kind.minWalk) continue;
    if (kind.zone === ZONES.MID && band.usable - kind.depth * 2 < 1.0) continue;
    if (kind.zone === ZONES.BUILDING && !(buildingGap <= wallReach)) continue;
    const since = station - (lastAt[id] ?? -1e9);
    if (since < kind.gap) continue;
    const weight = atCorner ? kind.corner : kind.weight[classBand(classRank)];
    if (!(weight > 0)) continue;
    total += weight;
    legal.push({ id, kind, weight });
  }
  if (!legal.length) return null;
  let cursor = draw * total;
  for (const entry of legal) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry;
  }
  return legal[legal.length - 1];
}

/**
 * Lateral offset (magnitude, from the centreline) for a kind inside a band,
 * and the through-route the placement has to leave behind it.
 *
 * `depth` is the item's half-extent ACROSS the footway, which is not its plan
 * radius: a bench is 1.7 m long and 0.6 m deep, and using the length to decide
 * whether it fits across a 2.5 m footway would reject every bench in the city.
 */
export function lateralFor(kind, band, throughRoute) {
  const through = Number.isFinite(kind.through) ? kind.through : throughRoute;
  const limit = band.outer - through;
  // A wall item starts its search at the far end of its reach and walks in to
  // the first station that is clear of, but touching, a facade.
  if (kind.zone === ZONES.BUILDING) {
    return { lateral: band.outer + (Number.isFinite(kind.reach) ? kind.reach : 3.0) - kind.depth, limit: band.outer, nearest: band.inner + kind.depth };
  }
  const nearest = band.inner + kind.depth + 0.1;
  if (kind.zone === ZONES.MID) {
    const wanted = band.inner + Math.max(kind.depth + 0.1, band.usable * 0.5);
    return { lateral: Math.min(wanted, limit - kind.depth), limit, nearest };
  }
  return { lateral: band.inner + kind.depth + 0.06, limit, nearest };
}

function placeItem(state, spec) {
  const { segment, side, station, kindId, kind, band, ring, forced = false } = spec;
  const o = state.o;
  const wallReach = state.options.wallReach;
  const fit = lateralFor({ ...kind, reach: wallReach }, band, state.options.throughRoute);
  const lateral = fit.lateral;
  if (lateral - kind.depth < band.inner - 0.05) { reject(state, kindId, 'inside-curb'); return null; }
  if (kind.zone !== ZONES.BUILDING) {
    if (lateral + kind.depth > band.outer + 0.05) { reject(state, kindId, 'past-property-line'); return null; }
    if (lateral + kind.depth > fit.limit + 1e-6) { reject(state, kindId, 'blocks-through-route'); return null; }
  }
  const st = streetStationAt(segment, station, false);
  const nx = st.nx * st.miter;
  const nz = st.nz * st.miter;
  let placedLateral = lateral;
  if (kind.zone === ZONES.BUILDING) {
    // Snap to the facade. The authored footway band and the authored building
    // footprint routinely overlap - the band is a nominal width, not a
    // survey - so a wall item parked at the nominal property line is often
    // buried in the wall. Walk inward until the item is just clear of the
    // footprint, and give up rather than leave it standing in open footway.
    const floor = band.inner + kind.depth + 0.05;
    const ceiling = band.outer + wallReach;
    let snapped = null;
    for (let probe = Math.min(lateral, ceiling); probe >= floor; probe -= 0.12) {
      const px = st.x + nx * side * probe;
      const pz = st.z + nz * side * probe;
      const gap = buildingDistance(state.buildings, px, pz);
      if (gap > 0.02 && gap <= 0.55) { snapped = probe; break; }
      if (gap > 0.55) break;
    }
    if (snapped === null) { reject(state, kindId, 'no-facade'); return null; }
    placedLateral = snapped;
  }
  const x = st.x + nx * side * placedLateral;
  const z = st.z + nz * side * placedLateral;
  if (occupancyHit(state.occupancy, x, z, kind.radius)) { reject(state, kindId, 'overlap'); return null; }
  // The roadway test is done on the item's OWN footprint, not on its plan
  // circle. A bench is 1.7 m long and 0.6 m deep and stands parallel to the
  // kerb, so its circle radius points down the street, not at the traffic;
  // testing that circle refuses every bench, rack and shelter in the city.
  // Three samples along the long axis, each with the across-footway depth, is
  // the oriented rectangle to the accuracy that matters here.
  // Unit outward direction, matching the yaw the instance is actually given,
  // plus a margin so the test is conservative rather than exact.
  const outLen = Math.hypot(nx, nz) || 1;
  const roadway = itemOnRoadway(state, kind, x, z, (side * nx) / outLen, (side * nz) / outLen);
  if (roadway) { reject(state, kindId, 'on-carriageway'); return null; }
  // A wall-mounted kind is allowed to stand hard against a facade, but never
  // INSIDE one: the footway band can overlap a building footprint where the
  // authored footway is wider than the real setback, and an item placed there
  // would be buried in the wall rather than fixed to it.
  const insideBuilding = buildingDistance(state.buildings, x, z);
  const clearance = kind.zone === ZONES.BUILDING ? 0.02 : 0.15;
  if (insideBuilding <= clearance) { reject(state, kindId, 'inside-building'); return null; }
  const datum = state.datum(x, z);
  // Beyond the property line the item still stands at footway level, not on
  // an extrapolated cross-fall.
  const surfaceLateral = Math.min(placedLateral, band.outer);
  const y = sidewalkSurfaceY(datum, surfaceLateral, segment.half, o);
  const curbTop = sidewalkSurfaceY(datum, segment.half, segment.half, o);
  const zone = kind.zone;
  if (!(y >= curbTop - 1e-6)) { reject(state, kindId, 'below-curb'); return null; }
  const rng = streetRandom(`${state.seedTag}:item:${segment.id}:${side}:${Math.round(station * 100)}:${kindId}`);
  // -Z of the item faces the carriageway.
  const facing = Math.atan2(side * nx, side * nz);
  const spin = kindId === 'tree' || kindId === 'hydrant' || kindId === 'bollard' || kindId === 'wasteBin'
    ? (rng() - 0.5) * Math.PI
    : (rng() - 0.5) * 0.06;
  const scale = kindId === 'tree' ? 0.82 + rng() * 0.5 : 0.965 + rng() * 0.07;
  // Species. Deterministic from the same per-placement stream as the scale and
  // the spin, so the mix along a block is fixed for a seed and differs between
  // seeds, and the count of forms available is whatever this level of detail
  // actually carries.
  const variant = kindId === 'tree'
    ? Math.floor(rng() * streetTreeVariantCount(ring.lod)) % streetTreeVariantCount(ring.lod)
    : 0;
  // A tree's canopy is far wider than its plan footprint, so a young narrow
  // species and an old broad one at the same instance scale are visibly
  // different heights as well as widths.
  const heightScale = kindId === 'tree' ? scale * (0.92 + rng() * 0.2) : scale;
  occupancyAdd(state.occupancy, x, z, kind.radius, kindId);
  const item = {
    kind: kindId,
    variant,
    heightScale,
    lod: ring.lod,
    ring: ring.id,
    x,
    y,
    z,
    rotation: facing + spin,
    scale,
    tintSeed: rng(),
    segmentId: segment.id,
    side,
    station,
    lateral: placedLateral,
    zone,
    // True when this is one of the placements a junction corner is guaranteed:
    // exactly one set per corner, claimed before the mid-block walk runs.
    forced,
    nodeId: forced ? spec.nodeId ?? null : null,
    band: { inner: band.inner, outer: band.outer, walk: band.walk },
    half: segment.half,
    curbTop,
  };
  state.items.push(item);
  state.counts[kindId] = (state.counts[kindId] || 0) + 1;
  state.usedSegments.add(segment.id);
  // Both records move together: `state.rings` is what the placement walk tests
  // its per-ring item cap against, and round 1 only ever incremented the
  // diagnostics copy, so that cap never actually bound.
  ring.items += 1;
  const ringRecord = state.ringRecords[state.rings.indexOf(ring)];
  ringRecord.items += 1;
  return item;
}

/**
 * Walk one side of one segment and furnish it.
 *
 * The corner zone - the first and last `cornerZone` metres, where the segment
 * meets a junction - draws from the corner weights, which is what puts the
 * sign poles, hydrants, bollards and news boxes at corners and keeps trees,
 * meters and benches out of the sight triangle.
 */
function furnishSide(state, segment, side) {
  const o = state.o;
  const band = sidewalkBand(segment, side, o, state.options.throughRoute);
  if (!band) { reject(state, 'side', 'no-footway'); return; }
  const s0 = segment.trimStart + 1.2;
  const s1 = segment.length - segment.trimEnd - 1.2;
  if (s1 - s0 < 2) { reject(state, 'side', 'no-run'); return; }
  const cornerZone = state.options.cornerZone;
  const lastAt = {};
  const rng = streetRandom(`${state.seedTag}:furnish:${segment.id}:${side}`);
  const basePitch = segment.classRank >= 5 ? 4.2 : segment.classRank >= 4 ? 5.0 : 6.4;
  let station = s0 + rng() * 1.5;
  let guard = 0;
  while (station < s1 && guard < 4000) {
    guard += 1;
    const st = streetStationAt(segment, station, false);
    const nx = st.nx * st.miter;
    const nz = st.nz * st.miter;
    const probeLateral = band.inner + band.usable * 0.5;
    const px = st.x + nx * side * probeLateral;
    const pz = st.z + nz * side * probeLateral;
    const ring = ringFor(state, px, pz);
    if (!ring) { reject(state, 'slot', 'out-of-range'); station += 12; continue; }
    if (ring.items >= ring.maxItems) { reject(state, 'slot', 'ring-item-cap'); station += 12; continue; }
    const atStartCorner = segment.nodeStart && station - s0 < cornerZone;
    const atEndCorner = segment.nodeEnd && s1 - station < cornerZone;
    const atCorner = Boolean(atStartCorner || atEndCorner);
    const buildingGap = buildingDistance(state.buildings, st.x + nx * side * band.outer, st.z + nz * side * band.outer);
    const choice = chooseKind(state, {
      band, classRank: segment.classRank, atCorner, ring, lastAt, station, buildingGap,
      wallReach: state.options.wallReach,
    }, rng());
    if (!choice) { reject(state, 'slot', atCorner ? 'no-legal-corner-kind' : 'no-legal-kind'); station += basePitch; continue; }
    const placed = placeItem(state, {
      segment, side, station, kindId: choice.id, kind: choice.kind, band, ring,
    });
    if (placed) {
      lastAt[choice.id] = station;
      station += Math.max(0.9, choice.kind.radius * 2 + 0.5) + basePitch * ring.pitchScale * (0.6 + rng() * 0.7);
    } else {
      station += 1.6 + rng();
    }
  }
}

/**
 * The corner itself. Every junction corner in a real city carries a sign pole,
 * and about half carry a hydrant; those are placed first, before the mid-block
 * walk, so the corner always wins the space.
 */
function furnishCorners(state) {
  for (const node of state.plan.nodes) {
    for (const approach of node.approaches) {
      const segment = approach.segment;
      if (!segment) continue;
      // One placement per CORNER, not per (approach, side). The approaches
      // round a node are sorted by angle, so corner k is bounded by approach
      // k's counter-clockwise side and approach k+1's clockwise side; visiting
      // only the counter-clockwise side visits every corner exactly once.
      // Visiting both sides is what turns a four-way junction into eight sign
      // poles instead of four.
      const ccwSide = approach.atStart ? 1 : -1;
      for (const side of [ccwSide]) {
        const band = sidewalkBand(segment, side, state.o, state.options.throughRoute);
        if (!band) continue;
        const ringProbe = streetStationAt(segment, approach.atStart
          ? approach.trim + 1.4
          : segment.length - approach.trim - 1.4, false);
        const nx = ringProbe.nx * ringProbe.miter;
        const nz = ringProbe.nz * ringProbe.miter;
        const lateralProbe = band.inner + band.usable * 0.5;
        const ring = ringFor(state,
          ringProbe.x + nx * side * lateralProbe,
          ringProbe.z + nz * side * lateralProbe);
        if (!ring) continue;
        const hash = streetHash32(`${state.seedTag}:corner:${node.id}:${segment.id}:${side}`);
        const wanted = [];
        if (!ring.kinds || ring.kinds.includes('signPole')) wanted.push('signPole');
        if (hash % 5 === 0 && (!ring.kinds || ring.kinds.includes('hydrant'))) wanted.push('hydrant');
        if (hash % 3 === 0 && (!ring.kinds || ring.kinds.includes('bollard'))) wanted.push('bollard');
        let offset = 1.3;
        for (const kindId of wanted) {
          const kind = STREET_FURNITURE_KINDS[kindId];
          if (band.walk < kind.minWalk) { reject(state, kindId, 'corner-too-narrow'); continue; }
          const station = approach.atStart
            ? approach.trim + offset
            : segment.length - approach.trim - offset;
          if (station < 0.3 || station > segment.length - 0.3) { reject(state, kindId, 'corner-no-room'); continue; }
          placeItem(state, { segment, side, station, kindId, kind, band, ring, forced: true, nodeId: node.id });
          offset += kind.radius * 2 + 0.9;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tree pits
// ---------------------------------------------------------------------------

const PIT_LIFTS = Object.freeze({ soil: 0.005, grate: 0.012 });

function makeFlatBuffer() {
  return { positions: [], normals: [], colors: [], uvs: [], indices: [], triangles: 0 };
}

function pushFlatQuad(buffer, points, linearColor) {
  const base = buffer.positions.length / 3;
  // Force counter-clockwise seen from above so the face points up.
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  const ring = area < 0 ? [...points].reverse() : points;
  for (const p of ring) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
    buffer.positions.push(p.x, p.y, p.z);
    buffer.normals.push(0, 1, 0);
    buffer.colors.push(linearColor[0], linearColor[1], linearColor[2]);
    buffer.uvs.push(p.x * 0.5, p.z * 0.5);
  }
  for (let i = 1; i < ring.length - 1; i += 1) {
    buffer.indices.push(base, base + i, base + i + 1);
    buffer.triangles += 1;
  }
}

/**
 * A tree pit: soil, a cast frame and its slats. Without it a trunk grows
 * straight out of a concrete slab, which is the single most obvious tell that
 * a street was placed rather than built.
 */
function emitTreePit(state, buffer, item, detailed) {
  const o = state.o;
  const half = state.options.pitSize / 2;
  const c = Math.cos(item.rotation);
  const s = Math.sin(item.rotation);
  const at = (a, b, lift) => {
    const x = item.x + c * a + s * b;
    const z = item.z - s * a + c * b;
    const datum = state.datum(x, z);
    return { x, y: sidewalkSurfaceY(datum, item.lateral, item.half, o) + lift, z };
  };
  const soil = hexToLinear(PALETTE.pitSoil);
  pushFlatQuad(buffer, [
    at(-half, -half, PIT_LIFTS.soil), at(half, -half, PIT_LIFTS.soil),
    at(half, half, PIT_LIFTS.soil), at(-half, half, PIT_LIFTS.soil),
  ], soil);
  if (!detailed) return;
  const grate = hexToLinear(PALETTE.pitGrate);
  const rail = 0.09;
  for (const [a0, a1, b0, b1] of [
    [-half, half, -half, -half + rail],
    [-half, half, half - rail, half],
    [-half, -half + rail, -half + rail, half - rail],
    [half - rail, half, -half + rail, half - rail],
  ]) {
    pushFlatQuad(buffer, [
      at(a0, b0, PIT_LIFTS.grate), at(a1, b0, PIT_LIFTS.grate),
      at(a1, b1, PIT_LIFTS.grate), at(a0, b1, PIT_LIFTS.grate),
    ], grate);
  }
  const slats = 5;
  for (let i = 0; i < slats; i += 1) {
    const b = -half + rail + ((half - rail) * 2 * (i + 0.5)) / slats;
    pushFlatQuad(buffer, [
      at(-half + rail, b - 0.028, PIT_LIFTS.grate), at(half - rail, b - 0.028, PIT_LIFTS.grate),
      at(half - rail, b + 0.028, PIT_LIFTS.grate), at(-half + rail, b + 0.028, PIT_LIFTS.grate),
    ], grate);
  }
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

function instanceTint(kindId, t) {
  if (kindId === 'newsBox') {
    const palettes = [[0.24, 0.36, 0.62], [0.55, 0.34, 0.16], [0.36, 0.39, 0.42], [0.58, 0.2, 0.18]];
    return palettes[Math.floor(t * palettes.length) % palettes.length];
  }
  if (kindId === 'tree') {
    return [0.86 + t * 0.2, 0.9 + t * 0.22, 0.82 + t * 0.2];
  }
  if (kindId === 'wasteBin') {
    return t < 0.5 ? [1, 1, 1] : [0.78, 0.82, 0.86];
  }
  const k = 0.9 + t * 0.2;
  return [k, k, k];
}

const DEFAULT_OPTIONS = Object.freeze({
  cornerZone: 11,
  throughRoute: 1.35,
  pitSize: 1.06,
  // How far past the property line a wall-mounted item may reach to find a
  // facade. The authored footway width is nominal, so the real building face
  // is often a couple of metres behind it.
  wallReach: 5.0,
  maxSceneOccupancy: 6000,
});

function makeState(plan, focus, ctx, options, seedTag, outerRadius) {
  const rings = STREET_FURNITURE_RINGS.map((ring) => ({
    ...ring,
    radius: ring.radius == null ? outerRadius : ring.radius,
    items: 0,
    triangles: 0,
  }));
  const o = plan.options;
  const heightAt = o.heightAt;
  return {
    plan,
    o,
    focus,
    options,
    // Seed prefix: one seed is bit-identical run to run, two seeds differ.
    seedTag: String(seedTag ?? 'city'),
    rings,
    ringRecords: rings.map((ring) => ({ id: ring.id, radius: ring.radius, lod: ring.lod, items: 0, triangles: 0 })),
    items: [],
    counts: {},
    rejections: {},
    usedSegments: new Set(),
    occupancy: makeOccupancy(2.5),
    buildings: buildBuildingIndex(plan.city),
    roadway: buildRoadwayIndex(plan),
    datum: heightAt ? (x, z) => o.roadLift + heightAt(x, z) : () => o.roadLift,
  };
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

/**
 * Which catalogue geometry an item draws. Trees are the only kind with more
 * than one form, so this is where the species index enters the draw-call
 * bucketing.
 */
export function furnitureGeometryKey(item) {
  return item.kind === 'tree' ? `tree#${item.variant || 0}` : item.kind;
}

/**
 * The three materials this pass draws with.
 *
 * `envClass` is a member of `MATERIAL_CLASSES` in
 * src/render/environment-ibl.js and is REQUIRED on every lit material: the
 * renderer's environment grading and the wet-weather response only reach
 * materials that declare one. Round 2 shipped all three of these without a
 * class, which is why the street trees stayed fully saturated green in the
 * night card - the foliage was never graded by anything. The verifier asserts
 * these names against that module's own exported list.
 *
 * They are built ONCE per city and reused across every LOD re-centre. The
 * renderer caches its environment-grading buckets from a single traverse taken
 * just after the passes are built, so a material that first appeared during a
 * refresh would never be handed an environment map and would render unlit for
 * the rest of the session.
 */
export function createStreetFurnitureMaterials() {
  const prop = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.74, metalness: 0.14,
  });
  prop.name = `${STREET_FURNITURE_ID}:prop`;
  prop.userData = { envClass: 'painted-metal' };
  const foliage = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0,
  });
  foliage.name = `${STREET_FURNITURE_ID}:foliage`;
  foliage.userData = { envClass: 'foliage' };
  const pit = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.05,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  pit.name = `${STREET_FURNITURE_ID}:pit`;
  pit.userData = { envClass: 'sidewalk' };
  return { prop, foliage, pit };
}

export function disposeStreetFurnitureMaterials(materials) {
  if (!materials) return;
  for (const material of Object.values(materials)) material?.dispose?.();
}

export function buildStreetFurniture(ctx, overrides = {}) {
  const startedAt = Date.now();
  const city = ctx?.city;
  const options = { ...DEFAULT_OPTIONS, ...(overrides.placement || {}) };
  const surfaceOptions = surfaceOptionsFor(ctx, overrides.surface || {});
  const plan = buildStreetscapePlan(city, surfaceOptions);
  const bounds = city?.meta?.bounds;
  const focus = resolveFocus(ctx, city);
  const outerRadius = windowRadius(focus, bounds, STREET_FURNITURE_WINDOW);
  const state = makeState(plan, focus, ctx, options, ctx?.seed ?? city?.meta?.seed ?? 'city', outerRadius);
  const legacyOccupancy = seedOccupancyFromScene(state, ctx?.root);

  // Corners first: they are the highest-value placements and must win the
  // space before the mid-block walk consumes it.
  furnishCorners(state);
  const farRadius = state.rings[state.rings.length - 1].radius;
  for (const segment of plan.segments) {
    if (segmentReach(focus, segment) > farRadius) { reject(state, 'segment', 'out-of-range'); continue; }
    for (const side of [1, -1]) furnishSide(state, segment, side);
  }

  // Geometry, one variant per level of detail actually used.
  const lodsUsed = new Set(state.items.map((item) => item.lod));
  const catalogue = new Map();
  for (const lod of [...lodsUsed].sort()) catalogue.set(lod, buildCatalogue(lod));
  const triangleOf = (geometryKey, lod) => {
    const geometry = catalogue.get(lod)?.[geometryKey];
    if (!geometry) return 0;
    const index = geometry.getIndex();
    return Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3);
  };

  // Ring triangle caps. Items are dropped from the tail of the ring, which is
  // the furthest-along-the-street placement, so a cap never leaves a hole at a
  // corner.
  const kept = [];
  for (const item of state.items) {
    const ringIndex = state.rings.findIndex((ring) => ring.id === item.ring);
    const ring = state.rings[ringIndex];
    const triangles = triangleOf(furnitureGeometryKey(item), item.lod);
    if (ring.triangles + triangles > ring.maxTriangles) {
      reject(state, item.kind, 'ring-triangle-cap');
      state.counts[item.kind] -= 1;
      continue;
    }
    ring.triangles += triangles;
    state.ringRecords[ringIndex].triangles += triangles;
    kept.push(item);
  }
  state.items = kept;

  const group = new THREE.Group();
  group.name = STREET_FURNITURE_ID;
  group.userData = { kind: 'street-furniture', version: STREET_FURNITURE_VERSION };

  const materials = overrides.materials || createStreetFurnitureMaterials();
  const { prop: propMaterial, foliage: foliageMaterial, pit: groundMaterial } = materials;

  const buckets = new Map();
  for (const item of state.items) {
    const key = `${furnitureGeometryKey(item)}:${item.lod}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item); else buckets.set(key, [item]);
  }

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const positionVector = new THREE.Vector3();
  const scaleVector = new THREE.Vector3();
  const color = new THREE.Color();
  const meshes = [];
  let triangles = 0;
  for (const key of [...buckets.keys()].sort()) {
    const items = buckets.get(key);
    const [geometryKey, lodText] = key.split(':');
    const lod = Number(lodText);
    const kindId = items[0].kind;
    const geometry = catalogue.get(lod)?.[geometryKey];
    if (!geometry) { reject(state, kindId, 'no-geometry'); continue; }
    const material = kindId === 'tree' ? foliageMaterial : propMaterial;
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      positionVector.set(item.x, item.y, item.z);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), item.rotation);
      scaleVector.set(item.scale, item.heightScale ?? item.scale, item.scale);
      matrix.compose(positionVector, quaternion, scaleVector);
      mesh.setMatrixAt(i, matrix);
      const [r, g, b] = instanceTint(kindId, item.tintSeed);
      color.setRGB(r, g, b);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = `${STREET_FURNITURE_ID}:${key}`;
    // Shadow policy. Every extra caster is an extra shadow-map draw call, and
    // the QA capture path is a software GL backend, so only kinds with real
    // bulk cast, and only inside the two detailed rings. A 32 mm meter pole
    // could not resolve in the shadow map anyway - see the renderer's shadow
    // caster policy, which gets the final word after this pass.
    // Only the near tier casts. Every extra caster is another shadow-map draw
    // call, and the capture path is a software GL backend.
    mesh.castShadow = lod < 1 && SHADOW_CASTING_KINDS.has(kindId);
    mesh.receiveShadow = true;
    mesh.userData = {
      kind: 'street-furniture', pass: STREET_FURNITURE_ID, itemKind: kindId, geometryKey, lod,
    };
    group.add(mesh);
    const perItem = triangleOf(geometryKey, lod);
    triangles += perItem * items.length;
    meshes.push({
      kind: kindId, geometryKey, lod, instances: items.length, trianglesEach: perItem, drawCalls: 1,
    });
  }

  // Tree pits, merged into one ground decal mesh.
  const pitBuffer = makeFlatBuffer();
  for (const item of state.items) {
    if (item.kind !== 'tree') continue;
    emitTreePit(state, pitBuffer, item, item.lod < 1);
  }
  if (pitBuffer.triangles > 0) {
    const pitGeometry = new THREE.BufferGeometry();
    pitGeometry.setAttribute('position', new THREE.Float32BufferAttribute(pitBuffer.positions, 3));
    pitGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(pitBuffer.normals, 3));
    pitGeometry.setAttribute('color', new THREE.Float32BufferAttribute(pitBuffer.colors, 3));
    pitGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(pitBuffer.uvs, 2));
    pitGeometry.setIndex(pitBuffer.indices);
    pitGeometry.computeBoundingSphere();
    const pitMesh = new THREE.Mesh(pitGeometry, groundMaterial);
    pitMesh.name = `${STREET_FURNITURE_ID}:tree-pits`;
    pitMesh.castShadow = false;
    pitMesh.receiveShadow = true;
    pitMesh.renderOrder = 2;
    pitMesh.userData = { kind: 'road-markings', pass: STREET_FURNITURE_ID, itemKind: 'treePit' };
    group.add(pitMesh);
    triangles += pitBuffer.triangles;
    meshes.push({ kind: 'treePit', lod: 0, instances: 1, trianglesEach: pitBuffer.triangles, drawCalls: 1 });
  }

  // Release geometry for kinds that ended up with no instances.
  for (const [lod, set] of catalogue) {
    for (const [geometryKey, geometry] of Object.entries(set)) {
      if (!buckets.has(`${geometryKey}:${lod}`)) geometry?.dispose?.();
    }
  }

  const drawCalls = meshes.length;
  const segmentIds = [...state.usedSegments];
  const diagnostics = {
    version: STREET_FURNITURE_VERSION,
    implemented: true,
    focus: { x: focus.x, z: focus.z },
    focusSource: focus.source,
    focusRejected: focus.rejected,
    // Which datum the rings are centred on RIGHT NOW: the build focus on the
    // first build, the live camera after a re-centre.
    centreSource: overrides.centreSource || focus.source,
    windowRadius: outerRadius,
    plan: plan.stats,
    counts: state.counts,
    rejections: state.rejections,
    legacyOccupancySeeded: legacyOccupancy,
    buildingFootprints: state.buildings.count,
    rings: state.ringRecords.map((record, i) => ({
      ...record,
      maxItems: state.rings[i].maxItems,
      maxTriangles: state.rings[i].maxTriangles,
      withinBudget: record.triangles <= state.rings[i].maxTriangles
        && record.items <= state.rings[i].maxItems,
      kinds: state.rings[i].kinds ? [...state.rings[i].kinds] : 'all',
    })),
    meshes,
    totals: {
      items: state.items.length,
      triangles,
      drawCalls,
      withinTriangleBudget: triangles <= STREET_FURNITURE_BUDGET.maxTriangles,
      withinDrawCallBudget: drawCalls <= STREET_FURNITURE_BUDGET.maxDrawCalls,
    },
    sourceSegmentIds: segmentIds.slice(0, 256),
    sourceSegmentCount: segmentIds.length,
    buildMs: Date.now() - startedAt,
  };
  return {
    object: state.items.length ? group : null,
    diagnostics, items: state.items, plan, state, materials,
  };
}

// ---------------------------------------------------------------------------
// pass module: the LOD centre follows the camera
// ---------------------------------------------------------------------------
//
// ROUND 3 CORRECTION - READ THIS BEFORE CHANGING THE THRESHOLD.
//
// The ring note at the top of this file explains why the outer ring covers the
// whole window: a wrong focus must never empty the city. That fixed existence,
// not detail. `ctx.focus` is sampled ONCE, when the city is built, and the
// player - or the capture harness - then moves away from it. Measured on the
// round-3 capture set the rings were still centred on (1588.8, 369.5) while
// the street card stood at (1447.1, 1003.8), 640 m away, so EVERY tree in
// every captured frame drew the lod1 six-cluster form - including the one 18 m
// from the lens, which is the "placeholder tree" the reviews have flagged
// three rounds running. The near tier existed; nothing was standing in it.
//
// `update` re-centres the rings on the live camera once it has moved past
// STREET_FURNITURE_FOCUS.refreshMetres, exactly as facade-articulation does.
// The rebuild is SYNCHRONOUS and completes inside the update call, so a camera
// teleport - which is how every capture card is posed - is fully re-centred in
// the frame it is posed for. Nothing is interpolated.
//
// Threshold choice. The near ring reaches 120 m, so re-centring every 40 m
// keeps at least 80 m of lod0 furniture ahead of the eye while costing one
// rebuild per 40 m travelled instead of one per frame. Measured rebuild cost
// on the shipped slice is ~1.0 s in the browser (`buildMs` in the
// diagnostics), which is why the threshold is not tighter.
export const STREET_FURNITURE_FOCUS = Object.freeze({
  refreshMetres: 40,
});

/** Live pass state. A pass module is a singleton, so this is its whole world. */
const passState = {
  group: null,
  materials: null,
  centre: null,
  refreshes: 0,
  lastRefreshMs: 0,
  diagnostics: { version: STREET_FURNITURE_VERSION, implemented: false },
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
  id: STREET_FURNITURE_ID,
  order: 40,
  build(ctx) {
    passState.materials = createStreetFurnitureMaterials();
    const result = buildStreetFurniture(ctx, { materials: passState.materials });
    passState.group = result.object;
    passState.centre = { x: result.diagnostics.focus.x, z: result.diagnostics.focus.z };
    passState.refreshes = 0;
    passState.lastRefreshMs = 0;
    result.diagnostics.refreshes = 0;
    result.diagnostics.lastRefreshMs = 0;
    result.diagnostics.refreshMetres = STREET_FURNITURE_FOCUS.refreshMetres;
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
    if (moved < STREET_FURNITURE_FOCUS.refreshMetres) return;
    const startedAt = Date.now();
    const next = buildStreetFurniture(
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
      refreshMetres: STREET_FURNITURE_FOCUS.refreshMetres,
    });
  },

  dispose() {
    // The registry disposes the returned object's geometry and the materials
    // that are still attached to it. A material whose buffer ended up empty
    // was never attached, so release the whole set here and drop the
    // singleton's references, so a rebuilt city starts clean.
    disposeStreetFurnitureMaterials(passState.materials);
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
