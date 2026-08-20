// Self-check for src/render/shadow-casters.js
//
// Runs headless under plain node: no browser, no DOM, no renderer, no capture,
// no new dependency. Exits non-zero on the first failed assertion.
//
//   npm run verify:shadow-casters
//
// What it proves:
//   1. the module's calibration reproduces the MEASURED fit numbers
//   2. the representative object table decides the way the task requires
//   3. the decision is monotone as thickness crosses the texel size
//   4. the crossing point is exactly minThicknessTexels * texelWorldSize
//   5. the policy rescales correctly when the texel size changes
//   6. role hints classify the real mesh names in the current scene
//   7. no name-based role can bypass the thickness gate on plate geometry
//   8. the ring, ground-flush, decal and non-occluder gates fire as designed
//   9. the bias recommendation follows its own stated formula
//  10. every decision is deterministic and free of wall-clock/random input

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as sc from '../../src/render/shadow-casters.js';

const root = resolve(import.meta.dirname, '../..');
const MODULE_PATH = resolve(root, 'src/render/shadow-casters.js');

// The fit numbers measured on the current build, reproduced here so the check
// fails loudly if the renderer's shadow fit moves under this module's feet.
const MEASURED = {
  mapSize: 2048,
  normalBias: 0.2674,
  bias: -0.0002149,
  halfExtent: 219,
  near: 1,
  far: 996.7,
};

let checks = 0;
const failures = [];

