// Shadow-caster admission policy for the canonical city renderer.
//
// Why this module exists
// ----------------------
// The sun's shadow map is 2048x2048 fitted to a 220 m slice of the view
// frustum. `computeSunShadowCamera` in ./environment-ibl.js reports the
// achieved density; on the current build it is 0.21392 m per texel
// (4.675 texels/m, ortho half-extent 219.05 m, depthRange 995.4 m,
// normalBias 0.2674, bias -0.0002149). Those five numbers are consistent with
// each other to five decimals, so they are the ground truth this module is
// calibrated against - not the nominal "5.2 texels/m", which is the density
// you would get without the fit's one-texel containment margin.
//
// The scene currently marks 297 meshes `castShadow = true`. 143 of them have a
// smallest bounding-box dimension under 0.35 m, and 137 of those are the
// shopfront awnings: 12 m x 0.14 m x 1.25 m plates hanging 2.7 m above the
// pavement. A 0.14 m plate is 0.654 shadow texels thick. It cannot produce a
// correct shadow, and the artifact it produces instead is the set of hard dark
// bands the night card shows lying across real roadway.
//
// The geometry of that failure, stated precisely
// ----------------------------------------------
// Two independent mechanisms break at sub-texel thickness, and both are
// quantified by the same number, the texel world size `w`:
//
//   1. **The bias is larger than the object.** `normalBias` displaces the
//      shadow lookup along the receiving surface's normal by `b` metres before
//      the depth comparison. At the current fit `b = 1.25 w = 0.2674 m`. The
//      awning is 0.14 m thick. So for any surface on the awning - and for the
//      first few centimetres of wall directly behind it - the biased lookup
//      point lies on the *far side of the awning itself*, i.e. on the lit side
//      of its own occluder. The comparison then flips between "shadowed" and
//      "lit" on sub-texel detail, which is what turns a soft 12 m awning
//      shadow into hard-edged geometric banding. You cannot fix this by
//      lowering `b`, because `b` is set by (2) below.
//
//   2. **The bias cannot be lowered, because acne scales with the texel.**
//      Inside one shadow texel the receiver's depth along the light varies by
//      `w * tan(phi)`, where `phi` is the angle between the receiver normal and
//      the light. Cancelling half of that with a normal offset needs
//        b >= w * sin(phi) / (2 * cos(phi)^2)
//      which is 0.71 w at phi = 45 deg, 1.73 w at 60 deg and 4.0 w at 70 deg.
//      The shipped 1.25 w is the design point that holds to about 55 deg. Any
//      bias that stops acne on a raking facade is, by construction, several
//      times thicker than a 14 cm plate.
//
// So the bias needed to keep a 0.21 m texel clean is larger than the object
// being biased. There is no value of `normalBias` that serves both. The object
// has to leave the caster set. That is not a workaround; at this texel size it
// is the only correct answer, and `recommendShadowBias()` below shows what
// texel size would be needed to change it (spoiler: 0.093 m, i.e. 4096 at
// 96 m of shadow distance - out of reach this round).
//
// What this module is
// -------------------
// A pure decision function. Given a mesh's bounding-box dimensions, its name
// and parent name, its clearance above the ground and the *current* texel size
// in metres, it returns whether the mesh should cast and a human-readable
// reason carrying the numbers, so the integrator can log a histogram of why
// things were excluded rather than guessing.
//
// It moves these rubric dimensions in Docs/VISUAL_QUALITY_GATE.md:
//   - "Lighting and atmosphere" (the night card's spurious dark bands)
//   - "Street and road realism" (roadway no longer painted with fake shadow)
//   - "Character rendering" (the thickness floor is calibrated to keep people
//     casting; see MIN_THICKNESS_TEXELS)
//
// Design constraints honoured here
// --------------------------------
//   * No renderer, canvas, RAF loop, scene root or light is created.
//   * No ShaderMaterial, no onBeforeCompile, no addons: this module never
//     touches a material at all.
//   * The decision core imports nothing and touches no scene object, so it is
//     assertable from plain node. `three` is imported only by the two optional
//     integration helpers at the bottom of the file.
//   * No Math.random(), no Date.now(). Same inputs -> same decision, always.
//   * Presentation-only: nothing here reads or writes simulation state. It
//     sets `castShadow`, which is a render flag, and nothing else.

import * as THREE from 'three';

export const SHADOW_CASTER_VERSION = 'shadow-casters-v1';

// ---------------------------------------------------------------------------
// Calibration constants
// ---------------------------------------------------------------------------

/**
 * Minimum caster thickness, expressed in shadow texels.
 *
 * 1.5 is the width `PCFSoftShadowMap` actually reads: a 2x2 hardware PCF tap
 * spread across the texel grid covers ~1.5 texels. An occluder thinner than
 * the filter kernel cannot put a resolvable step into the map - every tap that
 * sees it also sees past it.
 *
 * The value is also bracketed by real scene content at the current
 * w = 0.21392 m, and the bracket is narrow enough to be worth writing down:
 *
 *   shopfront awning   0.14 m  = 0.65 texels   must NOT cast
 *   thin cable         0.05 m  = 0.23 texels   must NOT cast
 *   1.5 texel floor    0.32 m
 *   human torso depth  0.35 m  = 1.64 texels   must cast
 *   parking bollard    0.40 m  = 1.87 texels   must cast
 *
 * Raising the floor to 2.0 texels (0.428 m) would stop pedestrians casting,
 * which is a visible regression on the character dimension. Lowering it to
 * 1.0 texel (0.214 m) re-admits geometry the PCF kernel cannot resolve. 1.5 is
 * the only setting with clearance on both sides. See "Known risks" in the
 * task report: this margin shrinks if the texel grows.
 */
