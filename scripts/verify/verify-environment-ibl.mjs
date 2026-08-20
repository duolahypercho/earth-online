/**
 * Headless self-check for src/render/environment-ibl.js.
 *
 * Runs in plain node: no browser, no DOM, no canvas, no WebGL, no GPU, no new
 * npm dependency. It asserts the pure half of the module (solar position, sky
 * colour model, turbidity response over the day, equirect buffer, material
 * intensity table, light-rig recommendation) and exercises the rig's cache and
 * LRU through an injected stub prefilter generator.
 *
 * Exits non-zero on the first failed assertion.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_LIGHT_RIG,
  CANONICAL_CAPTURE_HOURS,
  CANONICAL_SITE,
  CANONICAL_SKY_DATE,
  GOLDEN_HOUR_ALTITUDE_BAND_DEG,
  MATERIAL_CLASSES,
  SHADOW_TEXEL_DENSITY_RANGE,
  SKY_MODEL_VERSION,
  WEATHER_KINDS,
  applyEnvMapIntensity,
  applySunShadowFit,
  baselineFillCurve,
  classifyMaterialClass,
  computeSkyModel,
  computeSolarDay,
  computeSunDirection,
  computeSunShadowCamera,
  createEnvironmentRig,
  dayOfYearFromMonthDay,
  directBeamTransmittance,
  envMapIntensityFor,
  envMapIntensityTable,
  environmentCacheKey,
  lightRigSchedule,
  normaliseWeather,
  quantiseHour,
  recommendedLightRig,
  renderEquirectRadiance,
  resolveDayOfYear,
  sampleSkyRadiance,
  weatherProfile,
  wrapHour,
} from '../../src/render/environment-ibl.js';

const MODULE_PATH = fileURLToPath(new URL('../../src/render/environment-ibl.js', import.meta.url));

let checks = 0;
const results = [];
// Reporting state: the sections fill these in so the run prints the numbers a
// reader of the handoff needs, generated rather than typed.
let solarDayRow = null;
const captureRows = [];
const shadowDistanceRows = [];
const shadowHourRows = [];
let shadowDensityRow = null;
let lightRigRows = [];
let lightRigContinuity = null;
async function section(name, body) {
  const started = process.hrtime.bigint();
  await body();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  results.push(`  ok  ${name} (${ms.toFixed(1)} ms)`);
}
function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}
const finite = (values) => values.every((v) => Number.isFinite(v));
const nonNegative = (values) => values.every((v) => v >= 0);
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const warmth = (c) => c[0] / Math.max(1e-9, c[2]);

// ---------------------------------------------------------------- determinism
await section('module source is deterministic', () => {
  // Scan executable code only: the module's own documentation legitimately
  // mentions the things that must never appear in the code itself.
  const source = readFileSync(MODULE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check(source.length > 4000, 'module source was read');
  check(!/Math\.random\s*\(/.test(source), 'module must not call Math.random()');
  check(!/Date\.now\s*\(/.test(source), 'module must not call Date.now()');
  check(!/new Date\s*\(/.test(source), 'module must not construct Date');
  check(!/ShaderMaterial/.test(source), 'module must not introduce a ShaderMaterial');
  check(!/onBeforeCompile/.test(source), 'module must not introduce onBeforeCompile');
  check(!/new\s+\w*Renderer\s*\(/.test(source), 'module must not construct a renderer');
  check(!/requestAnimationFrame|setAnimationLoop/.test(source), 'module must not own an animation loop');
});

// ------------------------------------------------------------- solar position
await section('solar position', () => {
  for (let h = 0; h < 24; h += 0.25) {
    const sun = computeSunDirection(h);
    const length = Math.hypot(sun.x, sun.y, sun.z);
    check(Math.abs(length - 1) < 1e-12, `sun direction must be unit at h=${h}, got ${length}`);
    check(finite([sun.x, sun.y, sun.z, sun.altitudeDeg, sun.azimuthDeg]), `sun finite at h=${h}`);
    check(sun.azimuthDeg >= 0 && sun.azimuthDeg < 360, `azimuth in range at h=${h}`);
    check(Math.abs(sun.y - Math.sin(sun.altitudeDeg * Math.PI / 180)) < 1e-12, `y matches altitude at h=${h}`);
  }

  const dawn = computeSunDirection(6.5);
  const morning = computeSunDirection(9);
  const noon = computeSunDirection(12);
  const afternoon = computeSunDirection(16);
  const night = computeSunDirection(1);

  check(noon.altitudeDeg > morning.altitudeDeg, 'noon sun is higher than 09:00');
  check(morning.altitudeDeg > dawn.altitudeDeg, '09:00 sun is higher than 06:30');
  check(night.altitudeDeg < 0, 'the sun is below the horizon at 01:00');
  check(morning.azimuthDeg < 180, 'morning sun is in the eastern half');
  check(afternoon.azimuthDeg > 180, 'afternoon sun is in the western half');
  // -Z is north, +Z is south: at solar noon in the northern hemisphere the sun is south.
  check(noon.z > 0.5, 'noon sun sits to the south (+Z)');
  check(morning.x > 0, 'morning sun sits to the east (+X)');
  check(afternoon.x < 0, 'afternoon sun sits to the west (-X)');

  // Deterministic: identical inputs give identical outputs.
  assert.deepEqual(computeSunDirection(15.25), computeSunDirection(15.25));
  // Latitude is honoured.
  const equator = computeSunDirection(12, { latitudeDeg: 0, longitudeDeg: 0, timezoneOffsetHours: 0 });
  check(equator.altitudeDeg > 60, `equator noon sun should be high, got ${equator.altitudeDeg}`);
  checks += 1;
});

// ------------------------------------------------------- hour quantisation
await section('hour quantisation and cache keys', () => {
  check(wrapHour(-0.5) === 23.5, 'wrapHour handles negatives');
  check(wrapHour(24) === 0, 'wrapHour wraps 24 to 0');
  check(quantiseHour(12.12) === 12, '12.12 -> 12.00');
  check(quantiseHour(12.13) === 12.25, '12.13 -> 12.25');
  check(quantiseHour(12.125) === 12.25, 'bucket boundary rounds up deterministically');
  check(quantiseHour(23.95) === 0, '23.95 wraps to 0');
  check(quantiseHour(15.4, 1) === 15, 'coarser quantum honoured');

  const a = environmentCacheKey({ hour: 15.01, weather: 'clear' });
  const b = environmentCacheKey({ hour: 15.11, weather: 'clear' });
  const c = environmentCacheKey({ hour: 15.4, weather: 'clear' });
  const d = environmentCacheKey({ hour: 15.01, weather: 'fog' });
  check(a === b, 'hours inside one bucket share a cache key');
  check(a !== c, 'different buckets get different cache keys');
  check(a !== d, 'weather is part of the cache key');
  check(a.startsWith(SKY_MODEL_VERSION), 'cache key carries the model version');

  assert.throws(() => normaliseWeather('hail'), TypeError);
  assert.throws(() => quantiseHour(12, 0), TypeError);
  assert.throws(() => wrapHour(Number.NaN), TypeError);
  checks += 3;
  for (const kind of WEATHER_KINDS) check(weatherProfile(kind).weather === kind, `profile for ${kind}`);
});

// ---------------------------------------------------------------- sky model
await section('sky radiance is finite, non-negative and never black', () => {
  const directions = [
    [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [0.6, 0.05, -0.8], [-0.3, -0.4, 0.86], [0.1, 0.99, 0.05],
  ];
  for (const weather of WEATHER_KINDS) {
    for (let h = 0; h < 24; h += 0.5) {
      const model = computeSkyModel({ hour: h, weather });
      check(model.version === SKY_MODEL_VERSION, 'model carries version');
      check(finite([...model.zenithRadiance, ...model.horizonRadiance, ...model.groundRadiance]),
        `probes finite at ${weather} ${h}`);
      check(nonNegative([...model.zenithRadiance, ...model.horizonRadiance, ...model.groundRadiance]),
        `probes non-negative at ${weather} ${h}`);
      check(model.skyIrradianceLuminance > 0,
        `environment must never be fully black (${weather} ${h}), got ${model.skyIrradianceLuminance}`);
      for (const [x, y, z] of directions) {
        const c = sampleSkyRadiance(model, x, y, z);
        check(finite(c) && nonNegative(c), `radiance finite/non-negative ${weather} ${h} dir ${x},${y},${z}`);
      }
    }
  }
  assert.throws(() => sampleSkyRadiance(computeSkyModel({ hour: 12 }), 0, 0, 0), TypeError);
  checks += 1;
});

await section('daylight sky is blue, twilight horizon is warm', () => {
  const noon = computeSkyModel({ hour: 12, weather: 'clear' });
  const [nr, ng, nb] = noon.zenithRadiance;
  check(nb > ng && ng > nr, `clear midday zenith must be blue, got ${nr},${ng},${nb}`);

  const dusk = computeSkyModel({ hour: 17.75, weather: 'clear' });
  check(warmth(dusk.sunwardHorizonRadiance) > 2.0,
    `low-sun horizon must be warm, r/b = ${warmth(dusk.sunwardHorizonRadiance)}`);
  check(warmth(noon.sunwardHorizonRadiance) < 1.0,
    `midday horizon must stay cool, r/b = ${warmth(noon.sunwardHorizonRadiance)}`);
  check(warmth(dusk.sunwardHorizonRadiance) > warmth(dusk.antisunHorizonRadiance) * 2,
    'the sunward horizon is warmer than the opposite horizon at dusk');

  // Brightness falls monotonically from midday into the night.
  const ladder = [12, 15, 17, 18.5, 21].map((h) => computeSkyModel({ hour: h, weather: 'clear' }).skyIrradianceLuminance);
  for (let i = 1; i < ladder.length; i += 1) {
    check(ladder[i] < ladder[i - 1], `sky irradiance must fall from 12:00 to 21:00, step ${i}: ${ladder.join(' > ')}`);
  }
  const nightModel = computeSkyModel({ hour: 23, weather: 'clear' });
  check(nightModel.night > 0.99, 'the model knows 23:00 is night');
  check(nightModel.daylight < 0.01, 'no daylight at 23:00');
  check(lum(nightModel.horizonRadiance) > lum(nightModel.zenithRadiance),
    'urban skyglow makes the night horizon brighter than the night zenith');
});

await section('turbidity and weather response', () => {
  for (const hour of [9, 12, 15]) {
    const clear = computeSkyModel({ hour, weather: 'clear' });
    const fog = computeSkyModel({ hour, weather: 'fog' });
    const drizzle = computeSkyModel({ hour, weather: 'drizzle' });

    check(fog.turbidity > clear.turbidity, 'fog is more turbid than clear air');
    check(fog.turbidity > drizzle.turbidity, 'fog is more turbid than drizzle');

    // An overcast dome must never out-light a clear sky with the same sun.
    check(fog.skyIrradianceLuminance < clear.skyIrradianceLuminance,
      `fog must transmit less than clear at ${hour}: ${fog.skyIrradianceLuminance} vs ${clear.skyIrradianceLuminance}`);
    check(drizzle.skyIrradianceLuminance < fog.skyIrradianceLuminance,
      `drizzle must be darker than fog at ${hour}`);

    // High turbidity flattens the dome: less sunward/antisunward contrast.
    check(fog.sunwardContrast < clear.sunwardContrast,
      `fog must be flatter than clear at ${hour}: ${fog.sunwardContrast} vs ${clear.sunwardContrast}`);

    // Overcast domes are closer to neutral grey than a clear sky.
    const saturation = (c) => (Math.max(...c) - Math.min(...c)) / Math.max(1e-9, Math.max(...c));
    check(saturation(fog.zenithRadiance) < saturation(clear.zenithRadiance),
      `fog zenith must be less saturated than clear at ${hour}`);

    check(drizzle.wetness > 0 && clear.wetness === 0, 'only rain marks surfaces wet');
  }

  // The ground hemisphere is a bounce, not a void, and it is darker than the sky.
  const model = computeSkyModel({ hour: 12, weather: 'clear' });
  const down = sampleSkyRadiance(model, 0, -1, 0);
  check(lum(down) > 0, 'the lower hemisphere is not black');
  check(lum(down) < lum(model.horizonRadiance), 'the ground bounce is darker than the sky');
  for (let i = 0; i < 3; i += 1) {
    check(Math.abs(down[i] - model.groundRadiance[i]) < 1e-12, 'straight down equals the ground radiance');
  }
});

await section('exposure and solar disc options', () => {
  const base = computeSkyModel({ hour: 12 });
  const bright = computeSkyModel({ hour: 12, exposure: 2 });
  check(Math.abs(bright.skyIrradianceLuminance / base.skyIrradianceLuminance - 2) < 1e-6,
    'exposure scales radiance linearly');
  for (let i = 0; i < 3; i += 1) {
    check(Math.abs(bright.groundRadiance[i] / base.groundRadiance[i] - 2) < 1e-9,
      'exposure scales the ground bounce too');
  }
  // Night skyglow must follow exposure as well, or a dimmed environment would
  // still have a full-brightness night floor.
  const night1 = computeSkyModel({ hour: 23 });
  const night2 = computeSkyModel({ hour: 23, exposure: 2 });
  check(Math.abs(night2.skyIrradianceLuminance / night1.skyIrradianceLuminance - 2) < 1e-6,
    'exposure scales the night skyglow');
  assert.throws(() => computeSkyModel({ hour: 12, exposure: 0 }), TypeError);
  checks += 1;

  const withDisc = computeSkyModel({ hour: 12, sunDiscIntensity: 1 });
  const sun = withDisc.sun;
  const atSun = sampleSkyRadiance(withDisc, sun.x, sun.y, sun.z);
  const atSunNoDisc = sampleSkyRadiance(base, sun.x, sun.y, sun.z);
  check(lum(atSun) > lum(atSunNoDisc) * 100, 'the optional solar disc is genuinely bright');
  check(base.sunDiscIntensity === 0, 'the disc is off by default so the key light is not double-counted');
});

// ------------------------------------------------------------ equirect buffer
await section('equirect radiance buffer', () => {
  const model = computeSkyModel({ hour: 15, weather: 'clear' });
  const width = 128;
  const height = 64;
  const buffer = renderEquirectRadiance(model, width, height);
  check(buffer.width === width && buffer.height === height, 'buffer reports its size');
  check(buffer.data.length === width * height * 3, 'buffer is RGB float, width*height*3');
  check(buffer.data instanceof Float32Array, 'buffer is a Float32Array');
  for (let i = 0; i < buffer.data.length; i += 1) {
    if (!Number.isFinite(buffer.data[i]) || buffer.data[i] < 0) {
      assert.fail(`equirect texel ${i} is ${buffer.data[i]}`);
    }
  }
  checks += 1;

  // Row 0 is the nadir and the last row is the zenith (DataTexture, flipY = false).
  const rowLum = (j) => {
    let total = 0;
    for (let i = 0; i < width; i += 1) {
      const o = (j * width + i) * 3;
      total += lum([buffer.data[o], buffer.data[o + 1], buffer.data[o + 2]]);
    }
    return total / width;
  };
  check(Math.abs(rowLum(0) - lum(model.groundRadiance)) < 1e-3, 'bottom row is the ground bounce');
  check(Math.abs(rowLum(height - 1) - lum(model.zenithRadiance)) < 5e-3, 'top row is close to the zenith');
  // The horizon band is the brightest part of a clear daytime dome; the
  // sunlit ground bounce sits between it and the deep blue zenith.
  check(rowLum(height / 2) > rowLum(0), 'the sky at the horizon is brighter than the ground bounce');
  check(rowLum(height / 2) > rowLum(height - 1), 'the horizon is brighter than the zenith under a clear sky');

  // Horizontal wrap: crossing the u=0 seam must be no more of a jump than an
  // ordinary step between neighbouring columns. (An absolute tolerance would
  // be wrong: near a low sun the azimuthal gradient is genuinely steep.)
  const texel = (i, j, k) => buffer.data[(j * width + i) * 3 + k];
  for (let j = 0; j < height; j += 1) {
    for (let k = 0; k < 3; k += 1) {
      const seam = Math.abs(texel(0, j, k) - texel(width - 1, j, k));
      const neighbour = Math.max(
        Math.abs(texel(0, j, k) - texel(1, j, k)),
        Math.abs(texel(width - 2, j, k) - texel(width - 1, j, k)),
      );
      check(seam <= neighbour * 2.5 + 1e-6,
        `equirect must wrap continuously at row ${j} channel ${k}: seam ${seam} vs neighbour ${neighbour}`);
    }
  }

  // The fast row path must agree with the documented per-direction sampler.
  let maxRelative = 0;
  for (const [i, j] of [[0, 0], [17, 5], [64, 32], [127, 63], [40, 48], [99, 12]]) {
    const u = (i + 0.5) / width;
    const v = (j + 0.5) / height;
    const elevation = (v - 0.5) * Math.PI;
    const dy = Math.sin(elevation);
    const r = Math.cos(elevation);
    const phi = (u - 0.5) * Math.PI * 2;
    const expected = sampleSkyRadiance(model, Math.cos(phi) * r, dy, Math.sin(phi) * r);
    const o = (j * width + i) * 3;
    for (let k = 0; k < 3; k += 1) {
      maxRelative = Math.max(maxRelative, Math.abs(expected[k] - buffer.data[o + k]) / Math.max(1e-6, expected[k]));
    }
  }
  check(maxRelative < 1e-5, `row fast path must match sampleSkyRadiance, max relative error ${maxRelative}`);

  // Determinism: byte-identical across runs, and independent of call order.
  const again = renderEquirectRadiance(computeSkyModel({ hour: 15, weather: 'clear' }), width, height);
  assert.deepEqual(Array.from(again.data), Array.from(buffer.data));
  checks += 1;

  assert.throws(() => renderEquirectRadiance(model, 2, 64), TypeError);
  assert.throws(() => renderEquirectRadiance(model, 128.5, 64), TypeError);
  checks += 2;
});

// ------------------------------------------------------------ envMapIntensity
await section('envMapIntensity per material class', () => {
  const clearNoon = computeSkyModel({ hour: 12, weather: 'clear' });
  const wetNoon = computeSkyModel({ hour: 12, weather: 'drizzle' });
  const night = computeSkyModel({ hour: 23, weather: 'clear' });

  const table = envMapIntensityTable(clearNoon);
  check(Object.keys(table).length === MATERIAL_CLASSES.length, 'the table covers every material class');
  for (const key of MATERIAL_CLASSES) {
    const value = table[key];
    check(Number.isFinite(value) && value > 0 && value <= 3, `${key} intensity in (0, 3]: ${value}`);
    check(value === envMapIntensityFor(key, clearNoon), `${key} table matches the accessor`);
  }
  check(table['facade-glass'] > table['facade-masonry'], 'glass reflects more than masonry');
  check(table.water > table.foliage, 'water reflects more than foliage');
  check(table.chrome > table['painted-metal'], 'chrome reflects more than painted metal');

  check(envMapIntensityFor('asphalt', wetNoon) > envMapIntensityFor('asphalt', clearNoon) * 1.5,
    'wet asphalt reflects far more than dry asphalt');
  check(envMapIntensityFor('sidewalk', wetNoon) > envMapIntensityFor('sidewalk', clearNoon),
    'wet concrete reflects more than dry concrete');
  check(envMapIntensityFor('facade-masonry', night) < envMapIntensityFor('facade-masonry', clearNoon),
    'masonry pulls its env response back at night');

  assert.throws(() => envMapIntensityFor('unobtainium', clearNoon), TypeError);
  checks += 1;

  // A bare {hour, weather} state works as well as a full model.
  check(envMapIntensityFor('asphalt', { hour: 12, weather: 'drizzle' }) === envMapIntensityFor('asphalt', wetNoon),
    'a plain state is accepted in place of a model');

  // classifyMaterialClass covers the shapes the city data actually produces.
  const cityMaterials = ['painted', 'plaster', 'brick', 'concrete', 'clapboard', 'glass', 'stone'];
  const cityFacades = ['edwardian', 'modern-grid', 'bay-window', 'shopfront', 'loft', 'art-deco'];
  for (const material of cityMaterials) {
    for (const facade of cityFacades) {
      const cls = classifyMaterialClass({ material, facade });
      check(MATERIAL_CLASSES.includes(cls), `classify(${material}, ${facade}) -> known class, got ${cls}`);
    }
  }
  check(classifyMaterialClass({ kind: 'road' }) === 'asphalt', 'road -> asphalt');
  check(classifyMaterialClass({ kind: 'sidewalk' }) === 'sidewalk', 'sidewalk -> sidewalk');
  check(classifyMaterialClass({ kind: 'water' }) === 'water', 'water -> water');
  check(classifyMaterialClass({ kind: 'vehicle' }) === 'painted-metal', 'vehicle -> painted metal');
  check(classifyMaterialClass({ material: 'glass' }) === 'facade-glass', 'glass -> facade glass');
  check(classifyMaterialClass({}) === 'facade-masonry', 'unknown falls back to masonry');

  // applyEnvMapIntensity works on plain objects, arrays and class maps.
  const single = { envMapIntensity: 1, needsUpdate: false };
  check(applyEnvMapIntensity(single, 'water', clearNoon) === 1, 'single material updated');
  check(single.envMapIntensity === table.water, 'single material got the right value');
  check(single.needsUpdate === true, 'needsUpdate flagged when present');

  const list = [{ envMapIntensity: 0 }, { envMapIntensity: 0 }, null];
  check(applyEnvMapIntensity(list, 'asphalt', clearNoon) === 2, 'arrays are handled and nulls skipped');
  check(list[0].envMapIntensity === table.asphalt, 'array entries updated');

  const grouped = {
    'facade-glass': [{ envMapIntensity: 0 }, { envMapIntensity: 0 }],
    asphalt: { envMapIntensity: 0 },
  };
  check(applyEnvMapIntensity(grouped, clearNoon) === 3, 'class map updates every listed material');
  check(grouped['facade-glass'][1].envMapIntensity === table['facade-glass'], 'grouped glass updated');
});

// ------------------------------------------------------------------ light rig
await section('recommended light rig', () => {
  const day = recommendedLightRig({ hour: 12, weather: 'clear' });
  const night = recommendedLightRig({ hour: 23, weather: 'clear' });
  const fog = recommendedLightRig({ hour: 12, weather: 'fog' });

  for (const rig of [day, night, fog]) {
    for (const key of ['sun', 'hemi', 'ambient', 'rim']) {
      check(Number.isFinite(rig[key]) && rig[key] > 0, `${key} must be a positive number, got ${rig[key]}`);
      check(rig[key] <= BASELINE_LIGHT_RIG[key] + 1e-9, `${key} must not exceed the baseline`);
    }
    check(rig.environmentIntensity > 0 && rig.environmentIntensity <= 1.2, 'environmentIntensity in range');
    assert.deepEqual(rig.baseline, { ...BASELINE_LIGHT_RIG });
    checks += 1;
  }

  // IBL supplements the key light; it never replaces it.
  check(day.sun > BASELINE_LIGHT_RIG.sun * 0.85, `key light stays dominant, got ${day.sun}`);
  check(day.sun > day.hemi * 4, 'the sun still dominates the fill in daylight');
  // The fill drops because the environment now carries it.
  check(day.hemi < BASELINE_LIGHT_RIG.hemi * 0.5, `hemi must drop by half or more, got ${day.hemi}`);
  check(day.ambient < BASELINE_LIGHT_RIG.ambient * 0.4, `ambient must drop hard, got ${day.ambient}`);
  check(day.rim < BASELINE_LIGHT_RIG.rim, 'rim eases back a little');
  // At night the environment is dim skyglow, so punctual fill must stay up.
  check(night.hemi > day.hemi * 2, `night keeps more hemi fill (${night.hemi} vs ${day.hemi})`);
  check(night.ambient > day.ambient, 'night keeps more ambient fill');
  // Overcast. The v1 check here asserted `fog.hemi <= day.hemi` on the theory
  // that an overcast sky is pure fill and so IBL should take even more of it.
  // That only held because the v1 energy normalisation let a fog dome deliver
  // nearly as much irradiance as a clear one. With the irradiance-normalised
  // dome, fog transmits exactly 0.62 of clear, so the environment carries
  // *less* absolute fill under fog and the punctual fill legitimately rises.
  // What actually defines overcast is the key/fill ratio, so that is what is
  // asserted now - a stricter statement than the old one, not a looser one.
  check(fog.sun < day.sun, `overcast trims the key harder (${fog.sun} vs ${day.sun})`);
  check(fog.sun / fog.hemi < day.sun / day.hemi,
    `overcast lowers the key:fill ratio (${(fog.sun / fog.hemi).toFixed(2)} vs ${(day.sun / day.hemi).toFixed(2)})`);
  check(fog.shadow.intensity < day.shadow.intensity, 'overcast softens the shadow map');
  check(fog.fill.environment < day.fill.environment, 'an overcast dome delivers less irradiance than a clear one');
  check(fog.environmentIntensity < day.environmentIntensity, 'overcast trims environment intensity');
  // In clear daylight the environment must be carrying most of the fill, which
  // is the whole reason the punctual fill was allowed to drop.
  check(day.fill.environment > day.fill.punctual * 2,
    `IBL carries the daylight fill (${day.fill.environment} env vs ${day.fill.punctual} punctual)`);

  // A custom baseline is honoured.
  const custom = recommendedLightRig({ hour: 12 }, { sun: 4, hemi: 2, ambient: 1, rim: 1 });
  check(custom.hemi < 2 && custom.sun > 3, 'custom baseline scaled, not ignored');
});


// ------------------------------------------- canonical date and capture hours
await section('canonical date, and the golden-hour defect it fixes', () => {
  check(CANONICAL_SKY_DATE.month === 9 && CANONICAL_SKY_DATE.day === 22,
    'the canonical date is September 22, the September equinox');
  check(CANONICAL_SKY_DATE.dayOfYear === 265, 'September 22 is day 265 of a common year');
  check(CANONICAL_SITE.utcOffsetHours === -7,
    'the canonical offset is UTC-7, the offset actually in force in San Francisco on that date');
  check(CANONICAL_SITE.standardUtcOffsetHours === -8, 'the standard-time offset is recorded alongside it');
  check(Math.abs(CANONICAL_SITE.latitudeDeg - 37.7749) < 1e-9, 'latitude is San Francisco');
  check(Math.abs(CANONICAL_SITE.longitudeDeg + 122.4194) < 1e-9, 'longitude is San Francisco');

  const day = computeSolarDay();
  solarDayRow = day;
  // Equinox: the day is 12 hours long, the sun rises due east and sets due west.
  check(Math.abs(day.daylightHours - 12) < 0.2,
    `an equinox day is 12 hours long, got ${day.daylightHours.toFixed(3)}`);
  check(Math.abs(computeSunDirection(day.sunriseHour).azimuthDeg - 90) < 2,
    'the equinox sun rises due east');
  check(Math.abs(computeSunDirection(day.sunsetHour).azimuthDeg - 270) < 2,
    'the equinox sun sets due west, which is what makes the canyon card a canyon card');
  check(day.sunsetHour > 19 && day.sunsetHour < 19.2,
    `sunset is just after 19:00 local, got ${day.sunsetHour.toFixed(3)}`);
  check(day.sunriseHour > 6.9 && day.sunriseHour < 7.1,
    `sunrise is just after 07:00 local, got ${day.sunriseHour.toFixed(3)}`);
  check(day.solarNoonHour > 13 && day.solarNoonHour < 13.1,
    `solar noon is 13:02, not 12:00 - SF sits west in its zone, got ${day.solarNoonHour.toFixed(3)}`);

  // The defect, stated as an assertion. The pre-fix configuration was day 264
  // on the site's *standard* offset, UTC-8, on a date when San Francisco is on
  // UTC-7. Reproducing it must put the golden-hour card below the horizon, and
  // must land on the altitude that was measured from the real capture: -4.83.
  const preFix = computeSunDirection(18.5, { dayOfYear: 264, utcOffsetHours: -8 });
  check(preFix.altitudeDeg < 0,
    `the pre-fix UTC-8 offset put 18:30 below the horizon (${preFix.altitudeDeg.toFixed(2)} deg)`);
  check(Math.abs(preFix.altitudeDeg + 4.83) < 0.25,
    `and it reproduces the measured -4.83 deg, got ${preFix.altitudeDeg.toFixed(2)}`);
  // The whole difference is the one-hour offset, not the model.
  const sameDateRightOffset = computeSunDirection(18.5, { dayOfYear: 264, utcOffsetHours: -7 });
  check(sameDateRightOffset.altitudeDeg > 0,
    'the same date on the offset actually in force is above the horizon');
  check(sameDateRightOffset.altitudeDeg - preFix.altitudeDeg > 11,
    'one hour of clock error is ~12 degrees of altitude at this time of day');

  // Every canonical capture hour lands in its documented altitude band.
  for (const entry of CANONICAL_CAPTURE_HOURS) {
    const sun = computeSunDirection(entry.hour);
    captureRows.push({ entry, sun });
    check(sun.altitudeDeg >= entry.minAltitudeDeg && sun.altitudeDeg <= entry.maxAltitudeDeg,
      `hour ${entry.hour} altitude ${sun.altitudeDeg.toFixed(2)} must be in `
      + `[${entry.minAltitudeDeg}, ${entry.maxAltitudeDeg}] (${entry.label})`);
    check((sun.altitudeDeg > 0) === entry.aboveHorizon,
      `hour ${entry.hour} above-horizon expectation`);
    check(sun.dayOfYear === CANONICAL_SKY_DATE.dayOfYear, `hour ${entry.hour} used the canonical date`);
    check(sun.utcOffsetHours === CANONICAL_SITE.utcOffsetHours, `hour ${entry.hour} used the canonical offset`);
  }

  // Golden hour specifically: above the horizon, low, warm, and inside the
  // documented band rather than merely "not dark".
  const golden = computeSunDirection(18.5);
  check(golden.altitudeDeg > 0, `18:30 must be above the horizon, got ${golden.altitudeDeg.toFixed(2)}`);
  check(golden.altitudeDeg >= GOLDEN_HOUR_ALTITUDE_BAND_DEG[0]
    && golden.altitudeDeg <= GOLDEN_HOUR_ALTITUDE_BAND_DEG[1],
    `18:30 must sit inside the golden-hour band, got ${golden.altitudeDeg.toFixed(2)}`);
  check(day.goldenHourEvening.startHour <= 18.5 && day.goldenHourEvening.endHour >= 18.5,
    `18:30 must sit inside the evening golden-hour window `
    + `[${day.goldenHourEvening.startHour.toFixed(2)}, ${day.goldenHourEvening.endHour.toFixed(2)}]`);
  check(golden.azimuthDeg > 255 && golden.azimuthDeg < 285,
    `the golden-hour sun must rake in from the west, got azimuth ${golden.azimuthDeg.toFixed(1)}`);
  check(day.sunsetHour - 18.5 > 0.4 && day.sunsetHour - 18.5 < 1.2,
    'the golden-hour card sits roughly half an hour before sunset');

  // And it must read warm and low in the rendered sky, not just in the geometry.
  const goldenSky = computeSkyModel({ hour: 18.5, weather: 'clear' });
  const noonSky = computeSkyModel({ hour: 12, weather: 'clear' });
  check(goldenSky.daylight > 0.9, 'the 18:30 model is still a daylight model, not a dusk model');
  check(warmth(goldenSky.sunwardHorizonRadiance) > warmth(noonSky.sunwardHorizonRadiance) * 1.3,
    'the golden-hour sunward horizon is markedly warmer than noon');
  check(goldenSky.sunwardContrast > noonSky.sunwardContrast,
    'the low sun concentrates radiance toward its own azimuth');
  check(lum(goldenSky.skyIrradiance) < lum(noonSky.skyIrradiance) * 0.35,
    'golden-hour sky irradiance has fallen well below noon');
});

// -------------------------------------------------- date as explicit parameter
await section('date is an explicit, documented parameter', () => {
  check(dayOfYearFromMonthDay(1, 1) === 1, 'Jan 1 is day 1');
  check(dayOfYearFromMonthDay(12, 31) === 365, 'Dec 31 is day 365');
  check(dayOfYearFromMonthDay(3, 1) === 60, 'Mar 1 is day 60 in a common year');
  check(dayOfYearFromMonthDay(6, 21) === 172, 'Jun 21 is day 172');
  assert.throws(() => dayOfYearFromMonthDay(13, 1), TypeError);
  assert.throws(() => dayOfYearFromMonthDay(2, 30), RangeError);
  checks += 2;

  // Every accepted spelling of the date resolves identically.
  check(resolveDayOfYear() === 265, 'no date means the canonical date');
  check(resolveDayOfYear({ date: { month: 9, day: 22 } }) === 265, '{month, day} form');
  check(resolveDayOfYear({ date: '09-22' }) === 265, 'MM-DD form');
  check(resolveDayOfYear({ date: '2025-09-22' }) === 265, 'YYYY-MM-DD form');
  check(resolveDayOfYear({ date: 265 }) === 265, 'day-of-year form');
  check(resolveDayOfYear({ dayOfYear: 172 }) === 172, 'legacy dayOfYear still honoured');
  check(resolveDayOfYear({ date: { month: 6, day: 21 }, dayOfYear: 1 }) === 172, 'date outranks dayOfYear');
  assert.throws(() => resolveDayOfYear({ date: 'nonsense' }), TypeError);
  assert.throws(() => resolveDayOfYear({ dayOfYear: 900 }), TypeError);
  checks += 2;

  const a = computeSunDirection(18.5);
  const b = computeSunDirection(18.5, { date: '09-22' });
  const c = computeSunDirection(18.5, { date: { month: 9, day: 22 }, utcOffsetHours: -7 });
  check(Math.abs(a.altitudeDeg - b.altitudeDeg) < 1e-12, 'the default really is the canonical date');
  check(Math.abs(a.altitudeDeg - c.altitudeDeg) < 1e-12, 'the default really is the canonical offset');

  // The date is load-bearing, not decorative: a solstice moves 18:30 a long way.
  const summer = computeSunDirection(18.5, { date: { month: 6, day: 21 } });
  const winter = computeSunDirection(18.5, { date: { month: 12, day: 21 }, utcOffsetHours: -8 });
  check(summer.altitudeDeg > 20, `midsummer 18:30 is high afternoon, got ${summer.altitudeDeg.toFixed(2)}`);
  check(winter.altitudeDeg < -10, `midwinter 18:30 is night, got ${winter.altitudeDeg.toFixed(2)}`);
  check(summer.altitudeDeg - winter.altitudeDeg > 40, 'the date parameter has real authority');

  // Deprecated spelling still works and still wins when it is the only one given.
  const legacy = computeSunDirection(18.5, { timezoneOffsetHours: -8 });
  check(legacy.utcOffsetHours === -8, 'timezoneOffsetHours is honoured as an alias');
  check(Math.abs(legacy.altitudeDeg - computeSunDirection(18.5, { utcOffsetHours: -8 }).altitudeDeg) < 1e-12,
    'the alias and the new spelling agree');
  // ...including through computeSkyModel, which must not pre-merge the defaults.
  const legacySky = computeSkyModel({ hour: 18.5, site: { timezoneOffsetHours: -8 } });
  check(legacySky.sun.altitudeDeg < 0, 'the site override reaches the sky model');

  // Determinism: identical inputs, identical output, no hidden clock.
  assert.deepEqual(computeSunDirection(18.5, { date: '09-22' }), computeSunDirection(18.5, { date: '09-22' }));
  assert.deepEqual(computeSolarDay({ date: '06-21' }), computeSolarDay({ date: '06-21' }));
  checks += 2;

  // Solar-day maths generalises: a summer day is longer than an equinox day.
  const summerDay = computeSolarDay({ date: { month: 6, day: 21 } });
  check(summerDay.daylightHours > 14, `midsummer is a long day, got ${summerDay.daylightHours.toFixed(2)}`);
  check(summerDay.maxAltitudeDeg > computeSolarDay().maxAltitudeDeg + 20, 'and a much higher sun');
});

// ------------------------------------------------------ sun shadow camera fit
await section('sun shadow camera fit', () => {
  // The recorded 01-street-day pose, verbatim.
  const eye = { x: 1435.49, y: 1.86, z: 993.43 };
  const look = { x: 1379.47, y: 1.76, z: 1064.06 };
  const direction = { x: look.x - eye.x, y: look.y - eye.y, z: look.z - eye.z };
  const fovDeg = 47;
  const aspect = 1280 / 720;
  const base = { cameraPosition: eye, cameraDirection: direction, fovDeg, aspect };

  assert.throws(() => computeSunShadowCamera({ ...base, sunDirection: { x: 0, y: 0, z: 0 } }), TypeError);
  assert.throws(() => computeSunShadowCamera({ ...base, fovDeg: 0, sunDirection: { x: 0, y: 1, z: 0 } }), TypeError);
  assert.throws(() => computeSunShadowCamera({ ...base, sunDirection: [0, 1] }), TypeError);
  assert.throws(() => computeSunShadowCamera({
    ...base, sunDirection: { x: 0, y: 1, z: 0 }, shadowDistance: 0.1,
  }), TypeError);
  checks += 4;

  // --- purity and determinism.
  const sunAt15 = computeSunDirection(15);
  const first = computeSunShadowCamera({ ...base, sunDirection: sunAt15 });
  const second = computeSunShadowCamera({ ...base, sunDirection: sunAt15 });
  assert.deepEqual(first, second);
  checks += 1;
  const mutableSun = { x: sunAt15.x, y: sunAt15.y, z: sunAt15.z };
  const mutableEye = { ...eye };
  computeSunShadowCamera({ ...base, cameraPosition: mutableEye, sunDirection: mutableSun });
  assert.deepEqual(mutableSun, { x: sunAt15.x, y: sunAt15.y, z: sunAt15.z });
  assert.deepEqual(mutableEye, eye);
  checks += 2;
  check(Object.isFrozen(first) && Object.isFrozen(first.position) && Object.isFrozen(first.lightSpaceBounds),
    'the fit is frozen, so a caller cannot mutate a cached result');

  // --- the box must contain the camera frustum corners in light space.
  // Swept over sun altitude, camera yaw and pitch, and shadow distance.
  let worstSlack = Infinity;
  let densityMin = Infinity;
  let densityMax = -Infinity;
  for (let hour = 7; hour <= 19; hour += 0.5) {
    const sun = computeSunDirection(hour);
    if (sun.altitudeDeg <= 0) continue;
    for (const yaw of [0, 0.9, 2.1, 3.5, 4.8, 6.0]) {
      for (const pitch of [-0.9, -0.2, 0, 0.35, 1.4]) {
        const dir = {
          x: Math.cos(pitch) * Math.sin(yaw),
          y: Math.sin(pitch),
          z: Math.cos(pitch) * Math.cos(yaw),
        };
        for (const shadowDistance of [120, 220, 400]) {
          const fit = computeSunShadowCamera({
            cameraPosition: eye, cameraDirection: dir, fovDeg, aspect, sunDirection: sun, shadowDistance,
          });
          const b = fit.lightSpaceBounds;
          const slack = Math.min(
            b.minX - fit.left, fit.right - b.maxX,
            b.minY - fit.bottom, fit.top - b.maxY,
          );
          worstSlack = Math.min(worstSlack, slack);
          check(slack >= 0,
            `frustum corners must sit inside the box (h=${hour} yaw=${yaw} d=${shadowDistance}, slack ${slack})`);
          // Depth: every corner must be between near and far along the light axis.
          const nearDepth = fit.lightDistance + b.minZ;
          const farDepth = fit.lightDistance + b.maxZ;
          check(nearDepth >= fit.near && farDepth <= fit.far,
            `frustum corners must sit inside the depth range (h=${hour}, ${nearDepth}..${farDepth})`);
          if (shadowDistance === 220) {
            densityMin = Math.min(densityMin, fit.texelsPerMetre);
            densityMax = Math.max(densityMax, fit.texelsPerMetre);
          }
        }
      }
    }
  }
  check(worstSlack >= 0, 'containment held across the whole sweep');
  check(worstSlack < 1.0, `the fit is tight, not merely safe: worst slack ${worstSlack.toFixed(4)} m`);

  // --- texel density is invariant to sun altitude and camera orientation.
  // This is the property that a naive light-space AABB fit does not have, and
  // the reason the sphere fit was chosen.
  shadowDensityRow = { min: densityMin, max: densityMax };
  check(densityMax - densityMin < 1e-9,
    `texel density must not move with the sun or the camera: ${densityMin} .. ${densityMax}`);
  check(densityMin >= SHADOW_TEXEL_DENSITY_RANGE[0] && densityMax <= SHADOW_TEXEL_DENSITY_RANGE[1],
    `density ${densityMin.toFixed(3)}/m must sit inside the documented `
    + `[${SHADOW_TEXEL_DENSITY_RANGE[0]}, ${SHADOW_TEXEL_DENSITY_RANGE[1]}] band`);
  for (const shadowDistance of [120, 220, 300, 400]) {
    const fit = computeSunShadowCamera({ ...base, sunDirection: sunAt15, shadowDistance });
    shadowDistanceRows.push(fit);
    check(fit.texelsPerMetre >= SHADOW_TEXEL_DENSITY_RANGE[0]
      && fit.texelsPerMetre <= SHADOW_TEXEL_DENSITY_RANGE[1],
      `shadowDistance ${shadowDistance} m stays inside the documented density band `
      + `(${fit.texelsPerMetre.toFixed(3)}/m)`);
    check(fit.warnings.length === 0, `shadowDistance ${shadowDistance} m produces no warning`);
    // Density is exactly mapSize / width, and width is exactly mapSize texels.
    check(Math.abs(fit.width - fit.texelWorldSize * fit.mapSize) < 1e-9, 'width is a whole number of texels');
    check(Math.abs(fit.texelsPerMetre * fit.texelWorldSize - 1) < 1e-12, 'density and texel size are reciprocal');
  }
  // Density scales with resolution exactly as it should.
  const at1024 = computeSunShadowCamera({ ...base, sunDirection: sunAt15, mapSize: 1024 });
  const at4096 = computeSunShadowCamera({ ...base, sunDirection: sunAt15, mapSize: 4096 });
  check(at4096.texelsPerMetre / at1024.texelsPerMetre > 3.9, 'quadrupling the map roughly quadruples the density');

  // --- texel snapping: a sub-texel camera nudge must not move the box.
  const snapped = computeSunShadowCamera({ ...base, sunDirection: sunAt15 });
  const nudge = computeSunShadowCamera({
    ...base,
    cameraPosition: { x: eye.x + snapped.texelWorldSize * 0.1, y: eye.y, z: eye.z },
    sunDirection: sunAt15,
  });
  const centreMove = Math.hypot(
    nudge.target.x - snapped.target.x, nudge.target.y - snapped.target.y, nudge.target.z - snapped.target.z,
  );
  check(centreMove < 1e-9 || centreMove >= snapped.texelWorldSize - 1e-9,
    `snapping means the centre either holds still or moves a whole texel, moved ${centreMove}`);
  const unsnapped = computeSunShadowCamera({ ...base, sunDirection: sunAt15, texelSnap: false });
  check(Math.abs(unsnapped.width - snapped.width) < 1e-9, 'snapping changes the centre, never the size');

  // --- near-plane extrusion: this is what a fixed shadow camera gets wrong.
  const noon = computeSunShadowCamera({ ...base, sunDirection: computeSunDirection(12) });
  const golden = computeSunShadowCamera({ ...base, sunDirection: computeSunDirection(18.5) });
  shadowHourRows.push(noon, golden);
  check(golden.casterExtrusion > noon.casterExtrusion * 4,
    `a low sun needs far more extrusion (${golden.casterExtrusion.toFixed(0)} m vs ${noon.casterExtrusion.toFixed(0)} m)`);
  check(Math.abs(golden.casterExtrusion - 260 / Math.sin(golden.sunAltitudeDeg * Math.PI / 180)) < 1,
    'extrusion follows maxCasterHeight / sin(altitude)');
  check(golden.texelsPerMetre === noon.texelsPerMetre,
    'and the extrusion costs no texel density, only depth range');
  check(golden.depthRange > noon.depthRange * 3, 'it is paid for in depth range instead');
  // The light must actually stand between the sun and the city.
  for (const fit of [noon, golden]) {
    const toLight = {
      x: fit.position.x - fit.target.x, y: fit.position.y - fit.target.y, z: fit.position.z - fit.target.z,
    };
    const length = Math.hypot(toLight.x, toLight.y, toLight.z);
    check(Math.abs(length - fit.lightDistance) < 1e-6, 'the light sits at lightDistance from the target');
    const sun = fit === noon ? computeSunDirection(12) : computeSunDirection(18.5);
    const alignment = (toLight.x * sun.x + toLight.y * sun.y + toLight.z * sun.z) / length;
    check(alignment > 1 - 1e-9, 'and it sits along the direction toward the sun');
    check(fit.position.y > fit.target.y, 'the light is above its target while the sun is up');
  }

  // --- bias recommendations scale the way they are documented to.
  check(noon.normalBias > 0 && noon.normalBias < 1, `normalBias is a small positive offset, got ${noon.normalBias}`);
  check(Math.abs(noon.normalBias - 1.25 * noon.texelWorldSize) < 1e-3,
    'normalBias is 1.25 texel widths, because acne is a texel-footprint artifact');
  check(at4096.normalBias < noon.normalBias * 0.6, 'a denser map needs a proportionally smaller normalBias');
  check(noon.bias < 0, 'depth bias pulls toward the light, so it is negative');
  check(golden.bias > noon.bias,
    `the golden-hour depth range is larger, so the same metre pull-back is a smaller NDC bias `
    + `(${golden.bias} vs ${noon.bias})`);
  for (const fit of [noon, golden, at1024, at4096]) {
    // bias, converted back to metres through the orthographic depth range,
    // must always be half a texel.
    const metres = Math.abs(fit.bias) * fit.depthRange / 2;
    check(Math.abs(metres - 0.5 * fit.texelWorldSize) < 2e-3,
      `bias must be half a texel of depth pull-back, got ${metres.toFixed(4)} m vs ${(0.5 * fit.texelWorldSize).toFixed(4)} m`);
  }

  // --- night and grazing sun are reported, not silently mis-fitted.
  const night = computeSunShadowCamera({ ...base, sunDirection: computeSunDirection(21.5) });
  check(night.castShadow === false, 'below the horizon the fit says do not cast');
  check(night.warnings.length > 0 && /below the horizon/.test(night.warnings[0]), 'and says why');
  check(Number.isFinite(night.far) && night.far > night.near, 'the box stays well formed anyway');
  const grazing = computeSunShadowCamera({
    ...base, sunDirection: { x: 1, y: Math.tan(1 * Math.PI / 180), z: 0 },
  });
  check(grazing.warnings.some((w) => /minCasterAltitudeDeg/.test(w)), 'a 1 deg sun is flagged');
  check(grazing.casterExtrusion <= 3200 + 1e-9, 'and the extrusion is clamped');
  // Straight-down sun and straight-down camera are both handled.
  const overhead = computeSunShadowCamera({ ...base, sunDirection: { x: 0, y: 1, z: 0 } });
  check(Number.isFinite(overhead.width) && overhead.width > 0, 'an overhead sun does not degenerate');
  const lookDown = computeSunShadowCamera({
    ...base, cameraDirection: { x: 0, y: -1, z: 0 }, sunDirection: sunAt15,
  });
  check(Number.isFinite(lookDown.width) && lookDown.width > 0, 'a camera looking straight down does not degenerate');

  // --- applySunShadowFit writes exactly the properties it claims to.
  const light = {
    castShadow: false,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    target: { position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, updated: 0, updateMatrixWorld() { this.updated += 1; } },
    shadow: {
      bias: -0.0004,
      normalBias: 0,
      needsUpdate: false,
      camera: {
        left: -420, right: 420, top: 420, bottom: -420, near: 10, far: 1000,
        projections: 0,
        updateProjectionMatrix() { this.projections += 1; },
      },
    },
  };
  applySunShadowFit(light, noon);
  check(light.shadow.camera.left === noon.left && light.shadow.camera.far === noon.far, 'the box is copied across');
  check(light.shadow.camera.projections === 1, 'the projection matrix is refreshed exactly once');
  check(light.position.x === noon.position.x && light.position.y === noon.position.y, 'the light is moved');
  check(light.target.position.z === noon.target.z && light.target.updated === 1, 'the target is moved and updated');
  check(light.shadow.normalBias === noon.normalBias && light.shadow.bias === noon.bias, 'bias is applied');
  check(light.castShadow === true, 'castShadow follows the fit');
  applySunShadowFit(light, night);
  check(light.castShadow === false, 'and is turned off at night');
  assert.throws(() => applySunShadowFit(null, noon), TypeError);
  assert.throws(() => applySunShadowFit({ position: {}, shadow: {} }, noon), TypeError);
  checks += 2;

  // --- the fixed camera the renderer ships today, measured against the fit.
  // 840 m box on a 2048 map is 2.44 texels/m, and it is anchored 420 m from a
  // light position that does not follow the camera at all.
  const fixedTexels = 2048 / 840;
  check(fixedTexels < SHADOW_TEXEL_DENSITY_RANGE[0],
    `the shipped +/-420 m box is below the density floor (${fixedTexels.toFixed(2)}/m)`);
  check(noon.texelsPerMetre > fixedTexels * 2, 'the fit more than doubles the texel density at the same map size');
});

// ------------------------------------------------- light rig across the day
await section('light rig across the day', () => {
  for (const weather of WEATHER_KINDS) {
    const schedule = lightRigSchedule(weather);
    if (weather === 'clear') lightRigRows = schedule;
    check(schedule.length === CANONICAL_CAPTURE_HOURS.length, 'one row per canonical capture hour');
    for (const row of schedule) {
      check(row.scales.sun > 0 && row.scales.sun <= 1, `sun scale in (0,1] at ${row.hour}`);
      check(row.scales.hemi > 0 && row.scales.hemi <= 1.2, `hemi scale bounded at ${row.hour}`);
      check(row.scales.ambient > 0 && row.scales.ambient <= 1.2, `ambient scale bounded at ${row.hour}`);
      check(row.fill.punctual >= 0, `punctual fill is never negative at ${row.hour}`);
      check(Math.abs(row.fill.environment + row.fill.punctual - row.fill.total) < 1e-3,
        `fill accounting closes at ${row.hour}`);
      check(row.shadow.castShadow === (row.sunAltitudeDeg > 0), `shadow advice matches the sun at ${row.hour}`);
    }
  }

  const clear = lightRigSchedule('clear');
  const byHour = new Map(clear.map((row) => [row.hour, row]));
  const noon = byHour.get(12);
  const golden = byHour.get(18.5);
  const night = byHour.get(21.5);
  const morning = byHour.get(9);

  // The v1 defect, stated as an assertion: the recommendation must not be a
  // day/night switch. v1 returned the identical scales at 09:00, 12:00, 15:00
  // and 18:30 because `daylight` saturates six degrees off the horizon.
  check(Math.abs(golden.scales.hemi - noon.scales.hemi) > 0.08,
    `golden hour and noon must not get the same hemi advice (${golden.scales.hemi} vs ${noon.scales.hemi})`);
  check(Math.abs(morning.scales.hemi - noon.scales.hemi) > 0.05,
    `09:00 and noon must not get the same hemi advice (${morning.scales.hemi} vs ${noon.scales.hemi})`);
  check(golden.scales.hemi > noon.scales.hemi,
    'the environment carries a seventh of the fill at golden hour, so the punctual fill must come back up');
  check(golden.fill.environment < noon.fill.environment * 0.2, 'and that is why: env fill has collapsed');

  // The key is not trimmed at low sun: the atmosphere already did that.
  check(golden.scales.sun > noon.scales.sun,
    `the key must not be trimmed twice at golden hour (${golden.scales.sun} vs ${noon.scales.sun})`);
  check(golden.key.transmittance < noon.key.transmittance * 0.5,
    `direct-beam transmittance already halves the key at golden hour `
    + `(${golden.key.transmittance} vs ${noon.key.transmittance})`);
  check(noon.key.relativeIrradiance > golden.key.relativeIrradiance * 8,
    'and the horizontal key irradiance falls by far more than the fill does');
  check(golden.key.airMass > 6 && noon.key.airMass < 1.5, 'air mass follows Kasten-Young');

  // The rim takes the largest cut in daylight, because the env replaces it.
  check(noon.scales.rim < noon.scales.hemi + 0.4, 'the rim is cut hard at noon');
  check(night.scales.rim > 0.9, 'and left alone at night, where the env is only skyglow');

  // Night: the environment is dim skyglow, so punctual fill must stay high.
  check(night.scales.hemi > noon.scales.hemi * 2, 'night keeps its punctual fill');
  check(night.fill.environment < 0.05, 'because the night environment carries almost nothing');
  check(night.shadow.castShadow === false, 'and the sun casts nothing at 21:30');

  // The advice must be continuous in the thing that matters - the intensity
  // the renderer ends up with - even where its own day/night curve steps.
  let worstAbsoluteStep = 0;
  let worstTotalStep = 0;
  let previous = null;
  for (let hour = 0; hour < 24; hour += 0.25) {
    const rig = computeSkyModel({ hour, weather: 'clear' }).lightRig;
    if (previous) {
      worstAbsoluteStep = Math.max(worstAbsoluteStep,
        Math.abs(rig.absolute.hemi - previous.absolute.hemi) + Math.abs(rig.absolute.ambient - previous.absolute.ambient));
      worstTotalStep = Math.max(worstTotalStep, Math.abs(rig.fill.total - previous.fill.total));
    }
    previous = rig;
  }
  check(worstAbsoluteStep < 0.2,
    `recommended fill intensity must not jump between hour buckets, worst ${worstAbsoluteStep.toFixed(4)}`);
  check(worstTotalStep < 0.25,
    `total fill must not jump between hour buckets, worst ${worstTotalStep.toFixed(4)}`);
  lightRigContinuity = { absolute: worstAbsoluteStep, total: worstTotalStep };

  // The baseline curve is documented, not guessed at.
  check(Math.abs(baselineFillCurve(1).fill - 1.69) < 1e-9, 'the daylight baseline fill is 1.69');
  check(Math.abs(baselineFillCurve(0).fill - 0.63) < 1e-9, 'the night baseline fill is 0.63');
  check(baselineFillCurve(0.5).fill > baselineFillCurve(0).fill, 'the curve is monotonic');

  // Transmittance model behaves.
  check(directBeamTransmittance(90).transmittance > directBeamTransmittance(30).transmittance,
    'a higher sun is less attenuated');
  check(directBeamTransmittance(-5).transmittance === 0, 'a set sun delivers no direct beam');
  check(directBeamTransmittance(0).airMass > 30, 'air mass blows up at the horizon');
});

// -------------------------------------------------------------------- the rig
await section('environment rig lifecycle, cache and LRU', () => {
  assert.throws(() => createEnvironmentRig(null), TypeError);
  assert.throws(() => createEnvironmentRig({}), TypeError);
  checks += 2;

  // Stub renderer + stub prefilter generator: enough to drive every code path
  // in the rig without a GPU. The real rig uses THREE.PMREMGenerator here.
  const rendererStub = { hasInitialized: () => true };
  let prefilterCalls = 0;
  let disposedTargets = 0;
  let generatorDisposed = 0;
  const makeTarget = () => {
    const target = {
      texture: { id: prefilterCalls, isTexture: true },
      dispose() { disposedTargets += 1; },
    };
    return target;
  };
  const pmremStub = {
    fromEquirectangular(texture) {
      check(texture.image.width === 64 && texture.image.height === 32, 'equirect texture reaches the prefilter');
      check(texture.flipY === false, 'DataTexture must not be flipped');
      prefilterCalls += 1;
      return makeTarget();
    },
    async fromEquirectangularAsync() { prefilterCalls += 1; return makeTarget(); },
    dispose() { generatorDisposed += 1; },
  };

  const scene = { environment: null, environmentIntensity: 1 };
  const rig = createEnvironmentRig(rendererStub, {
    scene,
    equirectWidth: 64,
    equirectHeight: 32,
    hourQuantum: 0.25,
    cacheSize: 3,
    pmremGenerator: pmremStub,
  });

  const first = rig.update({ hour: 12, weather: 'clear' });
  check(prefilterCalls === 1, 'the first update prefilters once');
  check(first.regenerated === true, 'the first update reports a regeneration');
  check(scene.environment === first.texture, 'scene.environment is assigned');
  check(scene.environmentIntensity === first.model.lightRig.environmentIntensity, 'environmentIntensity applied');
  check(rig.getTexture() === first.texture, 'getTexture returns the live texture');
  check(rig.getModel().hour === 12, 'getModel returns the active model');

  // Inside the same quantised bucket nothing is regenerated: this is what makes
  // the rig safe to call every frame.
  for (let i = 0; i < 40; i += 1) rig.update({ hour: 12 + i * 0.002, weather: 'clear' });
  check(prefilterCalls === 1, `no regeneration inside one bucket, got ${prefilterCalls} calls`);
  check(rig.stats().cacheHits === 40, `cache hits counted, got ${rig.stats().cacheHits}`);
  check(rig.update({ hour: 12.05 }).regenerated === false, 'a cache hit reports regenerated=false');

  // Crossing a bucket regenerates exactly once.
  rig.update({ hour: 12.3, weather: 'clear' });
  check(prefilterCalls === 2, 'crossing a bucket regenerates once');
  rig.update({ hour: 12.3, weather: 'fog' });
  check(prefilterCalls === 3, 'changing weather regenerates');
  check(rig.getModel().weather === 'fog', 'weather change is reflected in the model');

  // LRU eviction keeps the cache bounded and disposes what it drops.
  const before = rig.stats().evictions;
  rig.update({ hour: 13, weather: 'clear' });
  rig.update({ hour: 14, weather: 'clear' });
  const stats = rig.stats();
  check(stats.cacheSize <= 3, `cache stays bounded, got ${stats.cacheSize}`);
  check(stats.evictions > before, 'eviction happened');
  check(disposedTargets === stats.evictions, 'every evicted target was disposed');
  check(stats.version === SKY_MODEL_VERSION, 'stats carry the model version');

  // Accessors work off the live model.
  check(rig.envMapIntensityFor('asphalt') === rig.envMapIntensityTable().asphalt, 'rig accessors agree');
  check(rig.recommendedLightRig().hemi > 0, 'rig exposes the light-rig recommendation');

  // Per-call scene override.
  const otherScene = { environment: null };
  rig.update({ hour: 20, weather: 'drizzle', scene: otherScene });
  check(otherScene.environment !== null, 'a per-call scene is assigned');

  rig.dispose();
  check(generatorDisposed === 1, 'the generator is disposed once');
  check(rig.getTexture() === null, 'the texture reference is dropped');
  rig.dispose();
  check(generatorDisposed === 1, 'dispose is idempotent');
  assert.throws(() => rig.update({ hour: 12 }), /disposed/);
  checks += 1;
});

await section('rig async path', () => {
  // updateAsync is exercised separately because it awaits renderer init.
  const rendererStub = { hasInitialized: () => false };
  let calls = 0;
  const rig = createEnvironmentRig(rendererStub, {
    equirectWidth: 64,
    equirectHeight: 32,
    pmremGenerator: {
      fromEquirectangular() { throw new Error('sync path must not be used'); },
      async fromEquirectangularAsync() {
        calls += 1;
        return { texture: { isTexture: true }, dispose() {} };
      },
      dispose() {},
    },
  });
  const scene = { environment: null, environmentIntensity: 1 };
  return rig.updateAsync({ hour: 8, weather: 'clear', scene }).then((result) => {
    check(calls === 1, 'updateAsync prefilters once');
    check(scene.environment === result.texture, 'updateAsync assigns scene.environment');
    rig.dispose();
  });
});

console.log(`verify-environment-ibl: ${SKY_MODEL_VERSION}`);
for (const line of results) console.log(line);

const f = (value, width, places = 2) => (
  value === null || value === undefined ? '-'.padStart(width) : value.toFixed(places).padStart(width)
);
const hm = (hour) => {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

console.log('');
console.log(`solar model: ${CANONICAL_SITE.name} ${CANONICAL_SKY_DATE.label}, `
  + `lat ${CANONICAL_SITE.latitudeDeg} lon ${CANONICAL_SITE.longitudeDeg}, `
  + `UTC${CANONICAL_SITE.utcOffsetHours} (PDT; standard offset is UTC${CANONICAL_SITE.standardUtcOffsetHours})`);
console.log(`  sunrise ${hm(solarDayRow.sunriseHour)}  solar noon ${hm(solarDayRow.solarNoonHour)}  `
  + `sunset ${hm(solarDayRow.sunsetHour)}  daylight ${solarDayRow.daylightHours.toFixed(2)} h  `
  + `peak altitude ${solarDayRow.maxAltitudeDeg.toFixed(2)} deg`);
console.log(`  evening golden hour ${hm(solarDayRow.goldenHourEvening.startHour)}`
  + `-${hm(solarDayRow.goldenHourEvening.endHour)} `
  + `(altitude ${GOLDEN_HOUR_ALTITUDE_BAND_DEG[1]} deg down to ${GOLDEN_HOUR_ALTITUDE_BAND_DEG[0]} deg)`);
console.log('  hour   altitude   azimuth   expected band   scene');
for (const { entry, sun } of captureRows) {
  console.log(`  ${hm(entry.hour)}  ${f(sun.altitudeDeg, 8)}  ${f(sun.azimuthDeg, 8, 1)}   `
    + `[${String(entry.minAltitudeDeg).padStart(4)},${String(entry.maxAltitudeDeg).padStart(4)}]   ${entry.label}`);
}
console.log(`  pre-fix config (day 264, UTC-8) put 18:30 at `
  + `${computeSunDirection(18.5, { dayOfYear: 264, utcOffsetHours: -8 }).altitudeDeg.toFixed(2)} deg `
  + '(measured from the real capture: -4.83) -> the golden-hour card rendered as dusk');

console.log('');
console.log('shadow camera fit (01-street-day pose, fov 47, 1280x720, 2048 map):');
console.log('  shadowDist   radius    box       texels/m   texel      normalBias');
for (const fit of shadowDistanceRows) {
  console.log(`  ${String(fit.shadowDistance).padStart(7)} m   ${f(fit.radius, 6, 1)}   `
    + `${f(fit.width, 6, 1)}    ${f(fit.texelsPerMetre, 7, 3)}   ${f(fit.texelWorldSize, 6, 4)} m   `
    + `${fit.normalBias} m`);
}
console.log(`  texel density over the sun/camera sweep at 220 m: `
  + `${shadowDensityRow.min.toFixed(6)} .. ${shadowDensityRow.max.toFixed(6)} texels/m (invariant by construction)`);
console.log('  hour    altitude   extrusion   near..far          depthRange   bias         normalBias');
for (const fit of shadowHourRows) {
  console.log(`  ${f(fit.sunAltitudeDeg, 8)} deg  ${f(fit.casterExtrusion, 8, 0)} m   `
    + `${f(fit.near, 5, 1)}..${f(fit.far, 7, 1)}   ${f(fit.depthRange, 8, 1)} m   `
    + `${String(fit.bias).padStart(11)}   ${fit.normalBias} m`);
}
console.log(`  shipped fixed box: +/-420 m on 2048 = ${(2048 / 840).toFixed(2)} texels/m, `
  + 'not anchored to the camera -> no shadows in frame');

console.log('');
console.log('light rig across the day (clear; scales multiply the renderer curve, absolute is the result):');
console.log('  hour   altitude  skyIrr   envFill  target  punctual  sun    hemi   ambient  rim    hemiAbs  ambAbs  T(beam)');
for (const row of lightRigRows) {
  console.log(`  ${hm(row.hour)}  ${f(row.sunAltitudeDeg, 8)}  ${f(row.skyIrradiance, 6, 3)}   `
    + `${f(row.fill.environment, 6, 3)}  ${f(row.fill.target, 6, 3)}   ${f(row.fill.punctual, 6, 3)}  `
    + `${f(row.scales.sun, 5, 3)}  ${f(row.scales.hemi, 5, 3)}  ${f(row.scales.ambient, 5, 3)}   `
    + `${f(row.scales.rim, 5, 3)}  ${f(row.absolute.hemi, 6, 3)}   ${f(row.absolute.ambient, 5, 3)}  `
    + `${f(row.key.transmittance, 5, 3)}`);
}
console.log(`  worst step between adjacent 0.25 h buckets: absolute fill `
  + `${lightRigContinuity.absolute.toFixed(4)}, total fill ${lightRigContinuity.total.toFixed(4)}`);

console.log('');
console.log(`verify-environment-ibl: PASS (${checks} assertions)`);
