/**
 * Pooled pedestrian crowd for the San Francisco district.
 *
 * The crowd is intentionally authored from a small set of reusable meshes so
 * it can stay dense in WebGL2 without turning every person into a full GLTF
 * rig. Each actor still has a distinct silhouette, palette, occupation prop,
 * gait phase, and behavior state.
 */

import * as THREE from 'three';
import { signalOffsetForPosition, signalPhaseAt } from './signals.js';
import { createBlackboard, tick as tickBehaviorTree } from './npc-behavior-tree.js';
import { createTreeForRole } from './npc-trees.js';

const POOL_SIZE = 48;
const MAX_PERSISTED_COMBAT_DEFEATS = 8;
const VEHICLE_IMPACT_DEFEAT_COUNT = 2;
const SFPD_OFFICER_POOL_SIZE = 3;
const SFPD_OFFICER_SPEED = 3.25;
const SFPD_OFFICER_STANDOFF = [11.5, 13, 14.5];
const SFPD_OFFICER_TRACER_SECONDS = 0.18;
// Eight camera-facing actors carry the costly face/clothing treatment; the
// remainder preserve a readable, varied background crowd inside the 48-person
// fixed pool. This keeps the hero pass bounded on Cinema quality.
const HERO_ACTORS = 8;
// These identities intentionally track the fixed hero pool rather than a
// random role draw. The labels are synthetic UI handles, not claims about
// canonical resident backstories.
const FEATURED_RESIDENTS = Object.freeze([
  Object.freeze({ actorIndex: 0, id: 'maria-chen', label: 'Maria Chen' }),
  Object.freeze({ actorIndex: 1, id: 'james-orourke', label: "James O'Rourke" }),
  Object.freeze({ actorIndex: 2, id: 'diana-ruiz', label: 'Diana Ruiz' }),
  Object.freeze({ actorIndex: 3, id: 'noah-kim', label: 'Noah Kim' }),
  Object.freeze({ actorIndex: 4, id: 'priya-shah', label: 'Priya Shah' }),
  Object.freeze({ actorIndex: 5, id: 'elena-park', label: 'Elena Park' }),
  Object.freeze({ actorIndex: 6, id: 'theo-nguyen', label: 'Theo Nguyen' }),
  Object.freeze({ actorIndex: 7, id: 'grace-okonkwo', label: 'Grace Okonkwo' }),
]);
const WALK_SPEED = 1.12;
const WALK_SPEED_VARIANCE = 0.38;
// Reference step length for coupling stride phase to ~1.1 m/s adult walk.
const ADULT_STEP_LENGTH = 0.68;
const GAIT_START_DAMP = 10.2;
const GAIT_STOP_DAMP = 5.4;
const MAX_DT = 0.05;
const VEHICLE_WITNESS_FLEE_SPEED = 2.45;
const VEHICLE_WITNESS_MAX_TRAVEL = 4.4;
// Shared contact envelope for the inline crowd animator. It is intentionally
// small so the fixed pool stays grounded without a per-actor IK pass.
const CONTACT_PELVIS_DROP = 0.008;
const CONTACT_PELVIS_ROLL = 0.035;
const CONTACT_KNEE_BEND = 0.045;
const CONTACT_TOE_ROLL = 0.06;

const STATE_WALK = 0;
const STATE_IDLE = 1;
const STATE_WORK = 2;
const STATE_CROSS = 3;

// Map the traffic signal phase onto the legal pedestrian window: walk while
// the parallel movement is green, a flashing "don't start" during yellow, and
// a short countdown clearance where pedestrians already in the roadway finish.
const CROSS_MIN_GREEN = 2.8;
const CROSS_CLEARANCE = 3.4;
const PERSONAL_SPACE = 1.05;
const SEPARATION_FORCE = 2.6;
const LATERAL_DRIFT = 1.35;
const CROWD_CELL_SIZE = PERSONAL_SPACE;
const CROWD_CELL_STRIDE = 4096;
const MAX_PATH_ATTACH_DISTANCE = 2.2;
const ON_FOOT_PLAYER_RADIUS = 0.72;
const ON_FOOT_PEDESTRIAN_RADIUS = 0.46;
const ON_FOOT_CONTACT_MARGIN = 0.025;
const ON_FOOT_CONTACT_REARM_GAP = 0.18;
const ON_FOOT_PLAYER_YIELD_SHIFT = 0.28;

const SKIN = [0xd5aa86, 0xc4926c, 0xb77d5b, 0x9d6549, 0x80502f, 0xe0ba94, 0x6d402b];
const HAIR = [0x171719, 0x2b201d, 0x4e3324, 0x704b2e, 0x9a6d3d, 0x7d7d76, 0xc2a274];
// The saturated accents are intentionally used sparingly. They give a moving
// crowd a readable rhythm of jackets and rain shells without turning every
// actor into a billboard.
const TOPS = [
  0x203a58, 0x2d3438, 0x59433a, 0x315c4c, 0x8d3f32, 0x5b4d74, 0x7a6b55, 0xc4b59d,
  0x2f6f88, 0x8b4056, 0xb46b3f, 0x405b72,
];
const BOTTOMS = [0x1c2530, 0x2f3033, 0x354a57, 0x42372f, 0x4d4d4b, 0x626052, 0x293b47];
const SHOES = [0x17191a, 0x2b211c, 0x393b3a, 0x6b4a33, 0x4a3a35];
const HERO_TOPS = [0x243b53, 0x425a4a, 0x70443c, 0x51465f, 0x9b8068, 0x29333b, 0x2f6f88, 0x8b4056];
const HERO_BOTTOMS = [0x1c2731, 0x303437, 0x394954, 0x443b35, 0x595852, 0x626052];
const SHIRT_ACCENTS = [0xd9d4c8, 0xb8cad0, 0xd4b5a5, 0xb8c2a4, 0xd6c7a4, 0xe1b06a];
const SCARF_COLORS = [0x8d3f32, 0x2f6f88, 0xb46b3f, 0x59636c, 0x6f5b75];
const HAT_COLORS = [0x25333a, 0x4d3a32, 0x8a4b3c, 0x59664f, 0xb17746];
const SHOE_ACCENTS = [0xbbb9ae, 0xd0a26d, 0x6d8b94, 0x4c5e4b];
const BAG_COLORS = [0x302b28, 0x474944, 0x384653, 0x6e5140, 0x3a2c47];
const HERO_MATERIAL_ATLAS_URL = new URL(
  '../assets/pedestrians/sf-hero-material-atlas-v1.png',
  import.meta.url,
).href;

// The generated source sheet intentionally leaves pale gutters between its
// material fields. These safe interior bounds keep linear filtering and
// mipmaps from exposing a neighboring field at a UV seam.
const HERO_ATLAS_TILES = Object.freeze({
  skin: {
    id: 'skin', x: 0.018, y: 0.36, width: 0.31, height: 0.62,
    repeatU: 2, repeatV: 1, referenceLuma: 0.26, strength: 0.24,
  },
  hair: {
    id: 'hair', x: 0.348, y: 0.36, width: 0.31, height: 0.62,
    repeatU: 2, repeatV: 1, referenceLuma: 0.014, strength: 0.22,
  },
  jacket: {
    id: 'jacket', x: 0.678, y: 0.36, width: 0.31, height: 0.62,
    repeatU: 2, repeatV: 2, referenceLuma: 0.095, strength: 0.3,
  },
  denim: {
    id: 'denim', x: 0.018, y: 0.02, width: 0.31, height: 0.31,
    repeatU: 2, repeatV: 2, referenceLuma: 0.052, strength: 0.28,
  },
  shoe: {
    id: 'shoe', x: 0.348, y: 0.02, width: 0.31, height: 0.31,
    repeatU: 2, repeatV: 1, referenceLuma: 0.024, strength: 0.18,
  },
  cotton: {
    id: 'cotton', x: 0.678, y: 0.02, width: 0.31, height: 0.31,
    repeatU: 2, repeatV: 2, referenceLuma: 0.24, strength: 0.2,
  },
});

let sharedHeroMaterialAtlas = null;

const JOBS = [
  { id: 'commuter', weight: 42, prop: null },
  { id: 'courier', weight: 13, prop: 'parcel' },
  { id: 'barista', weight: 11, prop: 'coffee' },
  { id: 'worker', weight: 10, prop: 'worker' },
  { id: 'tourist', weight: 11, prop: 'camera' },
  { id: 'cleaner', weight: 7, prop: 'broom' },
  { id: 'phone', weight: 6, prop: 'phone' },
];
const HERO_JOB_IDS = [
  'cleaner', 'tourist', 'courier', 'phone', 'barista', 'worker',
  'commuter', 'courier', 'commuter', 'tourist', 'barista', 'commuter',
];
const JOB_SPEED_FACTOR = Object.freeze({
  commuter: 1.08,
  courier: 1.18,
  barista: 0.94,
  worker: 0.9,
  tourist: 0.82,
  cleaner: 0.98,
  phone: 0.88,
});

// A role is more than a mesh and a prop: it gives the actor a reason to be
// on this block, a likely stop duration, and a different willingness to wait
// for the signal. These small ranges are intentionally broad so the fixed
// pool does not fall into a visible metronome.
const ROLE_SCHEDULES = Object.freeze({
  commuter: Object.freeze({
    destination: 'office', walk: [7, 16], idle: [0.8, 2.2], work: [2.2, 4.2],
    workChance: 0.04, idleChance: 0.18, crossingChance: 0.34,
  }),
  courier: Object.freeze({
    destination: 'delivery stop', walk: [8, 18], idle: [0.6, 1.8], work: [2.4, 5.2],
    workChance: 0.62, idleChance: 0.08, crossingChance: 0.3,
  }),
  barista: Object.freeze({
    destination: 'coffee counter', walk: [4, 10], idle: [1.1, 3.2], work: [4.5, 9.5],
    workChance: 0.72, idleChance: 0.16, crossingChance: 0.2,
  }),
  worker: Object.freeze({
    destination: 'job site', walk: [5, 12], idle: [1.4, 3.8], work: [6, 13],
    workChance: 0.76, idleChance: 0.12, crossingChance: 0.13,
  }),
  tourist: Object.freeze({
    destination: 'viewpoint', walk: [5, 12], idle: [2.4, 5.8], work: [3.4, 7.2],
    workChance: 0.7, idleChance: 0.3, crossingChance: 0.39,
  }),
  cleaner: Object.freeze({
    destination: 'cleanup zone', walk: [3, 9], idle: [1.2, 3.5], work: [5, 12],
    workChance: 0.78, idleChance: 0.14, crossingChance: 0.17,
  }),
  phone: Object.freeze({
    destination: 'phone pause', walk: [4, 9], idle: [1.2, 3.4], work: [3.2, 8],
    workChance: 0.68, idleChance: 0.23, crossingChance: 0.2,
  }),
});

// Visual variation is seeded separately from the behavior RNG. A role can
// therefore keep the same route, signal decisions, and weather response while
// its clothing and gait remain stable across every rebuild of the pooled
// crowd. The profiles stay deliberately small: one shared mesh per visible
// accessory is enough to make a silhouette legible at street distance.
const ROLE_VISUAL_SEEDS = Object.freeze({
  commuter: 0x11a2d3e1,
  courier: 0x2c74b9a7,
  barista: 0x49ce188d,
  worker: 0x5e8134b2,
  tourist: 0x6b24f0c9,
  cleaner: 0x7c3d91e5,
  phone: 0x8f42a6b3,
});
const SILHOUETTE_VARIANTS = Object.freeze([
  Object.freeze({ id: 'lean', width: 0.96, depth: 0.98 }),
  Object.freeze({ id: 'layered', width: 1.04, depth: 1.06 }),
  Object.freeze({ id: 'relaxed', width: 1.08, depth: 0.94 }),
  Object.freeze({ id: 'tailored', width: 0.99, depth: 1.04 }),
]);
const ROLE_VISUAL_PROFILES = Object.freeze({
  commuter: Object.freeze({
    silhouettes: [0, 1, 2, 3], hairStyles: [0, 1, 2], headwearStyles: [0, 1, 2],
    scarfChance: 0.28, outerwearChance: 0.52, bagStyles: ['backpack', 'messenger', 'none'],
    gaitStyles: ['steady', 'brisk', 'light'],
  }),
  courier: Object.freeze({
    silhouettes: [0, 1, 3], hairStyles: [0, 1, 2], headwearStyles: [0, 2],
    scarfChance: 0.14, outerwearChance: 0.58, bagStyles: ['messenger'],
    gaitStyles: ['brisk', 'purposeful'],
  }),
  barista: Object.freeze({
    silhouettes: [1, 2, 3], hairStyles: [0, 1, 2], headwearStyles: [0, 1, 2],
    scarfChance: 0.08, outerwearChance: 0.24, bagStyles: ['tote', 'none'],
    gaitStyles: ['balanced', 'easy'], wardrobe: 'apron',
  }),
  worker: Object.freeze({
    silhouettes: [1, 3], hairStyles: [0, 1], headwearStyles: [0],
    scarfChance: 0, outerwearChance: 0.12, bagStyles: ['none'],
    gaitStyles: ['purposeful', 'brisk'], wardrobe: 'hi-vis',
  }),
  tourist: Object.freeze({
    silhouettes: [0, 2, 3], hairStyles: [0, 1, 2], headwearStyles: [0, 1, 2],
    scarfChance: 0.24, outerwearChance: 0.34, bagStyles: ['tote', 'none'],
    gaitStyles: ['sightseeing', 'easy'],
  }),
  cleaner: Object.freeze({
    silhouettes: [1, 2, 3], hairStyles: [0, 1, 2], headwearStyles: [0, 1],
    scarfChance: 0.1, outerwearChance: 0.48, bagStyles: ['none'],
    gaitStyles: ['careful', 'purposeful'], wardrobe: 'utility',
  }),
  phone: Object.freeze({
    silhouettes: [0, 1, 2, 3], hairStyles: [0, 1, 2], headwearStyles: [0, 1, 2],
    scarfChance: 0.2, outerwearChance: 0.3, bagStyles: ['messenger', 'none'],
    gaitStyles: ['distracted', 'easy'],
  }),
});
const GAIT_VISUAL_CUES = Object.freeze({
  steady: Object.freeze({ stride: 1, arm: 1, lean: 0.008, bob: 1 }),
  brisk: Object.freeze({ stride: 1.08, arm: 1.08, lean: 0.028, bob: 1.12 }),
  light: Object.freeze({ stride: 1.03, arm: 0.9, lean: -0.004, bob: 0.82 }),
  purposeful: Object.freeze({ stride: 1.05, arm: 1.04, lean: 0.022, bob: 1.06 }),
  balanced: Object.freeze({ stride: 0.96, arm: 0.86, lean: 0, bob: 0.9 }),
  easy: Object.freeze({ stride: 0.92, arm: 0.82, lean: -0.006, bob: 0.78 }),
  sightseeing: Object.freeze({ stride: 0.86, arm: 0.72, lean: -0.01, bob: 0.72 }),
  careful: Object.freeze({ stride: 0.9, arm: 0.76, lean: 0.018, bob: 0.86 }),
  distracted: Object.freeze({ stride: 0.94, arm: 0.68, lean: 0.012, bob: 0.84 }),
});
const WEATHER_MODES = new Set(['clear', 'fog', 'drizzle']);
const HERO_ROUTE_SAMPLES = [
  { segment: 1, ratio: 0.22 },
  { segment: 1, ratio: 0.48 },
  { segment: 1, ratio: 0.72 },
  { segment: 2, ratio: 0.28 },
  { segment: 2, ratio: 0.56 },
  { segment: 2, ratio: 0.84 },
];
const RIGHT_SIDE_DEPTH_OFFSETS = [-0.1, 0.11, -0.09, 0.1, -0.12, 0.05];
// Keep beauty-route heroes in the sidewalk center band — negative spread pulled
// camera-facing actors into facades during QA and street-distance review.
const HERO_LANE_OFFSETS = [0.04, 0.02, 0.06, 0.04];
// Waterfront avenues place building mass on -X; bias pulls heroes toward +X curb.
const BEAUTY_STREET_BIAS = 0.48;
// Beauty routes clamp toward street-side only so reversed headings never hug facades.
const BEAUTY_LANE_CLAMP = Object.freeze({ min: 0.18, max: 0.52 });
// Keep the background crowd in two readable sidewalk lanes. The role bias is
// deliberately subtle: it gives a courier or café worker a habitual path
// through a block without turning navigation into a role-specific graph.
const ROLE_SIDEWALK_LANES = Object.freeze({
  // Keep all roles street-side of sidewalk center so facade clipping stays rare.
  commuter: 0.36,
  courier: 0.48,
  barista: 0.40,
  worker: 0.44,
  tourist: 0.42,
  cleaner: 0.34,
  phone: 0.42,
});

// Morning-rush role colors are deliberately a little quieter than UI colors:
// they read as a jacket patch, apron trim, or carried object in the street
// view, while keeping the low-poly crowd from becoming a row of billboards.
// The same material is reused by every actor in a role so the identity cue is
// stable across rebuilds and route handoffs.
const ROLE_ACCENT_COLORS = Object.freeze({
  commuter: 0x5b8192,
  courier: 0x2e8790,
  barista: 0xb17a43,
  worker: 0xe7832d,
  tourist: 0xb76578,
  cleaner: 0x639b8b,
  phone: 0x7b6ca8,
});

// The streamed crowd deliberately reuses the authored crowd's compact
// procedural palette without importing its hero atlas, skeletons, or
// behavior graph. Returned arrays are copies so weather tinting in the
// instanced presentation cannot mutate the core material library.
export function getStreamedPedestrianVisualProfile() {
  return {
    skinColors: [...SKIN],
    topColors: [...TOPS],
    bottomColors: [...BOTTOMS],
    shoeColors: [...SHOES],
  };
}

/**
 * Three small, persistent SFPD rigs paired one-to-one with live traffic
 * responders. The actors are transient pursuit presentation: they never enter
 * resident identity, witness, favor, impact, or persistence ledgers.
 */
