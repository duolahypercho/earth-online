/**
 * Additive facade construction depth for city buildings.
 *
 * The city shell is a flat extruded prism with a painted window grid. That
 * reads as a prototype because every architectural element that should cast a
 * local shadow -- a window reveal, a sill, a string course, a cornice, a
 * shopfront head, a bay -- is texture instead of geometry. This module returns
 * *additive* geometry that sits on top of the untouched shell and gives those
 * elements real depth.
 *
 * Contract with the rest of the world:
 *  - It never moves, rescales, re-origins or re-indexes the source shell. The
 *    footprint polygon, the base elevation and the height are read-only inputs
 *    and every emitted vertex is clamped into the building's own
 *    footprint-AABB + height box (expanded horizontally by at most
 *    `maxProjection`, which is a caller-owned budget, default 0.45 m).
 *  - It is deterministic: all variation is drawn from a seed derived from the
 *    building id, and every random draw happens before any level-of-detail
 *    branching, so the same building produces the same facade at every LOD.
 *  - It is pure: `planFacadeDepth` needs no three.js, no DOM, no canvas and no
 *    GPU. `buildFacadeDepth` / `buildFacadeDepthBatch` only turn that plan into
 *    `THREE.BufferGeometry`.
 *  - It is merge friendly: geometry is grouped by (style, role) so a whole city
 *    of facade depth costs at most 12 extra draw calls, and it uses the same UV
 *    parameterisation as the shell so it can share the shell's facade texture.
 *
 * Detail tier is a screen-space decision, not a per-building one. Two
 * buildings standing side by side must never render at different facade
 * fidelity: a real cornice next to a painted-on window grid reads as a broken
 * asset, and that is more damaging than uniformly lower detail. So the tier is
 * derived from how many pixels one *reference storey* (3.4 m, a fixed metric
 * quantity that does not scale with the building) covers on screen:
 *
 *     pixelsPerMetre = viewportHeight / (2 * distance * tan(fov / 2))
 *     storeyPixels   = pixelsPerMetre * 3.4
 *
 * Facade construction has fixed metric sizes -- a 0.16 m window reveal, a
 * 0.7 m cornice, a 3.4 m storey -- so a 200 m tower and a 10 m shop at the same
 * distance present those elements at exactly the same size on screen. That is
 * why `facadeDetailTier` must not, and does not, read the building's own height
 * or footprint as a fidelity input. Height and footprint area are read for one
 * thing only: whether the building can carry facade construction at all
 * (`carriesFacadeConstruction`). That gate is provably a subset of what
 * `planFacadeDepth` already refuses, so it can never demote a building that
 * would otherwise have produced geometry, and therefore can never introduce a
 * visible difference between neighbours.
 *
 * Triangle cost per building, by detail tier (hard caps, enforced):
 *
 *   tier         cap    what it buys
 *   off            0    nothing; the shell texture carries the facade
 *   silhouette    32    cornice + plinth on the 2 longest edges. Budget relief
 *                         valve only, never the default floor.
 *   far           96    cornice / parapet cap + ground plinth on up to 4 edges,
 *                         plus a recessed glazing band on the lowest 2 storeys,
 *                         cut to the same reveal depth as a near-tier window so
 *                         a distant facade still throws a real horizontal shadow
 *   mid          512    + string courses, shopfront glazing line and door
 *                         recess, bays, and the first 24 recessed window openings
 *   near        1664    + sills, lintels, pilasters, and up to 60 recessed
 *                         window openings on 6 edges, 5 storeys deep
 *
 * `far` is the *floor* (`FACADE_DEPTH_MIN_TIER`), not the bottom of a cull. No
 * building handed to this module is ever demoted below it by distance. That is
 * the round-3 fix, and it is a fix to a measured failure, not a preference:
 *
 *   Round 2 gave every building a tier scored from one view point that the
 *   renderer picks once, at city build time. Measured on the real San Francisco
 *   slice (700 buildings, loadSfData center [1600,400] radius 720): with the
 *   ring centred on the build focus, 615 of 700 buildings scored `off` -- zero
 *   facade geometry -- and all eight buildings within 90 m of the night capture
 *   eye were among them, because the eye had walked ~615 m away from the ring
 *   centre. The city spent 14,292 of its 120,000 triangle allowance while 88%
 *   of it stayed a flat prism. Nothing in the tier function was wrong; the ring
 *   was simply centred somewhere the camera no longer was. A floor is the only
 *   repair a module with no per-frame rebuild can make.
 *
 * The floor costs, measured over the same 700 building corpus: every building
 * at `far` is 52,380 triangles (74.8 avg, 44% of the 120,000 allowance), which
 * leaves 67,620 for the near/mid rings. A full street-level batch from the
 * night pose measures 60,330 triangles at 12 draw calls, 0 buildings empty.
 *
 * Measured over the 700 building corpus the far tier now costs 54 triangles at
 * its cheapest, 96 at its ceiling and 77.1 on average, against a flat 48
 * before -- a cornice and a plinth and nothing else, which is exactly why a
 * distant facade read as a flat prism. The band replaces nothing:
 * it is emitted where the mid/near tiers would emit individual openings, at the
 * same sill and head heights, so approaching a building deepens the same lines
 * instead of introducing new ones.
 *
 * Integration sketch (the renderer owns the call site, this module does not):
 *
 *   const depth = buildFacadeDepthBatch(city.buildings, {
 *     viewPoint: { x: camera.position.x, z: camera.position.z },
 *     baseYFor: (b) => this.terrain?.heightAt?.(centroidX(b), centroidZ(b)) ?? 0,
 *   });
 *   for (const group of depth.groups) {
 *     const material = group.role === 'glass'
 *       ? this.facadeGlassMaterial          // dark, low roughness, envMap
 *       : this.facadeMaterialFor(group.style); // the shell's own wall material
 *     const mesh = new THREE.Mesh(group.geometry, material);
 *     mesh.castShadow = true;
 *     mesh.receiveShadow = true;
 *     root.add(mesh);                        // world space: identity transform
 *   }
 *
 * Geometry is emitted in world space with the shell's UV parameterisation
 * (12 m x 4.6 m per tile), so a structure group can share the building's
 * existing facade texture without any remapping.
 *
 * Scene budget for 700 visible buildings. `buildFacadeDepthBatch` never exceeds
 * the 120,000 triangle runtime allowance, and it never gets there by dropping
 * one building and keeping its neighbour. When a scene would overrun it the
 * batch degrades in three uniform steps, in this order:
 *
 *   1. lower one *global* tier ceiling, near -> mid -> far;
 *   2. lower one *global* tier floor, far -> silhouette -> off;
 *   3. only if both are exhausted, drop whole distance rings from the outside
 *      in, every building sharing a rank kept or dropped together.
 *
 * The ceiling goes first because taking construction off the buildings the
 * player is standing in front of costs more than taking it off the ones on the
 * horizon. Every step is uniform in distance, so a tight budget can never leave
 * one building detailed and its neighbour flat.
 *
 * What that costs on the real corpus, measured (700 buildings, night pose,
 * fov 47, 720 px):
 *
 *   all 700 at near      565,336 tri   does not fit
 *   all 700 at mid       203,114 tri   does not fit
 *   all 700 at far        52,380 tri   fits, 44% of the allowance  <- the floor
 *   all 700 at silhouette 16,800 tri   fits, 14%
 *   floor + real rings    60,330 tri   fits, 50%, 0 buildings empty
 *
 * So the "every building gets construction depth" guarantee is affordable at
 * the real corpus size with 59,670 triangles of headroom. It stops being
 * affordable somewhere around 1,600 visible buildings at the far floor; past
 * that the batch lowers the floor to `silhouette` rather than dropping anyone,
 * and reports the floor it used in `tierFloor`.
 *
 * Only the storeys a street-level camera can actually read are detailed; tall
 * towers get their lowest storeys and keep the texture above.
 */
import * as THREE from 'three';

export const FACADE_DEPTH_VERSION = 'facade-depth-1';

/** Facade style vocabulary, mirrored from the renderer's FACADE_STYLES. */
export const FACADE_DEPTH_STYLES = Object.freeze([
  'edwardian',
  'modern-grid',
  'bay-window',
  'shopfront',
  'loft',
  'art-deco',
]);

/** Geometry roles. Each role is one merged draw call per style. */
export const FACADE_DEPTH_ROLES = Object.freeze(['structure', 'glass']);

/**
 * The detail ladder, weakest first.
 *
 * `off` is the only rung that emits nothing, and it is no longer reachable from
 * distance. See `FACADE_DEPTH_MIN_TIER`.
 */
export const FACADE_DEPTH_LODS = Object.freeze(['off', 'silhouette', 'far', 'mid', 'near']);

/**
 * The lowest tier a building may be demoted to by *distance*.
 *
 * This is the fix for the round-2 artefact. The tier ring is centred on one
 * view point that the caller chooses once, at build time. If the camera later
 * stands somewhere else -- and it always does, because the player walks -- then
 * a building thirty metres in front of the lens can still be carrying the tier
 * it earned six hundred metres from the ring centre. Measured on the real San
 * Francisco slice: with the ring centred on the build focus, every one of the
 * eight buildings within 90 m of the night capture eye scored `off`, i.e. zero
 * facade geometry, while relief was being spent on buildings 600 m away. That
 * is precisely "a real cornice beside a painted-on window grid", and no amount
 * of tier *equality* fixes it, because the two neighbours really were at equal
 * distance from the ring centre -- the ring centre was simply in the wrong
 * place.
 *
 * So the module stops relying on the view point for correctness and only uses
 * it for refinement: every building it is handed gets at least this tier,
 * whatever the distance, and the view point can only ever raise it. `off`
 * remains reachable, but only when the caller explicitly asks for it (an
 * explicit `tier`/`lod`, a `tierFor` that returns it, or `minTier: 'off'`), or
 * when the scene budget forces a uniform degrade.
 */
export const FACADE_DEPTH_MIN_TIER = 'far';

/** Shell UV parameterisation, matched to the renderer's building extrusion. */
export const FACADE_DEPTH_UV_METRES = Object.freeze({ x: 12, y: 4.6 });

/** Default outward projection allowance, in metres, for the whole module. */
export const FACADE_DEPTH_MAX_PROJECTION = 0.45;

export const FACADE_DEPTH_BUDGET = Object.freeze({
  visibleBuildings: 700,
  trianglesPerBuilding: Object.freeze({ off: 0, silhouette: 32, far: 96, mid: 512, near: 1664 }),
  // The tier no building may fall below on distance alone.
  minTier: FACADE_DEPTH_MIN_TIER,
  // A plausible street-level distribution of 700 visible buildings, with the
  // far-tier floor applied: nothing sits at `off`.
  referenceMix: Object.freeze({ near: 16, mid: 96, far: 588, silhouette: 0, off: 0 }),
  referenceTriangles: 16 * 1664 + 96 * 512 + 588 * 96,
  // What `buildFacadeDepthBatch` will actually spend. It degrades uniformly
  // rather than dropping individual buildings, so this is a hard ceiling.
  sceneTriangleBudget: 120000,
  // The arithmetic worst case of the reference mix, every building pinned to
  // its tier ceiling. Declared so the raised far-tier floor is budgeted, not
  // assumed; the runtime allowance above is what the batch enforces.
  worstCaseAllowance: 136000,
  // Worst case if every visible building were forced to mid detail.
  allMidTriangles: 700 * 512,
  // The cost of the floor on its own: every visible building at the far tier
  // and nothing above it. This is what the guarantee "no building is ever a
  // flat prism" actually costs, and it has to fit inside sceneTriangleBudget
  // with room left for the near/mid rings or the guarantee is not affordable.
  allFarCeilingTriangles: 700 * 96,
  allSilhouetteCeilingTriangles: 700 * 32,
  maxDrawCalls: FACADE_DEPTH_STYLES.length * FACADE_DEPTH_ROLES.length,
});

/** The four detail tiers, weakest first. Alias of FACADE_DEPTH_LODS. */
export const FACADE_DEPTH_TIERS = FACADE_DEPTH_LODS;

/** Ordering used to compare tiers. Higher rank is more construction. */
export const FACADE_TIER_RANK = Object.freeze({ off: 0, silhouette: 1, far: 2, mid: 3, near: 4 });

/**
 * Uniform degrade ladder for the tier *floor*, cheapest last. It deliberately
 * stops at `silhouette` and never reaches `off`: once the floor is as cheap as
 * it goes, the honest next move is to drop whole distance rings from the
 * outside in -- which keeps the buildings the player is standing in front of --
 * not to strip the entire city back to bare prisms.
 */
const FLOOR_LADDER = Object.freeze(['far', 'silhouette']);

/**
 * Reference screen. Used whenever the caller does not pass camera parameters,
 * so a legacy call site keeps the ring distances it had before the tier became
 * screen-space (59.7 / 138.3 / 328.4 m).
 */
export const FACADE_DEPTH_SCREEN = Object.freeze({ fov: 50, viewportHeight: 720 });

/**
 * The facade's natural unit of construction, in metres. Deliberately a fixed
 * metric quantity: it is the same for every building, which is what makes the
 * tier equal for equal-distance neighbours.
 */
export const FACADE_DEPTH_REFERENCE_STOREY = 3.4;

/**
 * Tier thresholds, in screen pixels covered by one reference storey.
 *  near: a storey is 44 px tall -- a 0.16 m reveal is ~2 px, so a real shadow.
 *  mid : 19 px -- openings still resolve, sills and lintels do not.
 *  far : 8 px -- only a horizontal band can be read; below this the shell
 *        texture carries the facade on its own.
 */
export const FACADE_DEPTH_TIER_PIXELS = Object.freeze({ near: 44, mid: 19, far: 8 });

/**
 * Per-style construction language. `revealDepth` is the window recess and is
 * held inside the 0.10-0.25 m band the brief calls for.
 */
export const FACADE_STYLE_PROFILES = Object.freeze({
  edwardian: Object.freeze({
    bayWidth: 3.1,
    windowRatio: 0.52,
    revealDepth: 0.16,
    sill: true,
    lintel: true,
    stringCourse: true,
    pilaster: false,
    bay: false,
    corniceHeight: 0.72,
    corniceProjection: 0.22,
    plinthHeight: 0.55,
    plinthProjection: 0.09,
    commercialGround: false,
  }),
  'modern-grid': Object.freeze({
    bayWidth: 3.8,
    windowRatio: 0.74,
    revealDepth: 0.12,
    sill: false,
    lintel: false,
    stringCourse: false,
    pilaster: false,
    bay: false,
    corniceHeight: 0.42,
    corniceProjection: 0.1,
    plinthHeight: 0.4,
    plinthProjection: 0.06,
    commercialGround: true,
  }),
  'bay-window': Object.freeze({
    bayWidth: 3.4,
    windowRatio: 0.55,
    revealDepth: 0.14,
    sill: true,
    lintel: true,
    stringCourse: true,
    pilaster: false,
    bay: true,
    bayProjection: 0.45,
    corniceHeight: 0.62,
    corniceProjection: 0.2,
    plinthHeight: 0.6,
    plinthProjection: 0.09,
    commercialGround: false,
  }),
  shopfront: Object.freeze({
    bayWidth: 3.2,
    windowRatio: 0.58,
    revealDepth: 0.18,
    sill: true,
    lintel: true,
    stringCourse: true,
    pilaster: false,
    bay: false,
    corniceHeight: 0.58,
    corniceProjection: 0.18,
    plinthHeight: 0.35,
    plinthProjection: 0.07,
    commercialGround: true,
  }),
  loft: Object.freeze({
    bayWidth: 4.4,
    windowRatio: 0.68,
    revealDepth: 0.22,
    sill: true,
    lintel: false,
    stringCourse: false,
    pilaster: false,
    bay: false,
    corniceHeight: 0.8,
    corniceProjection: 0.25,
    plinthHeight: 0.7,
    plinthProjection: 0.1,
    commercialGround: true,
  }),
  'art-deco': Object.freeze({
    bayWidth: 3.6,
    windowRatio: 0.5,
    revealDepth: 0.2,
    sill: true,
    lintel: true,
    stringCourse: true,
    pilaster: true,
    bay: false,
    corniceHeight: 0.9,
    corniceProjection: 0.24,
    plinthHeight: 0.65,
    plinthProjection: 0.1,
    commercialGround: true,
  }),
});

const LOD_CONFIG = Object.freeze({
  off: Object.freeze({
    edges: 0, storeys: 0, windows: 0, windowBands: 0,
    cornice: false, plinth: false, stringCourse: false, bay: false,
    shopfront: false, sill: false, lintel: false, pilaster: false,
  }),
  // The floor. Two longest edges get a cornice and a plinth and nothing else:
  // a roofline that catches the sun and a base course that catches the ground
  // shadow, for 24 triangles. It exists so the scene budget has a uniform step
  // between the far-tier floor and dropping a building entirely -- it is never
  // the default floor, because a facade with no glazing depth still reads flat
  // from the pavement.
  silhouette: Object.freeze({
    edges: 2, storeys: 0, windows: 0, windowBands: 0,
    cornice: true, plinth: true, stringCourse: false, bay: false,
    shopfront: false, sill: false, lintel: false, pilaster: false,
  }),
  // `windowBands` is the far tier's substitute for individual openings: one
  // recessed glazing band per storey, spanning the edge, cut at the same
  // reveal depth a near-tier window would use and sitting between the same
  // sill and head heights. It is a far-tier-only feature by design -- the mid
  // and near tiers emit the openings themselves, and a band drawn over them
  // would occlude the deeper reveals behind it.
  far: Object.freeze({
    edges: 4, storeys: 0, windows: 0, windowBands: 2,
    cornice: true, plinth: true, stringCourse: false, bay: false,
    shopfront: false, sill: false, lintel: false, pilaster: false,
  }),
  mid: Object.freeze({
    edges: 4, storeys: 3, windows: 24, windowBands: 0,
    cornice: true, plinth: true, stringCourse: true, bay: true,
    shopfront: true, sill: false, lintel: false, pilaster: false,
  }),
  near: Object.freeze({
    edges: 6, storeys: 5, windows: 60, windowBands: 0,
    cornice: true, plinth: true, stringCourse: true, bay: true,
    shopfront: true, sill: true, lintel: true, pilaster: true,
  }),
});

// Window column pitch is LOD independent on purpose: a lower LOD emits a
// prefix of the same openings, so approaching a building adds detail instead of
// sliding the existing detail sideways.
const MAX_BAYS_PER_EDGE = 8;
// Anything that would otherwise sit exactly on the shell base is lifted by
// this much so a horizontal face cannot z-fight with the sidewalk.
const GROUND_CLEARANCE = 0.03;
const MIN_EDGE_LENGTH = 3;
const MIN_PLAN_EXTENT = 3;
const MIN_BUILDING_HEIGHT = 3;
// A footprint smaller than this cannot carry facade construction: it is a
// kiosk, a lift head or a map artefact. Refused by the planner *and* used by
// `carriesFacadeConstruction`, so the two always agree.
const MIN_FOOTPRINT_AREA = MIN_PLAN_EXTENT * MIN_PLAN_EXTENT;
// Guard so a camera standing inside a building cannot divide by zero.
const MIN_TIER_DISTANCE = 0.5;
const MIN_WINDOW_WIDTH = 0.7;
const MIN_WINDOW_HEIGHT = 0.7;
const EPSILON = 1e-6;

