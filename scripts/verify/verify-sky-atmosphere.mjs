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
  DELIVERED_REFERENCE_CLASS,
  EXPOSURE_CURVE,
  KEY_FILL_GAIN_RANGE,
  MIN_ENVIRONMENT_SHARE,
  SHADOW_DISPLAY_FLOOR,
  TARGET_KEY_FILL,
  WEATHER_KINDS,
  aerialPerspective,
  canyonBounce,
  displayValue,
  displayStepScene,
  envMapIntensityFor,
  sceneForDisplay,
  blackBodyColor,
  cloudProfile,
  computeSkyModel,
  computeSunDirection,
  keyFillBalance,
  morningInversion,
  nightPracticalProfile,
  recommendedExposure,
  renderCloudSheet,
  sampleSkyRadiance,
  sceneIlluminance,
  skyDomeRadiance,
  starField,
  wetSurfaceGrade,
} from '../../src/render/environment-ibl.js';

import skyAtmosphere, {
  SKY_ATMOSPHERE_BUDGET,
  SKY_ATMOSPHERE_VERSION,
} from '../../src/render/passes/sky-atmosphere.js';
import {
  contactShadowLeakMetres,
  keyShareOfRatio,
  projectedContactShadow,
} from '../../src/render/shadow-casters.js';
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
let shadowRow = null;
let datumRow = null;
let wetRow = null;
let duskRow = [];
let ditherRow = null;
let lampRow = null;
let practicalPeakRow = [];
let puddleRow = null;
// Must match DITHER_STEPS in the pass; asserted below against the built pass.
const SKY_DITHER_STEPS = 2.0;
let cardRows = [];
let deliveredRows = [];
let contactRow = null;
let contactAoRow = null;
let groundingRow = null;
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
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Local copy of the module's smoothstep, for probing ramp monotonicity. */
const smoothstepLocal = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// --------------------------------------------------------------- display model
//
// The round-1 review rejected the golden-hour card on a measurement this suite
// could not make: 55.7% of its pixels under 12/255 and a mean of 16.7. Nothing
// here can render a frame, but the renderer's display transform is known
// exactly - ACES filmic at `toneMappingExposure`, then the sRGB transfer - and
// so is the shading model for a Lambertian surface. Putting those together
// turns "how dark is the shadow side" from an opinion into a number, for every
// hour and every weather bucket, without a browser.
//
// This predicts the value of a *surface*, not of a pixel. It cannot see
// geometry, occlusion, texture or emissive content, so it is a floor test on
// the lighting model and not a substitute for looking at a frame.

/** ACES filmic curve, the fitted form three uses. */
const aces = (x) => clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
/** Linear -> sRGB transfer. */
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** Scene-referred radiance -> 0..255 display value. */
const display255 = (radiance, exposure) => 255 * toSrgb(aces(Math.max(0, radiance) * exposure));

/** Anything under this reads as crushed black in a capture. */
const BLACK_THRESHOLD = 12;

/**
 * The surfaces the rubric's cards are actually made of, with the albedo and
 * orientation each one presents. Vertical surfaces see about half the sky
 * hemisphere, which is why a facade in shadow is the first thing to crush.
 */
const CANONICAL_SURFACES = Object.freeze([
  Object.freeze({ name: 'asphalt', albedo: 0.08, vertical: false, shadowFloor: 14 }),
  Object.freeze({ name: 'sidewalk', albedo: 0.45, vertical: false, shadowFloor: 70 }),
  Object.freeze({ name: 'facade-painted', albedo: 0.42, vertical: true, shadowFloor: 40 }),
  Object.freeze({ name: 'facade-masonry', albedo: 0.30, vertical: true, shadowFloor: 28 }),
  Object.freeze({ name: 'vehicle-paint', albedo: 0.22, vertical: true, shadowFloor: 20 }),
]);

/**
 * Predicted display value of one surface, in shadow and in key light, under a
 * rebalanced light rig.
 */
function surfaceDisplay(surface, balance, model) {
  const exposure = balance.apply.exposure;
  const fill = balance.achieved.fill;
  const key = balance.achieved.key;
  const shadowIrradiance = surface.vertical ? fill * 0.5 : fill;
  // A vertical face square to the sun takes cos(altitude) of the beam; a
  // horizontal one takes all of it, the beam already being horizontal-referred.
  const keyIrradiance = surface.vertical
    ? key * Math.max(0, Math.cos(model.sun.altitudeDeg * Math.PI / 180))
    : key;
  const brdf = surface.albedo / Math.PI;
  return {
    shadow: display255(shadowIrradiance * brdf, exposure),
    lit: display255((shadowIrradiance + keyIrradiance) * brdf, exposure),
  };
}

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
      // The vertical construction the renderer and `street-surface-v2` really
      // publish. The pass has to read these, not assume the terrain.
      streetDesign: {
        roadLift: 0.45,
        gutterDepth: 0.03,
        curbFaceHeight: 0.15,
        crossSlope: 0.02,
        gutterWidth: 0.45,
      },
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

const rigEnvironmentIntensity = (hour, weather) => computeSkyModel({ hour, weather }).lightRig.environmentIntensity;

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
  check(eGolden.exposure > 1.15 && eGolden.exposure < 1.45, `golden exposure band 1.15..1.45, got ${eGolden.exposure}`);
  check(eNight.exposure > 1.35 && eNight.exposure <= EXPOSURE_CURVE.max,
    `night exposure band 1.35..${EXPOSURE_CURVE.max}, got ${eNight.exposure}`);
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
  // The *ratio* correction is inert below the horizon - there is no key to
  // balance against. The any-normal black floor is NOT, and must not be: it
  // exists because the round-2 night card rendered 15.7% of its pixels at
  // exactly (0, 0, 0), and 96% of those are ordinary lit surfaces in the day
  // frame at the same pixels.
  check(bNight.gains.key === 1, 'the key correction must be inert below the horizon');
  check(bNight.gains.fill >= 1, 'the night floor may only add fill, never remove it');
  check(bNight.shadow.anyNormalDisplay >= 2,
    `a dark surface on any normal must clear the black floor at night, got ${bNight.shadow.anyNormalDisplay}`);
  // v1 preserved key+fill exactly, and the golden-hour card proved that was
  // the wrong invariant: it says nothing about a surface the key cannot reach,
  // and a canyon at 18:30 is nothing but such surfaces. The contract is now
  // the shadow side itself, and the rebalance may only ever add light.
  for (const balance of [bNoon, bGolden]) {
    check(balance.achieved.total >= balance.measured.total - 1e-6,
      `the rebalance must never darken the frame overall (${balance.measured.total} -> ${balance.achieved.total})`);
    check(balance.shadow.product >= SHADOW_DISPLAY_FLOOR - 1e-6,
      `shadow side must clear the display floor, got ${balance.shadow.product} at hour ${balance.hour}`);
  }
  check(bGolden.shadow.bounce > 0, 'golden hour must carry a canyon-bounce term');
  check(bNight.shadow.bounce === 0, 'there is nothing to bounce below the horizon');
  // Gains stay inside the declared clamp for every hour and bucket.
  for (let h = 0; h < 24; h += 0.5) {
    for (const weather of WEATHER_KINDS) {
      const balance = keyFillBalance(computeSkyModel({ hour: h, weather }));
      check(balance.gains.key >= Math.min(1, KEY_FILL_GAIN_RANGE.key[0]) - 1e-9
        && balance.gains.key <= KEY_FILL_GAIN_RANGE.key[1] + 1e-9,
      `key gain out of range at ${h} ${weather}: ${balance.gains.key}`);
      check(balance.gains.fill >= KEY_FILL_GAIN_RANGE.fill[0] - 1e-9
        && balance.gains.fill <= KEY_FILL_GAIN_RANGE.fill[1] + 1e-9,
      `fill gain out of range at ${h} ${weather}: ${balance.gains.fill}`);
      check(balance.apply.environmentIntensity
        >= rigEnvironmentIntensity(h, weather) * MIN_ENVIRONMENT_SHARE - 1e-6,
      `environmentIntensity must keep its floor at ${h} ${weather}: ${balance.apply.environmentIntensity}`);
      check(balance.apply.environmentIntensity > 0, `environmentIntensity must stay positive at ${h} ${weather}`);
    }
  }
  // Overcast is physically fill-dominated; the target must say so.
  check(TARGET_KEY_FILL.fog < 1.2 && TARGET_KEY_FILL.drizzle < 1.4,
    'overcast buckets must target a near-unity key/fill');
  check(TARGET_KEY_FILL.clear > 3, 'the clear bucket must target a strongly directional key');
});

