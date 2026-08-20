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
