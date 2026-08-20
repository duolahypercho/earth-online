/**
 * Image-based lighting (IBL) for the canonical city renderer.
 *
 * Why this module exists
 * ----------------------
 * The renderer builds dozens of `MeshStandardMaterial` instances but never sets
 * `scene.environment`. A physically based material with no environment has no
 * specular response at all: metals go black, dielectrics lose their Fresnel
 * rim, and every facade reads as flat painted card. This module produces a
 * prefiltered radiance environment map (PMREM) from an analytic sky so those
 * materials finally have something to reflect.
 *
 * Design
 * ------
 * The module is split into two halves so the colour science is testable in
 * plain node with no WebGL, no DOM and no canvas:
 *
 *   1. A **pure** sky model. `computeSkyModel()` turns `{ hour, weather }`
 *      into a frozen description of the sky (sun direction, turbidity,
 *      zenith/horizon radiance, irradiance estimate, recommended
 *      `envMapIntensity` per material class, recommended light-rig values).
 *      `sampleSkyRadiance()` and `renderEquirectRadiance()` evaluate it.
 *      These functions import nothing from three and touch no GPU state.
 *
 *   2. A **GPU** rig. `createEnvironmentRig(renderer)` wraps a
 *      `PMREMGenerator`, uploads the pure equirect radiance buffer as a
 *      half-float `DataTexture`, prefilters it, and assigns the result to
 *      `scene.environment`. Results are cached by quantised hour + weather so
 *      the PMREM is not regenerated per frame.
 *
 * Sky colour science
 * ------------------
 * The daylight dome is a CPU port of the Preetham analytic daylight model
 * (the same formulation three.js ships in its sky example), evaluated in
 * linear radiance instead of the example's artistic gamma curve. Overcast
 * weather blends that dome toward the CIE standard overcast distribution
 * `L(theta) = Lz * (1 + 2 cos(theta)) / 3` and toward isotropy. Below the
 * horizon the dome is replaced by a bounce term derived from the sky
 * irradiance and a ground albedo, because a black lower hemisphere is the
 * classic "PBR object floating in a void" tell.
 *
 * The solar disc is deliberately **not** baked into the environment by
 * default (`sunDiscIntensity: 0`). The renderer already owns a
 * `DirectionalLight` key; baking the disc as well would double-count the sun
 * and produce PMREM ringing. The Mie aureole around the sun is kept, so the
 * sky still biases specular toward the sun direction.
 *
 * Determinism
 * -----------
 * No `Math.random()`, no `Date.now()`. Every output is a pure function of the
 * arguments. Hemispherical integrals use a fixed Fibonacci lattice.
 *
 * Constraints honoured
 * --------------------
 * - No new renderer, canvas, animation loop or scene root is created.
 * - No `ShaderMaterial` / `onBeforeCompile` is introduced; the only shaders
 *   involved are the ones `PMREMGenerator` already owns internally.
 * - No new npm dependency.
 * - Works on the WebGL2 fallback path of `WebGPURenderer`.
 *
 * @module src/render/environment-ibl
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  PMREMGenerator,
  RGBAFormat,
  RepeatWrapping,
} from 'three/webgpu';

/**
 * Identity of the sky colour model. Bump this whenever the radiance output
 * changes so cached PMREM targets and captured evidence cannot be confused
 * across versions.
 * @type {string}
 */
export const SKY_MODEL_VERSION = 'earthonline-sky-ibl-v1';

/** Supported weather keys. @type {readonly string[]} */
export const WEATHER_KINDS = Object.freeze(['clear', 'fog', 'drizzle']);

/** Material classes with a recommended `envMapIntensity`. @type {readonly string[]} */
export const MATERIAL_CLASSES = Object.freeze([
  'facade-glass',
  'facade-masonry',
  'facade-painted',
  'facade-metal',
  'asphalt',
  'sidewalk',
  'painted-metal',
  'chrome',
  'water',
  'foliage',
  'fabric',
]);

/**
 * The light rig the renderer ships with today, recorded here so
 * `recommendedLightRig()` can express its advice as both absolute values and
 * scale factors against the known baseline.
 * @type {Readonly<{sun:number, hemi:number, ambient:number, rim:number}>}
 */
export const BASELINE_LIGHT_RIG = Object.freeze({
  sun: 2.75,
  hemi: 1.38,
  ambient: 0.3,
  rim: 0.6,
});

/** Default site: San Francisco. */
const DEFAULT_SITE = Object.freeze({
  latitudeDeg: 37.7749,
  longitudeDeg: -122.4194,
  timezoneOffsetHours: -8,
  // Late September: a near-equinox sun path, which puts the 15:00 sun at
  // roughly the altitude/azimuth the existing hard-coded key light uses.
  dayOfYear: 264,
});

// --- Preetham constants (wavelengths 680/550/450 nm) -------------------------
const TOTAL_RAYLEIGH = Object.freeze([5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5]);
const MIE_CONST = Object.freeze([1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14]);
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const SUN_ENERGY = 1000;
const THREE_OVER_SIXTEEN_PI = 0.05968310365946075;
const ONE_OVER_FOUR_PI = 0.07957747154594767;
const SUN_ANGULAR_DIAMETER_COS = 0.9999566769464485;
/**
 * Twilight afterglow. Preetham has no below-horizon sun: once the sun drops
 * past about -2 deg its dome collapses to a constant, so without this term
 * 18:30 would light the city exactly like 03:00. This adds a warm glow banded
 * on the sunward horizon that peaks just after sunset and is gone by the end
 * of nautical twilight.
 */
const TWILIGHT_COLOR = Object.freeze([0.160, 0.075, 0.055]);
const TWILIGHT_BEGIN_SIN = Math.sin(1 * Math.PI / 180);
const TWILIGHT_END_SIN = Math.sin(-14 * Math.PI / 180);

/** Sky -> ground crossfade width, as sin(angle) below the horizon. */
const GROUND_BLEND_SIN = Math.sin(4 * Math.PI / 180);
const PREETHAM_RADIANCE_SCALE = 0.04;
const NIGHT_FLOOR = Object.freeze([0, 0.0003, 0.00075]);

/**
 * Calibration from Preetham's arbitrary radiance units into three.js punctual
 * light units, so the environment sits alongside the existing rig instead of
 * swamping it.
 *
 * Reference point: clear sky, San Francisco, 12:00. The current rig fills an
 * up-facing surface with roughly `hemi(1.38) + ambient(0.30) ~= 1.7` while the
 * key light delivers `sun(2.75) * sin(altitude)`. This scale puts the clear
 * midday sky irradiance at ~1.3, i.e. the environment can take over the fill
 * without out-running the key.
 */
const SKY_RADIANCE_SCALE = 0.2;

/** The key-light intensity the ground-bounce term assumes. */
const SUN_KEY_IRRADIANCE = BASELINE_LIGHT_RIG.sun;

