// Procedural surface detail maps (normal / roughness / AO) for the canonical
// city renderer.
//
// Why this module exists
// ----------------------
// The renderer builds dozens of MeshStandardMaterial instances with no
// normalMap, no aoMap and no roughnessMap. A PBR material whose only spatial
// input is a flat albedo texture cannot produce high-frequency specular
// response, so surfaces read as painted card. This module supplies tiling
// tangent-space normal + ORM (AO / roughness / metalness) maps that are
// generated once per (class, seed, resolution) and shared by every mesh.
//
// It moves these rubric dimensions in Docs/VISUAL_QUALITY_GATE.md:
//   - "Architecture and materials" (high-frequency detail, plausible PBR and
//     weathering)
//   - "Street and road realism" (asphalt / sidewalk surface response)
//   - "Lighting and atmosphere" (materials that actually respond to the sun)
//
// Design constraints honoured here
// --------------------------------
//   * No renderer, canvas element, RAF loop or scene root is created.
//   * No ShaderMaterial and no onBeforeCompile: everything is stock texture
//     slots on stock three.js materials, so the WebGL2 fallback path works.
//   * Every height / roughness / AO field is a PURE seeded function with no
//     canvas and no DOM, so it is assertable from plain node.
//   * Every field is exactly periodic in u and v, so the textures tile with no
//     seam. `sampleSurfaceField(c, 0, v) === sampleSurfaceField(c, 1, v)` holds
//     bit-for-bit.
//   * No Math.random(), no Date.now().
//
// Colour space: normal, roughness, AO and metalness are DATA, never colour.
// Every texture produced here is THREE.NoColorSpace. Never assign one of these
// to `material.map` or `material.emissiveMap`.

import * as THREE from 'three';

export const DETAIL_MAPS_VERSION = 'detail-maps-v1';

// ---------------------------------------------------------------------------
// Pure numeric core: integer hashing, periodic value noise, fbm.
// All of this is deterministic 32-bit integer arithmetic, so the same seed
// yields the same field on any platform and in any JS engine.
// ---------------------------------------------------------------------------

const UINT32 = 4294967296;