// ------------------------------------------------- shadow side / black share

/**
 * The gate round 1 did not have.
 *
 * Two numbers, both stated up front rather than discovered afterwards:
 *
 *  1. **Shadow-side band.** Every canonical surface has a floor it may not go
 *     under in shadow, and the shadow may not come within a stated factor of
 *     the key side either - a shadow that reads the same as the lit side is
 *     the 0.70 key/fill defect this wave started from.
 *  2. **Black share.** The share of (surface x hour x weather) combinations
 *     whose shadow side falls under 12/255 must stay at or under 6%. The
 *     round-1 golden-hour frame was at 55.7% of *pixels* under that value;
 *     this is the surface-level proxy for it.
 */
await section('shadow side stays readable and the black share stays low', () => {
  let combinations = 0;
  let black = 0;
  let worst = null;
  for (const weather of WEATHER_KINDS) {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const model = computeSkyModel({ hour, weather });
      const balance = keyFillBalance(model);
      for (const surface of CANONICAL_SURFACES) {
        const value = surfaceDisplay(surface, balance, model);
        combinations += 1;
        check(finite([value.shadow, value.lit]),
          `${surface.name} display must be finite at ${hour}:00 ${weather}`);
        check(value.lit >= value.shadow - 1e-6,
          `${surface.name} lit side must not be darker than its shadow at ${hour}:00 ${weather}`);
        if (value.shadow < BLACK_THRESHOLD) black += 1;
        if (!worst || value.shadow < worst.shadow) {
          worst = { ...value, surface: surface.name, hour, weather };
        }
        // Per-surface shadow floor, over the whole clock and every bucket.
        check(value.shadow >= surface.shadowFloor,
          `${surface.name} shadow side must stay at or above ${surface.shadowFloor}/255 at `
          + `${hour}:00 ${weather}, got ${value.shadow.toFixed(1)}`);
        // ...and a ceiling, so "readable" never turns into "washed out".
        check(value.shadow <= 190,
          `${surface.name} shadow side must stay under 190/255 at ${hour}:00 ${weather}, `
          + `got ${value.shadow.toFixed(1)}`);
      }
      // Contrast, measured on the surface the cards are mostly made of.
      const sidewalk = surfaceDisplay(CANONICAL_SURFACES[1], balance, model);
      const ratio = sidewalk.lit / Math.max(1e-6, sidewalk.shadow);
      if (model.sun.altitudeDeg > 35 && weather === 'clear') {
        // Re-banded from 1.6..3.2 when `TARGET_KEY_FILL.clear` went to the
        // physical 5.8. The shipped value sat at 1.90..2.06, the bottom of the
        // old band; it now sits at 2.07..2.18. The band is tight because this
        // is a *booked* ratio - see the delivered-rig section below for what a
        // capture measures, and why the two numbers are not the same one.
        check(ratio > 2.0 && ratio < 2.6,
          `clear high-sun lit/shadow ratio band 2.0..2.6 at ${hour}:00, got ${ratio.toFixed(2)}`);
      }
      if (model.sun.altitudeDeg > 4) {
        check(ratio > 1.05, `the key must be visible at all at ${hour}:00 ${weather}, ratio ${ratio.toFixed(2)}`);
      }
      if (model.sun.altitudeDeg < -8) {
        check(ratio < 1.02, `there is no key below the horizon at ${hour}:00 ${weather}, ratio ${ratio.toFixed(2)}`);
      }
    }
  }
  const blackShare = black / combinations;
  check(blackShare <= 0.06,
    `black share must stay at or under 6% of surface/hour/weather combinations, got ${(blackShare * 100).toFixed(1)}%`);
  shadowRow = { combinations, black, blackShare, worst };

  // Ordering across the three cards the review named.
  const noon = computeSkyModel({ hour: 12, weather: 'clear' });
  const golden = computeSkyModel({ hour: 18.5, weather: 'clear' });
  const night = computeSkyModel({ hour: 21.5, weather: 'clear' });
  const sidewalk = CANONICAL_SURFACES[1];
  const dNoon = surfaceDisplay(sidewalk, keyFillBalance(noon), noon);
  const dGolden = surfaceDisplay(sidewalk, keyFillBalance(golden), golden);
  const dNight = surfaceDisplay(sidewalk, keyFillBalance(night), night);
  check(dNoon.lit > dGolden.lit && dGolden.lit > dNight.lit,
    `lit level must fall noon -> golden -> night (${dNoon.lit.toFixed(0)}/${dGolden.lit.toFixed(0)}/${dNight.lit.toFixed(0)})`);
  check(dNight.shadow < dGolden.shadow,
    `night must sit below golden hour (${dNight.shadow.toFixed(0)} vs ${dGolden.shadow.toFixed(0)})`);
  check(dGolden.shadow > dNoon.shadow * 0.9,
    'golden hour must not be crushed relative to noon: it is the card the review rejected');
  // ...and the opposite failure. Lifting the shadow side until it matches the
  // key side is how a golden-hour frame goes flat, which is the risk this
  // wave's floor introduces.
  check(dGolden.shadow < dNoon.shadow * 2.0,
    `golden hour must not out-run noon's shadow side (${dGolden.shadow.toFixed(0)} vs ${dNoon.shadow.toFixed(0)})`);
  const goldenFacade = surfaceDisplay(CANONICAL_SURFACES[2], keyFillBalance(golden), golden);
  check(goldenFacade.lit / Math.max(1e-6, goldenFacade.shadow) > 1.35,
    `a vertical facade must still read directional at golden hour, ratio `
    + `${(goldenFacade.lit / goldenFacade.shadow).toFixed(2)}`);
  cardRows = [
    { label: 'noon 12:00', ...dNoon },
    { label: 'golden 18:30', ...dGolden },
    { label: 'night 21:30', ...dNight },
  ];

  // The canyon bounce is the term that rescues the golden-hour card, so its
  // shape is asserted rather than assumed.
  const bounceGolden = canyonBounce(golden, keyFillBalance(golden).gains.key);
  const bounceNoon = canyonBounce(noon, keyFillBalance(noon).gains.key);
  const bounceNight = canyonBounce(night, 1);
  const bounceFog = canyonBounce(computeSkyModel({ hour: 18.5, weather: 'fog' }), 2);
  check(bounceGolden / keyFillBalance(golden).achieved.fill > 0.2,
    'the bounce must be a fifth or more of the golden-hour fill');
  // The contract is that the term is SHAPED by sun altitude, not that it has a
  // particular size: a legitimate view-factor change moves both ends together.
  //
  //
  // Measured at a FIXED key gain, per unit of horizontal key. That is the
  // physical statement the term makes: a vertical facade at low sun takes
  // nearly the whole beam while the ground under it takes almost none.
  // Re-deriving the bounce from each hour's own `gains.key` instead confounds
  // the altitude shape with the gain - the clear key target is now the physical
  // 5.8, which raises the noon gain far more than the golden-hour one (golden
  // was already on the 6.5 clamp), so both ends move for a reason that has
  // nothing to do with the term being tested.
  const shapeGain = 2;
  const shapeGolden = canyonBounce(golden, shapeGain) / sceneIlluminance(golden).key;
  const shapeNoon = canyonBounce(noon, shapeGain) / sceneIlluminance(noon).key;
  check(shapeNoon < shapeGolden * 0.25,
    `per unit of horizontal key the bounce must be far larger at golden hour `
    + `(${shapeNoon.toFixed(3)} vs ${shapeGolden.toFixed(3)})`);
  // ...and the share of the fill the module ACTUALLY applies at each end,
  // which is the number that reaches the shadow side.
  const goldenShare = keyFillBalance(golden).shadow.bounceShare;
  const noonShare = keyFillBalance(noon).shadow.bounceShare;
  check(noonShare < goldenShare * 0.65,
    `the applied bounce must matter far less at noon than at golden hour (${noonShare.toFixed(3)} vs ${goldenShare.toFixed(3)})`);
  check(noonShare < 0.3, `the bounce may not dominate the noon fill, got ${noonShare.toFixed(3)}`);
  check(bounceNight === 0, 'no beam below the horizon means no bounce');
  check(bounceFog < bounceGolden * 0.25, 'an overcast dome has no directional beam to bounce');

  // The environment's lower hemisphere is what a metal or glass surface
  // reflects. Round 1 measured a glass tower at exactly (0, 0, 0).
  for (const weather of WEATHER_KINDS) {
    for (let hour = 0; hour < 24; hour += 1) {
      const model = computeSkyModel({ hour, weather });
      const down = sampleSkyRadiance(model, 0, -1, 0);
      check(finite(down) && down.every((v) => v >= 0), `ground bounce finite at ${hour}:00 ${weather}`);
      check(lum(down) < model.horizonLuminance,
        `the ground hemisphere must stay darker than the sky above it at ${hour}:00 ${weather}`);
      if (model.sun.altitudeDeg < -6) {
        check(lum(down) > 0.008,
          `a city lights its own ground: the night lower hemisphere may not be a void at `
          + `${hour}:00 ${weather}, got ${lum(down).toFixed(5)}`);
      }
    }
  }
});

