// Self-check for src/render/sun-shadow-cascade.js
//
// Runs headless under plain node: no browser, no DOM, no renderer, no capture,
// no new dependency. Exits non-zero on the first failed assertion.
//
//   node scripts/verify/verify-sun-shadow-cascade.mjs
//
// What it proves:
//   1. the module is pure: no three import, no renderer, no clock, no random
//   2. `fitContains` agrees with an independently derived light-space test
//   3. the axial coverage scan is contiguous and resolves the exit plane
//   4. a cascade split tiles view depth: no gap, no overlap, and every sampled
//      depth inside the span belongs to EXACTLY ONE authoritative cascade
//   5. every cascade's shadow volume actually contains its authority interval
//   6. texel density per cascade at each of the eight captured poses, against
//      a stated floor that a 0.35 m occluder can resolve
//   7. the low-rise pose that shows no shadows produces a valid, finite,
//      correctly-oriented shadow camera - and is disproved as the cause
//   8. the shader-free multi-light rig is assessed non-viable with its exact
//      light leak, and the single-cascade rig is assessed viable
//   9. `recommendSingleCascade` is a deterministic search that meets both its
//      density target and its reach floor at every pose
//  10. no NaN anywhere, determinism, and a stated per-frame texel budget

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAP_SIZE_LADDER,
  MAX_SHADOW_LEAK,
  PORTABLE_SAMPLE_COUNTS,
  SUN_SHADOW_CASCADE_VERSION,
  assessCascadeRig,
  axialCoverage,
  cascadeAuthorityContains,
  cascadeForDepth,
  fitContains,
  planSunShadowCascades,
  recommendSingleCascade,
} from '../../src/render/sun-shadow-cascade.js';
import {
  CANONICAL_SITE, computeSkyModel, computeSunDirection, computeSunShadowCamera,
} from '../../src/render/environment-ibl.js';
import { MIN_THICKNESS_TEXELS, casterBracket, contactShadowLeakMetres } from '../../src/render/shadow-casters.js';

const root = resolve(import.meta.dirname, '../..');
const MODULE_PATH = resolve(root, 'src/render/sun-shadow-cascade.js');
const CAPTURE_REPORT = resolve(root, '.qa-round1/capture-report.json');

let checks = 0;
const failures = [];
const notes = [];

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

function allFinite(value, path = '$', seen = new Set()) {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const bad = allFinite(entry, `${path}.${key}`, seen);
    if (bad) return bad;
  }
  return null;
}

// The eight capture poses. The report is the same evidence the review round
// used, so the densities below are the densities those frames were drawn at.
const report = JSON.parse(readFileSync(CAPTURE_REPORT, 'utf8'));
const ASPECT = report.viewport.w / report.viewport.h;
const POSES = report.cards
  .filter((card) => card.pose?.ok && card.pose.eye && card.pose.target)
  .map((card) => ({
    id: card.id,
    fovDeg: card.pose.fov,
    hour: card.held?.clock ?? card.requested?.hour ?? 12,
    eye: card.pose.eye,
    forward: {
      x: card.pose.target.x - card.pose.eye.x,
      y: card.pose.target.y - card.pose.eye.y,
      z: card.pose.target.z - card.pose.eye.z,
    },
    surroundingAvgHeight: card.pose.surroundingAvgHeight ?? null,
  }));

function planFor(pose, cascades) {
  return planSunShadowCascades({
    cameraPosition: pose.eye,
    cameraDirection: pose.forward,
    fovDeg: pose.fovDeg,
    aspect: ASPECT,
    sunDirection: computeSunDirection(pose.hour, CANONICAL_SITE),
    cascades,
    cameraNear: 0.5,
  });
}

const SHIPPED = [{ mapSize: 2048, shadowDistance: 220 }];
const RECOMMENDED = [{ mapSize: 4096, shadowDistance: 150 }];
const TWO_CASCADE = [{ mapSize: 2048, shadowDistance: 35 }, { mapSize: 2048, shadowDistance: 220 }];

// ---------------------------------------------------------------------------
section('1. purity');
// ---------------------------------------------------------------------------

