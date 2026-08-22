// street-life - presentation pass.
//
// Owner: Pedestrians/life. Contract: src/render/pass-registry.js.
//
// WHAT THIS FIXES
//
// The captured 11:00 downtown street card contains no people. Not "few" - none.
// The rubric dimension "NPC and traffic life" scores about 1/5 on it, and the
// empty pavement drags composition and place identity down with it.
//
// Two different things were missing, and they need two different fixes:
//
//   1. DENSITY. The walking population and the recycler that keeps it near the
//      camera are simulation-owned and are fixed in src/citygen/traffic.js.
//   2. PURPOSE. A crowd of people all walking at 1.4 m/s in straight lines is a
//      conveyor belt. What makes a street read as a place is the people who are
//      NOT walking: queueing at the crossing, standing in pairs talking, on a
//      phone against a wall, sitting on a step, looking in a window, waiting in
//      a doorway. None of that is path-following, so none of it can come out of
//      the walking simulation. That is what this pass builds.
//
// It also fills the kerb directly in front of the camera. The legacy map-wide
// parked-car layer spends its whole 520-car budget on whichever segments happen
// to come first in the source array, so on the measured capture pose the
// nearest parked car in shot is 224 m away. This pass streams kerb occupancy
// from the camera outwards and skips any stall the legacy layer already filled.
//
// WHAT IT IS NOT. It never writes simulation state, never moves a path, never
// spawns an agent the simulation knows about, and never creates a renderer, a
// loop, a clock or a scene root. Its figures are scenery: they occupy the two
// edges of the footway - against the kerb and against the property line - while
// the simulated walkers own the through-route between them, so the two
// populations share a pavement without ever standing in each other.
//
// SOURCES OF TRUTH
//   * street geometry     `buildStreetscapePlan` (src/world/streets/street-surface-v2.js)
//                         - the same node set, trims and corner arcs the paved
//                           surface was built from. No mesh is reverse-engineered.
//   * figure appearance   `identityVariation` / `identityWardrobe` and the rig
//                         from src/simulation/pedestrians/pedestrian-presentation.js,
//                         so a standing figure and a walking one are the same
//                         person vocabulary, not two different art styles.
//   * ground              `sidewalkSurfaceY` / `carriagewaySurfaceY` against the
//                         city datum, evaluated once per figure at build time.
//
// DETERMINISM. No Math.random, no Date.now. Every choice is a hash of a source
// id, so two builds of one city are bit-identical.

import * as THREE from 'three';
import {
  buildStreetscapePlan,
  sidewalkBand,
  sidewalkSurfaceY,
  carriagewaySurfaceY,
  streetStationAt,
  STREET_SURFACE_V2_DEFAULTS,
} from '../../world/streets/street-surface-v2.js';
import {
  PEDESTRIAN_BONE_NAMES,
  REST_POSE,
  buildInstancedPartGeometries,
  buildWardrobeGeometries,
  identitySeed,
  identityRandom,
  identityVariation,
  identityWardrobe,
  appearanceSignature,
  evaluateActivityPose,
  mirrorActivityPose,
  ACTIVITY_ROOT_DROP,
  contactShadowFor,
  CONTACT_SHADOW,
  contactShadowSunTerm,
  // The validity gate. Same rules, same constants and the same counted ledger
  // as the walking crowd, because a standing figure standing inside a wall and
  // a walking one standing inside a wall are one defect with one owner.
  PRESENTATION_VALIDITY,
  CARRIED_PROP_FLAGS,
  buildFootprintIndex,
  publishBuildingFootprints,
  createValidityLedger,
  clampTorsoTilt,
  measureRigPose,
  poseRejection,
  carriedHandIsFree,
  carriedPropAttachments,
  restBoneWorld,
} from '../../simulation/pedestrians/pedestrian-presentation.js';

export const STREET_LIFE_ID = 'street-life';
export const STREET_LIFE_VERSION = 'street-life-v1';

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------
//
// Captures run through a SOFTWARE GL backend on a four-core box, so the ring
// radii below are chosen by what a figure is worth at that distance, not by
// what fits in a GPU:
//
//   near  <= 32 m   A figure is 55-190 px tall: a reviewer can count its
//                   fingers, so it gets the full near-tier body - hands, jaw,
//                   brow, nose, eyes, shoulder caps and a joint filler at every
//                   articulating joint - under per-bone articulation.
//                   `radialSegments: 7` is a threshold, not a dial:
//                   `makePartGeometry` draws every joint filler as an
//                   8-triangle OCTAHEDRON below 7 and as a sphere at 7 and
//                   above. At 6 every elbow, knee, shoulder cap, ankle and eye
//                   on a figure two metres from the lens was a faceted lozenge.
//                   The near tier additionally replaces the frusta and swept
//                   cylinders of the cheaper tiers with LOFTED solids - a
//                   deltoid continuous with the torso, limbs whose section
//                   changes along their length, a head with a jaw and a brow,
//                   hands with a thumb, and a collar, a cuff and a shirt hem.
//                   Measured: body 2432 tri and wardrobe 186 tri per figure, in
//                   21 body + 9 wardrobe draws. The chunk keys are per
//                   bone/group, so neither the segment count nor the loft ring
//                   count can ever add a draw call.
//   mid   <= 132 m  A figure is 14-55 px tall - AND, when the near ring is
//                   saturated, as close as the 27th-nearest figure happens to
//                   be. That second case is what this ring is now built for.
//                   One root matrix, no articulation, `mid` detail: 556 body +
//                   112 wardrobe tri per figure in 5 + 8 draws.
//   past 132 m      Not drawn at all. The walking crowd's own far band already
//                   populates 132-220 m, and a motionless figure at that range
//                   is a smudge that costs a matrix.
//
// WHY THIS RING IS NO LONGER DRAWN AT `far` DETAIL.
//
// A ring cap is not a distance. The near ring takes the 26 nearest figures and
// every other figure inside its radius falls to this one, so the tier a figure
// gets is decided by its RANK, not by how big it is on screen. The round-5
// capture report records what that costs: the pass published 149 figures inside
// the 32 m near ring on three of the four cards, against a near cap of 26. The
// other 123 - the nearest of them about 13 m from the lens, ~140 px tall - were
// drawn from the tier authored for 120-220 m.
//
// Measured on the drawn triangles of that tier, at the rest pose, in horizontal
// slices 10 mm apart: `far` had NO geometry at all in the slice through the
// elbow, the knee, the ankle, or anywhere in the 140 mm between the top of the
// shoulders and the base of the skull. It was not a cheap figure, it was a
// figure in pieces, and 123 of them were standing in the hero frame. That is
// the "blocky mannequin with a cube head and untapered cylinder limbs" the
// reviewers wrote down.
//
// So this ring now draws `mid`: continuous across every joint (proved by the
// same slice measurement), with hands, a neck that reaches the skull, and a
// lofted cranium. `far` keeps its triangle count within 12 and is now drawn
// only by the walking crowd's own 120-220 m band.
//
// The near ring is small on purpose. Spending 2520 triangles on a figure whose
// limbs occupy four pixels is the failure mode this table exists to prevent;
// the previous 46 m / 56-figure near ring was drawing 56 close-up bodies to
// cover a ring where six of them were ever legible.
//
// LENS GUARD. `minRadius` and `introduceRadius` are the two floors described at
// `streetLifeLensGuard` below. They are recomputed from the live camera on
// every re-plan; the numbers stored here are the values for the canonical
// runtime camera (52 deg, near 0.5 m, 16:9) and are what the budget table and
// the verifier are stated against.
//
// Per-ring caps are hard: the planner sorts by distance and stops, so the cost
// of this pass is bounded by the caps and NOT by the size of the city.
export const STREET_LIFE_RINGS = Object.freeze([
  Object.freeze({
    id: 'near',
    radius: 32,
    budget: 26,
    articulated: true,
    detail: 'near',
    radialSegments: 7,
    minRadius: 1.05,
    introduceRadius: 1.95,
  }),
  Object.freeze({ id: 'mid', radius: 132, budget: 130, articulated: false, detail: 'mid', radialSegments: 5 }),
]);

// RESTATED BUDGET (continuity landing). THE CEILING MOVES THIS WAVE.
//
// The ceiling is derived from the caps, never from a high-water mark a capture
// pose happened to produce, so a busy junction that fills a ring cannot fail
// it. Worst case is the arithmetic sum of the caps, every ring saturated and
// every wardrobe flag set - a state no pose can exceed because the ring caps
// are hard.
//
// WAS (mid ring at `far` detail, cap 200):
//
//   near body      26 x 2432 = 63 232
//   near wardrobe  26 x  186 =  4 836
//   mid body      200 x  180 = 36 000
//   mid wardrobe  200 x   48 =  9 600
//   kerb cars      72 x  128 =  9 216
//                             --------
//                              122 884   against a declared 123 000
//
// NOW (mid ring at `mid` detail, cap 130):
//
//   near body      26 x 2520 = 65 520   (+88/figure: the lofted shoe)
//   near wardrobe  26 x  186 =  4 836   (unchanged)
//   mid body      130 x  556 = 72 280   (+376/figure over `far`: a neck, a
//                                        throat ring on the skull, hands, a
//                                        lofted deltoid, a hair shell, and
//                                        every limb crossing its own joint)
//   mid wardrobe  130 x  112 = 14 560   (+64/figure over `far`)
//   kerb cars      72 x  128 =  9 216   (unchanged)
//                             --------
//                              166 412   against a declared 167 000
//
// That is +43 528 triangles of worst case, spent on exactly one thing: the
// figures between the near cap and 132 m stop being drawn from a tier that has
// holes in it. What it buys is stated at STREET_LIFE_RINGS.
//
// The cost is bounded and small in context. The round-5 capture recorded
// 1 638 320 triangles in the hero frame and 59 072 of them in this pass, so the
// NEW WORST CASE - a state the measured poses do not reach - is +2.7% of that
// frame. The mid ring gave up 70 instances (200 -> 130) to pay for part of it;
// at the round-5 poses the pass drew 137 mid figures, so the cap still covers
// what the measured poses place, and `figures.culled` publishes it when it does
// not.
//
// DRAW CALLS DID NOT MOVE, and they remain the tighter constraint. The chunk
// keys are per bone/group and the mid ring is merged to one root, so a
// saturated pass is 21 + 9 near, 5 + 8 mid, 1 shadow and 2 car meshes = 46,
// against an unchanged ceiling of 48. The mid ring went from 9 draws to 13
// because `mid` detail carries two more wardrobe chunks over the same 5 body
// chunks; neither the segment count, the loft ring count nor the figure count
// can add one.
//
// Contact shadows are 2 tri x 298 instances and are not in this total because
// `writeFrame` has never counted them; that accounting predates this landing
// and is left alone rather than changed silently.
export const STREET_LIFE_BUDGET = Object.freeze({
  rings: STREET_LIFE_RINGS,
  /** Kerb stalls drawn, nearest first, inside `parkingRadius`. */
  parkedCars: 72,
  parkingRadius: 150,
  /**
   * Planning caps, so a huge city cannot blow memory on records it never draws.
   *
   * `maxAnchors` is a MEMORY cap, not a draw budget - the ring caps above are
   * what bound the cost of a frame. It matters because hitting it truncates the
   * plan in segment order, which would leave the tail of the source array with
   * no population at all: the same first-come bias this pass exists to correct
   * in the legacy parked-car layer. Raised from 6000 with the density: the
   * shipped 720 m slice (3397 segments, 154.8 km of centreline) plans 4987
   * figures at 0.13/m, which left 17% of headroom, and a denser or wider slice
   * would have started truncating silently. `rejected.capped` is published so
   * that if it ever does fire, it is visible rather than inferred.
   */
  maxAnchors: 10000,
  maxParkingSpots: 9000,
  /**
   * Ceilings derived from the caps above; exceeding either is a regression, not
   * a tuning choice. `maxTriangles` is the 166 412 worst case rounded up to the
   * next round number, so it stays a bound and not a high-water mark.
   */
  maxTriangles: 167000,
  maxDrawCalls: 48,
});

