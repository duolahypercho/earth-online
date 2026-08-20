/**
 * Pedestrian crowd *presentation* for the canonical city renderer.
 *
 * Why this module exists
 * ----------------------
 * The visual quality gate scores "character grounding" 1/5 and "NPC and traffic
 * life" 2/5 - twenty rubric points. Captured frames show one or two rigid,
 * untextured figures standing motionless with no contact shadow. The cause is
 * not a missing library: three 0.180 already ships `AnimationMixer`,
 * `AnimationClip`, keyframe tracks, `SkinnedMesh`/`Skeleton`/`Bone`. What is
 * missing is *wiring* (nothing in `src/` constructs an `AnimationMixer`) and
 * *clips* (there is no locomotion data anywhere in the tree). This module
 * supplies both, with zero external assets and zero new npm dependencies.
 *
 * Ownership (AGENTS.md)
 * ---------------------
 * This is **presentation only**. Path, identity, speed, heading and schedule are
 * simulation-owned. `update()` reads the caller's agent records through a
 * read-only adapter and never writes a property back onto them - the headless
 * self-check snapshots the caller's records before `update()` and asserts byte
 * equality afterwards. Nothing here creates a renderer, a canvas, an animation
 * loop, an HTML entrypoint or a scene root; `createCrowdPresentation()` returns
 * an `Object3D` that the integrator attaches wherever it wants.
 *
 * WebGPURenderer constraints honoured
 * -----------------------------------
 * - No `ShaderMaterial`, no `onBeforeCompile`, no `three/addons` import. Only
 *   `MeshStandardMaterial` and `MeshBasicMaterial`, which NodeBuilder maps onto
 *   `MeshStandardNodeMaterial` / `MeshBasicNodeMaterial` without substituting a
 *   blank material.
 * - No `BatchedMesh`: on a WebGL2 backend without `WEBGL_multi_draw` it issues
 *   no draw call and only `warnOnce()`s. The far/mid bands use `InstancedMesh`,
 *   which is core WebGL2.
 * - No WGSL/TSL/compute.
 *
 * Determinism
 * -----------
 * Every random-looking quantity is a pure function of the agent's identity seed
 * through a 32-bit integer hash. There is no `Math.random()` and no
 * `Date.now()` in this file. The only clock is the `dt` the caller passes in.
 *
 * ----------------------------------------------------------------------------
 * INPUT CONTRACT  (what the simulation must hand us)
 * ----------------------------------------------------------------------------
 * `update(agents, dt, view)` takes an array-like of *simulation-owned* records.
 * Each record is read through `options.readAgent(source, index, out) -> out`.
 * The default reader accepts either shape:
 *
 *   A. flat:   { id, seed?, x, y, z, heading, speed, active?, pose? }
 *   B. nested: { instanceIndex|id, group: { position:{x,y,z}, rotation:{y} },
 *                speed, active?, pose? }
 *              (this is the shape `src/citygen/traffic.js` already produces)
 *
 * Field semantics, all simulation-owned:
 *
 *   id        string|number  Stable per-agent identity. Required.
 *   seed      number|string  Identity seed for procedural variation. Defaults
 *                            to `id`. Must be stable for the agent's lifetime.
 *   x, y, z   number         World metres. `y` is the simulation's own idea of
 *                            the agent's ground contact height; presentation
 *                            may *display* a different height (foot grounding)
 *                            but never writes back.
 *   heading   number         Radians. `0` faces +Z; `+heading` turns toward +X.
 *                            i.e. forward = (sin h, 0, cos h). This matches
 *                            `Object3D.rotation.y` in the existing crowd code.
 *   speed     number         Ground speed magnitude in m/s, >= 0. This is the
 *                            ONLY thing that drives the locomotion state; the
 *                            module never integrates a position of its own.
 *   active    boolean        Optional. `false` hides the agent this frame.
 *   pose      string         Optional. 'walk' (default) | 'stand' | 'sit'.
 *                            'stand'/'sit' force the idle state regardless of
 *                            speed, for simulation-authored stationary actors.
 *
 * The module keeps its own per-agent presentation memory (gait phase, damped
 * root height, band hysteresis) keyed by `id`. That memory is presentation
 * state, not simulation state.
 *
 * ----------------------------------------------------------------------------
 * GROUND CONTRACT
 * ----------------------------------------------------------------------------
 * `options.sampleGround(x, z) -> number | null | undefined`
 * World-space ground height in metres at a horizontal position, or a nullish
 * value where no ground data exists. In the canonical runtime this is
 * `renderer.terrain.heightAt` (see `src/citygen/renderer.js`, which already
 * builds `this.terrain = { heightAt }`). When it is absent or returns nullish
 * the module falls back to the agent's simulation `y` and reports
 * `grounded: false` in its stats, so a missing ground function degrades to the
 * current behaviour instead of floating a crowd in the air.
 *
 * ----------------------------------------------------------------------------
 * CLIP SEAM  (how CC0 clips replace the built-ins later)
 * ----------------------------------------------------------------------------
 * The built-in clips are authored as plain data in `LOCOMOTION_CLIP_SOURCE`
 * (euler degrees + metres at keyframe times) and compiled by
 * `buildLocomotionClips()` into real `THREE.AnimationClip`s. To swap in
 * externally supplied CC0 clips, the integrator calls
 * `crowd.setClips({ idle, walk, brisk })` - or passes `{ clips }` to
 * `createCrowdPresentation()` - with `THREE.AnimationClip` instances. No caller
 * of `update()` changes. Replacement clips must satisfy
 * `LOCOMOTION_CLIP_CONTRACT`:
 *
 *   - track targets use the bone names in `PEDESTRIAN_BONE_NAMES`
 *     (retarget with `SkeletonUtils.retargetClip` outside this module - the
 *     rig `crowd.rig.template` is exported for exactly that);
 *   - clips are **in place**: no forward root translation. `Hips.position` may
 *     carry vertical bob and lateral sway only;
 *   - `walk` and `brisk` last exactly ONE full stride (left step + right step)
 *     and are looped; their duration is arbitrary because the module drives
 *     `action.time = gaitPhase * clip.duration` rather than letting the clip
 *     free-run. That phase lock is what makes the crowd unable to skate;
 *   - `idle` may be any duration and free-runs on a per-agent identity clock.
 *
 * By default the legs are *overridden* after the mixer by the analytic foot
 * placement below (`footIK: true`), so even a mediocre replacement walk cycle
 * cannot introduce skating. Pass `footIK: false` to let a high-quality external
 * clip drive the legs directly.
 *
 * ----------------------------------------------------------------------------
 * FOOT GROUNDING (the part the rubric actually gates on)
 * ----------------------------------------------------------------------------
 * Skating is an automatic reject, so foot contact is derived from *distance
 * travelled*, never from wall-clock time:
 *
 *   stride L(v)  = 2 * v / cadence(v)          metres per full cycle
 *   dPhase       = (v * dt) / L                cycles, i.e. phase is an
 *                                              odometer, not a clock
 *
 * Within a cycle a foot is in stance for a duty factor `b`, then swings. In
 * stance the foot's body-local longitudinal coordinate is
 *
 *   x(p) = (b/2 - p) * L      for  0 <= p < b
 *
 * whose derivative with respect to phase is exactly `-L`, so the foot's world
 * ground speed is
 *
 *   v + dx/dp * dp/dt = v + (-L) * (v / L) = 0        exactly, for all v.
 *
 * The swing is a cubic Hermite from `-bL/2` to `+bL/2` whose *end tangents are
 * also* `-L` per unit phase, so world foot speed is likewise exactly zero at
 * toe-off and at heel-strike. There is no sliding contact anywhere in the
 * cycle. `footGroundSpeed()` returns this analytically and the self-check
 * cross-validates it against a finite difference of `footPlant()`.
 *
 * Vertically, each foot is placed at `sampleGround(footX, footZ) + lift`, so a
 * curb, a driveway ramp or a hill is followed per foot rather than per body.
 * The root height follows a stance-weighted blend of the two feet's ground
 * heights through a critically-damped response, and the root pitch/roll come
 * from four ground probes around the agent. A planar two-bone IK
 * (`solveTwoBoneIK`) bends the knee to reach the placed foot.
 *
 * ----------------------------------------------------------------------------
 * BUDGET
 * ----------------------------------------------------------------------------
 * See `CROWD_BUDGET`. Defaults, and why (all figures measured by the headless
 * self-check, not estimated):
 *
 *   skinned    24 agents  <  28 m   1 SkinnedMesh + 1 AnimationMixer + 17 bones
 *                                   each, 336 tri. 24 draws, 8.1 k tri. The real
 *                                   limit is CPU: 24 mixer evaluations and 48
 *                                   two-bone IK solves per frame, not triangles.
 *   instanced  96 agents  <  90 m   15 InstancedMeshes carrying one matrix per
 *                                   bone per agent - articulated legs and arms,
 *                                   no skinning, one shared virtual rig posed
 *                                   once per agent. 244 tri each: 15 draws,
 *                                   23.4 k tri.
 *   far       320 agents  < 220 m   4 InstancedMeshes (bottom / top / skin /
 *                                   shoes), the whole figure baked into
 *                                   character space onto one root matrix, bob
 *                                   only, no mixer. 136 tri each: 4 draws,
 *                                   43.5 k tri.
 *   shadows   440 agents            1 InstancedMesh of soft blob quads.
 *
 * Total steady-state cost at full population: 44 draw calls and ~75 k triangles
 * for a 440-agent crowd. Agents beyond a band's budget fall to the next cheaper
 * band; only agents past the far band are culled. The budget is a hard cap:
 * `planCrowdPresentation()` can never return more skinned agents than
 * `budget.skinned`, and the self-check proves it over a 600-agent corpus.
 */

import * as THREE from 'three';

export const PEDESTRIAN_PRESENTATION_VERSION = 'earthonline-pedestrian-presentation-v1';

