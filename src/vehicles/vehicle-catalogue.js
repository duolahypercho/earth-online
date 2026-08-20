// Vehicle catalogue - real-world dimensions and silhouette control points.
//
// Owner: Rendering / vehicle presentation. Consumed by
// `src/vehicles/vehicle-geometry.js` and `src/render/passes/vehicle-presentation.js`.
//
// WHY THIS FILE EXISTS
//
// Every vehicle in the shipped world is a flat slab with a smaller slab on top:
// no wheels that read, no glass, no lamps, no bumpers, no grille, no mirrors,
// no plate. At the kerb they stand 3-8 m from a hero camera, which is exactly
// where the quality gate's automatic rejection condition for "primitive
// vehicles in a hero street frame" bites.
//
// A catalogue fixes that only if the numbers are real. Every dimension below is
// stated in METRES and is a plausible figure for its vehicle class, not a
// stylised guess:
//
//   id            class                       L      W      H     wheelbase
//   compactHatch  compact hatchback         4.06   1.78   1.47      2.56
//   sedan         mid-size sedan            4.85   1.84   1.45      2.82
//   wagon         estate / station wagon    4.76   1.83   1.51      2.79
//   compactSuv    small crossover SUV       4.55   1.86   1.68      2.68
//   pickup        full-size pickup          5.89   2.03   1.93      3.68
//   deliveryVan   panel delivery van        5.53   2.03   2.55      3.45
//   boxTruck      box / straight truck      7.62   2.44   3.35      4.32
//   cityBus       transit city bus         12.20   2.59   3.22      6.10
//   taxi          licensed taxi sedan       4.92   1.86   1.50      2.86
//   patrolSedan   patrol / police sedan     4.95   1.90   1.52      2.90
//
// `width` is the body width across the doors and EXCLUDES the mirrors, the way
// a manufacturer quotes it; `mirrorReach` is how far one mirror stands proud of
// that, so the measured bounding box of a built vehicle is
// `width + 2 * mirrorReach` and the verifier checks both numbers.
//
// NAMING POLICY. Classes are described generically. No marque, model, operator
// or product name appears anywhere in this repository - see CLAUDE.md.
//
// Determinism: this module is pure data plus pure factories. No Math.random,
// no Date.now, no mutable module state.

/** Catalogue schema version, surfaced in pass diagnostics. */
export const VEHICLE_CATALOGUE_VERSION = 'vehicle-catalogue-v1';

/**
 * Plausible range per dimension per body class, in metres. The verifier asserts
 * every catalogued entry sits inside its own class band, so a typo that makes a
 * "compact hatchback" 6 m long fails the build rather than the review.
 */
export const CLASS_DIMENSION_RANGE = Object.freeze({
  car: { length: [3.5, 5.4], width: [1.6, 2.0], height: [1.3, 1.75], wheelbase: [2.3, 3.1] },
  suv: { length: [4.1, 5.2], width: [1.75, 2.05], height: [1.55, 1.95], wheelbase: [2.5, 3.1] },
  pickup: { length: [5.0, 6.4], width: [1.9, 2.15], height: [1.75, 2.1], wheelbase: [3.0, 4.0] },
  van: { length: [4.6, 6.4], width: [1.85, 2.15], height: [1.9, 2.9], wheelbase: [3.0, 4.1] },
  truck: { length: [6.5, 9.5], width: [2.2, 2.6], height: [2.9, 4.1], wheelbase: [3.6, 5.6] },
  bus: { length: [9.0, 13.5], width: [2.4, 2.7], height: [2.9, 3.6], wheelbase: [4.5, 7.2] },
});

// ---------------------------------------------------------------------------
// paint
// ---------------------------------------------------------------------------

/**
 * A real kerb is mostly white, black, grey and silver. Roughly three quarters
 * of the cars on a North American street are achromatic; the colour that is
 * there is dark and desaturated. Weights below are percentages of a parked
 * population and sum to 100, so the distribution is auditable rather than a
 * hand-tuned rainbow.
 */
