/**
 * Headless self-check for src/render/passes/sky-atmosphere.js and the
 * atmosphere half of src/render/environment-ibl.js.
 *
 * Runs in plain node: no browser, no DOM, no canvas, no WebGL, no GPU, no new
 * npm dependency. It builds the real pass against a synthetic city for every
 * hour of the day and every weather bucket, and asserts the numbers the
 * lighting rubric is scored on: solar monotonicity, key/fill direction,
 * exposure direction, sky luminance direction, fog ordering and map scaling,
 * determinism, NaN-freedom in every generated buffer, and the declared
 * triangle/draw/texture budget.
 *
 * What this file does and does not prove
 * --------------------------------------
 * It proves the model is self-consistent, deterministic, ordered in the right
 * direction, inside budget, and that the pass satisfies the registry contract
 * on both the node import path and the runtime's own build/update/dispose
 * cycle. It proves nothing at all about how the frame looks. A visual claim
 * needs matched captures and a human reviewer; see Docs/VISUAL_QUALITY_GATE.md.
 *
 * Exits non-zero on the first failed assertion.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BoxGeometry,
  Fog,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from 'three/webgpu';

import {
  ATMOSPHERE_MODEL_VERSION,
  EXPOSURE_CURVE,
  KEY_FILL_GAIN_RANGE,
  TARGET_KEY_FILL,
  WEATHER_KINDS,
  aerialPerspective,
  blackBodyColor,
  cloudProfile,
  computeSkyModel,
  computeSunDirection,
  keyFillBalance,
  morningInversion,
  nightPracticalProfile,
  recommendedExposure,
  renderCloudSheet,
  sceneIlluminance,
  skyDomeRadiance,
  starField,
  wetSurfaceGrade,
} from '../../src/render/environment-ibl.js';

import skyAtmosphere, {
  SKY_ATMOSPHERE_BUDGET,
  SKY_ATMOSPHERE_VERSION,
} from '../../src/render/passes/sky-atmosphere.js';
import { PASSES } from '../../src/render/passes/index.js';
import { createPassRuntime, validatePass } from '../../src/render/pass-registry.js';

const PASS_PATH = fileURLToPath(new URL('../../src/render/passes/sky-atmosphere.js', import.meta.url));
const MODULE_PATH = fileURLToPath(new URL('../../src/render/environment-ibl.js', import.meta.url));

let checks = 0;
const results = [];
// Reporting state: the sections fill these so the run prints the numbers a
// reader of the handoff needs, generated rather than typed.
const dayRows = [];
const weatherRows = [];
const budgetRows = [];
let fogSpanRows = [];
let contactRow = null;
let updateCostRow = null;

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
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Walk any plain value and fail on the first non-finite number found. This is
 * the NaN gate: a NaN in a vertex colour or a texture byte is invisible in a
 * unit test and catastrophic in a frame.
 */
function assertNoNaN(value, path, seen = new Set()) {
  if (typeof value === 'number') {
    check(Number.isFinite(value), `${path} must be finite, got ${value}`);
    return;
  }
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!Number.isFinite(value[i])) {
        check(false, `${path}[${i}] must be finite, got ${value[i]}`);
        return;
      }
    }
    checks += 1;
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertNoNaN(value[i], `${path}[${i}]`, seen);
    return;
  }
  for (const key of Object.keys(value)) assertNoNaN(value[key], `${path}.${key}`, seen);
}

// ------------------------------------------------------------- test fixtures

/**
 * A synthetic city with the exact shape the real generators emit
 * (`meta.bounds`, `buildings[].polygon`, `segments[].points/width`), at the
 * density the canonical SF slice reports: 700 buildings, 2835 segments.
 */
function makeCity({ buildings = 700, segments = 2835, span = 2000 } = {}) {
  const city = {
    meta: {
      name: 'verify-city',
      seed: 'verify',
      seedInt: 4242,
      generator: 'sf-builtin',
      bounds: { minX: 0, maxX: span, minZ: 0, maxZ: span },
      streetDesign: { roadLift: 0.45 },
    },
    buildings: [],
    segments: [],
    streets: [],
    blocks: [],
    signals: [],
  };
  const cols = 40;
  for (let i = 0; i < buildings; i += 1) {
    const x = (i % cols) * (span / cols);
    const z = Math.floor(i / cols) * 34;
    // Deliberately non-rectangular and non-axis-aligned: the contact skirt has
    // to mitre real footprints, and an axis-aligned test would hide that.
    city.buildings.push({
      id: `b-${i}`,
      height: 12 + (i % 11) * 4,
      material: 'brick',
      facade: 'shopfront',
      polygon: [
        { x, z },
        { x: x + 16, z: z + 2 },
        { x: x + 18, z: z + 14 },
        { x: x + 4, z: z + 16 },
        { x: x - 1, z: z + 8 },
      ],
    });
  }
  for (let i = 0; i < segments; i += 1) {
    const x = (i % 50) * (span / 50);
    const z = Math.floor(i / 50) * 24;
    city.segments.push({
      id: `s-${i}`,
      width: 8 + (i % 4) * 2,
      highway: 'secondary',
      points: [{ x, z }, { x: x + 64, z: z + 12 }],
    });
  }
  return city;
}

/**
 * Stand-ins for the renderer-owned groups this pass reads through
 * `ctx.legacyGroup`, under the names the renderer really assigns:
 * `street-lamps`, `shopfront-awnings`, `parked-car-bodies`. Without these the
 * practicals, the shop spill and the under-vehicle darkening would all build
 * zero geometry and the run would prove nothing about them.
 */
function addLegacyGroups(root, { lamps = 120, awnings = 90, cars = 140 } = {}) {
  const material = new MeshBasicMaterial();
  const lampGroup = new Group();
  lampGroup.name = 'street-lamps';
  for (let i = 0; i < lamps; i += 1) {
    const lamp = new Group();
    lamp.name = `street-lamp-${i}`;
    lamp.position.set((i % 20) * 34, 0, Math.floor(i / 20) * 48);
    lamp.userData = { kind: 'street-lamp' };
    lampGroup.add(lamp);
  }
  root.add(lampGroup);

  const awningGroup = new Group();
  awningGroup.name = 'shopfront-awnings';
  for (let i = 0; i < awnings; i += 1) {
    const mesh = new Mesh(new BoxGeometry(3, 0.14, 1.2), material);
    mesh.position.set((i % 18) * 41 + 6, 3.2, Math.floor(i / 18) * 55 + 4);
    mesh.rotation.y = (i % 4) * 0.4;
    awningGroup.add(mesh);
  }
  root.add(awningGroup);

  const cabs = new InstancedMesh(new BoxGeometry(4.4, 1.4, 1.9), material, cars);
  cabs.name = 'parked-car-bodies';
  const matrix = new Matrix4();
  for (let i = 0; i < cars; i += 1) {
    matrix.makeRotationY((i % 8) * 0.6);
    matrix.setPosition((i % 24) * 27 + 3, 0.7, Math.floor(i / 24) * 61 + 9);
    cabs.setMatrixAt(i, matrix);
  }
  root.add(cabs);
  return { lamps, awnings, cars };
}