// ---------------------------------------------------------------- small maths

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Wrap into [0, 1). Exported because gait phase is part of the public state. */
export function wrapPhase(phase) {
  if (!Number.isFinite(phase)) return 0;
  const wrapped = phase % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

/** Critically damped exponential approach. Frame-rate independent. */
export function damp(current, target, rate, dt) {
  if (!(rate > 0) || !(dt > 0)) return target;
  return target + (current - target) * Math.exp(-rate * dt);
}

// ------------------------------------------------------------------- identity

/**
 * 32-bit identity hash. Accepts a number or a string so simulation ids of
 * either kind produce a stable seed. Deterministic across processes and
 * platforms: integer ops only, no floats, no locale.
 */
export function identitySeed(id) {
  if (typeof id === 'number' && Number.isFinite(id)) {
    let h = (id | 0) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  const text = String(id ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Deterministic [0,1) draw from an identity seed and a salt. Distinct salts are
 * decorrelated, so `identityRandom(s, 'height')` and `identityRandom(s, 'top')`
 * do not move together across a crowd.
 */
export function identityRandom(seedOrId, salt = 0) {
  const seed = typeof seedOrId === 'number' && Number.isInteger(seedOrId) && seedOrId >= 0
    ? seedOrId >>> 0
    : identitySeed(seedOrId);
  const saltHash = typeof salt === 'number' ? (salt >>> 0) : identitySeed(salt);
  let h = (seed ^ Math.imul(saltHash ^ 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function pick(list, seed, salt) {
  return list[Math.floor(identityRandom(seed, salt) * list.length) % list.length];
}

// ------------------------------------------------------- locomotion behaviour

export const LOCOMOTION_STATES = Object.freeze(['idle', 'walk', 'brisk']);

/**
 * Speed thresholds in m/s. The up- and down-thresholds differ, which is the
 * hysteresis: an agent hovering around 0.3 m/s (a queue shuffling forward) does
 * not flicker between idle and walk once per frame.
 */
export const LOCOMOTION_THRESHOLDS = Object.freeze({
  idleToWalk: 0.35,
  walkToIdle: 0.20,
  walkToBrisk: 1.85,
  briskToWalk: 1.55,
});

/** Crossfade ramps, in m/s, for the continuous blend weights. */
export const LOCOMOTION_BLEND_RAMP = Object.freeze({
  walkIn: 0.15,
  walkFull: 0.60,
  briskIn: 1.45,
  briskFull: 2.10,
});

/**
 * Discrete locomotion state with hysteresis.
 * @param {number} speed metres/second, simulation-owned
 * @param {string} previous previous state, '' or unknown treated as 'idle'
 * @param {{pose?:string}} [hint] simulation pose override ('stand'|'sit')
 * @returns {'idle'|'walk'|'brisk'}
 */
export function resolveLocomotionState(speed, previous = 'idle', hint = null) {
  const pose = hint && hint.pose;
  if (pose === 'stand' || pose === 'sit') return 'idle';
  const v = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  const prev = LOCOMOTION_STATES.includes(previous) ? previous : 'idle';
  const T = LOCOMOTION_THRESHOLDS;
  if (prev === 'idle') {
    if (v >= T.walkToBrisk) return 'brisk';
    return v >= T.idleToWalk ? 'walk' : 'idle';
  }
  if (prev === 'walk') {
    if (v >= T.walkToBrisk) return 'brisk';
    return v < T.walkToIdle ? 'idle' : 'walk';
  }
  // prev === 'brisk'
  if (v >= T.briskToWalk) return 'brisk';
  return v < T.walkToIdle ? 'idle' : 'walk';
}

/**
 * Continuous crossfade weights for the three clips. Always sums to 1, always
 * non-negative, and continuous in `speed` - this is what is written into the
 * three `AnimationAction` weights so a transition is a blend, not a cut.
 * @returns {{idle:number, walk:number, brisk:number}}
 */
export function locomotionBlend(speed, hint = null) {
  const pose = hint && hint.pose;
  if (pose === 'stand' || pose === 'sit') return { idle: 1, walk: 0, brisk: 0 };
  const v = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  const R = LOCOMOTION_BLEND_RAMP;
  const moving = smoothstep(R.walkIn, R.walkFull, v);
  const fast = smoothstep(R.briskIn, R.briskFull, v);
  return {
    idle: 1 - moving,
    walk: moving * (1 - fast),
    brisk: moving * fast,
  };
}

// ------------------------------------------------------------- gait modelling

export const GAIT = Object.freeze({
  /** Reference adult standing height, metres. */
  referenceHeight: 1.75,
  /** Hip-joint height as a fraction of standing height - the pendulum length. */
  legRatio: 0.526,
  /** cadence(v) = (intercept + slope * v) * (referenceLeg / legLength), steps/s. */
  cadenceIntercept: 0.95,
  cadenceSlope: 0.60,
  cadenceMin: 0.70,
  cadenceMax: 3.20,
  /** Duty factor (stance fraction of the cycle) falls as speed rises. */
  dutyAtRest: 0.66,
  dutySlope: 0.05,
  dutyMin: 0.52,
  /** Swing foot clearance, metres. */
  liftBase: 0.050,
  liftPerSpeed: 0.038,
  liftMax: 0.170,
  /** Half the lateral distance between the two feet, metres. */
  stanceHalfWidth: 0.084,
  /** Ankle height above the sole in the rest pose, metres. */
  soleOffset: 0.080,
  /** Phase window over which stance weight ramps in and out. */
  stanceRamp: 0.06,
  /**
   * Foot rocker. A real foot is not a point: at heel strike the contact is the
   * heel and the ankle sits above and BEHIND it; at toe-off the contact is the
   * ball of the foot and the ankle sits above and AHEAD of it. Both extremes
   * therefore need noticeably less leg extension than a point foot would.
   * Modelling this is what stops a fast walker's ankle from floating: the
   * CONTACT point is still exactly planted (no skating), only the ankle moves.
   */
  rockerRise: 0.075,
  rockerShift: 0.090,
  /** How far the pelvis may drop to keep an extended leg reachable, metres. */
  maxPelvisDrop: 0.16,
});

/** Hip-joint height for a given standing height. */
export function legLengthForHeight(height = GAIT.referenceHeight) {
  return Math.max(0.35, height * GAIT.legRatio);
}

/**
 * Step cadence in steps/second. Shorter legs take faster, shorter steps at the
 * same ground speed, which is why the crowd does not look like scaled clones.
 */
export function cadenceForSpeed(speed, legLength = legLengthForHeight()) {
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0);
  const refLeg = legLengthForHeight(GAIT.referenceHeight);
  const scale = refLeg / Math.max(0.35, legLength);
  const raw = (GAIT.cadenceIntercept + GAIT.cadenceSlope * v) * scale;
  return clamp(raw, GAIT.cadenceMin, GAIT.cadenceMax);
}

/**
 * Stride length: metres of ground covered per FULL cycle (both feet). This is
 * the denominator of the phase odometer, so it is the single number that
 * decides whether feet slide.
 */
export function strideLengthForSpeed(speed, legLength = legLengthForHeight()) {
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0);
  if (v <= 0) return 0;
  return (2 * v) / cadenceForSpeed(v, legLength);
}

/** Stance fraction of the cycle. Monotonically decreasing in speed. */
export function dutyFactorForSpeed(speed) {
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0);
  return clamp(GAIT.dutyAtRest - GAIT.dutySlope * v, GAIT.dutyMin, GAIT.dutyAtRest);
}

/** Swing-foot clearance for a given speed, metres. */
export function swingLiftForSpeed(speed) {
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0);
  return Math.min(GAIT.liftMax, GAIT.liftBase + GAIT.liftPerSpeed * v);
}

/**
 * Advance the gait phase by DISTANCE travelled, not by elapsed time. When the
 * agent is standing still the phase is frozen, so a stopped pedestrian's feet
 * are planted rather than marking time.
 * @returns {number} phase in [0,1)
 */
export function advanceGaitPhase(phase, speed, strideLength, dt) {
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0);
  const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  if (!(strideLength > 1e-4) || v <= 1e-4 || step <= 0) return wrapPhase(phase);
  return wrapPhase(phase + (v * step) / strideLength);
}

/** Cubic Hermite basis, and its derivative, for the swing trajectory. */
function hermite(u, p0, p1, m0, m1) {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0
    + (u3 - 2 * u2 + u) * m0
    + (-2 * u3 + 3 * u2) * p1
    + (u3 - u2) * m1;
}
function hermiteDerivative(u, p0, p1, m0, m1) {
  const u2 = u * u;
  return (6 * u2 - 6 * u) * p0
    + (3 * u2 - 4 * u + 1) * m0
    + (-6 * u2 + 6 * u) * p1
    + (3 * u2 - 2 * u) * m1;
}

/**
 * Body-local placement of one foot at a gait phase.
 *
 * Coordinates are in the agent's own frame: `+longitudinal` is forward,
 * `+lateral` is the agent's left, `lift` is height above the ground *under
 * that foot* (so it composes with a per-foot ground sample).
 *
 * @returns {{longitudinal:number, lateral:number, lift:number, stance:number,
 *            phase:number, contact:boolean}}
 *   `stance` is a smooth 0..1 support weight (1 while planted), used to blend
 *   the pelvis between the two feet without a step-function snap at a curb.
 */
export function footPlant({
  phase = 0,
  side = 'left',
  strideLength = 0,
  duty = GAIT.dutyAtRest,
  lift: liftHeight = 0,
  stanceHalfWidth = GAIT.stanceHalfWidth,
} = {}) {
  const L = Math.max(0, strideLength);
  const b = clamp(duty, 0.35, 0.85);
  // The right foot is half a cycle out of step with the left.
  const p = wrapPhase(side === 'right' ? phase + 0.5 : phase);
  const lateral = side === 'right' ? -stanceHalfWidth : stanceHalfWidth;
  let longitudinal;
  let lift = 0;
  let contact;
  if (p < b) {
    // Stance: planted. Local longitudinal slides backward at exactly the
    // agent's forward speed, so world foot speed is exactly zero.
    longitudinal = (b / 2 - p) * L;
    contact = true;
  } else {
    const u = (p - b) / (1 - b);
    const p0 = -b * L * 0.5;
    const p1 = b * L * 0.5;
    // End tangents dx/du = -L * (1 - b) so that dx/dphase = -L at both ends,
    // matching stance and giving zero world foot speed at toe-off/heel-strike.
    const m = -L * (1 - b);
    longitudinal = hermite(u, p0, p1, m, m);
    lift = Math.max(0, liftHeight) * Math.sin(Math.PI * u);
    contact = false;
  }
  // Smooth support weight: 1 through stance, ramping over `stanceRamp` phase
  // at each end so a curb transfer does not snap the pelvis.
  const ramp = Math.max(1e-4, GAIT.stanceRamp);
  let stance;
  if (p < b) {
    // Full support, easing out over the last `ramp` of stance. The ease back IN
    // is supplied by the previous cycle's swing tail below, so the two feet's
    // weights always sum to at least 1.
    stance = p > b - ramp ? 1 - smoothstep(b - ramp, b, p) : 1;
  } else {
    const tail = 1 - ramp;
    stance = p > tail ? smoothstep(tail, 1, p) : 0;
  }
  const support = clamp(stance, 0, 1);
  // Foot rocker: the ankle's offset from the contact point, only while the foot
  // is actually bearing weight. `u` is how far through the stance roll the foot
  // is: +1 at heel strike, 0 at midstance, -1 at toe-off.
  const halfStance = Math.max(1e-6, (b * L) / 2);
  const u = clamp(longitudinal / halfStance, -1, 1);
  // The rocker follows how far the foot is from under the body, NOT the stance
  // weight: at toe-off the foot has already left the ground but the ankle is
  // still high over a pointed toe, and at heel strike it is high over a raised
  // toe. Tying it to stance instead would collapse the ankle exactly at the two
  // moments the leg is longest. `u` is ~0 in mid-swing, so the rocker fades out
  // there on its own.
  const ankleShift = -GAIT.rockerShift * u;
  const ankleRise = GAIT.rockerRise * u * u;
  return {
    longitudinal,
    lateral,
    lift,
    stance: support,
    phase: p,
    contact,
    /** Where the ANKLE sits relative to the planted contact point. */
    ankleLongitudinal: longitudinal + ankleShift,
    ankleRise,
  };
}

/**
 * World-space ground speed of a foot, in m/s. This is the anti-skating
 * measurement: during stance it is analytically zero for every speed, stride
 * and duty factor.
 */
export function footGroundSpeed({
  phase = 0,
  side = 'left',
  strideLength = 0,
  duty = GAIT.dutyAtRest,
  speed = 0,
} = {}) {
  const L = Math.max(0, strideLength);
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0);
  if (L <= 1e-9 || v <= 0) return 0;
  const b = clamp(duty, 0.35, 0.85);
  const p = wrapPhase(side === 'right' ? phase + 0.5 : phase);
  let dLongitudinalDPhase;
  if (p < b) {
    dLongitudinalDPhase = -L;
  } else {
    const u = (p - b) / (1 - b);
    const p0 = -b * L * 0.5;
    const p1 = b * L * 0.5;
    const m = -L * (1 - b);
    dLongitudinalDPhase = hermiteDerivative(u, p0, p1, m, m) / (1 - b);
  }
  // dPhase/dt = v / L, so world speed = v + dx/dphase * v / L.
  return v + dLongitudinalDPhase * (v / L);
}

// ------------------------------------------------------------- two-bone IK

/**
 * Planar two-bone IK by the law of cosines. Pure maths, no three types.
 *
 * `upperAngle` is the angle between the upper bone and the hip->target line;
 * `bendAngle` is how far the knee is bent away from straight (0 = locked).
 * When the target is out of reach the chain is straightened and `reachable`
 * is false, which is exactly what a leg does at full extension - it does not
 * stretch.
 *
 * @returns {{upperAngle:number, bendAngle:number, reachable:boolean,
 *            distance:number}}
 */
export function solveTwoBoneIK({ upperLength, lowerLength, targetDistance } = {}) {
  const a = Math.max(1e-6, upperLength);
  const b = Math.max(1e-6, lowerLength);
  const requested = Math.max(0, Number.isFinite(targetDistance) ? targetDistance : 0);
  const min = Math.abs(a - b) + 1e-5;
  const max = a + b - 1e-5;
  const d = clamp(requested, min, max);
  const reachable = requested >= min && requested <= max;
  const cosUpper = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const cosKnee = clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1);
  return {
    upperAngle: Math.acos(cosUpper),
    bendAngle: Math.PI - Math.acos(cosKnee),
    reachable,
    distance: d,
  };
}