/** Slightly warm bias for sun-lit ground bounce. */
const GROUND_SUN_TINT = Object.freeze([1.06, 1.0, 0.9]);

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// --- small pure helpers ------------------------------------------------------

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const mix = (a, b, t) => a + (b - a) * t;

const smoothstep = (edge0, edge1, x) => {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Relative luminance of a linear-sRGB triple. */
const luminance = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

/**
 * Wrap an hour into [0, 24).
 * @param {number} hour
 * @returns {number}
 */
export function wrapHour(hour) {
  if (!isFiniteNumber(hour)) throw new TypeError(`environment-ibl: hour must be a finite number, got ${hour}`);
  const wrapped = hour % 24;
  return wrapped < 0 ? wrapped + 24 : wrapped;
}

/**
 * Quantise an hour so the PMREM is regenerated at most once per bucket.
 * Rounds to the nearest multiple of `quantum` and wraps back into [0, 24).
 *
 * @param {number} hour Hour of day, any real number.
 * @param {number} [quantum=0.25] Bucket size in hours.
 * @returns {number} Quantised hour in [0, 24).
 */
export function quantiseHour(hour, quantum = 0.25) {
  if (!isFiniteNumber(quantum) || quantum <= 0) {
    throw new TypeError(`environment-ibl: quantum must be a positive number, got ${quantum}`);
  }
  const wrapped = wrapHour(hour);
  // Round-half-up on a 1e-6 grid keeps the bucket boundary deterministic
  // across platforms instead of depending on binary float noise.
  const buckets = Math.floor(wrapped / quantum + 0.5 + 1e-9);
  return wrapHour(buckets * quantum);
}

/**
 * Normalise and validate a weather key.
 * @param {string} weather
 * @returns {'clear'|'fog'|'drizzle'}
 */
export function normaliseWeather(weather) {
  const key = typeof weather === 'string' ? weather.toLowerCase() : '';
  if (!WEATHER_KINDS.includes(key)) {
    throw new TypeError(`environment-ibl: unknown weather '${weather}', expected one of ${WEATHER_KINDS.join('|')}`);
  }
  return /** @type {'clear'|'fog'|'drizzle'} */ (key);
}

/**
 * Stable cache key for a quantised sky state.
 * @param {{hour:number, weather:string, quantum?:number}} state
 * @returns {string}
 */
export function environmentCacheKey({ hour, weather, quantum = 0.25 }) {
  const q = quantiseHour(hour, quantum);
  return `${SKY_MODEL_VERSION}|${normaliseWeather(weather)}|${q.toFixed(4)}`;
}

// --- solar position ----------------------------------------------------------

/**
 * NOAA solar-position approximation.
 *
 * @param {number} hour Local clock hour, 0..24.
 * @param {object} [site]
 * @param {number} [site.latitudeDeg]
 * @param {number} [site.longitudeDeg]
 * @param {number} [site.timezoneOffsetHours]
 * @param {number} [site.dayOfYear] 1..365.
 * @returns {{x:number,y:number,z:number,altitudeDeg:number,azimuthDeg:number,declinationDeg:number}}
 *   Unit direction **toward** the sun in world space (+X east, +Y up, -Z north),
 *   plus altitude above the horizon and azimuth clockwise from north.
 */
export function computeSunDirection(hour, site = {}) {
  const {
    latitudeDeg = DEFAULT_SITE.latitudeDeg,
    longitudeDeg = DEFAULT_SITE.longitudeDeg,
    timezoneOffsetHours = DEFAULT_SITE.timezoneOffsetHours,
    dayOfYear = DEFAULT_SITE.dayOfYear,
  } = site;
  const h = wrapHour(hour);

  const gamma = (TAU / 365) * (dayOfYear - 1 + (h - 12) / 24);
  const eqTimeMinutes = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );
  const declination = 0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);

  const timeOffset = eqTimeMinutes + 4 * longitudeDeg - 60 * timezoneOffsetHours;
  const trueSolarTime = h * 60 + timeOffset;
  const hourAngle = (trueSolarTime / 4 - 180) * DEG;

  const lat = latitudeDeg * DEG;
  const cosZenith = clamp(
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle),
    -1,
    1,
  );
  const altitude = Math.asin(cosZenith);
  // Azimuth measured from south, positive west; shifted to clockwise-from-north.
  const azimuthFromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat),
  );
  let azimuth = azimuthFromSouth + Math.PI;
  if (azimuth < 0) azimuth += TAU;
  if (azimuth >= TAU) azimuth -= TAU;

  const cosAlt = Math.cos(altitude);
  return Object.freeze({
    x: Math.sin(azimuth) * cosAlt,
    y: Math.sin(altitude),
    z: -Math.cos(azimuth) * cosAlt,
    altitudeDeg: altitude / DEG,
    azimuthDeg: azimuth / DEG,
    declinationDeg: declination / DEG,
  });
}

// --- weather -----------------------------------------------------------------

/**
 * Atmospheric parameters per weather kind.
 *
 * `turbidity` and `mieCoefficient` drive the Preetham scattering directly.
 * `overcast` blends toward the CIE overcast dome, `isotropy` blends toward a
 * uniform dome. `brightness` is the diffuse transmission **relative to a clear
 * sky with the same sun** - the dome is energy-normalised against a clear
 * reference first, so raising turbidity changes the sky's shape and colour
 * without accidentally making an overcast day brighter than a clear one.
 * `desaturation` pulls the dome toward neutral grey at constant luminance,
 * which is what a fog or rain dome actually looks like. `tint` is the final
 * chromatic grade. `wetness` is
 * consumed by the `envMapIntensity` table (wet asphalt is far more reflective
 * than dry asphalt, which is the single cheapest rain cue there is).
 *
 * @param {'clear'|'fog'|'drizzle'} weather
 * @returns {Readonly<object>}
 */
export function weatherProfile(weather) {
  const key = normaliseWeather(weather);
  switch (key) {
    case 'fog':
      return Object.freeze({
        weather: key,
        turbidity: 9.5,
        rayleigh: 1.6,
        mieCoefficient: 0.021,
        mieDirectionalG: 0.72,
        overcast: 0.9,
        isotropy: 0.7,
        desaturation: 0.7,
        brightness: 0.62,
        tint: Object.freeze([0.98, 1.0, 1.02]),
        wetness: 0.3,
        groundAlbedo: Object.freeze([0.16, 0.16, 0.155]),
        urbanGlow: 0.85,
      });
    case 'drizzle':
      return Object.freeze({
        weather: key,
        turbidity: 6.0,
        rayleigh: 1.3,
        mieCoefficient: 0.013,
        mieDirectionalG: 0.78,
        overcast: 0.85,
        isotropy: 0.35,
        desaturation: 0.55,
        brightness: 0.38,
        tint: Object.freeze([0.94, 0.98, 1.06]),
        wetness: 1.0,
        // Wet ground is darker and less saturated than dry ground.
        groundAlbedo: Object.freeze([0.075, 0.078, 0.082]),
        urbanGlow: 1.0,
      });
    case 'clear':
    default:
      return Object.freeze({
        weather: key,
        turbidity: 2.4,
        rayleigh: 1.6,
        mieCoefficient: 0.005,
        mieDirectionalG: 0.8,
        overcast: 0,
        isotropy: 0,
        desaturation: 0,
        brightness: 1,
        tint: Object.freeze([1, 1, 1]),
        wetness: 0,
        groundAlbedo: Object.freeze([0.17, 0.165, 0.15]),
        urbanGlow: 0.6,
      });
  }
}