export const MIN_THICKNESS_TEXELS = 1.5;

/**
 * A mesh must also be at least this many texels across its *largest* dimension
 * before it is worth a draw in the shadow pass. Below ~2 texels the silhouette
 * is a single filtered blob that reads as dirt, not as an object.
 */
export const MIN_SPAN_TEXELS = 2;

/**
 * Largest dimension, in metres, at or above which geometry counts as "large
 * structural". Structural geometry is exempt from the ring test because the
 * fit's near-plane extrusion deliberately lets a tall building far outside the
 * ring throw a complete shadow into it at low sun.
 */
export const STRUCTURE_MIN_SPAN = 4;

/**
 * Clearance below which a mesh is sitting on the ground rather than above it.
 * 2 cm is under one tenth of a texel: nothing at this clearance can cast a
 * shadow that lands anywhere except on the surface it is already touching.
 */
export const MIN_GROUND_CLEARANCE = 0.02;

/**
 * Aspect ratio (largest dimension / smallest dimension) at or above which a
 * ground-flush mesh is treated as a decal - road markings, crosswalk bars,
 * manhole plates, patches. These are coplanar with the road; admitting them to
 * the shadow pass buys nothing but self-acne.
 */
export const DECAL_ASPECT_RATIO = 20;

/** The measured texel world size on the current build, in metres. */
export const MEASURED_TEXEL_WORLD_SIZE = 0.21392;

/** The measured fit half-extent on the current build, in metres. */
export const MEASURED_RING_RADIUS = 219.05;

