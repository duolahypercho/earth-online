// Sun shadow cascade planner for the canonical city renderer.
//
// Why this module exists
// ----------------------
// `computeSunShadowCamera` in ./environment-ibl.js fits ONE orthographic box
// to the visible slice of the view frustum. Its density is fixed by two
// numbers and nothing else:
//
//     texelsPerMetre ~= mapSize / (2 * radius),  radius ~= k(fov, aspect) * shadowDistance
//
// so density and reach are inversely coupled. On the single-box rig the round-4
// capture measures 6.855 texels/m (14.59 cm texels) over 150 m of view depth,
// and the caster policy in ./shadow-casters.js consequently refuses 165 of 340
// meshes under a 21.9 cm thickness floor: every tree, pole, sign, railing and
// small prop in the city casts nothing at all.
//
// The textbook answer is a cascaded shadow map: a tight, dense near cascade
// plus wider ones, with a per-fragment CHOICE between them. This module plans
// such a split and states its density and coverage in numbers.
//
// CORRECTION TO THIS FILE'S PREVIOUS HEADER
// -----------------------------------------
// An earlier version of this comment asserted that a cascade "cannot" be
// implemented on the canonical renderer. That is false and was already false
// when it was written. The blocker it named was the canonical-runtime rule
// against a new `ShaderMaterial` or `onBeforeCompile` dependency, on the
// premise that the per-fragment cascade choice has to be patched into the
// lighting shader. It does not: three ships `CSMShadowNode`
// (three/addons/csm/CSMShadowNode.js), a `ShadowBaseNode` attached through
// `light.shadow.shadowNode`, which three's own node material calls in place of
// its default shadow term. No material is subclassed, no shader source is
// patched, nothing is compiled by this project. The renderer now uses it; the
// integration lives in src/citygen/renderer.js.
//
// `assessCascadeRig` below is UNCHANGED and its verdict is unchanged, because
// it never assessed a cascade in the first place. It assesses the *shader-free
// multi-light substitute* - N collinear `DirectionalLight`s splitting the key
// intensity - and prices its light leak at `1 - 1/N`. That substitute is still
// not viable, and the arithmetic proving it is still worth keeping, because it
// is the thing a future reader will otherwise be tempted to build. Read it as
// "why we use a shadow node instead of more lights", not as "why there is no
// cascade".
//
// What this module is
// -------------------
// A pure planner, in two halves.
//
//   1. The original single-box half. Given a camera pose, a sun direction and
//      a list of `{ shadowDistance, mapSize }` requests it returns, per
//      cascade, the fit from `computeSunShadowCamera`, the achieved texel
//      density, the interval of view depth the cascade is AUTHORITATIVE for,
//      the interval its box actually contains, and whether that box covers its
//      authority interval. `recommendSingleCascade` solves the inverse
//      problem. This half models a fit that tracks the SUN.
//
//   2. The texel-budget calculator, `planCascadeTexelBudget`. This half models
//      the fit `CSMShadowNode` actually performs, which is a different fit: it
//      splits the view frustum at practical-scheme breaks and sizes each
//      cascade's square box to the DIAGONAL of its frustum slice, in light
//      space, independent of the sun. It is what chooses the cascade count and
//      `maxFar` the renderer ships, and what the per-cascade caster thickness
//      floors are derived from. It reproduces `CSMShadowNode._getBreaks` and
//      `CSMShadowNode._updateShadowBounds` exactly so the two cannot drift.
//
// Design constraints honoured here
// --------------------------------
//   * No renderer, canvas, RAF loop, scene root, camera or light is created.
//   * Nothing imported from three. The only import is the pure fitting
//     function next door, so this file runs under plain node.
//   * No ShaderMaterial, no onBeforeCompile, no TSL, no material touched.
//   * No Math.random(), no Date.now(). Same inputs -> same plan, always.
//   * Presentation-only: it reads no simulation state and writes none.

import { computeSunShadowCamera, SHADOW_FIT_DEFAULTS } from './environment-ibl.js';

export const SUN_SHADOW_CASCADE_VERSION = 'sun-shadow-cascade-v1';

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Square shadow map sizes this project is willing to allocate, smallest first.
 * 4096 is the ceiling: WebGPU guarantees `maxTextureDimension2D >= 8192` but a
 * 8192 depth attachment is 268 MB at 32-bit and is not a defensible spend for
 * one light. The list is used by `recommendSingleCascade` and is declared so
 * the recommendation is a search over a fixed set, not a free-floating number.
 * @type {readonly number[]}
 */
export const MAP_SIZE_LADDER = Object.freeze([1024, 2048, 3072, 4096]);

/**
 * MSAA sample counts a WebGPU render pipeline is guaranteed to accept. The
 * spec requires support for 1 and 4 only; 8 is optional and is not present on
 * every adapter. Any antialiasing plan that asks for a sample count outside
 * this set diverges between the WebGPU path and the WebGL2 fallback, which the
 * canonical-runtime rule forbids. Exported so an antialiasing decision can be
 * asserted against it instead of assumed.
 * @type {readonly number[]}
 */
