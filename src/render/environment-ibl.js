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
 *      `computeSunShadowCamera()` fits the sun's orthographic shadow camera to
 *      the visible city. These functions import nothing from three and touch no
 *      GPU state.
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
 * What changed in v2
 * ------------------
 * Three defects, all of them measured rather than guessed:
 *
 *   1. *Golden hour was dusk.* The solar model ran a late-September date on
 *      the site's **standard** offset (UTC-8) when San Francisco is on daylight
 *      time (UTC-7) in September. Every solar event landed an hour early, so
 *      the canonical 18:30 golden-hour card was captured 30 minutes after
 *      sunset at -4.83 deg. The date is now an explicit parameter with a
 *      documented default (`CANONICAL_SKY_DATE`, `CANONICAL_SITE`), and 18:30
 *      sits at +6.6 deg. See `CANONICAL_SKY_DATE` for why that date.
 *   2. *The sun cast no visible shadows.* The shadow pass was fine; the
 *      orthographic shadow camera was a fixed +/-420 m box on a fixed light
 *      position, covering 2.44 texels/m of somewhere the player was not
 *      looking. `computeSunShadowCamera()` is the pure fitting function that
 *      replaces it, at 5.21 texels/m and anchored to the view.
 *   3. *The light-rig advice was a two-state switch.* It keyed off `daylight`,
 *      which saturates 6 deg either side of the horizon, so golden hour got
 *      noon's advice while the environment was delivering a seventh of noon's
 *      fill. It now keys off measured sky irradiance.
 *
 * A fourth, found on the way: the weather energy normalisation matched *mean
 * radiance* between weather domes rather than *irradiance*, which let an
 * overcast dome out-light the clear sky it was normalised against once the sun
 * was low. `clearReferenceIrradianceLuminance` documents the fix.
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
export const SKY_MODEL_VERSION = 'earthonline-sky-ibl-v2';

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

/** Days before the first of each month in a common (non-leap) year. */
const MONTH_DAY_OFFSETS = Object.freeze([0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]);
/** Days in each month of a common year. */
const MONTH_LENGTHS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

/**
 * Day-of-year (1..365) for a month/day in a common year.
 *
 * A common year is used deliberately: the sky model must be reproducible from
 * `{month, day}` alone, with no calendar year and no `Date` object, so captured
 * evidence stays comparable forever. The leap-year shift is a quarter of a day
 * of solar declination (< 0.1 deg of altitude) and is below the tolerance of
 * every assertion in this module.
 *
 * @param {number} month 1..12
 * @param {number} day 1..31
 * @returns {number} 1..365
 */
export function dayOfYearFromMonthDay(month, day) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new TypeError(`environment-ibl: month must be an integer 1..12, got ${month}`);
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new TypeError(`environment-ibl: day must be an integer 1..31, got ${day}`);
  }
  if (day > MONTH_LENGTHS[month - 1]) {
    throw new RangeError(`environment-ibl: month ${month} has ${MONTH_LENGTHS[month - 1]} days in a common year, got ${day}`);
  }
  return MONTH_DAY_OFFSETS[month - 1] + day;
}

/**
 * The canonical capture date, chosen on purpose rather than inherited.
 *
 * **September 22, the September equinox.** Three reasons, in the order they
 * matter to the capture set:
 *
 * 1. *Golden hour lands on the clock hour we capture.* On the equinox in San
 *    Francisco the sun sets at about 19:04 local time, so the canonical
 *    18:30 (`hour = 18.5`) card sits roughly +6.7 deg above the horizon -
 *    inside golden hour by the usual definition (sun below ~6-10 deg), warm,
 *    raking, still casting. Pick a midsummer date and 18:30 is a bland +16 deg
 *    afternoon; pick midwinter and the sun set an hour ago.
 * 2. *The sun rises due east and sets due west.* Only at an equinox is the
 *    sunset azimuth exactly 270 deg, so the low sun runs straight along an
 *    east-west street instead of across it. That is what makes the "dense
 *    building canyon at golden hour" card a canyon shot and not a wall shot.
 * 3. *It is the median sun path of the year.* Noon altitude ~50 deg is the
 *    annual mean for this latitude, so the daylight cards are representative
 *    rather than a seasonal extreme.
 *
 * The offset is **UTC-7, Pacific Daylight Time**, because PDT - not PST - is
 * the offset actually in force in San Francisco on September 22. Running the
 * previous UTC-8 offset on a late-September date was the whole bug: it shifted
 * every solar event one hour earlier, put sunset at 18:04, and rendered the
 * 18:30 golden-hour card as post-sunset dusk (measured altitude -4.83 deg).
 *
 * @type {Readonly<{label:string, month:number, day:number, dayOfYear:number}>}
 */
export const CANONICAL_SKY_DATE = Object.freeze({
  label: 'September 22 (September equinox)',
  month: 9,
  day: 22,
  dayOfYear: dayOfYearFromMonthDay(9, 22),
});

/**
 * Canonical site: San Francisco on the canonical date.
 *
 * `utcOffsetHours` is the offset in force **on `date`**, not the site's
 * standard offset. `standardUtcOffsetHours` is recorded next to it so the
 * choice is auditable instead of looking like a typo.
 *
 * @type {Readonly<object>}
 */
export const CANONICAL_SITE = Object.freeze({
  name: 'San Francisco',
  latitudeDeg: 37.7749,
  longitudeDeg: -122.4194,
  /** Offset in force on the canonical date: Pacific Daylight Time. */
  utcOffsetHours: -7,
  /** The site's winter offset, kept for documentation and for winter dates. */
  standardUtcOffsetHours: -8,
  daylightSaving: true,
  date: CANONICAL_SKY_DATE,
  dayOfYear: CANONICAL_SKY_DATE.dayOfYear,
});

/** Internal alias so existing call sites keep reading naturally. */
const DEFAULT_SITE = CANONICAL_SITE;

/**
 * Solar altitude band, in degrees, that this project calls golden hour.
 *
 * `-4` is the low edge: below that the disc is gone and the direct key has
 * collapsed to nothing, which is blue hour, not golden hour. `+8` is the high
 * edge: above it the shadows shorten enough that the light reads as ordinary
 * afternoon. The commonly quoted photographic band (-4 to +6) sits inside
 * this; the extra two degrees are deliberate headroom so a capture hour does
 * not fall out of the window because of a one-day calendar slip.
 *
 * @type {readonly [number, number]}
 */