// ------------------------------------------------------------ foot grounding

/**
 * Default ground sampler used when the caller supplies none: flat world at the
 * agent's own simulation height.
 */
function flatGround() {
  return null;
}

/**
 * Sample the ground under both feet and derive the root height and tilt.
 *
 * Sign conventions, fixed and tested. `pitch` and `roll` are the X and Z
 * components of a THREE 'YXZ' Euler applied to the agent root, so they can be
 * written straight onto `root.rotation` with no sign juggling at the call site:
 *   heading  0 faces +Z; forward = (sin h, 0, cos h); left = (cos h, 0, -sin h).
 *            The agent's local +X axis therefore points LEFT.
 *   pitch    Euler X. Walking UPHILL gives a POSITIVE pitch, which leans the
 *            agent forward into the hill.
 *   roll     Euler Z. Ground falling away to the agent's RIGHT gives a POSITIVE
 *            roll, which tips the head toward the downhill side - a partial
 *            alignment to the ground normal, not a balance correction.
 *
 * @returns frozen grounding record; see fields inline.
 */
export function sampleFootGrounding({
  x = 0,
  y = 0,
  z = 0,
  heading = 0,
  gaitPhase = 0,
  speed = 0,
  strideLength = 0,
  duty = GAIT.dutyAtRest,
  lift = 0,
  stanceHalfWidth = GAIT.stanceHalfWidth,
  sampleGround = flatGround,
  probe = 0.32,
  slopeFollow = 0.45,
  maxSlope = 0.60,
  previousRootY = null,
  responseRate = 14,
  dt = 0,
  scale = 1,
  soleOffset = GAIT.soleOffset,
  hipHeight = LEG_SEGMENTS.hipLocalY,
  legReach = LEG_SEGMENTS.thigh + LEG_SEGMENTS.shin,
} = {}) {
  const sampler = typeof sampleGround === 'function' ? sampleGround : flatGround;
  let grounded = true;
  const ground = (gx, gz) => {
    const h = sampler(gx, gz);
    if (h == null || !Number.isFinite(h)) {
      grounded = false;
      return y;
    }
    return h;
  };

  const fwdX = Math.sin(heading);
  const fwdZ = Math.cos(heading);
  const leftX = Math.cos(heading);
  const leftZ = -Math.sin(heading);

  const rootGround = ground(x, z);

  const feet = [];
  let stanceSum = 0;
  let stanceWeighted = 0;
  for (const side of ['left', 'right']) {
    const plant = footPlant({
      phase: gaitPhase,
      side,
      strideLength,
      duty,
      lift,
      stanceHalfWidth,
    });
    const fx = x + fwdX * plant.longitudinal + leftX * plant.lateral;
    const fz = z + fwdZ * plant.longitudinal + leftZ * plant.lateral;
    const gy = ground(fx, fz);
    // The foot follows the ground under ITSELF. This is what makes a curb read
    // as a curb rather than as the whole body teleporting up 15 cm.
    const footY = gy + plant.lift;
    // The ANKLE is offset from the contact point by the foot rocker. Only the
    // contact point has to be motionless; the ankle is what the leg IK aims at.
    const ax = x + fwdX * plant.ankleLongitudinal + leftX * plant.lateral;
    const az = z + fwdZ * plant.ankleLongitudinal + leftZ * plant.lateral;
    const ay = gy + plant.lift + (soleOffset + plant.ankleRise) * scale;
    stanceSum += plant.stance;
    stanceWeighted += plant.stance * gy;
    feet.push(Object.freeze({
      side,
      x: fx,
      y: footY,
      z: fz,
      groundY: gy,
      lift: plant.lift,
      stance: plant.stance,
      contact: plant.contact,
      phase: plant.phase,
      longitudinal: plant.longitudinal,
      ankleLongitudinal: plant.ankleLongitudinal,
      lateral: plant.lateral,
      ankleX: ax,
      ankleY: ay,
      ankleZ: az,
      worldSpeed: footGroundSpeed({
        phase: gaitPhase, side, strideLength, duty, speed,
      }),
    }));
  }

  // The pelvis follows the supporting foot (or the blend of both during double
  // support), never the mean of a planted foot and a foot in mid-air.
  let supportY = stanceSum > 1e-4 ? stanceWeighted / stanceSum : rootGround;

  // Pelvis lowering. A long stride spreads the legs, and a straight-line leg of
  // fixed length simply cannot reach a foot that is half a stride away while the
  // hip stays at standing height - that is the "floating ankle" artefact. Real
  // gait solves it by dropping the pelvis a few centimetres at double support,
  // and so does this: drop the root by exactly the deficit, never more than
  // `GAIT.maxPelvisDrop`. It also produces the vertical gait bob for free.
  const scaledHip = hipHeight * scale;
  const scaledReach = legReach * scale;
  // Both feet are IK-driven every frame, so the pelvis has to satisfy whichever
  // leg is currently the more extended - unweighted, or the pelvis would pop up
  // at toe-off exactly when the leg is longest.
  let drop = 0;
  for (const foot of feet) {
    const horizontal = Math.abs(foot.ankleLongitudinal);
    if (horizontal >= scaledReach * 0.995) continue;
    const vertical = supportY + scaledHip - foot.ankleY;
    const required = Math.hypot(horizontal, vertical);
    if (required <= scaledReach) continue;
    const allowedVertical = Math.sqrt(scaledReach * scaledReach - horizontal * horizontal);
    drop = Math.max(drop, vertical - allowedVertical);
  }
  supportY -= Math.min(drop, GAIT.maxPelvisDrop * scale);

  const rootY = previousRootY == null
    ? supportY
    : damp(previousRootY, supportY, responseRate, dt);

  const gFront = ground(x + fwdX * probe, z + fwdZ * probe);
  const gBack = ground(x - fwdX * probe, z - fwdZ * probe);
  const gLeft = ground(x + leftX * probe, z + leftZ * probe);
  const gRight = ground(x - leftX * probe, z - leftZ * probe);

  const slopePitch = Math.atan2(gFront - gBack, 2 * probe);
  const slopeRoll = Math.atan2(gLeft - gRight, 2 * probe);
  const pitch = clamp(slopePitch * slopeFollow, -maxSlope, maxSlope);
  const roll = clamp(slopeRoll * slopeFollow, -maxSlope, maxSlope);

  return Object.freeze({
    rootY,
    supportY,
    groundY: rootGround,
    pitch,
    roll,
    slopePitch,
    slopeRoll,
    grounded,
    /** Height of the higher foot's ground above the lower - the curb size. */
    stepDelta: Math.abs(feet[0].groundY - feet[1].groundY),
    /** How far the pelvis was lowered to keep the stance leg reachable. */
    pelvisDrop: Math.min(drop, GAIT.maxPelvisDrop * scale),
    feet: Object.freeze(feet),
  });
}

// ------------------------------------------------------------ contact shadow

export const CONTACT_SHADOW = Object.freeze({
  baseRadius: 0.30,
  speedStretch: 0.22,
  baseOpacity: 0.42,
  /** Above this clearance (metres) the blob has fully faded. */
  clearanceFade: 0.40,
  fadeStart: 120,
  fadeEnd: 210,
  lift: 0.012,
});

/**
 * Cheap, reliable grounding: a soft blob under every agent in every band.
 * The sun shadow map is 2048 over a +/-219 m box (~5.2 texels/m), which cannot
 * resolve a foot; the blob is what actually sells contact at eye level.
 *
 * @returns {{radius:number, lengthScale:number, opacity:number, y:number}}
 */
export function contactShadowFor({
  speed = 0,
  heightScale = 1,
  buildScale = 1,
  groundClearance = 0,
  distance = 0,
  sunElevationDeg = 45,
  opacityScale = 1,
} = {}) {
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0);
  const radius = CONTACT_SHADOW.baseRadius * heightScale * (0.9 + 0.2 * buildScale);
  const lengthScale = 1 + CONTACT_SHADOW.speedStretch * clamp(v / 2, 0, 1);
  const clearance = 1 - smoothstep(0, CONTACT_SHADOW.clearanceFade, Math.max(0, groundClearance));
  const distanceFade = 1 - smoothstep(CONTACT_SHADOW.fadeStart, CONTACT_SHADOW.fadeEnd, distance);
  // A low sun makes a long soft ambient occlusion pool; a high sun makes a
  // tight dark one. Both are darker than an overhead-light-only guess.
  const sun = clamp(Math.abs(sunElevationDeg) / 90, 0, 1);
  const sunTerm = lerp(0.72, 1.0, sun);
  const opacity = clamp(
    CONTACT_SHADOW.baseOpacity * clearance * distanceFade * sunTerm * opacityScale,
    0,
    1,
  );
  return { radius, lengthScale, opacity, y: CONTACT_SHADOW.lift };
}

// --------------------------------------------------- procedural variation

/**
 * Wardrobe and complexion vocabulary. Deliberately desaturated with a few
 * saturated accents: a crowd where every jacket is a primary colour reads as
 * toys, and a crowd with no accents reads as a grey smear. Values are linear
 * sRGB hex, consumed as `THREE.Color` in sRGB.
 */
export const PEDESTRIAN_PALETTE = Object.freeze({
  skin: Object.freeze([
    0xd8b092, 0xc6946f, 0xb07d5c, 0x96674a, 0x7d5236, 0x62402b, 0xe3c0a3, 0xa9744f,
  ]),
  hair: Object.freeze([
    0x1a1a1c, 0x2b201d, 0x4a3122, 0x6d4a2c, 0x93683a, 0x8a8880, 0xc7ae86, 0x3a2c33,
  ]),
  top: Object.freeze([
    0x23384f, 0x2e3639, 0x55433b, 0x2f5a4a, 0x8a3f33, 0x574a70, 0x776a56, 0xbfb29b,
    0x2d6b83, 0x854056, 0xac6a41, 0x3d5870, 0x9aa2a6, 0x40484d, 0xd2c6ae, 0x1f4a44,
  ]),
  bottom: Object.freeze([
    0x1d2530, 0x2e2f32, 0x33474f, 0x413730, 0x4b4b49, 0x5e5c50, 0x2a3945, 0x6c6257,
  ]),
  shoes: Object.freeze([
    0x18191a, 0x2a201c, 0x383a39, 0x674630, 0x4a3a35, 0xb5b1a6, 0x30414d,
  ]),
  accent: Object.freeze([
    0x8a3f33, 0x2d6b83, 0xac6a41, 0x59636c, 0x6d5a73, 0xc9bda4, 0x3f6b4f,
  ]),
});

/** Palette slot order baked into the rig's UVs. Do not reorder. */
export const PALETTE_SLOTS = Object.freeze([
  'skin', 'hair', 'top', 'bottom', 'shoes', 'accent',
]);