/**
 * Standing figures per metre of kerb PER SIDE, before class, district and hour
 * scaling.
 *
 * Re-calibrated. The old 0.042/m was calibrated against a block face, and it is
 * defensible as a count of people who are *motionless for a whole minute*. It
 * is the wrong quantity. What a frame contains is everyone who is not walking
 * AT THAT INSTANT, which includes the much larger population that is pausing:
 * reading a sign, at a doorway, digging for keys, half-turned mid-conversation,
 * stopped at the kerb before stepping off. 0.042/m starved the declared rings -
 * the pass was drawing 3 of an allowed 26 near figures and 50 of an allowed 200
 * mid figures at the round-3 capture poses, so the "empty pavement" complaint
 * survived a pass built to answer it.
 *
 * 0.13/m puts about ten stationary figures on each side of a 100 m downtown
 * block face at midday, before the class weight (0.5 residential, 0.95
 * secondary) and the district term (0.22 at the quiet floor, 1.0 downtown)
 * multiply it down. On a residential street at 04:00 that is
 * 100 * 0.13 * 0.5 * 0.22 * 0.05 = 0.07 people, i.e. still an empty street.
 *
 * This buys instance matrices, not draw calls: every figure a ring adds writes
 * into an InstancedMesh that is already being drawn, so the ceiling that moves
 * is `maxTriangles`, and it is restated and verified above.
 *
 * The ring caps, not this number, are what bound the cost. Raising the density
 * past the point where the caps saturate buys nothing but planning time.
 */
export const STREET_LIFE_LINE_DENSITY = 0.13;

/** How heavily each street class is populated with stationary figures. */
export const STREET_LIFE_CLASS_WEIGHT = Object.freeze({
  primary: 1.0,
  primary_link: 0.7,
  secondary: 0.95,
  secondary_link: 0.7,
  tertiary: 0.78,
  tertiary_link: 0.6,
  residential: 0.5,
  living_street: 0.55,
  unclassified: 0.45,
  pedestrian: 1.2,
  service: 0.16,
  alley: 0.16,
  track: 0.1,
  trunk: 0.25,
  motorway: 0,
});

/**
 * Footfall by hour. Midday and the evening commute are the busy windows, the
 * small hours are nearly empty. Shared shape with the traffic simulation's own
 * curve so the standing population and the walking population rise and fall
 * together instead of contradicting each other.
 */
export function streetLifeHourFactor(hour) {
  const h = Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 12;
  const table = [
    0.10, 0.07, 0.05, 0.04, 0.05, 0.10, 0.24, 0.52, 0.82, 0.88, 0.92, 0.97,
    1.00, 0.98, 0.93, 0.92, 0.95, 1.00, 0.94, 0.78, 0.60, 0.46, 0.32, 0.18,
  ];
  const i = Math.floor(h);
  const f = h - i;
  return table[i] * (1 - f) + table[(i + 1) % 24] * f;
}

/**
 * What the figures are doing, where they stand, and which way they face.
 *
 * ZONES. `sidewalkBand` splits a footway into a furnishing strip at the back of
 * the kerb and a pedestrian through-route reserved at the property-line end -
 * and the walking simulation puts its walkers 1.0 m in from the property line,
 * i.e. squarely in that through-route. So every stationary figure stands in the
 * furnishing strip, which is both where the street contract says non-moving
 * things belong and where people really do stand: at the kerb, by the meter, on
 * the kerb edge. Placing them against the shopfront instead would put them
 * inside the walking lane on a 2.5 m footway, which is most of this city.
 *
 *   zone     'strip'    the furnishing strip, back of the kerb outward
 *            'kerbEdge' sitting on the kerb itself, feet toward the gutter
 *   facing   'road'     out across the carriageway (waiting to cross)
 *            'building' back at the shopfront
 *            'along'    along the street
 *            'pair'     at the other half of a conversation
 *   corner   only chosen within `CORNER_ZONE_METRES` of a junction
 */
const ACTIVITY_CATALOGUE = Object.freeze([
  { activity: 'wait', zone: 'strip', facing: 'road', weight: 0.7, corner: true },
  { activity: 'phone', zone: 'strip', facing: 'along', weight: 0.85, corner: false },
  { activity: 'talk', zone: 'strip', facing: 'pair', weight: 1.0, corner: false, pair: 'listen' },
  { activity: 'browse', zone: 'strip', facing: 'building', weight: 0.7, corner: false },
  { activity: 'lean', zone: 'strip', facing: 'road', weight: 0.5, corner: false },
  { activity: 'sit', zone: 'kerbEdge', facing: 'road', weight: 0.4, corner: false },
  { activity: 'carry', zone: 'strip', facing: 'along', weight: 0.45, corner: false },
  { activity: 'stand', zone: 'strip', facing: 'along', weight: 0.5, corner: false },
]);

/**
 * Clearance the walking simulation's through-route keeps from a stationary
 * figure, measured from the CENTRE of that route.
 *
 * `buildSidewalkPaths` walks its agents 1.0 m in from the property line with up
 * to 0.38 m of lateral scatter. At the previous 0.45 m a walker scattered fully
 * toward the kerb passed within 0.45 - 0.38 = 0.07 m of a standing figure's
 * centre - i.e. THROUGH it. Two populations that never touch by construction is
 * the whole premise of this pass sharing a pavement with the simulation, and
 * 0.07 m is not that.
 *
 * The number is now derived from the two facts it has to satisfy:
 *
 *   scatter                            0.38 m
 *   + `PRESENTATION_VALIDITY.minSeparationM`  0.40 m
 *                                      ------
 *                                      0.78 m -> 0.80 m
 *
 * so the closest a walker can come to a standing figure is exactly the
 * separation the validity gate would otherwise have to cull one of them for.
 * The placement window on the narrowest footway this pass populates (2.5 m,
 * band 4.26-6.60 m) is 4.16-4.80 m, and the authored standing offset is
 * 4.60-4.76 m, so nothing is lost to the wider clearance.
 */
export const WALKER_LANE_CLEARANCE_M = 0.80;

/** How close to a junction a figure has to be to count as "at the corner". */
const CORNER_ZONE_METRES = 7;

/**
 * How close two standing figures may ever be, and how many of them may share a
 * patch of pavement.
 *
 * ---------------------------------------------------------------------------
 * DERIVED FROM THE BODY, NOT PICKED
 * ---------------------------------------------------------------------------
 * The near-tier body's bideltoid breadth is `2 * (shoulder joint 0.185 +
 * deltoid half-width 0.059) = 0.488 m`, and `identityVariation` scales a figure
 * by up to 1.06, so the widest figure this pass can draw is 0.517 m across the
 * shoulders. Every number below is that breadth plus a stated air gap:
 *
 *   solo   0.95 m  ->  0.43 m of air. Two strangers on a pavement.
 *   group  0.80 m  ->  0.28 m of air. A conversation pair or a crossing queue;
 *                      closer than strangers stand, which is the point, but
 *                      still not touching.
 *   queue  0.86 m  ->  the along-kerb pitch of a waiting line, > `group`.
 *
 * The previous values were 0.78 / 0.55 / 0.78. `group` at 0.55 m was NARROWER
 * THAN THE FIGURE, so a conversation pair and a crossing queue were authored to
 * intersect: the two bodies shared 0.03 m of solid at the shoulder at the
 * reference scale, and more at every scale above it. That is the "six figures
 * overlapping inside about three metres" a reviewer measured on a round-3 card,
 * and it is a placement bug, not a density preference.
 *
 * `maxWithinCluster` is the separate rule. Minimum separation alone bounds the
 * NEAREST neighbour and says nothing about how many neighbours there are: at
 * 0.95 m you can still stand thirty people inside a 3 m circle and pass every
 * pairwise test. A knot of people is a real thing on a pavement, a crowd scene
 * is not, so no figure may have more than four other figures inside
 * `clusterRadius`.
 */
export const STREET_LIFE_SPACING = Object.freeze({
  /** Widest figure the near tier draws, metres across the shoulders. */
  shoulderBreadth: 0.517,
  solo: 0.95,
  group: 0.80,
  queue: 0.86,
  clusterRadius: 3.0,
  maxWithinCluster: 4,
});
/** Extra waiting figures placed at each signalised junction approach. */
const CROSSING_QUEUE = Object.freeze({ min: 1, max: 4, spacing: STREET_LIFE_SPACING.queue });
/** Plan-radius of a standing figure, for the overlap test against street props. */
const FIGURE_RADIUS = 0.34;
/** Kerb stall pitch: a 4.6 m car plus a 1.8 m manoeuvring gap. */
const PARKING_PITCH = 6.4;
/** No stall inside this distance of a junction mouth. */
const PARKING_END_CLEARANCE = 8.5;
/** A stall this close to a legacy parked car is already taken. */
const PARKING_DEDUPE_RADIUS = 3.2;

const TAU = Math.PI * 2;

/**
 * Where the two ankles sit in CHARACTER space (soles at y = 0) with the legs at
 * rest, from the shared rest pose rather than from a number copied out of it.
 *
 * This is the target the drawn foot is measured against: every stationary
 * activity except `sit` leaves the leg bones at identity, so a standing
 * figure's drawn ankle must land exactly here once the root transform is
 * applied, and any difference is a foot that is not where the placement put it.
 */
const REST_ANKLE = Object.freeze([
  Object.freeze(restBoneWorld('LeftFoot')),
  Object.freeze(restBoneWorld('RightFoot')),
]);

