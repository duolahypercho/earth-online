// Ground coverage v1 - the surface that guarantees the player cannot see
// through the world.
//
// Subsystem: Terrain/buildings/streets (src/world/). Presentation geometry
// only: it reads `city.meta.bounds`, `city.terrain.heightAt`, `city.segments`
// and `city.parks` / `city.water` exactly as they arrive and never writes back.
// It creates no renderer, no canvas, no animation loop and no scene root; it
// returns a THREE.Group the composition root adds to `city-root`.
//
// WHY THIS EXISTS (measured, not assumed)
//
//   `CityRenderer.makeGround` sizes its base plane from `city.meta.bounds`:
//
//       const width = bounds.maxX - bounds.minX + 520;
//       const geometry = new THREE.PlaneGeometry(width, depth, 96, 96);
//       ... positions[i + 1] = terrain.heightAt(x, z) - 0.22;
//
//   The sample coordinates are offset by the bounds centre, but the VERTEX
//   POSITIONS never are, and the mesh is added to `city-root` (which sits at
//   the world origin) without a position. So the plane is centred on (0, 0)
//   while the loaded San Francisco slice is centred on (1600, 400).
//
//   On the real slice the app loads - `loadSfData({ center: [1600, 400],
//   radius: 720, maxBuildings: 900 })`, bounds x 577.2 .. 2625.9,
//   z -754.7 .. 1406.9 - the base plane spans x -1284.4 .. 1284.4,
//   z -1340.8 .. 1340.8. It covers 33.5% of the map by area, and it does NOT
//   contain the slice centre or ANY of the eight quality-card camera poses.
//   Two thirds of the world has no ground under it at all: everything the
//   street ribbons and building shells do not physically cover is a hole
//   straight to the sky dome. That is what the eye-level hole detector in
//   scripts/qa/capture-quality-cards-v1.mjs has been measuring.
//
// WHAT THIS MODULE GUARANTEES
//
//   1. POSITION. Every vertex is emitted in ABSOLUTE world metres. The group
//      must be added at identity, like `street-surface-v2`. There is no
//      mesh-local offset to get wrong.
//   2. WATERTIGHTNESS BY CONSTRUCTION. The carpet is ONE rectilinear grid with
//      explicit, sorted `xs` / `zs` coordinate arrays and shared vertices. Two
//      triangles per cell, one shared diagonal, no independent sub-meshes and
//      therefore no T-junctions and no seams to close. A hole is not something
//      that has to be detected and repaired here - it cannot be expressed.
//   3. WINDING. Both triangles of every cell are wound so the geometric normal
//      is +Y. A downward-facing ground triangle is invisible from above and
//      invisible to a raycast against a front-side material, which is the same
//      defect as a hole; `verify:ground-coverage` asserts the sign on every
//      emitted triangle, not on a sample.
//   4. REACH. The fine grid covers `bounds` plus `margin`; a geometrically
//      graded apron then carries the surface out to `horizonRadius` (default
//      3600 m, inside the canonical camera's 4200 m far plane) so a ray that
//      leaves the built area near the horizon still lands on ground instead of
//      on the dome. The apron shares the fine grid's boundary vertices because
//      it is the same grid, just with wider cells at the edges.
//   5. VERTICAL SAFETY. The carpet sits `sink` metres BELOW `heightAt`, and the
//      builder measures the worst-case bilinear interpolation error of its own
//      cells against the true height field. `stats.minRoadClearance` is the
//      smallest gap between the carpet (interpolated, not just at vertices) and
//      the lowest paved surface above it - the gutter invert at
//      `heightAt + roadLift - gutterDepth`. If the grid were ever too coarse
//      for the terrain, that number goes negative and the self-check fails
//      instead of the carpet quietly poking through the road.
//
// RELATIONSHIP TO THE LEGACY BASE PLANE
//
//   The default `sink` is 0.26 m, i.e. 4 cm below the legacy plane's 0.22 m.
//   That is deliberate: if the integrator adds this carpet WITHOUT removing
//   `makeGround`'s plane, the two are not coplanar in the region where they
//   overlap, so there is no z-fighting - the legacy plane simply wins where it
//   exists and the carpet covers the other two thirds. 4 cm clears the
//   resolvable depth delta of the canonical projection (near 0.5 m, far 4200 m,
//   24-bit depth: ~11 mm at 300 m) over the whole range the ground is more than
//   a pixel tall. Removing the legacy plane is still the correct end state and
//   costs 18 432 triangles.
//
// Determinism: no Math.random, no Date.now, no iteration over unordered sets.
// The only variation is a 32-bit hash of the quantised vertex coordinate used
// for a +/-2.5% tone jitter, so two runs on the same city are bit-identical.