export const CIVILIAN_PAINT = Object.freeze([
  { hex: 0xe6e7e3, weight: 15, name: 'white' },
  { hex: 0xd4d5cd, weight: 9, name: 'pearl-white' },
  { hex: 0x17191c, weight: 12, name: 'black' },
  { hex: 0x282c31, weight: 7, name: 'graphite' },
  { hex: 0x6a6f74, weight: 9, name: 'mid-grey' },
  { hex: 0xa6abaf, weight: 8, name: 'silver' },
  { hex: 0xc0c4c6, weight: 6, name: 'light-silver' },
  { hex: 0x23334a, weight: 5, name: 'navy' },
  { hex: 0x35577d, weight: 4, name: 'blue' },
  { hex: 0x8a2b26, weight: 4, name: 'dark-red' },
  { hex: 0xa8332b, weight: 3, name: 'red' },
  { hex: 0x2c4437, weight: 3, name: 'dark-green' },
  { hex: 0xb2a48f, weight: 3, name: 'beige' },
  { hex: 0x5a4637, weight: 2, name: 'brown' },
  { hex: 0x4b2029, weight: 2, name: 'burgundy' },
  { hex: 0x2a4a4e, weight: 2, name: 'teal' },
  { hex: 0xbaa87e, weight: 2, name: 'champagne' },
  { hex: 0xa9542a, weight: 1, name: 'orange' },
  { hex: 0x3d4a52, weight: 3, name: 'slate' },
]);

/** Working vehicles are overwhelmingly plain white or a single fleet colour. */
export const COMMERCIAL_PAINT = Object.freeze([
  { hex: 0xe9eae6, weight: 46, name: 'fleet-white' },
  { hex: 0xd6d7d1, weight: 12, name: 'off-white' },
  { hex: 0xa6abaf, weight: 8, name: 'silver' },
  { hex: 0x2f4a68, weight: 9, name: 'fleet-blue' },
  { hex: 0x5a4637, weight: 6, name: 'brown' },
  { hex: 0x2c4437, weight: 5, name: 'fleet-green' },
  { hex: 0x8a2b26, weight: 5, name: 'fleet-red' },
  { hex: 0x6a6f74, weight: 6, name: 'grey' },
  { hex: 0x17191c, weight: 3, name: 'black' },
]);

/** Liveried classes carry their livery in baked vertex colour; the instance
 *  tint only nudges it, so the set is deliberately near-white. */
export const LIVERY_TINT = Object.freeze([
  { hex: 0xffffff, weight: 6, name: 'as-painted' },
  { hex: 0xf4f4f2, weight: 3, name: 'sun-faded' },
  { hex: 0xe8e9e6, weight: 1, name: 'worn' },
]);

export const PAINT_SETS = Object.freeze({
  civilian: CIVILIAN_PAINT,
  commercial: COMMERCIAL_PAINT,
  livery: LIVERY_TINT,
});

/** Wheel finishes. Steel-with-cover is the cheap end, machined alloy the top. */
export const RIM_FINISHES = Object.freeze([
  { hex: 0xb6bbbf, weight: 34, name: 'alloy-silver' },
  { hex: 0x8d9296, weight: 20, name: 'alloy-grey' },
  { hex: 0x54595d, weight: 16, name: 'dark-alloy' },
  { hex: 0xa9adaf, weight: 18, name: 'steel-cover' },
  { hex: 0x2a2d30, weight: 8, name: 'black-alloy' },
  { hex: 0xc9ccce, weight: 4, name: 'polished' },
]);

// ---------------------------------------------------------------------------
// shared trim colours (absolute, baked into vertex colour)
// ---------------------------------------------------------------------------

export const TRIM = Object.freeze({
  chrome: 0xc8cdd1,
  darkChrome: 0x8b9196,
  blackPlastic: 0x1c1e21,
  greyPlastic: 0x3a3d41,
  rubber: 0x151719,
  glassSeal: 0x121316,
  grille: 0x14161a,
  exhaust: 0x9aa0a4,
  plateWhite: 0xdadcd6,
  plateBlue: 0x2b4a7a,
  lensClear: 0xd8dde2,
  lensRed: 0x8e1c16,
  lensAmber: 0xb46a12,
  interior: 0x0d0f11,
  bedLiner: 0x24262a,
  liveryYellow: 0xf0b727,
  liveryYellowDeep: 0xd79f18,
  liveryBlack: 0x141518,
  liveryWhite: 0xe8e9e7,
  liveryPatrolBlue: 0x1c2a45,
  transitSilver: 0xc7ccce,
  transitRed: 0x9d2733,
  transitCharcoal: 0x33373a,
});