// ---------------------------------------------------------------- primitives

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** FNV-1a over the building id: stable across runs, machines and processes. */
export function facadeDepthSeed(id) {
  const text = String(id ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash ^ 0x9e3779b9) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Facade tags that are not in the vocabulary but do occur on real records --
 * OSM `building:facade`, `building:architecture`, hand-authored fixtures, and
 * the synonyms a data pipeline picks up on the way. Mapped, never dropped.
 *
 * Keys are normalised: lower case, underscores and spaces folded to hyphens.
 */
export const FACADE_STYLE_ALIASES = Object.freeze({
  // bay / oriel language
  victorian: 'bay-window',
  italianate: 'bay-window',
  'queen-anne': 'bay-window',
  oriel: 'bay-window',
  bay: 'bay-window',
  bays: 'bay-window',
  'bay-windows': 'bay-window',
  // masonry terrace language
  terrace: 'edwardian',
  terraced: 'edwardian',
  masonry: 'edwardian',
  stone: 'edwardian',
  stucco: 'edwardian',
  plaster: 'edwardian',
  classical: 'edwardian',
  church: 'edwardian',
  // heavy-frame / brick language
  brick: 'loft',
  'brick-loft': 'loft',
  warehouse: 'loft',
  industrial: 'loft',
  factory: 'loft',
  timber: 'loft',
  // deco language
  deco: 'art-deco',
  artdeco: 'art-deco',
  moderne: 'art-deco',
  gothic: 'art-deco',
  civic: 'art-deco',
  landmark: 'art-deco',
  // retail language
  retail: 'shopfront',
  shop: 'shopfront',
  store: 'shopfront',
  storefront: 'shopfront',
  commercial: 'shopfront',
  mixed: 'shopfront',
  // curtain-wall language
  glass: 'modern-grid',
  'curtain-wall': 'modern-grid',
  curtainwall: 'modern-grid',
  modern: 'modern-grid',
  grid: 'modern-grid',
  contemporary: 'modern-grid',
  concrete: 'modern-grid',
  office: 'modern-grid',
  tower: 'modern-grid',
  highrise: 'modern-grid',
  'high-rise': 'modern-grid',
});

/** Building `type` -> style, for records with no usable facade tag. */
const TYPE_STYLE = Object.freeze({
  shop: 'shopfront',
  retail: 'shopfront',
  rowhouse: 'bay-window',
  house: 'bay-window',
  residential: 'bay-window',
  apartment: 'edwardian',
  midrise: 'edwardian',
  warehouse: 'loft',
  industrial: 'loft',
  civic: 'art-deco',
  landmark: 'art-deco',
  tower: 'modern-grid',
  office: 'modern-grid',
});

/** Building `usage` -> style. Third in the chain, after facade tag and type. */
const USAGE_STYLE = Object.freeze({
  retail: 'shopfront',
  commercial: 'shopfront',
  office: 'modern-grid',
  industrial: 'loft',
  civic: 'art-deco',
  residential: 'bay-window',
  mixed: 'shopfront',
});

/** Wall material -> style, used before the last-resort height rule. */
const MATERIAL_STYLE = Object.freeze({
  brick: 'loft',
  stone: 'edwardian',
  clapboard: 'bay-window',
  wood: 'bay-window',
  plaster: 'edwardian',
  glass: 'modern-grid',
  concrete: 'modern-grid',
  metal: 'modern-grid',
});

function normaliseStyleKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/**
 * Resolve a building record to one of the six supported facade styles, and say
 * where the answer came from.
 *
 * Total by construction: every branch ends inside `FACADE_DEPTH_STYLES`, so a
 * record with a missing, empty, misspelt or entirely unknown `facade` tag still
 * gets construction depth in *some* architectural language rather than falling
 * through to a bare shell. The chain is declared tag -> alias -> street trade ->
 * type -> usage -> material -> massing, and it reads no randomness, so the same
 * record always resolves the same way.
 *
 * @returns {{style: string, source: 'declared'|'alias'|'trade'|'type'|'usage'|'material'|'massing'}}
 */
export function resolveFacadeStyleEntry(building) {
  const declared = building?.facade;
  if (FACADE_DEPTH_STYLES.includes(declared)) return { style: declared, source: 'declared' };

  const key = normaliseStyleKey(declared);
  if (key) {
    if (FACADE_DEPTH_STYLES.includes(key)) return { style: key, source: 'alias' };
    const aliased = FACADE_STYLE_ALIASES[key];
    if (aliased) return { style: aliased, source: 'alias' };
  }

  // A tagged shop or amenity is a shopfront whatever else the record says.
  if (building?.shop || building?.amenity) return { style: 'shopfront', source: 'trade' };

  const type = normaliseStyleKey(building?.type);
  if (TYPE_STYLE[type]) return { style: TYPE_STYLE[type], source: 'type' };
  if (FACADE_STYLE_ALIASES[type]) return { style: FACADE_STYLE_ALIASES[type], source: 'type' };

  const usage = normaliseStyleKey(building?.usage);
  if (USAGE_STYLE[usage]) return { style: USAGE_STYLE[usage], source: 'usage' };

  const material = normaliseStyleKey(building?.material);
  if (MATERIAL_STYLE[material]) return { style: MATERIAL_STYLE[material], source: 'material' };

  // Last resort: read the massing. A tall record is a frame building, a short
  // one is a masonry terrace. Both are better guesses than a fixed default.
  const height = Number(building?.height);
  if (Number.isFinite(height) && height >= 24) return { style: 'modern-grid', source: 'massing' };
  if (Number.isFinite(height) && height >= 9) return { style: 'edwardian', source: 'massing' };
  return { style: 'bay-window', source: 'massing' };
}

/** Resolve a building record to one of the six supported facade styles. */
export function resolveFacadeStyle(building) {
  return resolveFacadeStyleEntry(building).style;
}

/** True when the ground floor should read as retail rather than residential. */
export function hasStreetLevelTrade(building) {
  if (!building) return false;
  if (building.shop) return true;
  if (building.amenity) return true;
  if (building.type === 'shop') return true;
  if (building.usage === 'retail' || building.usage === 'commercial' || building.usage === 'mixed') return true;
  return building.facade === 'shopfront';
}

// ---------------------------------------------------------------- detail tier

function resolveScreen(options) {
  const fov = Number(options?.fov);
  const viewportHeight = Number(options?.viewportHeight);
  return {
    fov: Number.isFinite(fov) && fov > 1 && fov < 179 ? fov : FACADE_DEPTH_SCREEN.fov,
    viewportHeight: Number.isFinite(viewportHeight) && viewportHeight >= 16
      ? viewportHeight
      : FACADE_DEPTH_SCREEN.viewportHeight,
  };
}

function resolveTierPixels(options) {
  const override = options?.tierPixels;
  if (!override) return FACADE_DEPTH_TIER_PIXELS;
  const near = Number.isFinite(override.near) ? override.near : FACADE_DEPTH_TIER_PIXELS.near;
  const mid = Number.isFinite(override.mid) ? override.mid : FACADE_DEPTH_TIER_PIXELS.mid;
  const far = Number.isFinite(override.far) ? override.far : FACADE_DEPTH_TIER_PIXELS.far;
  return { near, mid, far };
}

function resolveReferenceStorey(options) {
  const value = Number(options?.referenceStorey);
  return Number.isFinite(value) && value > 0 ? value : FACADE_DEPTH_REFERENCE_STOREY;
}

/**
 * The lowest tier distance may demote a building to. Defaults to
 * `FACADE_DEPTH_MIN_TIER`; a caller that really does want distant buildings
 * bare has to say `minTier: 'off'` out loud.
 */
export function resolveMinTier(options) {
  const requested = options?.minTier;
  return FACADE_DEPTH_LODS.includes(requested) ? requested : FACADE_DEPTH_MIN_TIER;
}

/** Raise `tier` to at least `floor` and lower it to at most `ceiling`. */
export function clampTier(tier, floor = 'off', ceiling = 'near') {
  const rank = FACADE_TIER_RANK[tier] ?? 0;
  const floorRank = FACADE_TIER_RANK[floor] ?? 0;
  const ceilingRank = FACADE_TIER_RANK[ceiling] ?? FACADE_TIER_RANK.near;
  const bounded = Math.min(Math.max(rank, Math.min(floorRank, ceilingRank)), ceilingRank);
  return FACADE_DEPTH_LODS[bounded];
}

/**
 * Screen scale in pixels per world metre for a perspective camera. Depends on
 * the camera and the viewport only -- never on what is being looked at.
 */
export function facadeDepthPixelsPerMetre(distance, fov, viewportHeight) {
  const screen = resolveScreen({ fov, viewportHeight });
  const d = Number(distance);
  if (!Number.isFinite(d) || d < 0) return 0;
  const clamped = Math.max(d, MIN_TIER_DISTANCE);
  return screen.viewportHeight / (2 * clamped * Math.tan((screen.fov * Math.PI) / 360));
}

/**
 * Can this building carry facade construction at all?
 *
 * This is a *capability* test, never a fidelity test. It is deliberately a
 * strict subset of what `planFacadeDepth` already refuses:
 *
 *   height < MIN_BUILDING_HEIGHT     -> planner skips with reason 'height'
 *   footprintArea < MIN_FOOTPRINT_AREA -> planner skips with reason 'area'
 *
 * So a building this returns false for produces zero geometry at *every* tier.
 * Demoting it to 'off' therefore cannot make it look different from the
 * building beside it -- both were always going to be bare shells.
 *
 * A missing or non-finite input is treated as unknown and never gates.
 */
export function carriesFacadeConstruction(height, footprintArea) {
  const h = Number(height);
  if (Number.isFinite(h) && h < MIN_BUILDING_HEIGHT) return false;
  const area = Number(footprintArea);
  if (Number.isFinite(area) && area >= 0 && area < MIN_FOOTPRINT_AREA) return false;
  return true;
}

/**
 * Screen-space detail tier, with the measurements that produced it.
 *
 * Pure: same inputs, same output, no clock, no seed, no scene state. The tier
 * is a function of (distance, fov, viewportHeight) alone for every building
 * that can carry construction, which is what guarantees:
 *
 *  - two buildings side by side at the same distance land in the same tier,
 *    whatever their height, footprint, style, id or index; and
 *  - the tier is monotone: a nearer building never gets a lower tier than a
 *    farther one, because storeyPixels is strictly decreasing in distance and
 *    the thresholds are ordered near > mid > far.
 *
 * @param {object} params
 * @param {number} params.distance      camera-to-building distance, metres
 * @param {number} [params.height]      building height, metres (capability only)
 * @param {number} [params.footprintArea] footprint area, m^2 (capability only)
 * @param {number} [params.fov]         vertical field of view, degrees
 * @param {number} [params.viewportHeight] drawing buffer height, pixels
 * @param {{near:number,mid:number,far:number}} [params.tierPixels] threshold override
 * @param {number} [params.referenceStorey] reference storey height, metres
 * @returns {{tier:string, distance:number, fov:number, viewportHeight:number,
 *   pixelsPerMetre:number, storeyPixels:number, screenHeightPixels:number,
 *   carries:boolean, reason:string|null}}
 */
export function facadeDetailTierMetrics(params = {}) {
  const screen = resolveScreen(params);
  const thresholds = resolveTierPixels(params);
  const referenceStorey = resolveReferenceStorey(params);
  const minTier = resolveMinTier(params);
  const distance = Number(params.distance);
  const base = {
    tier: 'off',
    minTier,
    distance,
    fov: screen.fov,
    viewportHeight: screen.viewportHeight,
    pixelsPerMetre: 0,
    storeyPixels: 0,
    screenHeightPixels: 0,
    carries: true,
    reason: null,
  };
  if (!Number.isFinite(distance) || distance < 0) return { ...base, reason: 'distance' };

  const pixelsPerMetre = facadeDepthPixelsPerMetre(distance, screen.fov, screen.viewportHeight);
  const storeyPixels = pixelsPerMetre * referenceStorey;
  const height = Number(params.height);
  const measured = {
    ...base,
    pixelsPerMetre,
    storeyPixels,
    screenHeightPixels: Number.isFinite(height) ? Math.max(0, height) * pixelsPerMetre : 0,
  };
  if (!carriesFacadeConstruction(params.height, params.footprintArea)) {
    return { ...measured, carries: false, reason: 'no-construction' };
  }
  if (storeyPixels >= thresholds.near) return { ...measured, tier: 'near', minTier };
  if (storeyPixels >= thresholds.mid) return { ...measured, tier: 'mid', minTier };
  if (storeyPixels >= thresholds.far) return { ...measured, tier: 'far', minTier };
  // Below the far threshold the storey no longer resolves, but the building is
  // not therefore allowed to become a flat prism: it drops to the floor, not to
  // `off`. `reason` still records that it fell off the bottom of the ladder, so
  // the diagnostics stay honest about what happened.
  return { ...measured, tier: minTier, reason: 'below-far', minTier };
}

/**
 * The assertable entry point the integrator calls, per frame or per build:
 * (distance, height, footprintArea, fov, viewportHeight) -> tier.
 */
export function facadeDetailTier(params = {}) {
  return facadeDetailTierMetrics(params).tier;
}

/**
 * The distance, in metres, at which each tier boundary falls for a given
 * screen. Useful for culling rings and for asserting the tier round trip.
 */
export function facadeDetailTierDistances(screenOptions = {}) {
  const screen = resolveScreen(screenOptions);
  const thresholds = resolveTierPixels(screenOptions);
  const referenceStorey = resolveReferenceStorey(screenOptions);
  const k = (screen.viewportHeight * referenceStorey) / (2 * Math.tan((screen.fov * Math.PI) / 360));
  return Object.freeze({ near: k / thresholds.near, mid: k / thresholds.mid, far: k / thresholds.far });
}

/**
 * Distance thresholds, in metres, for the reference screen. Derived from the
 * tier function rather than declared beside it, so the two cannot drift.
 */
export const FACADE_DEPTH_LOD_DISTANCES = facadeDetailTierDistances();

/**
 * Distance-only tier lookup, kept for call sites that have no camera. It is
 * the screen-space tier evaluated on the reference screen.
 */
export function facadeDepthLodForDistance(distance, distances = FACADE_DEPTH_LOD_DISTANCES, minTier = FACADE_DEPTH_MIN_TIER) {
  const floor = FACADE_DEPTH_LODS.includes(minTier) ? minTier : FACADE_DEPTH_MIN_TIER;
  const d = Number(distance);
  if (!Number.isFinite(d)) return floor;
  if (d <= distances.near) return 'near';
  if (d <= distances.mid) return clampTier('mid', floor, 'near');
  if (d <= distances.far) return clampTier('far', floor, 'near');
  return floor;
}

function normalisePolygon(polygon) {
  const points = [];
  if (!Array.isArray(polygon)) return points;
  for (const raw of polygon) {
    const x = Number(Array.isArray(raw) ? raw[0] : raw?.x);
    const z = Number(Array.isArray(raw) ? raw[1] : raw?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
    const previous = points[points.length - 1];
    if (previous && Math.hypot(x - previous.x, z - previous.z) < 1e-4) continue;
    points.push({ x, z });
  }
  while (points.length > 2 && Math.hypot(points[0].x - points[points.length - 1].x, points[0].z - points[points.length - 1].z) < 1e-4) {
    points.pop();
  }
  return points.length >= 3 ? points : [];
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

function buildEdges(points) {
  const area = signedArea(points);
  const flip = area > 0 ? 1 : -1;
  const edges = [];
  let offset = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (!(length > EPSILON)) continue;
    const ux = dx / length;
    const uz = dz / length;
    edges.push({
      index: i,
      ax: a.x,
      az: a.z,
      ux,
      uz,
      nx: flip * uz,
      nz: -flip * ux,
      length,
      offset,
    });
    offset += length;
  }
  return edges;
}

// ------------------------------------------------------------------ planning

/**
 * A quad emitter that fixes its own winding. Corners are given in edge-local
 * (s, y, d) coordinates: s runs along the edge, y is world height, d is the
 * outward offset from the wall plane (negative is a recess). The face normal is
 * recomputed with Newell's method and the corner order is reversed when it
 * disagrees with the hint, so no call site can emit a backfacing quad.
 */
class QuadSink {
  constructor(context) {
    this.context = context;
    this.quads = [];
    this.triangles = 0;
    this.pending = null;
    this.counts = Object.create(null);
  }

  begin() {
    this.pending = [];
    return this;
  }

  /** Commit the pending feature only if it fits the remaining budget. */
  commit(feature) {
    const pending = this.pending || [];
    this.pending = null;
    const cost = pending.length * 2;
    if (!pending.length) return false;
    if (this.triangles + cost > this.context.triangleCap) return false;
    for (const quad of pending) {
      quad.feature = feature;
      this.quads.push(quad);
    }
    this.triangles += cost;
    this.counts[feature] = (this.counts[feature] || 0) + 1;
    return true;
  }

  abort() {
    this.pending = null;
  }

  quad(role, edge, corners, hint) {
    const ctx = this.context;
    const positions = new Array(12);
    const uvs = new Array(8);
    for (let i = 0; i < 4; i += 1) {
      const [s, y, d] = corners[i];
      const point = ctx.place(edge, s, y, d);
      positions[i * 3] = point[0];
      positions[i * 3 + 1] = point[1];
      positions[i * 3 + 2] = point[2];
      uvs[i * 2] = (edge.offset + s) / ctx.uvMetres.x;
      uvs[i * 2 + 1] = (point[1] - ctx.baseY) / ctx.uvMetres.y;
    }
    // Newell normal of the placed quad.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) % 4;
      const x0 = positions[i * 3];
      const y0 = positions[i * 3 + 1];
      const z0 = positions[i * 3 + 2];
      const x1 = positions[j * 3];
      const y1 = positions[j * 3 + 1];
      const z1 = positions[j * 3 + 2];
      nx += (y0 - y1) * (z0 + z1);
      ny += (z0 - z1) * (x0 + x1);
      nz += (x0 - x1) * (y0 + y1);
    }
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) return; // degenerate after clamping: drop it.
    nx /= len;
    ny /= len;
    nz /= len;
    const hintWorld = ctx.direction(edge, hint);
    if (nx * hintWorld[0] + ny * hintWorld[1] + nz * hintWorld[2] < 0) {
      // Reverse winding (and the normal) rather than trusting the call site.
      for (let i = 0; i < 2; i += 1) {
        const a = i;
        const b = 3 - i;
        for (let k = 0; k < 3; k += 1) {
          const tmp = positions[a * 3 + k];
          positions[a * 3 + k] = positions[b * 3 + k];
          positions[b * 3 + k] = tmp;
        }
        for (let k = 0; k < 2; k += 1) {
          const tmp = uvs[a * 2 + k];
          uvs[a * 2 + k] = uvs[b * 2 + k];
          uvs[b * 2 + k] = tmp;
        }
      }
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const value of positions) {
      if (!Number.isFinite(value)) return;
    }
    (this.pending || this.quads).push({
      role,
      feature: null,
      edgeIndex: edge.index,
      positions,
      uvs,
      normal: [nx, ny, nz],
    });
  }
}

/**
 * Placement context: converts edge-local (s, y, d) into world space and clamps
 * every vertex into the building's own AABB, expanded outward by at most
 * `maxProjection`. This is what makes the "never leaves the source volume"
 * invariant hold by construction instead of by convention.
 */
function createPlacement(bounds, baseY, height, maxProjection, uvMetres, triangleCap) {
  const minX = bounds.minX - maxProjection;
  const maxX = bounds.maxX + maxProjection;
  const minZ = bounds.minZ - maxProjection;
  const maxZ = bounds.maxZ + maxProjection;
  const minY = baseY;
  const maxY = baseY + height;
  return {
    baseY,
    uvMetres,
    triangleCap,
    // `y` is a local height above the shell base; the caller never has to
    // carry the terrain sample around.
    place(edge, s, y, d) {
      const x = edge.ax + edge.ux * s + edge.nx * d;
      const z = edge.az + edge.uz * s + edge.nz * d;
      return [clamp(x, minX, maxX), clamp(baseY + y, minY, maxY), clamp(z, minZ, maxZ)];
    },
    direction(edge, hint) {
      switch (hint) {
        case 'out': return [edge.nx, 0, edge.nz];
        case 'in': return [-edge.nx, 0, -edge.nz];
        case 'up': return [0, 1, 0];
        case 'down': return [0, -1, 0];
        case 'along': return [edge.ux, 0, edge.uz];
        case 'against': return [-edge.ux, 0, -edge.uz];
        default: return [edge.nx, 0, edge.nz];
      }
    },
  };
}

/** Horizontal band with a real soffit: projecting ledge or recessed groove. */
function emitLedge(sink, edge, s0, s1, yBottom, yTop, depth, role = 'structure') {
  if (!(s1 - s0 > EPSILON) || !(yTop - yBottom > EPSILON) || Math.abs(depth) < 1e-3) return;
  const outer = depth;
  sink.quad(role, edge, [[s0, yBottom, outer], [s0, yTop, outer], [s1, yTop, outer], [s1, yBottom, outer]], 'out');
  // Top surface of a projecting ledge faces up; the top of a groove is the
  // soffit of the wall above it and faces down.
  sink.quad(role, edge, [[s0, yTop, 0], [s1, yTop, 0], [s1, yTop, outer], [s0, yTop, outer]], depth > 0 ? 'up' : 'down');
  sink.quad(role, edge, [[s0, yBottom, 0], [s1, yBottom, 0], [s1, yBottom, outer], [s0, yBottom, outer]], depth > 0 ? 'down' : 'up');
}

/**
 * Recessed glazing band: one horizontal strip cut back into the wall between a
 * storey's sill and head heights, with a lit cill below and a shadowed head
 * soffit above. Three quads, six triangles, and it reads at 8 px per storey --
 * this is what stops a far-tier facade from being a flat prism.
 */
function emitBand(sink, edge, s0, s1, yBottom, yTop, depth) {
  if (!(s1 - s0 > EPSILON) || !(yTop - yBottom > EPSILON)) return;
  const d = -Math.abs(depth);
  sink.quad('glass', edge, [[s0, yBottom, d], [s0, yTop, d], [s1, yTop, d], [s1, yBottom, d]], 'out');
  sink.quad('structure', edge, [[s0, yTop, 0], [s1, yTop, 0], [s1, yTop, d], [s0, yTop, d]], 'down');
  sink.quad('structure', edge, [[s0, yBottom, 0], [s1, yBottom, 0], [s1, yBottom, d], [s0, yBottom, d]], 'up');
}

/** Recessed opening: four reveal returns plus the pane set back in the hole. */
function emitReveal(sink, edge, s0, s1, y0, y1, depth, paneRole = 'glass') {
  const d = -Math.abs(depth);
  sink.quad(paneRole, edge, [[s0, y0, d], [s0, y1, d], [s1, y1, d], [s1, y0, d]], 'out');
  sink.quad('structure', edge, [[s0, y0, 0], [s0, y1, 0], [s0, y1, d], [s0, y0, d]], 'along');
  sink.quad('structure', edge, [[s1, y0, 0], [s1, y1, 0], [s1, y1, d], [s1, y0, d]], 'against');
  sink.quad('structure', edge, [[s0, y1, 0], [s1, y1, 0], [s1, y1, d], [s0, y1, d]], 'down');
  sink.quad('structure', edge, [[s0, y0, 0], [s1, y0, 0], [s1, y0, d], [s0, y0, d]], 'up');
}

/**
 * Sill and head height of one storey's glazing zone. Shared by the far tier's
 * band and the mid/near tiers' individual openings, so the tiers cannot
 * disagree about where the glazing sits: approaching a building deepens the
 * same horizontal line instead of sliding it.
 */
function glazingBandFor(layout, storey, variant, height) {
  if (!(storey >= 0) || storey >= layout.stories) return null;
  const floorY = layout.floors[storey];
  const storeyHeight = layout.tops[storey] - floorY;
  if (!(storeyHeight > 2.2)) return null;
  const sillY = floorY + clamp(storeyHeight * 0.26, 0.7, variant.sillLift);
  let windowHeight = Math.min(storeyHeight * 0.56, 2.3);
  windowHeight = Math.min(windowHeight, floorY + storeyHeight - 0.3 - sillY);
  if (windowHeight < MIN_WINDOW_HEIGHT) return null;
  const headY = sillY + windowHeight;
  if (headY > height - 0.15) return null;
  return { sillY, headY };
}

function storeyLayout(building, height, commercial) {
  let stories = Math.round(Number(building?.stories));
  const capacity = Math.max(1, Math.floor(height / 2.5));
  if (!Number.isFinite(stories) || stories < 1) stories = Math.max(1, Math.round(height / 3.4));
  stories = clamp(stories, 1, Math.min(capacity, 60));
  if (stories === 1) {
    return { stories: 1, floors: [0], tops: [height] };
  }
  const preferred = commercial ? 4.4 : 3.6;
  const room = height - 2.5 * (stories - 1);
  const ground = clamp(preferred, 2.5, Math.max(2.5, room));
  const upper = (height - ground) / (stories - 1);
  const floors = [0];
  const tops = [ground];
  for (let i = 1; i < stories; i += 1) {
    floors.push(ground + (i - 1) * upper);
    tops.push(ground + i * upper);
  }
  tops[tops.length - 1] = height;
  return { stories, floors, tops };
}

/** Deterministic per-building variation, drawn before any LOD branching. */
function drawVariant(building, style) {
  const random = mulberry32(facadeDepthSeed(building?.id));
  const profile = FACADE_STYLE_PROFILES[style];
  return {
    bayWidth: profile.bayWidth * (0.9 + random() * 0.22),
    windowRatio: clamp(profile.windowRatio * (0.94 + random() * 0.14), 0.4, 0.86),
    revealDepth: clamp(profile.revealDepth * (0.88 + random() * 0.26), 0.1, 0.25),
    corniceHeight: profile.corniceHeight * (0.9 + random() * 0.24),
    plinthHeight: profile.plinthHeight * (0.88 + random() * 0.3),
    sillLift: 0.85 + random() * 0.32,
    doorPick: random(),
    bayColumns: random() < 0.45 ? 1 : 2,
    bayStoreys: 2 + Math.floor(random() * 2),
    pilasterPick: random(),
    shopHead: 0.28 + random() * 0.18,
  };
}

/**
 * Pure facade plan. No three.js, no DOM. Returns quads in world space with the
 * shell's own UV parameterisation, plus exact triangle accounting.
 *
 * @param {object} building city.buildings[i] shaped record
 * @param {object} [options]
 * @param {'off'|'far'|'mid'|'near'} [options.tier='near'] detail tier
 * @param {'off'|'far'|'mid'|'near'} [options.lod='near'] legacy alias of tier
 * @param {number} [options.baseY=0] ground elevation of the shell base
 * @param {number} [options.maxProjection=0.45] outward projection allowance (m)
 * @param {number} [options.triangleCap] override the per-LOD triangle cap
 * @param {{x:number,y:number}} [options.uvMetres]
 */