// --- Preetham dome -----------------------------------------------------------

const sunIntensityAt = (zenithAngleCos) => {
  const c = clamp(zenithAngleCos, -1, 1);
  return SUN_ENERGY * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(c)) / STEEPNESS)));
};

const totalMie = (turbidity) => {
  // GLSL `10E-18` is 1e-17.
  const c = 0.2 * turbidity * 1e-17;
  return [0.434 * c * MIE_CONST[0], 0.434 * c * MIE_CONST[1], 0.434 * c * MIE_CONST[2]];
};

/**
 * Pre-compute everything in the Preetham model that depends only on the sun,
 * not on the view direction. Called once per sky model, then reused for every
 * texel.
 * @private
 */
function preethamState(sun, profile, sunDiscIntensity) {
  const sunE = sunIntensityAt(sun.y);
  const sunFade = 1 - clamp(1 - Math.exp(sun.y), 0, 1);
  const rayleighCoefficient = profile.rayleigh - (1 - sunFade);
  const betaR = [
    TOTAL_RAYLEIGH[0] * rayleighCoefficient,
    TOTAL_RAYLEIGH[1] * rayleighCoefficient,
    TOTAL_RAYLEIGH[2] * rayleighCoefficient,
  ];
  const mie = totalMie(profile.turbidity);
  const betaM = [
    mie[0] * profile.mieCoefficient,
    mie[1] * profile.mieCoefficient,
    mie[2] * profile.mieCoefficient,
  ];
  return {
    sunE,
    sunFade,
    betaR,
    betaM,
    betaSum: [betaR[0] + betaM[0], betaR[1] + betaM[1], betaR[2] + betaM[2]],
    horizonUp: clamp(Math.pow(1 - sun.y, 5), 0, 1),
    g: profile.mieDirectionalG,
    sunDiscIntensity,
  };
}

/**
 * View-direction terms of the Preetham model that depend only on elevation
 * (the optical-depth extinction `Fex`). Hoisted out of the texel loop, because
 * this is where the three `exp()` calls live: an equirect row shares one.
 * @private
 * @returns {[number,number,number]}
 */
function preethamRow(state, dy) {
  const up = Math.max(0, dy);
  const zenithAngle = Math.acos(up);
  const inverse = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle / DEG), -1.253));
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  const sM = MIE_ZENITH_LENGTH * inverse;
  return [
    Math.exp(-(state.betaR[0] * sR + state.betaM[0] * sM)),
    Math.exp(-(state.betaR[1] * sR + state.betaM[1] * sM)),
    Math.exp(-(state.betaR[2] * sR + state.betaM[2] * sM)),
  ];
}

/**
 * Finish the Preetham evaluation for one direction, given its row extinction
 * and the cosine of the angle to the sun. Writes linear radiance into `out`.
 * @private
 * @returns {number[]} `out`
 */
function preethamRadianceRow(state, fex, cosTheta, out) {
  const rCos = cosTheta * 0.5 + 0.5;
  const rPhase = THREE_OVER_SIXTEEN_PI * (1 + rCos * rCos);
  const g = state.g;
  const g2 = g * g;
  // pow(q, 1.5) written as q * sqrt(q): this runs once per texel.
  const q = Math.max(1e-6, 1 - 2 * g * cosTheta + g2);
  const mPhase = ONE_OVER_FOUR_PI * ((1 - g2) / (q * Math.sqrt(q)));
  const withDisc = state.sunDiscIntensity > 0 && cosTheta > SUN_ANGULAR_DIAMETER_COS;
  for (let i = 0; i < 3; i += 1) {
    const f = fex[i];
    const betaTheta = state.betaR[i] * rPhase + state.betaM[i] * mPhase;
    const ratio = betaTheta / state.betaSum[i];
    const inScatter = Math.max(0, state.sunE * ratio * (1 - f));
    let lin = inScatter * Math.sqrt(inScatter);
    const horizonTerm = Math.sqrt(Math.max(0, state.sunE * ratio * f));
    lin *= mix(1, horizonTerm, state.horizonUp);
    let l0 = 0.1 * f;
    if (withDisc) l0 += state.sunE * 19000 * f * state.sunDiscIntensity;
    out[i] = (lin + l0) * PREETHAM_RADIANCE_SCALE + NIGHT_FLOOR[i];
  }
  return out;
}

/**
 * Evaluate the clear-sky Preetham dome for one direction, in linear radiance.
 * Directions below the horizon are evaluated at the horizon; the caller
 * replaces them with the ground bounce.
 * @private
 * @returns {number[]}
 */
function preethamRadiance(state, dx, dy, dz, sun, out = [0, 0, 0]) {
  const cosTheta = clamp(dx * sun.x + dy * sun.y + dz * sun.z, -1, 1);
  return preethamRadianceRow(state, preethamRow(state, dy), cosTheta, out);
}

/**
 * Deterministic Fibonacci lattice over the upper hemisphere.
 * @private
 */
function hemisphereSamples(count) {
  const dirs = new Float64Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    // Cosine-free uniform-solid-angle distribution over the hemisphere.
    const y = (i + 0.5) / count;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * golden;
    dirs[i * 3] = Math.cos(phi) * r;
    dirs[i * 3 + 1] = y;
    dirs[i * 3 + 2] = Math.sin(phi) * r;
  }
  return dirs;
}

const IRRADIANCE_SAMPLES = 512;
const IRRADIANCE_DIRS = hemisphereSamples(IRRADIANCE_SAMPLES);

/**
 * Mean upper-hemisphere luminance of the *clear* Preetham dome for a given
 * sun. Used to energy-normalise the other weather profiles. Memoised on the
 * sun elevation, because the sky model is only rebuilt when the hour bucket
 * changes.
 * @private
 */
const _clearReferenceCache = new Map();
function clearReferenceMeanLuminance(sun, sunDiscIntensity) {
  const key = `${Math.round(sun.y * 1e6)}|${sunDiscIntensity}`;
  const cached = _clearReferenceCache.get(key);
  if (cached !== undefined) return cached;
  const state = preethamState(sun, weatherProfile('clear'), sunDiscIntensity);
  let sum = 0;
  for (let i = 0; i < IRRADIANCE_SAMPLES; i += 1) {
    sum += luminance(preethamRadiance(
      state,
      IRRADIANCE_DIRS[i * 3],
      IRRADIANCE_DIRS[i * 3 + 1],
      IRRADIANCE_DIRS[i * 3 + 2],
      sun,
    ));
  }
  const value = Math.max(1e-9, sum / IRRADIANCE_SAMPLES);
  // Bounded memo: the rig only ever visits 96 hour buckets per weather kind.
  if (_clearReferenceCache.size > 512) _clearReferenceCache.clear();
  _clearReferenceCache.set(key, value);
  return value;
}