export const PORTABLE_SAMPLE_COUNTS = Object.freeze([1, 4]);

/**
 * How much sunlight is allowed to leak into a shadow before the rig counts as
 * broken. 0.05 is one twentieth of the key: below that the difference between
 * a full shadow and a leaking one is inside the tone mapper's own noise. This
 * is the number that decides `assessCascadeRig().viable`.
 */
export const MAX_SHADOW_LEAK = 0.05;

/** Defaults for `planSunShadowCascades`. */
export const CASCADE_PLAN_DEFAULTS = Object.freeze({
  cameraNear: SHADOW_FIT_DEFAULTS.cameraNear,
  maxCasterHeight: SHADOW_FIT_DEFAULTS.maxCasterHeight,
  /** Sampling step, in metres, for the axial containment scan. */
  coverageStep: 0.25,
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function readVec3(value, label) {
  if (Array.isArray(value) && value.length >= 3) {
    const [x, y, z] = value;
    if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z)) return { x, y, z };
  } else if (value && typeof value === 'object'
    && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)) {
    return { x: value.x, y: value.y, z: value.z };
  }
  throw new TypeError(`sun-shadow-cascade: ${label} must be a finite {x,y,z} vector`);
}

function normalise(v, label) {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 1e-12)) throw new TypeError(`sun-shadow-cascade: ${label} must not be zero length`);
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/**
 * Is a world point inside a fit's orthographic shadow volume?
 *
 * The volume is the box `[-halfExtent, halfExtent]^2` across the light's right
 * and up axes, and `[near, far]` along the light's forward axis measured from
 * the light position. A point outside it samples the map's border, which three
 * clamps to "lit" - so this predicate is exactly "can this point receive a
 * shadow from this cascade".
 *
 * **Pure.**
 *
 * @param {Readonly<object>} fit A `computeSunShadowCamera` result.
 * @param {{x:number,y:number,z:number}} point World-space point.
 * @returns {boolean}
 */
export function fitContains(fit, point) {
  const basis = fit.lightBasis;
  const dx = point.x - fit.target.x;
  const dy = point.y - fit.target.y;
  const dz = point.z - fit.target.z;
  const lx = dx * basis.right.x + dy * basis.right.y + dz * basis.right.z;
  const ly = dx * basis.up.x + dy * basis.up.y + dz * basis.up.z;
  if (Math.abs(lx) > fit.halfExtent || Math.abs(ly) > fit.halfExtent) return false;
  const depth = (point.x - fit.position.x) * basis.forward.x
    + (point.y - fit.position.y) * basis.forward.y
    + (point.z - fit.position.z) * basis.forward.z;
  return depth >= fit.near && depth <= fit.far;
}

/**
 * The unbroken run of view depths, starting at `cameraNear`, that a fit's
 * shadow volume contains along the camera axis.
 *
 * Scanned rather than solved: the box is a rotated cuboid and the exit face
 * depends on the sun, so a scan plus a bisection at the boundary is both
 * simpler and demonstrably right. Deterministic - fixed step, fixed iteration
 * count, no early exit on floating point luck.
 *
 * @param {Readonly<object>} fit
 * @param {{x:number,y:number,z:number}} eye
 * @param {{x:number,y:number,z:number}} forward Unit view direction.
 * @param {object} [options]
 * @param {number} [options.cameraNear=0.5]
 * @param {number} [options.limit=2000] Longest depth to test, in metres.
 * @param {number} [options.step=0.25]
 * @returns {Readonly<{near:number, far:number, contiguous:boolean}>}
 */