import * as THREE from 'three';

export const GROUND_COVERAGE_ID = 'ground-coverage-v1';

/**
 * Budget. The carpet is one draw call. The triangle cap is the auto-coarsening
 * target, not an aspiration: `resolveGroundCoverageOptions` grows the cell size
 * until the grid fits, so a bigger map costs resolution, never budget.
 */
export const GROUND_COVERAGE_BUDGET = Object.freeze({
  maxTriangles: 60000,
  maxDrawCalls: 1,
});

export const GROUND_COVERAGE_DEFAULTS = Object.freeze({
  // extent
  margin: 240,          // fine grid reach beyond city.meta.bounds, metres
  cellSize: 24,         // fine grid cell, metres (auto-coarsened to fit maxQuads)
  maxQuads: 24000,      // -> 48 000 triangles worst case, under the budget
  // Apron reach from the bounds centre.
  //
  // ROUND 2 CORRECTION. 3600 m was chosen against the canonical camera's
  // 4200 m far plane, but the two are measured from different origins: the far
  // plane is 4200 m from the CAMERA, and the camera can stand anywhere in the
  // loaded window. On the shipped slice the window half-diagonal is 1489 m, so
  // a ray leaving the far corner had only 2111 m of ground in front of it. A
  // ray that grazes the horizon - eye 2.35 m, descent 0.0005 rad - needs about
  // 4700 m to reach the carpet, so it ran out of world and hit the sky dome
  // BELOW the horizon. Measured on the eight quality-card poses, 243 of
  // 304 400 below-horizon rays escaped that way, all within 0.05 degrees of the
  // horizon, which is exactly the thin sliver of sky under the skyline that the
  // round-1 review flagged. The apron is geometric, so extending it past the
  // far plane from the worst corner of the window costs no extra quads at all -
  // only wider outermost cells.
  horizonRadius: 5900,
  apronRings: 6,        // geometric apron steps per side
  apronGrowth: 2.4,     // ring-to-ring step ratio
  // vertical
  sink: 0.26,           // metres below heightAt (legacy base plane used 0.22)
  roadLift: null,       // null -> city.meta.streetDesign.roadLift ?? 0.45
  gutterDepth: 0.04,    // matches renderer STREET_GUTTER_DEPTH
  minRoadClearance: 0.2, // required gap under the gutter invert, metres
  normalEpsilon: 1,     // central-difference step for the height-field normal
  // tone
  palette: 'sf',
  corridorMargin: 2.5,  // metres beyond the paved edge still read as corridor
  lotRadius: 46,        // beyond this, land grades from urban lot to open field
  toneJitter: 0.025,
  uvMetersPerRepeat: 8,
  // sources
  heightAt: null,       // null -> city.terrain.heightAt
  seed: null,           // null -> city.meta.seedInt
  waterPolygons: null,  // null -> city.water polygons
  parkPolygons: null,   // null -> city.parks polygons
});

const PALETTES = Object.freeze({
  sf: Object.freeze({
    corridor: '#b9b6ae', // under the carriageway: never seen, kept neutral
    lot: '#c3bcac',      // yards, alleys, service lots between walk and wall
    open: '#9fb184',     // undeveloped land at the edge of the slice
    park: '#93b878',
    water: '#5d7f8c',
  }),
  stylised: Object.freeze({
    corridor: '#6f6f6d',
    lot: '#8b8272',
    open: '#7f9a66',
    park: '#79a15f',
    water: '#3f6472',
  }),
});

// ---------------------------------------------------------------------------
// deterministic helpers
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
  const n = parseInt(text.length === 3 ? text.split('').map((c) => c + c).join('') : text, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function mixColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.z > z) !== (b.z > z)
      && x < ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToSegmentSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  let t = lenSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t;
  const qz = az + dz * t;
  return (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
}

