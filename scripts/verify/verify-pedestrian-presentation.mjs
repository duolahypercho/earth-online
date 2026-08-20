/**
 * Headless self-check for src/simulation/pedestrians/pedestrian-presentation.js.
 *
 * Plain node: no browser, no DOM, no canvas, no WebGL, no GPU, no new npm
 * dependency. three's animation, skinning and instancing classes are pure CPU
 * data structures until a renderer touches them, so the whole runtime - mixer,
 * skeleton, foot IK, instanced bands - is exercised here for real.
 *
 * What it proves:
 *
 *   - the module never imports an addon, never builds a ShaderMaterial, never
 *     calls onBeforeCompile, never constructs a BatchedMesh, and contains no
 *     Math.random / Date.now (source scan);
 *   - speed -> locomotion state, INCLUDING the hysteresis: the same speed maps
 *     to different states depending on where you came from;
 *   - the crossfade weights are a partition of unity and are continuous;
 *   - stride length and cadence against real adult gait numbers, and their
 *     monotonicity in speed;
 *   - the gait phase is an odometer, not a clock: splitting a frame in two
 *     yields the same phase, and a stopped agent's phase is frozen;
 *   - NO SKATING: the world-space ground speed of a foot in stance is zero to
 *     machine precision at every speed, stride and duty factor, and the
 *     analytic footGroundSpeed() agrees with a finite difference of
 *     footPlant(); the foot never travels backwards in world space;
 *   - two-bone IK reconstructs the requested foot position exactly and clamps
 *     (rather than stretches) an unreachable target;
 *   - foot height follows a supplied ground function exactly across a 15 cm
 *     curb step, the pelvis follows the supporting foot, and pitch/roll signs
 *     are correct on a slope;
 *   - per-agent phase offsets are spread, so a crowd cannot march in lockstep;
 *   - every identity-derived quantity is a pure function of the seed, and the
 *     crowd is not clones;
 *   - the distance band policy is monotone, hysteretic, and the skinned /
 *     instanced / far budgets are hard caps over a 600 agent corpus;
 *   - the authored clips compile, satisfy the replacement contract, and the
 *     contract validator rejects root motion and unknown bones;
 *   - the live crowd runs 240 frames over a curbed, sloped ground function
 *     without producing a single non-finite matrix element, respects the
 *     budget, keeps its draw and triangle cost inside the documented envelope,
 *     lands every skinned actor's ankle on the ground under that ankle, and
 *     NEVER writes to the caller's simulation records.
 *
 * Exits non-zero on the first failed assertion.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';

import {
  BAND_HYSTERESIS,
  CONTACT_SHADOW,
  CROWD_BUDGET,
  GAIT,
  LEG_SEGMENTS,
  LOCOMOTION_BLEND_RAMP,
  LOCOMOTION_CLIP_CONTRACT,
  LOCOMOTION_CLIP_SOURCE,
  LOCOMOTION_STATES,
  LOCOMOTION_THRESHOLDS,
  PALETTE_SLOTS,
  PEDESTRIAN_BONE_NAMES,
  PEDESTRIAN_PRESENTATION_VERSION,
  PRESENTATION_BANDS,
  PRESENTATION_BAND_DISTANCES,
  REST_POSE,
  ROOT_BONE_KEY,
  advanceGaitPhase,
  buildInstancedPartGeometries,
  buildLocomotionClips,
  buildPedestrianBodyGeometry,
  cadenceForSpeed,
  contactShadowFor,
  createCrowdPresentation,
  defaultReadAgent,
  dutyFactorForSpeed,
  footGroundSpeed,
  footPlant,
  identityRandom,
  identitySeed,
  identityVariation,
  legLengthForHeight,
  locomotionBlend,
  planCrowdPresentation,
  presentationBandForDistance,
  resolveLocomotionState,
  restBoneWorld,
  sampleFootGrounding,
  solveTwoBoneIK,
  strideLengthForSpeed,
  swingLiftForSpeed,
  validateLocomotionClips,
} from '../../src/simulation/pedestrians/pedestrian-presentation.js';

const MODULE_PATH = fileURLToPath(new URL('../../src/simulation/pedestrians/pedestrian-presentation.js', import.meta.url));
const SOURCE = readFileSync(MODULE_PATH, 'utf8');
// Scan CODE, not prose: the module's own documentation names the things it is
// forbidden to use, and explains why.
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

let checks = 0;
const results = [];
const notes = [];
function section(name, body) {
  const started = process.hrtime.bigint();
  body();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  results.push(`  ok  ${name} (${ms.toFixed(1)} ms)`);
}
function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}
function note(line) {
  notes.push(`      ${line}`);
}

// ------------------------------------------------------------ 1. source scan

section('renderer policy: no ShaderMaterial, no addons, no ambient randomness', () => {
  const banned = [
    ['ShaderMaterial', /\bShaderMaterial\b/],
    ['RawShaderMaterial', /\bRawShaderMaterial\b/],
    ['onBeforeCompile', /onBeforeCompile/],
    ['BatchedMesh', /\bBatchedMesh\b/],
    ['three/addons import', /from\s+['"]three\/(addons|examples)/],
    ['Math.random', /Math\.random\s*\(/],
    ['Date.now', /Date\.now\s*\(/],
    ['performance.now', /performance\.now\s*\(/],
    ['document/window', /\b(document|window)\s*\./],
  ];
  for (const [label, pattern] of banned) {
    check(!pattern.test(CODE), `module code must not contain ${label}`);
  }
  const imports = [...CODE.matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  check(imports.length === 1 && imports[0] === 'three', `only import is bare three, got ${JSON.stringify(imports)}`);
  check(PEDESTRIAN_PRESENTATION_VERSION === 'earthonline-pedestrian-presentation-v1', 'version tag');
  note(`imports: ${JSON.stringify(imports)}   source ${SOURCE.split('\n').length} lines`);
});

// ------------------------------------------------- 2. locomotion state machine

section('speed -> locomotion state, with real hysteresis', () => {
  const T = LOCOMOTION_THRESHOLDS;
  check(T.walkToIdle < T.idleToWalk, 'idle/walk thresholds must be asymmetric');
  check(T.briskToWalk < T.walkToBrisk, 'walk/brisk thresholds must be asymmetric');

  check(resolveLocomotionState(0, 'idle') === 'idle', 'still agent idles');
  check(resolveLocomotionState(1.3, 'idle') === 'walk', 'walking speed from idle -> walk');
  check(resolveLocomotionState(2.4, 'walk') === 'brisk', 'fast from walk -> brisk');
  check(resolveLocomotionState(1.7, 'brisk') === 'brisk', 'brisk holds through the dead band');
  check(resolveLocomotionState(1.4, 'brisk') === 'walk', 'brisk drops below briskToWalk');
  check(resolveLocomotionState(1.7, 'walk') === 'walk', 'walk does not promote inside the dead band');

  // The signature of hysteresis: identical speed, different answer.
  const dead = (T.walkToIdle + T.idleToWalk) / 2;
  check(resolveLocomotionState(dead, 'idle') === 'idle', 'dead band from below stays idle');
  check(resolveLocomotionState(dead, 'walk') === 'walk', 'dead band from above stays walk');
  const fastDead = (T.briskToWalk + T.walkToBrisk) / 2;
  check(resolveLocomotionState(fastDead, 'walk') === 'walk', 'fast dead band from below stays walk');
  check(resolveLocomotionState(fastDead, 'brisk') === 'brisk', 'fast dead band from above stays brisk');

  // A speed ramp up then down must not oscillate at any single sample.
  let state = 'idle';
  let flips = 0;
  let previous = state;
  for (let i = 0; i <= 400; i += 1) {
    const t = i / 400;
    const speed = 2.6 * (t < 0.5 ? t * 2 : (1 - t) * 2);
    state = resolveLocomotionState(speed, state);
    if (state !== previous) flips += 1;
    previous = state;
  }
  check(flips === 4, `a single up/down ramp must produce exactly 4 transitions, got ${flips}`);

  // A dithering speed inside the dead band must produce ZERO transitions.
  state = 'walk';
  let dither = 0;
  for (let i = 0; i < 500; i += 1) {
    const speed = dead + (i % 2 ? 0.06 : -0.06);
    const next = resolveLocomotionState(speed, state);
    if (next !== state) dither += 1;
    state = next;
  }
  check(dither === 0, `dithering inside the dead band must not flip state, got ${dither} flips`);

  check(resolveLocomotionState(2.9, 'idle', { pose: 'sit' }) === 'idle', 'simulation pose overrides speed');
  check(resolveLocomotionState(2.9, 'walk', { pose: 'stand' }) === 'idle', 'stand pose forces idle');
  note(`thresholds up ${T.idleToWalk}/${T.walkToBrisk} m/s, down ${T.walkToIdle}/${T.briskToWalk} m/s`);
});

section('crossfade weights are a continuous partition of unity', () => {
  let previous = locomotionBlend(0);
  for (let i = 0; i <= 600; i += 1) {
    const speed = (i / 600) * 3.2;
    const w = locomotionBlend(speed);
    const sum = w.idle + w.walk + w.brisk;
    check(Math.abs(sum - 1) < 1e-12, `blend weights must sum to 1 at ${speed}`);
    check(w.idle >= 0 && w.walk >= 0 && w.brisk >= 0, 'blend weights must be non-negative');
    const jump = Math.max(
      Math.abs(w.idle - previous.idle),
      Math.abs(w.walk - previous.walk),
      Math.abs(w.brisk - previous.brisk),
    );
    check(jump < 0.05, `blend must be continuous, jumped ${jump} at ${speed} m/s`);
    previous = w;
  }
  check(locomotionBlend(0).idle === 1, 'a still agent is fully idle');
  check(locomotionBlend(3.0).brisk === 1, 'a fast agent is fully brisk');
  check(locomotionBlend(1.2).walk > 0.9, 'a normal walk is dominated by the walk clip');
  check(locomotionBlend(2.4, { pose: 'sit' }).idle === 1, 'pose override reaches the blend too');
  note(`ramps walk ${LOCOMOTION_BLEND_RAMP.walkIn}-${LOCOMOTION_BLEND_RAMP.walkFull} m/s, brisk ${LOCOMOTION_BLEND_RAMP.briskIn}-${LOCOMOTION_BLEND_RAMP.briskFull} m/s`);
});

// -------------------------------------------------------- 3. the gait model

section('cadence and stride against adult gait, monotone in speed', () => {
  const leg = legLengthForHeight(1.75);
  check(Math.abs(leg - 0.9205) < 1e-3, `1.75 m adult hip height ${leg.toFixed(4)} m`);

  const cadence = cadenceForSpeed(1.4, leg);
  const stepsPerMinute = cadence * 60;
  check(stepsPerMinute > 100 && stepsPerMinute < 118, `1.4 m/s cadence ${stepsPerMinute.toFixed(1)} steps/min must sit in the adult 100-118 band`);
  const step = strideLengthForSpeed(1.4, leg) / 2;
  check(step > 0.70 && step < 0.85, `1.4 m/s step length ${step.toFixed(3)} m must sit in the adult 0.70-0.85 band`);
  const briskStep = strideLengthForSpeed(2.2, leg) / 2;
  check(briskStep > 0.88 && briskStep < 1.05, `2.2 m/s step length ${briskStep.toFixed(3)} m`);

  let lastStride = -1;
  let lastCadence = -1;
  let lastDuty = 1;
  for (let i = 1; i <= 200; i += 1) {
    const v = (i / 200) * 3.0;
    const stride = strideLengthForSpeed(v, leg);
    const c = cadenceForSpeed(v, leg);
    const duty = dutyFactorForSpeed(v);
    check(stride > lastStride, `stride must grow with speed at ${v}`);
    check(c >= lastCadence, `cadence must not fall with speed at ${v}`);
    check(duty <= lastDuty + 1e-12, `duty factor must not grow with speed at ${v}`);
    check(duty >= GAIT.dutyMin - 1e-12 && duty <= GAIT.dutyAtRest + 1e-12, 'duty in range');
    lastStride = stride;
    lastCadence = c;
    lastDuty = duty;
  }
  check(strideLengthForSpeed(0, leg) === 0, 'a still agent has no stride');

  // Short legs take shorter, faster steps at the same ground speed.
  const shortLeg = legLengthForHeight(1.55);
  check(cadenceForSpeed(1.4, shortLeg) > cadenceForSpeed(1.4, leg), 'short legs step faster');
  check(strideLengthForSpeed(1.4, shortLeg) < strideLengthForSpeed(1.4, leg), 'short legs step shorter');
  note(`1.4 m/s -> ${stepsPerMinute.toFixed(1)} steps/min, ${step.toFixed(3)} m step, duty ${dutyFactorForSpeed(1.4).toFixed(3)}`);
});

section('gait phase is an odometer, not a clock', () => {
  const leg = legLengthForHeight(1.75);
  const speed = 1.4;
  const stride = strideLengthForSpeed(speed, leg);

  // One big step vs sixteen small ones must land on the same phase.
  let coarse = 0.137;
  let fine = 0.137;
  coarse = advanceGaitPhase(coarse, speed, stride, 0.32);
  for (let i = 0; i < 16; i += 1) fine = advanceGaitPhase(fine, speed, stride, 0.02);
  check(Math.abs(coarse - fine) < 1e-12, `frame rate must not change the phase (${coarse} vs ${fine})`);

  // Walking one stride length advances exactly one cycle.
  const oneCycle = advanceGaitPhase(0, speed, stride, stride / speed);
  check(Math.abs(oneCycle) < 1e-12 || Math.abs(oneCycle - 1) < 1e-12, `one stride = one cycle, got ${oneCycle}`);

  // A stopped agent's feet stay planted.
  check(advanceGaitPhase(0.4, 0, 0, 0.1) === 0.4, 'a still agent does not march in place');
  check(advanceGaitPhase(0.4, 1.4, 0, 0.1) === 0.4, 'a zero stride cannot advance the phase');
  check(advanceGaitPhase(0.4, 1.4, stride, 0) === 0.4, 'a zero timestep cannot advance the phase');

  for (const p of [-0.3, 1.7, 3.25]) {
    const wrapped = advanceGaitPhase(p, 0, 0, 0);
    check(wrapped >= 0 && wrapped < 1, `phase wraps into [0,1), got ${wrapped}`);
  }
  note(`stride at 1.4 m/s = ${stride.toFixed(4)} m; phase invariant across 1x0.32 s vs 16x0.02 s`);
});

// ------------------------------------------------------------- 4. NO SKATING

section('NO SKATING: stance foot ground speed is zero to machine precision', () => {
  let worstStance = 0;
  let worstBackward = 0;
  let worstFiniteDiff = 0;
  let stanceSamples = 0;
  const leg = legLengthForHeight(1.75);

  for (const height of [1.52, 1.75, 1.96]) {
    const L0 = legLengthForHeight(height);
    for (let s = 1; s <= 30; s += 1) {
      const speed = (s / 30) * 3.0;
      const stride = strideLengthForSpeed(speed, L0);
      const duty = dutyFactorForSpeed(speed);
      const lift = swingLiftForSpeed(speed);
      for (const side of ['left', 'right']) {
        for (let k = 0; k < 512; k += 1) {
          const phase = k / 512;
          const plant = footPlant({ phase, side, strideLength: stride, duty, lift });
          const analytic = footGroundSpeed({ phase, side, strideLength: stride, duty, speed });

          // Finite difference of the real world position of the foot.
          const dPhase = 1e-7;
          const phaseB = (phase + dPhase) % 1;
          const plantB = footPlant({ phase: phaseB, side, strideLength: stride, duty, lift });
          // World longitudinal position = root travel + body-local offset.
          const dt = (dPhase * stride) / speed;
          const worldA = plant.longitudinal;
          const worldB = plantB.longitudinal + speed * dt;
          const numeric = (worldB - worldA) / dt;
          const isBoundary = Math.abs(phase - duty) < 2e-3
            || phase > 1 - 2e-3
            || (side === 'right' && (Math.abs(((phase + 0.5) % 1) - duty) < 2e-3 || ((phase + 0.5) % 1) > 1 - 2e-3));
          if (!isBoundary) {
            worstFiniteDiff = Math.max(worstFiniteDiff, Math.abs(numeric - analytic));
          }

          if (plant.contact) {
            stanceSamples += 1;
            worstStance = Math.max(worstStance, Math.abs(analytic));
            check(plant.lift === 0, 'a planted foot has zero lift');
          } else {
            check(plant.lift >= 0, 'swing lift is non-negative');
          }
          // A foot may never travel backwards through the world - that is the
          // visible tell of a sliding contact.
          worstBackward = Math.min(worstBackward, analytic);
        }
      }
    }
  }
  check(worstStance < 1e-9, `stance foot ground speed must be zero, worst |v| = ${worstStance}`);
  check(worstBackward > -1e-9, `foot must never slide backwards, worst = ${worstBackward}`);
  check(worstFiniteDiff < 1e-4, `analytic foot speed must match a finite difference, worst delta = ${worstFiniteDiff}`);
  check(stanceSamples > 20000, 'stance sample coverage');

  // Toe-off and heel-strike are the classic skate points: check them exactly.
  const stride = strideLengthForSpeed(1.4, leg);
  const duty = dutyFactorForSpeed(1.4);
  for (const phase of [0, duty - 1e-12, duty, 1 - 1e-12]) {
    const v = footGroundSpeed({ phase, side: 'left', strideLength: stride, duty, speed: 1.4 });
    check(Math.abs(v) < 1e-9, `foot speed at phase ${phase} must be zero, got ${v}`);
  }

  // Sanity: the guarantee comes from driving the phase by DISTANCE. Reproduce
  // the classic bug - advance the phase on a fixed cadence clock that does not
  // match the stride - and the same foot maths skates by ~1 m/s.
  const speed = 1.4;
  const dt = 1e-6;
  const wrongPhaseRate = (speed * dt) / (stride * 0.5); // clock, not odometer
  const a0 = footPlant({ phase: 0.2, side: 'left', strideLength: stride, duty });
  const a1 = footPlant({ phase: 0.2 + wrongPhaseRate, side: 'left', strideLength: stride, duty });
  const skate = ((a1.longitudinal + speed * dt) - a0.longitudinal) / dt;
  check(Math.abs(skate) > 0.6, `sanity: a clock-driven phase must skate visibly (${skate.toFixed(3)} m/s)`);
  const right = footPlant({ phase: 0.2 + (speed * dt) / stride, side: 'left', strideLength: stride, duty });
  const noSkate = ((right.longitudinal + speed * dt) - a0.longitudinal) / dt;
  check(Math.abs(noSkate) < 1e-6, `and the odometer-driven phase does not (${noSkate})`);
  note(`${stanceSamples} stance samples, worst |ground speed| ${worstStance.toExponential(2)} m/s, finite-diff delta ${worstFiniteDiff.toExponential(2)}`);
});

section('the two feet are half a cycle apart and support is continuous', () => {
  const leg = legLengthForHeight(1.75);
  for (const speed of [0.6, 1.4, 2.4]) {
    const stride = strideLengthForSpeed(speed, leg);
    const duty = dutyFactorForSpeed(speed);
    let minSupport = Infinity;
    let doubleSupport = 0;
    for (let k = 0; k < 2048; k += 1) {
      const phase = k / 2048;
      const l = footPlant({ phase, side: 'left', strideLength: stride, duty, lift: 0.08 });
      const r = footPlant({ phase, side: 'right', strideLength: stride, duty, lift: 0.08 });
      minSupport = Math.min(minSupport, l.stance + r.stance);
      if (l.contact && r.contact) doubleSupport += 1;
      check(!(l.lift > 0 && r.lift > 0), `both feet must never be airborne at ${speed} m/s, phase ${phase}`);
      check(Math.abs(l.lateral + r.lateral) < 1e-12, 'stance is symmetric about the centre line');
    }
    check(minSupport >= 1 - 1e-9, `at least one foot must fully support the body, min ${minSupport}`);
    const fraction = doubleSupport / 2048;
    check(fraction > 0.03 && fraction < 0.40, `double support fraction ${fraction.toFixed(3)} at ${speed} m/s`);
  }
});

// ---------------------------------------------------------------- 5. leg IK

section('two-bone IK reaches the target exactly and clamps out of range', () => {
  const A = LEG_SEGMENTS.thigh;
  const B = LEG_SEGMENTS.shin;
  let worst = 0;
  for (let i = 1; i <= 500; i += 1) {
    const d = (i / 500) * (A + B) * 0.999;
    if (d < Math.abs(A - B) + 1e-4) continue;
    const ik = solveTwoBoneIK({ upperLength: A, lowerLength: B, targetDistance: d });
    // Rebuild the chain in the sagittal plane exactly as applyPose() does:
    // thigh rotated -upperAngle about X off the aim axis, knee bent +bendAngle.
    const a = ik.upperAngle;
    const bend = ik.bendAngle;
    const kneeY = -A * Math.cos(a);
    const kneeZ = A * Math.sin(a);
    const footY = kneeY - B * Math.cos(bend - a);
    const footZ = kneeZ - B * Math.sin(bend - a);
    worst = Math.max(worst, Math.hypot(footZ, footY + d));
    check(ik.reachable, `d=${d} must be reachable`);
  }
  check(worst < 1e-12, `IK must reconstruct the target exactly, worst error ${worst}`);

  const over = solveTwoBoneIK({ upperLength: A, lowerLength: B, targetDistance: 5 });
  check(over.reachable === false, 'an unreachable target is reported');
  check(over.distance <= A + B, 'an unreachable target is clamped, not stretched');
  check(over.bendAngle < 0.02, `an over-extended leg is straight (knee bend ${(over.bendAngle * 180 / Math.PI).toFixed(2)} deg)`);
  const under = solveTwoBoneIK({ upperLength: A, lowerLength: B, targetDistance: 0 });
  check(under.reachable === false && under.distance >= Math.abs(A - B), 'a collapsed target is clamped');
  note(`thigh ${A} m, shin ${B} m, reach ${(A + B).toFixed(3)} m, worst reconstruction error ${worst.toExponential(2)} m`);
});

// ---------------------------------------------------- 6. ground / curb / slope

section('foot height follows the ground function across a 15 cm curb', () => {
  const CURB = 0.15;
  const EDGE = 4.0;
  const ground = (x, z) => (z >= EDGE ? CURB : 0);
  const leg = legLengthForHeight(1.75);
  const speed = 1.3;
  const stride = strideLengthForSpeed(speed, leg);
  const duty = dutyFactorForSpeed(speed);
  const lift = swingLiftForSpeed(speed);

  let phase = 0;
  let rootY = null;
  let worstContactError = 0;
  let worstPenetration = 0;
  let sawLower = false;
  let sawUpper = false;
  const dt = 1 / 60;
  let z = 1.0;
  let rootAtEnd = 0;
  for (let f = 0; f < 600; f += 1) {
    z += speed * dt;
    phase = advanceGaitPhase(phase, speed, stride, dt);
    const g = sampleFootGrounding({
      x: 0, y: 0, z, heading: 0, gaitPhase: phase, speed,
      strideLength: stride, duty, lift, sampleGround: ground,
      previousRootY: rootY, dt,
    });
    rootY = g.rootY;
    rootAtEnd = g.rootY;
    check(g.grounded, 'the ground function is defined everywhere here');
    for (const foot of g.feet) {
      const expected = ground(foot.x, foot.z) + foot.lift;
      worstContactError = Math.max(worstContactError, Math.abs(foot.y - expected));
      worstPenetration = Math.min(worstPenetration, foot.y - ground(foot.x, foot.z));
      if (foot.contact) {
        check(Math.abs(foot.y - ground(foot.x, foot.z)) < 1e-12, 'a planted foot sits exactly on its own ground sample');
        if (foot.groundY === 0) sawLower = true;
        if (foot.groundY === CURB) sawUpper = true;
      }
    }
    if (g.stepDelta > 0) {
      check(Math.abs(g.stepDelta - CURB) < 1e-12, `the detected step must be the curb height, got ${g.stepDelta}`);
    }
  }
  check(sawLower && sawUpper, 'the walk must plant feet on both sides of the curb');
  check(worstContactError < 1e-12, `foot height must equal ground+lift, worst error ${worstContactError}`);
  check(worstPenetration > -1e-12, `a foot must never sink below its own ground, worst ${worstPenetration}`);
  check(rootAtEnd <= CURB + 1e-9 && rootAtEnd > CURB - GAIT.maxPelvisDrop,
    `after the step the pelvis rides the upper level, got ${rootAtEnd}`);

  // Without damping the pelvis is the stance-weighted ground, minus whatever
  // lowering the stance leg needs in order to reach.
  const instant = sampleFootGrounding({
    x: 0, y: 0, z: 20, heading: 0, gaitPhase: 0.25, speed,
    strideLength: stride, duty, lift, sampleGround: ground,
  });
  check(Math.abs(instant.rootY - (CURB - instant.pelvisDrop)) < 1e-12, 'undamped root height sits on the supporting ground');
  note(`curb ${CURB} m: worst foot placement error ${worstContactError.toExponential(2)} m, final pelvis ${rootAtEnd.toFixed(4)} m`);
});

section('the leg can always reach: foot rocker plus pelvis lowering', () => {
  const reach = LEG_SEGMENTS.thigh + LEG_SEGMENTS.shin;
  const hip = LEG_SEGMENTS.hipLocalY;
  let worstOverreach = 0;
  let worstDrop = 0;
  let bobAtWalk = 0;
  for (const speed of [0.5, 1.0, 1.4, 1.9, 2.4]) {
    const leg = legLengthForHeight(1.75);
    const stride = strideLengthForSpeed(speed, leg);
    const duty = dutyFactorForSpeed(speed);
    const lift = swingLiftForSpeed(speed);
    let minRoot = Infinity;
    let maxRoot = -Infinity;
    for (let k = 0; k < 256; k += 1) {
      const g = sampleFootGrounding({
        x: 0, y: 0, z: 0, heading: 0, gaitPhase: k / 256, speed,
        strideLength: stride, duty, lift, sampleGround: () => 0,
      });
      minRoot = Math.min(minRoot, g.rootY);
      maxRoot = Math.max(maxRoot, g.rootY);
      worstDrop = Math.max(worstDrop, g.pelvisDrop);
      for (const foot of g.feet) {
        const d = Math.hypot(foot.ankleLongitudinal, g.rootY + hip - foot.ankleY);
        worstOverreach = Math.max(worstOverreach, d - reach);
        // The contact point is still exactly on its ground, rocker or not.
        check(Math.abs(foot.y - foot.lift) < 1e-12, 'the rocker never moves the contact point off the ground');
      }
    }
    if (speed === 1.4) bobAtWalk = maxRoot - minRoot;
    check(maxRoot - minRoot < 0.13, `pelvis bob at ${speed} m/s must stay plausible, got ${(maxRoot - minRoot).toFixed(4)} m`);
  }
  check(worstOverreach < 1e-9, `the stance leg must never be over-extended, worst ${worstOverreach.toFixed(5)} m`);
  check(worstDrop > 0.002 && worstDrop <= GAIT.maxPelvisDrop, `pelvis lowering is real but bounded, worst ${worstDrop.toFixed(4)} m`);
  check(bobAtWalk > 0.002, `a walking pelvis bobs, got ${bobAtWalk.toFixed(4)} m at 1.4 m/s`);

  // A point foot with no rocker and no pelvis drop is exactly the artefact this
  // replaces: prove the naive model really would over-extend.
  const stride = strideLengthForSpeed(1.9, legLengthForHeight(1.75));
  const duty = dutyFactorForSpeed(1.9);
  const naive = footPlant({ phase: 0, side: 'left', strideLength: stride, duty });
  const naiveReach = Math.hypot(naive.longitudinal, hip - GAIT.soleOffset);
  check(naiveReach > reach, `sanity: a point foot at standing hip height over-extends by ${(naiveReach - reach).toFixed(4)} m`);
  note(`reach ${reach.toFixed(3)} m: worst over-extension ${worstOverreach.toExponential(1)} m, pelvis drop <= ${worstDrop.toFixed(4)} m, bob ${bobAtWalk.toFixed(4)} m at 1.4 m/s`);
});

section('slope response: pitch and roll signs, and the no-ground fallback', () => {
  const uphill = sampleFootGrounding({
    x: 0, y: 0, z: 0, heading: 0, sampleGround: (x, z) => z * 0.2,
  });
  check(uphill.pitch > 0.05, `walking uphill must lean forward (positive pitch), got ${uphill.pitch}`);
  const downhill = sampleFootGrounding({
    x: 0, y: 0, z: 0, heading: 0, sampleGround: (x, z) => -z * 0.2,
  });
  check(downhill.pitch < -0.05, `walking downhill must lean back, got ${downhill.pitch}`);
  check(Math.abs(uphill.pitch + downhill.pitch) < 1e-12, 'the slope response is antisymmetric');

  // heading 0 faces +Z, so the agent's left is +X. Ground falling away to the
  // agent's RIGHT (-X) must roll the head toward the right, i.e. positive Z euler.
  const crossSlope = sampleFootGrounding({
    x: 0, y: 0, z: 0, heading: 0, sampleGround: (x) => x * 0.2,
  });
  check(crossSlope.roll > 0.05, `ground falling to the right must roll right, got ${crossSlope.roll}`);
  check(Math.abs(crossSlope.pitch) < 1e-12, 'a pure cross slope produces no pitch');

  const flat = sampleFootGrounding({ x: 0, y: 0, z: 0, heading: 0, sampleGround: () => 3 });
  check(flat.pitch === 0 && flat.roll === 0, 'flat ground produces no tilt');
  check(flat.rootY === 3, 'flat ground sets the root height');

  const clamped = sampleFootGrounding({
    x: 0, y: 0, z: 0, heading: 0, slopeFollow: 1, sampleGround: (x, z) => z * 40,
  });
  check(Math.abs(clamped.pitch) <= 0.6 + 1e-12, 'the slope response is clamped');

  const missing = sampleFootGrounding({ x: 0, y: 7, z: 0, heading: 0, sampleGround: () => null });
  check(missing.grounded === false, 'a nullish ground sample is reported, not hidden');
  check(missing.rootY === 7, 'a missing ground falls back to the simulation height');
  const noSampler = sampleFootGrounding({ x: 0, y: 2.5, z: 0, heading: 0 });
  check(noSampler.grounded === false && noSampler.rootY === 2.5, 'no sampler degrades to simulation height');

  // Heading must actually rotate the foot placement into the world.
  const east = sampleFootGrounding({
    x: 0, y: 0, z: 0, heading: Math.PI / 2, gaitPhase: 0.0, speed: 1.4,
    strideLength: 1.5, duty: 0.6, sampleGround: () => 0,
  });
  check(east.feet[0].x > 0.3, 'heading +pi/2 puts the leading foot on +X');
  check(Math.abs(east.feet[0].z) < 0.2, 'heading +pi/2 keeps the leading foot near z=0');
});

// ------------------------------------------------------- 7. identity variation

section('per-agent phase offsets are spread: no lockstep', () => {
  const offsets = [];
  for (let i = 0; i < 256; i += 1) offsets.push(identityVariation(`ped-${i}`).phaseOffset);
  const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  const variance = offsets.reduce((a, b) => a + (b - mean) ** 2, 0) / offsets.length;
  check(Math.abs(mean - 0.5) < 0.06, `phase offsets must be centred, mean ${mean.toFixed(4)}`);
  check(variance > 0.06, `phase offsets must be spread, variance ${variance.toFixed(4)}`);

  const buckets = new Set(offsets.map((o) => Math.floor(o * 32)));
  check(buckets.size === 32, `phase offsets must cover all 32 buckets, got ${buckets.size}`);
  const distinct = new Set(offsets.map((o) => o.toFixed(9)));
  check(distinct.size === offsets.length, `256 identities must give 256 distinct phases, got ${distinct.size}`);

  // The point of the offset: at any instant the crowd's feet are not together.
  const leg = legLengthForHeight(1.75);
  const stride = strideLengthForSpeed(1.4, leg);
  const duty = dutyFactorForSpeed(1.4);
  let planted = 0;
  for (const o of offsets) {
    if (footPlant({ phase: o, side: 'left', strideLength: stride, duty }).contact) planted += 1;
  }
  const fraction = planted / offsets.length;
  check(Math.abs(fraction - duty) < 0.08, `left-foot stance fraction across the crowd ${fraction.toFixed(3)} should track the duty factor ${duty.toFixed(3)}`);
  note(`256 identities: phase mean ${mean.toFixed(4)}, variance ${variance.toFixed(4)}, 32/32 buckets covered`);
});

section('identity determinism and crowd variety', () => {
  const a = identityVariation('maria');
  const b = identityVariation('maria');
  check(JSON.stringify(a) === JSON.stringify(b), 'the same identity must give byte-identical variation');
  check(identitySeed('maria') === identitySeed('maria'), 'seed hash is stable');
  check(identitySeed(17) === identitySeed(17), 'numeric seed hash is stable');
  check(identitySeed('maria') !== identitySeed('mario'), 'nearby ids do not collide');
  check(identityRandom(5, 'height') !== identityRandom(5, 'build'), 'salts decorrelate');

  const outfits = new Set();
  const heights = [];
  for (let i = 0; i < 512; i += 1) {
    const v = identityVariation(`crowd-${i}`);
    outfits.add(`${v.colors.top}|${v.colors.bottom}|${v.colors.shoes}|${v.colors.skin}|${v.colors.hair}`);
    heights.push(v.height);
    check(v.heightScale >= 0.90 && v.heightScale <= 1.10, 'height scale in range');
    check(v.buildScale >= 0.92 && v.buildScale <= 1.12, 'build scale in range');
    check(v.cadenceBias >= 0.94 && v.cadenceBias <= 1.06, 'cadence bias in range');
    for (const slot of PALETTE_SLOTS) {
      check(Number.isInteger(v.colors[slot]), `palette slot ${slot} is a hex integer`);
    }
  }
  check(outfits.size > 460, `512 identities must not be clones, got ${outfits.size} distinct outfits`);
  const minH = Math.min(...heights);
  const maxH = Math.max(...heights);
  check(maxH - minH > 0.3, `crowd height spread ${(maxH - minH).toFixed(3)} m`);
  note(`512 identities: ${outfits.size} distinct outfits, heights ${minH.toFixed(2)}-${maxH.toFixed(2)} m`);
});

// ------------------------------------------------------ 8. bands and budget

section('distance bands are monotone and hysteretic', () => {
  check(presentationBandForDistance(1) === 'skinned', 'nearby agents are skinned');
  check(presentationBandForDistance(50) === 'instanced', 'mid agents are instanced');
  check(presentationBandForDistance(150) === 'far', 'distant agents use the cheap band');
  check(presentationBandForDistance(900) === 'culled', 'very distant agents are culled');

  let previousRank = -1;
  for (let d = 0; d <= 400; d += 0.5) {
    const band = presentationBandForDistance(d);
    const rank = PRESENTATION_BANDS.indexOf(band);
    check(rank >= previousRank, `band must never get richer with distance at ${d} m`);
    previousRank = rank;
  }

  const edge = PRESENTATION_BAND_DISTANCES.skinned;
  check(presentationBandForDistance(edge + 2, 'skinned') === 'skinned', 'hysteresis holds a richer band');
  check(presentationBandForDistance(edge + 2, null) === 'instanced', 'without history the boundary is honoured');
  check(presentationBandForDistance(edge + BAND_HYSTERESIS + 0.5, 'skinned') === 'instanced', 'hysteresis is bounded');
  check(presentationBandForDistance(edge - 2, 'instanced') === 'skinned', 'promotion has no hysteresis');
});

section('the skinned/instanced/far budgets are hard caps', () => {
  const agents = [];
  for (let i = 0; i < 600; i += 1) {
    agents.push({ id: `a${i}`, x: (i % 25) * 9 - 100, y: 0, z: Math.floor(i / 25) * 9 - 100 });
  }
  const plan = planCrowdPresentation(agents, { position: { x: 0, y: 1.7, z: 0 } });
  check(plan.counts.skinned <= CROWD_BUDGET.skinned, `skinned budget: ${plan.counts.skinned} <= ${CROWD_BUDGET.skinned}`);
  check(plan.counts.instanced <= CROWD_BUDGET.instanced, `instanced budget: ${plan.counts.instanced}`);
  check(plan.counts.far <= CROWD_BUDGET.far, `far budget: ${plan.counts.far}`);
  const total = plan.counts.skinned + plan.counts.instanced + plan.counts.far + plan.counts.culled;
  check(total === 600, `every agent is accounted for, got ${total}`);

  // Overload the near band: everybody within 5 m.
  const crush = [];
  const CRUSH = 500;
  for (let i = 0; i < CRUSH; i += 1) crush.push({ id: `c${i}`, x: (i % 25) * 0.2, y: 0, z: Math.floor(i / 25) * 0.2 });
  const crushed = planCrowdPresentation(crush, { position: { x: 0, y: 1.7, z: 0 } });
  check(crushed.counts.skinned === CROWD_BUDGET.skinned, 'an overloaded near band fills exactly to the cap');
  check(crushed.counts.instanced === CROWD_BUDGET.instanced, 'overflow demotes to the next band, it does not vanish');
  check(crushed.counts.far === CROWD_BUDGET.far, 'and again to the far band');
  check(crushed.counts.culled === CRUSH - CROWD_BUDGET.skinned - CROWD_BUDGET.instanced - CROWD_BUDGET.far, 'only the remainder is culled');

  // Nearest wins: no agent in a richer band may be further than one in a poorer.
  const byBand = { skinned: [], instanced: [], far: [] };
  for (const e of crushed.entries) if (byBand[e.band]) byBand[e.band].push(e.distance);
  check(Math.max(...byBand.skinned) <= Math.min(...byBand.instanced) + 1e-9, 'skinned agents are the nearest');
  check(Math.max(...byBand.instanced) <= Math.min(...byBand.far) + 1e-9, 'instanced agents are nearer than far ones');

  // Determinism: array order must not change the plan.
  const shuffled = agents.slice();
  let seed = 12345;
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const planB = planCrowdPresentation(shuffled, { position: { x: 0, y: 1.7, z: 0 } });
  const sig = (p) => p.entries.map((e) => `${e.id}:${e.band}`).join(',');
  check(sig(plan) === sig(planB), 'the plan is independent of the input array order');

  // Inactive agents are the simulation's business, and they are skipped.
  const withInactive = agents.map((a, i) => (i % 3 === 0 ? { ...a, active: false } : a));
  const planC = planCrowdPresentation(withInactive, { position: { x: 0, y: 1.7, z: 0 } });
  check(planC.entries.length === 600 - 200, 'inactive agents are excluded');
  note(`600 agents -> ${plan.counts.skinned} skinned / ${plan.counts.instanced} instanced / ${plan.counts.far} far / ${plan.counts.culled} culled`);
});

section('contact shadow maths', () => {
  const near = contactShadowFor({ speed: 1.4, distance: 5 });
  check(near.opacity > 0.2, `a nearby walker gets a real blob, got ${near.opacity}`);
  check(near.radius > 0.2 && near.radius < 0.5, `blob radius ${near.radius}`);
  check(near.lengthScale > 1, 'a moving blob stretches along the heading');
  const still = contactShadowFor({ speed: 0, distance: 5 });
  check(still.lengthScale === 1, 'a standing blob is round');
  const far = contactShadowFor({ speed: 1.4, distance: CONTACT_SHADOW.fadeEnd + 10 });
  check(far.opacity === 0, 'the blob is gone past the fade distance');
  const airborne = contactShadowFor({ speed: 1.4, distance: 5, groundClearance: CONTACT_SHADOW.clearanceFade });
  check(airborne.opacity === 0, 'a fully lifted agent has no contact shadow');
  let previous = Infinity;
  for (let d = 0; d <= 260; d += 2) {
    const o = contactShadowFor({ speed: 1.4, distance: d }).opacity;
    check(o <= previous + 1e-12, 'opacity is monotone in distance');
    previous = o;
  }
  const big = contactShadowFor({ speed: 0, heightScale: 1.1, buildScale: 1.12 });
  const small = contactShadowFor({ speed: 0, heightScale: 0.9, buildScale: 0.92 });
  check(big.radius > small.radius, 'a bigger person casts a bigger blob');
});

// -------------------------------------------------------------- 9. the clips

section('authored clips compile and satisfy the replacement contract', () => {
  const clips = buildLocomotionClips();
  check(validateLocomotionClips(clips).length === 0, 'the built-in clips satisfy their own contract');
  for (const state of LOCOMOTION_STATES) {
    const clip = clips[state];
    check(clip instanceof THREE.AnimationClip, `${state} is a real AnimationClip`);
    check(clip.tracks.length > 6, `${state} drives a real body, ${clip.tracks.length} tracks`);
    for (const track of clip.tracks) {
      const bone = track.name.split('.')[0];
      check(PEDESTRIAN_BONE_NAMES.includes(bone), `${state} targets a known bone (${bone})`);
      check(Number.isFinite(track.times[0]), 'track times are finite');
      for (const value of track.values) check(Number.isFinite(value), `${state}/${track.name} has finite values`);
      // Seamless loop: the first and last keyframes must agree.
      const stride = track.getValueSize();
      const last = track.values.length - stride;
      for (let i = 0; i < stride; i += 1) {
        check(Math.abs(track.values[i] - track.values[last + i]) < 1e-6,
          `${state}/${track.name} must loop seamlessly (component ${i})`);
      }
      check(Math.abs(track.times[track.times.length - 1] - clip.duration) < 1e-5, `${state}/${track.name} spans the clip`);
    }
  }
  check(clips.walk.duration === 1 && clips.brisk.duration === 1, 'walk/brisk are one stride long');
  check(LOCOMOTION_CLIP_CONTRACT.strideCycles.walk === 1, 'the contract states one stride per cycle');

  // In-place: only Hips may move, and only vertically/laterally.
  for (const state of ['walk', 'brisk']) {
    const track = clips[state].tracks.find((t) => t.name === 'Hips.position');
    check(track, `${state} has a hips bob`);
    const restZ = REST_POSE.Hips.offset[2];
    for (let i = 2; i < track.values.length; i += 3) {
      check(Math.abs(track.values[i] - restZ) < 1e-9, `${state} must be in place: no forward root motion`);
    }
  }

  // The brisk clip must actually be bigger than the walk clip.
  const amplitude = (clip, name) => {
    const track = clip.tracks.find((t) => t.name === name);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < track.values.length; i += 4) {
      min = Math.min(min, track.values[i]);
      max = Math.max(max, track.values[i]);
    }
    return max - min;
  };
  check(amplitude(clips.brisk, 'LeftUpLeg.quaternion') > amplitude(clips.walk, 'LeftUpLeg.quaternion') * 1.2,
    'brisk swings the leg further than walk');
  check(amplitude(clips.brisk, 'LeftArm.quaternion') > amplitude(clips.walk, 'LeftArm.quaternion') * 1.2,
    'brisk swings the arm further than walk');

  // The validator must reject the two ways an external clip usually breaks.
  const rogue = buildLocomotionClips();
  rogue.walk = new THREE.AnimationClip('rogue', 1, [
    new THREE.VectorKeyframeTrack('Chest.position', [0, 1], [0, 0, 0, 0, 0, 5]),
  ]);
  const problems = validateLocomotionClips(rogue);
  check(problems.some((p) => /root motion/.test(p)), `root motion is rejected: ${problems.join('; ')}`);
  const unknown = buildLocomotionClips();
  unknown.idle = new THREE.AnimationClip('rogue', 1, [
    new THREE.QuaternionKeyframeTrack('Tail.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  check(validateLocomotionClips(unknown).some((p) => /unknown bone/.test(p)), 'unknown bones are rejected');
  check(validateLocomotionClips({}).length >= 3, 'a missing clip set is rejected');
  note(`clips: idle ${clips.idle.duration}s/${clips.idle.tracks.length} tracks, walk 1 stride/${clips.walk.tracks.length}, brisk 1 stride/${clips.brisk.tracks.length}`);
});

section('the mixer really evaluates the authored clips', () => {
  const clips = buildLocomotionClips();
  const root = new THREE.Object3D();
  const bones = new Map();
  for (const name of PEDESTRIAN_BONE_NAMES) {
    const node = new THREE.Object3D();
    node.name = name;
    const rest = REST_POSE[name];
    node.position.set(...rest.offset);
    bones.set(name, node);
  }
  for (const name of PEDESTRIAN_BONE_NAMES) {
    const rest = REST_POSE[name];
    (rest.parent ? bones.get(rest.parent) : root).add(bones.get(name));
  }
  const mixer = new THREE.AnimationMixer(root);
  const walk = mixer.clipAction(clips.walk);
  walk.play();
  walk.setEffectiveWeight(1);
  const thigh = bones.get('LeftUpLeg');
  const samples = [];
  for (const t of [0, 0.25, 0.5, 0.75]) {
    walk.time = t;
    mixer.update(0);
    samples.push(thigh.quaternion.x);
  }
  check(new Set(samples.map((v) => v.toFixed(6))).size === 4, `mixer.update(0) must evaluate the clip, got ${samples}`);
  check(samples[0] < -0.1, 'phase 0 is left heel strike: the left thigh is flexed forward');
  check(samples[2] > 0.1, 'phase 0.5 is left toe-off: the left thigh is extended back');

  // Blending must interpolate, not switch.
  const idle = mixer.clipAction(clips.idle);
  idle.play();
  idle.setEffectiveWeight(0.5);
  walk.setEffectiveWeight(0.5);
  walk.time = 0;
  idle.time = 0;
  mixer.update(0);
  const blended = thigh.quaternion.x;
  check(blended > samples[0] && blended < 0, `a 50/50 blend must land between the clips, got ${blended}`);
  note('AnimationMixer drives clip time from gait phase via update(0): clip time is distance, not wall clock');
});

// ------------------------------------------------------ 10. the live crowd

section('rig geometry, palette slots and triangle cost', () => {
  const body = buildPedestrianBodyGeometry();
  const vertices = body.attributes.position.count;
  const triangles = vertices / 3;
  check(Number.isInteger(triangles), 'the merged body is non-indexed triangles');
  check(body.attributes.skinIndex && body.attributes.skinWeight, 'the body is skinnable');
  let maxBone = 0;
  for (const index of body.attributes.skinIndex.array) maxBone = Math.max(maxBone, index);
  check(maxBone < PEDESTRIAN_BONE_NAMES.length, 'skin indices stay inside the skeleton');
  for (const w of body.attributes.skinWeight.array) check(w === 0 || w === 1, 'rigid skinning weights');
  const uvs = body.attributes.uv.array;
  const slots = new Set();
  for (let i = 0; i < uvs.length; i += 2) {
    const slot = Math.round(uvs[i] * PALETTE_SLOTS.length - 0.5);
    check(slot >= 0 && slot < PALETTE_SLOTS.length, 'every vertex maps to a palette slot');
    slots.add(slot);
  }
  check(slots.size === PALETTE_SLOTS.length, `all ${PALETTE_SLOTS.length} palette slots are used, got ${slots.size}`);
  // The skinned band is the <= 28 m band. It carries hands, a jaw, a brow, a
  // nose, eyes, shoulder caps and a joint filler at every articulating joint,
  // because a figure two metres from the camera made of a cube head and bare
  // cylinder limbs caps the character dimension however good the grounding is.
  // 1 600 is the ceiling for that: 24 of them is 35 k triangles.
  check(triangles < 1600, `skinned body triangle budget: ${triangles}`);
  check(body.attributes.color, 'the body carries baked cavity shading in its colour attribute');
  let shadeMin = 1;
  let shadeMax = 0;
  for (const v of body.attributes.color.array) {
    shadeMin = Math.min(shadeMin, v);
    shadeMax = Math.max(shadeMax, v);
  }
  check(shadeMin >= 0.25 && shadeMax <= 1 && shadeMin < 0.9,
    `cavity shading spans a usable range, ${shadeMin.toFixed(2)}-${shadeMax.toFixed(2)}`);

  const mid = buildInstancedPartGeometries({ detail: 'mid', radialSegments: 5 });
  const far = buildInstancedPartGeometries({ detail: 'far', radialSegments: 3, mergeToRoot: true });
  let midTris = 0;
  for (const entry of mid.values()) midTris += entry.geometry.attributes.position.count / 3;
  let farTris = 0;
  for (const entry of far.values()) farTris += entry.geometry.attributes.position.count / 3;
  check(midTris < triangles, 'the instanced band is cheaper than the skinned body');
  check(farTris < midTris, 'the far band is cheaper than the instanced band');
  check(far.size <= 5, `the far band must be a handful of draws, got ${far.size}`);
  for (const entry of far.values()) {
    check(entry.bone === ROOT_BONE_KEY, 'the far band collapses onto a single root matrix');
    entry.geometry.computeBoundingBox();
    const box = entry.geometry.boundingBox;
    // Baked in CHARACTER space: feet on the ground at y = 0. Getting this wrong
    // buries the whole far band up to the hips, and nothing else would notice.
    check(box.min.y > -0.02, `far band geometry must not sink below the ground plane (${box.min.y.toFixed(3)} m)`);
    check(box.max.y < 1.95, `far band geometry must stay inside an adult silhouette (${box.max.y.toFixed(3)} m)`);
  }
  let farTop = -Infinity;
  let farBottom = Infinity;
  for (const entry of far.values()) {
    farTop = Math.max(farTop, entry.geometry.boundingBox.max.y);
    farBottom = Math.min(farBottom, entry.geometry.boundingBox.min.y);
  }
  check(farTop > 1.55 && farBottom < 0.05, `the far figure spans a whole person, ${farBottom.toFixed(3)}-${farTop.toFixed(3)} m`);

  // The mid band is the opposite: bone-local, so every chunk hugs its joint.
  for (const entry of mid.values()) {
    entry.geometry.computeBoundingBox();
    const box = entry.geometry.boundingBox;
    const reach = Math.max(Math.abs(box.min.y), Math.abs(box.max.y));
    check(reach < 0.5, `mid band chunk ${entry.bone}|${entry.group} must be bone-local, reach ${reach.toFixed(3)} m`);
  }

  const total = CROWD_BUDGET.skinned * triangles
    + CROWD_BUDGET.instanced * midTris
    + CROWD_BUDGET.far * farTris;
  check(total < 200000, `full crowd triangle budget ${Math.round(total)} must stay under 200k`);
  check(restBoneWorld('LeftFoot')[1] > 0, 'the ankle rests above the ground plane');
  note(`skinned ${triangles} tri x${CROWD_BUDGET.skinned}, mid ${midTris} tri x${CROWD_BUDGET.instanced} in ${mid.size} draws, far ${farTris} tri x${CROWD_BUDGET.far} in ${far.size} draws -> ${Math.round(total / 1000)}k tri`);
});

section('the live crowd runs, stays finite, and grounds every skinned ankle', () => {
  const CURB = 0.15;
  const ground = (x, z) => (z > 6 ? CURB : 0) + Math.sin(x * 0.04) * 0.6;
  const parent = new THREE.Group();
  const crowd = createCrowdPresentation({ parent, sampleGround: ground });
  check(parent.children.includes(crowd.object3d), 'the crowd attaches to the caller-supplied parent');
  check(crowd.object3d.name === 'pedestrian-presentation', 'the crowd group is named');

  const agents = [];
  for (let i = 0; i < 300; i += 1) {
    agents.push({
      id: `sim-${i}`,
      x: (i % 20) * 4 - 40,
      y: 0,
      z: Math.floor(i / 20) * 4 - 30,
      heading: (i * 0.37) % (Math.PI * 2),
      speed: [0, 0.9, 1.35, 2.3][i % 4],
    });
  }
  const before = JSON.stringify(agents);

  let stats = null;
  const dt = 1 / 60;
  for (let frame = 0; frame < 240; frame += 1) {
    for (const a of agents) {
      a.x += Math.sin(a.heading) * a.speed * dt;
      a.z += Math.cos(a.heading) * a.speed * dt;
    }
    const snapshot = JSON.stringify(agents);
    stats = crowd.update(agents, dt, { x: 0, y: 1.7, z: 0 });
    check(JSON.stringify(agents) === snapshot,
      `presentation must never write to simulation records (frame ${frame})`);
  }
  check(JSON.stringify(agents) !== before, 'sanity: the test itself moved the crowd');

  check(stats.skinned <= CROWD_BUDGET.skinned, `runtime skinned budget ${stats.skinned}`);
  check(stats.instanced <= CROWD_BUDGET.instanced, `runtime instanced budget ${stats.instanced}`);
  check(stats.far <= CROWD_BUDGET.far, `runtime far budget ${stats.far}`);
  check(stats.skinned > 0 && stats.instanced > 0 && stats.far > 0, 'all three bands are populated');
  check(stats.shadows === stats.skinned + stats.instanced + stats.far, `every visible agent gets a contact shadow (${stats.shadows})`);
  check(stats.ungrounded === 0, 'every agent found ground');
  check(stats.maxFootGroundSpeed < 1e-9, `runtime stance foot speed ${stats.maxFootGroundSpeed}`);

  // No non-finite matrix element anywhere in the crowd.
  let matrices = 0;
  crowd.object3d.traverse((node) => {
    node.updateMatrixWorld(true);
    for (const v of node.matrixWorld.elements) check(Number.isFinite(v), `finite matrix on ${node.name}`);
    matrices += 1;
    if (node.isInstancedMesh) {
      const array = node.instanceMatrix.array;
      for (let i = 0; i < node.count * 16; i += 1) {
        check(Number.isFinite(array[i]), `finite instance matrix on ${node.name}`);
      }
      check(node.count <= node.instanceMatrix.count, `${node.name} never draws past its capacity`);
    }
  });
  check(matrices > 20, 'the crowd built a real scene subtree');

  // THE GROUNDING TEST: every visible skinned ankle sits on the ground under it.
  const world = new THREE.Vector3();
  let ankles = 0;
  let worstAnkle = 0;
  let bestAnkle = Infinity;
  for (const actor of crowd.object3d.children) {
    if (!actor.name.startsWith('pedestrian-actor-') || !actor.visible) continue;
    let skinned = null;
    actor.traverse((n) => { if (n.isSkinnedMesh) skinned = n; });
    check(skinned, 'a visible actor carries a SkinnedMesh');
    for (const side of ['LeftFoot', 'RightFoot']) {
      const bone = skinned.skeleton.bones[PEDESTRIAN_BONE_NAMES.indexOf(side)];
      bone.getWorldPosition(world);
      check(Number.isFinite(world.x + world.y + world.z), 'the ankle has a finite world position');
      const expected = ground(world.x, world.z);
      // The ankle sits a sole's thickness above its own ground, plus swing lift.
      const above = world.y - expected;
      check(above > 0, `${side} must stay above its ground (${above.toFixed(4)} m)`);
      // Sole thickness + foot rocker + swing clearance is the whole budget an
      // ankle is allowed. Anything beyond that is a floating character.
      const ceiling = (GAIT.soleOffset + GAIT.rockerRise) * 1.10 + swingLiftForSpeed(2.4) * 1.10;
      check(above < ceiling, `${side} must stay attached to its ground (${above.toFixed(4)} m of ${ceiling.toFixed(4)} m)`);
      worstAnkle = Math.max(worstAnkle, above);
      bestAnkle = Math.min(bestAnkle, above);
      ankles += 1;
    }
  }
  check(ankles >= 2 * stats.skinned, `every skinned actor was checked (${ankles} ankles)`);
  check(bestAnkle < GAIT.soleOffset * 1.25, `at least one ankle is fully planted (${bestAnkle.toFixed(4)} m)`);

  // Materials must be renderer-legal.
  crowd.object3d.traverse((node) => {
    const materials = node.material ? [].concat(node.material) : [];
    for (const m of materials) {
      check(!m.isShaderMaterial && !m.isRawShaderMaterial, `${node.name} must not use a ShaderMaterial`);
      check(m.isMeshStandardMaterial || m.isMeshBasicMaterial, `${node.name} uses a WebGPU-safe material (${m.type})`);
      check(typeof m.onBeforeCompile !== 'function' || m.onBeforeCompile.length === 0 || !m.userData.patched, 'no shader patching');
    }
    check(!node.isBatchedMesh, 'no BatchedMesh on the WebGL2 fallback');
  });
  note(`240 frames, 300 agents: ${stats.skinned} skinned / ${stats.instanced} instanced / ${stats.far} far, ${stats.draws} draws, ankle clearance ${bestAnkle.toFixed(4)}-${worstAnkle.toFixed(4)} m`);
  crowd.dispose();
  check(!parent.children.includes(crowd.object3d), 'dispose detaches the crowd');
});

section('the crowd is deterministic and the clip seam is swappable', () => {
  const ground = (x, z) => Math.sin(x * 0.05) * 0.4 + Math.cos(z * 0.03) * 0.2;
  const agents = () => {
    const out = [];
    for (let i = 0; i < 120; i += 1) {
      out.push({
        id: `d-${i}`, x: (i % 12) * 3 - 18, y: 0, z: Math.floor(i / 12) * 3 - 15,
        heading: i * 0.21, speed: 0.4 + (i % 6) * 0.4,
      });
    }
    return out;
  };
  const run = () => {
    const crowd = createCrowdPresentation({ sampleGround: ground });
    const list = agents();
    for (let f = 0; f < 90; f += 1) {
      for (const a of list) { a.x += Math.sin(a.heading) * a.speed / 60; a.z += Math.cos(a.heading) * a.speed / 60; }
      crowd.update(list, 1 / 60, { x: 0, y: 1.7, z: 0 });
    }
    const signature = [];
    crowd.object3d.traverse((node) => {
      if (node.isInstancedMesh) {
        for (let i = 0; i < node.count * 16; i += 1) signature.push(node.instanceMatrix.array[i].toFixed(6));
      } else if (node.isBone) {
        signature.push(node.quaternion.x.toFixed(6), node.quaternion.y.toFixed(6), node.quaternion.z.toFixed(6));
      }
    });
    const stats = { ...crowd.stats() };
    crowd.dispose();
    return { signature: signature.join(','), stats };
  };
  const a = run();
  const b = run();
  check(a.signature === b.signature, 'two identical runs must produce identical transforms');
  check(a.signature.length > 5000, 'the determinism signature actually covers the crowd');
  check(JSON.stringify(a.stats) === JSON.stringify(b.stats), 'stats are deterministic');

  // The seam: hand it a different clip set and nothing else changes.
  const crowd = createCrowdPresentation({ sampleGround: ground });
  const list = agents();
  crowd.update(list, 1 / 60, { x: 0, y: 1.7, z: 0 });
  const external = buildLocomotionClips({
    ...LOCOMOTION_CLIP_SOURCE,
    walk: {
      duration: 2.5,
      tracks: [
        { bone: 'LeftUpLeg', property: 'rotation', times: [0, 1.25, 2.5], values: [[-40, 0, 0], [40, 0, 0], [-40, 0, 0]] },
        { bone: 'RightUpLeg', property: 'rotation', times: [0, 1.25, 2.5], values: [[40, 0, 0], [-40, 0, 0], [40, 0, 0]] },
      ],
    },
  });
  check(external.walk.duration === 2.5, 'a replacement clip may have any duration');
  crowd.setClips(external);
  const after = crowd.update(list, 1 / 60, { x: 0, y: 1.7, z: 0 });
  check(after.agents === 120, 'the crowd still runs after a clip swap');
  check(after.maxFootGroundSpeed < 1e-9, 'a replacement clip cannot introduce skating: foot placement is analytic');
  check(crowd.getClips().walk === external.walk, 'the swapped clip is the live one');
  assert.throws(() => crowd.setClips({ idle: external.idle }), /invalid locomotion clip set/, 'an incomplete clip set is refused');
  check(crowd.rig.boneNames === PEDESTRIAN_BONE_NAMES, 'the retarget seam exposes the bone vocabulary');
  check(crowd.rig.template.isObject3D, 'the retarget seam exposes a skeleton template');
  crowd.dispose();
  note('clip swap accepted at runtime; foot placement stayed analytic across the swap');
});

section('the simulation adapter is read-only and shape-tolerant', () => {
  const out = {};
  const flat = Object.freeze({ id: 'a', x: 1, y: 2, z: 3, heading: 0.5, speed: 1.2 });
  const readFlat = defaultReadAgent(flat, 0, out);
  check(readFlat.id === 'a' && readFlat.x === 1 && readFlat.heading === 0.5 && readFlat.speed === 1.2, 'flat shape reads');
  check(readFlat.seed === 'a' && readFlat.active === true && readFlat.pose === 'walk', 'defaults applied');

  // The shape src/citygen/traffic.js already produces.
  const nested = Object.freeze({
    instanceIndex: 7,
    group: Object.freeze({ position: Object.freeze({ x: 4, y: 0, z: 5 }), rotation: Object.freeze({ y: 1.1 }) }),
    speed: 1.9,
  });
  const readNested = defaultReadAgent(nested, 3, {});
  check(readNested.id === 7 && readNested.x === 4 && readNested.z === 5, 'nested shape reads');
  check(readNested.heading === 1.1 && readNested.speed === 1.9, 'nested heading and speed read');

  const missing = defaultReadAgent({}, 11, {});
  check(missing.id === 11 && missing.speed === 0 && missing.x === 0, 'a bare record degrades to sane defaults');
  check(defaultReadAgent({ speed: -3 }, 0, {}).speed === 0, 'negative speed is clamped, not trusted');

  // Frozen inputs prove there is no write path.
  const crowd = createCrowdPresentation({});
  const frozen = [flat, nested].map((a) => Object.freeze(a));
  crowd.update(frozen, 1 / 60, { x: 0, y: 1.7, z: 0 });
  crowd.update(frozen, 1 / 60, { x: 0, y: 1.7, z: 0 });
  check(true, 'updating frozen simulation records does not throw');
  crowd.dispose();
});

// ------------------------------------------------------------------- report

process.stdout.write(`\nverify-pedestrian-presentation  ${PEDESTRIAN_PRESENTATION_VERSION}\n`);
for (const line of results) process.stdout.write(`${line}\n`);
process.stdout.write('\nmeasurements\n');
for (const line of notes) process.stdout.write(`${line}\n`);
process.stdout.write(`\n${checks} assertions passed in ${results.length} sections.\n`);