export function planFacadeDepth(building, options = {}) {
  // `tier` is the current name; `lod` is kept so existing call sites keep
  // working. They mean the same thing and only one of them may be set.
  const requested = options.tier !== undefined ? options.tier : options.lod;
  const lod = FACADE_DEPTH_LODS.includes(requested) ? requested : 'near';
  const resolved = resolveFacadeStyleEntry(building);
  const style = resolved.style;
  const styleSource = resolved.source;
  const profile = FACADE_STYLE_PROFILES[style];
  const config = LOD_CONFIG[lod];
  const cap = Number.isFinite(options.triangleCap)
    ? Math.max(0, options.triangleCap)
    : FACADE_DEPTH_BUDGET.trianglesPerBuilding[lod];
  const maxProjection = Number.isFinite(options.maxProjection)
    ? clamp(options.maxProjection, 0, FACADE_DEPTH_MAX_PROJECTION)
    : FACADE_DEPTH_MAX_PROJECTION;
  const uvMetres = options.uvMetres || FACADE_DEPTH_UV_METRES;
  const baseY = Number.isFinite(options.baseY) ? options.baseY : 0;
  const height = Number(building?.height);

  const empty = {
    id: building?.id ?? null,
    style,
    styleSource,
    lod,
    quads: [],
    triangles: 0,
    features: {},
    bounds: null,
    baseY,
    height: Number.isFinite(height) ? height : 0,
    maxProjection,
    skipped: 'empty',
  };

  const points = normalisePolygon(building?.polygon);
  if (!points.length) return { ...empty, skipped: 'polygon' };
  if (!Number.isFinite(height) || height < MIN_BUILDING_HEIGHT) return { ...empty, skipped: 'height' };
  if (cap <= 0 || lod === 'off') return { ...empty, skipped: 'lod-off' };

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const planExtent = Math.min(maxX - minX, maxZ - minZ);
  if (!(planExtent >= MIN_PLAN_EXTENT)) return { ...empty, skipped: 'extent' };
  // Refused for the same reason `carriesFacadeConstruction` refuses it: a
  // footprint this small is a kiosk or a map artefact, not a facade. Keeping
  // the two in lockstep is what makes the tier gate provably harmless.
  const footprintArea = Math.abs(signedArea(points));
  if (!(footprintArea >= MIN_FOOTPRINT_AREA)) return { ...empty, skipped: 'area' };

  const allEdges = buildEdges(points);
  if (!allEdges.length) return { ...empty, skipped: 'edges' };

  const variant = drawVariant(building, style);
  // A tagged shop or amenity earns a real recessed entrance; a style whose
  // ground floor is glazed by convention only earns the glazing line.
  const tagged = hasStreetLevelTrade(building);
  const commercial = tagged || profile.commercialGround;
  const layout = storeyLayout(building, height, commercial);
  // Inward recesses can never eat more than a fifth of the plan thickness, so
  // a reveal cannot punch through a narrow building.
  const inwardLimit = Math.max(0.05, Math.min(0.45, planExtent * 0.2));
  const reveal = Math.min(variant.revealDepth, inwardLimit);

  const placement = createPlacement({ minX, maxX, minZ, maxZ }, baseY, height, maxProjection, uvMetres, cap);
  const sink = new QuadSink(placement);

  const ranked = allEdges.slice().sort((a, b) => (b.length - a.length) || (a.index - b.index));
  const edges = ranked.filter((edge) => edge.length >= MIN_EDGE_LENGTH).slice(0, config.edges);
  if (!edges.length) return { ...empty, skipped: 'short-edges' };
  const primary = edges[0];

  const project = (value) => Math.min(value, maxProjection);
  const grooveOr = (value, groove) => (project(value) >= 0.02 ? project(value) : groove);

  // 1. Cornice / parapet cap at the roofline. Cheapest, highest silhouette
  //    value: it is what stops a roof edge reading as a cut-off box.
  if (config.cornice) {
    const corniceHeight = Math.min(variant.corniceHeight, height * 0.12);
    const depth = grooveOr(profile.corniceProjection, -Math.min(0.08, inwardLimit));
    for (const edge of edges) {
      sink.begin();
      emitLedge(sink, edge, 0, edge.length, height - corniceHeight, height, depth);
      sink.commit('cornice');
    }
  }

  // 2. Ground plinth: the base course that gives the wall a foot.
  if (config.plinth) {
    const plinthHeight = Math.min(variant.plinthHeight, height * 0.14);
    const depth = grooveOr(profile.plinthProjection, -Math.min(0.05, inwardLimit));
    for (const edge of edges) {
      sink.begin();
      // Lifted off the base plane so the plinth soffit cannot z-fight with the
      // sidewalk or the terrain sample the shell sits on.
      emitLedge(sink, edge, 0, edge.length, GROUND_CLEARANCE, plinthHeight, depth);
      sink.commit('plinth');
    }
  }

  // 3. Ground floor: shopfront glazing line and a recessed door for anything
  //    with a shop or amenity tag, on the street-facing (longest) edge.
  const groundTop = layout.tops[0];
  // Tier independent on purpose: the far tier needs to know where the shopfront
  // sits so its ground-storey band lands on the same line the mid tier will
  // turn into a real glazing reveal.
  const shopEligible = commercial && groundTop > 2.6 && primary.length >= 4;
  let shopBand = null;
  if (shopEligible) {
    const head = groundTop - Math.max(0.5, variant.shopHead * 1.6);
    const cill = Math.min(0.65, groundTop * 0.18);
    const inset = Math.min(0.9, primary.length * 0.08);
    const s0 = inset;
    const s1 = primary.length - inset;
    if (s1 - s0 > 1.2 && head - cill > 1.2) shopBand = { s0, s1, sillY: cill, headY: head };
  }
  const shopWindows = shopEligible && config.shopfront;
  if (shopWindows && shopBand) {
    const { s0, s1, sillY: cill, headY: head } = shopBand;
    const glazingDepth = Math.min(0.22, inwardLimit);
    {
      sink.begin();
      emitReveal(sink, primary, s0, s1, cill, head, glazingDepth, 'glass');
      sink.commit('shopfront-glazing');

      // Door recess: a deeper hole so the entrance reads from the sidewalk.
      const doorWidth = clamp((s1 - s0) * 0.16, 1, 1.8);
      const doorCentre = s0 + (s1 - s0) * (0.2 + variant.doorPick * 0.6);
      const d0 = clamp(doorCentre - doorWidth / 2, s0, s1 - doorWidth);
      const doorHeight = Math.min(2.4, head - 0.15);
      const doorDepth = Math.min(0.35, inwardLimit);
      if (tagged && doorHeight > 1.9) {
        sink.begin();
        emitReveal(sink, primary, d0, d0 + doorWidth, GROUND_CLEARANCE, doorHeight, doorDepth, 'glass');
        // Threshold floor of the recess, held just off the sidewalk plane.
        sink.quad('structure', primary, [[d0, GROUND_CLEARANCE, 0], [d0 + doorWidth, GROUND_CLEARANCE, 0], [d0 + doorWidth, GROUND_CLEARANCE, -doorDepth], [d0, GROUND_CLEARANCE, -doorDepth]], 'up');
        sink.commit('door-recess');
      }
    }
  }

  // 4. String courses between storeys, for the older styles.
  if (config.stringCourse && profile.stringCourse && layout.stories > 1) {
    const depth = grooveOr(0.14, -Math.min(0.06, inwardLimit));
    const last = Math.min(layout.stories - 1, config.storeys);
    for (const edge of edges) {
      for (let storey = 1; storey <= last; storey += 1) {
        const y = layout.floors[storey];
        if (!(y > 0.6) || y + 0.3 > height) continue;
        sink.begin();
        emitLedge(sink, edge, 0, edge.length, y - 0.15, y + 0.15, depth);
        sink.commit('string-course');
      }
    }
  }

  // 5. Bay windows. San Francisco's signature: a projecting three-sided oriel
  //    over the upper storeys. With a zero projection allowance it degrades to
  //    a recessed oriel niche rather than disappearing.
  if (config.bay && profile.bay && layout.stories > 1) {
    const projection = project(profile.bayProjection || 0.4);
    const depth = projection >= 0.08 ? projection : -Math.min(0.25, inwardLimit);
    const bayEdges = edges.slice(0, 2);
    const topStorey = Math.min(layout.stories - 1, config.storeys, variant.bayStoreys);
    for (const edge of bayEdges) {
      const columns = Math.min(variant.bayColumns, Math.max(1, Math.floor(edge.length / 4.5)));
      const pitch = edge.length / columns;
      const width = Math.min(pitch * 0.6, 3);
      if (width < 1.4 || topStorey < 1) continue;
      const splay = Math.min(width * 0.2, 0.5);
      for (let column = 0; column < columns; column += 1) {
        const centre = (column + 0.5) * pitch;
        const s0 = centre - width / 2;
        const s1 = centre + width / 2;
        const yBottom = layout.floors[1];
        const yTop = Math.min(layout.tops[topStorey], height - 0.2);
        if (!(yTop - yBottom > 2)) continue;
        sink.begin();
        // Front pane and the two splayed cheeks, per storey, plus caps.
        for (let storey = 1; storey <= topStorey; storey += 1) {
          const y0 = Math.max(yBottom, layout.floors[storey]) + 0.18;
          const y1 = Math.min(yTop, layout.tops[storey]) - 0.18;
          if (!(y1 - y0 > 0.8)) continue;
          sink.quad('glass', edge, [[s0 + splay, y0, depth], [s0 + splay, y1, depth], [s1 - splay, y1, depth], [s1 - splay, y0, depth]], 'out');
          sink.quad('glass', edge, [[s0, y0, 0], [s0, y1, 0], [s0 + splay, y1, depth], [s0 + splay, y0, depth]], 'against');
          sink.quad('glass', edge, [[s1, y0, 0], [s1, y1, 0], [s1 - splay, y1, depth], [s1 - splay, y0, depth]], 'along');
        }
        sink.quad('structure', edge, [[s0, yBottom, 0], [s1, yBottom, 0], [s1 - splay, yBottom, depth], [s0 + splay, yBottom, depth]], depth > 0 ? 'down' : 'up');
        sink.quad('structure', edge, [[s0, yTop, 0], [s1, yTop, 0], [s1 - splay, yTop, depth], [s0 + splay, yTop, depth]], depth > 0 ? 'up' : 'down');
        sink.commit('bay-window');
      }
    }
  }

  // 6. Pilasters: vertical fins between bays, art-deco only.
  if (config.pilaster && profile.pilaster) {
    const depth = project(0.12);
    if (depth >= 0.04) {
      for (const edge of edges.slice(0, 2)) {
        const columns = clamp(Math.floor(edge.length / variant.bayWidth), 1, MAX_BAYS_PER_EDGE);
        const pitch = edge.length / columns;
        const width = clamp(pitch * 0.12, 0.25, 0.6);
        const yTop = Math.max(0, height - Math.min(variant.corniceHeight, height * 0.12));
        for (let column = 1; column < columns; column += 1) {
          const s0 = column * pitch - width / 2;
          const s1 = s0 + width;
          if (s0 < 0.1 || s1 > edge.length - 0.1 || yTop < 3) continue;
          sink.begin();
          sink.quad('structure', edge, [[s0, GROUND_CLEARANCE, depth], [s0, yTop, depth], [s1, yTop, depth], [s1, GROUND_CLEARANCE, depth]], 'out');
          sink.quad('structure', edge, [[s0, GROUND_CLEARANCE, 0], [s0, yTop, 0], [s0, yTop, depth], [s0, GROUND_CLEARANCE, depth]], 'against');
          sink.quad('structure', edge, [[s1, GROUND_CLEARANCE, 0], [s1, yTop, 0], [s1, yTop, depth], [s1, GROUND_CLEARANCE, depth]], 'along');
          sink.commit('pilaster');
        }
      }
    }
  }

  // 7. Recessed window openings with sills and lintels. Emitted last and per
  //    window, so the budget trims whole windows rather than half a facade.
  let windowsLeft = config.windows;
  if (windowsLeft > 0) {
    const sillDepth = project(0.12);
    const lintelDepth = project(0.09);
    const topStorey = Math.min(layout.stories - 1, config.storeys);
    for (const edge of edges) {
      if (windowsLeft <= 0) break;
      const columns = clamp(Math.floor((edge.length - 1) / variant.bayWidth), 1, MAX_BAYS_PER_EDGE);
      const pitch = edge.length / columns;
      const width = Math.min(variant.bayWidth * variant.windowRatio, pitch * 0.72, 2.6);
      if (width < MIN_WINDOW_WIDTH) continue;
      for (let storey = 0; storey <= topStorey; storey += 1) {
        if (windowsLeft <= 0) break;
        if (storey === 0 && shopWindows) continue;
        const band = glazingBandFor(layout, storey, variant, height);
        if (!band) continue;
        const { sillY, headY } = band;
        for (let column = 0; column < columns; column += 1) {
          if (windowsLeft <= 0) break;
          const centre = (column + 0.5) * pitch;
          const s0 = centre - width / 2;
          const s1 = centre + width / 2;
          if (s0 < 0.25 || s1 > edge.length - 0.25) continue;
          sink.begin();
          emitReveal(sink, edge, s0, s1, sillY, headY, reveal, 'glass');
          if (config.sill && profile.sill && sillDepth >= 0.03) {
            emitLedge(sink, edge, s0 - 0.14, s1 + 0.14, sillY - 0.12, sillY, sillDepth);
          }
          if (config.lintel && profile.lintel && lintelDepth >= 0.03 && headY + 0.18 < height) {
            emitLedge(sink, edge, s0 - 0.1, s1 + 0.1, headY, headY + 0.14, lintelDepth);
          }
          if (sink.commit('window')) windowsLeft -= 1;
          else { windowsLeft = 0; break; }
        }
      }
    }
  }

  // 8. Far-tier glazing bands. The far tier cannot afford individual openings,
  //    and a facade with only a cornice and a plinth still reads as a flat
  //    prism, so each of the lowest storeys gets one continuous recessed band
  //    at the same sill and head heights the mid tier will use, cut to the same
  //    reveal depth. Cost is six triangles per band per edge: at most
  //    2 storeys x 4 edges = 48, on top of the 24 + 24 the cornice and plinth
  //    spend, for a 96 triangle far tier.
  if (config.windowBands > 0) {
    const bandDepth = clamp(Math.min(reveal, inwardLimit), 0.08, 0.25);
    const bandStoreys = Math.min(config.windowBands, layout.stories);
    for (let storey = 0; storey < bandStoreys; storey += 1) {
      // A shop-eligible ground storey belongs to the shopfront, not to the
      // residential window grid: it takes the shopfront's own line, on the
      // shopfront's own edge, so the far -> mid handover does not move it.
      const shopStorey = storey === 0 && shopEligible;
      const range = shopStorey && shopBand
        ? shopBand
        : glazingBandFor(layout, storey, variant, height);
      if (!range) continue;
      const bandEdges = shopStorey ? [primary] : edges;
      for (const edge of bandEdges) {
        const inset = clamp(edge.length * 0.06, 0.2, 0.9);
        const s0 = inset;
        const s1 = edge.length - inset;
        if (!(s1 - s0 > 1)) continue;
        sink.begin();
        emitBand(sink, edge, s0, s1, range.sillY, range.headY, bandDepth);
        sink.commit('window-band');
      }
    }
  }

  let boundsMinX = Infinity;
  let boundsMaxX = -Infinity;
  let boundsMinY = Infinity;
  let boundsMaxY = -Infinity;
  let boundsMinZ = Infinity;
  let boundsMaxZ = -Infinity;
  for (const quad of sink.quads) {
    for (let i = 0; i < 4; i += 1) {
      const x = quad.positions[i * 3];
      const y = quad.positions[i * 3 + 1];
      const z = quad.positions[i * 3 + 2];
      boundsMinX = Math.min(boundsMinX, x);
      boundsMaxX = Math.max(boundsMaxX, x);
      boundsMinY = Math.min(boundsMinY, y);
      boundsMaxY = Math.max(boundsMaxY, y);
      boundsMinZ = Math.min(boundsMinZ, z);
      boundsMaxZ = Math.max(boundsMaxZ, z);
    }
  }

  return {
    id: building?.id ?? null,
    style,
    styleSource,
    lod,
    quads: sink.quads,
    triangles: sink.triangles,
    features: { ...sink.counts },
    bounds: sink.quads.length
      ? { minX: boundsMinX, maxX: boundsMaxX, minY: boundsMinY, maxY: boundsMaxY, minZ: boundsMinZ, maxZ: boundsMaxZ }
      : null,
    footprint: { minX, maxX, minZ, maxZ },
    footprintArea,
    baseY,
    height,
    maxProjection,
    storeys: layout.stories,
    skipped: sink.quads.length ? null : 'no-features',
  };
}

// ------------------------------------------------------------------ geometry