export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function mix(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function imod(n, m) {
  const r = n % m;
  return r < 0 ? r + m : r;
}

/** Deterministic 32-bit integer avalanche. */
function hashInt(x) {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Stable string -> uint32, so a caller may seed by name. */
export function hashSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return hashInt(Math.trunc(value));
  const text = String(value ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return hashInt(h);
}

/** Lattice hash in [0,1). Integer inputs only. */
function hash2(ix, iy, seed) {
  let h = hashInt(ix + 0x9e3779b9);
  h = hashInt((h ^ (iy | 0)) + 0x85ebca6b);
  h = hashInt((h ^ (seed | 0)) + 0xc2b2ae35);
  return h / UINT32;
}

/**
 * Lattice memo.
 *
 * Baking a 512x512 tile evaluates the lattice hash millions of times, and a
 * period-p lattice only has p*p distinct values. Caching them turns generation
 * of the whole class set from seconds into a fraction of a second. Float64
 * storage keeps the cached value bit-identical to the uncached hash, so the
 * memo cannot change any output.
 */
const latticeCache = new Map();
const LATTICE_CACHE_LIMIT = 128;

function latticeTable(px, py, seed) {
  const key = `${px}|${py}|${seed}`;
  const cached = latticeCache.get(key);
  if (cached) return cached;
  const table = new Float64Array(px * py);
  for (let y = 0; y < py; y += 1) {
    const row = y * px;
    for (let x = 0; x < px; x += 1) table[row + x] = hash2(x, y, seed);
  }
  if (latticeCache.size >= LATTICE_CACHE_LIMIT) latticeCache.clear();
  latticeCache.set(key, table);
  return table;
}

/** Free the lattice memo. Generation still works, just slower. */
export function clearNoiseLatticeCache() {
  latticeCache.clear();
}

function latticeNoise(x, y, px, py, table) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const x0 = imod(ix, px);
  const x1 = x0 + 1 === px ? 0 : x0 + 1;
  const y0 = imod(iy, py) * px;
  const y1 = y0 + px === px * py ? 0 : y0 + px;
  const n00 = table[y0 + x0];
  const n10 = table[y0 + x1];
  const n01 = table[y1 + x0];
  const n11 = table[y1 + x1];
  return mix(mix(n00, n10, fx), mix(n01, n11, fx), fy);
}

/**
 * Value noise on a periodic integer lattice.
 * `px` / `py` MUST be positive integers; the noise then repeats exactly every
 * `px` units in x and `py` units in y, which is what makes the textures tile.
 */
export function periodicValueNoise(x, y, px, py, seed) {
  return latticeNoise(x, y, px, py, latticeTable(px, py, seed | 0));
}

/**
 * Fractal Brownian motion built from periodic value noise.
 * `u` / `v` are normalized tile coordinates; the result repeats exactly with
 * period 1 in both axes.
 */
export function periodicFbm(u, v, options = {}) {
  const {
    periodX = 4,
    periodY = 4,
    octaves = 4,
    gain = 0.5,
    lacunarity = 2,
    seed = 0,
  } = options;
  let amplitude = 1;
  let total = 0;
  let norm = 0;
  let px = Math.max(1, Math.round(periodX));
  let py = Math.max(1, Math.round(periodY));
  for (let o = 0; o < octaves; o += 1) {
    const table = latticeTable(px, py, (seed + o * 1013) | 0);
    total += amplitude * latticeNoise(u * px, v * py, px, py, table);
    norm += amplitude;
    amplitude *= gain;
    px = Math.max(1, Math.round(px * lacunarity));
    py = Math.max(1, Math.round(py * lacunarity));
  }
  return norm > 0 ? total / norm : 0;
}

/** Turbulence: fbm folded around 0.5, useful for cracks and corrosion edges. */
export function periodicTurbulence(u, v, options = {}) {
  const {
    periodX = 4,
    periodY = 4,
    octaves = 4,
    gain = 0.5,
    lacunarity = 2,
    seed = 0,
  } = options;
  let amplitude = 1;
  let total = 0;
  let norm = 0;
  let px = Math.max(1, Math.round(periodX));
  let py = Math.max(1, Math.round(periodY));
  for (let o = 0; o < octaves; o += 1) {
    const table = latticeTable(px, py, (seed + o * 7919) | 0);
    const n = latticeNoise(u * px, v * py, px, py, table);
    total += amplitude * Math.abs(n * 2 - 1);
    norm += amplitude;
    amplitude *= gain;
    px = Math.max(1, Math.round(px * lacunarity));
    py = Math.max(1, Math.round(py * lacunarity));
  }
  return norm > 0 ? total / norm : 0;
}

/**
 * Distance (in normalized tile units) from `t` to the nearest of `count`
 * evenly spaced lines at 0, 1/count, 2/count ... The wrap at t=1 is handled,
 * so a line sitting exactly on the tile seam stays continuous.
 */
export function periodicLineDistance(t, count) {
  const n = Math.max(1, Math.round(count));
  const scaled = t * n;
  const frac = scaled - Math.floor(scaled);
  return Math.min(frac, 1 - frac) / n;
}

// ---------------------------------------------------------------------------
// Surface class registry.
//
// `metresPerRepeat` is the real-world size of one texture tile. The world is
// 1 unit = 1 metre, so a wall 12 m wide using the brick class needs
// texture.repeat.x = 12 / 2.4 = 5. Use `repeatForSurface()` or, preferably,
// bake the UVs in metres and multiply by `uvScalePerMetre()`.
//
// `heightScaleMetres` is the peak-to-peak physical relief the whole 0..1 field
// stands for. It converts the unitless field into a real slope when the
// tangent-space normal is encoded, so relief reads the same at 256 or 1024.
//
// `normalExaggeration` is a deliberate, documented amplification of that slope.
// A 512-texel tile cannot resolve a 4 mm stucco bump or a 6 mm asphalt stone:
// the true feature gets smeared over several texels, and the physically exact
// slope encodes as almost flat. Every class is therefore amplified to the
// slope the real material shows at arm's length. It is baked into the encoded
// normal; `bundle.normalScale` stays at 1 so the integrator still has a clean
// per-material dial.
// ---------------------------------------------------------------------------

const SURFACE_DEFS = Object.freeze({
  brick: Object.freeze({
    className: 'brick',
    label: 'fired brick, running bond, raked mortar',
    metresPerRepeat: Object.freeze({ x: 2.4, y: 2.4 }),
    heightScaleMetres: 0.014,
    normalExaggeration: 1,
    defaultResolution: 512,
    // Course = 75 mm, brick = 240 mm; both divide the 2.4 m tile exactly.
    courses: 32,
    bricksPerCourse: 10,
  }),
  stucco: Object.freeze({
    className: 'stucco',
    label: 'troweled stucco / lime plaster',
    metresPerRepeat: Object.freeze({ x: 1.2, y: 1.2 }),
    heightScaleMetres: 0.004,
    normalExaggeration: 4,
    defaultResolution: 512,
  }),
  'painted-concrete': Object.freeze({
    className: 'painted-concrete',
    label: 'painted cast concrete with form joints and tie holes',
    metresPerRepeat: Object.freeze({ x: 1.8, y: 1.8 }),
    heightScaleMetres: 0.005,
    normalExaggeration: 4,
    defaultResolution: 512,
    jointsPerTile: 1,
    tieHolesPerTile: 2,
  }),
  'glass-curtain': Object.freeze({
    className: 'glass-curtain',
    label: 'glass curtain wall, aluminium mullion grid',
    metresPerRepeat: Object.freeze({ x: 3.6, y: 3.6 }),
    heightScaleMetres: 0.055,
    normalExaggeration: 1,
    defaultResolution: 512,
    panesPerTile: 3,
  }),
  asphalt: Object.freeze({
    className: 'asphalt',
    label: 'hot-mix asphalt wearing course',
    metresPerRepeat: Object.freeze({ x: 1.5, y: 1.5 }),
    heightScaleMetres: 0.006,
    normalExaggeration: 3,
    defaultResolution: 512,
  }),
  'sidewalk-concrete': Object.freeze({
    className: 'sidewalk-concrete',
    label: 'broom-finished sidewalk concrete with score lines',
    metresPerRepeat: Object.freeze({ x: 3.0, y: 3.0 }),
    heightScaleMetres: 0.012,
    normalExaggeration: 3,
    defaultResolution: 512,
    scoreLinesPerTile: 2,
  }),
  'dirty-metal': Object.freeze({
    className: 'dirty-metal',
    label: 'weathered brushed metal with corrosion patches',
    metresPerRepeat: Object.freeze({ x: 0.8, y: 0.8 }),
    heightScaleMetres: 0.003,
    normalExaggeration: 3,
    defaultResolution: 512,
  }),
});

export const SURFACE_CLASSES = Object.freeze(Object.keys(SURFACE_DEFS));

export function listSurfaceClasses() {
  return SURFACE_CLASSES.slice();
}

export function getSurfaceDef(className) {
  const def = SURFACE_DEFS[className];
  if (!def) {
    throw new Error(
      `[detail-maps] unknown surface class "${className}". Known: ${SURFACE_CLASSES.join(', ')}`,
    );
  }
  return def;
}

/** Per-class seed mix, so one seed produces uncorrelated classes. */
function classSeed(className, seed) {
  return hashInt(hashSeed(seed) ^ hashSeed(`detail:${className}`)) | 0;
}

// ---------------------------------------------------------------------------
// Compiled noise programs.
//
// A sampler is called once per texel - 262144 times for one 512 tile - so the
// per-call work has to be array indexing, not option parsing or map lookups.
// Every fbm a class needs is therefore compiled once per (class, seed) into a
// flat program of lattice tables, then evaluated per texel. The arithmetic is
// identical to periodicFbm(); only the bookkeeping moves out of the loop.
// ---------------------------------------------------------------------------

const FBM_STRIDE = 1013;
const TURBULENCE_STRIDE = 7919;

function compileNoise(options, seedStride) {
  const {
    periodX = 4, periodY = 4, octaves = 4, gain = 0.5, lacunarity = 2, seed = 0,
  } = options;
  const tables = [];
  const pxs = [];
  const pys = [];
  const amps = [];
  let amplitude = 1;
  let norm = 0;
  let px = Math.max(1, Math.round(periodX));
  let py = Math.max(1, Math.round(periodY));
  for (let o = 0; o < octaves; o += 1) {
    tables.push(latticeTable(px, py, (seed + o * seedStride) | 0));
    pxs.push(px);
    pys.push(py);
    amps.push(amplitude);
    norm += amplitude;
    amplitude *= gain;
    px = Math.max(1, Math.round(px * lacunarity));
    py = Math.max(1, Math.round(py * lacunarity));
  }
  return { tables, pxs, pys, amps, norm, count: octaves };
}

function evalFbm(program, u, v) {
  let total = 0;
  for (let o = 0; o < program.count; o += 1) {
    const px = program.pxs[o];
    const py = program.pys[o];
    total += program.amps[o] * latticeNoise(u * px, v * py, px, py, program.tables[o]);
  }
  return program.norm > 0 ? total / program.norm : 0;
}

function evalTurbulence(program, u, v) {
  let total = 0;
  for (let o = 0; o < program.count; o += 1) {
    const px = program.pxs[o];
    const py = program.pys[o];
    const n = latticeNoise(u * px, v * py, px, py, program.tables[o]);
    total += program.amps[o] * Math.abs(n * 2 - 1);
  }
  return program.norm > 0 ? total / program.norm : 0;
}

function fbmProgram(periodX, periodY, octaves, seed, gain = 0.5) {
  return compileNoise({ periodX, periodY, octaves, gain, seed }, FBM_STRIDE);
}

function turbulenceProgram(periodX, periodY, octaves, seed) {
  return compileNoise({ periodX, periodY, octaves, seed }, TURBULENCE_STRIDE);
}

/**
 * High-frequency micro relief program.
 *
 * The mid-frequency fbm terms carry the look of a material, but at 512 texels
 * across a 1-3 m tile they produce almost no per-texel slope, so the encoded
 * normal stays near flat and the surface still reads as painted card. This
 * term deliberately lives at 1/64 and 1/128 of the tile - roughly 4 and 2
 * texels at the default resolution - which is the finest detail that survives
 * mipmapping without shimmering.
 */
function microProgram(seed, periodX = 64, periodY = 64) {
  return compileNoise({
    periodX, periodY, octaves: 2, gain: 0.7, seed: seed + 613,
  }, FBM_STRIDE);
}

/** Signed micro relief in [-1, 1]. */
function microRelief(program, u, v) {
  return evalFbm(program, u, v) * 2 - 1;
}

// ---------------------------------------------------------------------------
// Per-class field samplers.
//
// Each writes { height, roughness, ao, metalness } into `out`, all in [0,1].
// Each is exactly periodic with period 1 in u and in v: every noise call goes
// through the periodic lattice, and every pattern index is taken modulo an
// integer count that divides the tile, so u=0 and u=1 evaluate bit-identically.
// ---------------------------------------------------------------------------

function prepareBrick(seed) {
  return {
    grain: fbmProgram(32, 32, 3, seed + 101),
    mortarGrain: fbmProgram(24, 24, 2, seed + 211),
    micro: microProgram(seed),
  };
}

function sampleBrick(out, u, v, ctx) {
  const { def, seed, p } = ctx;
  const courses = def.courses;
  const bricks = def.bricksPerCourse;

  const rowScaled = v * courses;
  const row = Math.floor(rowScaled);
  const rowFrac = rowScaled - row;
  const rowIndex = imod(row, courses);

  // Running bond: every other course shifts by half a brick.
  const offset = (rowIndex % 2) * 0.5;
  const colScaled = u * bricks + offset;
  const col = Math.floor(colScaled);
  const colFrac = colScaled - col;
  const colIndex = imod(col, bricks);

  const jointV = 0.15;
  const jointU = 0.055;
  const faceV = smoothstep(0, jointV, rowFrac) * smoothstep(0, jointV, 1 - rowFrac);
  const faceU = smoothstep(0, jointU, colFrac) * smoothstep(0, jointU, 1 - colFrac);
  const face = Math.min(faceV, faceU);

  const perBrick = hash2(colIndex, rowIndex, seed);
  const perBrickTone = hash2(colIndex, rowIndex, seed + 7717);
  const grain = evalFbm(p.grain, u, v);
  const mortarGrain = evalFbm(p.mortarGrain, u, v);
  const micro = microRelief(p.micro, u, v);

  const brickFace = 0.70 + 0.13 * perBrick + 0.08 * (grain - 0.5);
  const mortar = 0.16 + 0.10 * mortarGrain;

  out.height = clamp01(mix(mortar, brickFace, face) + 0.055 * micro);
  out.roughness = clamp01(
    mix(0.95, 0.74 + 0.14 * perBrickTone + 0.05 * (grain - 0.5), face) + 0.03 * micro,
  );
  out.ao = clamp01(mix(0.40, 0.96 + 0.04 * perBrick, face));
  out.metalness = 0;
}

function prepareStucco(seed) {
  return {
    coarse: fbmProgram(6, 6, 4, seed),
    fine: fbmProgram(32, 32, 2, seed + 91),
    trowel: fbmProgram(3, 9, 2, seed + 17),
    pit: turbulenceProgram(40, 40, 2, seed + 313),
    micro: microProgram(seed),
  };
}

function sampleStucco(out, u, v, ctx) {
  const { p } = ctx;
  const coarse = evalFbm(p.coarse, u, v);
  const fine = evalFbm(p.fine, u, v);
  const trowel = evalFbm(p.trowel, u, v);
  const pit = smoothstep(0.84, 0.97, evalTurbulence(p.pit, u, v));
  const micro = microRelief(p.micro, u, v);

  const h = 0.56 + 0.20 * (fine - 0.5) + 0.16 * (coarse - 0.5) + 0.08 * (trowel - 0.5)
    + 0.085 * micro - 0.30 * pit;
  out.height = clamp01(h);
  out.roughness = clamp01(
    0.88 + 0.10 * (fine - 0.5) - 0.08 * (coarse - 0.5) + 0.04 * micro + 0.06 * pit,
  );
  out.ao = clamp01(0.94 + 0.10 * (h - 0.56) - 0.45 * pit);
  out.metalness = 0;
}

function preparePaintedConcrete(seed) {
  return {
    mottle: fbmProgram(3, 3, 4, seed),
    grain: fbmProgram(48, 48, 2, seed + 53),
    // Rain runoff: features stretched along v (few periods vertically).
    streak: fbmProgram(24, 2, 3, seed + 137),
    micro: microProgram(seed),
  };
}

function samplePaintedConcrete(out, u, v, ctx) {
  const { def, p } = ctx;
  const metres = def.metresPerRepeat.x;
  const mottle = evalFbm(p.mottle, u, v);
  const grain = evalFbm(p.grain, u, v);
  const streak = evalFbm(p.streak, u, v);
  const micro = microRelief(p.micro, u, v);

  const jointHalf = 0.006 / metres;
  const jointSoft = 0.020 / metres;
  const dU = periodicLineDistance(u, def.jointsPerTile);
  const dV = periodicLineDistance(v, def.jointsPerTile);
  const jointU = 1 - smoothstep(jointHalf, jointSoft, dU);
  const jointV = 1 - smoothstep(jointHalf, jointSoft, dV);
  const joint = Math.max(jointU, jointV);

  // Form-tie dimples on the joint grid intersections.
  const tU = periodicLineDistance(u, def.tieHolesPerTile);
  const tV = periodicLineDistance(v, def.tieHolesPerTile);
  const tieRadius = 0.018 / metres;
  const tieDistance = Math.sqrt(tU * tU + tV * tV);
  const tie = 1 - smoothstep(tieRadius * 0.4, tieRadius, tieDistance);

  const streakMask = smoothstep(0.58, 0.86, streak);
  const h = 0.64 + 0.10 * (mottle - 0.5) + 0.06 * (grain - 0.5)
    + 0.055 * micro - 0.42 * joint - 0.34 * tie;
  out.height = clamp01(h);
  out.roughness = clamp01(
    0.66 + 0.14 * (mottle - 0.5) + 0.16 * streakMask + 0.03 * micro + 0.12 * joint,
  );
  out.ao = clamp01(1 - 0.50 * joint - 0.45 * tie - 0.10 * (1 - mottle) - 0.06 * streakMask);
  out.metalness = 0;
}

function prepareGlassCurtain(seed) {
  return {
    smudge: fbmProgram(8, 8, 3, seed),
    brushed: fbmProgram(3, 64, 2, seed + 401),
    micro: microProgram(seed, 32, 96),
  };
}

function sampleGlassCurtain(out, u, v, ctx) {
  const { def, p } = ctx;
  const metres = def.metresPerRepeat.x;
  const panes = def.panesPerTile;

  const vMullionHalf = 0.035 / metres;
  const hMullionHalf = 0.050 / metres;
  const dU = periodicLineDistance(u, panes);
  const dV = periodicLineDistance(v, panes);
  const mullionU = 1 - smoothstep(vMullionHalf * 0.65, vMullionHalf, dU);
  const mullionV = 1 - smoothstep(hMullionHalf * 0.65, hMullionHalf, dV);
  const frame = Math.max(mullionU, mullionV);

  // Gasket shadow line hugging the frame.
  const dMin = Math.min(dU, dV);
  const gasketOuter = 0.075 / metres;
  const gasket = (1 - frame) * (1 - smoothstep(hMullionHalf, gasketOuter, dMin));

  // Glazing bows very slightly inward across each pane.
  const paneScaledU = u * panes;
  const paneScaledV = v * panes;
  const paneU = paneScaledU - Math.floor(paneScaledU);
  const paneV = paneScaledV - Math.floor(paneScaledV);
  const bow = Math.sin(Math.PI * paneU) * Math.sin(Math.PI * paneV);

  const smudge = evalFbm(p.smudge, u, v);
  const brushed = evalFbm(p.brushed, u, v);
  const micro = microRelief(p.micro, u, v);

  const glassHeight = 0.30 - 0.07 * bow - 0.10 * gasket;
  out.height = clamp01(mix(glassHeight, 0.95 + 0.02 * micro, frame));
  const glassRoughness = 0.045 + 0.05 * smudge + 0.10 * gasket;
  const frameRoughness = 0.40 + 0.10 * (brushed - 0.5);
  out.roughness = clamp01(mix(glassRoughness, frameRoughness, frame));
  out.ao = clamp01(1 - 0.40 * gasket - 0.08 * frame);
  out.metalness = clamp01(mix(0, 0.90, frame));
}

function prepareAsphalt(seed) {
  return {
    aggregate: fbmProgram(32, 32, 3, seed),
    coarse: fbmProgram(12, 12, 3, seed + 61),
    patch: fbmProgram(4, 4, 2, seed + 149),
    crack: turbulenceProgram(5, 5, 4, seed + 733),
    micro: microProgram(seed),
  };
}

function sampleAsphalt(out, u, v, ctx) {
  const { p } = ctx;
  const aggregate = evalFbm(p.aggregate, u, v);
  const coarse = evalFbm(p.coarse, u, v);
  const patch = evalFbm(p.patch, u, v);
  const crack = smoothstep(0.90, 0.99, 1 - evalTurbulence(p.crack, u, v));
  const micro = microRelief(p.micro, u, v);

  const h = 0.54 + 0.24 * (aggregate - 0.5) + 0.12 * (coarse - 0.5)
    + 0.115 * micro - 0.42 * crack;
  out.height = clamp01(h);
  // Polished wheel paths (high `patch`) read slightly smoother than the verge.
  out.roughness = clamp01(
    0.93 - 0.10 * (aggregate - 0.5) - 0.10 * (patch - 0.5) + 0.03 * micro + 0.04 * crack,
  );
  out.ao = clamp01(0.95 + 0.10 * (h - 0.54) - 0.55 * crack);
  out.metalness = 0;
}

function prepareSidewalkConcrete(seed) {
  return {
    aggregate: fbmProgram(32, 32, 3, seed),
    // Broom finish: fine ridges running across the walk.
    broom: fbmProgram(2, 96, 2, seed + 29),
    stain: fbmProgram(3, 3, 3, seed + 907),
    micro: microProgram(seed),
    broomRidge: microProgram(seed + 4409, 4, 128),
  };
}

function sampleSidewalkConcrete(out, u, v, ctx) {
  const { def, p } = ctx;
  const metres = def.metresPerRepeat.x;
  const scoreHalf = 0.008 / metres;
  const scoreSoft = 0.030 / metres;
  const dU = periodicLineDistance(u, def.scoreLinesPerTile);
  const dV = periodicLineDistance(v, def.scoreLinesPerTile);
  const d = Math.min(dU, dV);
  const groove = 1 - smoothstep(scoreHalf, scoreSoft, d);

  const aggregate = evalFbm(p.aggregate, u, v);
  const broom = evalFbm(p.broom, u, v);
  const stain = smoothstep(0.60, 0.88, evalFbm(p.stain, u, v));
  const micro = microRelief(p.micro, u, v);
  const broomRidge = microRelief(p.broomRidge, u, v);

  const h = 0.68 + 0.12 * (aggregate - 0.5) + 0.06 * (broom - 0.5)
    + 0.055 * micro + 0.035 * broomRidge - 0.50 * groove;
  out.height = clamp01(h);
  out.roughness = clamp01(
    0.87 + 0.08 * (aggregate - 0.5) + 0.03 * micro + 0.06 * groove + 0.07 * stain,
  );
  out.ao = clamp01(1 - 0.55 * groove - 0.10 * (1 - aggregate) - 0.10 * stain);
  out.metalness = 0;
}

function prepareDirtyMetal(seed) {
  return {
    // Brushed grain: many periods along v, few along u -> horizontal streaks.
    brush: fbmProgram(2, 64, 2, seed),
    dents: fbmProgram(3, 3, 3, seed + 13),
    grit: fbmProgram(32, 32, 2, seed + 41),
    corrosion: fbmProgram(5, 5, 4, seed + 29),
    micro: microProgram(seed, 4, 128),
    crust: microProgram(seed + 1201),
  };
}

function sampleDirtyMetal(out, u, v, ctx) {
  const { p } = ctx;
  const brush = evalFbm(p.brush, u, v);
  const dents = evalFbm(p.dents, u, v);
  const grit = evalFbm(p.grit, u, v);
  const corrosion = smoothstep(0.55, 0.80, evalFbm(p.corrosion, u, v));
  const micro = microRelief(p.micro, u, v);
  const crust = microRelief(p.crust, u, v);

  const h = 0.58 + 0.10 * (dents - 0.5) + 0.05 * (brush - 0.5)
    + 0.070 * micro
    + 0.16 * corrosion * (0.4 + 0.6 * grit) + 0.05 * corrosion * crust;
  out.height = clamp01(h);
  out.roughness = clamp01(
    mix(0.34 + 0.10 * (brush - 0.5) + 0.05 * micro, 0.88 + 0.08 * (grit - 0.5), corrosion),
  );
  out.ao = clamp01(1 - 0.25 * corrosion - 0.12 * (1 - dents));
  out.metalness = clamp01(mix(0.94, 0.28, corrosion));
}

const SAMPLERS = Object.freeze({
  brick: { prepare: prepareBrick, sample: sampleBrick },
  stucco: { prepare: prepareStucco, sample: sampleStucco },
  'painted-concrete': { prepare: preparePaintedConcrete, sample: samplePaintedConcrete },
  'glass-curtain': { prepare: prepareGlassCurtain, sample: sampleGlassCurtain },
  asphalt: { prepare: prepareAsphalt, sample: sampleAsphalt },
  'sidewalk-concrete': { prepare: prepareSidewalkConcrete, sample: sampleSidewalkConcrete },
  'dirty-metal': { prepare: prepareDirtyMetal, sample: sampleDirtyMetal },
});

const contextCache = new Map();

/**
 * Deterministic per-(class, seed) sampling context. Cached because compiling
 * the noise programs is the expensive part and the result is immutable.
 */
export function getSurfaceContext(className, seed = 0) {
  const def = getSurfaceDef(className);
  const mixed = classSeed(className, seed);
  const key = `${className}|${mixed}`;
  let ctx = contextCache.get(key);
  if (!ctx) {
    const entry = SAMPLERS[className];
    ctx = { className, def, seed: mixed, p: entry.prepare(mixed), sample: entry.sample };
    contextCache.set(key, ctx);
  }
  return ctx;
}

/** Free the compiled-noise contexts and their lattice tables. */
export function clearSurfaceContextCache() {
  contextCache.clear();
  clearNoiseLatticeCache();
}

/**
 * Pure, continuous, exactly periodic surface sample.
 *
 * @param {string} className one of SURFACE_CLASSES
 * @param {number} u normalized tile coordinate; period 1
 * @param {number} v normalized tile coordinate; period 1
 * @param {{seed?: number|string}} [options]
 * @returns {{height:number, roughness:number, ao:number, metalness:number}}
 *   all channels in [0,1]
 */
export function sampleSurfaceField(className, u, v, options = {}) {
  const ctx = getSurfaceContext(className, options.seed ?? 0);
  const out = { height: 0, roughness: 0, ao: 0, metalness: 0 };
  ctx.sample(out, u, v, ctx);
  return out;
}

// ---------------------------------------------------------------------------
// Discrete field baking (still pure: typed arrays only, no canvas, no DOM).
// ---------------------------------------------------------------------------

function normalizeResolution(resolution, def) {
  const size = Math.max(4, Math.round(resolution ?? def.defaultResolution));
  return { width: size, height: size };
}

/**
 * Bake the continuous field onto a grid.
 *
 * Texel centres are sampled at (i + 0.5) / width, so no texel sits exactly on
 * the tile seam and the wrap stays symmetric.
 *
 * @param {string} className
 * @param {{seed?: number|string, resolution?: number}} [options]
 * @returns {{
 *   className: string, seed: number, width: number, height: number,
 *   metresPerRepeat: {x:number, y:number}, heightScaleMetres: number,
 *   normalExaggeration: number,
 *   heightField: Float32Array, roughnessField: Float32Array,
 *   aoField: Float32Array, metalnessField: Float32Array
 * }}
 */
export function buildSurfaceField(className, options = {}) {
  const def = getSurfaceDef(className);
  const { width, height } = normalizeResolution(options.resolution, def);
  const ctx = getSurfaceContext(className, options.seed ?? 0);
  const seed = ctx.seed;
  const sample = ctx.sample;

  const count = width * height;
  const heightField = new Float32Array(count);
  const roughnessField = new Float32Array(count);
  const aoField = new Float32Array(count);
  const metalnessField = new Float32Array(count);
  const scratch = { height: 0, roughness: 0, ao: 0, metalness: 0 };

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      sample(scratch, u, v, ctx);
      const i = row + x;
      heightField[i] = scratch.height;
      roughnessField[i] = scratch.roughness;
      aoField[i] = scratch.ao;
      metalnessField[i] = scratch.metalness;
    }
  }

  return {
    className,
    seed,
    width,
    height,
    metresPerRepeat: { x: def.metresPerRepeat.x, y: def.metresPerRepeat.y },
    heightScaleMetres: def.heightScaleMetres,
    normalExaggeration: def.normalExaggeration,
    heightField,
    roughnessField,
    aoField,
    metalnessField,
  };
}