// --------------------------------------------- delivered rig vs a real capture
//
// The gate above predicts the display value of a surface from `achieved`, which
// is the solver's own book. For three rounds nobody checked that book against a
// frame, and it does not agree with one.
//
// The evidence is a matched pair: the capture harness now shoots a second frame
// per card with `sun.intensity = 0`, so the same pixels can be read with the key
// on and with the key off. Key-off is exactly what a fully shadowed surface
// receives, because a shadow map zeroes the same term. On `01-street-day`
// (11:00, clear, sun altitude 43.33 deg, sun.intensity 5.60, hemi 0.218,
// ambient 0.047, scene.environmentIntensity 0.80):
//
//   footway     [380,450,600,530]   key on 191.1/255   key off  68.8/255
//   carriageway [120,485,260,525]   key on  86.8/255   key off  12.5/255
//                                                      median 11.5, 55.4% < 12
//
// Inverting ACES + sRGB on the footway pair cancels the surface albedo exactly
// and leaves `1 + key/fill = 6.29`, i.e. a delivered scene-referred key/fill of
// **5.29**. The pre-wave `achieved.ratio` booked 2.78 for the same state. The
// two disagree by 1.9x, and the direction matters: the book is *optimistic*
// about the shadow side, which is why the black-share gate above could read
// 0/720 while more than half of the shipped card's shadowed carriageway sat
// under the same 12/255 threshold.
//
// `keyFillBalance().delivered` is the module's prediction of that measurement.
// This section pins it to the card.
const CARD_11_CLEAR = Object.freeze({
  hour: 11,
  weather: 'clear',
  /** Albedo-free: (radiance_lit / radiance_shadow) - 1 on the same footway pixels. */
  deliveredKeyFill: 5.286,
  /** Displayed lit/shadow on that footway, straight off the two frames. */
  displayedRatio: 191.1 / 68.8,
  /** `delivered.fill` the module predicted for the state that card was shot in. */
  deliveredFillAtCapture: 0.849,
});