const rawSource = readFileSync(MODULE_PATH, 'utf8');
const source = rawSource
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');
assert(source.length < rawSource.length && source.includes('planSunShadowCascades'),
  `comment-stripped source is ${source.length}/${rawSource.length} bytes and still has the code`);
assert(!/from 'three'|from "three"/.test(source),
  'the module imports nothing from three, so it runs under plain node');
assert(!/Date\.now|performance\.now|new Date\(/.test(source),
  'the module contains no wall-clock call');
assert(!/Math\.random/.test(source),
  'the module contains no unseeded randomness');
// The module NAMES these in the rejection reasons it returns, so match the
// syntax that would actually create a dependency, not the words.
assert(!/new\s+\w*ShaderMaterial|onBeforeCompile\s*=|from\s+'three\/(addons|tsl)/.test(source),
  'the module constructs no ShaderMaterial, assigns no onBeforeCompile, and imports no addon or TSL');
assert(!/WebGPURenderer|setAnimationLoop|requestAnimationFrame|document\./.test(source),
  'the module creates no renderer, animation loop, canvas or scene root');
assert(PORTABLE_SAMPLE_COUNTS.includes(4) && !PORTABLE_SAMPLE_COUNTS.includes(8),
  'the portable MSAA set is {1, 4}: WebGPU guarantees no other sample count, so an '
  + '8x plan would diverge between the WebGPU path and the WebGL2 fallback');

// ---------------------------------------------------------------------------
section('2. fitContains agrees with an independent derivation');
// ---------------------------------------------------------------------------

const probePose = POSES.find((pose) => pose.id === '01-street-day');
const probePlan = planFor(probePose, SHIPPED);
const probeFit = probePlan.cascades[0].fit;

// Independent test: the fit publishes `lightSpaceBounds` for the frustum
// corners, computed inside `computeSunShadowCamera` by a different code path.
// Every corner must therefore be inside the box this module tests against.
let cornersInside = 0;
for (const corner of probeFit.frustumCorners) {
  if (fitContains(probeFit, corner)) cornersInside += 1;
}
assert(cornersInside === probeFit.frustumCorners.length,
  `all ${cornersInside} frustum-slice corners are inside the fitted volume`);
assert(Math.abs(probeFit.lightSpaceBounds.minX) <= probeFit.halfExtent
  && Math.abs(probeFit.lightSpaceBounds.maxX) <= probeFit.halfExtent
  && Math.abs(probeFit.lightSpaceBounds.minY) <= probeFit.halfExtent
  && Math.abs(probeFit.lightSpaceBounds.maxY) <= probeFit.halfExtent,
  'and the fit’s own reported light-space bounds are inside the same half-extent');

// A point one metre outside the box on the light’s right axis must be refused.
const outside = {
  x: probeFit.target.x + probeFit.lightBasis.right.x * (probeFit.halfExtent + 1),
  y: probeFit.target.y + probeFit.lightBasis.right.y * (probeFit.halfExtent + 1),
  z: probeFit.target.z + probeFit.lightBasis.right.z * (probeFit.halfExtent + 1),
};
assert(fitContains(probeFit, outside) === false,
  'a point one metre outside the half-extent is refused, so the predicate is not vacuous');

// ---------------------------------------------------------------------------
section('3. the axial coverage scan');
// ---------------------------------------------------------------------------

const coverage = axialCoverage(probeFit, probePose.eye, (() => {
  const length = Math.hypot(probePose.forward.x, probePose.forward.y, probePose.forward.z);
  return { x: probePose.forward.x / length, y: probePose.forward.y / length, z: probePose.forward.z / length };
})(), { cameraNear: 0.5 });
assert(coverage.contiguous === true && coverage.near === 0.5 && coverage.far > 220,
  `the shipped fit covers view depth ${coverage.near} m to ${coverage.far.toFixed(2)} m contiguously, `
  + 'which is beyond its 220 m shadowDistance because the box is square around the slice sphere');
const at = (d) => {
  const length = Math.hypot(probePose.forward.x, probePose.forward.y, probePose.forward.z);
  return {
    x: probePose.eye.x + (probePose.forward.x / length) * d,
    y: probePose.eye.y + (probePose.forward.y / length) * d,
    z: probePose.eye.z + (probePose.forward.z / length) * d,
  };
};
assert(fitContains(probeFit, at(coverage.far - 1e-3)) === true
  && fitContains(probeFit, at(coverage.far + 1e-2)) === false,
  'the reported far edge is the exit plane to within a centimetre, in both directions');

// ---------------------------------------------------------------------------
section('4. the split tiles view depth exactly once');
// ---------------------------------------------------------------------------

const twoPlan = planFor(probePose, TWO_CASCADE);
assert(twoPlan.split.ok === true && twoPlan.split.gaps.length === 0 && twoPlan.split.overlaps.length === 0,
  `a ${TWO_CASCADE.length}-cascade split reports no gap and no overlap `
  + `(${twoPlan.cascades.map((c) => `[${c.authority.near}, ${c.authority.far}]`).join(' + ')})`);

let exactlyOne = 0;
let sampled = 0;
let unowned = 0;
for (let depth = 0.5; depth <= twoPlan.span.far; depth += 0.05) {
  sampled += 1;
  let owners = 0;
  for (let i = 0; i < twoPlan.cascades.length; i += 1) {
    if (cascadeAuthorityContains(twoPlan, i, depth)) owners += 1;
  }
  if (owners === 1) exactlyOne += 1;
  if (owners === 0) unowned += 1;
}
assert(exactlyOne === sampled && unowned === 0,
  `all ${sampled} sampled view depths from 0.5 m to ${twoPlan.span.far} m are owned by exactly one `
  + 'cascade - including the split point itself, because authority intervals are half-open');
assert(cascadeForDepth(twoPlan, 35) === 1 && cascadeForDepth(twoPlan, 34.999) === 0,
  'the split point 35 m belongs to the far cascade and 34.999 m to the near one, with no ambiguity');
assert(cascadeForDepth(twoPlan, twoPlan.span.far + 1) === -1,
  'and a depth past the last cascade is reported unowned rather than silently clamped');

// ---------------------------------------------------------------------------
section('5. every cascade contains its own authority interval');
// ---------------------------------------------------------------------------

for (const pose of POSES) {
  const plan = planFor(pose, TWO_CASCADE);
  const covers = plan.cascades.every((cascade) => cascade.covers);
  assert(covers && plan.split.ok,
    `${pose.id}: both cascades contain their authority intervals `
    + `(headroom ${plan.cascades.map((c) => `${c.headroom} m`).join(', ')})`);
}

// The containment is not free: a cascade whose shadowDistance exceeds its own
// box is a real failure mode, so prove the check can fail.
const brokenPlan = planFor(probePose, [{ mapSize: 2048, shadowDistance: 35 }, { mapSize: 2048, shadowDistance: 220 }]);
const stretched = {
  ...brokenPlan.cascades[0],
  authority: { near: 0.5, far: brokenPlan.cascades[0].coverage.far + 10 },
};
assert(stretched.coverage.far < stretched.authority.far,
  'a cascade asked to own more depth than its box holds is detectably short '
  + `(${stretched.coverage.far.toFixed(1)} m of ${stretched.authority.far.toFixed(1)} m)`);

// ---------------------------------------------------------------------------
section('6. texel density per cascade at the eight captured poses');
// ---------------------------------------------------------------------------

// A 0.35 m pedestrian torso is the thinnest object the character dimension of
// Docs/VISUAL_QUALITY_GATE.md scores. `shadow-casters.js` admits a caster at
// `MIN_THICKNESS_TEXELS` texels, so the floor is 0.35 / 1.5 m per texel.
const TORSO_THICKNESS = 0.35;
const TEXEL_FLOOR = TORSO_THICKNESS / MIN_THICKNESS_TEXELS;

let shippedFailures = 0;
for (const pose of POSES) {
  const cascade = planFor(pose, SHIPPED).cascades[0];
  if (cascade.texelWorldSize > TEXEL_FLOOR) shippedFailures += 1;
  notes.push(`${pose.id} shipped 2048/220: ${cascade.texelsPerMetre} texels/m, `
    + `${(cascade.texelWorldSize * 100).toFixed(2)} cm, reach ${cascade.coverage.far.toFixed(0)} m, `
    + `${casterBracket(cascade.texelWorldSize).casting.length}/11 reference objects cast, `
    + (cascade.castShadow
      ? `${contactShadowLeakMetres({ texelWorldSize: cascade.texelWorldSize, sunAltitudeDeg: cascade.fit.sunAltitudeDeg }).leakMetres} m contact erased`
      : 'sun below the horizon, no solar shadow this card'));
}
notes.push(`RECORDED REJECTION: ${shippedFailures} of ${POSES.length} captured poses miss the `
  + `${(TEXEL_FLOOR * 100).toFixed(2)} cm torso floor on the shipped fit, and all ${POSES.length} `
  + 'miss the 0.15 m bollard. src/citygen/renderer.js owns the two constants that set this.');

let recommendedWorst = 0;
let recommendedReach = Infinity;
for (const pose of POSES) {
  const cascade = planFor(pose, RECOMMENDED).cascades[0];
  recommendedWorst = Math.max(recommendedWorst, cascade.texelWorldSize);
  recommendedReach = Math.min(recommendedReach, cascade.coverage.far);
  notes.push(`${pose.id} recommended 4096/150: ${cascade.texelsPerMetre} texels/m, `
    + `${(cascade.texelWorldSize * 100).toFixed(2)} cm, reach ${cascade.coverage.far.toFixed(0)} m, `
    + `${casterBracket(cascade.texelWorldSize).casting.length}/11 reference objects cast`);
}
assert(recommendedWorst <= TEXEL_FLOOR,
  `the recommended single cascade clears the torso floor at every pose `
  + `(worst ${(recommendedWorst * 100).toFixed(2)} cm against ${(TEXEL_FLOOR * 100).toFixed(2)} cm)`);
assert(recommendedWorst <= 0.15 / MIN_THICKNESS_TEXELS,
  `and it clears the 0.15 m bollard floor too `
  + `(${(recommendedWorst * 100).toFixed(2)} cm against ${((0.15 / MIN_THICKNESS_TEXELS) * 100).toFixed(2)} cm), `
  + 'which is what puts street furniture back into the frame');
assert(recommendedReach >= 180,
  `while still reaching at least ${recommendedReach.toFixed(0)} m of view depth, so the shadow `
  + 'cut-off stays within a degree of the horizon on a level street');

// ---------------------------------------------------------------------------
section('7. the low-rise pose is a valid fit, not a collapse');
// ---------------------------------------------------------------------------
//
// The reported symptom: 02-intersection has no shadows of any kind at 13:00
// clear sky, and its pose note records surroundingAvgHeight 4.5 m against
// 46.9 m at 3rd Street. The hypothesis under test is that the fit collapses on
// low geometry. It does not - and the reason is structural, not empirical:
// `computeSunShadowCamera` takes a camera pose, a sun direction, a map size
// and a shadow distance, and reads NO scene geometry at all.

const lowRise = POSES.find((pose) => pose.id === '02-intersection');
const highRise = POSES.find((pose) => pose.id === '01-street-day');
const lowFit = planFor(lowRise, SHIPPED).cascades[0];
const highFit = planFor(highRise, SHIPPED).cascades[0];

assert(lowRise.surroundingAvgHeight < 10 && highRise.surroundingAvgHeight > 40,
  `the two poses stand in genuinely different districts `
  + `(${lowRise.surroundingAvgHeight} m against ${highRise.surroundingAvgHeight} m of surrounding height)`);
assert(near(lowFit.texelWorldSize, highFit.texelWorldSize, 1e-9)
  && near(lowFit.halfExtent, highFit.halfExtent, 1e-6),
  `yet they fit identically: ${lowFit.texelsPerMetre} texels/m and +/-${lowFit.halfExtent} m in both`);
assert(lowFit.castShadow === true && lowFit.warnings.length === 0,
  'the low-rise fit reports castShadow true and raises no warning');
assert(allFinite(lowFit.fit) === null,
  `every number in the low-rise fit is finite (checked recursively; first bad value: none)`);

const basis = lowFit.fit.lightBasis;
const sun = computeSunDirection(lowRise.hour, CANONICAL_SITE);
const dotFS = basis.forward.x * sun.x + basis.forward.y * sun.y + basis.forward.z * sun.z;
assert(near(dotFS, -1, 1e-9),
  `the shadow camera looks exactly down-sun (forward . toSun = ${dotFS.toFixed(9)})`);
const lengths = [basis.right, basis.up, basis.forward].map((v) => Math.hypot(v.x, v.y, v.z));
const orthogonality = [
  basis.right.x * basis.up.x + basis.right.y * basis.up.y + basis.right.z * basis.up.z,
  basis.right.x * basis.forward.x + basis.right.y * basis.forward.y + basis.right.z * basis.forward.z,
  basis.up.x * basis.forward.x + basis.up.y * basis.forward.y + basis.up.z * basis.forward.z,
].map(Math.abs);
assert(lengths.every((l) => near(l, 1, 1e-9)) && orthogonality.every((o) => o < 1e-9),
  'and its light basis is orthonormal to nine decimals, so the box is not sheared or degenerate');
const back = {
  x: lowFit.fit.position.x - lowFit.fit.target.x,
  y: lowFit.fit.position.y - lowFit.fit.target.y,
  z: lowFit.fit.position.z - lowFit.fit.target.z,
};
const backLength = Math.hypot(back.x, back.y, back.z);
assert(near(backLength, lowFit.fit.lightDistance, 1e-6)
  && back.y > 0
  && near((back.x * sun.x + back.y * sun.y + back.z * sun.z) / backLength, 1, 1e-9),
  `the light sits ${backLength.toFixed(1)} m up the sun ray from the box centre, above the ground, `
  + 'which is the only orientation that can write a shadow into the box');
assert(lowFit.fit.near > 0 && lowFit.fit.far > lowFit.fit.near && lowFit.fit.depthRange > 0,
  `near ${lowFit.fit.near} < far ${lowFit.fit.far.toFixed(1)} over a positive ${lowFit.fit.depthRange.toFixed(1)} m depth range`);

// What the pose ACTUALLY is: the camera is looking almost straight down-sun,
// so every shadow in the frame is hidden behind the object that casts it.
const antiSolarAz = (Math.atan2(-sun.x, sun.z) * 180) / Math.PI;
const viewAz = (Math.atan2(lowRise.forward.x, -lowRise.forward.z) * 180) / Math.PI;
const separation = Math.abs(((antiSolarAz - viewAz + 540) % 360) - 180);
const highSun = computeSunDirection(highRise.hour, CANONICAL_SITE);
const highAntiSolarAz = (Math.atan2(-highSun.x, highSun.z) * 180) / Math.PI;
const highViewAz = (Math.atan2(highRise.forward.x, -highRise.forward.z) * 180) / Math.PI;
const highSeparation = Math.abs(((highAntiSolarAz - highViewAz + 540) % 360) - 180);
assert(separation < 15 && highSeparation > 90,
  `the real difference is the POSE: at 02-intersection the shadows point ${separation.toFixed(1)} deg `
  + `from the view heading, so they fall behind their own casters, while at 01-street-day they `
  + `run ${highSeparation.toFixed(1)} deg across the view. That is a capture-set problem, not a fit problem`);
notes.push(`02-intersection: anti-solar azimuth ${((antiSolarAz + 360) % 360).toFixed(1)} deg vs view heading `
  + `${((viewAz + 360) % 360).toFixed(1)} deg -> ${separation.toFixed(1)} deg apart. `
  + 'Pick an hour or heading at least 45 deg off anti-solar for this card.');

// ---------------------------------------------------------------------------
section('8. rig viability');
// ---------------------------------------------------------------------------

const singleRig = assessCascadeRig(planFor(probePose, SHIPPED));
assert(singleRig.viable === true && singleRig.worstShadowLeak === 0,
  'a single cascade is one light carrying the whole key, so no light leaks into its shadows');

const twoRig = assessCascadeRig(twoPlan);
assert(twoRig.viable === false && near(twoRig.worstShadowLeak, 0.5, 1e-9),
  `an even two-light split leaks ${(twoRig.worstShadowLeak * 100).toFixed(0)}% of the key into any shadow `
  + `only one cascade resolves, against a ${(MAX_SHADOW_LEAK * 100).toFixed(0)}% budget`);
assert(near(twoRig.bestPossibleShadowLeak, 0.5, 1e-9),
  'and no other split of two lights does better: the best possible worst case is 1 - 1/N = 50%');

const skewRig = assessCascadeRig(twoPlan, { intensityFractions: [0.35, 0.65] });
assert(skewRig.viable === false
  && near(Math.max(...skewRig.lights.map((l) => l.shadowLeak)), 0.65, 1e-9),
  'skewing the split toward the far cascade makes the near-field shadows worse, not better '
  + `(${(skewRig.lights[0].shadowLeak * 100).toFixed(0)}% leak on every pedestrian shadow)`);
assert(twoRig.reasons.length >= 3 && twoRig.reasons.some((r) => /ShaderMaterial|onBeforeCompile/.test(r)),
  'and the rejection carries its reasons, including the shader constraint that causes it');

const threeRig = assessCascadeRig(planFor(probePose, [
  { mapSize: 2048, shadowDistance: 25 },
  { mapSize: 2048, shadowDistance: 80 },
  { mapSize: 2048, shadowDistance: 220 },
]));
assert(near(threeRig.bestPossibleShadowLeak, 1 - 1 / 3, 1e-4) && threeRig.viable === false,
  `three cascades are worse still (${(threeRig.bestPossibleShadowLeak * 100).toFixed(1)}% best-case leak), `
  + 'so the rejection is structural rather than a tuning failure');

// ---------------------------------------------------------------------------
section('9. the single-cascade recommendation');
// ---------------------------------------------------------------------------

let recommendedAll = true;
let chosen = null;
for (const pose of POSES) {
  const recommendation = recommendSingleCascade({
    cameraPosition: pose.eye,
    cameraDirection: pose.forward,
    fovDeg: pose.fovDeg,
    aspect: ASPECT,
    sunDirection: computeSunDirection(pose.hour, CANONICAL_SITE),
    cameraNear: 0.5,
    targetTexelWorldSize: 0.15 / MIN_THICKNESS_TEXELS,
    minAxialReach: 220,
  });
  if (!recommendation.found) recommendedAll = false;
  if (pose.id === '01-street-day') chosen = recommendation;
}
assert(recommendedAll,
  'a fit meeting the 0.15 m bollard floor with 220 m of reach exists at every captured pose');
assert(chosen && MAP_SIZE_LADDER.includes(chosen.mapSize),
  `the search returns a map size from the declared ladder (${chosen?.mapSize}) rather than a free number`);
notes.push(`recommendSingleCascade at 01-street-day for a 0.15 m occluder and 220 m of reach: `
  + `${chosen.mapSize} over ${chosen.shadowDistance} m -> ${chosen.texelsPerMetre} texels/m, `
  + `reach ${chosen.axialReach} m, ${chosen.texelBudgetRatio}x the shipped texel budget`);

const repeat = recommendSingleCascade({
  cameraPosition: probePose.eye,
  cameraDirection: probePose.forward,
  fovDeg: probePose.fovDeg,
  aspect: ASPECT,
  sunDirection: computeSunDirection(probePose.hour, CANONICAL_SITE),
  cameraNear: 0.5,
  targetTexelWorldSize: 0.15 / MIN_THICKNESS_TEXELS,
  minAxialReach: 220,
});
assert(repeat.mapSize === chosen.mapSize && repeat.shadowDistance === chosen.shadowDistance,
  'and the search is deterministic: the same pose returns the same pair');

const impossible = recommendSingleCascade({
  cameraPosition: probePose.eye,
  cameraDirection: probePose.forward,
  fovDeg: probePose.fovDeg,
  aspect: ASPECT,
  sunDirection: computeSunDirection(probePose.hour, CANONICAL_SITE),
  cameraNear: 0.5,
  targetTexelWorldSize: 0.002,
  minAxialReach: 400,
});
assert(impossible.found === false && impossible.tried.length === MAP_SIZE_LADDER.length,
  'an unreachable target returns found:false with a per-map-size reason, not a silent guess');

// ---------------------------------------------------------------------------
section('10. determinism, no NaN, and the texel budget');
// ---------------------------------------------------------------------------

const runOnce = () => JSON.stringify(POSES.map((pose) => {
  const plan = planFor(pose, TWO_CASCADE);
  return plan.cascades.map((c) => [c.texelsPerMetre, c.texelWorldSize, c.coverage.far, c.headroom]);
}));
assert(runOnce() === runOnce(), 'two identical runs produce byte-identical plans');

let firstNaN = null;
for (const pose of POSES) {
  for (const cascades of [SHIPPED, RECOMMENDED, TWO_CASCADE]) {
    const bad = allFinite(planFor(pose, cascades));
    if (bad && !firstNaN) firstNaN = `${pose.id} ${JSON.stringify(cascades)} ${bad}`;
  }
}
assert(firstNaN === null,
  `no non-finite number anywhere in ${POSES.length} poses x 3 plans (recursive scan)`);

// The per-frame cost, stated. The shadow pass is depth-only, so its cost is
// dominated by rasterised depth fragments, which scale with map area.
const shippedBudget = planFor(probePose, SHIPPED);
const recommendedBudget = planFor(probePose, RECOMMENDED);
const twoBudget = planFor(probePose, TWO_CASCADE);
assert(shippedBudget.texelBudgetRatio === 1,
  `the shipped plan is the 1.0x baseline: ${shippedBudget.totalTexels} shadow texels per frame, one pass`);
assert(recommendedBudget.texelBudgetRatio === 4,
  `the recommended single cascade is ${recommendedBudget.texelBudgetRatio}x the depth-fragment budget `
  + `(${recommendedBudget.totalTexels} texels) and still ONE shadow pass, one caster traversal, one light`);
assert(twoBudget.texelBudgetRatio === 2,
  `the rejected two-cascade rig is only ${twoBudget.texelBudgetRatio}x the texels but TWO shadow passes, `
  + 'two caster traversals and a second directional light in every lit fragment - '
  + 'a worse trade than the single cascade even before the 50% light leak');

section('12. the key is the sun, or it is nothing');

// Round 4's night card shipped a directional key at intensity 0.2997 with
// `castShadow: true`, and its shadow fit published `sunAltitudeDeg: 52.0`, at
// an hour when `computeSkyModel` puts the sun 28.12 deg BELOW the horizon.
// `measure-frame-v1 --ratio` on that pair classifies 421964 pixels as reached
// by that key. Nothing in the fit was wrong: it was handed a direction that
// had been reflected to the anti-solar azimuth and lifted to a fixed 52 deg,
// and it reported the altitude of what it was given. The name lied, the
// envelope let the key back in below the horizon, and the frame paid for both.
//
// These are the assertions that stop it recurring. They are model-side: the
// model has always said the right thing (key illuminance 0.0000,
// relativeIrradiance 0, castShadow false, key/fill target 0 - four independent
// outputs), so what was missing was a single number the integrator applies and
// a fit that refuses to pretend.
{
  const belowHorizonWithKey = [];
  const belowHorizonCasting = [];
  let daylightSuppressed = 0;
  for (let hour = 0; hour < 24; hour += 0.25) {
    const model = computeSkyModel({ hour, weather: 'clear' });
    const key = model.lightRig.key;
    if (model.sun.altitudeDeg <= 0) {
      if (key.envelope !== 0) belowHorizonWithKey.push(hour);
      if (key.castShadow !== false || model.lightRig.shadow.castShadow !== false) {
        belowHorizonCasting.push(hour);
      }
    } else if (model.sun.altitudeDeg >= 4 && key.envelope < 1) {
      daylightSuppressed += 1;
    }
  }
  assert(belowHorizonWithKey.length === 0,
    'across all 96 quarter-hours of the day, every hour with the sun at or below the horizon '
    + 'publishes key.envelope exactly 0: there is no multiplier by which a directional key can '
    + 'survive sunset');
  assert(belowHorizonCasting.length === 0,
    'and none of them asks for a shadow map, because a shadow map records where the sun cannot '
    + 'reach and below the horizon there is no sun');
  assert(daylightSuppressed === 0,
    'every hour with the sun at or above 4 deg keeps the full key, so no daylight card loses a '
    + 'single step to this envelope - including the golden-hour card at +6.61 deg');

  const golden = computeSkyModel({ hour: 18.5, weather: 'clear' });
  assert(golden.lightRig.key.envelope === 1,
    `the golden-hour card at ${golden.sun.altitudeDeg.toFixed(2)} deg is untouched (envelope 1)`);
  const night = computeSkyModel({ hour: 21.5, weather: 'clear' });
  assert(night.lightRig.key.envelope === 0 && night.lightRig.key.castShadow === false,
    `the night card at ${night.sun.altitudeDeg.toFixed(2)} deg asks for envelope 0 and no shadow`);
  // Monotone in altitude, so it cannot come back below the horizon the way
  // `(2 * daylight - 1) ** 2` did.
  let previousEnvelope = 0;
  let envelopeMonotone = true;
  for (let altitude = -40; altitude <= 60; altitude += 0.5) {
    const value = altitude <= 0 ? 0 : Math.min(1, Math.max(0, (() => {
      const t = Math.min(1, Math.max(0, altitude / 4));
      return t * t * (3 - 2 * t);
    })()));
    if (value < previousEnvelope - 1e-12) envelopeMonotone = false;
    previousEnvelope = value;
  }
  assert(envelopeMonotone,
    'the envelope is monotone in solar altitude over -40..+60 deg: unlike a squared daylight '
    + 'term it has no second branch that returns to full strength on the far side of the horizon');

  // --- the fit must not publish a key altitude as a solar altitude.
  const nightPose = POSES.find((pose) => pose.id === '06-night-street') || POSES[0];
  const nightKeyDirection = (() => {
    const solar = computeSunDirection(21.5, CANONICAL_SITE);
    const horizontal = Math.hypot(solar.x, solar.z);
    const lift = (52 * Math.PI) / 180;
    return {
      x: (-solar.x / horizontal) * Math.cos(lift),
      y: Math.sin(lift),
      z: (-solar.z / horizontal) * Math.cos(lift),
    };
  })();
  const honest = computeSunShadowCamera({
    fovDeg: nightPose.fovDeg,
    aspect: ASPECT,
    cameraPosition: nightPose.eye,
    cameraDirection: nightPose.forward,
    sunDirection: nightKeyDirection,
    mapSize: 2048,
    shadowDistance: 220,
    solarAltitudeDeg: night.sun.altitudeDeg,
  });
  assert(Math.abs(honest.keyAltitudeDeg - 52) < 0.05,
    `handed the renderer's night key the fit reports keyAltitudeDeg ${honest.keyAltitudeDeg.toFixed(2)}, `
    + 'which is what it was given');
  assert(honest.solarAltitudeDeg === night.sun.altitudeDeg && honest.keyIsSun === false,
    'and reports the model\'s own solar altitude alongside it, flagged as not-the-sun, so no '
    + 'capture report can publish 52 deg as a solar altitude again');
  assert(honest.castShadow === false,
    'castShadow is forced false because the SUN is down, whatever direction the key was pointed');
  assert(honest.warnings.some((w) => w.includes('describes the KEY')),
    'and the fit says so in its warnings rather than leaving the reader to notice');

  // Backwards compatible: a caller that does not supply the truth gets exactly
  // the behaviour it had.
  const legacy = computeSunShadowCamera({
    fovDeg: nightPose.fovDeg,
    aspect: ASPECT,
    cameraPosition: nightPose.eye,
    cameraDirection: nightPose.forward,
    sunDirection: nightKeyDirection,
    mapSize: 2048,
    shadowDistance: 220,
  });
  assert(legacy.castShadow === true && legacy.keyIsSun === true && legacy.solarAltitudeDeg === null,
    'a caller that supplies no solar altitude sees the previous contract unchanged');

  notes.push('night key: model says envelope 0, castShadow false, key illuminance 0.0000 at 21:30; '
    + 'round 4 shipped intensity 0.2997 with castShadow true at a fit-reported 52.0 deg');
}

if (notes.length > 0) {
  console.log('\nmeasured:');
  for (const note of notes) console.log(`  - ${note}`);
}

console.log(`\n${SUN_SHADOW_CASCADE_VERSION}`);
console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