export function createSfpdOfficerResponse({
  scene,
  getNearestWorldBlocker,
  getSurfaceHeight,
} = {}) {
  if (!scene?.isScene) {
    throw new TypeError('createSfpdOfficerResponse requires a THREE.Scene.');
  }

  const group = new THREE.Group();
  group.name = 'SFPD on-foot response';
  scene.add(group);
  const officers = [];
  const origin = new THREE.Vector3();
  const destination = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const playerHead = new THREE.Vector3();
  const muzzlePoint = new THREE.Vector3();
  const aimQuaternion = new THREE.Quaternion();
  const forwardAxis = new THREE.Vector3(0, 0, 1);
  const officerBounds = new THREE.Box3();
  const events = {
    aims: 0,
    shots: 0,
    damage: [],
    officerFires: [],
    bookings: 0,
  };
  let blockerCycles = 0;
  let blockedCycleElapsed = 0;
  let lastBlocked = null;
  let lastLevel = 0;

  function material(color, options = {}) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: options.roughness ?? 0.72,
      metalness: options.metalness ?? 0.04,
      emissive: options.emissive ?? 0x000000,
      emissiveIntensity: options.emissiveIntensity ?? 0,
      transparent: options.transparent ?? false,
      opacity: options.opacity ?? 1,
      depthWrite: options.depthWrite ?? true,
    });
  }

  function addPart(parent, geometry, partMaterial, position, name) {
    const mesh = new THREE.Mesh(geometry, partMaterial);
    mesh.name = name;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function makeOfficer(slot) {
    const root = new THREE.Group();
    root.name = `SFPD officer ${slot + 1}`;
    root.visible = false;
    root.userData.sfpdOfficer = true;
    root.userData.combatDisabled = false;
    root.userData.combatDefeated = false;
    const navy = material(slot === 1 ? 0x172d48 : 0x122640);
    const darkNavy = material(0x091522);
    const skin = material([0xbd805b, 0xd1a07c, 0x8d5c42][slot]);
    const metal = material(0xc8d2d8, { roughness: 0.3, metalness: 0.72 });
    const weaponMaterial = material(0x15191d, { roughness: 0.34, metalness: 0.52 });
    const telegraphMaterial = new THREE.LineBasicMaterial({
      color: 0xff5d4d,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const tracerMaterial = new THREE.LineBasicMaterial({
      color: 0xffc05a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const torso = addPart(root, new THREE.BoxGeometry(0.62, 0.72, 0.34), navy, [0, 1.14, 0], 'SFPD uniform torso');
    const belt = addPart(root, new THREE.BoxGeometry(0.68, 0.11, 0.39), darkNavy, [0, 0.79, 0], 'SFPD duty belt');
    const badge = addPart(root, new THREE.OctahedronGeometry(0.075, 0), metal, [-0.18, 1.31, 0.185], 'SFPD badge');
    const head = addPart(root, new THREE.SphereGeometry(0.22, 8, 6), skin, [0, 1.73, 0], 'SFPD officer head');
    const cap = addPart(root, new THREE.CylinderGeometry(0.22, 0.24, 0.1, 8), darkNavy, [0, 1.94, 0], 'SFPD patrol cap');
    const capBill = addPart(root, new THREE.BoxGeometry(0.28, 0.035, 0.2), darkNavy, [0, 1.91, 0.16], 'SFPD cap bill');
    const leftLeg = addPart(root, new THREE.BoxGeometry(0.23, 0.72, 0.25), navy, [-0.17, 0.36, 0], 'SFPD left leg');
    const rightLeg = addPart(root, new THREE.BoxGeometry(0.23, 0.72, 0.25), navy, [0.17, 0.36, 0], 'SFPD right leg');
    const leftArm = addPart(root, new THREE.BoxGeometry(0.18, 0.62, 0.2), navy, [-0.38, 1.13, 0.02], 'SFPD support arm');
    const rightArm = addPart(root, new THREE.BoxGeometry(0.18, 0.62, 0.2), navy, [0.38, 1.13, 0.02], 'SFPD weapon arm');
    const weapon = addPart(root, new THREE.BoxGeometry(0.14, 0.16, 0.48), weaponMaterial, [0.17, 1.34, 0.38], 'SFPD visible sidearm');
    weapon.rotation.x = -0.08;

    const telegraphGeometry = new THREE.BufferGeometry();
    telegraphGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const telegraph = new THREE.Line(telegraphGeometry, telegraphMaterial);
    telegraph.name = 'SFPD aim telegraph';
    telegraph.visible = false;
    telegraph.frustumCulled = false;
    scene.add(telegraph);

    const tracerGeometry = new THREE.BufferGeometry();
    tracerGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const tracer = new THREE.Line(tracerGeometry, tracerMaterial);
    tracer.name = 'SFPD pressure tracer';
    tracer.visible = false;
    tracer.frustumCulled = false;
    scene.add(tracer);

    group.add(root);
    const officer = {
      slot,
      id: null,
      responderId: null,
      root,
      torso,
      belt,
      badge,
      head,
      cap,
      capBill,
      leftLeg,
      rightLeg,
      leftArm,
      rightArm,
      weapon,
      telegraph,
      telegraphMaterial,
      tracer,
      tracerMaterial,
      tracerLife: 0,
      state: 'cleared',
      grounded: true,
      hasLineOfSight: false,
      blocker: null,
      distance: null,
      phase: slot * 1.7,
      deployState: 'cleared',
      deployElapsed: 0,
      deployStart: new THREE.Vector3(),
      deployEnd: new THREE.Vector3(),
      parentVehicleSpeed: null,
      parentVehicleDistance: null,
      parentVehicleHoldRequested: false,
      parentVehicleHolding: false,
      exitClearance: 0,
      bodyVehicleOverlap: false,
      groundResidual: 0,
      surfaceY: null,
      footY: null,
      targetable: false,
      aimStartedAt: null,
      holdPosition: false,
      materials: [navy, darkNavy, skin, metal, weaponMaterial, telegraphMaterial, tracerMaterial],
    };
    officers.push(officer);
    return officer;
  }

  for (let index = 0; index < SFPD_OFFICER_POOL_SIZE; index += 1) makeOfficer(index);

  function setLine(line, start, end) {
    const attribute = line.geometry.getAttribute('position');
    attribute.setXYZ(0, start.x, start.y, start.z);
    attribute.setXYZ(1, end.x, end.y, end.z);
    attribute.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  function deactivate(officer, { resetDefeat = false } = {}) {
    officer.root.visible = false;
    officer.telegraph.visible = false;
    officer.telegraphMaterial.opacity = 0;
    officer.tracer.visible = false;
    officer.tracerMaterial.opacity = 0;
    officer.tracerLife = 0;
    officer.state = 'cleared';
    officer.hasLineOfSight = false;
    officer.blocker = null;
    officer.distance = null;
    officer.deployState = 'cleared';
    officer.deployElapsed = 0;
    officer.parentVehicleSpeed = null;
    officer.parentVehicleDistance = null;
    officer.parentVehicleHoldRequested = false;
    officer.parentVehicleHolding = false;
    officer.exitClearance = 0;
    officer.bodyVehicleOverlap = false;
    officer.groundResidual = 0;
    officer.surfaceY = null;
    officer.footY = null;
    officer.targetable = false;
    officer.aimStartedAt = null;
    officer.holdPosition = false;
    officer.id = null;
    officer.responderId = null;
    delete officer.root.userData.sfpdOfficerId;
    delete officer.root.userData.sfpdResponderId;
    if (resetDefeat) {
      officer.root.rotation.z = 0;
      officer.root.userData.combatDisabled = false;
      officer.root.userData.combatDefeated = false;
      officer.root.userData.combatReaction = 'settled';
      officer.root.userData.combatReactionUntil = 0;
    }
  }

  function clear({ resetDefeats = true } = {}) {
    officers.forEach((officer) => deactivate(officer, { resetDefeat: resetDefeats }));
    lastLevel = 0;
    lastBlocked = null;
  }

  function updateLos(officer, playerPosition) {
    muzzlePoint.copy(officer.root.position);
    muzzlePoint.y += 1.36;
    playerHead.set(playerPosition.x, (Number(playerPosition.y) || 0) + 1.34, playerPosition.z);
    direction.subVectors(playerHead, muzzlePoint);
    const targetDistance = direction.length();
    if (targetDistance <= 0.01) {
      officer.hasLineOfSight = true;
      officer.blocker = null;
      return;
    }
    direction.multiplyScalar(1 / targetDistance);
    const blocker = getNearestWorldBlocker?.(muzzlePoint, direction, targetDistance - 0.08) ?? null;
    officer.blocker = blocker && Number.isFinite(blocker.distance) ? blocker : null;
    officer.hasLineOfSight = !officer.blocker;
  }

  function groundOfficer(officer, fallbackY = 0) {
    const sampled = getSurfaceHeight?.({
      x: officer.root.position.x,
      z: officer.root.position.z,
    });
    const surfaceY = Number.isFinite(sampled) ? sampled : Number(fallbackY) || 0;
    officer.root.position.y = surfaceY;
    officer.root.updateWorldMatrix(true, true);
    officerBounds.setFromObject(officer.root, true);
    if (Number.isFinite(officerBounds.min.y)) {
      officer.root.position.y += surfaceY - officerBounds.min.y;
      officer.root.updateWorldMatrix(true, true);
      officerBounds.setFromObject(officer.root, true);
    }
    officer.footY = Number.isFinite(officerBounds.min.y) ? officerBounds.min.y : surfaceY;
    officer.groundResidual = Math.abs(officer.footY - surfaceY);
    officer.grounded = officer.groundResidual <= 0.03;
    officer.surfaceY = surfaceY;
  }

  function update(dt = 0, elapsed = 0, {
    active = false,
    level = 0,
    responders = [],
    playerPosition = null,
    outdoor = true,
    pressure = null,
  } = {}) {
    const delta = THREE.MathUtils.clamp(Number(dt) || 0, 0, 0.1);
    const desired = active && outdoor && playerPosition && level >= 2
      ? Math.min(SFPD_OFFICER_POOL_SIZE, Math.floor(level), responders.length)
      : 0;
    let anyBlocked = false;
    for (let index = 0; index < officers.length; index += 1) {
      const officer = officers[index];
      const responder = responders[index];
      if (index >= desired || !responder?.active || !responder.position) {
        deactivate(officer);
        continue;
      }
      const nextId = `sfpd-officer-${responder.id}`;
      const newlyAssigned = officer.id !== nextId;
      officer.id = nextId;
      officer.responderId = responder.id;
      officer.root.name = `SFPD officer ${nextId}`;
      officer.root.userData.sfpdOfficerId = nextId;
      officer.root.userData.sfpdResponderId = responder.id;
      officer.parentVehicleSpeed = Math.max(0, Number(responder.speed) || 0);
      officer.parentVehicleHoldRequested = responder.deploymentHold?.requested === true;
      officer.parentVehicleHolding = responder.deploymentHold?.holding === true;
      officer.holdPosition = responder.qaHoldPosition === true;
      officer.parentVehicleDistance = Number.isFinite(responder.distance)
        ? responder.distance
        : Math.hypot(
          responder.position.x - playerPosition.x,
          responder.position.z - playerPosition.z,
        );
      if (newlyAssigned) {
        const heading = Number(responder.heading) || 0;
        const curbSide = responder.dir === -1 ? -1 : 1;
        const groundY = Number(responder.position.y) || Number(playerPosition.y) || 0;
        officer.deployStart.set(
          responder.position.x + Math.cos(heading) * 0.72 * curbSide,
          groundY,
          responder.position.z - Math.sin(heading) * 0.72 * curbSide,
        );
        officer.deployEnd.set(
          responder.position.x + Math.cos(heading) * 1.72 * curbSide,
          groundY,
          responder.position.z - Math.sin(heading) * 1.72 * curbSide,
        );
        officer.root.position.copy(officer.deployStart);
        officer.deployState = 'waiting-for-stop';
        officer.deployElapsed = 0;
        officer.root.visible = false;
        officer.targetable = false;
        officer.root.rotation.z = 0;
        officer.root.userData.combatDisabled = false;
        officer.root.userData.combatDefeated = false;
      }
      if (officer.deployState === 'waiting-for-stop') {
        officer.root.visible = false;
        officer.targetable = false;
        if (officer.parentVehicleSpeed <= 2) {
          officer.deployState = 'exiting';
          officer.deployElapsed = 0;
          officer.root.visible = true;
        } else {
          continue;
        }
      }
      if (officer.deployState === 'exiting') {
        officer.deployElapsed += delta;
        const exitProgress = THREE.MathUtils.smoothstep(
          THREE.MathUtils.clamp(officer.deployElapsed / 0.5, 0, 1),
          0,
          1,
        );
        officer.root.position.lerpVectors(officer.deployStart, officer.deployEnd, exitProgress);
        officer.exitClearance = officer.root.position.distanceTo(officer.deployStart);
        officer.bodyVehicleOverlap = officer.exitClearance < 0.34;
        officer.targetable = exitProgress >= 0.55;
        officer.state = 'exiting';
        groundOfficer(officer, playerPosition.y);
        if (exitProgress < 1) continue;
        officer.deployState = 'deployed';
        officer.bodyVehicleOverlap = false;
        officer.targetable = true;
      }
      const downed = officer.root.userData.combatDisabled === true
        || officer.root.userData.combatDefeated === true;
      officer.distance = Math.hypot(
        playerPosition.x - officer.root.position.x,
        playerPosition.z - officer.root.position.z,
      );
      if (downed) {
        officer.state = 'downed';
        officer.hasLineOfSight = false;
        officer.telegraph.visible = false;
        officer.telegraphMaterial.opacity = 0;
        officer.root.rotation.z = THREE.MathUtils.damp(officer.root.rotation.z, -1.12, 8, delta);
        groundOfficer(officer, playerPosition.y);
      } else {
        const meleeReaction = officer.root.userData.combatReactionSource === 'melee'
          && officer.root.userData.combatReaction === 'hit-react';
        if (meleeReaction && officer.root.userData.meleeRecoilPending === true) {
          const recoilX = Number(officer.root.userData.meleeRecoilDirectionX) || 0;
          const recoilZ = Number(officer.root.userData.meleeRecoilDirectionZ) || 0;
          const length = Math.hypot(recoilX, recoilZ) || 1;
          const applied = Math.max(0, Number(officer.root.userData.meleeRecoilApplied) || 0);
          const next = Math.min(0.34, applied + delta * 1.15);
          officer.root.position.x += recoilX / length * (next - applied);
          officer.root.position.z += recoilZ / length * (next - applied);
          officer.root.userData.meleeRecoilApplied = next;
          if (next >= 0.34 - 1e-5) officer.root.userData.meleeRecoilPending = false;
        }
        const standoff = SFPD_OFFICER_STANDOFF[index];
        direction.set(
          playerPosition.x - officer.root.position.x,
          0,
          playerPosition.z - officer.root.position.z,
        );
        const planarDistance = direction.length();
        if (planarDistance > 0.001) direction.multiplyScalar(1 / planarDistance);
        if (meleeReaction) {
          officer.state = 'staggered';
        } else if (officer.holdPosition) {
          officer.state = 'holding';
        } else if (planarDistance > standoff + 0.8) {
          officer.root.position.addScaledVector(direction, Math.min(planarDistance - standoff, SFPD_OFFICER_SPEED * delta));
          officer.state = 'advancing';
        } else if (planarDistance < standoff - 1.8) {
          officer.root.position.addScaledVector(direction, -Math.min(standoff - planarDistance, SFPD_OFFICER_SPEED * 0.72 * delta));
          officer.state = 'repositioning';
        } else {
          officer.state = 'aiming';
        }
        officer.root.rotation.y = Math.atan2(direction.x, direction.z);
        const gait = officer.state === 'advancing' || officer.state === 'repositioning'
          ? Math.sin(elapsed * 9 + officer.phase) * 0.48
          : 0;
        officer.leftLeg.rotation.x = gait;
        officer.rightLeg.rotation.x = -gait;
        officer.leftArm.rotation.x = officer.state === 'aiming' ? -0.86 : -gait * 0.58;
        officer.rightArm.rotation.x = officer.state === 'aiming' ? -0.98 : gait * 0.58;
        if (meleeReaction) {
          const pulse = 0.72 + Math.sin(elapsed * 26 + officer.phase) * 0.28;
          officer.torso.rotation.x = 0.13;
          officer.torso.rotation.z = 0.1 * pulse;
          officer.head.rotation.z = 0.15 * pulse;
          officer.leftArm.rotation.z = 0.2 * pulse;
          officer.rightArm.rotation.z = -0.2 * pulse;
        } else {
          officer.torso.rotation.x = THREE.MathUtils.damp(officer.torso.rotation.x, 0, 16, delta);
          officer.torso.rotation.z = THREE.MathUtils.damp(officer.torso.rotation.z, 0, 16, delta);
          officer.head.rotation.z = THREE.MathUtils.damp(officer.head.rotation.z, 0, 16, delta);
          officer.leftArm.rotation.z = THREE.MathUtils.damp(officer.leftArm.rotation.z, 0, 16, delta);
          officer.rightArm.rotation.z = THREE.MathUtils.damp(officer.rightArm.rotation.z, 0, 16, delta);
        }
        groundOfficer(officer, playerPosition.y);
        updateLos(officer, playerPosition);
        anyBlocked ||= !officer.hasLineOfSight;
        const locking = pressure?.phase === 'locking'
          && pressure?.responderId === officer.responderId
          && officer.hasLineOfSight;
        if (locking && !officer.telegraph.visible) {
          officer.aimStartedAt = elapsed;
          events.aims += 1;
        }
        officer.telegraph.visible = locking;
        officer.telegraphMaterial.opacity = locking
          ? 0.34 + Math.min(0.58, (Number(pressure.lock) || 0) * 0.7)
          : 0;
        if (locking) {
          setLine(officer.telegraph, muzzlePoint, playerHead);
          if (officer.state !== 'aiming') officer.state = 'aiming';
        } else {
          officer.aimStartedAt = null;
        }
      }
      if (officer.tracerLife > 0) {
        officer.tracerLife = Math.max(0, officer.tracerLife - delta);
        officer.tracer.visible = officer.tracerLife > 0;
        officer.tracerMaterial.opacity = officer.tracerLife / SFPD_OFFICER_TRACER_SECONDS;
      } else {
        officer.tracer.visible = false;
        officer.tracerMaterial.opacity = 0;
      }
    }
    if (desired > 0 && anyBlocked) {
      blockedCycleElapsed += delta;
      while (blockedCycleElapsed >= 0.85) {
        blockedCycleElapsed -= 0.85;
        blockerCycles += 1;
      }
    } else {
      blockedCycleElapsed = 0;
    }
    if (desired > 0 && lastBlocked !== null && anyBlocked !== lastBlocked) blockerCycles += 1;
    if (desired > 0) lastBlocked = anyBlocked;
    lastLevel = desired > 0 ? Math.floor(level) : 0;
    return getState();
  }

  function getPressureAuthority({ responderId = null } = {}) {
    const officer = officers.find((entry) => (
      entry.root.visible && entry.targetable && entry.responderId === responderId
    ));
    const live = Boolean(officer
      && officer.root.userData.combatDisabled !== true
      && officer.root.userData.combatDefeated !== true);
    return {
      authorized: Boolean(live && officer.hasLineOfSight),
      officerId: officer?.id ?? null,
      responderId,
      live,
      los: Boolean(officer?.hasLineOfSight),
      blocked: Boolean(officer?.blocker),
      blocker: officer?.blocker ? {
        source: officer.blocker.source || 'world',
        distance: Math.round(officer.blocker.distance * 1000) / 1000,
      } : null,
    };
  }

  function registerPressureShot(responderId, playerPosition) {
    const officer = officers.find((entry) => (
      entry.root.visible && entry.targetable && entry.responderId === responderId
    ));
    if (!officer || officer.root.userData.combatDisabled === true
      || officer.root.userData.combatDefeated === true || !officer.hasLineOfSight) return false;
    muzzlePoint.copy(officer.root.position);
    muzzlePoint.y += 1.36;
    playerHead.set(playerPosition.x, (Number(playerPosition.y) || 0) + 1.34, playerPosition.z);
    setLine(officer.tracer, muzzlePoint, playerHead);
    direction.subVectors(playerHead, muzzlePoint).normalize();
    aimQuaternion.setFromUnitVectors(forwardAxis, direction);
    officer.weapon.quaternion.copy(aimQuaternion);
    officer.tracerLife = SFPD_OFFICER_TRACER_SECONDS;
    officer.tracer.visible = true;
    officer.tracerMaterial.opacity = 1;
    events.shots += 1;
    events.officerFires.push({ officerId: officer.id });
    if (events.officerFires.length > 24) events.officerFires.shift();
    return true;
  }

  function recordAim() {
    events.aims += 1;
  }

  function recordDamage({ targetId = 'player', source = 'pursuit-pressure', los = false, blocked = false } = {}) {
    events.damage.push({ targetId, source, los: los === true, blocked: blocked === true });
    if (events.damage.length > 24) events.damage.shift();
  }

  function recordBooking() {
    events.bookings += 1;
  }

  function resetEvents() {
    events.aims = 0;
    events.shots = 0;
    events.damage.length = 0;
    events.officerFires.length = 0;
    events.bookings = 0;
    blockerCycles = 0;
    blockedCycleElapsed = 0;
  }

  function getCombatCandidates(out = []) {
    for (const officer of officers) {
      if (!officer.root.visible || !officer.targetable
        || officer.root.userData.combatDisabled === true
        || officer.root.userData.combatDefeated === true) continue;
      out.push({
        kind: 'officer',
        id: officer.id,
        officerId: officer.id,
        responderId: officer.responderId,
        label: 'SFPD officer',
        mesh: officer.root,
        radius: 0.78,
        height: 1.08,
      });
    }
    return out;
  }

  function getState() {
    const snapshots = officers.filter((officer) => officer.id !== null).map((officer) => {
      const downed = officer.root.userData.combatDisabled === true
        || officer.root.userData.combatDefeated === true;
      return {
        id: officer.id,
        responderId: officer.responderId,
        visible: officer.root.visible,
        live: !downed,
        state: downed ? 'downed' : officer.state,
        parentVehicleId: officer.responderId,
        distance: officer.distance === null ? null : Math.round(officer.distance * 10) / 10,
        los: !downed && officer.hasLineOfSight,
        blocked: !downed && Boolean(officer.blocker),
        surfaceDelta: Math.round(officer.groundResidual * 1000) / 1000,
        surfaceY: Number.isFinite(officer.surfaceY)
          ? Math.round(officer.surfaceY * 1000) / 1000
          : null,
        footY: Number.isFinite(officer.footY)
          ? Math.round(officer.footY * 1000) / 1000
          : null,
        targetable: officer.targetable && !downed,
        defeated: downed,
        deploy: {
          state: officer.deployState,
          vehicleSpeed: officer.parentVehicleSpeed === null
            ? null
            : Math.round(officer.parentVehicleSpeed * 10) / 10,
          holdRequested: officer.parentVehicleHoldRequested,
          holding: officer.parentVehicleHolding,
          distance: officer.parentVehicleDistance === null
            ? null
            : Math.round(officer.parentVehicleDistance * 10) / 10,
          exitClearance: Math.round(officer.exitClearance * 1000) / 1000,
          bodyVehicleOverlap: officer.bodyVehicleOverlap,
        },
        aim: {
          telegraphActive: officer.telegraph.visible,
          startedAt: officer.aimStartedAt,
          weaponMuzzle: true,
          muzzlePosition: {
            x: Math.round((officer.root.position.x) * 1000) / 1000,
            y: Math.round((officer.root.position.y + 1.36) * 1000) / 1000,
            z: Math.round((officer.root.position.z) * 1000) / 1000,
          },
        },
        position: {
          x: Math.round(officer.root.position.x * 1000) / 1000,
          y: Math.round(officer.root.position.y * 1000) / 1000,
          z: Math.round(officer.root.position.z * 1000) / 1000,
        },
        morphology: {
          human: Boolean(officer.head && officer.torso && officer.leftLeg && officer.rightLeg),
          uniform: Boolean(officer.badge && officer.cap && officer.belt),
          badge: Boolean(officer.badge),
          belt: Boolean(officer.belt),
          weapon: Boolean(officer.weapon?.visible),
          grounded: officer.grounded,
        },
      };
    });
    const activeTimers = officers.reduce((count, officer) => (
      count + (officer.tracerLife > 0 ? 1 : 0) + (officer.telegraph.visible ? 1 : 0)
    ), 0);
    const activeProjectiles = officers.filter((officer) => officer.tracer.visible).length;
    return {
      level: lastLevel,
      officers: snapshots,
      events: {
        aims: events.aims,
        shots: events.shots,
        damage: events.damage.map((entry) => ({ ...entry })),
        officerFires: events.officerFires.map((entry) => ({ ...entry })),
        bookings: events.bookings,
      },
      blocker: {
        solid: snapshots.some((officer) => officer.blocked),
        cycles: blockerCycles,
      },
      resources: {
        officerActors: snapshots.length,
        activeTimers,
        activeListeners: 0,
        activeProjectiles,
      },
      cleared: snapshots.length === 0 && activeTimers === 0 && activeProjectiles === 0,
    };
  }

  function dispose() {
    clear();
    officers.forEach((officer) => {
      officer.root.traverse((object) => object.geometry?.dispose?.());
      officer.telegraph.geometry.dispose();
      officer.tracer.geometry.dispose();
      officer.materials.forEach((entry) => entry.dispose());
      officer.telegraph.removeFromParent();
      officer.tracer.removeFromParent();
    });
    group.removeFromParent();
  }

  return {
    group,
    update,
    clear,
    getState,
    getCombatCandidates,
    getPressureAuthority,
    registerPressureShot,
    recordAim,
    recordDamage,
    recordBooking,
    resetEvents,
    dispose,
  };
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, values) {
  return values[Math.floor(rng() * values.length)];
}

function pickJob(rng) {
  const total = JOBS.reduce((sum, job) => sum + job.weight, 0);
  let cursor = rng() * total;
  for (const job of JOBS) {
    cursor -= job.weight;
    if (cursor <= 0) return job;
  }
  return JOBS[0];
}

function roleScheduleFor(job) {
  return ROLE_SCHEDULES[job?.id] || ROLE_SCHEDULES.commuter;
}

function randomRange(rng, range) {
  return range[0] + rng() * (range[1] - range[0]);
}

function createVisualVariant(actorIndex, job) {
  const role = job?.id || 'commuter';
  const profile = ROLE_VISUAL_PROFILES[role] || ROLE_VISUAL_PROFILES.commuter;
  const seed = (
    0x3f2a91c7
    ^ Math.imul((actorIndex ?? 0) + 1, 0x9e3779b1)
    ^ (ROLE_VISUAL_SEEDS[role] ?? ROLE_VISUAL_SEEDS.commuter)
  ) >>> 0;
  const visualRng = mulberry32(seed);
  const silhouetteId = pick(visualRng, profile.silhouettes);
  const silhouette = SILHOUETTE_VARIANTS[silhouetteId] || SILHOUETTE_VARIANTS[0];
  const outerwear = visualRng() < profile.outerwearChance;
  return {
    silhouetteId,
    silhouette: silhouette.id,
    bodyWidthScale: silhouette.width,
    bodyDepthScale: silhouette.depth,
    hairStyle: pick(visualRng, profile.hairStyles),
    headwearStyle: pick(visualRng, profile.headwearStyles),
    wearsScarf: visualRng() < profile.scarfChance,
    wearsGlasses: role === 'tourist' || visualRng() < 0.2,
    outerwear,
    hooded: outerwear && visualRng() < 0.3,
    bagStyle: pick(visualRng, profile.bagStyles),
    gaitStyle: pick(visualRng, profile.gaitStyles),
    wardrobe: profile.wardrobe || null,
    propScale: 0.9 + visualRng() * 0.18,
    posePhase: visualRng() * Math.PI * 2,
  };
}

function getHeroMaterialAtlas() {
  if (sharedHeroMaterialAtlas || typeof document === 'undefined') return sharedHeroMaterialAtlas;
  sharedHeroMaterialAtlas = new THREE.TextureLoader().load(HERO_MATERIAL_ATLAS_URL);
  sharedHeroMaterialAtlas.name = 'Generated hero pedestrian material atlas';
  sharedHeroMaterialAtlas.colorSpace = THREE.SRGBColorSpace;
  sharedHeroMaterialAtlas.wrapS = THREE.ClampToEdgeWrapping;
  sharedHeroMaterialAtlas.wrapT = THREE.ClampToEdgeWrapping;
  sharedHeroMaterialAtlas.minFilter = THREE.LinearMipmapLinearFilter;
  sharedHeroMaterialAtlas.magFilter = THREE.LinearFilter;
  sharedHeroMaterialAtlas.anisotropy = 4;
  return sharedHeroMaterialAtlas;
}

function atlasNumber(value) {
  return Number(value).toFixed(5);
}

function applyHeroAtlasBreakup(material, atlas, tile) {
  if (!atlas) return material;
  material.map = atlas;
  material.name = `Shared hero ${tile.id} atlas material`;
  material.userData.heroAtlasTile = tile.id;
  material.onBeforeCompile = (shader) => {
    const origin = `vec2(${atlasNumber(tile.x)}, ${atlasNumber(tile.y)})`;
    const size = `vec2(${atlasNumber(tile.width)}, ${atlasNumber(tile.height)})`;
    const repeat = `vec2(${atlasNumber(tile.repeatU)}, ${atlasNumber(tile.repeatV)})`;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `
        #if defined( USE_UV ) || defined( USE_ANISOTROPY )
          vUv = vec3( uv, 1 ).xy;
        #endif
        #ifdef USE_MAP
          vec2 pedestrianAtlasUv = fract(
            ( mapTransform * vec3( MAP_UV, 1.0 ) ).xy * ${repeat}
          );
          vMapUv = ${origin} + pedestrianAtlasUv * ${size};
        #endif
      `,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `
        #ifdef USE_MAP
          vec3 pedestrianAtlasSample = texture2D( map, vMapUv ).rgb;
          float pedestrianAtlasLuminance = dot(
            pedestrianAtlasSample,
            vec3( 0.2126, 0.7152, 0.0722 )
          );
          float pedestrianAtlasBreakup = clamp(
            pedestrianAtlasLuminance / ${atlasNumber(tile.referenceLuma)},
            0.74,
            1.26
          );
          diffuseColor.rgb *= mix(
            vec3( 1.0 ),
            vec3( pedestrianAtlasBreakup ),
            ${atlasNumber(tile.strength)}
          );
        #endif
      `,
    );
  };
  material.customProgramCacheKey = () => `hero-pedestrian-atlas-v1-${tile.id}`;
  material.needsUpdate = true;
  return material;
}

function createMaterialLibrary() {
  const standardPalette = (colors, options) => colors.map((color) => new THREE.MeshStandardMaterial({ color, ...options }));
  const atlas = getHeroMaterialAtlas();
  const roleAccent = Object.fromEntries(
    Object.entries(ROLE_ACCENT_COLORS).map(([role, color]) => [
      role,
      new THREE.MeshStandardMaterial({ color, roughness: 0.72 }),
    ]),
  );
  const heroStandardPalette = (colors, options, tile) => colors.map((color) => applyHeroAtlasBreakup(
    new THREE.MeshStandardMaterial({ color, ...options }),
    atlas,
    tile,
  ));
  const heroPhysicalPalette = (colors, options, tile) => colors.map((color) => applyHeroAtlasBreakup(
    new THREE.MeshPhysicalMaterial({ color, ...options }),
    atlas,
    tile,
  ));
  return {
    skin: standardPalette(SKIN, { roughness: 0.8 }),
    heroSkin: heroPhysicalPalette(SKIN, { roughness: 0.63, sheen: 0.03, sheenRoughness: 0.9 }, HERO_ATLAS_TILES.skin),
    hair: standardPalette(HAIR, { roughness: 0.8, metalness: 0.015 }),
    heroHair: heroStandardPalette(HAIR, { roughness: 0.78, metalness: 0.015 }, HERO_ATLAS_TILES.hair),
    top: standardPalette(TOPS, { roughness: 0.84 }),
    heroTop: heroPhysicalPalette(HERO_TOPS, { roughness: 0.7, sheen: 0.19, sheenRoughness: 0.82 }, HERO_ATLAS_TILES.jacket),
    bottom: standardPalette(BOTTOMS, { roughness: 0.82 }),
    heroBottom: heroStandardPalette(HERO_BOTTOMS, { roughness: 0.8 }, HERO_ATLAS_TILES.denim),
    shoes: standardPalette(SHOES, { roughness: 0.72, metalness: 0.02 }),
    heroShoes: heroPhysicalPalette(SHOES, { roughness: 0.45, clearcoat: 0.1, clearcoatRoughness: 0.52 }, HERO_ATLAS_TILES.shoe),
    accent: new THREE.MeshStandardMaterial({ color: 0x8a5a3d, roughness: 0.74 }),
    workerAccent: new THREE.MeshStandardMaterial({ color: 0xec7c2c, roughness: 0.74, side: THREE.DoubleSide }),
    baristaAccent: new THREE.MeshStandardMaterial({ color: 0xf2e6cd, roughness: 0.74 }),
    serviceAccent: new THREE.MeshStandardMaterial({ color: 0x4a6468, roughness: 0.8 }),
    reflective: new THREE.MeshStandardMaterial({ color: 0xf3d27c, roughness: 0.42 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x202528, roughness: 0.46, metalness: 0.4 }),
    roleAccent,
    screen: new THREE.MeshStandardMaterial({
      color: 0x6fa7c4,
      emissive: 0x1a536b,
      emissiveIntensity: 0.45,
      roughness: 0.22,
      metalness: 0.25,
    }),
    eye: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.55 }),
    eyeWhite: new THREE.MeshStandardMaterial({ color: 0xc8c7c0, roughness: 0.46 }),
    lip: new THREE.MeshStandardMaterial({ color: 0x75433d, roughness: 0.82 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xa9adb0, roughness: 0.28, metalness: 0.72 }),
    trim: standardPalette(SHIRT_ACCENTS, { roughness: 0.64 }),
    heroTrim: heroStandardPalette(SHIRT_ACCENTS, { roughness: 0.64 }, HERO_ATLAS_TILES.cotton),
    scarf: standardPalette(SCARF_COLORS, { roughness: 0.88 }),
    heroScarf: heroStandardPalette(SCARF_COLORS, { roughness: 0.78 }, HERO_ATLAS_TILES.cotton),
    headwear: standardPalette(HAT_COLORS, { roughness: 0.78 }),
    heroHeadwear: heroStandardPalette(HAT_COLORS, { roughness: 0.74 }, HERO_ATLAS_TILES.jacket),
    shoeAccent: standardPalette(SHOE_ACCENTS, { roughness: 0.66 }),
    heroShoeAccent: heroStandardPalette(SHOE_ACCENTS, { roughness: 0.58 }, HERO_ATLAS_TILES.shoe),
    workerTrim: new THREE.MeshStandardMaterial({ color: 0xe5dfbf, roughness: 0.64 }),
    heroWorkerTrim: applyHeroAtlasBreakup(
      new THREE.MeshStandardMaterial({ color: 0xe5dfbf, roughness: 0.64 }),
      atlas,
      HERO_ATLAS_TILES.cotton,
    ),
    bag: standardPalette(BAG_COLORS, { roughness: 0.6, metalness: 0.03 }),
    heroBag: heroStandardPalette(BAG_COLORS, { roughness: 0.6, metalness: 0.03 }, HERO_ATLAS_TILES.cotton),
  };
}

function createMaterials(rng, job, heroDetail, library) {
  // Reuse a compact material library across the fixed pool. It retains the
  // palette/readability of the prior per-actor setup while avoiding hundreds
  // of unique GPU material states at Cinema quality.
  return {
    skin: pick(rng, heroDetail ? library.heroSkin : library.skin),
    hair: pick(rng, heroDetail ? library.heroHair : library.hair),
    top: pick(rng, heroDetail ? library.heroTop : library.top),
    bottom: pick(rng, heroDetail ? library.heroBottom : library.bottom),
    shoes: pick(rng, heroDetail ? library.heroShoes : library.shoes),
    accent: job.id === 'worker'
      ? library.workerAccent
      : job.id === 'barista'
        ? library.baristaAccent
        : job.id === 'cleaner'
          ? library.serviceAccent
          : library.roleAccent[job.id] || library.accent,
    roleAccent: library.roleAccent[job.id] || library.accent,
    dark: library.dark,
    reflective: library.reflective,
    screen: library.screen,
    eye: library.eye,
    eyeWhite: library.eyeWhite,
    lip: library.lip,
    metal: library.metal,
    trim: job.id === 'worker'
      ? (heroDetail ? library.heroWorkerTrim : library.workerTrim)
      : pick(rng, heroDetail ? library.heroTrim : library.trim),
    scarf: pick(rng, heroDetail ? library.heroScarf : library.scarf),
    headwear: pick(rng, heroDetail ? library.heroHeadwear : library.headwear),
    shoeAccent: pick(rng, heroDetail ? library.heroShoeAccent : library.shoeAccent),
    bag: pick(rng, heroDetail ? library.heroBag : library.bag),
  };
}

function addMesh(parent, geometry, material, position, scale = null) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  if (scale) mesh.scale.copy(scale);
  parent.add(mesh);
  return mesh;
}

function addVisualWardrobeDetails({
  rig,
  headPivot,
  geometry,
  materials,
  job,
  variant,
  heroDetail = false,
  existingOuterwear = false,
  existingBackpack = false,
}) {
  const role = job?.id;
  if (!variant || !rig) return;

  // The authored worker uniform is shared by background and hero actors. The
  // hero path needs the vest and hard hat recreated because its skinned body
  // replaces the legacy assembly; the background path only needs the stripe.
  if (role === 'worker') {
    if (heroDetail) {
      const vest = addMesh(rig, geometry.vest, materials.accent, new THREE.Vector3(0, 1.25, 0));
      vest.material.side = THREE.DoubleSide;
      vest.name = 'Hi-vis work vest';
      const hardHat = addMesh(
        headPivot,
        geometry.hat,
        materials.accent,
        new THREE.Vector3(0, 0.18, 0),
        new THREE.Vector3(0.9, 0.52, 0.9),
      );
      hardHat.name = 'Hard hat silhouette';
    }
    const reflectiveBand = addMesh(
      rig,
      geometry.reflectiveBand,
      materials.reflective,
      new THREE.Vector3(0, 1.27, 0.225),
      new THREE.Vector3(1.08, 1, 1),
    );
    reflectiveBand.name = 'Reflective work stripe';
    addMesh(
      rig,
      geometry.utilityBelt,
      materials.dark,
      new THREE.Vector3(0, 1.0, 0.03),
      new THREE.Vector3(1.02, 1, 0.82),
    ).name = 'Work utility belt';
    addMesh(
      rig,
      geometry.badge,
      materials.reflective,
      new THREE.Vector3(0.105, 1.4, 0.236),
      new THREE.Vector3(1, 1, 0.8),
    ).name = 'Work badge';
  }

  if (role === 'barista') {
    const apron = addMesh(
      rig,
      geometry.apron,
      materials.accent,
      new THREE.Vector3(0, 1.22, 0.235),
      new THREE.Vector3(0.92, 1, 1),
    );
    apron.name = 'Barista apron';
    addMesh(
      rig,
      geometry.apronPocket,
      materials.trim,
      new THREE.Vector3(0, 1.1, 0.257),
      new THREE.Vector3(0.96, 1, 1),
    ).name = 'Barista apron pocket';
  }

  if (role === 'cleaner') {
    const apron = addMesh(
      rig,
      geometry.apron,
      materials.accent,
      new THREE.Vector3(0, 1.2, 0.172),
      new THREE.Vector3(0.88, 0.92, 1),
    );
    apron.name = 'Service apron';
    addMesh(
      rig,
      geometry.reflectiveBand,
      materials.reflective,
      new THREE.Vector3(0, 1.22, 0.196),
      new THREE.Vector3(0.92, 1, 1),
    ).name = 'Service uniform stripe';
    addMesh(
      rig,
      geometry.utilityBelt,
      materials.dark,
      new THREE.Vector3(0, 1.0, 0.03),
      new THREE.Vector3(0.94, 0.9, 0.8),
    ).name = 'Cleaner utility belt';
  }
  // A deterministic outer layer adds a second shoulder/hem read without
  // making a unique garment or material for every pooled actor.
  if (variant.outerwear && !existingOuterwear && role !== 'worker') {
    const coat = addMesh(rig, geometry.coat, materials.top, new THREE.Vector3(0, 1.18, -0.004));
    coat.scale.set(variant.bodyWidthScale * 1.03, 1.04, 0.78);
    coat.name = 'Layered outerwear silhouette';
    const hem = addMesh(rig, geometry.jacketHem, materials.top, new THREE.Vector3(0, 0.98, 0));
    hem.scale.set(variant.bodyWidthScale * 1.04, 1, 0.82);
    hem.name = 'Layered jacket hem';
    if (variant.hooded) {
      const hood = addMesh(rig, geometry.hood, materials.top, new THREE.Vector3(0, 1.58, -0.015));
      hood.rotation.x = Math.PI * 0.5;
      hood.scale.set(1.08, 1, 0.96);
      hood.name = 'Layered hood rim';
    }
  } else if (variant.silhouetteId === 3 && role !== 'worker' && role !== 'barista') {
    const shoulderYoke = addMesh(rig, geometry.shoulderYoke, materials.top, new THREE.Vector3(0, 1.55, 0));
    shoulderYoke.scale.set(variant.bodyWidthScale, 0.82, 0.82);
    shoulderYoke.name = 'Structured shoulder layer';
  }

  let bagStyle = variant.bagStyle;
  if (existingBackpack) bagStyle = null;
  if (bagStyle === 'backpack') {
    const backpack = addMesh(rig, geometry.backpack, materials.bag, new THREE.Vector3(0, 1.28, -0.18));
    backpack.scale.set(0.85, 0.92, 0.58);
    backpack.name = 'Everyday backpack';
  } else if (bagStyle === 'messenger') {
    const strap = addMesh(rig, geometry.strap, materials.bag, new THREE.Vector3(0.08, 1.36, 0.19));
    strap.rotation.z = 0.48;
    strap.name = 'Messenger bag strap';
    const bag = addMesh(rig, geometry.messengerBag, materials.bag, new THREE.Vector3(-0.16, 1.0, 0.19));
    bag.rotation.y = -0.1;
    bag.name = 'Messenger bag';
  } else if (bagStyle === 'tote') {
    const tote = addMesh(rig, geometry.tote, materials.bag, new THREE.Vector3(-0.29, 1.01, 0.04));
    tote.rotation.z = -0.08;
    tote.name = 'Canvas tote';
  }

  // Role identity reads through wardrobe pieces above — apron, vest, bag,
  // reflective stripe — not through floating chest markers that read as UI.
  if (role === 'commuter' && bagStyle === 'none' && !existingOuterwear) {
    const scarf = addMesh(
      rig,
      geometry.scarf,
      materials.scarf,
      new THREE.Vector3(0, 1.52, 0.08),
      new THREE.Vector3(0.82, 0.72, 0.72),
    );
    scarf.name = 'Commuter neck scarf';
  } else if (role === 'phone') {
    addMesh(
      rig,
      geometry.scarf,
      materials.trim,
      new THREE.Vector3(0, 1.48, 0.06),
      new THREE.Vector3(0.74, 0.55, 0.55),
    ).name = 'Phone-user collar trim';
  } else if (role === 'tourist' && bagStyle === 'none') {
    addMesh(
      rig,
      geometry.badge,
      materials.trim,
      new THREE.Vector3(0.12, 1.34, 0.228),
      new THREE.Vector3(0.72, 0.72, 0.55),
    ).name = 'Tourist map fold';
  }
}

const HERO_BONE = Object.freeze({
  root: 0,
  hips: 1,
  spine: 2,
  chest: 3,
  neck: 4,
  head: 5,
  leftUpperArm: 6,
  leftForearm: 7,
  leftHand: 8,
  rightUpperArm: 9,
  rightForearm: 10,
  rightHand: 11,
  leftUpperLeg: 12,
  leftShin: 13,
  leftFoot: 14,
  rightUpperLeg: 15,
  rightShin: 16,
  rightFoot: 17,
});

const HERO_MATERIAL = Object.freeze({
  skin: 0,
  hair: 1,
  top: 2,
  bottom: 3,
  shoes: 4,
  dark: 5,
  trim: 6,
});

function createHeroBodyGeometry() {
  const positions = [];
  const uvs = [];
  const skinIndices = [];
  const skinWeights = [];
  const triangles = Array.from({ length: Object.keys(HERO_MATERIAL).length }, () => []);

  function addVertex(x, y, z, u, v, influences) {
    positions.push(x, y, z);
    uvs.push(u, v);
    const entries = influences.slice(0, 4);
    const total = entries.reduce((sum, entry) => sum + entry[1], 0) || 1;
    for (let index = 0; index < 4; index += 1) {
      const entry = entries[index];
      skinIndices.push(entry?.[0] ?? HERO_BONE.root);
      skinWeights.push(entry ? entry[1] / total : 0);
    }
    return positions.length / 3 - 1;
  }

  function addTube(rings, segments, materialIndex) {
    const ringIndexes = rings.map((ring, ringIndex) => (
      Array.from({ length: segments + 1 }, (_, segment) => {
        const angle = (segment / segments) * Math.PI * 2;
        return addVertex(
          (ring.x || 0) + Math.cos(angle) * ring.radiusX,
          ring.y,
          (ring.z || 0) + Math.sin(angle) * ring.radiusZ,
          segment / segments,
          ringIndex / Math.max(1, rings.length - 1),
          ring.influences,
        );
      })
    ));
    for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
      for (let segment = 0; segment < segments; segment += 1) {
        const lower = ringIndexes[ringIndex][segment];
        const lowerNext = ringIndexes[ringIndex][segment + 1];
        const upper = ringIndexes[ringIndex + 1][segment];
        const upperNext = ringIndexes[ringIndex + 1][segment + 1];
        triangles[materialIndex].push(lower, upper, lowerNext, lowerNext, upper, upperNext);
      }
    }
  }

  function addEllipsoid(center, radius, segments, rows, materialIndex, influences) {
    const indexes = [];
    for (let row = 0; row <= rows; row += 1) {
      const latitude = (row / rows) * Math.PI;
      const sinLatitude = Math.sin(latitude);
      const cosLatitude = Math.cos(latitude);
      const ring = [];
      for (let segment = 0; segment <= segments; segment += 1) {
        const longitude = (segment / segments) * Math.PI * 2;
        ring.push(addVertex(
          center.x + Math.cos(longitude) * sinLatitude * radius.x,
          center.y + cosLatitude * radius.y,
          center.z + Math.sin(longitude) * sinLatitude * radius.z,
          segment / segments,
          row / rows,
          influences,
        ));
      }
      indexes.push(ring);
    }
    for (let row = 0; row < rows; row += 1) {
      for (let segment = 0; segment < segments; segment += 1) {
        const upper = indexes[row][segment];
        const upperNext = indexes[row][segment + 1];
        const lower = indexes[row + 1][segment];
        const lowerNext = indexes[row + 1][segment + 1];
        triangles[materialIndex].push(upper, upperNext, lower, upperNext, lowerNext, lower);
      }
    }
  }

  function addFrontQuad(points, materialIndex, influences) {
    const indexes = points.map((point, index) => addVertex(
      point.x,
      point.y,
      point.z,
      index === 1 || index === 2 ? 1 : 0,
      index >= 2 ? 1 : 0,
      influences,
    ));
    triangles[materialIndex].push(
      indexes[0], indexes[1], indexes[2],
      indexes[0], indexes[2], indexes[3],
    );
  }

  // A single draped shell establishes shoulder slope, rib cage, waist and
  // pelvis. The hem sits over the upper-leg shells, avoiding the segmented
  // action-figure gap the previous close actors showed.
  addTube([
    { y: 0.87, radiusX: 0.215, radiusZ: 0.145, influences: [[HERO_BONE.hips, 1]] },
    { y: 1.02, radiusX: 0.22, radiusZ: 0.15, influences: [[HERO_BONE.hips, 0.9], [HERO_BONE.spine, 0.1]] },
    { y: 1.2, radiusX: 0.177, radiusZ: 0.128, influences: [[HERO_BONE.hips, 0.25], [HERO_BONE.spine, 0.75]] },
    { y: 1.42, radiusX: 0.235, radiusZ: 0.148, influences: [[HERO_BONE.spine, 0.4], [HERO_BONE.chest, 0.6]] },
    { y: 1.57, radiusX: 0.305, radiusZ: 0.154, influences: [[HERO_BONE.chest, 1]] },
    { y: 1.66, radiusX: 0.115, radiusZ: 0.11, influences: [[HERO_BONE.chest, 0.82], [HERO_BONE.neck, 0.18]] },
  ], 14, HERO_MATERIAL.top);

  addFrontQuad([
    { x: -0.13, y: 1.57, z: 0.157 },
    { x: -0.02, y: 1.48, z: 0.16 },
    { x: -0.008, y: 1.58, z: 0.16 },
    { x: -0.085, y: 1.64, z: 0.143 },
  ], HERO_MATERIAL.trim, [[HERO_BONE.chest, 1]]);
  addFrontQuad([
    { x: 0.02, y: 1.48, z: 0.16 },
    { x: 0.13, y: 1.57, z: 0.157 },
    { x: 0.085, y: 1.64, z: 0.143 },
    { x: 0.008, y: 1.58, z: 0.16 },
  ], HERO_MATERIAL.trim, [[HERO_BONE.chest, 1]]);

  addTube([
    { y: 1.65, radiusX: 0.07, radiusZ: 0.066, influences: [[HERO_BONE.neck, 0.65], [HERO_BONE.chest, 0.35]] },
    { y: 1.79, radiusX: 0.064, radiusZ: 0.061, influences: [[HERO_BONE.neck, 0.9], [HERO_BONE.head, 0.1]] },
  ], 10, HERO_MATERIAL.skin);

  const armSides = [
    {
      x: -0.3,
      upper: HERO_BONE.leftUpperArm,
      forearm: HERO_BONE.leftForearm,
      hand: HERO_BONE.leftHand,
    },
    {
      x: 0.3,
      upper: HERO_BONE.rightUpperArm,
      forearm: HERO_BONE.rightForearm,
      hand: HERO_BONE.rightHand,
    },
  ];
  for (const side of armSides) {
    addTube([
      { x: side.x, y: 1.59, radiusX: 0.076, radiusZ: 0.08, influences: [[side.upper, 1]] },
      { x: side.x, y: 1.39, radiusX: 0.067, radiusZ: 0.071, influences: [[side.upper, 1]] },
      { x: side.x, y: 1.18, radiusX: 0.057, radiusZ: 0.061, influences: [[side.upper, 0.72], [side.forearm, 0.28]] },
    ], 9, HERO_MATERIAL.top);
    addTube([
      { x: side.x, y: 1.19, radiusX: 0.057, radiusZ: 0.061, influences: [[side.upper, 0.22], [side.forearm, 0.78]] },
      { x: side.x, y: 1.0, radiusX: 0.052, radiusZ: 0.056, influences: [[side.forearm, 1]] },
      { x: side.x, y: 0.84, radiusX: 0.043, radiusZ: 0.048, influences: [[side.forearm, 0.82], [side.hand, 0.18]] },
    ], 9, HERO_MATERIAL.top);
    addEllipsoid(
      new THREE.Vector3(side.x, 0.785, 0.005),
      new THREE.Vector3(0.05, 0.095, 0.038),
      8,
      6,
      HERO_MATERIAL.skin,
      [[side.hand, 1]],
    );
  }

  const legSides = [
    {
      x: -0.11,
      upper: HERO_BONE.leftUpperLeg,
      shin: HERO_BONE.leftShin,
      foot: HERO_BONE.leftFoot,
    },
    {
      x: 0.11,
      upper: HERO_BONE.rightUpperLeg,
      shin: HERO_BONE.rightShin,
      foot: HERO_BONE.rightFoot,
    },
  ];
  for (const side of legSides) {
    addTube([
      { x: side.x, y: 0.98, radiusX: 0.105, radiusZ: 0.125, influences: [[side.upper, 1]] },
      { x: side.x, y: 0.73, radiusX: 0.09, radiusZ: 0.105, influences: [[side.upper, 1]] },
      { x: side.x, y: 0.49, radiusX: 0.072, radiusZ: 0.08, influences: [[side.upper, 0.72], [side.shin, 0.28]] },
    ], 10, HERO_MATERIAL.bottom);
    addTube([
      { x: side.x, y: 0.5, radiusX: 0.072, radiusZ: 0.08, influences: [[side.upper, 0.18], [side.shin, 0.82]] },
      { x: side.x, y: 0.28, radiusX: 0.065, radiusZ: 0.075, influences: [[side.shin, 1]] },
      { x: side.x, y: 0.08, radiusX: 0.052, radiusZ: 0.059, influences: [[side.shin, 0.82], [side.foot, 0.18]] },
    ], 10, HERO_MATERIAL.bottom);
    addEllipsoid(
      new THREE.Vector3(side.x, 0.065, 0.105),
      new THREE.Vector3(0.082, 0.062, 0.19),
      10,
      6,
      HERO_MATERIAL.shoes,
      [[side.foot, 1]],
    );
  }

  // The face is roughly 7.4 head-heights within the complete figure. Hair is
  // a slightly offset rear shell, so it frames rather than inflates the head.
  addEllipsoid(
    new THREE.Vector3(0, 1.915, -0.022),
    new THREE.Vector3(0.132, 0.153, 0.116),
    12,
    8,
    HERO_MATERIAL.hair,
    [[HERO_BONE.head, 1]],
  );
  addEllipsoid(
    new THREE.Vector3(0, 1.905, 0.014),
    new THREE.Vector3(0.12, 0.142, 0.106),
    12,
    8,
    HERO_MATERIAL.skin,
    [[HERO_BONE.head, 1]],
  );
  addEllipsoid(
    new THREE.Vector3(-0.122, 1.91, 0.005),
    new THREE.Vector3(0.019, 0.031, 0.014),
    7,
    5,
    HERO_MATERIAL.skin,
    [[HERO_BONE.head, 1]],
  );
  addEllipsoid(
    new THREE.Vector3(0.122, 1.91, 0.005),
    new THREE.Vector3(0.019, 0.031, 0.014),
    7,
    5,
    HERO_MATERIAL.skin,
    [[HERO_BONE.head, 1]],
  );
  addEllipsoid(
    new THREE.Vector3(0, 1.9, 0.118),
    new THREE.Vector3(0.021, 0.033, 0.027),
    7,
    5,
    HERO_MATERIAL.skin,
    [[HERO_BONE.head, 1]],
  );
  for (const x of [-0.043, 0.043]) {
    addEllipsoid(
      new THREE.Vector3(x, 1.945, 0.105),
      new THREE.Vector3(0.014, 0.008, 0.009),
      6,
      4,
      HERO_MATERIAL.dark,
      [[HERO_BONE.head, 1]],
    );
  }
  addEllipsoid(
    new THREE.Vector3(0, 1.852, 0.112),
    new THREE.Vector3(0.025, 0.004, 0.007),
    6,
    4,
    HERO_MATERIAL.trim,
    [[HERO_BONE.head, 1]],
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  const combinedIndices = [];
  for (let materialIndex = 0; materialIndex < triangles.length; materialIndex += 1) {
    const start = combinedIndices.length;
    combinedIndices.push(...triangles[materialIndex]);
    geometry.addGroup(start, combinedIndices.length - start, materialIndex);
  }
  geometry.setIndex(combinedIndices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = 'Shared adult hero pedestrian body';
  return geometry;
}

function createSharedGeometry() {
  const torsoProfile = [
    // A real waist and a soft shoulder slope read more naturally than the
    // previous almost-straight tube, while remaining one shared lathe mesh.
    new THREE.Vector2(0.17, -0.36),
    new THREE.Vector2(0.205, -0.3),
    new THREE.Vector2(0.19, -0.06),
    new THREE.Vector2(0.22, 0.17),
    new THREE.Vector2(0.255, 0.31),
    new THREE.Vector2(0.2, 0.38),
  ];
  return {
    heroBody: createHeroBodyGeometry(),
    torso: new THREE.LatheGeometry(torsoProfile, 16),
    head: new THREE.SphereGeometry(0.17, 20, 16),
    // Hero faces get a shallow, separately lit oval instead of asking a
    // single spherical cranium to carry every facial plane.
    facePlane: new THREE.SphereGeometry(0.135, 12, 8),
    hair: new THREE.SphereGeometry(0.18, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.58),
    hairBack: new THREE.CapsuleGeometry(0.13, 0.18, 4, 10),
    neck: new THREE.CylinderGeometry(0.075, 0.082, 0.155, 10),
    ear: new THREE.SphereGeometry(0.035, 8, 5),
    brow: new THREE.BoxGeometry(0.052, 0.01, 0.012),
    mouth: new THREE.BoxGeometry(0.065, 0.009, 0.01),
    collar: new THREE.TorusGeometry(0.125, 0.018, 5, 12, Math.PI),
    button: new THREE.SphereGeometry(0.012, 6, 4),
    upperArm: new THREE.CylinderGeometry(0.064, 0.076, 0.42, 8),
    lowerArm: new THREE.CylinderGeometry(0.052, 0.062, 0.36, 8),
    upperLeg: new THREE.CylinderGeometry(0.078, 0.09, 0.46, 8),
    lowerLeg: new THREE.CylinderGeometry(0.062, 0.074, 0.42, 8),
    foot: new THREE.CapsuleGeometry(0.076, 0.17, 4, 8),
    hand: new THREE.SphereGeometry(0.057, 8, 6),
    palm: new THREE.CapsuleGeometry(0.052, 0.09, 3, 6),
    finger: new THREE.CapsuleGeometry(0.013, 0.048, 3, 5),
    nose: new THREE.CapsuleGeometry(0.022, 0.048, 3, 7),
    eye: new THREE.SphereGeometry(0.015, 6, 4),
    eyeWhite: new THREE.SphereGeometry(0.025, 8, 5),
    glasses: new THREE.TorusGeometry(0.045, 0.008, 5, 10),
    backpack: new THREE.CapsuleGeometry(0.14, 0.28, 4, 8),
    coat: new THREE.CylinderGeometry(0.2, 0.245, 0.62, 10),
    skirt: new THREE.CylinderGeometry(0.14, 0.245, 0.43, 12),
    shoulderYoke: new THREE.CylinderGeometry(0.225, 0.255, 0.13, 12),
    jacketHem: new THREE.CylinderGeometry(0.205, 0.235, 0.15, 10, 1, true),
    lapel: new THREE.BoxGeometry(0.045, 0.34, 0.026),
    cuff: new THREE.TorusGeometry(0.048, 0.012, 4, 8),
    shoeSole: new THREE.BoxGeometry(0.145, 0.038, 0.31),
    shoeToe: new THREE.SphereGeometry(0.086, 8, 5),
    shoeStripe: new THREE.BoxGeometry(0.018, 0.028, 0.14),
    strap: new THREE.BoxGeometry(0.025, 0.88, 0.026),
    messengerBag: new THREE.BoxGeometry(0.22, 0.19, 0.09),
    tote: new THREE.BoxGeometry(0.2, 0.27, 0.055),
    apron: new THREE.BoxGeometry(0.29, 0.5, 0.035),
    apronPocket: new THREE.BoxGeometry(0.12, 0.08, 0.022),
    reflectiveBand: new THREE.BoxGeometry(0.36, 0.028, 0.028),
    utilityBelt: new THREE.BoxGeometry(0.38, 0.07, 0.07),
    badge: new THREE.BoxGeometry(0.05, 0.06, 0.024),
    scarf: new THREE.TorusGeometry(0.115, 0.026, 5, 12),
    scarfTail: new THREE.BoxGeometry(0.04, 0.28, 0.038),
    // Background pedestrians keep a readable head/torso/limb silhouette,
    // while using one paired arm and one paired leg mesh instead of the
    // close-up component stack. The navigation and behavior rigs still
    // receive the same transform handles below.
    // Background actors keep the same two-mesh-per-side budget, but rounded
    // low-poly limb caps avoid the rectangular "action figure" silhouette at
    // street distance. Capsule dimensions preserve the previous 0.72 m arm
    // and 0.84 m leg envelopes, so existing pivots and gait amplitudes remain
    // unchanged while feet/hand ends catch a softer contact highlight.
    crowdArms: new THREE.CapsuleGeometry(0.085, 0.55, 2, 6),
    crowdLegs: new THREE.CapsuleGeometry(0.12, 0.6, 2, 6),
    hood: new THREE.TorusGeometry(0.145, 0.03, 5, 12),
    beanie: new THREE.SphereGeometry(0.19, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.54),
    capBrim: new THREE.BoxGeometry(0.18, 0.026, 0.11),
    ponytail: new THREE.SphereGeometry(0.085, 8, 6),
    bun: new THREE.SphereGeometry(0.07, 8, 6),
    parcel: new THREE.BoxGeometry(0.18, 0.15, 0.24),
    parcelTape: new THREE.BoxGeometry(0.19, 0.018, 0.055),
    cup: new THREE.CylinderGeometry(0.04, 0.033, 0.13, 8),
    cupSleeve: new THREE.CylinderGeometry(0.044, 0.038, 0.055, 8),
    cupLid: new THREE.CylinderGeometry(0.045, 0.045, 0.014, 8),
    phone: new THREE.BoxGeometry(0.075, 0.12, 0.012),
    camera: new THREE.BoxGeometry(0.12, 0.08, 0.14),
    lens: new THREE.CylinderGeometry(0.033, 0.033, 0.05, 8),
    broomHandle: new THREE.CylinderGeometry(0.018, 0.018, 0.86, 6),
    broomHead: new THREE.BoxGeometry(0.1, 0.035, 0.23),
    toolHandle: new THREE.BoxGeometry(0.035, 0.25, 0.035),
    toolHead: new THREE.BoxGeometry(0.15, 0.045, 0.045),
    hat: new THREE.SphereGeometry(0.2, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
    vest: new THREE.CylinderGeometry(0.21, 0.24, 0.44, 8, 1, true),
    cone: new THREE.ConeGeometry(0.07, 0.18, 8),
  };
}

function createHeroSkeleton() {
  const makeBone = (name, x, y, z) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    return bone;
  };
  const bones = [];
  bones[HERO_BONE.root] = makeBone('HeroRig', 0, 0, 0);
  bones[HERO_BONE.hips] = makeBone('Hips', 0, 0.98, 0);
  bones[HERO_BONE.spine] = makeBone('Spine', 0, 0.26, 0);
  bones[HERO_BONE.chest] = makeBone('Chest', 0, 0.28, 0);
  bones[HERO_BONE.neck] = makeBone('Neck', 0, 0.18, 0);
  bones[HERO_BONE.head] = makeBone('Head', 0, 0.205, 0);
  bones[HERO_BONE.leftUpperArm] = makeBone('LeftUpperArm', -0.3, 0.05, 0);
  bones[HERO_BONE.leftForearm] = makeBone('LeftForearm', 0, -0.4, 0);
  bones[HERO_BONE.leftHand] = makeBone('LeftHand', 0, -0.34, 0);
  bones[HERO_BONE.rightUpperArm] = makeBone('RightUpperArm', 0.3, 0.05, 0);
  bones[HERO_BONE.rightForearm] = makeBone('RightForearm', 0, -0.4, 0);
  bones[HERO_BONE.rightHand] = makeBone('RightHand', 0, -0.34, 0);
  bones[HERO_BONE.leftUpperLeg] = makeBone('LeftUpperLeg', -0.11, -0.05, 0);
  bones[HERO_BONE.leftShin] = makeBone('LeftShin', 0, -0.47, 0);
  bones[HERO_BONE.leftFoot] = makeBone('LeftFoot', 0, -0.43, 0);
  bones[HERO_BONE.rightUpperLeg] = makeBone('RightUpperLeg', 0.11, -0.05, 0);
  bones[HERO_BONE.rightShin] = makeBone('RightShin', 0, -0.47, 0);
  bones[HERO_BONE.rightFoot] = makeBone('RightFoot', 0, -0.43, 0);

  bones[HERO_BONE.root].add(bones[HERO_BONE.hips]);
  bones[HERO_BONE.hips].add(
    bones[HERO_BONE.spine],
    bones[HERO_BONE.leftUpperLeg],
    bones[HERO_BONE.rightUpperLeg],
  );
  bones[HERO_BONE.spine].add(bones[HERO_BONE.chest]);
  bones[HERO_BONE.chest].add(
    bones[HERO_BONE.neck],
    bones[HERO_BONE.leftUpperArm],
    bones[HERO_BONE.rightUpperArm],
  );
  bones[HERO_BONE.neck].add(bones[HERO_BONE.head]);
  bones[HERO_BONE.leftUpperArm].add(bones[HERO_BONE.leftForearm]);
  bones[HERO_BONE.leftForearm].add(bones[HERO_BONE.leftHand]);
  bones[HERO_BONE.rightUpperArm].add(bones[HERO_BONE.rightForearm]);
  bones[HERO_BONE.rightForearm].add(bones[HERO_BONE.rightHand]);
  bones[HERO_BONE.leftUpperLeg].add(bones[HERO_BONE.leftShin]);
  bones[HERO_BONE.leftShin].add(bones[HERO_BONE.leftFoot]);
  bones[HERO_BONE.rightUpperLeg].add(bones[HERO_BONE.rightShin]);
  bones[HERO_BONE.rightShin].add(bones[HERO_BONE.rightFoot]);
  return { bones, skeleton: new THREE.Skeleton(bones) };
}

function buildSkinnedHeroActor(geometry, materials, job, legacyRoot, actorIndex, visualVariant = null) {
  const root = new THREE.Group();
  root.name = `NPC hero rig / ${job.id}`;
  root.scale.copy(legacyRoot.scale);

  const materialSet = [
    materials.skin,
    materials.hair,
    job.id === 'worker' ? materials.accent : materials.top,
    materials.bottom,
    materials.shoes,
    materials.dark,
    materials.trim,
  ];
  const { bones, skeleton } = createHeroSkeleton();
  const body = new THREE.SkinnedMesh(geometry.heroBody, materialSet);
  body.name = 'Shared skinned adult body';
  body.add(bones[HERO_BONE.root]);
  body.bind(skeleton);
  body.normalizeSkinWeights();
  body.castShadow = false;
  body.receiveShadow = true;
  root.add(body);

  // Appearance-only variations use the actor-index/role seed, after the
  // legacy builder has consumed the original RNG stream. Crowd roles, paths
  // and activities therefore remain bit-for-bit deterministic across this
  // visual swap.
  const visual = visualVariant || createVisualVariant(actorIndex, job);
  const hairStyle = visual.hairStyle;
  const headwearStyle = visual.headwearStyle;
  const wearsScarf = visual.wearsScarf;
  const wearsGlasses = visual.wearsGlasses;
  if (hairStyle === 1) {
    const bun = addMesh(
      bones[HERO_BONE.head],
      geometry.bun,
      materials.hair,
      new THREE.Vector3(0, 0.13, -0.08),
      new THREE.Vector3(0.62, 0.72, 0.58),
    );
    bun.name = 'Tied hair silhouette';
  } else if (hairStyle === 2) {
    const ponytail = addMesh(
      bones[HERO_BONE.head],
      geometry.ponytail,
      materials.hair,
      new THREE.Vector3(0, -0.02, -0.13),
      new THREE.Vector3(0.58, 0.95, 0.5),
    );
    ponytail.name = 'Ponytail silhouette';
  }

  if (wearsScarf) {
    const scarf = addMesh(
      bones[HERO_BONE.neck],
      geometry.scarf,
      materials.scarf,
      new THREE.Vector3(0, -0.06, 0.02),
    );
    scarf.rotation.x = Math.PI * 0.5;
    const scarfTail = addMesh(
      bones[HERO_BONE.neck],
      geometry.scarfTail,
      materials.scarf,
      new THREE.Vector3(0.1, -0.28, 0.05),
    );
    scarfTail.rotation.z = -0.08;
    scarf.name = 'Low-poly scarf loop';
    scarfTail.name = 'Low-poly scarf tail';
  }
  if (job.id !== 'worker' && headwearStyle === 1) {
    const beanie = addMesh(
      bones[HERO_BONE.head],
      geometry.beanie,
      materials.headwear,
      new THREE.Vector3(0, 0.01, 0),
      new THREE.Vector3(1.08, 0.9, 1.02),
    );
    beanie.name = 'Ribbed beanie silhouette';
  } else if (job.id !== 'worker' && headwearStyle === 2) {
    const cap = addMesh(
      bones[HERO_BONE.head],
      geometry.hat,
      materials.headwear,
      new THREE.Vector3(0, 0.08, 0.01),
      new THREE.Vector3(0.98, 0.46, 0.98),
    );
    const brim = addMesh(
      bones[HERO_BONE.head],
      geometry.capBrim,
      materials.headwear,
      new THREE.Vector3(0, 0.065, 0.16),
      new THREE.Vector3(1.05, 1, 1),
    );
    cap.name = 'Soft cap silhouette';
    brim.name = 'Soft cap brim';
  }
  if (wearsGlasses) {
    for (const x of [-0.043, 0.043]) {
      addMesh(
        bones[HERO_BONE.head],
        geometry.glasses,
        materials.dark,
        new THREE.Vector3(x, 0.04, 0.133),
      );
    }
    addMesh(
      bones[HERO_BONE.head],
      geometry.brow,
      materials.dark,
      new THREE.Vector3(0, 0.04, 0.134),
      new THREE.Vector3(0.5, 0.7, 0.65),
    );
  }
  for (const footBone of [bones[HERO_BONE.leftFoot], bones[HERO_BONE.rightFoot]]) {
    const sole = addMesh(
      footBone,
      geometry.shoeSole,
      materials.dark,
      new THREE.Vector3(0, 0.035, 0.105),
      new THREE.Vector3(0.92, 0.62, 0.88),
    );
    sole.name = 'Hero shoe sole';
    const stripe = addMesh(
      footBone,
      geometry.shoeStripe,
      materials.shoeAccent,
      new THREE.Vector3(0, 0.058, 0.13),
      new THREE.Vector3(1.4, 0.82, 0.92),
    );
    stripe.name = 'Hero shoe contrast stripe';
  }

  addVisualWardrobeDetails({
    rig: bones[HERO_BONE.root],
    headPivot: bones[HERO_BONE.head],
    geometry,
    materials,
    job,
    variant: visual,
    heroDetail: true,
  });

  let prop = null;
  if (job.prop === 'parcel') {
    prop = new THREE.Group();
    addMesh(
      prop,
      geometry.parcel,
      materials.accent,
      new THREE.Vector3(0, 0, 0),
    );
    addMesh(prop, geometry.parcelTape, materials.trim, new THREE.Vector3(0, 0.085, 0));
    prop.scale.setScalar(visual.propScale * 1.22);
    prop.position.set(0.13, -0.49, 0.13);
    bones[HERO_BONE.rightUpperArm].add(prop);
  } else if (job.prop === 'coffee') {
    prop = new THREE.Group();
    addMesh(
      prop,
      geometry.cup,
      materials.roleAccent,
      new THREE.Vector3(0, 0, 0),
    );
    addMesh(prop, geometry.cupSleeve, materials.accent, new THREE.Vector3(0, -0.008, 0));
    addMesh(prop, geometry.cupLid, materials.trim, new THREE.Vector3(0, 0.071, 0));
    prop.scale.setScalar(visual.propScale * 1.2);
    prop.position.set(0.03, -0.72, 0.12);
    bones[HERO_BONE.rightUpperArm].add(prop);
  } else if (job.prop === 'phone') {
    prop = new THREE.Group();
    addMesh(
      prop,
      geometry.phone,
      materials.dark,
      new THREE.Vector3(0, 0, 0),
    );
    addMesh(
      prop,
      geometry.phone,
      materials.screen,
      new THREE.Vector3(0, 0, 0.008),
      new THREE.Vector3(0.74, 0.74, 0.2),
    );
    prop.scale.setScalar(visual.propScale * 1.16);
    prop.position.set(0, -0.68, 0.13);
    bones[HERO_BONE.rightUpperArm].add(prop);
  } else if (job.prop === 'camera') {
    prop = new THREE.Group();
    addMesh(
      prop,
      geometry.camera,
      materials.dark,
      new THREE.Vector3(0, 0, 0),
    );
    const lens = addMesh(prop, geometry.lens, materials.screen, new THREE.Vector3(0, 0, 0.09));
    lens.rotation.x = Math.PI * 0.5;
    prop.scale.setScalar(visual.propScale * 1.2);
    prop.position.set(0, -0.62, 0.14);
    bones[HERO_BONE.rightUpperArm].add(prop);
  } else if (job.prop === 'broom') {
    prop = new THREE.Group();
    addMesh(
      prop,
      geometry.broomHandle,
      materials.accent,
      new THREE.Vector3(0, 0.43, 0),
    );
    const broomHead = addMesh(prop, geometry.broomHead, materials.dark, new THREE.Vector3(0, 0, 0));
    broomHead.rotation.y = Math.PI * 0.5;
    prop.scale.setScalar(visual.propScale * 1.1);
    prop.rotation.z = -0.18;
    prop.position.set(0.2, -1.49, 0);
    bones[HERO_BONE.rightUpperArm].add(prop);
  } else if (job.prop === 'worker') {
    prop = new THREE.Group();
    addMesh(prop, geometry.toolHandle, materials.accent, new THREE.Vector3(0, -0.1, 0));
    addMesh(prop, geometry.toolHead, materials.metal, new THREE.Vector3(0, 0.035, 0));
    prop.scale.setScalar(visual.propScale * 1.1);
    prop.position.set(0.16, -0.62, 0.03);
    bones[HERO_BONE.rightUpperArm].add(prop);
  }

  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = true;
  });

  const legacyData = legacyRoot.userData;
  root.userData = {
    rig: bones[HERO_BONE.root],
    head: bones[HERO_BONE.head],
    headPivot: bones[HERO_BONE.head],
    body: bones[HERO_BONE.spine],
    leftArm: bones[HERO_BONE.leftUpperArm],
    rightArm: bones[HERO_BONE.rightUpperArm],
    leftForearm: bones[HERO_BONE.leftForearm],
    rightForearm: bones[HERO_BONE.rightForearm],
    leftHand: bones[HERO_BONE.leftHand],
    rightHand: bones[HERO_BONE.rightHand],
    leftLeg: bones[HERO_BONE.leftUpperLeg],
    rightLeg: bones[HERO_BONE.rightUpperLeg],
    leftShin: bones[HERO_BONE.leftShin],
    rightShin: bones[HERO_BONE.rightShin],
    leftFoot: bones[HERO_BONE.leftFoot],
    rightFoot: bones[HERO_BONE.rightFoot],
    leftHipY: bones[HERO_BONE.leftUpperLeg].position.y,
    rightHipY: bones[HERO_BONE.rightUpperLeg].position.y,
    leftHipX: bones[HERO_BONE.leftUpperLeg].position.x,
    rightHipX: bones[HERO_BONE.rightUpperLeg].position.x,
    prop,
    groundOffset: 0,
    armSwing: legacyData.armSwing,
    stride: legacyData.stride,
    headBias: legacyData.headBias,
    silhouette: legacyData.silhouette,
    heroDetail: true,
    footNeutralX: 0,
    leftFootY: bones[HERO_BONE.leftFoot].position.y,
    rightFootY: bones[HERO_BONE.rightFoot].position.y,
    leftFootZ: bones[HERO_BONE.leftFoot].position.z,
    rightFootZ: bones[HERO_BONE.rightFoot].position.z,
    skinnedBody: body,
    visualVariant: visual,
  };
  return root;
}