export function axialCoverage(fit, eye, forward, options = {}) {
  const {
    cameraNear = CASCADE_PLAN_DEFAULTS.cameraNear,
    limit = 2000,
    step = CASCADE_PLAN_DEFAULTS.coverageStep,
  } = options;
  const at = (d) => ({
    x: eye.x + forward.x * d,
    y: eye.y + forward.y * d,
    z: eye.z + forward.z * d,
  });
  if (!fitContains(fit, at(cameraNear))) {
    return Object.freeze({ near: cameraNear, far: cameraNear, contiguous: false });
  }
  let last = cameraNear;
  let exit = null;
  for (let d = cameraNear + step; d <= limit; d += step) {
    if (fitContains(fit, at(d))) {
      last = d;
    } else {
      exit = d;
      break;
    }
  }
  if (exit === null) return Object.freeze({ near: cameraNear, far: last, contiguous: true });
  // Bisect the last contained depth to the step's own precision.
  let lo = last;
  let hi = exit;
  for (let i = 0; i < 40; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (fitContains(fit, at(mid))) lo = mid; else hi = mid;
  }
  return Object.freeze({ near: cameraNear, far: lo, contiguous: true });
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Plan an N-cascade sun shadow for one camera pose.
 *
 * Cascade `i` is declared AUTHORITATIVE over the view-depth interval
 * `[start_i, shadowDistance_i]`, where `start_0 = cameraNear` and
 * `start_{i+1} = shadowDistance_i`. Those intervals tile `[cameraNear,
 * shadowDistance_last]` by construction, which is what "no gap, no overlap"
 * means for a cascade split: every world point in front of the camera, out to
 * the last cascade's distance, has exactly one cascade responsible for it.
 *
 * Each cascade's actual shadow volume is then measured against its authority
 * interval with `axialCoverage`, because tiling the intervals is a statement
 * about intent and containment is a statement about geometry; a plan is only
 * sound when both hold.
 *
 * **Pure.** Reads only its arguments, allocates only its result.
 *
 * @param {object} options
 * @param {{x:number,y:number,z:number}|number[]} options.cameraPosition
 * @param {{x:number,y:number,z:number}|number[]} options.cameraDirection Need
 *   not be normalised.
 * @param {number} options.fovDeg Vertical field of view.
 * @param {number} options.aspect Width / height.
 * @param {{x:number,y:number,z:number}|number[]} options.sunDirection Direction
 *   TOWARD the sun.
 * @param {ReadonlyArray<{shadowDistance:number, mapSize:number}>} options.cascades
 *   Ascending by `shadowDistance`. One entry is a legal plan and describes the
 *   renderer as it ships.
 * @param {number} [options.cameraNear=0.5]
 * @param {number} [options.maxCasterHeight=260]
 * @param {number} [options.coverageStep=0.25]
 * @returns {Readonly<object>}
 */
export function planSunShadowCascades(options = {}) {
  const {
    fovDeg,
    aspect,
    cascades,
    cameraNear = CASCADE_PLAN_DEFAULTS.cameraNear,
    maxCasterHeight = CASCADE_PLAN_DEFAULTS.maxCasterHeight,
    coverageStep = CASCADE_PLAN_DEFAULTS.coverageStep,
  } = options;

  if (!Array.isArray(cascades) || cascades.length === 0) {
    throw new TypeError('sun-shadow-cascade: cascades must be a non-empty array');
  }
  if (!isFiniteNumber(cameraNear) || cameraNear <= 0) {
    throw new TypeError(`sun-shadow-cascade: cameraNear must be positive, got ${cameraNear}`);
  }
  let previous = cameraNear;
  for (const entry of cascades) {
    if (!entry || !isFiniteNumber(entry.shadowDistance) || entry.shadowDistance <= previous) {
      throw new TypeError('sun-shadow-cascade: cascade shadowDistance must be finite and strictly '
        + `increasing from cameraNear, got ${entry?.shadowDistance} after ${previous}`);
    }
    if (!Number.isInteger(entry.mapSize) || entry.mapSize < 16) {
      throw new TypeError(`sun-shadow-cascade: cascade mapSize must be an integer >= 16, got ${entry?.mapSize}`);
    }
    previous = entry.shadowDistance;
  }

  const eye = readVec3(options.cameraPosition, 'cameraPosition');
  const forward = normalise(readVec3(options.cameraDirection, 'cameraDirection'), 'cameraDirection');
  const sun = normalise(readVec3(options.sunDirection, 'sunDirection'), 'sunDirection');

  const planned = [];
  let start = cameraNear;
  let totalTexels = 0;
  for (let index = 0; index < cascades.length; index += 1) {
    const request = cascades[index];
    const fit = computeSunShadowCamera({
      cameraPosition: eye,
      cameraDirection: forward,
      fovDeg,
      aspect,
      sunDirection: sun,
      shadowDistance: request.shadowDistance,
      cameraNear,
      mapSize: request.mapSize,
      maxCasterHeight,
    });
    const coverage = axialCoverage(fit, eye, forward, {
      cameraNear,
      limit: Math.max(4 * request.shadowDistance, 2 * fit.halfExtent + request.shadowDistance),
      step: coverageStep,
    });
    const authority = Object.freeze({ near: start, far: request.shadowDistance });
    // The authority interval must sit inside what the box actually contains.
    // `coverage.near` is `cameraNear` for every cascade, because every box is
    // fitted from the eye - a cascade never starts short.
    const covers = coverage.contiguous
      && coverage.near <= authority.near + 1e-6
      && coverage.far + 1e-6 >= authority.far;
    planned.push(Object.freeze({
      index,
      mapSize: request.mapSize,
      shadowDistance: request.shadowDistance,
      authority,
      coverage,
      /** Metres of view depth the box holds beyond its authority interval. */
      headroom: round(coverage.far - authority.far, 3),
      covers,
      texelsPerMetre: round(fit.texelsPerMetre, 4),
      texelWorldSize: round(fit.texelWorldSize, 6),
      halfExtent: round(fit.halfExtent, 3),
      depthRange: round(fit.depthRange, 2),
      normalBias: fit.normalBias,
      bias: fit.bias,
      castShadow: fit.castShadow,
      warnings: fit.warnings,
      fit,
    }));
    totalTexels += request.mapSize * request.mapSize;
    start = request.shadowDistance;
  }

  // --- split continuity. Intervals tile by construction, so this is an
  // assertion about the construction rather than a search: it fails loudly if
  // someone changes how `start` is carried.
  const gaps = [];
  const overlaps = [];
  for (let i = 1; i < planned.length; i += 1) {
    const previousFar = planned[i - 1].authority.far;
    const currentNear = planned[i].authority.near;
    if (currentNear > previousFar + 1e-9) gaps.push({ after: i - 1, from: previousFar, to: currentNear });
    if (currentNear < previousFar - 1e-9) overlaps.push({ after: i - 1, from: currentNear, to: previousFar });
  }
  const uncovered = planned.filter((c) => !c.covers).map((c) => c.index);

  const problems = [];
  if (gaps.length) problems.push(`${gaps.length} gap(s) between authority intervals`);
  if (overlaps.length) problems.push(`${overlaps.length} overlap(s) between authority intervals`);
  if (uncovered.length) problems.push(`cascade(s) ${uncovered.join(', ')} do not contain their own authority interval`);

  return Object.freeze({
    version: SUN_SHADOW_CASCADE_VERSION,
    cascades: Object.freeze(planned),
    /** Union of the authority intervals, in view depth. */
    span: Object.freeze({ near: cameraNear, far: planned[planned.length - 1].authority.far }),
    split: Object.freeze({
      ok: problems.length === 0,
      gaps: Object.freeze(gaps),
      overlaps: Object.freeze(overlaps),
      uncovered: Object.freeze(uncovered),
      problems: Object.freeze(problems),
    }),
    /** Total shadow-map texels allocated, all cascades summed. */
    totalTexels,
    /** Relative to a single 2048 map, which is what the renderer ships. */
    texelBudgetRatio: round(totalTexels / (2048 * 2048), 3),
    sunAltitudeDeg: round(planned[0].fit.sunAltitudeDeg, 3),
  });
}

/**
 * Is cascade `index` authoritative for `depth`?
 *
 * Authority intervals are half-open, `[near, far)`, except the last, which is
 * closed. That is what makes "exactly one cascade" true at the split points
 * themselves rather than true almost everywhere - a boundary owned by two
 * cascades is a boundary where a renderer can flicker between them.
 *
 * @param {Readonly<object>} plan Result of `planSunShadowCascades`.
 * @param {number} index Cascade index.
 * @param {number} depth View depth in metres.
 * @returns {boolean}
 */
export function cascadeAuthorityContains(plan, index, depth) {
  const cascade = plan.cascades[index];
  if (!cascade || !isFiniteNumber(depth)) return false;
  const last = index === plan.cascades.length - 1;
  return depth >= cascade.authority.near && (last ? depth <= cascade.authority.far : depth < cascade.authority.far);
}

/**
 * Which cascade is authoritative for a given view depth?
 * @param {Readonly<object>} plan Result of `planSunShadowCascades`.
 * @param {number} depth View depth in metres.
 * @returns {number} Cascade index, or -1 when the depth is outside the span.
 */
export function cascadeForDepth(plan, depth) {
  for (let i = 0; i < plan.cascades.length; i += 1) {
    if (cascadeAuthorityContains(plan, i, depth)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Rig assessment: can this plan actually be built here?
// ---------------------------------------------------------------------------

/**
 * Assess whether a multi-cascade plan can be implemented on the canonical
 * renderer, and price the artifact if it cannot.
 *
 * **Why two collinear lights is not a cascade.**
 *
 * A real cascaded shadow map is one light with N maps and a per-fragment
 * choice: the fragment picks the cascade whose box contains it and takes ALL
 * of the light's occlusion from that one map. That choice lives in the
 * lighting shader. The renderer makes it with `CSMShadowNode`, a
 * `ShadowBaseNode` hung on `light.shadow.shadowNode` that three's own node
 * material calls in place of its default shadow term - no `ShaderMaterial`,
 * no `onBeforeCompile`, no shader source owned by this project.
 *
 * What follows is the assessment of the OTHER option, the one that needs no
 * node at all, so that the cost of choosing it is on the record. It is N
 * `DirectionalLight`s pointing the same way,
 * each with its own shadow camera, sharing the key's intensity in fractions
 * `f_i` that sum to 1. That is a SUM, not a choice. A point is darkened by
 * cascade `i` only for the fraction `f_i` of the key that light carries, so a
 * shadow that only one cascade resolves is rendered at `f_i` of its true
 * density and `1 - f_i` of the sun leaks through it.
 *
 * The leak is unavoidable and symmetric:
 *
 *   - a pedestrian inside the near box is absent from the wide map (it is
 *     sub-texel there), so its ground shadow is drawn at `f_near`;
 *   - a building shadow falling on ground beyond the near box is absent from
 *     the near map (that ground is outside its volume), so it is drawn at
 *     `1 - f_near`.
 *
 * Both cannot be small. With N cascades the best possible worst case is
 * `1 - 1/N`: 50% of the sun leaking with two cascades, 67% with three. That
 * is why `viable` is false for every N > 1 at any sane `MAX_SHADOW_LEAK`, and
 * the number below is the proof rather than the claim.
 *
 * A single light has no leak, which is why `recommendSingleCascade` exists and
 * why the shipped rig uses one light with a shadow node rather than N lights.
 *
 * **Pure.**
 *
 * @param {Readonly<object>} plan Result of `planSunShadowCascades`.
 * @param {object} [options]
 * @param {number[]} [options.intensityFractions] Key fractions per cascade.
 *   Defaults to an equal split. Must sum to 1.
 * @param {number} [options.maxShadowLeak=MAX_SHADOW_LEAK]
 * @returns {Readonly<object>}
 */
export function assessCascadeRig(plan, options = {}) {
  const { maxShadowLeak = MAX_SHADOW_LEAK } = options;
  const count = plan.cascades.length;
  const fractions = Array.isArray(options.intensityFractions)
    ? options.intensityFractions.slice()
    : new Array(count).fill(1 / count);
  if (fractions.length !== count) {
    throw new TypeError(`sun-shadow-cascade: intensityFractions must have ${count} entries, got ${fractions.length}`);
  }
  let sum = 0;
  for (const f of fractions) {
    if (!isFiniteNumber(f) || f < 0) {
      throw new TypeError(`sun-shadow-cascade: intensityFractions must be non-negative numbers, got ${f}`);
    }
    sum += f;
  }
  if (Math.abs(sum - 1) > 1e-6) {
    throw new TypeError(`sun-shadow-cascade: intensityFractions must sum to 1, got ${round(sum, 6)}`);
  }

  const leaks = plan.cascades.map((cascade, i) => Object.freeze({
    index: cascade.index,
    intensityFraction: round(fractions[i], 4),
    /** Fraction of the key that survives a shadow only this cascade resolves. */
    shadowLeak: round(1 - fractions[i], 4),
    texelsPerMetre: cascade.texelsPerMetre,
  }));
  const worstLeak = count === 1 ? 0 : Math.max(...leaks.map((l) => l.shadowLeak));
  const bestPossibleLeak = count === 1 ? 0 : round(1 - 1 / count, 4);

  const reasons = [];
  if (count > 1) {
    reasons.push(`${count} collinear directional lights sum rather than choose: a shadow only one `
      + `cascade resolves keeps ${round(100 * worstLeak, 1)}% of the key. The best any split of `
      + `${count} lights can do is ${round(100 * bestPossibleLeak, 1)}%, against a ${round(100 * maxShadowLeak, 1)}% budget.`);
    reasons.push('A true per-fragment cascade choice needs the lighting shader, and the canonical '
      + 'path may not take a ShaderMaterial or onBeforeCompile dependency.');
    reasons.push(`Each extra cascade is a second full shadow-map render pass: this plan allocates `
      + `${plan.totalTexels} texels, ${plan.texelBudgetRatio}x a single 2048 map, and rasterises `
      + 'every admitted caster once per cascade.');
  }

  return Object.freeze({
    version: SUN_SHADOW_CASCADE_VERSION,
    cascadeCount: count,
    lights: Object.freeze(leaks),
    worstShadowLeak: round(worstLeak, 4),
    bestPossibleShadowLeak: bestPossibleLeak,
    maxShadowLeak,
    /** A single cascade is the only rig with no leak on this renderer. */
    viable: count === 1 || worstLeak <= maxShadowLeak,
    reasons: Object.freeze(reasons),
  });
}

// ---------------------------------------------------------------------------
// The inverse problem
// ---------------------------------------------------------------------------

/**
 * Find the cheapest single `{ mapSize, shadowDistance }` that reaches a target
 * texel size without giving up reach.
 *
 * Both requirements are read off the same pose:
 *
 *   - `targetTexelWorldSize` is set by what has to cast. Take it from
 *     `casterBracket()` in ./shadow-casters.js: the floor is
 *     `minThicknessTexels * w`, so admitting an object of thickness `t`
 *     needs `w <= t / minThicknessTexels`.
 *   - `minAxialReach` is set by what must still be shadowed. Below it the
 *     shadow simply stops, and on a level street the cut-off lands at
 *     `atan(eyeHeight / reach)` below the horizon, which is a visible line
 *     across the road.
 *
 * The search is a deterministic sweep over `MAP_SIZE_LADDER` (ascending) and
 * a bisection on `shadowDistance`, returning the FIRST map size that can
 * satisfy both. No randomness, no wall clock, and the same pose always yields
 * the same answer.
 *
 * @param {object} options Everything `planSunShadowCascades` needs, minus
 *   `cascades`, plus:
 * @param {number} options.targetTexelWorldSize Metres per texel, upper bound.
 * @param {number} options.minAxialReach Metres of view depth that must still
 *   receive shadows.
 * @param {ReadonlyArray<number>} [options.mapSizes=MAP_SIZE_LADDER]
 * @returns {Readonly<object>} `{ found, mapSize, shadowDistance, plan, ... }`
 */
export function recommendSingleCascade(options = {}) {
  const {
    targetTexelWorldSize,
    minAxialReach,
    mapSizes = MAP_SIZE_LADDER,
    ...pose
  } = options;
  if (!isFiniteNumber(targetTexelWorldSize) || targetTexelWorldSize <= 0) {
    throw new TypeError(`sun-shadow-cascade: targetTexelWorldSize must be positive, got ${targetTexelWorldSize}`);
  }
  if (!isFiniteNumber(minAxialReach) || minAxialReach <= 0) {
    throw new TypeError(`sun-shadow-cascade: minAxialReach must be positive, got ${minAxialReach}`);
  }

  const evaluate = (mapSize, shadowDistance) => planSunShadowCascades({
    ...pose,
    cascades: [{ mapSize, shadowDistance }],
  }).cascades[0];

  const tried = [];
  for (const mapSize of mapSizes) {
    // Density falls as shadowDistance grows and reach rises with it, so the
    // largest shadowDistance that still meets the texel target is also the one
    // with the most reach. Bisect for it.
    let lo = Math.max(2 * (pose.cameraNear ?? CASCADE_PLAN_DEFAULTS.cameraNear), 1);
    let hi = 2000;
    if (evaluate(mapSize, lo).texelWorldSize > targetTexelWorldSize) {
      tried.push({ mapSize, reason: 'cannot reach the target texel size at any distance' });
      continue;
    }
    for (let i = 0; i < 60; i += 1) {
      const mid = 0.5 * (lo + hi);
      if (evaluate(mapSize, mid).texelWorldSize <= targetTexelWorldSize) lo = mid; else hi = mid;
    }
    const shadowDistance = round(lo, 3);
    const cascade = evaluate(mapSize, shadowDistance);
    if (cascade.coverage.far + 1e-6 >= minAxialReach) {
      const plan = planSunShadowCascades({ ...pose, cascades: [{ mapSize, shadowDistance }] });
      return Object.freeze({
        version: SUN_SHADOW_CASCADE_VERSION,
        found: true,
        mapSize,
        shadowDistance,
        texelWorldSize: cascade.texelWorldSize,
        texelsPerMetre: cascade.texelsPerMetre,
        axialReach: round(cascade.coverage.far, 2),
        texelBudgetRatio: plan.texelBudgetRatio,
        plan,
        tried: Object.freeze(tried),
      });
    }
    tried.push({
      mapSize,
      shadowDistance,
      axialReach: round(cascade.coverage.far, 2),
      reason: `reaches only ${round(cascade.coverage.far, 1)} m of the ${minAxialReach} m required`,
    });
  }
  return Object.freeze({
    version: SUN_SHADOW_CASCADE_VERSION,
    found: false,
    mapSize: null,
    shadowDistance: null,
    tried: Object.freeze(tried),
  });
}

// ---------------------------------------------------------------------------
// Texel budget for a real cascade rig (the fit CSMShadowNode performs)
// ---------------------------------------------------------------------------
//
// Everything above models `computeSunShadowCamera`, which fits a box to the
// visible slice *along the sun*. `CSMShadowNode` does not do that. It splits
// the view frustum at practical-scheme breaks and gives each slice a SQUARE
// box whose side is the slice's longest diagonal, measured in light space and
// therefore independent of the sun direction. That independence is the whole
// point: the density below is a property of the lens and the split, so it is
// one number per cascade for every frame the app will ever draw, and the
// caster thickness floors derived from it never move with the time of day.
//
// The two functions below reproduce `CSMShadowNode._getBreaks` (mode
// 'practical') and `CSMShadowNode._updateShadowBounds` exactly. If three
// changes either, this file must change with it or the renderer's logged
// budget stops describing the rig it ships.

/** `lambda` used by CSM's 'practical' split. Hard-coded in three. */
export const PRACTICAL_SPLIT_LAMBDA = 0.5;

/**
 * Cascade split fractions, in `[0,1]` of `far`, for CSM's 'practical' scheme.
 *
 * Practical = the arithmetic mean of the uniform and logarithmic schemes at
 * `lambda = 0.5`. Uniform alone wastes the near cascade on empty air;
 * logarithmic alone makes the far cascade carry almost the whole scene.
 *
 * @param {number} cascades Number of cascades, >= 1.
 * @param {number} near Camera near plane, metres.
 * @param {number} far Effective far (`min(camera.far, maxFar)`), metres.
 * @param {number} [lambda=PRACTICAL_SPLIT_LAMBDA]
 * @returns {number[]} `cascades` entries, last one exactly 1.
 */
export function practicalCascadeBreaks(cascades, near, far, lambda = PRACTICAL_SPLIT_LAMBDA) {
  if (!Number.isInteger(cascades) || cascades < 1) {
    throw new TypeError(`sun-shadow-cascade: cascades must be a positive integer, got ${cascades}`);
  }
  if (!isFiniteNumber(near) || near <= 0) {
    throw new TypeError(`sun-shadow-cascade: near must be positive metres, got ${near}`);
  }
  if (!isFiniteNumber(far) || far <= near) {
    throw new TypeError(`sun-shadow-cascade: far must exceed near, got ${far} <= ${near}`);
  }
  const breaks = [];
  for (let i = 1; i < cascades; i += 1) {
    const uniform = (near + (far - near) * i / cascades) / far;
    const logarithmic = (near * (far / near) ** (i / cascades)) / far;
    breaks.push(uniform + (logarithmic - uniform) * lambda);
  }
  breaks.push(1);
  return breaks;
}

/**
 * Half-extent, in metres, of the square orthographic box CSM gives a frustum
 * slice running from view depth `z0` to `z1`.
 *
 * CSM takes the longer of two diagonals: the one across the far plane of the
 * slice, and the one from a far corner to the opposite near corner. The box
 * side is that length, so the box contains the slice at any light orientation
 * - which is exactly why the density does not move with the sun.
 *
 * @param {number} z0 Near depth of the slice, metres.
 * @param {number} z1 Far depth of the slice, metres.
 * @param {number} fovDeg Vertical field of view.
 * @param {number} aspect Width / height.
 * @returns {number} Half the box side, metres.
 */
export function cascadeSliceHalfExtent(z0, z1, fovDeg, aspect) {
  if (!isFiniteNumber(fovDeg) || fovDeg <= 0 || fovDeg >= 180) {
    throw new TypeError(`sun-shadow-cascade: fovDeg must be in (0,180), got ${fovDeg}`);
  }
  if (!isFiniteNumber(aspect) || aspect <= 0) {
    throw new TypeError(`sun-shadow-cascade: aspect must be positive, got ${aspect}`);
  }
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const h0 = z0 * t;
  const h1 = z1 * t;
  const w0 = h0 * aspect;
  const w1 = h1 * aspect;
  // Far-plane diagonal: opposite corners of the slice's far rectangle.
  const acrossFar = 2 * Math.hypot(w1, h1);
  // Corner-to-opposite-corner through the slice's depth.
  const throughSlice = Math.hypot(w1 + w0, h1 + h0, z1 - z0);
  return Math.max(acrossFar, throughSlice) / 2;
}

/**
 * Per-cascade texel budget for a CSM rig.
 *
 * This is the function that chooses what the renderer ships: it says, for one
 * lens and one split, exactly how many centimetres a shadow texel is worth in
 * each cascade and therefore what the caster policy's thickness floor becomes
 * there. The floor is `minThicknessTexels * texelWorldSize` - the same product
 * `resolveShadowCasterContext` computes - so the two modules agree by
 * construction rather than by a copied constant.
 *
 * @param {object} options
 * @param {number} [options.cascades=3]
 * @param {number} [options.mapSize=2048] Square map size, per cascade.
 * @param {number} options.fovDeg Vertical field of view.
 * @param {number} options.aspect Width / height.
 * @param {number} [options.cameraNear=0.5]
 * @param {number} [options.maxFar=250] CSM's `maxFar`; the split runs
 *   `cameraNear .. min(cameraFar, maxFar)`.
 * @param {number} [options.cameraFar=Infinity]
 * @param {number} [options.lambda=PRACTICAL_SPLIT_LAMBDA]
 * @param {number} [options.minThicknessTexels=1.5] Mirrors
 *   `MIN_THICKNESS_TEXELS` in ./shadow-casters.js.
 * @returns {Readonly<object>} `{ version, cascades: [...], far, breaks,
 *   texelBytes, finestTexelWorldSize, coarsestTexelWorldSize }`
 */
export function planCascadeTexelBudget(options = {}) {
  const {
    cascades = 3,
    mapSize = 2048,
    fovDeg,
    aspect,
    cameraNear = CASCADE_PLAN_DEFAULTS.cameraNear,
    maxFar = 250,
    cameraFar = Infinity,
    lambda = PRACTICAL_SPLIT_LAMBDA,
    minThicknessTexels = 1.5,
  } = options;
  if (!Number.isInteger(mapSize) || mapSize < 16) {
    throw new TypeError(`sun-shadow-cascade: mapSize must be an integer >= 16, got ${mapSize}`);
  }
  if (!isFiniteNumber(minThicknessTexels) || minThicknessTexels <= 0) {
    throw new TypeError(`sun-shadow-cascade: minThicknessTexels must be positive, got ${minThicknessTexels}`);
  }
  const far = Math.min(cameraFar, maxFar);
  const breaks = practicalCascadeBreaks(cascades, cameraNear, far, lambda);
  const slices = [];
  let previous = cameraNear;
  for (let i = 0; i < cascades; i += 1) {
    // `breaks` are computed by `_getBreaks` as fractions OF `far`, and then
    // applied by `CSMFrustum.split` as lerp fractions FROM `cameraNear` TO
    // `far`. Those are not the same mapping, and three uses the second one.
    // Reproducing three's behaviour is the point of this function, so the
    // inconsistency is copied deliberately rather than tidied away: tidying it
    // would make this file disagree with the rig it claims to describe by
    // about 1% of a texel at the near cascade.
    const sliceFar = i === cascades - 1 ? far : cameraNear + (far - cameraNear) * breaks[i];
    const halfExtent = cascadeSliceHalfExtent(previous, sliceFar, fovDeg, aspect);
    const texelWorldSize = (halfExtent * 2) / mapSize;
    slices.push(Object.freeze({
      index: i,
      near: round(previous, 4),
      far: round(sliceFar, 4),
      /** Fraction of `far` this cascade is authoritative up to. */
      breakFraction: round(breaks[i], 6),
      halfExtent: round(halfExtent, 4),
      width: round(halfExtent * 2, 4),
      mapSize,
      texelWorldSize: round(texelWorldSize, 6),
      texelsPerMetre: round(1 / texelWorldSize, 4),
      /** Thinnest mesh this cascade can resolve, metres. */
      minCasterThickness: round(minThicknessTexels * texelWorldSize, 4),
    }));
    previous = sliceFar;
  }
  return Object.freeze({
    version: SUN_SHADOW_CASCADE_VERSION,
    cascades: Object.freeze(slices),
    cameraNear,
    maxFar,
    far: round(far, 4),
    lambda,
    minThicknessTexels,
    breaks: Object.freeze(breaks.map((b) => round(b, 6))),
    /** Depth-attachment bytes at 32-bit, all cascades. The cost line. */
    texelBytes: cascades * mapSize * mapSize * 4,
    finestTexelWorldSize: slices[0].texelWorldSize,
    coarsestTexelWorldSize: slices[slices.length - 1].texelWorldSize,
    finestMinCasterThickness: slices[0].minCasterThickness,
    coarsestMinCasterThickness: slices[slices.length - 1].minCasterThickness,
  });
}

/**
 * Choose the cascade count and `maxFar` for a lens and a texel target.
 *
 * The rule is the one the round-4 evidence forces: the NEAR cascade has to
 * resolve street-scale trim, so its texel has to be small enough that
 * `minThicknessTexels * texelWorldSize` sits under the thinnest thing that
 * must cast. Cascade count is the only free variable that buys that without
 * either growing the map (memory) or shortening the reach (visible cut-off),
 * so this searches the counts in order and returns the first that clears the
 * target - and reports every count it rejected, with its number.
 *
 * Each extra cascade is an extra shadow render pass per frame. On a software
 * rasterizer that is the dominant cost of the whole feature, so the search
 * stops at the FIRST count that works rather than the best one.
 *
 * @param {object} options `planCascadeTexelBudget` fields, plus:
 * @param {number} options.targetMinCasterThickness Metres. The thinnest mesh
 *   the near cascade must be able to admit.
 * @param {number[]} [options.counts=[1,2,3,4]] Cascade counts to try, in order.
 * @returns {Readonly<object>} `{ found, cascades, maxFar, budget, tried }`
 */
export function recommendCascadeCount(options = {}) {
  const { targetMinCasterThickness, counts = [1, 2, 3, 4], ...rest } = options;
  if (!isFiniteNumber(targetMinCasterThickness) || targetMinCasterThickness <= 0) {
    throw new TypeError('sun-shadow-cascade: targetMinCasterThickness must be positive metres, '
      + `got ${targetMinCasterThickness}`);
  }
  const tried = [];
  for (const cascades of counts) {
    const budget = planCascadeTexelBudget({ ...rest, cascades });
    const achieved = budget.finestMinCasterThickness;
    if (achieved <= targetMinCasterThickness) {
      return Object.freeze({
        version: SUN_SHADOW_CASCADE_VERSION,
        found: true,
        cascades,
        maxFar: budget.maxFar,
        minCasterThickness: achieved,
        shadowPassesPerFrame: cascades,
        budget,
        tried: Object.freeze(tried),
      });
    }
    tried.push(Object.freeze({
      cascades,
      minCasterThickness: achieved,
      reason: `near cascade resolves ${round(achieved * 100, 1)} cm, over the `
        + `${round(targetMinCasterThickness * 100, 1)} cm target`,
    }));
  }
  return Object.freeze({
    version: SUN_SHADOW_CASCADE_VERSION,
    found: false,
    cascades: null,
    maxFar: null,
    tried: Object.freeze(tried),
  });
}