function geometryFromQuads(quads) {
  const count = quads.length;
  if (!count) return null;
  const positions = new Float32Array(count * 12);
  const normals = new Float32Array(count * 12);
  const uvs = new Float32Array(count * 8);
  const index = count * 4 > 65535 ? new Uint32Array(count * 6) : new Uint16Array(count * 6);
  for (let q = 0; q < count; q += 1) {
    const quad = quads[q];
    positions.set(quad.positions, q * 12);
    uvs.set(quad.uvs, q * 8);
    for (let v = 0; v < 4; v += 1) {
      normals[q * 12 + v * 3] = quad.normal[0];
      normals[q * 12 + v * 3 + 1] = quad.normal[1];
      normals[q * 12 + v * 3 + 2] = quad.normal[2];
    }
    const base = q * 4;
    const i = q * 6;
    index[i] = base;
    index[i + 1] = base + 1;
    index[i + 2] = base + 2;
    index[i + 3] = base;
    index[i + 4] = base + 2;
    index[i + 5] = base + 3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Build the additive facade geometry for one building.
 *
 * @returns {{
 *   id: *, style: string, lod: string, triangles: number,
 *   parts: { structure: THREE.BufferGeometry|null, glass: THREE.BufferGeometry|null },
 *   plan: object
 * }}
 */
export function buildFacadeDepth(building, options = {}) {
  const plan = planFacadeDepth(building, options);
  const structure = [];
  const glass = [];
  for (const quad of plan.quads) (quad.role === 'glass' ? glass : structure).push(quad);
  return {
    id: plan.id,
    style: plan.style,
    lod: plan.lod,
    triangles: plan.triangles,
    parts: {
      structure: geometryFromQuads(structure),
      glass: geometryFromQuads(glass),
    },
    plan,
  };
}

/** Deterministic footprint centroid and area, derived from the polygon. */
export function facadeFootprintMetrics(building) {
  const polygon = normalisePolygon(building?.polygon);
  if (!polygon.length) {
    const declared = Number(building?.footprintArea);
    return { centroid: null, area: Number.isFinite(declared) ? declared : NaN };
  }
  let cx = 0;
  let cz = 0;
  for (const point of polygon) {
    cx += point.x;
    cz += point.z;
  }
  return {
    centroid: { x: cx / polygon.length, z: cz / polygon.length },
    // The polygon is authoritative: a record-declared area can disagree with
    // the geometry the planner will actually read.
    area: Math.abs(signedArea(polygon)),
  };
}

/**
 * One tier decision per building, with the distance that produced it.
 *
 * Every path here is uniform in distance. Nothing that can differ between two
 * neighbours standing at the same distance -- style, id, index, height, storey
 * count -- reaches the tier, except the capability gate, which only ever fires
 * on buildings that produce no geometry at any tier.
 */
function resolveTierEntry(building, options, index) {
  const metrics = facadeFootprintMetrics(building);
  const view = options.viewPoint;
  const distance = metrics.centroid && view && Number.isFinite(view.x) && Number.isFinite(view.z)
    ? Math.hypot(metrics.centroid.x - view.x, metrics.centroid.z - view.z)
    : NaN;

  let tier = null;
  if (typeof options.tierFor === 'function') {
    const chosen = options.tierFor(building, index);
    if (FACADE_DEPTH_TIERS.includes(chosen)) tier = chosen;
  }
  if (tier === null && typeof options.lodFor === 'function') {
    const chosen = options.lodFor(building, index);
    if (FACADE_DEPTH_TIERS.includes(chosen)) tier = chosen;
  }
  if (tier === null && FACADE_DEPTH_TIERS.includes(options.tier)) tier = options.tier;
  if (tier === null && FACADE_DEPTH_TIERS.includes(options.lod)) tier = options.lod;
  const minTier = resolveMinTier(options);
  const explicit = tier !== null;
  if (tier === null && Number.isFinite(distance)) {
    if (options.lodDistances) {
      tier = facadeDepthLodForDistance(distance, options.lodDistances, minTier);
    } else {
      tier = facadeDetailTier({
        distance,
        height: building?.height,
        footprintArea: metrics.area,
        fov: options.fov,
        viewportHeight: options.viewportHeight,
        tierPixels: options.tierPixels,
        referenceStorey: options.referenceStorey,
        minTier,
      });
    }
  }
  // No view point at all: the caller cannot have meant "make the whole city
  // flat", so an unknown distance lands on the floor rather than on `off`.
  if (tier === null) tier = metrics.centroid ? 'near' : minTier;
  // The capability gate is the one thing allowed to pull a building under the
  // floor, and only because such a building emits nothing at any tier anyway.
  if (!carriesFacadeConstruction(building?.height, metrics.area)) tier = 'off';

  return {
    building,
    index,
    tier,
    explicit,
    minTier,
    distance,
    // Ring order. Distance when the caller gave a view point, declaration
    // order otherwise, so the outside-in cut below always has an ordering.
    rank: Number.isFinite(distance) ? distance : index,
  };
}

function planEntries(entries, options, ceiling, floor) {
  const planned = [];
  let triangles = 0;
  for (const entry of entries) {
    // The capability gate already forced these to `off`; they emit nothing at
    // any tier, so the floor must not try to lift them back up.
    const tier = entry.tier === 'off' ? 'off' : clampTier(entry.tier, floor, ceiling);
    if (tier === 'off') continue;
    const baseY = typeof options.baseYFor === 'function'
      ? Number(options.baseYFor(entry.building))
      : options.baseY;
    const plan = planFacadeDepth(entry.building, {
      tier,
      baseY: Number.isFinite(baseY) ? baseY : 0,
      maxProjection: options.maxProjection,
      uvMetres: options.uvMetres,
    });
    if (!plan.quads.length) continue;
    planned.push({ entry, plan });
    triangles += plan.triangles;
  }
  return { planned, triangles };
}

/**
 * Width of one distance ring, in metres, for the last-resort budget cut.
 *
 * The cut used to group buildings by their exact float distance. On synthetic
 * rings that is a real equivalence class; on real data every building has its
 * own distance to seventeen digits, so an "outside-in ring cut" degenerated
 * into dropping buildings one at a time -- measured on the real slice, a cut
 * separated two buildings 0.2 m apart in distance. Quantising the rank to a
 * band makes the cut coarse enough to read as a distance fade rather than as a
 * hole punched in the block.
 */
export const FACADE_DEPTH_RING_METRES = 8;

/** Distance rank quantised to a ring band. */
function ringRank(rank) {
  if (!Number.isFinite(rank)) return rank;
  return Math.floor(rank / FACADE_DEPTH_RING_METRES) * FACADE_DEPTH_RING_METRES;
}

/**
 * Drop whole distance rings from the outside in until the scene fits. Every
 * building sharing a ring band is kept or dropped together, so the cut can
 * never separate two neighbours standing on the same block.
 */
function ringCut(planned, budget) {
  const ordered = planned.slice().sort((a, b) => (ringRank(a.entry.rank) - ringRank(b.entry.rank)) || (a.entry.index - b.entry.index));
  let triangles = 0;
  let cutRank = -Infinity;
  let i = 0;
  while (i < ordered.length) {
    const rank = ringRank(ordered[i].entry.rank);
    let j = i;
    let ringCost = 0;
    while (j < ordered.length && ringRank(ordered[j].entry.rank) === rank) {
      ringCost += ordered[j].plan.triangles;
      j += 1;
    }
    if (triangles + ringCost > budget) break;
    triangles += ringCost;
    cutRank = rank;
    i = j;
  }
  return {
    cutRank,
    triangles,
    planned: planned.filter((item) => ringRank(item.entry.rank) <= cutRank),
  };
}

/**
 * Build merged facade depth for a set of buildings.
 *
 * Geometry is merged per (style, role), so the whole city costs at most
 * `FACADE_DEPTH_BUDGET.maxDrawCalls` (12) additional draw calls.
 *
 * Budget behaviour is deliberately uniform. An earlier version walked the list
 * and skipped whichever building happened to cross the budget line, which put a
 * fully detailed facade next to an untouched prism at the same distance -- the
 * single most damaging facade artefact there is. Instead the batch now lowers
 * one *global* tier ceiling (near -> mid -> far) and, only if that still does
 * not fit, drops whole distance rings from the outside in.
 *
 * @param {Array<object>} buildings
 * @param {object} [options]
 * @param {'off'|'far'|'mid'|'near'} [options.tier] pin every building to a tier
 * @param {'off'|'far'|'mid'|'near'} [options.lod] legacy alias of tier
 * @param {(building:object, index:number)=>string} [options.tierFor]
 * @param {(building:object, index:number)=>string} [options.lodFor] legacy alias
 * @param {{x:number,z:number}} [options.viewPoint] screen-space tiering origin
 * @param {number} [options.fov] vertical field of view, degrees
 * @param {number} [options.viewportHeight] drawing buffer height, pixels
 * @param {(building:object)=>number} [options.baseYFor] terrain sample per building
 * @param {number} [options.baseY]
 * @param {number} [options.maxProjection]
 * @param {'off'|'silhouette'|'far'|'mid'|'near'} [options.minTier='far'] the
 *   lowest tier distance may demote a building to. Leave it alone unless you
 *   have a reason: it is what guarantees no building is ever a flat prism.
 * @param {number} [options.sceneTriangleBudget] hard ceiling, degraded uniformly
 * @returns {{version:string, groups:Array, drawCalls:number, triangles:number,
 *   buildings:Array, skipped:number, emptyBuildings:number, tiers:object,
 *   requestedTiers:object, tierCeiling:string, tierFloor:string, minTier:string,
 *   styleSources:object, ringCutDistance:number|null, sceneTriangleBudget:number}}
 */
export function buildFacadeDepthBatch(buildings, options = {}) {
  const list = Array.isArray(buildings) ? buildings : [];
  const sceneBudget = Number.isFinite(options.sceneTriangleBudget)
    ? Math.max(0, options.sceneTriangleBudget)
    : FACADE_DEPTH_BUDGET.sceneTriangleBudget;

  const minTier = resolveMinTier(options);
  const entries = list.map((building, index) => resolveTierEntry(building, options, index));
  const requestedTiers = { off: 0, silhouette: 0, far: 0, mid: 0, near: 0 };
  for (const entry of entries) requestedTiers[entry.tier] += 1;

  // Uniform degrade ladder. Every step is a *global* move, so no step can ever
  // leave one building detailed and its neighbour at the same distance bare:
  //   1. lower the tier ceiling  near -> mid -> far
  //   2. lower the tier floor    minTier -> silhouette -> off
  //   3. drop whole distance rings from the outside in (last resort)
  // The floor is only lowered after the ceiling has bottomed out, because
  // taking construction away from the near buildings the player is standing in
  // front of costs more than taking it away from the far ones.
  let ceiling = 'near';
  let floor = minTier;
  let attempt = planEntries(entries, options, ceiling, floor);
  for (const next of ['mid', 'far']) {
    if (attempt.triangles <= sceneBudget) break;
    ceiling = next;
    attempt = planEntries(entries, options, ceiling, clampTier(floor, 'off', ceiling));
  }
  floor = clampTier(floor, 'off', ceiling);
  for (const next of FLOOR_LADDER) {
    if (attempt.triangles <= sceneBudget) break;
    if (FACADE_TIER_RANK[next] >= FACADE_TIER_RANK[floor]) continue;
    floor = next;
    attempt = planEntries(entries, options, ceiling, floor);
  }
  let cutRank = null;
  let planned = attempt.planned;
  let triangles = attempt.triangles;
  if (triangles > sceneBudget) {
    const cut = ringCut(planned, sceneBudget);
    planned = cut.planned;
    triangles = cut.triangles;
    cutRank = Number.isFinite(cut.cutRank) ? cut.cutRank : null;
  }

  const buckets = new Map();
  const perBuilding = [];
  const tiers = { off: 0, silhouette: 0, far: 0, mid: 0, near: 0 };
  const styleSources = Object.create(null);
  for (const { entry, plan } of planned) {
    tiers[plan.lod] += 1;
    styleSources[plan.styleSource] = (styleSources[plan.styleSource] || 0) + 1;
    perBuilding.push({
      id: plan.id,
      style: plan.style,
      styleSource: plan.styleSource,
      tier: plan.lod,
      lod: plan.lod,
      distance: entry.distance,
      triangles: plan.triangles,
    });
    for (const quad of plan.quads) {
      const key = `${plan.style}:${quad.role}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, style: plan.style, role: quad.role, quads: [], buildingIds: [] };
        buckets.set(key, bucket);
      }
      bucket.quads.push(quad);
      if (bucket.buildingIds[bucket.buildingIds.length - 1] !== plan.id) bucket.buildingIds.push(plan.id);
    }
  }

  const groups = [];
  const orderedKeys = Array.from(buckets.keys()).sort();
  for (const key of orderedKeys) {
    const bucket = buckets.get(key);
    const geometry = geometryFromQuads(bucket.quads);
    if (!geometry) continue;
    groups.push({
      key,
      style: bucket.style,
      role: bucket.role,
      geometry,
      triangles: bucket.quads.length * 2,
      quads: bucket.quads.length,
      buildingIds: bucket.buildingIds.slice(),
    });
  }
  return {
    version: FACADE_DEPTH_VERSION,
    groups,
    drawCalls: groups.length,
    triangles,
    buildings: perBuilding,
    skipped: list.length - perBuilding.length,
    tiers,
    requestedTiers,
    tierCeiling: ceiling,
    tierFloor: floor,
    minTier,
    styleSources,
    // Buildings handed in that emit nothing. With the floor in place this is
    // only ever the capability gate (a building under 3 m or under 9 m2, which
    // produces no geometry at any tier) plus anything an explicit caller tier
    // or a last-resort ring cut removed -- never a plain distance demotion.
    emptyBuildings: list.length - perBuilding.length,
    ringCutDistance: cutRank,
    sceneTriangleBudget: sceneBudget,
  };
}

/** Release every geometry produced by build* helpers. */
export function disposeFacadeDepth(result) {
  if (!result) return;
  if (result.parts) {
    for (const geometry of Object.values(result.parts)) geometry?.dispose?.();
  }
  if (Array.isArray(result.groups)) {
    for (const group of result.groups) group.geometry?.dispose?.();
  }
}

// ===========================================================================
// Facade articulation: constructed elevations
// ===========================================================================
//
// Everything above this line is *additive relief*: trim laid on top of the
// shell, with the shell's painted window grid still doing the work of the
// window. That is why a street still read as painted boxes. The painted grid
// is a 128 px canvas tiled every 12 m x 4.6 m, so its "windows" are a fixed
// metric wallpaper with no relation to the building's storeys -- three to six
// rows per 4.6 m, i.e. a window every 0.8-1.5 m of wall. No amount of trim
// laid over that reads as architecture, and real openings laid over it read as
// two disagreeing grids.
//
// This section therefore *clads*: it replaces the visible wall with real
// construction. For every edge it emits a partition of the whole rectangle
// [0, edgeLength] x [0, height] -- base, spandrels, piers, openings, cap --
// standing `ART_CLAD` (20 mm) proud of the shell wall, so the painted grid is
// covered rather than competed with. The partition is contiguous by
// construction: a budget cut lowers the whole elevation to a cheaper
// vocabulary, it never removes a piece and leaves a hole.
//
// Vocabulary, base to cap:
//
//   base    plinth, or a commercial storefront: bulkhead, recessed display
//           glazing with shopfront mullions, transom light, fascia/sign band,
//           end piers, and a deeper recessed entry with a door leaf.
//   shaft   per storey: spandrel wall, piers between bays, and either real
//           openings (reveal returns, frame ring, glass set back behind the
//           frame, mullion/transom bars, projecting sill with a drip recess
//           under it, lintel) or -- further away -- one recessed glazing band
//           per storey on the same sill/head line, so approaching a building
//           deepens the same lines instead of moving them.
//   cap     bed mould, corona, parapet wall, coping. Profile follows the era:
//           a masonry building gets the full entablature, a curtain-wall
//           building gets a thin coping and a shadow reveal.
//
// Weathering follows the geometry rather than a decal: every quad carries a
// soffit factor (how sheltered/self-shadowed that face is: 0 for a sunlit
// front face, ~1 for a head soffit or a drip recess) and vertex colour is
// darkened by that factor plus a ground-splash falloff. Dirt therefore ends up
// under sills, inside reveals, under cornices and at the pavement, because
// those are the faces that carry the factor.
//
// LOD is by distance from the caller's focus, in four rings; see
// FACADE_ARTICULATION_RINGS for the radii and per-ring budget.

/**
 * The depth stack, measured outward from the shell wall (d = 0).
 *
 * Everything the articulation emits stands OUTSIDE the shell. That is not a
 * style choice, it is the only arrangement that works: the shell is opaque and
 * is still drawn, so an opening cut inward would simply show the shell's
 * painted texture at the bottom of the hole instead of glass. Measured on the
 * real slice with an offline rasteriser, a 20 mm clad plane with inward
 * reveals put the shell in front of every pane on the street.
 *
 * So the elevation is built as a real cladding layer:
 *
 *   d = 0                                  the shell wall (structure)
 *   d = ART_PANE            0.012 m        the glass
 *   d = pane + glassSet     0.042-0.062    the frame face
 *   d = frame + reveal      0.142-0.262    the clad wall face
 *   d = clad + projection   up to 0.45     sills, cornices, fascias
 *
 * The reveal is therefore the recess from the clad wall face down to the frame
 * face, and the whole build-up has to fit inside the projection allowance,
 * which is what bounds the reveal at 0.20 m rather than the brief's 0.25 m.
 */
// 30 mm rather than the 12 mm round 1 used. The pane and the backing plane are
// the two surfaces closest to the shell, and at a grazing view up a 100 m wall
// a 12 mm separation is inside one pixel's depth span -- measured offline, the
// shell won those pixels and its painted grid showed through as speckle.
const ART_PANE = 0.03;
const ART_REVEAL_MIN = 0.1;
const ART_REVEAL_MAX = 0.2;
const ART_GLASS_SET_MIN = 0.03;
const ART_GLASS_SET_MAX = 0.05;

/**
 * Cladding is extended past each edge end by a little more than the pane
 * offset, so the neighbouring edge's return is met rather than missed and a
 * building corner cannot show a seam.
 */
const ART_CORNER_OVERLAP = 0.03;

/**
 * Outward allowance handed to an edge that is a party wall. It is under the
 * thinnest possible clad stack on purpose: an edge with this allowance is
 * built as a single flush panel at the pane plane, because the next building
 * is standing where its cornice would go.
 */
const ART_PARTY_ALLOWANCE = 0.05;

/** Outward projection allowance for articulation, from the shell wall. */
export const FACADE_ARTICULATION_MAX_PROJECTION = 0.45;

/** Bays per edge. A real elevation does not have thirty bays on one face. */
const MAX_ART_BAYS = 12;

/** Height of the drip recess cut into the wall under a projecting sill. */
const ART_DRIP_HEIGHT = 0.26;
const ART_DRIP_DEPTH = 0.035;

/** Below this the edge is a corner return, not an elevation. */
const MIN_ART_EDGE = 1.2;

export const FACADE_ARTICULATION_VERSION = 'facade-articulation-1';

/**
 * The constructed constants, exported so a verifier measures against the same
 * numbers the geometry is built from instead of restating them.
 *
 * `revealRange` is the brief's contract: the recess from the clad wall face to
 * the frame face is never shallower than 0.10 m and never deeper than 0.25 m.
 * The pane sits a further `glassSet` (0.035-0.065 m) behind the frame face, so
 * a *pane* measures up to 0.315 m behind the wall; that is the window's build-
 * up, not its reveal.
 */
export const FACADE_ARTICULATION_GEOMETRY = Object.freeze({
  paneOffset: ART_PANE,
  cornerOverlap: ART_CORNER_OVERLAP,
  partyAllowance: ART_PARTY_ALLOWANCE,
  maxProjection: FACADE_ARTICULATION_MAX_PROJECTION,
  dripHeight: ART_DRIP_HEIGHT,
  dripDepth: ART_DRIP_DEPTH,
  minEdge: MIN_ART_EDGE,
  maxBays: MAX_ART_BAYS,
  revealRange: Object.freeze({ min: ART_REVEAL_MIN, max: ART_REVEAL_MAX }),
  glassSetRange: Object.freeze({ min: ART_GLASS_SET_MIN, max: ART_GLASS_SET_MAX }),
  neighbourMetres: 48,
});

/**
 * LOD rings, as distance from the caller's focus in metres and a hard count.
 *
 * Both limits are enforced: the radius is what makes the ring meaningful, the
 * count is what makes the budget a bound rather than a hope. A dense block can
 * put four hundred buildings inside 150 m; the count cut is applied outside-in
 * within the ring, so the buildings the player is standing in front of are the
 * ones that keep the detail.
 *
 * The radius is measured to the NEAREST POINT OF THE FOOTPRINT, not to the
 * centroid -- see `nearestFootprintDistance`. `coverageGain` and
 * `glazeCoverage` are the screen-coverage terms: the first scales the
 * per-building triangle cap by how much of the frame the elevation fills, the
 * second is the frame share above which every storey is glazed individually
 * instead of banded. See `articulationScreenCoverage`.
 *
 *   near   <=  85 m   full articulation. A 0.16 m reveal is ~6 px at 1440p
 *                     from 85 m, so frames, mullions and sills still resolve.
 *   mid    <= 200 m   reveal + pane + sill. Frames and mullions are under a
 *                     pixel here and only cost triangles and shimmer.
 *   far    <= 420 m   clad, with one recessed glazing band per storey on the
 *                     same sill/head line the near ring uses, and a continuous
 *                     bay pier every bay so the band is not one flat stripe.
 *                     Its `capScale` is 2.4 rather than 6: at 200-420 m a
 *                     4,900 triangle elevation resolves to the same pixels a
 *                     2,000 triangle one does, and on the gate's own poses that
 *                     ring was holding a third of the whole scene budget for
 *                     buildings covering under 2% of the frame each.
 *   beyond            silhouette: cornice and plinth only, shell texture kept.
 *                     No cladding, so there is no colour step at the cut --
 *                     at 420 m the painted grid is sub-pixel anyway.
 *
 * The radii are set from the poses the quality gate actually captures, not
 * from a guess: the gate's cards are eye-level street views in which buildings
 * 30-90 m away fill most of the frame, and the canyon card (58 deg) puts 26%
 * of one frame on a single building at 65 m.
 *
 * Per-window geometry therefore stops at 200 m. That radius is the documented
 * one the brief asks for. `capScale` is how far the per-building triangle cap
 * may grow with the building's measured wall area; see
 * `articulationTriangleCap`.
 */
export const FACADE_ARTICULATION_RINGS = Object.freeze({
  near: Object.freeze({ radius: 85, maxBuildings: 26, triangleCap: 6000, capScale: 2.4, coverageGain: 7.5, glazeCoverage: 0.05 }),
  mid: Object.freeze({ radius: 200, maxBuildings: 72, triangleCap: 2300, capScale: 2.6, coverageGain: 6, glazeCoverage: 0.06 }),
  far: Object.freeze({ radius: 420, maxBuildings: 300, triangleCap: 820, capScale: 2.4, coverageGain: 0, glazeCoverage: Infinity }),
  silhouette: Object.freeze({ radius: Infinity, maxBuildings: 900, triangleCap: 48, capScale: 16, coverageGain: 0, glazeCoverage: Infinity }),
});

/**
 * The frame the screen-coverage term is measured in.
 *
 * Not a guess: this is the quality gate's own street card -- 47 deg vertical
 * field of view, 16:9, eye at 2.4 m. Coverage is measured as if the camera had
 * turned to face the building, deliberately, because it has to survive the
 * player turning on the spot and a rebuild costs a few hundred milliseconds.
 * A term that depended on the current view direction would make every LOD
 * decision a function of something that changes sixty times a second.
 */
export const FACADE_ARTICULATION_SCREEN = Object.freeze({
  fov: 47,
  aspect: 16 / 9,
  eyeHeight: 2.4,
});

/**
 * Distance from a point to the nearest point of a footprint; 0 inside it.
 *
 * This is the distance the LOD ring is measured in. The centroid is the wrong
 * question: a 200 m block's centroid is 100 m from the wall you are standing
 * against, and measured on the real slice that put buildings whose frontage is
 * 20-60 m from the eye -- half the frame -- one or two rings out.
 */
export function nearestFootprintDistance(polygon, point) {
  const points = normalisePolygon(polygon);
  if (!points.length || !point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return NaN;
  if (pointInPolygon(point.x, point.z, points)) return 0;
  let best = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len2 = ex * ex + ez * ez;
    let t = len2 > EPSILON ? ((point.x - a.x) * ex + (point.z - a.z) * ez) / len2 : 0;
    t = clamp(t, 0, 1);
    best = Math.min(best, Math.hypot(a.x + ex * t - point.x, a.z + ez * t - point.z));
  }
  return best;
}

/**
 * The share of the reference frame this building's silhouette would fill.
 *
 * Distance alone cannot answer "does this elevation need windows": a 3 m
 * lock-up and a 160 m tower standing the same 5 m away subtend wildly
 * different amounts of frame, and it is the frame share -- not the metres --
 * that decides whether a storey is a readable band of glass or a sub-pixel
 * line. Width comes from the angular spread of the footprint about the eye,
 * height from the nearest wall, and both are clipped to the frame before the
 * product is taken, so a building taller than the frame does not earn credit
 * for the part that is off-screen.
 *
 * Returns 0..1.
 */
export function articulationScreenCoverage(building, focus, screen = FACADE_ARTICULATION_SCREEN) {
  if (!focus || !Number.isFinite(focus.x) || !Number.isFinite(focus.z)) return 0;
  const points = normalisePolygon(building?.polygon);
  const height = Number(building?.height);
  if (!points.length || !Number.isFinite(height) || height <= 0) return 0;
  const fovV = ((Number(screen?.fov) || FACADE_ARTICULATION_SCREEN.fov) * Math.PI) / 180;
  const aspect = Number(screen?.aspect) || FACADE_ARTICULATION_SCREEN.aspect;
  const eyeY = Number.isFinite(screen?.eyeHeight) ? screen.eyeHeight : FACADE_ARTICULATION_SCREEN.eyeHeight;
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
  const distance = nearestFootprintDistance(points, focus);
  if (!Number.isFinite(distance)) return 0;
  if (distance <= EPSILON) return 1;

  // Angular width, measured about the direction to the footprint centroid so
  // the +/-pi branch cut cannot land inside the building.
  let cx = 0;
  let cz = 0;
  for (const point of points) { cx += point.x; cz += point.z; }
  const reference = Math.atan2(cz / points.length - focus.z, cx / points.length - focus.x);
  let lowest = 0;
  let highest = 0;
  for (const point of points) {
    let delta = Math.atan2(point.z - focus.z, point.x - focus.x) - reference;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    lowest = Math.min(lowest, delta);
    highest = Math.max(highest, delta);
  }
  const angularWidth = highest - lowest;
  const angularHeight = Math.atan(Math.max(0, height - eyeY) / distance) + Math.atan(Math.max(0, eyeY) / distance);
  return clamp((Math.min(angularWidth, fovH) / fovH) * (Math.min(angularHeight, fovV) / fovV), 0, 1);
}

/**
 * The elevation area one ring's base triangle cap is written for, in square
 * metres: a four-sided, 60 m perimeter block six storeys high. A building with
 * twelve edges and three times the wall has three times as much elevation to
 * build and cannot be held to the same count, so the cap scales with measured
 * wall area up to the ring's `capScale`.
 */
export const FACADE_ARTICULATION_REFERENCE_WALL = 1200;

/**
 * Per-building triangle cap for a ring.
 *
 * Three things drive how much elevation a building deserves: its wall area,
 * how many separate faces that wall is broken into -- a cornice line costs the
 * same twelve triangles on a 3 m return as on a 40 m frontage -- and how much
 * of the frame it actually fills. The first two are `demand`, taken whichever
 * way round is larger and clamped to the ring's `capScale`. The third is
 * `coverage`, and it is the one round 2 was missing: a 160 m tower carries
 * 23,000 m2 of wall, twenty times the reference, so `demand` clamps at 2.4 and
 * the cap lands on 14,400 triangles whether that tower is filling half the
 * frame from 4.5 m or is one of thirty in the background. Fourteen thousand
 * triangles over fifty storeys buys four glazed storeys and forty-six flat
 * bands, which is exactly what the capture showed. `coverageGain` is what lets
 * the handful of buildings a frame is actually made of spend the budget the
 * background is not using.
 */
export function articulationTriangleCap(ring, wallArea, edgeCount = 4, coverage = 0) {
  const spec = FACADE_ARTICULATION_RINGS[ring] || FACADE_ARTICULATION_RINGS.silhouette;
  const area = Number.isFinite(wallArea) && wallArea > 0 ? wallArea : FACADE_ARTICULATION_REFERENCE_WALL;
  const edges = Number.isFinite(edgeCount) && edgeCount > 0 ? edgeCount : 4;
  const demand = Math.max(area / FACADE_ARTICULATION_REFERENCE_WALL, edges / 4);
  const share = Number.isFinite(coverage) ? clamp(coverage, 0, 1) : 0;
  const gain = 1 + (spec.coverageGain || 0) * share;
  return Math.round(spec.triangleCap * clamp(demand, 1, spec.capScale) * gain);
}

export const FACADE_ARTICULATION_RING_ORDER = Object.freeze(['near', 'mid', 'far', 'silhouette']);

/**
 * How the screen-coverage bonus is given up when a frame does not fit the
 * scene budget, before any ring is demoted. Each step is the multiplier the
 * whole city's coverage term is scaled by, so the buildings holding the most
 * bonus give up the most triangles and the background is untouched.
 */
export const COVERAGE_CUT_STEPS = Object.freeze([0.5, 0.2, 0]);

/**
 * Scene budget. The arithmetic worst case of the ring caps is
 * 30*3400 + 90*1300 + 260*320 + 1200*48 = 358,600; the batch enforces the
 * ceiling below by demoting whole rings outside-in, never by dropping one
 * building and keeping its neighbour.
 */
export const FACADE_ARTICULATION_BUDGET = Object.freeze({
  sceneTriangleBudget: 330000,
  // Arithmetic worst case: every ring full of buildings tall enough to take
  // the whole height scale. It is far above the scene budget on purpose --
  // the budget is what the batch enforces, by demoting whole rings.
  worstCaseAllowance: 26 * 6000 * 2.4 + 72 * 2300 * 2.6 + 300 * 820 * 6 + 900 * 48 * 16,
  // 2 zones x 7 material classes x 3 roles, and only non-empty buckets are
  // built, so this is a ceiling and not a target.
  maxDrawCalls: 48,
  // Zone refresh thresholds, in metres of focus movement. See the pass.
  detailRefreshMetres: 25,
  bulkRefreshMetres: 90,
});

/**
 * Material classes. `surface` names a class in src/render/detail-maps.js so
 * the pass can take a real normal/roughness map for it; `palette` is the
 * per-building colour draw, in sRGB.
 *
 * Roughness and metalness are the physical part of the brief: brick and stucco
 * are fully dielectric and rough, stone is a little smoother, a curtain-wall
 * spandrel is a coated metal panel, and glass is smooth with a low dielectric
 * response. Frames are a separate role so a mullion can be anodised metal
 * while the wall next to it is brick.
 */
export const FACADE_MATERIAL_CLASSES = Object.freeze({
  brick: Object.freeze({
    surface: 'brick', roughness: 0.93, metalness: 0.0, detail: 1.0,
    palette: Object.freeze(['#9c5a45', '#8d4c3a', '#a86a4f', '#7d4436', '#b07a5c', '#94513d']),
    glass: Object.freeze({ color: '#2e3a42', roughness: 0.09, metalness: 0.28 }),
  }),
  stone: Object.freeze({
    surface: 'painted-concrete', roughness: 0.78, metalness: 0.0, detail: 0.85,
    palette: Object.freeze(['#cbc3ae', '#bdb49e', '#d6cfbb', '#c2b8a2', '#b6ac96', '#d0c7b1']),
    glass: Object.freeze({ color: '#2b343b', roughness: 0.08, metalness: 0.3 }),
  }),
  plaster: Object.freeze({
    surface: 'stucco', roughness: 0.89, metalness: 0.0, detail: 0.95,
    palette: Object.freeze(['#e2c9a8', '#d9b892', '#eed6b6', '#cfae8b', '#e6d2b4', '#dcbfa0']),
    glass: Object.freeze({ color: '#2f3941', roughness: 0.1, metalness: 0.26 }),
  }),
  painted: Object.freeze({
    surface: 'stucco', roughness: 0.82, metalness: 0.0, detail: 0.8,
    palette: Object.freeze(['#a8544f', '#4d7686', '#b08b45', '#5a6b8a', '#a56a44', '#6d8a5f', '#96607a']),
    glass: Object.freeze({ color: '#2f3941', roughness: 0.1, metalness: 0.26 }),
  }),
  clapboard: Object.freeze({
    surface: 'stucco', roughness: 0.76, metalness: 0.0, detail: 0.7,
    palette: Object.freeze(['#8fb0c9', '#c9a179', '#9dc194', '#cfa2b0', '#93a8c9', '#c7c2a8']),
    glass: Object.freeze({ color: '#303a42', roughness: 0.11, metalness: 0.24 }),
  }),
  concrete: Object.freeze({
    surface: 'painted-concrete', roughness: 0.86, metalness: 0.02, detail: 0.9,
    palette: Object.freeze(['#c3bfb4', '#b4b0a5', '#cdc9be', '#a9a59b', '#bcb8ac', '#c8c4b8']),
    glass: Object.freeze({ color: '#2a333a', roughness: 0.07, metalness: 0.32 }),
  }),
  'curtain-wall': Object.freeze({
    surface: 'glass-curtain', roughness: 0.38, metalness: 0.62, detail: 0.55,
    palette: Object.freeze(['#5c6a72', '#4e5b63', '#6a7880', '#556269', '#61707a', '#48545c']),
    glass: Object.freeze({ color: '#1f2b34', roughness: 0.05, metalness: 0.42 }),
  }),
});

export const FACADE_MATERIAL_CLASS_NAMES = Object.freeze(Object.keys(FACADE_MATERIAL_CLASSES));

/**
 * Geometry roles for articulation. Only `structure` is bucketed per material
 * class -- glass, joinery and interior fittings look the same whatever the
 * wall behind them is made of, and folding their colour into vertex colour
 * instead of a material keeps the whole city inside a dozen draw calls a zone.
 *
 * `glass-lit` is the same glass with an emissive interior. The pass drives its
 * `emissiveIntensity` from the clock, which is what puts lit windows back on
 * the night card: the shell's own emissive night texture is behind the
 * cladding now and cannot be seen.
 */
export const FACADE_ARTICULATION_ROLES = Object.freeze(['structure', 'glass', 'glass-lit', 'frame', 'interior']);

/** Roles that share one material rather than one per material class. */
export const FACADE_ARTICULATION_SHARED_ROLES = Object.freeze(['glass', 'glass-lit', 'frame', 'interior']);

/** Bucket key component for a role: the wall class, or the shared bucket. */
export function articulationBucketClass(role, className) {
  return FACADE_ARTICULATION_SHARED_ROLES.includes(role) ? 'shared' : className;
}

/**
 * What is behind a pane. A window that is only a dark sheet reads as a hole
 * punched in a card, which is exactly what the round-1 captures showed: at
 * golden hour every opening was pure black. Each opening therefore draws one
 * of these, deterministically, from its own building/edge/storey/column.
 *
 * `sky` and `floor` are the two ends of the vertical gradient baked into the
 * pane: the top of a pane at street level reflects the sky above the canyon,
 * the bottom reflects the darker street and the room behind it. The physical
 * Fresnel reflection from the environment rides on top of that, so the pane
 * still brightens as the view angle goes grazing.
 */
export const WINDOW_INTERIORS = Object.freeze({
  empty: Object.freeze({ sky: '#8fa6bb', floor: '#2f3438', weight: 30 }),
  office: Object.freeze({ sky: '#7f96ab', floor: '#3b3a36', ceiling: true, weight: 18 }),
  blind: Object.freeze({ sky: '#8fa6bb', floor: '#33383c', blind: true, weight: 20 }),
  curtain: Object.freeze({ sky: '#8299ad', floor: '#343a3e', curtain: true, weight: 12 }),
  lit: Object.freeze({ sky: '#9a8a6d', floor: '#6d5c40', lit: true, weight: 12 }),
  litBlind: Object.freeze({ sky: '#9c8d70', floor: '#6a5a3f', blind: true, lit: true, weight: 8 }),
});

const WINDOW_INTERIOR_KEYS = Object.freeze(Object.keys(WINDOW_INTERIORS));
const WINDOW_INTERIOR_TOTAL = WINDOW_INTERIOR_KEYS.reduce((sum, key) => sum + WINDOW_INTERIORS[key].weight, 0);

/** Blind and curtain fabric, and the shop fittings behind display glazing. */
export const FACADE_INTERIOR_MATERIAL = Object.freeze({
  roughness: 0.86,
  metalness: 0,
  blinds: Object.freeze(['#cfc6b1', '#c3bcac', '#d8d1bf', '#b7b1a3', '#cdc0a4']),
  curtains: Object.freeze(['#b6ada0', '#a9a396', '#c4bcae', '#9d968c']),
  fittings: Object.freeze(['#6f6357', '#7b6c5c', '#5f574d']),
});

/** What a lit shop looks like through its own display glazing. */
export const SHOP_INTERIOR = Object.freeze({
  ceiling: '#d8c49a',
  back: '#6a5a45',
  valance: '#f0dcae',
});

/** Glass. A dielectric: metalness 0 is what gives it a view-angle Fresnel. */
export const FACADE_GLASS_MATERIAL = Object.freeze({
  roughness: 0.07,
  metalness: 0,
  // Warm interior glow driven from the clock by the pass.
  emissive: '#ffcf8a',
  nightEmissiveIntensity: 0.85,
});

/** Anodised/painted metal for frames, mullions, transom bars and shop fascia. */
export const FACADE_FRAME_MATERIAL = Object.freeze({
  roughness: 0.36,
  metalness: 0.88,
  palette: Object.freeze(['#3a3f45', '#2b2e33', '#4a4038', '#55585c', '#2f3a3f', '#6a604f']),
});

/** Source `building.material` -> articulation class. */
const ART_CLASS_BY_MATERIAL = Object.freeze({
  brick: 'brick',
  stone: 'stone',
  plaster: 'plaster',
  painted: 'painted',
  clapboard: 'clapboard',
  concrete: 'concrete',
  glass: 'curtain-wall',
  metal: 'curtain-wall',
  wood: 'clapboard',
  stucco: 'plaster',
});

/**
 * Which material class an articulated building is built from. The source
 * record wins; a tower with no usable material tag is a curtain wall and
 * anything else falls back to plaster, which is what most of the city is.
 */
export function resolveArticulationClass(building) {
  const raw = String(building?.material ?? '').toLowerCase().trim();
  const direct = ART_CLASS_BY_MATERIAL[raw];
  if (direct) return { className: direct, source: 'material' };
  for (const [key, className] of Object.entries(ART_CLASS_BY_MATERIAL)) {
    if (raw.includes(key)) return { className, source: 'material-substring' };
  }
  const height = Number(building?.height);
  if (Number.isFinite(height) && height >= 45) return { className: 'curtain-wall', source: 'height' };
  const type = String(building?.type ?? '').toLowerCase();
  if (type === 'tower') return { className: 'curtain-wall', source: 'type' };
  if (type === 'warehouse' || type === 'civic') return { className: 'concrete', source: 'type' };
  return { className: 'plaster', source: 'fallback' };
}

/**
 * Storey count. `levels` is the brief's field name, `stories` is what the SF
 * loader writes, and a record with neither is derived from its height. Every
 * path is clamped so a bad tag cannot ask for a 2 m storey.
 */
export function articulationLevels(building, height) {
  const declared = Number(
    building?.levels
    ?? building?.['building:levels']
    ?? building?.stories
    ?? NaN,
  );
  const capacity = Math.max(1, Math.floor(height / 2.6));
  if (Number.isFinite(declared) && declared >= 1) return clamp(Math.round(declared), 1, Math.min(capacity, 80));
  return clamp(Math.max(1, Math.round(height / 3.5)), 1, Math.min(capacity, 80));
}

/** Storey floor/top heights, with a taller commercial ground floor. */
function articulationStoreys(building, height, commercial) {
  const levels = articulationLevels(building, height);
  if (levels === 1) return { levels: 1, floors: [0], tops: [height] };
  const wanted = commercial ? 4.5 : 3.7;
  const room = height - 2.6 * (levels - 1);
  const ground = clamp(wanted, 2.6, Math.max(2.6, room));
  const upper = (height - ground) / (levels - 1);
  const floors = [0];
  const tops = [ground];
  for (let i = 1; i < levels; i += 1) {
    floors.push(ground + (i - 1) * upper);
    tops.push(ground + i * upper);
  }
  tops[tops.length - 1] = height;
  return { levels, floors, tops };
}

/**
 * Per-building deterministic variation. Drawn from the building id (plus a
 * `salt` the batch uses to break a signature collision with a neighbour), and
 * drawn *before* any ring branching so a building's proportions do not change
 * as the camera walks toward it.
 */
export function drawArticulationVariant(building, style, className, salt = 0) {
  const random = mulberry32((facadeDepthSeed(building?.id) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0);
  const profile = FACADE_STYLE_PROFILES[style] || FACADE_STYLE_PROFILES['modern-grid'];
  const classDef = FACADE_MATERIAL_CLASSES[className] || FACADE_MATERIAL_CLASSES.plaster;
  const modern = className === 'curtain-wall' || style === 'modern-grid';
  return {
    bayWidth: profile.bayWidth * (0.86 + random() * 0.3),
    windowRatio: clamp(profile.windowRatio * (0.9 + random() * 0.2), 0.36, 0.88),
    reveal: clamp(profile.revealDepth * (0.85 + random() * 0.34), ART_REVEAL_MIN, ART_REVEAL_MAX),
    frameWidth: 0.055 + random() * 0.045,
    glassSet: ART_GLASS_SET_MIN + random() * (ART_GLASS_SET_MAX - ART_GLASS_SET_MIN),
    sillLift: 0.72 + random() * 0.42,
    sillProjection: 0.07 + random() * 0.07,
    lintelDepth: 0.05 + random() * 0.05,
    corniceHeight: profile.corniceHeight * (0.85 + random() * 0.3),
    corniceProjection: clamp(profile.corniceProjection * (0.8 + random() * 0.45), 0.06, 0.26),
    parapetHeight: 0.55 + random() * 0.75,
    plinthHeight: profile.plinthHeight * (0.85 + random() * 0.35),
    plinthProjection: 0.05 + random() * 0.05,
    // 0 = single light, 1 = one vertical mullion, 2 = mullion + transom.
    mullionPattern: modern ? (random() < 0.35 ? 1 : 2) : (random() < 0.55 ? 1 : 0),
    capProfile: modern ? (random() < 0.6 ? 'coping' : 'reveal') : (random() < 0.5 ? 'entablature' : 'bracketed'),
    baseProfile: random() < 0.5 ? 'plinth' : 'water-table',
    paletteIndex: Math.floor(random() * classDef.palette.length),
    framePaletteIndex: Math.floor(random() * FACADE_FRAME_MATERIAL.palette.length),
    storefrontHue: Math.floor(random() * 6),
    doorPick: random(),
    bulkheadHeight: 0.5 + random() * 0.22,
    transomHeight: 0.42 + random() * 0.3,
    // Phase shift so two neighbours with the same bay width still do not line
    // their bays up across the party wall.
    bayPhase: random(),
    // Vertical composition picks: whether the second storey reads as a
    // mezzanine, where a plant floor sits, and how the crown is proportioned.
    mezzanine: random() < 0.45,
    mechanicalPick: random(),
    crownRatio: 0.62 + random() * 0.24,
    interruptSeed: Math.floor(random() * 65536),
  };
}

/**
 * The facade's identity, as a short string. Two buildings with the same
 * signature would read as the same kit part; the batch uses this to guarantee
 * that no two buildings inside `ART_NEIGHBOUR_METRES` of each other share one.
 */
export function facadeArticulationSignature(style, className, variant) {
  const bucket = (value, step) => Math.round(value / step);
  return [
    style,
    className,
    variant.paletteIndex,
    bucket(variant.bayWidth, 0.35),
    bucket(variant.windowRatio, 0.06),
    bucket(variant.reveal, 0.03),
    variant.capProfile,
    variant.baseProfile,
    variant.mullionPattern,
    bucket(variant.bayPhase, 0.25),
  ].join('|');
}

/** Two buildings closer than this must not share a facade signature. */
export const ART_NEIGHBOUR_METRES = 48;

// ------------------------------------------------------- articulation sink

/**
 * QuadSink plus a paint state. `paint(tint, soffit)` sets the sRGB colour and
 * the shelter factor every following quad carries, so an emitter can hand a
 * head soffit a different weathering response from the sunlit face directly
 * below it without threading colour through every call.
 */
class ArticulationSink extends QuadSink {
  constructor(context) {
    super(context);
    this.tint = [1, 1, 1];
    this.soffit = 0;
    this.part = 'wall';
    this.parts = Object.create(null);
    // The clad wall face for the elevation currently being laid out, and how
    // far past each edge end it runs. Row fill needs both and threading them
    // through every call site buys nothing.
    this.clad = 0;
    this.overlap = ART_CORNER_OVERLAP;
    // Optional vertical gradient for the next quads, as [topScale,
    // bottomScale] applied across the quad's own height. This is how a pane
    // carries a reflected-sky-to-interior ramp without a shader.
    this.grad = null;
  }

  paint(tint, soffit = 0) {
    this.tint = tint;
    this.soffit = soffit;
    return this;
  }

  /** Name the element the following quads belong to. Diagnostics and the
   *  verifier both read it, so every emitter states what it is building. */
  mark(part) {
    this.part = part;
    return this;
  }

  /** Vertical ramp for the following quads. `null` clears it. */
  gradient(top, bottom) {
    this.grad = top === null ? null : [top, bottom];
    return this;
  }

  /**
   * Same contract as `QuadSink.quad` -- corners in edge-local (s, y, d), the
   * normal recomputed from the placed quad and the winding fixed against the
   * hint -- written out longhand because an articulated city emits hundreds of
   * thousands of these per rebuild and the shared version allocates ten
   * temporaries per quad. Measured on a 700 building slice this is the
   * difference between a 1.0 s and a 0.25 s rebuild.
   */
  quad(role, edge, corners, hint) {
    const ctx = this.context;
    const positions = new Array(12);
    const uvs = new Array(8);
    const { minX, maxX, minZ, maxZ, minY, maxY, baseY } = ctx;
    const invU = 1 / ctx.uvMetres.x;
    const invV = 1 / ctx.uvMetres.y;
    for (let i = 0; i < 4; i += 1) {
      const corner = corners[i];
      const s = corner[0];
      const d = corner[2];
      let x = edge.ax + edge.ux * s + edge.nx * d;
      let z = edge.az + edge.uz * s + edge.nz * d;
      let y = baseY + corner[1];
      if (x < minX) x = minX; else if (x > maxX) x = maxX;
      if (z < minZ) z = minZ; else if (z > maxZ) z = maxZ;
      if (y < minY) y = minY; else if (y > maxY) y = maxY;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = (edge.offset + s) * invU;
      uvs[i * 2 + 1] = (y - baseY) * invV;
    }
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) & 3;
      const x0 = positions[i * 3];
      const y0 = positions[i * 3 + 1];
      const z0 = positions[i * 3 + 2];
      const x1 = positions[j * 3];
      const y1 = positions[j * 3 + 1];
      const z1 = positions[j * 3 + 2];
      nx += (y0 - y1) * (z0 + z1);
      ny += (z0 - z1) * (x0 + x1);
      nz += (x0 - x1) * (y0 + y1);
    }
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(length > 1e-9)) return; // degenerate after clamping: drop it.
    nx /= length;
    ny /= length;
    nz /= length;
    let hx = edge.nx;
    let hy = 0;
    let hz = edge.nz;
    if (hint === 'in') { hx = -edge.nx; hz = -edge.nz; }
    else if (hint === 'up') { hx = 0; hy = 1; hz = 0; }
    else if (hint === 'down') { hx = 0; hy = -1; hz = 0; }
    else if (hint === 'along') { hx = edge.ux; hz = edge.uz; }
    else if (hint === 'against') { hx = -edge.ux; hz = -edge.uz; }
    if (nx * hx + ny * hy + nz * hz < 0) {
      for (let i = 0; i < 2; i += 1) {
        const a = i;
        const b = 3 - i;
        for (let k = 0; k < 3; k += 1) {
          const tmp = positions[a * 3 + k];
          positions[a * 3 + k] = positions[b * 3 + k];
          positions[b * 3 + k] = tmp;
        }
        for (let k = 0; k < 2; k += 1) {
          const tmp = uvs[a * 2 + k];
          uvs[a * 2 + k] = uvs[b * 2 + k];
          uvs[b * 2 + k] = tmp;
        }
      }
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    (this.pending || this.quads).push({
      role,
      feature: null,
      edgeIndex: edge.index,
      positions,
      uvs,
      normal: [nx, ny, nz],
      tint: this.tint,
      soffit: this.soffit,
      part: this.part,
      grad: this.grad,
      baseY,
    });
    this.parts[this.part] = (this.parts[this.part] || 0) + 1;
  }
}

/**
 * Placement context for articulation. Same invariant as `createPlacement` --
 * every vertex is clamped into the building's own footprint AABB expanded by
 * at most `maxProjection`, and into [baseY, baseY + height] -- but it exposes
 * the bounds as plain numbers so the sink can clamp without a call and an
 * array allocation per corner.
 */
function createArticulationPlacement(bounds, baseY, height, maxProjection, uvMetres) {
  return {
    baseY,
    uvMetres,
    triangleCap: Infinity,
    minX: bounds.minX - maxProjection,
    maxX: bounds.maxX + maxProjection,
    minZ: bounds.minZ - maxProjection,
    maxZ: bounds.maxZ + maxProjection,
    minY: baseY,
    maxY: baseY + height,
  };
}

/**
 * Grime response. Two terms, both geometric:
 *  - `soffit` is how sheltered the face is. A head soffit, a reveal return or
 *    a drip recess never sees rain, so it keeps what the wall above sheds.
 *  - the ground term is splash-back and traffic film, which falls off over the
 *    first few metres of wall.
 * Neither is a decal, so a face that is not there cannot be dirty.
 */
function articulationGrimeScale(yAboveBase, soffit) {
  const ground = Math.exp(-Math.max(0, yAboveBase) / 6.5);
  return clamp(1 - clamp(soffit, 0, 1) * 0.34 - ground * 0.2, 0.35, 1);
}

/** sRGB 0-1 channel to the linear working space vertex colours are read in. */
function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function hexToSrgb(hex) {
  const value = typeof hex === 'string' ? Number.parseInt(hex.replace('#', ''), 16) : Number(hex);
  if (!Number.isFinite(value)) return [1, 1, 1];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// ---------------------------------------------------------------- emitters

/**
 * Deterministic per-opening hash. Stable across runs and independent of the
 * order openings are emitted in, so a window keeps its blinds when the LOD
 * ring around it changes.
 */
function openingHash(seed, edgeIndex, storey, column) {
  let h = (seed ^ Math.imul(edgeIndex + 1, 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (storey + 1), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (column + 1), 0xc2b2ae35) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/** Weighted draw from WINDOW_INTERIORS. */
function pickWindowInterior(hash) {
  let roll = (hash % 1000) / 1000 * WINDOW_INTERIOR_TOTAL;
  for (const key of WINDOW_INTERIOR_KEYS) {
    roll -= WINDOW_INTERIORS[key].weight;
    if (roll <= 0) return { key, ...WINDOW_INTERIORS[key] };
  }
  return { key: 'empty', ...WINDOW_INTERIORS.empty };
}

/**
 * The full glazing description for one opening: which pane bucket it lands in,
 * the sky-to-interior ramp baked into it, and whatever fabric is hanging in
 * front of it. Everything here is opaque -- no transparency is introduced into
 * the canonical path -- so the "interior" is a painted-on ramp plus real
 * blind/curtain geometry standing in the glazing cavity.
 */
function glazingFor(hash, options = {}) {
  const interior = options.interior || pickWindowInterior(hash);
  const blindRoll = ((hash >>> 7) % 1000) / 1000;
  const curtainRoll = ((hash >>> 13) % 1000) / 1000;
  const paletteRoll = (hash >>> 19) % 997;
  return {
    key: interior.key,
    role: interior.lit ? 'glass-lit' : 'glass',
    sky: hexToSrgb(interior.sky),
    floor: hexToSrgb(interior.floor),
    // A blind covers the top of the opening; a curtain hangs down one side.
    blind: interior.blind ? 0.28 + blindRoll * 0.5 : 0,
    blindTint: hexToSrgb(FACADE_INTERIOR_MATERIAL.blinds[paletteRoll % FACADE_INTERIOR_MATERIAL.blinds.length]),
    curtain: interior.curtain ? 0.18 + curtainRoll * 0.22 : 0,
    curtainSide: (hash >>> 3) & 1 ? 1 : 0,
    curtainTint: hexToSrgb(FACADE_INTERIOR_MATERIAL.curtains[paletteRoll % FACADE_INTERIOR_MATERIAL.curtains.length]),
  };
}

/**
 * Pane plus whatever is behind and in front of it.
 *
 * The pane's vertical ramp is the cheap half of the answer to "glass is a
 * black void": the top of a pane reflects the sky over the canyon and the
 * bottom reflects the street and the room. The expensive half is the material,
 * which is a dielectric (metalness 0), so the environment's Fresnel reflection
 * rides on top of this and grows as the view angle goes grazing.
 */
function emitGlazing(sink, edge, s0, s1, y0, y1, depth, glaze) {
  sink.mark('window-pane').paint([1, 1, 1], 0.08);
  // Ramp encoded as a tint plus a scale: the tint is the floor colour, and the
  // top of the ramp lifts it toward the sky colour.
  const lift = [
    glaze.floor[0] > 1e-4 ? glaze.sky[0] / glaze.floor[0] : 1,
    glaze.floor[1] > 1e-4 ? glaze.sky[1] / glaze.floor[1] : 1,
    glaze.floor[2] > 1e-4 ? glaze.sky[2] / glaze.floor[2] : 1,
  ];
  const ramp = Math.min(3.2, (lift[0] + lift[1] + lift[2]) / 3);
  sink.paint(glaze.floor, 0.08).gradient(ramp, 1);
  sink.quad(glaze.role, edge, [[s0, y0, depth], [s0, y1, depth], [s1, y1, depth], [s1, y0, depth]], 'out');
  sink.gradient(null, null);
  const width = s1 - s0;
  const height = y1 - y0;
  if (glaze.blind > 0 && height > 0.6) {
    const bottom = y1 - height * glaze.blind;
    sink.mark('blind').paint(glaze.blindTint, 0.3).gradient(1, 0.86);
    sink.quad('interior', edge, [[s0, bottom, depth + 0.014], [s0, y1, depth + 0.014], [s1, y1, depth + 0.014], [s1, bottom, depth + 0.014]], 'out');
    sink.gradient(null, null);
  }
  if (glaze.curtain > 0 && width > 0.7) {
    const cw = width * glaze.curtain;
    const c0 = glaze.curtainSide ? s1 - cw : s0;
    sink.mark('curtain').paint(glaze.curtainTint, 0.3).gradient(1, 0.88);
    sink.quad('interior', edge, [[c0, y0, depth + 0.012], [c0, y1, depth + 0.012], [c0 + cw, y1, depth + 0.012], [c0 + cw, y0, depth + 0.012]], 'out');
    sink.gradient(null, null);
  }
}

/** Flush cladding: the wall itself, standing `ART_CLAD` proud of the shell. */
function emitClad(sink, edge, s0, s1, y0, y1, depth = sink.clad) {
  if (!(s1 - s0 > EPSILON) || !(y1 - y0 > EPSILON)) return;
  sink.quad('structure', edge, [[s0, y0, depth], [s0, y1, depth], [s1, y1, depth], [s1, y0, depth]], 'out');
}

/**
 * A profiled band between two depths: front face plus the two returns. Used
 * for every horizontal member -- cornice corona, bed mould, coping, string
 * course, sill, lintel, plinth, fascia -- so they all shade consistently.
 * The under-return always carries the soffit weathering.
 */
function emitProfile(sink, edge, s0, s1, y0, y1, inner, outer, tint, soffit = 0.85) {
  if (!(s1 - s0 > EPSILON) || !(y1 - y0 > EPSILON) || Math.abs(outer - inner) < 1e-4) return;
  const up = outer > inner ? 'up' : 'down';
  const down = outer > inner ? 'down' : 'up';
  sink.paint(tint, 0.06);
  sink.quad('structure', edge, [[s0, y0, outer], [s0, y1, outer], [s1, y1, outer], [s1, y0, outer]], 'out');
  sink.paint(tint, 0.25);
  sink.quad('structure', edge, [[s0, y1, inner], [s1, y1, inner], [s1, y1, outer], [s0, y1, outer]], up);
  sink.paint(tint, soffit);
  sink.quad('structure', edge, [[s0, y0, inner], [s1, y0, inner], [s1, y0, outer], [s0, y0, outer]], down);
}

/**
 * One constructed window opening.
 *
 * wall plane -> reveal returns -> frame ring -> glass, each on its own plane:
 *
 *      d = clad            the clad wall face
 *      d = clad - reveal   the back of the reveal; the frame face sits here
 *      d = that - glassSet the pane
 *
 * so the pane is genuinely inside a hole and self-shadows, the frame catches a
 * specular edge, and the head soffit above it stays dark all day.
 */
function emitOpening(sink, edge, s0, s1, y0, y1, opt) {
  const wall = opt.clad;
  const back = wall - opt.reveal;
  const pane = back - opt.glassSet;
  // Reveal returns.
  sink.mark('window-reveal').paint(opt.tint, 0.5);
  sink.quad('structure', edge, [[s0, y0, wall], [s0, y1, wall], [s0, y1, back], [s0, y0, back]], 'along');
  sink.quad('structure', edge, [[s1, y0, wall], [s1, y1, wall], [s1, y1, back], [s1, y0, back]], 'against');
  sink.paint(opt.tint, 0.95);
  sink.quad('structure', edge, [[s0, y1, wall], [s1, y1, wall], [s1, y1, back], [s0, y1, back]], 'down');
  sink.paint(opt.tint, 0.7);
  sink.quad('structure', edge, [[s0, y0, wall], [s1, y0, wall], [s1, y0, back], [s0, y0, back]], 'up');

  let g0 = s0;
  let g1 = s1;
  let gy0 = y0;
  let gy1 = y1;
  if (opt.frameWidth > 0.01) {
    const fw = Math.min(opt.frameWidth, (s1 - s0) * 0.22, (y1 - y0) * 0.22);
    if (fw > 0.01) {
      sink.mark('window-frame').paint(opt.frameTint, 0.2);
      sink.quad('frame', edge, [[s0, y0, back], [s0, y1, back], [s0 + fw, y1, back], [s0 + fw, y0, back]], 'out');
      sink.quad('frame', edge, [[s1 - fw, y0, back], [s1 - fw, y1, back], [s1, y1, back], [s1, y0, back]], 'out');
      sink.quad('frame', edge, [[s0 + fw, y1 - fw, back], [s0 + fw, y1, back], [s1 - fw, y1, back], [s1 - fw, y1 - fw, back]], 'out');
      sink.quad('frame', edge, [[s0 + fw, y0, back], [s0 + fw, y0 + fw, back], [s1 - fw, y0 + fw, back], [s1 - fw, y0, back]], 'out');
      g0 = s0 + fw;
      g1 = s1 - fw;
      gy0 = y0 + fw;
      gy1 = y1 + 0 - fw;
    }
  }
  // The pane, its ramp, and whatever is hanging in front of it.
  emitGlazing(sink, edge, g0, g1, gy0, gy1, pane, opt.glaze);
  if (opt.mullionPattern > 0 && g1 - g0 > 0.9) {
    const bar = 0.05;
    const centre = (g0 + g1) / 2;
    sink.mark('mullion').paint(opt.frameTint, 0.2);
    sink.quad('frame', edge, [[centre - bar, gy0, pane + 0.012], [centre - bar, gy1, pane + 0.012], [centre + bar, gy1, pane + 0.012], [centre + bar, gy0, pane + 0.012]], 'out');
  }
  if (opt.mullionPattern > 1 && gy1 - gy0 > 1.1) {
    const bar = 0.05;
    const transom = gy0 + (gy1 - gy0) * 0.72;
    sink.mark('mullion').paint(opt.frameTint, 0.2);
    sink.quad('frame', edge, [[g0, transom - bar, pane + 0.012], [g0, transom + bar, pane + 0.012], [g1, transom + bar, pane + 0.012], [g1, transom - bar, pane + 0.012]], 'out');
  }
}

/** Cheap opening for the mid ring: reveal returns and a pane, nothing else. */
function emitPlainOpening(sink, edge, s0, s1, y0, y1, opt) {
  const wall = opt.clad;
  const back = wall - opt.reveal;
  sink.mark('window-reveal').paint(opt.tint, 0.5);
  sink.quad('structure', edge, [[s0, y0, wall], [s0, y1, wall], [s0, y1, back], [s0, y0, back]], 'along');
  sink.quad('structure', edge, [[s1, y0, wall], [s1, y1, wall], [s1, y1, back], [s1, y0, back]], 'against');
  sink.paint(opt.tint, 0.95);
  sink.quad('structure', edge, [[s0, y1, wall], [s1, y1, wall], [s1, y1, back], [s0, y1, back]], 'down');
  emitGlazing(sink, edge, s0, s1, y0, y1, back, opt.glaze);
}

/**
 * One recessed glazing band across a storey. The far ring's substitute for
 * individual openings: same sill and head line, same reveal depth, so walking
 * in deepens the line instead of introducing a new one.
 */
function emitStoreyBand(sink, edge, s0, s1, y0, y1, opt) {
  const wall = opt.clad;
  const back = wall - opt.reveal;
  const part = opt.part || 'band';
  sink.mark(`${part}-reveal`).paint(opt.tint, 0.95);
  sink.quad('structure', edge, [[s0, y1, wall], [s1, y1, wall], [s1, y1, back], [s0, y1, back]], 'down');
  sink.paint(opt.tint, 0.7);
  sink.quad('structure', edge, [[s0, y0, wall], [s1, y0, wall], [s1, y0, back], [s0, y0, back]], 'up');
  if (opt.glaze) {
    emitGlazing(sink, edge, s0, s1, y0, y1, back, opt.glaze);
  } else {
    sink.mark(`${part}-pane`).paint(opt.glassTint, 0.1);
    sink.quad('glass', edge, [[s0, y0, back], [s0, y1, back], [s1, y1, back], [s1, y0, back]], 'out');
  }
}

/**
 * Emit one horizontal row as a complete partition of [0, length] x [y0, y1]:
 * the listed spans get `spanFn`, everything between them is clad wall. This is
 * what makes a budget cut safe -- the gaps are filled by construction, so a
 * dropped opening becomes wall rather than a hole.
 */
function emitRow(sink, edge, y0, y1, spans, tint, spanFn, soffit = 0, from = null, to = null) {
  const start = from === null ? -sink.overlap : from;
  const end = to === null ? edge.length + sink.overlap : to;
  let cursor = start;
  for (const span of spans) {
    if (span.s0 > cursor) {
      sink.mark('pier').paint(tint, soffit);
      emitClad(sink, edge, cursor, span.s0, y0, y1);
    }
    spanFn(span);
    cursor = Math.max(cursor, span.s1);
  }
  if (cursor < end) {
    sink.mark('pier').paint(tint, soffit);
    emitClad(sink, edge, cursor, end, y0, y1);
  }
}

/** Bay centres for an edge, as spans of the given width. */
function bayspans(edge, variant, ratio, pitchScale = 1) {
  const columns = clamp(Math.round(edge.length / (variant.bayWidth / pitchScale)), 1, MAX_ART_BAYS);
  const pitch = edge.length / columns;
  const width = Math.min(pitch * ratio, 3.2);
  if (width < MIN_WINDOW_WIDTH || pitch - width < 0.45) return { columns, pitch, width, spans: [] };
  const spans = [];
  for (let column = 0; column < columns; column += 1) {
    const centre = (column + 0.5) * pitch;
    const s0 = centre - width / 2;
    const s1 = centre + width / 2;
    if (s0 < 0.22 || s1 > edge.length - 0.22) continue;
    spans.push({ s0, s1 });
  }
  return { columns, pitch, width, spans };
}

/** Front face plus all four returns: a member that reads as solid from any angle. */
function emitPanel(sink, edge, s0, s1, y0, y1, inner, outer, tint, soffit = 0.6) {
  if (!(s1 - s0 > EPSILON) || !(y1 - y0 > EPSILON)) return;
  const up = outer > inner ? 'up' : 'down';
  const down = outer > inner ? 'down' : 'up';
  sink.paint(tint, 0.05);
  sink.quad('structure', edge, [[s0, y0, outer], [s0, y1, outer], [s1, y1, outer], [s1, y0, outer]], 'out');
  if (Math.abs(outer - inner) < 1e-4) return;
  sink.paint(tint, 0.28);
  sink.quad('structure', edge, [[s0, y1, inner], [s1, y1, inner], [s1, y1, outer], [s0, y1, outer]], up);
  sink.paint(tint, soffit);
  sink.quad('structure', edge, [[s0, y0, inner], [s1, y0, inner], [s1, y0, outer], [s0, y0, outer]], down);
  sink.paint(tint, 0.35);
  sink.quad('structure', edge, [[s0, y0, inner], [s0, y1, inner], [s0, y1, outer], [s0, y0, outer]], 'against');
  sink.quad('structure', edge, [[s1, y0, inner], [s1, y1, inner], [s1, y1, outer], [s1, y0, outer]], 'along');
}

/**
 * Ground-floor commercial band: bulkhead, recessed display glazing with
 * shopfront mullions, a real recessed entry with a door leaf, a transom bar,
 * a transom light and a projecting fascia, held between two end piers.
 *
 * The whole zone [0, groundTop] is partitioned, so the storefront cannot leave
 * a strip of painted shell showing between itself and the storey above.
 */
function emitStorefront(sink, edge, geom, opt) {
  const { groundTop } = geom;
  const pier = clamp(edge.length * 0.05, 0.35, 0.95);
  const s0 = pier;
  const s1 = edge.length - pier;
  const bulk = clamp(opt.variant.bulkheadHeight, 0.4, groundTop * 0.24);
  const fasciaHeight = clamp(0.42, 0.3, groundTop * 0.16);
  const fasciaBottom = groundTop - fasciaHeight;
  const transomHeight = opt.full ? clamp(opt.variant.transomHeight, 0.3, groundTop * 0.16) : 0;
  const barHeight = transomHeight > 0 ? 0.09 : 0;
  const transomBottom = fasciaBottom - transomHeight;
  const displayTop = transomBottom - barHeight;
  if (!(displayTop - bulk > 1.1) || !(s1 - s0 > 1.6)) return false;

  // Every projecting member of the shopfront is held inside the edge's own
  // outward allowance, which the batch narrows to the cladding thickness on a
  // party wall. Without this a fascia would stand 130 mm into the next
  // building, which the neighbour-intrusion check catches.
  const proud = (metres) => Math.min(opt.clad + metres, opt.projection);

  // End piers, full height of the storey.
  sink.mark('shop-pier');
  emitPanel(sink, edge, -sink.overlap, s0, 0, groundTop, opt.clad, proud(0.09), opt.tint, 0.75);
  emitPanel(sink, edge, s1, edge.length + sink.overlap, 0, groundTop, opt.clad, proud(0.09), opt.tint, 0.75);

  // Display zone: recessed glazing broken by shopfront mullions, with a deeper
  // entry recess somewhere along it.
  // Every recess stops at the pane plane: behind it is the opaque shell.
  const deepest = Math.max(0.04, opt.clad - opt.pane);
  const glazeDepth = Math.min(0.16, deepest);
  const entryDepth = Math.min(opt.full ? 0.55 : 0.2, deepest);
  const entryWidth = clamp((s1 - s0) * 0.18, 1.05, 1.9);
  const entryCentre = s0 + entryWidth / 2 + (s1 - s0 - entryWidth) * (0.15 + opt.variant.doorPick * 0.7);
  const e0 = clamp(entryCentre - entryWidth / 2, s0 + 0.15, s1 - entryWidth - 0.15);
  const e1 = e0 + entryWidth;
  const hasEntry = opt.full && opt.entry && e1 < s1 - 0.1 && e0 > s0 + 0.1;

  const spans = [];
  const mullionPitch = 2.3;
  const pushGlazing = (a, b) => {
    if (!(b - a > 0.6)) return;
    const lights = Math.max(1, Math.round((b - a) / mullionPitch));
    const step = (b - a) / lights;
    for (let i = 0; i < lights; i += 1) {
      const g0 = a + i * step + (i === 0 ? 0.05 : 0.045);
      const g1 = a + (i + 1) * step - (i === lights - 1 ? 0.05 : 0.045);
      if (g1 - g0 > 0.4) spans.push({ s0: g0, s1: g1, kind: 'display' });
    }
  };
  if (hasEntry) {
    pushGlazing(s0, e0);
    spans.push({ s0: e0, s1: e1, kind: 'entry' });
    pushGlazing(e1, s1);
  } else {
    pushGlazing(s0, s1);
  }
  spans.sort((a, b) => a.s0 - b.s0);

  // Bulkhead. Splash-back and traffic film live here, hence the high soffit
  // factor on its under-return and the ground term in the grime response. It
  // stops at the entry: a kick plate across a doorway is not a doorway.
  sink.mark('bulkhead');
  if (hasEntry) {
    emitPanel(sink, edge, s0, e0, GROUND_CLEARANCE, bulk, opt.clad, proud(0.035), opt.trimTint, 0.9);
    emitPanel(sink, edge, e1, s1, GROUND_CLEARANCE, bulk, opt.clad, proud(0.035), opt.trimTint, 0.9);
  } else {
    emitPanel(sink, edge, s0, s1, GROUND_CLEARANCE, bulk, opt.clad, proud(0.035), opt.trimTint, 0.9);
  }

  // Shopfront glazing is not upper-storey glazing: a shop is lit from inside
  // all day, its ceiling is bright, and there are fittings a metre behind the
  // glass. Round 1 gave it the same dark pane as a fourth-floor office and it
  // read as a continuous black band two storeys tall.
  let light = 0;
  emitRow(sink, edge, bulk, displayTop, spans, opt.tint, (span) => {
    if (span.kind === 'entry') return;
    const hash = openingHash(opt.shopSeed, edge.index, 0, light);
    light += 1;
    const shopGlaze = {
      key: 'shop',
      role: 'glass-lit',
      sky: hexToSrgb(SHOP_INTERIOR.ceiling),
      floor: hexToSrgb(SHOP_INTERIOR.back),
      blind: 0,
      curtain: 0,
      curtainSide: 0,
      blindTint: [1, 1, 1],
      curtainTint: [1, 1, 1],
    };
    sink.mark('shop-glazing');
    emitStoreyBand(sink, edge, span.s0, span.s1, bulk, displayTop, {
      clad: opt.clad, reveal: glazeDepth, tint: opt.tint, glassTint: opt.glassTint,
      part: 'shop-glazing', glaze: shopGlaze,
    });
    // Fittings behind the glass: a counter or display shelf at waist height,
    // and the lit valance under the ceiling. Two quads per light, and they are
    // what turn a black band into a shop.
    const back = opt.clad - glazeDepth;
    const counterY = bulk + Math.min(1.0, (displayTop - bulk) * 0.34);
    const fitting = hexToSrgb(FACADE_INTERIOR_MATERIAL.fittings[hash % FACADE_INTERIOR_MATERIAL.fittings.length]);
    if (displayTop - bulk > 1.4 && span.s1 - span.s0 > 0.5) {
      sink.mark('shop-fitting').paint(fitting, 0.55);
      sink.quad('interior', edge, [[span.s0, counterY - 0.34, back + 0.02], [span.s0, counterY, back + 0.02], [span.s1, counterY, back + 0.02], [span.s1, counterY - 0.34, back + 0.02]], 'out');
      sink.mark('shop-valance').paint(hexToSrgb(SHOP_INTERIOR.valance), 0.15);
      sink.quad('interior', edge, [[span.s0, displayTop - 0.24, back + 0.02], [span.s0, displayTop - 0.05, back + 0.02], [span.s1, displayTop - 0.05, back + 0.02], [span.s1, displayTop - 0.24, back + 0.02]], 'out');
    }
  }, 0.2, s0, s1);

  if (hasEntry) {
    // The entry is cut from the pavement to the transom, deeper than the
    // display glazing, with a threshold and a door leaf at the back.
    const doorTop = Math.min(displayTop - 0.05, 2.45);
    const back = opt.clad - entryDepth;
    sink.mark('entry').paint(opt.tint, 0.6);
    sink.quad('structure', edge, [[e0, GROUND_CLEARANCE, opt.clad], [e0, doorTop, opt.clad], [e0, doorTop, back], [e0, GROUND_CLEARANCE, back]], 'along');
    sink.quad('structure', edge, [[e1, GROUND_CLEARANCE, opt.clad], [e1, doorTop, opt.clad], [e1, doorTop, back], [e1, GROUND_CLEARANCE, back]], 'against');
    sink.paint(opt.tint, 1);
    sink.quad('structure', edge, [[e0, doorTop, opt.clad], [e1, doorTop, opt.clad], [e1, doorTop, back], [e0, doorTop, back]], 'down');
    sink.paint(opt.trimTint, 0.95);
    sink.quad('structure', edge, [[e0, GROUND_CLEARANCE, opt.clad], [e1, GROUND_CLEARANCE, opt.clad], [e1, GROUND_CLEARANCE, back], [e0, GROUND_CLEARANCE, back]], 'up');
    // Door leaf: a glazed panel behind its frame, standing at the back of the
    // recess. The glass is the deepest plane the entrance owns, and it still
    // stands proud of the shell -- see the depth-stack note.
    sink.mark('door').paint(opt.frameTint, 0.25);
    sink.quad('frame', edge, [[e0 + 0.04, GROUND_CLEARANCE, back + 0.025], [e0 + 0.04, doorTop - 0.04, back + 0.025], [e1 - 0.04, doorTop - 0.04, back + 0.025], [e1 - 0.04, GROUND_CLEARANCE, back + 0.025]], 'out');
    sink.paint(opt.glassTint, 0.25);
    sink.quad('glass', edge, [[e0 + 0.13, 0.24, back], [e0 + 0.13, doorTop - 0.16, back], [e1 - 0.13, doorTop - 0.16, back], [e1 - 0.13, 0.24, back]], 'out');
    // Wall above the entry head, up to the display head.
    sink.mark('shop-wall').paint(opt.tint, 0.25);
    emitClad(sink, edge, e0, e1, doorTop, displayTop, opt.clad);
  }

  if (transomHeight > 0) {
    // Transom bar, then the transom light above the display head.
    sink.mark('transom-bar');
    emitPanel(sink, edge, s0, s1, displayTop, transomBottom, opt.clad, proud(0.055), opt.frameTint, 0.8);
    emitRow(sink, edge, transomBottom, fasciaBottom, [{ s0: s0 + 0.06, s1: s1 - 0.06 }], opt.tint, (span) => {
      sink.mark('transom');
      emitStoreyBand(sink, edge, span.s0, span.s1, transomBottom, fasciaBottom, {
        clad: opt.clad, reveal: Math.min(0.1, deepest), tint: opt.tint, glassTint: opt.glassTint, part: 'transom',
      });
    }, 0.3, s0, s1);
  }

  // Fascia / sign band: the projecting head of the shopfront.
  sink.mark('fascia');
  emitPanel(sink, edge, s0 - 0.06, s1 + 0.06, fasciaBottom, groundTop, opt.clad, proud(0.13), opt.signTint, 0.95);
  return true;
}

/** Roofline: era-appropriate cap between `capBottom` and the shell top. */
function emitCap(sink, edge, height, opt) {
  const { variant, clad, tint, trimTint } = opt;
  // A cap is a silhouette element, and silhouette is read at distance. A fixed
  // 0.6 m cornice is two pixels on a 115 m tower at 200 m, which is why round 1
  // showed tall buildings terminating flat against the sky. Cap members
  // therefore grow with the building: a tall building gets a metres-deep
  // entablature, a shopfront keeps its 0.4 m one.
  const capScale = clamp(1 + height / 45, 1, 4.5);
  const parapet = clamp(variant.parapetHeight * capScale, 0.4, Math.max(0.4, height * 0.075));
  const corniceHeight = clamp(variant.corniceHeight * capScale, 0.35, Math.max(0.35, height * 0.06));
  const copingHeight = clamp(0.14 * capScale, 0.12, 0.85);
  const architrave = clamp(0.16 * capScale, 0.14, 0.9);
  const dentilHeight = clamp(0.2 * capScale, 0.18, 0.8);
  const corniceTop = height - parapet;
  const corniceBottom = corniceTop - corniceHeight;
  const projection = Math.min(variant.corniceProjection, opt.projection - clad);
  if (!(corniceBottom > 1) || projection < 0.03) {
    const flat = Math.max(0, height - 0.6);
    sink.mark('parapet').paint(tint, 0.1);
    emitClad(sink, edge, -sink.overlap, edge.length + sink.overlap, flat, height, clad);
    return { capBottom: flat };
  }
  const s0 = -sink.overlap;
  const s1 = edge.length + sink.overlap;
  // The bottom of whatever this branch actually emits. It is returned so the
  // storey loop knows where its wall must stop; getting it wrong leaves an
  // uncovered strip of painted shell under the cornice.
  let capBottom = corniceBottom;
  if (opt.full && (variant.capProfile === 'entablature' || variant.capProfile === 'bracketed')) {
    // Architrave, then the corona, then the parapet and its coping.
    capBottom = corniceBottom - architrave;
    sink.mark('architrave');
    emitProfile(sink, edge, s0, s1, corniceBottom - architrave, corniceBottom, clad, clad + projection * 0.4, trimTint, 0.9);
    if (variant.capProfile === 'bracketed') {
      // Dentils: a row of small blocks under the corona. Real high-frequency
      // detail on the one line of a masonry building the sun always rakes.
      const count = clamp(Math.round(edge.length / clamp(0.62 * capScale, 0.5, 2.2)), 2, 40);
      const step = edge.length / count;
      const spans = [];
      for (let i = 0; i < count; i += 1) {
        const a = i * step + step * 0.28;
        const b = i * step + step * 0.72;
        if (b - a > 0.1) spans.push({ s0: a, s1: b });
      }
      emitRow(sink, edge, corniceBottom, corniceBottom + dentilHeight, spans, tint, (span) => {
        sink.mark('dentil');
        emitPanel(sink, edge, span.s0, span.s1, corniceBottom, corniceBottom + dentilHeight, clad, clad + projection * 0.55, trimTint, 0.95);
      }, 0.6);
      sink.mark('cornice');
      emitProfile(sink, edge, s0, s1, corniceBottom + dentilHeight, corniceTop, clad, clad + projection, trimTint, 0.95);
    } else {
      sink.mark('cornice');
      emitProfile(sink, edge, s0, s1, corniceBottom, corniceTop, clad, clad + projection, trimTint, 0.95);
    }
    sink.mark('parapet').paint(tint, 0.12);
    emitClad(sink, edge, s0, s1, corniceTop, height - copingHeight, clad);
    sink.mark('coping');
    emitProfile(sink, edge, s0, s1, height - copingHeight, height, clad, clad + Math.min(0.14, projection), trimTint, 0.7);
  } else if (variant.capProfile === 'reveal') {
    // Curtain-wall language: a shadow reveal under a flush parapet.
    // Curtain-wall crown: a deep shadow reveal, then a flush parapet capped by
    // a proud coping. The reveal is the cap here, so it scales too.
    const revealBand = clamp(0.14 * capScale, 0.12, 0.7);
    sink.mark('cornice');
    emitProfile(sink, edge, s0, s1, corniceBottom, corniceBottom + revealBand, clad, Math.max(opt.pane, clad - 0.1), trimTint, 0.95);
    sink.mark('parapet').paint(tint, 0.12);
    emitClad(sink, edge, s0, s1, corniceBottom + revealBand, height - copingHeight, clad);
    sink.mark('coping');
    emitProfile(sink, edge, s0, s1, height - copingHeight, height, clad, clad + Math.min(0.12, projection), trimTint, 0.7);
  } else {
    sink.mark('parapet').paint(tint, 0.12);
    emitClad(sink, edge, s0, s1, corniceBottom, height - copingHeight, clad);
    sink.mark('coping');
    emitProfile(sink, edge, s0, s1, height - copingHeight, height, clad, clad + Math.min(0.16, projection), trimTint, 0.8);
  }
  // Close the slot between the cladding and the shell's roof edge, so an
  // aerial view does not look down a 200 mm gap all the way round the roof.
  if (clad > 0.01) {
    sink.mark('coping').paint(trimTint, 0.2);
    sink.quad('structure', edge, [[s0, height, 0], [s1, height, 0], [s1, height, clad], [s0, height, clad]], 'up');
  }
  return { capBottom };
}

/**
 * Vertical composition: which register each storey belongs to.
 *
 * Round 1 varied buildings against each other but never a building against
 * itself, so a tall elevation was one window band repeated storey after storey.
 * A real elevation has registers:
 *
 *   ground      the street storey -- storefront or plinth
 *   mezzanine   a shallower second register sitting on the ground floor
 *   typical     the shaft
 *   mechanical  a plant floor: louvres, no glazing
 *   crown       the top one or two storeys, on a different rhythm
 *
 * Everything here is a deterministic function of the storey count and the
 * building's own variant, so it is stable across LOD changes.
 */
function storeyRegisters(levels, variant) {
  const registers = new Array(levels).fill('typical');
  registers[0] = 'ground';
  if (levels >= 5 && variant.mezzanine) registers[1] = 'mezzanine';
  const crown = levels >= 12 ? 2 : levels >= 6 ? 1 : 0;
  for (let i = 0; i < crown; i += 1) {
    const index = levels - 1 - i;
    if (index > 1) registers[index] = 'crown';
  }
  if (levels >= 10) {
    const primary = Math.round(levels * (0.58 + variant.mechanicalPick * 0.12));
    if (registers[primary] === 'typical') registers[primary] = 'mechanical';
    if (levels >= 26) {
      const secondary = Math.round(levels * 0.32);
      if (registers[secondary] === 'typical') registers[secondary] = 'mechanical';
    }
  }
  return registers;
}

/** Sill and head of one storey's glazing zone. Shared by openings and bands. */
function articulationGlazing(storeys, index, variant, capBottom, register = 'typical') {
  const floor = storeys.floors[index];
  const top = storeys.tops[index];
  const storeyHeight = top - floor;
  if (!(storeyHeight > 2.3)) return null;
  // Register changes the proportion, not just the decoration: a mezzanine is a
  // wide low band, a crown storey is taller and sits higher in its storey.
  const lift = register === 'mezzanine' ? 0.34 : register === 'crown' ? 0.2 : 0.24;
  const share = register === 'mezzanine' ? 0.42 : register === 'crown' ? 0.68 : 0.6;
  const sill = floor + clamp(storeyHeight * lift, 0.5, variant.sillLift * (register === 'mezzanine' ? 1.6 : 1));
  const head = Math.min(sill + Math.min(storeyHeight * share, 2.8), top - 0.35);
  if (!(head - sill >= MIN_WINDOW_HEIGHT)) return null;
  if (head > capBottom - 0.2) return null;
  return { sill, head };
}

/**
 * The detail ladder. A building starts at the rung its ring names and steps
 * down until it fits its triangle cap. Every rung is a complete elevation, so
 * a step down changes the vocabulary of the whole facade rather than removing
 * pieces of it -- there is no rung at which part of a wall is missing.
 */
export const ART_DETAIL_LADDER = Object.freeze([
  Object.freeze({ name: 'full', bandFins: true, clad: true, edges: 6, openStoreys: 6, frames: true, mullions: true, sills: true, lintels: true, drip: true, storefront: 'full', full: true }),
  Object.freeze({ name: 'framed', bandFins: true, clad: true, edges: 5, openStoreys: 5, frames: true, mullions: true, sills: true, lintels: false, drip: false, storefront: 'full', full: true }),
  Object.freeze({ name: 'reveal', bandFins: true, clad: true, edges: 4, openStoreys: 4, frames: false, mullions: false, sills: true, lintels: false, drip: false, storefront: 'simple', full: false }),
  Object.freeze({ name: 'sparse', bandFins: true, clad: true, edges: 4, openStoreys: 2, frames: false, mullions: false, sills: false, lintels: false, drip: false, storefront: 'simple', full: false }),
  Object.freeze({ name: 'banded', bandFins: true, clad: true, edges: 4, openStoreys: 0, frames: false, mullions: false, sills: false, lintels: false, drip: false, storefront: 'simple', full: false }),
  Object.freeze({ name: 'silhouette', bandFins: false, clad: false, edges: 4, openStoreys: 0, frames: false, mullions: false, sills: false, lintels: false, drip: false, storefront: null, full: false }),
]);

const ART_RING_LADDER_START = Object.freeze({ near: 0, mid: 2, far: 4, silhouette: 5 });

/** Emit one complete elevation for one edge. */
function layoutEdge(sink, edge, state) {
  const { height, storeys, variant, detail, opt } = state;
  const detailEdge = state.detailEdges.has(edge.index);
  // The shopfront is not budgeted with the shaft. It is the part of the
  // elevation the player stands closest to and walks around the corner of, so
  // it follows the longest frontages rather than the faces that happen to turn
  // toward the LOD centre this refresh.
  const frontEdge = state.frontEdges.has(edge.index);
  sink.clad = opt.clad;
  // Adjacent elevations must meet at the corner. Running each one past its end
  // by its own clad depth closes a right-angle corner exactly; the end returns
  // emitted below close the rest, so no corner can show a slot.
  const overlap = Math.max(ART_CORNER_OVERLAP, opt.clad);
  sink.overlap = overlap;

  // A party wall has the next building standing where its cladding would go.
  // It gets one flush panel at the pane plane: enough to cover the painted
  // shell where the neighbour is shorter, nothing that can reach into it.
  if (detail.clad && opt.projection <= ART_PARTY_ALLOWANCE + 1e-6) {
    // A party wall is the face the next building is standing against. There is
    // no room to clad it, and a near-coplanar panel laid over the shell is
    // worse than nothing: measured offline, a flush panel on a 160 m party
    // wall lost the depth test to the shell at a grazing view and the painted
    // grid showed through as speckle across the whole face. So this edge is
    // left to the shell, which is what carried it before the pass existed.
    return { openings: 0, bands: 0, glazedRows: 0, bandedRows: 0, party: true };
  }

  if (!detail.clad) {
    // Silhouette: the shell texture keeps the wall; only the two lines that
    // give a prism a top and a foot are built.
    const projection = Math.min(variant.corniceProjection, opt.projection);
    const capBand = clamp(0.62 * clamp(1 + height / 45, 1, 4.5), 0.5, Math.max(0.5, height * 0.09));
    sink.mark('cornice');
    emitProfile(sink, edge, 0, edge.length, Math.max(0, height - capBand), height, 0, projection, opt.trimTint, 0.9);
    const plinth = clamp(variant.plinthHeight, 0.3, Math.max(0.3, height * 0.12));
    sink.mark('plinth');
    emitProfile(sink, edge, 0, edge.length, GROUND_CLEARANCE, plinth, 0, Math.min(variant.plinthProjection, opt.projection), opt.trimTint, 0.95);
    return { openings: 0, bands: 0, glazedRows: 0, bandedRows: 0 };
  }

  // Backing plane. The courses below partition the whole elevation, but a
  // shared edge between two of them can still crack by a pixel on some
  // rasterisers, and behind that crack is the shell's painted window grid.
  // One quad just outside the shell means a crack shows the building's own
  // colour instead. It is deliberately NOT part of the partition: the
  // coverage check ignores it, so it cannot hide a real hole.
  sink.mark('backing').paint(opt.tint, 0.45);
  emitClad(sink, edge, -overlap, edge.length + overlap, 0, height, ART_PANE * 0.6);

  const cap = emitCap(sink, edge, height, opt);
  const capBottom = Math.max(1, cap.capBottom);
  let cursor = 0;
  let openings = 0;
  let bands = 0;
  let bandLow = Infinity;
  let bandHigh = -Infinity;

  let storefront = false;
  if (state.commercial && detail.storefront && frontEdge && storeys.tops[0] > 2.6 && edge.length >= 4.5) {
    storefront = emitStorefront(sink, edge, { groundTop: Math.min(storeys.tops[0], capBottom) }, {
      ...opt,
      full: detail.storefront === 'full',
      entry: state.tagged || detail.storefront === 'full',
      variant,
    });
  }
  if (storefront) {
    cursor = Math.min(storeys.tops[0], capBottom);
    sink.counts.storefront = (sink.counts.storefront || 0) + 1;
  } else {
    const plinth = Math.min(clamp(variant.plinthHeight, 0.3, Math.max(0.3, height * 0.12)), capBottom * 0.5);
    sink.mark('plinth');
    emitPanel(
      sink, edge, -overlap, edge.length + overlap, GROUND_CLEARANCE, plinth,
      opt.clad, opt.clad + Math.min(variant.plinthProjection, opt.projection - opt.clad), opt.trimTint, 0.95,
    );
    cursor = plinth;
    sink.counts.plinth = (sink.counts.plinth || 0) + 1;
  }

  const startStorey = storefront ? 1 : 0;
  const typicalBays = bayspans(edge, variant, variant.windowRatio);
  // The crown runs on its own rhythm: narrower, more closely spaced openings,
  // so the top of a tower does not look like more of the same shaft.
  const crownBays = bayspans(edge, variant, variant.windowRatio * variant.crownRatio, 1.35);
  const canOpen = detailEdge && typicalBays.spans.length > 0;
  let opened = 0;
  let glazedRows = 0;
  let bandedRows = 0;
  const seed = state.seed;
  // The cap eats the top of a tall building -- a 115 m tower carries a ~16 m
  // entablature and parapet -- so the crown register has to be pinned to the
  // topmost storey that can still carry glazing, not to the topmost storey.
  // Without this the crown falls inside the cap and never renders, which is
  // how round 1 ended up banding every elevation right up to the roofline.
  const registers = state.registers.slice();
  let topGlazed = -1;
  for (let i = storeys.levels - 1; i >= 0; i -= 1) {
    if (storeys.tops[i] - storeys.floors[i] > 2.3 && storeys.tops[i] - 0.35 <= capBottom - 0.2) { topGlazed = i; break; }
  }
  if (topGlazed >= 2 && state.crownCount > 0) {
    for (let i = 0; i < registers.length; i += 1) if (registers[i] === 'crown') registers[i] = 'typical';
    for (let k = 0; k < state.crownCount; k += 1) {
      const index = topGlazed - k;
      if (index > 1 && registers[index] === 'typical') registers[index] = 'crown';
    }
  }
  // The crown and the mezzanine are reserved out of the opening budget rather
  // than competing for it. On a thirty-storey tower the budget is spent long
  // before the top, and the top is the part read against the sky -- round 1
  // banded it, which is why tall elevations repeated to the roofline.
  // The ladder's `openStoreys` is a FLOOR, not a ceiling. `state.openStoreyBudget`
  // is the screen-coverage answer to the same question -- when this elevation
  // fills enough of the frame for its storeys to be read individually, every
  // storey is glazed individually. Round 2 had only the floor, so a fifty
  // storey tower 4.5 m from the eye carried four glazed storeys and forty-six
  // flat bands: the ladder's own rule is that approaching a building deepens
  // the same lines rather than moving them, and a rung that swaps a band for a
  // window moves them.
  const budgeted = Math.max(detail.openStoreys, state.openStoreyBudget || 0);
  const bottomBudget = detail.openStoreys > 0 ? Math.max(1, budgeted - state.crownCount) : 0;

  for (let index = startStorey; index < storeys.levels; index += 1) {
    const register = registers[index] || 'typical';
    const band = articulationGlazing(storeys, index, variant, capBottom, register);
    if (!band) continue;
    if (!(band.sill > cursor + 0.12)) continue;
    // Weathering accumulates downward: every sill above sheds onto the wall
    // below it, so the same detail is dirtier the closer it is to the street.
    const shed = clamp(0.5 + 0.5 * (1 - band.sill / Math.max(1, height)), 0.5, 1);

    // --- mechanical floor: louvres, no glazing ------------------------------
    if (register === 'mechanical') {
      const inset = clamp(edge.length * 0.05, 0.18, 0.8);
      const m0 = inset;
      const m1 = edge.length - inset;
      if (m1 - m0 > 1 && band.head - band.sill > 0.9) {
        if (band.sill > cursor + EPSILON) {
          sink.mark('wall').paint(opt.tint, 0.1);
          emitClad(sink, edge, -overlap, edge.length + overlap, cursor, band.sill, opt.clad);
        }
        emitRow(sink, edge, band.sill, band.head, [{ s0: m0, s1: m1 }], opt.tint, (span) => {
          const plenum = Math.max(opt.pane, opt.clad - 0.09);
          sink.mark('louvre-plenum').paint(opt.plenumTint, 1);
          emitPanel(sink, edge, span.s0, span.s1, band.sill, band.head, opt.clad, plenum, opt.plenumTint, 1);
          const fins = 5;
          const step = (band.head - band.sill) / fins;
          sink.mark('louvre').paint(opt.frameTint, 0.55);
          for (let f = 0; f < fins; f += 1) {
            const fy0 = band.sill + f * step + step * 0.12;
            const fy1 = fy0 + step * 0.6;
            sink.quad('interior', edge, [[span.s0, fy0, plenum + 0.05], [span.s0, fy1, plenum + 0.05], [span.s1, fy1, plenum + 0.05], [span.s1, fy0, plenum + 0.05]], 'out');
          }
        }, 0.3);
        sink.counts.mechanical = (sink.counts.mechanical || 0) + 1;
        cursor = band.head;
        continue;
      }
    }

    const bays = register === 'crown' && crownBays.spans.length ? crownBays : typicalBays;
    // A blank bay every few storeys stops the grid reading as a print. The
    // pier fill covers whatever is dropped, so this can never open a hole.
    const interrupt = openingHash(seed ^ variant.interruptSeed, edge.index, index, 0);
    let spansForStorey = bays.spans;
    if (register === 'typical' && bays.spans.length >= 3 && interrupt % 6 === 0) {
      const drop = interrupt % bays.spans.length;
      spansForStorey = bays.spans.filter((_, i) => i !== drop);
    }

    // A rung with no opening budget at all builds bands only, whatever the
    // register: that is what keeps per-window geometry inside the mid radius.
    const reserved = detail.openStoreys > 0 && (register === 'crown' || register === 'mezzanine');
    const useOpenings = canOpen && spansForStorey.length > 0 && (reserved || opened < bottomBudget);
    const sillLedge = useOpenings && detail.sills && register !== 'mezzanine';
    const dripBand = useOpenings && detail.drip && register !== 'mezzanine';
    const sillTop = band.sill;
    const sillBottom = sillLedge ? band.sill - 0.1 : band.sill;
    const dripTop = sillBottom;
    const dripBottom = dripBand ? dripTop - ART_DRIP_HEIGHT : dripTop;

    if (dripBottom > cursor + EPSILON) {
      sink.mark('wall').paint(opt.tint, 0.1);
      emitClad(sink, edge, -overlap, edge.length + overlap, cursor, dripBottom, opt.clad);
    }
    // A string course under the first crown storey: the line that separates
    // the shaft from the cap.
    if (register === 'crown' && registers[index - 1] !== 'crown' && dripBottom > 1.2 && detail.sills) {
      sink.mark('string-course');
      emitProfile(
        sink, edge, -overlap, edge.length + overlap, dripBottom - 0.22, dripBottom - 0.04,
        opt.clad, opt.clad + Math.min(0.12, opt.projection - opt.clad), opt.trimTint, 0.9,
      );
      sink.counts.stringCourse = (sink.counts.stringCourse || 0) + 1;
    }
    if (dripBand && dripTop > dripBottom) {
      // Drip recess: a 35 mm groove under each sill. Rain leaving the sill
      // runs into it, so this is where the streak lives -- as geometry that
      // self-shadows, not as a painted stripe.
      const spans = spansForStorey.map((span) => ({ s0: span.s0 - 0.08, s1: span.s1 + 0.08 }));
      emitRow(sink, edge, dripBottom, dripTop, spans, opt.tint, (span) => {
        sink.mark('drip');
        emitPanel(sink, edge, span.s0, span.s1, dripBottom, dripTop, opt.clad, opt.clad - ART_DRIP_DEPTH, opt.tint, shed);
      }, 0.15 * shed);
    }
    if (sillLedge && sillTop > sillBottom) {
      const spans = spansForStorey.map((span) => ({ s0: span.s0 - 0.13, s1: span.s1 + 0.13 }));
      emitRow(sink, edge, sillBottom, sillTop, spans, opt.tint, (span) => {
        sink.mark('sill');
        emitPanel(
          sink, edge, span.s0, span.s1, sillBottom, sillTop,
          opt.clad, opt.clad + Math.min(variant.sillProjection, opt.projection - opt.clad), opt.trimTint, shed,
        );
      }, 0.2 * shed);
      sink.counts.sill = (sink.counts.sill || 0) + 1;
    }

    if (useOpenings) {
      let column = 0;
      emitRow(sink, edge, band.sill, band.head, spansForStorey, opt.tint, (span) => {
        const glaze = glazingFor(openingHash(seed, edge.index, index, column));
        column += 1;
        if (detail.frames) {
          emitOpening(sink, edge, span.s0, span.s1, band.sill, band.head, {
            clad: opt.clad,
            reveal: opt.reveal,
            glassSet: variant.glassSet,
            frameWidth: variant.frameWidth,
            // A crown opening is a paired light; a mezzanine is a single wide
            // one. Rhythm changes up the elevation, not just proportion.
            mullionPattern: detail.mullions
              ? (register === 'crown' ? 1 : register === 'mezzanine' ? 0 : variant.mullionPattern)
              : 0,
            tint: opt.tint,
            glassTint: opt.glassTint,
            frameTint: opt.frameTint,
            glaze,
          });
        } else {
          emitPlainOpening(sink, edge, span.s0, span.s1, band.sill, band.head, {
            clad: opt.clad, reveal: opt.reveal, tint: opt.tint, glassTint: opt.glassTint, glaze,
          });
        }
        openings += 1;
      }, 0.25);
      sink.counts.window = (sink.counts.window || 0) + spansForStorey.length;
      sink.counts[`register-${register}`] = (sink.counts[`register-${register}`] || 0) + 1;
      opened += 1;
      glazedRows += 1;
      cursor = band.head;
      if (detail.lintels) {
        const spans = spansForStorey.map((span) => ({ s0: span.s0 - 0.09, s1: span.s1 + 0.09 }));
        const top = Math.min(band.head + 0.14, capBottom);
        if (top > band.head + 0.02) {
          emitRow(sink, edge, band.head, top, spans, opt.tint, (span) => {
            sink.mark('lintel');
            emitPanel(
              sink, edge, span.s0, span.s1, band.head, top,
              opt.clad, opt.clad + Math.min(variant.lintelDepth, opt.projection - opt.clad), opt.trimTint, 0.9,
            );
          }, 0.15);
          cursor = top;
          sink.counts.lintel = (sink.counts.lintel || 0) + 1;
        }
      }
    } else {
      // One recessed glazing band across the storey, on the same line the
      // openings would use.
      // Banded storeys still have to differ from each other: the inset shifts,
      // and roughly a fifth of them are lit, so a shaft is not one row of
      // pixels copied to the roofline.
      const bandHash = openingHash(seed, edge.index, index, 0);
      const inset = clamp(edge.length * (0.04 + ((bandHash >>> 9) % 5) * 0.008), 0.18, 0.9);
      const b0 = inset;
      const b1 = edge.length - inset;
      if (b1 - b0 > 0.9) {
        const bandLit = ((bandHash >>> 5) % 100) < 22;
        const glaze = glazingFor(bandHash, {
          interior: bandLit
            ? { ...WINDOW_INTERIORS.lit, blind: false, curtain: false }
            : { ...WINDOW_INTERIORS.empty, blind: false, curtain: false, lit: false },
        });
        emitRow(sink, edge, band.sill, band.head, [{ s0: b0, s1: b1 }], opt.tint, (span) => {
          emitStoreyBand(sink, edge, span.s0, span.s1, band.sill, band.head, {
            clad: opt.clad,
            reveal: opt.reveal,
            tint: opt.tint,
            trimTint: opt.trimTint,
            glassTint: opt.glassTint,
            glaze,
          });
          bands += 1;
          bandLow = Math.min(bandLow, band.sill);
          bandHigh = Math.max(bandHigh, band.head);
        }, 0.25);
        sink.counts.band = (sink.counts.band || 0) + 1;
        bandedRows += 1;
        cursor = band.head;
      }
    }
  }

  if (cursor < capBottom) {
    sink.mark('wall').paint(opt.tint, 0.1);
    emitClad(sink, edge, -overlap, edge.length + overlap, cursor, capBottom, opt.clad);
  }

  // Continuous bay piers over a banded elevation. An unbroken glazing stripe
  // is what makes a distant tower read as a flat coloured band with a black
  // slot cut in it, but a fin per bay per storey costs a fin per bay per
  // storey. One pier running the whole banded height is both cheaper -- bays
  // instead of bays x storeys -- and better architecture: that is what a
  // curtain wall's mullions actually do.
  if (detail.bandFins && bands > 0 && bandHigh - bandLow > 1.5) {
    const columns = clamp(Math.round(edge.length / variant.bayWidth), 1, MAX_ART_BAYS);
    if (columns > 1) {
      const pitch = edge.length / columns;
      const width = clamp(pitch * 0.06, 0.08, 0.24);
      const proud = Math.min(opt.clad + 0.07, opt.projection);
      sink.mark('bay-pier').paint(opt.trimTint, 0.35);
      for (let i = 1; i < columns; i += 1) {
        const c = i * pitch;
        sink.quad('structure', edge, [[c - width, bandLow, proud], [c - width, bandHigh, proud], [c + width, bandHigh, proud], [c + width, bandLow, proud]], 'out');
      }
      sink.counts.bayPier = (sink.counts.bayPier || 0) + 1;
    }
  }
  // End returns: the side of the cladding tab where it runs past the corner.
  // On a right angle they land inside the neighbouring elevation and are never
  // seen; on an acute or obtuse corner they are what closes it.
  if (opt.clad > 0.01) {
    sink.mark('corner-return').paint(opt.tint, 0.5);
    sink.quad('structure', edge, [[-overlap, 0, 0], [-overlap, height, 0], [-overlap, height, opt.clad], [-overlap, 0, opt.clad]], 'against');
    sink.quad('structure', edge, [[edge.length + overlap, 0, 0], [edge.length + overlap, height, 0], [edge.length + overlap, height, opt.clad], [edge.length + overlap, 0, opt.clad]], 'along');
  }
  return { openings, bands, glazedRows, bandedRows };
}

/**
 * Plan one building's articulated elevation.
 *
 * @param {object} building city.buildings[i]: polygon, height, levels, material, id
 * @param {object} [options]
 * @param {'near'|'mid'|'far'|'silhouette'} [options.ring='near']
 * @param {number} [options.baseY=0]
 * @param {number} [options.salt=0] variant salt, used to break a signature
 *   collision with a neighbour
 * @param {number} [options.maxProjection] outward allowance from the wall
 * @param {number} [options.triangleCap] override the ring cap
 */
export function planFacadeArticulation(building, options = {}) {
  const ring = FACADE_ARTICULATION_RING_ORDER.includes(options.ring) ? options.ring : 'near';
  const baseY = Number.isFinite(options.baseY) ? options.baseY : 0;
  const salt = Number.isFinite(options.salt) ? options.salt : 0;
  const uvMetres = options.uvMetres || FACADE_DEPTH_UV_METRES;
  const resolved = resolveFacadeStyleEntry(building);
  const style = resolved.style;
  const { className, source: classSource } = resolveArticulationClass(building);
  const classDef = FACADE_MATERIAL_CLASSES[className];
  const variant = drawArticulationVariant(building, style, className, salt);
  const signature = facadeArticulationSignature(style, className, variant);
  const height = Number(building?.height);

  const empty = {
    id: building?.id ?? null,
    style,
    className,
    classSource,
    ring,
    detailLevel: null,
    signature,
    quads: [],
    triangles: 0,
    openings: 0,
    bands: 0,
    glazedStoreys: 0,
    bandedStoreys: 0,
    edgeRows: [],
    coverage: 0,
    glazeAll: false,
    features: {},
    bounds: null,
    footprint: null,
    baseY,
    height: Number.isFinite(height) ? height : 0,
    levels: 0,
    skipped: 'empty',
  };

  const points = normalisePolygon(building?.polygon);
  if (!points.length) return { ...empty, skipped: 'polygon' };
  if (!Number.isFinite(height) || height < MIN_BUILDING_HEIGHT) return { ...empty, skipped: 'height' };

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const planExtent = Math.min(maxX - minX, maxZ - minZ);
  if (!(planExtent >= MIN_PLAN_EXTENT)) return { ...empty, skipped: 'extent' };
  const footprintArea = Math.abs(signedArea(points));
  if (!(footprintArea >= MIN_FOOTPRINT_AREA)) return { ...empty, skipped: 'area' };

  const allEdges = buildEdges(points);
  if (!allEdges.length) return { ...empty, skipped: 'edges' };
  const usable = allEdges.filter((edge) => edge.length >= MIN_ART_EDGE);
  if (!usable.length) return { ...empty, skipped: 'short-edges' };

  const declaredProjection = Number.isFinite(options.maxProjection)
    ? clamp(options.maxProjection, 0.04, FACADE_ARTICULATION_MAX_PROJECTION)
    : FACADE_ARTICULATION_MAX_PROJECTION;
  // A narrow plan cannot carry a thick cladding layer on both of its faces.
  const inwardLimit = Math.max(0.05, Math.min(0.4, planExtent * 0.18));
  // The reveal is the recess from the clad wall face down to the frame face.
  // Everything sits outside the shell; see the depth-stack note above.
  const glassSet = variant.glassSet;
  const reveal = clamp(
    Math.min(variant.reveal, Math.max(ART_REVEAL_MIN, planExtent * 0.06)),
    ART_REVEAL_MIN,
    ART_REVEAL_MAX,
  );
  const cladDepth = ART_PANE + glassSet + reveal;
  const tagged = hasStreetLevelTrade(building);
  const commercial = tagged || FACADE_STYLE_PROFILES[style].commercialGround;
  const storeys = articulationStoreys(building, height, commercial);

  const palette = classDef.palette;
  const tint = hexToSrgb(palette[variant.paletteIndex % palette.length]);
  // Trim is the same body colour lifted: painted stone, cast concrete or a
  // lighter course, which is what a real cornice or sill is.
  const trimTint = tint.map((c) => clamp(c * 1.18 + 0.06, 0, 1));
  const signTint = tint.map((c) => clamp(c * 0.42, 0, 1));
  const glassTint = hexToSrgb(classDef.glass.color);
  const frameTint = hexToSrgb(FACADE_FRAME_MATERIAL.palette[variant.framePaletteIndex % FACADE_FRAME_MATERIAL.palette.length]);

  // Taller buildings legitimately carry more wall, so the per-building cap
  // scales with height. The scene budget in the batch is what actually bounds
  // the city; this only decides which rung of the ladder one building lands on.
  let perimeter = 0;
  for (const edge of allEdges) perimeter += edge.length;
  const wallArea = perimeter * height;
  // Screen coverage: how much of the reference frame this elevation fills. It
  // sizes the cap and decides whether the storeys are glazed individually.
  const coverage = Number.isFinite(options.coverage)
    ? clamp(options.coverage, 0, 1)
    : (options.facing ? articulationScreenCoverage(building, options.facing, options.screen) : 0);
  const ringSpec = FACADE_ARTICULATION_RINGS[ring] || FACADE_ARTICULATION_RINGS.silhouette;
  const cap = Number.isFinite(options.triangleCap)
    ? Math.max(0, options.triangleCap)
    : articulationTriangleCap(ring, wallArea, usable.length, coverage);
  const glazeAll = Number.isFinite(ringSpec.glazeCoverage) && coverage >= ringSpec.glazeCoverage;

  // Detail edges are the ones the focus can see. Ranking on length alone spent
  // the cap on the back of a tower -- six long faces built, two of them ever
  // rendered -- and it is that misallocation which paid for the flat bands on
  // the face the camera was pointed at. A non-facing edge is still clad and
  // still banded, so nothing is uncovered by this; it only loses joinery.
  const facing = options.facing && Number.isFinite(options.facing.x) && Number.isFinite(options.facing.z)
    ? options.facing
    : null;
  const faces = (edge) => {
    if (!facing) return 0;
    const mx = edge.ax + edge.ux * edge.length * 0.5;
    const mz = edge.az + edge.uz * edge.length * 0.5;
    return (facing.x - mx) * edge.nx + (facing.z - mz) * edge.nz > 0 ? 0 : 1;
  };
  const ranked = usable.slice().sort(
    (a, b) => (faces(a) - faces(b)) || (b.length - a.length) || (a.index - b.index),
  );
  // A prism seen from a street shows two or three of its faces. When the focus
  // is known, the joinery budget stops at the faces that turn toward it; the
  // rest of the elevation is still clad and still banded, and the triangles
  // that were being spent on the back of the block pay for the front of it.
  const facingCount = facing ? ranked.filter((edge) => faces(edge) === 0).length : 0;
  const byLength = usable.slice().sort((a, b) => (b.length - a.length) || (a.index - b.index));
  let start = ART_RING_LADDER_START[ring];
  let chosen = null;
  for (let attempt = 0; attempt < 4 && start + attempt < ART_DETAIL_LADDER.length; attempt += 1) {
    const detail = ART_DETAIL_LADDER[start + attempt];
    const placement = createArticulationPlacement({ minX, maxX, minZ, maxZ }, baseY, height, declaredProjection, uvMetres);
    const sink = new ArticulationSink(placement);
    // Every face that turns toward the focus, not the ladder's count of them:
    // the ladder's `edges` was a cost bound, and the triangle cap is now the
    // cost bound. A face the camera can see and its neighbour cannot is what
    // makes one elevation read as two different buildings.
    const detailEdgeCount = facingCount > 0 ? facingCount : detail.edges;
    const detailEdges = new Set(ranked.slice(0, detailEdgeCount).map((edge) => edge.index));
    const frontEdges = new Set(byLength.slice(0, detail.edges).map((edge) => edge.index));
    const opt = {
      clad: detail.clad ? cladDepth : 0,
      pane: ART_PANE,
      glassSet,
      reveal,
      inwardLimit,
      projection: declaredProjection,
      tint,
      trimTint,
      signTint,
      glassTint,
      frameTint,
      plenumTint: tint.map((c) => clamp(c * 0.3, 0, 1)),
      shopSeed: facadeDepthSeed(building?.id) ^ 0x5bf03635,
      variant,
      full: detail.full,
    };
    const state = {
      height, storeys, variant, detail, opt, detailEdges, frontEdges, commercial, tagged,
      registers: storeyRegisters(storeys.levels, variant),
      crownCount: storeys.levels >= 12 ? 2 : storeys.levels >= 6 ? 1 : 0,
      // Every storey, when the frame share says the storeys are readable.
      openStoreyBudget: glazeAll ? storeys.levels : 0,
      seed: facadeDepthSeed(building?.id) ^ Math.imul(salt + 1, 0x9e3779b9),
    };
    let openings = 0;
    let bands = 0;
    let glazedStoreys = 0;
    let bandedStoreys = 0;
    const edgeRows = [];
    for (const edge of usable) {
      // Per-edge outward allowance: a party wall has no room for a cornice.
      opt.projection = typeof options.projectionForEdge === 'function'
        ? clamp(Number(options.projectionForEdge(edge.index, edge)) || 0, 0, declaredProjection)
        : declaredProjection;
      sink.begin();
      const result = layoutEdge(sink, edge, state);
      sink.commit('elevation');
      openings += result.openings;
      bands += result.bands;
      glazedStoreys += result.glazedRows;
      bandedStoreys += result.bandedRows;
      // Per edge, so a caller can ask "does the face I am looking at carry
      // openings" instead of averaging the front of the building with its back.
      edgeRows.push({
        edgeIndex: edge.index,
        length: edge.length,
        detail: detailEdges.has(edge.index),
        glazedRows: result.glazedRows,
        bandedRows: result.bandedRows,
        party: result.party === true,
      });
    }
    chosen = { detail, sink, openings, bands, glazedStoreys, bandedStoreys, edgeRows };
    if (sink.triangles <= cap) break;
  }
  if (!chosen) return { ...empty, skipped: 'no-detail-level' };
  const { sink, detail } = chosen;
  if (!sink.quads.length) return { ...empty, skipped: 'no-features' };

  let boundsMinX = Infinity;
  let boundsMaxX = -Infinity;
  let boundsMinY = Infinity;
  let boundsMaxY = -Infinity;
  let boundsMinZ = Infinity;
  let boundsMaxZ = -Infinity;
  for (const quad of sink.quads) {
    for (let i = 0; i < 4; i += 1) {
      boundsMinX = Math.min(boundsMinX, quad.positions[i * 3]);
      boundsMaxX = Math.max(boundsMaxX, quad.positions[i * 3]);
      boundsMinY = Math.min(boundsMinY, quad.positions[i * 3 + 1]);
      boundsMaxY = Math.max(boundsMaxY, quad.positions[i * 3 + 1]);
      boundsMinZ = Math.min(boundsMinZ, quad.positions[i * 3 + 2]);
      boundsMaxZ = Math.max(boundsMaxZ, quad.positions[i * 3 + 2]);
    }
  }

  return {
    id: building?.id ?? null,
    style,
    className,
    classSource,
    ring,
    detailLevel: detail.name,
    signature,
    quads: sink.quads,
    triangles: sink.triangles,
    openings: chosen.openings,
    bands: chosen.bands,
    // Storey-rows that carry individual openings, and storey-rows that carry a
    // flat glazing band instead. Their ratio is what a reviewer sees as
    // "articulated elevation" versus "uniform grid of identical windows".
    glazedStoreys: chosen.glazedStoreys,
    bandedStoreys: chosen.bandedStoreys,
    edgeRows: chosen.edgeRows,
    coverage,
    glazeAll,
    features: { ...sink.counts },
    parts: { ...sink.parts },
    bounds: { minX: boundsMinX, maxX: boundsMaxX, minY: boundsMinY, maxY: boundsMaxY, minZ: boundsMinZ, maxZ: boundsMaxZ },
    footprint: { minX, maxX, minZ, maxZ },
    footprintArea,
    polygon: points,
    baseY,
    height,
    levels: storeys.levels,
    triangleCap: cap,
    perimeter,
    wallArea,
    edges: usable.length,
    maxProjection: declaredProjection,
    revealDepth: reveal,
    cladDepth,
    glassSet,
    skipped: null,
  };
}

// ---------------------------------------------------------------- geometry

/**
 * Merge articulation quads into one indexed geometry, with the weathering
 * baked into a vertex colour attribute.
 *
 * Colour is `tint * grime(height, soffit)` converted to the linear working
 * space three.js reads vertex colours in, so a material can stay white and one
 * merged draw call can still carry a whole street of different building
 * colours.
 */
export function articulationGeometryFromQuads(quads, baseY = 0) {
  const count = quads.length;
  if (!count) return null;
  const positions = new Float32Array(count * 12);
  const normals = new Float32Array(count * 12);
  const uvs = new Float32Array(count * 8);
  const colors = new Float32Array(count * 12);
  const index = count * 4 > 65535 ? new Uint32Array(count * 6) : new Uint16Array(count * 6);
  for (let q = 0; q < count; q += 1) {
    const quad = quads[q];
    positions.set(quad.positions, q * 12);
    uvs.set(quad.uvs, q * 8);
    const tint = quad.tint || [1, 1, 1];
    const linear = [srgbToLinear(tint[0]), srgbToLinear(tint[1]), srgbToLinear(tint[2])];
    let gy0 = 0;
    let gspan = 0;
    if (quad.grad) {
      gy0 = Math.min(quad.positions[1], quad.positions[4], quad.positions[7], quad.positions[10]);
      const gy1 = Math.max(quad.positions[1], quad.positions[4], quad.positions[7], quad.positions[10]);
      gspan = gy1 - gy0;
    }
    for (let v = 0; v < 4; v += 1) {
      normals[q * 12 + v * 3] = quad.normal[0];
      normals[q * 12 + v * 3 + 1] = quad.normal[1];
      normals[q * 12 + v * 3 + 2] = quad.normal[2];
      const y = quad.positions[v * 3 + 1];
      let scale = articulationGrimeScale(y - (quad.baseY ?? baseY), quad.soffit || 0);
      if (quad.grad && gspan > 1e-5) {
        const t = (y - gy0) / gspan;
        scale *= quad.grad[1] + (quad.grad[0] - quad.grad[1]) * t;
      }
      colors[q * 12 + v * 3] = Math.min(1, linear[0] * scale);
      colors[q * 12 + v * 3 + 1] = Math.min(1, linear[1] * scale);
      colors[q * 12 + v * 3 + 2] = Math.min(1, linear[2] * scale);
    }
    const base = q * 4;
    const i = q * 6;
    index[i] = base;
    index[i + 1] = base + 1;
    index[i + 2] = base + 2;
    index[i + 3] = base;
    index[i + 4] = base + 2;
    index[i + 5] = base + 3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Which merged bucket a ring's geometry belongs to. See the pass: `detail`
 *  is rebuilt when the focus moves 25 m, `bulk` when it moves 90 m. */
export function articulationZoneFor(ring) {
  return ring === 'near' || ring === 'mid' ? 'detail' : 'bulk';
}

// ------------------------------------------------------------------- batch

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.z > z) !== (b.z > z)
      && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z || EPSILON) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Per-edge outward projection allowance.
 *
 * A cornice, a sill and a shopfront fascia all stand proud of the wall. On a
 * party wall there is no room for them: the next building is there. Rather
 * than shrinking every projection in the city to the worst case, each edge is
 * probed outward at three points; an edge whose probe lands inside another
 * building's footprint is a party wall and is built flush.
 */
function edgeProjectionProbe(polygon, edges, neighbours, allowance) {
  const limits = new Map();
  const probe = allowance + 0.05;
  for (const edge of edges) {
    // Seven samples, and the edge is only a party wall if most of them are
    // buried. Round 1 flagged the whole edge on a single hit, which turned a
    // sixty-metre tower frontage into one blank panel because its far corner
    // happened to touch the next footprint. Measured on the real slice that
    // over-triggered on 931 edges; the majority rule leaves the genuine
    // shared walls and gives the frontages back.
    let hits = 0;
    for (const t of [0.08, 0.22, 0.36, 0.5, 0.64, 0.78, 0.92]) {
      const s = edge.length * t;
      const x = edge.ax + edge.ux * s + edge.nx * probe;
      const z = edge.az + edge.uz * s + edge.nz * probe;
      for (const neighbour of neighbours) {
        if (neighbour === polygon) continue;
        if (pointInPolygon(x, z, neighbour)) { hits += 1; break; }
      }
    }
    limits.set(edge.index, hits >= 5 ? ART_PARTY_ALLOWANCE : allowance);
  }
  return limits;
}

/**
 * Build merged, ring-budgeted facade articulation for a whole city.
 *
 * @param {Array<object>} buildings
 * @param {object} [options]
 * @param {{x:number,z:number}} [options.focus] LOD centre
 * @param {(building:object)=>number} [options.baseYFor] terrain sample
 * @param {object} [options.rings] override FACADE_ARTICULATION_RINGS
 * @param {number} [options.sceneTriangleBudget]
 * @param {'detail'|'bulk'|null} [options.zone] build only one zone
 * @param {Set<string>|Array<string>} [options.preserveIds] buildings whose
 *   elevation is authored elsewhere (a hand-made facade atlas, a landmark).
 *   They are never clad -- they only get the silhouette rung's roofline and
 *   base course, so the authored surface survives and still has a top.
 */
export function buildFacadeArticulationBatch(buildings, options = {}) {
  const list = Array.isArray(buildings) ? buildings : [];
  const rings = { ...FACADE_ARTICULATION_RINGS, ...(options.rings || {}) };
  const sceneBudget = Number.isFinite(options.sceneTriangleBudget)
    ? Math.max(0, options.sceneTriangleBudget)
    : FACADE_ARTICULATION_BUDGET.sceneTriangleBudget;
  const focus = options.focus && Number.isFinite(options.focus.x) && Number.isFinite(options.focus.z)
    ? { x: options.focus.x, z: options.focus.z }
    : null;
  const wantZone = options.zone === 'detail' || options.zone === 'bulk' ? options.zone : null;
  const screen = options.screen && Number.isFinite(options.screen.fov)
    ? { ...FACADE_ARTICULATION_SCREEN, ...options.screen }
    : FACADE_ARTICULATION_SCREEN;
  const preserve = options.preserveIds instanceof Set
    ? options.preserveIds
    : new Set(Array.isArray(options.preserveIds) ? options.preserveIds : []);
  const allowance = Number.isFinite(options.maxProjection)
    ? clamp(options.maxProjection, 0.04, FACADE_ARTICULATION_MAX_PROJECTION)
    : FACADE_ARTICULATION_MAX_PROJECTION;

  const rejected = [];
  const rejectedByReason = Object.create(null);
  const reject = (id, reason) => {
    rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
    if (rejected.length < 40) rejected.push({ id: id ?? null, reason });
  };

  // 1. Footprints, distance, and the neighbour grid the party-wall probe uses.
  const cell = 44;
  const grid = new Map();
  const entries = [];
  for (let index = 0; index < list.length; index += 1) {
    const building = list[index];
    const polygon = normalisePolygon(building?.polygon);
    if (!polygon.length) { reject(building?.id, 'polygon'); continue; }
    const metrics = facadeFootprintMetrics(building);
    const centroid = metrics.centroid;
    if (!centroid) { reject(building?.id, 'centroid'); continue; }
    // Distance to the nearest point of the footprint, not to the centroid: the
    // wall the player is standing against is the surface the ring is deciding
    // for. Coverage is the screen term -- how much of the reference frame this
    // elevation fills -- and it sizes the budget the plan is allowed to spend.
    const distance = focus ? nearestFootprintDistance(polygon, focus) : 0;
    const coverage = focus ? articulationScreenCoverage(building, focus, screen) : 0;
    const entry = { building, index, polygon, centroid, distance, coverage, rank: focus ? distance : index };
    entries.push(entry);
    const key = `${Math.floor(centroid.x / cell)}:${Math.floor(centroid.z / cell)}`;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(entry);
  }
  const neighboursOf = (entry) => {
    const cx = Math.floor(entry.centroid.x / cell);
    const cz = Math.floor(entry.centroid.z / cell);
    const out = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const bucket = grid.get(`${cx + dx}:${cz + dz}`);
        if (bucket) for (const other of bucket) if (other !== entry) out.push(other.polygon);
      }
    }
    return out;
  };

  // 2. Ring assignment: nearest first, bounded by both radius and count so the
  //    budget is a bound rather than a hope. Ties break on declaration order,
  //    so the assignment is deterministic for a given focus.
  const ordered = entries.slice().sort((a, b) => (a.rank - b.rank) || (a.index - b.index));

  // Uniform outside-in degrade. Every step moves a whole ring, and the ring
  // membership cut is nearest-first, so no step can leave one facade detailed
  // and its neighbour at the same distance bare:
  //   1. shrink every ring's population to 60%
  //   2. far -> silhouette   3. mid -> far   4. near -> mid
  const assignRings = (demotions) => {
    const scale = demotions >= 1 ? 0.6 : 1;
    const used = { near: 0, mid: 0, far: 0, silhouette: 0 };
    for (const entry of ordered) {
      let ring = 'silhouette';
      for (const name of ['near', 'mid', 'far']) {
        const room = Math.max(1, Math.floor(rings[name].maxBuildings * scale));
        if (entry.distance <= rings[name].radius && used[name] < room) {
          ring = name;
          used[name] += 1;
          break;
        }
      }
      let final = ring;
      if (demotions >= 2 && ring === 'far') final = 'silhouette';
      if (demotions >= 3 && ring === 'mid') final = 'far';
      if (demotions >= 4 && ring === 'near') final = 'mid';
      // An authored elevation is never clad over, whatever ring it lands in.
      if (preserve.has(entry.building?.id)) final = 'silhouette';
      entry.ring = final;
    }
  };

  const planAll = (coverageScale = 1) => {
    const signatureGrid = new Map();
    const planned = [];
    let triangles = 0;
    let resignatured = 0;
    let collisions = 0;
    let partyEdges = 0;
    for (const entry of ordered) {
      const zone = articulationZoneFor(entry.ring);
      if (wantZone && zone !== wantZone) continue;
      const baseY = typeof options.baseYFor === 'function' ? Number(options.baseYFor(entry.building)) : options.baseY;
      const edges = buildEdges(entry.polygon).filter((edge) => edge.length >= MIN_ART_EDGE);
      const limits = edgeProjectionProbe(entry.polygon, edges, neighboursOf(entry), allowance);
      for (const limit of limits.values()) if (limit < allowance) partyEdges += 1;
      // Non-repeating language: a signature already used by a building within
      // ART_NEIGHBOUR_METRES is re-drawn with a salted seed until it differs.
      const cx = Math.floor(entry.centroid.x / ART_NEIGHBOUR_METRES);
      const cz = Math.floor(entry.centroid.z / ART_NEIGHBOUR_METRES);
      const nearbySignatures = new Set();
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = signatureGrid.get(`${cx + dx}:${cz + dz}`);
          if (bucket) for (const signature of bucket) nearbySignatures.add(signature);
        }
      }
      let plan = null;
      for (let salt = 0; salt < 8; salt += 1) {
        plan = planFacadeArticulation(entry.building, {
          ring: entry.ring,
          baseY: Number.isFinite(baseY) ? baseY : 0,
          salt,
          maxProjection: allowance,
          projectionForEdge: (edgeIndex) => limits.get(edgeIndex) ?? allowance,
          uvMetres: options.uvMetres,
          coverage: entry.coverage * coverageScale,
          facing: focus,
        });
        if (plan.skipped) break;
        if (!nearbySignatures.has(plan.signature)) break;
        collisions += 1;
        if (salt === 7) break;
        resignatured += 1;
      }
      if (!plan || plan.skipped) { reject(entry.building?.id, plan?.skipped || 'plan'); continue; }
      const key = `${cx}:${cz}`;
      let bucket = signatureGrid.get(key);
      if (!bucket) { bucket = new Set(); signatureGrid.set(key, bucket); }
      bucket.add(plan.signature);
      planned.push({ entry, plan, zone });
      triangles += plan.triangles;
    }
    return { planned, triangles, resignatured, collisions, partyEdges, coverageScale };
  };

  // Degrade in two stages, and give up the screen-coverage bonus FIRST.
  //
  // The bonus is what the two or three buildings a frame is made of are
  // spending; the ring ladder is what everything else is standing on. Cutting
  // the bonus takes triangles off the elevations that have the most of them
  // and leaves the rest of the city exactly where it was, so it is both the
  // cheapest step and the one a viewer is least likely to see. Only when the
  // bonus is gone entirely does the uniform outside-in ring demotion start,
  // and that still moves whole rings, never one building out of a pair
  // standing side by side.
  const reset = () => {
    rejected.length = 0;
    for (const key of Object.keys(rejectedByReason)) delete rejectedByReason[key];
  };
  let coverageCuts = 0;
  let demotions = 0;
  assignRings(demotions);
  let attempt = planAll(1);
  while (attempt.triangles > sceneBudget && coverageCuts < COVERAGE_CUT_STEPS.length) {
    coverageCuts += 1;
    reset();
    attempt = planAll(COVERAGE_CUT_STEPS[coverageCuts - 1]);
  }
  while (attempt.triangles > sceneBudget && demotions < 4) {
    demotions += 1;
    reset();
    assignRings(demotions);
    attempt = planAll(COVERAGE_CUT_STEPS[COVERAGE_CUT_STEPS.length - 1]);
  }

  // 3. Merge. One bucket per (zone, material class, role): a whole city of
  //    articulation costs at most FACADE_ARTICULATION_BUDGET.maxDrawCalls.
  const buckets = new Map();
  const perBuilding = [];
  const ringStats = { near: { buildings: 0, triangles: 0 }, mid: { buildings: 0, triangles: 0 }, far: { buildings: 0, triangles: 0 }, silhouette: { buildings: 0, triangles: 0 } };
  const features = Object.create(null);
  const parts = Object.create(null);
  const classes = Object.create(null);
  const signatures = new Set();
  let openings = 0;
  let bands = 0;
  for (const { entry, plan, zone } of attempt.planned) {
    ringStats[plan.ring].buildings += 1;
    ringStats[plan.ring].triangles += plan.triangles;
    classes[plan.className] = (classes[plan.className] || 0) + 1;
    signatures.add(plan.signature);
    openings += plan.openings;
    bands += plan.bands;
    for (const [name, value] of Object.entries(plan.features)) features[name] = (features[name] || 0) + value;
    for (const [name, value] of Object.entries(plan.parts)) parts[name] = (parts[name] || 0) + value;
    perBuilding.push({
      id: plan.id,
      ring: plan.ring,
      detailLevel: plan.detailLevel,
      className: plan.className,
      style: plan.style,
      signature: plan.signature,
      distance: entry.distance,
      coverage: entry.coverage,
      capCoverage: plan.coverage,
      glazedStoreys: plan.glazedStoreys,
      bandedStoreys: plan.bandedStoreys,
      triangles: plan.triangles,
      triangleCap: plan.triangleCap,
      wallArea: plan.wallArea,
      edges: plan.edges,
      openings: plan.openings,
      levels: plan.levels,
      revealDepth: plan.revealDepth,
    });
    for (const quad of plan.quads) {
      const bucketClass = articulationBucketClass(quad.role, plan.className);
      const key = `${zone}|${bucketClass}|${quad.role}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, zone, className: bucketClass, role: quad.role, quads: [], buildingIds: [] };
        buckets.set(key, bucket);
      }
      bucket.quads.push(quad);
      if (bucket.buildingIds[bucket.buildingIds.length - 1] !== plan.id) bucket.buildingIds.push(plan.id);
    }
  }

  const groups = [];
  for (const key of Array.from(buckets.keys()).sort()) {
    const bucket = buckets.get(key);
    const geometry = articulationGeometryFromQuads(bucket.quads);
    if (!geometry) continue;
    groups.push({
      key,
      zone: bucket.zone,
      className: bucket.className,
      role: bucket.role,
      geometry,
      quads: bucket.quads.length,
      triangles: bucket.quads.length * 2,
      buildingIds: bucket.buildingIds.slice(),
    });
  }

  return {
    version: FACADE_ARTICULATION_VERSION,
    groups,
    drawCalls: groups.length,
    triangles: attempt.triangles,
    focus,
    zone: wantZone,
    rings: FACADE_ARTICULATION_RING_ORDER.reduce((out, name) => {
      out[name] = {
        radius: rings[name].radius,
        maxBuildings: rings[name].maxBuildings,
        triangleCap: rings[name].triangleCap,
        buildings: ringStats[name].buildings,
        triangles: ringStats[name].triangles,
      };
      return out;
    }, {}),
    buildings: perBuilding,
    articulated: perBuilding.length,
    sourceBuildings: list.length,
    rejected,
    rejectedByReason: { ...rejectedByReason },
    openings,
    bands,
    features: { ...features },
    parts: { ...parts },
    classes: { ...classes },
    signatures: {
      total: perBuilding.length,
      unique: signatures.size,
      uniqueRatio: perBuilding.length ? signatures.size / perBuilding.length : 1,
      neighbourCollisions: attempt.collisions,
      resignatured: attempt.resignatured,
    },
    partyEdges: attempt.partyEdges,
    preservedAuthored: perBuilding.filter((record) => preserve.has(record.id)).length,
    demotions,
    // How many steps of the screen-coverage bonus this frame had to give up
    // before it fit. Nonzero means the frame is spending its whole budget on
    // the elevations in front of the player; >= COVERAGE_CUT_STEPS.length means
    // the bonus is gone and the ring ladder is next.
    coverageCuts,
    sceneTriangleBudget: sceneBudget,
    maxProjection: allowance,
  };
}

/** Release every geometry a batch produced. */
export function disposeFacadeArticulation(batch) {
  if (!batch) return;
  for (const group of batch.groups || []) group.geometry?.dispose?.();
}