export const GOLDEN_HOUR_ALTITUDE_BAND_DEG = Object.freeze([-4, 8]);

/**
 * The clock hours the capture set uses, with the expected solar altitude band
 * for each on the canonical date. These are the numbers the self-check asserts;
 * they are exported so a capture harness can log the expectation next to the
 * frame instead of re-deriving it.
 *
 * @type {readonly Readonly<{hour:number, label:string, minAltitudeDeg:number,
 *   maxAltitudeDeg:number, aboveHorizon:boolean}>[]}
 */
export const CANONICAL_CAPTURE_HOURS = Object.freeze([
  Object.freeze({
    hour: 6,
    label: 'pre-dawn twilight, sun still down (sunrise is 07:00 on this date)',
    minAltitudeDeg: -16,
    maxAltitudeDeg: -8,
    aboveHorizon: false,
  }),
  Object.freeze({
    hour: 9,
    label: 'morning, sun clear of the low buildings, long east shadows',
    minAltitudeDeg: 18,
    maxAltitudeDeg: 28,
    aboveHorizon: true,
  }),
  Object.freeze({
    hour: 12,
    label: 'late morning; solar noon is 13:02, so this is not the daily peak',
    minAltitudeDeg: 45,
    maxAltitudeDeg: 55,
    aboveHorizon: true,
  }),
  Object.freeze({
    hour: 15,
    label: 'afternoon, the clear-day card',
    minAltitudeDeg: 38,
    maxAltitudeDeg: 49,
    aboveHorizon: true,
  }),
  Object.freeze({
    hour: 18.5,
    label: 'golden hour, the dense-canyon card: low, warm, still casting',
    minAltitudeDeg: 3,
    maxAltitudeDeg: 8,
    aboveHorizon: true,
  }),
  Object.freeze({
    hour: 21.5,
    label: 'night, the shop/vehicle/street-lighting card',
    minAltitudeDeg: -40,
    maxAltitudeDeg: -18,
    aboveHorizon: false,
  }),
]);

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
 * Resolve the date of a site description into a day-of-year.
 *
 * Accepts, in priority order:
 *   - `site.date` as `{month, day}`, as `'MM-DD'` / `'YYYY-MM-DD'`, or as a
 *     plain day-of-year number;
 *   - `site.dayOfYear`;
 *   - the canonical date.
 *
 * Exported so the integrator and the self-check resolve dates the same way.
 *
 * @param {object} [site]
 * @returns {number} 1..365
 */
export function resolveDayOfYear(site = {}) {
  const { date, dayOfYear } = site;
  if (date !== undefined && date !== null) {
    if (typeof date === 'number') {
      if (!Number.isInteger(date) || date < 1 || date > 365) {
        throw new TypeError(`environment-ibl: numeric site.date must be a day-of-year 1..365, got ${date}`);
      }
      return date;
    }
    if (typeof date === 'string') {
      const parts = date.split('-').filter((part) => part.length > 0);
      if (parts.length < 2) throw new TypeError(`environment-ibl: cannot read site.date '${date}'`);
      const [month, day] = parts.slice(-2).map((part) => Number.parseInt(part, 10));
      return dayOfYearFromMonthDay(month, day);
    }
    if (typeof date === 'object') {
      if (Number.isInteger(date.month) && Number.isInteger(date.day)) {
        return dayOfYearFromMonthDay(date.month, date.day);
      }
      if (Number.isInteger(date.dayOfYear)) return date.dayOfYear;
    }
    throw new TypeError(`environment-ibl: cannot read site.date ${JSON.stringify(date)}`);
  }
  if (dayOfYear !== undefined) {
    if (!Number.isInteger(dayOfYear) || dayOfYear < 1 || dayOfYear > 365) {
      throw new TypeError(`environment-ibl: site.dayOfYear must be an integer 1..365, got ${dayOfYear}`);
    }
    return dayOfYear;
  }
  return CANONICAL_SKY_DATE.dayOfYear;
}

/**
 * Resolve the UTC offset in force for a site description.
 * `timezoneOffsetHours` is the pre-v2 spelling and still wins when it is the
 * only one the caller supplied, so old call sites keep their meaning.
 * @param {object} [site]
 * @returns {number}
 */
function resolveUtcOffsetHours(site = {}) {
  const explicit = site.utcOffsetHours ?? site.timezoneOffsetHours;
  if (explicit === undefined) return CANONICAL_SITE.utcOffsetHours;
  if (!isFiniteNumber(explicit)) {
    throw new TypeError(`environment-ibl: utcOffsetHours must be a finite number, got ${explicit}`);
  }
  return explicit;
}

/**
 * NOAA solar-position approximation.
 *
 * The date is an **explicit, documented parameter** (`site.date`, defaulting to
 * `CANONICAL_SKY_DATE`), and the offset is the one in force on that date
 * (`site.utcOffsetHours`, defaulting to `CANONICAL_SITE.utcOffsetHours`). See
 * `CANONICAL_SKY_DATE` for why September 22 / UTC-7 and not something else.
 *
 * Note that the fractional-year term is evaluated in **UTC**, not on the local
 * clock. Using the local hour there biases the declination by the timezone
 * offset - small (< 0.1 deg here) but a systematic error with no upside.
 *
 * @param {number} hour Local clock hour, 0..24.
 * @param {object} [site]
 * @param {number} [site.latitudeDeg]
 * @param {number} [site.longitudeDeg]
 * @param {number} [site.utcOffsetHours] Offset in force on `date`.
 * @param {number} [site.timezoneOffsetHours] Deprecated alias of `utcOffsetHours`.
 * @param {{month:number,day:number}|string|number} [site.date]
 * @param {number} [site.dayOfYear] 1..365. Lower priority than `site.date`.
 * @returns {{x:number,y:number,z:number,altitudeDeg:number,azimuthDeg:number,
 *   declinationDeg:number,dayOfYear:number,utcOffsetHours:number,
 *   equationOfTimeMinutes:number,hourAngleDeg:number}}
 *   Unit direction **toward** the sun in world space (+X east, +Y up, -Z north),
 *   plus altitude above the horizon and azimuth clockwise from north.
 */