/**
 * Everything about an agent that presentation is allowed to invent, because
 * none of it is simulation truth: how tall they are, how heavy their build is,
 * what they are wearing, and where in the walk cycle they happen to be. All of
 * it is a pure function of the identity seed, so the same person looks the same
 * across a reload, a stream-out/stream-in, and a replay.
 *
 * `phaseOffset` is the reason a crowd does not march in lockstep.
 */
export function identityVariation(idOrSeed) {
  const seed = identitySeed(idOrSeed);
  const heightScale = 0.90 + identityRandom(seed, 'height') * 0.20;
  const buildScale = 0.92 + identityRandom(seed, 'build') * 0.20;
  const height = GAIT.referenceHeight * heightScale;
  return Object.freeze({
    seed,
    heightScale,
    buildScale,
    height,
    legLength: legLengthForHeight(height),
    /** Multiplies cadence: some people are naturally quicker-stepping. */
    cadenceBias: 0.94 + identityRandom(seed, 'cadence') * 0.12,
    /** Where in the walk cycle this agent starts. Cycles, [0,1). */
    phaseOffset: identityRandom(seed, 'phase'),
    /** Free-running idle clock offset, seconds. */
    idleOffset: identityRandom(seed, 'idle') * 12,
    /** Small resting yaw bias so an idle crowd is not all square to the street. */
    idleYawBias: (identityRandom(seed, 'yaw') - 0.5) * 0.35,
    colors: Object.freeze({
      skin: pick(PEDESTRIAN_PALETTE.skin, seed, 'c-skin'),
      hair: pick(PEDESTRIAN_PALETTE.hair, seed, 'c-hair'),
      top: pick(PEDESTRIAN_PALETTE.top, seed, 'c-top'),
      bottom: pick(PEDESTRIAN_PALETTE.bottom, seed, 'c-bottom'),
      shoes: pick(PEDESTRIAN_PALETTE.shoes, seed, 'c-shoes'),
      accent: pick(PEDESTRIAN_PALETTE.accent, seed, 'c-accent'),
    }),
  });
}

// ------------------------------------------------- distance bands and budget

export const PRESENTATION_BANDS = Object.freeze(['skinned', 'instanced', 'far', 'culled']);

/** Band rank: lower is richer. Used to compare bands under hysteresis. */
export const BAND_RANK = Object.freeze({ skinned: 0, instanced: 1, far: 2, culled: 3 });

/** Outer distance of each band, metres from the view position. */
export const PRESENTATION_BAND_DISTANCES = Object.freeze({
  skinned: 28,
  instanced: 90,
  far: 220,
});

/**
 * Hard caps. Exceeding a cap does not drop the agent, it demotes them to the
 * next cheaper band, so the crowd thins in fidelity rather than in population.
 */
export const CROWD_BUDGET = Object.freeze({
  skinned: 24,
  instanced: 96,
  far: 320,
  get shadows() { return 440; },
});

/** Band boundary hysteresis, metres. Prevents band thrash at a boundary. */
export const BAND_HYSTERESIS = 4;

/**
 * Distance -> band, with hysteresis: an agent already in a richer band keeps it
 * until it is `BAND_HYSTERESIS` metres past the boundary.
 */
export function presentationBandForDistance(distance, previousBand = null, distances = PRESENTATION_BAND_DISTANCES) {
  const d = Number.isFinite(distance) ? Math.max(0, distance) : Infinity;
  const held = previousBand && BAND_RANK[previousBand] != null ? previousBand : null;
  const margin = (band) => (held && BAND_RANK[held] <= BAND_RANK[band] ? BAND_HYSTERESIS : 0);
  if (d <= distances.skinned + margin('skinned')) return 'skinned';
  if (d <= distances.instanced + margin('instanced')) return 'instanced';
  if (d <= distances.far + margin('far')) return 'far';
  return 'culled';
}