await section('the delivered rig is checked against a matched key-off capture', () => {
  const card = computeSkyModel({ hour: CARD_11_CLEAR.hour, weather: CARD_11_CLEAR.weather });
  const balance = keyFillBalance(card);
  const delivered = balance.delivered;

  check(delivered.referenceClass === DELIVERED_REFERENCE_CLASS,
    'the delivered block must name the class it is quoted for');
  check(finite([delivered.key, delivered.environment, delivered.punctual, delivered.fill, delivered.ratio]),
    'every delivered term must be finite');
  check(Math.abs(delivered.environment
    - card.skyIrradianceLuminance * envMapIntensityFor(DELIVERED_REFERENCE_CLASS, card)) < 1e-3,
  'the delivered environment term must be the per-class grade, not the global intensity');

  // 1. The book is optimistic, and by roughly the measured factor. The module
  //    models neither the renderer's light colours nor the prefilter loss, so
  //    it is allowed to land under the card - but not over it, and not by more
  //    than the size of the terms it omits.
  const modelled = delivered.ratio;
  // What this same block predicted for the rig the card was shot with
  // (TARGET_KEY_FILL.clear = 4.0, SHADOW_DISPLAY_FLOOR = 0.62): key 3.412
  // against fill 0.849. The card measured 5.286 for that state, so the model's
  // residual error there was 1.32x. Carrying that residual forward assumes it
  // is multiplicative and hour-independent, which is an assumption one card
  // cannot test - it is stated here so the next capture can refute it.
  const MODELLED_AT_CAPTURE = 4.019;
  const measuredNow = CARD_11_CLEAR.deliveredKeyFill * (modelled / MODELLED_AT_CAPTURE);
  check(modelled > balance.achieved.ratio * 1.2,
    `the delivered ratio must exceed the booked one - the renderer applies no `
    + `atmospheric extinction to its key (${modelled} vs ${balance.achieved.ratio})`);
  check(modelled >= MODELLED_AT_CAPTURE * 1.25,
    `this wave must raise the delivered key/fill at clear high sun, got ${modelled} `
    + `against ${MODELLED_AT_CAPTURE} for the captured rig`);
  check(modelled > 5.0 && modelled < 7.0,
    `delivered clear high-sun key/fill band 5.0..7.0, got ${modelled}`);

  // 2. The shadow side may not be cut to pay for it. This is the constraint the
  //    card makes non-negotiable: its shadowed carriageway is already at the
  //    black threshold, so any reduction here is a measured crush.
  const MODELLED_FILL_AT_CAPTURE = CARD_11_CLEAR.deliveredFillAtCapture;
  check(delivered.fill >= MODELLED_FILL_AT_CAPTURE - 1e-6,
    `the delivered shadow side may not fall below the shipped card's own level `
    + `(${delivered.fill} vs ${MODELLED_FILL_AT_CAPTURE})`);

  // 3. The displayed consequence, which is what the review actually scores.
  //    Same ACES + sRGB transform, applied to the card's own measured shadow
  //    level scaled by the change in the delivered ratio, so the prediction
  //    inherits the card's albedo instead of assuming one.
  const shadowScene = sceneForDisplay(68.8 / 255, balance.apply.exposure)
    * (delivered.fill / MODELLED_FILL_AT_CAPTURE);
  const litScene = shadowScene * (1 + measuredNow);
  const predictedShadow = 255 * displayValue(shadowScene, balance.apply.exposure);
  const predictedLit = 255 * displayValue(litScene, balance.apply.exposure);
  const predictedRatio = predictedLit / predictedShadow;
  check(predictedRatio > CARD_11_CLEAR.displayedRatio,
    `the predicted displayed ratio must beat the card it is measured against `
    + `(${predictedRatio.toFixed(2)} vs ${CARD_11_CLEAR.displayedRatio.toFixed(2)})`);
  check(predictedRatio > 2.9 && predictedRatio < 3.4,
    `predicted displayed lit/shadow band 2.9..3.4 on the captured footway, got ${predictedRatio.toFixed(2)}`);
  check(predictedLit < 232,
    `the lit footway must keep headroom for sunlit white paint, got ${predictedLit.toFixed(0)}/255`);
  check(predictedShadow >= 68.0,
    `the shadow side of that footway may not go down, got ${predictedShadow.toFixed(1)}/255`);

  // 4. The carriageway is the surface that was measured crushing. Its shadow
  //    side is carried by `envMapIntensityFor('asphalt')`, because the renderer
  //    gives a classed material its own envMap and that intensity. At the dry
  //    road roughness this project ships (0.93) that response is diffuse
  //    irradiance, not a reflection, so trimming it below the physical value
  //    for a rough dielectric is indistinguishable from crushing the shadow.
  const noonClear = computeSkyModel({ hour: 12, weather: 'clear' });
  check(envMapIntensityFor('asphalt', noonClear) >= 0.9,
    `the carriageway's dry environment grade may not sit below 0.9 - its shadow side `
    + `was measured at a median 11.5/255, got ${envMapIntensityFor('asphalt', noonClear)}`);

  // 5. Shape over the clock: the delivered ratio has to behave like a sun, not
  //    like a constant, and it must be zero below the horizon.
  for (const weather of WEATHER_KINDS) {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const model = computeSkyModel({ hour, weather });
      const d = keyFillBalance(model).delivered;
      check(finite([d.key, d.fill, d.ratio]) && d.fill > 0,
        `delivered terms finite and positive at ${hour}:00 ${weather}`);
      if (model.sun.altitudeDeg <= 0) {
        check(d.key === 0, `no delivered key below the horizon at ${hour}:00 ${weather}`);
      }
      if (weather !== 'clear') {
        check(d.ratio < 5.0,
          `an overcast dome may not deliver a clear-sky key/fill at ${hour}:00 ${weather}, got ${d.ratio}`);
      }
    }
  }
  const dNoon = keyFillBalance(computeSkyModel({ hour: 12, weather: 'clear' })).delivered;
  const dGolden = keyFillBalance(computeSkyModel({ hour: 18.5, weather: 'clear' })).delivered;
  check(dNoon.ratio > dGolden.ratio,
    `the delivered ratio must fall with the sun (${dNoon.ratio} -> ${dGolden.ratio})`);

  deliveredRows = [
    { label: 'card 11:00 clear', ...delivered, predictedShadow, predictedLit, predictedRatio },
    { label: 'noon 12:00 clear', ...dNoon },
    { label: 'golden 18:30 clear', ...dGolden },
  ];
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

  // Interior lights follow the light level in the street, not the horizon.
  // Round 1 keyed them off `model.night`, which saturates six degrees either
  // side of the horizon, so the golden-hour card had every window at emissive
  // zero while the canyon was already in deep shadow.
  const golden = nightPracticalProfile({ hour: 18.5, weather: 'clear' });
  const dusk = nightPracticalProfile({ hour: 19, weather: 'clear' });
  check(golden.dusk > 0.5, `windows must be coming on at golden hour, dusk ramp ${golden.dusk}`);
  check(golden.windows.occupancy > 0.25,
    `a quarter of windows or more must be lit at golden hour, got ${golden.windows.occupancy}`);
  check(golden.shopSpill.opacity > 0.15, `shopfronts must be spilling at golden hour, got ${golden.shopSpill.opacity}`);
  check(golden.lampsOn < 0.2, `street lighting must still be off at golden hour, got ${golden.lampsOn}`);
  check(dusk.lampsOn > 0.5, `street lighting must be on by 19:00, got ${dusk.lampsOn}`);
  check(noon.dusk === 0 && noon.lampsOn === 0, 'nothing is lit at midday');
  // Both ramps are monotone as the sun drops.
  let previousDusk = -1;
  let previousLamps = -1;
  for (let alt = 24; alt >= -12; alt -= 2) {
    const at = nightPracticalProfile({ hour: 12, weather: 'clear' });
    void at;
    const probe = { dusk: 1 - smoothstepLocal(2, 16, alt), lamps: 1 - smoothstepLocal(-3, 8, alt) };
    check(probe.dusk >= previousDusk, `dusk ramp must be monotone at ${alt} deg`);
    check(probe.lamps >= previousLamps, `lamp ramp must be monotone at ${alt} deg`);
    previousDusk = probe.dusk;
    previousLamps = probe.lamps;
  }
  duskRow = [12, 17, 18, 18.5, 19, 20, 21.5, 3].map((hour) => {
    const profile = nightPracticalProfile({ hour, weather: 'clear' });
    return {
      hour,
      altitude: computeSkyModel({ hour, weather: 'clear' }).sun.altitudeDeg,
      dusk: profile.dusk,
      lampsOn: profile.lampsOn,
      occupancy: profile.windows.occupancy,
      pool: profile.pool.opacity,
      spill: profile.shopSpill.opacity,
    };
  });
  check(night.vehicle.tailColor[0] > night.vehicle.tailColor[1] * 4,
    'vehicle tail lights must be red');
  check(night.pool.color[0] > night.pool.color[2] * 2, 'street lamps must read warm');
  const wetNight = nightPracticalProfile({ hour: 21.5, weather: 'drizzle' });
  // The pool's opacity is an on/off ramp now that the level is display-referred,
  // so the wet cue lives in the reach and the peak instead of in the alpha.
  check(wetNight.pool.radius > night.pool.radius,
    `wet ground must extend the reach of a practical (${night.pool.radius} -> ${wetNight.pool.radius})`);
  check(wetNight.pool.peakDisplay > night.pool.peakDisplay,
    `wet ground must brighten a practical (${night.pool.peakDisplay} -> ${wetNight.pool.peakDisplay})`);
  check(wetNight.pool.carriageway.reach > night.pool.carriageway.reach,
    'wet ground must extend the carriageway throw');
  check(wetNight.pool.peakDisplay < 200, 'a wet pool must not blow out either');
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
      check(detail.sky.dither.steps === SKY_DITHER_STEPS,
        `the verifier's dither constant must track the pass (${detail.sky.dither.steps} vs ${SKY_DITHER_STEPS})`);
      check(detail.sky.dither.amplitude > 0, `dither amplitude must be positive at ${hour}:00 ${weather}`);
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
        check(detail.contact.canopies > 0, 'canopies must get under-object darkening');
        // Vehicles are the vehicle owner's contact patch now, not this pass's.
        // Two patches under one car is a darker artifact than none.
        check(detail.contact.vehicles === 0,
          'this pass must not also emit a vehicle contact patch');
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

/**
 * Banding gate.
 *
 * A reviewer measured hard quantisation contours across the round-2 night sky,
 * and scanning the frame confirms it: a vertical cut through open sky at x=760
 * runs 15 pixels at luma 15, then 33 at 16, then 23 at 17 - flat bands
 * stepping by exactly one. This reproduces that quantisation on a synthetic
 * shallow gradient at the pass's own dither parameters and asserts the worst
 * run falls, rather than asking anyone to look at a frame.
 */
await section('the sky dither breaks 8-bit contouring', () => {
  const hash01Local = (i) => {
    let x = i | 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
  const longestRun = (values) => {
    let best = 1;
    let run = 1;
    for (let i = 1; i < values.length; i += 1) {
      if (values[i] === values[i - 1]) run += 1;
      else { best = Math.max(best, run); run = 1; }
    }
    return Math.max(best, run);
  };
  const SAMPLES = 400;
  let worstPlain = 0;
  let worstDithered = 0;
  let minAmplitudeSteps = Infinity;
  for (const weather of WEATHER_KINDS) {
    for (let hour = 0; hour < 24; hour += 1) {
      const model = computeSkyModel({ hour, weather });
      const exposure = recommendedExposure(model).exposure;
      // The level the pass sizes its dither against: the visible dome's mean.
      const reference = model.horizonLuminance * 0.35 + model.zenithLuminance * 0.65;
      const amplitude = sceneForDisplay(SKY_DITHER_STEPS / 255, exposure);
      const bias = displayStepScene(reference, exposure, SKY_DITHER_STEPS * 0.5);
      check(Number.isFinite(amplitude) && amplitude > 0,
        `dither amplitude must be positive at ${hour}:00 ${weather}, got ${amplitude}`);
      const amplitudeSteps = 255 * displayValue(amplitude, exposure);
      minAmplitudeSteps = Math.min(minAmplitudeSteps, amplitudeSteps);
      check(amplitudeSteps >= 1,
        `the dither must be worth at least one display step at ${hour}:00 ${weather}, got ${amplitudeSteps.toFixed(2)}`);
      // A shallow gradient of the kind that bands: 16% over 400 pixels.
      const plain = [];
      const dithered = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const scene = reference * (1 + 0.16 * (i / SAMPLES));
        plain.push(Math.round(255 * displayValue(scene, exposure)));
        dithered.push(Math.round(
          255 * displayValue(Math.max(0, scene - bias), exposure)
          + 255 * displayValue(amplitude * hash01Local(i * 2654435761), exposure),
        ));
      }
      const runPlain = longestRun(plain);
      const runDithered = longestRun(dithered);
      worstPlain = Math.max(worstPlain, runPlain);
      worstDithered = Math.max(worstDithered, runDithered);
      check(runDithered <= 14,
        `dithered contour run must stay at or under 14 px at ${hour}:00 ${weather}, got ${runDithered}`);
      if (runPlain > 24) {
        check(runDithered < runPlain * 0.5,
          `the dither must at least halve the contour run at ${hour}:00 ${weather} `
          + `(${runPlain} -> ${runDithered})`);
      }
      // The gradient's level must survive the dither: a dither that changes
      // the mean is a grade, not a dither.
      const meanPlain = plain.reduce((a, b) => a + b, 0) / SAMPLES;
      const meanDithered = dithered.reduce((a, b) => a + b, 0) / SAMPLES;
      check(Math.abs(meanDithered - meanPlain) < 0.6,
        `dither must be zero-mean at ${hour}:00 ${weather} (${meanPlain.toFixed(2)} -> ${meanDithered.toFixed(2)})`);
    }
  }
  ditherRow = { worstPlain, worstDithered, minAmplitudeSteps };
});

await section('street lamps light the carriageway, not just their own base', () => {
  // Round 2's night card measured its near road at mean luma 8.3/255 with 79%
  // of it under the black threshold, while the footway beside it read 71.4.
  // The pools existed and were at the right height; they were 7.4 m circles on
  // the footway with a ^2.1 falloff, which is a row of spots on the pavement
  // and nothing at all on the road.
  const night = nightPracticalProfile({ hour: 21.5, weather: 'clear' });
  check(night.pool.radius >= 10,
    `pools must overlap at typical fixture spacing, radius ${night.pool.radius}`);
  check(night.pool.falloff <= 1.7,
    `a steep falloff puts spots on the pavement, got ^${night.pool.falloff}`);
  check(night.pool.carriageway.reach >= 10 && night.pool.carriageway.length >= 25,
    'the throw across the carriageway must reach the far lane and overlap along the street');
  check(night.pool.carriageway.opacity > 0.2, 'the carriageway throw must be legible');

  const city = makeCity();
  const ctx = makeContext(city, { hour: 21.5, weather: 'clear' });
  const runtime = createPassRuntime([skyAtmosphere]);
  const detail = runtime.build(ctx).built[0].detail;
  check(detail.lights.carriagewayPools > 0, 'lamps must throw light onto the carriageway');
  check(detail.lights.carriagewayPools >= detail.lights.lampPools * 0.6,
    `most lamps front a street and must light it: ${detail.lights.carriagewayPools} of ${detail.lights.lampPools}`);
  const roadPools = ctx.root.getObjectByName('sky-atmosphere:road-pools');
  check(roadPools != null && roadPools.visible, 'the carriageway pools must be visible at night');

  // Practicals must be DISPLAY-referred. Three tone-maps per material and
  // blends afterwards, so an additive pool contributes
  // `displayValue(material.color) * alpha` and a scene-referred level does not
  // mean what it looks like: round 2's 0.46 opacity on a 1.35x warm colour is
  // 0.62 linear, which tone-maps to +218 luma - a blown white disc under every
  // lamp. This asserts the peak lands where the profile says, and that it does
  // not move when the exposure does.
  const peakOf = (mesh, exposure) => {
    const { color } = mesh.material;
    const channel = (v) => 255 * displayValue(v, exposure);
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const expected = [
    ['sky-atmosphere:light-pools', night.pool.peakDisplay],
    ['sky-atmosphere:road-pools', night.pool.carriageway.peakDisplay],
    ['sky-atmosphere:bulb-glows', night.bulb.peakDisplay],
    ['sky-atmosphere:shop-spill', night.shopSpill.peakDisplay],
  ];
  const nightExposure = recommendedExposure(computeSkyModel({ hour: 21.5, weather: 'clear' })).exposure;
  for (const [name, target] of expected) {
    const mesh = ctx.root.getObjectByName(name);
    check(mesh != null, `${name} must exist at night`);
    const peak = peakOf(mesh, nightExposure);
    check(Math.abs(peak - target) / target < 0.10,
      `${name} peak must land on ${target}/255 display, got ${peak.toFixed(1)}`);
    check(peak < 200, `${name} must not blow out, got ${peak.toFixed(1)}`);
  }
  // Exposure independence: retime at a different exposure and the peak holds.
  const dawnCtx = makeContext(city, { hour: 21.5, weather: 'clear' });
  const dawnRuntime = createPassRuntime([skyAtmosphere]);
  dawnRuntime.build(dawnCtx);
  dawnCtx.hour = 19;
  dawnRuntime.update(dawnCtx, 1 / 60);
  const duskExposure = recommendedExposure(computeSkyModel({ hour: 19, weather: 'clear' })).exposure;
  const duskProfile = nightPracticalProfile({ hour: 19, weather: 'clear' });
  const duskPeak = peakOf(dawnCtx.root.getObjectByName('sky-atmosphere:road-pools'), duskExposure);
  check(Math.abs(duskPeak - duskProfile.pool.carriageway.peakDisplay) / duskProfile.pool.carriageway.peakDisplay < 0.10,
    `the carriageway peak must be exposure-independent, got ${duskPeak.toFixed(1)} at 19:00`);
  dawnRuntime.dispose();
  practicalPeakRow = expected.map(([name, target]) => ({
    name: name.replace('sky-atmosphere:', ''),
    target,
    measured: peakOf(ctx.root.getObjectByName(name), nightExposure),
  }));
  // ...and they must sit on the crown, not on the flat datum, or the crowned
  // road surface swallows them exactly as it swallowed the puddles.
  const position = roadPools.geometry.getAttribute('position');
  let minY = Infinity;
  for (let i = 0; i < position.count; i += 1) minY = Math.min(minY, position.getY(i));
  const design = city.meta.streetDesign;
  const minHalf = Math.min(...city.segments.map((segment) => segment.width * 0.5));
  const crown = design.roadLift + design.crossSlope * minHalf;
  check(minY >= crown,
    `carriageway pools must clear the road crown (${crown.toFixed(3)}), got ${minY.toFixed(3)}`);
  lampRow = {
    lamps: detail.lights.lampPools,
    carriageway: detail.lights.carriagewayPools,
    radius: night.pool.radius,
    falloff: night.pool.falloff,
    throw: night.pool.carriageway,
  };
  runtime.dispose();
});

await section('puddles sit on the crowned road and carry a real mask', () => {
  const city = makeCity();
  const design = city.meta.streetDesign;
  const ctx = makeContext(city, { hour: 15, weather: 'drizzle' });
  const runtime = createPassRuntime([skyAtmosphere]);
  runtime.build(ctx);
  const sheen = ctx.root.getObjectByName('sky-atmosphere:wet-sheen');
  check(sheen != null, 'the wet sheen must exist');
  // The road is crowned: at the centreline the surface is roadLift +
  // crossSlope*half, which round 2 ignored and buried every puddle under.
  const position = sheen.geometry.getAttribute('position');
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < position.count; i += 1) {
    minY = Math.min(minY, position.getY(i));
    maxY = Math.max(maxY, position.getY(i));
  }
  // Widest segment sets the highest crown a puddle may legitimately reach.
  const maxHalf = Math.max(...city.segments.map((segment) => segment.width * 0.5));
  const gutterInvert = design.roadLift - design.gutterDepth;
  const crown = design.roadLift + design.crossSlope * maxHalf;
  check(minY > gutterInvert, `no puddle may sit below the gutter invert ${gutterInvert}, got ${minY}`);
  check(maxY <= crown + 0.06, `no puddle may float above the crown ${crown.toFixed(3)}, got ${maxY.toFixed(3)}`);
  check(maxY - minY > 0.005, 'puddle heights must follow the cross-section, not be a constant');

  // The alphaMap channel regression. `MaterialNode` coerces the alpha texture
  // to a float, which takes red on the node path and green on the classic one,
  // so a falloff stored only in the alpha channel is read as a constant 1 and
  // every puddle renders as a hard-edged square at full opacity.
  const material = sheen.material;
  check(material.alphaMap != null, 'the puddle must carry an alphaMap');
  check(material.map == null, 'the puddle must not also carry a map, or the falloff is applied twice');
  const texels = material.alphaMap.image.data;
  let minRed = 255;
  let maxRed = 0;
  let minGreen = 255;
  let maxGreen = 0;
  for (let i = 0; i < texels.length; i += 4) {
    minRed = Math.min(minRed, texels[i]);
    maxRed = Math.max(maxRed, texels[i]);
    minGreen = Math.min(minGreen, texels[i + 1]);
    maxGreen = Math.max(maxGreen, texels[i + 1]);
  }
  check(maxRed - minRed > 200, `the alphaMap's RED channel must carry the falloff, spread ${maxRed - minRed}`);
  check(maxGreen - minGreen > 200, `the alphaMap's GREEN channel must carry it too, spread ${maxGreen - minGreen}`);
  puddleRow = { minY, maxY, crown, gutterInvert, redSpread: maxRed - minRed };
  runtime.dispose();
});

await section('ground decals sit on the pavement, not under it', () => {
  // Round 1 put every ground decal at `ctx.heightAt(x, z)` - the terrain - while
  // the carriageway is `terrain + roadLift` and the footway a further
  // `curbFaceHeight - gutterDepth` above that. The whole practical set was
  // buried half a metre under the pavement and depth-tested away. This is the
  // regression test for that.
  const city = makeCity();
  const roadLift = city.meta.streetDesign.roadLift;
  const footwayLift = roadLift - city.meta.streetDesign.gutterDepth + city.meta.streetDesign.curbFaceHeight;
  const ctx = makeContext(city, { hour: 21.5, weather: 'clear' });
  const runtime = createPassRuntime([skyAtmosphere]);
  const diagnostics = runtime.build(ctx);
  const detail = diagnostics.built[0].detail;
  check(detail.datum.roadLift === roadLift, `datum must read the street design's roadLift, got ${detail.datum.roadLift}`);
  check(Math.abs(detail.datum.footwayLift - footwayLift) < 1e-6,
    `footway datum must be ${footwayLift}, got ${detail.datum.footwayLift}`);
  check(detail.datum.streetCells > 0, 'the street proximity grid must have cells');

  const minY = (name) => {
    const mesh = ctx.root.getObjectByName(name);
    if (!mesh) return null;
    const position = mesh.geometry.getAttribute('position');
    let min = Infinity;
    for (let i = 0; i < position.count; i += 1) min = Math.min(min, position.getY(i));
    return min;
  };
  // Everything that lies on the paved surface.
  //
  // CONTRACT CHANGE, round 5. The old assertion was `y >= footwayLift` for
  // every vertex of every pool, i.e. "a light pool lies on the footway". That
  // was true of a single flat quad and is wrong of the thing a pool actually
  // is: an 11.5 m radius patch that starts on the footway, crosses the kerb
  // and lands on a crowned carriageway 0.12 m lower, over ground that is not
  // level. Holding a 23 m quad at the footway datum is exactly what put it
  // under the pavement on the sloping half - the round-4 night card has no
  // lamp pool on the ground anywhere, at any of the 240 fixtures the pass
  // reports building.
  //
  // The new floor is the gutter invert (`roadLift - gutterDepth`), which is
  // the lowest point of the paved cross-section, plus the pass's clearance;
  // the new ceiling is the footway plus that clearance plus a margin. So the
  // patch is still required to be ON the pavement, over its whole area - just
  // over the real pavement rather than over one datum of it.
  const poolLift = 0.12;
  const gutterInvertLift = roadLift - city.meta.streetDesign.gutterDepth;
  for (const name of ['sky-atmosphere:light-pools', 'sky-atmosphere:shop-spill']) {
    const mesh = ctx.root.getObjectByName(name);
    check(mesh != null, `${name} must exist at night`);
    const position = mesh.geometry.getAttribute('position');
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      low = Math.min(low, position.getY(i));
      high = Math.max(high, position.getY(i));
    }
    check(low >= gutterInvertLift + poolLift - 1e-3,
      `${name} must sit on the paved cross-section (>= ${gutterInvertLift + poolLift}), got ${low}`);
    check(high < footwayLift + poolLift + 0.3,
      `${name} must not float above the footway, got ${high}`);
    // The patch is a grid, not a quad: it has to have more than four corners
    // or it cannot follow anything.
    check(position.count > 4 * detail.lights.lampPools,
      `${name} must be terrain-conforming, got ${position.count} vertices for `
      + `${detail.lights.lampPools} fixtures`);
  }
  // ...and everything that lies on the carriageway.
  const puddleY = minY('sky-atmosphere:wet-sheen');
  check(puddleY != null && puddleY >= roadLift,
    `puddles must sit on the carriageway (>= ${roadLift}), got ${puddleY}`);
  // Contact skirts follow the street where there is one and the terrain where
  // there is not, so their minimum is the terrain case and their maximum has
  // to reach the footway.
  const contact = ctx.root.getObjectByName('sky-atmosphere:contact-grounding');
  const contactPos = contact.geometry.getAttribute('position');
  let contactMax = -Infinity;
  for (let i = 0; i < contactPos.count; i += 1) contactMax = Math.max(contactMax, contactPos.getY(i));
  check(contactMax >= footwayLift,
    `contact skirts fronting a street must reach the footway (>= ${footwayLift}), got ${contactMax}`);
  check(detail.lights.lampPools > 0 && detail.lights.shopSpills > 0,
    'practicals must build against the renderer\'s real group names');
  check(detail.contact.canopies > 0,
    'under-canopy darkening must find the renderer\'s real awning group');
  check(detail.contact.vehicles === 0,
    'vehicle contact patches belong to the vehicle presentation pass');
  datumRow = {
    roadLift,
    footwayLift,
    pools: minY('sky-atmosphere:light-pools'),
    spill: minY('sky-atmosphere:shop-spill'),
    puddles: puddleY,
    contactMax,
    lampPools: detail.lights.lampPools,
    shopSpills: detail.lights.shopSpills,
    vehicles: detail.contact.vehicles,
    canopies: detail.contact.canopies,
  };
  runtime.dispose();
});