// ---------------------------------------------------------------------------
// corridor index: nearest authoritative centreline, and how wide it is there
// ---------------------------------------------------------------------------

/**
 * Uniform XZ bucket index over `city.segments`. Presentation-only read: the
 * source points, widths and sidewalk widths are copied, never mutated.
 */
function buildCorridorIndex(city, searchRadius) {
  const cell = Math.max(24, searchRadius);
  const buckets = new Map();
  const edges = [];
  const segments = Array.isArray(city?.segments) ? city.segments : [];
  for (const segment of segments) {
    const points = Array.isArray(segment?.points) ? segment.points : [];
    const width = Number(segment?.width);
    const walkLeft = Number(segment?.sidewalkLeft ?? segment?.sidewalkW ?? 0);
    const walkRight = Number(segment?.sidewalkRight ?? segment?.sidewalkW ?? 0);
    const half = (finite(width) ? width : 7) / 2
      + Math.max(finite(walkLeft) ? walkLeft : 0, finite(walkRight) ? walkRight : 0);
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (!a || !b || !finite(a.x) || !finite(a.z) || !finite(b.x) || !finite(b.z)) continue;
      const index = edges.length;
      edges.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, half });
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minZ = Math.min(a.z, b.z);
      const maxZ = Math.max(a.z, b.z);
      for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
        for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
          const key = `${gx}:${gz}`;
          let list = buckets.get(key);
          if (!list) { list = []; buckets.set(key, list); }
          list.push(index);
        }
      }
    }
  }
  const reach = Math.ceil(searchRadius / cell);
  return {
    edges,
    /**
     * @returns {{ distance: number, half: number }} distance to the nearest
     * centreline within `searchRadius` (Infinity past that) and the paved half
     * width of that centreline.
     */
    query(x, z) {
      let bestSq = Infinity;
      let bestHalf = 0;
      const gx0 = Math.floor(x / cell);
      const gz0 = Math.floor(z / cell);
      for (let gz = gz0 - reach; gz <= gz0 + reach; gz += 1) {
        for (let gx = gx0 - reach; gx <= gx0 + reach; gx += 1) {
          const list = buckets.get(`${gx}:${gz}`);
          if (!list) continue;
          for (const index of list) {
            const e = edges[index];
            const dSq = distanceToSegmentSq(x, z, e.ax, e.az, e.bx, e.bz);
            if (dSq < bestSq) { bestSq = dSq; bestHalf = e.half; }
          }
        }
      }
      return { distance: bestSq === Infinity ? Infinity : Math.sqrt(bestSq), half: bestHalf };
    },
  };
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/**
 * Resolve options against the city. Also decides the final `cellSize`: the fine
 * grid is coarsened until the whole grid fits `maxQuads`, so the triangle
 * budget is a hard ceiling rather than a hope.
 *
 * @param {object} city
 * @param {Partial<typeof GROUND_COVERAGE_DEFAULTS>} [overrides]
 */