/** The carried-prop attachment, resolved once. See `carriedPropAttachments`. */
const CARRIED_PROP_ATTACHMENT = carriedPropAttachments()
  .find((entry) => entry.flag === CARRIED_PROP_FLAGS[0]) || null;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// lens guard
// ---------------------------------------------------------------------------
//
// One of the round-3 cards is an intersection whose near quarter is a scenery
// figure standing on the lens. Two things made that inevitable rather than
// unlucky:
//
//   * the near ring selected nearest-first with no floor, so the closest
//     scenery figure in the world was GUARANTEED to be drawn, however close it
//     was to the eye;
//   * a scenery figure is not a pedestrian. The simulated crowd walks out of
//     shot on its own and the QA clearance guard knows where its agents are;
//     these figures are motionless, are known to no simulation list, and will
//     stand in the lens for as long as the camera is there.
//
// THE RULE. "No figure within R metres of the camera" is the obvious fix and it
// is the wrong one for gameplay: the figures stand in the furnishing strip
// about 1.2 m off the walking route, so a radius large enough to clear a lens
// deletes every figure the player walks past, and the crowd visibly tears a
// hole around the player. The rule implemented instead is about the LENS, has
// two parts, and neither part can open a hole in a crowd the player is walking
// through:
//
//   1. HARD CULL, `nearVolume`. A figure whose body can reach inside the
//      camera's near volume - the space between the eye and the near plane - is
//      never drawn. Anything it removes is geometry the lens is inside of: it
//      would render as a sliced torso pasted over the frame, or clip open
//      entirely. The radius is the sphere that circumscribes the near-plane
//      rectangle, `hypot(near, near*tan(fov/2), near*tan(fov/2)*aspect)`, plus
//      the figure's body radius. For the canonical 52 deg / 0.5 m / 16:9 camera
//      that is 1.05 m; for the 47 deg capture camera, 1.01 m.
//
//   2. INTRODUCE GUARD, `introduce`. A figure that is not already being drawn
//      is not introduced inside the distance at which a standing figure spans
//      the whole frame height, `figureHeight / (2*tan(fov/2))` - 1.95 m on the
//      canonical camera, 2.19 m on the 47 deg capture camera, 1.71 m at the
//      58 deg canyon FOV, exactly as it should be: a wider lens needs less
//      room. A figure ALREADY drawn is kept however close the camera comes
//      (down to the hard cull), so walking up to somebody never pops them out.
//      What the guard actually forbids is the camera ARRIVING with a body
//      already inside the lens - a capture pose, a fast travel, a respawn, a
//      re-plan after a teleport - which is precisely the round-3 failure.
//
// Both radii are recomputed from the live camera every re-plan, so they follow
// a FOV change, a photo mode, or an aspect change without a second constant to
// keep in sync.
export const STREET_LIFE_LENS_GUARD = Object.freeze({
  /** Tallest figure the pass draws: 1.78 m rig x the 1.06 top of `heightScale`. */
  figureHeight: 1.9,
  /** Plan radius of a body, the same one the placement overlap test uses. */
  bodyRadius: FIGURE_RADIUS,
  /** Used when the pass is driven from `ctx.focus` with no perspective camera. */
  fallback: Object.freeze({ fov: 52, aspect: 16 / 9, near: 0.5 }),
});

/**
 * The two lens radii, in metres from the eye, for a given camera.
 *
 * Pure function of `fov`, `aspect` and `near`; a non-perspective or missing
 * camera falls back to the canonical runtime camera rather than to zero, so a
 * headless or orthographic caller still gets a guard.
 *
 * @param {THREE.Camera|null} camera
 * @param {object} [out] reused result object
 */
export function streetLifeLensGuard(camera, out = {}) {
  const fallback = STREET_LIFE_LENS_GUARD.fallback;
  const perspective = Boolean(camera && camera.isPerspectiveCamera);
  const read = (value, spare, lo, hi) => {
    const n = Number(perspective ? value : spare);
    return Number.isFinite(n) && n > 0 ? clamp(n, lo, hi) : spare;
  };
  const fov = read(camera?.fov, fallback.fov, 10, 150);
  const aspect = read(camera?.aspect, fallback.aspect, 0.2, 8);
  const near = read(camera?.near, fallback.near, 0.01, 10);
  const tanHalf = Math.tan((fov * Math.PI) / 360);
  const halfHeight = near * tanHalf;
  const halfWidth = halfHeight * aspect;
  const nearVolume = Math.hypot(near, halfHeight, halfWidth) + STREET_LIFE_LENS_GUARD.bodyRadius;
  const introduce = Math.max(nearVolume, STREET_LIFE_LENS_GUARD.figureHeight / (2 * tanHalf));
  out.fov = fov;
  out.aspect = aspect;
  out.near = near;
  out.nearVolume = nearVolume;
  out.introduce = introduce;
  return out;
}

/**
 * The two vertical planes the renderer pins for the whole street.
 *
 * `src/citygen/renderer.js` builds the surface with a gutter cut 40 mm below
 * the carriageway datum and a curb face sized so the footway lands exactly
 * 45 mm above that datum, because street lamps, sidewalk props and the seated
 * hero actors are already grounded there. Reproduced here rather than imported
 * so this pass shares no mutable state with the renderer, and asserted against
 * the same numbers by the verifier.
 */
export function streetLifeSurfaceOptions(city) {
  const defaults = STREET_SURFACE_V2_DEFAULTS;
  const roadLift = Number(city?.meta?.streetDesign?.roadLift ?? defaults.roadLift);
  const datum = Number.isFinite(roadLift) ? roadLift : defaults.roadLift;
  const gutterDepth = 0.04;
  const legacyFootwayLift = 0.102;
  return {
    roadLift: datum,
    gutterDepth,
    curbFaceHeight: legacyFootwayLift + gutterDepth + defaults.curbTopFall,
  };
}

// ---------------------------------------------------------------------------
// district density
// ---------------------------------------------------------------------------

/**
 * Coarse building-mass grid, used to tell a downtown block from a warehouse
 * street without a per-anchor spatial query. One cell per `cellSize` metres
 * holding total floor area; `at()` returns a 0..1 density that saturates at
 * `fullMass`, so a tower cluster and a two-storey terrace get different crowds.
 */
export function buildDistrictDensity(city, { cellSize = 110, fullMass = 26000 } = {}) {
  const bounds = city?.meta?.bounds;
  const buildings = Array.isArray(city?.buildings) ? city.buildings : [];
  const minX = Number(bounds?.minX);
  const minZ = Number(bounds?.minZ);
  const maxX = Number(bounds?.maxX);
  const maxZ = Number(bounds?.maxZ);
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) {
    return { at: () => 0.6, cells: 0, cellSize };
  }
  const width = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const height = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const grid = new Float64Array(width * height);
  for (const building of buildings) {
    const polygon = building?.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    let area = 0;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      area += a.x * b.z - b.x * a.z;
      cx += a.x;
      cz += a.z;
    }
    area = Math.abs(area / 2);
    cx /= polygon.length;
    cz /= polygon.length;
    const levels = Math.max(1, Number(building.levels) || Math.round((Number(building.height) || 8) / 3.3));
    const gx = clamp(Math.floor((cx - minX) / cellSize), 0, width - 1);
    const gz = clamp(Math.floor((cz - minZ) / cellSize), 0, height - 1);
    grid[gz * width + gx] += area * levels;
  }
  return {
    cells: width * height,
    cellSize,
    at(x, z) {
      const gx = clamp(Math.floor((x - minX) / cellSize), 0, width - 1);
      const gz = clamp(Math.floor((z - minZ) / cellSize), 0, height - 1);
      // Blur over the 3x3 neighbourhood: a block's crowd does not stop dead at
      // a grid line.
      let sum = 0;
      let n = 0;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const ix = gx + dx;
          const iz = gz + dz;
          if (ix < 0 || iz < 0 || ix >= width || iz >= height) continue;
          sum += grid[iz * width + ix];
          n += 1;
        }
      }
      const mass = n ? sum / n : 0;
      // Even a quiet street has somebody on it: floor at 0.22.
      return 0.22 + 0.78 * clamp(mass / fullMass, 0, 1);
    },
  };
}

// ---------------------------------------------------------------------------
// exclusions
// ---------------------------------------------------------------------------

/**
 * A hash grid of everything already standing on this street, harvested from the
 * finished scene graph rather than guessed at.
 *
 * Passes with a lower `order` (street furniture, and the legacy renderer's own
 * lamps, props, trees and parked cars) have already added their content to
 * `ctx.root` by the time this runs, so their instance translations are readable
 * facts. Only compact instanced content is harvested: a road ribbon or a
 * building shell is a single big merged mesh and is filtered out by its
 * bounding radius, which is also what keeps this scan cheap.
 */