// --- sky model ---------------------------------------------------------------

/**
 * @typedef {object} SkyModel
 * @property {string} version
 * @property {number} hour Quantised hour actually used.
 * @property {number} requestedHour
 * @property {'clear'|'fog'|'drizzle'} weather
 * @property {{x:number,y:number,z:number,altitudeDeg:number,azimuthDeg:number}} sun
 * @property {number} turbidity
 * @property {number} daylight 0 at night, 1 in full day.
 * @property {number} night 1 - daylight.
 * @property {[number,number,number]} zenithRadiance Linear RGB.
 * @property {[number,number,number]} horizonRadiance Averaged around the compass.
 * @property {[number,number,number]} sunwardHorizonRadiance
 * @property {[number,number,number]} antisunHorizonRadiance
 * @property {[number,number,number]} groundRadiance
 * @property {[number,number,number]} skyIrradiance Cosine-weighted, upper hemisphere.
 * @property {number} skyIrradianceLuminance
 * @property {number} sunwardContrast sunward / antisun horizon luminance.
 * @property {Readonly<Record<string, number>>} envMapIntensity
 * @property {Readonly<object>} lightRig
 */

/**
 * Build the pure sky description for a time of day and weather.
 *
 * Everything here is CPU-only and deterministic; nothing touches three.js or
 * the GPU. This is the function the self-check asserts on.
 *
 * @param {object} options
 * @param {number} options.hour 0..24 (values outside are wrapped).
 * @param {'clear'|'fog'|'drizzle'} [options.weather='clear']
 * @param {number} [options.hourQuantum=0.25] Quantisation applied before evaluation.
 * @param {number} [options.exposure=1] Linear multiplier on all radiance.
 * @param {number} [options.sunDiscIntensity=0] Bake the solar disc into the env
 *   map. Leave at 0 while a `DirectionalLight` key exists, or the sun is counted twice.
 * @param {object} [options.site] Overrides for `computeSunDirection`.
 * @param {object} [options.overrides] Direct overrides for turbidity/rayleigh/
 *   mieCoefficient/mieDirectionalG/overcast/isotropy/brightness/wetness/groundAlbedo.
 * @returns {Readonly<SkyModel>}
 */