function buildActor(geometry, materialLibrary, rng, job, heroDetail = false, actorIndex = 0) {
  const visualVariant = createVisualVariant(actorIndex, job);
  const materials = createMaterials(rng, job, heroDetail, materialLibrary);
  const root = new THREE.Group();
  root.name = `NPC / ${job.id}`;
  // A wider adult range stops the crowd reading as one duplicated doll at a
  // distance. The shared skeleton keeps this cheap while the scale changes
  // height, shoulder width, head shape, and stance independently.
  const height = 0.85 + rng() * 0.18;
  const build = 0.92 + rng() * 0.22;
  const shoulderWidth = 0.98 + rng() * 0.22;
  // The earlier head-to-body ratio skewed toy-like at the player camera.
  // Keep adults around seven head heights, then recover silhouette variety
  // through hair and outerwear rather than oversized heads.
  const headWidth = 0.78 + rng() * 0.13;
  const silhouette = Math.floor(rng() * 4);
  const hairStyle = Math.floor(rng() * (heroDetail ? 5 : 3));
  const headwearStyle = job.id === 'worker' ? 0 : Math.floor(rng() * (heroDetail ? 4 : 3));
  const wearsScarf = job.id !== 'worker' && rng() < (heroDetail ? 0.28 : 0.12);
  const wearsGlasses = job.id === 'tourist' || rng() < (heroDetail ? 0.2 : 0.07);
  const longSleeves = rng() < 0.78;
  const outerwear = silhouette === 1
    ? rng() < (heroDetail ? 0.72 : 0.48)
    : rng() < (heroDetail ? 0.36 : 0.16);
  const hooded = outerwear && rng() < (heroDetail ? 0.34 : 0.18);

  // The background crowd remains fully simulated and collision-aware, but it
  // does not need the close-up wardrobe/face stack. Consume the same visual
  // RNG decisions as the legacy builder before switching to the bounded
  // silhouette so route assignment remains deterministic.
  if (!heroDetail) {
    const torsoDepth = 0.84 + rng() * 0.1;
    const headHeight = 0.88 + rng() * 0.09;
    const headDepth = 0.88 + rng() * 0.08;
    rng(); // Background shoe accent decision.
    if (job.id === 'commuter') {
      const existingBackpack = rng() < 0.42;
      if (!existingBackpack && !outerwear) rng();
    } else if (!outerwear) {
      rng();
    }

    const root = new THREE.Group();
    root.name = `NPC / ${job.id}`;
    root.scale.set(
      build * visualVariant.bodyWidthScale,
      height,
      build * visualVariant.bodyDepthScale,
    );
    const rig = new THREE.Group();
    root.add(rig);

    // Drop torso slightly so hip pivots read attached under the waist.
    const torso = addMesh(rig, geometry.torso, materials.top, new THREE.Vector3(0, 1.0, 0));
    torso.scale.set(shoulderWidth, silhouette === 3 ? 1.1 : 1.04, torsoDepth);
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 1.84, 0);
    rig.add(headPivot);
    const head = addMesh(headPivot, geometry.head, materials.skin, new THREE.Vector3());
    head.scale.set(headWidth, headHeight, headDepth);
    const hair = addMesh(headPivot, geometry.hair, materials.hair, new THREE.Vector3(0, 0.08, -0.01));
    hair.scale.set(headWidth * 1.13, [0.66, 0.9, 0.78][hairStyle] || 0.78, 0.98);

    // Independent L/R limbs so procedural gait can alternate (shared legRig
    // previously overwrote left swing with right, reading as a hop).
    const leftArm = new THREE.Group();
    leftArm.position.set(-0.28 * shoulderWidth, 1.28, 0);
    rig.add(leftArm);
    const leftArmMesh = addMesh(
      leftArm,
      geometry.crowdArms,
      materials.top,
      new THREE.Vector3(0, -0.36, 0),
    );
    leftArmMesh.scale.set(0.9, 1, 0.88);
    const rightArm = new THREE.Group();
    rightArm.position.set(0.28 * shoulderWidth, 1.28, 0);
    rig.add(rightArm);
    const rightArmMesh = addMesh(
      rightArm,
      geometry.crowdArms,
      materials.top,
      new THREE.Vector3(0, -0.36, 0),
    );
    rightArmMesh.scale.set(0.9, 1, 0.88);

    const leftLeg = new THREE.Group();
    // Hip pivot tucked under shortened torso so swing doesn't open a waist gap.
    leftLeg.position.set(-0.14, 0.68, 0);
    rig.add(leftLeg);
    const leftLegMesh = addMesh(
      leftLeg,
      geometry.crowdLegs,
      materials.bottom,
      new THREE.Vector3(0, -0.5, 0),
    );
    leftLegMesh.scale.set(1, 1.05, 1);
    const rightLeg = new THREE.Group();
    rightLeg.position.set(0.14, 0.68, 0);
    rig.add(rightLeg);
    const rightLegMesh = addMesh(
      rightLeg,
      geometry.crowdLegs,
      materials.bottom,
      new THREE.Vector3(0, -0.5, 0),
    );
    rightLegMesh.scale.set(1, 1, 1);

    const emptyForearm = new THREE.Group();
    const emptyHand = new THREE.Group();
    const emptyShin = new THREE.Group();
    const emptyFoot = new THREE.Group();
    root.userData = {
      rig,
      head,
      headPivot,
      body: torso,
      leftArm,
      rightArm,
      leftForearm: emptyForearm,
      rightForearm: emptyForearm,
      leftHand: emptyHand,
      rightHand: emptyHand,
      leftLeg,
      rightLeg,
      leftShin: emptyShin,
      rightShin: emptyShin,
      leftFoot: emptyFoot,
      rightFoot: emptyFoot,
      leftHipY: leftLeg.position.y,
      rightHipY: rightLeg.position.y,
      leftHipX: leftLeg.position.x,
      rightHipX: rightLeg.position.x,
      prop: null,
      groundOffset: 0,
      armSwing: 0.86 + rng() * 0.22,
      stride: 0.92 + rng() * 0.14,
      headBias: (rng() - 0.5) * 0.14,
      silhouette,
      heroDetail: false,
      footNeutralX: 0,
      leftFootY: 0,
      rightFootY: 0,
      leftFootZ: 0,
      rightFootZ: 0,
      leftShoeStripe: null,
      rightShoeStripe: null,
      visualVariant,
    };
    return root;
  }

  root.scale.set(
    build * visualVariant.bodyWidthScale,
    height,
    build * visualVariant.bodyDepthScale,
  );
  const rig = new THREE.Group();
  root.add(rig);

  const torso = addMesh(rig, geometry.torso, materials.top, new THREE.Vector3(0, 1.24, 0));
  torso.scale.set(shoulderWidth, silhouette === 3 ? 1.06 : 1, 0.84 + rng() * 0.1);
  if (heroDetail) {
    // One shared yoke bridges the chest and sleeves. It makes the shoulder
    // line legible in a close view without assigning a unique garment mesh to
    // every actor in the 48-person pool.
    const yoke = addMesh(rig, geometry.shoulderYoke, materials.top, new THREE.Vector3(0, 1.55, 0));
    yoke.scale.set(shoulderWidth, 1, 0.82);
  }
  addMesh(rig, geometry.neck, materials.skin, new THREE.Vector3(0, 1.76, 0));

  const headPivot = new THREE.Group();
  headPivot.position.set(0, 1.94, 0);
  rig.add(headPivot);
  const head = addMesh(headPivot, geometry.head, materials.skin, new THREE.Vector3());
  head.scale.set(headWidth, 0.88 + rng() * 0.09, 0.88 + rng() * 0.08);
  if (heroDetail) {
    const facePlane = addMesh(
      headPivot,
      geometry.facePlane,
      materials.skin,
      new THREE.Vector3(0, -0.008, 0.128),
      new THREE.Vector3(headWidth * 0.84, 0.93, 0.2),
    );
    facePlane.rotation.y = (silhouette - 1.5) * 0.035;
  }
  const hair = addMesh(headPivot, geometry.hair, materials.hair, new THREE.Vector3(0, 0.08, -0.01));
  const hairHeight = [0.66, 0.9, 0.78, 1.02, 0.82][hairStyle];
  hair.scale.set(headWidth * 1.13, hairHeight, 0.98);
  if (hairStyle === 1 || hairStyle === 3) {
    const hairBack = addMesh(headPivot, geometry.hairBack, materials.hair, new THREE.Vector3(0, -0.035, -0.12));
    hairBack.scale.set(1.08, hairStyle === 3 ? 1.82 : 1.32, 0.6);
  }
  if (heroDetail && hairStyle === 2) {
    const ponytail = addMesh(headPivot, geometry.ponytail, materials.hair, new THREE.Vector3(0, -0.055, -0.19));
    ponytail.scale.set(0.9, 1.5, 0.78);
  } else if (heroDetail && hairStyle === 4) {
    addMesh(headPivot, geometry.bun, materials.hair, new THREE.Vector3(0, 0.18, -0.11));
  }
  if (wearsScarf) {
    const scarf = addMesh(rig, geometry.scarf, materials.scarf, new THREE.Vector3(0, 1.67, 0.02));
    scarf.rotation.x = Math.PI * 0.5;
    const scarfTail = addMesh(rig, geometry.scarfTail, materials.scarf, new THREE.Vector3(0.1, 1.42, 0.08));
    scarfTail.rotation.z = -0.08;
    scarf.name = 'Scarf loop';
    scarfTail.name = 'Scarf tail';
  }
  if (job.id !== 'worker' && headwearStyle === 1) {
    const beanie = addMesh(
      headPivot,
      geometry.beanie,
      materials.headwear,
      new THREE.Vector3(0, 0.02, 0),
      new THREE.Vector3(headWidth * 1.06, 0.88, 1.02),
    );
    beanie.name = 'Beanie silhouette';
  } else if (job.id !== 'worker' && headwearStyle === 2) {
    const cap = addMesh(
      headPivot,
      geometry.hat,
      materials.headwear,
      new THREE.Vector3(0, 0.1, 0.01),
      new THREE.Vector3(headWidth * 1.05, 0.48, 0.98),
    );
    const brim = addMesh(
      headPivot,
      geometry.capBrim,
      materials.headwear,
      new THREE.Vector3(0, 0.08, 0.17),
      new THREE.Vector3(headWidth * 1.05, 1, 1),
    );
    cap.name = 'Cap silhouette';
    brim.name = 'Cap brim';
  }
  const nose = addMesh(headPivot, geometry.nose, materials.skin, new THREE.Vector3(0, -0.005, 0.17));
  nose.rotation.x = Math.PI * 0.5;
  if (heroDetail) {
    for (const x of [-0.061, 0.061]) {
      addMesh(headPivot, geometry.eyeWhite, materials.eyeWhite, new THREE.Vector3(x, 0.035, 0.153), new THREE.Vector3(1, 0.72, 0.42));
      addMesh(headPivot, geometry.eye, materials.eye, new THREE.Vector3(x, 0.035, 0.169));
    }
  } else {
    addMesh(headPivot, geometry.eye, materials.eye, new THREE.Vector3(-0.061, 0.035, 0.154));
    addMesh(headPivot, geometry.eye, materials.eye, new THREE.Vector3(0.061, 0.035, 0.154));
  }
  if (heroDetail) {
    addMesh(headPivot, geometry.ear, materials.skin, new THREE.Vector3(-0.132, 0, 0));
    addMesh(headPivot, geometry.ear, materials.skin, new THREE.Vector3(0.132, 0, 0));
    for (const x of [-0.061, 0.061]) {
      const brow = addMesh(headPivot, geometry.brow, materials.hair, new THREE.Vector3(x, 0.085, 0.157));
      brow.rotation.z = x < 0 ? -0.04 : 0.04;
    }
    addMesh(headPivot, geometry.mouth, materials.lip, new THREE.Vector3(0, -0.085, 0.16));
  }
  if (wearsGlasses) {
    for (const x of [-0.058, 0.058]) {
      addMesh(headPivot, geometry.glasses, materials.dark, new THREE.Vector3(x, 0.038, 0.163));
    }
    if (heroDetail) {
      addMesh(
        headPivot,
        geometry.brow,
        materials.dark,
        new THREE.Vector3(0, 0.038, 0.164),
        new THREE.Vector3(0.58, 0.66, 0.7),
      );
    }
  }

  const leftArm = new THREE.Group();
  const rightArm = new THREE.Group();
  leftArm.position.set(-0.25 * shoulderWidth, 1.48, 0);
  rightArm.position.set(0.25 * shoulderWidth, 1.48, 0);
  rig.add(leftArm, rightArm);
  addMesh(leftArm, geometry.upperArm, materials.top, new THREE.Vector3(0, -0.22, 0));
  addMesh(rightArm, geometry.upperArm, materials.top, new THREE.Vector3(0, -0.22, 0));
  const leftForearm = new THREE.Group();
  const rightForearm = new THREE.Group();
  leftForearm.position.y = -0.42;
  rightForearm.position.y = -0.42;
  leftArm.add(leftForearm);
  rightArm.add(rightForearm);
  addMesh(leftForearm, geometry.lowerArm, longSleeves ? materials.top : materials.skin, new THREE.Vector3(0, -0.18, 0));
  addMesh(rightForearm, geometry.lowerArm, longSleeves ? materials.top : materials.skin, new THREE.Vector3(0, -0.18, 0));
  if (heroDetail && longSleeves) {
    const leftCuff = addMesh(leftForearm, geometry.cuff, materials.trim, new THREE.Vector3(0, -0.345, 0));
    const rightCuff = addMesh(rightForearm, geometry.cuff, materials.trim, new THREE.Vector3(0, -0.345, 0));
    leftCuff.rotation.x = Math.PI * 0.5;
    rightCuff.rotation.x = Math.PI * 0.5;
  }
  const leftHand = addMesh(leftForearm, heroDetail ? geometry.palm : geometry.hand, materials.skin, new THREE.Vector3(0, -0.39, 0));
  const rightHand = addMesh(rightForearm, heroDetail ? geometry.palm : geometry.hand, materials.skin, new THREE.Vector3(0, -0.39, 0));
  leftHand.scale.set(heroDetail ? 0.94 : 0.8, heroDetail ? 1.08 : 1, heroDetail ? 0.8 : 0.68);
  rightHand.scale.copy(leftHand.scale);
  if (heroDetail) {
    for (const x of [-0.018, 0.018]) {
      addMesh(leftForearm, geometry.finger, materials.skin, new THREE.Vector3(x, -0.45, 0.025));
      addMesh(rightForearm, geometry.finger, materials.skin, new THREE.Vector3(x, -0.45, 0.025));
    }
  }

  const leftLeg = new THREE.Group();
  const rightLeg = new THREE.Group();
  const hipWidth = 0.1 + (shoulderWidth - 0.88) * 0.11;
  leftLeg.position.set(-hipWidth, 0.86, 0);
  rightLeg.position.set(hipWidth, 0.86, 0);
  rig.add(leftLeg, rightLeg);
  addMesh(leftLeg, geometry.upperLeg, materials.bottom, new THREE.Vector3(0, -0.24, 0));
  addMesh(rightLeg, geometry.upperLeg, materials.bottom, new THREE.Vector3(0, -0.24, 0));
  const leftShin = new THREE.Group();
  const rightShin = new THREE.Group();
  leftShin.position.y = -0.46;
  rightShin.position.y = -0.46;
  leftLeg.add(leftShin);
  rightLeg.add(rightShin);
  addMesh(leftShin, geometry.lowerLeg, materials.bottom, new THREE.Vector3(0, -0.21, 0));
  const leftFoot = addMesh(leftShin, geometry.foot, materials.shoes, new THREE.Vector3(0, -0.32, 0.085));
  addMesh(rightShin, geometry.lowerLeg, materials.bottom, new THREE.Vector3(0, -0.21, 0));
  const rightFoot = addMesh(rightShin, geometry.foot, materials.shoes, new THREE.Vector3(0, -0.32, 0.085));
  leftFoot.rotation.x = Math.PI * 0.5;
  rightFoot.rotation.x = Math.PI * 0.5;
  leftFoot.scale.set(heroDetail ? 0.98 : 0.92, heroDetail ? 0.98 : 0.94, heroDetail ? 0.9 : 0.82);
  rightFoot.scale.copy(leftFoot.scale);
  let leftShoeStripe = null;
  let rightShoeStripe = null;
  if (heroDetail) {
    const leftSole = addMesh(leftShin, geometry.shoeSole, materials.dark, new THREE.Vector3(0, -0.365, 0.095));
    const rightSole = addMesh(rightShin, geometry.shoeSole, materials.dark, new THREE.Vector3(0, -0.365, 0.095));
    const leftToe = addMesh(leftShin, geometry.shoeToe, materials.shoes, new THREE.Vector3(0, -0.34, 0.205));
    const rightToe = addMesh(rightShin, geometry.shoeToe, materials.shoes, new THREE.Vector3(0, -0.34, 0.205));
    leftSole.scale.set(0.94, 1, 0.88);
    rightSole.scale.copy(leftSole.scale);
    leftToe.scale.set(0.9, 0.42, 0.68);
    rightToe.scale.copy(leftToe.scale);
  }
  if (heroDetail || rng() < 0.18) {
    leftShoeStripe = addMesh(leftShin, geometry.shoeStripe, materials.shoeAccent, new THREE.Vector3(0, -0.39, 0.13));
    rightShoeStripe = addMesh(rightShin, geometry.shoeStripe, materials.shoeAccent, new THREE.Vector3(0, -0.39, 0.13));
    leftShoeStripe.scale.set(heroDetail ? 1.25 : 0.9, 0.72, heroDetail ? 0.92 : 0.78);
    rightShoeStripe.scale.copy(leftShoeStripe.scale);
  }
  if (heroDetail && (silhouette === 2 || (silhouette === 3 && rng() < 0.32))) {
    const skirt = addMesh(rig, geometry.skirt, materials.bottom, new THREE.Vector3(0, 0.79, 0));
    skirt.scale.set(0.96 + (shoulderWidth - 0.9) * 0.28, 1, 0.78);
  }

  if (heroDetail && !outerwear && rng() < 0.72) {
    const collar = addMesh(rig, geometry.collar, materials.trim, new THREE.Vector3(0, 1.59, 0.03));
    collar.rotation.x = Math.PI * 0.5;
    for (let buttonIndex = 0; buttonIndex < 3; buttonIndex += 1) {
      addMesh(rig, geometry.button, materials.metal, new THREE.Vector3(0, 1.42 - buttonIndex * 0.13, 0.19));
    }
  }
  if (outerwear) {
    const coat = addMesh(rig, geometry.coat, materials.top, new THREE.Vector3(0, 1.18, -0.004));
    coat.scale.set(shoulderWidth * 1.03, 1.04, 0.78);
    const hem = addMesh(rig, geometry.jacketHem, materials.top, new THREE.Vector3(0, 0.98, 0));
    hem.scale.set(shoulderWidth * 1.04, 1, 0.82);
    for (const x of [-0.105, 0.105]) {
      const lapel = addMesh(rig, geometry.lapel, materials.trim, new THREE.Vector3(x, 1.43, 0.215));
      lapel.rotation.z = x < 0 ? -0.31 : 0.31;
    }
    if (hooded) {
      const hood = addMesh(rig, geometry.hood, materials.top, new THREE.Vector3(0, 1.58, -0.015));
      hood.rotation.x = Math.PI * 0.5;
      hood.scale.set(1.08, 1, 0.96);
      hood.name = 'Hood rim silhouette';
    }
  }

  let existingBackpack = false;
  if (job.id === 'commuter' && rng() < 0.42) {
    existingBackpack = true;
    const backpack = addMesh(rig, geometry.backpack, materials.dark, new THREE.Vector3(0, 1.28, -0.18));
    backpack.scale.set(0.85, 0.92, 0.58);
  } else if (!outerwear && rng() < (heroDetail ? 0.34 : 0.13)) {
    const coat = addMesh(rig, geometry.coat, materials.top, new THREE.Vector3(0, 1.18, 0));
    coat.scale.z = 0.72;
  }
  if (heroDetail && (job.id === 'courier' || (job.id === 'commuter' && rng() < 0.34))) {
    const strap = addMesh(rig, geometry.strap, materials.bag, new THREE.Vector3(0.08, 1.36, 0.19));
    strap.rotation.z = 0.48;
    const bag = addMesh(rig, geometry.messengerBag, materials.bag, new THREE.Vector3(-0.16, 1.0, 0.19));
    bag.rotation.y = -0.1;
  } else if (heroDetail && job.id === 'barista') {
    const tote = addMesh(rig, geometry.tote, materials.bag, new THREE.Vector3(-0.29, 1.01, 0.04));
    tote.rotation.z = -0.08;
  }

  if (!heroDetail) {
    addVisualWardrobeDetails({
      rig,
      headPivot,
      geometry,
      materials,
      job,
      variant: visualVariant,
      existingOuterwear: outerwear,
      existingBackpack,
    });
  }

  let prop = null;
  if (job.prop === 'parcel') {
    prop = new THREE.Group();
    const parcel = addMesh(prop, geometry.parcel, materials.accent, new THREE.Vector3(0, 0, 0));
    parcel.scale.set(1.12, 1.08, 1.08);
    addMesh(prop, geometry.parcelTape, materials.trim, new THREE.Vector3(0, 0.085, 0));
    prop.scale.setScalar(visualVariant.propScale * 1.14);
    prop.position.set(0.13, -0.48, 0.12);
    rightArm.add(prop);
  } else if (job.prop === 'coffee') {
    prop = new THREE.Group();
    addMesh(prop, geometry.cup, materials.roleAccent, new THREE.Vector3(0, 0, 0));
    addMesh(prop, geometry.cupSleeve, materials.accent, new THREE.Vector3(0, -0.008, 0));
    addMesh(prop, geometry.cupLid, materials.trim, new THREE.Vector3(0, 0.071, 0));
    prop.scale.setScalar(visualVariant.propScale * 1.14);
    prop.position.set(0.03, -0.72, 0.13);
    rightArm.add(prop);
  } else if (job.prop === 'phone') {
    prop = new THREE.Group();
    addMesh(prop, geometry.phone, materials.dark, new THREE.Vector3(0, 0, 0));
    addMesh(prop, geometry.phone, materials.screen, new THREE.Vector3(0, 0, 0.008), new THREE.Vector3(0.74, 0.74, 0.2));
    prop.scale.setScalar(visualVariant.propScale * 1.1);
    prop.position.set(0, -0.68, 0.16);
    rightArm.add(prop);
  } else if (job.prop === 'camera') {
    prop = new THREE.Group();
    addMesh(prop, geometry.camera, materials.dark, new THREE.Vector3(0, 0, 0));
    const lens = addMesh(prop, geometry.lens, materials.screen, new THREE.Vector3(0, 0, 0.09));
    lens.rotation.x = Math.PI * 0.5;
    prop.scale.setScalar(visualVariant.propScale * 1.14);
    prop.position.set(0, -0.62, 0.18);
    rightArm.add(prop);
  } else if (job.prop === 'broom') {
    prop = new THREE.Group();
    const handle = addMesh(prop, geometry.broomHandle, materials.accent, new THREE.Vector3(0, 0.43, 0));
    const head = addMesh(prop, geometry.broomHead, materials.dark, new THREE.Vector3(0, 0, 0));
    head.rotation.y = Math.PI * 0.5;
    prop.scale.setScalar(visualVariant.propScale * 1.08);
    prop.rotation.z = -0.22;
    prop.position.set(0.22, -1.24, 0);
    rightArm.add(prop);
    void handle;
  } else if (job.prop === 'worker') {
    const vest = addMesh(rig, geometry.vest, materials.accent, new THREE.Vector3(0, 1.25, 0));
    vest.material.side = THREE.DoubleSide;
    const hat = addMesh(headPivot, geometry.hat, materials.accent, new THREE.Vector3(0, 0.18, 0));
    hat.scale.setScalar(0.9);
    prop = new THREE.Group();
    addMesh(prop, geometry.toolHandle, materials.accent, new THREE.Vector3(0, -0.1, 0));
    addMesh(prop, geometry.toolHead, materials.metal, new THREE.Vector3(0, 0.035, 0));
    prop.scale.setScalar(visualVariant.propScale * 1.08);
    prop.position.set(0.18, -0.62, 0.03);
    rightArm.add(prop);
  }

  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = true;
  });

  root.userData = {
    rig,
    head,
    headPivot,
    body: torso,
    leftArm,
    rightArm,
    leftForearm,
    rightForearm,
    leftHand,
    rightHand,
    leftLeg,
    rightLeg,
    leftShin,
    rightShin,
    leftFoot,
    rightFoot,
    leftHipY: leftLeg.position.y,
    rightHipY: rightLeg.position.y,
    leftHipX: leftLeg.position.x,
    rightHipX: rightLeg.position.x,
    prop,
    groundOffset: 0,
    armSwing: 0.86 + rng() * 0.22,
    stride: 0.92 + rng() * 0.14,
    headBias: (rng() - 0.5) * 0.14,
    silhouette,
    heroDetail,
    footNeutralX: Math.PI * 0.5,
    leftFootY: leftFoot.position.y,
    rightFootY: rightFoot.position.y,
    leftFootZ: leftFoot.position.z,
    rightFootZ: rightFoot.position.z,
    leftShoeStripe,
    rightShoeStripe,
    leftShoeStripeY: leftShoeStripe?.position.y,
    rightShoeStripeY: rightShoeStripe?.position.y,
    leftShoeStripeZ: leftShoeStripe?.position.z,
    rightShoeStripeZ: rightShoeStripe?.position.z,
    visualVariant,
  };
  return heroDetail
    ? buildSkinnedHeroActor(geometry, materials, job, root, actorIndex, visualVariant)
    : root;
}