export function collectStreetOccupancy(root, {
  cell = 6,
  maxPoints = 24000,
  maxRadius = 7,
  match = null,
} = {}) {
  const buckets = new Map();
  let points = 0;
  const position = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const add = (x, z, radius) => {
    if (points >= maxPoints) return;
    points += 1;
    const key = `${Math.floor(x / cell)}:${Math.floor(z / cell)}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(x, z, radius);
  };
  if (root && typeof root.traverse === 'function') {
    root.traverse((node) => {
      if (points >= maxPoints) return;
      if (!node.isInstancedMesh || !node.geometry) return;
      if (match && !match.test(node.name || '')) return;
      const geometry = node.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const radius = geometry.boundingSphere ? geometry.boundingSphere.radius : 0;
      if (!(radius > 0) || radius > maxRadius) return;
      const count = Math.min(node.count ?? 0, node.instanceMatrix?.count ?? 0);
      const footprint = Math.min(radius, 1.4);
      for (let i = 0; i < count; i += 1) {
        matrix.fromArray(node.instanceMatrix.array, i * 16);
        position.setFromMatrixPosition(matrix);
        add(position.x, position.z, footprint);
      }
    });
  }
  return {
    points,
    cell,
    /** True when `(x,z)` is within `margin` metres of anything already there. */
    blocked(x, z, margin) {
      const gx = Math.floor(x / cell);
      const gz = Math.floor(z / cell);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const list = buckets.get(`${gx + dx}:${gz + dz}`);
          if (!list) continue;
          for (let i = 0; i < list.length; i += 3) {
            const ex = list[i];
            const ez = list[i + 1];
            const er = list[i + 2];
            const reach = margin + er;
            if ((ex - x) * (ex - x) + (ez - z) * (ez - z) < reach * reach) return true;
          }
        }
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// anchor planning
// ---------------------------------------------------------------------------

function pickActivity(seed, salt, atCorner) {
  let total = 0;
  for (const entry of ACTIVITY_CATALOGUE) {
    if (entry.corner && !atCorner) continue;
    total += entry.weight;
  }
  let roll = identityRandom(seed, salt) * total;
  let chosen = null;
  for (const entry of ACTIVITY_CATALOGUE) {
    if (entry.corner && !atCorner) continue;
    chosen = entry;
    roll -= entry.weight;
    if (roll <= 0) break;
  }
  return chosen || ACTIVITY_CATALOGUE[ACTIVITY_CATALOGUE.length - 1];
}

/** Yaw that faces `(dx, dz)`; the rig's forward is +Z at yaw 0. */
function yawTo(dx, dz) {
  return Math.atan2(dx, dz);
}

/**
 * Every stationary figure in the city, as plain data.
 *
 * Placement rules, in order:
 *   1. only on a side that actually has a footway wide enough to stand on;
 *   2. inside the footway band, at the kerb edge or the property-line edge,
 *      never in the through-route the walking simulation uses;
 *   3. never within `FIGURE_RADIUS + item radius` of a prop already there;
 *   4. never within 0.7 m of another figure, except a conversation pair, which
 *      is deliberately 0.92 m apart and facing;
 *   5. grounded on `sidewalkSurfaceY` at its own lateral offset, so a figure on
 *      a cross-falling footway stands on the footway and not through it.
 *
 * @returns {{anchors: Array, rejected: object, sampledSegments: number}}
 */
export function planStreetLifeAnchors(plan, {
  hour = 12,
  density = null,
  occupancy = null,
  heightAt = () => 0,
  maxAnchors = STREET_LIFE_BUDGET.maxAnchors,
  footprints = null,
} = {}) {
  const anchors = [];
  const rejected = { noBand: 0, tooShort: 0, blocked: 0, crowded: 0, capped: 0, insideBuilding: 0 };
  let relocated = 0;
  const options = plan.options;
  const hourFactor = streetLifeHourFactor(hour);
  const districtAt = density ? (x, z) => density.at(x, z) : () => 0.7;
  // Figures already placed. Two rules, both enforced here because both are
  // properties of the FINAL set, not of one placement:
  //
  //   1. minimum separation, and the minimum depends on whether the two figures
  //      belong to the same conversation or queue. Comparing a grouped figure
  //      against a stranger at the group minimum was the hole in the previous
  //      version: two different pairs could end up 0.80 m apart, which is a
  //      stranger distance the rules say is 0.95 m;
  //   2. the cluster cap, which is symmetric. Rejecting a candidate that has
  //      too many neighbours is not enough - the candidate is also a NEW
  //      neighbour for everyone around it, so a figure placed early can be
  //      pushed over the cap by figures placed later. Each accepted figure
  //      therefore also has to leave every neighbour under the cap.
  //
  // The grid cell is 2 m and `clusterRadius` is 3 m, so the scan reaches two
  // cells out; the separation test only ever needs one, and gets the wider scan
  // for free.
  const CELL = 2;
  const REACH = Math.ceil(STREET_LIFE_SPACING.clusterRadius / CELL);
  const clusterR2 = STREET_LIFE_SPACING.clusterRadius * STREET_LIFE_SPACING.clusterRadius;
  const solo2 = STREET_LIFE_SPACING.solo * STREET_LIFE_SPACING.solo;
  const group2 = STREET_LIFE_SPACING.group * STREET_LIFE_SPACING.group;
  /** @type {Map<string, Array<{x:number, z:number, groupId:string|null, near:number}>>} */
  const placed = new Map();
  const claim = (x, z, groupId) => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const neighbours = [];
    for (let dz = -REACH; dz <= REACH; dz += 1) {
      for (let dx = -REACH; dx <= REACH; dx += 1) {
        const list = placed.get(`${cx + dx}:${cz + dz}`);
        if (!list) continue;
        for (const other of list) {
          const d2 = (other.x - x) * (other.x - x) + (other.z - z) * (other.z - z);
          const together = Boolean(groupId) && other.groupId === groupId;
          if (d2 < (together ? group2 : solo2)) return false;
          if (d2 < clusterR2) {
            if (other.near >= STREET_LIFE_SPACING.maxWithinCluster) return false;
            neighbours.push(other);
            if (neighbours.length > STREET_LIFE_SPACING.maxWithinCluster) return false;
          }
        }
      }
    }
    const key = `${cx}:${cz}`;
    let list = placed.get(key);
    if (!list) {
      list = [];
      placed.set(key, list);
    }
    for (const other of neighbours) other.near += 1;
    list.push({ x, z, groupId: groupId || null, near: neighbours.length });
    return true;
  };

  let sampledSegments = 0;
  for (const segment of plan.segments) {
    if (anchors.length >= maxAnchors) { rejected.capped += 1; break; }
    const classWeight = STREET_LIFE_CLASS_WEIGHT[segment.className] ?? 0.4;
    if (classWeight <= 0) continue;
    const usableStart = segment.trimStart;
    const usableEnd = segment.length - segment.trimEnd;
    const usable = usableEnd - usableStart;
    if (!(usable > 6)) { rejected.tooShort += 1; continue; }
    sampledSegments += 1;
    const seed = identitySeed(`street-life:${segment.id}`);

    for (const side of [1, -1]) {
      const band = sidewalkBand(segment, side, options, 1.2);
      if (!band) { rejected.noBand += 1; continue; }
      const midStation = streetStationAt(segment, (usableStart + usableEnd) / 2);
      const district = districtAt(midStation.x, midStation.z);
      const expected = usable * STREET_LIFE_LINE_DENSITY * classWeight * district * hourFactor;
      // Deterministic rounding: the fractional part becomes a probability, so a
      // short block still occasionally gets its one person.
      const whole = Math.floor(expected);
      const extra = identityRandom(seed, `count-${side}`) < (expected - whole) ? 1 : 0;
      let count = whole + extra;
      // Junction approaches get a queue on top of the line density: that is
      // what makes a red light look like a red light.
      const queues = [];
      for (const [node, station] of [[segment.nodeStart, usableStart + 1.8], [segment.nodeEnd, usableEnd - 1.8]]) {
        if (!node || node.degree < 3) continue;
        // A queue belongs at a crossing people actually wait at: a signalised
        // junction, or one where a collector or better meets the street. Every
        // three-way service turn-off getting a queue is what turns a city into
        // a crowd of people standing about doing nothing.
        if (!node.signalised && node.maxClassRank < 5) continue;
        const queueSeed = identityRandom(seed, `queue-${side}-${station.toFixed(1)}`);
        if (queueSeed > 0.5) continue;
        const size = Math.round(
          CROSSING_QUEUE.min + (queueSeed * 2) * (CROSSING_QUEUE.max - CROSSING_QUEUE.min)
          * district * hourFactor,
        );
        if (size > 0) queues.push({ station, size });
      }
      count = Math.min(count, 24);

      const emit = (station, forcedActivity, groupId, pairIndex) => {
        if (anchors.length >= maxAnchors) return false;
        const s = clamp(station, usableStart + 0.6, usableEnd - 0.6);
        const frame = streetStationAt(segment, s);
        const atCorner = Math.min(s - usableStart, usableEnd - s) <= CORNER_ZONE_METRES
          && (segment.nodeStart || segment.nodeEnd);
        const salt = `act-${side}-${s.toFixed(2)}`;
        const entry = forcedActivity
          || pickActivity(seed, salt, Boolean(atCorner));
        // Lateral offset inside the band, measured from the centreline.
        const jitter = identityRandom(seed, `lat-${salt}`) * 0.16;
        const desiredOffset = entry.zone === 'kerbEdge'
          // Perched on the kerb top, which is a seat every city provides.
          ? band.inner - 0.06
          : band.inner + 0.34 + jitter;
        if (desiredOffset < band.inner - 0.1) return false;
        // Never inside the lane the walking simulation uses.
        //
        // CLAMPED, NOT REJECTED. The clearance widened this wave (see
        // `WALKER_LANE_CLEARANCE_M`), and on a footway narrower than about
        // 2.15 m the authored standing offset no longer fits inside it. A
        // return here would have emptied every narrow street in the city -
        // which is the "nobody on the pavement" complaint this pass exists to
        // answer, reintroduced by a spacing rule. Pressed against the kerb IS
        // where people stand on a narrow pavement, so the figure is moved there
        // and only dropped when even the kerb line is inside the walking lane's
        // clearance.
        const walkerLane = band.outer - 1.0;
        const outermost = walkerLane - WALKER_LANE_CLEARANCE_M;
        if (outermost < band.inner - 0.1) return false;
        const baseOffset = Math.min(desiredOffset, outermost);
        // ---------------------------------------------------------------
        // NOBODY STANDS INSIDE A BUILDING.
        // ---------------------------------------------------------------
        // The footway band comes from the STREET contract - centreline, width,
        // sidewalk width - and knows nothing about what is built beside it.
        // Where a source building polygon overlaps that band, which is most
        // narrow downtown streets, the furnishing strip is inside the ground
        // floor and every figure placed on it stands behind the glazing. That
        // is the round-4 canyon card, and no amount of pose work fixes it.
        //
        // RELOCATE FIRST, REJECT SECOND. The strip runs from the kerb outward,
        // so a footprint that reaches it always reaches the OUTER end first.
        // The candidates are therefore kerbward: where the figure wanted to
        // stand, a 0.28 m step back from the property line, and finally the
        // kerb edge itself - which is where somebody stands when the building
        // comes out to the pavement, and is a real place to stand rather than a
        // fallback. Only a footprint that covers the kerb as well - a source
        // polygon over the carriageway - loses the figure, and that rejection
        // is counted rather than absorbed.
        let offset = baseOffset;
        let x = 0;
        let z = 0;
        let inside = true;
        let attempt = 0;
        const candidates = [baseOffset, baseOffset - 0.28, band.inner + 0.02];
        for (; attempt < candidates.length; attempt += 1) {
          offset = candidates[attempt];
          if (offset < band.inner - 0.1 || offset > baseOffset + 1e-9) continue;
          const lateral = offset * side;
          x = frame.x + frame.nx * lateral * frame.miter;
          z = frame.z + frame.nz * lateral * frame.miter;
          inside = footprints ? footprints.contains(x, z) : false;
          if (!inside) break;
        }
        if (inside) { rejected.insideBuilding += 1; return false; }
        if (attempt > 0) relocated += 1;
        const u = offset * side;
        if (occupancy && occupancy.blocked(x, z, FIGURE_RADIUS)) { rejected.blocked += 1; return false; }
        if (!claim(x, z, groupId)) { rejected.crowded += 1; return false; }
        const datum = heightAt(x, z) + options.roadLift;
        const y = sidewalkSurfaceY(datum, u, segment.half, options);
        // Facing.
        const outward = { x: frame.nx * side, z: frame.nz * side };
        let yaw;
        switch (entry.facing) {
          case 'road': yaw = yawTo(-outward.x, -outward.z); break;
          case 'building': yaw = yawTo(outward.x, outward.z); break;
          case 'pair': {
            // Facing the other half of the conversation, but not squared up to
            // them: two figures on exactly opposite yaws read as a mirror, and
            // a street of mirrors is the clustering artifact this pass is
            // supposed to be the cure for. +/- 0.22 rad, deterministic.
            const base = pairIndex === 1
              ? yawTo(-frame.tx, -frame.tz)
              : yawTo(frame.tx, frame.tz);
            yaw = base + (identityRandom(seed, `pair-yaw-${salt}-${pairIndex}`) - 0.5) * 0.44;
            break;
          }
          default: yaw = yawTo(frame.tx, frame.tz) + (identityRandom(seed, `yaw-${salt}`) - 0.5) * 0.7;
        }
        const id = `sl-${segment.id}-${side > 0 ? 'l' : 'r'}-${anchors.length}`;
        anchors.push({
          id,
          seed: identitySeed(id),
          x,
          y,
          z,
          yaw,
          activity: entry.activity,
          seated: entry.activity === 'sit',
          groupId: groupId || null,
          segmentId: segment.id,
          side,
          className: segment.className,
        });
        return true;
      };

      for (const queue of queues) {
        for (let i = 0; i < queue.size; i += 1) {
          emit(queue.station + i * CROSSING_QUEUE.spacing, ACTIVITY_CATALOGUE[0], `q-${segment.id}-${side}-${queue.station.toFixed(0)}`, 0);
        }
      }
      for (let i = 0; i < count; i += 1) {
        const t = (i + 0.5 + (identityRandom(seed, `jit-${side}-${i}`) - 0.5) * 0.7) / Math.max(1, count);
        const station = usableStart + t * usable;
        const atCorner = Math.min(station - usableStart, usableEnd - station) <= CORNER_ZONE_METRES
          && (segment.nodeStart || segment.nodeEnd);
        const entry = pickActivity(seed, `pick-${side}-${i}`, Boolean(atCorner));
        if (entry.pair) {
          const groupId = `pair-${segment.id}-${side}-${i}`;
          // The partner's activity is `entry.pair` - 'listen', which is a real
          // pose in `ACTIVITY_POSES` with its own arms-folded, head-tilted
          // overlay. It is deliberately NOT in `ACTIVITY_CATALOGUE`, because
          // nobody stands alone listening; it only exists as the other half of
          // a conversation. Looking it up in the catalogue therefore missed,
          // fell back to `entry`, and drew every conversation in this city as
          // two people making the same talking gesture at each other.
          const partner = ACTIVITY_CATALOGUE.find((candidate) => candidate.activity === entry.pair)
            || { ...entry, activity: entry.pair, pair: null };
          emit(station, entry, groupId, 0);
          emit(station + 0.92, { ...partner, zone: entry.zone, facing: 'pair' }, groupId, 1);
        } else {
          emit(station, entry, null, 0);
        }
      }
    }
  }
  return { anchors, rejected, sampledSegments, relocated };
}

/**
 * Kerb stalls, as plain data.
 *
 * Stalls sit on the carriageway surface 1.3 m in from the kerb line, which is
 * the same lateral offset and the same datum the legacy map-wide parked-car
 * layer uses, so the two layers form one continuous line of cars rather than
 * two offset ones. Any stall the legacy layer already filled is dropped.
 */
export function planKerbParking(plan, {
  occupancy = null,
  heightAt = () => 0,
  maxSpots = STREET_LIFE_BUDGET.maxParkingSpots,
  occupancyRate = 0.66,
} = {}) {
  const spots = [];
  const rejected = { narrow: 0, classFiltered: 0, taken: 0, empty: 0, capped: 0 };
  const options = plan.options;
  for (const segment of plan.segments) {
    if (spots.length >= maxSpots) { rejected.capped += 1; break; }
    const weight = STREET_LIFE_CLASS_WEIGHT[segment.className] ?? 0;
    if (!(weight > 0.3) || segment.className === 'pedestrian') { rejected.classFiltered += 1; continue; }
    if (segment.half < 3.4) { rejected.narrow += 1; continue; }
    const start = segment.trimStart + PARKING_END_CLEARANCE;
    const end = segment.length - segment.trimEnd - PARKING_END_CLEARANCE;
    if (!(end - start > PARKING_PITCH)) { rejected.narrow += 1; continue; }
    const seed = identitySeed(`kerb:${segment.id}`);
    const stalls = Math.floor((end - start) / PARKING_PITCH);
    for (const side of [1, -1]) {
      const band = sidewalkBand(segment, side, options, 1.2);
      if (!band) continue;
      for (let i = 0; i < stalls; i += 1) {
        if (spots.length >= maxSpots) break;
        const salt = `${side}-${i}`;
        if (identityRandom(seed, `use-${salt}`) > occupancyRate) { rejected.empty += 1; continue; }
        const s = start + (i + 0.5) * PARKING_PITCH;
        const frame = streetStationAt(segment, s);
        const u = (segment.half - 1.3) * side;
        const x = frame.x + frame.nx * u * frame.miter;
        const z = frame.z + frame.nz * u * frame.miter;
        if (occupancy && occupancy.blocked(x, z, PARKING_DEDUPE_RADIUS)) { rejected.taken += 1; continue; }
        const datum = heightAt(x, z) + options.roadLift;
        const y = carriagewaySurfaceY(datum, u, segment.half, options);
        // Nose in the direction of travel on that side of the road, with a
        // small parking error so the line is not machine-perfect.
        const along = side > 0 ? 1 : -1;
        const yaw = yawTo(frame.tx * along, frame.tz * along)
          + (identityRandom(seed, `skew-${salt}`) - 0.5) * 0.06;
        spots.push({
          id: `${segment.id}:${salt}`,
          seed: identitySeed(`kerb-car:${segment.id}:${salt}`),
          x,
          y,
          z,
          yaw,
          segmentId: segment.id,
        });
      }
    }
  }
  return { spots, rejected };
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** Parked-car paint: desaturated street colours, never a toybox. */
const CAR_PAINT = Object.freeze([
  0x9aa0a4, 0x2f3438, 0xb8bcbd, 0x3d4b57, 0x6d6257, 0x8c3a33, 0x2f4f45,
  0xc9c4b6, 0x4a4f55, 0x7a848c, 0x35414d, 0x5d4a3f,
]);

function boxInto(target, size, offset) {
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geometry.translate(offset[0], offset[1], offset[2]);
  target.push(geometry);
  return geometry;
}

/**
 * Concatenate non-indexed geometries carrying only position/normal/uv. Written
 * inline: `three/addons` is off the WebGPU renderer path, and this is 20 lines.
 */
function mergeSimple(list) {
  const parts = list.map((geometry) => geometry.toNonIndexed());
  let total = 0;
  for (const part of parts) total += part.attributes.position.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let v = 0;
  for (const part of parts) {
    position.set(part.attributes.position.array, v * 3);
    normal.set(part.attributes.normal.array, v * 3);
    if (part.attributes.uv) uv.set(part.attributes.uv.array, v * 2);
    v += part.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  for (const part of parts) part.dispose();
  for (const geometry of list) if (!parts.includes(geometry)) geometry.dispose();
  return out;
}

/**
 * A parked car in two pieces so the glass can be a different material: hull
 * (body plus four wheels, 116 tri) and cabin (12 tri). Origin at the tyre
 * contact patch, nose toward +Z, which matches the anchor yaw convention.
 */
export function buildParkedCarGeometry() {
  const hullParts = [];
  boxInto(hullParts, [1.80, 0.62, 4.34], [0, 0.70, 0]);
  boxInto(hullParts, [1.68, 0.20, 3.30], [0, 1.05, -0.05]);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.21, 8);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(sx * 0.83, 0.33, sz * 1.34);
      hullParts.push(wheel);
    }
  }
  const cabinParts = [];
  boxInto(cabinParts, [1.56, 0.54, 2.05], [0, 1.34, -0.18]);
  return {
    hull: mergeSimple(hullParts),
    cabin: mergeSimple(cabinParts),
  };
}

/** A soft round blob, reused from the crowd's contact-shadow recipe. */
function buildBlobTexture(size = 32) {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const r = Math.min(1, Math.hypot(dx, dy));
      const a = Math.round(255 * (1 - r) * (1 - r) * (1 - r * 0.35));
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = a;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** One InstancedMesh per `"<bone>|<group>"` key, keyed the way the crowd is. */
function createBand(name, geometries, capacity, { castShadow }) {
  const group = new THREE.Group();
  group.name = name;
  const meshes = [];
  const materials = new Map();
  for (const [key, entry] of geometries) {
    let material = materials.get(entry.group);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: entry.group === 'shoes' ? 0.62 : entry.group === 'skin' ? 0.74 : 0.88,
        metalness: 0,
        // The body geometry carries a baked cavity term in its colour
        // attribute; three multiplies it with the per-agent instance colour, so
        // a figure has a shaded side even where the scene lighting is flat.
        vertexColors: true,
      });
      material.name = `street-life-${entry.group}`;
      // Declared so `renderer.applyEnvironmentGrading` can reach these: an
      // untagged material never receives the per-class environment intensity or
      // the wet-weather roughness/albedo grade, and reads flat in shade.
      material.userData.envClass = 'fabric';
      material.envMapIntensity = 1;
      materials.set(entry.group, material);
    }
    const mesh = new THREE.InstancedMesh(entry.geometry, material, Math.max(1, capacity));
    mesh.name = `${name}-${key.replace(/\|/g, '-')}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.setColorAt(0, new THREE.Color(0xffffff));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    meshes.push({ key, bone: entry.bone, group: entry.group, flag: entry.flag ?? null, mesh });
    group.add(mesh);
  }
  return { group, meshes, materials, capacity: Math.max(1, capacity) };
}