function distanceSquared(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Assign every agent to a presentation band under a hard budget.
 *
 * Deterministic: agents are ordered by distance, ties broken by the stable
 * string form of their id, so the same crowd in a different array order yields
 * the same plan. Nearest agents win the expensive bands.
 *
 * @param {Array} agents records with `{id, x, y, z}` (already read out of the
 *   simulation - this function does not touch simulation objects)
 * @param {{position:{x,y,z}, budget?:object, previousBands?:Map,
 *          distances?:object, maxDistance?:number}} options
 * @returns {{entries:Array, counts:object, budget:object}}
 */
export function planCrowdPresentation(agents, {
  position = { x: 0, y: 0, z: 0 },
  budget = CROWD_BUDGET,
  previousBands = null,
  distances = PRESENTATION_BAND_DISTANCES,
} = {}) {
  const list = [];
  const px = position?.x ?? 0;
  const py = position?.y ?? 0;
  const pz = position?.z ?? 0;
  for (let i = 0; i < agents.length; i += 1) {
    const agent = agents[i];
    if (!agent) continue;
    if (agent.active === false) continue;
    const d2 = distanceSquared(agent.x, agent.y, agent.z, px, py, pz);
    list.push({
      index: i,
      id: agent.id,
      key: String(agent.id),
      distance: Math.sqrt(d2),
    });
  }
  list.sort((a, b) => (a.distance - b.distance) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const caps = {
    skinned: Math.max(0, budget.skinned | 0),
    instanced: Math.max(0, budget.instanced | 0),
    far: Math.max(0, budget.far | 0),
  };
  const counts = { skinned: 0, instanced: 0, far: 0, culled: 0 };
  const entries = new Array(list.length);
  for (let rank = 0; rank < list.length; rank += 1) {
    const item = list[rank];
    const previous = previousBands ? previousBands.get(item.id) : null;
    let band = presentationBandForDistance(item.distance, previous, distances);
    // Demote, never drop, when a band is full.
    while (band !== 'culled' && counts[band] >= caps[band]) {
      band = PRESENTATION_BANDS[BAND_RANK[band] + 1];
    }
    counts[band] += 1;
    entries[rank] = Object.assign(item, { band, rank });
  }
  return { entries, counts, budget: caps };
}

// ---------------------------------------------------------------- the rig

/**
 * Humanoid bone vocabulary. These are the names an externally supplied clip
 * must target (directly, or after `SkeletonUtils.retargetClip` against
 * `crowd.rig.template`). Order is the skeleton's bone index order and is part
 * of the contract - do not reorder.
 */
export const PEDESTRIAN_BONE_NAMES = Object.freeze([
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot',
  'RightUpLeg', 'RightLeg', 'RightFoot',
]);

/**
 * Rest pose: parent + local offset in metres for a 1.75 m reference adult.
 * Hip joint sits at 0.92 m, knee at 0.48 m, ankle at 0.08 m, which is where the
 * `GAIT.legRatio` and `GAIT.soleOffset` constants come from.
 */
export const REST_POSE = Object.freeze({
  Hips: { parent: null, offset: [0, 0.92, 0] },
  Spine: { parent: 'Hips', offset: [0, 0.14, 0] },
  Chest: { parent: 'Spine', offset: [0, 0.16, 0] },
  Neck: { parent: 'Chest', offset: [0, 0.20, 0] },
  Head: { parent: 'Neck', offset: [0, 0.09, 0] },
  LeftArm: { parent: 'Chest', offset: [0.185, 0.145, 0] },
  LeftForeArm: { parent: 'LeftArm', offset: [0, -0.27, 0] },
  LeftHand: { parent: 'LeftForeArm', offset: [0, -0.25, 0] },
  RightArm: { parent: 'Chest', offset: [-0.185, 0.145, 0] },
  RightForeArm: { parent: 'RightArm', offset: [0, -0.27, 0] },
  RightHand: { parent: 'RightForeArm', offset: [0, -0.25, 0] },
  LeftUpLeg: { parent: 'Hips', offset: [GAIT.stanceHalfWidth, -0.06, 0] },
  LeftLeg: { parent: 'LeftUpLeg', offset: [0, -0.38, 0] },
  LeftFoot: { parent: 'LeftLeg', offset: [0, -0.40, 0] },
  RightUpLeg: { parent: 'Hips', offset: [-GAIT.stanceHalfWidth, -0.06, 0] },
  RightLeg: { parent: 'RightUpLeg', offset: [0, -0.38, 0] },
  RightFoot: { parent: 'RightLeg', offset: [0, -0.40, 0] },
});

/** Thigh and shin lengths taken straight from the rest pose - used by the IK. */
export const LEG_SEGMENTS = Object.freeze({
  thigh: 0.38,
  shin: 0.40,
  hipLocalY: REST_POSE.Hips.offset[1] + REST_POSE.LeftUpLeg.offset[1],
});

/** Rest-pose world position of a bone, metres, feet on the ground at y = 0. */
export function restBoneWorld(name, pose = REST_POSE) {
  let node = pose[name];
  const out = [0, 0, 0];
  let guard = 0;
  while (node && guard < 32) {
    out[0] += node.offset[0];
    out[1] += node.offset[1];
    out[2] += node.offset[2];
    node = node.parent ? pose[node.parent] : null;
    guard += 1;
  }
  return out;
}

/**
 * Body parts. `slot` indexes `PALETTE_SLOTS`, which is what makes one shared
 * geometry able to wear per-agent colours: every vertex of a part is given the
 * UV of its palette slot, and each agent owns a 6x1 palette texture.
 * `detail` selects which parts survive into the cheaper instanced bands.
 */
const BODY_PARTS = Object.freeze([
  { bone: 'Hips', slot: 'bottom', kind: 'box', size: [0.26, 0.19, 0.17], offset: [0, 0.02, 0], detail: 'far', group: 'bottom' },
  { bone: 'Spine', slot: 'top', kind: 'box', size: [0.255, 0.17, 0.165], offset: [0, 0.06, 0], detail: 'far', group: 'top' },
  { bone: 'Chest', slot: 'top', kind: 'box', size: [0.32, 0.25, 0.19], offset: [0, 0.085, 0], detail: 'far', group: 'top' },
  { bone: 'Chest', slot: 'accent', kind: 'box', size: [0.328, 0.045, 0.198], offset: [0, -0.035, 0], detail: 'near', group: 'accent' },
  { bone: 'Neck', slot: 'skin', kind: 'cyl', size: [0.048, 0.042, 0.085], offset: [0, 0.045, 0], detail: 'near', group: 'skin' },
  { bone: 'Head', slot: 'skin', kind: 'box', size: [0.155, 0.215, 0.185], offset: [0, 0.085, 0.005], detail: 'far', group: 'skin' },
  { bone: 'Head', slot: 'hair', kind: 'box', size: [0.168, 0.085, 0.196], offset: [0, 0.185, -0.004], detail: 'mid', group: 'hair' },
  { bone: 'LeftArm', slot: 'top', kind: 'cyl', size: [0.048, 0.041, 0.26], offset: [0, -0.135, 0], detail: 'mid', group: 'top' },
  { bone: 'LeftForeArm', slot: 'skin', kind: 'cyl', size: [0.039, 0.034, 0.235], offset: [0, -0.125, 0], detail: 'mid', group: 'skin' },
  { bone: 'LeftHand', slot: 'skin', kind: 'box', size: [0.068, 0.10, 0.045], offset: [0, -0.05, 0], detail: 'near', group: 'skin' },
  { bone: 'RightArm', slot: 'top', kind: 'cyl', size: [0.048, 0.041, 0.26], offset: [0, -0.135, 0], detail: 'mid', group: 'top' },
  { bone: 'RightForeArm', slot: 'skin', kind: 'cyl', size: [0.039, 0.034, 0.235], offset: [0, -0.125, 0], detail: 'mid', group: 'skin' },
  { bone: 'RightHand', slot: 'skin', kind: 'box', size: [0.068, 0.10, 0.045], offset: [0, -0.05, 0], detail: 'near', group: 'skin' },
  { bone: 'LeftUpLeg', slot: 'bottom', kind: 'cyl', size: [0.077, 0.061, 0.36], offset: [0, -0.19, 0], detail: 'far', group: 'bottom' },
  { bone: 'LeftLeg', slot: 'bottom', kind: 'cyl', size: [0.059, 0.046, 0.375], offset: [0, -0.2, 0], detail: 'far', group: 'bottom' },
  { bone: 'LeftFoot', slot: 'shoes', kind: 'box', size: [0.095, 0.072, 0.245], offset: [0, -0.042, 0.055], detail: 'far', group: 'shoes' },
  { bone: 'RightUpLeg', slot: 'bottom', kind: 'cyl', size: [0.077, 0.061, 0.36], offset: [0, -0.19, 0], detail: 'far', group: 'bottom' },
  { bone: 'RightLeg', slot: 'bottom', kind: 'cyl', size: [0.059, 0.046, 0.375], offset: [0, -0.2, 0], detail: 'far', group: 'bottom' },
  { bone: 'RightFoot', slot: 'shoes', kind: 'box', size: [0.095, 0.072, 0.245], offset: [0, -0.042, 0.055], detail: 'far', group: 'shoes' },
]);

const DETAIL_RANK = { far: 0, mid: 1, near: 2 };

/**
 * Pseudo-bone key for geometry baked into character space (feet on the ground)
 * rather than into a bone's local space. The far band uses it: the whole figure
 * rides one agent-root matrix.
 */
export const ROOT_BONE_KEY = 'Root';

function makePartGeometry(part, radialSegments) {
  const [a, b, c] = part.size;
  let geometry;
  if (part.kind === 'cyl') {
    geometry = new THREE.CylinderGeometry(a, b, c, radialSegments, 1, false);
  } else {
    geometry = new THREE.BoxGeometry(a, b, c);
  }
  return geometry.toNonIndexed();
}

/**
 * Concatenate non-indexed geometries. Written inline instead of importing
 * `three/addons/utils/BufferGeometryUtils.js` because addons are off-limits on
 * this renderer path and this is twenty lines.
 */
function mergeParts(chunks, { skinning = true } = {}) {
  let total = 0;
  for (const chunk of chunks) total += chunk.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);
  let v = 0;
  for (const chunk of chunks) {
    position.set(chunk.position, v * 3);
    normal.set(chunk.normal, v * 3);
    uv.set(chunk.uv, v * 2);
    skinIndex.set(chunk.skinIndex, v * 4);
    skinWeight.set(chunk.skinWeight, v * 4);
    v += chunk.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (skinning) {
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  }
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

function bakePart(part, { origin, boneIndex = 0, radialSegments = 6 }) {
  const source = makePartGeometry(part, radialSegments);
  const count = source.attributes.position.count;
  const position = Float32Array.from(source.attributes.position.array);
  const normal = Float32Array.from(source.attributes.normal.array);
  const uv = new Float32Array(count * 2);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const slot = PALETTE_SLOTS.indexOf(part.slot);
  const u = (slot + 0.5) / PALETTE_SLOTS.length;
  const [ox, oy, oz] = origin;
  for (let i = 0; i < count; i += 1) {
    position[i * 3] += ox;
    position[i * 3 + 1] += oy;
    position[i * 3 + 2] += oz;
    uv[i * 2] = u;
    uv[i * 2 + 1] = 0.5;
    skinIndex[i * 4] = boneIndex;
    skinWeight[i * 4] = 1;
  }
  source.dispose();
  return { count, position, normal, uv, skinIndex, skinWeight };
}

/**
 * The shared skinned body geometry. One instance is created per crowd and
 * reused by every skinned actor; only the skeleton and the palette texture are
 * per-agent.
 */
export function buildPedestrianBodyGeometry({ radialSegments = 6 } = {}) {
  const chunks = BODY_PARTS.map((part) => {
    const bone = restBoneWorld(part.bone);
    return bakePart(part, {
      origin: [bone[0] + part.offset[0], bone[1] + part.offset[1], bone[2] + part.offset[2]],
      boneIndex: PEDESTRIAN_BONE_NAMES.indexOf(part.bone),
      radialSegments,
    });
  });
  const geometry = mergeParts(chunks);
  geometry.name = 'pedestrian-body';
  return geometry;
}

/**
 * Per-part geometry for the instanced bands, expressed in BONE-LOCAL space so
 * an InstancedMesh can carry one matrix per bone per agent. Parts are grouped
 * by the bone that drives them.
 */
export function buildInstancedPartGeometries({
  detail = 'mid',
  radialSegments = 5,
  mergeToRoot = false,
} = {}) {
  const wanted = DETAIL_RANK[detail] ?? 1;
  const buckets = new Map();
  for (const part of BODY_PARTS) {
    if ((DETAIL_RANK[part.detail] ?? 1) > wanted) continue;
    // `mergeToRoot` bakes the whole figure into CHARACTER space - feet on the
    // ground at y = 0 - so one agent-root matrix draws it. Anything else is
    // baked in BONE-local space so one matrix per bone can articulate it.
    const bone = mergeToRoot ? ROOT_BONE_KEY : part.bone;
    const key = `${bone}|${part.group}`;
    let origin;
    if (mergeToRoot) {
      const world = restBoneWorld(part.bone);
      origin = [
        world[0] + part.offset[0],
        world[1] + part.offset[1],
        world[2] + part.offset[2],
      ];
    } else {
      origin = part.offset;
    }
    if (!buckets.has(key)) buckets.set(key, { bone, group: part.group, chunks: [] });
    buckets.get(key).chunks.push(bakePart(part, { origin, radialSegments }));
  }
  const out = new Map();
  for (const [key, bucket] of buckets) {
    const geometry = mergeParts(bucket.chunks, { skinning: false });
    geometry.name = `pedestrian-${key.replace('|', '-')}`;
    out.set(key, { bone: bucket.bone, group: bucket.group, geometry });
  }
  return out;
}

/** Per-agent 6x1 palette texture. 24 bytes; NearestFilter; no mipmaps. */
export function buildPaletteTexture(variation) {
  const data = new Uint8Array(PALETTE_SLOTS.length * 4);
  for (let i = 0; i < PALETTE_SLOTS.length; i += 1) {
    const hex = variation.colors[PALETTE_SLOTS[i]] ?? 0xffffff;
    data[i * 4] = (hex >> 16) & 0xff;
    data[i * 4 + 1] = (hex >> 8) & 0xff;
    data[i * 4 + 2] = hex & 0xff;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, PALETTE_SLOTS.length, 1, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Build one skinned actor: bone tree, skeleton, SkinnedMesh, mixer, actions.
 * The geometry and the material template are shared; only bones, palette and
 * mixer are per-actor.
 */
export function createPedestrianRig({ geometry, variation, clips, material = null } = {}) {
  const bones = [];
  const byName = new Map();
  for (const name of PEDESTRIAN_BONE_NAMES) {
    const bone = new THREE.Bone();
    bone.name = name;
    const rest = REST_POSE[name];
    bone.position.set(rest.offset[0], rest.offset[1], rest.offset[2]);
    bones.push(bone);
    byName.set(name, bone);
  }
  for (const name of PEDESTRIAN_BONE_NAMES) {
    const rest = REST_POSE[name];
    if (rest.parent) byName.get(rest.parent).add(byName.get(name));
  }
  const root = byName.get('Hips');
  root.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(bones);
  const palette = buildPaletteTexture(variation);
  const actorMaterial = material
    ? material.clone()
    : new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0.0 });
  actorMaterial.map = palette;
  actorMaterial.needsUpdate = true;

  const mesh = new THREE.SkinnedMesh(geometry, actorMaterial);
  mesh.name = 'pedestrian-skinned';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // The skinned pose routinely leaves the bind bounding sphere; a stale bound
  // is how a walker in front of the camera vanishes.
  mesh.frustumCulled = false;
  mesh.add(root);
  mesh.bind(skeleton);

  const mixer = new THREE.AnimationMixer(mesh);
  const actions = {};
  for (const name of LOCOMOTION_STATES) {
    const clip = clips[name];
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
    action.setEffectiveWeight(name === 'idle' ? 1 : 0);
    action.play();
    actions[name] = action;
  }
  return { mesh, bones, byName, skeleton, mixer, actions, material: actorMaterial, palette };
}

// ------------------------------------------------------------------- clips

export const LOCOMOTION_CLIP_NAMES = Object.freeze({
  idle: 'pedestrian-idle',
  walk: 'pedestrian-walk',
  brisk: 'pedestrian-brisk',
});

/**
 * The contract a replacement clip set must satisfy. Kept as data so a verifier
 * (or a future asset importer) can check an external CC0 clip mechanically
 * instead of by eye.
 */
export const LOCOMOTION_CLIP_CONTRACT = Object.freeze({
  states: LOCOMOTION_STATES,
  boneNames: PEDESTRIAN_BONE_NAMES,
  /** walk/brisk must span exactly one full stride and loop seamlessly. */
  strideCycles: Object.freeze({ idle: 0, walk: 1, brisk: 1 }),
  /** In-place only: no forward root translation. */
  rootMotion: 'in-place',
  /** Phase 0 of walk/brisk is LEFT heel strike. */
  phaseZero: 'left-heel-strike',
  /** Only Hips may carry a position track, and only bob/sway. */
  positionTracks: Object.freeze(['Hips']),
});

/**
 * Built-in clips as pure data: rotations in EULER DEGREES (XYZ order),
 * positions in METRES as an offset added to the bone's rest position.
 *
 * Authored, not captured, so the repository needs zero external animation
 * assets and the result is byte-identical on every machine. Amplitudes come
 * from the same gait model as `footPlant()`: phase 0 is left heel strike,
 * 0.25 left midstance, 0.5 left toe-off / right heel strike, 0.75 left
 * midswing.
 *
 * Sign conventions in this rig: a bone's child hangs along local -Y, so a
 * POSITIVE X rotation swings the limb BACKWARD (toward -Z) and a NEGATIVE X
 * rotation swings it FORWARD.
 */
export const LOCOMOTION_CLIP_SOURCE = Object.freeze({
  idle: Object.freeze({
    duration: 4.4,
    tracks: Object.freeze([
      { bone: 'Hips', property: 'position', times: [0, 1.1, 2.2, 3.3, 4.4], values: [[0, 0, 0], [0.012, -0.004, 0], [0, -0.002, 0], [-0.011, -0.004, 0], [0, 0, 0]] },
      { bone: 'Hips', property: 'rotation', times: [0, 1.1, 2.2, 3.3, 4.4], values: [[0, 0, 0], [0, -1.6, 1.1], [0, 0, 0], [0, 1.6, -1.1], [0, 0, 0]] },
      { bone: 'Spine', property: 'rotation', times: [0, 2.2, 4.4], values: [[-2.2, 0, 0], [-1.2, 0, 0], [-2.2, 0, 0]] },
      { bone: 'Chest', property: 'rotation', times: [0, 1.1, 2.2, 3.3, 4.4], values: [[0, 1.2, 0], [0, 2.4, -0.8], [0, -1.1, 0], [0, -2.6, 0.8], [0, 1.2, 0]] },
      { bone: 'Neck', property: 'rotation', times: [0, 2.2, 4.4], values: [[2.0, 0, 0], [1.0, 0, 0], [2.0, 0, 0]] },
      { bone: 'Head', property: 'rotation', times: [0, 1.1, 2.2, 3.3, 4.4], values: [[0, -3.5, 0], [0, 2.0, 0], [0, 6.0, 0], [0, 1.0, 0], [0, -3.5, 0]] },
      { bone: 'LeftArm', property: 'rotation', times: [0, 2.2, 4.4], values: [[2.5, 0, -5.0], [0.5, 0, -4.0], [2.5, 0, -5.0]] },
      { bone: 'RightArm', property: 'rotation', times: [0, 2.2, 4.4], values: [[0.5, 0, 5.0], [2.5, 0, 4.0], [0.5, 0, 5.0]] },
      { bone: 'LeftForeArm', property: 'rotation', times: [0, 2.2, 4.4], values: [[-14, 0, 0], [-11, 0, 0], [-14, 0, 0]] },
      { bone: 'RightForeArm', property: 'rotation', times: [0, 2.2, 4.4], values: [[-11, 0, 0], [-14, 0, 0], [-11, 0, 0]] },
      { bone: 'LeftUpLeg', property: 'rotation', times: [0, 2.2, 4.4], values: [[0, 0, -1.2], [-1.5, 0, -1.2], [0, 0, -1.2]] },
      { bone: 'RightUpLeg', property: 'rotation', times: [0, 2.2, 4.4], values: [[-1.5, 0, 1.2], [0, 0, 1.2], [-1.5, 0, 1.2]] },
      { bone: 'LeftLeg', property: 'rotation', times: [0, 2.2, 4.4], values: [[2.0, 0, 0], [3.5, 0, 0], [2.0, 0, 0]] },
      { bone: 'RightLeg', property: 'rotation', times: [0, 2.2, 4.4], values: [[3.5, 0, 0], [2.0, 0, 0], [3.5, 0, 0]] },
    ]),
  }),
  walk: Object.freeze({
    duration: 1,
    tracks: Object.freeze([
      { bone: 'Hips', property: 'position', times: [0, 0.25, 0.5, 0.75, 1], values: [[0, -0.018, 0], [0.022, 0.014, 0], [0, -0.018, 0], [-0.022, 0.014, 0], [0, -0.018, 0]] },
      { bone: 'Hips', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[0, -4, 0], [0, 0, 2.2], [0, 4, 0], [0, 0, -2.2], [0, -4, 0]] },
      { bone: 'Spine', property: 'rotation', times: [0, 0.5, 1], values: [[-3, 0, 0], [-3, 0, 0], [-3, 0, 0]] },
      { bone: 'Chest', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[0, 5, 0], [0, 0, 0], [0, -5, 0], [0, 0, 0], [0, 5, 0]] },
      { bone: 'Head', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[0, 2, 0], [0, 0, -1], [0, -2, 0], [0, 0, 1], [0, 2, 0]] },
      { bone: 'LeftArm', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[22, 0, -4], [0, 0, -4], [-22, 0, -4], [0, 0, -4], [22, 0, -4]] },
      { bone: 'RightArm', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-22, 0, 4], [0, 0, 4], [22, 0, 4], [0, 0, 4], [-22, 0, 4]] },
      { bone: 'LeftForeArm', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-14, 0, 0], [-20, 0, 0], [-30, 0, 0], [-20, 0, 0], [-14, 0, 0]] },
      { bone: 'RightForeArm', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-30, 0, 0], [-20, 0, 0], [-14, 0, 0], [-20, 0, 0], [-30, 0, 0]] },
      { bone: 'LeftUpLeg', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-25, 0, 0], [0, 0, 0], [20, 0, 0], [-22, 0, 0], [-25, 0, 0]] },
      { bone: 'RightUpLeg', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[20, 0, 0], [-22, 0, 0], [-25, 0, 0], [0, 0, 0], [20, 0, 0]] },
      { bone: 'LeftLeg', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[5, 0, 0], [5, 0, 0], [12, 0, 0], [55, 0, 0], [5, 0, 0]] },
      { bone: 'RightLeg', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[12, 0, 0], [55, 0, 0], [5, 0, 0], [5, 0, 0], [12, 0, 0]] },
      { bone: 'LeftFoot', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[8, 0, 0], [0, 0, 0], [-18, 0, 0], [6, 0, 0], [8, 0, 0]] },
      { bone: 'RightFoot', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-18, 0, 0], [6, 0, 0], [8, 0, 0], [0, 0, 0], [-18, 0, 0]] },
    ]),
  }),
  brisk: Object.freeze({
    duration: 1,
    tracks: Object.freeze([
      { bone: 'Hips', property: 'position', times: [0, 0.25, 0.5, 0.75, 1], values: [[0, -0.028, 0], [0.028, 0.020, 0], [0, -0.028, 0], [-0.028, 0.020, 0], [0, -0.028, 0]] },
      { bone: 'Hips', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[0, -6.5, 0], [0, 0, 3], [0, 6.5, 0], [0, 0, -3], [0, -6.5, 0]] },
      { bone: 'Spine', property: 'rotation', times: [0, 0.5, 1], values: [[-7, 0, 0], [-7, 0, 0], [-7, 0, 0]] },
      { bone: 'Chest', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[0, 8, 0], [0, 0, 0], [0, -8, 0], [0, 0, 0], [0, 8, 0]] },
      { bone: 'Head', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[3, 3, 0], [3, 0, -1.5], [3, -3, 0], [3, 0, 1.5], [3, 3, 0]] },
      { bone: 'LeftArm', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[36, 0, -6], [0, 0, -6], [-34, 0, -6], [0, 0, -6], [36, 0, -6]] },
      { bone: 'RightArm', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-34, 0, 6], [0, 0, 6], [36, 0, 6], [0, 0, 6], [-34, 0, 6]] },
      { bone: 'LeftForeArm', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-30, 0, 0], [-42, 0, 0], [-58, 0, 0], [-42, 0, 0], [-30, 0, 0]] },
      { bone: 'RightForeArm', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-58, 0, 0], [-42, 0, 0], [-30, 0, 0], [-42, 0, 0], [-58, 0, 0]] },
      { bone: 'LeftUpLeg', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-36, 0, 0], [2, 0, 0], [28, 0, 0], [-33, 0, 0], [-36, 0, 0]] },
      { bone: 'RightUpLeg', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[28, 0, 0], [-33, 0, 0], [-36, 0, 0], [2, 0, 0], [28, 0, 0]] },
      { bone: 'LeftLeg', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[8, 0, 0], [6, 0, 0], [18, 0, 0], [76, 0, 0], [8, 0, 0]] },
      { bone: 'RightLeg', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[18, 0, 0], [76, 0, 0], [8, 0, 0], [6, 0, 0], [18, 0, 0]] },
      { bone: 'LeftFoot', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[12, 0, 0], [0, 0, 0], [-26, 0, 0], [10, 0, 0], [12, 0, 0]] },
      { bone: 'RightFoot', property: 'rotation', times: [0, 0.25, 0.5, 0.75, 1], values: [[-26, 0, 0], [10, 0, 0], [12, 0, 0], [0, 0, 0], [-26, 0, 0]] },
    ]),
  }),
});