let sharedHeroAvatarResources = null;

function getHeroAvatarResources() {
  if (!sharedHeroAvatarResources) {
    sharedHeroAvatarResources = {
      geometry: createSharedGeometry(),
      materials: createMaterialLibrary(),
    };
  }
  return sharedHeroAvatarResources;
}

/**
 * Builds a standalone player-grade hero using the same shared skinned rig and
 * wardrobe stack as the authored close-range crowd. The shared geometry and
 * material library stay live for the pedestrian pool, so callers must not
 * dispose them per-actor.
 */
export function createHeroPlayerAvatar({
  name = 'Traveler',
  jobId = 'commuter',
  variantSeed = 0,
  scale = 1,
} = {}) {
  const resources = getHeroAvatarResources();
  const job = JOBS.find((candidate) => candidate.id === jobId) || JOBS[0];
  const seed = (0x51f00d42 ^ Math.imul(((Number(variantSeed) || 0) >>> 0) + 1, 0x9e3779b1)) >>> 0;
  const rng = mulberry32(seed);
  const root = buildActor(
    resources.geometry,
    resources.materials,
    rng,
    job,
    true,
    Number(variantSeed) >>> 0,
  );
  root.name = `Player hero rig / ${name}`;
  root.scale.setScalar(Number.isFinite(scale) && scale > 0 ? scale : 1);
  root.userData.phase = 0;
  root.userData.gaitBlend = 0;
  root.userData.playerRig = true;
  root.userData.heroDetail = true;
  return root;
}

function pointsForPath(path) {
  if (Array.isArray(path)) return path;
  if (Array.isArray(path?.points)) return path.points;
  if (Array.isArray(path?.waypoints)) return path.waypoints;
  return [];
}