// ---------------------------------------------------------------------------
// spec factories
// ---------------------------------------------------------------------------

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Build the longitudinal control stations of a car-like body.
 *
 * A station is `{ z, sill, top, half }` in metres in the vehicle frame:
 * +Z is the nose, +Y is up, the origin is on the ground at the mid-length.
 * `sill` is the bottom of the body side, `top` the bonnet / belt / boot line,
 * `half` the half-width. The wheel arches are cut into `sill` later, by the
 * geometry builder, so they always follow the wheel that is actually fitted.
 */
function carProfile({
  length, width, frontOverhang, wheelbase,
  sill, noseTop, belt, tailTop, noseHalfF, tailHalfF, tailFullAt = 0.34,
}) {
  const zF = length / 2;
  const zR = -length / 2;
  const half = width / 2;
  const frontAxle = zF - frontOverhang;
  const rearAxle = frontAxle - wheelbase;
  return [
    { z: zR, sill: sill + 0.30, top: tailTop - 0.17, half: half * tailHalfF * 0.84 },
    { z: zR + 0.20, sill: sill + 0.11, top: tailTop - 0.02, half: half * tailHalfF },
    { z: zR + tailFullAt + 0.28, sill: sill + 0.01, top: tailTop, half: half * lerp(tailHalfF, 1, 0.82) },
    { z: rearAxle - 0.30, sill, top: lerp(belt, tailTop, 0.6), half },
    { z: rearAxle + 0.35, sill, top: belt, half },
    { z: lerp(rearAxle, frontAxle, 0.55), sill, top: belt, half },
    { z: frontAxle - 0.20, sill, top: lerp(belt, noseTop, 0.45), half },
    { z: frontAxle + 0.34, sill: sill + 0.02, top: noseTop, half: half * 0.995 },
    { z: zF - 0.30, sill: sill + 0.10, top: noseTop - 0.04, half: half * lerp(noseHalfF, 1, 0.55) },
    { z: zF, sill: sill + 0.28, top: noseTop - 0.15, half: half * noseHalfF * 0.86 },
  ];
}

/** Greenhouse control stations: `{ z, top, half }`, bottom is the body top. */
function carRoof({ cabRear, cabFront, roofRear, roofFront, roofY, beltY, half, roofHalfF, ghHalfF }) {
  return [
    { z: cabRear, top: beltY + 0.012, half: half * ghHalfF },
    { z: lerp(cabRear, roofRear, 0.55), top: lerp(beltY, roofY, 0.72), half: half * lerp(ghHalfF, roofHalfF, 0.5) },
    { z: roofRear, top: roofY - 0.012, half: half * roofHalfF },
    { z: lerp(roofRear, roofFront, 0.5), top: roofY, half: half * roofHalfF },
    { z: roofFront, top: roofY - 0.010, half: half * roofHalfF },
    { z: lerp(roofFront, cabFront, 0.5), top: lerp(beltY, roofY, 0.62), half: half * lerp(ghHalfF, roofHalfF, 0.45) },
    { z: cabFront, top: beltY + 0.012, half: half * ghHalfF },
  ];
}

/**
 * Assemble one catalogue entry from a compact parameter set. Everything the
 * geometry builder needs is derived here exactly once, so a spec cannot drift
 * away from the dimensions it declares.
 */