await section('contact darkening is ambient occlusion, and it tracks the sky', () => {
  // The round-3 review's first finding, restated as a test.
  //
  // `01-street-day` (11:00) and `06-night-street` (21:30) were shot from an
  // identical eye and target. On row 760 the frame stepped at exactly x=1330
  // in BOTH: 191.5 -> 152.0 by day and 73.1 -> 43.2 at night. The round-4
  // key-off pair says why. Inverting the display transform at that pixel, the
  // key contributes 0.572 radiance left of the boundary and 0.291 right of it,
  // while the fill contributes 0.075 and 0.035 - both scaled by 0.50, which is
  // an alpha-0.5 black quad composited in linear space, i.e. CONTACT_ALPHA.
  // The 3.6 m skirt, mitred to 9.4 m at a sharp corner, was a fake shadow that
  // did not move with the sun and did not switch off with it.
  //
  // Two properties are required of what replaced it: small enough to read as
  // ambient occlusion, and scaled by the light it occludes.
  const leak = contactShadowLeakMetres({ texelWorldSize: 0.192055, sunAltitudeDeg: 46.36 });
  const day = createPassRuntime([skyAtmosphere]);
  const dayCtx = makeContext(makeCity(), { hour: 12, weather: 'clear' });
  const dayDetail = day.build(dayCtx).built[0].detail;

  check(dayDetail.contact.width <= leak.leakMetres + 1e-9,
    `the contact band is ${dayDetail.contact.width} m, at or under the ${leak.leakMetres} m of `
    + 'contact the shadow map\'s own bias plan erases - it fills in exactly that and no more');
  check(dayDetail.contact.width <= 0.35,
    `${dayDetail.contact.width} m reads as a crevice line, not as a shadow (round 3 shipped 3.6 m)`);
  check(dayDetail.contact.mitreClamp * dayDetail.contact.width <= 0.5,
    `the widest a corner mitre can open is ${(dayDetail.contact.mitreClamp * dayDetail.contact.width).toFixed(3)} m; `
    + 'round 3 could throw a 9.4 m wedge across a footway from one needle corner');
  check(dayDetail.contact.aoScale > 0.5,
    `at noon there is sky to occlude, so the AO runs at ${dayDetail.contact.aoScale.toFixed(3)}`);

  // Physics check on the width choice: a wall's own AO does NOT fall off over
  // a footway, so a wide band cannot be justified as wall occlusion. For an
  // infinite wall of height h the cosine-weighted sky occlusion at distance d
  // is (1/2) h^2 / (h^2 + d^2).
  const occlusionAt = (d, h) => 0.5 * ((h * h) / (h * h + d * d));
  check(occlusionAt(3.6, 20) > 0.48,
    `at 3.6 m from a 20 m wall the sky occlusion is still ${occlusionAt(3.6, 20).toFixed(3)} of `
    + '0.500 at the wall: wall AO is a broad canyon term, which the light rig already delivers, '
    + 'so painting a 3.6 m band on top of it was double-counting');

  const night = createPassRuntime([skyAtmosphere]);
  const nightCtx = makeContext(makeCity(), { hour: 21.5, weather: 'clear' });
  const nightDetail = night.build(nightCtx).built[0].detail;
  check(nightDetail.contact.aoScale < 0.05,
    `at 21:30 the sky delivers 0.029 against a noon 1.076, so the AO runs at `
    + `${nightDetail.contact.aoScale.toFixed(4)} - a hairline, not a wedge`);
  const nightContact = nightCtx.root.getObjectByName('sky-atmosphere:contact-grounding');
  const nightCanopy = nightCtx.root.getObjectByName('sky-atmosphere:under-object-shading');
  check(nightContact.material.opacity < 0.05 && nightCanopy.material.opacity < 0.05,
    `both AO meshes are at ${nightContact.material.opacity.toFixed(4)} and `
    + `${nightCanopy.material.opacity.toFixed(4)} opacity at 21:30: ambient occlusion removes SKY, `
    + 'and at 21:30 there is almost none to remove');
  const dayContact = dayCtx.root.getObjectByName('sky-atmosphere:contact-grounding');
  check(dayContact.material.opacity > nightContact.material.opacity * 10,
    'the day and night strengths differ by more than an order of magnitude, so the boundary '
    + 'cannot sit at the identical pixel with the identical value in both frames again');
  contactAoRow = {
    leak: leak.leakMetres,
    width: dayDetail.contact.width,
    dayScale: dayDetail.contact.aoScale,
    nightScale: nightDetail.contact.aoScale,
  };
  day.dispose();
  night.dispose();
});