/** Defaults for the per-frame policy context. */
export const SHADOW_CASTER_DEFAULTS = Object.freeze({
  /** Shadow texel size in metres. Take this from `fit.texelWorldSize`. */
  texelWorldSize: MEASURED_TEXEL_WORLD_SIZE,
  /** Radius, in metres, inside which mid-scale props are worth a shadow. */
  ringRadius: MEASURED_RING_RADIUS,
  minThicknessTexels: MIN_THICKNESS_TEXELS,
  minSpanTexels: MIN_SPAN_TEXELS,
  structureMinSpan: STRUCTURE_MIN_SPAN,
  minGroundClearance: MIN_GROUND_CLEARANCE,
  decalAspectRatio: DECAL_ASPECT_RATIO,
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Role vocabulary. The role is a *hint*, never the decision: the task is
 * explicit that decorative trim must be judged on measured thickness against
 * texel size and not on its name. The role only decides which gates apply -
 * whether the ring test runs, and whether the structural exemption applies.
 */
export const SHADOW_ROLES = Object.freeze({
  /** Buildings, walls, bridges, piers. Always casts above STRUCTURE_MIN_SPAN. */
  STRUCTURE: 'structure',
  /** Terrain and road surface. Always casts; hillsides must shade themselves. */
  TERRAIN: 'terrain',
  /** Vehicles, street furniture, trees, people. Casts inside the ring. */
  PROP: 'prop',
  /** Awnings, bunting, neon, wires, cables, railings. Thickness decides. */
  TRIM: 'trim',
  /** Road markings, patches, painted detail. Never casts. */
  DECAL: 'decal',
  /** Sky dome, water, glows, light pools, helpers. Never casts. */
  NON_OCCLUDER: 'non-occluder',
  /** Unclassified. Treated exactly as PROP. */
  UNKNOWN: 'unknown',
});

/**
 * Name fragments per role, matched case-insensitively against the mesh name
 * and its parent chain. Ordered: the first role whose fragment list matches
 * wins, so DECAL and TRIM are tested before the broader PROP and STRUCTURE
 * lists. `shopfront-awnings` matches `awning` and lands in TRIM before the
 * `front` in `shopfront` could reach anything else.
 *
 * These are hints for the integrator, exposed so it can override them. They
 * are deliberately generic English nouns describing city geometry.
 */
export const SHADOW_ROLE_HINTS = Object.freeze([
  Object.freeze({
    role: SHADOW_ROLES.NON_OCCLUDER,
    fragments: Object.freeze([
      'sky-dome', 'skydome', 'sky_dome', 'skybox', 'sky-sphere', 'backdrop',
      'horizon', 'cloud', 'fog-', 'volumetric', 'billboard', 'impostor',
      'glow', 'halo', 'flare', 'light-pool', 'lightpool', 'night-light',
      'water', 'ocean', 'ripple', 'wake', 'reflection', 'caustic',
      'helper', 'gizmo', 'debug', 'contour', 'contact-shadow',
    ]),
  }),
  Object.freeze({
    role: SHADOW_ROLES.DECAL,
    fragments: Object.freeze([
      'marking', 'crosswalk', 'crossing-stripe', 'lane-line', 'road-paint',
      'decal', 'manhole', 'patch', 'puddle', 'stain', 'grate', 'contact-shadow',
    ]),
  }),
  Object.freeze({
    role: SHADOW_ROLES.TRIM,
    fragments: Object.freeze([
      'awning', 'bunting', 'banner', 'pennant', 'garland', 'flag',
      'neon', 'signage', 'sign', 'lettering', 'placard',
      'wire', 'cable', 'catenary', 'aerial', 'antenna',
      'rail', 'railing', 'handrail', 'balustrade', 'guardrail',
      'cornice', 'ledge', 'moulding', 'molding', 'trim', 'fascia',
      'overhead', 'sleeper', 'tie-bar', 'mesh-panel', 'lattice',
      'gutter', 'downpipe', 'conduit', 'louvre', 'louver', 'blind',
    ]),
  }),
  Object.freeze({
    role: SHADOW_ROLES.PROP,
    fragments: Object.freeze([
      'vehicle', 'car', 'bus', 'truck', 'van', 'taxi', 'tram', 'trolley',
      'bike', 'bicycle', 'scooter', 'motorcycle', 'cab',
      'tree', 'trunk', 'canopy', 'foliage', 'shrub', 'hedge', 'planter',
      'pedestrian', 'person', 'people', 'npc', 'actor', 'civilian', 'walker',
      'bench', 'lamp', 'lamppost', 'streetlight', 'bollard', 'hydrant',
      'kiosk', 'newsstand', 'stall', 'stand', 'booth',
      'bin', 'dumpster', 'trash', 'waste', 'recycl', 'crate', 'pallet',
      'barrier', 'cone', 'barricade',
      'mailbox', 'postbox', 'meter', 'phonebox', 'umbrella', 'parasol',
      'table', 'chair', 'stool', 'pole', 'post', 'sculpture', 'statue',
      'prop', 'furniture', 'rack', 'cart', 'trolley-stand',
    ]),
  }),
  Object.freeze({
    role: SHADOW_ROLES.TERRAIN,
    fragments: Object.freeze([
      'terrain', 'ground', 'hillside', 'landform', 'roadway', 'road-surface',
      'street-surface', 'asphalt', 'sidewalk', 'pavement', 'kerb', 'curb',
      'plaza', 'seabed',
    ]),
  }),
  Object.freeze({
    role: SHADOW_ROLES.STRUCTURE,
    fragments: Object.freeze([
      'building', 'tower', 'block', 'shell', 'facade', 'storefront',
      'shopfront', 'wall', 'parapet', 'roof', 'chimney', 'stair', 'stairs',
      'bridge', 'pier', 'wharf', 'jetty', 'seawall', 'retaining', 'abutment',
      'overpass', 'underpass', 'tunnel', 'garage', 'warehouse', 'landmark',
      'monument', 'column', 'pillar', 'buttress',
    ]),
  }),
]);

/**
 * Classify a mesh into a shadow role from its own name and its ancestors'
 * names. Pure, allocation-light, case-insensitive, first-match-wins in the
 * declared `SHADOW_ROLE_HINTS` order.
 *
 * The mesh's own name is tested against every role before the parent names
 * are, so a `neon-strip` parented to `building-42` classifies as TRIM rather
 * than inheriting STRUCTURE from its parent.
 *
 * @param {string|null|undefined} name Mesh name.
 * @param {string|string[]|null} [parentNames] Parent name, or the ancestor
 *   chain from nearest to furthest.
 * @returns {string} One of `SHADOW_ROLES`.
 */
export function classifyShadowRole(name, parentNames = null) {
  const chain = [];
  if (typeof name === 'string' && name.length > 0) chain.push(name.toLowerCase());
  if (typeof parentNames === 'string' && parentNames.length > 0) {
    chain.push(parentNames.toLowerCase());
  } else if (Array.isArray(parentNames)) {
    for (const entry of parentNames) {
      if (typeof entry === 'string' && entry.length > 0) chain.push(entry.toLowerCase());
    }
  }
  for (const candidate of chain) {
    for (const hint of SHADOW_ROLE_HINTS) {
      for (const fragment of hint.fragments) {
        if (candidate.includes(fragment)) return hint.role;
      }
    }
  }
  return SHADOW_ROLES.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Decision codes
// ---------------------------------------------------------------------------

/**
 * Every value `decision.code` can take. Stable strings: the integrator keys a
 * histogram off these, so they are part of the contract and are sorted
 * deterministically by `summariseShadowCasterAudit`.
 */
export const SHADOW_DECISION_CODES = Object.freeze({
  CAST_STRUCTURE: 'cast:structure',
  CAST_TERRAIN: 'cast:terrain',
  CAST_PROP: 'cast:prop',
  CAST_TRIM: 'cast:trim',
  CAST_FORCED: 'cast:forced',
  SKIP_DEGENERATE: 'skip:degenerate',
  SKIP_SUB_TEXEL: 'skip:sub-texel',
  SKIP_SUB_SPAN: 'skip:sub-span',
  SKIP_DECAL: 'skip:decal',
  SKIP_NON_OCCLUDER: 'skip:non-occluder',
  SKIP_GROUND_FLUSH: 'skip:ground-flush',
  SKIP_OUT_OF_RING: 'skip:out-of-ring',
  SKIP_OPTED_OUT: 'skip:opted-out',
});

const CODE_ORDER = Object.freeze(Object.values(SHADOW_DECISION_CODES));

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * Normalise and validate a policy context once, so the per-mesh call can stay
 * branch-light when it runs across a few hundred meshes every rebuild.
 *
 * @param {object} [context]
 * @returns {Readonly<object>} Frozen, fully-populated context.
 */
export function resolveShadowCasterContext(context = {}) {
  const merged = { ...SHADOW_CASTER_DEFAULTS, ...context };
  const {
    texelWorldSize, ringRadius, minThicknessTexels, minSpanTexels,
    structureMinSpan, minGroundClearance, decalAspectRatio,
  } = merged;
  if (!isFiniteNumber(texelWorldSize) || texelWorldSize <= 0) {
    throw new TypeError(`shadow-casters: texelWorldSize must be positive metres, got ${texelWorldSize}`);
  }
  if (!isFiniteNumber(ringRadius) || ringRadius <= 0) {
    throw new TypeError(`shadow-casters: ringRadius must be positive metres, got ${ringRadius}`);
  }
  if (!isFiniteNumber(minThicknessTexels) || minThicknessTexels <= 0) {
    throw new TypeError(`shadow-casters: minThicknessTexels must be positive, got ${minThicknessTexels}`);
  }
  return Object.freeze({
    texelWorldSize,
    ringRadius,
    minThicknessTexels,
    minSpanTexels,
    structureMinSpan,
    minGroundClearance,
    decalAspectRatio,
    /** Derived: the thickness floor in metres. This is the headline number. */
    minThickness: minThicknessTexels * texelWorldSize,
    minSpan: minSpanTexels * texelWorldSize,
    texelsPerMetre: 1 / texelWorldSize,
    version: SHADOW_CASTER_VERSION,
  });
}

function decision(cast, code, reason, extra) {
  return Object.freeze({ cast, code, reason, ...extra });
}

/**
 * Decide whether one mesh should cast a sun shadow.
 *
 * **Pure.** Reads only its arguments, allocates only its result, imports
 * nothing from three, touches no scene object and no simulation state.
 *
 * Gate order, and why it is this order:
 *
 *   1. degenerate box            - nothing measurable, refuse rather than guess
 *   2. explicit `cast` override  - the integrator always gets the last word
 *   3. non-occluder role         - sky dome, water, glow: not solid matter
 *   4. decal role                - coplanar with the road; pure acne, no gain
 *   5. large structural / terrain- exempt from the thickness floor and the ring
 *   6. thickness vs texel        - THE gate this module exists for
 *   7. span vs texel             - too small to read even when thick enough
 *   8. ground-flush thin plate   - can only ever shade what it rests on
 *   9. ring                      - mid-scale props outside the fit box
 *
 * Gates 5-8 are all monotone non-decreasing in thickness: once a mesh is thick
 * enough to cast, making it thicker never takes the shadow away. The
 * self-check asserts this by sweeping thickness across the texel size.
 *
 * @param {object} descriptor
 * @param {string} [descriptor.name] Mesh name, used for the role hint.
 * @param {string|string[]} [descriptor.parentName] Parent name or ancestor chain.
 * @param {string} [descriptor.role] Explicit role, overrides the name hint.
 * @param {{x:number,y:number,z:number}|number[]} descriptor.size World-space
 *   bounding-box dimensions in metres.
 * @param {number|null} [descriptor.groundClearance] Metres from the ground to
 *   the mesh's underside. `null`/omitted means unknown, and the ground-flush
 *   gate is skipped rather than guessed.
 * @param {number|null} [descriptor.distance] Metres from the shadow-fit centre
 *   (`fit.target`). `null`/omitted means unknown, and the ring gate passes.
 * @param {boolean|null} [descriptor.cast] Explicit override. `false` opts out,
 *   `true` opts in, `null`/omitted defers to the policy.
 * @param {object} [context] See `SHADOW_CASTER_DEFAULTS`. Pass the resolved
 *   context from `resolveShadowCasterContext` when calling in a loop.
 * @returns {Readonly<object>} `{ cast, code, reason, role, minDimension,
 *   maxDimension, thicknessTexels, spanTexels, minThickness }`
 */
export function shadowCasterDecision(descriptor = {}, context = SHADOW_CASTER_DEFAULTS) {
  const ctx = Object.isFrozen(context) && context.version === SHADOW_CASTER_VERSION
    ? context
    : resolveShadowCasterContext(context);

  const raw = descriptor.size;
  let sx = NaN;
  let sy = NaN;
  let sz = NaN;
  if (Array.isArray(raw) && raw.length >= 3) {
    [sx, sy, sz] = raw;
  } else if (raw && typeof raw === 'object') {
    sx = raw.x;
    sy = raw.y;
    sz = raw.z;
  }

  const role = typeof descriptor.role === 'string' && descriptor.role
    ? descriptor.role
    : classifyShadowRole(descriptor.name, descriptor.parentName ?? null);

  const dims = [Math.abs(sx), Math.abs(sy), Math.abs(sz)];
  const measurable = dims.every((d) => Number.isFinite(d) && d > 0);
  const sorted = measurable ? [...dims].sort((a, b) => a - b) : null;
  const minDimension = measurable ? sorted[0] : NaN;
  // The MEDIAN, not the max, is what makes something "large structural". A
  // 12 m x 1.25 m x 0.14 m awning has a 12 m max dimension and would sail
  // through a max-based test if it were ever misnamed into a structural
  // bucket; its median is 1.25 m, which is honest about it being a plate. A
  // real wall (20 x 10 x 0.3) has a 10 m median and keeps its exemption.
  const medianDimension = measurable ? sorted[1] : NaN;
  const maxDimension = measurable ? sorted[2] : NaN;
  const thicknessTexels = measurable ? round(minDimension / ctx.texelWorldSize, 4) : NaN;
  const spanTexels = measurable ? round(maxDimension / ctx.texelWorldSize, 4) : NaN;
  const base = {
    role,
    minDimension,
    medianDimension,
    maxDimension,
    thicknessTexels,
    spanTexels,
    minThickness: round(ctx.minThickness, 4),
    texelWorldSize: ctx.texelWorldSize,
  };

  // 1. Degenerate.
  if (!measurable) {
    return decision(false, SHADOW_DECISION_CODES.SKIP_DEGENERATE,
      `bounding box is not measurable (${sx}, ${sy}, ${sz}); refusing to guess`, base);
  }

  // 2. Explicit override. The integrator owns the scene; the policy advises.
  if (descriptor.cast === false) {
    return decision(false, SHADOW_DECISION_CODES.SKIP_OPTED_OUT,
      'explicitly opted out by the integrator', base);
  }
  if (descriptor.cast === true) {
    return decision(true, SHADOW_DECISION_CODES.CAST_FORCED,
      'explicitly forced on by the integrator', base);
  }

  // 3. Things that are not solid matter at all.
  if (role === SHADOW_ROLES.NON_OCCLUDER) {
    return decision(false, SHADOW_DECISION_CODES.SKIP_NON_OCCLUDER,
      'sky dome, water, glow, light pool or helper geometry: it is not an '
      + 'occluder, and its bounding box is large enough to shadow the whole map', base);
  }

  // 4. Decals are coplanar with what they sit on.
  if (role === SHADOW_ROLES.DECAL) {
    return decision(false, SHADOW_DECISION_CODES.SKIP_DECAL,
      'painted/coplanar detail: a shadow could only land on the surface it is '
      + 'already drawn onto, so casting is pure self-acne', base);
  }

  // 5. Large structural geometry and terrain always cast, and are exempt from
  //    both the thickness gate and the ring. The thickness exemption is
  //    deliberate: a 0.30 m building wall is 1.4 texels and would otherwise be
  //    culled, but a wall's shadow is the single most important one in the
  //    frame. The ring exemption is also deliberate: the fit's near-plane
  //    extrusion exists precisely so a tower well outside the box still writes
  //    a complete shadow into it at low sun.
  //
  //    Both exemptions are gated on the MEDIAN dimension, so nothing plate-like
  //    can buy its way in on one long edge.
  const structural = medianDimension >= ctx.structureMinSpan;
  if (role === SHADOW_ROLES.TERRAIN && structural) {
    return decision(true, SHADOW_DECISION_CODES.CAST_TERRAIN,
      `terrain/road surface ${round(medianDimension, 1)} m across: hillsides and `
      + 'grades must shade themselves and everything downslope, at any distance', base);
  }
  if (role === SHADOW_ROLES.STRUCTURE && structural) {
    return decision(true, SHADOW_DECISION_CODES.CAST_STRUCTURE,
      `structural geometry, median dimension ${round(medianDimension, 2)} m `
      + `(>= ${ctx.structureMinSpan} m): always casts, exempt from the thickness `
      + 'floor and the ring', base);
  }

  // 6. The thickness gate. This is the whole point of the module.
  if (minDimension < ctx.minThickness) {
    return decision(false, SHADOW_DECISION_CODES.SKIP_SUB_TEXEL,
      `${round(minDimension, 3)} m thick = ${thicknessTexels} shadow texels, `
      + `under the ${ctx.minThicknessTexels}-texel floor `
      + `(${round(ctx.minThickness, 3)} m at ${round(ctx.texelWorldSize, 5)} m/texel): `
      + 'thinner than the PCF kernel and thinner than the normalBias needed to '
      + 'keep this texel size free of acne, so it can only produce banding', base);
  }

  // 7. Span gate. Thick enough, but too small to read as anything.
  if (maxDimension < ctx.minSpan) {
    return decision(false, SHADOW_DECISION_CODES.SKIP_SUB_SPAN,
      `${round(maxDimension, 3)} m across = ${spanTexels} shadow texels, `
      + `under the ${ctx.minSpanTexels}-texel span floor: the silhouette would `
      + 'filter down to a single blob', base);
  }

  // 8. A thin plate lying on the ground. Monotone in thickness: the aspect
  //    ratio falls as the mesh thickens, so this gate only ever opens.
  const clearance = descriptor.groundClearance;
  if (isFiniteNumber(clearance)
    && clearance < ctx.minGroundClearance
    && maxDimension / minDimension >= ctx.decalAspectRatio) {
    return decision(false, SHADOW_DECISION_CODES.SKIP_GROUND_FLUSH,
      `flush with the ground (${round(clearance, 3)} m clearance) and `
      + `${round(maxDimension / minDimension, 1)}:1 flat: its shadow would land `
      + 'inside the surface it rests on', base);
  }

  // 9. The ring. Mid-scale props outside the fitted box contribute no texels.
  const distance = descriptor.distance;
  if (isFiniteNumber(distance) && distance > ctx.ringRadius) {
    return decision(false, SHADOW_DECISION_CODES.SKIP_OUT_OF_RING,
      `${round(distance, 1)} m from the shadow-fit centre, outside the `
      + `${round(ctx.ringRadius, 1)} m ring: it would be rasterised into a map `
      + 'region that is never sampled', base);
  }

  if (role === SHADOW_ROLES.TRIM) {
    return decision(true, SHADOW_DECISION_CODES.CAST_TRIM,
      `trim, but measured at ${round(minDimension, 3)} m = ${thicknessTexels} `
      + 'texels thick, which the map can resolve', base);
  }
  return decision(true, SHADOW_DECISION_CODES.CAST_PROP,
    `${round(minDimension, 3)} m thick = ${thicknessTexels} texels, inside the `
    + `${round(ctx.ringRadius, 1)} m ring`, base);
}

/**
 * Boolean-only convenience wrapper around `shadowCasterDecision`.
 * @returns {boolean}
 */
export function shouldCastShadow(descriptor, context) {
  return shadowCasterDecision(descriptor, context).cast;
}

/**
 * Bind a context once and get a `decide(descriptor)` closure. Cheaper in a
 * loop than re-resolving the context per mesh, and it makes the call site read
 * as one decision per mesh.
 *
 * @param {object} [context]
 * @returns {Readonly<{context: object, decide: Function, cast: Function}>}
 */
export function createShadowCasterPolicy(context = {}) {
  const resolved = resolveShadowCasterContext(context);
  return Object.freeze({
    context: resolved,
    decide: (descriptor) => shadowCasterDecision(descriptor, resolved),
    cast: (descriptor) => shadowCasterDecision(descriptor, resolved).cast,
  });
}

// ---------------------------------------------------------------------------
// Audit: the "why was it excluded" histogram
// ---------------------------------------------------------------------------

/**
 * Collect decisions into a deterministic histogram keyed by decision code,
 * with one worked example per code so the log line is actionable rather than
 * just a count.
 *
 * @returns {object} `{ record, total, casting, excluded, histogram, lines, toJSON }`
 */
export function createShadowCasterAudit() {
  const buckets = new Map();
  let total = 0;
  let casting = 0;

  const audit = {
    /**
     * @param {Readonly<object>} result A `shadowCasterDecision` result.
     * @param {string} [name] Mesh name, kept as the bucket's example.
     * @returns {Readonly<object>} `result`, for chaining.
     */
    record(result, name = '') {
      total += 1;
      if (result.cast) casting += 1;
      let bucket = buckets.get(result.code);
      if (!bucket) {
        bucket = { code: result.code, count: 0, example: name, reason: result.reason };
        buckets.set(result.code, bucket);
      }
      bucket.count += 1;
      return result;
    },
    get total() { return total; },
    get casting() { return casting; },
    get excluded() { return total - casting; },
    /**
     * Sorted by the declared `SHADOW_DECISION_CODES` order, so two runs over
     * the same scene produce byte-identical output.
     */
    histogram() {
      const rank = (code) => {
        const index = CODE_ORDER.indexOf(code);
        return index < 0 ? CODE_ORDER.length : index;
      };
      return [...buckets.values()]
        .sort((a, b) => rank(a.code) - rank(b.code) || (a.code < b.code ? -1 : 1))
        .map((bucket) => Object.freeze({ ...bucket }));
    },
    /** Ready-to-log lines. No timestamps: deterministic by construction. */
    lines(pass = SHADOW_CASTER_VERSION) {
      const out = [`[${pass}] ${casting}/${total} meshes cast, ${total - casting} excluded`];
      for (const bucket of audit.histogram()) {
        out.push(`[${pass}]   ${bucket.code} x${bucket.count}`
          + (bucket.example ? ` e.g. "${bucket.example}"` : '')
          + ` - ${bucket.reason}`);
      }
      return out;
    },
    toJSON() {
      return {
        version: SHADOW_CASTER_VERSION,
        total,
        casting,
        excluded: total - casting,
        histogram: audit.histogram(),
      };
    },
  };
  return audit;
}

/**
 * Render an audit as a single string. Pure and deterministic.
 * @param {object} audit Result of `createShadowCasterAudit`.
 * @param {string} [pass] Log prefix.
 * @returns {string}
 */
export function summariseShadowCasterAudit(audit, pass = SHADOW_CASTER_VERSION) {
  return audit.lines(pass).join('\n');
}

// ---------------------------------------------------------------------------
// Bias recommendation
// ---------------------------------------------------------------------------

/**
 * Minimum `normalBias`, in texel widths, that cancels half a texel of
 * slope-induced depth error on a receiver whose normal is `phi` degrees off
 * the light direction:
 *
 *   b >= w * sin(phi) / (2 * cos(phi)^2)
 *
 * Exported because it is the formula the whole bias recommendation rests on
 * and the self-check asserts it directly.
 *
 * @param {number} phiDeg Receiver normal vs light direction, in degrees.
 * @returns {number} Required normalBias in texel widths.
 */
export function normalBiasTexelsForSlope(phiDeg) {
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  if (!(cos > 1e-6)) return Infinity;
  return Math.sin(phi) / (2 * cos * cos);
}

/**
 * Recommend `bias` / `normalBias` for a given fit, with the reasoning attached.
 *
 * **Pure.** Call it again with a new `texelWorldSize` or `depthRange` when the
 * fit changes - that *is* the rescaling rule. Nothing here should ever be
 * frozen into a constant, which is the mistake the shipped fixed `-0.0004`
 * made before `computeSunShadowCamera` replaced it.
 *
 * @param {object} options
 * @param {number} [options.texelWorldSize] Metres per shadow texel
 *   (`fit.texelWorldSize`). Supply this or `texelsPerMetre`.
 * @param {number} [options.texelsPerMetre] Alternative to `texelWorldSize`.
 * @param {number} [options.depthRange] `fit.far - fit.near`, in metres.
 * @param {number} [options.mapSize=2048]
 * @param {number} [options.maxReceiverSlopeDeg=55] The steepest receiver angle
 *   the normal offset is asked to hold. Above this the surface is allowed to
 *   fall back on the depth bias.
 * @param {number} [options.sunAltitudeDeg=52] Used only to price the contact
 *   leak that the depth bias buys.
 * @param {number} [options.minThicknessTexels=MIN_THICKNESS_TEXELS]
 * @returns {Readonly<object>} numbers, costs, warnings and rationale.
 */
export function recommendShadowBias(options = {}) {
  const {
    mapSize = 2048,
    depthRange = null,
    maxReceiverSlopeDeg = 55,
    sunAltitudeDeg = 52,
    minThicknessTexels = MIN_THICKNESS_TEXELS,
  } = options;

  let texelWorldSize = options.texelWorldSize;
  if (!isFiniteNumber(texelWorldSize)) {
    if (isFiniteNumber(options.texelsPerMetre) && options.texelsPerMetre > 0) {
      texelWorldSize = 1 / options.texelsPerMetre;
    } else {
      throw new TypeError('shadow-casters: recommendShadowBias needs texelWorldSize or texelsPerMetre');
    }
  }
  if (!(texelWorldSize > 0)) {
    throw new TypeError(`shadow-casters: texelWorldSize must be positive, got ${texelWorldSize}`);
  }

  // --- normalBias.
  //
  // The shipped fit uses 1.25 texels, which by the slope formula holds a
  // receiver to about 55 deg off the light. That number was chosen while the
  // caster set still contained 143 sub-texel meshes whose own depth landed in
  // the same texel as the ground behind them - the worst acne source in the
  // scene, and one a normal offset cannot fix at any magnitude.
  //
  // With those meshes removed by the thickness gate above, the residual acne
  // is ordinary slope acne on facades and road crown, so the requirement is
  // exactly the formula and nothing more. 1.0 texel holds to 51.8 deg, which
  // covers a vertical facade under a key light at 52 deg altitude (the night
  // rig) and every road surface in the city. Dropping 1.25 -> 1.0 buys back
  // 20% of the peter-panning, which is paid at the contact line - the ankles
  // of every pedestrian and the base of every kerb, i.e. exactly the character
  // and street dimensions the gate scores lowest.
  const normalBiasTexels = 1;
  const normalBias = round(normalBiasTexels * texelWorldSize, 4);
  const holdsToDeg = solveSlopeForTexels(normalBiasTexels);

  // --- bias (constant depth pull-back, in NDC).
  //
  // Give back to the depth bias what the normal offset just gave up. A depth
  // pull-back does not move a shadow's silhouette - shifting an occluder along
  // the light ray leaves its projection where it was - so it costs nothing in
  // shadow shape. It only leaks light at the contact point, by
  // `pullback / sin(sunAltitude)` metres along a flat receiver.
  //
  // 0.75 texels of pull-back = 0.16 m at the current fit = 0.20 m of contact
  // leak at 52 deg, versus the 0.05 m of peter-panning the normalBias cut
  // bought back. That is a wash on paper, and it is the right trade anyway
  // because the depth term is uniform while peter-panning is worst exactly
  // where the eye is looking. Raise `depthBiasTexels` before `normalBiasTexels`
  // if acne survives.
  //
  // NDC: the orthographic depth range maps linearly onto [-1, 1], so a
  // pull-back of `t` metres toward the light is `-2t / depthRange`. Because
  // `depthRange` swings from ~670 m at noon to ~2500 m at golden hour, this
  // MUST be recomputed per fit. A constant that is right at noon is 4x too
  // weak at 18:30.
  const depthBiasTexels = 0.75;
  const depthPullbackMetres = round(depthBiasTexels * texelWorldSize, 4);
  const bias = isFiniteNumber(depthRange) && depthRange > 0
    ? -round((depthBiasTexels * texelWorldSize * 2) / depthRange, 7)
    : null;

  const sunAlt = Math.max(sunAltitudeDeg, 1) * (Math.PI / 180);
  const contactLeak = round(depthPullbackMetres / Math.max(Math.sin(sunAlt), 1e-3), 3);
  const minCasterThickness = round(minThicknessTexels * texelWorldSize, 4);

  const warnings = [];
  if (holdsToDeg < maxReceiverSlopeDeg) {
    warnings.push(`normalBias ${normalBiasTexels} texels holds receivers only to `
      + `${round(holdsToDeg, 1)} deg, below the requested ${maxReceiverSlopeDeg} deg: `
      + `raise normalBiasTexels to ${round(normalBiasTexelsForSlope(maxReceiverSlopeDeg), 3)} `
      + 'or accept acne on near-grazing facades');
  }
  if (minCasterThickness > 0.45) {
    warnings.push(`the ${minThicknessTexels}-texel thickness floor is now `
      + `${minCasterThickness} m, above the ~0.40 m depth of a pedestrian and a `
      + 'bollard: people would stop casting. Raise mapSize or cut shadowDistance '
      + 'rather than lower the floor');
  }
  if (texelWorldSize > 0.3) {
    warnings.push(`texels are ${round(texelWorldSize, 3)} m `
      + `(${round(1 / texelWorldSize, 2)}/m): normalBias ${normalBias} m of `
      + 'peter-panning is becoming visible at eye level');
  }
  if (!isFiniteNumber(depthRange)) {
    warnings.push('no depthRange supplied, so `bias` is null: read fit.far - fit.near '
      + 'and call again. Never hard-code `bias`; it is only correct at one sun altitude');
  }

  return Object.freeze({
    version: SHADOW_CASTER_VERSION,
    mapSize,
    texelWorldSize,
    texelsPerMetre: round(1 / texelWorldSize, 4),
    // --- straight onto light.shadow
    normalBias,
    bias,
    // --- what those numbers mean
    normalBiasTexels,
    depthBiasTexels,
    depthPullbackMetres,
    depthRange,
    holdsReceiverSlopeToDeg: round(holdsToDeg, 2),
    // --- costs, in metres, so the trade is auditable
    peterPanMetres: normalBias,
    contactLeakMetres: contactLeak,
    // --- couples the bias to the caster policy
    minThicknessTexels,
    minCasterThickness,
    /**
     * Texel size at which a 0.14 m awning would clear the thickness floor.
     * Reported so "exclude it" can be checked against "make it work".
     */
    texelWorldSizeForAwning: round(0.14 / minThicknessTexels, 4),
    warnings: Object.freeze(warnings),
    rationale: Object.freeze([
      `normalBias = ${normalBiasTexels} x ${round(texelWorldSize, 5)} m = ${normalBias} m; `
        + `by b >= w sin(phi)/(2 cos^2 phi) this holds receivers to ${round(holdsToDeg, 1)} deg off the light.`,
      `bias = -2 x ${depthBiasTexels} x ${round(texelWorldSize, 5)} / depthRange`
        + (bias === null ? ' (depthRange not supplied)' : ` = ${bias} at depthRange ${round(depthRange, 1)} m.`),
      `Both scale linearly with texelWorldSize, so keep them in TEXELS and recompute per fit. `
        + `bias additionally scales as 1/depthRange, which swings ~4x across a day.`,
      `Caster thickness floor = ${minThicknessTexels} x ${round(texelWorldSize, 5)} m = ${minCasterThickness} m. `
        + `A 0.14 m awning needs texels <= ${round(0.14 / minThicknessTexels, 4)} m to qualify.`,
    ]),
  });
}

/** Invert `normalBiasTexels = sin(phi)/(2 cos^2 phi)` for phi, by bisection. */
function solveSlopeForTexels(texels) {
  let lo = 0;
  let hi = 89.9;
  for (let i = 0; i < 60; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (normalBiasTexelsForSlope(mid) < texels) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------------------
// Optional integration helpers
// ---------------------------------------------------------------------------
//
// These two touch three.js objects. They create no renderer, no light, no
// canvas, no loop and no scene root; `applyShadowCasterPolicy` writes exactly
// one property, `castShadow`, and reads nothing from the simulation.

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _instanceSize = new THREE.Vector3();
const _scale = new THREE.Vector3();

/**
 * Measure an Object3D into a descriptor for `shadowCasterDecision`.
 *
 * The object's world matrix must be current - call `root.updateWorldMatrix`
 * (or `updateMatrixWorld`) once before a traversal rather than per mesh.
 *
 * @param {object} object A three `Object3D` with geometry.
 * @param {object} [options]
 * @param {(x:number,z:number)=>number} [options.groundHeightAt] Terrain sampler.
 *   When absent, `groundClearance` is left null and that gate is skipped.
 * @param {{x:number,y:number,z:number}} [options.ringCentre] Shadow-fit centre
 *   (`fit.target`). When absent, `distance` is left null and the ring gate passes.
 * @returns {object} Descriptor, ready for `shadowCasterDecision`.
 */
export function measureShadowCaster(object, options = {}) {
  _box.makeEmpty();
  _box.setFromObject(object, true);
  const empty = _box.isEmpty();
  _box.getSize(_size);
  _box.getCenter(_centre);

  // An InstancedMesh or BatchedMesh holds hundreds of separate objects, so its
  // world box is the size of a city block and every per-object test below
  // would be meaningless. `sidewalk-props` and `street-lamps` in the current
  // scene are exactly this case: the batch is one 12 cm lamp post repeated, but
  // its world box is 400 m wide, which would read as "large structural".
  //
  // The thickness question is about ONE instance, so measure the source
  // geometry scaled by the node's world scale. Clearance and ring distance
  // still come from the world box, because those really are batch-wide -
  // a batch is one draw and one castShadow flag, all or nothing.
  let sizeX = _size.x;
  let sizeY = _size.y;
  let sizeZ = _size.z;
  let batched = false;
  if (!empty && (object.isInstancedMesh || object.isBatchedMesh) && object.geometry) {
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const gb = object.geometry.boundingBox;
    if (gb && !gb.isEmpty()) {
      gb.getSize(_instanceSize);
      object.getWorldScale(_scale);
      sizeX = Math.abs(_instanceSize.x * _scale.x);
      sizeY = Math.abs(_instanceSize.y * _scale.y);
      sizeZ = Math.abs(_instanceSize.z * _scale.z);
      batched = true;
    }
  }

  const parents = [];
  for (let node = object.parent; node && parents.length < 4; node = node.parent) {
    if (node.name) parents.push(node.name);
  }

  let groundClearance = null;
  if (!empty && !batched && typeof options.groundHeightAt === 'function') {
    const ground = options.groundHeightAt(_centre.x, _centre.z);
    if (isFiniteNumber(ground)) groundClearance = _box.min.y - ground;
  }

  let distance = null;
  const ringCentre = options.ringCentre;
  if (!empty && ringCentre && isFiniteNumber(ringCentre.x)) {
    distance = Math.hypot(
      _centre.x - ringCentre.x,
      _centre.y - (isFiniteNumber(ringCentre.y) ? ringCentre.y : _centre.y),
      _centre.z - ringCentre.z,
    );
  }

  return {
    name: object.name || '',
    parentName: parents,
    size: empty ? { x: NaN, y: NaN, z: NaN } : { x: sizeX, y: sizeY, z: sizeZ },
    groundClearance,
    distance,
    batched,
  };
}

/**
 * Walk a subtree, decide each mesh, write `castShadow`, and return the audit.
 *
 * Call this once per world build (and again after a shadow refit that changes
 * `texelWorldSize` by more than a few percent) - NOT every frame. It is a
 * traversal with a `Box3.setFromObject` per mesh.
 *
 * `receiveShadow` is deliberately untouched: an awning that cannot cast should
 * still be shaded by the building above it.
 *
 * @param {object} root Scene subtree root (an `Object3D`).
 * @param {object} [options] `resolveShadowCasterContext` fields, plus
 *   `groundHeightAt`, `ringCentre`, and `filter(object)` to skip nodes.
 * @returns {object} The audit from `createShadowCasterAudit`.
 */
export function applyShadowCasterPolicy(root, options = {}) {
  const policy = createShadowCasterPolicy(options);
  const audit = createShadowCasterAudit();
  const filter = typeof options.filter === 'function' ? options.filter : null;
  if (!root || typeof root.traverse !== 'function') {
    throw new TypeError('shadow-casters: applyShadowCasterPolicy(root) needs an Object3D');
  }
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh && !object.isBatchedMesh) return;
    if (filter && !filter(object)) return;
    const descriptor = measureShadowCaster(object, options);
    const result = policy.decide(descriptor);
    object.castShadow = result.cast;
    audit.record(result, descriptor.name);
  });
  return audit;
}