export function computeSunDirection(hour, site = {}) {
  const {
    latitudeDeg = DEFAULT_SITE.latitudeDeg,
    longitudeDeg = DEFAULT_SITE.longitudeDeg,
  } = site;
  const timezoneOffsetHours = resolveUtcOffsetHours(site);
  const dayOfYear = resolveDayOfYear(site);
  const h = wrapHour(hour);

  // Fractional year at the instant, in UTC.
  const gamma = (TAU / 365) * (dayOfYear - 1 + (h - timezoneOffsetHours - 12) / 24);
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
    dayOfYear,
    utcOffsetHours: timezoneOffsetHours,
    equationOfTimeMinutes: eqTimeMinutes,
    hourAngleDeg: hourAngle / DEG,
  });
}

/**
 * Solar events for a whole day at a site: sunrise, sunset, solar noon, the
 * peak altitude, and the golden-hour window.
 *
 * Deterministic by construction: a fixed 1-minute scan finds each bracket and
 * a fixed 24-step bisection refines it, so the result depends only on the
 * arguments. No `Date`, no iteration-until-converged.
 *
 * Golden hour is reported as the clock window where the altitude lies inside
 * `GOLDEN_HOUR_ALTITUDE_BAND_DEG`. The evening side is the one the canonical
 * 18:30 card captures.
 *
 * @param {object} [site] Same shape as `computeSunDirection`'s site.
 * @returns {Readonly<object>}
 */