export function resolveGroundCoverageOptions(city, overrides = {}) {
  const o = { ...GROUND_COVERAGE_DEFAULTS, ...overrides };
  const raw = city?.meta?.bounds || {};
  const bounds = {
    minX: finite(raw.minX) ? raw.minX : -400,
    maxX: finite(raw.maxX) ? raw.maxX : 400,
    minZ: finite(raw.minZ) ? raw.minZ : -400,
    maxZ: finite(raw.maxZ) ? raw.maxZ : 400,
  };
  if (bounds.maxX <= bounds.minX) bounds.maxX = bounds.minX + 1;
  if (bounds.maxZ <= bounds.minZ) bounds.maxZ = bounds.minZ + 1;

  const margin = Math.max(0, Number(o.margin) || 0);
  const core = {
    minX: bounds.minX - margin,
    maxX: bounds.maxX + margin,
    minZ: bounds.minZ - margin,
    maxZ: bounds.maxZ + margin,
  };
  const apronRings = Math.max(0, Math.round(Number(o.apronRings) || 0));
  const maxQuads = Math.max(64, Math.round(Number(o.maxQuads) || 1));

  // Coarsen until the grid (fine cells + apron rings on all four sides) fits.
  let cellSize = Math.max(1, Number(o.cellSize) || 24);
  for (let guard = 0; guard < 64; guard += 1) {
    const nx = Math.ceil((core.maxX - core.minX) / cellSize) + 1 + apronRings * 2;
    const nz = Math.ceil((core.maxZ - core.minZ) / cellSize) + 1 + apronRings * 2;
    if ((nx - 1) * (nz - 1) <= maxQuads) break;
    cellSize *= 1.25;
  }

  const heightAt = typeof o.heightAt === 'function'
    ? o.heightAt
    : (typeof city?.terrain?.heightAt === 'function' ? city.terrain.heightAt : null);
  // `Number(null)` is 0 and 0 is finite, so an explicit null test is required
  // here: falling through would silently zero the road datum and make the
  // clearance stat meaningless.
  const roadLift = o.roadLift == null || !finite(Number(o.roadLift))
    ? Number(city?.meta?.streetDesign?.roadLift ?? 0.45)
    : Number(o.roadLift);

  return {
    ...o,
    bounds,
    core,
    margin,
    cellSize,
    apronRings,
    apronGrowth: Math.max(1.05, Number(o.apronGrowth) || 2.4),
    horizonRadius: Math.max(0, Number(o.horizonRadius) || 0),
    sink: Number(o.sink) || 0,
    roadLift: finite(roadLift) ? roadLift : 0.45,
    gutterDepth: Number(o.gutterDepth) || 0,
    heightAt,
    seed: finite(Number(o.seed)) ? Number(o.seed) : Number(city?.meta?.seedInt ?? 1),
    palette: PALETTES[o.palette] ? o.palette : 'sf',
    waterPolygons: Array.isArray(o.waterPolygons)
      ? o.waterPolygons
      : (city?.water || []).map((w) => w?.polygon).filter((p) => Array.isArray(p) && p.length > 2),
    parkPolygons: Array.isArray(o.parkPolygons)
      ? o.parkPolygons
      : (city?.parks || []).map((p) => p?.polygon).filter((p) => Array.isArray(p) && p.length > 2),
  };
}

/**
 * Build one axis of the rectilinear grid: uniform fine steps across
 * [min, max], then `rings` geometrically growing steps outward on each side up
 * to `reach` metres. Returns a strictly increasing array.
 */
function buildAxis(min, max, cellSize, reach, rings, growth) {
  const inner = [];
  const count = Math.max(1, Math.ceil((max - min) / cellSize));
  const step = (max - min) / count;
  for (let i = 0; i <= count; i += 1) inner.push(min + step * i);
  inner[count] = max;
  if (rings <= 0 || reach <= 0) return inner;
  // Geometric partial sums normalised so the last ring lands exactly on reach.
  const fractions = [];
  let total = 0;
  let term = 1;
  for (let i = 0; i < rings; i += 1) { total += term; term *= growth; }
  let acc = 0;
  term = 1;
  for (let i = 0; i < rings; i += 1) {
    acc += term;
    term *= growth;
    fractions.push(acc / total);
  }
  const low = fractions.map((f) => min - reach * f).reverse();
  const high = fractions.map((f) => max + reach * f);
  return [...low, ...inner, ...high];
}

// ---------------------------------------------------------------------------
// data build (plain arrays - no THREE, so the geometry is node-testable)
// ---------------------------------------------------------------------------

/**
 * Build the ground carpet as plain arrays in ABSOLUTE world metres.
 *
 * @param {object} city  needs `meta.bounds`; uses `terrain.heightAt`,
 *                       `meta.streetDesign.roadLift`, `segments`, `parks`,
 *                       `water` when present. Never mutated.
 * @param {Partial<typeof GROUND_COVERAGE_DEFAULTS>} [overrides]
 * @returns {{
 *   id: string,
 *   grid: { xs: number[], zs: number[] },
 *   positions: number[], normals: number[], colors: number[], uvs: number[],
 *   indices: number[],
 *   stats: object, options: object
 * }} `colors` are sRGB 0..1; `buildGroundCoverage` converts them to linear.
 */