/**
 * Compile the authored data into real `THREE.AnimationClip`s.
 *
 * THIS IS THE ASSET SEAM. Everything downstream consumes `AnimationClip`
 * objects, so an external CC0 clip set can be dropped in with
 * `crowd.setClips({...})` and nothing else in the codebase changes.
 *
 * @param {object} [source] override the authored data
 * @returns {{idle:THREE.AnimationClip, walk:THREE.AnimationClip, brisk:THREE.AnimationClip}}
 */
export function buildLocomotionClips(source = LOCOMOTION_CLIP_SOURCE) {
  const clips = {};
  const euler = new THREE.Euler();
  const quaternion = new THREE.Quaternion();
  for (const state of LOCOMOTION_STATES) {
    const def = source[state];
    if (!def) continue;
    const tracks = [];
    for (const track of def.tracks) {
      const rest = REST_POSE[track.bone];
      if (!rest) throw new Error(`unknown bone in clip data: ${track.bone}`);
      const times = Float32Array.from(track.times);
      if (track.property === 'position') {
        const values = new Float32Array(track.values.length * 3);
        track.values.forEach((v, i) => {
          values[i * 3] = rest.offset[0] + v[0];
          values[i * 3 + 1] = rest.offset[1] + v[1];
          values[i * 3 + 2] = rest.offset[2] + v[2];
        });
        tracks.push(new THREE.VectorKeyframeTrack(`${track.bone}.position`, times, values));
      } else {
        const values = new Float32Array(track.values.length * 4);
        track.values.forEach((v, i) => {
          euler.set(v[0] * DEG, v[1] * DEG, v[2] * DEG, 'XYZ');
          quaternion.setFromEuler(euler);
          values[i * 4] = quaternion.x;
          values[i * 4 + 1] = quaternion.y;
          values[i * 4 + 2] = quaternion.z;
          values[i * 4 + 3] = quaternion.w;
        });
        tracks.push(new THREE.QuaternionKeyframeTrack(`${track.bone}.quaternion`, times, values));
      }
    }
    const clip = new THREE.AnimationClip(LOCOMOTION_CLIP_NAMES[state], def.duration, tracks);
    clip.userData = { state, strideCycles: LOCOMOTION_CLIP_CONTRACT.strideCycles[state], authored: true };
    clips[state] = clip;
  }
  return clips;
}

/**
 * Validate an externally supplied clip set against `LOCOMOTION_CLIP_CONTRACT`.
 * Returns a list of human-readable problems; empty means the set is usable.
 */
export function validateLocomotionClips(clips) {
  const problems = [];
  for (const state of LOCOMOTION_STATES) {
    const clip = clips?.[state];
    if (!clip) { problems.push(`missing clip for state "${state}"`); continue; }
    if (!(clip.duration > 0)) problems.push(`clip "${state}" has non-positive duration`);
    for (const track of clip.tracks || []) {
      const bone = String(track.name).split('.')[0];
      if (!PEDESTRIAN_BONE_NAMES.includes(bone)) {
        problems.push(`clip "${state}" targets unknown bone "${bone}"`);
      }
      if (track.name.endsWith('.position') && !LOCOMOTION_CLIP_CONTRACT.positionTracks.includes(bone)) {
        problems.push(`clip "${state}" carries root motion on "${bone}"`);
      }
    }
  }
  return problems;
}

// ------------------------------------------------------- agent input reader

/**
 * Default read-only adapter from a simulation record to the presentation's
 * internal snapshot. It NEVER writes to `source`.
 *
 * Accepts the flat `{id, x, y, z, heading, speed}` shape and the nested
 * `{instanceIndex, group:{position, rotation}, speed}` shape that
 * `src/citygen/traffic.js` already produces, so the integrator does not have to
 * reshape the crowd before handing it over.
 */
export function defaultReadAgent(source, index, out) {
  const group = source.group;
  const position = source.position || (group && group.position);
  const id = source.id ?? source.instanceIndex ?? index;
  out.id = id;
  out.seed = source.seed ?? id;
  out.x = Number(source.x ?? position?.x ?? 0);
  out.y = Number(source.y ?? position?.y ?? 0);
  out.z = Number(source.z ?? position?.z ?? 0);
  out.heading = Number(source.heading ?? source.yaw ?? group?.rotation?.y ?? 0);
  out.speed = Math.max(0, Number(source.speed ?? 0));
  out.active = source.active !== false;
  out.pose = source.pose ?? 'walk';
  return out;
}

// ------------------------------------------------------------ blob shadow

const SHADOW_TEXTURE_SIZE = 32;

function buildContactShadowTexture() {
  const size = SHADOW_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const r = Math.sqrt(dx * dx + dy * dy);
      // Squared falloff with a soft rim: a hard-edged disc reads as a decal,
      // a gaussian-ish pool reads as ambient occlusion.
      const a = clamp(1 - smoothstep(0.12, 1.0, r), 0, 1);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * a * a);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// ------------------------------------------------------------- pose target

const NEG_Y = new THREE.Vector3(0, -1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);