export function computeSolarDay(site = {}) {
  const altitudeAt = (h) => computeSunDirection(h, site).altitudeDeg;
  const STEPS = 24 * 60;
  const crossing = (target, rising) => {
    for (let i = 0; i < STEPS; i += 1) {
      const h0 = (i / STEPS) * 24;
      const h1 = ((i + 1) / STEPS) * 24;
      const a0 = altitudeAt(h0) - target;
      const a1 = altitudeAt(h1) - target;
      if (rising ? (a0 <= 0 && a1 > 0) : (a0 >= 0 && a1 < 0)) {
        let lo = h0;
        let hi = h1;
        for (let k = 0; k < 24; k += 1) {
          const mid = 0.5 * (lo + hi);
          const am = altitudeAt(mid) - target;
          if (rising ? am <= 0 : am >= 0) lo = mid; else hi = mid;
        }
        return 0.5 * (lo + hi);
      }
    }
    return null;
  };

  let peakHour = 0;
  let peakAltitude = -90;
  for (let i = 0; i <= STEPS; i += 1) {
    const h = (i / STEPS) * 24;
    const a = altitudeAt(h);
    if (a > peakAltitude) {
      peakAltitude = a;
      peakHour = h;
    }
  }

  const sunriseHour = crossing(0, true);
  const sunsetHour = crossing(0, false);
  const goldenEveningStart = crossing(GOLDEN_HOUR_ALTITUDE_BAND_DEG[1], false);
  const goldenEveningEnd = crossing(GOLDEN_HOUR_ALTITUDE_BAND_DEG[0], false);
  const goldenMorningStart = crossing(GOLDEN_HOUR_ALTITUDE_BAND_DEG[0], true);
  const goldenMorningEnd = crossing(GOLDEN_HOUR_ALTITUDE_BAND_DEG[1], true);
  return Object.freeze({
    dayOfYear: resolveDayOfYear(site),
    utcOffsetHours: resolveUtcOffsetHours(site),
    sunriseHour,
    sunsetHour,
    solarNoonHour: peakHour,
    maxAltitudeDeg: peakAltitude,
    daylightHours: sunriseHour !== null && sunsetHour !== null ? sunsetHour - sunriseHour : null,
    goldenHourBandDeg: GOLDEN_HOUR_ALTITUDE_BAND_DEG,
    /** Evening window where the altitude is inside `GOLDEN_HOUR_ALTITUDE_BAND_DEG`. */
    goldenHourEvening: goldenEveningStart !== null && goldenEveningEnd !== null
      ? Object.freeze({ startHour: goldenEveningStart, endHour: goldenEveningEnd })
      : null,
    goldenHourMorning: goldenMorningStart !== null && goldenMorningEnd !== null
      ? Object.freeze({ startHour: goldenMorningStart, endHour: goldenMorningEnd })
      : null,
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
 * Cosine-weighted upper-hemisphere irradiance luminance of the *clear*
 * Preetham dome for a given sun, used to energy-normalise the other weather
 * profiles. Memoised on the sun elevation, because the sky model is only
 * rebuilt when the hour bucket changes.
 *
 * This is deliberately the **cosine-weighted irradiance** and not the mean
 * radiance it used to be. The two are not interchangeable: an overcast dome
 * concentrates its radiance at the zenith, where the cosine weight is 1, while
 * a clear dome at low sun concentrates its radiance near the horizon, where
 * the cosine weight approaches 0. Normalising the *mean radiance* therefore let
 * an overcast sky deliver more irradiance than the clear sky it was normalised
 * against, which is backwards and is exactly what showed up once the corrected
 * solar model put the 09:00 sun at 23 deg instead of 34 deg. Normalising the
 * irradiance makes `brightness` mean what its documentation says: diffuse
 * transmission relative to a clear sky with the same sun.
 * @private
 */
const _clearReferenceCache = new Map();
function clearReferenceIrradianceLuminance(sun, sunDiscIntensity) {
  const key = `${Math.round(sun.y * 1e6)}|${sunDiscIntensity}`;
  const cached = _clearReferenceCache.get(key);
  if (cached !== undefined) return cached;
  const state = preethamState(sun, weatherProfile('clear'), sunDiscIntensity);
  let sum = 0;
  for (let i = 0; i < IRRADIANCE_SAMPLES; i += 1) {
    const dy = IRRADIANCE_DIRS[i * 3 + 1];
    sum += luminance(preethamRadiance(
      state,
      IRRADIANCE_DIRS[i * 3],
      dy,
      IRRADIANCE_DIRS[i * 3 + 2],
      sun,
    )) * dy;
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
  // Not merged with DEFAULT_SITE here: `computeSunDirection` resolves its own
  // defaults, and pre-merging would make `CANONICAL_SITE.utcOffsetHours` shadow
  // a caller that only passed the deprecated `timezoneOffsetHours` spelling.
  const sun = computeSunDirection(quantised, site || {});

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
  // luminance and the mean radiance used by the isotropy blend. The raw
  // samples are kept so pass 1.5 can shape them without re-evaluating
  // Preetham 512 more times.
  let meanR = 0;
  let meanG = 0;
  let meanB = 0;
  const rawDome = new Float64Array(IRRADIANCE_SAMPLES * 3);
  for (let i = 0; i < IRRADIANCE_SAMPLES; i += 1) {
    const dx = IRRADIANCE_DIRS[i * 3];
    const dy = IRRADIANCE_DIRS[i * 3 + 1];
    const dz = IRRADIANCE_DIRS[i * 3 + 2];
    const c = preethamRadiance(state, dx, dy, dz, sun);
    rawDome[i * 3] = c[0];
    rawDome[i * 3 + 1] = c[1];
    rawDome[i * 3 + 2] = c[2];
    meanR += c[0];
    meanG += c[1];
    meanB += c[2];
  }
  meanR /= IRRADIANCE_SAMPLES;
  meanG /= IRRADIANCE_SAMPLES;
  meanB /= IRRADIANCE_SAMPLES;
  const mean = [meanR, meanG, meanB];

  // CIE overcast: the zenith is roughly 3x the horizon. Normalising by the
  // mean of (1 + 2 cos(theta)) / 3 over the hemisphere keeps total energy
  // close to the clear-sky dome before `brightness` grades it down.
  const overcastZenith = [meanR * 1.5, meanG * 1.5, meanB * 1.5];

  // Pass 1.5: energy normalisation.
  //
  // Preetham's absolute output climbs steeply with turbidity, so a fog profile
  // evaluated raw comes out brighter than a clear sky, which is backwards.
  // The normalisation is done on the **cosine-weighted irradiance of the fully
  // shaped dome**, not on its mean radiance, because overcast blending moves
  // energy toward the zenith where the cosine weight is largest. Getting this
  // wrong is invisible with a high sun and obvious with a low one.
  //
  // After this, `skyIrradiance` for any weather is exactly
  // `brightness * clearSkyIrradiance` for the same sun, up to the twilight and
  // skyglow terms added later, which are additive and not part of the dome.
  let shapedIrradianceLuminance = 0;
  const shapedSample = [0, 0, 0];
  for (let i = 0; i < IRRADIANCE_SAMPLES; i += 1) {
    const dy = IRRADIANCE_DIRS[i * 3 + 1];
    const cieShape = (1 + 2 * Math.max(0, dy)) / 3;
    for (let c = 0; c < 3; c += 1) {
      const v = mix(rawDome[i * 3 + c], overcastZenith[c] * cieShape, profile.overcast);
      shapedSample[c] = mix(v, mean[c], profile.isotropy);
    }
    if (desaturation > 0) {
      const l = luminance(shapedSample);
      shapedSample[0] = mix(shapedSample[0], l, desaturation);
      shapedSample[1] = mix(shapedSample[1], l, desaturation);
      shapedSample[2] = mix(shapedSample[2], l, desaturation);
    }
    shapedIrradianceLuminance += luminance([
      shapedSample[0] * tint[0],
      shapedSample[1] * tint[1],
      shapedSample[2] * tint[2],
    ]) * dy;
  }
  shapedIrradianceLuminance = Math.max(1e-12, shapedIrradianceLuminance / IRRADIANCE_SAMPLES);
  const referenceIrradianceLuminance = clearReferenceIrradianceLuminance(sun, sunDiscIntensity);
  const energyScale = referenceIrradianceLuminance / shapedIrradianceLuminance;
  const grade = profile.brightness * exposure * SKY_RADIANCE_SCALE * energyScale;

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
  // `skipLightRig` exists only to break the one-shot recursion when
  // `recommendedLightRig` builds its clear-noon irradiance reference. Nothing
  // outside this module should pass it.
  model.lightRig = options.skipLightRig === true ? null : recommendedLightRig(model);
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
 * The per-hour punctual curve the renderer already runs, reconstructed here as
 * a function of `daylight` alone.
 *
 * This matters because `lightRig.scales` are **multipliers applied on top of
 * that curve**, not absolute intensities. Writing the curve down makes the
 * recommendation checkable: `scales.hemi * curveFill(daylight)` is the fill the
 * recommendation actually asks for, and that is the number the model reasons
 * about. `lightRig.absolute` reports it directly for an integrator who would
 * rather set intensities than scale them.
 *
 * @param {number} daylight 0 at night, 1 in full day.
 * @returns {{hemi:number, ambient:number, fill:number}}
 */
export function baselineFillCurve(daylight) {
  const d = clamp(daylight, 0, 1);
  const hemi = 0.55 + 0.80 * d;
  const ambient = 0.08 + 0.26 * d;
  return { hemi, ambient, fill: hemi + ambient };
}

/**
 * Reference clear-sky irradiance luminance at the canonical noon, used to
 * normalise the fill curve. Recomputed lazily and memoised, never hard-coded,
 * so it cannot drift away from the sky model.
 * @private
 */
let _noonReferenceIrradiance = 0;
function noonReferenceIrradiance() {
  if (_noonReferenceIrradiance === 0) {
    _noonReferenceIrradiance = computeSkyModel({
      hour: 12,
      weather: 'clear',
      skipLightRig: true,
    }).skyIrradianceLuminance;
  }
  return _noonReferenceIrradiance;
}

/**
 * Perceptual compression applied to the fill's day/night swing.
 *
 * A fully physical fill would fall by a factor of ~7 between noon and golden
 * hour and by ~40 between noon and night. The renderer's tone mapping exposure
 * is fixed per day/night state, so a fully physical fall underexposes the
 * shadow side into mud. `^0.35` is roughly a lightness curve: it keeps the
 * ordering and the direction of every change while compressing a 40:1 physical
 * range into about 3.5:1 on screen.
 */
const FILL_COMPRESSION = 0.35;

/**
 * Kasten-Young relative optical air mass, then a standard direct-beam
 * transmittance. Used only to describe how much the *key* is attenuated at low
 * sun, which is what makes golden hour warm and weak.
 * @param {number} altitudeDeg
 * @returns {{airMass:number, transmittance:number}}
 */
export function directBeamTransmittance(altitudeDeg) {
  if (altitudeDeg <= -1) return { airMass: Infinity, transmittance: 0 };
  const alt = Math.max(altitudeDeg, 0);
  const airMass = 1 / (Math.sin(alt * DEG) + 0.50572 * Math.pow(alt + 6.07995, -1.6364));
  const transmittance = Math.pow(0.7, Math.pow(airMass, 0.678));
  return { airMass, transmittance };
}

/**
 * Recommended punctual-light values now that IBL carries the sky fill.
 *
 * What changed in v2, and why
 * ---------------------------
 * v1 drove the whole recommendation off `daylight`, which saturates six degrees
 * either side of the horizon. That made the advice a two-state switch: every
 * hour from 07:30 to 18:30 got the same 0.25x hemi and 0.20x ambient. It is
 * right at noon and wrong everywhere else, and it is most wrong exactly at the
 * golden-hour card, where the environment's own irradiance has fallen to 0.18
 * against noon's 1.23 - a seventh of the fill - while the punctual fill that
 * used to cover the gap is still being cut by 75-80%. Shadow sides went muddy
 * and the frame lost its low-sun colour separation.
 *
 * v2 drives it off the sky model's **measured irradiance** instead:
 *
 *   environmentFill = skyIrradianceLuminance * environmentIntensity
 *   targetFill      = baselineNoonFill * (skyIrradiance / noonSkyIrradiance)^0.35
 *   punctualFill    = max(0, targetFill - environmentFill)
 *   hemi/ambient scale = punctualFill / baselineFillCurve(daylight).fill
 *
 * The key is left alone at low sun. It is already weak there - direct-beam
 * transmittance at +6.6 deg is 0.25 against 0.65 at noon - so trimming it again
 * for "IBL now helps" is double-counting in the wrong direction. The trim is
 * therefore scaled by how much fill the environment is really delivering, which
 * is ~1.0 at noon and ~0.15 at golden hour.
 *
 * The rim light is the piece IBL most completely replaces: it exists only to
 * fake a sky bounce from the anti-sun side, which is precisely what a
 * prefiltered sky dome does correctly. It takes the largest cut.
 *
 * @param {Readonly<SkyModel>|{hour:number, weather?:string}} modelOrState
 * @param {Readonly<{sun:number,hemi:number,ambient:number,rim:number}>} [baseline]
 * @returns {Readonly<object>}
 */
export function recommendedLightRig(modelOrState, baseline = BASELINE_LIGHT_RIG) {
  const model = modelOrState && modelOrState.version === SKY_MODEL_VERSION
    ? modelOrState
    : computeSkyModel(modelOrState || {});

  // The dome is now energy-correct per weather (fog transmits 0.62 of clear,
  // drizzle 0.38), so `environmentIntensity` no longer has to carry a
  // brightness trim - that would double-count. The residual 0.10 overcast trim
  // is there for one narrower reason: an isotropic grey dome reflects as a
  // flat white highlight on wet asphalt and glass, and easing the whole
  // environment slightly is cheaper than re-tuning every glossy class.
  const environmentIntensity = clamp(1 - 0.10 * model.overcast, 0.6, 1.2);
  const environmentFill = model.skyIrradianceLuminance * environmentIntensity;

  // How much fill the environment is delivering, as a fraction of clear noon.
  // This is the "IBL authority" number, and unlike v1's it is measured.
  const irradianceRatio = model.skyIrradianceLuminance / Math.max(1e-9, noonReferenceIrradiance());
  const envAuthority = clamp(environmentFill / Math.max(1e-9, noonReferenceIrradiance()), 0, 1.5);

  // Fill the frame should end up with, compressed against the physical swing.
  const baselineNoonFill = baselineFillCurve(1).fill;
  const targetFill = baselineNoonFill * Math.pow(clamp(irradianceRatio, 0, 4), FILL_COMPRESSION);
  const punctualFill = Math.max(0, targetFill - environmentFill);
  const curve = baselineFillCurve(model.daylight);
  const fillScale = clamp(punctualFill / Math.max(1e-6, curve.fill), 0.12, 1.15);

  // Ambient is the flattest of the three, so it gives up slightly more of the
  // remaining fill than the hemisphere light, which at least has an up/down
  // gradient. 0.9 / 1.05 keeps their sum at the requested `punctualFill`.
  const hemiScale = clamp(fillScale * 1.05, 0.12, 1.2);
  const ambientScale = clamp(fillScale * 0.90, 0.10, 1.2);

  // The rim faked the anti-sun sky bounce; the env dome now does it properly.
  const rimScale = clamp(1 - 0.45 * clamp(envAuthority, 0, 1), 0.5, 1);

  // Key trim, proportional to how much the environment is genuinely adding.
  const sunScale = clamp(1 - 0.06 * clamp(envAuthority, 0, 1) - 0.10 * model.overcast, 0.72, 1);

  const beam = directBeamTransmittance(model.sun.altitudeDeg);
  const round = (value) => Math.round(value * 1000) / 1000;
  const round4 = (value) => Math.round(value * 10000) / 10000;

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
    /**
     * The intensities the recommendation actually asks for once the scales are
     * applied to the renderer's own day/night curve. Set these directly if you
     * would rather not multiply.
     */
    absolute: Object.freeze({
      hemi: round(curve.hemi * hemiScale),
      ambient: round(curve.ambient * ambientScale),
    }),
    /** Value for `scene.environmentIntensity`. */
    environmentIntensity: round(environmentIntensity),
    envAuthority: round(envAuthority),
    fill: Object.freeze({
      environment: round4(environmentFill),
      target: round4(targetFill),
      punctual: round4(punctualFill),
      total: round4(environmentFill + punctualFill),
      curve: round4(curve.fill),
      irradianceRatio: round4(irradianceRatio),
    }),
    key: Object.freeze({
      altitudeDeg: round(model.sun.altitudeDeg),
      airMass: Number.isFinite(beam.airMass) ? round(beam.airMass) : null,
      transmittance: round4(beam.transmittance),
      /** Horizontal irradiance the key delivers, relative to clear noon. */
      relativeIrradiance: round4(
        (beam.transmittance * Math.max(0, model.sun.y))
        / Math.max(1e-9, directBeamTransmittance(52.73).transmittance * Math.sin(52.73 * DEG)),
      ),
    }),
    shadow: Object.freeze({
      castShadow: model.sun.altitudeDeg > 0,
      /** `light.shadow.intensity`: soften the map under an overcast dome. */
      intensity: round(clamp(1 - 0.55 * model.overcast, 0.4, 1)),
    }),
    note: 'Fill follows measured sky irradiance, not a day/night switch; the key is left alone at low sun '
      + 'because direct-beam transmittance already weakens it; the rim takes the largest cut because the '
      + 'env dome replaces it outright.',
  });
}

/**
 * The whole recommendation across the canonical capture hours, as a table.
 *
 * Exists so the numbers in the handoff are generated, not typed, and so the
 * self-check asserts the same rows the integrator reads.
 *
 * @param {'clear'|'fog'|'drizzle'} [weather='clear']
 * @returns {readonly Readonly<object>[]}
 */
export function lightRigSchedule(weather = 'clear') {
  return Object.freeze(CANONICAL_CAPTURE_HOURS.map((entry) => {
    const model = computeSkyModel({ hour: entry.hour, weather });
    const rig = model.lightRig;
    return Object.freeze({
      hour: entry.hour,
      label: entry.label,
      weather: model.weather,
      sunAltitudeDeg: Math.round(model.sun.altitudeDeg * 100) / 100,
      skyIrradiance: Math.round(model.skyIrradianceLuminance * 10000) / 10000,
      environmentIntensity: rig.environmentIntensity,
      scales: rig.scales,
      absolute: rig.absolute,
      fill: rig.fill,
      key: rig.key,
      shadow: rig.shadow,
    });
  }));
}

// --- sun shadow camera fitting -----------------------------------------------

/**
 * Why this section exists
 * ----------------------
 * Measured on the canonical street-day pose: `shadowMap.enabled = true`,
 * `PCFSoftShadowMap`, a 2048x2048 map, 297 casters, 162 receivers, and not one
 * visible cast shadow on the roadway. Nothing is broken in the shadow *pass* -
 * the orthographic shadow camera is simply not fitted to the area the player
 * can see. A fixed +/-420 m box hung off a fixed light position covers a
 * different 840 m square than the one under the camera, so the map is either
 * spent on empty ground or the receivers fall outside it entirely.
 *
 * Fitting method: bounding sphere, not tight AABB
 * -----------------------------------------------
 * The obvious fit - transform the eight frustum corners into light space and
 * take their axis-aligned bounds - is a trap for a day/night city. That box
 * changes size as the sun rotates, so the metres-per-texel changes with the
 * time of day (2-3x across a day here), and it changes as the *camera* rotates,
 * so shadow edges crawl and shimmer while the player turns.
 *
 * Fitting the minimal sphere around the frustum slice and using a square box of
 * that diameter is invariant to both rotations: `texelsPerMetre` is a function
 * of `shadowDistance` and `mapSize` only. The cost is roughly 25-30% of the map
 * area on a 16:9 frustum, which is a good trade for a stable, predictable,
 * loggable texel density. The centre is then snapped to whole texels in light
 * space, which is what actually removes the crawl.
 *
 * The near plane, and why it is not `r`
 * ------------------------------------
 * The set of casters that can shadow the sphere is the cylinder of radius `r`
 * around the light axis, extended back toward the sun. A caster of height `H`
 * above the sphere whose shadow still lands inside the sphere sits at a
 * horizontal distance of about `H / tan(alt)` and therefore at an along-axis
 * distance of about
 *
 *     (H / tan(alt)) * cos(alt) + H * sin(alt) = H / sin(alt)
 *
 * from the centre. So the light must be pulled back by `r + H / sin(alt)`, and
 * that pull-back grows without bound as the sun approaches the horizon. This is
 * exactly the golden-hour case: at +6.6 deg a 260 m tower needs 2.2 km of
 * extrusion before its shadow is complete. It costs no texel density - the box
 * stays `2r` wide - only depth range, which is why the recommended `bias` below
 * is expressed per unit of depth range rather than as a constant.
 */

/** Defaults for `computeSunShadowCamera`. */
export const SHADOW_FIT_DEFAULTS = Object.freeze({
  /** Metres of the view frustum the shadow map covers. See the density table. */
  shadowDistance: 220,
  /** Camera near plane. Only affects the fit through the near frustum corners. */
  cameraNear: 0.5,
  /** Square shadow map resolution. */
  mapSize: 2048,
  /** Tallest caster expected above the fitted sphere, in metres. */
  maxCasterHeight: 260,
  /** Sun altitudes below this are treated as this for the extrusion maths. */
  minCasterAltitudeDeg: 3,
  /** Hard ceiling on the near-plane extrusion, in metres. */
  maxCasterExtrusion: 3200,
  /** Shadow camera near plane, in metres. */
  shadowNear: 1,
  /** Snap the fitted centre to whole texels to stop edge crawl. */
  texelSnap: true,
  /** `normalBias` in texel widths. */
  normalBiasTexels: 1.25,
  /** `bias` in texel widths of depth pull-back. */
  depthBiasTexels: 0.5,
});

/**
 * The texel density band this fit is designed to stay inside, in
 * texels-per-metre, for `mapSize = 2048` and `shadowDistance` between 120 m and
 * 400 m. Outside this band the shadows are either aliased (below ~2.5) or the
 * map is being wasted on an area smaller than the visible street (above ~12).
 * @type {readonly [number, number]}
 */
export const SHADOW_TEXEL_DENSITY_RANGE = Object.freeze([2.5, 12]);

/** Read a `{x,y,z}` / `[x,y,z]` / `Vector3` triple without importing three. */
function readVec3(value, label) {
  if (Array.isArray(value) && value.length >= 3) {
    const [x, y, z] = value;
    if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z)) return { x, y, z };
  } else if (value && typeof value === 'object'
    && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)) {
    return { x: value.x, y: value.y, z: value.z };
  }
  throw new TypeError(`environment-ibl: ${label} must be a finite {x,y,z} vector`);
}