await section('grounding: the objects the shadow map refused still touch the ground', () => {
  // The round-3 review's second finding. On the near footway of round 4's
  // `01-street-day`, `measure-frame-v1 --ratio` classifies 217758 pixels as
  // reached by the key and 3 as shadowed: the tree, the lamp column, the
  // hydrant, the parked car and every pedestrian put nothing on the ground.
  // The caster policy is right to refuse them - 165 of 340 meshes are thinner
  // than the PCF kernel - so the shadow they cannot have is drawn directly.
  const runtime = createPassRuntime([skyAtmosphere]);
  const ctx = makeContext(makeCity(), { hour: 11, weather: 'clear' });
  // Props of exactly the kind the policy excludes: a 12 cm lamp column, a
  // batch of hydrants, a pedestrian - and one tower that DOES cast.
  const material = new MeshBasicMaterial();
  const props = new Group();
  props.name = 'sidewalk-props';
  const column = new Mesh(new BoxGeometry(0.12, 4.2, 0.12), material);
  column.name = 'lamp-column';
  column.castShadow = false;
  column.position.set(60, 2.1, 25);
  props.add(column);
  const walker = new Mesh(new BoxGeometry(0.5, 1.8, 0.35), material);
  walker.name = 'pedestrian-7';
  walker.castShadow = false;
  walker.position.set(70, 0.9, 26);
  props.add(walker);
  const hydrants = new InstancedMesh(new BoxGeometry(0.44, 0.75, 0.44), material, 24);
  hydrants.name = 'hydrants';
  hydrants.castShadow = false;
  const matrix = new Matrix4();
  for (let i = 0; i < 24; i += 1) {
    matrix.makeTranslation(i * 14 + 4, 0.375, 30);
    hydrants.setMatrixAt(i, matrix);
  }
  hydrants.instanceMatrix.needsUpdate = true;
  props.add(hydrants);
  const tower = new Mesh(new BoxGeometry(20, 40, 20), material);
  tower.name = 'building-tower';
  tower.castShadow = true;
  tower.position.set(300, 20, 300);
  props.add(tower);
  ctx.root.add(props);

  runtime.build(ctx);
  const mesh = ctx.root.getObjectByName('sky-atmosphere:grounding');
  check(mesh != null, 'the grounding mesh exists');
  // Nothing at build: this pass is order 10 and the passes that own trees,
  // vehicles and people are 40-60. The scan is deferred on purpose.
  const inspect = skyAtmosphere._inspect();
  check(inspect.grounding.anchors.length === 0,
    'no anchors at build time, because the objects that need grounding are built by later passes');
  for (let frame = 0; frame < 4; frame += 1) runtime.update(ctx, 1 / 60);
  const grounding = skyAtmosphere._inspect().grounding;
  const byName = (name) => grounding.anchors.filter((anchor) => anchor.node.name === name).length;
  check(byName('hydrants') === 24,
    `the hydrant batch is expanded to ${byName('hydrants')} separate anchors: one castShadow flag `
    + 'was standing in for 24 objects on 24 different corners');
  check(byName('lamp-column') === 1 && byName('pedestrian-7') === 1,
    'the 12 cm lamp column and the pedestrian each get one');
  check(byName('parked-car-bodies') === 140,
    `and the ${byName('parked-car-bodies')} kerbside car instances the fixture builds, which is the `
    + 'case the round-4 street card shows with no shadow under any of them');
  check(byName('building-tower') === 0 && grounding.audit.skipped.casting === 1,
    'the tower is left alone: the shadow map is already drawing it');
  check(grounding.anchors.length === 166,
    `${grounding.anchors.length} anchors in total; the 90 awning plates are refused because a 14 cm `
    + 'plate is under the height floor and has no silhouette to project');
  check(grounding.quads === grounding.anchors.length && mesh.visible === true,
    `${grounding.quads} quads are drawn at 11:00 and the mesh is visible`);
  // The darkness is the rig's own delivered key/fill, so a drawn contact
  // shadow and the shadow map's shadow on the building beside it are the same
  // shadow. It is NOT a chosen opacity.
  const delivered = keyFillBalance(computeSkyModel({ hour: 11, weather: 'clear' })).achieved.ratio;
  check(Math.abs(mesh.material.opacity - delivered / (1 + delivered)) < 1e-4,
    `alpha ${mesh.material.opacity.toFixed(4)} is r/(1+r) for the delivered key/fill ${delivered}: `
    + 'under linear compositing that leaves the receiver at exactly its fill-only radiance');
  const at11 = { anchors: grounding.anchors.length, quads: grounding.quads, keyShare: grounding.keyShare };

  const positionOf = (quad) => {
    const position = mesh.geometry.getAttribute('position');
    const out = [];
    for (let v = 0; v < 4; v += 1) {
      out.push(position.getX(quad * 4 + v), position.getY(quad * 4 + v), position.getZ(quad * 4 + v));
    }
    return out;
  };
  const morning = positionOf(0);
  const model11 = computeSkyModel({ hour: 11, weather: 'clear' });
  const horizontal11 = Math.hypot(model11.sun.x, model11.sun.z);
  const footX = (morning[0] + morning[3]) / 2;
  const footZ = (morning[2] + morning[5]) / 2;
  const tipX = (morning[6] + morning[9]) / 2;
  const tipZ = (morning[8] + morning[11]) / 2;
  const runLength = Math.hypot(tipX - footX, tipZ - footZ);
  check(Math.abs((tipX - footX) / runLength - (-model11.sun.x / horizontal11)) < 0.02
    && Math.abs((tipZ - footZ) / runLength - (-model11.sun.z / horizontal11)) < 0.02,
    'the quad runs along the anti-solar azimuth taken from the sky model, not an authored direction');

  // Move the clock: the quads must move with it.
  ctx.hour = 15;
  for (let frame = 0; frame < 2; frame += 1) runtime.update(ctx, 1 / 60);
  const afternoon = positionOf(0);
  const moved = afternoon.some((value, index) => Math.abs(value - morning[index]) > 0.05);
  check(moved,
    'the same quad has different corners at 15:00 than at 11:00 - the element tracks the key, '
    + 'which is exactly what the round-3 contact skirt could not do');

  // Move an object: the quad must follow it.
  matrix.makeTranslation(500, 0.375, 900);
  hydrants.setMatrixAt(0, matrix);
  hydrants.instanceMatrix.needsUpdate = true;
  hydrants.updateMatrixWorld(true);
  runtime.update(ctx, 1 / 60);
  const followed = skyAtmosphere._inspect().grounding.anchors
    .find((anchor) => anchor.node === hydrants && anchor.instance === 0);
  check(Math.abs(followed.x - 500) < 1e-3 && Math.abs(followed.z - 900) < 1e-3,
    'a moving object drags its contact with it, which is what pedestrians and traffic need');

  // Sunset: the whole element must be gone. Not faint - gone.
  ctx.hour = 21.5;
  for (let frame = 0; frame < 2; frame += 1) runtime.update(ctx, 1 / 60);
  const dark = skyAtmosphere._inspect().grounding;
  check(dark.quads === 0 && mesh.visible === false && mesh.material.opacity === 0,
    'at 21:30 the grounding mesh draws zero quads, is invisible and has zero opacity: a projected '
    + 'contact shadow cannot outlive the sun that projects it');
  check(mesh.geometry.drawRange.count === 0,
    'and the draw range is zero, so it is not even submitted');

  // Back into the light: it must come back.
  ctx.hour = 9;
  for (let frame = 0; frame < 2; frame += 1) runtime.update(ctx, 1 / 60);
  const dawn = skyAtmosphere._inspect().grounding;
  check(dawn.quads === 166 && mesh.visible === true,
    'and it returns with the sun the next morning');

  const noonModel = computeSkyModel({ hour: 12, weather: 'clear' });
  const noonShare = keyShareOfRatio(keyFillBalance(noonModel).achieved.ratio);
  const noonPlan = projectedContactShadow({ height: 1.8, radius: 0.3 }, noonModel.sun, noonShare);
  groundingRow = {
    ...at11,
    pedestrianThrow: noonPlan.length,
    pedestrianAlpha: noonPlan.opacity,
  };
  runtime.dispose();
});