export function computeSkyModel(options = {}) {
  const {
    hour = 12,
    weather = 'clear',
    hourQuantum = 0.25,
    exposure = 1,
    sunDiscIntensity = 0,
    site = {},
    overrides = {},
  } = options;

  if (!isFiniteNumber(exposure) || exposure <= 0) {
    throw new TypeError(`environment-ibl: exposure must be a positive number, got ${exposure}`);
  }

  const requestedHour = wrapHour(hour);
  const quantised = quantiseHour(hour, hourQuantum);
  const profile = { ...weatherProfile(weather), ...overrides };
  const sun = computeSunDirection(quantised, { ...DEFAULT_SITE, ...site });

  // Daylight ramp: full daylight above +6 deg, full night below -6 deg
  // (civil twilight). Used to fade in the urban skyglow.
  const daylight = smoothstep(-0.10453, 0.10453, sun.y); // sin(+/-6 deg)
  const night = 1 - daylight;

  const state = preethamState(sun, profile, sunDiscIntensity);
  const tint = profile.tint;
  const urbanGlow = profile.urbanGlow ?? 0.6;
  const desaturation = clamp(profile.desaturation ?? 0, 0, 1);
  // Peaks just after sunset, zero in daylight and zero in deep night. Overcast
  // skies swallow the afterglow.
  const twilight = smoothstep(TWILIGHT_END_SIN, TWILIGHT_BEGIN_SIN, sun.y)
    * (1 - daylight) * (1 - profile.overcast * 0.7) * exposure;

  // Pass 1: the raw Preetham dome, needed to derive the overcast zenith
  // luminance and the mean radiance used by the isotropy blend.
  let meanR = 0;
  let meanG = 0;
  let meanB = 0;
  for (let i = 0; i < IRRADIANCE_SAMPLES; i += 1) {
    const dx = IRRADIANCE_DIRS[i * 3];
    const dy = IRRADIANCE_DIRS[i * 3 + 1];
    const dz = IRRADIANCE_DIRS[i * 3 + 2];
    const c = preethamRadiance(state, dx, dy, dz, sun);
    meanR += c[0];
    meanG += c[1];
    meanB += c[2];
  }
  meanR /= IRRADIANCE_SAMPLES;
  meanG /= IRRADIANCE_SAMPLES;
  meanB /= IRRADIANCE_SAMPLES;
  const mean = [meanR, meanG, meanB];

  // Energy normalisation. Preetham's absolute output climbs steeply with
  // turbidity, so a fog profile evaluated raw comes out brighter than a clear
  // sky, which is backwards. Rescale every weather dome onto the clear-sky
  // reference for the same sun, then let `brightness` express the real diffuse
  // transmission (fog 0.62, drizzle 0.38 of clear).
  const referenceMeanLuminance = clearReferenceMeanLuminance(sun, sunDiscIntensity);
  const meanLuminance = Math.max(1e-9, luminance(mean));
  const energyScale = referenceMeanLuminance / meanLuminance;
  const grade = profile.brightness * exposure * SKY_RADIANCE_SCALE * energyScale;

  // CIE overcast: the zenith is roughly 3x the horizon. Normalising by the
  // mean of (1 + 2 cos(theta)) / 3 over the hemisphere keeps total energy
  // close to the clear-sky dome before `brightness` grades it down.
  const overcastZenith = [meanR * 1.5, meanG * 1.5, meanB * 1.5];

  /**
   * Elevation-only terms shared by a whole equirect row.
   * @private
   */
  const rowState = (dy) => ({
    fex: preethamRow(state, dy),
    cieShape: (1 + 2 * Math.max(0, dy)) / 3,
    horizonWeight: Math.pow(1 - clamp(Math.abs(dy), 0, 1), 3),
  });

  /**
   * Radiance for one direction under the full model (Preetham + overcast +
   * isotropy + grade + night skyglow), excluding the ground hemisphere.
   * @private
   */
  const upperFromRow = (row, cosTheta, out = [0, 0, 0]) => {
    preethamRadianceRow(state, row.fex, cosTheta, out);
    for (let i = 0; i < 3; i += 1) {
      let v = mix(out[i], overcastZenith[i] * row.cieShape, profile.overcast);
      out[i] = mix(v, mean[i], profile.isotropy);
    }
    if (desaturation > 0) {
      // Luminance-preserving pull toward neutral: a fog dome is grey, not a
      // dimmer blue sky.
      const l = luminance(out);
      out[0] = mix(out[0], l, desaturation);
      out[1] = mix(out[1], l, desaturation);
      out[2] = mix(out[2], l, desaturation);
    }
    out[0] *= grade * tint[0];
    out[1] *= grade * tint[1];
    out[2] *= grade * tint[2];
    if (twilight > 0 && cosTheta > 0) {
      // Banded on the horizon and biased toward the sun's azimuth.
      const sunward = cosTheta * cosTheta;
      const band = twilight * row.horizonWeight * sunward;
      out[0] += band * TWILIGHT_COLOR[0];
      out[1] += band * TWILIGHT_COLOR[1];
      out[2] += band * TWILIGHT_COLOR[2];
    }
    if (night > 0) {
      // Moonless zenith plus a warm urban skyglow concentrated near the
      // horizon. Without this the night env map is black and every material
      // loses its specular again after sunset.
      const glow = night * urbanGlow * exposure;
      const hw = row.horizonWeight;
      out[0] += glow * (0.0090 + 0.0520 * hw);
      out[1] += glow * (0.0104 + 0.0328 * hw);
      out[2] += glow * (0.0176 + 0.0176 * hw);
    }
    return out;
  };

  const cosToSun = (dx, dy, dz) => clamp(dx * sun.x + dy * sun.y + dz * sun.z, -1, 1);
  const sampleUpper = (dx, dy, dz, out) => upperFromRow(rowState(dy), cosToSun(dx, dy, dz), out);

  // Cosine-weighted irradiance over the upper hemisphere: E = integral L cos(theta) dw.
  // Uniform solid-angle samples over 2pi sr, weighted by cos(theta).
  let irrR = 0;
  let irrG = 0;
  let irrB = 0;
  for (let i = 0; i < IRRADIANCE_SAMPLES; i += 1) {
    const dx = IRRADIANCE_DIRS[i * 3];
    const dy = IRRADIANCE_DIRS[i * 3 + 1];
    const dz = IRRADIANCE_DIRS[i * 3 + 2];
    const c = sampleUpper(dx, dy, dz);
    irrR += c[0] * dy;
    irrG += c[1] * dy;
    irrB += c[2] * dy;
  }
  const solidAngleWeight = TAU / IRRADIANCE_SAMPLES;
  const skyIrradiance = [irrR * solidAngleWeight, irrG * solidAngleWeight, irrB * solidAngleWeight];

  // Ground bounce: Lambertian half-space lit by the sky irradiance (plus the
  // sun's own contribution, approximated from its altitude) at `groundAlbedo`.
  const albedo = profile.groundAlbedo;
  // Direct sun contribution to the bounce, expressed as exitant radiance of a
  // Lambertian half-space: L = albedo * E / pi, with E = key * sin(altitude).
  const directGround = Math.max(0, sun.y) * SUN_KEY_IRRADIANCE / Math.PI
    * profile.brightness * exposure * (1 - profile.overcast * 0.8);
  const groundRadiance = [
    albedo[0] * (skyIrradiance[0] / Math.PI + directGround * GROUND_SUN_TINT[0]),
    albedo[1] * (skyIrradiance[1] / Math.PI + directGround * GROUND_SUN_TINT[1]),
    albedo[2] * (skyIrradiance[2] / Math.PI + directGround * GROUND_SUN_TINT[2]),
  ];

  const zenithRadiance = sampleUpper(0, 1, 0);

  // Horizon probes sit slightly above the horizon so they are pure sky.
  const horizonY = Math.sin(2 * DEG);
  const horizonR = Math.cos(2 * DEG);
  const probeAt = (azimuthRad) => sampleUpper(
    Math.sin(azimuthRad) * horizonR,
    horizonY,
    -Math.cos(azimuthRad) * horizonR,
  );
  const sunAzimuth = sun.azimuthDeg * DEG;
  const sunwardHorizonRadiance = probeAt(sunAzimuth);
  const antisunHorizonRadiance = probeAt(sunAzimuth + Math.PI);
  const horizonAccum = [0, 0, 0];
  const HORIZON_PROBES = 8;
  for (let i = 0; i < HORIZON_PROBES; i += 1) {
    const c = probeAt((i / HORIZON_PROBES) * TAU);
    horizonAccum[0] += c[0];
    horizonAccum[1] += c[1];
    horizonAccum[2] += c[2];
  }
  const horizonRadiance = [
    horizonAccum[0] / HORIZON_PROBES,
    horizonAccum[1] / HORIZON_PROBES,
    horizonAccum[2] / HORIZON_PROBES,
  ];

  const skyIrradianceLuminance = luminance(skyIrradiance);
  const antisunLuminance = Math.max(1e-9, luminance(antisunHorizonRadiance));

  const model = {
    version: SKY_MODEL_VERSION,
    hour: quantised,
    requestedHour,
    hourQuantum,
    weather: profile.weather,
    exposure,
    sun,
    sunAltitudeDeg: sun.altitudeDeg,
    sunAzimuthDeg: sun.azimuthDeg,
    turbidity: profile.turbidity,
    rayleigh: profile.rayleigh,
    mieCoefficient: profile.mieCoefficient,
    overcast: profile.overcast,
    isotropy: profile.isotropy,
    wetness: profile.wetness,
    daylight,
    night,
    sunDiscIntensity,
    groundAlbedo: Object.freeze([...albedo]),
    zenithRadiance: Object.freeze(zenithRadiance),
    horizonRadiance: Object.freeze(horizonRadiance),
    sunwardHorizonRadiance: Object.freeze(sunwardHorizonRadiance),
    antisunHorizonRadiance: Object.freeze(antisunHorizonRadiance),
    groundRadiance: Object.freeze(groundRadiance),
    meanSkyRadiance: Object.freeze([mean[0] * grade, mean[1] * grade, mean[2] * grade]),
    skyIrradiance: Object.freeze(skyIrradiance),
    skyIrradianceLuminance,
    zenithLuminance: luminance(zenithRadiance),
    horizonLuminance: luminance(horizonRadiance),
    sunwardContrast: luminance(sunwardHorizonRadiance) / antisunLuminance,
    /** @private evaluators reused by sampleSkyRadiance / renderEquirectRadiance */
    _upperRadiance: sampleUpper,
    _rowState: rowState,
    _upperFromRow: upperFromRow,
  };

  model.envMapIntensity = envMapIntensityTable(model);
  model.lightRig = recommendedLightRig(model);
  return Object.freeze(model);
}

/**
 * Evaluate the full environment (sky above, ground bounce below) for one
 * direction. Direction need not be normalised.
 *
 * @param {Readonly<SkyModel>} model From `computeSkyModel`.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {[number,number,number]} Linear RGB radiance.
 */
export function sampleSkyRadiance(model, x, y, z) {
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) throw new TypeError('environment-ibl: sampleSkyRadiance needs a non-zero direction');
  const dx = x / length;
  const dy = y / length;
  const dz = z / length;
  const sky = model._upperRadiance(dx, dy, dz);
  if (dy >= 0) return sky;
  // Blend sky -> ground across the 4 degrees below the horizon so the PMREM
  // does not see a hard discontinuity (which shows up as a ringing band).
  const t = smoothstep(0, GROUND_BLEND_SIN, -dy);
  const ground = model.groundRadiance;
  return [mix(sky[0], ground[0], t), mix(sky[1], ground[1], t), mix(sky[2], ground[2], t)];
}