const vecAdd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vecScale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vecDot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const vecCross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
function vecNormalise(a, label) {
  const length = Math.hypot(a.x, a.y, a.z);
  if (!(length > 1e-12)) throw new TypeError(`environment-ibl: ${label} must not be a zero-length vector`);
  return { x: a.x / length, y: a.y / length, z: a.z / length };
}

/**
 * Fit an orthographic shadow camera to the visible part of a 1-2 km city.
 *
 * **Pure.** It reads only its arguments, allocates only its result, imports
 * nothing from three, and touches no scene object. The same arguments always
 * produce the same numbers, so it is safe to call every frame and safe to
 * assert on in a headless check.
 *
 * @param {object} options
 * @param {{x:number,y:number,z:number}|number[]} options.cameraPosition World-space eye.
 * @param {{x:number,y:number,z:number}|number[]} options.cameraDirection Forward,
 *   need not be normalised. (`camera.getWorldDirection(v)`.)
 * @param {number} options.fovDeg Vertical field of view in degrees.
 * @param {number} options.aspect Width / height.
 * @param {{x:number,y:number,z:number}|number[]} options.sunDirection Unit-ish
 *   direction **toward** the sun, i.e. what `computeSunDirection` returns.
 * @param {number} [options.shadowDistance=220] Metres of view depth covered.
 * @param {number} [options.cameraNear=0.5]
 * @param {number} [options.mapSize=2048]
 * @param {number} [options.maxCasterHeight=260]
 * @param {number} [options.minCasterAltitudeDeg=3]
 * @param {number} [options.maxCasterExtrusion=3200]
 * @param {number} [options.shadowNear=1]
 * @param {boolean} [options.texelSnap=true]
 * @param {number} [options.normalBiasTexels=1.25]
 * @param {number} [options.depthBiasTexels=0.5]
 * @returns {Readonly<object>} `{ left, right, top, bottom, near, far }` for
 *   `light.shadow.camera`, `position` / `target` for `light` and `light.target`,
 *   `normalBias` / `bias` for `light.shadow`, the achieved `texelsPerMetre`,
 *   and the intermediates a diagnostic overlay wants.
 */