/** A bone-only Object3D tree used to evaluate one figure's pose at a time. */
function buildPoser() {
  const root = new THREE.Group();
  root.name = 'street-life-poser';
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
  return { root, byName };
}

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

/**
 * Sun elevation in degrees for the pass, from the context.
 *
 * `ctx.sunElevationDeg` if the renderer supplies it - it owns the real solar
 * position and should - otherwise a plain day-arc from `ctx.hour`, which is the
 * only clock this pass is guaranteed. The arc is deliberately crude: what it
 * has to get right is the SIGN, because the contact blob's whole night
 * behaviour turns on whether the sun is up.
 */
export function streetLifeSunElevationDeg(ctx) {
  const supplied = ctx?.sunElevationDeg;
  if (Number.isFinite(supplied)) return supplied;
  const hour = Number.isFinite(ctx?.hour) ? ((ctx.hour % 24) + 24) % 24 : 12;
  // Up at 06:00, down at 18:00, 64 degrees at the zenith.
  return 64 * Math.sin((Math.PI * (hour - 6)) / 12);
}

function viewPosition(ctx, out) {
  const camera = ctx?.camera;
  if (camera && camera.isCamera) {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    out.x = e[12];
    out.y = e[13];
    out.z = e[14];
    return out;
  }
  const focus = ctx?.focus;
  out.x = Number(focus?.x) || 0;
  out.y = Number(focus?.y) || 0;
  out.z = Number(focus?.z) || 0;
  return out;
}