function makeSpec(input) {
  const {
    id, label, bodyClass, length, width, height, wheelbase, frontOverhang,
    trackFront, trackRear = trackFront, wheelRadius, wheelWidth,
    sill, noseTop, belt, tailTop, noseHalfF = 0.86, tailHalfF = 0.88,
    cabRear, cabFront, roofRear, roofFront, roofHalfF = 0.86, ghHalfF = 0.95,
    mirrorReach = 0.15, paintSet = 'civilian', weight = [1, 1, 1, 1],
    axles = 2, features = {}, glazing = {}, profileOverride = null, roofOverride = null,
    plateStyle = 'us', shadow = true, dualRear = false,
  } = input;

  const half = width / 2;
  const zF = length / 2;
  const zR = -length / 2;
  const frontAxle = zF - frontOverhang;
  const rearAxle = frontAxle - wheelbase;
  const profile = profileOverride
    || carProfile({ length, width, frontOverhang, wheelbase, sill, noseTop, belt, tailTop, noseHalfF, tailHalfF });
  const roof = roofOverride
    || carRoof({ cabRear, cabFront, roofRear, roofFront, roofY: height, beltY: belt, half, roofHalfF, ghHalfF });

  const roofFurniture = Math.max(
    features.roofSign ? features.roofSign.y + features.roofSign.h : 0,
    features.lightBar ? features.lightBar.y + features.lightBar.h : 0,
    features.roofPods ? height + 0.20 : 0,
  );

  return Object.freeze({
    id,
    label,
    bodyClass,
    // Declared real-world dimensions, metres.
    length,
    width,
    height,
    // Height over any roof furniture (taxi sign, light bar, transit roof pods).
    overallHeight: Math.max(height, roofFurniture),
    wheelbase,
    trackFront,
    trackRear,
    frontOverhang,
    rearOverhang: length - wheelbase - frontOverhang,
    wheelRadius,
    wheelWidth,
    mirrorReach,
    axles,
    dualRear,
    overallWidth: width + mirrorReach * 2,
    // Derived frame landmarks.
    zFront: zF,
    zRear: zR,
    frontAxleZ: frontAxle,
    rearAxleZ: rearAxle,
    beltY: belt,
    sillY: sill,
    profile: Object.freeze(profile.map((s) => Object.freeze({ ...s }))),
    roof: Object.freeze(roof.map((s) => Object.freeze({ ...s }))),
    glazing: Object.freeze({
      windscreen: glazing.windscreen !== false,
      backlight: glazing.backlight !== false,
      // Side panes as absolute z spans in the vehicle frame; the geometry
      // builder projects them onto the greenhouse surface.
      sidePanes: Object.freeze((glazing.sidePanes || []).map((p) => Object.freeze([...p]))),
      paneRise: glazing.paneRise ?? 0.055,
      paneDrop: glazing.paneDrop ?? 0.075,
      // Absolute [y0, y1] of a one-box body's window band, when it carries one
      // instead of a greenhouse.
      bandY: glazing.bandY ? Object.freeze([...glazing.bandY]) : null,
    }),
    features: Object.freeze({
      mirrors: true,
      wipers: true,
      grille: true,
      exhaust: 'single',
      doorLines: [],
      handles: [],
      ...features,
    }),
    paintSet,
    plateStyle,
    shadow,
    // Relative chance of this class appearing on a street of rank band
    // [service, residential, collector, arterial].
    weight: Object.freeze([...weight]),
  });
}

// ---------------------------------------------------------------------------
// the catalogue
// ---------------------------------------------------------------------------

const compactHatch = makeSpec({
  id: 'compactHatch',
  label: 'compact hatchback',
  bodyClass: 'car',
  length: 4.06, width: 1.78, height: 1.47, wheelbase: 2.56, frontOverhang: 0.86,
  trackFront: 1.53, trackRear: 1.52, wheelRadius: 0.315, wheelWidth: 0.205,
  sill: 0.215, noseTop: 0.86, belt: 0.94, tailTop: 1.02,
  noseHalfF: 0.84, tailHalfF: 0.90,
  cabRear: -1.66, cabFront: 0.68, roofRear: -1.05, roofFront: 0.02,
  roofHalfF: 0.83, ghHalfF: 0.95, mirrorReach: 0.145,
  glazing: { sidePanes: [[-0.98, -0.30], [-0.24, 0.42]] },
  features: { doorLines: [-0.28], handles: [[-0.62, 1.02], [0.10, 1.02]], exhaust: 'single' },
  weight: [3, 6, 5, 4],
});

const sedan = makeSpec({
  id: 'sedan',
  label: 'mid-size sedan',
  bodyClass: 'car',
  length: 4.85, width: 1.84, height: 1.45, wheelbase: 2.82, frontOverhang: 0.96,
  trackFront: 1.58, trackRear: 1.57, wheelRadius: 0.34, wheelWidth: 0.225,
  sill: 0.205, noseTop: 0.88, belt: 0.96, tailTop: 0.99,
  noseHalfF: 0.86, tailHalfF: 0.88,
  cabRear: -1.72, cabFront: 1.06, roofRear: -1.10, roofFront: 0.36,
  roofHalfF: 0.84, ghHalfF: 0.95, mirrorReach: 0.155,
  glazing: { sidePanes: [[-1.02, -0.26], [-0.19, 0.58]] },
  features: { doorLines: [-0.22], handles: [[-0.60, 1.04], [0.16, 1.04]], exhaust: 'twin' },
  weight: [3, 6, 6, 6],
});