function assert(condition, message) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures.push(message);
    console.log(`  FAIL ${message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function near(a, b, tolerance) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

// ---------------------------------------------------------------------------
section('1. calibration reproduces the measured shadow fit');
// ---------------------------------------------------------------------------

const texel = MEASURED.normalBias / 1.25; // the fit uses normalBiasTexels = 1.25
assert(near(texel, sc.MEASURED_TEXEL_WORLD_SIZE, 5e-5),
  `normalBias ${MEASURED.normalBias} / 1.25 = ${texel.toFixed(5)} m/texel `
  + `matches MEASURED_TEXEL_WORLD_SIZE ${sc.MEASURED_TEXEL_WORLD_SIZE}`);

const halfExtent = (MEASURED.mapSize * texel) / 2;
assert(near(halfExtent, MEASURED.halfExtent, 0.1),
  `that texel size implies a +/-${halfExtent.toFixed(2)} m ortho box, `
  + `matching the measured +/-${MEASURED.halfExtent} m`);
assert(near(halfExtent, sc.MEASURED_RING_RADIUS, 0.1),
  `MEASURED_RING_RADIUS ${sc.MEASURED_RING_RADIUS} m is that half-extent`);

const depthRange = (0.5 * texel * 2) / Math.abs(MEASURED.bias);
assert(near(depthRange, MEASURED.far - MEASURED.near, 1),
  `bias ${MEASURED.bias} implies depthRange ${depthRange.toFixed(1)} m, `
  + `matching far-near = ${(MEASURED.far - MEASURED.near).toFixed(1)} m`);

const density = 1 / texel;
assert(density > 4.6 && density < 4.8,
  `real density is ${density.toFixed(3)} texels/m (not the nominal 5.2: the fit `
  + 'adds a one-texel containment margin, so halfExtent > shadowDistance)');

const ctx = sc.resolveShadowCasterContext({ texelWorldSize: texel, ringRadius: halfExtent });
assert(near(ctx.minThickness, 0.3209, 1e-3),
  `thickness floor = ${sc.MIN_THICKNESS_TEXELS} texels = ${ctx.minThickness.toFixed(4)} m`);
assert(ctx.minThickness > 0.14 && ctx.minThickness < 0.35,
  `that floor sits above the 0.14 m awning and at/below the 0.35 m measured `
  + 'cutoff that isolates the 143 thin casters');

// ---------------------------------------------------------------------------
section('2. representative object table');
// ---------------------------------------------------------------------------

const TABLE = [
  {
    label: '14 cm shopfront awning at 3 m',
    descriptor: {
      name: 'awning', parentName: 'shopfront-awnings',
      size: { x: 12, y: 0.14, z: 1.25 }, groundClearance: 2.7, distance: 18,
    },
    expect: false, expectCode: sc.SHADOW_DECISION_CODES.SKIP_SUB_TEXEL,
    expectRole: sc.SHADOW_ROLES.TRIM,
  },
  {
    label: '40 m building',
    descriptor: {
      name: 'building-shell-42', size: { x: 18, y: 40, z: 22 },
      groundClearance: 0, distance: 130,
    },
    expect: true, expectCode: sc.SHADOW_DECISION_CODES.CAST_STRUCTURE,
    expectRole: sc.SHADOW_ROLES.STRUCTURE,
  },
  {
    label: '4.5 m car',
    descriptor: {
      name: 'traffic-car-7', size: { x: 1.85, y: 1.45, z: 4.5 },
      groundClearance: 0.18, distance: 40,
    },
    expect: true, expectCode: sc.SHADOW_DECISION_CODES.CAST_PROP,
    expectRole: sc.SHADOW_ROLES.PROP,
  },
  {
    label: '5 cm overhead cable',
    descriptor: {
      name: 'sf-transit-overhead-cable', size: { x: 0.05, y: 0.05, z: 38 },
      groundClearance: 7.2, distance: 25,
    },
    expect: false, expectCode: sc.SHADOW_DECISION_CODES.SKIP_SUB_TEXEL,
    expectRole: sc.SHADOW_ROLES.TRIM,
  },
  {
    label: '1.8 m person',
    descriptor: {
      name: 'pedestrian-113', size: { x: 0.55, y: 1.8, z: 0.4 },
      groundClearance: 0, distance: 12,
    },
    expect: true, expectCode: sc.SHADOW_DECISION_CODES.CAST_PROP,
    expectRole: sc.SHADOW_ROLES.PROP,
  },
  {
    label: '6 m street tree',
    descriptor: {
      name: 'street-tree-canopy', size: { x: 2.6, y: 6, z: 2.6 },
      groundClearance: 2.1, distance: 30,
    },
    expect: true, expectCode: sc.SHADOW_DECISION_CODES.CAST_PROP,
    expectRole: sc.SHADOW_ROLES.PROP,
  },
];

for (const row of TABLE) {
  const result = sc.shadowCasterDecision(row.descriptor, ctx);
  assert(result.cast === row.expect,
    `${row.label}: cast = ${result.cast} (expected ${row.expect}) `
    + `[${result.thicknessTexels} texels thick]`);
  assert(result.code === row.expectCode,
    `${row.label}: code = ${result.code}`);
  assert(result.role === row.expectRole,
    `${row.label}: role = ${result.role}`);
  assert(typeof result.reason === 'string' && result.reason.length > 20,
    `${row.label}: reason is human-readable ("${result.reason.slice(0, 64)}...")`);
}

assert(sc.shouldCastShadow(TABLE[0].descriptor, ctx) === false,
  'shouldCastShadow() agrees with shadowCasterDecision() on the awning');

// The headline claim: this is the change that removes the night-card bands.
const awningCount = 137;
assert(sc.shadowCasterDecision(TABLE[0].descriptor, ctx).cast === false,
  `all ${awningCount} shopfront awnings leave the caster set (297 -> ~${297 - awningCount})`);

// ---------------------------------------------------------------------------
section('3. monotone in thickness, with the crossing at the texel floor');
// ---------------------------------------------------------------------------

function sweep(context) {
  const seen = [];
  for (let i = 1; i <= 400; i += 1) {
    const thickness = i * 0.005;
    const result = sc.shadowCasterDecision({
      name: 'awning', parentName: 'shopfront-awnings',
      size: { x: 12, y: thickness, z: 1.25 }, groundClearance: 2.7, distance: 18,
    }, context);
    seen.push({ thickness, cast: result.cast, code: result.code });
  }
  return seen;
}

const swept = sweep(ctx);
let flips = 0;
let firstCast = null;
let lastSkip = null;
for (let i = 0; i < swept.length; i += 1) {
  if (swept[i].cast && firstCast === null) firstCast = swept[i].thickness;
  if (!swept[i].cast) lastSkip = swept[i].thickness;
  if (i > 0 && swept[i - 1].cast && !swept[i].cast) flips += 1;
}
assert(flips === 0,
  `sweeping thickness 0.005 -> 2.000 m never turns a caster back off (${flips} regressions)`);
assert(firstCast !== null && lastSkip !== null && lastSkip < firstCast,
  `the decision crosses exactly once: last skip at ${lastSkip} m, first cast at ${firstCast} m`);
assert(near(firstCast, ctx.minThickness, 0.005 + 1e-9),
  `the crossing sits at the ${sc.MIN_THICKNESS_TEXELS}-texel floor `
  + `(${ctx.minThickness.toFixed(4)} m); first cast at ${firstCast} m, one sweep step`);
assert(swept.filter((s) => !s.cast).every((s) => s.code === sc.SHADOW_DECISION_CODES.SKIP_SUB_TEXEL),
  'every exclusion in the sweep is attributed to sub-texel thickness, not another gate');

// ---------------------------------------------------------------------------
section('4. the floor rescales with the texel size, and only with it');
// ---------------------------------------------------------------------------

const halfTexel = sc.resolveShadowCasterContext({ texelWorldSize: texel / 2 });
assert(near(halfTexel.minThickness, ctx.minThickness / 2, 1e-9),
  `halving the texel halves the floor: ${ctx.minThickness.toFixed(4)} -> ${halfTexel.minThickness.toFixed(4)} m`);

const sweptFiner = sweep(halfTexel);
let flipsFiner = 0;
let firstCastFiner = null;
for (let i = 0; i < sweptFiner.length; i += 1) {
  if (sweptFiner[i].cast && firstCastFiner === null) firstCastFiner = sweptFiner[i].thickness;
  if (i > 0 && sweptFiner[i - 1].cast && !sweptFiner[i].cast) flipsFiner += 1;
}
assert(flipsFiner === 0, 'the sweep is still monotone at half the texel size');
assert(firstCastFiner < firstCast,
  `a finer map admits thinner casters: crossing moves ${firstCast} m -> ${firstCastFiner} m`);

// The point at which the awning WOULD become legitimate.
const awningOk = sc.resolveShadowCasterContext({ texelWorldSize: 0.14 / sc.MIN_THICKNESS_TEXELS });
assert(sc.shouldCastShadow(TABLE[0].descriptor, awningOk) === true,
  `the 0.14 m awning only qualifies at ${awningOk.texelWorldSize.toFixed(4)} m texels `
  + `(${awningOk.texelsPerMetre.toFixed(1)}/m) - i.e. 2048 over a ~96 m ring, or 4096 over ~192 m`);
assert(awningOk.texelsPerMetre > 10,
  `that is ${awningOk.texelsPerMetre.toFixed(1)} texels/m, above the fit's declared 12/m ceiling's `
  + 'working band: excluding the awnings is the correct fix, not a workaround');

// A person must survive every texel size the fit can currently produce.
const person = TABLE[4].descriptor;
assert(sc.shouldCastShadow(person, ctx) === true, 'a person casts at the current texel size');
const stillFine = sc.resolveShadowCasterContext({ texelWorldSize: 0.26 });
assert(sc.shouldCastShadow(person, stillFine) === true,
  'a person still casts at 0.26 m texels (3.85/m)');
const coarse = sc.resolveShadowCasterContext({ texelWorldSize: 0.28 });
assert(sc.shouldCastShadow(person, coarse) === false,
  'but stops at 0.28 m texels (3.57/m): the character margin runs out at '
  + `${(0.4 / sc.MIN_THICKNESS_TEXELS).toFixed(4)} m per texel, so do not coarsen past it`);

// ---------------------------------------------------------------------------
section('5. role hints on the real scene names');
// ---------------------------------------------------------------------------

const NAMES = [
  ['shopfront-awnings', sc.SHADOW_ROLES.TRIM],
  ['sky-dome', sc.SHADOW_ROLES.NON_OCCLUDER],
  ['contact-shadows', sc.SHADOW_ROLES.NON_OCCLUDER],
  ['local-light-pool', sc.SHADOW_ROLES.NON_OCCLUDER],
  ['local-night-light-3', sc.SHADOW_ROLES.NON_OCCLUDER],
  ['bay-ripple-cards', sc.SHADOW_ROLES.NON_OCCLUDER],
  ['elevation-contours', sc.SHADOW_ROLES.NON_OCCLUDER],
  ['sf-ground-mission-v1', sc.SHADOW_ROLES.TERRAIN],
  ['sidewalk-props', sc.SHADOW_ROLES.PROP],
  ['street-lamps', sc.SHADOW_ROLES.PROP],
  ['sf-bike-rack-120t', sc.SHADOW_ROLES.PROP],
  ['sf-trash-can-140t', sc.SHADOW_ROLES.PROP],
  ['sf-transit-overhead', sc.SHADOW_ROLES.TRIM],
  ['sf-transit-rails', sc.SHADOW_ROLES.TRIM],
  ['hero-roof-parapets', sc.SHADOW_ROLES.STRUCTURE],
  ['facade-relief-mission-01', sc.SHADOW_ROLES.STRUCTURE],
  ['city-root', sc.SHADOW_ROLES.UNKNOWN],
];
for (const [name, role] of NAMES) {
  assert(sc.classifyShadowRole(name) === role,
    `"${name}" -> ${sc.classifyShadowRole(name)}`);
}
assert(sc.classifyShadowRole('neon-strip', 'building-shell-42') === sc.SHADOW_ROLES.TRIM,
  'a mesh name beats its parent: "neon-strip" under "building-shell-42" is trim, not structure');
assert(sc.classifyShadowRole('panel-7', ['shopfront-awnings', 'city-root']) === sc.SHADOW_ROLES.TRIM,
  'an unnamed child inherits the awning parent\'s trim role');

// ---------------------------------------------------------------------------
section('6. no name can smuggle plate geometry past the thickness gate');
// ---------------------------------------------------------------------------

for (const role of Object.values(sc.SHADOW_ROLES)) {
  const plate = sc.shadowCasterDecision({
    role, size: { x: 12, y: 0.14, z: 1.25 }, groundClearance: 2.7, distance: 18,
  }, ctx);
  assert(plate.cast === false,
    `a 12 x 0.14 x 1.25 m plate declared role "${role}" still does not cast (${plate.code})`);
}
const wall = sc.shadowCasterDecision({
  name: 'building-wall', size: { x: 20, y: 10, z: 0.3 }, distance: 500,
}, ctx);
assert(wall.cast === true && wall.code === sc.SHADOW_DECISION_CODES.CAST_STRUCTURE,
  'but a genuine 20 x 10 x 0.3 m wall keeps its exemption at 1.4 texels and 500 m out '
  + '(the fit extrudes the near plane for exactly this)');
assert(wall.medianDimension >= sc.STRUCTURE_MIN_SPAN,
  `the exemption is keyed on the median dimension (${wall.medianDimension} m), not the max`);

// ---------------------------------------------------------------------------
section('7. the other gates');
// ---------------------------------------------------------------------------

const outOfRing = sc.shadowCasterDecision({
  name: 'traffic-car-9', size: { x: 1.85, y: 1.45, z: 4.5 }, distance: 400,
}, ctx);
assert(outOfRing.cast === false && outOfRing.code === sc.SHADOW_DECISION_CODES.SKIP_OUT_OF_RING,
  `a car 400 m out is outside the ${ctx.ringRadius.toFixed(1)} m ring (${outOfRing.code})`);

const inRing = sc.shadowCasterDecision({
  name: 'traffic-car-9', size: { x: 1.85, y: 1.45, z: 4.5 }, distance: 218,
}, ctx);
assert(inRing.cast === true, 'the same car at 218 m, just inside the ring, casts');

const noDistance = sc.shadowCasterDecision({
  name: 'traffic-car-9', size: { x: 1.85, y: 1.45, z: 4.5 },
}, ctx);
assert(noDistance.cast === true,
  'an unknown distance passes the ring gate rather than guessing');

const marking = sc.shadowCasterDecision({
  name: 'road-marking-crosswalk', size: { x: 3.2, y: 0.01, z: 0.6 }, groundClearance: 0,
}, ctx);
assert(marking.cast === false && marking.code === sc.SHADOW_DECISION_CODES.SKIP_DECAL,
  `road markings never cast (${marking.code})`);

const skyDome = sc.shadowCasterDecision({
  name: 'sky-dome', size: { x: 8000, y: 4000, z: 8000 },
}, ctx);
assert(skyDome.cast === false && skyDome.code === sc.SHADOW_DECISION_CODES.SKIP_NON_OCCLUDER,
  `the sky dome is huge but never an occluder (${skyDome.code})`);

const flush = sc.shadowCasterDecision({
  name: 'utility-plate', size: { x: 9, y: 0.4, z: 0.4 }, groundClearance: 0.0,
}, ctx);
assert(flush.cast === false && flush.code === sc.SHADOW_DECISION_CODES.SKIP_GROUND_FLUSH,
  `a 22:1 slab lying on the ground can only shade what it rests on (${flush.code})`);
const lifted = sc.shadowCasterDecision({
  name: 'utility-plate', size: { x: 9, y: 0.4, z: 0.4 }, groundClearance: 1.2,
}, ctx);
assert(lifted.cast === true, 'lift the same slab to 1.2 m and it casts');

const tiny = sc.shadowCasterDecision({ name: 'stud', size: { x: 0.35, y: 0.36, z: 0.4 } }, ctx);
assert(tiny.cast === false && tiny.code === sc.SHADOW_DECISION_CODES.SKIP_SUB_SPAN,
  `thick enough but only ${tiny.spanTexels} texels across (${tiny.code})`);

const degenerate = sc.shadowCasterDecision({ name: 'empty', size: { x: 0, y: 0, z: 0 } }, ctx);
assert(degenerate.cast === false && degenerate.code === sc.SHADOW_DECISION_CODES.SKIP_DEGENERATE,
  'a degenerate box is refused, not guessed');

assert(sc.shadowCasterDecision({ ...TABLE[0].descriptor, cast: true }, ctx).cast === true,
  'an explicit override wins: the integrator always has the last word');
assert(sc.shadowCasterDecision({ ...TABLE[1].descriptor, cast: false }, ctx).cast === false,
  'and can opt a building out too');

// ---------------------------------------------------------------------------
section('8. the audit histogram');
// ---------------------------------------------------------------------------

const audit = sc.createShadowCasterAudit();
for (let i = 0; i < awningCount; i += 1) {
  audit.record(sc.shadowCasterDecision(TABLE[0].descriptor, ctx), `shopfront-awning-${i}`);
}
for (const row of TABLE.slice(1)) {
  audit.record(sc.shadowCasterDecision(row.descriptor, ctx), row.descriptor.name);
}
assert(audit.total === awningCount + 5, `audit counted ${audit.total} meshes`);
assert(audit.casting === 4 && audit.excluded === awningCount + 1,
  `${audit.casting} cast, ${audit.excluded} excluded`);
const hist = audit.histogram();
const subTexel = hist.find((b) => b.code === sc.SHADOW_DECISION_CODES.SKIP_SUB_TEXEL);
assert(subTexel && subTexel.count === awningCount + 1,
  `histogram attributes ${subTexel?.count} exclusions to sub-texel thickness`);
assert(subTexel.example === 'shopfront-awning-0',
  `and keeps a worked example ("${subTexel.example}")`);
const lines = sc.summariseShadowCasterAudit(audit, 'shadow-caster-policy-1');
assert(lines.split('\n').length === hist.length + 1,
  `the log block is ${hist.length + 1} lines, one header plus one per code`);
assert(lines === sc.summariseShadowCasterAudit(audit, 'shadow-caster-policy-1'),
  'the log block is byte-identical when rendered twice');
console.log(lines.split('\n').map((l) => `       ${l}`).join('\n'));

// ---------------------------------------------------------------------------
section('9. bias recommendation follows its own formula');
// ---------------------------------------------------------------------------

assert(near(sc.normalBiasTexelsForSlope(45), 0.7071, 1e-3),
  `slope formula: 45 deg needs ${sc.normalBiasTexelsForSlope(45).toFixed(4)} texels`);
assert(near(sc.normalBiasTexelsForSlope(60), 1.7321, 1e-3),
  `60 deg needs ${sc.normalBiasTexelsForSlope(60).toFixed(4)} texels`);
assert(near(sc.normalBiasTexelsForSlope(70), 4.0, 0.02),
  `70 deg needs ${sc.normalBiasTexelsForSlope(70).toFixed(4)} texels - it diverges at grazing, `
  + 'which is why normalBias alone can never be the whole answer');

const rec = sc.recommendShadowBias({
  texelWorldSize: texel, depthRange: MEASURED.far - MEASURED.near, mapSize: MEASURED.mapSize,
});
assert(near(rec.normalBias, rec.normalBiasTexels * texel, 1e-4),
  `normalBias ${rec.normalBias} = ${rec.normalBiasTexels} x ${texel.toFixed(5)} m`);
assert(rec.normalBias < MEASURED.normalBias,
  `recommended normalBias ${rec.normalBias} is below the shipped ${MEASURED.normalBias} `
  + `(${(100 * (1 - rec.normalBias / MEASURED.normalBias)).toFixed(1)}% less peter-panning)`);
assert(near(rec.bias, -(rec.depthBiasTexels * texel * 2) / (MEASURED.far - MEASURED.near), 1e-7),
  `bias ${rec.bias} = -2 x ${rec.depthBiasTexels} x texel / depthRange`);
assert(Math.abs(rec.bias) > Math.abs(MEASURED.bias),
  `recommended bias ${rec.bias} is stronger than the shipped ${MEASURED.bias}: `
  + 'the depth term takes over what the normal offset gave up');
assert(near(rec.holdsReceiverSlopeToDeg, 51.33, 0.1),
  `${rec.normalBiasTexels} texels holds receivers to ${rec.holdsReceiverSlopeToDeg} deg off the light`);
assert(near(rec.minCasterThickness, ctx.minThickness, 1e-3),
  `the recommendation reports the matching caster floor ${rec.minCasterThickness} m`);
assert(near(rec.texelWorldSizeForAwning, 0.0933, 1e-3),
  `and states that a 0.14 m awning needs <= ${rec.texelWorldSizeForAwning} m texels to qualify`);
assert(rec.warnings.length === 1 && rec.warnings[0].includes('55 deg'),
  `one honest warning is raised: "${rec.warnings[0].slice(0, 70)}..."`);

const recNoRange = sc.recommendShadowBias({ texelsPerMetre: density });
assert(recNoRange.bias === null && recNoRange.warnings.some((w) => w.includes('depthRange')),
  'without depthRange, bias is null and the reason says so rather than inventing a constant');
assert(near(recNoRange.normalBias, rec.normalBias, 1e-4),
  'texelsPerMetre and texelWorldSize are interchangeable inputs');

const recFine = sc.recommendShadowBias({
  texelWorldSize: texel / 2, depthRange: MEASURED.far - MEASURED.near,
});
assert(near(recFine.normalBias, rec.normalBias / 2, 1e-4),
  `normalBias is linear in texel size: ${rec.normalBias} -> ${recFine.normalBias}`);
assert(near(recFine.bias, rec.bias / 2, 1e-7),
  `so is bias at fixed depthRange: ${rec.bias} -> ${recFine.bias}`);
const recFar = sc.recommendShadowBias({ texelWorldSize: texel, depthRange: 2500 });
assert(Math.abs(recFar.bias) < Math.abs(rec.bias) / 2,
  `and bias goes as 1/depthRange: ${rec.bias} at noon-ish 995 m becomes ${recFar.bias} at `
  + 'golden-hour 2500 m - which is why it must never be a constant');
const recCoarse = sc.recommendShadowBias({ texelWorldSize: 0.35, depthRange: 995.7 });
assert(recCoarse.warnings.some((w) => w.includes('pedestrian')),
  'a coarse map warns that the thickness floor is about to exclude people');

for (const line of rec.rationale) console.log(`       ${line}`);

// ---------------------------------------------------------------------------
section('10. determinism and purity');
// ---------------------------------------------------------------------------

const ALL = [
  ...TABLE.map((r) => r.descriptor),
  { name: 'sky-dome', size: { x: 8000, y: 4000, z: 8000 } },
  { name: 'road-marking-crosswalk', size: { x: 3.2, y: 0.01, z: 0.6 }, groundClearance: 0 },
  { name: 'building-wall', size: { x: 20, y: 10, z: 0.3 }, distance: 500 },
];
const runOnce = () => JSON.stringify(ALL.map((d) => sc.shadowCasterDecision(d, ctx)));
const a = runOnce();
const b = runOnce();
const c = JSON.stringify([...ALL].reverse().map((d) => sc.shadowCasterDecision(d, ctx)).reverse());
assert(a === b, 'the same descriptors produce byte-identical decisions on a second run');
assert(a === c, 'and decision order does not affect any decision (no hidden state)');

const policy = sc.createShadowCasterPolicy({ texelWorldSize: texel, ringRadius: halfExtent });
assert(JSON.stringify(ALL.map((d) => policy.decide(d))) === a,
  'the bound policy closure agrees with the free function');
assert(Object.isFrozen(policy.decide(ALL[0])),
  'decisions are frozen, so a consumer cannot mutate one into a different verdict');

// Strip comments first: the module's header prose deliberately NAMES the
// things it avoids ("no Math.random(), no Date.now()"), so a naive grep over
// the raw file would match its own documentation.
const rawSource = readFileSync(MODULE_PATH, 'utf8');
const source = rawSource
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');
assert(source.length < rawSource.length && source.includes('shadowCasterDecision'),
  `comment-stripped source is ${source.length}/${rawSource.length} bytes and still has the code`);
assert(!/Date\.now|performance\.now|new Date\(/.test(source),
  'the module contains no wall-clock call');
assert(!/Math\.random/.test(source),
  'the module contains no unseeded randomness');
assert(!/ShaderMaterial|onBeforeCompile|three\/addons/.test(source),
  'the module contains no ShaderMaterial, onBeforeCompile or addon import');
assert(!/new THREE\.WebGPURenderer|setAnimationLoop|requestAnimationFrame|document\.createElement/.test(source),
  'the module creates no renderer, loop or canvas');
assert(!/BatchedMesh\(/.test(source),
  'the module constructs no BatchedMesh (WEBGL_multi_draw is not probed here)');

const before = JSON.stringify(ALL);
runOnce();
assert(JSON.stringify(ALL) === before,
  'shadowCasterDecision does not mutate the descriptors it is given');

// ---------------------------------------------------------------------------
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
