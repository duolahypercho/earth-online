// sky-atmosphere — presentation pass.
//
// Owner: Rendering (lighting/atmosphere)
// Goal:  Sky, cloud, aerial-perspective and exposure content that the rubric's lighting dimension needs.
//
// Contract: see src/render/pass-registry.js. Build from the city contract in
// `ctx`; never mutate simulation state, never create a renderer or loop.
//
// What this pass is answering
// ---------------------------
// Measured on the baseline 11:00 clear card (`.qa-baseline-0820`), the frame
// has: a flat two-stop vertex-coloured sky with no sun and no cloud; no
// aerial perspective, because the renderer's fog starts at 1100 m on a map
// whose deepest street sight-line is about 250 m; no contact darkening where
// wall meets ground; and a key/fill ratio of 0.70, i.e. the sky fill is
// stronger than the sun. All four are addressed here or in the pure model this
// pass reads (`src/render/environment-ibl.js`), except the parts that live in
// the renderer's own light rig, which are reported as diagnostics for the
// integration owner rather than patched from inside a pass.
//
// Backend policy
// --------------
// Everything below is plain Three geometry with `MeshBasicMaterial`,
// `PointsMaterial` and one `MeshStandardMaterial`, plus `DataTexture`s built
// from typed arrays. No `ShaderMaterial`, no `onBeforeCompile`, no render
// target, no second renderer, no animation loop. That is what lets the same
// content render on `WebGPURenderer` and on its WebGL2 fallback, which is the
// backend the capture harness actually runs.
//
// Determinism
// -----------
// No `Math.random()`, no `Date.now()`. Cloud shape, star placement, puddle
// placement and per-lamp jitter all come from the integer hash in
// `environment-ibl`, and cloud drift is a function of the clock hour rather
// than of accumulated frame time, so a pinned capture hour reproduces the same
// sky byte for byte.

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

import {
  ATMOSPHERE_MODEL_VERSION,
  aerialPerspective,
  blackBodyColor,
  cloudProfile,
  computeSkyModel,
  displayStepScene,
  sceneForDisplay,
  keyFillBalance,
  nightPracticalProfile,
  normaliseWeather,
  quantiseHour,
  recommendedExposure,
  renderCloudSheet,
  skyDomeRadiance,
  starField,
  wetSurfaceGrade,
} from '../environment-ibl.js';

import {
  GROUNDING_DEFAULTS,
  collectGroundingAnchors,
  groundingFrame,
  groundingLength,
  groundingTipWidth,
  keyShareOfRatio,
  refreshGroundingAnchor,
} from '../shadow-casters.js';

/** Identity of the scene content this pass builds. */
export const SKY_ATMOSPHERE_VERSION = 'sky-atmosphere-v2';

/**
 * Declared budget for everything this pass adds.
 *
 * `AGENTS.md` requires render-only work to preserve draw/triangle budgets
 * unless the task defines and verifies a new one. This is that definition, and
 * `scripts/verify/verify-sky-atmosphere.mjs` asserts the built result against
 * it for every hour and weather bucket.
 */
export const SKY_ATMOSPHERE_BUDGET = Object.freeze({
  triangles: 48000,
  drawCalls: 20,
  /** Bytes of texture this pass uploads, summed over every texture it owns. */
  textureBytes: 1_600_000,
  /**
   * Hours between sky retimes. A retime costs one `computeSkyModel` (~3.8 ms)
   * plus a dome recolour (~3.6 ms). At 0.5 h and the shipped 40 s day that is
   * about 8 ms once every 0.83 s, i.e. ~1% of frame time; at 0.25 h it would be
   * twice that for a sky difference nobody can see.
   */
  hourQuantum: 0.5,
});

/** Geometry resolution. Kept low: a sky gradient interpolates well. */
const DOME_SEGMENTS = 40;
const DOME_RINGS = 26;
const CLOUD_SEGMENTS = 44;
const CLOUD_RINGS = 9;
const HAZE_SEGMENTS = 56;
const HAZE_RINGS = 5;
const STAR_COUNT = 620;
// Cloud sheet resolution.
//
// Round 3 baked the low deck at 256 and the frame came back reading as painted
// sky. The arithmetic says why. The low deck's texture tiles every 1750 m and
// sits at `radius * 0.17` = 657 m, so at 256 a texel is 6.84 m and subtends
// 6.84/657 = 10.4 mrad = 0.60 deg. The capture runs a 47 deg horizontal field
// across 2560 px, i.e. 54.5 px/deg, so one cloud texel is **33 screen pixels**
// and the smallest feature the sheet can carry is a 65 px blob. That is a
// poster, not a cloud.
//
// At 512 the same texel is 3.42 m and 16.3 px, and the composited detail
// octave below runs at four times the base lattice frequency, so the finest
// structure in the sheet lands at roughly 8 px. The high deck keeps half the
// low deck's resolution: it tiles every 4600 m at `radius * 0.5` = 1932 m, so
// 256 puts its texel at 29 px - already finer than round 3's LOW deck - and it
// is thin cirrus at 0.24 opacity seen at a shallow angle.
//
// Budget: 512^2 + 256^2 at RGBA8 is 1,310,720 bytes against round 3's 409,600.
// The whole pass still lands inside the declared 1,600,000 (measured below and
// asserted per bucket by `scripts/verify/verify-sky-atmosphere.mjs`), so this
// is a re-verification of the existing budget, not a new one.
const CLOUD_TEXTURE_SIZE = 512;
/** High deck edge, as a fraction of the low deck's. */
const CLOUD_HIGH_SCALE = 0.5;
/** Detail sheet edge, as a fraction of the deck it is composited into. */
const CLOUD_DETAIL_SCALE = 0.5;
// Detail-octave lattice, per deck. Four times the base lattice once the half
// size sheet is tiled twice across the deck, which is the frequency step a
// second octave wants; going finer puts the smallest noise cell under four
// texels and the sheet starts aliasing against its own sampler.
const CLOUD_DETAIL_LATTICE = Object.freeze([14, 12]);
const CLOUD_DETAIL_OCTAVES = 3;
/** Mixed into the deck seed so the detail octave is not a copy of the base. */
const CLOUD_DETAIL_SEED = 0x9e37;
// How hard the detail octave breaks up the deck's edge.
//
// Applied through a `4*a*(1-a)` window, which is zero at both ends and 1 in
// the middle, so the detail lands entirely on the fringe: a solid overcast
// stays solid, open sky stays open, and the coverage-weighted mean is
// unchanged because the field is symmetric about 0.5 and the swing can never
// clip. A plain multiply was tried first and is wrong for exactly that
// reason - it clips against alpha 1 on the bright side only, and thinned the
// fog bucket's deck from 0.97 to 0.82 mean alpha, which is not fog.
//
// 0.25 is the largest value the window admits without clipping anywhere
// (`4*e*a*(1-a) <= min(a, 1-a)` for every a requires `e <= 0.25`), and it
// swings the fringe by +/-0.25 alpha at the deck's own half-cover contour.
const CLOUD_DETAIL_EROSION = 0.25;
/** Peak-to-peak relief the detail octave adds to the shading term. */
const CLOUD_DETAIL_RELIEF = 0.35;
// Base darkening. A cumulus is bright where it is thin and dark where it is
// thick, because the light reaching the underside has been scattered through
// more water on the way. Round 3's sheet carried a -0.30*density term inside
// the bake and still read as uniform white at deck scale; this is the same
// idea at deck scale, keyed on the deck's own coverage rather than on the
// noise, and written as a *multiplier* rather than a subtraction so it darkens
// the thick interior in proportion instead of crushing the whole sheet toward
// black and then needing a large gain to climb back out.
const CLOUD_BASE_DARKEN = 0.35;
const DITHER_TEXTURE_SIZE = 64;
// Chosen so the pattern lands at roughly one texel per two screen pixels at the
// capture's 47 deg field of view: the dome's u spans 360 deg, the frame sees
// about a fifth of it, so 64 repeats put 64 x 64 / 5 = 820 texels across 1600 px.
const DITHER_REPEAT = 64;
// Peak-to-peak dither amplitude, in display steps. Measured against a
// simulated shallow sky gradient: undithered it renders in runs of 113 pixels
// at one luma value, at 1.4 steps the worst run falls to 20, and at 2.0 it
// falls to 8. Two steps is also the textbook amplitude for fully decorrelating
// the quantisation error, and 2/255 of full scale is not visible as grain.
const DITHER_STEPS = 2.0;
const MAX_CONTACT_BUILDINGS = 1200;
const MAX_CONTACT_EDGES = 48;
// Hard ceiling on the merged contact mesh. 1200 buildings at 48 edges each
// would be 115k triangles - twice the declared budget - so the cap is on the
// total, not on the per-building edge count.
const MAX_CONTACT_QUADS = 14000;
const MAX_PUDDLES = 360;
// Contact band width, in metres. This number is no longer chosen; it is read
// off the shadow map.
//
// Round 3 shipped a 3.6 m skirt, mitred out to 9.4 m at a sharp corner, at a
// fixed 0.55 alpha that never moved with the sun. The round-4 key-off pair
// measures exactly what that produced. On the near footway of `01-street-day`,
// at row 760, the frame steps from 210 to 171 across x=1330 with the key ON,
// and from 71.5 to 38 at the same pixel with the key OFF. Inverting the
// display transform, the key contributes 0.572 radiance on the bright side and
// 0.291 on the dark side while the fill contributes 0.075 and 0.035: BOTH are
// scaled by 0.50, which is an alpha-0.5 black quad composited in linear space,
// and it is exactly `CONTACT_ALPHA`. The same boundary is at the same pixel in
// `06-night-street`, where there is no sun at all to justify it.
//
// A skirt that wide is not ambient occlusion in the first place. For a wall of
// height h, infinite in length, the cosine-weighted sky occlusion at ground
// distance d is (1/2) h^2 / (h^2 + d^2): 0.500 at the wall, 0.484 at 3.6 m
// from a 20 m wall. Wall AO does not fall off across a footway - it is a broad
// canyon term, and this pass already delivers that through the light rig
// (`canyonBounce`, `keyFillBalance`). Painting a band on top double-counts it.
//
// What a shadow map genuinely cannot deliver is the first few centimetres at
// the contact line, and `contactShadowLeakMetres()` in ../shadow-casters.js
// says how many: the depth pull-back that keeps the map free of acne erases
// `depthPullback / sin(altitude)` metres of shadow at every contact. On the
// shipped fit that is 0.277 m (round-3 diagnostics: `contactLeakMetres`). So
// the band is that wide and no wider - it fills in precisely what the bias
// plan erased, which is the one darkening on this ground that nothing else in
// the stack is producing.
const CONTACT_WIDTH = 0.28;
// Mitre clamp. At 3.6 m the old 2.6x clamp could throw a 9.4 m wedge across a
// footway from one needle-sharp corner, which is the wedge the round-3 review
// recorded. At 0.28 m the same 2.6x is 0.73 m, but there is no reason to let a
// crevice line widen at all beyond keeping the offset edge parallel, so it is
// tightened here too.
const CONTACT_MITRE_CLAMP = 1.5;
// Alpha at the junction itself, falling to zero over CONTACT_WIDTH. Kept at
// the round-3 value: a crevice line IS nearly black at its root, and what made
// the old skirt wrong was its width and its constancy, not its peak.
const CONTACT_ALPHA = 0.55;
// Half-height of the under-canopy AO patch, in metres. A shopfront canopy
// really does occlude the sky over the pavement it covers, so this one is
// legitimate ambient occlusion; the round-3 version was simply at a fixed
// strength day and night.
const CANOPY_AO_ALPHA = 0.55;

// --- grounding (sun-tracked projected contact shadows)
//
// Capacity of the merged grounding mesh, in quads. 1024 quads is 2048
// triangles against a 48000 budget and 12288 floats rewritten per frame, which
// is the same order as one instanced batch's matrix upload. The round-3 scene
// reported 340 candidate meshes of which 165 were refused as sub-texel;
// expanded per instance - a batch is one flag standing in for hundreds of
// trees, lamps and people - the real population is in the low thousands, so
// this is a cap that bites and `collectGroundingAnchors` allocates it
// round-robin across sources so no single batch eats it.
const MAX_GROUNDING_ANCHORS = 1024;
// Clearance above the surface the object stands on, in metres. Larger than the
// contact band's 0.035 because the quad reaches up to 26 m from the point
// whose height it was measured at, and it must not submarine through a
// pavement it is a few centimetres above. Still an order under the 0.15 m kerb
// face, so a shadow on the footway cannot float over the kerb.
const GROUNDING_LIFT = 0.06;
const GROUNDING_MASK_SIZE = 64;
// Frames after the world build at which the anchor set is re-collected.
//
// This pass is `order: 10`. Street furniture, vehicles and the crowd are
// orders 40-60 and the crowd is built lazily some frames later still, so at
// `build()` time none of the objects this feature exists for are in the scene
// yet. Collecting on the first update catches the passes; the later two catch
// lazily built content. Three traversals total, then it settles - a scan is a
// `Box3` per mesh and is not something to run on a timer.
const GROUNDING_COLLECT_FRAMES = Object.freeze([2, 60, 300, 900]);

// --- ground-level practicals
//
// Clearance for the additive light patches, in metres. Round 3 used 0.025 and
// the ground under every lamp in the round-4 night card is neutral, i.e. the
// patches are not in the frame at all (see `quadSink.patch`). 0.12 m is the
// largest lift that still cannot let a pool on the footway float clear of the
// 0.15 m kerb face and appear over the carriageway, and it is an order more
// than any datum disagreement this pass can have with a junction pad, a
// footway crossfall or a slab the street-surface passes lay on top.
//
// A floating ADDITIVE patch is not the artifact a floating opaque one is:
// there is nothing to see behind it, only light arriving slightly nearer the
// viewer than the tarmac it belongs to.
const POOL_LIFT = 0.12;
// Grid resolution for the conforming patches. 4 x 4 puts a vertex every 5.8 m
// across a 23 m pool, which tracks a smooth terrain heightfield to within
// millimetres, and holds the whole practicals set inside the triangle budget:
// 240 lamps x 16 quads x 2 sinks is 15360 triangles.
const POOL_GRID = 4;
const SPILL_GRID = 2;