export function computeSunShadowCamera(options = {}) {
  const config = { ...SHADOW_FIT_DEFAULTS, ...options };
  const {
    fovDeg,
    aspect,
    shadowDistance,
    cameraNear,
    mapSize,
    maxCasterHeight,
    minCasterAltitudeDeg,
    maxCasterExtrusion,
    shadowNear,
    texelSnap,
    normalBiasTexels,
    depthBiasTexels,
  } = config;

  if (!isFiniteNumber(fovDeg) || fovDeg <= 0 || fovDeg >= 180) {
    throw new TypeError(`environment-ibl: fovDeg must be in (0, 180), got ${fovDeg}`);
  }
  if (!isFiniteNumber(aspect) || aspect <= 0) {
    throw new TypeError(`environment-ibl: aspect must be positive, got ${aspect}`);
  }
  if (!isFiniteNumber(cameraNear) || cameraNear <= 0) {
    throw new TypeError(`environment-ibl: cameraNear must be positive, got ${cameraNear}`);
  }
  if (!isFiniteNumber(shadowDistance) || shadowDistance <= cameraNear) {
    throw new TypeError(`environment-ibl: shadowDistance must exceed cameraNear, got ${shadowDistance}`);
  }
  if (!Number.isFinite(mapSize) || mapSize < 16) {
    throw new TypeError(`environment-ibl: mapSize must be at least 16, got ${mapSize}`);
  }
  if (!isFiniteNumber(shadowNear) || shadowNear <= 0) {
    throw new TypeError(`environment-ibl: shadowNear must be positive, got ${shadowNear}`);
  }

  const eye = readVec3(config.cameraPosition, 'cameraPosition');
  const forward = vecNormalise(readVec3(config.cameraDirection, 'cameraDirection'), 'cameraDirection');
  const toSun = vecNormalise(readVec3(config.sunDirection, 'sunDirection'), 'sunDirection');

  // --- camera basis. The world-up degeneracy (looking straight down a lift
  // shaft) is handled by swapping the reference axis, never by leaving a
  // near-zero cross product to normalise.
  const worldUp = Math.abs(forward.y) > 0.9995 ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
  const camRight = vecNormalise(vecCross(forward, worldUp), 'camera right');
  const camUp = vecCross(camRight, forward);

  // --- the eight frustum-slice corners.
  const tanHalfV = Math.tan(0.5 * fovDeg * DEG);
  const tanHalfH = tanHalfV * aspect;
  const frustumCorners = [];
  for (const depth of [cameraNear, shadowDistance]) {
    const h = depth * tanHalfV;
    const w = depth * tanHalfH;
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        frustumCorners.push(vecAdd(
          vecAdd(eye, vecScale(forward, depth)),
          vecAdd(vecScale(camRight, sx * w), vecScale(camUp, sy * h)),
        ));
      }
    }
  }

  // --- minimal on-axis sphere around the slice.
  // Equalise the distance to the near and far corner rings; clamp the solution
  // into the slice when one ring dominates. The radius is then taken from the
  // corners themselves, so containment is exact by construction rather than by
  // trusting the closed form.
  const k2 = (1 + aspect * aspect) * tanHalfV * tanHalfV;
  const a = cameraNear;
  const b = shadowDistance;
  const centreDistance = clamp(0.5 * (a + b) * (1 + k2), a, b);
  const centre0 = vecAdd(eye, vecScale(forward, centreDistance));
  let radius = 0;
  for (const corner of frustumCorners) {
    radius = Math.max(radius, Math.hypot(corner.x - centre0.x, corner.y - centre0.y, corner.z - centre0.z));
  }

  // --- light basis. `lightForward` is the direction the light travels.
  const lightForward = vecScale(toSun, -1);
  const lightRef = Math.abs(lightForward.y) > 0.9995 ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
  const lightRight = vecNormalise(vecCross(lightRef, lightForward), 'light right');
  const lightUp = vecCross(lightForward, lightRight);

  // --- box. One texel of margin absorbs the half-texel that snapping can move
  // the centre on each axis, which is what makes containment provable:
  //   texelWorld = 2r / (mapSize - 2)  =>  width = 2(r + texelWorld) = mapSize * texelWorld.
  const texelWorld = (2 * radius) / (mapSize - 2);
  const halfExtent = radius + texelWorld;

  let centre = centre0;
  if (texelSnap) {
    const cx = Math.round(vecDot(centre0, lightRight) / texelWorld) * texelWorld;
    const cy = Math.round(vecDot(centre0, lightUp) / texelWorld) * texelWorld;
    const cz = vecDot(centre0, lightForward);
    centre = vecAdd(
      vecAdd(vecScale(lightRight, cx), vecScale(lightUp, cy)),
      vecScale(lightForward, cz),
    );
  }

  // --- near-plane extrusion: how far back the light must sit so that a caster
  // of `maxCasterHeight` still writes a complete shadow into the box.
  const sunAltitudeDeg = Math.asin(clamp(toSun.y, -1, 1)) / DEG;
  const extrusionAltitudeDeg = Math.max(sunAltitudeDeg, minCasterAltitudeDeg);
  const rawExtrusion = maxCasterHeight / Math.sin(extrusionAltitudeDeg * DEG);
  const casterExtrusion = Math.min(rawExtrusion, maxCasterExtrusion);
  const lightDistance = radius + casterExtrusion + shadowNear;
  const far = lightDistance + radius;
  const depthRange = far - shadowNear;

  const position = vecAdd(centre, vecScale(toSun, lightDistance));

  // --- light-space bounds of the frustum corners, relative to the final
  // centre. Returned so the integrator (and the self-check) can see the fit
  // actually contains what it claims to.
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const corner of frustumCorners) {
    const d = { x: corner.x - centre.x, y: corner.y - centre.y, z: corner.z - centre.z };
    const lx = vecDot(d, lightRight);
    const ly = vecDot(d, lightUp);
    const lz = vecDot(d, lightForward);
    bounds.minX = Math.min(bounds.minX, lx);
    bounds.maxX = Math.max(bounds.maxX, lx);
    bounds.minY = Math.min(bounds.minY, ly);
    bounds.maxY = Math.max(bounds.maxY, ly);
    bounds.minZ = Math.min(bounds.minZ, lz);
    bounds.maxZ = Math.max(bounds.maxZ, lz);
  }

  const texelsPerMetre = mapSize / (2 * halfExtent);
  const round = (value, places) => {
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
  };

  // --- bias.
  //
  // `normalBias` moves the shadow lookup along the surface normal, in metres.
  // Acne is a texel-footprint artifact, so the offset that cures it scales with
  // the texel, not with the scene: one texel is the width of the depth step the
  // map can represent, and `PCFSoftShadowMap` reads a 2x2 block spread over
  // about 1.5 texels, so 1.25 texels covers the kernel without paying for the
  // worst case. The price is peter-panning of at most `normalBias` metres,
  // which at the default fit is ~0.24 m - under the 0.19 m texel plus the
  // filter width, i.e. below what the map can resolve anyway.
  //
  // `bias` is added to the shadow-space depth in NDC, where the orthographic
  // depth range `far - near` maps linearly onto [-1, 1]. So a pull-back of `t`
  // metres toward the light is `-2t / depthRange`, and half a texel is enough
  // once `normalBias` has done the geometric work. Expressing it this way is
  // the point: the extrusion above makes `depthRange` swing from ~670 m at noon
  // to ~2500 m at golden hour, and a constant `bias` that is correct at noon is
  // four times too weak at 18:30. That is the second half of why the current
  // fixed `-0.0004` does nothing useful.
  const normalBias = round(normalBiasTexels * texelWorld, 4);
  const bias = -round((depthBiasTexels * texelWorld * 2) / depthRange, 7);

  const warnings = [];
  if (sunAltitudeDeg <= 0) {
    warnings.push('sun is below the horizon: set light.castShadow = false and let the local lights carry the night');
  } else if (sunAltitudeDeg < minCasterAltitudeDeg) {
    warnings.push(`sun altitude ${sunAltitudeDeg.toFixed(2)} deg is below minCasterAltitudeDeg `
      + `${minCasterAltitudeDeg}: shadows past the fit radius will be clipped`);
  }
  if (rawExtrusion > maxCasterExtrusion) {
    warnings.push(`caster extrusion clamped from ${Math.round(rawExtrusion)} m to ${maxCasterExtrusion} m: `
      + 'the tallest casters lose the far end of their shadow');
  }
  if (texelsPerMetre < SHADOW_TEXEL_DENSITY_RANGE[0]) {
    warnings.push(`texel density ${texelsPerMetre.toFixed(2)}/m is below the ${SHADOW_TEXEL_DENSITY_RANGE[0]}/m floor: `
      + 'reduce shadowDistance or raise mapSize');
  }
  if (texelsPerMetre > SHADOW_TEXEL_DENSITY_RANGE[1]) {
    warnings.push(`texel density ${texelsPerMetre.toFixed(2)}/m is above the ${SHADOW_TEXEL_DENSITY_RANGE[1]}/m ceiling: `
      + 'the map is covering less than the visible street');
  }

  return Object.freeze({
    // --- straight onto light.shadow.camera
    left: -halfExtent,
    right: halfExtent,
    top: halfExtent,
    bottom: -halfExtent,
    near: shadowNear,
    far,
    // --- straight onto light / light.target
    position: Object.freeze(position),
    target: Object.freeze(centre),
    // --- straight onto light.shadow
    normalBias,
    bias,
    mapSize,
    // --- diagnostics
    texelsPerMetre,
    texelWorldSize: texelWorld,
    radius,
    halfExtent,
    width: 2 * halfExtent,
    depthRange,
    lightDistance,
    casterExtrusion,
    casterExtrusionUnclamped: rawExtrusion,
    centreDistance,
    sunAltitudeDeg,
    shadowDistance,
    castShadow: sunAltitudeDeg > 0,
    frustumCorners: Object.freeze(frustumCorners.map((corner) => Object.freeze(corner))),
    lightSpaceBounds: Object.freeze(bounds),
    lightBasis: Object.freeze({
      right: Object.freeze(lightRight),
      up: Object.freeze(lightUp),
      forward: Object.freeze(lightForward),
    }),
    warnings: Object.freeze(warnings),
  });
}