const wagon = makeSpec({
  id: 'wagon',
  label: 'estate wagon',
  bodyClass: 'car',
  length: 4.76, width: 1.83, height: 1.51, wheelbase: 2.79, frontOverhang: 0.94,
  trackFront: 1.56, trackRear: 1.56, wheelRadius: 0.335, wheelWidth: 0.225,
  sill: 0.215, noseTop: 0.90, belt: 0.98, tailTop: 1.22,
  noseHalfF: 0.86, tailHalfF: 0.93, tailFullAt: 0.16,
  cabRear: -2.24, cabFront: 1.02, roofRear: -1.96, roofFront: 0.30,
  roofHalfF: 0.86, ghHalfF: 0.96, mirrorReach: 0.155,
  glazing: { sidePanes: [[-1.86, -1.18], [-1.10, -0.30], [-0.24, 0.54]] },
  features: { doorLines: [-1.14, -0.26], handles: [[-0.62, 1.06], [0.14, 1.06]], roofRails: true },
  weight: [2, 4, 4, 3],
});

const compactSuv = makeSpec({
  id: 'compactSuv',
  label: 'small crossover SUV',
  bodyClass: 'suv',
  length: 4.55, width: 1.86, height: 1.68, wheelbase: 2.68, frontOverhang: 0.92,
  trackFront: 1.59, trackRear: 1.59, wheelRadius: 0.36, wheelWidth: 0.235,
  sill: 0.285, noseTop: 1.02, belt: 1.10, tailTop: 1.30,
  noseHalfF: 0.86, tailHalfF: 0.92, tailFullAt: 0.20,
  cabRear: -2.02, cabFront: 0.98, roofRear: -1.72, roofFront: 0.26,
  roofHalfF: 0.85, ghHalfF: 0.96, mirrorReach: 0.17,
  glazing: { sidePanes: [[-1.64, -1.06], [-0.98, -0.26], [-0.20, 0.52]] },
  features: {
    doorLines: [-1.02, -0.22], handles: [[-0.58, 1.18], [0.14, 1.18]],
    cladding: true, roofRails: true, exhaust: 'single',
  },
  weight: [2, 5, 5, 4],
});

const pickup = makeSpec({
  id: 'pickup',
  label: 'full-size pickup',
  bodyClass: 'pickup',
  length: 5.89, width: 2.03, height: 1.93, wheelbase: 3.68, frontOverhang: 0.95,
  trackFront: 1.72, trackRear: 1.72, wheelRadius: 0.39, wheelWidth: 0.28,
  sill: 0.36, noseTop: 1.24, belt: 1.32, tailTop: 0.98,
  cabRear: -0.52, cabFront: 1.44, roofRear: -0.30, roofFront: 0.46,
  roofHalfF: 0.90, ghHalfF: 0.97, mirrorReach: 0.20,
  // An open bed is not a car silhouette: the body top drops to the bed floor
  // behind the cab and the bed walls are added on top of it.
  profileOverride: [
    { z: -2.945, sill: 0.60, top: 0.92, half: 0.90 },
    { z: -2.82, sill: 0.46, top: 0.98, half: 0.98 },
    { z: -2.40, sill: 0.40, top: 0.98, half: 1.015 },
    { z: -1.685, sill: 0.36, top: 0.98, half: 1.015 },
    { z: -0.72, sill: 0.36, top: 0.98, half: 1.015 },
    { z: -0.58, sill: 0.36, top: 1.32, half: 1.015 },
    { z: 0.40, sill: 0.36, top: 1.32, half: 1.015 },
    { z: 1.44, sill: 0.36, top: 1.30, half: 1.01 },
    { z: 1.995, sill: 0.36, top: 1.24, half: 1.005 },
    { z: 2.62, sill: 0.42, top: 1.18, half: 0.97 },
    { z: 2.945, sill: 0.58, top: 1.06, half: 0.88 },
  ],
  glazing: { sidePanes: [[-0.24, 0.36], [0.44, 1.10]], backlight: true },
  features: {
    doorLines: [0.40], handles: [[0.04, 1.36], [0.72, 1.36]],
    bed: { rear: -2.80, front: -0.60, floorY: 0.98, sideY: 1.32 },
    exhaust: 'single', cladding: true,
  },
  weight: [3, 4, 3, 3],
});

