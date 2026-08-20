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
  MATERIAL_CLASSES,
  SKY_MODEL_VERSION,
  WEATHER_KINDS,
  applyEnvMapIntensity,
  classifyMaterialClass,
  computeSkyModel,
  computeSunDirection,
  createEnvironmentRig,
  envMapIntensityFor,
  envMapIntensityTable,
  environmentCacheKey,
  normaliseWeather,
  quantiseHour,
  recommendedLightRig,
  renderEquirectRadiance,
  sampleSkyRadiance,
  weatherProfile,
  wrapHour,
} from '../../src/render/environment-ibl.js';

const MODULE_PATH = fileURLToPath(new URL('../../src/render/environment-ibl.js', import.meta.url));

let checks = 0;
const results = [];
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
  // Overcast light is almost pure fill, so IBL can take even more of it.
  check(fog.hemi <= day.hemi, 'overcast lets IBL take more of the fill');
  check(fog.environmentIntensity < day.environmentIntensity, 'overcast trims environment intensity');

  // A custom baseline is honoured.
  const custom = recommendedLightRig({ hour: 12 }, { sun: 4, hemi: 2, ambient: 1, rim: 1 });
  check(custom.hemi < 2 && custom.sun > 3, 'custom baseline scaled, not ignored');
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
console.log(`verify-environment-ibl: PASS (${checks} assertions)`);