/**
 * Copy a fit onto a three `DirectionalLight`.
 *
 * The one impure helper in this module, and deliberately trivial: it assigns
 * plain numeric properties on an object the caller already owns. It creates no
 * renderer, no light, no scene node and no loop, and it imports nothing - so it
 * still runs under the headless self-check against a plain stub.
 *
 * `light.target` must already be in the scene graph, which is the usual
 * `scene.add(light.target)` line.
 *
 * @param {object} light A `DirectionalLight` (or a stub with the same shape).
 * @param {Readonly<object>} fit Result of `computeSunShadowCamera`.
 * @returns {Readonly<object>} `fit`, for chaining.
 */
export function applySunShadowFit(light, fit) {
  if (!light || typeof light !== 'object' || !light.shadow || !light.position) {
    throw new TypeError('environment-ibl: applySunShadowFit(light, fit) needs a DirectionalLight');
  }
  const camera = light.shadow.camera;
  if (!camera) throw new TypeError('environment-ibl: light.shadow.camera is missing');

  light.position.set?.(fit.position.x, fit.position.y, fit.position.z);
  if (light.target?.position?.set) {
    light.target.position.set(fit.target.x, fit.target.y, fit.target.z);
    light.target.updateMatrixWorld?.();
  }
  camera.left = fit.left;
  camera.right = fit.right;
  camera.top = fit.top;
  camera.bottom = fit.bottom;
  camera.near = fit.near;
  camera.far = fit.far;
  camera.updateProjectionMatrix?.();
  light.shadow.normalBias = fit.normalBias;
  light.shadow.bias = fit.bias;
  if (typeof light.castShadow === 'boolean') light.castShadow = fit.castShadow;
  light.shadow.needsUpdate = true;
  return fit;
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