const deliveryVan = makeSpec({
  id: 'deliveryVan',
  label: 'panel delivery van',
  bodyClass: 'van',
  length: 5.53, width: 2.03, height: 2.55, wheelbase: 3.45, frontOverhang: 0.94,
  trackFront: 1.74, trackRear: 1.72, wheelRadius: 0.375, wheelWidth: 0.245,
  sill: 0.31, noseTop: 1.26, belt: 1.38, tailTop: 2.55,
  cabRear: -2.64, cabFront: 1.30, roofRear: -2.52, roofFront: 0.62,
  roofHalfF: 0.93, ghHalfF: 0.985, mirrorReach: 0.22,
  // One box with a short bonnet: the windscreen is the sloped face between the
  // cowl at z=1.30 and the roof header at z=0.62.
  profileOverride: [
    { z: -2.765, sill: 0.60, top: 2.38, half: 0.93 },
    { z: -2.64, sill: 0.40, top: 2.50, half: 1.00 },
    { z: -2.20, sill: 0.34, top: 2.53, half: 1.015 },
    { z: -1.625, sill: 0.31, top: 2.55, half: 1.015 },
    { z: 0.10, sill: 0.31, top: 2.55, half: 1.015 },
    { z: 0.62, sill: 0.31, top: 2.50, half: 1.01 },
    { z: 1.30, sill: 0.31, top: 1.38, half: 1.00 },
    { z: 1.825, sill: 0.31, top: 1.26, half: 0.995 },
    { z: 2.40, sill: 0.36, top: 1.18, half: 0.95 },
    { z: 2.765, sill: 0.54, top: 1.04, half: 0.86 },
  ],
  roofOverride: [
    { z: -0.30, top: 2.556, half: 1.012 },
    { z: 0.10, top: 2.554, half: 1.012 },
    { z: 0.62, top: 2.506, half: 1.008 },
    { z: 1.30, top: 1.386, half: 0.998 },
  ],
  glazing: { sidePanes: [[0.26, 0.96]], bandY: [1.42, 1.86], backlight: false },
  features: {
    doorLines: [0.20], handles: [[-0.02, 1.50]],
    panelRibs: [-2.20, -1.55, -0.90, -0.25], exhaust: 'single',
    endGlass: [{ y0: 1.60, y1: 2.30, halfF: 0.86, facing: -1 }],
  },
  paintSet: 'commercial',
  weight: [3, 3, 4, 4],
});

const boxTruck = makeSpec({
  id: 'boxTruck',
  label: 'box truck',
  bodyClass: 'truck',
  length: 7.62, width: 2.44, height: 3.35, wheelbase: 4.32, frontOverhang: 1.16,
  trackFront: 1.98, trackRear: 1.78, wheelRadius: 0.46, wheelWidth: 0.30,
  dualRear: true,
  sill: 0.50, noseTop: 1.52, belt: 1.62, tailTop: 3.35,
  noseHalfF: 0.90, tailHalfF: 0.995, tailFullAt: 0.04,
  cabRear: -1.50, cabFront: 2.36, roofRear: -1.42, roofFront: 1.42,
  roofHalfF: 0.96, ghHalfF: 0.99, mirrorReach: 0.30,
  // The cargo box is a straight-sided volume; the cab is a shorter, narrower
  // glasshouse in front of it. Explicit stations rather than the car recipe.
  profileOverride: [
    { z: -3.81, sill: 0.62, top: 3.31, half: 1.215 },
    { z: -3.68, sill: 0.58, top: 3.35, half: 1.22 },
    { z: -1.52, sill: 0.55, top: 3.35, half: 1.22 },
    { z: -1.46, sill: 0.52, top: 2.42, half: 1.16 },
    { z: -0.10, sill: 0.50, top: 1.62, half: 1.16 },
    { z: 1.30, sill: 0.50, top: 1.60, half: 1.16 },
    { z: 2.30, sill: 0.52, top: 1.52, half: 1.14 },
    { z: 3.30, sill: 0.60, top: 1.44, half: 1.10 },
    { z: 3.81, sill: 0.74, top: 1.30, half: 0.98 },
  ],
  roofOverride: [
    { z: -1.44, top: 2.44, half: 1.14 },
    { z: -1.30, top: 2.62, half: 1.13 },
    { z: 1.02, top: 2.62, half: 1.13 },
    { z: 1.42, top: 2.58, half: 1.12 },
    { z: 2.34, top: 1.56, half: 1.10 },
  ],
  glazing: { sidePanes: [[1.20, 2.06]], paneDrop: 0.12, paneRise: 0.09 },
  features: {
    doorLines: [1.14], handles: [[0.92, 1.78]],
    panelRibs: [-3.30, -2.80, -2.30, -1.80], exhaust: 'stack', chassisRails: true,
    boxBody: { rear: -3.81, front: -1.46, top: 3.35 },
  },
  paintSet: 'commercial',
  weight: [1, 1, 3, 4],
  shadow: true,
});