export function buildGroundCoverageData(city, overrides = {}) {
  const o = resolveGroundCoverageOptions(city, overrides);
  const palette = PALETTES[o.palette];
  const corridorTone = hexToSrgb(palette.corridor);
  const lotTone = hexToSrgb(palette.lot);
  const openTone = hexToSrgb(palette.open);
  const parkTone = hexToSrgb(palette.park);
  const waterTone = hexToSrgb(palette.water);

  const centreX = (o.core.minX + o.core.maxX) / 2;
  const centreZ = (o.core.minZ + o.core.maxZ) / 2;
  const coreHalf = Math.max(
    (o.core.maxX - o.core.minX) / 2,
    (o.core.maxZ - o.core.minZ) / 2,
  );
  const reach = Math.max(0, o.horizonRadius - coreHalf);

  const xs = buildAxis(o.core.minX, o.core.maxX, o.cellSize, reach, o.apronRings, o.apronGrowth);
  const zs = buildAxis(o.core.minZ, o.core.maxZ, o.cellSize, reach, o.apronRings, o.apronGrowth);
  const nx = xs.length;
  const nz = zs.length;

  const height = (x, z) => {
    if (!o.heightAt) return 0;
    const value = Number(o.heightAt(x, z));
    return finite(value) ? value : 0;
  };
  const surface = (x, z) => height(x, z) - o.sink;

  const corridor = buildCorridorIndex(city, o.lotRadius);

  const positions = new Array(nx * nz * 3);
  const normals = new Array(nx * nz * 3);
  const colors = new Array(nx * nz * 3);
  const uvs = new Array(nx * nz * 2);
  const trueHeights = new Array(nx * nz);
  const eps = Math.max(0.05, Number(o.normalEpsilon) || 1);
  const repeat = Math.max(0.001, Number(o.uvMetersPerRepeat) || 1);
  let nonFinite = 0;

  for (let j = 0; j < nz; j += 1) {
    const z = zs[j];
    for (let i = 0; i < nx; i += 1) {
      const x = xs[i];
      const k = j * nx + i;
      const h = height(x, z);
      const y = h - o.sink;
      trueHeights[k] = h;
      positions[k * 3] = x;
      positions[k * 3 + 1] = y;
      positions[k * 3 + 2] = z;
      if (!finite(x) || !finite(y) || !finite(z)) nonFinite += 1;

      // Height-field normal by central difference. Sampling the field rather
      // than the mesh keeps the shading identical at every resolution.
      const dhdx = (height(x + eps, z) - height(x - eps, z)) / (2 * eps);
      const dhdz = (height(x, z + eps) - height(x, z - eps)) / (2 * eps);
      const len = Math.hypot(-dhdx, 1, -dhdz) || 1;
      normals[k * 3] = -dhdx / len;
      normals[k * 3 + 1] = 1 / len;
      normals[k * 3 + 2] = -dhdz / len;

      uvs[k * 2] = x / repeat;
      uvs[k * 2 + 1] = z / repeat;

      // Tone by context. Under the carriageway nothing is ever seen, so the
      // interesting range is the strip between the back of the walk and the
      // building line (urban lot) grading out to open land at the map edge.
      const near = corridor.query(x, z);
      const outside = near.distance - (near.half + o.corridorMargin);
      let tone;
      if (!finite(outside) || outside >= o.lotRadius) {
        tone = openTone;
      } else if (outside <= 0) {
        tone = corridorTone;
      } else {
        tone = mixColor(lotTone, openTone, clamp(outside / o.lotRadius, 0, 1));
      }
      for (const polygon of o.parkPolygons) {
        if (pointInPolygon(x, z, polygon)) { tone = parkTone; break; }
      }
      for (const polygon of o.waterPolygons) {
        if (pointInPolygon(x, z, polygon)) { tone = waterTone; break; }
      }
      const jitter = 1 + ((hash32(`${o.seed}:${Math.round(x)}:${Math.round(z)}`) % 1000) / 1000 - 0.5)
        * 2 * o.toneJitter;
      colors[k * 3] = clamp(tone[0] * jitter, 0, 1);
      colors[k * 3 + 1] = clamp(tone[1] * jitter, 0, 1);
      colors[k * 3 + 2] = clamp(tone[2] * jitter, 0, 1);
    }
  }

  // Two triangles per cell, sharing the v01-v10 diagonal. Both are wound so
  // (b - a) x (c - a) points at +Y: see the WINDING note at the top.
  const indices = new Array((nx - 1) * (nz - 1) * 6);
  let w = 0;
  for (let j = 0; j < nz - 1; j += 1) {
    for (let i = 0; i < nx - 1; i += 1) {
      const v00 = j * nx + i;
      const v10 = v00 + 1;
      const v01 = v00 + nx;
      const v11 = v01 + 1;
      indices[w] = v00; indices[w + 1] = v01; indices[w + 2] = v10;
      indices[w + 3] = v10; indices[w + 4] = v01; indices[w + 5] = v11;
      w += 6;
    }
  }

  // Vertical safety. The lowest paved surface above the carpet is the gutter
  // invert at heightAt + roadLift - gutterDepth. Check the carpet where it is
  // highest relative to the true field: at its vertices AND at cell centres,
  // where the bilinear surface can sit above the terrain it is approximating.
  // The constraint is only real where pavement can exist, so the scan is
  // limited to points with a centreline inside `lotRadius`. The apron cells are
  // kilometres wide and kilometres from any road; measuring them would report a
  // "clearance failure" against a road that is not there.
  const invertLift = o.roadLift - o.gutterDepth;
  let minRoadClearance = Infinity;
  let maxInterpolationError = 0;
  let maxCoreInterpolationError = 0;
  let worstClearanceAt = null;
  let clearanceSamples = 0;
  const nearRoad = (x, z) => corridor.query(x, z).distance < o.lotRadius;
  const consider = (x, z, carpetY) => {
    if (!nearRoad(x, z)) return;
    clearanceSamples += 1;
    const clearance = (height(x, z) + invertLift) - carpetY;
    if (clearance < minRoadClearance) {
      minRoadClearance = clearance;
      worstClearanceAt = { x: +x.toFixed(2), z: +z.toFixed(2), clearance: +clearance.toFixed(4) };
    }
  };
  const inCore = (x, z) => x >= o.core.minX && x <= o.core.maxX
    && z >= o.core.minZ && z <= o.core.maxZ;
  for (let j = 0; j < nz; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const k = j * nx + i;
      consider(xs[i], zs[j], positions[k * 3 + 1]);
    }
  }
  for (let j = 0; j < nz - 1; j += 1) {
    for (let i = 0; i < nx - 1; i += 1) {
      const x = (xs[i] + xs[i + 1]) / 2;
      const z = (zs[j] + zs[j + 1]) / 2;
      const k = j * nx + i;
      // Cell centre lies on the shared diagonal, so both triangles agree:
      // it is the mean of the two diagonal endpoints.
      const interpolated = (positions[(k + 1) * 3 + 1] + positions[(k + nx) * 3 + 1]) / 2;
      const error = Math.abs(interpolated - (height(x, z) - o.sink));
      if (error > maxInterpolationError) maxInterpolationError = error;
      if (inCore(x, z) && error > maxCoreInterpolationError) maxCoreInterpolationError = error;
      consider(x, z, interpolated);
    }
  }
  if (!clearanceSamples) minRoadClearance = invertLift + o.sink;

  const triangles = (nx - 1) * (nz - 1) * 2;
  const stats = {
    id: GROUND_COVERAGE_ID,
    vertices: nx * nz,
    quads: (nx - 1) * (nz - 1),
    triangles,
    gridX: nx,
    gridZ: nz,
    cellSize: +o.cellSize.toFixed(4),
    apronRings: o.apronRings,
    apronReach: +reach.toFixed(2),
    centre: { x: +centreX.toFixed(3), z: +centreZ.toFixed(3) },
    extent: {
      minX: xs[0], maxX: xs[nx - 1], minZ: zs[0], maxZ: zs[nz - 1],
    },
    sourceBounds: { ...o.bounds },
    sink: o.sink,
    roadLift: o.roadLift,
    gutterDepth: o.gutterDepth,
    minRoadClearance: +minRoadClearance.toFixed(4),
    clearanceSamples,
    worstClearanceAt,
    maxInterpolationError: +maxInterpolationError.toFixed(4),
    maxCoreInterpolationError: +maxCoreInterpolationError.toFixed(4),
    nonFinite,
    budget: {
      ...GROUND_COVERAGE_BUDGET,
      withinTriangles: triangles <= GROUND_COVERAGE_BUDGET.maxTriangles,
    },
  };

  return {
    id: GROUND_COVERAGE_ID,
    grid: { xs, zs },
    positions,
    normals,
    colors,
    uvs,
    indices,
    stats,
    options: o,
  };
}