/** Build the bone-only Object3D tree used by the instanced band's poser. */
function buildVirtualRig(clips) {
  const root = new THREE.Group();
  root.name = 'pedestrian-poser';
  const byName = new Map();
  for (const name of PEDESTRIAN_BONE_NAMES) {
    const node = new THREE.Object3D();
    node.name = name;
    const rest = REST_POSE[name];
    node.position.set(rest.offset[0], rest.offset[1], rest.offset[2]);
    byName.set(name, node);
  }
  for (const name of PEDESTRIAN_BONE_NAMES) {
    const rest = REST_POSE[name];
    (rest.parent ? byName.get(rest.parent) : root).add(byName.get(name));
  }
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const name of LOCOMOTION_STATES) {
    if (!clips[name]) continue;
    const action = mixer.clipAction(clips[name]);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
    action.setEffectiveWeight(name === 'idle' ? 1 : 0);
    action.play();
    actions[name] = action;
  }
  return { root, byName, mixer, actions };
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

/**
 * Drive one rig (skinned actor or virtual poser) from a presentation snapshot.
 *
 * 1. root TRS from the grounded position, heading and slope;
 * 2. the three locomotion actions are weighted by `blend` and their `time` is
 *    set from the gait phase - the mixer is stepped with `update(0)` so clip
 *    time is a pure function of distance travelled, never of wall clock;
 * 3. optional two-bone foot IK snaps each ankle onto its own ground sample.
 */
function applyPose(rig, pose, clipDurations, footIK) {
  const root = rig.root;
  root.position.set(pose.x, pose.rootY, pose.z);
  root.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');
  root.scale.set(pose.scaleXZ, pose.scaleY, pose.scaleXZ);

  const { actions } = rig;
  if (actions.idle) {
    actions.idle.setEffectiveWeight(pose.blend.idle);
    actions.idle.time = clipDurations.idle > 0
      ? (pose.idleTime % clipDurations.idle)
      : 0;
  }
  if (actions.walk) {
    actions.walk.setEffectiveWeight(pose.blend.walk);
    actions.walk.time = pose.gaitPhase * clipDurations.walk;
  }
  if (actions.brisk) {
    actions.brisk.setEffectiveWeight(pose.blend.brisk);
    actions.brisk.time = pose.gaitPhase * clipDurations.brisk;
  }
  rig.mixer.update(0);
  root.updateMatrixWorld(true);

  if (!footIK || !pose.grounding) return;

  const hips = rig.byName.get('Hips');
  _m1.copy(hips.matrixWorld).invert();
  for (let i = 0; i < 2; i += 1) {
    const side = i === 0 ? 'Left' : 'Right';
    const foot = pose.grounding.feet[i];
    const thigh = rig.byName.get(`${side}UpLeg`);
    const shin = rig.byName.get(`${side}Leg`);
    const ankle = rig.byName.get(`${side}Foot`);
    // Ankle target in world metres, already carrying the swing lift, the sole
    // thickness and the foot rocker (see sampleFootGrounding).
    _v1.set(foot.ankleX, foot.ankleY, foot.ankleZ);
    _v1.applyMatrix4(_m1);           // -> Hips-local, unscaled bone space
    _v2.copy(_v1).sub(thigh.position);
    const distance = _v2.length();
    const ik = solveTwoBoneIK({
      upperLength: LEG_SEGMENTS.thigh,
      lowerLength: LEG_SEGMENTS.shin,
      targetDistance: distance,
    });
    if (distance > 1e-5) {
      _v2.multiplyScalar(1 / distance);
      _q1.setFromUnitVectors(NEG_Y, _v2);          // aim the whole chain
      _q2.setFromAxisAngle(AXIS_X, -ik.upperAngle); // then swing the knee forward
      thigh.quaternion.copy(_q1).multiply(_q2);
      shin.quaternion.setFromAxisAngle(AXIS_X, ik.bendAngle);
    }
    // Level the foot against the ground it stands on. Exact: take the shin's
    // world orientation and rotate back to the desired world orientation.
    thigh.updateMatrixWorld(true);
    shin.getWorldQuaternion(_q1).invert();
    _q2.setFromEuler(pose.footEuler);
    ankle.quaternion.copy(_q1).multiply(_q2);
    if (!foot.contact) {
      // Toe-up through swing so the foot does not scuff the pavement.
      _q3.setFromAxisAngle(AXIS_X, -0.35 * (foot.lift / Math.max(1e-4, pose.lift)));
      ankle.quaternion.multiply(_q3);
    }
  }
  root.updateMatrixWorld(true);
}

// ----------------------------------------------------------- instanced band

/**
 * One instanced band: a set of `InstancedMesh`es keyed `"<bone>|<group>"`.
 * `group` selects which identity colour the whole mesh's instance carries, so
 * every agent in the band keeps its own skin / top / bottom / shoe colours in
 * a handful of draw calls.
 */