function createStreetLife() {
  let state = null;

  function dispose() {
    if (!state) return;
    for (const band of [state.near, state.mid, state.nearWardrobe, state.midWardrobe]) {
      if (!band) continue;
      for (const item of band.meshes) {
        item.mesh.geometry.dispose();
        item.mesh.dispose();
      }
      for (const material of band.materials.values()) material.dispose();
    }
    state.shadowMesh?.geometry.dispose();
    state.shadowMesh?.dispose();
    state.shadowMaterial?.map?.dispose();
    state.shadowMaterial?.dispose();
    for (const mesh of state.carMeshes || []) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
    // Withdraw the footprint index this pass published for the walking crowd:
    // it describes the world that is going away.
    publishBuildingFootprints(null);
    state = null;
  }

  function build(ctx) {
    dispose();
    const city = ctx?.city;
    const segments = Array.isArray(city?.segments) ? city.segments : [];
    const heightAt = typeof ctx?.heightAt === 'function' ? ctx.heightAt : () => 0;
    const diagnostics = {
      version: STREET_LIFE_VERSION,
      implemented: true,
      figures: { planned: 0, near: 0, mid: 0, culled: 0 },
      parking: { planned: 0, drawn: 0 },
      budget: STREET_LIFE_BUDGET,
    };
    if (!segments.length) {
      return { object: null, diagnostics: { ...diagnostics, reason: 'no-street-contract' } };
    }

    const overrides = streetLifeSurfaceOptions(city);
    const plan = buildStreetscapePlan(city, { ...overrides, heightAt, inferNodes: true });
    if (!plan.segments.length) {
      return { object: null, diagnostics: { ...diagnostics, reason: 'no-plan-segments' } };
    }

    const object = new THREE.Group();
    object.name = 'street-life';
    // Two occupancy sets, because they answer two different questions.
    // `occupancy` is everything standing on the footway, which is what a figure
    // must not be inside. `vehicles` is only the parked cars already on the
    // carriageway, which is what a kerb stall must not double-book - testing a
    // stall against footway props would reject the whole kerb.
    const occupancy = collectStreetOccupancy(ctx?.root);
    const vehicles = collectStreetOccupancy(ctx?.root, { match: /car|vehicle/i });
    const density = buildDistrictDensity(city);
    const hour = Number.isFinite(ctx?.hour) ? ctx.hour : 12;
    // The building footprints, from the same source array the district density
    // is built from. Published for the walking crowd as well: its agents come
    // from the traffic simulation and are placed on sidewalk paths that have
    // the same blind spot this pass had - see `publishBuildingFootprints`.
    const footprints = buildFootprintIndex(city?.buildings);
    if (footprints.count > 0) publishBuildingFootprints(footprints);
    const planned = planStreetLifeAnchors(plan, { hour, density, occupancy, heightAt, footprints });
    const parking = planKerbParking(plan, { occupancy: vehicles, heightAt });

    const nearRing = STREET_LIFE_RINGS[0];
    const midRing = STREET_LIFE_RINGS[1];
    const near = createBand(
      'street-life-near',
      buildInstancedPartGeometries({ detail: nearRing.detail, radialSegments: nearRing.radialSegments }),
      nearRing.budget,
      { castShadow: true },
    );
    const nearWardrobe = createBand(
      'street-life-near-wardrobe',
      buildWardrobeGeometries({ detail: nearRing.detail, radialSegments: nearRing.radialSegments }),
      nearRing.budget,
      { castShadow: true },
    );
    const mid = createBand(
      'street-life-mid',
      buildInstancedPartGeometries({ detail: midRing.detail, radialSegments: midRing.radialSegments, mergeToRoot: true }),
      midRing.budget,
      { castShadow: false },
    );
    const midWardrobe = createBand(
      'street-life-mid-wardrobe',
      buildWardrobeGeometries({ detail: midRing.detail, radialSegments: midRing.radialSegments, mergeToRoot: true }),
      midRing.budget,
      { castShadow: false },
    );
    object.add(near.group, nearWardrobe.group, mid.group, midWardrobe.group);

    // Contact shadows. Same recipe as the walking crowd's, so a standing figure
    // and a walking one sit on the pavement the same way.
    const shadowTexture = buildBlobTexture();
    const shadowMaterial = new THREE.MeshBasicMaterial({
      map: shadowTexture,
      color: 0x080b0e,
      transparent: true,
      // Density follows the sun, exactly as the walking crowd's does. A fixed
      // opacity put a full daylight contact shadow under every scenery figure
      // on the round-4 night card, where there is no sun to cast one.
      opacity: CONTACT_SHADOW.baseOpacity * contactShadowSunTerm(streetLifeSunElevationDeg(ctx)),
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    shadowMaterial.name = 'street-life-contact-shadow';
    const shadowCapacity = nearRing.budget + midRing.budget + STREET_LIFE_BUDGET.parkedCars;
    const shadowMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      shadowMaterial,
      shadowCapacity,
    );
    shadowMesh.name = 'street-life-contact-shadows';
    shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shadowMesh.frustumCulled = false;
    shadowMesh.renderOrder = 2;
    shadowMesh.count = 0;
    object.add(shadowMesh);

    // Kerb parking.
    const carGeometry = buildParkedCarGeometry();
    const hullMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.46, metalness: 0.32, flatShading: true,
    });
    hullMaterial.name = 'street-life-car-hull';
    hullMaterial.userData.envClass = 'painted-metal';
    const cabinMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.16, metalness: 0.44, flatShading: true,
    });
    cabinMaterial.name = 'street-life-car-cabin';
    cabinMaterial.userData.envClass = 'facade-glass';
    const carMeshes = [];
    for (const [geometry, material, label] of [
      [carGeometry.hull, hullMaterial, 'hull'],
      [carGeometry.cabin, cabinMaterial, 'cabin'],
    ]) {
      const mesh = new THREE.InstancedMesh(geometry, material, STREET_LIFE_BUDGET.parkedCars);
      mesh.name = `street-life-kerb-car-${label}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.setColorAt(0, new THREE.Color(0xffffff));
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      carMeshes.push(mesh);
      object.add(mesh);
    }

    // Per-figure appearance is resolved once and cached; it never changes.
    const figures = planned.anchors.map((anchor) => {
      const variation = identityVariation(anchor.seed);
      const wardrobe = identityWardrobe(anchor.seed);
      return {
        anchor,
        variation,
        wardrobe,
        signature: appearanceSignature(anchor.seed),
        // Standing on the footway means the sole is on the footway; the rig's
        // root is the pelvis, which is `hip height x scale` above it.
        rootY: anchor.y + (anchor.seated ? -ACTIVITY_ROOT_DROP.sit * variation.heightScale : 0),
        distance: Infinity,
        ring: null,
        // Lens-guard hysteresis: true while this figure is being drawn. A
        // figure is never INTRODUCED inside the lens radius, but one that is
        // already drawn is kept as the camera closes on it, so walking up to
        // somebody never pops them out of the world.
        drawn: false,
      };
    });

    state = {
      object,
      near,
      nearWardrobe,
      mid,
      midWardrobe,
      shadowMesh,
      shadowMaterial,
      carMeshes,
      figures,
      parking: parking.spots,
      poser: buildPoser(),
      validity: createValidityLedger(),
      footprintCount: footprints.count,
      overlay: {},
      time: 0,
      replanIn: 0,
      lastView: { x: Infinity, y: 0, z: Infinity },
      view: { x: 0, y: 0, z: 0 },
      active: { near: [], mid: [] },
      activeParking: [],
      lens: streetLifeLensGuard(ctx?.camera),
      sunElevationDeg: streetLifeSunElevationDeg(ctx),
      // Published, live, nearest-first. See `object.userData.streetLife`.
      nearAnchors: [],
      scratch: {
        object3d: new THREE.Object3D(),
        colour: new THREE.Color(),
        euler: new THREE.Euler(0, 0, 0, 'XYZ'),
        quaternion: new THREE.Quaternion(),
        // Reused ankle-target record, shaped like a `sampleFootGrounding`
        // result so the shared pose gate can read it. Allocation-free.
        grounding: {
          feet: [
            { ankleX: 0, ankleY: 0, ankleZ: 0, groundY: 0, contact: true },
            { ankleX: 0, ankleY: 0, ankleZ: 0, groundY: 0, contact: true },
          ],
        },
      },
      diagnostics: {
        version: STREET_LIFE_VERSION,
        implemented: true,
        planVersion: plan.version,
        planStats: plan.stats,
        hour,
        surface: overrides,
        figures: {
          planned: figures.length,
          near: 0,
          mid: 0,
          culled: 0,
          // Figures the lens guard withheld at the last re-plan.
          lensCulled: 0,
          lensWithheld: 0,
          rejected: planned.rejected,
          /** Figures moved back toward the kerb to get out of a building. */
          relocated: planned.relocated,
          sampledSegments: planned.sampledSegments,
        },
        /**
         * THE VALIDITY GATE, COUNTED.
         *
         * `placement` is what the planner did with the building footprints -
         * how many figures it moved and how many it refused to place at all.
         * `pose` is the per-frame ledger from the near ring: it re-measures the
         * DRAWN bone matrices of every articulated figure and refuses to write
         * an instance for one that is in an impossible state. `peak` publishes
         * what it measured, not only what it rejected, so a frame that passed
         * by a millimetre is legible as such.
         *
         * `footprints` is the number of building polygons the placement test
         * had; 0 means the test could not run and no rejection under
         * `insideBuilding` means anything.
         */
        validity: {
          version: PRESENTATION_VALIDITY.version,
          footprints: footprints.count,
          placement: {
            relocated: planned.relocated,
            insideBuilding: planned.rejected.insideBuilding,
          },
          carriedProps: carriedPropAttachments(),
          pose: null,
        },
        appearance: {
          uniqueSignatures: new Set(figures.map((f) => f.signature)).size,
          total: figures.length,
        },
        activities: figures.reduce((acc, f) => {
          acc[f.anchor.activity] = (acc[f.anchor.activity] || 0) + 1;
          return acc;
        }, {}),
        grounding: { maxOffset: 0, meanOffset: 0, samples: 0 },
        parking: {
          planned: parking.spots.length,
          drawn: 0,
          rejected: parking.rejected,
          legacyOccupancyPoints: occupancy.points,
          legacyVehiclePoints: vehicles.points,
        },
        budget: STREET_LIFE_BUDGET,
        cost: { triangles: 0, drawCalls: 0 },
        // PUBLISHED HANDLES. Both are the same live objects `state` holds, so a
        // reader that keeps the reference sees every re-plan without polling
        // the pass. See `object.userData.streetLife`.
        lens: null,
        nearAnchors: null,
      },
    };
    state.diagnostics.lens = state.lens;
    state.diagnostics.nearAnchors = state.nearAnchors;
    state.diagnostics.validity.pose = state.validity;

    // The stable handle the QA clearance guard reads.
    //
    // The capture harness has to keep the lens clear of anything that can stand
    // in it, and it can enumerate the simulated crowd because the simulation
    // publishes it. These figures belong to no simulation list, so until this
    // landed the only way to find them was to scrape instance matrices off the
    // meshes named `street-life-near*` - which misses every figure the near
    // budget spilled into the mid ring, and breaks the moment a mesh is
    // renamed. `userData.streetLife.nearAnchors` is that list, done properly:
    // every figure this pass is CURRENTLY DRAWING inside the near-ring radius,
    // near tier and mid tier alike, nearest first, in world metres.
    //
    // The array identity is stable for the life of the build; it is rewritten
    // in place on every re-plan.
    object.userData.pass = STREET_LIFE_ID;
    object.userData.streetLife = {
      id: STREET_LIFE_ID,
      version: STREET_LIFE_VERSION,
      /** [{ id, x, y, z, distance, ring, activity }], nearest first. */
      nearAnchors: state.nearAnchors,
      /** { fov, aspect, near, nearVolume, introduce } - see `streetLifeLensGuard`. */
      lens: state.lens,
      /** Radius `nearAnchors` is reported out to. */
      radius: STREET_LIFE_RINGS[0].radius,
    };

    // Grounding self-report: how far each figure's foot plane is from the
    // footway surface the street contract says is under it. Zero by
    // construction; measured anyway, because "by construction" is how a
    // floating crowd ships.
    let maxOffset = 0;
    let sumOffset = 0;
    for (const figure of figures) {
      const segment = plan.segmentById.get(figure.anchor.segmentId);
      if (!segment) continue;
      const datum = heightAt(figure.anchor.x, figure.anchor.z) + plan.options.roadLift;
      // Re-derive the lateral offset from the placed point rather than trusting
      // the value that placed it.
      const frame = streetStationAt(segment, 0);
      const along = { x: segment.points.at(-1).x - frame.x, z: segment.points.at(-1).z - frame.z };
      const len = Math.hypot(along.x, along.z) || 1;
      const nx = -along.z / len;
      const nz = along.x / len;
      const u = (figure.anchor.x - frame.x) * nx + (figure.anchor.z - frame.z) * nz;
      const expected = sidewalkSurfaceY(datum, u, segment.half, plan.options);
      const offset = Math.abs(figure.anchor.y - expected);
      if (offset > maxOffset) maxOffset = offset;
      sumOffset += offset;
    }
    state.diagnostics.grounding = {
      maxOffset,
      meanOffset: figures.length ? sumOffset / figures.length : 0,
      samples: figures.length,
    };

    // First plan against whatever view the build already knows about, so the
    // pass is never empty for a frame.
    replan(ctx, true);
    return { object, diagnostics: state.diagnostics };
  }

  /** One published record for the QA clearance guard. Plain data, no THREE. */
  function publishAnchor(figure) {
    const anchor = figure.anchor;
    return {
      id: anchor.id,
      x: anchor.x,
      y: anchor.y,
      z: anchor.z,
      distance: figure.distance,
      ring: figure.ring,
      activity: anchor.activity,
    };
  }

  /** Re-select which figures and stalls are drawn, nearest first. */
  function replan(ctx, force = false) {
    if (!state) return;
    const view = viewPosition(ctx, state.view);
    const moved = Math.hypot(view.x - state.lastView.x, view.z - state.lastView.z);
    if (!force && moved < 6 && state.replanIn > 0) return;
    state.replanIn = 0.5;
    state.lastView.x = view.x;
    state.lastView.y = view.y;
    state.lastView.z = view.z;

    const nearRing = STREET_LIFE_RINGS[0];
    const midRing = STREET_LIFE_RINGS[1];
    // Re-derived every re-plan so a FOV or aspect change is followed for free.
    const lens = streetLifeLensGuard(ctx?.camera, state.lens);
    // The clock moves between re-plans; the blob follows it.
    state.sunElevationDeg = streetLifeSunElevationDeg(ctx);
    state.shadowMaterial.opacity = CONTACT_SHADOW.baseOpacity
      * contactShadowSunTerm(state.sunElevationDeg);
    const candidates = [];
    let lensCulled = 0;
    let lensWithheld = 0;
    for (const figure of state.figures) {
      const dx = figure.anchor.x - view.x;
      const dz = figure.anchor.z - view.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > midRing.radius * midRing.radius) {
        figure.ring = null;
        figure.drawn = false;
        continue;
      }
      const distance = Math.sqrt(d2);
      figure.distance = distance;
      // 1. Hard cull: the body can reach inside the near volume, so the lens is
      //    inside the person. Never drawn, drawn or not a moment ago.
      if (distance < lens.nearVolume) {
        figure.ring = null;
        figure.drawn = false;
        lensCulled += 1;
        continue;
      }
      // 2. Introduce guard: a figure that is not already on screen is not
      //    introduced inside the distance at which it would span the whole
      //    frame. One that IS already drawn stays drawn all the way down to the
      //    hard cull, so approaching a figure never punches a hole in the crowd.
      if (distance < lens.introduce && !figure.drawn) {
        figure.ring = null;
        lensWithheld += 1;
        continue;
      }
      candidates.push(figure);
    }
    candidates.sort((a, b) => a.distance - b.distance
      || (a.anchor.id < b.anchor.id ? -1 : a.anchor.id > b.anchor.id ? 1 : 0));
    const nearList = state.active.near;
    const midList = state.active.mid;
    nearList.length = 0;
    midList.length = 0;
    for (const figure of candidates) {
      if (figure.distance <= nearRing.radius && nearList.length < nearRing.budget) {
        figure.ring = 'near';
        nearList.push(figure);
      } else if (figure.anchor.seated) {
        // The mid ring is one rigid root matrix over a figure baked standing.
        // A seated anchor drawn from it is a standing person sunk into the kerb,
        // so a seated figure simply stops existing past the articulated ring
        // rather than being drawn wrong.
        figure.ring = null;
      } else if (midList.length < midRing.budget) {
        figure.ring = 'mid';
        midList.push(figure);
      } else {
        figure.ring = null;
      }
      figure.drawn = figure.ring !== null;
    }
    state.diagnostics.figures.near = nearList.length;
    state.diagnostics.figures.mid = midList.length;
    state.diagnostics.figures.culled = state.figures.length - nearList.length - midList.length;
    state.diagnostics.figures.lensCulled = lensCulled;
    state.diagnostics.figures.lensWithheld = lensWithheld;

    // Republish the drawn near-field figures for the QA clearance guard. Both
    // rings, because a busy street spills figures well inside `nearRing.radius`
    // into the mid tier and one of those in the lens is the same artifact.
    const nearAnchors = state.nearAnchors;
    nearAnchors.length = 0;
    for (const figure of nearList) nearAnchors.push(publishAnchor(figure));
    for (const figure of midList) {
      if (figure.distance <= nearRing.radius) nearAnchors.push(publishAnchor(figure));
    }
    nearAnchors.sort((a, b) => a.distance - b.distance
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const parkingRadius2 = STREET_LIFE_BUDGET.parkingRadius * STREET_LIFE_BUDGET.parkingRadius;
    const stalls = [];
    for (const spot of state.parking) {
      const dx = spot.x - view.x;
      const dz = spot.z - view.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > parkingRadius2) continue;
      stalls.push({ spot, distance: Math.sqrt(d2) });
    }
    stalls.sort((a, b) => a.distance - b.distance
      || (a.spot.id < b.spot.id ? -1 : a.spot.id > b.spot.id ? 1 : 0));
    state.activeParking = stalls.slice(0, STREET_LIFE_BUDGET.parkedCars);
    writeParking();
    // A re-plan changed which figures exist, so every static buffer is stale.
    writeFrame(0, true);
  }

  function writeParking() {
    const { object3d, colour } = state.scratch;
    let index = 0;
    for (const stall of state.activeParking) {
      const spot = stall.spot;
      object3d.position.set(spot.x, spot.y, spot.z);
      object3d.rotation.set(0, spot.yaw, 0);
      object3d.scale.set(1, 1, 1);
      object3d.updateMatrix();
      const paint = CAR_PAINT[Math.floor(identityRandom(spot.seed, 'paint') * CAR_PAINT.length) % CAR_PAINT.length];
      for (let m = 0; m < state.carMeshes.length; m += 1) {
        const mesh = state.carMeshes[m];
        mesh.setMatrixAt(index, object3d.matrix);
        colour.setHex(m === 0 ? paint : 0x2b3238, THREE.SRGBColorSpace);
        mesh.setColorAt(index, colour);
      }
      index += 1;
    }
    for (const mesh of state.carMeshes) {
      mesh.count = index;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    state.diagnostics.parking.drawn = index;
  }

  /**
   * Write instance matrices.
   *
   * Only the near ring moves: those figures are running an activity overlay and
   * are re-posed every frame. A mid-ring figure, its contact shadow and every
   * parked car are motionless, so they are written once per re-plan and left
   * alone - which is what keeps the steady-state cost of a 160-figure street
   * proportional to the 56 figures that are actually animating.
   */
  function writeFrame(delta, statics = false) {
    if (!state) return;
    const { object3d, colour, euler, quaternion } = state.scratch;
    const poser = state.poser;
    state.time += delta;
    // One writeFrame per frame, so the ledger is per frame.
    state.validity.reset();
    state.validity.buildings = state.footprintCount > 0 ? 'own' : 'none';

    /**
     * Where this figure's two ankles are SUPPOSED to be, in world metres.
     *
     * Derived from the FOOTWAY height the anchor was grounded on plus the rest
     * pose - never from the rig's own root - so the comparison against the
     * drawn bone matrices is a comparison against the pavement, and a figure
     * whose root has drifted off it fails rather than dragging the target
     * along with it.
     */
    const ankleTargets = (anchor, variation) => {
      const grounding = state.scratch.grounding;
      const scaleY = variation.heightScale;
      const scaleXZ = scaleY * variation.buildScale;
      const cos = Math.cos(anchor.yaw);
      const sin = Math.sin(anchor.yaw);
      for (let i = 0; i < 2; i += 1) {
        const rest = REST_ANKLE[i];
        const lx = rest[0] * scaleXZ;
        const ly = rest[1] * scaleY;
        const lz = rest[2] * scaleXZ;
        const foot = grounding.feet[i];
        foot.ankleX = anchor.x + lx * cos + lz * sin;
        // From the FOOTWAY, not from the rig's own root: a figure whose root
        // has drifted is exactly what this is here to catch, and a target
        // derived from that root would drift with it and see nothing.
        foot.ankleY = anchor.y + ly;
        foot.ankleZ = anchor.z - lx * sin + lz * cos;
        foot.groundY = anchor.y;
        foot.contact = true;
      }
      return grounding;
    };

    const nearCursor = new Map();
    let shadowIndex = 0;
    const shadowCapacity = state.shadowMesh.instanceMatrix.count;

    const writeShadow = (figure) => {
      if (shadowIndex >= shadowCapacity) return;
      const blob = contactShadowFor({
        speed: 0,
        heightScale: figure.variation.heightScale,
        buildScale: figure.variation.buildScale,
        groundClearance: 0,
        distance: figure.distance,
        sunElevationDeg: state.sunElevationDeg,
      });
      const fade = clamp(blob.opacity / CONTACT_SHADOW.baseOpacity, 0, 1);
      if (fade <= 0.08) return;
      object3d.position.set(figure.anchor.x, figure.anchor.y + blob.y, figure.anchor.z);
      object3d.rotation.set(0, figure.anchor.yaw, 0);
      const diameter = blob.radius * 2 * fade * (figure.anchor.seated ? 1.25 : 1);
      object3d.scale.set(diameter, 1, diameter * blob.lengthScale);
      object3d.updateMatrix();
      state.shadowMesh.setMatrixAt(shadowIndex, object3d.matrix);
      shadowIndex += 1;
    };

    // Near ring: full articulation. The overlay is evaluated per figure and the
    // bone tree is posed once, then read out into the instanced meshes.
    for (const figure of state.active.near) {
      const anchor = figure.anchor;
      const overlay = evaluateActivityPose(anchor.activity, state.time, anchor.seed, state.overlay);
      // Mirror half the population so a street of talkers is not a street of
      // people all gesturing with the same hand.
      if (anchor.seed & 1) mirrorActivityPose(overlay);
      for (const name of PEDESTRIAN_BONE_NAMES) {
        const node = poser.byName.get(name);
        const angles = overlay && overlay[name];
        if (angles) {
          euler.set(angles[0], angles[1], angles[2], 'XYZ');
          quaternion.setFromEuler(euler);
          node.quaternion.copy(quaternion);
        } else {
          node.quaternion.identity();
        }
      }
      const scaleXZ = figure.variation.heightScale * figure.variation.buildScale;
      poser.root.position.set(anchor.x, figure.rootY, anchor.z);
      poser.root.rotation.set(0, anchor.yaw, 0);
      poser.root.scale.set(scaleXZ, figure.variation.heightScale, scaleXZ);
      poser.root.updateMatrixWorld(true);

      // ---- THE VALIDITY GATE, ON THE DRAWN FIGURE ------------------------
      // Everything below reads `matrixWorld` off the posed bone tree - the same
      // matrices that are about to be written into the instance buffers - and
      // not the anchor record that produced them. A figure that fails is not
      // written at all this frame, and the reason is counted.
      state.validity.checked += 1;
      if (clampTorsoTilt(poser).clamped) state.validity.clampedTorso += 1;
      const metrics = state.validity.observe(measureRigPose(poser, {
        // A seated figure's legs come from the overlay, so it has no standing
        // ankle target to be measured against; everything else does.
        grounding: anchor.seated ? null : ankleTargets(anchor, figure.variation),
        seated: anchor.seated,
        // ...so a seated figure is held to its ROOT instead: the pelvis is on
        // the kerb the anchor was grounded on, or the figure is not drawn.
        // Without this a seated figure was the one shape the gate could not
        // catch levitating.
        rootTargetY: anchor.y - (anchor.seated
          ? ACTIVITY_ROOT_DROP.sit * figure.variation.heightScale
          : 0),
      }));
      const rejection = poseRejection(metrics);
      if (rejection) {
        state.validity.reject(rejection);
        continue;
      }
      state.validity.drawn += 1;

      for (const item of state.near.meshes) {
        const cursor = nearCursor.get(item.key) || 0;
        if (cursor >= state.near.capacity) continue;
        const node = poser.byName.get(item.bone);
        item.mesh.setMatrixAt(cursor, node.matrixWorld);
        colour.setHex(figure.variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
        item.mesh.setColorAt(cursor, colour);
        nearCursor.set(item.key, cursor + 1);
      }
      const handFree = Boolean(CARRIED_PROP_ATTACHMENT?.attached)
        && carriedHandIsFree(anchor.activity, (anchor.seed & 1) !== 0);
      for (const item of state.nearWardrobe.meshes) {
        if (!figure.wardrobe.flags[item.flag]) continue;
        // A prop hangs from a hand bone and follows it wherever the activity
        // sends it. `phone` puts the hand at the ear and `wait` folds it across
        // the ribs, so a case drawn through those poses is a box in somebody's
        // ear or through their back. Drawn only while the hand is free.
        if (CARRIED_PROP_FLAGS.includes(item.flag) && !handFree) {
          state.validity.suppressedProps += 1;
          continue;
        }
        const cursor = nearCursor.get(item.key) || 0;
        if (cursor >= state.nearWardrobe.capacity) continue;
        const node = poser.byName.get(item.bone);
        item.mesh.setMatrixAt(cursor, node.matrixWorld);
        colour.setHex(figure.variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
        item.mesh.setColorAt(cursor, colour);
        nearCursor.set(item.key, cursor + 1);
      }
      if (statics) writeShadow(figure);
    }

    if (!statics) {
      // Near ring only: commit the animated meshes and leave every static
      // buffer exactly as the last re-plan left it.
      let animatedDraws = 0;
      let animatedTriangles = 0;
      for (const item of [...state.near.meshes, ...state.nearWardrobe.meshes]) {
        const count = nearCursor.get(item.key) || 0;
        item.mesh.count = count;
        item.mesh.instanceMatrix.needsUpdate = true;
        if (item.mesh.instanceColor) item.mesh.instanceColor.needsUpdate = true;
        if (count > 0) {
          animatedDraws += 1;
          animatedTriangles += Math.floor(item.mesh.geometry.getAttribute('position').count / 3) * count;
        }
      }
      state.diagnostics.cost.animatedDrawCalls = animatedDraws;
      state.diagnostics.cost.animatedTriangles = animatedTriangles;
      return;
    }

    // Mid ring: one root matrix per figure, no articulation. A seated figure
    // keeps its root drop so it does not stand up when it crosses the boundary.
    let midIndex = 0;
    const midWardrobeCursor = new Map();
    for (const figure of state.active.mid) {
      if (midIndex >= state.mid.capacity) break;
      const anchor = figure.anchor;
      const scaleXZ = figure.variation.heightScale * figure.variation.buildScale;
      // The mid geometry is baked in CHARACTER space - soles at y = 0 - so the
      // root matrix puts the FEET on the footway, not the pelvis.
      object3d.position.set(
        anchor.x,
        anchor.y - (anchor.seated ? ACTIVITY_ROOT_DROP.sit * figure.variation.heightScale : 0),
        anchor.z,
      );
      object3d.rotation.set(0, anchor.yaw, 0);
      object3d.scale.set(scaleXZ, figure.variation.heightScale, scaleXZ);
      object3d.updateMatrix();
      for (const item of state.mid.meshes) {
        item.mesh.setMatrixAt(midIndex, object3d.matrix);
        colour.setHex(figure.variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
        item.mesh.setColorAt(midIndex, colour);
      }
      for (const item of state.midWardrobe.meshes) {
        if (!figure.wardrobe.flags[item.flag]) continue;
        const cursor = midWardrobeCursor.get(item.key) || 0;
        if (cursor >= state.midWardrobe.capacity) continue;
        item.mesh.setMatrixAt(cursor, object3d.matrix);
        colour.setHex(figure.variation.colors[item.group] ?? 0xffffff, THREE.SRGBColorSpace);
        item.mesh.setColorAt(cursor, colour);
        midWardrobeCursor.set(item.key, cursor + 1);
      }
      midIndex += 1;
      writeShadow(figure);
    }

    let drawCalls = 0;
    let triangles = 0;
    const commit = (item, count) => {
      item.mesh.count = count;
      item.mesh.instanceMatrix.needsUpdate = true;
      if (item.mesh.instanceColor) item.mesh.instanceColor.needsUpdate = true;
      if (count > 0) {
        drawCalls += 1;
        const position = item.mesh.geometry.getAttribute('position');
        triangles += Math.floor(position.count / 3) * count;
      }
    };
    for (const item of state.near.meshes) commit(item, nearCursor.get(item.key) || 0);
    for (const item of state.nearWardrobe.meshes) commit(item, nearCursor.get(item.key) || 0);
    for (const item of state.mid.meshes) commit(item, midIndex);
    for (const item of state.midWardrobe.meshes) commit(item, midWardrobeCursor.get(item.key) || 0);
    state.shadowMesh.count = shadowIndex;
    state.shadowMesh.instanceMatrix.needsUpdate = true;
    if (shadowIndex > 0) drawCalls += 1;
    for (const mesh of state.carMeshes) {
      if (mesh.count > 0) {
        drawCalls += 1;
        triangles += Math.floor(mesh.geometry.getAttribute('position').count / 3) * mesh.count;
      }
    }
    state.diagnostics.cost = { triangles, drawCalls };
  }

  return {
    id: STREET_LIFE_ID,
    order: 50,
    build(ctx) {
      try {
        return build(ctx);
      } catch (error) {
        dispose();
        return {
          object: null,
          diagnostics: {
            version: STREET_LIFE_VERSION,
            implemented: true,
            failure: String(error?.message || error),
          },
        };
      }
    },
    update(ctx, delta) {
      if (!state) return;
      const step = Number.isFinite(delta) ? clamp(delta, 0, 0.25) : 0;
      state.replanIn -= step;
      const before = state.replanIn;
      replan(ctx, false);
      // `replan` already rewrote everything when it fired; otherwise animate
      // the near ring only.
      if (state.replanIn === before) writeFrame(step, false);
    },
    dispose,
    /**
     * Every figure this pass is currently drawing inside the near-ring radius,
     * nearest first, in world metres. The QA camera-clearance guard unions this
     * with the simulated crowd; nothing else should mutate it.
     */
    nearAnchors: () => (state ? state.nearAnchors : []),
    /** The lens radii in force at the last re-plan. */
    lens: () => (state ? state.lens : streetLifeLensGuard(null)),
    /** Test seam: the live state, for the headless verifier. */
    _state: () => state,
  };
}

export default createStreetLife();