/**
 * Render the environment to an equirectangular linear-RGB float buffer.
 *
 * The layout matches three.js `EquirectangularReflectionMapping` for a
 * `DataTexture` (`flipY = false`): row 0 is the nadir, the last row is the
 * zenith, and column centre `u = 0.5` looks down +X.
 *
 * Pure: no GPU, no DOM. Roughly 3 ms at 512x256 in node.
 *
 * @param {Readonly<SkyModel>} model
 * @param {number} [width=512]
 * @param {number} [height=256]
 * @returns {{width:number, height:number, data:Float32Array}} `data` is RGB, length `width*height*3`.
 */
export function renderEquirectRadiance(model, width = 512, height = 256) {
  if (!Number.isInteger(width) || width < 4) throw new TypeError(`environment-ibl: bad width ${width}`);
  if (!Number.isInteger(height) || height < 2) throw new TypeError(`environment-ibl: bad height ${height}`);
  const data = new Float32Array(width * height * 3);
  const ground = model.groundRadiance;
  const scratch = [0, 0, 0];
  const sun = model.sun;
  // Azimuth trig is shared by every row.
  const cosPhi = new Float64Array(width);
  const sinPhi = new Float64Array(width);
  for (let i = 0; i < width; i += 1) {
    const phi = ((i + 0.5) / width - 0.5) * TAU;
    cosPhi[i] = Math.cos(phi);
    sinPhi[i] = Math.sin(phi);
  }
  for (let j = 0; j < height; j += 1) {
    const v = (j + 0.5) / height;
    const elevation = (v - 0.5) * Math.PI;
    const dy = Math.sin(elevation);
    const r = Math.cos(elevation);
    // Everything that depends only on elevation is computed once per row.
    const row = model._rowState(dy);
    const groundBlend = dy >= 0 ? 0 : smoothstep(0, GROUND_BLEND_SIN, -dy);
    const sunDotY = dy * sun.y;
    for (let i = 0; i < width; i += 1) {
      const dx = cosPhi[i] * r;
      const dz = sinPhi[i] * r;
      const cosTheta = clamp(dx * sun.x + sunDotY + dz * sun.z, -1, 1);
      model._upperFromRow(row, cosTheta, scratch);
      const o = (j * width + i) * 3;
      if (groundBlend > 0) {
        data[o] = mix(scratch[0], ground[0], groundBlend);
        data[o + 1] = mix(scratch[1], ground[1], groundBlend);
        data[o + 2] = mix(scratch[2], ground[2], groundBlend);
      } else {
        data[o] = scratch[0];
        data[o + 1] = scratch[1];
        data[o + 2] = scratch[2];
      }
    }
  }
  return { width, height, data };
}

// --- envMapIntensity ---------------------------------------------------------

/**
 * Dry-clear baseline `envMapIntensity` per material class.
 *
 * These are tuned for `ACESFilmicToneMapping` at exposure 0.86 with the
 * radiance levels this module produces. Glass and water are allowed above 1
 * because they are almost entirely specular; masonry and foliage stay low so
 * the env map reads as sky fill rather than a mirror finish.
 */
const BASE_ENV_MAP_INTENSITY = Object.freeze({
  'facade-glass': 1.15,
  'facade-masonry': 0.55,
  'facade-painted': 0.62,
  'facade-metal': 0.95,
  asphalt: 0.65,
  sidewalk: 0.55,
  'painted-metal': 0.9,
  chrome: 1.25,
  water: 1.4,
  foliage: 0.35,
  fabric: 0.4,
});

/** How much each class gains when surfaces are wet. */
const WETNESS_GAIN = Object.freeze({
  'facade-glass': 0.15,
  'facade-masonry': 0.45,
  'facade-painted': 0.5,
  'facade-metal': 0.3,
  asphalt: 1.15,
  sidewalk: 0.85,
  'painted-metal': 0.35,
  chrome: 0.1,
  water: 0.1,
  foliage: 0.35,
  fabric: 0.2,
});

const ENV_INTENSITY_MAX = 3;

/**
 * Recommended `envMapIntensity` for one material class under a sky model.
 *
 * @param {string} materialClass One of `MATERIAL_CLASSES`.
 * @param {Readonly<SkyModel>|{hour:number, weather?:string}} modelOrState
 * @returns {number} Clamped to [0, 3].
 */
export function envMapIntensityFor(materialClass, modelOrState) {
  const base = BASE_ENV_MAP_INTENSITY[materialClass];
  if (base === undefined) {
    throw new TypeError(
      `environment-ibl: unknown material class '${materialClass}', expected one of ${MATERIAL_CLASSES.join(', ')}`,
    );
  }
  const model = modelOrState && modelOrState.version === SKY_MODEL_VERSION
    ? modelOrState
    : computeSkyModel(modelOrState || {});
  const wetGain = (WETNESS_GAIN[materialClass] || 0) * model.wetness;
  // Overcast light is soft and low-contrast: pull reflective classes back a
  // little so wet asphalt does not turn into a mirror under a grey dome.
  const overcastTrim = 1 - 0.14 * model.overcast;
  // After dark the environment is carried by skyglow, and a high multiplier on
  // it just lifts black levels. Glass keeps most of its response so windows
  // still catch the sky.
  const nightTrim = 1 - 0.28 * model.night * (materialClass === 'facade-glass' || materialClass === 'water' ? 0.4 : 1);
  const value = clamp(base * (1 + wetGain) * overcastTrim * nightTrim, 0, ENV_INTENSITY_MAX);
  return Math.round(value * 1000) / 1000;
}

/**
 * The whole recommended `envMapIntensity` table for a sky model.
 * @param {Readonly<SkyModel>|{hour:number, weather?:string}} modelOrState
 * @returns {Readonly<Record<string, number>>}
 */
export function envMapIntensityTable(modelOrState) {
  const table = {};
  for (const key of MATERIAL_CLASSES) table[key] = envMapIntensityFor(key, modelOrState);
  return Object.freeze(table);
}

/**
 * Best-effort mapping from the city data model onto a material class, so the
 * integrator does not have to hand-label 57 materials.
 *
 * @param {object} [hints]
 * @param {string} [hints.kind] Explicit surface kind: 'road'|'asphalt'|'sidewalk'|
 *   'water'|'vehicle'|'foliage'|'fabric'|'glass'|'metal'.
 * @param {string} [hints.material] `city.buildings[i].material`.
 * @param {string} [hints.facade] `city.buildings[i].facade`.
 * @returns {string} A member of `MATERIAL_CLASSES`.
 */