function makeContext(city, { hour = 12, weather = 'clear', legacy = true } = {}) {
  const scene = new Scene();
  scene.fog = new Fog(0xe2e8e2, 330, 1380);
  const camera = new PerspectiveCamera(47, 16 / 9, 0.5, 4200);
  const root = new Group();
  root.name = 'city-root';
  scene.add(root);
  if (legacy) addLegacyGroups(root);
  return {
    root,
    city,
    scene,
    camera,
    renderer: null,
    rendererBackend: 'node-verify',
    terrain: null,
    heightAt: () => 0,
    isSanFrancisco: true,
    seed: 4242,
    hour,
    weather,
    day: 1,
    registerGeometry: (geometry) => geometry,
    legacyGroup: (name) => root.getObjectByName(name) || null,
  };
}

function countGeometry(object) {
  let triangles = 0;
  let drawCalls = 0;
  object.traverse((node) => {
    const geometry = node.geometry;
    if (!geometry) return;
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    const verts = index ? index.count : position ? position.count : 0;
    const instances = Number.isFinite(node.count) ? Math.max(1, node.count) : 1;
    triangles += Math.floor(verts / 3) * instances;
    drawCalls += 1;
  });
  return { triangles, drawCalls };
}

// ---------------------------------------------------------------- determinism