/**
 * Point query against a built carpet. Binary-searches the rectilinear grid, so
 * it is O(log n) and needs no THREE and no raycaster.
 *
 * @returns {{ covered: boolean, y: number|null, cell: {i:number,j:number}|null }}
 */
export function sampleGroundCoverage(data, x, z) {
  const xs = data?.grid?.xs;
  const zs = data?.grid?.zs;
  if (!xs || !zs || !finite(x) || !finite(z)) return { covered: false, y: null, cell: null };
  if (x < xs[0] || x > xs[xs.length - 1] || z < zs[0] || z > zs[zs.length - 1]) {
    return { covered: false, y: null, cell: null };
  }
  const locate = (values, value) => {
    let lo = 0;
    let hi = values.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (values[mid] <= value) lo = mid; else hi = mid;
    }
    return lo;
  };
  const i = locate(xs, x);
  const j = locate(zs, z);
  const nx = xs.length;
  const x0 = xs[i];
  const x1 = xs[i + 1];
  const z0 = zs[j];
  const z1 = zs[j + 1];
  const u = (x - x0) / ((x1 - x0) || 1);
  const v = (z - z0) / ((z1 - z0) || 1);
  const y = (k) => data.positions[k * 3 + 1];
  const v00 = j * nx + i;
  const v10 = v00 + 1;
  const v01 = v00 + nx;
  const v11 = v01 + 1;
  // Diagonal runs v01 -> v10, i.e. u + v = 1.
  const height = (u + v <= 1)
    ? y(v00) + (y(v10) - y(v00)) * u + (y(v01) - y(v00)) * v
    : y(v11) + (y(v01) - y(v11)) * (1 - u) + (y(v10) - y(v11)) * (1 - v);
  return { covered: true, y: height, cell: { i, j } };
}