function createContactShadowTexture() {
  // A small radial alpha map gives every pooled person a soft shoe-level
  // grounding cue without enabling hundreds of expensive shadow casters.
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const gradient = context.createRadialGradient(32, 32, 4, 32, 32, 30);
  gradient.addColorStop(0, 'rgba(255,255,255,0.92)');
  gradient.addColorStop(0.48, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

function createData(mesh, job, index, rng, hero = false) {
  const roleSpeed = JOB_SPEED_FACTOR[job.id] ?? 1;
  const schedule = roleScheduleFor(job);
  const preferredLane = ROLE_SIDEWALK_LANES[job.id] ?? 0;
  const laneOffset = THREE.MathUtils.clamp(
    preferredLane + (rng() - 0.5) * 0.14,
    -0.52,
    0.52,
  );
  return {
    mesh,
    job,
    schedule,
    state: STATE_WALK,
    path: null,
    segment: 0,
    direction: rng() > 0.5 ? 1 : -1,
    t: rng(),
    speed: (WALK_SPEED + (rng() - 0.5) * WALK_SPEED_VARIANCE) * roleSpeed,
    walkPace: THREE.MathUtils.clamp(12 / randomRange(rng, schedule.walk), 0.82, 1.2),
    phase: rng() * Math.PI * 2,
    cadence: (0.92 + rng() * 0.18) * (job.id === 'courier' ? 1.08 : job.id === 'tourist' ? 0.9 : 1),
    gaitBlend: 0,
    gazePhase: rng() * Math.PI * 2,
    laneOffset,
    laneOffsetHome: laneOffset,
    // Impatience scales how quickly a waiting pedestrian talks themselves
    // into crossing on the flashing hand; it also shortens curb hesitation.
    impatience: rng(),
    heading: rng() * Math.PI * 2,
    turnRate: 0,
    turnIntent: 0,
    grade: 0,
    groundY: 0,
    stepPulse: 0,
    timer: 0,
    crossing: null,
    transfer: null,
    hero,
    visualVariant: mesh.userData.visualVariant || null,
    beautyRoute: false,
    vignette: null,
    interaction: null,
    stationAnchor: null,
    destination: null,
    destinationKind: schedule.destination,
    destinationReached: false,
    stopCount: 0,
    index,
    behaviorTree: createTreeForRole(job.id),
    blackboard: createBlackboard({
      roleId: job.id,
      atCrossing: false,
      signalClear: false,
      atDestination: false,
      preferWork: Boolean(job.prop),
      handoffReady: false,
      weather: 'clear',
      intent: 'walk',
      animCue: 'commute-stride',
      urgency: 0.55,
    }),
  };
}

export function createPedestrianSystem({
  scene,
  sidewalkNetwork,
  onPlayerCrowdContact,
} = {}) {
  if (!scene?.isScene) throw new TypeError('createPedestrianSystem requires a THREE.Scene.');

  const group = new THREE.Group();
  group.name = 'Living San Francisco pedestrians';
  scene.add(group);

  const rng = mulberry32(0x51f00d42);
  const geometry = createSharedGeometry();
  const materialLibrary = createMaterialLibrary();
  const paths = Array.isArray(sidewalkNetwork?.paths) ? sidewalkNetwork.paths : [];
  const crossings = Array.isArray(sidewalkNetwork?.crossings) ? sidewalkNetwork.crossings : [];
  const avenuePoints = new Map();
  for (const path of paths) {
    for (const point of pointsForPath(path)) {
      if (point.x < 15 || point.x > 43 || point.z < -15 || point.z > 60) continue;
      const key = point.x.toFixed(2);
      if (!avenuePoints.has(key)) avenuePoints.set(key, []);
      if (!avenuePoints.get(key).some((candidate) => Math.abs(candidate.z - point.z) < 0.1)) {
        avenuePoints.get(key).push(point.clone());
      }
    }
  }
  const beautyRoutes = [...avenuePoints.values()]
    .filter((route) => route.length >= 3)
    .map((route) => route.sort((a, b) => a.z - b.z))
    .sort((a, b) => a[0].x - b[0].x)
    .slice(0, 2);
  const farAvenueRoutes = beautyRoutes
    .map((route) => route.filter((point) => point.z >= 31))
    .filter((route) => route.length >= 2);
  const backgroundPaths = paths.filter((path) => !pointsForPath(path).some((point) => (
    point.x > 10 && point.x < 48 && point.z < 48
  )));
  const pool = [];
  const crowdGrid = new Map();
  const crowdBuckets = Array.from({ length: POOL_SIZE }, () => []);
  const activeCrowdBuckets = [];
  let focusActive = false;
  let focusX = 0;
  let focusZ = 0;
  let focusRadiusSquared = Infinity;
  let qaSoloGroupIndex = null;
  let qaForceWalkIndex = null;
  let qaWitnessResidentId = null;
  let qaWitnessPosition = null;
  let onFootPlayerCollisionProbe = null;
  let onFootPlayerCollisionLatch = new Set();
  let qaPlayerContactStage = null;
  const onFootPlayerContactDiagnostics = {
    probes: 0,
    contactTests: 0,
    corrections: 0,
    contacts: 0,
    rearmed: 0,
    yields: 0,
    lastProbe: null,
    lastCorrection: null,
    lastContact: null,
  };

  // Enrich each crosswalk with the traffic-signal context it needs to time
  // pedestrian phases realistically. A crossing over the east-west roadway
  // (delta mostly along Z) is open to walkers while north-south traffic
  // holds group 0; the crossing over the north-south roadway follows group 1.
  for (const crossing of crossings) {
    const rawEntry = crossing?.entry || crossing?.start || crossing?.from;
    const rawExit = crossing?.exit || crossing?.end || crossing?.to;
    if (!rawEntry?.isVector3 || !rawExit?.isVector3) continue;
    crossing.phaseGroup = Math.abs(rawExit.z - rawEntry.z) >= Math.abs(rawExit.x - rawEntry.x) ? 0 : 1;
    crossing.offset = signalOffsetForPosition(rawEntry.x, rawEntry.z);
  }

  const contactGeometry = new THREE.CircleGeometry(0.48, 16);
  contactGeometry.rotateX(-Math.PI * 0.5);
  const contactShadowTexture = createContactShadowTexture();
  const contactMaterial = new THREE.MeshBasicMaterial({
    color: 0x111719,
    alphaMap: contactShadowTexture,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const contactShadows = new THREE.InstancedMesh(contactGeometry, contactMaterial, POOL_SIZE);
  contactShadows.name = 'Pedestrian contact shadows';
  contactShadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  contactShadows.renderOrder = -1;
  group.add(contactShadows);

  const shadowMatrix = new THREE.Matrix4();
  const shadowPosition = new THREE.Vector3();
  const shadowScale = new THREE.Vector3();
  const shadowQuaternion = new THREE.Quaternion();
  const direction = new THREE.Vector3();
  const target = new THREE.Vector3();
  const position = new THREE.Vector3();
  const conversationAnchor = new THREE.Vector3();
  const conversationForward = new THREE.Vector3();
  const conversationSide = new THREE.Vector3();
  let beautyRouteCursor = 0;
  let lastUpdateElapsed = 0;
  const system = {};

  function dayNightFactor() {
    const hour = Number.isFinite(system.dayHour) ? system.dayHour : 7;
    if (hour >= 6 && hour < 10) return 1;
    if (hour >= 10 && hour < 17) return 0.72;
    if (hour >= 17 && hour < 21) return 0.62;
    if (hour >= 21 && hour < 23) return 0.24;
    return 0.1;
  }

  function setDayHour(hour) {
    const safe = Number(hour);
    if (!Number.isFinite(safe)) return false;
    system.dayHour = ((safe % 24) + 24) % 24;
    return true;
  }

  function getDayHour() {
    return Number.isFinite(system.dayHour) ? system.dayHour : 7;
  }

  function scheduleDuration(data, state) {
    const range = data.schedule?.[state] || [1, 3];
    let duration = randomRange(rng, range);
    if (system.weather === 'drizzle' && state === 'idle') duration += 0.35;
    if (system.weather === 'fog' && state !== 'walk') duration += 0.45;
    const dayFactor = dayNightFactor();
    if (state === 'idle') duration += (1 - dayFactor) * 1.8;
    if (state === 'work') duration *= Math.max(0.3, dayFactor);
    return duration;
  }

  function setBehaviorState(data, state, duration = null, vignette = null) {
    data.state = state;
    if (state === STATE_WALK) {
      data.timer = 0;
      data.vignette = null;
      data.interaction = null;
      data.stationAnchor = null;
      return;
    }
    if (state === STATE_CROSS) {
      data.timer = 0;
      data.interaction = null;
      data.vignette = vignette;
      return;
    }
    if (state === STATE_IDLE || state === STATE_WORK) {
      data.timer = duration ?? scheduleDuration(data, state === STATE_IDLE ? 'idle' : 'work');
      data.vignette = vignette || `${state === STATE_WORK ? 'work' : 'idle'}:${data.destinationKind}`;
      data.stationAnchor = data.mesh.position.clone();
      return;
    }
    data.timer = 0;
    data.vignette = vignette;
  }

  function setDestinationFor(data) {
    const points = pointsForPath(data.path);
    if (!points || points.length < 2) {
      data.destination = null;
      return;
    }
    const endpoint = data.direction > 0 ? points[points.length - 1] : points[0];
    data.destination = endpoint.clone();
    data.destinationKind = data.schedule?.destination || 'sidewalk stop';
    data.destinationReached = false;
  }

  function beginScheduledStop(data) {
    data.stopCount += 1;
    data.destinationReached = true;
    const schedule = data.schedule || ROLE_SCHEDULES.commuter;
    const dayFactor = dayNightFactor();
    const workChance = schedule.workChance * Math.max(0.28, dayFactor);
    const idleChance = schedule.idleChance + (1 - dayFactor) * 0.22;
    if (data.job.prop && rng() < workChance) {
      setBehaviorState(data, STATE_WORK, null, `work:${schedule.destination}`);
      return true;
    }
    if (rng() < idleChance) {
      setBehaviorState(data, STATE_IDLE, null, `idle:${schedule.destination}`);
      return true;
    }
    return false;
  }

  function moveSpeedFor(data) {
    // The district is deliberately not flat: a small uphill penalty and a
    // gentler downhill bonus keep walkers from sliding up Nob Hill at one
    // constant speed. Drizzle makes most roles hurry, while tourists still
    // keep their slower, stop-and-look rhythm.
    const gradeFactor = data.grade > 0
      ? 1 - Math.min(0.16, data.grade * 0.42)
      : 1 + Math.min(0.06, Math.abs(data.grade) * 0.16);
    const weatherFactor = system.weather === 'drizzle'
      ? (data.job.id === 'tourist' ? 1.02 : 1.12)
      : system.weather === 'fog'
        ? (data.job.id === 'tourist' ? 0.86 : 0.93)
        : 1;
    const dayFactor = dayNightFactor();
    const timeFactor = 0.82 + dayFactor * 0.18;
    return data.speed * data.walkPace * gradeFactor * weatherFactor * timeFactor;
  }

  function pathGradeFor(data) {
    const points = pointsForPath(data.path);
    if (!points || points.length < 2) return 0;
    const index = Math.max(0, Math.min(points.length - 2, data.segment));
    const start = points[index];
    const end = points[index + 1];
    const horizontalDistance = Math.hypot(end.x - start.x, end.z - start.z);
    if (horizontalDistance < 0.001) return 0;
    return THREE.MathUtils.clamp(
      ((end.y - start.y) / horizontalDistance) * data.direction,
      -0.32,
      0.32,
    );
  }

  function turnToward(data, desired, dt, response = 10) {
    const delta = Math.atan2(
      Math.sin(desired - data.heading),
      Math.cos(desired - data.heading),
    );
    data.heading += delta * Math.min(1, dt * response);
    const desiredRate = THREE.MathUtils.clamp(delta / Math.max(0.001, dt), -7, 7);
    data.turnRate = THREE.MathUtils.damp(data.turnRate, desiredRate, 13, dt);
    data.mesh.rotation.y = data.heading;
  }

  // True while the parallel traffic movement is green with enough time left
  // for a walker to reach the far curb before the countdown ends.
  function canEnterCrossing(crossing, elapsed, margin = 0, data = null) {
    if (!crossing || crossing.phaseGroup == null) return true;
    const phase = signalPhaseAt(crossing.phaseGroup, elapsed, crossing.offset);
    if (phase !== 'green') return false;
    const remaining = signalPhaseAt.remaining(crossing.phaseGroup, elapsed, crossing.offset);
    const weatherMargin = system.weather === 'fog'
      ? 0.85
      : system.weather === 'drizzle'
        ? 0.2
        : 0;
    const roleMargin = data?.job.id === 'tourist' ? 0.2 : 0;
    return remaining >= CROSS_MIN_GREEN + margin + weatherMargin + roleMargin;
  }

  function timeUntilWalk(crossing, elapsed) {
    if (!crossing || crossing.phaseGroup == null) return 0;
    return signalPhaseAt.remaining(crossing.phaseGroup, elapsed, crossing.offset)
      - CROSS_MIN_GREEN;
  }

  function crossingIsClearing(crossing, elapsed) {
    if (!crossing || crossing.phaseGroup == null) return false;
    return signalPhaseAt(crossing.phaseGroup, elapsed, crossing.offset) === 'yellow'
      || signalPhaseAt.remaining(crossing.phaseGroup, elapsed, crossing.offset) < CROSS_CLEARANCE;
  }

  function choosePath() {
    if (!paths.length) return null;
    const roll = rng();
    if (backgroundPaths.length && roll < 0.62) {
      return backgroundPaths[Math.floor(rng() * backgroundPaths.length)];
    }
    if (farAvenueRoutes.length === 2 && roll < 0.88) {
      const route = farAvenueRoutes[beautyRouteCursor % farAvenueRoutes.length];
      beautyRouteCursor += 1;
      return route;
    }
    return paths[Math.floor(rng() * paths.length)];
  }

  function pathDistanceSq(path, worldPoint) {
    let closestDistance = Infinity;
    for (const point of pointsForPath(path)) {
      const dx = point.x - worldPoint.x;
      const dz = point.z - worldPoint.z;
      closestDistance = Math.min(closestDistance, dx * dx + dz * dz);
    }
    return closestDistance;
  }

  function locateOnPath(path, worldPoint) {
    const pathPoints = pointsForPath(path);
    let closest = null;
    let closestDistance = Infinity;
    for (let index = 0; index < pathPoints.length - 1; index += 1) {
      const start = pathPoints[index];
      const end = pathPoints[index + 1];
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const lengthSq = dx * dx + dz * dz;
      const pathT = lengthSq > 1e-5
        ? THREE.MathUtils.clamp(((worldPoint.x - start.x) * dx + (worldPoint.z - start.z) * dz) / lengthSq, 0, 1)
        : 0;
      const candidateX = start.x + dx * pathT;
      const candidateZ = start.z + dz * pathT;
      const distance = (worldPoint.x - candidateX) ** 2 + (worldPoint.z - candidateZ) ** 2;
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = { segment: index, pathT };
      }
    }
    return closest || { segment: 0, pathT: 0 };
  }

  function chooseNearbyPath(data) {
    if (!paths.length) return null;
    const scored = paths
      .map((path) => ({ path, distance: pathDistanceSq(path, data.mesh.position) }))
      .sort((first, second) => first.distance - second.distance);
    const attachDistanceSq = MAX_PATH_ATTACH_DISTANCE * MAX_PATH_ATTACH_DISTANCE;
    const local = scored.filter((candidate) => candidate.distance <= attachDistanceSq);
    // A small local shortlist preserves believable block-to-block continuity
    // while still allowing the crowd to migrate around the district over
    // several route changes. If no new sidewalk is close enough, keep looping
    // instead of snapping across a street; signalized crossings handle the
    // actual block-to-block transfer.
    if (local.length) return local[Math.floor(rng() * local.length)].path;
    return data.path || scored[0].path;
  }

  function assignBeautyRoute(data, route, orderOnSide, sideIndex) {
    data.path = route;
    data.beautyRoute = true;
    const placement = HERO_ROUTE_SAMPLES[orderOnSide % HERO_ROUTE_SAMPLES.length];
    const sideOffset = sideIndex ? RIGHT_SIDE_DEPTH_OFFSETS[orderOnSide % RIGHT_SIDE_DEPTH_OFFSETS.length] : 0;
    const ratio = THREE.MathUtils.clamp(placement.ratio + sideOffset, 0.08, 0.96);
    data.segment = Math.min(placement.segment, route.length - 2);
    data.direction = orderOnSide % 2 ? -1 : 1;
    data.t = data.direction > 0 ? ratio : 1 - ratio;
    // Scale offset by travel direction so the same world-side (street/center)
    // is kept when an actor reverses heading on a path segment.
    const lateralSpread = HERO_LANE_OFFSETS[orderOnSide % HERO_LANE_OFFSETS.length]
      * (sideIndex ? -1 : 1);
    const rawBeautyLane = (BEAUTY_STREET_BIAS + lateralSpread) * data.direction;
    data.laneOffset = THREE.MathUtils.clamp(
      Math.abs(rawBeautyLane),
      BEAUTY_LANE_CLAMP.min,
      BEAUTY_LANE_CLAMP.max,
    ) * Math.sign(rawBeautyLane || 1);
    data.laneOffsetHome = data.laneOffset;
    setDestinationFor(data);
    if (data.job.prop) {
      setBehaviorState(data, STATE_WORK, 3.5 + (orderOnSide % 3) * 1.1, `work:${data.destinationKind}`);
    } else {
      setBehaviorState(data, STATE_WALK);
    }
    data.crossing = null;
    data.mesh.visible = true;
    if (sample(data, position)) {
      data.mesh.position.copy(position);
      data.groundY = position.y;
      data.heading = Math.atan2(direction.x, direction.z);
      data.mesh.rotation.y = data.heading;
      if (data.state === STATE_IDLE || data.state === STATE_WORK) {
        data.stationAnchor = data.mesh.position.clone();
      }
    }
  }

  // Place a hero actor on a known piece of sidewalk without changing its
  // route graph. This is used only for the authored morning beat below; the
  // actor still loops, crosses, reroutes, and obeys signals after the stop.
  function placeHeroAtRoute(data, route, {
    ratio = 0.5,
    lateralOffset = 0,
    directionSign = 1,
    state = STATE_IDLE,
    duration = 10,
    vignette = null,
  } = {}) {
    const points = pointsForPath(route);
    if (!data || !points || points.length < 2) return false;
    const totalSegments = points.length - 1;
    const pathPosition = THREE.MathUtils.clamp(
      ratio * totalSegments,
      0,
      Math.max(0, totalSegments - 0.04),
    );
    data.path = route;
    data.beautyRoute = beautyRoutes.includes(route) || farAvenueRoutes.includes(route);
    data.direction = directionSign >= 0 ? 1 : -1;
    data.segment = Math.min(totalSegments - 1, Math.floor(pathPosition));
    const localRatio = pathPosition - data.segment;
    data.t = data.direction > 0 ? localRatio : 1 - localRatio;
    data.laneOffset = lateralOffset;
    data.laneOffsetHome = lateralOffset;
    data.crossing = null;
    data.transfer = null;
    setDestinationFor(data);
    if (!sample(data, position)) return false;
    data.mesh.position.copy(position);
    data.groundY = position.y;
    data.heading = Math.atan2(direction.x, direction.z);
    data.mesh.rotation.y = data.heading;
    setBehaviorState(data, state, duration, vignette);
    if (state === STATE_IDLE || state === STATE_WORK) {
      data.stationAnchor = data.mesh.position.clone();
    }
    data.mesh.visible = true;
    return true;
  }

  function assignDestinationCluster(first, second, route, {
    ratio = 0.86,
    lateralGap = 0.64,
    directionSign = 1,
    state = STATE_WORK,
    duration = 12,
    vignette = null,
  } = {}) {
    if (!first || !second || !route) return false;
    const firstPlaced = placeHeroAtRoute(first, route, {
      ratio,
      lateralOffset: lateralGap,
      directionSign,
      state,
      duration,
      vignette: typeof vignette === 'function' ? vignette(first) : vignette,
    });
    const secondPlaced = placeHeroAtRoute(second, route, {
      ratio,
      lateralOffset: -lateralGap,
      directionSign,
      state,
      duration,
      vignette: typeof vignette === 'function' ? vignette(second) : vignette,
    });
    if (!firstPlaced || !secondPlaced) return false;

    // Both actors face the shared route endpoint. The tiny paired formation
    // makes a work destination/viewpoint read as a place, not two unrelated
    // people frozen at arbitrary points on a sidewalk.
    const endpoint = pointsForPath(route)[directionSign > 0 ? pointsForPath(route).length - 1 : 0];
    if (endpoint?.isVector3) {
      for (const data of [first, second]) {
        const dx = endpoint.x - data.mesh.position.x;
        const dz = endpoint.z - data.mesh.position.z;
        if (Math.hypot(dx, dz) < 0.001) continue;
        data.heading = Math.atan2(dx, dz);
        data.mesh.rotation.y = data.heading;
      }
    }
    return true;
  }

  function assignMorningHandoff(first, second, route) {
    if (!first || !second || !route) return;
    // A courier pauses at the café edge while the barista checks the order.
    // Their shoulder-to-shoulder spacing leaves a readable silhouette gap,
    // and both roles retain their own prop-driven work pose.
    const placedFirst = placeHeroAtRoute(first, route, {
      ratio: 0.58,
      lateralOffset: 0.56,
      directionSign: 1,
      state: STATE_WORK,
      duration: 13.5,
      vignette: 'handoff:delivery',
    });
    const placedSecond = placeHeroAtRoute(second, route, {
      ratio: 0.58,
      lateralOffset: -0.56,
      directionSign: -1,
      state: STATE_IDLE,
      duration: 12.5,
      vignette: 'handoff:coffee counter',
    });
    if (!placedFirst || !placedSecond) return;
    // The route directions remain opposite for the later rejoin, but the
    // stationary handoff beat turns both bodies toward the person receiving
    // the parcel/cup so the exchange reads from an oblique sidewalk camera.
    for (const [actor, partner] of [[first, second], [second, first]]) {
      const dx = partner.mesh.position.x - actor.mesh.position.x;
      const dz = partner.mesh.position.z - actor.mesh.position.z;
      actor.heading = Math.atan2(dx, dz);
      actor.mesh.rotation.y = actor.heading;
    }
    first.interaction = { kind: 'handoff', partner: second, side: 'courier' };
    second.interaction = { kind: 'handoff', partner: first, side: 'barista' };
  }

  function nearestPath(worldPoint) {
    let closest = null;
    let closestDistance = Infinity;
    for (const path of paths) {
      const distance = pathDistanceSq(path, worldPoint);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = path;
      }
    }
    return closest || choosePath();
  }

  function chooseCrossingFor(data) {
    const ranked = [];
    for (const crossing of crossings) {
      const entry = crossing?.entry || crossing?.start || crossing?.from;
      const exit = crossing?.exit || crossing?.end || crossing?.to;
      if (!entry?.isVector3 || !exit?.isVector3) continue;
      const entryDistance = data.mesh.position.distanceToSquared(entry);
      const exitDistance = data.mesh.position.distanceToSquared(exit);
      let score = Math.min(entryDistance, exitDistance);
      // Tourists naturally drift toward signalized avenues and viewpoints;
      // commuters and couriers prefer the first usable crossing on their way.
      if (data.job.id === 'tourist' && crossing.center?.isVector3) score *= 0.82;
      if (data.job.id === 'worker') score *= 1.18;
      ranked.push({ crossing, score });
    }
    if (!ranked.length) return null;
    ranked.sort((a, b) => a.score - b.score);
    const shortlist = Math.min(3, ranked.length);
    return ranked[Math.floor(rng() * shortlist)].crossing;
  }

  function assignPath(data, path = choosePath(), options = {}) {
    const points = pointsForPath(path);
    if (!points || points.length < 2) {
      data.path = null;
      data.mesh.visible = false;
      return;
    }
    const anchor = options.anchor?.isVector3
      ? options.anchor
      : options.preservePosition
        ? data.mesh.position
        : null;
    data.path = path;
    data.transfer = null;
    data.beautyRoute = beautyRoutes.includes(path) || farAvenueRoutes.includes(path);
    data.direction = options.direction ?? (rng() > 0.5 ? 1 : -1);
    if (anchor) {
      const location = locateOnPath(path, anchor);
      data.segment = location.segment;
      data.t = data.direction > 0 ? location.pathT : 1 - location.pathT;
    } else {
      data.segment = Math.min(points.length - 2, Math.floor(rng() * (points.length - 1)));
      data.t = 0.08 + rng() * 0.84;
    }
    setDestinationFor(data);
    if (options.forceWalk || anchor) {
      setBehaviorState(data, STATE_WALK);
    } else if (data.job.prop && rng() < 0.48) {
      setBehaviorState(data, STATE_WORK, null, `work:${data.destinationKind}`);
    } else {
      setBehaviorState(data, STATE_WALK);
    }
    data.crossing = null;
    data.mesh.visible = true;
    if (sample(data, position)) {
      if (options.deferAttach && anchor) {
        data.transfer = { target: position.clone() };
        data.groundY = data.mesh.position.y;
      } else {
        data.mesh.position.copy(position);
        data.groundY = position.y;
      }
      data.heading = Math.atan2(direction.x, direction.z);
      data.mesh.rotation.y = data.heading;
      if (!data.transfer && (data.state === STATE_IDLE || data.state === STATE_WORK)) {
        data.stationAnchor = data.mesh.position.clone();
      }
    }
  }

  function restartPathAtLoop(data) {
    const points = pointsForPath(data.path);
    if (!points || points.length < 2) {
      assignPath(data);
      return;
    }
    data.segment = data.direction > 0 ? 0 : points.length - 2;
    data.t = 0;
    setDestinationFor(data);
    data.destinationReached = false;
    const anchor = data.mesh.position.clone();
    if (sample(data, position)) {
      const targetPosition = position.clone();
      if (anchor.distanceToSquared(targetPosition) > 0.0324) {
        data.transfer = { target: targetPosition };
        data.groundY = anchor.y;
      } else {
        data.mesh.position.copy(targetPosition);
        data.groundY = targetPosition.y;
      }
      data.heading = Math.atan2(direction.x, direction.z);
      data.mesh.rotation.y = data.heading;
    }
  }

  function rerouteFromStop(data) {
    const nextPath = chooseNearbyPath(data);
    if (!nextPath || nextPath === data.path) {
      restartPathAtLoop(data);
      return;
    }
    assignPath(data, nextPath, {
      anchor: data.mesh.position,
      direction: rng() > 0.5 ? data.direction : -data.direction,
      deferAttach: true,
    });
  }

  function assignConversationPair(first, second) {
    const route = farAvenueRoutes[0] || beautyRoutes[1] || beautyRoutes[0] || paths[0];
    const points = pointsForPath(route);
    if (!first || !second || points.length < 2) return;
    const segment = Math.min(points.length - 2, Math.max(0, Math.floor((points.length - 1) * 0.42)));
    conversationAnchor.lerpVectors(points[segment], points[segment + 1], 0.54);
    conversationForward.subVectors(points[segment + 1], points[segment]).setY(0);
    if (conversationForward.lengthSq() < 1e-5) conversationForward.set(0, 0, 1);
    else conversationForward.normalize();
    conversationSide.set(conversationForward.z, 0, -conversationForward.x);
    // Keep the pair close enough to read as a conversation, but just beyond
    // the personal-space radius so the spacing solver never collapses it.
    first.mesh.position.copy(conversationAnchor).addScaledVector(conversationSide, 0.55).addScaledVector(conversationForward, -0.16);
    second.mesh.position.copy(conversationAnchor).addScaledVector(conversationSide, -0.55).addScaledVector(conversationForward, 0.1);
    first.heading = Math.atan2(second.mesh.position.x - first.mesh.position.x, second.mesh.position.z - first.mesh.position.z);
    second.heading = Math.atan2(first.mesh.position.x - second.mesh.position.x, first.mesh.position.z - second.mesh.position.z);
    first.mesh.rotation.y = first.heading;
    second.mesh.rotation.y = second.heading;
    for (const data of [first, second]) {
      data.path = route;
      data.beautyRoute = beautyRoutes.includes(route) || farAvenueRoutes.includes(route);
      const location = locateOnPath(route, data.mesh.position);
      data.segment = location.segment;
      data.direction = data.index % 2 === 0 ? 1 : -1;
      data.t = data.direction > 0 ? location.pathT : 1 - location.pathT;
      setDestinationFor(data);
      setBehaviorState(data, STATE_IDLE, 18 + rng() * 11, 'conversation');
      data.crossing = null;
      data.mesh.visible = true;
    }
    first.interaction = { kind: 'conversation', partner: second, side: 'speaker' };
    second.interaction = { kind: 'conversation', partner: first, side: 'listener' };
  }

  function sample(data, out) {
    const points = pointsForPath(data.path);
    if (!points || points.length < 2) return false;
    const index = Math.max(0, Math.min(points.length - 2, data.segment));
    const start = points[index];
    const end = points[index + 1];
    const t = data.direction > 0 ? data.t : 1 - data.t;
    out.lerpVectors(start, end, t);
    data.groundY = out.y;
    direction.subVectors(end, start).multiplyScalar(data.direction).normalize();
    data.grade = pathGradeFor(data);
    data.turnIntent = 0;
    const hasNextSegment = data.direction > 0
      ? index < points.length - 2
      : index > 0;
    if (hasNextSegment) {
      const nextStart = data.direction > 0 ? points[index + 1] : points[index];
      const nextEnd = data.direction > 0 ? points[index + 2] : points[index - 1];
      const currentHeading = Math.atan2(direction.x, direction.z);
      const nextHeading = Math.atan2(
        nextEnd.x - nextStart.x,
        nextEnd.z - nextStart.z,
      );
      const cornerDelta = Math.atan2(
        Math.sin(nextHeading - currentHeading),
        Math.cos(nextHeading - currentHeading),
      );
      data.turnIntent = cornerDelta * THREE.MathUtils.smoothstep(data.t, 0.62, 0.98);
    }
    let lane = data.laneOffset;
    if (data.beautyRoute) {
      // Beauty corridors put mass on -X; keep a firm street-side band so
      // background actors never cut the Coit/Embarcadero facade apex.
      const sign = Math.sign(lane || data.direction || 1) || 1;
      lane = THREE.MathUtils.clamp(Math.abs(lane), 0.36, 0.56) * sign;
    }
    out.x += direction.z * lane;
    out.z -= direction.x * lane;
    // Waterfront avenues keep building mass on -X; nudge street-side for
    // beauty heroes and background actors on the same corridor.
    if (data.beautyRoute || !data.hero) {
      out.x += data.beautyRoute ? 0.82 : 0.68;
    }
    // Corners shrink the usable sidewalk band — a light street-side push
    // keeps actors off facade apexes without shoving them onto plazas.
    const cornerAbs = Math.abs(data.turnIntent || 0);
    if (cornerAbs > 0.06 && (data.beautyRoute || !data.hero)) {
      const cornerPush = THREE.MathUtils.clamp(cornerAbs * 0.62, 0.06, 0.24);
      const curbSign = Math.sign(lane || 1) || 1;
      out.x += direction.z * cornerPush * curbSign;
      out.z -= direction.x * cornerPush * curbSign;
    }
    return true;
  }

  function beginCrossingFor(data) {
    if (!crossings.length) return false;
    const schedule = data.schedule || ROLE_SCHEDULES.commuter;
    const weatherFactor = system.weather === 'fog'
      ? 0.58
      : system.weather === 'drizzle'
        ? 1.04
        : 1;
    const nightCrossingFactor = 0.3 + dayNightFactor() * 0.7;
    if (rng() >= schedule.crossingChance * weatherFactor * nightCrossingFactor) return false;
    const crossing = chooseCrossingFor(data);
    const rawEntry = crossing?.entry || crossing?.start || crossing?.from;
    const rawExit = crossing?.exit || crossing?.end || crossing?.to;
    if (!rawEntry?.isVector3 || !rawExit?.isVector3) return false;
    const reverse = data.mesh.position.distanceToSquared(rawExit)
      < data.mesh.position.distanceToSquared(rawEntry);
    data.crossing = {
      entry: (reverse ? rawExit : rawEntry).clone(),
      exit: (reverse ? rawEntry : rawExit).clone(),
      ref: crossing,
      phase: 'approach',
      wait: 0.4 + rng() * 0.9,
      hurried: false,
      queueBack: null,
      queueSide: 0,
    };
    setBehaviorState(data, STATE_CROSS, 0, `crossing:${data.destinationKind}`);
    return true;
  }

  function advance(data) {
    const points = pointsForPath(data.path);
    if (!points || points.length < 2) {
      assignPath(data);
      return;
    }
    if (data.direction > 0) {
      if (data.segment < points.length - 2) {
        data.segment += 1;
        data.t = 0;
        return;
      }
      if (data.beautyRoute) {
        data.direction = -1;
        data.laneOffset = -data.laneOffset;
        data.laneOffsetHome = -(data.laneOffsetHome ?? data.laneOffset);
        data.segment = points.length - 2;
        data.t = 0;
        setDestinationFor(data);
        if (!beginScheduledStop(data)) setBehaviorState(data, STATE_WALK);
        return;
      }
      if (beginScheduledStop(data) || beginCrossingFor(data)) return;
      rerouteFromStop(data);
      return;
    }
    if (data.segment > 0) {
      data.segment -= 1;
      data.t = 0;
      return;
    }
    if (data.beautyRoute) {
      data.direction = 1;
      data.laneOffset = -data.laneOffset;
      data.laneOffsetHome = -(data.laneOffsetHome ?? data.laneOffset);
      data.segment = 0;
      data.t = 0;
      setDestinationFor(data);
      if (!beginScheduledStop(data)) setBehaviorState(data, STATE_WALK);
      return;
    }
    if (beginScheduledStop(data) || beginCrossingFor(data)) return;
    rerouteFromStop(data);
  }

  function moveTo(data, destination, dt, speed, { ignorePush = false } = {}) {
    target.copy(destination);
    direction.subVectors(target, data.mesh.position);
    const distance = direction.length();
    if (distance < 0.18) return true;
    direction.normalize();
    data.mesh.position.addScaledVector(direction, Math.min(distance, speed * dt));
    if (!ignorePush && data.pushX) {
      data.mesh.position.x += data.pushX;
      data.mesh.position.z += data.pushZ;
    }
    data.groundY = data.mesh.position.y;
    const desired = Math.atan2(direction.x, direction.z);
    const horizontalDistance = Math.hypot(direction.x, direction.z);
    data.grade = horizontalDistance > 0.001
      ? THREE.MathUtils.clamp(direction.y / horizontalDistance, -0.32, 0.32)
      : 0;
    turnToward(data, desired, dt, 9);
    return false;
  }

  function updateCrossing(data, dt, elapsed) {
    const crossing = data.crossing;
    if (!crossing) {
      setBehaviorState(data, STATE_WALK);
      return;
    }
    if (crossing.phase === 'approach') {
      // Walkers arriving during the walk window keep their stride and step
      // off the curb without the scripted pause; otherwise they reach the
      // curb and check the light. Require the walk window near the curb so a
      // stale phase flip cannot drop someone into the roadway mid-approach.
      if (canEnterCrossing(crossing.ref, elapsed, 0, data)
        && data.mesh.position.distanceToSquared(crossing.entry) < 2.6) {
        crossing.phase = 'cross';
      }
      if (moveTo(data, crossing.entry, dt, moveSpeedFor(data) * 1.15) && crossing.phase === 'approach') {
        crossing.phase = 'wait';
      }
      return;
    }
    if (crossing.phase === 'wait') {
      // Face the far curb and glance down the roadway (handled in `animate`)
      // until the light opens, the walk window has enough green left, and the
      // walker's own curb hesitation has elapsed. Impatient walkers cheat the
      // countdown once their patience runs out.
      const secondsToWalk = timeUntilWalk(crossing.ref, elapsed);
      if (secondsToWalk > 0.05) crossing.wait += (1 - data.impatience) * dt * 1.8;
      crossing.wait -= dt;
      direction.subVectors(crossing.exit, crossing.entry).normalize();
      // Queue behind the curb instead of stacking on the exact entry point:
      // each walker holds a small personal offset back along the approach and
      // a lateral scatter so a waiting cluster reads as a loose group.
      if (crossing.queueBack == null) {
        crossing.queueBack = 0.25 + (data.index % 4) * 0.42 + data.impatience * 0.2;
        crossing.queueSide = ((data.index % 3) - 1) * 0.3;
      }
      const queueDistance = data.mesh.position.distanceTo(crossing.entry);
      if (queueDistance < crossing.queueBack) {
        target.copy(crossing.entry)
          .addScaledVector(direction, -crossing.queueBack);
        target.x += direction.z * crossing.queueSide;
        target.z -= direction.x * crossing.queueSide;
        data.mesh.position.lerp(target, Math.min(1, dt * 2.2));
      }
      const desired = Math.atan2(direction.x, direction.z);
      turnToward(data, desired, dt, 5);
      // Require a little margin past the theoretical minimum so a walker
      // released this frame still has room to clear before the countdown.
      if (crossing.wait <= 0 && canEnterCrossing(crossing.ref, elapsed, 0.35, data)) {
        crossing.phase = 'cross';
      }
      return;
    }
    // Committing pedestrians hurry when the countdown starts so nobody is
    // left mid-roadway when cross traffic releases. Separation is ignored
    // here: a sideways nudge must never shove someone along the crossing
    // axis past the far curb or back into traffic.
    if (!crossing.hurried && crossingIsClearing(crossing.ref, elapsed)) crossing.hurried = true;
    const stride = crossing.hurried ? 1.85 : 1.25;
    if (moveTo(data, crossing.exit, dt, moveSpeedFor(data) * stride, { ignorePush: true })) {
      const exit = crossing.exit.clone();
      data.crossing = null;
      assignPath(data, nearestPath(exit), {
        anchor: exit,
        direction: data.direction,
        deferAttach: true,
      });
    }
  }

  function blendBoneRot(bone, x, y, z, weight) {
    if (weight <= 0) return;
    if (weight >= 0.999) {
      bone.rotation.set(x, y, z);
      return;
    }
    bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, x, weight);
    bone.rotation.y = THREE.MathUtils.lerp(bone.rotation.y, y, weight);
    bone.rotation.z = THREE.MathUtils.lerp(bone.rotation.z, z, weight);
  }

  function blendScalar(current, target, weight) {
    return weight <= 0 ? current : THREE.MathUtils.lerp(current, target, weight);
  }

  function resetPose(data) {
    const ud = data.mesh.userData;
    const leftHipY = ud.leftHipY;
    const rightHipY = ud.rightHipY;
    const leftHipX = ud.leftHipX ?? 0;
    const rightHipX = ud.rightHipX ?? 0;
    ud.rig.position.set(0, 0, 0);
    ud.rig.rotation.set(0, 0, 0);
    ud.leftArm.rotation.set(0, 0, 0);
    ud.rightArm.rotation.set(0, 0, 0);
    ud.leftForearm.rotation.set(0, 0, 0);
    ud.rightForearm.rotation.set(0, 0, 0);
    ud.leftLeg.rotation.set(0, 0, 0);
    ud.rightLeg.rotation.set(0, 0, 0);
    ud.leftLeg.position.y = leftHipY;
    ud.rightLeg.position.y = rightHipY;
    ud.leftLeg.position.x = leftHipX;
    ud.rightLeg.position.x = rightHipX;
    ud.leftShin.rotation.set(0, 0, 0);
    ud.rightShin.rotation.set(0, 0, 0);
    ud.leftFoot.position.y = ud.leftFootY ?? ud.leftFoot.position.y;
    ud.rightFoot.position.y = ud.rightFootY ?? ud.rightFoot.position.y;
    ud.leftFoot.position.z = ud.leftFootZ ?? ud.leftFoot.position.z;
    ud.rightFoot.position.z = ud.rightFootZ ?? ud.rightFoot.position.z;
    if (ud.leftShoeStripe) {
      ud.leftShoeStripe.position.y = ud.leftShoeStripeY;
      ud.leftShoeStripe.position.z = ud.leftShoeStripeZ;
    }
    if (ud.rightShoeStripe) {
      ud.rightShoeStripe.position.y = ud.rightShoeStripeY;
      ud.rightShoeStripe.position.z = ud.rightShoeStripeZ;
    }
    const footNeutralX = ud.footNeutralX ?? Math.PI * 0.5;
    ud.leftFoot.rotation.set(footNeutralX, 0, 0);
    ud.rightFoot.rotation.set(footNeutralX, 0, 0);
    ud.headPivot.rotation.set(0, 0, 0);
    ud.body.rotation.set(0, 0, 0);
  }

  function animate(data, elapsed, delta) {
    const ud = data.mesh.userData;
    const skinnedRig = Boolean(ud.skinnedBody);
    resetPose(data);
    const crossingWait = data.state === STATE_CROSS && data.crossing?.phase === 'wait';
    const crossingCross = data.state === STATE_CROSS && data.crossing?.phase === 'cross';
    const walking = data.state === STATE_WALK || (data.state === STATE_CROSS && !crossingWait);
    // Blend between locomotion and stillness rather than snapping limbs from
    // a full stride to a statue when a person reaches a curb or work task.
    // Ease-in is slightly faster than ease-out so stops feel weighted.
    const gaitTarget = walking ? 1 : 0;
    const gaitDamp = gaitTarget > data.gaitBlend ? GAIT_START_DAMP : GAIT_STOP_DAMP;
    data.gaitBlend = THREE.MathUtils.damp(data.gaitBlend, gaitTarget, gaitDamp, delta);
    const gait = THREE.MathUtils.smoothstep(data.gaitBlend, 0, 1);
    const restWeight = 1 - gait;
    const visual = data.visualVariant || ud.visualVariant || {};
    const posePhase = elapsed + (visual.posePhase || 0);
    const gaitCue = GAIT_VISUAL_CUES[visual.gaitStyle] || GAIT_VISUAL_CUES.steady;
    const btHurry = Number.isFinite(data.btUrgency) ? 0.92 + data.btUrgency * 0.45 : 1;
    const crossHurry = (crossingCross
      ? (data.crossing?.hurried ? 1.24 : 1.14)
      : 1) * (walking ? btHurry : 1);
    const locomotionSpeed = walking ? moveSpeedFor(data) * crossHurry : 0;
    const stepLength = Math.max(
      0.55,
      ADULT_STEP_LENGTH * ud.stride * gaitCue.stride * (crossingCross ? 1.06 : 1),
    );
    // Phase rate tracks world speed so footfall cadence matches translation (~1.1 m/s).
    const phaseRate = (locomotionSpeed / stepLength) * Math.PI * data.cadence;
    const phase = elapsed * phaseRate + data.phase;
    const sinPhase = Math.sin(phase);
    const cosPhase = Math.cos(phase);
    const forwardLeft = Math.max(0, -sinPhase);
    const forwardRight = Math.max(0, sinPhase);
    const stanceLeft = Math.max(0, sinPhase);
    const stanceRight = Math.max(0, -sinPhase);
    const leftSwing = Math.pow(forwardLeft, 0.82);
    const rightSwing = Math.pow(forwardRight, 0.82);
    const leftStance = Math.pow(stanceLeft, 2.4);
    const rightStance = Math.pow(stanceRight, 2.4);
    const leftFootLift = leftSwing * 0.072 * gait;
    const rightFootLift = rightSwing * 0.072 * gait;
    const leftFootPlant = Math.pow(Math.max(0, cosPhase), 10) * gait;
    const rightFootPlant = Math.pow(Math.max(0, -cosPhase), 10) * gait;
    const leftHeelStrike = Math.pow(Math.max(0, Math.cos(phase + 0.12)), 14) * gait;
    const rightHeelStrike = Math.pow(Math.max(0, -Math.cos(phase + 0.12)), 14) * gait;
    const leftToeOff = Math.pow(Math.max(0, -Math.sin(phase - 0.18)), 8) * gait;
    const rightToeOff = Math.pow(Math.max(0, Math.sin(phase - 0.18)), 8) * gait;
    const leftContact = leftStance * (0.62 + leftHeelStrike * 0.38);
    const rightContact = rightStance * (0.62 + rightHeelStrike * 0.38);
    const contactBalance = rightContact - leftContact;
    const contactWeight = Math.max(leftContact, rightContact);
    const turnRate = data.turnRate;
    const turnLean = THREE.MathUtils.clamp(
      turnRate * 0.032 + data.turnIntent * 0.045,
      -0.16,
      0.16,
    );
    data.turnRate = THREE.MathUtils.damp(data.turnRate, 0, 8, delta);
    data.stepPulse = Math.max(leftFootPlant, rightFootPlant);
    const strideScale = gait * ud.stride * gaitCue.stride * crossHurry;
    // Background capsules need a stronger swing to read at mid range; heroes
    // keep a more grounded adult stride.
    // Readable stride at mid-range without opening a waist hollow.
    const crowdBoost = ud.heroDetail === false ? 1.42 : 1;
    const heroBoost = skinnedRig ? 1.12 : 1;
    const swing = sinPhase * 0.62 * strideScale * crowdBoost * heroBoost;
    const shoulderTwist = sinPhase * 0.19 * gait;
    const bob = gait > 0.001
      ? (-Math.pow(Math.abs(cosPhase), 4) * 0.019 * gait
        - data.stepPulse * 0.009
        - contactWeight * CONTACT_PELVIS_DROP)
        * gaitCue.bob
      : Math.sin(elapsed * 1.7 + data.phase) * 0.006;
    ud.rig.position.y = bob;
    // Pelvis drops over the planted hip while the swing side rises.
    const hipDrop = 0.032 * gait;
    ud.rig.position.x = -sinPhase * 0.028 * gait + contactBalance * 0.006;
    ud.rig.rotation.x = 0.018 * gait
      + Math.sin(phase * 2) * 0.01 * gait
      + gaitCue.lean * gait
      + (crossingCross ? 0.014 * gait : 0)
      - data.grade * 0.055 * gait;
    // A restrained pelvis roll follows the planted foot, making the capsule
    // crowd and the skinned heroes share the same weighted contact read.
    ud.rig.rotation.z = -sinPhase * 0.032 * gait
      + contactBalance * CONTACT_PELVIS_ROLL * gait
      - turnLean;
    const leftHipY = ud.leftHipY;
    const rightHipY = ud.rightHipY;
    const leftHipX = ud.leftHipX ?? 0;
    const rightHipX = ud.rightHipX ?? 0;
    // Skinned heroes drive gait through bone rotation only — translating hip/
    // foot bones breaks mesh weights and reads as floating limb fragments.
    if (!skinnedRig) {
      // Crowd: keep hip Y nearly pinned — vertical slide reads as detached legs.
      const hipYAmp = ud.heroDetail === false ? 0.01 : 1;
      ud.leftLeg.position.y = leftHipY + (leftSwing * 0.032 - leftStance * hipDrop) * gait * hipYAmp;
      ud.rightLeg.position.y = rightHipY + (rightSwing * 0.032 - rightStance * hipDrop) * gait * hipYAmp;
      const hipSpread = (ud.heroDetail === false ? 0.02 : 0.014) * gait;
      ud.leftLeg.position.x = leftHipX + (-rightSwing + leftSwing) * hipSpread - (ud.heroDetail === false ? 0.012 * gait : 0);
      ud.rightLeg.position.x = rightHipX + (rightSwing - leftSwing) * hipSpread + (ud.heroDetail === false ? 0.012 * gait : 0);
    }
    ud.leftLeg.rotation.x = swing;
    ud.rightLeg.rotation.x = -swing;
    ud.leftLeg.rotation.y = -sinPhase * 0.055 * gait;
    ud.rightLeg.rotation.y = sinPhase * 0.055 * gait;
    const footLiftScale = skinnedRig ? 0.72 : 1;
    ud.leftShin.rotation.x = (
      leftSwing * 0.88 * footLiftScale
      - leftStance * 0.09
      - leftContact * CONTACT_KNEE_BEND
      + leftHeelStrike * 0.06
      - leftToeOff * 0.04
    ) * gait;
    ud.rightShin.rotation.x = (
      rightSwing * 0.88 * footLiftScale
      - rightStance * 0.09
      - rightContact * CONTACT_KNEE_BEND
      + rightHeelStrike * 0.06
      - rightToeOff * 0.04
    ) * gait;
    // Feet advance only during swing; stance holds the shoe line to kill skate.
    const leftFootZOffset = leftSwing * 0.052 * gait;
    const rightFootZOffset = rightSwing * 0.052 * gait;
    if (!skinnedRig) {
      ud.leftFoot.position.y += leftFootLift * (1 - leftStance * 0.92);
      ud.rightFoot.position.y += rightFootLift * (1 - rightStance * 0.92);
      ud.leftFoot.position.z += leftFootZOffset - leftStance * leftFootZOffset * 0.98;
      ud.rightFoot.position.z += rightFootZOffset - rightStance * rightFootZOffset * 0.98;
      if (ud.leftShoeStripe) {
        ud.leftShoeStripe.position.y += leftFootLift * (1 - leftStance * 0.92);
        ud.leftShoeStripe.position.z += leftFootZOffset - leftStance * leftFootZOffset * 0.98;
      }
      if (ud.rightShoeStripe) {
        ud.rightShoeStripe.position.y += rightFootLift * (1 - rightStance * 0.92);
        ud.rightShoeStripe.position.z += rightFootZOffset - rightStance * rightFootZOffset * 0.98;
      }
    }
    const footNeutralX = ud.footNeutralX ?? Math.PI * 0.5;
    // Skinned foot bones detach when pitch is exaggerated — keep rotation mild.
    const footPitchScale = skinnedRig ? 0.48 : 1;
    ud.leftFoot.rotation.x = footNeutralX
      + (leftSwing * 0.38 * footPitchScale
        - leftStance * 0.08
        + leftFootPlant * 0.06
        + leftHeelStrike * 0.04
        - leftToeOff * CONTACT_TOE_ROLL) * gait
      - data.grade * 0.025 * gait;
    ud.rightFoot.rotation.x = footNeutralX
      + (rightSwing * 0.38 * footPitchScale
        - rightStance * 0.08
        + rightFootPlant * 0.06
        + rightHeelStrike * 0.04
        - rightToeOff * CONTACT_TOE_ROLL) * gait
      - data.grade * 0.025 * gait;
    const armSwing = swing * 0.92 * ud.armSwing * gaitCue.arm;
    ud.leftArm.rotation.x = -armSwing;
    ud.rightArm.rotation.x = armSwing;
    ud.leftArm.rotation.y = shoulderTwist * 0.52;
    ud.rightArm.rotation.y = -shoulderTwist * 0.52;
    ud.leftArm.rotation.z = -0.045 - leftSwing * 0.035 * gait + leftStance * 0.012 * gait;
    ud.rightArm.rotation.z = 0.045 + rightSwing * 0.035 * gait - rightStance * 0.012 * gait;
    ud.leftForearm.rotation.x = (-0.13 - leftStance * 0.22 + leftSwing * 0.14) * gait;
    ud.rightForearm.rotation.x = (-0.13 - rightStance * 0.22 + rightSwing * 0.14) * gait;
    ud.leftForearm.rotation.z = -0.035 - sinPhase * 0.018 * gait;
    ud.rightForearm.rotation.z = 0.035 + sinPhase * 0.018 * gait;
    ud.leftLeg.rotation.z = sinPhase * (ud.heroDetail === false ? 0.095 : 0.048) * gait;
    ud.rightLeg.rotation.z = -sinPhase * (ud.heroDetail === false ? 0.095 : 0.048) * gait;
    if (ud.heroDetail === false) {
      // Background capsules lack shins/feet — exaggerate upper-limb swing so
      // the stride reads at mid range instead of a stiff T-pose torso.
      ud.leftArm.rotation.z = -0.12 - leftSwing * 0.08 * gait + leftStance * 0.03 * gait;
      ud.rightArm.rotation.z = 0.12 + rightSwing * 0.08 * gait - rightStance * 0.03 * gait;
      // Extra sagittal pitch so rear/¾ views show clear L/R separation.
      ud.leftLeg.rotation.x *= 1.12;
      ud.rightLeg.rotation.x *= 1.12;
    }
    ud.body.rotation.z = gait > 0.001
      ? -sinPhase * 0.032 * gait + contactBalance * 0.02 * gait
      : Math.sin(elapsed + data.phase) * 0.014;
    ud.body.rotation.x += data.grade * 0.12 * gait;
    ud.body.rotation.y = -shoulderTwist * 0.88 + turnLean * 0.32 + data.turnIntent * 0.035 * gait;
    ud.headPivot.rotation.y = ud.headBias
      + Math.sin(elapsed * 0.55 + data.gazePhase) * 0.045 * gait
      + turnLean * 0.8
      + data.turnIntent * 0.16 * gait;

    const atCurb = data.state === STATE_CROSS
      && data.crossing?.phase === 'approach'
      && data.mesh.position.distanceToSquared(data.crossing.entry) < 2.6;
    if (atCurb) {
      const trafficCheck = Math.sin(elapsed * 1.65 + data.gazePhase);
      ud.headPivot.rotation.y += trafficCheck > 0 ? 0.3 : -0.3;
      ud.body.rotation.y += trafficCheck > 0 ? 0.055 : -0.055;
    } else if (walking && data.job.id === 'tourist' && data.beautyRoute) {
      // Viewpoints and the waterfront pull tourists' gaze off their path;
      // the small torso follow-through keeps this from reading as a broken
      // heading change.
      const sightseeing = Math.sin(elapsed * 0.34 + data.gazePhase);
      ud.headPivot.rotation.y += sightseeing * 0.18;
      ud.body.rotation.y += sightseeing * 0.045;
    } else if (walking && data.job.id === 'phone') {
      ud.headPivot.rotation.x += 0.06;
    }

    // A carried object dampens the matching arm rather than letting it swing
    // straight through a cup, parcel, camera, or phone.
    if (walking && data.job.prop) {
      ud.rightArm.rotation.x *= 0.28;
      ud.rightForearm.rotation.x = -0.36 - Math.max(0, sinPhase) * 0.08;
      if (data.job.prop === 'parcel') {
        ud.leftArm.rotation.x = -0.22;
        ud.leftForearm.rotation.x = -0.28;
      }
    }

    if (walking) {
      // Small role cues sell the prop and wardrobe together without adding a
      // second rig or changing navigation: couriers lean into a delivery,
      // workers carry their tool with purpose, and service roles protect what
      // they are carrying while moving through the block.
      if (data.job.id === 'courier') {
        ud.body.rotation.x += 0.028 * gait;
        ud.body.rotation.z += Math.sin(posePhase * 0.8) * 0.018 * gait;
        ud.headPivot.rotation.y += Math.sin(posePhase * 0.42) * 0.055 * gait;
      } else if (data.job.id === 'worker') {
        ud.body.rotation.x += 0.038 * gait;
        ud.leftArm.rotation.z -= 0.035 * gait;
        ud.headPivot.rotation.x += 0.018 * gait;
      } else if (data.job.id === 'barista') {
        ud.body.rotation.z += Math.sin(posePhase * 0.7) * 0.025 * gait;
        ud.rightForearm.rotation.x -= 0.08 * gait;
      } else if (data.job.id === 'cleaner') {
        ud.body.rotation.x += 0.022 * gait;
        ud.rig.rotation.z += Math.sin(posePhase * 0.65) * 0.028 * gait;
      } else if (data.job.id === 'phone') {
        ud.headPivot.rotation.x += 0.055 * gait;
        ud.rightArm.rotation.z += 0.035 * gait;
      }
    }

    if (data.state === STATE_IDLE && restWeight > 0.001) {
      const rw = restWeight;
      const idleSway = Math.sin(elapsed * 0.7 + data.phase);
      const idleBreath = Math.sin(elapsed * 1.35 + data.phase * 0.5);
      ud.rig.position.x = blendScalar(ud.rig.position.x, idleSway * 0.014, rw);
      ud.rig.position.y = blendScalar(ud.rig.position.y, idleBreath * 0.004, rw);
      ud.rig.rotation.z = blendScalar(ud.rig.rotation.z, -idleSway * 0.018, rw);
      if (!skinnedRig) {
        ud.leftLeg.position.y = blendScalar(
          ud.leftLeg.position.y,
          ud.leftLeg.position.y + Math.max(0, -idleSway) * 0.006,
          rw,
        );
        ud.rightLeg.position.y = blendScalar(
          ud.rightLeg.position.y,
          ud.rightLeg.position.y + Math.max(0, idleSway) * 0.006,
          rw,
        );
      }
      blendBoneRot(ud.leftArm, -0.055, ud.leftArm.rotation.y, ud.leftArm.rotation.z, rw);
      blendBoneRot(ud.rightArm, 0.035, ud.rightArm.rotation.y, ud.rightArm.rotation.z, rw);
      blendBoneRot(ud.leftForearm, -0.11, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
      blendBoneRot(ud.rightForearm, -0.08, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
      ud.headPivot.rotation.y = blendScalar(
        ud.headPivot.rotation.y,
        ud.headBias + Math.sin(elapsed * 0.65 + data.phase) * 0.2,
        rw,
      );
      ud.body.rotation.x = blendScalar(ud.body.rotation.x, Math.sin(elapsed * 0.5 + data.phase) * 0.018, rw);
      ud.body.rotation.z = blendScalar(ud.body.rotation.z, idleSway * 0.014, rw);
      if (data.vignette === 'conversation') {
        const gesture = Math.max(0, Math.sin(elapsed * 1.35 + data.phase));
        const listener = data.index % 2 === 1;
        ud.headPivot.rotation.y = blendScalar(ud.headPivot.rotation.y, listener ? -0.08 : 0.08, rw);
        ud.body.rotation.y = blendScalar(ud.body.rotation.y, listener ? -0.035 : 0.035, rw);
        if (!listener) {
          blendBoneRot(
            ud.rightArm,
            -0.34 - gesture * 0.42,
            ud.rightArm.rotation.y,
            -0.18,
            rw,
          );
          blendBoneRot(
            ud.rightForearm,
            -0.42 - gesture * 0.36,
            ud.rightForearm.rotation.y,
            ud.rightForearm.rotation.z,
            rw,
          );
        } else {
          blendBoneRot(
            ud.leftArm,
            -0.22 - gesture * 0.18,
            ud.leftArm.rotation.y,
            ud.leftArm.rotation.z,
            rw,
          );
          blendBoneRot(ud.leftForearm, -0.3, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
          ud.headPivot.rotation.x = blendScalar(
            ud.headPivot.rotation.x,
            Math.sin(elapsed * 0.78 + data.phase) * 0.06,
            rw,
          );
        }
      } else if (data.job.id === 'phone') {
        const phoneCheck = 0.5 + Math.sin(posePhase * 0.72) * 0.5;
        blendBoneRot(ud.rightArm, -0.62 - phoneCheck * 0.14, ud.rightArm.rotation.y, 0.08, rw);
        blendBoneRot(ud.rightForearm, -0.62 - phoneCheck * 0.18, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        ud.headPivot.rotation.x = blendScalar(ud.headPivot.rotation.x, 0.16 + phoneCheck * 0.08, rw);
        ud.headPivot.rotation.y = blendScalar(
          ud.headPivot.rotation.y,
          ud.headBias + Math.sin(posePhase * 0.36) * 0.08,
          rw,
        );
      } else if (data.job.id === 'tourist') {
        const sightseeing = Math.sin(posePhase * 0.36);
        ud.headPivot.rotation.y = blendScalar(ud.headPivot.rotation.y, ud.headBias + sightseeing * 0.3, rw);
        ud.body.rotation.y = blendScalar(ud.body.rotation.y, sightseeing * 0.06, rw);
        if (data.job.prop === 'camera') {
          // A viewpoint pause alternates between framing the shot and taking
          // in the skyline. Keeping the camera raised for most of the beat
          // makes the stop legible before the actor starts walking again.
          const cameraMoment = 0.5 + Math.sin(posePhase * 0.36 + 0.8) * 0.5;
          blendBoneRot(ud.rightArm, -0.62 - cameraMoment * 0.2, ud.rightArm.rotation.y, 0.1, rw);
          blendBoneRot(ud.rightForearm, -0.6 - cameraMoment * 0.16, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
          ud.headPivot.rotation.x = blendScalar(ud.headPivot.rotation.x, -0.02 - cameraMoment * 0.06, rw);
        }
      } else if (data.job.id === 'barista') {
        blendBoneRot(ud.rightArm, -0.52, ud.rightArm.rotation.y, ud.rightArm.rotation.z, rw);
        blendBoneRot(ud.rightForearm, -0.76, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        blendBoneRot(
          ud.leftArm,
          -0.12 + Math.sin(posePhase * 0.68) * 0.08,
          ud.leftArm.rotation.y,
          ud.leftArm.rotation.z,
          rw,
        );
        blendBoneRot(ud.leftForearm, -0.22, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
        ud.body.rotation.z = blendScalar(ud.body.rotation.z, Math.sin(posePhase * 0.42) * 0.04, rw);
      } else if (data.job.id === 'courier') {
        const parcelCheck = Math.max(0, Math.sin(posePhase * 0.52));
        blendBoneRot(ud.rightArm, -0.28 - parcelCheck * 0.12, ud.rightArm.rotation.y, ud.rightArm.rotation.z, rw);
        blendBoneRot(ud.rightForearm, -0.5 - parcelCheck * 0.16, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        ud.headPivot.rotation.y = blendScalar(ud.headPivot.rotation.y, ud.headBias + parcelCheck * 0.1, rw);
        ud.body.rotation.z = blendScalar(ud.body.rotation.z, -0.028, rw);
      } else if (data.job.id === 'cleaner') {
        ud.body.rotation.x = blendScalar(ud.body.rotation.x, 0.06, rw);
        blendBoneRot(ud.rightArm, -0.34, ud.rightArm.rotation.y, ud.rightArm.rotation.z, rw);
        blendBoneRot(ud.rightForearm, -0.4, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        blendBoneRot(ud.leftArm, -0.14, ud.leftArm.rotation.y, ud.leftArm.rotation.z, rw);
        blendBoneRot(ud.leftForearm, -0.24, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
        ud.rig.rotation.z = blendScalar(ud.rig.rotation.z, 0.024, rw);
      } else if (data.job.id === 'worker') {
        const toolCheck = Math.max(0, Math.sin(posePhase * 0.56));
        ud.body.rotation.x = blendScalar(ud.body.rotation.x, 0.045, rw);
        blendBoneRot(ud.rightArm, -0.38 - toolCheck * 0.16, ud.rightArm.rotation.y, ud.rightArm.rotation.z, rw);
        blendBoneRot(ud.rightForearm, -0.4 - toolCheck * 0.14, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        ud.headPivot.rotation.y = blendScalar(ud.headPivot.rotation.y, ud.headBias + toolCheck * 0.1, rw);
      }
    } else if (data.state === STATE_WORK && restWeight > 0.001) {
      const rw = restWeight;
      const workPhase = elapsed * 2.2 + data.phase;
      ud.headPivot.rotation.x = blendScalar(ud.headPivot.rotation.x, 0.1 + Math.sin(workPhase * 0.55) * 0.08, rw);
      if (data.job.id === 'cleaner') {
        ud.body.rotation.x = blendScalar(ud.body.rotation.x, 0.16, rw);
        blendBoneRot(ud.rightArm, -0.52 + Math.sin(workPhase) * 0.3, ud.rightArm.rotation.y, -0.26, rw);
        blendBoneRot(ud.rightForearm, -0.3, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        blendBoneRot(ud.leftArm, -0.38 - Math.sin(workPhase) * 0.24, ud.leftArm.rotation.y, 0.12, rw);
        blendBoneRot(ud.leftForearm, -0.46, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
        ud.rig.rotation.z = blendScalar(ud.rig.rotation.z, 0.035, rw);
        ud.rig.rotation.y = blendScalar(ud.rig.rotation.y, Math.sin(workPhase) * 0.12, rw);
      } else if (data.job.id === 'tourist') {
        blendBoneRot(ud.leftArm, -1.08, ud.leftArm.rotation.y, -0.18, rw);
        blendBoneRot(ud.rightArm, -1.18, ud.rightArm.rotation.y, 0.14, rw);
        blendBoneRot(ud.leftForearm, -0.56, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
        blendBoneRot(ud.rightForearm, -0.7, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        ud.body.rotation.z = blendScalar(ud.body.rotation.z, 0.028, rw);
        ud.headPivot.rotation.x = blendScalar(ud.headPivot.rotation.x, -0.08, rw);
      } else if (data.job.id === 'phone') {
        blendBoneRot(ud.rightArm, -0.88, ud.rightArm.rotation.y, 0.09, rw);
        blendBoneRot(ud.rightForearm, -0.72, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        blendBoneRot(ud.leftArm, 0.08, ud.leftArm.rotation.y, ud.leftArm.rotation.z, rw);
        blendBoneRot(ud.leftForearm, -0.18, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
        ud.headPivot.rotation.x = blendScalar(ud.headPivot.rotation.x, 0.28, rw);
        ud.headPivot.rotation.y = blendScalar(ud.headPivot.rotation.y, Math.sin(workPhase * 0.35) * 0.08, rw);
      } else if (data.job.id === 'barista') {
        // Coffee is carried near the chest, with a small weight shift and
        // occasional glance rather than an idle arm waving through the cup.
        blendBoneRot(ud.rightArm, -0.64, ud.rightArm.rotation.y, ud.rightArm.rotation.z, rw);
        blendBoneRot(ud.rightForearm, -0.82, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        blendBoneRot(
          ud.leftArm,
          -0.3 + Math.sin(workPhase * 0.75) * 0.08,
          ud.leftArm.rotation.y,
          ud.leftArm.rotation.z,
          rw,
        );
        blendBoneRot(ud.leftForearm, -0.32, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
        ud.body.rotation.z = blendScalar(ud.body.rotation.z, Math.sin(workPhase * 0.5) * 0.035, rw);
        ud.headPivot.rotation.y = blendScalar(ud.headPivot.rotation.y, Math.sin(workPhase * 0.36) * 0.12, rw);
      } else if (data.job.id === 'courier') {
        blendBoneRot(ud.rightArm, -0.36, ud.rightArm.rotation.y, 0.11, rw);
        blendBoneRot(ud.rightForearm, -0.82, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        blendBoneRot(ud.leftArm, -0.42, ud.leftArm.rotation.y, ud.leftArm.rotation.z, rw);
        blendBoneRot(ud.leftForearm, -0.7, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
        ud.body.rotation.x = blendScalar(ud.body.rotation.x, 0.05, rw);
        ud.body.rotation.z = blendScalar(ud.body.rotation.z, -0.024, rw);
      } else if (data.job.id === 'worker') {
        ud.body.rotation.x = blendScalar(ud.body.rotation.x, 0.09, rw);
        blendBoneRot(ud.rightArm, -0.68 + Math.sin(workPhase) * 0.22, ud.rightArm.rotation.y, ud.rightArm.rotation.z, rw);
        blendBoneRot(ud.rightForearm, -0.48, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        blendBoneRot(ud.leftArm, -0.3, ud.leftArm.rotation.y, ud.leftArm.rotation.z, rw);
        ud.rig.rotation.y = blendScalar(ud.rig.rotation.y, Math.sin(workPhase * 0.42) * 0.06, rw);
      } else {
        blendBoneRot(ud.rightArm, -0.7 + Math.sin(workPhase) * 0.25, ud.rightArm.rotation.y, ud.rightArm.rotation.z, rw);
        blendBoneRot(ud.rightForearm, -0.48, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
        blendBoneRot(
          ud.leftArm,
          -0.18 + Math.sin(workPhase + 0.8) * 0.14,
          ud.leftArm.rotation.y,
          ud.leftArm.rotation.z,
          rw,
        );
        ud.body.rotation.x = blendScalar(ud.body.rotation.x, Math.sin(workPhase * 0.5) * 0.025, rw);
      }
    } else if (crossingWait && restWeight > 0.001) {
      const rw = restWeight;
      const glance = Math.sin(elapsed * 1.8 + data.phase);
      ud.headPivot.rotation.y = blendScalar(ud.headPivot.rotation.y, glance > 0 ? 0.62 : -0.62, rw);
      ud.body.rotation.y = blendScalar(ud.body.rotation.y, ud.headPivot.rotation.y * 0.12, rw);
      blendBoneRot(ud.leftArm, -0.08, ud.leftArm.rotation.y, ud.leftArm.rotation.z, rw);
      blendBoneRot(ud.rightArm, 0.04, ud.rightArm.rotation.y, ud.rightArm.rotation.z, rw);
      blendBoneRot(ud.leftForearm, -0.1, ud.leftForearm.rotation.y, ud.leftForearm.rotation.z, rw);
      blendBoneRot(ud.rightForearm, -0.12, ud.rightForearm.rotation.y, ud.rightForearm.rotation.z, rw);
    } else if (crossingCross) {
      // Forward brace and alert gaze on top of the hurried cross gait.
      ud.body.rotation.x += 0.022 * gait;
      ud.headPivot.rotation.y += Math.sin(elapsed * 0.8 + data.gazePhase) * 0.07 * gait;
      if (data.crossing?.hurried) {
        ud.body.rotation.y += Math.sin(elapsed * 2.4 + data.phase) * 0.04 * gait;
      }
    }

    // Stationary people still carry their weight. A tiny hip settle, planted
    // foot roll, and opposite-knee release keeps a worker, phone user, or
    // café customer from reading as a frozen mannequin between beats.
    if (data.state === STATE_IDLE || data.state === STATE_WORK) {
      const weightPhase = posePhase * (data.state === STATE_WORK ? 0.42 : 0.55) + data.phase;
      const weightShift = Math.sin(weightPhase);
      ud.rig.position.x += weightShift * 0.008;
      if (!skinnedRig) {
        ud.leftLeg.position.y += Math.max(0, -weightShift) * 0.004;
        ud.rightLeg.position.y += Math.max(0, weightShift) * 0.004;
      }
      ud.leftFoot.rotation.z += weightShift * 0.014;
      ud.rightFoot.rotation.z += weightShift * 0.014;
    }

    // The delivery-to-café beat has a real target: both actors turn toward
    // the partner in world space, then make a restrained handoff gesture. The
    // interaction is visual only; navigation and schedule transitions remain
    // unchanged.
    const partner = data.interaction?.partner;
    if (partner?.mesh?.visible
      && (data.state === STATE_IDLE || data.state === STATE_WORK)) {
      const partnerDeltaX = partner.mesh.position.x - data.mesh.position.x;
      const partnerDeltaZ = partner.mesh.position.z - data.mesh.position.z;
      const partnerHeading = Math.atan2(partnerDeltaX, partnerDeltaZ);
      const localFacing = Math.atan2(
        Math.sin(partnerHeading - data.mesh.rotation.y),
        Math.cos(partnerHeading - data.mesh.rotation.y),
      );
      ud.headPivot.rotation.y = THREE.MathUtils.clamp(
        ud.headBias + localFacing * 0.78,
        -0.92,
        0.92,
      );
      ud.body.rotation.y = THREE.MathUtils.clamp(localFacing * 0.22, -0.2, 0.2);
      if (data.interaction.kind === 'handoff') {
        const handoffBeat = 0.5 + Math.sin(posePhase * 1.25) * 0.5;
        const partnerSide = Math.sign(
          Math.cos(data.mesh.rotation.y) * partnerDeltaX
            - Math.sin(data.mesh.rotation.y) * partnerDeltaZ,
        ) || 1;
        if (data.interaction.side === 'courier') {
          ud.rightArm.rotation.x = -0.34 - handoffBeat * 0.14;
          ud.rightForearm.rotation.x = -0.74 - handoffBeat * 0.12;
          ud.rightArm.rotation.z = 0.1 - partnerSide * 0.18;
          ud.rightForearm.rotation.z = -partnerSide * 0.12;
          ud.body.rotation.x += 0.025;
        } else {
          ud.rightArm.rotation.x = -0.48 - handoffBeat * 0.12;
          ud.rightForearm.rotation.x = -0.7 - handoffBeat * 0.1;
          ud.rightArm.rotation.z = 0.08 - partnerSide * 0.18;
          ud.rightForearm.rotation.z = -partnerSide * 0.12;
          ud.leftArm.rotation.x = -0.18 - handoffBeat * 0.12;
          ud.leftForearm.rotation.x = -0.28;
          ud.body.rotation.z += 0.018;
        }
      }
    }

    // Coastal drizzle: shoulders round forward, heads tuck, and parcel or
    // coffee carriers pull their cargo in against the chest.
    if (system.weather === 'drizzle' && !crossingWait && data.job.id !== 'worker') {
      const hunch = data.state === STATE_IDLE ? 0.07 : 0.13;
      ud.body.rotation.x += hunch;
      ud.headPivot.rotation.x += 0.1;
      if (walking) {
        ud.leftArm.rotation.x *= 0.55;
        ud.rightArm.rotation.x *= 0.55;
      }
      if (data.state !== STATE_WORK
        && (data.job.prop === 'parcel' || data.job.prop === 'coffee')) {
        ud.rightArm.rotation.x = -0.74;
        ud.rightForearm.rotation.x = -1.02;
      }
    }
    if (system.weather === 'fog' && !crossingWait) {
      // In low visibility people keep their gaze closer to the pavement and
      // make fewer abrupt sightseeing turns, especially near a curb.
      ud.body.rotation.x += data.state === STATE_IDLE ? 0.025 : 0.045;
      ud.headPivot.rotation.x += data.state === STATE_IDLE ? 0.025 : 0.045;
      ud.headPivot.rotation.y *= 0.82;
    }
  }

  for (let index = 0; index < POOL_SIZE; index += 1) {
    const hero = index < HERO_ACTORS;
    const heroJob = hero ? JOBS.find((candidate) => candidate.id === HERO_JOB_IDS[index]) : null;
    const job = heroJob || pickJob(rng);
    const mesh = buildActor(geometry, materialLibrary, rng, job, hero, index);
    const data = createData(mesh, job, index, rng, hero);
    group.add(mesh);
    pool.push(data);
    if (hero && beautyRoutes.length === 2) {
      assignBeautyRoute(data, beautyRoutes[index % 2], Math.floor(index / 2), index % 2);
    } else {
      assignPath(data, choosePath());
      if (hero && job.prop) {
        setBehaviorState(data, STATE_WORK, 4 + rng() * 6, `activity:${job.id}`);
      }
    }
  }
  // Hold the authored job roles long enough for a player to actually read
  // them instead of having every courier, tourist, and worker leave their
  // pose within the first few seconds after the city becomes visible.
  for (let index = 0; index < HERO_ACTORS; index += 1) {
    const data = pool[index];
    if (!data?.job.prop) continue;
    setBehaviorState(data, STATE_WORK, 10 + rng() * 8, `activity:${data.job.id}`);
  }
  // Put a visible pair into an actual, face-to-face sidewalk conversation at
  // startup. This is deliberately sparse: one loose social cluster reads
  // more naturally than every nearby person performing the same idle loop.
  assignConversationPair(pool[6], pool[7]);

  // The hero route now carries a small morning-rush rhythm: a courier makes
  // a café handoff, a tourist pauses to take in the avenue, and a commuter
  // checks a phone before rejoining the flow. These are deterministic startup
  // beats, not a second behavior system; once their timers expire they return
  // to the normal schedule/crossing graph.
  const morningRoute = beautyRoutes[0] || farAvenueRoutes[0] || paths[0];
  const secondaryMorningRoute = beautyRoutes[1] || farAvenueRoutes[1] || morningRoute;
  assignMorningHandoff(pool[2], pool[4], morningRoute);
  assignDestinationCluster(pool[0], pool[5], secondaryMorningRoute, {
    ratio: 0.88,
    lateralGap: 0.66,
    directionSign: 1,
    state: STATE_WORK,
    duration: 12.5,
    vignette: (data) => `work:${data.destinationKind}`,
  });
  const touristClusterMember = pool.find((data, index) => (
    index >= HERO_ACTORS && data.job.id === 'tourist'
  ));
  if (!assignDestinationCluster(pool[1], touristClusterMember, secondaryMorningRoute, {
    ratio: 0.76,
    lateralGap: 0.58,
    directionSign: 1,
    state: STATE_IDLE,
    duration: 13.5,
    vignette: 'viewpoint:pause',
  })) {
    placeHeroAtRoute(pool[1], secondaryMorningRoute, {
      ratio: 0.7,
      lateralOffset: 0.42,
      directionSign: -1,
      state: STATE_IDLE,
      duration: 11.5,
      vignette: 'dwelling:viewpoint',
    });
  }
  placeHeroAtRoute(pool[3], morningRoute, {
    ratio: 0.34,
    lateralOffset: -0.42,
    directionSign: 1,
    state: STATE_IDLE,
    duration: 9.5,
    vignette: 'dwelling:transit stop',
  });

  function occupiesCableCarAperture(data) {
    const { x, z } = data.mesh.position;
    return x > 18.5 && x < 45.5 && z > 4.5 && z < 33.5;
  }

  function keepOutOfCableCarAperture(data) {
    if (!occupiesCableCarAperture(data)) return false;
    const farRoute = farAvenueRoutes[0] || farAvenueRoutes[1];
    if (!farRoute) return false;
    assignBeautyRoute(data, farRoute, data.index, data.index % 2);
    return true;
  }

  function syncNpcBlackboard(data) {
    const bb = data.blackboard;
    if (!bb) return;
    bb.roleId = data.job.id;
    bb.weather = system.weather;
    bb.atCrossing = data.state === STATE_CROSS;
    bb.signalClear = data.state === STATE_CROSS
      && data.crossing?.phase === 'cross';
    bb.atDestination = data.state === STATE_IDLE
      || data.state === STATE_WORK
      || data.destinationReached;
    bb.preferWork = data.state === STATE_WORK
      || (Boolean(data.job.prop) && data.destinationReached && data.state !== STATE_IDLE);
    bb.handoffReady = data.interaction?.kind === 'handoff';
    bb.vignette = data.vignette;
    bb.state = data.state;
  }

  function tickNpcBehavior(data, delta) {
    if (!data.behaviorTree || !data.blackboard) return;
    syncNpcBlackboard(data);
    tickBehaviorTree(data.behaviorTree, data.blackboard, delta);
    const intent = data.blackboard.intent;
    const urgency = Number.isFinite(data.blackboard.urgency) ? data.blackboard.urgency : 0.55;
    data.btIntent = intent;
    data.btAnimCue = data.blackboard.animCue;
    data.btUrgency = urgency;
    // Urgency from the role tree modulates walk pace without fighting navigation.
    if (intent === 'walk' || intent === 'cross') {
      data.walkPace = THREE.MathUtils.damp(
        data.walkPace,
        THREE.MathUtils.clamp(0.82 + urgency * 0.55, 0.78, 1.28),
        4,
        delta,
      );
    }
  }

  // Combat owns only the short-lived reaction cue on the pooled mesh. The
  // pedestrian system consumes that cue here so navigation, spacing, and
  // normal schedule behavior remain the source of truth once it settles.
  function applyCombatReactionMovement(data, delta) {
    const userData = data.mesh.userData;
    const reaction = userData?.combatReaction;
    if (!userData || !reaction || reaction === 'settled') return false;
    if (userData.meleeRecoilPending === true) {
      let directionX = Number(userData.meleeRecoilDirectionX) || 0;
      let directionZ = Number(userData.meleeRecoilDirectionZ) || 0;
      const directionLength = Math.hypot(directionX, directionZ) || 1;
      directionX /= directionLength;
      directionZ /= directionLength;
      const applied = Math.max(0, Number(userData.meleeRecoilApplied) || 0);
      const targetDistance = 0.34;
      const next = Math.min(targetDistance, applied + Math.max(0, delta) * 1.15);
      const step = next - applied;
      // This is deliberately a short, time-integrated root recoil rather than
      // a hit-frame teleport. Hold the existing path briefly, then let its
      // normal route sampling take ownership again from the displaced pose.
      if (step > 0) {
        data.mesh.position.x += directionX * step;
        data.mesh.position.z += directionZ * step;
        data.groundY = data.mesh.position.y;
        userData.meleeRecoilApplied = next;
      }
      if (next >= targetDistance - 1e-5 && userData.meleeRecoilResynced !== true) {
        // Preserve the recoil when normal path sampling resumes: fold its
        // lateral component into the existing lane offset, then reattach the
        // longitudinal path coordinate to the displaced root. Lane recovery
        // already damps back toward home, so this settles without a snap.
        const forwardX = Math.sin(data.heading);
        const forwardZ = Math.cos(data.heading);
        const rightX = forwardZ;
        const rightZ = -forwardX;
        const lateral = directionX * rightX + directionZ * rightZ;
        data.laneOffset = THREE.MathUtils.clamp(
          (Number(data.laneOffset) || 0) + lateral * targetDistance,
          -LATERAL_DRIFT,
          LATERAL_DRIFT,
        );
        const location = data.path ? locateOnPath(data.path, data.mesh.position) : null;
        if (location) {
          data.segment = location.segment;
          data.t = data.direction > 0 ? location.pathT : 1 - location.pathT;
          setDestinationFor(data);
        }
        userData.meleeRecoilResynced = true;
        userData.meleeRecoilPending = false;
      }
      if (data.state !== STATE_IDLE) setBehaviorState(data, STATE_IDLE, 0.72, 'combat:melee-recoil');
      else data.timer = Math.max(data.timer, 0.72);
      return true;
    }
    if (reaction !== 'flee') return reaction === 'hit-react' || reaction === 'staggered';

    let directionX = Number(userData.combatReactionDirectionX) || 0;
    let directionZ = Number(userData.combatReactionDirectionZ) || 0;
    const directionLength = Math.hypot(directionX, directionZ);
    if (directionLength < 0.001) {
      directionX = Math.sin(data.heading + Math.PI);
      directionZ = Math.cos(data.heading + Math.PI);
    } else {
      directionX /= directionLength;
      directionZ /= directionLength;
    }
    if (data.state !== STATE_WALK && data.state !== STATE_CROSS) {
      setBehaviorState(data, STATE_WALK, 1.6, 'combat:flee');
    }
    data.walkPace = Math.max(data.walkPace || 1, 1.28);
    data.mesh.position.x += directionX * 2.8 * delta;
    data.mesh.position.z += directionZ * 2.8 * delta;
    data.heading = Math.atan2(directionX, directionZ);
    data.mesh.rotation.y = data.heading;
    data.turnRate = 0;
    return true;
  }

  function applyCombatReactionPose(data, elapsed, active) {
    if (!active) return;
    const userData = data.mesh.userData;
    const reaction = userData?.combatReaction;
    if (reaction !== 'hit-react' && reaction !== 'staggered') return;
    const melee = userData.combatReactionSource === 'melee';
    const pulse = 0.72 + Math.sin(elapsed * 26 + data.phase) * 0.28;
    const stagger = reaction === 'staggered' ? 1.18 : 1;
    if (melee) {
      // The root recoil is owned by applyCombatReactionMovement(). This is a
      // paired upper-body response only: a readable chest check, head snap,
      // and raised guard arm on the same live actor, with no route/foot edit.
      const directionX = Number(userData.combatReactionDirectionX) || 0;
      const directionZ = Number(userData.combatReactionDirectionZ) || 0;
      const side = Math.sign(
        directionX * Math.cos(data.heading) - directionZ * Math.sin(data.heading),
      ) || 1;
      userData.body.rotation.x += 0.34 * stagger;
      userData.body.rotation.z += side * 0.32 * stagger;
      userData.headPivot.rotation.x -= 0.22 * pulse;
      userData.headPivot.rotation.z -= side * 0.34 * pulse;
      userData.leftArm.rotation.x -= 0.82 * pulse;
      userData.leftArm.rotation.z += side * 0.58 * pulse;
      // Counter-rotate the forearm into a guard so it reads as an elbowed
      // reaction, not a single rigid arm bar.
      userData.leftForearm.rotation.x += 0.62 * pulse;
      userData.rightArm.rotation.x += 0.32 * pulse;
      userData.rightArm.rotation.z -= side * 0.32 * pulse;
      userData.rig.position.x += side * 0.018 * pulse;
      return;
    }
    userData.body.rotation.x += 0.11 * stagger;
    userData.body.rotation.z += Math.sin(elapsed * 24 + data.phase) * 0.11 * stagger;
    userData.headPivot.rotation.z += Math.sin(elapsed * 18 + data.phase) * 0.16 * pulse;
    userData.leftArm.rotation.z += 0.16 * pulse * stagger;
    userData.rightArm.rotation.z -= 0.16 * pulse * stagger;
    userData.rig.position.x += Math.sin(elapsed * 22 + data.phase) * 0.012 * stagger;
  }

  function applyVehicleImpactPose(data, elapsed) {
    const userData = data.mesh.userData;
    const until = Number(userData?.vehicleImpactUntil) || 0;
    if (!userData || until <= elapsed) {
      if (userData && until > 0) {
        userData.vehicleImpactUntil = 0;
        userData.vehicleImpactDirectionX = 0;
        userData.vehicleImpactDirectionZ = 0;
      }
      return;
    }
    const remaining = THREE.MathUtils.clamp((until - elapsed) / 1.35, 0, 1);
    const pulse = 0.68 + Math.sin(elapsed * 25 + data.phase) * 0.32;
    const side = THREE.MathUtils.clamp(
      Number(userData.vehicleImpactDirectionX) || 0,
      -1,
      1,
    );
    userData.body.rotation.x += 0.24 * remaining;
    userData.body.rotation.z += (0.14 + Math.abs(side) * 0.12) * Math.sign(side || 1) * remaining;
    userData.headPivot.rotation.z -= Math.sign(side || 1) * 0.22 * pulse * remaining;
    userData.leftArm.rotation.z += 0.28 * pulse * remaining;
    userData.rightArm.rotation.z -= 0.28 * pulse * remaining;
    userData.rig.position.y -= 0.08 * remaining;
  }

  function applyVehicleWitnessReaction(data, delta, elapsed) {
    const userData = data.mesh.userData;
    const until = Number(userData?.vehicleWitnessUntil) || 0;
    if (!userData || until <= elapsed) {
      if (userData && until > 0) {
        userData.vehicleWitnessUntil = 0;
        userData.vehicleWitnessDirectionX = 0;
        userData.vehicleWitnessDirectionZ = 0;
        userData.vehicleWitnessOffsetX = 0;
        userData.vehicleWitnessOffsetZ = 0;
        userData.vehicleWitnessTravel = 0;
        userData.vehicleWitnessReaction = null;
      }
      return false;
    }
    let directionX = Number(userData.vehicleWitnessDirectionX) || 0;
    let directionZ = Number(userData.vehicleWitnessDirectionZ) || 0;
    const directionLength = Math.hypot(directionX, directionZ) || 1;
    directionX /= directionLength;
    directionZ /= directionLength;
    if (data.state !== STATE_WALK && data.state !== STATE_CROSS) {
      setBehaviorState(data, STATE_WALK, 1.8, 'vehicle-impact:witness-flee');
    }
    data.walkPace = Math.max(data.walkPace || 1, 1.32);
    const travel = Math.min(
      VEHICLE_WITNESS_MAX_TRAVEL,
      (Number(userData.vehicleWitnessTravel) || 0) + VEHICLE_WITNESS_FLEE_SPEED * delta,
    );
    const baseX = Number.isFinite(userData.vehicleWitnessBaseX)
      ? userData.vehicleWitnessBaseX
      : data.mesh.position.x;
    const baseZ = Number.isFinite(userData.vehicleWitnessBaseZ)
      ? userData.vehicleWitnessBaseZ
      : data.mesh.position.z;
    userData.vehicleWitnessTravel = travel;
    userData.vehicleWitnessOffsetX = directionX * travel;
    userData.vehicleWitnessOffsetZ = directionZ * travel;
    data.mesh.position.x = baseX + userData.vehicleWitnessOffsetX;
    data.mesh.position.z = baseZ + userData.vehicleWitnessOffsetZ;
    const pathLocation = locateOnPath(data.path, data.mesh.position);
    const pathPoints = pointsForPath(data.path);
    const pathStart = pathPoints[pathLocation.segment];
    const pathEnd = pathPoints[pathLocation.segment + 1];
    if (pathStart?.isVector3 && pathEnd?.isVector3) {
      data.mesh.position.y = THREE.MathUtils.lerp(pathStart.y, pathEnd.y, pathLocation.pathT);
      data.groundY = data.mesh.position.y;
    } else if (Number.isFinite(userData.vehicleWitnessBaseY)) {
      data.mesh.position.y = userData.vehicleWitnessBaseY;
      data.groundY = data.mesh.position.y;
    }
    data.heading = Math.atan2(directionX, directionZ);
    data.mesh.rotation.y = data.heading;
    const pulse = 0.82 + Math.sin(elapsed * 18 + data.phase) * 0.18;
    userData.body.rotation.x -= 0.08;
    userData.headPivot.rotation.z += 0.1 * pulse;
    userData.rightArm.rotation.x -= 0.82;
    userData.rightArm.rotation.z += 0.72 * pulse;
    userData.leftArm.rotation.z -= 0.28 * pulse;
    return true;
  }

  function setOnFootPlayerCollisionProbe(probe = null) {
    if (!probe?.active
      || !Number.isFinite(probe.start?.x)
      || !Number.isFinite(probe.start?.z)
      || !Number.isFinite(probe.end?.x)
      || !Number.isFinite(probe.end?.z)) {
      onFootPlayerCollisionProbe = null;
      onFootPlayerCollisionLatch.clear();
      return false;
    }
    onFootPlayerCollisionProbe = {
      start: { x: probe.start.x, z: probe.start.z },
      end: { x: probe.end.x, z: probe.end.z },
      radius: THREE.MathUtils.clamp(
        Number(probe.radius) || ON_FOOT_PLAYER_RADIUS,
        0.3,
        0.8,
      ),
    };
    return true;
  }

  function livingPlayerContactResident(data) {
    if (!data?.mesh?.visible) return false;
    const userData = data.mesh.userData || {};
    return userData.combatDefeated !== true
      && userData.combatDisabled !== true;
  }

  function sweptPlayerResidentContact(probe, data) {
    const radius = probe.radius + ON_FOOT_PEDESTRIAN_RADIUS;
    const startX = probe.start.x - data.mesh.position.x;
    const startZ = probe.start.z - data.mesh.position.z;
    const moveX = probe.end.x - probe.start.x;
    const moveZ = probe.end.z - probe.start.z;
    const moveLengthSq = moveX * moveX + moveZ * moveZ;
    const radiusSq = radius * radius;
    const startDistanceSq = startX * startX + startZ * startZ;
    let amount = null;
    if (startDistanceSq <= radiusSq) {
      amount = 0;
    } else if (moveLengthSq > 1e-8) {
      const along = startX * moveX + startZ * moveZ;
      const discriminant = along * along - moveLengthSq * (startDistanceSq - radiusSq);
      if (discriminant >= 0) {
        const candidate = (-along - Math.sqrt(discriminant)) / moveLengthSq;
        if (candidate >= 0 && candidate <= 1) amount = candidate;
      }
    }
    onFootPlayerContactDiagnostics.contactTests += 1;
    if (amount === null) return null;

    const contactX = probe.start.x + moveX * amount;
    const contactZ = probe.start.z + moveZ * amount;
    let normalX = contactX - data.mesh.position.x;
    let normalZ = contactZ - data.mesh.position.z;
    let normalLength = Math.hypot(normalX, normalZ);
    if (normalLength < 1e-5) {
      normalX = -moveX;
      normalZ = -moveZ;
      normalLength = Math.hypot(normalX, normalZ);
    }
    if (normalLength < 1e-5) {
      normalX = Math.cos(data.heading + (data.index % 2 ? Math.PI : 0));
      normalZ = -Math.sin(data.heading + (data.index % 2 ? Math.PI : 0));
      normalLength = 1;
    }
    normalX /= normalLength;
    normalZ /= normalLength;
    const moveLength = Math.sqrt(moveLengthSq);
    const safeAmount = moveLength > 1e-5
      ? Math.max(0, amount - ON_FOOT_CONTACT_MARGIN / moveLength)
      : 0;
    return {
      amount,
      safeAmount,
      radius,
      normalX,
      normalZ,
      contactX,
      contactZ,
    };
  }

  function applyPlayerContactYield(data, contact) {
    const rightX = Math.cos(data.heading);
    const rightZ = -Math.sin(data.heading);
    const awayX = data.mesh.position.x - contact.contactX;
    const awayZ = data.mesh.position.z - contact.contactZ;
    const sideDot = awayX * rightX + awayZ * rightZ;
    const side = Math.abs(sideDot) > 0.02
      ? Math.sign(sideDot)
      : (data.index % 2 === 0 ? 1 : -1);
    const laneShift = side * ON_FOOT_PLAYER_YIELD_SHIFT;
    data.laneOffset = THREE.MathUtils.clamp(
      data.laneOffset + laneShift,
      -LATERAL_DRIFT,
      LATERAL_DRIFT,
    );
    if (!data.transfer && data.state !== STATE_CROSS) {
      data.transfer = {
        target: data.mesh.position.clone().add(new THREE.Vector3(
          rightX * laneShift,
          0,
          rightZ * laneShift,
        )),
        playerYield: true,
      };
    }
    const userData = data.mesh.userData || (data.mesh.userData = {});
    userData.playerYieldUntil = lastUpdateElapsed + 0.55;
    userData.playerYieldSide = side;
    userData.playerYieldCount = (Number(userData.playerYieldCount) || 0) + 1;
    onFootPlayerContactDiagnostics.yields += 1;
    return { side, distance: ON_FOOT_PLAYER_YIELD_SHIFT };
  }

  function resolveOnFootPlayerContact() {
    const probe = onFootPlayerCollisionProbe;
    onFootPlayerCollisionProbe = null;
    if (!probe) {
      onFootPlayerCollisionLatch.clear();
      return null;
    }
    onFootPlayerContactDiagnostics.probes += 1;
    onFootPlayerContactDiagnostics.lastProbe = {
      start: { ...probe.start },
      end: { ...probe.end },
      radius: probe.radius,
    };
    const nextLatch = new Set();
    let best = null;
    for (const data of pool) {
      if (!livingPlayerContactResident(data)) continue;
      const identity = residentIdentityFor(data);
      const endDistance = Math.hypot(
        probe.end.x - data.mesh.position.x,
        probe.end.z - data.mesh.position.z,
      );
      const combinedRadius = probe.radius + ON_FOOT_PEDESTRIAN_RADIUS;
      if (onFootPlayerCollisionLatch.has(identity.id)) {
        const awayProgress = (probe.end.x - probe.start.x)
          * (probe.start.x - data.mesh.position.x)
          + (probe.end.z - probe.start.z)
          * (probe.start.z - data.mesh.position.z);
        const deliberatelySeparated = endDistance - combinedRadius > ON_FOOT_CONTACT_REARM_GAP
          && awayProgress > 1e-4;
        if (!deliberatelySeparated) {
          nextLatch.add(identity.id);
        } else {
          onFootPlayerContactDiagnostics.rearmed += 1;
        }
      }
      const contact = sweptPlayerResidentContact(probe, data);
      if (!contact) continue;
      const candidate = { data, identity, contact };
      if (!best
        || contact.amount < best.contact.amount - 1e-7
        || (Math.abs(contact.amount - best.contact.amount) <= 1e-7
          && identity.id.localeCompare(best.identity.id) < 0)) {
        best = candidate;
      }
    }
    onFootPlayerCollisionLatch = nextLatch;
    if (!best) return null;

    const { data, identity, contact } = best;
    const wasLatched = onFootPlayerCollisionLatch.has(identity.id);
    onFootPlayerCollisionLatch.add(identity.id);
    const newContact = !wasLatched;
    const correctedPosition = contact.amount === 0
      ? {
        x: data.mesh.position.x + contact.normalX * (contact.radius + ON_FOOT_CONTACT_MARGIN),
        z: data.mesh.position.z + contact.normalZ * (contact.radius + ON_FOOT_CONTACT_MARGIN),
      }
      : {
        x: THREE.MathUtils.lerp(probe.start.x, probe.end.x, contact.safeAmount),
        z: THREE.MathUtils.lerp(probe.start.z, probe.end.z, contact.safeAmount),
      };
    const yieldState = newContact ? applyPlayerContactYield(data, contact) : null;
    const event = {
      kind: 'on-foot-pedestrian-contact',
      residentId: identity.id,
      residentIndex: data.index,
      residentObjectUuid: data.mesh.uuid,
      residentLabel: identity.label,
      role: data.job.id,
      newContact,
      latched: !newContact,
      contactAmount: Math.round(contact.amount * 1000) / 1000,
      safeAmount: Math.round(contact.safeAmount * 1000) / 1000,
      playerRadius: probe.radius,
      pedestrianRadius: ON_FOOT_PEDESTRIAN_RADIUS,
      separation: probe.radius + ON_FOOT_PEDESTRIAN_RADIUS + ON_FOOT_CONTACT_MARGIN,
      residentPosition: {
        x: data.mesh.position.x,
        y: data.mesh.position.y,
        z: data.mesh.position.z,
      },
      contactPoint: { x: contact.contactX, z: contact.contactZ },
      normal: { x: contact.normalX, z: contact.normalZ },
      correctedPosition,
      yield: yieldState,
    };
    onFootPlayerContactDiagnostics.corrections += 1;
    if (newContact) onFootPlayerContactDiagnostics.contacts += 1;
    const consequence = onPlayerCrowdContact?.(event) ?? null;
    const appliedPosition = Number.isFinite(consequence?.correctedPosition?.x)
      && Number.isFinite(consequence?.correctedPosition?.z)
      ? { ...consequence.correctedPosition }
      : { ...correctedPosition };
    const resolvedEvent = consequence && typeof consequence === 'object'
      ? { ...event, correctedPosition: appliedPosition, consequence: { ...consequence } }
      : { ...event, correctedPosition: appliedPosition };
    resolvedEvent.finalClearance = Math.hypot(
      appliedPosition.x - data.mesh.position.x,
      appliedPosition.z - data.mesh.position.z,
    ) - contact.radius;
    resolvedEvent.finalOverlap = resolvedEvent.finalClearance < -1e-4;
    onFootPlayerContactDiagnostics.lastCorrection = resolvedEvent;
    if (newContact) onFootPlayerContactDiagnostics.lastContact = resolvedEvent;
    return resolvedEvent;
  }

  function update(dt = 0, elapsed = 0) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const delta = Math.min(dt, MAX_DT);
    lastUpdateElapsed = Number.isFinite(elapsed) ? elapsed : lastUpdateElapsed + delta;
    for (const data of pool) {
      if (!data.path) continue;
      if (keepOutOfCableCarAperture(data)) continue;
      const points = pointsForPath(data.path);
      if (!points || points.length < 2) continue;

      // Apply QA force-walk before navigation so the subject actually advances
      // this frame instead of animating a frozen idle stance.
      if (qaForceWalkIndex != null && (
        data.index === qaForceWalkIndex
        || group.children.indexOf(data.mesh) === qaForceWalkIndex
      )) {
        if (data.state !== STATE_WALK && data.state !== STATE_CROSS) {
          setBehaviorState(data, STATE_WALK, 20, 'qa:force-walk');
        }
        data.destinationReached = false;
        data.gaitBlend = 1;
        data.timer = Math.max(data.timer, 10);
        data.speed = Math.max(data.speed, WALK_SPEED * 0.92);
        data.walkPace = Math.max(data.walkPace || 1, 1);
      }

      let transferStep = false;
      if (data.transfer) {
        const transfer = data.transfer;
        transferStep = true;
        if (moveTo(data, transfer.target, delta, moveSpeedFor(data) * 1.25, { ignorePush: true })) {
          data.mesh.position.copy(transfer.target);
          data.groundY = transfer.target.y;
          data.transfer = null;
        }
      } else if (data.state === STATE_CROSS) {
        updateCrossing(data, delta, elapsed);
      } else if (data.state === STATE_IDLE || data.state === STATE_WORK) {
        data.timer -= delta;
        if (data.timer <= 0) {
          setBehaviorState(data, STATE_WALK);
        }
        if (data.state === STATE_WALK) {
          data.grade = pathGradeFor(data);
          data.t += (moveSpeedFor(data) * delta)
            / Math.max(0.1, points[data.segment].distanceTo(points[data.segment + 1]));
        }
      } else {
        data.grade = pathGradeFor(data);
        data.t += (moveSpeedFor(data) * delta)
          / Math.max(0.1, points[data.segment].distanceTo(points[data.segment + 1]));
      }

      if (data.transfer) transferStep = true;
      if (!transferStep && data.state === STATE_WALK && data.t >= 1) {
        data.t = 1;
        advance(data);
        if (data.transfer) transferStep = true;
      }
      if (!transferStep
        && data.state !== STATE_CROSS && data.state !== STATE_IDLE && data.state !== STATE_WORK) {
        if (sample(data, position)) {
          data.mesh.position.copy(position);
          if (data.pushX) {
            data.mesh.position.x += data.pushX;
            data.mesh.position.z += data.pushZ;
          }
          const desired = Math.atan2(direction.x, direction.z);
          turnToward(data, desired, delta, 10);
        }
      }
      // QA harness: keep force-walk flags hot; BT skipped while forced.
      if (qaForceWalkIndex != null && (
        data.index === qaForceWalkIndex
        || group.children.indexOf(data.mesh) === qaForceWalkIndex
      )) {
        // already applied pre-nav
      } else {
        tickNpcBehavior(data, delta);
      }
      if (qaWitnessResidentId === residentIdentityFor(data).id && qaWitnessPosition) {
        data.mesh.position.set(
          qaWitnessPosition.x,
          qaWitnessPosition.y,
          qaWitnessPosition.z,
        );
      }
      const combatReactionActive = applyCombatReactionMovement(data, delta);
      animate(data, elapsed, delta);
      applyCombatReactionPose(data, elapsed, combatReactionActive);
      applyVehicleImpactPose(data, elapsed);
      applyVehicleWitnessReaction(data, delta, elapsed);

      const soloMesh = qaSoloGroupIndex != null ? group.children[qaSoloGroupIndex] : null;
      const visible = soloMesh
        ? data.mesh === soloMesh
        : !focusActive
          || (data.mesh.position.x - focusX) ** 2
            + (data.mesh.position.z - focusZ) ** 2 <= focusRadiusSquared;
      data.mesh.visible = visible;

      shadowPosition.set(data.mesh.position.x, data.mesh.position.y + 0.012, data.mesh.position.z);
      const strideShadow = 1 + Math.abs(Math.sin(elapsed * 5.7 * data.cadence + data.phase)) * data.gaitBlend * 0.08;
      shadowScale.set(
        visible ? data.mesh.scale.x * 0.92 * strideShadow : 0,
        visible ? 1 : 0,
        visible ? data.mesh.scale.z * 0.5 : 0,
      );
      shadowMatrix.compose(shadowPosition, shadowQuaternion, shadowScale);
      contactShadows.setMatrixAt(data.index, shadowMatrix);
    }

    // Rebuild a tiny allocation-free uniform grid and inspect only nearby
    // cells. This preserves personal space without a 48×48 scan every frame.
    for (const bucket of activeCrowdBuckets) bucket.length = 0;
    activeCrowdBuckets.length = 0;
    crowdGrid.clear();
    for (const data of pool) {
      if (!data.mesh.visible) continue;
      data.gridCellX = Math.floor(data.mesh.position.x / CROWD_CELL_SIZE);
      data.gridCellZ = Math.floor(data.mesh.position.z / CROWD_CELL_SIZE);
      const key = data.gridCellX * CROWD_CELL_STRIDE + data.gridCellZ;
      let bucket = crowdGrid.get(key);
      if (!bucket) {
        bucket = crowdBuckets[activeCrowdBuckets.length];
        bucket.length = 0;
        activeCrowdBuckets.push(bucket);
        crowdGrid.set(key, bucket);
      }
      bucket.push(data);
    }

    // Crowd spacing: walkers gently veer around neighbors within personal
    // space so people stop occupying each other. The shove is stored and
    // consumed by `moveTo`/path sampling on the next frame so it blends with
    // locomotion instead of teleporting anyone across curbs. Stationary
    // actors only drift apart slowly so the moving crowd mostly flows around
    // them, but idle pairs never stand inside each other.
    const personalSpaceSq = PERSONAL_SPACE * PERSONAL_SPACE;
    for (const data of pool) {
      data.pushX = 0;
      data.pushZ = 0;
      if (!data.mesh.visible) continue;
      const moving = data.state === STATE_WALK
        || (data.state === STATE_CROSS && data.crossing?.phase === 'cross');
      // A passing neighbor should create a temporary sidestep, not permanently
      // move a pedestrian onto the curb. Recover the preferred sidewalk lane
      // whenever the local cell is clear.
      data.laneOffset = THREE.MathUtils.damp(
        data.laneOffset,
        data.laneOffsetHome ?? data.laneOffset,
        moving ? 2.8 : 4.2,
        delta,
      );
      let pushX = 0;
      let pushZ = 0;
      let overtakePush = 0;
      const fwdX = Math.sin(data.heading);
      const fwdZ = Math.cos(data.heading);
      for (let cellX = data.gridCellX - 1; cellX <= data.gridCellX + 1; cellX += 1) {
        for (let cellZ = data.gridCellZ - 1; cellZ <= data.gridCellZ + 1; cellZ += 1) {
          const bucket = crowdGrid.get(cellX * CROWD_CELL_STRIDE + cellZ);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === data) continue;
            const dx = data.mesh.position.x - other.mesh.position.x;
            const dz = data.mesh.position.z - other.mesh.position.z;
            const distSq = dx * dx + dz * dz;
            if (distSq >= personalSpaceSq || distSq < 1e-6) continue;
            const dist = Math.sqrt(distSq);
            const falloff = (PERSONAL_SPACE - dist) / PERSONAL_SPACE;
            pushX += (dx / dist) * falloff;
            pushZ += (dz / dist) * falloff;
            // Overtaking: turn a follower's pure repulsion into a lateral
            // swing so walkers pass instead of locking into a slow pair.
            if (moving && data.speed > other.speed + 0.05) {
              const along = dx * fwdX + dz * fwdZ;
              const headingDot = fwdX * Math.sin(other.heading) + fwdZ * Math.cos(other.heading);
              if (along < -0.2 && headingDot > 0.8) overtakePush += falloff;
            }
          }
        }
      }
      if (pushX === 0 && pushZ === 0) continue;
      const step = Math.min(1.6, Math.hypot(pushX, pushZ)) * SEPARATION_FORCE * delta;
      const inv = 1 / (Math.hypot(pushX, pushZ) || 1);
      if (overtakePush > 0) {
        // Sidestep to the walker's left, scaled by how much of the shove
        // came from the overtake target.
        const side = overtakePush / (Math.abs(pushX) + Math.abs(pushZ) + 1e-6);
        pushX += -fwdZ * side * 1.4;
        pushZ += fwdX * side * 1.4;
      }
      data.pushX = pushX * inv * step;
      data.pushZ = pushZ * inv * step;
      if (!moving) {
        // Stationary pairs (conversations, workers near a curb) still drift
        // apart slowly instead of standing inside each other.
        data.mesh.position.x += data.pushX * 0.6;
        data.mesh.position.z += data.pushZ * 0.6;
        data.pushX = 0;
        data.pushZ = 0;
        continue;
      }
      // Blend the shove into a temporary lane shift so the visual path
      // sampling and the collision response agree instead of fighting.
      const forwardX = Math.sin(data.heading);
      const forwardZ = Math.cos(data.heading);
      data.laneOffset = THREE.MathUtils.clamp(
        data.laneOffset + (pushX * forwardZ - pushZ * forwardX) * inv * step * 0.5,
        -LATERAL_DRIFT,
        LATERAL_DRIFT,
      );
    }

    resolveOnFootPlayerContact();
    contactShadows.instanceMatrix.needsUpdate = true;
  }

  function residentIdentityFor(data) {
    const featured = FEATURED_RESIDENTS[data.index];
    if (featured?.actorIndex === data.index) return featured;
    const serial = String(data.index + 1).padStart(2, '0');
    return { id: `resident-${serial}`, label: `Resident ${serial}` };
  }

  function clonePlayerContactEvent(event) {
    if (!event) return null;
    return {
      ...event,
      correctedPosition: event.correctedPosition ? { ...event.correctedPosition } : null,
      residentPosition: event.residentPosition ? { ...event.residentPosition } : null,
      contactPoint: event.contactPoint ? { ...event.contactPoint } : null,
      normal: event.normal ? { ...event.normal } : null,
      yield: event.yield ? { ...event.yield } : null,
      consequence: event.consequence ? { ...event.consequence } : undefined,
    };
  }

  function getOnFootPlayerContactDiagnostics() {
    return {
      probes: onFootPlayerContactDiagnostics.probes,
      contactTests: onFootPlayerContactDiagnostics.contactTests,
      corrections: onFootPlayerContactDiagnostics.corrections,
      contacts: onFootPlayerContactDiagnostics.contacts,
      rearmed: onFootPlayerContactDiagnostics.rearmed,
      yields: onFootPlayerContactDiagnostics.yields,
      activeLatchCount: onFootPlayerCollisionLatch.size,
      latchedResidentIds: [...onFootPlayerCollisionLatch].sort(),
      lastProbe: onFootPlayerContactDiagnostics.lastProbe
        ? {
          start: { ...onFootPlayerContactDiagnostics.lastProbe.start },
          end: { ...onFootPlayerContactDiagnostics.lastProbe.end },
          radius: onFootPlayerContactDiagnostics.lastProbe.radius,
        }
        : null,
      lastCorrection: clonePlayerContactEvent(onFootPlayerContactDiagnostics.lastCorrection),
      lastContact: clonePlayerContactEvent(onFootPlayerContactDiagnostics.lastContact),
      thresholds: {
        defaultPlayerRadius: ON_FOOT_PLAYER_RADIUS,
        pedestrianRadius: ON_FOOT_PEDESTRIAN_RADIUS,
        margin: ON_FOOT_CONTACT_MARGIN,
        rearmGap: ON_FOOT_CONTACT_REARM_GAP,
        yieldShift: ON_FOOT_PLAYER_YIELD_SHIFT,
      },
    };
  }

  function resetOnFootPlayerContactDiagnostics() {
    onFootPlayerCollisionProbe = null;
    onFootPlayerCollisionLatch.clear();
    onFootPlayerContactDiagnostics.probes = 0;
    onFootPlayerContactDiagnostics.contactTests = 0;
    onFootPlayerContactDiagnostics.corrections = 0;
    onFootPlayerContactDiagnostics.contacts = 0;
    onFootPlayerContactDiagnostics.rearmed = 0;
    onFootPlayerContactDiagnostics.yields = 0;
    onFootPlayerContactDiagnostics.lastProbe = null;
    onFootPlayerContactDiagnostics.lastCorrection = null;
    onFootPlayerContactDiagnostics.lastContact = null;
  }

  function clearOnFootPlayerContactQaStage() {
    const staged = qaPlayerContactStage;
    if (!staged) return false;
    const { data, restore } = staged;
    data.mesh.position.copy(restore.position);
    data.mesh.rotation.y = restore.rotationY;
    data.mesh.visible = restore.visible;
    data.state = restore.state;
    data.path = restore.path;
    data.segment = restore.segment;
    data.direction = restore.direction;
    data.t = restore.t;
    data.beautyRoute = restore.beautyRoute;
    data.timer = restore.timer;
    data.vignette = restore.vignette;
    data.interaction = restore.interaction;
    data.stationAnchor = restore.stationAnchor?.clone?.() ?? restore.stationAnchor;
    data.crossing = restore.crossing;
    data.transfer = restore.transfer;
    data.heading = restore.heading;
    data.groundY = restore.groundY;
    data.laneOffset = restore.laneOffset;
    data.laneOffsetHome = restore.laneOffsetHome;
    data.destination = restore.destination?.clone?.() ?? restore.destination;
    data.destinationKind = restore.destinationKind;
    data.destinationReached = restore.destinationReached;
    data.walkPace = restore.walkPace;
    const userData = data.mesh.userData || (data.mesh.userData = {});
    userData.playerYieldUntil = restore.playerYieldUntil;
    userData.playerYieldSide = restore.playerYieldSide;
    userData.playerYieldCount = restore.playerYieldCount;
    qaSoloGroupIndex = restore.qaSoloGroupIndex;
    qaForceWalkIndex = restore.qaForceWalkIndex;
    qaPlayerContactStage = null;
    resetOnFootPlayerContactDiagnostics();
    return true;
  }

  function stageOnFootPlayerContactQa({ kind = 'contact' } = {}) {
    if (!['contact', 'diagonal', 'empty'].includes(kind)) return null;
    clearOnFootPlayerContactQaStage();
    const data = pool.find((entry) => (
      entry.hero === true
      && entry.job.id === 'phone'
      && entry.path
      && livingPlayerContactResident(entry)
      && !occupiesCableCarAperture(entry)
    )) || pool.find((entry) => entry.path && livingPlayerContactResident(entry));
    if (!data) return null;
    const identity = residentIdentityFor(data);
    const userData = data.mesh.userData || (data.mesh.userData = {});
    const restore = {
      position: data.mesh.position.clone(),
      rotationY: data.mesh.rotation.y,
      visible: data.mesh.visible,
      state: data.state,
      path: data.path,
      segment: data.segment,
      direction: data.direction,
      t: data.t,
      beautyRoute: data.beautyRoute,
      timer: data.timer,
      vignette: data.vignette,
      interaction: data.interaction,
      stationAnchor: data.stationAnchor?.clone?.() ?? data.stationAnchor,
      crossing: data.crossing,
      transfer: data.transfer,
      heading: data.heading,
      groundY: data.groundY,
      laneOffset: data.laneOffset,
      laneOffsetHome: data.laneOffsetHome,
      destination: data.destination?.clone?.() ?? data.destination,
      destinationKind: data.destinationKind,
      destinationReached: data.destinationReached,
      walkPace: data.walkPace,
      playerYieldUntil: userData.playerYieldUntil,
      playerYieldSide: userData.playerYieldSide,
      playerYieldCount: userData.playerYieldCount,
      qaSoloGroupIndex,
      qaForceWalkIndex,
    };
    const groupIndex = group.children.indexOf(data.mesh);
    qaSoloGroupIndex = groupIndex;
    qaForceWalkIndex = null;

    // Use an actual waypoint on the broad north sidewalk of the eastern core
    // block. This keeps the hero's feet on authoritative sidewalk elevation
    // while leaving road-side camera room; the former phone-hero position sat
    // in a narrow facade pocket whose raised parcel hid the contact at eye level.
    let openWaypoint = null;
    const openTargetX = 56;
    const openTargetZ = 55.15;
    for (const path of paths) {
      const pathPoints = pointsForPath(path);
      for (let pointIndex = 0; pointIndex < pathPoints.length - 1; pointIndex += 1) {
        const candidate = pathPoints[pointIndex];
        const distanceSq = (candidate.x - openTargetX) ** 2
          + (candidate.z - openTargetZ) ** 2;
        if (!openWaypoint || distanceSq < openWaypoint.distanceSq) {
          openWaypoint = { path, pointIndex, distanceSq };
        }
      }
    }
    if (openWaypoint) {
      const pathPoints = pointsForPath(openWaypoint.path);
      data.path = openWaypoint.path;
      data.beautyRoute = false;
      data.direction = 1;
      data.segment = Math.min(openWaypoint.pointIndex, pathPoints.length - 2);
      data.t = openWaypoint.pointIndex >= pathPoints.length - 1 ? 1 : 0;
      data.laneOffset = 0;
      data.laneOffsetHome = 0;
      setDestinationFor(data);
      if (sample(data, position)) {
        data.mesh.position.copy(position);
        data.groundY = position.y;
        data.heading = Math.atan2(direction.x, direction.z);
        data.mesh.rotation.y = data.heading;
      }
    }
    setBehaviorState(data, STATE_IDLE, 30, 'qa:player-contact');
    data.crossing = null;
    data.transfer = null;
    data.mesh.visible = true;
    data.groundY = data.mesh.position.y;
    const forwardX = Math.sin(data.heading);
    const forwardZ = Math.cos(data.heading);
    const rightX = Math.cos(data.heading);
    const rightZ = -Math.sin(data.heading);
    const lateral = kind === 'diagonal'
      ? 0.62
      : kind === 'empty'
        ? ON_FOOT_PLAYER_RADIUS + ON_FOOT_PEDESTRIAN_RADIUS + 0.56
        : 0;
    const start = {
      x: data.mesh.position.x + forwardX * 1.7 + rightX * lateral,
      y: data.mesh.position.y,
      z: data.mesh.position.z + forwardZ * 1.7 + rightZ * lateral,
    };
    const yaw = kind === 'empty'
      ? Math.atan2(-forwardX, -forwardZ)
      : Math.atan2(
        data.mesh.position.x - start.x,
        data.mesh.position.z - start.z,
      ) + Math.PI;
    qaPlayerContactStage = { kind, data, identity, restore, start, yaw };
    resetOnFootPlayerContactDiagnostics();
    return {
      ready: true,
      syntheticEvents: 0,
      kind,
      residentId: identity.id,
      residentIndex: data.index,
      residentGroupIndex: groupIndex,
      residentObjectUuid: data.mesh.uuid,
      playerPose: {
        position: { ...start },
        yaw,
      },
    };
  }

  function getOnFootPlayerContactQaState() {
    const staged = qaPlayerContactStage;
    const diagnostics = getOnFootPlayerContactDiagnostics();
    const data = staged?.data
      || (diagnostics.lastCorrection
        ? pool.find((entry) => residentIdentityFor(entry).id
          === diagnostics.lastCorrection.residentId)
        : null);
    const identity = data ? residentIdentityFor(data) : null;
    const userData = data?.mesh?.userData || {};
    const corrected = diagnostics.lastCorrection?.correctedPosition;
    const combinedRadius = (diagnostics.lastCorrection?.playerRadius ?? ON_FOOT_PLAYER_RADIUS)
      + ON_FOOT_PEDESTRIAN_RADIUS;
    const clearance = data && corrected
      ? Math.hypot(
        corrected.x - data.mesh.position.x,
        corrected.z - data.mesh.position.z,
      ) - combinedRadius
      : null;
    return {
      active: Boolean(staged),
      kind: staged?.kind ?? null,
      syntheticEvents: 0,
      resident: data && identity ? {
        id: identity.id,
        index: data.index,
        objectUuid: data.mesh.uuid,
        visible: data.mesh.visible === true,
        live: userData.combatDefeated !== true && userData.combatDisabled !== true,
        defeated: userData.combatDefeated === true || userData.combatDisabled === true,
        position: {
          x: data.mesh.position.x,
          y: data.mesh.position.y,
          z: data.mesh.position.z,
        },
        groundY: data.groundY,
        yield: {
          active: (Number(userData.playerYieldUntil) || 0) > lastUpdateElapsed,
          side: Number(userData.playerYieldSide) || 0,
          count: Number(userData.playerYieldCount) || 0,
          remaining: Math.max(
            0,
            (Number(userData.playerYieldUntil) || 0) - lastUpdateElapsed,
          ),
        },
      } : null,
      collision: {
        finalClearance: clearance,
        finalOverlap: Number.isFinite(clearance) ? clearance < -1e-4 : false,
        latchedResidentIds: diagnostics.latchedResidentIds,
        lastCorrection: diagnostics.lastCorrection,
        lastContact: diagnostics.lastContact,
      },
      diagnostics,
    };
  }

  function residentDestinationFor(data) {
    return data.destinationKind || data.schedule?.destination || 'sidewalk stop';
  }

  function residentActivityFor(data) {
    if (data.state === STATE_CROSS) {
      if (data.crossing?.phase === 'wait') return 'waiting to cross';
      if (data.crossing?.phase === 'cross') return 'crossing';
      return 'approaching a crossing';
    }
    if (data.state === STATE_WORK) return 'working';
    if (data.state === STATE_IDLE) {
      return data.interaction?.kind === 'conversation' ? 'in conversation' : 'paused';
    }
    return 'walking';
  }

  function residentActionFor(data, destination) {
    const interaction = data.interaction;
    if (interaction?.kind === 'conversation') {
      return interaction.side === 'listener' ? 'listening to a neighbor' : 'chatting with a neighbor';
    }
    if (interaction?.kind === 'handoff') {
      return interaction.side === 'courier' ? 'handing over a parcel' : 'receiving a delivery';
    }
    if (data.state === STATE_CROSS) {
      if (data.crossing?.phase === 'wait') return 'checking the signal';
      if (data.crossing?.phase === 'cross') return `crossing toward ${destination}`;
      return `approaching the crosswalk to ${destination}`;
    }
    if (data.state === STATE_WORK) {
      switch (data.job.id) {
        case 'courier': return 'making a delivery';
        case 'barista': return 'working the coffee counter';
        case 'worker': return 'working the job site';
        case 'tourist': return 'taking a viewpoint photo';
        case 'cleaner': return 'sweeping the cleanup zone';
        case 'phone': return 'checking the phone';
        default: return `working at ${destination}`;
      }
    }
    if (data.state === STATE_IDLE) {
      if (data.job.id === 'tourist') return 'taking in the view';
      if (data.job.id === 'phone') return 'checking the phone';
      return `pausing at ${destination}`;
    }
    switch (data.job.prop) {
      case 'parcel': return 'walking with a parcel';
      case 'coffee': return 'carrying coffee';
      case 'camera': return `walking toward ${destination}`;
      case 'broom': return 'heading to the cleanup zone';
      case 'phone': return 'walking while checking the phone';
      case 'worker': return 'heading to the job site';
      default: return `heading toward ${destination}`;
    }
  }

  // These are operational needs inferred from the live schedule, not claims
  // about private motives. Keeping them destination-based makes the snapshot
  // useful without inventing resident simulation that does not exist.
  function residentNeedFor(data, destination) {
    if (data.interaction?.kind === 'conversation') return 'a brief exchange with a neighbor';
    if (data.interaction?.kind === 'handoff') {
      return data.interaction.side === 'courier'
        ? 'to complete the delivery handoff'
        : 'to receive the delivery';
    }
    if (data.state === STATE_CROSS) {
      if (data.crossing?.phase === 'wait') return `a safe crossing to ${destination}`;
      if (data.crossing?.phase === 'cross') return 'to clear the crossing safely';
      return 'to reach the crosswalk';
    }
    if (data.state === STATE_WORK) return `to finish at ${destination}`;
    if (data.state === STATE_IDLE) return `a short pause at ${destination}`;
    return `to reach ${destination}`;
  }

  function residentIntentFor(data, destination) {
    if (data.interaction?.kind === 'conversation') {
      return data.interaction.side === 'listener'
        ? 'listen before moving on'
        : 'share a quick update';
    }
    if (data.interaction?.kind === 'handoff') {
      return data.interaction.side === 'courier'
        ? 'get the parcel to the counter'
        : 'get the order ready for the next stop';
    }
    if (data.state === STATE_CROSS) {
      if (data.crossing?.phase === 'wait') return 'wait for a walk signal';
      if (data.crossing?.phase === 'cross') return 'get across before clearance';
      return 'approach the crosswalk';
    }
    if (data.state === STATE_WORK) return `work at ${destination}`;
    if (data.state === STATE_IDLE) return `pause, then continue toward ${destination}`;
    return `continue toward ${destination}`;
  }

  // "Mood" is visible-mode shorthand, not an emotional diagnosis. "Choice"
  // names the state-machine branch currently being executed, so neither field
  // invents private preferences that the simulation does not model.
  function residentMoodAndChoiceFor(data) {
    if (data.interaction?.kind === 'conversation') {
      return {
        mood: 'social',
        choice: data.interaction.side === 'listener' ? 'listen' : 'speak',
      };
    }
    if (data.interaction?.kind === 'handoff') {
      return {
        mood: 'engaged',
        choice: data.interaction.side === 'courier'
          ? 'hand over the parcel'
          : 'receive the delivery',
      };
    }
    if (data.state === STATE_CROSS) {
      if (data.crossing?.phase === 'wait') {
        return { mood: 'watchful', choice: 'wait for the walk signal' };
      }
      if (data.crossing?.phase === 'cross') {
        return {
          mood: data.crossing.hurried ? 'hurrying' : 'steady',
          choice: 'finish crossing',
        };
      }
      return { mood: 'watchful', choice: 'approach the crosswalk' };
    }
    if (data.state === STATE_WORK) {
      return { mood: 'occupied', choice: `stay at ${residentDestinationFor(data)}` };
    }
    if (data.state === STATE_IDLE) return { mood: 'paused', choice: 'pause here' };
    return { mood: 'on the move', choice: 'continue along the route' };
  }

  function residentSceneCueFor(data) {
    if (data.interaction?.kind === 'handoff') return 'delivery handoff';
    if (data.interaction?.kind === 'conversation') return 'conversation';
    const vignette = data.vignette;
    if (!vignette) return null;
    const separator = vignette.indexOf(':');
    const kind = separator >= 0 ? vignette.slice(0, separator) : vignette;
    const detail = separator >= 0 ? vignette.slice(separator + 1) : '';
    if (kind === 'viewpoint') return 'viewpoint pause';
    if (kind === 'work') return detail ? `work stop: ${detail}` : 'work stop';
    if (kind === 'activity') return detail ? `role activity: ${detail}` : 'role activity';
    if (kind === 'dwelling') return detail ? `pause: ${detail}` : 'pause';
    if (kind === 'crossing') return 'crosswalk';
    return vignette;
  }

  function getFeaturedResidentSnapshots() {
    return FEATURED_RESIDENTS.map((identity) => {
      const data = pool[identity.actorIndex];
      if (!data) return null;
      const destination = residentDestinationFor(data);
      const partner = data.interaction?.partner;
      const partnerIdentity = partner ? residentIdentityFor(partner) : null;
      const { mood, choice } = residentMoodAndChoiceFor(data);
      return {
        id: identity.id,
        label: identity.label,
        role: data.job.id,
        activity: residentActivityFor(data),
        action: residentActionFor(data, destination),
        mood,
        choice,
        destination,
        need: residentNeedFor(data, destination),
        intent: residentIntentFor(data, destination),
        visible: data.mesh.visible,
        relationship: partner
          ? {
            kind: data.interaction.kind,
            actorId: partnerIdentity.id,
            actorLabel: partnerIdentity.label,
            role: partner.job?.id || null,
            side: data.interaction.side || null,
          }
          : null,
        sceneCue: residentSceneCueFor(data),
      };
    }).filter(Boolean);
  }

  function getStats() {
    let walking = 0;
    let working = 0;
    let paused = 0;
    let crossing = 0;
    let withBehaviorTree = 0;
    const intentCounts = Object.create(null);
    for (const data of pool) {
      if (data.state === STATE_WALK) walking += 1;
      if (data.state === STATE_WORK) working += 1;
      if (data.state === STATE_IDLE) paused += 1;
      if (data.state === STATE_CROSS) crossing += 1;
      if (data.behaviorTree) withBehaviorTree += 1;
      const intent = data.btIntent || data.blackboard?.intent || 'none';
      intentCounts[intent] = (intentCounts[intent] || 0) + 1;
    }
    return {
      active: pool.length,
      visible: pool.reduce((count, data) => count + (data.mesh.visible ? 1 : 0), 0),
      walking,
      working,
      paused,
      crossing,
      withBehaviorTree,
      intentCounts,
      dayHour: getDayHour(),
    };
  }

  function setFocus(position, radius = 340) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
      focusActive = false;
      focusRadiusSquared = Infinity;
      return;
    }
    focusActive = true;
    focusX = position.x;
    focusZ = position.z;
    const safeRadius = Number.isFinite(radius) ? Math.max(32, radius) : 340;
    focusRadiusSquared = safeRadius * safeRadius;
    if (qaSoloGroupIndex == null) {
      pool.forEach((data) => {
        data.mesh.visible = (data.mesh.position.x - focusX) ** 2
          + (data.mesh.position.z - focusZ) ** 2 <= focusRadiusSquared;
      });
    }
  }

  function setQaSolo(groupIndex = null, { forceWalk = true } = {}) {
    qaSoloGroupIndex = Number.isInteger(groupIndex) ? groupIndex : null;
    qaForceWalkIndex = qaSoloGroupIndex != null && forceWalk ? qaSoloGroupIndex : null;
    if (qaForceWalkIndex != null) {
      const data = pool.find((entry) => entry.index === qaForceWalkIndex)
        || pool.find((entry) => group.children.indexOf(entry.mesh) === qaForceWalkIndex);
      if (data) {
        setBehaviorState(data, STATE_WALK, 14, 'qa:force-walk');
        data.gaitBlend = 1;
      }
    }
  }

  function setQaWitnessAnchor(residentId = null, anchor = null) {
    if (typeof residentId !== 'string'
      || !Number.isFinite(anchor?.x)
      || !Number.isFinite(anchor?.y)
      || !Number.isFinite(anchor?.z)) {
      qaWitnessResidentId = null;
      qaWitnessPosition = null;
      return false;
    }
    const data = pool.find((entry) => residentIdentityFor(entry).id === residentId);
    if (!data?.mesh?.visible) return false;
    qaWitnessResidentId = residentId;
    qaWitnessPosition = { x: anchor.x, y: anchor.y, z: anchor.z };
    return true;
  }

  function setWeather(mode = 'clear') {
    system.weather = WEATHER_MODES.has(mode) ? mode : 'clear';
  }

  function getNearestPerson(position, maxDistance = 4, { includeDefeated = false } = {}) {
    if (!position) return null;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const data of pool) {
      if (!data.mesh.visible) continue;
      const combatDefeated = data.mesh.userData?.combatDefeated === true
        || data.mesh.userData?.combatDisabled === true;
      if (combatDefeated && !includeDefeated) continue;
      const distance = Math.hypot(
        data.mesh.position.x - position.x,
        data.mesh.position.z - position.z,
      );
      if (distance <= maxDistance && distance < nearestDistance) {
        const identity = residentIdentityFor(data);
        nearestDistance = distance;
        nearest = {
          id: identity.id,
          label: identity.label,
          role: data.job.id,
          mesh: data.mesh,
          job: data.job,
          distance,
          heading: data.heading,
          position: {
            x: data.mesh.position.x,
            y: data.mesh.position.y,
            z: data.mesh.position.z,
          },
          combatDefeated,
        };
      }
    }
    return nearest;
  }

  function getVehicleImpactCandidates(probe, out = []) {
    out.length = 0;
    if (!probe?.start || !probe?.end) return out;
    const padding = Math.max(0.8, Number(probe.halfWidth) || 0) + 0.7;
    const minX = Math.min(probe.start.x, probe.end.x) - padding;
    const maxX = Math.max(probe.start.x, probe.end.x) + padding;
    const minZ = Math.min(probe.start.z, probe.end.z) - padding;
    const maxZ = Math.max(probe.start.z, probe.end.z) + padding;
    for (const data of pool) {
      if (!data.mesh.visible) continue;
      const userData = data.mesh.userData || {};
      const combatDefeated = userData.combatDefeated === true
        || userData.combatDisabled === true;
      if (combatDefeated) continue;
      const { x, y, z } = data.mesh.position;
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const identity = residentIdentityFor(data);
      out.push({
        id: identity.id,
        label: identity.label,
        position: { x, y, z },
        heading: data.heading,
        radius: 0.42,
        combatDefeated: false,
        activity: data.state === STATE_CROSS
          ? `crossing:${data.crossing?.phase || 'approach'}`
          : data.state === STATE_WORK ? 'working'
            : data.state === STATE_IDLE ? 'paused' : 'walking',
      });
    }
    return out;
  }

  function getCombatCandidates(out = []) {
    out.length = 0;
    for (const data of pool) {
      if (!data.mesh.visible) continue;
      const userData = data.mesh.userData || {};
      if (userData.combatDefeated === true || userData.combatDisabled === true) continue;
      const identity = residentIdentityFor(data);
      out.push({
        kind: 'pedestrian',
        id: identity.id,
        residentId: identity.id,
        groupIndex: group.children.indexOf(data.mesh),
        label: identity.label,
        mesh: data.mesh,
        radius: 0.72,
        height: 1.18,
      });
    }
    return out;
  }

  function validateCombatAftermathState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1) return null;
    if (!Array.isArray(snapshot.residents)
      || snapshot.residents.length > MAX_PERSISTED_COMBAT_DEFEATS) return null;
    const seen = new Set();
    const records = [];
    for (const entry of snapshot.residents) {
      if (!entry || typeof entry !== 'object') return null;
      const residentId = typeof entry.residentId === 'string'
        ? entry.residentId.trim()
        : '';
      const role = typeof entry.role === 'string' ? entry.role.trim() : '';
      if (!residentId || residentId.length > 96 || !role || role.length > 48
        || seen.has(residentId)) return null;
      const data = pool.find((candidate) => residentIdentityFor(candidate).id === residentId);
      if (!data || data.job.id !== role) return null;
      seen.add(residentId);
      records.push({ residentId, role, data });
    }
    return records;
  }

  function exportCombatAftermathState() {
    const residents = [];
    for (const data of pool) {
      const userData = data.mesh.userData || {};
      if (userData.combatDefeated !== true && userData.combatDisabled !== true) continue;
      const identity = residentIdentityFor(data);
      residents.push({ residentId: identity.id, role: data.job.id });
      if (residents.length >= MAX_PERSISTED_COMBAT_DEFEATS) break;
    }
    return { version: 1, residents };
  }

  function canImportCombatAftermathState(snapshot) {
    return validateCombatAftermathState(snapshot) !== null;
  }

  function importCombatAftermathState(snapshot) {
    const records = validateCombatAftermathState(snapshot);
    if (!records) return false;
    pool.forEach((data) => {
      const userData = data.mesh.userData || (data.mesh.userData = {});
      userData.vehicleImpactCount = 0;
      userData.vehicleImpactUntil = 0;
      userData.vehicleImpactDirectionX = 0;
      userData.vehicleImpactDirectionZ = 0;
      if (userData.combatDefeated !== true && userData.combatDisabled !== true) return;
      data.mesh.rotation.z = 0;
      userData.combatHitCount = 0;
      userData.combatHitUntil = 0;
      userData.combatDisabled = false;
      userData.combatDefeated = false;
      userData.combatDefeatedAt = null;
      userData.combatReaction = 'settled';
      userData.combatReactionUntil = 0;
      userData.combatReactionSource = null;
      userData.combatReactionStrength = 0;
    });
    records.forEach(({ data }) => {
      const userData = data.mesh.userData || (data.mesh.userData = {});
      userData.combatDisabled = true;
      userData.combatDefeated = true;
      userData.combatDefeatedAt = 0;
      userData.combatReaction = 'staggered';
      userData.combatReactionUntil = Number.MAX_SAFE_INTEGER;
      userData.combatReactionSource = 'defeat-persisted';
      userData.combatReactionStrength = 1;
    });
    return true;
  }

  function clearCombatAftermathState() {
    return importCombatAftermathState({ version: 1, residents: [] });
  }

  function registerVehicleImpact(residentId, { directionX = 0, directionZ = 0 } = {}) {
    const data = pool.find((entry) => residentIdentityFor(entry).id === residentId);
    if (!data?.mesh?.visible) return null;
    const userData = data.mesh.userData || (data.mesh.userData = {});
    if (userData.combatDefeated === true || userData.combatDisabled === true) return null;
    const directionLength = Math.hypot(directionX, directionZ) || 1;
    userData.vehicleImpactUntil = lastUpdateElapsed + 1.35;
    userData.vehicleImpactDirectionX = directionX / directionLength;
    userData.vehicleImpactDirectionZ = directionZ / directionLength;
    userData.vehicleImpactCount = (Number(userData.vehicleImpactCount) || 0) + 1;
    const defeated = userData.vehicleImpactCount >= VEHICLE_IMPACT_DEFEAT_COUNT;
    if (defeated) {
      userData.combatDisabled = true;
      userData.combatDefeated = true;
      userData.combatDefeatedAt = Math.round(lastUpdateElapsed * 1000) / 1000;
      userData.combatReaction = 'staggered';
      userData.combatReactionUntil = Number.MAX_SAFE_INTEGER;
      userData.combatReactionSource = 'vehicle-impact';
      userData.combatReactionStrength = 1;
    }
    return {
      residentId,
      count: userData.vehicleImpactCount,
      reaction: defeated ? 'vehicle-defeated' : 'vehicle-stagger',
      remaining: 1.35,
      defeated,
    };
  }

  function getVehicleImpactState(residentId) {
    const data = pool.find((entry) => residentIdentityFor(entry).id === residentId);
    if (!data) return null;
    const userData = data.mesh.userData || {};
    return {
      residentId,
      count: Number(userData.vehicleImpactCount) || 0,
      active: (Number(userData.vehicleImpactUntil) || 0) > lastUpdateElapsed,
      remaining: Math.max(0, (Number(userData.vehicleImpactUntil) || 0) - lastUpdateElapsed),
      combatDefeated: userData.combatDefeated === true || userData.combatDisabled === true,
      position: {
        x: data.mesh.position.x,
        y: data.mesh.position.y,
        z: data.mesh.position.z,
      },
    };
  }

  function getVehicleImpactWitness(residentId, maxDistance = 18) {
    const victim = pool.find((entry) => residentIdentityFor(entry).id === residentId);
    if (!victim?.mesh?.visible) return null;
    const victimPosition = victim.mesh.position;
    const limit = Number.isFinite(maxDistance) ? Math.max(2, maxDistance) : 18;
    const candidates = [];
    for (const data of pool) {
      if (data === victim || !data.mesh.visible) continue;
      const userData = data.mesh.userData || {};
      if (userData.combatDefeated === true || userData.combatDisabled === true) continue;
      const distance = Math.hypot(
        data.mesh.position.x - victimPosition.x,
        data.mesh.position.z - victimPosition.z,
      );
      if (distance > limit) continue;
      const identity = residentIdentityFor(data);
      candidates.push({
        id: identity.id,
        label: identity.label,
        role: data.job.id,
        distance,
        position: {
          x: data.mesh.position.x,
          y: data.mesh.position.y,
          z: data.mesh.position.z,
        },
        victimPosition: {
          x: victimPosition.x,
          y: victimPosition.y,
          z: victimPosition.z,
        },
      });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    return candidates[0] || null;
  }

  function registerVehicleWitnessReaction(witnessId, {
    originX = 0,
    originZ = 0,
  } = {}) {
    const data = pool.find((entry) => residentIdentityFor(entry).id === witnessId);
    if (!data?.mesh?.visible) return null;
    const userData = data.mesh.userData || (data.mesh.userData = {});
    if (userData.combatDefeated === true || userData.combatDisabled === true) return null;
    let directionX = data.mesh.position.x - (Number(originX) || 0);
    let directionZ = data.mesh.position.z - (Number(originZ) || 0);
    const directionLength = Math.hypot(directionX, directionZ);
    if (directionLength < 0.001) {
      directionX = Math.sin(data.heading + Math.PI);
      directionZ = Math.cos(data.heading + Math.PI);
    } else {
      directionX /= directionLength;
      directionZ /= directionLength;
    }
    userData.vehicleWitnessUntil = lastUpdateElapsed + 1.8;
    userData.vehicleWitnessDirectionX = directionX;
    userData.vehicleWitnessDirectionZ = directionZ;
    userData.vehicleWitnessBaseX = data.mesh.position.x;
    userData.vehicleWitnessBaseY = data.mesh.position.y;
    userData.vehicleWitnessBaseZ = data.mesh.position.z;
    userData.vehicleWitnessTravel = 0;
    userData.vehicleWitnessOffsetX = 0;
    userData.vehicleWitnessOffsetZ = 0;
    userData.vehicleWitnessReaction = 'phone-flee';
    userData.vehicleWitnessCount = (Number(userData.vehicleWitnessCount) || 0) + 1;
    return {
      witnessId,
      count: userData.vehicleWitnessCount,
      reaction: 'phone-flee',
      remaining: 1.8,
    };
  }

  function registerIncidentWitnessReaction(witnessId, options = {}) {
    const data = pool.find((entry) => residentIdentityFor(entry).id === witnessId);
    if (!data) return null;
    const activeUntil = Number(data.mesh.userData?.vehicleWitnessUntil) || 0;
    if (activeUntil > lastUpdateElapsed) return null;
    return registerVehicleWitnessReaction(witnessId, options);
  }

  function getVehicleWitnessState(witnessId) {
    const data = pool.find((entry) => residentIdentityFor(entry).id === witnessId);
    if (!data) return null;
    const userData = data.mesh.userData || {};
    return {
      witnessId,
      count: Number(userData.vehicleWitnessCount) || 0,
      reaction: userData.vehicleWitnessReaction || null,
      active: (Number(userData.vehicleWitnessUntil) || 0) > lastUpdateElapsed,
      remaining: Math.max(0, (Number(userData.vehicleWitnessUntil) || 0) - lastUpdateElapsed),
      displacement: Math.hypot(
        Number(userData.vehicleWitnessOffsetX) || 0,
        Number(userData.vehicleWitnessOffsetZ) || 0,
      ),
      groundError: Math.abs(data.mesh.position.y - data.groundY),
      combatDefeated: userData.combatDefeated === true || userData.combatDisabled === true,
      position: {
        x: data.mesh.position.x,
        y: data.mesh.position.y,
        z: data.mesh.position.z,
      },
    };
  }

  setWeather('clear');
  return Object.assign(system, {
    group,
    update,
    setFocus,
    setQaSolo,
    setQaWitnessAnchor,
    getStats,
    getFeaturedResidentSnapshots,
    getNearestPerson,
    setOnFootPlayerCollisionProbe,
    getOnFootPlayerContactDiagnostics,
    stageOnFootPlayerContactQa,
    clearOnFootPlayerContactQaStage,
    getOnFootPlayerContactQaState,
    getCombatCandidates,
    exportCombatAftermathState,
    canImportCombatAftermathState,
    importCombatAftermathState,
    clearCombatAftermathState,
    getVehicleImpactCandidates,
    registerVehicleImpact,
    getVehicleImpactState,
    getVehicleImpactWitness,
    registerVehicleWitnessReaction,
    getVehicleWitnessState,
    getIncidentWitness: getVehicleImpactWitness,
    registerWitnessReaction: registerIncidentWitnessReaction,
    getWitnessState: getVehicleWitnessState,
    setWeather,
    setDayHour,
    getDayHour,
  });
}