await section('module sources are deterministic and backend-safe', () => {
  const strip = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const [label, path] of [['pass', PASS_PATH], ['environment-ibl', MODULE_PATH]]) {
    const source = strip(readFileSync(path, 'utf8'));
    check(source.length > 2000, `${label} source was read`);
    check(!/Math\.random\s*\(/.test(source), `${label} must not call Math.random()`);
    check(!/Date\.now\s*\(/.test(source), `${label} must not call Date.now()`);
    check(!/new Date\s*\(/.test(source), `${label} must not construct Date`);
    check(!/performance\.now\s*\(/.test(source), `${label} must not read performance.now()`);
    // AGENTS.md: no new ShaderMaterial / onBeforeCompile dependency on the
    // canonical path, and no subsystem may own a renderer or a frame loop.
    check(!/ShaderMaterial/.test(source), `${label} must not introduce a ShaderMaterial`);
    check(!/onBeforeCompile/.test(source), `${label} must not introduce onBeforeCompile`);
    check(!/new\s+\w*Renderer\s*\(/.test(source), `${label} must not construct a renderer`);
    check(!/requestAnimationFrame|setAnimationLoop/.test(source),
      `${label} must not own an animation loop`);
    check(!/new\s+WebGLRenderTarget|new\s+RenderTarget/.test(source),
      `${label} must not allocate a render target`);
  }
});

// ------------------------------------------------------------ registry contract

await section('pass satisfies the registry contract', () => {
  check(validatePass(skyAtmosphere).length === 0,
    `pass must validate, got ${JSON.stringify(validatePass(skyAtmosphere))}`);
  check(skyAtmosphere.id === 'sky-atmosphere', 'pass id must be sky-atmosphere');
  check(Number.isFinite(skyAtmosphere.order), 'pass order must be finite');
  check(typeof skyAtmosphere.update === 'function', 'pass must expose update');
  check(typeof skyAtmosphere.dispose === 'function', 'pass must expose dispose');
  check(PASSES.includes(skyAtmosphere), 'pass must be registered in passes/index.js');
  check(SKY_ATMOSPHERE_VERSION.startsWith('sky-atmosphere'), 'pass version is tagged');

  // A pass "must not throw for bad input": the runtime records a build error
  // rather than losing the world, and this pass must not even do that.
  for (const bad of [undefined, {}, { city: null }, { city: { buildings: 'nope' } },
    { city: { meta: { bounds: {} }, buildings: [{ polygon: [{ x: NaN, z: 0 }] }] } }]) {
    let result;
    assert.doesNotThrow(() => { result = skyAtmosphere.build(bad); }, `build(${JSON.stringify(bad)}) must not throw`);
    checks += 1;
    check(result && typeof result === 'object', 'build returns a result for degenerate input');
    check(result.diagnostics && typeof result.diagnostics === 'object', 'degenerate build still reports diagnostics');
    skyAtmosphere.dispose();
  }
  assert.doesNotThrow(() => skyAtmosphere.update({}), 'update with no live build must not throw');
  assert.doesNotThrow(() => skyAtmosphere.dispose(), 'double dispose must not throw');
  checks += 2;
});

// ------------------------------------------------------- solar monotonicity

await section('sun direction is astronomically ordered', () => {
  // Altitude must rise from sunrise to solar noon and fall after it, with no
  // reversal. Solar noon on the canonical date is 13:02, so the turning point
  // is looked for rather than assumed to be 12:00.
  let peakHour = 0;
  let peak = -90;
  for (let h = 0; h < 24; h += 0.25) {
    const alt = computeSunDirection(h).altitudeDeg;
    if (alt > peak) { peak = alt; peakHour = h; }
  }
  check(peakHour > 12.5 && peakHour < 13.5, `solar noon must sit near 13:02, got ${peakHour}`);
  check(peak > 45 && peak < 60, `peak altitude must be 45..60 deg on the canonical date, got ${peak}`);

  let previous = computeSunDirection(7.5).altitudeDeg;
  for (let h = 7.75; h <= peakHour; h += 0.25) {
    const alt = computeSunDirection(h).altitudeDeg;
    check(alt > previous, `altitude must rise through the morning at h=${h} (${previous} -> ${alt})`);
    previous = alt;
  }
  previous = computeSunDirection(peakHour).altitudeDeg;
  for (let h = peakHour + 0.25; h <= 18.5; h += 0.25) {
    const alt = computeSunDirection(h).altitudeDeg;
    check(alt < previous, `altitude must fall through the afternoon at h=${h} (${previous} -> ${alt})`);
    previous = alt;
  }
  // Azimuth sweeps east -> south -> west across the day.
  const morning = computeSunDirection(9).azimuthDeg;
  const noon = computeSunDirection(13).azimuthDeg;
  const evening = computeSunDirection(17).azimuthDeg;
  check(morning < noon && noon < evening, `azimuth must sweep E->S->W, got ${morning}/${noon}/${evening}`);
  check(morning > 90 && morning < 150, `09:00 azimuth must be east-southeast, got ${morning}`);
  check(evening > 230 && evening < 280, `17:00 azimuth must be west-southwest, got ${evening}`);

  // The card the baseline capture uses.
  const noonCard = computeSunDirection(11);
  check(noonCard.altitudeDeg > 0, 'the sun must be above the horizon at 11:00');
  check(noonCard.y > 0, 'the sun vector must point up at 11:00');
  for (const h of [11, 12, 13]) {
    check(computeSunDirection(h).altitudeDeg > 25,
      `midday sun must be well clear of the horizon at ${h}:00`);
  }
});

// -------------------------------------------------- exposure and key/fill

await section('exposure and key/fill move in the right direction', () => {
  const noon = computeSkyModel({ hour: 12, weather: 'clear' });
  const golden = computeSkyModel({ hour: 18.5, weather: 'clear' });
  const night = computeSkyModel({ hour: 21.5, weather: 'clear' });

  const eNoon = recommendedExposure(noon);
  const eGolden = recommendedExposure(golden);
  const eNight = recommendedExposure(night);

  // Illuminance falls hard across those three; exposure must rise, and rise
  // strictly, or the three cards cannot all be readable.
  check(eNoon.illuminance.total > eGolden.illuminance.total * 5,
    `noon must be far brighter than golden hour (${eNoon.illuminance.total} vs ${eGolden.illuminance.total})`);
  check(eGolden.illuminance.total > eNight.illuminance.total * 4,
    `golden hour must be far brighter than night (${eGolden.illuminance.total} vs ${eNight.illuminance.total})`);
  check(eNoon.exposure < eGolden.exposure, `exposure must rise from noon to golden hour (${eNoon.exposure} -> ${eGolden.exposure})`);
  check(eGolden.exposure < eNight.exposure, `exposure must rise from golden hour to night (${eGolden.exposure} -> ${eNight.exposure})`);
  // Stated bands. Outside these the frame is either blown or crushed.
  check(eNoon.exposure > 0.74 && eNoon.exposure < 0.90, `noon exposure band 0.74..0.90, got ${eNoon.exposure}`);
  check(eGolden.exposure > 0.95 && eGolden.exposure < 1.22, `golden exposure band 0.95..1.22, got ${eGolden.exposure}`);
  check(eNight.exposure > 1.10 && eNight.exposure <= EXPOSURE_CURVE.max,
    `night exposure band 1.10..${EXPOSURE_CURVE.max}, got ${eNight.exposure}`);
  // Compression: adaptation must never be so strong that night matches day.
  check(eNight.exposure / eNoon.exposure < 2.2,
    `exposure swing must stay compressed, got ${eNight.exposure / eNoon.exposure}`);

  // Exposure is a non-increasing function of illuminance over the whole day.
  const samples = [];
  for (let h = 0; h < 24; h += 0.5) {
    for (const weather of WEATHER_KINDS) {
      const model = computeSkyModel({ hour: h, weather });
      const e = recommendedExposure(model);
      samples.push({ illuminance: e.illuminance.total, exposure: e.exposure });
    }
  }
  samples.sort((a, b) => a.illuminance - b.illuminance);
  for (let i = 1; i < samples.length; i += 1) {
    check(samples[i].exposure <= samples[i - 1].exposure + 1e-9,
      `exposure must not rise with illuminance (${samples[i - 1].illuminance} -> ${samples[i].illuminance})`);
  }

  // Key/fill: the defect this wave is fixing.
  const bNoon = keyFillBalance(noon);
  const bGolden = keyFillBalance(golden);
  const bNight = keyFillBalance(night);
  check(bNoon.measured.ratio < 1.0,
    `the shipped rig must still measure as fill-dominated at noon, got ${bNoon.measured.ratio}`);
  check(bNoon.achieved.ratio > 3.0 && bNoon.achieved.ratio <= TARGET_KEY_FILL.clear + 1e-6,
    `corrected clear-noon key/fill band 3.0..${TARGET_KEY_FILL.clear}, got ${bNoon.achieved.ratio}`);
  check(bGolden.achieved.ratio > 0.5 && bGolden.achieved.ratio < bNoon.achieved.ratio,
    `golden hour must stay directional but below noon, got ${bGolden.achieved.ratio}`);
  check(bNight.gains.key === 1 && bNight.gains.fill === 1,
    'the correction must be inert below the horizon');
  // Total illuminance is preserved, so the exposure curve stays valid.
  for (const balance of [bNoon, bGolden]) {
    const drift = Math.abs(balance.achieved.total - balance.measured.total) / Math.max(1e-9, balance.measured.total);
    check(drift < 0.02, `rebalance must preserve total fill+key within 2%, drifted ${(drift * 100).toFixed(2)}%`);
  }
  // Gains stay inside the declared clamp for every hour and bucket.
  for (let h = 0; h < 24; h += 0.5) {
    for (const weather of WEATHER_KINDS) {
      const balance = keyFillBalance(computeSkyModel({ hour: h, weather }));
      check(balance.gains.key >= Math.min(1, KEY_FILL_GAIN_RANGE.key[0]) - 1e-9
        && balance.gains.key <= KEY_FILL_GAIN_RANGE.key[1] + 1e-9,
      `key gain out of range at ${h} ${weather}: ${balance.gains.key}`);
      check(balance.gains.fill >= KEY_FILL_GAIN_RANGE.fill[0] - 1e-9
        && balance.gains.fill <= 1 + 1e-9,
      `fill gain out of range at ${h} ${weather}: ${balance.gains.fill}`);
      check(balance.apply.environmentIntensity > 0, `environmentIntensity must stay positive at ${h} ${weather}`);
    }
  }
  // Overcast is physically fill-dominated; the target must say so.
  check(TARGET_KEY_FILL.fog < 1.2 && TARGET_KEY_FILL.drizzle < 1.4,
    'overcast buckets must target a near-unity key/fill');
  check(TARGET_KEY_FILL.clear > 3, 'the clear bucket must target a strongly directional key');
});

// ------------------------------------------------------------- sky luminance

await section('sky luminance is ordered across the day and the dome', () => {
  const noon = computeSkyModel({ hour: 12, weather: 'clear' });
  const golden = computeSkyModel({ hour: 18.5, weather: 'clear' });
  const night = computeSkyModel({ hour: 21.5, weather: 'clear' });

  check(noon.horizonLuminance > golden.horizonLuminance,
    `sky must dim from noon to golden hour (${noon.horizonLuminance} -> ${golden.horizonLuminance})`);
  check(golden.horizonLuminance > night.horizonLuminance * 3,
    `sky must dim hard into night (${golden.horizonLuminance} -> ${night.horizonLuminance})`);
  check(night.horizonLuminance > 0,
    'the night sky must carry skyglow, not flat black');
  check(night.horizonLuminance > night.zenithLuminance,
    'night skyglow must sit at the horizon, not overhead');
  // Low sun means warm sun-side sky.
  const warmth = (c) => c[0] / Math.max(1e-9, c[2]);
  check(warmth(golden.sunwardHorizonRadiance) > warmth(noon.sunwardHorizonRadiance) * 2,
    'the sunward horizon must go warm at low sun');
  check(golden.sunwardContrast > noon.sunwardContrast,
    'sun-side/anti-sun contrast must rise as the sun drops');

  // The dome the pass actually draws: bright hazy horizon, dark blue zenith,
  // and a smooth join to the aerial-perspective colour below the horizon.
  const aerial = aerialPerspective({ model: noon, mapSpan: 2000 });
  const at = (elevationDeg) => {
    const r = elevationDeg * Math.PI / 180;
    return skyDomeRadiance(noon, Math.cos(r), Math.sin(r), 0, { hazeColor: aerial.color });
  };
  const zenith = at(90);
  const mid = at(35);
  const horizon = at(1);
  const below = at(-10);
  check(finite([...zenith, ...mid, ...horizon, ...below]), 'dome radiance must be finite everywhere');
  check(lum(horizon) > lum(mid) && lum(mid) > lum(zenith),
    `dome must brighten toward the horizon (${lum(zenith)} / ${lum(mid)} / ${lum(horizon)})`);
  check(zenith[2] > zenith[0] * 3, 'the clear zenith must be blue');
  const joinError = Math.abs(lum(below) - lum(aerial.color)) / Math.max(1e-9, lum(aerial.color));
  check(joinError < 0.10,
    `the dome below the horizon must meet the fog colour within 10%, off by ${(joinError * 100).toFixed(1)}%`);

  for (const weather of WEATHER_KINDS) {
    for (let h = 0; h < 24; h += 1) {
      const model = computeSkyModel({ hour: h, weather });
      const grade = aerialPerspective({ model, mapSpan: 2000 });
      const rgb = skyDomeRadiance(model, 0.4, 0.6, -0.7, { hazeColor: grade.color });
      check(finite(rgb) && rgb.every((v) => v >= 0),
        `dome radiance must be finite and non-negative at ${h}:00 ${weather}: ${rgb}`);
    }
  }
});

// ------------------------------------------------------- aerial perspective

await section('aerial perspective is ordered and scales with the map', () => {
  const spans = [200, 400, 900, 2000, 4000, 12000];
  fogSpanRows = spans.map((mapSpan) => aerialPerspective({ hour: 12, weather: 'clear', mapSpan }));
  for (let i = 0; i < fogSpanRows.length; i += 1) {
    const row = fogSpanRows[i];
    check(finite([row.near, row.far]), `fog pair must be finite at span ${spans[i]}`);
    check(row.near > 0, `fog near must be positive at span ${spans[i]}`);
    check(row.far > row.near, `fog far must exceed near at span ${spans[i]} (${row.near}/${row.far})`);
    if (i > 0) {
      check(row.near >= fogSpanRows[i - 1].near - 1e-6,
        `fog near must not shrink as the map grows (${fogSpanRows[i - 1].near} -> ${row.near})`);
      check(row.far >= fogSpanRows[i - 1].far - 1e-6,
        `fog far must not shrink as the map grows (${fogSpanRows[i - 1].far} -> ${row.far})`);
    }
  }
  // Strictly increasing somewhere in the middle of the range, or "scales with
  // map span" would be satisfied by a constant.
  check(fogSpanRows[4].near > fogSpanRows[1].near, 'fog near must genuinely track map span');
  check(fogSpanRows[4].far > fogSpanRows[1].far, 'fog far must genuinely track map span');

  // The renderer's own rule is still reported, and the graded pair is closer
  // in than it - which is the whole point of the change.
  const canonical = aerialPerspective({ hour: 11, weather: 'clear', mapSpan: 2000 });
  check(canonical.rendererRule.near === 1100 && canonical.rendererRule.far === 3000,
    `the renderer's shipped rule must be reported unchanged, got ${JSON.stringify(canonical.rendererRule)}`);
  check(canonical.near < canonical.rendererRule.near,
    'the graded fog must start closer than the aerial-framing rule it replaces');
  check(canonical.near > 120 && canonical.near < 420,
    `street-scale fog near band 120..420 m, got ${canonical.near}`);

  // Weather ordering: clear sees furthest, fog least, for every hour.
  for (let h = 0; h < 24; h += 1) {
    const clear = aerialPerspective({ hour: h, weather: 'clear', mapSpan: 2000 });
    const drizzle = aerialPerspective({ hour: h, weather: 'drizzle', mapSpan: 2000 });
    const fog = aerialPerspective({ hour: h, weather: 'fog', mapSpan: 2000 });
    check(clear.far > drizzle.far && drizzle.far > fog.far,
      `visibility ordering clear>drizzle>fog must hold at ${h}:00`);
    check(fog.haze.density > clear.haze.density,
      `fog must lay more ground haze than clear at ${h}:00`);
    for (const row of [clear, drizzle, fog]) {
      check(finite([row.near, row.far, row.haze.height, row.haze.density, ...row.color, ...row.haze.color]),
        `aerial parameters must be finite at ${h}:00`);
      check(row.far > row.near, `near<far must hold at ${h}:00 ${row.weather}`);
      check(row.haze.density >= 0 && row.haze.density <= 1, `haze density in 0..1 at ${h}:00 ${row.weather}`);
      check(row.color.every((v) => v >= 0), `fog colour must be non-negative at ${h}:00 ${row.weather}`);
    }
  }

  // Height fog sits in the streets in the morning and burns off by midday.
  check(morningInversion(6.5) > 0.8, 'the inversion must be at full strength at 06:30');
  check(morningInversion(12) === 0, 'the inversion must be gone by midday');
  const morning = aerialPerspective({ hour: 6.5, weather: 'clear', mapSpan: 2000 });
  const midday = aerialPerspective({ hour: 12, weather: 'clear', mapSpan: 2000 });
  check(morning.haze.height > midday.haze.height * 2,
    `morning haze must stand taller in the street (${morning.haze.height} vs ${midday.haze.height})`);
  check(morning.haze.density > midday.haze.density,
    'morning haze must be denser than midday haze');
  check(morning.near < midday.near, 'morning air must be shallower than midday air');
  // ...and it must be a *band*, not a global wash: capped well under the
  // height of the streetwall it is supposed to sit inside.
  check(morning.haze.height < 90, `haze band must stay below the streetwall, got ${morning.haze.height} m`);

  // The fog colour is the sky's, so golden hour is warm and night is not black.
  const goldenFog = aerialPerspective({ hour: 18.5, weather: 'clear', mapSpan: 2000 });
  const nightFog = aerialPerspective({ hour: 21.5, weather: 'clear', mapSpan: 2000 });
  check(goldenFog.color[0] > goldenFog.color[2] * 2, 'golden-hour aerial perspective must be warm');
  check(midday.color[2] > midday.color[0], 'midday aerial perspective must be cool');
  check(lum(nightFog.color) > 0, 'night aerial perspective must carry skyglow rather than black');
  check(nightFog.color[0] > nightFog.color[2], 'night aerial perspective must be warm urban glow');
});

// --------------------------------------------------------- cloud and stars

await section('cloud sheets and star field are sane and deterministic', () => {
  // Coverage means what it says: a monotone, near-linear map onto the fraction
  // of the sheet that is opaque.
  const measured = [];
  for (const coverage of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const sheet = renderCloudSheet({ size: 96, seed: 5, coverage });
    let sum = 0;
    for (let i = 3; i < sheet.data.length; i += 4) sum += sheet.data[i] / 255;
    measured.push(sum / (sheet.data.length / 4));
  }
  check(measured[0] === 0, `coverage 0 must produce an empty sheet, got ${measured[0]}`);
  check(measured[measured.length - 1] > 0.98, `coverage 1 must produce a solid deck, got ${measured[5]}`);
  for (let i = 1; i < measured.length; i += 1) {
    check(measured[i] > measured[i - 1], `coverage must be monotone (${measured[i - 1]} -> ${measured[i]})`);
  }
  check(Math.abs(measured[3] - 0.6) < 0.12, `coverage 0.6 must land near 0.6, got ${measured[3]}`);

  const a = renderCloudSheet({ size: 64, seed: 9, coverage: 0.5 });
  const b = renderCloudSheet({ size: 64, seed: 9, coverage: 0.5 });
  check(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0,
    'the same seed must bake the same sheet');
  const c = renderCloudSheet({ size: 64, seed: 10, coverage: 0.5 });
  check(Buffer.compare(Buffer.from(a.data), Buffer.from(c.data)) !== 0,
    'a different seed must bake a different sheet');
  for (const sheet of [a, c]) {
    for (let i = 0; i < sheet.data.length; i += 1) {
      if (!Number.isFinite(sheet.data[i])) check(false, `cloud sheet byte ${i} is not finite`);
    }
  }
  checks += 1;
  // Tileable: wrapping from the last column back to the first must be no more
  // of a step than any other column-to-column move. Comparing the two edges to
  // zero would be wrong - they are one texel apart, not the same texel - so the
  // test is against the sheet's own interior gradient.
  const size = a.width;
  const alphaAt = (i, j) => a.data[(j * size + i) * 4 + 3];
  let seam = 0;
  let interior = 0;
  for (let j = 0; j < size; j += 1) {
    seam += Math.abs(alphaAt(0, j) - alphaAt(size - 1, j));
    for (let i = 1; i < size; i += 1) interior += Math.abs(alphaAt(i, j) - alphaAt(i - 1, j));
  }
  const seamMean = seam / size;
  const interiorMean = interior / (size * (size - 1));
  check(seamMean <= interiorMean * 3 + 1,
    `cloud sheet must wrap with no step larger than its own gradient: seam ${seamMean.toFixed(1)} vs interior ${interiorMean.toFixed(1)}`);

  // Two decks at different altitudes, which is what parallax needs.
  const profile = cloudProfile({ hour: 12, weather: 'clear' });
  check(profile.layers.length === 2, 'there must be two cloud decks');
  check(profile.layers[0].altitude < profile.layers[1].altitude, 'the decks must sit at different altitudes');
  check(profile.layers[0].seed !== profile.layers[1].seed, 'the decks must not share a seed');
  check(profile.coverage < cloudProfile({ hour: 12, weather: 'fog' }).coverage,
    'a fog bucket must be cloudier than a clear one');
  for (const weather of WEATHER_KINDS) {
    for (let h = 0; h < 24; h += 1) {
      const row = cloudProfile({ hour: h, weather });
      assertNoNaN(row, `cloudProfile(${h},${weather})`);
      check(row.litTint.every((v) => v >= 0) && row.shadeTint.every((v) => v >= 0),
        `cloud tints must be non-negative at ${h}:00 ${weather}`);
      check(lum(row.litTint) >= lum(row.shadeTint),
        `a cloud's lit face must not be darker than its shaded face at ${h}:00 ${weather}`);
    }
  }
  const dayCloud = cloudProfile({ hour: 12, weather: 'clear' });
  const nightCloud = cloudProfile({ hour: 1, weather: 'clear' });
  check(lum(dayCloud.litTint) > lum(nightCloud.litTint) * 5, 'clouds must go dark at night');

  const stars = starField(256, { seed: 3 });
  check(stars.positions.length === 256 * 3, 'star buffer size');
  assertNoNaN(stars.positions, 'starField.positions');
  assertNoNaN(stars.magnitudes, 'starField.magnitudes');
  assertNoNaN(stars.colors, 'starField.colors');
  for (let i = 0; i < stars.count; i += 1) {
    const y = stars.positions[i * 3 + 1];
    check(y > 0, `star ${i} must sit above the horizon, got y=${y}`);
    const r = Math.hypot(stars.positions[i * 3], y, stars.positions[i * 3 + 2]);
    check(Math.abs(r - 1) < 0.05, `star ${i} must sit near the unit sphere, got r=${r}`);
  }
  const repeat = starField(256, { seed: 3 });
  check(stars.positions.every((v, i) => v === repeat.positions[i]), 'star field must be deterministic');
});

// ------------------------------------------------- practicals and wetness

await section('night practicals and wet surfaces respond', () => {
  const night = nightPracticalProfile({ hour: 21.5, weather: 'clear' });
  const noon = nightPracticalProfile({ hour: 12, weather: 'clear' });
  const late = nightPracticalProfile({ hour: 3.5, weather: 'clear' });
  check(night.pool.opacity > 0.1, 'street lamps must pool light at night');
  check(noon.pool.opacity === 0, 'street lamps must pool nothing at midday');
  check(night.windows.occupancy > late.windows.occupancy * 1.5,
    `window occupancy must fall overnight (${night.windows.occupancy} -> ${late.windows.occupancy})`);
  check(noon.windows.occupancy === 0, 'no windows are lit at midday');
  check(night.windows.temperatureRange[0] < 2600 && night.windows.temperatureRange[1] > 5000,
    'window colour temperature must span warm to cool');
  check(night.windows.intensityRange[0] < night.windows.intensityRange[1],
    'window intensity must be a range, not a constant');
  check(night.windows.coolShare > 0 && night.windows.coolShare < 0.7,
    'a minority of lit windows must read cool');
  check(night.shopSpill.opacity > 0 && night.shopSpill.depth > 2,
    'shopfronts must spill light onto the sidewalk');
  check(night.vehicle.tailColor[0] > night.vehicle.tailColor[1] * 4,
    'vehicle tail lights must be red');
  check(night.pool.color[0] > night.pool.color[2] * 2, 'street lamps must read warm');
  const wetNight = nightPracticalProfile({ hour: 21.5, weather: 'drizzle' });
  check(wetNight.pool.opacity > night.pool.opacity, 'wet ground must extend the reach of a practical');
  for (const weather of WEATHER_KINDS) {
    for (let h = 0; h < 24; h += 1) assertNoNaN(nightPracticalProfile({ hour: h, weather }), `practicals(${h},${weather})`);
  }

  // Black-body colours are normalised to unit luminance and ordered warm/cool.
  const warm = blackBodyColor(2400);
  const cool = blackBodyColor(6000);
  check(Math.abs(lum(warm) - 1) < 1e-6 && Math.abs(lum(cool) - 1) < 1e-6,
    'black-body colours must be luminance-normalised');
  check(warm[0] / warm[2] > cool[0] / cool[2] * 3, 'a 2400 K source must be far warmer than a 6000 K one');

  // Wet surfaces: roughness and albedo, not just a tint.
  const dry = wetSurfaceGrade('asphalt', { hour: 12, weather: 'clear' });
  const wet = wetSurfaceGrade('asphalt', { hour: 12, weather: 'drizzle' });
  check(dry.wetness === 0 && wet.wetness === 1, 'drizzle must be the wet bucket');
  check(wet.roughness < dry.roughness * 0.45,
    `wet asphalt must drop roughness legibly (${dry.roughness} -> ${wet.roughness})`);
  check(wet.colorScale < 0.75, `wet asphalt must darken (${wet.colorScale})`);
  check(wet.envMapIntensity > dry.envMapIntensity * 1.5,
    `wet asphalt must reflect more (${dry.envMapIntensity} -> ${wet.envMapIntensity})`);
  check(wet.sheenOpacity > 0.2 && dry.sheenOpacity === 0, 'standing water only appears in the wet bucket');
  const wetFog = wetSurfaceGrade('asphalt', { hour: 12, weather: 'fog' });
  check(wetFog.roughness > wet.roughness && wetFog.roughness < dry.roughness,
    'fog must sit between dry and drizzle');
  for (const cls of ['facade-glass', 'facade-masonry', 'sidewalk', 'foliage', 'chrome']) {
    const g = wetSurfaceGrade(cls, { hour: 12, weather: 'drizzle' });
    check(g.roughness <= g.dryRoughness, `${cls} must not roughen when wet`);
    check(g.colorScale <= 1, `${cls} must not brighten when wet`);
    assertNoNaN(g, `wetSurfaceGrade(${cls})`);
  }
  assert.throws(() => wetSurfaceGrade('not-a-class', { hour: 12 }), 'unknown material class must throw');
  checks += 1;
});

// ------------------------------------------------------------ the built pass

await section('pass builds for every hour and weather bucket, inside budget', () => {
  const city = makeCity();
  for (const weather of WEATHER_KINDS) {
    for (let hour = 0; hour < 24; hour += 1) {
      const ctx = makeContext(city, { hour, weather });
      const runtime = createPassRuntime([skyAtmosphere]);
      const diagnostics = runtime.build(ctx);
      check(diagnostics.errors.length === 0,
        `build must not error at ${hour}:00 ${weather}: ${JSON.stringify(diagnostics.errors)}`);
      check(diagnostics.built.length === 1, `pass must build at ${hour}:00 ${weather}`);
      const detail = diagnostics.built[0].detail;
      check(detail.implemented === true, `pass must report implemented at ${hour}:00 ${weather}`);
      check(detail.pass === SKY_ATMOSPHERE_VERSION, 'diagnostics must be tagged with the pass version');
      check(detail.model === ATMOSPHERE_MODEL_VERSION, 'diagnostics must be tagged with the model version');

      // The diagnostics contract the brief asks for.
      for (const key of ['sun', 'exposure', 'keyFill', 'fog', 'clouds', 'lights', 'contact', 'wet', 'schedule']) {
        check(detail[key] != null, `diagnostics must report ${key} at ${hour}:00 ${weather}`);
      }
      check(detail.schedule.length === 24, 'the schedule must cover all 24 hours');
      check(Number.isFinite(detail.sun.altitudeDeg) && Number.isFinite(detail.sun.azimuthDeg),
        'diagnostics must report measured sun altitude and azimuth');
      assertNoNaN(detail, `diagnostics(${hour},${weather})`);

      // Budget, per build. Counted on the pass's own object, not on the whole
      // root: the fixture's stand-in lamps and cars are not this pass's spend.
      const counts = countGeometry(diagnostics.built[0] && ctx.root.getObjectByName('pass:sky-atmosphere'));
      check(counts.triangles <= SKY_ATMOSPHERE_BUDGET.triangles,
        `triangle budget at ${hour}:00 ${weather}: ${counts.triangles} > ${SKY_ATMOSPHERE_BUDGET.triangles}`);
      check(counts.drawCalls <= SKY_ATMOSPHERE_BUDGET.drawCalls,
        `draw-call budget at ${hour}:00 ${weather}: ${counts.drawCalls} > ${SKY_ATMOSPHERE_BUDGET.drawCalls}`);
      check(detail.budget.textureBytes <= SKY_ATMOSPHERE_BUDGET.textureBytes,
        `texture budget at ${hour}:00 ${weather}: ${detail.budget.textureBytes} > ${SKY_ATMOSPHERE_BUDGET.textureBytes}`);

      // Every vertex attribute the pass generated must be finite.
      ctx.root.getObjectByName('pass:sky-atmosphere').traverse((node) => {
        const geometry = node.geometry;
        if (!geometry) return;
        for (const name of Object.keys(geometry.attributes)) {
          const attribute = geometry.attributes[name];
          for (let i = 0; i < attribute.array.length; i += 1) {
            if (!Number.isFinite(attribute.array[i])) {
              check(false, `${node.name}.${name}[${i}] is not finite at ${hour}:00 ${weather}`);
              return;
            }
          }
        }
        checks += 1;
      });

      // The pass must stay additive: it may not switch off geometry another
      // subsystem owns. The legacy `sky-dome` in particular is left visible on
      // purpose, because the capture harness raycasts against it to detect
      // holes in the world and `Raycaster` skips invisible objects.
      check(detail.suppressedLegacy.length === 0,
        `pass must not hide renderer-owned objects, hid ${JSON.stringify(detail.suppressedLegacy)}`);
      const dome = ctx.root.getObjectByName('sky-atmosphere:dome');
      check(dome != null && dome.renderOrder > -10 && dome.renderOrder < 0,
        `the dome must sort after the legacy sky-dome (-10) and before the world, got ${dome?.renderOrder}`);
      check(dome.material.transparent !== true && dome.material.depthWrite === false,
        'the dome must be opaque with no depth write, or it cannot paint over the legacy dome');

      // Fog was actually applied to the scene the pass was handed.
      check(Math.abs(ctx.scene.fog.near - detail.fog.near) < 1e-6,
        `scene fog near must match the reported plan at ${hour}:00 ${weather}`);
      check(ctx.scene.fog.far > ctx.scene.fog.near, 'applied scene fog must stay ordered');

      if (weather === 'clear' && (hour === 21 || hour === 22)) {
        check(detail.lights.lampPools > 0, `street lamps must pool light at ${hour}:00`);
        check(detail.lights.shopSpills > 0, `shopfronts must spill light at ${hour}:00`);
        check(detail.contact.vehicles > 0, 'parked vehicles must get under-object darkening');
        check(detail.contact.canopies > 0, 'canopies must get under-object darkening');
      }
      if (hour === 12 && weather === 'clear') {
        budgetRows.push({ label: 'clear 12:00', ...counts, textureBytes: detail.budget.textureBytes });
        contactRow = detail.contact;
      }
      if (hour === 21 && weather === 'drizzle') {
        budgetRows.push({ label: 'drizzle 21:00', ...counts, textureBytes: detail.budget.textureBytes });
      }
      if (weather === 'clear') {
        dayRows.push({
          hour,
          sun: detail.sun,
          skyLuminance: detail.sky.horizonLuminance,
          exposure: detail.exposure.recommended,
          illuminance: detail.exposure.illuminance.total,
          keyFill: detail.keyFill,
          fog: detail.fog,
          clouds: detail.clouds.coverage,
          lights: detail.lights,
        });
      }
      if (hour === 21) {
        weatherRows.push({
          weather,
          fog: detail.fog,
          clouds: detail.clouds.coverage,
          wet: detail.wet,
          lights: detail.lights,
        });
      }

      runtime.dispose();
      // Dispose must hand the scene back exactly as it was found.
      check(ctx.scene.fog.near === 330 && ctx.scene.fog.far === 1380,
        `dispose must restore the renderer's fog at ${hour}:00 ${weather}`);
    }
  }
});

await section('build is deterministic and update is cheap', () => {
  const city = makeCity({ buildings: 240, segments: 600 });
  const snapshot = (ctx) => {
    const parts = [];
    ctx.root.getObjectByName('pass:sky-atmosphere').traverse((node) => {
      const geometry = node.geometry;
      if (!geometry) return;
      const position = geometry.getAttribute('position');
      let sum = 0;
      for (let i = 0; i < position.array.length; i += 1) sum += position.array[i] * (i % 7 + 1);
      parts.push(`${node.name}:${position.count}:${sum.toFixed(4)}`);
    });
    return parts.sort().join('|');
  };
  const runOnce = () => {
    const ctx = makeContext(city, { hour: 18.5, weather: 'drizzle' });
    const runtime = createPassRuntime([skyAtmosphere]);
    const diagnostics = runtime.build(ctx);
    const digest = snapshot(ctx);
    const detail = JSON.stringify(diagnostics.built[0].detail);
    runtime.dispose();
    return { digest, detail };
  };
  const first = runOnce();
  const second = runOnce();
  check(first.digest === second.digest, 'two builds of the same city must produce identical geometry');
  check(first.detail === second.detail, 'two builds of the same city must produce identical diagnostics');

  // Repeated builds without an intervening dispose must not leak or throw:
  // the runtime clears its map without disposing, so the pass owns that.
  const ctx = makeContext(city, { hour: 11, weather: 'clear' });
  const runtime = createPassRuntime([skyAtmosphere]);
  runtime.build(ctx);
  assert.doesNotThrow(() => runtime.build(ctx), 'a rebuild without dispose must not throw');
  checks += 1;

  // Per-frame cost: the common path is a handful of writes; the retime path
  // runs once per `hourQuantum`.
  let worst = 0;
  let total = 0;
  const frames = 600;
  for (let i = 0; i < frames; i += 1) {
    ctx.hour = (11 + i * 0.02) % 24;
    ctx.camera.position.set(i * 0.4, 1.65, i * 0.3);
    const started = process.hrtime.bigint();
    runtime.update(ctx, 1 / 60);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    worst = Math.max(worst, ms);
    total += ms;
  }
  // A weather change has to rebake the cloud sheets, not just retint them: a
  // fog deck's opacity on a clear deck's coverage is not fog.
  const wctx = makeContext(city, { hour: 11, weather: 'clear' });
  const wruntime = createPassRuntime([skyAtmosphere]);
  wruntime.build(wctx);
  const lowDeck = wctx.root.getObjectByName('sky-atmosphere:cloud-low');
  const meanAlpha = () => {
    const data = lowDeck.material.map.image.data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i];
    return sum / (data.length / 4) / 255;
  };
  const clearAlpha = meanAlpha();
  wctx.weather = 'fog';
  wctx.hour = 11.9;
  wruntime.update(wctx, 1 / 60);
  const fogAlpha = meanAlpha();
  check(fogAlpha > clearAlpha * 2,
    `switching to fog must rebake a denser deck (${clearAlpha.toFixed(3)} -> ${fogAlpha.toFixed(3)})`);
  check(fogAlpha > 0.85, `a fog deck must be close to solid, got ${fogAlpha.toFixed(3)}`);
  wruntime.dispose();

  runtime.dispose();
  updateCostRow = { frames, mean: total / frames, worst };
  check(total / frames < 1.5, `mean update cost must stay under 1.5 ms, got ${(total / frames).toFixed(3)}`);
  check(worst < 30, `worst-case retime must stay under 30 ms, got ${worst.toFixed(2)}`);
});

await section('sky content survives a degenerate world', () => {
  // No buildings, no segments, no bounds, a camera with a short far plane: the
  // sky still has to be there, and it still has to fit inside the frustum.
  const city = { meta: {}, buildings: [], segments: [] };
  const ctx = makeContext(city, { hour: 21.5, weather: 'clear', legacy: false });
  ctx.camera.far = 1400;
  const runtime = createPassRuntime([skyAtmosphere]);
  const diagnostics = runtime.build(ctx);
  check(diagnostics.errors.length === 0, `degenerate world must build cleanly: ${JSON.stringify(diagnostics.errors)}`);
  const detail = diagnostics.built[0].detail;
  check(detail.implemented === true, 'the sky must build with no city geometry');
  check(detail.contact.footprints === 0, 'no footprints means no contact skirt');
  check(detail.domeRadius < ctx.camera.far,
    `the dome must stay inside the far plane (${detail.domeRadius} vs ${ctx.camera.far})`);
  check(detail.domeRadius > 0, 'the dome must have a radius');
  check(ctx.root.getObjectByName('sky-atmosphere:dome') != null, 'the dome mesh must exist');
  check(ctx.root.getObjectByName('sky-atmosphere:stars') != null, 'the star field must exist');
  runtime.dispose();
});

await section('illuminance model agrees with the light rig it reads', () => {
  for (const weather of WEATHER_KINDS) {
    for (let h = 0; h < 24; h += 0.5) {
      const model = computeSkyModel({ hour: h, weather });
      const illuminance = sceneIlluminance(model);
      check(finite([illuminance.sky, illuminance.key, illuminance.total]),
        `illuminance must be finite at ${h}:00 ${weather}`);
      check(illuminance.key >= 0, `the key can never be negative at ${h}:00 ${weather}`);
      check(illuminance.sky > 0, `the sky always contributes something at ${h}:00 ${weather}`);
      if (model.sun.altitudeDeg <= 0) {
        check(illuminance.key === 0, `there is no direct beam below the horizon at ${h}:00 ${weather}`);
      }
    }
  }
  // Weather transmits less than clear, at every daylight hour.
  for (const h of [9, 11, 12, 15]) {
    const clear = sceneIlluminance(computeSkyModel({ hour: h, weather: 'clear' })).total;
    const fog = sceneIlluminance(computeSkyModel({ hour: h, weather: 'fog' })).total;
    const drizzle = sceneIlluminance(computeSkyModel({ hour: h, weather: 'drizzle' })).total;
    check(clear > fog && fog > drizzle, `illuminance ordering clear>fog>drizzle must hold at ${h}:00`);
  }
});

// -------------------------------------------------------------------- report

const f = (value, width, digits = 2) => String(
  Number.isFinite(value) ? value.toFixed(digits) : 'n/a',
).padStart(width);
const hm = (hour) => `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`;

console.log('');
for (const line of results) console.log(line);

console.log('');
console.log(`sky-atmosphere pass ${SKY_ATMOSPHERE_VERSION} over model ${ATMOSPHERE_MODEL_VERSION}`);
console.log('clear day, 2000 m map span (all values measured from the built pass):');
console.log('  hour   altitude  azimuth  skyLum  illum   exposure  key/fill  ->corrected  fogNear  fogFar  hazeH  hazeD  cloud  pools');
for (const row of dayRows) {
  console.log(`  ${hm(row.hour)}  ${f(row.sun.altitudeDeg, 8)}  ${f(row.sun.azimuthDeg, 7, 1)}  `
    + `${f(row.skyLuminance, 6, 3)}  ${f(row.illuminance, 6, 3)}  ${f(row.exposure, 8, 3)}  `
    + `${f(row.keyFill.measured, 8, 2)}  ${f(row.keyFill.achieved, 11, 2)}  `
    + `${f(row.fog.near, 7, 0)}  ${f(row.fog.far, 6, 0)}  ${f(row.fog.haze.height, 5, 0)}  `
    + `${f(row.fog.haze.density, 5, 2)}  ${f(row.clouds, 5, 2)}  ${String(row.lights.lampPools).padStart(5)}`);
}

console.log('');
console.log('21:00 by weather bucket:');
console.log('  weather   fogNear  fogFar  hazeD  cloud  roughness(dry->wet)  envMapI  puddles  spills');
for (const row of weatherRows) {
  console.log(`  ${row.weather.padEnd(8)}  ${f(row.fog.near, 7, 0)}  ${f(row.fog.far, 6, 0)}  `
    + `${f(row.fog.haze.density, 5, 2)}  ${f(row.clouds, 5, 2)}  `
    + `${f(row.wet.dryRoughness, 8, 2)} -> ${f(row.wet.roughness, 4, 2)}   `
    + `${f(row.wet.envMapIntensity, 6, 2)}  ${String(row.wet.puddles).padStart(7)}  ${String(row.lights.shopSpills).padStart(6)}`);
}

console.log('');
console.log('aerial perspective against map span (clear, 12:00):');
console.log('  span       near     far    depth   renderer rule');
for (const row of fogSpanRows) {
  console.log(`  ${f(row.mapSpan, 6, 0)} m  ${f(row.near, 7, 0)}  ${f(row.far, 6, 0)}  ${f(row.depth, 6, 0)}   `
    + `${f(row.rendererRule.near, 5, 0)}..${f(row.rendererRule.far, 5, 0)}`);
}

console.log('');
console.log('budget (declared: '
  + `${SKY_ATMOSPHERE_BUDGET.triangles} tris, ${SKY_ATMOSPHERE_BUDGET.drawCalls} draws, `
  + `${(SKY_ATMOSPHERE_BUDGET.textureBytes / 1e6).toFixed(2)} MB texture):`);
for (const row of budgetRows) {
  console.log(`  ${row.label.padEnd(14)} ${String(row.triangles).padStart(6)} tris  `
    + `${String(row.drawCalls).padStart(2)} draws  ${(row.textureBytes / 1e6).toFixed(3)} MB`);
}
if (contactRow) {
  console.log(`  contact grounding: ${contactRow.footprints} footprints -> ${contactRow.quads} quads, `
    + `${contactRow.vehicles} vehicles, ${contactRow.canopies} canopies, ${contactRow.skipped} skipped`);
}
if (updateCostRow) {
  console.log(`  update over ${updateCostRow.frames} frames: mean ${updateCostRow.mean.toFixed(3)} ms, `
    + `worst ${updateCostRow.worst.toFixed(2)} ms (a retime once per ${SKY_ATMOSPHERE_BUDGET.hourQuantum} h)`);
}

console.log('');
console.log('what this run does NOT establish: nothing here is visual evidence. It shows the');
console.log('model is ordered, deterministic, finite and inside budget. Whether the frame reads');
console.log('as AAA open-world lighting needs matched captures and human review under');
console.log('Docs/VISUAL_QUALITY_GATE.md.');

console.log('');
console.log(`verify-sky-atmosphere: PASS (${checks} assertions)`);