// ---------------------------------------------------------------------------
// THREE build
// ---------------------------------------------------------------------------

/**
 * Build the THREE objects. Stock `MeshStandardMaterial` only - no
 * ShaderMaterial, no onBeforeCompile, no node/TSL material - so this runs
 * unchanged on the WebGPURenderer's WebGL2 fallback path. One mesh, one draw
 * call, vertices in absolute world metres: ADD THE GROUP AT IDENTITY.
 *
 * @param {object} city
 * @param {Partial<typeof GROUND_COVERAGE_DEFAULTS> & { maps?: { ground?: any } }} [overrides]
 * @returns {{ id, group, mesh, geometry, material, data, stats, drawCalls }}
 */
export function buildGroundCoverage(city, overrides = {}) {
  const data = buildGroundCoverageData(city, overrides);
  const map = overrides.maps?.ground || null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors.map(srgbToLinear), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
  geometry.setIndex(data.indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  geometry.name = `${GROUND_COVERAGE_ID}:carpet`;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map,
    bumpMap: map,
    bumpScale: map ? 0.02 : 1,
    roughness: 1,
    metalness: 0,
  });
  material.name = `${GROUND_COVERAGE_ID}:material`;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = GROUND_COVERAGE_ID;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  // Ground is the backstop every other surface sits on: it must draw before
  // anything that relies on depth against it, and it must never be the thing
  // that wins a coplanar fight with the road.
  mesh.renderOrder = -1;
  mesh.userData = { kind: 'ground', source: GROUND_COVERAGE_ID };

  const group = new THREE.Group();
  group.name = GROUND_COVERAGE_ID;
  group.userData = { kind: 'ground-coverage', version: 1 };
  group.add(mesh);

  return {
    id: GROUND_COVERAGE_ID,
    group,
    mesh,
    geometry,
    material,
    data,
    stats: data.stats,
    drawCalls: 1,
  };
}

/** Release everything buildGroundCoverage allocated. */
export function disposeGroundCoverage(result) {
  if (!result) return;
  result.geometry?.dispose?.();
  result.material?.dispose?.();
  result.group?.clear?.();
}