export function classifyMaterialClass(hints = {}) {
  const kind = typeof hints.kind === 'string' ? hints.kind.toLowerCase() : '';
  switch (kind) {
    case 'road':
    case 'asphalt':
      return 'asphalt';
    case 'sidewalk':
    case 'curb':
    case 'kerb':
      return 'sidewalk';
    case 'water':
      return 'water';
    case 'vehicle':
    case 'car':
      return 'painted-metal';
    case 'chrome':
    case 'trim':
      return 'chrome';
    case 'foliage':
    case 'tree':
      return 'foliage';
    case 'fabric':
    case 'awning':
      return 'fabric';
    case 'glass':
      return 'facade-glass';
    case 'metal':
      return 'facade-metal';
    default:
      break;
  }
  const material = typeof hints.material === 'string' ? hints.material.toLowerCase() : '';
  const facade = typeof hints.facade === 'string' ? hints.facade.toLowerCase() : '';
  if (material === 'glass' || facade === 'modern-grid' || facade === 'loft') return 'facade-glass';
  if (material === 'painted' || material === 'clapboard' || facade === 'edwardian' || facade === 'bay-window') {
    return 'facade-painted';
  }
  if (material === 'brick' || material === 'stone' || material === 'concrete' || material === 'plaster') {
    return 'facade-masonry';
  }
  if (facade === 'art-deco') return 'facade-masonry';
  if (facade === 'shopfront') return 'facade-glass';
  return 'facade-masonry';
}

/**
 * Apply the recommended intensity to one material, an array of materials, or
 * a `{ class: [materials] }` map.
 *
 * Works on plain objects, so it is testable without three.js. Only mutates
 * `envMapIntensity`; nothing else about the material is touched, and
 * `needsUpdate` is set only when the object already declares it.
 *
 * @param {object|object[]|Record<string, object|object[]>} target
 * @param {string|Readonly<SkyModel>} materialClassOrModel
 * @param {Readonly<SkyModel>} [maybeModel]
 * @returns {number} Number of materials updated.
 */
export function applyEnvMapIntensity(target, materialClassOrModel, maybeModel) {
  // Overload: (map, model)
  if (typeof materialClassOrModel === 'object' && materialClassOrModel !== null) {
    const model = materialClassOrModel;
    let count = 0;
    for (const [key, value] of Object.entries(target || {})) {
      count += applyEnvMapIntensity(value, key, model);
    }
    return count;
  }
  const materialClass = materialClassOrModel;
  const intensity = envMapIntensityFor(materialClass, maybeModel);
  const list = Array.isArray(target) ? target : [target];
  let count = 0;
  for (const material of list) {
    if (!material || typeof material !== 'object') continue;
    material.envMapIntensity = intensity;
    if ('needsUpdate' in material) material.needsUpdate = true;
    count += 1;
  }
  return count;
}

// --- light rig recommendation ------------------------------------------------

/**
 * Recommended punctual-light values now that IBL carries the sky fill.
 *
 * The existing rig fakes ambient bounce with a strong `HemisphereLight` and an
 * `AmbientLight`. A real environment map delivers that fill with correct
 * directionality, so leaving both at full strength double-counts the sky and
 * washes out contact shadows. These numbers keep the total illuminance close
 * to the current look while moving the fill from flat to directional.
 *
 * The key light is only trimmed slightly: IBL must supplement it, never
 * replace it.
 *
 * @param {Readonly<SkyModel>|{hour:number, weather?:string}} modelOrState
 * @param {Readonly<{sun:number,hemi:number,ambient:number,rim:number}>} [baseline]
 * @returns {Readonly<object>}
 */
export function recommendedLightRig(modelOrState, baseline = BASELINE_LIGHT_RIG) {
  const model = modelOrState && modelOrState.version === SKY_MODEL_VERSION
    ? modelOrState
    : computeSkyModel(modelOrState || {});

  // How much of the fill the environment can actually carry. In full daylight
  // it carries nearly all of it; at night the env is dim skyglow, so the
  // punctual fill must stay closer to its old value or the city goes black.
  const envAuthority = clamp(0.30 + 0.70 * model.daylight, 0, 1);
  // Overcast skies are almost pure fill, so IBL can take even more.
  const overcastBoost = 1 + 0.12 * model.overcast;

  const hemiScale = clamp(1 - 0.75 * envAuthority * overcastBoost, 0.18, 1);
  const ambientScale = clamp(1 - 0.80 * envAuthority * overcastBoost, 0.12, 1);
  const rimScale = clamp(1 - 0.30 * envAuthority, 0.55, 1);
  const sunScale = clamp(1 - 0.07 * model.daylight - 0.10 * model.overcast, 0.7, 1);

  const round = (value) => Math.round(value * 1000) / 1000;
  return Object.freeze({
    baseline: Object.freeze({ ...baseline }),
    scales: Object.freeze({
      sun: round(sunScale),
      hemi: round(hemiScale),
      ambient: round(ambientScale),
      rim: round(rimScale),
    }),
    sun: round(baseline.sun * sunScale),
    hemi: round(baseline.hemi * hemiScale),
    ambient: round(baseline.ambient * ambientScale),
    rim: round(baseline.rim * rimScale),
    /** Value for `scene.environmentIntensity`. */
    environmentIntensity: round(clamp(1 - 0.15 * model.overcast, 0.6, 1.2)),
    envAuthority: round(envAuthority),
    note: 'IBL supplements the key light; sun stays dominant, hemi/ambient drop because the env now carries directional fill.',
  });
}

// --- GPU rig -----------------------------------------------------------------

const DEFAULT_RIG_OPTIONS = Object.freeze({
  equirectWidth: 512,
  equirectHeight: 256,
  hourQuantum: 0.25,
  cacheSize: 8,
  exposure: 1,
  sunDiscIntensity: 0,
});

/**
 * Pack a pure RGB float buffer into an RGBA half-float `DataTexture` suitable
 * for `PMREMGenerator.fromEquirectangular`.
 * @private
 */