const DEG = Math.PI / 180;
const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const finite = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};
const luminanceOf = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

// Elevation the fog colour is sampled at. Deliberately the same +2 deg the
// model's own horizon probes use, so the sample and the ceiling it is clamped
// against are the same measurement taken in different directions.
const SKYLINE_ELEVATION_DEG = 2;
const SKYLINE_SIN = Math.sin(SKYLINE_ELEVATION_DEG * DEG);
const SKYLINE_COS = Math.cos(SKYLINE_ELEVATION_DEG * DEG);

/** The one live build. `dispose()` clears it; `build()` replaces it. */
let live = null;

// ---------------------------------------------------------------- textures

/** Wrap RGBA bytes in a `DataTexture` with sane sampler state. @private */
function byteTexture(data, width, height, { name, wrap = ClampToEdgeWrapping, srgb = false } = {}) {
  const texture = new DataTexture(data, width, height, RGBAFormat);
  texture.name = name || 'sky-atmosphere-texture';
  texture.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace;
  texture.wrapS = wrap;
  texture.wrapT = wrap;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Radial alpha sprite: white RGB, alpha falling from the centre by `power`.
 * Used for the solar disc, the solar aureole, lamp pools and under-vehicle
 * darkening, so one generator covers four cues.
 * @private
 */
function radialAlphaTexture(size, power, core = 0) {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      const dx = (i - centre) / centre;
      const dy = (j - centre) / centre;
      const r = Math.hypot(dx, dy);
      let a = r >= 1 ? 0 : Math.pow(1 - r, power);
      if (core > 0 && r < core) a = 1;
      const o = (j * size + i) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  return { data, width: size, height: size };
}

/**
 * Radial mask with the falloff written into RGB *and* alpha.
 *
 * `radialAlphaTexture` puts the falloff only in the alpha channel, which is
 * right for a `map` (three multiplies `diffuseColor.a` by `map.a`) and wrong
 * for an `alphaMap`: `MaterialNode`'s OPACITY scope multiplies opacity by the
 * alpha texture coerced to a float, which takes the RED channel, and the
 * classic path takes green. Round 2's puddles used `radialAlphaTexture` as an
 * `alphaMap`, so every texel read 1.0 and each puddle was a hard-edged square
 * at full opacity rather than a soft pool.
 * @private
 */
function radialMaskTexture(size, power, core = 0) {
  const source = radialAlphaTexture(size, power, core);
  const { data } = source;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    data[i] = a;
    data[i + 1] = a;
    data[i + 2] = a;
    data[i + 3] = 255;
  }
  return source;
}

/**
 * Tileable dither pattern, centred on mid grey.
 *
 * Banding is an output-quantisation artifact and cannot be fixed by adding
 * geometry or resolution: a gradient whose scene value changes by less than one
 * display step across many pixels renders as a flat band with a hard contour at
 * each step. Round 2's night sky measured single-luma runs of 19, 23 and 33
 * pixels stepping by exactly 1 - the textbook signature. This is the noise that
 * breaks those contours into pixel noise the eye integrates away. Its amplitude
 * is set per retime from `displayStepScene`, not baked in here, because one
 * display step is 3.2% of the scene value in the night sky and 1.4% at midday.
 * @private
 */
function ditherTexture(size, seed) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    // Hash-based white noise. Blue noise would be marginally less grainy, but
    // at one display step of amplitude the difference is not measurable.
    const value = Math.round(hash01(i * 2654435761 + seed) * 255);
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return { data, width: size, height: size };
}

/**
 * One-dimensional alpha ramp, `size` texels wide and one tall.
 * `alphaAt(t)` receives 0..1 across the ramp.
 * @private
 */
function rampTexture(size, alphaAt) {
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i += 1) {
    const t = size > 1 ? i / (size - 1) : 0;
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = Math.round(clamp(alphaAt(t), 0, 1) * 255);
  }
  return { data, width: size, height: 1 };
}

// ---------------------------------------------------------------- geometry

/**
 * A disc that curves down toward its rim, so the far edge of a cloud deck
 * meets the horizon instead of ending in a hard circular cut. Vertices carry
 * world-metre UVs, which is what lets the deck be re-centred on the camera
 * every frame while the texture stays anchored to the world.
 * @private
 */