const cityBus = makeSpec({
  id: 'cityBus',
  label: 'transit city bus',
  bodyClass: 'bus',
  length: 12.20, width: 2.59, height: 3.22, wheelbase: 6.10, frontOverhang: 2.55,
  trackFront: 2.20, trackRear: 1.86, wheelRadius: 0.53, wheelWidth: 0.315,
  dualRear: true,
  sill: 0.34, noseTop: 3.02, belt: 3.02, tailTop: 3.10,
  noseHalfF: 0.96, tailHalfF: 0.98,
  cabRear: -5.70, cabFront: 5.92, roofRear: -5.40, roofFront: 5.30,
  roofHalfF: 0.94, ghHalfF: 0.99, mirrorReach: 0.32,
  profileOverride: [
    { z: -6.10, sill: 0.60, top: 2.86, half: 1.24 },
    { z: -5.86, sill: 0.46, top: 3.00, half: 1.28 },
    { z: -5.30, sill: 0.40, top: 3.02, half: 1.295 },
    { z: -2.20, sill: 0.34, top: 3.02, half: 1.295 },
    { z: 2.20, sill: 0.34, top: 3.02, half: 1.295 },
    { z: 5.10, sill: 0.40, top: 3.00, half: 1.295 },
    { z: 5.86, sill: 0.50, top: 2.92, half: 1.26 },
    { z: 6.10, sill: 0.66, top: 2.76, half: 1.20 },
  ],
  roofOverride: [
    { z: -6.02, top: 2.90, half: 1.20 },
    { z: -5.60, top: 3.18, half: 1.24 },
    { z: -4.60, top: 3.22, half: 1.245 },
    { z: 0, top: 3.22, half: 1.245 },
    { z: 4.60, top: 3.22, half: 1.245 },
    { z: 5.60, top: 3.16, half: 1.22 },
    { z: 6.02, top: 2.88, half: 1.18 },
  ],
  glazing: {
    windscreen: false,
    backlight: false,
    // A transit window band: eight bays split by pillars, plus the door glass.
    sidePanes: [
      [-5.30, -4.40], [-4.24, -3.60], [-2.20, -1.30], [-1.14, -0.24],
      [-0.08, 0.82], [0.96, 2.30], [3.70, 4.60],
    ],
    bandY: [1.62, 2.72],
  },
  features: {
    mirrors: true, wipers: true, grille: false, exhaust: 'none',
    doors: [[2.45, 3.55], [-3.45, -2.35]],
    livery: 'transit', roofPods: true, destinationSign: true,
    doorLines: [], handles: [],
    endGlass: [
      { y0: 1.42, y1: 2.84, halfF: 0.90, facing: 1 },
      { y0: 1.55, y1: 2.78, halfF: 0.88, facing: -1 },
    ],
  },
  paintSet: 'livery',
  weight: [0, 1, 3, 5],
});