function createEquirectTexture(buffer) {
  const { width, height, data } = buffer;
  const texels = width * height;
  const packed = new Uint16Array(texels * 4);
  const toHalf = DataUtils.toHalfFloat;
  for (let i = 0; i < texels; i += 1) {
    // Half-float max is 65504; analytic sky radiance never approaches it, but
    // clamp anyway so a bad override cannot produce Infinity in the texture.
    packed[i * 4] = toHalf(clamp(data[i * 3], 0, 65504));
    packed[i * 4 + 1] = toHalf(clamp(data[i * 3 + 1], 0, 65504));
    packed[i * 4 + 2] = toHalf(clamp(data[i * 3 + 2], 0, 65504));
    packed[i * 4 + 3] = toHalf(1);
  }
  const texture = new DataTexture(packed, width, height, RGBAFormat, HalfFloatType);
  texture.name = `${SKY_MODEL_VERSION}-equirect`;
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Create the environment rig.
 *
 * The rig owns exactly one `PMREMGenerator` and an LRU cache of prefiltered
 * render targets keyed by `weather` + quantised hour. It creates no renderer,
 * no canvas, no animation loop and no scene root; it only writes
 * `scene.environment` / `scene.environmentIntensity` on a scene you pass in.
 *
 * @param {object} renderer The app's single renderer (WebGPURenderer, including
 *   its WebGL2 fallback backend). Must expose `hasInitialized`.
 * @param {object} [options]
 * @param {object} [options.scene] Scene to assign `environment` on. May also be
 *   passed per call to `update()`.
 * @param {number} [options.equirectWidth=512]
 * @param {number} [options.equirectHeight=256]
 * @param {number} [options.hourQuantum=0.25] Hours per cache bucket.
 * @param {number} [options.cacheSize=8] Prefiltered targets retained.
 * @param {number} [options.exposure=1]
 * @param {number} [options.sunDiscIntensity=0]
 * @param {object} [options.site] Overrides for solar position.
 * @param {boolean} [options.applyEnvironmentIntensity=true] Also write
 *   `scene.environmentIntensity` from the recommended light rig.
 * @param {object} [options.pmremGenerator] Inject the prefilter generator.
 *   Must expose `fromEquirectangular`, `fromEquirectangularAsync` and
 *   `dispose`. Exists so the headless self-check can exercise the cache and
 *   LRU without a GPU. Leave unset in the app.
 * @returns {{
 *   update: (state: {hour:number, weather?:string, scene?:object}) => object,
 *   updateAsync: (state: {hour:number, weather?:string, scene?:object}) => Promise<object>,
 *   getModel: () => (Readonly<SkyModel>|null),
 *   getTexture: () => (object|null),
 *   envMapIntensityFor: (materialClass: string) => number,
 *   envMapIntensityTable: () => Readonly<Record<string, number>>,
 *   recommendedLightRig: () => Readonly<object>,
 *   stats: () => Readonly<object>,
 *   dispose: () => void
 * }}
 */
export function createEnvironmentRig(renderer, options = {}) {
  if (!renderer || typeof renderer !== 'object' || typeof renderer.hasInitialized !== 'function') {
    throw new TypeError(
      'environment-ibl: createEnvironmentRig(renderer) needs the app renderer '
      + '(a three WebGPURenderer instance). Do not construct a second renderer.',
    );
  }

  const config = { ...DEFAULT_RIG_OPTIONS, ...options };
  const pmrem = config.pmremGenerator || new PMREMGenerator(renderer);
  /** @type {Map<string, {target: object, model: object}>} */
  const cache = new Map();
  let disposed = false;
  let currentKey = null;
  let currentModel = null;
  let currentTarget = null;
  const stats = {
    version: SKY_MODEL_VERSION,
    generated: 0,
    cacheHits: 0,
    cacheMisses: 0,
    evictions: 0,
    lastKey: null,
  };

  const assertLive = () => {
    if (disposed) throw new Error('environment-ibl: rig has been disposed');
  };

  const buildModel = (hour, weather) => computeSkyModel({
    hour,
    weather,
    hourQuantum: config.hourQuantum,
    exposure: config.exposure,
    sunDiscIntensity: config.sunDiscIntensity,
    site: config.site,
  });

  const touch = (key, entry) => {
    // Map preserves insertion order; re-inserting moves the entry to the end,
    // which makes the first key the least recently used.
    cache.delete(key);
    cache.set(key, entry);
  };

  const evictIfNeeded = () => {
    while (cache.size > config.cacheSize) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === currentKey) break;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      oldest?.target?.dispose?.();
      stats.evictions += 1;
    }
  };

  const commit = (key, entry, scene) => {
    currentKey = key;
    currentModel = entry.model;
    currentTarget = entry.target;
    stats.lastKey = key;
    const targetScene = scene || config.scene;
    if (targetScene) {
      targetScene.environment = entry.target.texture;
      if (config.applyEnvironmentIntensity !== false && 'environmentIntensity' in targetScene) {
        targetScene.environmentIntensity = entry.model.lightRig.environmentIntensity;
      }
    }
    return Object.freeze({
      key,
      texture: entry.target.texture,
      renderTarget: entry.target,
      model: entry.model,
      regenerated: entry.regenerated === true,
      lightRig: entry.model.lightRig,
      envMapIntensity: entry.model.envMapIntensity,
    });
  };

  const prepare = (state) => {
    assertLive();
    const hour = state?.hour ?? 12;
    const weather = normaliseWeather(state?.weather ?? 'clear');
    const key = environmentCacheKey({ hour, weather, quantum: config.hourQuantum });
    const hit = cache.get(key);
    if (hit) {
      stats.cacheHits += 1;
      touch(key, hit);
      hit.regenerated = false;
      return { key, hit, model: hit.model, weather, hour };
    }
    stats.cacheMisses += 1;
    return { key, hit: null, model: buildModel(hour, weather), weather, hour };
  };

  const finish = (key, model, target, scene) => {
    stats.generated += 1;
    const entry = { target, model, regenerated: true };
    touch(key, entry);
    evictIfNeeded();
    return commit(key, entry, scene);
  };

  return {
    /**
     * Set the environment for a time of day and weather. Regenerates the PMREM
     * only when the quantised hour or weather bucket changes; otherwise this is
     * a cache lookup and is safe to call every frame.
     */
    update(state = {}) {
      const { key, hit, model } = prepare(state);
      if (hit) return commit(key, hit, state.scene);
      const buffer = renderEquirectRadiance(model, config.equirectWidth, config.equirectHeight);
      const equirect = createEquirectTexture(buffer);
      try {
        const target = pmrem.fromEquirectangular(equirect);
        return finish(key, model, target, state.scene);
      } finally {
        // The PMREM keeps its own copy; the source texture is dead weight.
        equirect.dispose();
      }
    },

    /**
     * Same as `update()` but awaits renderer initialisation first. Use this for
     * the very first call if it can run before `await renderer.init()`.
     */
    async updateAsync(state = {}) {
      const { key, hit, model } = prepare(state);
      if (hit) return commit(key, hit, state.scene);
      const buffer = renderEquirectRadiance(model, config.equirectWidth, config.equirectHeight);
      const equirect = createEquirectTexture(buffer);
      try {
        const target = await pmrem.fromEquirectangularAsync(equirect);
        return finish(key, model, target, state.scene);
      } finally {
        equirect.dispose();
      }
    },

    getModel: () => currentModel,
    getTexture: () => (currentTarget ? currentTarget.texture : null),
    envMapIntensityFor: (materialClass) => envMapIntensityFor(materialClass, currentModel || buildModel(12, 'clear')),
    envMapIntensityTable: () => (currentModel ? currentModel.envMapIntensity : envMapIntensityTable({ hour: 12 })),
    recommendedLightRig: () => (currentModel ? currentModel.lightRig : recommendedLightRig({ hour: 12 })),
    stats: () => Object.freeze({ ...stats, cacheSize: cache.size }),

    /** Release every prefiltered target and the generator. Idempotent. */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of cache.values()) entry.target?.dispose?.();
      cache.clear();
      currentTarget = null;
      currentModel = null;
      currentKey = null;
      pmrem.dispose();
    },
  };
}

export default createEnvironmentRig;