/** Separable wrapped box blur. Wrapping keeps the blur itself tileable. */
function wrappedBoxBlur(source, width, height, radius) {
  if (radius <= 0) return Float32Array.from(source);
  const temp = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        sum += source[row + imod(x + k, width)];
      }
      temp[row + x] = sum / span;
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        sum += temp[imod(y + k, height) * width + x];
      }
      out[y * width + x] = sum / span;
    }
  }
  return out;
}

/**
 * Analytic AO combined with a height-cavity term: a texel sitting below its
 * local neighbourhood mean is treated as occluded. Pure; returns a new
 * Float32Array in [0,1] laid out like the field.
 */
export function buildOcclusionField(field, options = {}) {
  const { cavityRadius = 3, cavityGain = 2.6, cavityMix = 0.55 } = options;
  const { width, height, heightField, aoField } = field;
  const blurred = wrappedBoxBlur(heightField, width, height, cavityRadius);
  const out = new Float32Array(heightField.length);
  for (let i = 0; i < heightField.length; i += 1) {
    // cavity: 0.5 = flat, <0.5 = below neighbours, >0.5 = raised.
    const cavity = clamp01(0.5 + (heightField[i] - blurred[i]) * cavityGain);
    const cavityTerm = 0.55 + 0.90 * cavity; // 0.55 fully sunk .. 1.45 raised
    out[i] = clamp01(aoField[i] * (1 - cavityMix + cavityMix * cavityTerm));
  }
  return out;
}