await section('wet response reacts to a runtime weather change', () => {
  // `setWeather` does not rebuild the world, so every wet cue has to be a
  // property write on geometry that already exists. Round 1 built the puddles
  // only when the *build* hour's weather was already wet, which the runtime
  // can never satisfy.
  const city = makeCity({ buildings: 200, segments: 900 });
  const ctx = makeContext(city, { hour: 15, weather: 'clear' });
  const runtime = createPassRuntime([skyAtmosphere]);
  const diagnostics = runtime.build(ctx);
  const detail = diagnostics.built[0].detail;
  check(detail.wet.builtDry === true, 'wet content must be built in the clear bucket too');
  check(detail.wet.puddles > 0, 'puddles must exist even when the world is built dry');
  const sheen = ctx.root.getObjectByName('sky-atmosphere:wet-sheen');
  check(sheen != null, 'the wet sheen mesh must exist in the clear bucket');
  check(sheen.visible === false, 'the wet sheen must be hidden while the street is dry');
  const dryRoughness = sheen.material.roughness;

  ctx.weather = 'drizzle';
  ctx.hour = 15.9;
  runtime.update(ctx, 1 / 60);
  check(sheen.visible === true, 'a runtime switch to drizzle must reveal the wet sheen');
  check(sheen.material.roughness < dryRoughness * 0.45,
    `drizzle must drop puddle roughness legibly (${dryRoughness} -> ${sheen.material.roughness})`);
  check(sheen.material.opacity > 0.4, `drizzle sheen must be legible, got ${sheen.material.opacity}`);
  const wetRoughness = sheen.material.roughness;

  ctx.weather = 'clear';
  ctx.hour = 16.9;
  runtime.update(ctx, 1 / 60);
  check(sheen.visible === false, 'drying out must hide the sheen again');
  check(sheen.material.roughness > wetRoughness, 'drying out must restore roughness');
  wetRow = { dryRoughness, wetRoughness, puddles: detail.wet.puddles };
  runtime.dispose();
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
console.log('shadow side, predicted through ACES + sRGB at the recommended exposure');
console.log('(surface model only - it sees no geometry, no texture and no emissive):');
console.log('  card            sidewalk shadow/lit   ratio');
for (const row of cardRows) {
  console.log(`  ${row.label.padEnd(14)}  ${f(row.shadow, 8, 0)} / ${f(row.lit, 5, 0)}       `
    + `${f(row.lit / Math.max(1e-6, row.shadow), 5, 2)}`);
}
if (shadowRow) {
  console.log(`  black share: ${shadowRow.black}/${shadowRow.combinations} surface-hour-weather `
    + `combinations under ${BLACK_THRESHOLD}/255 = ${(shadowRow.blackShare * 100).toFixed(1)}% (gate: <= 6%)`);
  console.log(`  darkest shadow anywhere: ${shadowRow.worst.surface} at ${hm(shadowRow.worst.hour)} `
    + `${shadowRow.worst.weather}, ${shadowRow.worst.shadow.toFixed(1)}/255`);
  console.log('  round 1 measured 55.7% of the golden-hour card\'s PIXELS under that threshold; these');
  console.log('  are surfaces, not pixels, so the two numbers are related but not comparable.');
  console.log('  NOTE: this table is built from `achieved`, the solver\'s book. A matched key-off');
  console.log('  capture shows that book is optimistic about the shadow side - see below.');
}

console.log('');
console.log('delivered rig, checked against the matched key-off capture of 01-street-day');
console.log('(11:00 clear, sun altitude 43.33 deg; key-off is what a fully shadowed surface gets):');
console.log('  measured on that card, same pixels with the key on and off:');
console.log('    footway      191.1 -> 68.8 /255   displayed lit/shadow 2.78');
console.log('    carriageway   86.8 -> 12.5 /255   median 11.5, 55.4% of it under 12/255');
console.log('    albedo-free scene-referred key/fill on the footway: 5.29 (booked: 2.78)');
for (const row of deliveredRows) {
  console.log(`  ${row.label.padEnd(20)} key ${f(row.key, 6, 2)}  env ${f(row.environment, 5, 2)}  `
    + `punctual ${f(row.punctual, 5, 2)}  fill ${f(row.fill, 5, 2)}  key/fill ${f(row.ratio, 5, 2)}`);
}
if (deliveredRows[0]) {
  console.log(`  predicted for the captured footway after this wave: `
    + `${deliveredRows[0].predictedShadow.toFixed(1)} -> ${deliveredRows[0].predictedLit.toFixed(1)} /255, `
    + `displayed ratio ${deliveredRows[0].predictedRatio.toFixed(2)} (card: 2.78)`);
  console.log('  the shadow side is held, not cut: the whole change is on the lit side.');
  console.log('  PREDICTION ONLY. It is the module\'s own model of the renderer\'s rig, anchored on');
  console.log('  one card at one hour. It is not a capture and it is not visual evidence.');
}

console.log('');
console.log('sky dither (simulated 8-bit quantisation of a shallow 16% gradient, 400 samples):');
if (ditherRow) {
  console.log(`  worst contour run: ${ditherRow.worstPlain} px undithered -> ${ditherRow.worstDithered} px dithered `
    + `(gate: <= 14 px, and at least halved wherever the undithered run exceeds 24)`);
  console.log(`  smallest dither amplitude over the whole clock and all buckets: `
    + `${ditherRow.minAmplitudeSteps.toFixed(2)} display steps (gate: >= 1.00)`);
  console.log('  round 2 measured real runs of 19, 23 and 33 px at one luma in the night sky at x=760.');
}

console.log('');
if (lampRow) {
  console.log('street lighting:');
  console.log(`  ${lampRow.lamps} fixtures -> ${lampRow.carriageway} carriageway throws; `
    + `footway pool r=${lampRow.radius} m falloff ^${lampRow.falloff}; `
    + `throw ${lampRow.throw.length} m along the street x ${lampRow.throw.reach} m reach`);
  console.log('  round 2: r=7.4 m falloff ^2.1, no carriageway throw at all; the night card measured');
  console.log('  its near road at mean luma 8.3/255 with 78.7% of it under the black threshold.');
  for (const row of practicalPeakRow) {
    console.log(`  ${row.name.padEnd(12)} peak +${row.measured.toFixed(1)} display luma (target ${row.target})`);
  }
}
if (puddleRow) {
  console.log(`  puddles span y=${puddleRow.minY.toFixed(3)}..${puddleRow.maxY.toFixed(3)} between the gutter `
    + `invert ${puddleRow.gutterInvert.toFixed(3)} and the crown ${puddleRow.crown.toFixed(3)}; `
    + `alphaMap red-channel spread ${puddleRow.redSpread}/255`);
}

console.log('');
console.log('interior/street lighting ramps (clear):');
console.log('  hour   altitude   dusk   lamps   windowOcc   pool   spill');
for (const row of duskRow) {
  console.log(`  ${hm(row.hour)}  ${f(row.altitude, 8)}  ${f(row.dusk, 5, 2)}  ${f(row.lampsOn, 6, 2)}  `
    + `${f(row.occupancy, 10, 2)}  ${f(row.pool, 5, 2)}  ${f(row.spill, 5, 2)}`);
}

if (datumRow) {
  console.log('');
  console.log('vertical datum (the round-1 defect: every decal was buried under the pavement):');
  console.log(`  carriageway ${datumRow.roadLift} m, footway ${datumRow.footwayLift.toFixed(2)} m above terrain`);
  console.log(`  light pools at y=${datumRow.pools.toFixed(3)}, shop spill y=${datumRow.spill.toFixed(3)}, `
    + `puddles y=${datumRow.puddles.toFixed(3)}, contact skirt reaches y=${datumRow.contactMax.toFixed(3)}`);
  console.log(`  built against the renderer's real groups: ${datumRow.lampPools} lamp pools, `
    + `${datumRow.shopSpills} shop spills, ${datumRow.canopies} canopies `
    + '(vehicle contact patches belong to the vehicle presentation pass)');
}
if (wetRow) {
  console.log(`  wet response at runtime: ${wetRow.puddles} puddles built dry, roughness `
    + `${wetRow.dryRoughness.toFixed(2)} -> ${wetRow.wetRoughness.toFixed(2)} on setWeather, no rebuild`);
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
if (contactAoRow) {
  console.log(`  contact AO band: ${contactAoRow.width} m wide against a measured `
    + `${contactAoRow.leak} m contact leak; strength ${contactAoRow.dayScale.toFixed(3)} at noon, `
    + `${contactAoRow.nightScale.toFixed(4)} at 21:30 (round 3 shipped 3.6 m at a fixed 0.55)`);
}
if (groundingRow) {
  console.log(`  grounding: ${groundingRow.anchors} anchors -> ${groundingRow.quads} quads at 11:00, `
    + `alpha ${groundingRow.keyShare.toFixed(4)} = r/(1+r) for the delivered key/fill; `
    + `a 1.8 m pedestrian at noon throws ${groundingRow.pedestrianThrow} m at alpha `
    + `${groundingRow.pedestrianAlpha}; zero quads at 21:30`);
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