const taxi = makeSpec({
  id: 'taxi',
  label: 'licensed taxi sedan',
  bodyClass: 'car',
  length: 4.92, width: 1.86, height: 1.50, wheelbase: 2.86, frontOverhang: 0.97,
  trackFront: 1.60, trackRear: 1.59, wheelRadius: 0.345, wheelWidth: 0.225,
  sill: 0.215, noseTop: 0.90, belt: 0.98, tailTop: 1.02,
  noseHalfF: 0.86, tailHalfF: 0.89,
  cabRear: -1.74, cabFront: 1.08, roofRear: -1.12, roofFront: 0.38,
  roofHalfF: 0.85, ghHalfF: 0.95, mirrorReach: 0.155,
  glazing: { sidePanes: [[-1.04, -0.26], [-0.19, 0.60]] },
  features: {
    doorLines: [-0.22], handles: [[-0.60, 1.06], [0.16, 1.06]],
    roofSign: { z: -0.20, y: 1.50, w: 0.62, h: 0.19, d: 0.30 },
    livery: 'taxi', exhaust: 'single',
  },
  paintSet: 'livery',
  weight: [1, 3, 5, 6],
});

const patrolSedan = makeSpec({
  id: 'patrolSedan',
  label: 'patrol sedan',
  bodyClass: 'car',
  length: 4.95, width: 1.90, height: 1.52, wheelbase: 2.90, frontOverhang: 0.98,
  trackFront: 1.63, trackRear: 1.62, wheelRadius: 0.35, wheelWidth: 0.235,
  sill: 0.22, noseTop: 0.92, belt: 1.00, tailTop: 1.04,
  noseHalfF: 0.86, tailHalfF: 0.89,
  cabRear: -1.76, cabFront: 1.10, roofRear: -1.14, roofFront: 0.38,
  roofHalfF: 0.85, ghHalfF: 0.95, mirrorReach: 0.16,
  glazing: { sidePanes: [[-1.06, -0.26], [-0.19, 0.60]] },
  features: {
    doorLines: [-0.22], handles: [[-0.60, 1.08], [0.16, 1.08]],
    lightBar: { z: -0.16, y: 1.52, w: 1.28, h: 0.12, d: 0.24 },
    pushBar: true, livery: 'patrol', exhaust: 'twin',
  },
  paintSet: 'livery',
  weight: [1, 1, 2, 2],
});

/** The catalogue, in a stable order. */
export const VEHICLE_SPECS = Object.freeze([
  compactHatch, sedan, wagon, compactSuv, pickup, deliveryVan, boxTruck, cityBus, taxi, patrolSedan,
]);

export const VEHICLE_SPEC_BY_ID = Object.freeze(Object.fromEntries(VEHICLE_SPECS.map((s) => [s.id, s])));
export const VEHICLE_TYPE_IDS = Object.freeze(VEHICLE_SPECS.map((s) => s.id));

/**
 * Which catalogue entries may park on a street of a given class rank band.
 * A city bus never parks at a residential kerb; a box truck rarely does.
 */
export const PARKING_WEIGHT = Object.freeze({
  compactHatch: [3, 7, 6, 5],
  sedan: [3, 7, 7, 7],
  wagon: [2, 4, 4, 3],
  compactSuv: [2, 5, 5, 4],
  pickup: [3, 4, 3, 3],
  deliveryVan: [2, 2, 3, 4],
  boxTruck: [1, 1, 2, 2],
  cityBus: [0, 0, 0, 0],
  taxi: [0, 1, 2, 3],
  patrolSedan: [0, 1, 1, 1],
});

/** Which entries appear in moving traffic, by the simulation's own coarse kind. */
export const TRAFFIC_KIND_MAP = Object.freeze({
  sedan: ['sedan', 'compactHatch', 'wagon', 'compactSuv', 'sedan', 'compactHatch', 'pickup'],
  taxi: ['taxi'],
  truck: ['deliveryVan', 'boxTruck', 'deliveryVan'],
  bus: ['cityBus'],
  police: ['patrolSedan'],
});

/** Pick from a weighted list with a 0..1 draw. Pure. */
export function pickWeighted(list, draw, weightOf = (entry) => entry.weight) {
  let total = 0;
  for (const entry of list) total += Math.max(0, weightOf(entry));
  if (!(total > 0)) return list[0] ?? null;
  let t = Math.min(0.999999, Math.max(0, draw)) * total;
  for (const entry of list) {
    t -= Math.max(0, weightOf(entry));
    if (t <= 0) return entry;
  }
  return list[list.length - 1];
}

/** Class rank band index used by the weight tables. */
export function classBand(classRank) {
  if (classRank <= 1) return 0;
  if (classRank <= 3) return 1;
  if (classRank <= 4) return 2;
  return 3;
}

export default VEHICLE_SPECS;