function skyPlateGeometry(radius, altitude, segments, rings, tileMetres) {
  const vertexCount = (rings + 1) * (segments + 1);
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    // Squared ring spacing puts the resolution where the perspective needs it.
    const t = (ring / rings) ** 1.7;
    const r = t * radius;
    // Drop toward the horizon: at the rim the deck is at 8% of its altitude.
    const y = altitude * (1 - 0.92 * t * t);
    for (let seg = 0; seg <= segments; seg += 1) {
      const phi = (seg / segments) * Math.PI * 2;
      const index = ring * (segments + 1) + seg;
      const x = Math.cos(phi) * r;
      const z = Math.sin(phi) * r;
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
      uvs[index * 2] = x / tileMetres;
      uvs[index * 2 + 1] = z / tileMetres;
    }
  }
  for (let ring = 0; ring < rings; ring += 1) {
    for (let seg = 0; seg < segments; seg += 1) {
      const a = ring * (segments + 1) + seg;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Open cylinder wall for the ground haze band, UV-mapped so `v` runs 0 at the
 * ground to 1 at the top of the band. Two-sided, because the player can stand
 * inside it or look down on it from a roof.
 * @private
 */
function hazeWallGeometry(radius, height, segments, rings) {
  const vertexCount = (rings + 1) * (segments + 1);
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const v = ring / rings;
    const y = v * height;
    for (let seg = 0; seg <= segments; seg += 1) {
      const phi = (seg / segments) * Math.PI * 2;
      const index = ring * (segments + 1) + seg;
      positions[index * 3] = Math.cos(phi) * radius;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = Math.sin(phi) * radius;
      uvs[index * 2] = seg / segments;
      uvs[index * 2 + 1] = v;
    }
  }
  for (let ring = 0; ring < rings; ring += 1) {
    for (let seg = 0; seg < segments; seg += 1) {
      const a = ring * (segments + 1) + seg;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Accumulator for the flat, ground-hugging quad sets (contact darkening, light
 * pools, spill, puddles). Every one of them is the same shape - four corners,
 * a UV rectangle, one merged draw call - so they share this.
 * @private
 */
function quadSink() {
  const positions = [];
  const uvs = [];
  const indices = [];
  return {
    get count() { return indices.length / 6; },
    /** Axis-aligned rectangle centred on (x, z), size (w, d), rotated by `rot`. */
    rect(x, y, z, w, d, rot = 0, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const hw = w / 2;
      const hd = d / 2;
      const base = positions.length / 3;
      const corner = (ox, oz) => positions.push(x + ox * c - oz * s, y, z + ox * s + oz * c);
      corner(-hw, -hd);
      corner(hw, -hd);
      corner(hw, hd);
      corner(-hw, hd);
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    },
    /**
     * Terrain-conforming rectangle: an `cells` x `cells` grid whose every
     * vertex is placed by `surfaceY`, with UVs still spanning 0..1 over the
     * whole rectangle so a radial mask lands exactly as it would on one quad.
     *
     * This exists because a light pool is 23 m across and a flat quad 25 mm
     * above the pavement only clears it where the ground is level. Round 4's
     * night card is the evidence: the pass builds 240 lamp pools and 240
     * carriageway throws at full opacity with a colour calibrated to 82 and 72
     * display steps, the bulb glows from the SAME material family and the same
     * additive blending are plainly visible in the frame at their fixture
     * height - and the ground under every one of them samples neutral
     * (77,68,75 / 79,71,79 / 75,68,77 at the plaza; a 3000 K pool is
     * 1 : 0.71 : 0.39). Light that is calibrated, built, visible in the air and
     * absent on the ground is light that failed the depth test.
     */
    patch(x, z, w, d, rot, cells, surfaceY) {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const n = Math.max(1, Math.floor(cells));
      const base = positions.length / 3;
      for (let j = 0; j <= n; j += 1) {
        const v = j / n;
        const oz = (v - 0.5) * d;
        for (let i = 0; i <= n; i += 1) {
          const u = i / n;
          const ox = (u - 0.5) * w;
          const px = x + ox * c - oz * s;
          const pz = z + ox * s + oz * c;
          positions.push(px, surfaceY(px, pz), pz);
          uvs.push(u, v);
        }
      }
      for (let j = 0; j < n; j += 1) {
        for (let i = 0; i < n; i += 1) {
          const a = base + j * (n + 1) + i;
          const b = a + n + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    },
    /** Free quad from four explicit corners, with explicit UVs. */
    quad(a, b, c, d, uvA, uvB, uvC, uvD) {
      const base = positions.length / 3;
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
      uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1], uvD[0], uvD[1]);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    },
    build(name) {
      if (!indices.length) return null;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      geometry.name = name;
      return geometry;
    },
  };
}

// ---------------------------------------------------------------- helpers

/** Signed area of a polygon in XZ. Positive means counter-clockwise. @private */
function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

/** Deterministic 32-bit hash of a string. @private */
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const hash01 = (value) => {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

/** Set a `Color` from a linear-RGB triple without an sRGB decode. @private */
function setLinear(color, rgb, scale = 1) {
  color.setRGB(
    Math.max(0, rgb[0] * scale),
    Math.max(0, rgb[1] * scale),
    Math.max(0, rgb[2] * scale),
    LinearSRGBColorSpace,
  );
  return color;
}

/**
 * Vertical datums of the paved surface.
 *
 * This is the single most expensive thing round 1 got wrong. Every ground
 * decal this pass builds was placed at `ctx.heightAt(x, z)`, which is the
 * *terrain* height - but the renderer builds the carriageway at
 * `terrain + streetDesign.roadLift` (0.5 m) and `street-surface-v2` builds the
 * footway a further `curbFaceHeight - gutterDepth` (0.12 m) above that. So
 * every light pool, every contact skirt and every under-vehicle patch was
 * buried 0.5-0.62 m under the pavement, depth-tested away, and invisible. The
 * night card's missing practicals are entirely this.
 *
 * The formulas are the renderer's own: see `renderer.js` ("carriageway datum =
 * terrain + city.meta.streetDesign.roadLift") and `curbTopY()` in
 * `street-surface-v2.js`.
 * @private
 */
function pavedDatum(city) {
  const design = city?.meta?.streetDesign || {};
  const roadLift = finite(design.roadLift, 0.5);
  const gutterDepth = finite(design.gutterDepth, 0.03);
  const curbFaceHeight = finite(design.curbFaceHeight, 0.15);
  const crossSlope = finite(design.crossSlope, 0.02);
  const gutterWidth = finite(design.gutterWidth, 0.45);
  return {
    roadLift,
    footwayLift: roadLift - gutterDepth + curbFaceHeight,
    gutterDepth,
    curbFaceHeight,
    crossSlope,
    gutterWidth,
    /**
     * Carriageway surface height at lateral offset `u` from the centreline, a
     * direct port of `crossSectionY` in `street-surface-v2.js`.
     *
     * Round 2 placed puddles at `datum + 0.012` and forgot that the road is
     * crowned: at the centreline the surface is `datum + crossSlope * half`,
     * which on a 12 m street is 0.12 m and on a 30 m street 0.30 m. Every
     * puddle was under the tarmac, which is why the drizzle card shows no
     * standing water at all.
     */
    crossSectionY(terrainY, u, half) {
      const datum = terrainY + roadLift;
      const a = Math.min(Math.abs(u), half);
      const crown = crossSlope * half;
      const gutterStart = Math.max(0, half - gutterWidth);
      if (a <= gutterStart) return datum + crown * (1 - a / half);
      const lip = datum + crown * (1 - gutterStart / half);
      const invert = datum - gutterDepth;
      const t = (a - gutterStart) / Math.max(1e-6, half - gutterStart);
      return lip + (invert - lip) * t;
    },
    /** Highest point of the carriageway for a given width: the crown. */
    crownY(terrainY, half) {
      return terrainY + roadLift + crossSlope * half;
    },
  };
}

/**
 * Nearest street to a point, with its direction and width.
 *
 * A street lamp is not a point source over its own base: the head sits on an
 * outreach arm and the distribution is deliberately thrown across the road,
 * which is the only reason a carriageway is lit at all. To place that throw
 * this pass has to know which way the road is from each fixture, so the street
 * contract is indexed once per build and queried per lamp.
 * @private
 */
function streetIndex(city, cell = 26) {
  const grid = new Map();
  const segments = Array.isArray(city?.segments) ? city.segments : [];
  const put = (cx, cz, index) => {
    const key = `${cx}:${cz}`;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    if (!bucket.includes(index)) bucket.push(index);
  };
  for (let i = 0; i < segments.length; i += 1) {
    const points = segments[i]?.points;
    if (!Array.isArray(points) || points.length < 2) continue;
    for (let k = 0; k < points.length - 1; k += 1) {
      const ax = finite(points[k]?.x, NaN);
      const az = finite(points[k]?.z, NaN);
      const bx = finite(points[k + 1]?.x, NaN);
      const bz = finite(points[k + 1]?.z, NaN);
      if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
      const length = Math.hypot(bx - ax, bz - az);
      const steps = Math.min(40, Math.max(1, Math.ceil(length / cell)));
      for (let t = 0; t <= steps; t += 1) {
        const f = t / steps;
        put(Math.floor((ax + (bx - ax) * f) / cell), Math.floor((az + (bz - az) * f) / cell), i);
      }
    }
  }
  return {
    cells: grid.size,
    /** @returns {{distance:number,x:number,z:number,dx:number,dz:number,half:number}|null} */
    query(x, z) {
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      let best = null;
      for (let ix = -1; ix <= 1; ix += 1) {
        for (let iz = -1; iz <= 1; iz += 1) {
          const bucket = grid.get(`${cx + ix}:${cz + iz}`);
          if (!bucket) continue;
          for (const index of bucket) {
            const segment = segments[index];
            const points = segment.points;
            for (let k = 0; k < points.length - 1; k += 1) {
              const ax = points[k].x;
              const az = points[k].z;
              const ex = points[k + 1].x - ax;
              const ez = points[k + 1].z - az;
              const lengthSq = ex * ex + ez * ez;
              if (!(lengthSq > 1e-6)) continue;
              const t = clamp(((x - ax) * ex + (z - az) * ez) / lengthSq, 0, 1);
              const px = ax + ex * t;
              const pz = az + ez * t;
              const distance = Math.hypot(x - px, z - pz);
              if (!best || distance < best.distance) {
                const length = Math.sqrt(lengthSq);
                best = {
                  distance,
                  x: px,
                  z: pz,
                  dx: ex / length,
                  dz: ez / length,
                  half: clamp(finite(segment.width, 8), 3, 40) * 0.5,
                };
              }
            }
          }
        }
      }
      return best;
    },
  };
}

/**
 * Coarse "is this point on paved ground" test.
 *
 * A building fronting a street stands next to a footway 0.62 m above the
 * terrain; a building in the middle of a block stands on the ground carpet at
 * terrain height. Putting every contact skirt at the footway datum would leave
 * a dark ring floating over back yards, which is a worse artifact than the one
 * being fixed. A cell grid over the street contract answers the question in
 * one Set lookup and costs one pass over the segments at build.
 * @private
 */
function streetProximity(city, cell = 12) {
  const cells = new Set();
  const segments = Array.isArray(city?.segments) ? city.segments : [];
  for (const segment of segments) {
    const points = segment?.points;
    if (!Array.isArray(points) || points.length < 2) continue;
    const reach = clamp(finite(segment.width, 8) * 0.5 + 5, 4, 40);
    const rings = Math.min(2, Math.max(1, Math.ceil(reach / cell)));
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const ax = finite(a?.x, NaN);
      const az = finite(a?.z, NaN);
      const bx = finite(b?.x, NaN);
      const bz = finite(b?.z, NaN);
      if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
      const length = Math.hypot(bx - ax, bz - az);
      const steps = Math.min(48, Math.max(1, Math.ceil(length / (cell * 0.5))));
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const cx = Math.floor((ax + (bx - ax) * t) / cell);
        const cz = Math.floor((az + (bz - az) * t) / cell);
        for (let ix = -rings; ix <= rings; ix += 1) {
          for (let iz = -rings; iz <= rings; iz += 1) cells.add(`${cx + ix}:${cz + iz}`);
        }
      }
    }
  }
  return {
    cells: cells.size,
    near: (x, z) => cells.has(`${Math.floor(x / cell)}:${Math.floor(z / cell)}`),
  };
}

/** Largest of the map's X/Z extents, or a sane default. @private */
function mapSpanOf(city) {
  const bounds = city?.meta?.bounds;
  if (!bounds) return 2000;
  const span = Math.max(
    finite(bounds.maxX, 0) - finite(bounds.minX, 0),
    finite(bounds.maxZ, 0) - finite(bounds.minZ, 0),
  );
  return span > 1 ? span : 2000;
}

// ---------------------------------------------------------------- build parts

/**
 * The visible sky: a vertex-coloured dome, a solar disc with its aureole, a
 * stylised moon, and a star field.
 *
 * The dome is vertex-coloured rather than textured on purpose. A 1024x512
 * equirect panorama costs about 150 ms to bake, and the clock runs a full day
 * in forty seconds, so a per-bucket re-bake would be a visible hitch four
 * times a second. Recolouring 1107 vertices from the same pure model costs
 * about a millisecond and the gradient interpolates cleanly, because a sky is
 * exactly the low-frequency signal Gouraud interpolation is good at. The sun
 * is the one high-frequency feature, so it is separate geometry.
 * @private
 */
function buildSky(radius) {
  const group = new Group();
  group.name = 'sky-atmosphere:sky';

  const domeGeometry = new SphereGeometry(radius, DOME_SEGMENTS, DOME_RINGS);
  const vertexCount = domeGeometry.getAttribute('position').count;
  domeGeometry.setAttribute('color', new BufferAttribute(new Float32Array(vertexCount * 3), 3));
  const domeMaterial = new MeshBasicMaterial({
    vertexColors: true,
    side: BackSide,
    fog: false,
    depthWrite: false,
  });
  const dome = new Mesh(domeGeometry, domeMaterial);
  dome.name = 'sky-atmosphere:dome';
  // Later than the legacy dome's -10 so this one wins wherever both survive,
  // and still before every opaque surface in the world.
  dome.renderOrder = -9;
  dome.frustumCulled = false;
  group.add(dome);

  const glowSource = radialAlphaTexture(64, 2.6);
  const glowTexture = byteTexture(glowSource.data, 64, 64, { name: 'sky-atmosphere:sun-glow' });
  const glowMaterial = new MeshBasicMaterial({
    map: glowTexture,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  const glowSize = radius * 0.62;
  const glow = new Mesh(skyBillboardGeometry(glowSize), glowMaterial);
  glow.name = 'sky-atmosphere:sun-glow';
  glow.renderOrder = -8;
  glow.frustumCulled = false;
  group.add(glow);

  const discSource = radialAlphaTexture(64, 3.2, 0.34);
  const discTexture = byteTexture(discSource.data, 64, 64, { name: 'sky-atmosphere:sun-disc' });
  const discMaterial = new MeshBasicMaterial({
    map: discTexture,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  const disc = new Mesh(skyBillboardGeometry(radius * 0.045), discMaterial);
  disc.name = 'sky-atmosphere:sun-disc';
  disc.renderOrder = -7;
  disc.frustumCulled = false;
  group.add(disc);

  // The moon is a stylised placement, not an ephemeris: it is put on the
  // anti-solar azimuth at the altitude the renderer's night key already uses,
  // so the disc the player sees and the direction the night shadows run agree.
  // Calling it a lunar position would be a claim this module cannot support.
  const moonMaterial = new MeshBasicMaterial({
    map: discTexture,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  const moon = new Mesh(skyBillboardGeometry(radius * 0.05), moonMaterial);
  moon.name = 'sky-atmosphere:moon';
  moon.renderOrder = -7;
  moon.frustumCulled = false;
  group.add(moon);

  // Dither shell. Sits just inside the dome, additive, and is the only thing
  // that can break 8-bit contouring without a post-processing stage: the
  // banding is created by the output quantisation, so it has to be attacked at
  // pixel frequency, which no amount of dome tessellation reaches.
  const ditherSource = ditherTexture(DITHER_TEXTURE_SIZE, 0x5eed);
  const ditherTex = byteTexture(ditherSource.data, DITHER_TEXTURE_SIZE, DITHER_TEXTURE_SIZE, {
    name: 'sky-atmosphere:dither',
    wrap: RepeatWrapping,
  });
  ditherTex.repeat.set(DITHER_REPEAT, DITHER_REPEAT / 2);
  const ditherMaterial = new MeshBasicMaterial({
    map: ditherTex,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: BackSide,
    fog: false,
    opacity: 1,
  });
  const dither = new Mesh(new SphereGeometry(radius * 0.998, 24, 12), ditherMaterial);
  dither.name = 'sky-atmosphere:dither';
  dither.renderOrder = -4;
  dither.frustumCulled = false;
  group.add(dither);

  const stars = starField(STAR_COUNT, { seed: 11, minAltitudeDeg: 1.5 });
  const starPositions = new Float32Array(stars.count * 3);
  const starColors = new Float32Array(stars.count * 3);
  for (let i = 0; i < stars.count; i += 1) {
    const r = radius * 0.985;
    starPositions[i * 3] = stars.positions[i * 3] * r;
    starPositions[i * 3 + 1] = stars.positions[i * 3 + 1] * r;
    starPositions[i * 3 + 2] = stars.positions[i * 3 + 2] * r;
    const magnitude = stars.magnitudes[i];
    starColors[i * 3] = stars.colors[i * 3] * magnitude;
    starColors[i * 3 + 1] = stars.colors[i * 3 + 1] * magnitude;
    starColors[i * 3 + 2] = stars.colors[i * 3 + 2] * magnitude;
  }
  const starGeometry = new BufferGeometry();
  starGeometry.setAttribute('position', new BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('color', new BufferAttribute(starColors, 3));
  starGeometry.computeBoundingSphere();
  const starSource = radialAlphaTexture(16, 2.2);
  const starTexture = byteTexture(starSource.data, 16, 16, { name: 'sky-atmosphere:star' });
  const starMaterial = new PointsMaterial({
    size: 2.4,
    sizeAttenuation: false,
    vertexColors: true,
    map: starTexture,
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: AdditiveBlending,
    opacity: 0,
  });
  const starPoints = new Points(starGeometry, starMaterial);
  starPoints.name = 'sky-atmosphere:stars';
  starPoints.renderOrder = -8;
  starPoints.frustumCulled = false;
  group.add(starPoints);

  return {
    group,
    dome,
    domeGeometry,
    domeMaterial,
    disc,
    discMaterial,
    glow,
    glowMaterial,
    moon,
    moonMaterial,
    starPoints,
    starMaterial,
    dither,
    ditherMaterial,
    textures: [glowTexture, discTexture, starTexture, ditherTex],
    radius,
  };
}

const _aimQuaternion = new Quaternion();
const _aimFrom = new Vector3(0, 0, 1);
const _aimTo = new Vector3();

/**
 * Point a billboard's +Z face back at the dome centre.
 *
 * `Object3D.lookAt` reads `matrixWorld`, which is one frame stale during a
 * build and wrong the moment the sky group is re-centred on the camera. The
 * direction wanted here is purely local - a plane at `dir * R` faces `-dir` -
 * so it is set directly and is invariant to wherever the group ends up.
 * @private
 */
function aimAtCentre(object, dir) {
  _aimTo.set(-dir.x, -dir.y, -dir.z).normalize();
  object.quaternion.copy(_aimQuaternion.setFromUnitVectors(_aimFrom, _aimTo));
}

/** A square in the XY plane, centred on the origin, ready to be re-aimed. @private */
function skyBillboardGeometry(size) {
  const half = size / 2;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    -half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0,
  ]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Two cloud decks at different altitudes.
 *
 * The decks are re-centred on the camera every frame but their UVs are in
 * world metres and are offset by the camera position, so the texture stays
 * anchored to the world while the geometry never leaves the frustum. Because
 * the two decks divide the camera offset by different tile sizes they slide
 * against each other exactly as two real decks at 620 m and 1900 m would - the
 * parallax is a property of the offset arithmetic, not an animation.
 * @private
 */
function bakeCloudSheet(index, spec, coverage) {
  const size = index === 0 ? CLOUD_TEXTURE_SIZE : Math.round(CLOUD_TEXTURE_SIZE * CLOUD_HIGH_SCALE);
  const detailSize = Math.round(size * CLOUD_DETAIL_SCALE);
  // The deck's own shape: which parts of the sky have cloud in them at all.
  const base = renderCloudSheet({
    size,
    lattice: index === 0 ? 8 : 6,
    seed: spec.seed,
    coverage,
    softness: index === 0 ? 0.30 : 0.42,
    octaves: 5,
  });
  // The second octave. Baked at coverage 0.5 with a full-width shoulder on
  // purpose: that turns `renderCloudSheet`'s coverage threshold into a ramp
  // across the whole shaped range, so the alpha channel comes back as a
  // continuous 0..1 detail *field* rather than as a second set of hard-edged
  // cells that would fight the deck's own silhouette.
  const detail = renderCloudSheet({
    size: detailSize,
    lattice: CLOUD_DETAIL_LATTICE[index] || CLOUD_DETAIL_LATTICE[0],
    seed: (spec.seed ^ CLOUD_DETAIL_SEED) >>> 0,
    coverage: 0.5,
    softness: 0.9,
    octaves: CLOUD_DETAIL_OCTAVES,
  });

  const texels = size * size;
  const data = new Uint8Array(texels * 4);
  const relief = new Float32Array(texels);
  const alpha = new Float32Array(texels);
  const inv255 = 1 / 255;
  // Coverage-weighted moments of the deck before and after the composite. The
  // gain below holds the first moment fixed so this change adds structure
  // without also changing how bright the deck is - a brightness change here
  // would be an uncontrolled exposure change in the top half of every frame.
  let baseWeight = 0;
  let baseShadeSum = 0;
  let baseShadeSq = 0;
  let outWeight = 0;
  let outReliefSum = 0;
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      const index2 = j * size + i;
      const o = index2 * 4;
      const bs = base.data[o] * inv255;
      const ba = base.data[o + 3] * inv255;
      baseWeight += ba;
      baseShadeSum += bs * ba;
      baseShadeSq += bs * bs * ba;
      // Wind shear, done in whole texels so the composite still tiles.
      //
      // The detail sheet is half the deck's edge, so it repeats twice across
      // it; `+ j` slides it one texel per row (a 45 deg lean over the sheet,
      // an exact number of detail periods over the deck's height) and `j >> 1`
      // stretches it 2:1 along that lean. The result is a fibrous, leaning
      // grain instead of the isotropic blobs a second fBm would give, and
      // every offset is an integer multiple of the detail period at the deck's
      // own wrap, so the seam is still exactly as continuous as the base.
      const du = (i + j) % detailSize;
      const dv = (j >> 1) % detailSize;
      const d = (dv * detailSize + du) * 4;
      const ds = detail.data[d] * inv255;
      const df = detail.data[d + 3] * inv255;
      // Coverage: the detail field breaks up the deck's edge. See
      // CLOUD_DETAIL_EROSION - the `4*ba*(1-ba)` window is what keeps a solid
      // overcast solid and holds the deck's mean coverage exactly.
      const a = clamp(ba + CLOUD_DETAIL_EROSION * 4 * ba * (1 - ba) * (2 * df - 1), 0, 1);
      // Thickness at deck scale, from the deck's own coverage rather than from
      // the noise, so the darkening tracks the silhouette the player reads.
      const thick = smoothstep(0.25, 0.95, ba);
      const s = bs * (1 - CLOUD_BASE_DARKEN * thick) + CLOUD_DETAIL_RELIEF * (ds - 0.5);
      relief[index2] = s;
      alpha[index2] = a;
      outWeight += a;
      outReliefSum += s * a;
    }
  }
  const baseShadeMean = baseWeight > 0 ? baseShadeSum / baseWeight : 0;
  const baseShadeVar = baseWeight > 0 ? Math.max(0, baseShadeSq / baseWeight - baseShadeMean * baseShadeMean) : 0;
  const outReliefMean = outWeight > 0 ? outReliefSum / outWeight : 0;
  const gain = outReliefMean > 1e-4 && baseShadeMean > 1e-4
    ? clamp(baseShadeMean / outReliefMean, 0.5, 2)
    : 1;
  let shadeSum = 0;
  let shadeSq = 0;
  let clipped = 0;
  let coveredTexels = 0;
  for (let index2 = 0; index2 < texels; index2 += 1) {
    const a = alpha[index2];
    const s = clamp(relief[index2] * gain, 0, 1);
    if (a > 0.02) {
      coveredTexels += 1;
      if (s <= 0 || s >= 1) clipped += 1;
    }
    shadeSum += s * a;
    shadeSq += s * s * a;
    const o = index2 * 4;
    const byte = Math.round(s * 255);
    data[o] = byte;
    data[o + 1] = byte;
    data[o + 2] = byte;
    data[o + 3] = Math.round(a * 255);
  }
  const shadeMean = outWeight > 0 ? shadeSum / outWeight : 0;
  const shadeVar = outWeight > 0 ? Math.max(0, shadeSq / outWeight - shadeMean * shadeMean) : 0;
  // High-frequency energy: the mean absolute step to the next texel across and
  // down, coverage-weighted, on the sheet's own grid. Deviation alone would
  // rise from any large soft blob; this rises only if the sheet actually
  // carries detail at texel scale, which is the thing a 256 sheet stretched
  // over a 360 deg dome could not do. Reported for the base and the composite
  // in the SAME units, so the ratio is the structure that was gained.
  const clippedShareOf = (bytes, edge) => {
    let hit = 0;
    let covered = 0;
    for (let o = 0; o < bytes.length; o += 4) {
      if (bytes[o + 3] <= 5) continue;
      covered += 1;
      if (bytes[o] <= 0 || bytes[o] >= 255) hit += 1;
    }
    return covered > 0 ? hit / covered : 0;
  };
  const detailEnergy = (bytes, edge) => {
    let sum = 0;
    let weight = 0;
    for (let j = 0; j < edge; j += 1) {
      for (let i = 0; i < edge; i += 1) {
        const o = (j * edge + i) * 4;
        const a = bytes[o + 3] / 255;
        if (a <= 0.02) continue;
        const right = ((j * edge) + (i + 1) % edge) * 4;
        const down = ((((j + 1) % edge) * edge) + i) * 4;
        sum += a * (Math.abs(bytes[o] - bytes[right]) + Math.abs(bytes[o] - bytes[down])) / (2 * 255);
        weight += a;
      }
    }
    return weight > 0 ? sum / weight : 0;
  };
  const round4 = (value) => Math.round(value * 10000) / 10000;
  return {
    width: size,
    height: size,
    data,
    stats: {
      size,
      detailSize,
      detailLattice: CLOUD_DETAIL_LATTICE[index] || CLOUD_DETAIL_LATTICE[0],
      detailOctaves: CLOUD_DETAIL_OCTAVES,
      gain: round4(gain),
      /** Coverage-weighted mean shade. Held equal to the base sheet's. */
      baseShadeMean: round4(baseShadeMean),
      shadeMean: round4(shadeMean),
      /** Coverage-weighted shade spread. */
      baseShadeDeviation: round4(Math.sqrt(baseShadeVar)),
      shadeDeviation: round4(Math.sqrt(shadeVar)),
      /** Texel-scale shade energy. This is the structure that was added. */
      baseShadeDetail: round4(detailEnergy(base.data, size)),
      shadeDetail: round4(detailEnergy(data, size)),
      /** Share of the covered sheet driven to pure black or pure white. */
      baseClippedShare: round4(clippedShareOf(base.data, size)),
      clippedShare: round4(outWeight > 0 ? clipped / Math.max(1e-6, coveredTexels) : 0),
      /** Mean alpha: how much of the sky the deck covers, before and after. */
      baseCoverage: round4(baseWeight / texels),
      coverage: round4(outWeight / texels),
    },
  };
}

function buildClouds(profile, radius) {
  const group = new Group();
  group.name = 'sky-atmosphere:clouds';
  const layers = [];
  const textures = [];
  const altitudes = [radius * 0.17, radius * 0.5];
  const tiles = [1750, 4600];
  for (let i = 0; i < profile.layers.length; i += 1) {
    const spec = profile.layers[i];
    const sheet = bakeCloudSheet(i, spec, profile.coverage);
    const texture = byteTexture(sheet.data, sheet.width, sheet.height, {
      name: `sky-atmosphere:${spec.name}`,
      wrap: RepeatWrapping,
    });
    textures.push(texture);
    const geometry = skyPlateGeometry(radius * 0.92, altitudes[i], CLOUD_SEGMENTS, CLOUD_RINGS, tiles[i]);
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
      opacity: spec.opacity,
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = `sky-atmosphere:${spec.name}`;
    mesh.renderOrder = -6 + i;
    mesh.frustumCulled = false;
    group.add(mesh);
    layers.push({
      spec,
      mesh,
      material,
      texture,
      tile: tiles[i],
      geometry,
      index: i,
      coverage: profile.coverage,
      stats: sheet.stats,
      /** Screen size of one sheet texel on the capture card. See CLOUD_TEXTURE_SIZE. */
      metresPerTexel: Math.round((tiles[i] / sheet.width) * 100) / 100,
      altitude: Math.round(altitudes[i]),
    });
  }
  return { group, layers, textures };
}

/**
 * The ground-hugging haze band.
 *
 * A single linear fog term is uniform in height, so morning haze applied that
 * way greys the towers as much as the street and reads as a flat wash. This is
 * the height term: a two-sided cylinder wall whose alpha falls from the ground
 * to the top of the band, re-centred on the camera. From the street the far
 * wall of it sits across the end of the block; from a roof it is the layer the
 * city is standing in.
 * @private
 */
function buildHaze(radius, height) {
  const geometry = hazeWallGeometry(radius, height, HAZE_SEGMENTS, HAZE_RINGS);
  const ramp = rampTexture(64, (t) => (1 - t) ** 1.9);
  const texture = byteTexture(ramp.data, ramp.width, ramp.height, {
    name: 'sky-atmosphere:haze-ramp',
    wrap: ClampToEdgeWrapping,
  });
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
    opacity: 0,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-atmosphere:ground-haze';
  mesh.renderOrder = -5;
  mesh.frustumCulled = false;
  return { mesh, material, texture, geometry, height };
}

/**
 * Contact band: the crevice line at the wall/ground junction that the shadow
 * map's own bias plan erases.
 *
 * This is ambient occlusion and nothing else. It follows the real footprint
 * polygon, mitres the corners, and fades to nothing over `CONTACT_WIDTH`
 * metres - which is `contactShadowLeakMetres()` for the shipped fit, not a
 * taste value. See the constant for the measurement that condemned the round-3
 * version.
 *
 * Because it is AO, its strength tracks the SKY, not the sun: `retimeContactAO`
 * scales it by how much sky illuminance there is to occlude. That is the
 * property the round-3 review demanded and the round-3 build failed - the old
 * skirt's boundary sat at the identical pixel at 11:00 and at 21:30 and was
 * just as dark under a sun 18 degrees below the horizon.
 *
 * The renderer's own `contact-shadows` mesh is deliberately left alone; see the
 * note in `buildPass`.
 * @private
 */
function buildContactGrounding(ctx, city, datum, proximity) {
  const sink = quadSink();
  const heightAt = typeof ctx.heightAt === 'function' ? ctx.heightAt : () => 0;
  // Paved where the footprint fronts a street, terrain where it does not.
  const groundY = (x, z) => finite(heightAt(x, z), 0)
    + (proximity.near(x, z) ? datum.footwayLift + 0.02 : 0)
    + 0.035;
  const buildings = Array.isArray(city?.buildings) ? city.buildings : [];
  let footprints = 0;
  let skipped = 0;
  for (let b = 0;
    b < buildings.length && footprints < MAX_CONTACT_BUILDINGS && sink.count < MAX_CONTACT_QUADS;
    b += 1) {
    const polygon = buildings[b]?.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) { skipped += 1; continue; }
    // Drop a duplicated closing vertex if the source carries one.
    const points = [];
    for (const p of polygon) {
      const x = finite(p?.x, NaN);
      const z = finite(p?.z, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const last = points[points.length - 1];
      if (last && Math.abs(last.x - x) < 1e-4 && Math.abs(last.z - z) < 1e-4) continue;
      points.push({ x, z });
    }
    if (points.length > 2) {
      const first = points[0];
      const last = points[points.length - 1];
      if (Math.abs(first.x - last.x) < 1e-4 && Math.abs(first.z - last.z) < 1e-4) points.pop();
    }
    if (points.length < 3 || points.length > MAX_CONTACT_EDGES) { skipped += 1; continue; }
    const area = signedArea(points);
    if (Math.abs(area) < 6) { skipped += 1; continue; }
    // Outward normal depends on winding; normalise it away rather than
    // assuming the source is consistent, because OSM footprints are not.
    const sign = area > 0 ? 1 : -1;
    const n = points.length;
    const outward = [];
    for (let i = 0; i < n; i += 1) {
      const a = points[i];
      const c = points[(i + 1) % n];
      const ex = c.x - a.x;
      const ez = c.z - a.z;
      const len = Math.hypot(ex, ez) || 1;
      outward.push({ x: (ez / len) * sign, z: (-ex / len) * sign });
    }
    // Mitre: average the two edge normals at each vertex and lengthen so the
    // offset edge stays parallel to the original. Clamped so a needle-sharp
    // corner cannot throw a spike across the street.
    const offsets = [];
    for (let i = 0; i < n; i += 1) {
      const prev = outward[(i - 1 + n) % n];
      const next = outward[i];
      let mx = prev.x + next.x;
      let mz = prev.z + next.z;
      const len = Math.hypot(mx, mz);
      if (len < 1e-4) { mx = next.x; mz = next.z; }
      else { mx /= len; mz /= len; }
      const cosHalf = Math.max(0.35, mx * next.x + mz * next.z);
      const scale = clamp(CONTACT_WIDTH / cosHalf, CONTACT_WIDTH, CONTACT_WIDTH * CONTACT_MITRE_CLAMP);
      offsets.push({ x: mx * scale, z: mz * scale });
    }
    for (let i = 0; i < n; i += 1) {
      const a = points[i];
      const c = points[(i + 1) % n];
      const oa = offsets[i];
      const oc = offsets[(i + 1) % n];
      const ya = groundY(a.x, a.z);
      const yc = groundY(c.x, c.z);
      sink.quad(
        [a.x, ya, a.z],
        [c.x, yc, c.z],
        [c.x + oc.x, yc, c.z + oc.z],
        [a.x + oa.x, ya, a.z + oa.z],
        [0, 0.5], [0, 0.5], [1, 0.5], [1, 0.5],
      );
    }
    footprints += 1;
  }
  const geometry = sink.build('sky-atmosphere:contact-grounding');
  if (!geometry) return null;
  const ramp = rampTexture(64, (t) => CONTACT_ALPHA * (1 - t) ** 1.7);
  const texture = byteTexture(ramp.data, ramp.width, ramp.height, {
    name: 'sky-atmosphere:contact-ramp',
  });
  const material = new MeshBasicMaterial({
    map: texture,
    color: 0x000000,
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-atmosphere:contact-grounding';
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, material, texture, geometry, footprints, skipped, quads: sink.count };
}

/**
 * Under-object darkening for things that stand on the ground but are not
 * buildings: parked vehicles and shopfront canopies. Both are read out of the
 * groups the renderer already named, so this adds no assumption about how they
 * were generated.
 * @private
 */
function buildUnderObjectShading(ctx, datum) {
  const sink = quadSink();
  const heightAt = typeof ctx.heightAt === 'function' ? ctx.heightAt : () => 0;
  // Parked cars stand on the carriageway; canopies hang over the footway.
  const carriagewayY = (x, z) => finite(heightAt(x, z), 0) + datum.roadLift + 0.03;
  const footwayY = (x, z) => finite(heightAt(x, z), 0) + datum.footwayLift + 0.03;
  const world = new Vector3();
  const vehicles = 0;
  let canopies = 0;

  // Vehicles are deliberately NOT handled here any more.
  //
  // The vehicle owner has retired the legacy `parked-car-bodies` layer and now
  // emits a contact patch under every near and mid vehicle from inside the
  // vehicle presentation pass. That version is LOD-aware and follows moving
  // traffic, neither of which a build-time pass over a static instance buffer
  // can do, and running both would stack two darkening patches under one car.
  // `carriagewayY` is retained because the datum arithmetic is shared and a
  // future kerbside prop will want it.
  void carriagewayY;

  const awnings = ctx.legacyGroup?.('shopfront-awnings');
  if (awnings && typeof awnings.traverse === 'function') {
    awnings.updateMatrixWorld?.(true);
    awnings.traverse((node) => {
      if (!node.isMesh) return;
      node.getWorldPosition(world);
      const x = world.x;
      const z = world.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      sink.rect(x, footwayY(x, z), z, 3.6, 2.8, node.rotation?.y || 0);
      canopies += 1;
    });
  }

  const geometry = sink.build('sky-atmosphere:under-object-shading');
  if (!geometry) return null;
  const source = radialAlphaTexture(64, 1.9);
  const texture = byteTexture(source.data, 64, 64, { name: 'sky-atmosphere:under-object' });
  const material = new MeshBasicMaterial({
    map: texture,
    color: 0x000000,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-atmosphere:under-object-shading';
  mesh.renderOrder = 2;
  return { mesh, material, texture, geometry, vehicles, canopies, quads: sink.count };
}

/**
 * Alpha mask for one projected contact shadow.
 *
 * `u` runs along the throw (0 at the object's foot, 1 at the tip) and `v`
 * across it. The cross-section is flat-topped with soft shoulders, which is
 * what a penumbra looks like on a surface; the along-throw profile is opaque
 * for the first half and fades out over the last, because the further the
 * shadow travels the wider its penumbra is relative to the occluder and the
 * less of the solar disc is actually blocked.
 * @private
 */
function groundShadowMask(size) {
  const data = new Uint8Array(size * size * 4);
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  for (let j = 0; j < size; j += 1) {
    const v = j / (size - 1);
    const across = 1 - Math.abs(2 * v - 1);
    const cross = Math.pow(clamp(across, 0, 1), 0.55);
    for (let i = 0; i < size; i += 1) {
      const u = i / (size - 1);
      const along = 1 - smooth(0.5, 1, u);
      const o = (j * size + i) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(clamp(cross * along, 0, 1) * 255);
    }
  }
  return { data, width: size, height: size };
}

/**
 * The grounding mesh: one merged, preallocated quad set that carries a
 * projected contact shadow for every object the shadow map refused.
 *
 * Preallocated because the anchor set is discovered after the build (see
 * `GROUNDING_COLLECT_FRAMES`) and rewritten every frame; growing a buffer
 * geometry per frame would be a per-frame allocation in a pass that is not
 * allowed one. Positions are the only attribute that ever changes.
 * @private
 */
function buildGrounding(capacity) {
  const positions = new Float32Array(capacity * 4 * 3);
  const uvs = new Float32Array(capacity * 4 * 2);
  const indices = new Uint16Array(capacity * 6);
  for (let q = 0; q < capacity; q += 1) {
    const v = q * 4;
    // (foot,-w) (foot,+w) (tip,+w) (tip,-w); u along the throw, v across it.
    uvs.set([0, 0, 0, 1, 1, 1, 1, 0], q * 8);
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
  }
  const geometry = new BufferGeometry();
  const position = new BufferAttribute(positions, 3);
  position.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  geometry.name = 'sky-atmosphere:grounding';

  const mask = groundShadowMask(GROUNDING_MASK_SIZE);
  const texture = byteTexture(mask.data, mask.width, mask.height, {
    name: 'sky-atmosphere:grounding-mask',
  });
  const material = new MeshBasicMaterial({
    map: texture,
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-atmosphere:grounding';
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // The quad set covers the whole city and is rewritten every frame, so a
  // bounding sphere would be recomputed for nothing.
  mesh.frustumCulled = false;
  mesh.visible = false;
  return {
    mesh, material, texture, geometry, positions, capacity,
    anchors: [], quads: 0, collects: 0, frame: null, audit: null,
  };
}

/**
 * Find the objects that need grounding. Runs a handful of times after the
 * world build, never on a timer. @private
 */
function collectGrounding(state, ctx) {
  const root = ctx?.root;
  const grounding = state.grounding;
  if (!grounding || !root || typeof root.traverse !== 'function') return;
  try {
    const audit = collectGroundingAnchors(root, {
      maxAnchors: grounding.capacity,
      // Never ground this pass's own decals, and never ground the sky.
      skip: (object) => object === state.root
        || (typeof object.name === 'string' && object.name.startsWith('sky-atmosphere:')),
    });
    grounding.anchors = audit.anchors;
    grounding.audit = {
      anchors: audit.anchors.length,
      sources: audit.sources,
      scanned: audit.scanned,
      candidates: audit.candidates,
      capped: audit.capped,
      skipped: audit.skipped,
    };
  } catch {
    // A grounding scan is cosmetic. A pass must not take the world down.
    grounding.anchors = [];
  }
  grounding.collects += 1;
}

/**
 * Rewrite every grounding quad for the current sun.
 *
 * Called every frame, not on the hour bucket, because half the anchors are
 * walking or driving. The work is one matrix apply and twelve float writes per
 * anchor; at the 1024 cap that is the same order as one instanced batch's own
 * per-frame matrix upload.
 *
 * Returns the number of quads drawn. Zero means the sun is down, and the mesh
 * is switched off entirely - which is the property the round-3 review demanded
 * and the contact skirt could not offer.
 * @private
 */
function retimeGrounding(state, model, balance) {
  const grounding = state.grounding;
  if (!grounding) return 0;
  // The DELIVERED key share, not the physical one. See `keyShareOfRatio`: the
  // rig corrects key/fill on purpose, and a drawn shadow that removed the
  // physical key share would be a different darkness from the shadow map's own
  // on the building next to it.
  const share = keyShareOfRatio(balance?.achieved?.ratio);
  const frame = groundingFrame(model.sun, share);
  grounding.frame = frame;
  grounding.keyShare = share;
  if (!frame.active || !grounding.anchors.length) {
    grounding.quads = 0;
    grounding.geometry.setDrawRange(0, 0);
    grounding.mesh.visible = false;
    grounding.material.opacity = 0;
    return 0;
  }
  grounding.material.opacity = frame.opacity;

  const heightAt = state.heightAt;
  const positions = grounding.positions;
  const dirX = frame.dirX;
  const dirZ = frame.dirZ;
  // Perpendicular, in the ground plane.
  const perpX = -dirZ;
  const perpZ = dirX;
  let quads = 0;
  for (let i = 0; i < grounding.anchors.length && quads < grounding.capacity; i += 1) {
    const anchor = grounding.anchors[i];
    if (!refreshGroundingAnchor(anchor)) continue;
    const length = groundingLength(frame, anchor.height);
    if (!(length > 0)) continue;
    const baseHalf = anchor.radius;
    const tipHalf = groundingTipWidth(frame, anchor.radius * 2, length) * 0.5;
    // The quad starts one radius BEHIND the base so the object's own footprint
    // is covered: a shadow includes the ground the object is standing on.
    const footX = anchor.x - dirX * baseHalf;
    const footZ = anchor.z - dirZ * baseHalf;
    const tipX = anchor.x + dirX * length;
    const tipZ = anchor.z + dirZ * length;
    const footY = anchor.y + GROUNDING_LIFT;
    // Follow the terrain's slope out to the tip, keeping whatever pavement
    // offset the base had. A flat quad on a 6% grade is 1.5 m out of the
    // ground at 26 m, and this city has grades far steeper than that.
    let tipY = footY;
    if (heightAt && length > 3) {
      const base = finite(heightAt(anchor.x, anchor.z), NaN);
      const far = finite(heightAt(tipX, tipZ), NaN);
      if (Number.isFinite(base) && Number.isFinite(far)) tipY = footY + (far - base);
    }
    const o = quads * 12;
    positions[o] = footX - perpX * baseHalf;
    positions[o + 1] = footY;
    positions[o + 2] = footZ - perpZ * baseHalf;
    positions[o + 3] = footX + perpX * baseHalf;
    positions[o + 4] = footY;
    positions[o + 5] = footZ + perpZ * baseHalf;
    positions[o + 6] = tipX + perpX * tipHalf;
    positions[o + 7] = tipY;
    positions[o + 8] = tipZ + perpZ * tipHalf;
    positions[o + 9] = tipX - perpX * tipHalf;
    positions[o + 10] = tipY;
    positions[o + 11] = tipZ - perpZ * tipHalf;
    quads += 1;
  }
  grounding.quads = quads;
  grounding.geometry.getAttribute('position').needsUpdate = true;
  grounding.geometry.setDrawRange(0, quads * 6);
  grounding.mesh.visible = quads > 0 && frame.opacity > 0.008;
  return quads;
}

/**
 * Night practicals: what the street's own lights put on the ground and in the
 * air. Three separate merged meshes, because they blend differently - the
 * pools and the bulb glows are additive, the shop spill is a warm wash that
 * has to stay under 1 so it does not clip the sidewalk to white.
 * @private
 */
function buildNightPracticals(ctx, profile, datum, streets) {
  const heightAt = typeof ctx.heightAt === 'function' ? ctx.heightAt : () => 0;
  const footwayY = (x, z) => finite(heightAt(x, z), 0) + datum.footwayLift + 0.025;
  /**
   * The paved surface under an arbitrary point: the carriageway's own crowned
   * cross-section inside the kerb line, the footway datum outside it. This is
   * what a light pool has to lie on, and it is sampled per grid vertex rather
   * than once per pool, because a pool is 23 m across and the ground under it
   * is not level.
   */
  const surfaceNear = (street) => {
    if (!street) {
      return (px, pz) => finite(heightAt(px, pz), 0) + datum.footwayLift + POOL_LIFT;
    }
    // `street.x/z` is the fixture's own projection onto the segment, so the
    // line through it along `(dx, dz)` IS the centreline: one query per patch
    // gives every vertex an exact lateral offset, and the whole patch stays on
    // ONE segment instead of flip-flopping between two at a junction.
    const perpX = -street.dz;
    const perpZ = street.dx;
    return (px, pz) => {
      const terrain = finite(heightAt(px, pz), 0);
      const lateral = Math.abs((px - street.x) * perpX + (pz - street.z) * perpZ);
      if (lateral <= street.half) {
        return datum.crossSectionY(terrain, lateral, street.half) + POOL_LIFT;
      }
      return terrain + datum.footwayLift + POOL_LIFT;
    };
  };
  const lampGroup = ctx.legacyGroup?.('street-lamps');
  const pools = quadSink();
  const road = quadSink();
  const glows = quadSink();
  const spill = quadSink();
  const world = new Vector3();
  let lamps = 0;
  let carriagewayPools = 0;
  let spills = 0;

  if (lampGroup && typeof lampGroup.traverse === 'function') {
    lampGroup.updateMatrixWorld?.(true);
    const children = lampGroup.children || [];
    for (let i = 0; i < children.length; i += 1) {
      const lamp = children[i];
      lamp.getWorldPosition(world);
      const x = world.x;
      const z = world.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const ground = footwayY(x, z);
      // Per-fixture jitter: a street where every pool is the same size and the
      // same brightness reads as a texture, not as lighting.
      const jitter = 0.82 + 0.36 * hash01(hashString(`${lamp.name || 'lamp'}:${i}`));
      const radius = profile.pool.radius * jitter;
      // The throw across the carriageway. Oriented along the street so adjacent
      // fixtures overlap into a continuous band instead of a row of spots, and
      // laid on the carriageway's own crowned cross-section rather than on a
      // single flat datum.
      const street = streets.query(x, z);
      const pavedY = surfaceNear(street && street.distance < 26 ? street : null);
      pools.patch(x, z, radius * 2, radius * 2, 0, POOL_GRID, pavedY);
      if (street && street.distance < 26) {
        const toRoadX = street.x - x;
        const toRoadZ = street.z - z;
        const toRoad = Math.hypot(toRoadX, toRoadZ);
        const reach = profile.pool.carriageway.reach * jitter;
        // Centre the patch part-way out over the carriageway, not on the kerb.
        const bias = Math.min(street.half * 0.55, reach * 0.32);
        const cx = toRoad > 1e-3 ? x + (toRoadX / toRoad) * bias : x;
        const cz = toRoad > 1e-3 ? z + (toRoadZ / toRoad) * bias : z;
        road.patch(
          cx,
          cz,
          profile.pool.carriageway.length * jitter,
          reach * 2,
          Math.atan2(street.dz, street.dx),
          POOL_GRID,
          pavedY,
        );
        carriagewayPools += 1;
      }
      // The bulb itself, as a soft glow in air at the fixture height. The lamp
      // group's own world Y is the authority here - it is the fixture.
      glows.rect(x, finite(world.y, ground) + 5.5, z, 3.0 * jitter, 3.0 * jitter);
      lamps += 1;
    }
  }

  const awnings = ctx.legacyGroup?.('shopfront-awnings');
  if (awnings && typeof awnings.traverse === 'function') {
    awnings.updateMatrixWorld?.(true);
    let index = 0;
    awnings.traverse((node) => {
      if (!node.isMesh) return;
      index += 1;
      // Occupancy: not every shop is open, and which ones are must be stable
      // across frames and across captures.
      if (hash01(hashString(`spill:${index}`)) > profile.shopSpill.occupancy) return;
      node.getWorldPosition(world);
      const x = world.x;
      const z = world.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const depth = profile.shopSpill.depth * (0.8 + 0.5 * hash01(hashString(`spilld:${index}`)));
      const spillStreet = streets.query(x, z);
      spill.patch(x, z, 4.2, depth, node.rotation?.y || 0, SPILL_GRID,
        surfaceNear(spillStreet && spillStreet.distance < 26 ? spillStreet : null));
      spills += 1;
    });
  }

  const poolSource = radialAlphaTexture(96, profile.pool.falloff);
  const poolTexture = byteTexture(poolSource.data, 96, 96, { name: 'sky-atmosphere:light-pool' });
  // The carriageway throw is elongated, so it gets a gentler falloff: a
  // `^1.5` radial mask stretched 34 m along the street would read as an
  // obvious ellipse rather than as a lit road.
  const roadSource = radialAlphaTexture(96, 1.15);
  const roadTexture = byteTexture(roadSource.data, 96, 96, { name: 'sky-atmosphere:road-pool' });
  const glowSource = radialAlphaTexture(48, 2.4);
  const glowTexture = byteTexture(glowSource.data, 48, 48, { name: 'sky-atmosphere:bulb-glow' });

  const parts = [];
  const textures = [poolTexture, roadTexture, glowTexture];

  const poolGeometry = pools.build('sky-atmosphere:light-pools');
  if (poolGeometry) {
    const material = new MeshBasicMaterial({
      map: poolTexture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      opacity: 0,
      fog: true,
    });
    const mesh = new Mesh(poolGeometry, material);
    mesh.name = 'sky-atmosphere:light-pools';
    mesh.renderOrder = 3;
    parts.push({ key: 'pools', mesh, material, geometry: poolGeometry });
  }
  const roadGeometry = road.build('sky-atmosphere:road-pools');
  if (roadGeometry) {
    const material = new MeshBasicMaterial({
      map: roadTexture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      opacity: 0,
      fog: true,
    });
    const mesh = new Mesh(roadGeometry, material);
    mesh.name = 'sky-atmosphere:road-pools';
    mesh.renderOrder = 3;
    parts.push({ key: 'road', mesh, material, geometry: roadGeometry });
  }
  const glowGeometry = glows.build('sky-atmosphere:bulb-glows');
  if (glowGeometry) {
    const material = new MeshBasicMaterial({
      map: glowTexture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      opacity: 0,
      fog: true,
    });
    const mesh = new Mesh(glowGeometry, material);
    mesh.name = 'sky-atmosphere:bulb-glows';
    mesh.renderOrder = 3;
    parts.push({ key: 'glows', mesh, material, geometry: glowGeometry });
  }
  const spillGeometry = spill.build('sky-atmosphere:shop-spill');
  if (spillGeometry) {
    const material = new MeshBasicMaterial({
      map: poolTexture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      opacity: 0,
      fog: true,
    });
    const mesh = new Mesh(spillGeometry, material);
    mesh.name = 'sky-atmosphere:shop-spill';
    mesh.renderOrder = 3;
    parts.push({ key: 'spill', mesh, material, geometry: spillGeometry });
  }

  return { parts, textures, lamps, spills, carriagewayPools };
}

/**
 * Wet-surface response: standing water on the carriageway.
 *
 * This is the one piece that uses a `MeshStandardMaterial`, because the whole
 * point is a *reflection*: at `roughness` 0.24 with `scene.environment`
 * assigned, a puddle mirrors the sky and whatever the practicals are doing,
 * which is what makes a drizzle frame legible as wet rather than as tinted.
 * Placement follows the street contract's own polylines, so puddles land on
 * real carriageway and are stable across rebuilds.
 * @private
 */
function buildWetSheen(ctx, city, grade, datum) {
  // Built unconditionally, even in clear weather.
  //
  // Round 1 built this only when `ctx.weather` was already wet at *build*
  // time, and the runtime changes weather long after the world is built - so
  // the drizzle card could never have had puddles no matter what the harness
  // did. Geometry is cheap (720 triangles) and a hidden mesh costs nothing;
  // reacting to `setWeather` without a world rebuild is worth far more.
  const heightAt = typeof ctx.heightAt === 'function' ? ctx.heightAt : () => 0;
  const segments = Array.isArray(city?.segments) ? city.segments : [];
  const sink = quadSink();
  let placed = 0;
  // `datum.crossSectionY` owns the vertical placement now; the raw lift is no
  // longer used directly.
  for (let s = 0; s < segments.length && placed < MAX_PUDDLES; s += 1) {
    const segment = segments[s];
    const points = segment?.points;
    if (!Array.isArray(points) || points.length < 2) continue;
    const a = points[0];
    const b = points[points.length - 1];
    const dx = finite(b?.x, 0) - finite(a?.x, 0);
    const dz = finite(b?.z, 0) - finite(a?.z, 0);
    const length = Math.hypot(dx, dz);
    if (!(length > 12)) continue;
    const width = clamp(finite(segment.width, 8), 3, 40);
    const seed = hashString(String(segment.id || `seg:${s}`));
    // About one puddle per 26 m of carriageway, jittered across the lanes.
    const count = Math.max(1, Math.min(4, Math.floor(length / 26)));
    const ux = dx / length;
    const uz = dz / length;
    for (let k = 0; k < count && placed < MAX_PUDDLES; k += 1) {
      const t = (k + 0.5) / count + (hash01(seed + k * 7717) - 0.5) * 0.4;
      if (t <= 0.02 || t >= 0.98) continue;
      const lateral = (hash01(seed + k * 1913) - 0.5) * width * 0.72;
      const x = finite(a.x, 0) + ux * length * t - uz * lateral;
      const z = finite(a.z, 0) + uz * length * t + ux * lateral;
      const size = 2.2 + 3.4 * hash01(seed + k * 3301);
      sink.rect(
        x,
        // The road is crowned. Round 2 used `datum + 0.012` and buried every
        // puddle under up to 0.30 m of tarmac.
        datum.crossSectionY(finite(heightAt(x, z), 0), lateral, width * 0.5) + 0.02,
        z,
        size,
        size * (0.55 + 0.5 * hash01(seed + k * 5501)),
        Math.atan2(uz, ux),
      );
      placed += 1;
    }
  }
  const geometry = sink.build('sky-atmosphere:wet-sheen');
  if (!geometry) return null;
  // A MASK, not an alpha texture: `alphaMap` is read as a float, which takes
  // the red channel on the node path and green on the classic one, so the
  // falloff has to live in RGB.
  const source = radialMaskTexture(64, 1.4, 0.28);
  const texture = byteTexture(source.data, 64, 64, { name: 'sky-atmosphere:puddle' });
  const material = new MeshStandardMaterial({
    alphaMap: texture,
    color: 0x0b0e11,
    roughness: grade.roughness,
    metalness: 0.06,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  material.userData.envClass = 'water';
  material.envMapIntensity = grade.envMapIntensity;
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-atmosphere:wet-sheen';
  mesh.renderOrder = 1;
  mesh.receiveShadow = true;
  mesh.visible = false;
  return { mesh, material, texture, geometry, puddles: placed };
}

// ---------------------------------------------------------------- aerial

const _forward = new Vector3();
const _skyline = [0, 0, 0];

/**
 * Camera forward, without trusting a stale `matrixWorld`.
 *
 * `getWorldDirection` refreshes the camera's own world matrix before reading
 * it, which matters here: the pass runtime runs before the renderer updates
 * the graph, so reading `matrixWorld` directly would give last frame's
 * orientation and a single-frame capture would get the fog of a pose it never
 * rendered.
 * @private
 */
function cameraForward(camera, out) {
  if (camera && typeof camera.getWorldDirection === 'function') {
    try {
      camera.getWorldDirection(out);
      if (Number.isFinite(out.x) && Number.isFinite(out.z) && Math.hypot(out.x, out.z) > 1e-6) return out;
    } catch {
      // fall through to the default heading
    }
  }
  out.set(0, 0, -1);
  return out;
}

/**
 * The colour distance has to converge on.
 *
 * Round 3 handed `scene.fog` the module's `aerialPerspective().color`, which
 * is `mix(horizonRadiance, sunwardHorizonRadiance, 0.35)` - one number for the
 * whole compass, biased a third of the way toward the brightest point on the
 * skyline. Measured on the captured 15:00 clear card that is
 * [1.1580, 1.6204, 1.7192], luminance 1.529, against a horizon of
 * [0.9205, 1.3171, 1.4180] at 1.240 and an anti-solar skyline at 0.826. So the
 * far field was being blended toward a colour 23% brighter than the average
 * sky and 85% brighter than the sky actually behind it whenever the camera was
 * not pointed at the sun. That is the painted white band at the end of the
 * street: aerial perspective converging on white instead of on the sky.
 *
 * The fix is to ask the same dome function the frame is drawing what colour it
 * is in the direction the camera is looking, at the elevation distant geometry
 * is seen against, and hand *that* to the fog. Two ceilings keep it honest:
 *
 *  1. a hue-preserving luminance clamp to the model's own `horizonLuminance`,
 *     so looking into a low sun cannot drive the whole frame's fog above the
 *     sky's average skyline while it keeps the warm ratio that direction has;
 *  2. a hard per-channel clamp to `horizonRadiance`, because `scene.fog` is
 *     one colour applied to every pixel and geometry at the edge of the frame
 *     is not looking where the camera is.
 *
 * Sampling elevation is +2 deg, which is exactly where `computeSkyModel`'s own
 * horizon probes sit, so the sample and its ceiling are the same measurement
 * taken in different directions rather than two different models.
 *
 * `computeSkyModel` remains the sole authority: nothing here feeds back into
 * sun direction, irradiance or exposure.
 * @private
 */
function skylineRadiance(model, forwardX, forwardZ, out = [0, 0, 0]) {
  const horizontal = Math.hypot(forwardX, forwardZ);
  const nx = horizontal > 1e-6 ? forwardX / horizontal : 0;
  const nz = horizontal > 1e-6 ? forwardZ / horizontal : -1;
  skyDomeRadiance(model, nx * SKYLINE_COS, SKYLINE_SIN, nz * SKYLINE_COS, {}, out);
  const ceiling = model.horizonRadiance;
  const level = luminanceOf(out);
  const ceilingLevel = finite(model.horizonLuminance, luminanceOf(ceiling));
  if (level > ceilingLevel && level > 1e-9) {
    const scale = ceilingLevel / level;
    out[0] *= scale;
    out[1] *= scale;
    out[2] *= scale;
  }
  out[0] = clamp(out[0], 0, ceiling[0]);
  out[1] = clamp(out[1], 0, ceiling[1]);
  out[2] = clamp(out[2], 0, ceiling[2]);
  return out;
}

/**
 * Write the fog colour for the current view direction. Returns the linear RGB
 * it used so the caller can report it. @private
 */
function applyFogColor(state, camera) {
  if (!state.model) return state.fogRgb;
  cameraForward(camera, _forward);
  skylineRadiance(state.model, _forward.x, _forward.z, _skyline);
  state.fogRgb[0] = _skyline[0];
  state.fogRgb[1] = _skyline[1];
  state.fogRgb[2] = _skyline[2];
  setLinear(state.fogColor, _skyline);
  return state.fogRgb;
}

// ---------------------------------------------------------------- retiming

/** Recolour the dome and re-aim the sun/moon/stars for a sky model. @private */
function retimeSky(sky, model, cloud, exposure) {
  const colors = sky.domeGeometry.getAttribute('color');
  const positions = sky.domeGeometry.getAttribute('position');
  const rgb = [0, 0, 0];
  const inverse = 1 / sky.radius;
  // The dome's own mean luminance is the level the dither is sized against.
  // It is free here because the loop already visits every vertex.
  let luminanceSum = 0;
  let luminanceCount = 0;
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i) * inverse;
    const y = positions.getY(i) * inverse;
    const z = positions.getZ(i) * inverse;
    // The dome's own aerosol band and its below-horizon join now blend to the
    // model's measured `horizonRadiance` (skyDomeRadiance's default), not to
    // the averaged-and-sun-biased term the fog used to take. That is what
    // keeps the join exact: the fog colour above is a sample of THIS function
    // at the view azimuth, so at the skyline the dome and the fog are the same
    // number by construction, and the only place they can differ is below the
    // skyline, which the streetwall covers.
    skyDomeRadiance(model, x, y, z, undefined, rgb);
    colors.setXYZ(i, rgb[0], rgb[1], rgb[2]);
    // Only the visible upper dome: the ground hemisphere is never the thing
    // that bands, and averaging it in would drag the reference far too low.
    if (y > 0) {
      luminanceSum += 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      luminanceCount += 1;
    }
  }
  const meanLuminance = luminanceCount ? luminanceSum / luminanceCount : 0;
  // The shell blends ADDITIVELY, and three tone-maps per material, so what it
  // contributes to the frame is `displayValue(amplitude * noise)` on its own -
  // not `displayValue(sky + noise) - displayValue(sky)`. The amplitude is
  // therefore the scene value that *itself* renders at DITHER_STEPS, and the
  // compensation the dome pays back is the scene delta worth half that many
  // steps at the sky's own level. Sizing the shell with `displayStepScene`
  // instead would be a factor of several out, because one step near zero costs
  // far less scene radiance than one step at the sky's level.
  const amplitude = sceneForDisplay(DITHER_STEPS / 255, exposure);
  const bias = displayStepScene(meanLuminance, exposure, DITHER_STEPS * 0.5);
  if (bias > 0) {
    for (let i = 0; i < colors.count; i += 1) {
      colors.setXYZ(
        i,
        Math.max(0, colors.getX(i) - bias),
        Math.max(0, colors.getY(i) - bias),
        Math.max(0, colors.getZ(i) - bias),
      );
    }
  }
  setLinear(sky.ditherMaterial.color, [1, 1, 1], amplitude);
  sky.dither.visible = amplitude > 0;
  sky.ditherAmplitude = amplitude;
  sky.ditherReference = meanLuminance;
  colors.needsUpdate = true;

  const sun = model.sun;
  const cloudCover = clamp(cloud.coverage, 0, 1);
  // Cloud hides the disc: at 92% coverage there is no sun to see.
  const clearSky = 1 - cloudCover * 0.92;
  const above = clamp((sun.altitudeDeg + 2) / 4, 0, 1);

  sky.disc.position.set(sun.x * sky.radius * 0.97, sun.y * sky.radius * 0.97, sun.z * sky.radius * 0.97);
  aimAtCentre(sky.disc, sun);
  sky.glow.position.copy(sky.disc.position);
  aimAtCentre(sky.glow, sun);
  // The disc has to be far brighter than the dome or ACES will not clip it to
  // white, and a sun that is not clipped reads as a paper cut-out.
  const discRadiance = 26 + 46 * model.daylight;
  setLinear(sky.discMaterial.color, [1.0, 0.94, 0.84], discRadiance * above * clearSky);
  sky.disc.visible = above * clearSky > 0.01;
  // The aureole takes the sunward horizon's own colour, so it goes orange as
  // the sun drops without anyone choosing an orange.
  setLinear(sky.glowMaterial.color, model.sunwardHorizonRadiance, 0.55 * clearSky);
  sky.glow.visible = above * clearSky > 0.01;
  sky.glowMaterial.opacity = clamp(0.25 + 0.55 * (1 - model.daylight), 0, 1) * above;

  // Anti-solar azimuth at the altitude the renderer's night key uses.
  const horizontal = Math.hypot(sun.x, sun.z);
  const moonAltitude = 52 * DEG;
  const moonDir = horizontal > 1e-6
    ? {
      x: (-sun.x / horizontal) * Math.cos(moonAltitude),
      y: Math.sin(moonAltitude),
      z: (-sun.z / horizontal) * Math.cos(moonAltitude),
    }
    : { x: 0, y: 1, z: 0 };
  sky.moon.position.set(moonDir.x * sky.radius * 0.96, moonDir.y * sky.radius * 0.96, moonDir.z * sky.radius * 0.96);
  aimAtCentre(sky.moon, moonDir);
  setLinear(sky.moonMaterial.color, [0.94, 0.95, 1.0], 3.4 * model.night * clearSky);
  sky.moon.visible = model.night * clearSky > 0.02;

  sky.starMaterial.opacity = clamp(model.night * clearSky * 0.95, 0, 1);
  sky.starPoints.visible = sky.starMaterial.opacity > 0.01;
}

/**
 * Retint the cloud decks, and rebake their sheets if the deck's *coverage* has
 * changed - which only happens on a weather change.
 *
 * A retint alone would be wrong there: a fog deck's 0.95 opacity applied to a
 * sheet baked at clear's 0.30 coverage is a dense but sparse sky, which is not
 * fog. The rebake costs about 150 ms and happens once per user-driven weather
 * toggle, never on the clock.
 * @private
 */
function retimeClouds(clouds, profile) {
  if (Math.abs(profile.coverage - (clouds.layers[0]?.coverage ?? profile.coverage)) > 1e-6) {
    for (const layer of clouds.layers) {
      const sheet = bakeCloudSheet(layer.index, layer.spec, profile.coverage);
      layer.texture.image.data.set(sheet.data);
      layer.texture.needsUpdate = true;
      layer.coverage = profile.coverage;
      layer.stats = sheet.stats;
    }
  }
  for (const layer of clouds.layers) {
    // RGB in the sheet is a shade term, so `material.color` sets the lit end
    // and the sheet's own darkening carries the volume.
    setLinear(layer.material.color, profile.litTint);
    layer.material.opacity = layer.spec.opacity;
    layer.material.visible = layer.spec.opacity > 0.01;
  }
}

/**
 * Apply the aerial-perspective numbers to the scene fog and the haze band.
 *
 * The depth pair (`near`/`far`) is still entirely the module's: it is a map
 * property graded by weather and sun altitude and this pass has no business
 * second-guessing it. Only the *colours* are re-derived, against the sky's own
 * measured radiance - see `skylineRadiance`.
 * @private
 */
function retimeAerial(state, aerial, camera) {
  const fog = state.scene?.fog;
  if (fog) {
    fog.near = aerial.near;
    fog.far = aerial.far;
    applyFogColor(state, camera);
    fog.color.copy(state.fogColor);
  }
  if (state.haze) {
    // The ground haze is the air standing in the street, seen in every
    // direction at once, so it stays view-independent - but it cannot be
    // brighter than the sky that is lighting it either. Round 3 shipped
    // [1.0220, 1.4353, 1.5821] against a measured horizon of
    // [0.9205, 1.3171, 1.4180]: 11% of glow that no sky in the frame produces.
    const ceiling = state.model ? state.model.horizonRadiance : null;
    const hazeColor = ceiling
      ? [
        clamp(aerial.haze.color[0], 0, ceiling[0]),
        clamp(aerial.haze.color[1], 0, ceiling[1]),
        clamp(aerial.haze.color[2], 0, ceiling[2]),
      ]
      : aerial.haze.color;
    state.hazeRgb = hazeColor;
    setLinear(state.haze.material.color, hazeColor);
    state.haze.material.opacity = aerial.haze.density;
    state.haze.mesh.visible = aerial.haze.density > 0.012;
    // The band's height is baked into the geometry, so it is scaled rather
    // than rebuilt: a morning inversion is a taller band, not a new mesh.
    const scale = clamp(aerial.haze.height / state.haze.height, 0.25, 4);
    state.haze.mesh.scale.set(1, scale, 1);
  }
}

/**
 * Wet response, driven at runtime rather than at build.
 *
 * `setWeather` on the renderer does not rebuild the world, so everything the
 * drizzle bucket changes has to be a property write on an existing material.
 * Roughness is the one that matters: at 0.93 the puddle is a matte grey patch,
 * at 0.24 it mirrors the sky and the practicals, and that is the whole
 * difference between "the sky went grey" and "the street is wet".
 * @private
 */
function retimeWet(state, grade) {
  const wet = state.wet;
  if (!wet) return;
  wet.material.roughness = grade.roughness;
  wet.material.envMapIntensity = grade.envMapIntensity;
  wet.material.opacity = clamp(grade.sheenOpacity * 2.1, 0, 0.95);
  wet.mesh.visible = wet.material.opacity > 0.02;
}

/**
 * How much sky there is to occlude, 0..1, relative to a clear solar noon.
 *
 * Ambient occlusion darkens a surface by removing the *sky* it cannot see. If
 * there is no sky light, there is nothing for AO to remove, and a fixed-alpha
 * AO decal at 21:30 is painting darkness onto a surface that has no light on
 * it - which is exactly the defect the round-3 review measured on this pass's
 * contact skirt.
 *
 * The reference is the peak clear-sky illuminance the model itself reports, so
 * this is a measured ratio rather than a curve anybody authored. At 21:30 the
 * sky delivers 0.029 against a noon 1.076, so the AO term runs at 2.7% - a
 * hairline, not a wedge.
 * @private
 */
let peakSkyIlluminance = 0;
function skyOcclusionScale(illuminance) {
  if (!peakSkyIlluminance) {
    let peak = 0;
    for (let hour = 11; hour <= 14; hour += 1) {
      const sky = finite(recommendedExposure(computeSkyModel({ hour, weather: 'clear' })).illuminance?.sky, 0);
      if (sky > peak) peak = sky;
    }
    peakSkyIlluminance = peak > 0 ? peak : 1;
  }
  const sky = finite(illuminance?.sky, 0);
  return clamp(sky / peakSkyIlluminance, 0, 1);
}

/**
 * Scale the two ambient-occlusion elements - the contact band at the wall and
 * the patch under a shopfront canopy - by how much sky is available to occlude.
 * @private
 */
function retimeContactAO(state, illuminance) {
  const scale = skyOcclusionScale(illuminance);
  state.aoScale = scale;
  if (state.contact) {
    state.contact.material.opacity = scale;
    state.contact.mesh.visible = scale > 0.02;
  }
  if (state.underObject) {
    state.underObject.material.opacity = CANOPY_AO_ALPHA * scale;
    state.underObject.mesh.visible = state.underObject.material.opacity > 0.012;
  }
  return scale;
}

/** Turn the night practicals up or down. @private */
/**
 * Turn the night practicals up or down.
 *
 * Every level here is DISPLAY-referred, not scene-referred, and the conversion
 * is the whole point. Three tone-maps each material and blends afterwards, so
 * an additive pool contributes exactly `displayValue(material.color) * alpha`
 * to the frame. A scene-referred level therefore does not mean what it looks
 * like it means: round 2's 0.46 opacity on a 1.35x warm colour is 0.62 linear,
 * which tone-maps to +218 luma - a white-hot disc under every lamp, and the
 * only reason nobody saw it is that the pools were buried under the pavement.
 * Setting the colour from `sceneForDisplay(peak / 255, exposure)` instead
 * fixes the peak in display steps and makes it exposure-independent, and the
 * mask then falls off linearly in display space, which is what a pool of light
 * on tarmac actually looks like.
 * @private
 */
function retimePracticals(state, profile, exposure) {
  /** Colour whose tone-mapped luminance lands on `peak` display steps. */
  const atPeak = (material, color, peak, opacity) => {
    const target = sceneForDisplay(clamp(peak, 0, 254) / 255, exposure);
    const luminance = Math.max(1e-6, 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]);
    setLinear(material.color, color, target / luminance);
    material.opacity = clamp(opacity, 0, 1);
  };
  for (const part of state.practicals?.parts || []) {
    if (part.key === 'pools') {
      atPeak(part.material, profile.pool.color, profile.pool.peakDisplay, profile.pool.opacity);
    } else if (part.key === 'road') {
      const throwSpec = profile.pool.carriageway;
      atPeak(part.material, profile.pool.color, throwSpec.peakDisplay, throwSpec.opacity);
    } else if (part.key === 'glows') {
      atPeak(part.material, profile.pool.color, profile.bulb.peakDisplay, profile.bulb.opacity);
    } else {
      // Shopfronts run warmer than the street lamps and vary in temperature.
      atPeak(part.material, blackBodyColor(2950), profile.shopSpill.peakDisplay, profile.shopSpill.opacity);
    }
    part.mesh.visible = part.material.opacity > 0.012;
  }
}

// ---------------------------------------------------------------- diagnostics

/** The whole day, measured rather than typed. @private */
function daySchedule(weather, mapSpan) {
  const rows = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const model = computeSkyModel({ hour, weather });
    const balance = keyFillBalance(model);
    const exposure = recommendedExposure(model);
    const aerial = aerialPerspective({ model, mapSpan });
    const cloud = cloudProfile(model);
    rows.push({
      hour,
      sunAltitudeDeg: Math.round(model.sun.altitudeDeg * 100) / 100,
      sunAzimuthDeg: Math.round(model.sun.azimuthDeg * 100) / 100,
      daylight: Math.round(model.daylight * 1000) / 1000,
      skyLuminance: Math.round(model.horizonLuminance * 10000) / 10000,
      zenithLuminance: Math.round(model.zenithLuminance * 10000) / 10000,
      keyFill: balance.measured.ratio,
      keyFillTarget: balance.target.ratio,
      keyFillAchieved: balance.achieved.ratio,
      exposure: exposure.exposure,
      illuminance: exposure.illuminance.total,
      fogNear: aerial.near,
      fogFar: aerial.far,
      hazeDensity: aerial.haze.density,
      hazeHeight: aerial.haze.height,
      cloudCoverage: cloud.coverage,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- pass

function buildPass(ctx) {
  const city = ctx?.city || null;
  const weather = (() => {
    try {
      return normaliseWeather(ctx?.weather);
    } catch {
      return 'clear';
    }
  })();
  const hour = finite(ctx?.hour, 12);
  const mapSpan = mapSpanOf(city);
  const model = computeSkyModel({ hour, weather });
  const aerial = aerialPerspective({ model, mapSpan });
  const cloud = cloudProfile(model);
  const practical = nightPracticalProfile(model);
  const balance = keyFillBalance(model);
  const exposure = recommendedExposure(model);
  const wetAsphalt = wetSurfaceGrade('asphalt', model);

  const root = new Group();
  root.name = 'pass:sky-atmosphere';

  // The dome must sit inside the far plane or its top is clipped away; the
  // cloud decks and haze band must sit inside the dome for the same reason.
  const cameraFar = finite(ctx?.camera?.far, 4200);
  const radius = clamp(cameraFar * 0.92, 900, 3900);

  const sky = buildSky(radius);
  root.add(sky.group);

  const clouds = buildClouds(cloud, radius);
  root.add(clouds.group);

  const haze = buildHaze(Math.min(radius * 0.72, Math.max(240, aerial.far * 0.82)), aerial.haze.height);
  root.add(haze.mesh);

  const datum = pavedDatum(city);
  const proximity = streetProximity(city);
  const streets = streetIndex(city);
  const contact = buildContactGrounding(ctx, city, datum, proximity);
  if (contact) root.add(contact.mesh);
  const underObject = buildUnderObjectShading(ctx, datum);
  if (underObject) root.add(underObject.mesh);
  const practicals = buildNightPracticals(ctx, practical, datum, streets);
  for (const part of practicals.parts) root.add(part.mesh);
  const wet = buildWetSheen(ctx, city, wetAsphalt, datum);
  if (wet) root.add(wet.mesh);
  // Sun-tracked grounding for everything the shadow map refused. Empty at
  // build: the passes that own trees, vehicles and people have not run yet.
  const grounding = buildGrounding(MAX_GROUNDING_ANCHORS);
  root.add(grounding.mesh);

  // Deliberately *not* hiding the renderer's own `sky-dome` or
  // `contact-shadows`.
  //
  // The dome does not need hiding: both domes are opaque with
  // `depthWrite: false`, so they sit in the same render list sorted by
  // `renderOrder`, and this one is -9 against the legacy -10. It therefore
  // paints over the legacy dome completely, every frame, at any radius. Setting
  // `visible = false` on it instead would have a side effect nothing here
  // wants: the legacy dome is deliberately left raycastable so the capture
  // harness's ground-coverage probe can report a hole in the world by name, and
  // `Raycaster` skips invisible objects. A cosmetic pass must not quietly
  // disable someone else's hole detector.
  //
  // The contact blob is left alone for a different reason: it is another
  // subsystem's object, and this pass is additive by design. Its residue is a
  // soft patch under each building's bounding box, mostly hidden by the
  // building; the skirt above is what lands on the visible pavement. Removing
  // it is a one-line change in the renderer and is written up in the handoff
  // rather than taken unilaterally while other owners are in the same tree.
  const suppressed = [];

  const scene = ctx?.scene || null;
  // The renderer owns `scene.fog` and rewrites its colour on every clock move.
  // This pass takes over the numbers (aerial perspective is the atmosphere
  // subsystem's job) but records what it found so `dispose()` can hand the
  // scene back exactly as it was, rather than leaving a disposed pass's depth
  // budget behind on a live renderer.
  const originalFog = scene?.fog
    ? { near: scene.fog.near, far: scene.fog.far, color: scene.fog.color.clone() }
    : null;

  const state = {
    root,
    scene,
    originalFog,
    sky,
    clouds,
    haze,
    contact,
    underObject,
    practicals,
    wet,
    grounding,
    suppressed,
    radius,
    mapSpan,
    weather,
    datum,
    heightAt: typeof ctx?.heightAt === 'function' ? ctx.heightAt : null,
    /** Frames since build, for the deferred grounding scans. */
    frames: 0,
    /** Last model/balance, so the per-frame grounding needs no recompute. */
    model,
    illuminance: exposure.illuminance,
    balance,
    aoScale: 1,
    bucket: null,
    /** The live sky model. The fog colour is sampled out of it every frame. */
    model,
    fogNear: aerial.near,
    fogFar: aerial.far,
    fogColor: new Color(),
    /** Linear RGB actually handed to the fog, kept for diagnostics. */
    fogRgb: [0, 0, 0],
    hazeRgb: aerial.haze.color,
    lastCameraX: 0,
    lastCameraZ: 0,
  };

  retimeSky(sky, model, cloud, exposure.exposure);
  retimeClouds(clouds, cloud);
  retimeAerial(state, aerial, ctx?.camera);
  retimePracticals(state, practical, exposure.exposure);
  retimeWet(state, wetAsphalt);
  retimeContactAO(state, exposure.illuminance);
  retimeGrounding(state, model, balance);
  state.bucket = `${weather}|${quantiseHour(hour, SKY_ATMOSPHERE_BUDGET.hourQuantum).toFixed(4)}`;

  let textureBytes = 0;
  const countTexture = (texture) => {
    const image = texture?.image;
    if (!image) return;
    textureBytes += finite(image.width, 0) * finite(image.height, 0) * 4;
  };
  for (const texture of sky.textures) countTexture(texture);
  for (const texture of clouds.textures) countTexture(texture);
  countTexture(haze.texture);
  if (contact) countTexture(contact.texture);
  if (underObject) countTexture(underObject.texture);
  for (const texture of practicals.textures) countTexture(texture);
  if (wet) countTexture(wet.texture);
  countTexture(grounding.texture);

  const round4 = (value) => Math.round(value * 10000) / 10000;
  const round4v = (rgb) => [round4(rgb[0]), round4(rgb[1]), round4(rgb[2])];

  const diagnostics = {
    pass: SKY_ATMOSPHERE_VERSION,
    model: ATMOSPHERE_MODEL_VERSION,
    implemented: true,
    hour: model.hour,
    requestedHour: model.requestedHour,
    weather,
    mapSpan: Math.round(mapSpan),
    domeRadius: Math.round(radius),
    sun: {
      altitudeDeg: Math.round(model.sun.altitudeDeg * 100) / 100,
      azimuthDeg: Math.round(model.sun.azimuthDeg * 100) / 100,
      daylight: Math.round(model.daylight * 1000) / 1000,
    },
    exposure: {
      recommended: exposure.exposure,
      illuminance: exposure.illuminance,
      reference: exposure.reference,
      clamped: exposure.clamped,
    },
    keyFill: {
      measured: balance.measured.ratio,
      target: balance.target.ratio,
      achieved: balance.achieved.ratio,
      gains: balance.gains,
      apply: balance.apply,
      shadow: balance.shadow,
    },
    sky: {
      zenithLuminance: Math.round(model.zenithLuminance * 10000) / 10000,
      horizonLuminance: Math.round(model.horizonLuminance * 10000) / 10000,
      sunwardContrast: Math.round(model.sunwardContrast * 1000) / 1000,
      stars: STAR_COUNT,
      sunDiscVisible: sky.disc.visible,
      moonVisible: sky.moon.visible,
      dither: {
        steps: DITHER_STEPS,
        amplitude: sky.ditherAmplitude,
        reference: sky.ditherReference,
        repeat: DITHER_REPEAT,
        textureSize: DITHER_TEXTURE_SIZE,
      },
    },
    fog: {
      near: aerial.near,
      far: aerial.far,
      /** What the fog is actually set to: the sky at the view azimuth. */
      color: round4v(state.fogRgb),
      colorLuminance: round4(luminanceOf(state.fogRgb)),
      /** The ceiling it is clamped against: the model's measured skyline. */
      skyCeiling: round4v(model.horizonRadiance),
      skyCeilingLuminance: round4(model.horizonLuminance),
      /** The averaged, sun-biased term this pass no longer hands to the fog. */
      moduleColor: aerial.color,
      moduleColorLuminance: aerial.colorLuminance,
      rendererRule: aerial.rendererRule,
      scale: aerial.scale,
      haze: {
        ...aerial.haze,
        color: round4v(state.hazeRgb),
        moduleColor: aerial.haze.color,
      },
      note: 'fog colour is skyDomeRadiance sampled at the view azimuth and +2 deg, '
        + 'luminance-clamped to the model\'s own horizonLuminance and then per-channel '
        + 'clamped to horizonRadiance; near/far are still the module\'s map-span grade',
    },
    clouds: {
      coverage: cloud.coverage,
      layers: cloud.layers.map((layer, index) => ({
        name: layer.name,
        opacity: layer.opacity,
        driftU: layer.driftU,
        driftV: layer.driftV,
        textureSize: clouds.layers[index]?.stats?.size ?? null,
        metresPerTexel: clouds.layers[index]?.metresPerTexel ?? null,
        altitude: clouds.layers[index]?.altitude ?? null,
        detail: clouds.layers[index]?.stats ?? null,
      })),
      textureSize: CLOUD_TEXTURE_SIZE,
      highTextureSize: Math.round(CLOUD_TEXTURE_SIZE * CLOUD_HIGH_SCALE),
      detailOctaves: CLOUD_DETAIL_OCTAVES,
      note: 'each deck is a base fBm sheet with a sheared, 2:1 stretched second octave '
        + 'composited over it; the composite holds the base sheet\'s coverage-weighted '
        + 'mean shade so only the structure changes, not the deck\'s brightness',
    },
    datum: {
      roadLift: datum.roadLift,
      footwayLift: Math.round(datum.footwayLift * 1000) / 1000,
      streetCells: proximity.cells,
      indexedStreetCells: streets.cells,
      crossSlope: datum.crossSlope,
      contactWidth: CONTACT_WIDTH,
      note: 'ground decals sit on the paved datum, not on the terrain: the carriageway is '
        + 'terrain+roadLift and the footway is a further curbFaceHeight-gutterDepth above it',
    },
    lights: {
      lampPools: practicals.lamps,
      carriagewayPools: practicals.carriagewayPools,
      poolRadius: practical.pool.radius,
      poolFalloff: practical.pool.falloff,
      carriageway: practical.pool.carriageway,
      shopSpills: practicals.spills,
      bulbGlows: practicals.lamps,
      windowOccupancy: practical.windows.occupancy,
      windowCoolShare: practical.windows.coolShare,
      practicalProfile: practical,
    },
    contact: {
      footprints: contact?.footprints ?? 0,
      quads: contact?.quads ?? 0,
      skipped: contact?.skipped ?? 0,
      vehicles: underObject?.vehicles ?? 0,
      canopies: underObject?.canopies ?? 0,
      screenSpaceAvailable: false,
      /** Metres. Read off `contactShadowLeakMetres()`, not chosen. */
      width: CONTACT_WIDTH,
      mitreClamp: CONTACT_MITRE_CLAMP,
      alpha: CONTACT_ALPHA,
      /** 0..1: how much sky there is for this AO term to occlude, right now. */
      aoScale: state.aoScale,
      sunIndependent: true,
      note: 'ambient occlusion, not shadow: a crevice line exactly as wide as the shadow '
        + "map's own measured contact leak, scaled by the sky illuminance it occludes, so "
        + 'it is a hairline at night instead of a wedge',
    },
    grounding: {
      version: 'shadow-grounding-v1',
      capacity: MAX_GROUNDING_ANCHORS,
      anchors: grounding.anchors.length,
      quads: grounding.quads,
      collects: grounding.collects,
      audit: grounding.audit,
      keyShare: grounding.keyShare ?? 0,
      opacity: grounding.material.opacity,
      active: Boolean(grounding.frame?.active),
      reason: grounding.frame?.reason ?? null,
      direction: grounding.frame?.active
        ? { x: grounding.frame.dirX, z: grounding.frame.dirZ }
        : null,
      lift: GROUNDING_LIFT,
      defaults: GROUNDING_DEFAULTS,
      note: 'projected contact shadows for the casters the shadow map refused as sub-texel. '
        + 'Opacity is the key share of scene illuminance, so the element is gone whenever '
        + 'the sun is',
    },
    wet: {
      wetness: wetAsphalt.wetness,
      roughness: wetAsphalt.roughness,
      dryRoughness: wetAsphalt.dryRoughness,
      colorScale: wetAsphalt.colorScale,
      envMapIntensity: wetAsphalt.envMapIntensity,
      puddles: wet?.puddles ?? 0,
      /** Built in every bucket so a runtime `setWeather` needs no rebuild. */
      builtDry: true,
      visible: Boolean(wet?.mesh.visible),
    },
    suppressedLegacy: suppressed.map((entry) => entry.name),
    budget: {
      declared: SKY_ATMOSPHERE_BUDGET,
      textureBytes,
    },
    schedule: daySchedule(weather, mapSpan),
  };

  return { state, root, diagnostics };
}

export default {
  id: 'sky-atmosphere',
  order: 10,

  build(ctx) {
    try {
      if (live) {
        // A rebuild without a dispose would leak the previous world's meshes
        // and leave the legacy dome hidden by an object that no longer exists.
        this.dispose();
      }
      const { state, root, diagnostics } = buildPass(ctx || {});
      live = state;
      return { object: root, diagnostics };
    } catch (error) {
      // The contract says a pass must not take the world down. A frame with no
      // sky content is worse-looking, not broken.
      return {
        object: null,
        diagnostics: {
          pass: SKY_ATMOSPHERE_VERSION,
          implemented: false,
          error: String(error?.message || error),
        },
      };
    }
  },

  update(ctx) {
    const state = live;
    if (!state) return;
    const camera = ctx?.camera;
    const cx = finite(camera?.position?.x, state.lastCameraX);
    const cz = finite(camera?.position?.z, state.lastCameraZ);
    state.lastCameraX = cx;
    state.lastCameraZ = cz;

    // The dome, the cloud decks and the haze band are atmosphere, not objects:
    // they travel with the viewer. Only their *texture* stays world-anchored,
    // which is what produces parallax without ever leaving the far plane.
    state.sky.group.position.set(cx, 0, cz);
    state.clouds.group.position.set(cx, 0, cz);
    state.haze.mesh.position.set(cx, 0, cz);

    const hour = finite(ctx?.hour, 12);
    for (const layer of state.clouds.layers) {
      const offset = layer.texture.offset;
      if (offset) {
        offset.set(
          -cx / layer.tile + (hour * layer.spec.driftU) % 1,
          -cz / layer.tile + (hour * layer.spec.driftV) % 1,
        );
      }
    }

    // Grounding runs every frame, not on the hour bucket: half its anchors are
    // walking or driving, and a projected contact that stays where its owner
    // used to be is worse than none at all. The cost is one matrix apply and
    // twelve float writes per anchor, and it early-outs entirely when the sun
    // is down.
    state.frames += 1;
    if (state.grounding && GROUNDING_COLLECT_FRAMES.includes(state.frames)) {
      collectGrounding(state, ctx);
    }
    if (state.grounding?.anchors.length) {
      retimeGrounding(state, state.model, state.balance);
    }

    // Re-assert the fog every frame. `setTimeOfDay` writes `scene.fog.color`
    // from its own palette whenever the clock moves, and it runs before the
    // pass runtime in the same frame, so a value written only on a bucket
    // change would be overwritten within one tick.
    //
    // The colour is re-derived here rather than merely re-copied, because
    // aerial perspective is view-dependent: the sky the far field converges on
    // is the sky at the azimuth the camera is pointing down, which on the
    // canonical 15:00 clear model runs from luminance 0.826 anti-solar to the
    // 1.240 ceiling. Cost is one `skyDomeRadiance` per frame - a handful of
    // exp() on a cached Preetham state, measured below in the verifier's
    // per-frame update timing - and it is a pure function of the pose, so a
    // pinned capture still reproduces exactly.
    const fog = state.scene?.fog;
    if (fog) {
      applyFogColor(state, camera);
      fog.near = state.fogNear;
      fog.far = state.fogFar;
      fog.color.copy(state.fogColor);
    }

    let weather = state.weather;
    try {
      weather = normaliseWeather(ctx?.weather);
    } catch {
      weather = state.weather;
    }
    const bucket = `${weather}|${quantiseHour(hour, SKY_ATMOSPHERE_BUDGET.hourQuantum).toFixed(4)}`;
    if (bucket === state.bucket) return;
    state.bucket = bucket;

    // Weather changed the cloud sheets themselves, which needs a rebake; the
    // caller does that by rebuilding, so here the deck simply keeps its shape
    // and takes the new opacity and tint.
    const model = computeSkyModel({ hour, weather });
    const aerial = aerialPerspective({ model, mapSpan: state.mapSpan });
    const cloud = cloudProfile(model);
    const practical = nightPracticalProfile(model);
    state.weather = weather;
    state.model = model;
    state.fogNear = aerial.near;
    state.fogFar = aerial.far;
    retimeSky(state.sky, model, cloud, recommendedExposure(model).exposure);
    retimeClouds(state.clouds, cloud);
    retimeAerial(state, aerial, camera);
    const exposure = recommendedExposure(model);
    state.illuminance = exposure.illuminance;
    state.balance = keyFillBalance(model);
    retimePracticals(state, practical, exposure.exposure);
    retimeWet(state, wetSurfaceGrade('asphalt', model));
    retimeContactAO(state, exposure.illuminance);
    retimeGrounding(state, model, state.balance);
  },

  dispose() {
    const state = live;
    live = null;
    if (!state) return;
    for (const entry of state.suppressed) {
      if (entry.object) entry.object.visible = true;
    }
    const fog = state.scene?.fog;
    if (fog && state.originalFog) {
      fog.near = state.originalFog.near;
      fog.far = state.originalFog.far;
      fog.color.copy(state.originalFog.color);
    }
    // The pass runtime disposes the geometry and materials it can reach
    // through the returned object; the textures those materials share are
    // disposed here so a rebuild does not orphan them.
    const textures = [
      ...state.sky.textures,
      ...state.clouds.textures,
      state.haze.texture,
      state.contact?.texture,
      state.underObject?.texture,
      ...(state.practicals?.textures || []),
      state.wet?.texture,
      state.grounding?.texture,
    ];
    for (const texture of textures) texture?.dispose?.();
    // The grounding anchors hold references to other passes' meshes. Dropping
    // them here is the difference between a disposed world and a retained one.
    if (state.grounding) state.grounding.anchors = [];
  },

  /** Exposed for the headless verifier; never called by the runtime. */
  _inspect() {
    return live;
  },
};