/**
 * Encode a tangent-space normal map (OpenGL / three.js convention: +Y green is
 * up in UV space) as RGBA bytes, top row first (canvas orientation).
 *
 * Slopes are computed in metres from `heightScaleMetres` and the real texel
 * size, so the relief reads the same at 256 or 1024. Derivatives wrap, so the
 * normal map tiles as seamlessly as the height field.
 */
export function encodeNormalRGBA(field, options = {}) {
  const flipGreen = options.flipGreen ?? false;
  const normalStrength = options.normalStrength ?? field.normalExaggeration ?? 1;
  const { width, height, heightField } = field;
  const data = new Uint8ClampedArray(width * height * 4);

  const texelMetresX = field.metresPerRepeat.x / width;
  const texelMetresY = field.metresPerRepeat.y / height;
  const amplitude = field.heightScaleMetres * normalStrength;
  const greenSign = flipGreen ? -1 : 1;

  for (let y = 0; y < height; y += 1) {
    const rowUp = imod(y - 1, height) * width;
    const rowDown = imod(y + 1, height) * width;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const xLeft = imod(x - 1, width);
      const xRight = imod(x + 1, width);
      const dhdx = (heightField[row + xRight] - heightField[row + xLeft])
        * amplitude / (2 * texelMetresX);
      // Row index grows downward while UV v grows upward, so d/dv is the
      // negated row derivative and -dh/dv is therefore +dh/drow.
      const dhdrow = (heightField[rowDown + x] - heightField[rowUp + x])
        * amplitude / (2 * texelMetresY);

      let nx = -dhdx;
      let ny = greenSign * dhdrow;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;

      const i = (row + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/**
 * Encode the packed ORM map as RGBA bytes, top row first:
 *   R = ambient occlusion, G = roughness, B = metalness, A = 255.
 *
 * One texture can then be assigned to aoMap, roughnessMap AND metalnessMap at
 * once, which is exactly the channel layout three.js reads.
 */
export function encodeOrmRGBA(field, options = {}) {
  const { width, height } = field;
  const occlusion = options.occlusion ?? buildOcclusionField(field, options);
  const roughnessBias = options.roughnessBias ?? 0;
  const roughnessGain = options.roughnessGain ?? 1;
  const aoStrength = options.aoStrength ?? 1;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const ao = clamp01(1 - (1 - occlusion[i]) * aoStrength);
    const rough = clamp01(field.roughnessField[i] * roughnessGain + roughnessBias);
    data[i * 4] = Math.round(ao * 255);
    data[i * 4 + 1] = Math.round(rough * 255);
    data[i * 4 + 2] = Math.round(field.metalnessField[i] * 255);
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/**
 * Pure image set: the baked field plus both encoded RGBA buffers. No canvas,
 * no THREE object. This is what the node self-check exercises.
 */
export function buildDetailImages(className, options = {}) {
  const field = buildSurfaceField(className, options);
  const occlusion = buildOcclusionField(field, options);
  return {
    className,
    field,
    occlusion,
    normal: encodeNormalRGBA(field, options),
    orm: encodeOrmRGBA(field, { ...options, occlusion }),
  };
}

// ---------------------------------------------------------------------------
// Texture settings.
//
// Detail maps are data, not colour. They are always NoColorSpace, always
// RepeatWrapping, always mipmapped (a normal map without mipmaps shimmers
// violently at grazing angles, which the "Technical integrity" rubric line
// treats as a critical artifact).
// ---------------------------------------------------------------------------

const DEFAULT_TEXTURE_SETTINGS = {
  anisotropy: 8,
  generateMipmaps: true,
  minFilter: THREE.LinearMipmapLinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.RepeatWrapping,
  wrapT: THREE.RepeatWrapping,
  colorSpace: THREE.NoColorSpace,
  preferCanvas: true,
};

const textureSettings = { ...DEFAULT_TEXTURE_SETTINGS };

export const DETAIL_TEXTURE_DEFAULTS = Object.freeze({ ...DEFAULT_TEXTURE_SETTINGS });

/** Read the live texture settings (a copy; mutate through the setter). */
export function getDetailTextureSettings() {
  return { ...textureSettings };
}

/**
 * Override the texture settings used by textures created from now on.
 * Call before the first getDetailMaps() of a frame budget; already-created
 * textures are updated for anisotropy only (see applyRendererCapabilities).
 */
export function setDetailTextureSettings(overrides = {}) {
  Object.assign(textureSettings, overrides);
  return getDetailTextureSettings();
}

/**
 * Clamp anisotropy to what the active renderer actually supports and push it
 * onto every cached texture. Safe to call once after renderer creation.
 * Does not create or own a renderer.
 */
export function applyRendererCapabilities(renderer) {
  const max = renderer?.capabilities?.getMaxAnisotropy?.();
  if (Number.isFinite(max) && max > 0) {
    textureSettings.anisotropy = Math.min(textureSettings.anisotropy, max);
    for (const bundle of detailCache.values()) {
      for (const texture of bundle.textures) {
        texture.anisotropy = textureSettings.anisotropy;
        texture.needsUpdate = true;
      }
      // Repeat clones carry their own sampler state and must follow.
      for (const variant of bundle.variants.values()) {
        variant.anisotropy = textureSettings.anisotropy;
        variant.needsUpdate = true;
      }
    }
  }
  return textureSettings.anisotropy;
}

function configureTexture(texture, settings) {
  texture.wrapS = settings.wrapS;
  texture.wrapT = settings.wrapT;
  texture.colorSpace = settings.colorSpace;
  texture.generateMipmaps = settings.generateMipmaps;
  texture.minFilter = settings.minFilter;
  texture.magFilter = settings.magFilter;
  texture.anisotropy = settings.anisotropy;
  texture.channel = 0; // aoMap/roughnessMap/metalnessMap all read uv channel 0
  texture.needsUpdate = true;
  return texture;
}

function canvasFactory() {
  if (typeof OffscreenCanvas === 'function') {
    return (w, h) => new OffscreenCanvas(w, h);
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    return (w, h) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      return canvas;
    };
  }
  return null;
}

/** True when a 2D canvas is reachable (browser or worker), false in node. */
export function hasCanvasSupport() {
  return canvasFactory() !== null;
}

function textureFromCanvas(image) {
  const make = canvasFactory();
  if (!make) return null;
  const canvas = make(image.width, image.height);
  const context = canvas.getContext?.('2d', { willReadFrequently: false })
    ?? canvas.getContext?.('2d');
  if (!context) return null;
  let imageData = null;
  if (typeof context.createImageData === 'function') {
    imageData = context.createImageData(image.width, image.height);
    imageData.data.set(image.data);
  } else if (typeof ImageData === 'function') {
    imageData = new ImageData(image.data, image.width, image.height);
  } else {
    return null;
  }
  context.putImageData(imageData, 0, 0);
  // CanvasTexture keeps flipY = true, so canvas row 0 lands at v = 1.
  return new THREE.CanvasTexture(canvas);
}

/** Flip RGBA rows so a flipY=false DataTexture matches the canvas orientation. */
function flipRowsRGBA(image) {
  const { width, height, data } = image;
  const out = new Uint8Array(data.length);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * stride;
    out.set(data.subarray(src, src + stride), y * stride);
  }
  return out;
}

function textureFromData(image) {
  const texture = new THREE.DataTexture(
    flipRowsRGBA(image),
    image.width,
    image.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.flipY = false; // rows are pre-flipped above
  return texture;
}

/**
 * Wrap an RGBA image as a three.js texture. Prefers a CanvasTexture when a
 * canvas exists (browser/worker) and falls back to a DataTexture with
 * pre-flipped rows, so both paths sample identically for the same UVs.
 */
export function createDetailTexture(image, options = {}) {
  const settings = { ...textureSettings, ...options };
  const texture = (settings.preferCanvas ? textureFromCanvas(image) : null)
    ?? textureFromData(image);
  return configureTexture(texture, settings);
}

// ---------------------------------------------------------------------------
// Real-world tiling convention.
// ---------------------------------------------------------------------------

/** Texture repeats per metre for a class: repeat = metres * uvScalePerMetre. */
export function uvScalePerMetre(className) {
  const def = getSurfaceDef(className);
  return { x: 1 / def.metresPerRepeat.x, y: 1 / def.metresPerRepeat.y };
}

/** texture.repeat for a surface of the given real-world size, in metres. */
export function repeatForSurface(className, widthMetres, heightMetres) {
  const def = getSurfaceDef(className);
  return {
    x: (Number.isFinite(widthMetres) ? widthMetres : def.metresPerRepeat.x) / def.metresPerRepeat.x,
    y: (Number.isFinite(heightMetres) ? heightMetres : def.metresPerRepeat.y) / def.metresPerRepeat.y,
  };
}

// ---------------------------------------------------------------------------
// Bundle cache. Keyed by (class, seed, resolution, encode options) so a texture
// is generated exactly once per distinct request and shared by every mesh.
// ---------------------------------------------------------------------------

const detailCache = new Map();

function bundleCacheKey(className, options) {
  return [
    DETAIL_MAPS_VERSION,
    className,
    String(options.seed ?? 0),
    String(options.resolution ?? getSurfaceDef(className).defaultResolution),
    String(options.normalStrength ?? 1),
    options.flipGreen ? 'gy' : 'gn',
    String(options.aoStrength ?? 1),
    String(options.roughnessGain ?? 1),
    String(options.roughnessBias ?? 0),
    // These change the baked ORM pixels, so they have to key the cache too.
    String(options.cavityRadius ?? 3),
    String(options.cavityGain ?? 2.6),
    String(options.cavityMix ?? 0.55),
    (options.preferCanvas ?? textureSettings.preferCanvas) ? 'cv' : 'dt',
  ].join('|');
}

function makeBundle(className, options) {
  const def = getSurfaceDef(className);
  const images = buildDetailImages(className, options);
  const normalMap = createDetailTexture(images.normal, options);
  const ormMap = createDetailTexture(images.orm, options);
  normalMap.name = `detail-normal-${className}`;
  ormMap.name = `detail-orm-${className}`;

  const variants = new Map();
  const bundle = {
    key: bundleCacheKey(className, options),
    className,
    label: def.label,
    seed: images.field.seed,
    width: images.field.width,
    height: images.field.height,
    metresPerRepeat: { ...def.metresPerRepeat },
    uvScalePerMetre: uvScalePerMetre(className),
    heightScaleMetres: def.heightScaleMetres,
    normalMap,
    // One packed texture, three slots. R = AO, G = roughness, B = metalness.
    ormMap,
    roughnessMap: ormMap,
    aoMap: ormMap,
    metalnessMap: ormMap,
    // Exaggeration is already baked into the encoded normal; this stays at 1
    // so a caller can grade a single material without rebuilding a texture.
    normalScale: new THREE.Vector2(1, 1),
    textures: [normalMap, ormMap],
    variants,
    images: options.keepImages ? images : null,
    dispose() {
      for (const texture of variants.values()) texture.dispose();
      variants.clear();
      normalMap.dispose();
      ormMap.dispose();
      detailCache.delete(bundle.key);
    },
  };
  return bundle;
}

/**
 * Cached detail maps for a surface class. THIS is the entry point the renderer
 * should use: repeated calls with the same arguments return the same bundle
 * and therefore the same GPU textures.
 */
export function getDetailMaps(className, options = {}) {
  const key = bundleCacheKey(className, options);
  let bundle = detailCache.get(key);
  if (!bundle) {
    bundle = makeBundle(className, options);
    detailCache.set(key, bundle);
  }
  return bundle;
}

/** Uncached bundle; useful for a one-off preview. Caller must dispose it. */
export function createDetailMaps(className, options = {}) {
  return makeBundle(className, options);
}

/** Warm the cache for a set of classes during load, not during the first frame. */
export function preloadDetailMaps(classNames = SURFACE_CLASSES, options = {}) {
  return classNames.map((className) => getDetailMaps(className, options));
}

export function detailMapCacheStats() {
  let textures = 0;
  let variants = 0;
  let texels = 0;
  for (const bundle of detailCache.values()) {
    textures += bundle.textures.length;
    variants += bundle.variants.size;
    texels += bundle.width * bundle.height * bundle.textures.length;
  }
  return { bundles: detailCache.size, textures, variants, texels };
}

export function clearDetailMapCache() {
  for (const bundle of [...detailCache.values()]) bundle.dispose();
  detailCache.clear();
}

/**
 * A repeat-specific clone of a cached texture. Clones share the same
 * THREE.Source, so the pixel data is uploaded once no matter how many repeat
 * variants exist. Variants are cached per bundle and freed by bundle.dispose().
 */
function tiledVariant(bundle, slot, texture, repeatX, repeatY) {
  if (repeatX === 1 && repeatY === 1) return texture;
  const key = `${slot}|${repeatX.toFixed(4)}|${repeatY.toFixed(4)}`;
  let variant = bundle.variants.get(key);
  if (!variant) {
    variant = texture.clone();
    variant.repeat.set(repeatX, repeatY);
    variant.name = `${texture.name}-r${key}`;
    variant.needsUpdate = true;
    bundle.variants.set(key, variant);
  }
  return variant;
}

/**
 * Attach a class's detail maps to a stock three.js material.
 *
 * IMPORTANT three.js semantics: roughness/metalness maps are MULTIPLIED by the
 * scalar `material.roughness` / `material.metalness`. The packed ORM already
 * carries physical values, so this helper sets both scalars to 1 by default.
 * Pass `roughnessScale` / `metalnessScale` to grade them.
 *
 * Two tiling strategies:
 *   - Preferred: bake UVs in metres (uv = metres) and pass `uvsAreMetres: true`;
 *     the repeat is then set once from `uvScalePerMetre` and every mesh in a
 *     merged batch tiles correctly regardless of size.
 *   - Otherwise pass `widthMetres` / `heightMetres` for 0..1 UVs; a shared
 *     repeat clone is used.
 */
export function applyDetailMaps(material, classNameOrBundle, options = {}) {
  const bundle = typeof classNameOrBundle === 'string'
    ? getDetailMaps(classNameOrBundle, options)
    : classNameOrBundle;

  let repeatX = 1;
  let repeatY = 1;
  if (options.uvsAreMetres) {
    repeatX = bundle.uvScalePerMetre.x;
    repeatY = bundle.uvScalePerMetre.y;
  } else if (Number.isFinite(options.widthMetres) || Number.isFinite(options.heightMetres)) {
    const repeat = repeatForSurface(bundle.className, options.widthMetres, options.heightMetres);
    repeatX = repeat.x;
    repeatY = repeat.y;
  } else if (options.repeat) {
    repeatX = options.repeat.x ?? 1;
    repeatY = options.repeat.y ?? 1;
  }

  const normalMap = tiledVariant(bundle, 'n', bundle.normalMap, repeatX, repeatY);
  const ormMap = tiledVariant(bundle, 'o', bundle.ormMap, repeatX, repeatY);

  material.normalMap = normalMap;
  material.normalMapType = THREE.TangentSpaceNormalMap;
  const scale = options.normalScale ?? bundle.normalScale.x;
  material.normalScale = new THREE.Vector2(scale, scale);

  if (options.useRoughnessMap !== false) {
    material.roughnessMap = ormMap;
    material.roughness = options.roughnessScale ?? 1;
  }
  if (options.useMetalnessMap !== false) {
    material.metalnessMap = ormMap;
    material.metalness = options.metalnessScale ?? 1;
  }
  if (options.useAoMap !== false) {
    material.aoMap = ormMap;
    material.aoMapIntensity = options.aoMapIntensity ?? 1;
  }
  material.needsUpdate = true;
  return bundle;
}

// ---------------------------------------------------------------------------
// Weathering: vertical grime.
//
// Real buildings are dirtiest where the street splashes them and cleanest
// where rain washes them. A single global grime profile applied to every
// facade is the cheapest large win available on the "Architecture and
// materials" rubric line, because it breaks the uniform-albedo look that the
// audit called out without touching geometry.
//
// `grimeAmount()` is pure and monotonically non-increasing with height, which
// the node self-check asserts.
// ---------------------------------------------------------------------------

export const GRIME_DEFAULTS = Object.freeze({
  baseMetres: 0,        // world Y where the facade meets the ground
  falloffMetres: 7,     // height over which street grime fades out
  exponent: 1.7,        // >1 concentrates grime near the base
  topGrime: 0.06,       // residual soiling far above the street
  splashMetres: 0.9,    // splash-back band at the very bottom
  splashStrength: 0.22,
  strength: 1,          // global multiplier
  albedoDarken: 0.34,   // how much grime multiplies the albedo down
  roughnessBoost: 0.30, // how much grime pushes roughness toward 1
  dripColumns: 6,       // horizontal drip period per texture repeat
  dripLengthMetres: 9,
  seed: 0,
});

function grimeOptions(options) {
  return { ...GRIME_DEFAULTS, ...options };
}

/**
 * Grime in [0,1] at a height above the facade base, in metres.
 * Monotonically non-increasing in `heightMetres`.
 */
export function grimeAmount(heightMetres, options = {}) {
  const o = grimeOptions(options);
  const above = Math.max(0, heightMetres - o.baseMetres);
  const t = clamp01(above / Math.max(1e-6, o.falloffMetres));
  const profile = o.topGrime + (1 - o.topGrime) * Math.pow(1 - t, o.exponent);
  const splash = o.splashStrength
    * (1 - smoothstep(0, Math.max(1e-6, o.splashMetres), above));
  return clamp01((profile + splash) * o.strength);
}

/**
 * Grime with seeded vertical drip streaks. Exactly periodic in `u` (period 1),
 * so a facade texture using it still tiles horizontally.
 */
export function sampleGrimeField(u, heightMetres, options = {}) {
  const o = grimeOptions(options);
  const base = grimeAmount(heightMetres, o);
  if (base <= 0) return 0;
  const seed = hashSeed(`grime:${o.seed}`) | 0;
  const drip = periodicFbm(u, heightMetres / Math.max(1e-6, o.dripLengthMetres), {
    periodX: o.dripColumns,
    periodY: 3,
    octaves: 3,
    seed,
  });
  const streak = smoothstep(0.45, 0.85, drip);
  return clamp01(base * (0.74 + 0.40 * drip) + 0.16 * streak * base);
}

/** Albedo multiplier in (0,1]: multiply a facade colour or texel by this. */
export function grimeAlbedoScale(grime, options = {}) {
  const o = grimeOptions(options);
  return clamp01(1 - o.albedoDarken * clamp01(grime));
}

/** Roughness pushed toward 1 by grime. Dirt is never glossier than clean. */
export function grimeRoughness(roughness, grime, options = {}) {
  const o = grimeOptions(options);
  const g = clamp01(grime) * o.roughnessBoost;
  return clamp01(roughness + (1 - roughness) * g);
}

/**
 * Per-vertex grime multiplier for renderers that already use vertex colours:
 * multiply the vertex colour by this scalar at world height `yMetres`.
 */
export function grimeVertexColorScale(yMetres, options = {}) {
  return grimeAlbedoScale(grimeAmount(yMetres, options), options);
}

/**
 * Grime ramp image, top row first (canvas orientation), where row 0 is the top
 * of a wall `wallHeightMetres` tall.
 *   R = grime amount
 *   G = albedo multiplier (255 = clean)
 *   B = roughness boost to add (0 = none)
 *   A = 255
 */
export function buildGrimeImageRGBA(options = {}) {
  const o = grimeOptions(options);
  const width = Math.max(1, Math.round(options.width ?? 64));
  const height = Math.max(2, Math.round(options.height ?? 256));
  const wallHeightMetres = Math.max(0.5, options.wallHeightMetres ?? 24);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    // Row 0 is the top of the wall; v grows upward once flipY is applied.
    const metres = (1 - (y + 0.5) / height) * wallHeightMetres;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const grime = sampleGrimeField(u, metres, o);
      const i = (y * width + x) * 4;
      data[i] = Math.round(grime * 255);
      data[i + 1] = Math.round(grimeAlbedoScale(grime, o) * 255);
      data[i + 2] = Math.round(clamp01(grime * o.roughnessBoost) * 255);
      data[i + 3] = 255;
    }
  }
  return { width, height, data, wallHeightMetres };
}

const grimeCache = new Map();

function grimeCacheKey(options) {
  const o = grimeOptions(options);
  return [
    DETAIL_MAPS_VERSION,
    'grime',
    o.seed, o.baseMetres, o.falloffMetres, o.exponent, o.topGrime,
    o.splashMetres, o.splashStrength, o.strength, o.albedoDarken,
    o.roughnessBoost, o.dripColumns, o.dripLengthMetres,
    options.width ?? 64, options.height ?? 256, options.wallHeightMetres ?? 24,
  ].join('|');
}

/**
 * Cached grime ramp texture. Wraps horizontally, clamps vertically (a facade
 * has exactly one base and one top), and is NoColorSpace like every other map
 * here.
 */
export function getGrimeTexture(options = {}) {
  const key = grimeCacheKey(options);
  let entry = grimeCache.get(key);
  if (!entry) {
    const image = buildGrimeImageRGBA(options);
    const texture = createDetailTexture(image, { ...options, wrapT: THREE.ClampToEdgeWrapping });
    texture.name = 'detail-grime';
    entry = { key, image: options.keepImages ? image : null, texture, wallHeightMetres: image.wallHeightMetres };
    grimeCache.set(key, entry);
  }
  return entry;
}

export function clearGrimeCache() {
  for (const entry of grimeCache.values()) entry.texture.dispose();
  grimeCache.clear();
}

/** Dispose every cached detail and grime texture. */
export function disposeAllDetailMaps() {
  clearDetailMapCache();
  clearGrimeCache();
}

/**
 * Multiply grime into an existing sRGB facade albedo image, in place.
 * `image` is { width, height, data } with row 0 at the TOP of the wall, the
 * same orientation a 2D canvas uses. Returns the image for chaining.
 */
export function applyGrimeToAlbedoImage(image, options = {}) {
  const o = grimeOptions(options);
  const wallHeightMetres = Math.max(0.5, options.wallHeightMetres ?? 24);
  const { width, height, data } = image;
  for (let y = 0; y < height; y += 1) {
    const metres = (1 - (y + 0.5) / height) * wallHeightMetres;
    for (let x = 0; x < width; x += 1) {
      const scale = grimeAlbedoScale(sampleGrimeField((x + 0.5) / width, metres, o), o);
      const i = (y * width + x) * 4;
      data[i] = Math.round(data[i] * scale);
      data[i + 1] = Math.round(data[i + 1] * scale);
      data[i + 2] = Math.round(data[i + 2] * scale);
    }
  }
  return image;
}

/**
 * Raise the roughness channel (G) of an ORM image toward 1 near the wall base,
 * in place. Use this when a facade gets its own per-building ORM; the shared
 * cached ORM must never be mutated.
 */
export function applyGrimeToOrmImage(image, options = {}) {
  const o = grimeOptions(options);
  const wallHeightMetres = Math.max(0.5, options.wallHeightMetres ?? 24);
  const { width, height, data } = image;
  for (let y = 0; y < height; y += 1) {
    const metres = (1 - (y + 0.5) / height) * wallHeightMetres;
    for (let x = 0; x < width; x += 1) {
      const grime = sampleGrimeField((x + 0.5) / width, metres, o);
      const i = (y * width + x) * 4 + 1;
      data[i] = Math.round(grimeRoughness(data[i] / 255, grime, o) * 255);
    }
  }
  return image;
}