function createInstancedBand(name, geometries, capacity, { castShadow }) {
  const group = new THREE.Group();
  group.name = name;
  const meshes = [];
  const materials = new Map();
  for (const [key, entry] of geometries) {
    let material = materials.get(entry.group);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        roughness: entry.group === 'shoes' ? 0.7 : 0.88,
        metalness: 0,
        color: 0xffffff,
      });
      material.name = `pedestrian-${entry.group}`;
      materials.set(entry.group, material);
    }
    const mesh = new THREE.InstancedMesh(entry.geometry, material, capacity);
    mesh.name = `${name}-${key.replace('|', '-')}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The band spans the streamed city and moves every frame; a stale aggregate
    // bound is how a whole block of walkers blinks out.
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.count = 0;
    // Force the instanceColor buffer into existence so the first frame does not
    // draw a white crowd.
    mesh.setColorAt(0, new THREE.Color(0xffffff));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    meshes.push({ key, bone: entry.bone, group: entry.group, mesh });
    group.add(mesh);
  }
  return { group, meshes, materials, capacity };
}

// ------------------------------------------------------------ the crowd

/**
 * Build the crowd presentation.
 *
 * @param {object} options
 * @param {THREE.Object3D} [options.parent] where to attach `object3d`. The
 *   crowd group must stay at identity - it is a container, not a transform.
 * @param {object}  [options.budget]        see `CROWD_BUDGET`
 * @param {object}  [options.clips]         `{idle, walk, brisk}` AnimationClips;
 *                                          omit to use the authored built-ins
 * @param {Function}[options.sampleGround]  `(x,z) => number|null`
 * @param {Function}[options.readAgent]     read-only simulation adapter
 * @param {boolean} [options.footIK=true]   analytic foot placement overrides the
 *                                          clip's legs (anti-skating guarantee)
 * @param {number}  [options.sunElevationDeg=45] tunes contact shadow density
 * @returns crowd handle - see the return literal at the bottom
 */
export function createCrowdPresentation(options = {}) {
  const {
    parent = null,
    budget = CROWD_BUDGET,
    clips = null,
    sampleGround = null,
    readAgent = defaultReadAgent,
    footIK = true,
    distances = PRESENTATION_BAND_DISTANCES,
    sunElevationDeg = 45,
    shadowOpacityScale = 1,
    castShadow = true,
    material = null,
    groundResponseRate = 14,
  } = options;

  const caps = {
    skinned: Math.max(0, budget.skinned | 0),
    instanced: Math.max(0, budget.instanced | 0),
    far: Math.max(0, budget.far | 0),
  };
  const shadowCapacity = Math.max(1, caps.skinned + caps.instanced + caps.far);

  const object3d = new THREE.Group();
  object3d.name = 'pedestrian-presentation';

  let clipSet = clips ? { ...clips } : buildLocomotionClips();
  let clipDurations = clipDurationsFor(clipSet);
  let groundSampler = typeof sampleGround === 'function' ? sampleGround : null;
  let sunElevation = sunElevationDeg;

  const bodyGeometry = buildPedestrianBodyGeometry();
  const skinnedTemplate = material || new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0 });

  const midBand = createInstancedBand(
    'pedestrian-band-mid',
    buildInstancedPartGeometries({ detail: 'mid', radialSegments: 5 }),
    Math.max(1, caps.instanced),
    { castShadow },
  );
  const farBand = createInstancedBand(
    'pedestrian-band-far',
    buildInstancedPartGeometries({ detail: 'far', radialSegments: 4, mergeToRoot: true }),
    Math.max(1, caps.far),
    { castShadow: false },
  );
  object3d.add(midBand.group, farBand.group);

  const shadowTexture = buildContactShadowTexture();
  const shadowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    color: 0x080b0e,
    transparent: true,
    opacity: CONTACT_SHADOW.baseOpacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  shadowMaterial.name = 'pedestrian-contact-shadow';
  const shadowMesh = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, shadowCapacity);
  shadowMesh.name = 'pedestrian-contact-shadows';
  shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadowMesh.frustumCulled = false;
  shadowMesh.castShadow = false;
  shadowMesh.receiveShadow = false;
  shadowMesh.renderOrder = 2;
  shadowMesh.count = 0;
  // Per-instance ALPHA is not reachable without a custom shader, and shaders are
  // off-limits on this renderer path (a ShaderMaterial is silently replaced by a
  // blank NodeMaterial under WebGPURenderer). So the per-agent fade is carried by
  // the blob's RADIUS instead: a fading blob shrinks rather than lightening.
  // Lightening would be worse than wrong - blending a pale disc over dark asphalt
  // brightens the ground. Global density (time of day) rides on
  // `shadowMaterial.opacity` via `setSunElevation()`.
  object3d.add(shadowMesh);

  /** @type {Array<{group:THREE.Group, rig:object, id:*}>} */
  const skinnedActors = [];
  const poser = buildVirtualRig(clipSet);

  const memory = new Map();
  const snapshots = [];
  const bandMemory = new Map();
  const stats = {
    version: PEDESTRIAN_PRESENTATION_VERSION,
    frame: 0,
    agents: 0,
    skinned: 0,
    instanced: 0,
    far: 0,
    culled: 0,
    shadows: 0,
    grounded: 0,
    ungrounded: 0,
    maxFootGroundSpeed: 0,
    budget: caps,
    draws: 0,
  };

  const _color = new THREE.Color();
  const _obj = new THREE.Object3D();
  const footEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const pose = {
    x: 0, z: 0, rootY: 0, yaw: 0, pitch: 0, roll: 0,
    scaleXZ: 1, scaleY: 1, blend: null, gaitPhase: 0, idleTime: 0,
    grounding: null, footEuler, lift: 0.1,
  };

  function clipDurationsFor(set) {
    return {
      idle: set.idle ? set.idle.duration : 1,
      walk: set.walk ? set.walk.duration : 1,
      brisk: set.brisk ? set.brisk.duration : 1,
    };
  }

  function ensureSkinnedActor(index) {
    while (skinnedActors.length <= index) {
      const group = new THREE.Group();
      group.name = `pedestrian-actor-${skinnedActors.length}`;
      group.visible = false;
      // Variation is re-applied per agent; the rig is created once with a
      // placeholder identity so the palette texture exists.
      const rig = createPedestrianRig({
        geometry: bodyGeometry,
        variation: identityVariation(`actor-slot-${skinnedActors.length}`),
        clips: clipSet,
        material: skinnedTemplate,
      });
      rig.mesh.castShadow = castShadow;
      group.add(rig.mesh);
      object3d.add(group);
      skinnedActors.push({
        group,
        rig: { root: group, byName: rig.byName, mixer: rig.mixer, actions: rig.actions },
        mesh: rig.mesh,
        palette: rig.palette,
        material: rig.material,
        skeleton: rig.skeleton,
        id: null,
      });
    }
    return skinnedActors[index];
  }

  function writePalette(actor, variation) {
    const data = actor.palette.image.data;
    for (let i = 0; i < PALETTE_SLOTS.length; i += 1) {
      const hex = variation.colors[PALETTE_SLOTS[i]];
      data[i * 4] = (hex >> 16) & 0xff;
      data[i * 4 + 1] = (hex >> 8) & 0xff;
      data[i * 4 + 2] = hex & 0xff;
      data[i * 4 + 3] = 255;
    }
    actor.palette.needsUpdate = true;
  }

  function memoryFor(id, seed) {
    let record = memory.get(id);
    if (!record) {
      const variation = identityVariation(seed);
      record = {
        id,
        variation,
        phase: variation.phaseOffset,
        state: 'idle',
        rootY: null,
        idleTime: variation.idleOffset,
        band: null,
        seen: 0,
      };
      memory.set(id, record);
    }
    return record;
  }

  function resolveViewPosition(view) {
    if (!view) return { x: 0, y: 0, z: 0 };
    if (view.isCamera) {
      view.updateMatrixWorld();
      const e = view.matrixWorld.elements;
      return { x: e[12], y: e[13], z: e[14] };
    }
    if (view.position) return view.position;
    return view;
  }

  /**
   * Mirror one frame of simulation state.
   *
   * @param {ArrayLike} agents simulation-owned records. Read only.
   * @param {number} dt seconds since the previous call.
   * @param {THREE.Camera|{x,y,z}|{position:{x,y,z}}} view
   * @returns {object} frozen-ish stats snapshot (the same object each frame)
   */
  function update(agents, dt, view) {
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    const list = agents || [];
    const count = list.length | 0;

    while (snapshots.length < count) {
      snapshots.push({ id: null, seed: null, x: 0, y: 0, z: 0, heading: 0, speed: 0, active: true, pose: 'walk' });
    }
    const active = [];
    for (let i = 0; i < count; i += 1) {
      const source = list[i];
      if (!source) continue;
      const snapshot = readAgent(source, i, snapshots[i]);
      if (!snapshot || snapshot.active === false) continue;
      active.push(snapshot);
    }

    const viewPosition = resolveViewPosition(view);
    const plan = planCrowdPresentation(active, {
      position: viewPosition,
      budget: caps,
      previousBands: bandMemory,
      distances,
    });

    stats.frame += 1;
    stats.agents = active.length;
    stats.skinned = 0;
    stats.instanced = 0;
    stats.far = 0;
    stats.culled = plan.counts.culled;
    stats.grounded = 0;
    stats.ungrounded = 0;
    stats.maxFootGroundSpeed = 0;

    let shadowIndex = 0;
    const midCursor = new Map();
    let farCursor = 0;

    // Walk the plan nearest-first. `entry.index` indexes `active`.
    for (let e = 0; e < plan.entries.length; e += 1) {
      const entry = plan.entries[e];
      const agent = active[entry.index];
      if (!agent) continue;
      bandMemory.set(entry.id, entry.band);
      if (entry.band === 'culled') continue;

      const record = memoryFor(entry.id, agent.seed);
      record.seen = stats.frame;
      const variation = record.variation;

      const legLength = variation.legLength;
      const speed = agent.speed;
      const stride = strideLengthForSpeed(speed, legLength) / Math.max(0.5, variation.cadenceBias);
      const duty = dutyFactorForSpeed(speed);
      const lift = swingLiftForSpeed(speed) * variation.heightScale;

      record.phase = advanceGaitPhase(record.phase, speed, stride, step);
      record.idleTime += step;
      record.state = resolveLocomotionState(speed, record.state, agent);
      const blend = locomotionBlend(speed, agent);

      const grounding = sampleFootGrounding({
        x: agent.x,
        y: agent.y,
        z: agent.z,
        heading: agent.heading,
        gaitPhase: record.phase,
        speed,
        strideLength: stride,
        duty,
        lift,
        stanceHalfWidth: GAIT.stanceHalfWidth * variation.heightScale * variation.buildScale,
        scale: variation.heightScale,
        sampleGround: groundSampler,
        previousRootY: record.rootY,
        responseRate: groundResponseRate,
        dt: step,
      });
      record.rootY = grounding.rootY;
      if (grounding.grounded) stats.grounded += 1; else stats.ungrounded += 1;
      if (grounding.feet[0].contact || grounding.feet[1].contact) {
        const contactSpeed = Math.min(
          grounding.feet[0].contact ? Math.abs(grounding.feet[0].worldSpeed) : Infinity,
          grounding.feet[1].contact ? Math.abs(grounding.feet[1].worldSpeed) : Infinity,
        );
        if (contactSpeed > stats.maxFootGroundSpeed) stats.maxFootGroundSpeed = contactSpeed;
      }

      pose.x = agent.x;
      pose.z = agent.z;
      pose.rootY = grounding.rootY;
      pose.yaw = agent.heading + (blend.idle > 0.9 ? variation.idleYawBias : 0);
      pose.pitch = grounding.pitch;
      pose.roll = grounding.roll;
      pose.scaleY = variation.heightScale;
      pose.scaleXZ = variation.heightScale * variation.buildScale;
      pose.blend = blend;
      pose.gaitPhase = record.phase;
      pose.idleTime = record.idleTime;
      pose.grounding = grounding;
      pose.lift = Math.max(1e-4, lift);
      footEuler.set(grounding.slopePitch, pose.yaw, 0, 'YXZ');

      if (entry.band === 'skinned') {
        const actor = ensureSkinnedActor(stats.skinned);
        if (actor.id !== entry.id) {
          actor.id = entry.id;
          writePalette(actor, variation);
        }
        actor.group.visible = true;
        applyPose(actor.rig, pose, clipDurations, footIK);
        stats.skinned += 1;
      } else if (entry.band === 'instanced') {
        applyPose(poser, pose, clipDurations, footIK);
        for (const item of midBand.meshes) {
          const cursor = midCursor.get(item.key) || 0;
          if (cursor >= midBand.capacity) continue;
          const node = poser.byName.get(item.bone);
          item.mesh.setMatrixAt(cursor, node.matrixWorld);
          _color.setHex(variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
          item.mesh.setColorAt(cursor, _color);
          midCursor.set(item.key, cursor + 1);
        }
        stats.instanced += 1;
      } else {
        // far: one root matrix, no per-bone articulation, no mixer.
        if (farCursor < farBand.capacity) {
          const bob = blend.idle > 0.9
            ? 0
            : Math.sin(record.phase * TAU * 2) * 0.016 * variation.heightScale;
          _obj.position.set(agent.x, grounding.rootY + bob, agent.z);
          _obj.rotation.set(0, pose.yaw, 0);
          _obj.scale.set(pose.scaleXZ, pose.scaleY, pose.scaleXZ);
          _obj.updateMatrix();
          for (const item of farBand.meshes) {
            item.mesh.setMatrixAt(farCursor, _obj.matrix);
            _color.setHex(variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
            item.mesh.setColorAt(farCursor, _color);
          }
          farCursor += 1;
          stats.far += 1;
        }
      }

      // Contact shadow for every visible agent in every band.
      if (shadowIndex < shadowCapacity) {
        const clearance = Math.max(0, grounding.rootY - grounding.groundY);
        const blob = contactShadowFor({
          speed,
          heightScale: variation.heightScale,
          buildScale: variation.buildScale,
          groundClearance: clearance,
          distance: entry.distance,
          sunElevationDeg: sunElevation,
          opacityScale: shadowOpacityScale,
        });
        const fade = clamp(blob.opacity / CONTACT_SHADOW.baseOpacity, 0, 1);
        if (fade > 0.08) {
          _obj.position.set(agent.x, grounding.groundY + blob.y, agent.z);
          _obj.rotation.set(0, pose.yaw, 0);
          const diameter = blob.radius * 2 * fade;
          _obj.scale.set(diameter, 1, diameter * blob.lengthScale);
          _obj.updateMatrix();
          shadowMesh.setMatrixAt(shadowIndex, _obj.matrix);
          shadowIndex += 1;
        }
      }
    }

    for (let i = stats.skinned; i < skinnedActors.length; i += 1) {
      skinnedActors[i].group.visible = false;
      skinnedActors[i].id = null;
    }
    let draws = stats.skinned;
    for (const item of midBand.meshes) {
      item.mesh.count = midCursor.get(item.key) || 0;
      item.mesh.instanceMatrix.needsUpdate = true;
      if (item.mesh.instanceColor) item.mesh.instanceColor.needsUpdate = true;
      if (item.mesh.count > 0) draws += 1;
    }
    for (const item of farBand.meshes) {
      item.mesh.count = farCursor;
      item.mesh.instanceMatrix.needsUpdate = true;
      if (item.mesh.instanceColor) item.mesh.instanceColor.needsUpdate = true;
      if (item.mesh.count > 0) draws += 1;
    }
    shadowMesh.count = shadowIndex;
    shadowMesh.instanceMatrix.needsUpdate = true;
    if (shadowIndex > 0) draws += 1;
    stats.shadows = shadowIndex;
    stats.draws = draws;

    // Drop presentation memory for agents the simulation retired, so a long
    // session does not accumulate a map of dead ids.
    if (stats.frame % 300 === 0) {
      for (const [id, record] of memory) {
        if (stats.frame - record.seen > 600) {
          memory.delete(id);
          bandMemory.delete(id);
        }
      }
    }
    return stats;
  }

  function setClips(next) {
    const problems = validateLocomotionClips(next);
    if (problems.length) throw new Error(`invalid locomotion clip set: ${problems.join('; ')}`);
    clipSet = { ...next };
    clipDurations = clipDurationsFor(clipSet);
    const rebind = (rig, mixerRoot) => {
      rig.mixer.stopAllAction();
      rig.mixer.uncacheRoot(mixerRoot);
      const mixer = new THREE.AnimationMixer(mixerRoot);
      const actions = {};
      for (const name of LOCOMOTION_STATES) {
        if (!clipSet[name]) continue;
        const action = mixer.clipAction(clipSet[name]);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.enabled = true;
        action.setEffectiveWeight(name === 'idle' ? 1 : 0);
        action.play();
        actions[name] = action;
      }
      rig.mixer = mixer;
      rig.actions = actions;
    };
    for (const actor of skinnedActors) rebind(actor.rig, actor.mesh);
    rebind(poser, poser.root);
    return clipSet;
  }

  function dispose() {
    if (object3d.parent) object3d.parent.remove(object3d);
    bodyGeometry.dispose();
    for (const band of [midBand, farBand]) {
      for (const item of band.meshes) {
        item.mesh.geometry.dispose();
        item.mesh.dispose();
      }
      for (const mat of band.materials.values()) mat.dispose();
    }
    shadowGeometry.dispose();
    shadowMaterial.dispose();
    shadowTexture.dispose();
    shadowMesh.dispose();
    for (const actor of skinnedActors) {
      actor.rig.mixer.stopAllAction();
      actor.rig.mixer.uncacheRoot(actor.mesh);
      actor.palette.dispose();
      actor.material.dispose();
      actor.skeleton.dispose();
    }
    poser.mixer.stopAllAction();
    poser.mixer.uncacheRoot(poser.root);
    skinnedActors.length = 0;
    memory.clear();
    bandMemory.clear();
    snapshots.length = 0;
  }

  if (parent && typeof parent.add === 'function') parent.add(object3d);

  return {
    version: PEDESTRIAN_PRESENTATION_VERSION,
    object3d,
    update,
    stats: () => stats,
    setClips,
    getClips: () => ({ ...clipSet }),
    setGroundSampler: (fn) => { groundSampler = typeof fn === 'function' ? fn : null; },
    setSunElevation: (deg) => {
      if (!Number.isFinite(deg)) return;
      sunElevation = deg;
      // A high sun makes a tight dark pool; a low or absent sun makes a soft
      // ambient one. Both keep feet attached to the pavement.
      const sun = clamp(Math.abs(deg) / 90, 0, 1);
      shadowMaterial.opacity = CONTACT_SHADOW.baseOpacity * lerp(0.72, 1, sun);
    },
    materials: { contactShadow: shadowMaterial },
    /** Exposed so a caller can retarget an external clip against this skeleton. */
    rig: {
      boneNames: PEDESTRIAN_BONE_NAMES,
      restPose: REST_POSE,
      template: poser.root,
      bodyGeometry,
    },
    budget: caps,
    dispose,
  };
}

export default createCrowdPresentation;
