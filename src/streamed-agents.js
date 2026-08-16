import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { signalOffsetForPosition, signalPhaseAt } from './signals.js';
import { getStreamedVehicleVisualProfile } from './traffic.js';
import { getStreamedPedestrianVisualProfile } from './pedestrians.js';
import { AUTHORED_DISTRICT_BY_SECTOR } from './district_massing.js';
import { createBlackboard, tick as tickBehaviorTree } from './npc-behavior-tree.js';
import { createStreamedTreeForActivity } from './npc-trees.js';

const CORE_KEY = '0:0';
const SECTOR_SIZE = 384;
const GRID_STEP = 64;
const VEHICLE_CAPACITY = 22;
const PEDESTRIAN_CAPACITY = 36;
const MAX_ACTIVE_SECTORS = 3;
const MILESTONE_ACTIVE_SECTORS = 2;
const VEHICLES_PER_SECTOR = 8;
const PEDESTRIANS_PER_SECTOR = 14;
const EDGE_VEHICLES_PER_SECTOR = 4;
const EDGE_PEDESTRIANS_PER_SECTOR = 6;
const VEHICLE_STEP = 1 / 20;
const PEDESTRIAN_STEP = 1 / 15;
const PARK_Y = -10000;
const VEHICLE_LANE_OFFSET = 2.62;
const SIDEWALK_OFFSET = 10;
const STREET_LINE_OFFSETS = Object.freeze([-192, -128, -64, 0, 64, 128, 192]);
const SIDEWALK_ROAM_OFFSETS = Object.freeze([6.15, 6.85, 7.55]);
const VEHICLE_SPACING_JITTER = 10;
const PEDESTRIAN_SPACING_JITTER = 6.5;
// The active sector gets a compact, deterministic street-level tableau. It is
// deliberately smaller than the representative lease so the rest of the
// pool can continue to read as background traffic/crowd while these actors
// remain legible from the 1280x720 QA framing.
const FOCUS_TABLEAU_VEHICLES = 6;
const FOCUS_TABLEAU_PEDESTRIANS = 10;
const FOCUS_VEHICLE_SPACING = 22;
const FOCUS_PEDESTRIAN_SPACING = 7.5;
const FOCUS_RESTAGE_DISTANCE = 40;
// The ordinary corridor uses the existing focus tableau and actor pools.  A
// modest presentation lift on its Civic/Financial endpoints keeps those
// camera-local silhouettes readable without changing C3's authored 3:0 view
// or the representative lease/capacity model.
const LIVING_BLOCK_ACTOR_SECTORS = new Set(['2:0', '4:0']);
const LIVING_BLOCK_VEHICLE_SCALE = 1.1;
const LIVING_BLOCK_PEDESTRIAN_SCALE = 1.12;
// The normal QA orbit can sit roughly 64 m behind or ahead of its focus. Keep
// every living-block tableau vehicle on a deterministic, camera-clear slot
// with a small reversible band. This leaves the six class silhouettes on one
// readable street axis without teleporting them during fixed-step updates.
const LIVING_BLOCK_FOCUS_LONGITUDINAL_OFFSETS = Object.freeze([-44, -32, -8, -20, 32, 44]);
const LIVING_BLOCK_FOCUS_LATERAL_OFFSETS = Object.freeze([-4, 4, -2.4, 0.8, -3.3, 3.3]);
const LIVING_BLOCK_FOCUS_PEDESTRIAN_OFFSETS = Object.freeze([
  -40, -32, -24, -16, -8, 4, 16, 28, 40, 52,
]);
const LIVING_BLOCK_FOCUS_SLOT_BAND = 4;
// The roam camera sits ~64 m behind the focus target. Negative longitudinal
// offsets place actors between the lens and focus, which repeatedly clipped
// the same lower-left silhouette in every district capture.
const ROAM_CAMERA_BEHIND_FOCUS = 64;
const TABLEAU_MIN_FORWARD_OFFSET = 18;
const TABLEAU_MAX_FORWARD_OFFSET = 88;
const FOCUS_TABLEAU_ROUTES = Object.freeze({
  vehicle: Object.freeze([
    // The roam camera settles behind its focus and looks down the positive
    // z-axis. Keep the six deterministic tableau vehicles on that readable
    // street axis so a detailed sector visibly carries traffic instead of
    // hiding most of its live representatives on the two cross streets.
    Object.freeze({ orientation: 'north-south', longitudinalOffset: -54 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: -22 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 22 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 54 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 88 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 120 }),
  ]),
  pedestrian: Object.freeze([
    // Every offset is forward of the focus so actors land mid-block (~82–152 m
    // from the camera) instead of clipping the lower-left foreground.
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 18, sidewalkSide: 1 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 28, sidewalkSide: -1 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 38, sidewalkSide: 1 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 38, sidewalkSide: -1 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 48, sidewalkSide: -1 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 58, sidewalkSide: 1 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 68, sidewalkSide: -1 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 74, sidewalkSide: 1 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 80, sidewalkSide: -1 }),
    Object.freeze({ orientation: 'north-south', longitudinalOffset: 88, sidewalkSide: 1 }),
  ]),
});
const FOCUS_TABLEAU_MICRO_STORIES = Object.freeze([
  Object.freeze({
    label: 'Elena Park',
    role: 'commuter',
    beat: 'checking the phone before rejoining the flow',
    mood: 'hurried',
    choice: 'finish the message, then walk',
    destination: 'office district',
    dwell: true,
  }),
  Object.freeze({
    label: 'Marcus Webb',
    role: 'tourist',
    beat: 'framing a street photo',
    mood: 'curious',
    choice: 'take the shot, then move on',
    destination: 'viewpoint',
    dwell: true,
  }),
  Object.freeze({
    label: 'Diana Ruiz',
    role: 'delivery',
    beat: 'handing a parcel to the café counter',
    mood: 'engaged',
    choice: 'complete the handoff',
    destination: 'drop-off',
    partnerSlot: 3,
    dwell: true,
  }),
  Object.freeze({
    label: 'Noah Kim',
    role: 'barista',
    beat: 'receiving the morning delivery',
    mood: 'engaged',
    choice: 'sign for the order',
    destination: 'coffee counter',
    partnerSlot: 2,
    dwell: true,
  }),
  Object.freeze({
    label: 'Priya Shah',
    role: 'worker',
    beat: 'waiting for a walk signal with tools ready',
    mood: 'watchful',
    choice: 'cross when the light turns',
    destination: 'jobsite',
    dwell: false,
  }),
  Object.freeze({
    label: 'Jonah Ellis',
    role: 'shopper',
    beat: 'comparing two storefronts mid-block',
    mood: 'deciding',
    choice: 'pick a shop and go in',
    destination: 'market block',
    dwell: true,
  }),
  Object.freeze({
    label: 'Amelia Cruz',
    role: 'student',
    beat: 'walking with a backpack toward campus',
    mood: 'on the move',
    choice: 'keep pace with the crowd',
    destination: 'campus',
    dwell: false,
  }),
  Object.freeze({
    label: 'Renata Lopez',
    role: 'services',
    beat: 'checking a service clipboard at the curb',
    mood: 'occupied',
    choice: 'move to the next call',
    destination: 'service call',
    dwell: true,
  }),
  Object.freeze({
    label: 'Theo Nguyen',
    role: 'resident',
    beat: 'chatting with a neighbor on the sidewalk',
    mood: 'social',
    choice: 'share a quick update',
    destination: 'neighborhood',
    partnerSlot: 9,
    dwell: true,
  }),
  Object.freeze({
    label: 'Grace Okonkwo',
    role: 'resident',
    beat: 'listening to a neighbor before errands',
    mood: 'social',
    choice: 'listen, then continue',
    destination: 'neighborhood',
    partnerSlot: 8,
    dwell: true,
  }),
]);
const VALID_WEATHER = new Set(['clear', 'fog', 'drizzle']);

const PEDESTRIAN_ROLE_CUES = Object.freeze({
  runner: Object.freeze({ width: 0.94, depth: 0.96, limb: 1.08, gait: 1.2 }),
  tourist: Object.freeze({ width: 1.06, depth: 1.02, limb: 0.94, gait: 0.78 }),
  delivery: Object.freeze({ width: 1.04, depth: 1.06, limb: 1.02, gait: 1.08 }),
  services: Object.freeze({ width: 1.06, depth: 1.04, limb: 1, gait: 0.94 }),
  student: Object.freeze({ width: 0.98, depth: 0.98, limb: 1.04, gait: 1.05 }),
  beachgoer: Object.freeze({ width: 1.02, depth: 1.04, limb: 0.98, gait: 0.86 }),
});
const DEFAULT_PEDESTRIAN_ROLE_CUE = Object.freeze({
  width: 1,
  depth: 1,
  limb: 1,
  gait: 1,
});

// The streamed pool is seen mostly in silhouette. These small, shared color
// vocabularies keep the readability pass restrained while preventing every
// low-poly actor from collapsing into the same dark value under the district
// lighting.
// Four identity classes must read instantly at QA distance:
// taxi (yellow roof sign), SFMTA bus (cream + red stripe), service/delivery
// van (orange rack/stripe), private sedan/SUV (lighter body + subtle chrome).
const VEHICLE_ACCENT_COLORS = Object.freeze({
  sedan: 0xd5e2e8,
  suv: 0xb5cdd4,
  taxi: 0x1f1a14,
  van: 0xff8a2b,
  bus: 0xc8352c,
  bike: 0xffc75a,
});
const VEHICLE_ROOF_CUE_COLORS = Object.freeze({
  sedan: 0x9aadb6,
  suv: 0x8aa5af,
  taxi: 0xffd24a,
  van: 0xff6a1f,
  bus: 0xd23a32,
  bike: 0x2c5f8a,
});
const VEHICLE_ROOF_CUE_SIZES = Object.freeze({
  sedan: Object.freeze({ width: 0.3, height: 0.1, length: 0.48 }),
  suv: Object.freeze({ width: 0.42, height: 0.12, length: 0.68 }),
  taxi: Object.freeze({ width: 0.56, height: 0.28, length: 0.9 }),
  van: Object.freeze({ width: 0.7, height: 0.2, length: 0.86 }),
  bus: Object.freeze({ width: 1.05, height: 0.22, length: 1.35 }),
  bike: Object.freeze({ width: 0.18, height: 0.08, length: 0.34 }),
});
const FOCUS_VEHICLE_BODY_COLORS = Object.freeze({
  sedan: Object.freeze([0xf0f1ec, 0xd7dde2, 0x8eb0bc, 0xc9b39a, 0x8fa58a, 0xb48a94]),
  suv: Object.freeze([0xe7ece8, 0xc5d6db, 0x8aa67c, 0xb49a74, 0x7f91b8, 0xd0c4a8]),
  taxi: Object.freeze([0xffc324]),
  van: Object.freeze([0xf3f1ea, 0xff9a3d, 0xd7d8cf, 0x7ea0ad, 0xb87468]),
  bus: Object.freeze([0xe9e6e0]),
  bike: Object.freeze([0x2c5f8a, 0xc45c2a, 0x2f6b4f, 0x343a44, 0xb08a3e]),
});
// traffic.js only exposes the compact sedan/suv/taxi/van profile. Bus is
// authored for the core fleet; keep a matching local spec so streamed
// districts can show SFMTA coaches without changing the shared export.
const STREAMED_BUS_CLASS = Object.freeze({
  len: 11.0,
  wid: 2.55,
  hgt: 3.0,
  wheelR: 0.47,
});
const BUS_BODY_COLOR = 0xe9e6e0;
const FOCUS_VEHICLE_CLASS_ORDER = Object.freeze([
  'taxi',
  'bus',
  'van',
  'sedan',
  'bike',
  'suv',
]);
const VEHICLE_CLASS_LANE_BIAS = Object.freeze({
  sedan: 0,
  suv: 0.06,
  taxi: 0.2,
  van: 0.32,
  bus: 0.48,
  bike: -0.85,
});
const VEHICLE_CLASS_SPACING = Object.freeze({
  sedan: 0,
  suv: 1.5,
  taxi: 3.5,
  van: 6,
  bus: 12,
  bike: -2,
});
const VEHICLE_SILHOUETTE = Object.freeze({
  sedan: Object.freeze({
    bodyHeight: 0.48, cabinHeight: 0.4, cabinLength: 0.46, cabinWidth: 0.7,
    cabinLift: 0.7, roofLift: 0.94, cabinShift: 0.04, wheelBase: 0.31, trimHeight: 0.16,
  }),
  suv: Object.freeze({
    bodyHeight: 0.54, cabinHeight: 0.46, cabinLength: 0.54, cabinWidth: 0.78,
    cabinLift: 0.76, roofLift: 1.0, cabinShift: 0.0, wheelBase: 0.32, trimHeight: 0.18,
  }),
  taxi: Object.freeze({
    bodyHeight: 0.48, cabinHeight: 0.4, cabinLength: 0.46, cabinWidth: 0.7,
    cabinLift: 0.7, roofLift: 1.06, cabinShift: 0.04, wheelBase: 0.31, trimHeight: 0.17,
  }),
  van: Object.freeze({
    bodyHeight: 0.64, cabinHeight: 0.52, cabinLength: 0.74, cabinWidth: 0.86,
    cabinLift: 0.84, roofLift: 1.1, cabinShift: -0.05, wheelBase: 0.34, trimHeight: 0.22,
  }),
  bus: Object.freeze({
    bodyHeight: 0.74, cabinHeight: 0.5, cabinLength: 0.9, cabinWidth: 0.92,
    cabinLift: 0.9, roofLift: 1.16, cabinShift: 0.0, wheelBase: 0.38, trimHeight: 0.2,
  }),
  bike: Object.freeze({
    bodyHeight: 0.22, cabinHeight: 0.28, cabinLength: 0.42, cabinWidth: 0.34,
    cabinLift: 0.55, roofLift: 0.78, cabinShift: -0.08, wheelBase: 0.36, trimHeight: 0.08,
  }),
});
const PEDESTRIAN_HAIR_COLORS = Object.freeze([
  0x252326, 0x3a2b27, 0x59402f, 0x765333, 0x4a4e4a, 0x1e2930,
]);
const PEDESTRIAN_ROLE_ACCENTS = Object.freeze({
  commuter: Object.freeze({ kind: 'badge', color: 0x8dc7d8 }),
  resident: Object.freeze({ kind: 'tote', color: 0xd5c2a4 }),
  shopper: Object.freeze({ kind: 'tote', color: 0xf0b85d }),
  worker: Object.freeze({ kind: 'hi-vis', color: 0xffc75a }),
  services: Object.freeze({ kind: 'hi-vis', color: 0xa8cf72 }),
  delivery: Object.freeze({ kind: 'backpack', color: 0xff974e }),
  tourist: Object.freeze({ kind: 'badge', color: 0x59c5dd }),
  student: Object.freeze({ kind: 'backpack', color: 0xac89e1 }),
  runner: Object.freeze({ kind: 'band', color: 0x78d3bd }),
  beachgoer: Object.freeze({ kind: 'beach-gear', color: 0x45b6c8 }),
});
const DEFAULT_PEDESTRIAN_ROLE_ACCENT = Object.freeze({
  kind: 'band',
  color: 0xb8c2a4,
});

const DISTRICT_PROFILES = Object.freeze({
  'Financial District': Object.freeze({
    roles: [
      ['commuter', 46], ['worker', 22], ['student', 12], ['shopper', 8],
      ['resident', 6], ['services', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x243b53, 0x31424f, 0x425a4a, 0x5b4d74, 0x39434d, 0x70443c],
      bottoms: [0x1c2530, 0x30343a, 0x394954, 0x42372f, 0x353c45],
    }),
    classWeights: [['sedan', 22], ['bike', 8], ['suv', 18], ['taxi', 22], ['van', 14], ['bus', 16]],
  }),
  SoMa: Object.freeze({
    roles: [
      ['worker', 28], ['commuter', 26], ['delivery', 12], ['student', 10],
      ['shopper', 10], ['resident', 8], ['services', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x4d4038, 0x8a3d32, 0x315c4c, 0x2d3438, 0x7a6b55, 0x59433a],
      bottoms: [0x2f3033, 0x354a57, 0x42372f, 0x4d4d4b, 0x1c2530],
    }),
    classWeights: [['sedan', 16], ['bike', 8], ['suv', 16], ['taxi', 14], ['van', 28], ['bus', 18]],
  }),
  'North Beach': Object.freeze({
    roles: [
      ['resident', 30], ['tourist', 24], ['shopper', 18], ['services', 12],
      ['commuter', 10], ['student', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x8d3f32, 0x59433a, 0x7a6b55, 0x315c4c, 0xc4b59d, 0x5b4d74],
      bottoms: [0x42372f, 0x4d4d4b, 0x2f3033, 0x354a57],
    }),
    classWeights: [['sedan', 20], ['bike', 8], ['suv', 18], ['taxi', 24], ['van', 14], ['bus', 16]],
  }),
  'Pacific Heights': Object.freeze({
    roles: [
      ['resident', 34], ['shopper', 20], ['commuter', 18], ['student', 10],
      ['services', 10], ['runner', 8],
    ],
    wardrobe: Object.freeze({
      tops: [0x5b4d74, 0x425a4a, 0x31424f, 0x9b8068, 0x29333b, 0x70443c],
      bottoms: [0x30343a, 0x394954, 0x353c45, 0x42372f],
    }),
    classWeights: [['sedan', 28], ['bike', 8], ['suv', 26], ['taxi', 12], ['van', 14], ['bus', 12]],
  }),
  'Marina / Fisherman’s Wharf': Object.freeze({
    roles: [
      ['tourist', 36], ['shopper', 22], ['resident', 18], ['services', 12],
      ['runner', 8], ['commuter', 4],
    ],
    wardrobe: Object.freeze({
      tops: [0xb8c2a4, 0xd6c7a4, 0x315c4c, 0x8d3f32, 0x203a58, 0x59433a],
      bottoms: [0x354a57, 0x4d4d4b, 0x42372f, 0x30343a],
    }),
    classWeights: [['sedan', 16], ['bike', 8], ['suv', 18], ['taxi', 28], ['van', 14], ['bus', 16]],
  }),
  Sunset: Object.freeze({
    roles: [
      ['resident', 42], ['commuter', 20], ['student', 14], ['shopper', 12],
      ['services', 8], ['delivery', 4],
    ],
    wardrobe: Object.freeze({
      tops: [0x315c4c, 0x203a58, 0x7a6b55, 0xc4b59d, 0x59433a, 0x8d3f32],
      bottoms: [0x2f3033, 0x354a57, 0x42372f, 0x4d4d4b],
    }),
    classWeights: [['sedan', 30], ['bike', 8], ['suv', 22], ['taxi', 12], ['van', 16], ['bus', 12]],
  }),
  'Outer Sunset': Object.freeze({
    roles: [
      ['resident', 38], ['beachgoer', 12], ['student', 14], ['commuter', 16],
      ['shopper', 10], ['services', 6], ['delivery', 4],
    ],
    wardrobe: Object.freeze({
      tops: [0x315c4c, 0x7a6b55, 0x2d3438, 0xc4b59d, 0x203a58, 0x59433a],
      bottoms: [0x2f3033, 0x42372f, 0x4d4d4b, 0x354a57],
    }),
    classWeights: [['sedan', 32], ['bike', 8], ['suv', 22], ['taxi', 10], ['van', 16], ['bus', 12]],
  }),
  Richmond: Object.freeze({
    roles: [
      ['resident', 38], ['commuter', 22], ['shopper', 14], ['student', 12],
      ['services', 10], ['delivery', 4],
    ],
    wardrobe: Object.freeze({
      tops: [0x203a58, 0x315c4c, 0x5b4d74, 0x7a6b55, 0xc4b59d, 0x8d3f32],
      bottoms: [0x1c2530, 0x354a57, 0x2f3033, 0x42372f],
    }),
    classWeights: [['sedan', 28], ['bike', 8], ['suv', 22], ['taxi', 14], ['van', 16], ['bus', 12]],
  }),
  Mission: Object.freeze({
    roles: [
      ['resident', 32], ['shopper', 20], ['worker', 14], ['commuter', 12],
      ['services', 10], ['student', 8], ['delivery', 4],
    ],
    wardrobe: Object.freeze({
      tops: [0x8d3f32, 0x5b4d74, 0x315c4c, 0x59433a, 0x7a6b55, 0x2d3438],
      bottoms: [0x42372f, 0x354a57, 0x4d4d4b, 0x30343a],
    }),
    classWeights: [['sedan', 20], ['bike', 8], ['suv', 20], ['taxi', 14], ['van', 22], ['bus', 16]],
  }),
  'Castro / Noe Valley': Object.freeze({
    roles: [
      ['resident', 38], ['shopper', 20], ['commuter', 16], ['services', 12],
      ['runner', 8], ['student', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x8d3f32, 0x5b4d74, 0x425a4a, 0xc4b59d, 0x59433a, 0x203a58],
      bottoms: [0x354a57, 0x30343a, 0x42372f, 0x4d4d4b],
    }),
    classWeights: [['sedan', 28], ['bike', 8], ['suv', 24], ['taxi', 12], ['van', 14], ['bus', 14]],
  }),
  'Civic Center': Object.freeze({
    roles: [
      ['commuter', 34], ['worker', 26], ['student', 14], ['shopper', 10],
      ['services', 10], ['resident', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x243b53, 0x39434d, 0x5b4d74, 0x31424f, 0x70443c, 0x425a4a],
      bottoms: [0x1c2530, 0x394954, 0x30343a, 0x353c45],
    }),
    classWeights: [['sedan', 22], ['bike', 8], ['suv', 16], ['taxi', 22], ['van', 14], ['bus', 18]],
  }),
  Presidio: Object.freeze({
    roles: [
      ['resident', 30], ['runner', 26], ['tourist', 20], ['commuter', 12],
      ['shopper', 8], ['services', 4],
    ],
    wardrobe: Object.freeze({
      tops: [0x315c4c, 0x2d3438, 0x203a58, 0x8d3f32, 0x7a6b55, 0xc4b59d],
      bottoms: [0x354a57, 0x2f3033, 0x42372f, 0x4d4d4b],
    }),
    classWeights: [['sedan', 28], ['bike', 8], ['suv', 26], ['taxi', 12], ['van', 14], ['bus', 12]],
  }),
  'Presidio Heights': Object.freeze({
    roles: [
      ['resident', 36], ['runner', 18], ['commuter', 18], ['shopper', 12],
      ['student', 10], ['services', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x5b4d74, 0x425a4a, 0x31424f, 0x9b8068, 0x29333b, 0x70443c],
      bottoms: [0x30343a, 0x394954, 0x353c45, 0x1c2530],
    }),
    classWeights: [['sedan', 30], ['bike', 8], ['suv', 26], ['taxi', 12], ['van', 12], ['bus', 12]],
  }),
  Bayview: Object.freeze({
    roles: [
      ['worker', 28], ['resident', 28], ['delivery', 12], ['commuter', 12],
      ['shopper', 10], ['student', 10],
    ],
    wardrobe: Object.freeze({
      tops: [0x59433a, 0x8a3d32, 0x315c4c, 0x2d3438, 0x7a6b55, 0x5b4d74],
      bottoms: [0x42372f, 0x2f3033, 0x354a57, 0x4d4d4b],
    }),
    classWeights: [['sedan', 18], ['bike', 8], ['suv', 18], ['taxi', 10], ['van', 28], ['bus', 18]],
  }),
  Excelsior: Object.freeze({
    roles: [
      ['resident', 40], ['commuter', 18], ['worker', 14], ['student', 12],
      ['shopper', 10], ['delivery', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x315c4c, 0x59433a, 0x7a6b55, 0x203a58, 0x8d3f32, 0xc4b59d],
      bottoms: [0x2f3033, 0x42372f, 0x354a57, 0x4d4d4b],
    }),
    classWeights: [['sedan', 30], ['bike', 8], ['suv', 22], ['taxi', 10], ['van', 18], ['bus', 12]],
  }),
  'Mission Bay': Object.freeze({
    roles: [
      ['commuter', 32], ['worker', 22], ['student', 18], ['shopper', 12],
      ['resident', 10], ['services', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x243b53, 0x425a4a, 0x39434d, 0x5b4d74, 0x8d3f32, 0x29333b],
      bottoms: [0x1c2530, 0x394954, 0x30343a, 0x353c45],
    }),
    classWeights: [['sedan', 22], ['bike', 8], ['suv', 18], ['taxi', 16], ['van', 18], ['bus', 18]],
  }),
  'Golden Gate': Object.freeze({
    roles: [
      ['tourist', 34], ['runner', 24], ['resident', 16], ['shopper', 12],
      ['services', 8], ['commuter', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x315c4c, 0xb8c2a4, 0x203a58, 0x2d3438, 0x8d3f32, 0xc4b59d],
      bottoms: [0x354a57, 0x4d4d4b, 0x2f3033, 0x42372f],
    }),
    classWeights: [['sedan', 20], ['bike', 8], ['suv', 22], ['taxi', 20], ['van', 14], ['bus', 16]],
  }),
});

const FALLBACK_DISTRICT_PROFILE = Object.freeze({
  roles: [
    ['commuter', 26], ['resident', 22], ['shopper', 16], ['worker', 14],
    ['tourist', 10], ['student', 8], ['services', 4],
  ],
  wardrobe: Object.freeze({
    tops: [0x203a58, 0x2d3438, 0x59433a, 0x315c4c, 0x8d3f32, 0x5b4d74, 0x7a6b55, 0xc4b59d],
    bottoms: [0x1c2530, 0x2f3033, 0x354a57, 0x42372f, 0x4d4d4b],
  }),
  classWeights: [['sedan', 26], ['bike', 8], ['suv', 20], ['taxi', 14], ['van', 16], ['bus', 16]],
});

const DAY_HOUR_OFFSET = 7;
const HOURS_PER_ELAPSED_SECOND = 0.033;

const DWELL_ACTIVITIES = new Set([
  'working',
  'shopping',
  'studying',
  'leisure',
  'resting',
]);

const ROLE_SCHEDULES = Object.freeze({
  commuter: Object.freeze([
    Object.freeze({ start: 5, end: 9, activity: 'commuting', destination: 'office district', pace: 1.14 }),
    Object.freeze({ start: 9, end: 12, activity: 'working', destination: 'office district', pace: 0.94 }),
    Object.freeze({ start: 12, end: 13, activity: 'lunch', destination: 'lunch spot', pace: 1.06 }),
    Object.freeze({ start: 13, end: 17, activity: 'working', destination: 'office district', pace: 0.94 }),
    Object.freeze({ start: 17, end: 20, activity: 'commuting', destination: 'home district', pace: 1.12 }),
    Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'neighborhood', pace: 0.92 }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'home district', pace: 0.82 }),
  ]),
  worker: Object.freeze([
    Object.freeze({ start: 5, end: 7, activity: 'commuting', destination: 'jobsite', pace: 1.1 }),
    Object.freeze({ start: 7, end: 17, activity: 'working', destination: 'jobsite', pace: 0.9 }),
    Object.freeze({ start: 17, end: 19, activity: 'commuting', destination: 'home district', pace: 1.08 }),
    Object.freeze({ start: 19, end: 23, activity: 'leisure', destination: 'neighborhood', pace: 0.9 }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'home district', pace: 0.8 }),
  ]),
  student: Object.freeze([
    Object.freeze({ start: 6, end: 8, activity: 'commuting', destination: 'campus', pace: 1.1 }),
    Object.freeze({ start: 8, end: 15, activity: 'studying', destination: 'campus', pace: 0.88 }),
    Object.freeze({ start: 15, end: 18, activity: 'commuting', destination: 'home district', pace: 1.05 }),
    Object.freeze({ start: 18, end: 23, activity: 'leisure', destination: 'neighborhood', pace: 0.95 }),
    Object.freeze({ start: 23, end: 6, activity: 'resting', destination: 'home district', pace: 0.82 }),
  ]),
  shopper: Object.freeze([
    Object.freeze({ start: 8, end: 10, activity: 'commuting', destination: 'market block', pace: 1.08 }),
    Object.freeze({ start: 10, end: 18, activity: 'shopping', destination: 'market block', pace: 0.84 }),
    Object.freeze({ start: 18, end: 20, activity: 'commuting', destination: 'home district', pace: 1.05 }),
    Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'neighborhood', pace: 0.9 }),
    Object.freeze({ start: 23, end: 8, activity: 'resting', destination: 'home district', pace: 0.8 }),
  ]),
  resident: Object.freeze([
    Object.freeze({ start: 6, end: 9, activity: 'errands', destination: 'neighborhood', pace: 1.02 }),
    Object.freeze({ start: 9, end: 12, activity: 'errands', destination: 'market block', pace: 0.96 }),
    Object.freeze({ start: 12, end: 14, activity: 'leisure', destination: 'neighborhood park', pace: 0.9 }),
    Object.freeze({ start: 14, end: 18, activity: 'errands', destination: 'neighborhood', pace: 1 }),
    Object.freeze({ start: 18, end: 23, activity: 'leisure', destination: 'neighborhood', pace: 0.92 }),
    Object.freeze({ start: 23, end: 6, activity: 'resting', destination: 'home district', pace: 0.8 }),
  ]),
  tourist: Object.freeze([
    Object.freeze({ start: 8, end: 12, activity: 'touring', destination: 'tour route', pace: 1 }),
    Object.freeze({ start: 12, end: 13, activity: 'lunch', destination: 'lunch spot', pace: 0.95 }),
    Object.freeze({ start: 13, end: 19, activity: 'touring', destination: 'tour route', pace: 1 }),
    Object.freeze({ start: 19, end: 23, activity: 'leisure', destination: 'hotel', pace: 0.88 }),
    Object.freeze({ start: 23, end: 8, activity: 'resting', destination: 'hotel', pace: 0.82 }),
  ]),
  delivery: Object.freeze([
    Object.freeze({ start: 5, end: 20, activity: 'shift', destination: 'drop-off', pace: 1.1 }),
    Object.freeze({ start: 20, end: 23, activity: 'returning', destination: 'depot', pace: 1.04 }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'depot', pace: 0.82 }),
  ]),
  services: Object.freeze([
    Object.freeze({ start: 7, end: 18, activity: 'service', destination: 'service call', pace: 1.08 }),
    Object.freeze({ start: 18, end: 20, activity: 'returning', destination: 'office district', pace: 1.02 }),
    Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'neighborhood', pace: 0.9 }),
    Object.freeze({ start: 23, end: 7, activity: 'resting', destination: 'home district', pace: 0.8 }),
  ]),
  runner: Object.freeze([
    Object.freeze({ start: 5, end: 8, activity: 'running', destination: 'greenway', pace: 1.35 }),
    Object.freeze({ start: 8, end: 17, activity: 'errands', destination: 'neighborhood', pace: 0.94 }),
    Object.freeze({ start: 17, end: 20, activity: 'running', destination: 'greenway', pace: 1.3 }),
    Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'neighborhood', pace: 0.9 }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'home district', pace: 0.8 }),
  ]),
  beachgoer: Object.freeze([
    Object.freeze({ start: 6, end: 9, activity: 'commuting', destination: 'Ocean Beach', pace: 1.02 }),
    Object.freeze({ start: 9, end: 17, activity: 'leisure', destination: 'Ocean Beach surf line', pace: 0.84 }),
    Object.freeze({ start: 17, end: 20, activity: 'commuting', destination: 'N Judah stop', pace: 1.04 }),
    Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'Outer Sunset cafe', pace: 0.9 }),
    Object.freeze({ start: 23, end: 6, activity: 'resting', destination: 'home district', pace: 0.8 }),
  ]),
});

const FALLBACK_ROLE_SCHEDULE = Object.freeze([
  Object.freeze({ start: 6, end: 10, activity: 'commuting', destination: 'neighborhood', pace: 1 }),
  Object.freeze({ start: 10, end: 16, activity: 'errands', destination: 'neighborhood', pace: 0.94 }),
  Object.freeze({ start: 16, end: 20, activity: 'commuting', destination: 'home district', pace: 1 }),
  Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'neighborhood', pace: 0.9 }),
  Object.freeze({ start: 23, end: 6, activity: 'resting', destination: 'home district', pace: 0.82 }),
]);

const VEHICLE_SCHEDULES = Object.freeze({
  taxi: Object.freeze([
    Object.freeze({
      start: 5,
      end: 22,
      activity: 'cruising',
      destination: 'curb hail',
      pace: 1.08,
      fleetRole: 'taxi',
    }),
    Object.freeze({
      start: 22,
      end: 5,
      activity: 'night-shift',
      destination: 'late curb hail',
      pace: 1.02,
      fleetRole: 'taxi',
    }),
  ]),
  bus: Object.freeze([
    Object.freeze({
      start: 5,
      end: 21,
      activity: 'route-service',
      destination: 'muni stop',
      pace: 0.86,
      fleetRole: 'sfmta',
    }),
    Object.freeze({
      start: 21,
      end: 5,
      activity: 'returning',
      destination: 'muni yard',
      pace: 0.78,
      fleetRole: 'sfmta',
    }),
  ]),
  bike: Object.freeze([
    Object.freeze({
      start: 6,
      end: 21,
      activity: 'cycling',
      destination: 'bike lane',
      pace: 1.12,
      fleetRole: 'bike',
    }),
    Object.freeze({
      start: 21,
      end: 6,
      activity: 'night-ride',
      destination: 'neighborhood loop',
      pace: 0.98,
      fleetRole: 'bike',
    }),
  ]),
  van: Object.freeze([
    Object.freeze({ start: 5, end: 20, activity: 'delivering', destination: 'drop-off', pace: 1.06, fleetRole: 'delivery' }),
    Object.freeze({ start: 20, end: 23, activity: 'returning', destination: 'depot', pace: 0.96, fleetRole: 'delivery' }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'depot', pace: 0.84, fleetRole: 'delivery' }),
  ]),
  sedan: Object.freeze([
    Object.freeze({ start: 5, end: 10, activity: 'commuting', destination: 'office district', pace: 1.12, fleetRole: 'private' }),
    Object.freeze({ start: 10, end: 16, activity: 'errands', destination: 'local route', pace: 0.98, fleetRole: 'private' }),
    Object.freeze({ start: 16, end: 20, activity: 'commuting', destination: 'home district', pace: 1.1, fleetRole: 'private' }),
    Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'local route', pace: 0.94, fleetRole: 'private' }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'local route', pace: 0.9, fleetRole: 'private' }),
  ]),
  suv: Object.freeze([
    Object.freeze({ start: 5, end: 10, activity: 'commuting', destination: 'office district', pace: 1.1, fleetRole: 'private' }),
    Object.freeze({ start: 10, end: 16, activity: 'errands', destination: 'local route', pace: 0.96, fleetRole: 'private' }),
    Object.freeze({ start: 16, end: 20, activity: 'commuting', destination: 'home district', pace: 1.08, fleetRole: 'private' }),
    Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'local route', pace: 0.92, fleetRole: 'private' }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'local route', pace: 0.88, fleetRole: 'private' }),
  ]),
});

function dayHourAt(elapsed) {
  return modulo((elapsed * HOURS_PER_ELAPSED_SECOND + DAY_HOUR_OFFSET) % 24, 24);
}

function phaseContainsHour(phase, dayHour) {
  const hour = modulo(dayHour, 24);
  const start = modulo(phase.start, 24);
  const end = modulo(phase.end, 24);
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

export function schedulePhaseForRole(role, dayHour) {
  const phases = ROLE_SCHEDULES[role] || FALLBACK_ROLE_SCHEDULE;
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    if (phaseContainsHour(phase, dayHour)) return phase;
  }
  return phases[0];
}

export function vehicleSchedulePhaseFor(className, dayHour) {
  const phases = VEHICLE_SCHEDULES[className] || VEHICLE_SCHEDULES.sedan;
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    if (phaseContainsHour(phase, dayHour)) return phase;
  }
  return phases[0];
}

function districtForPosition(x, z) {
  if (z < -3600) return x < -900 ? 'Outer Sunset' : x > 1500 ? 'Bayview' : 'Excelsior';
  if (z < -1900) return x < -1200 ? 'Sunset' : x > 1300 ? 'Mission Bay' : 'Mission';
  if (z < -350) return x < -1200 ? 'Richmond' : x > 1500 ? 'SoMa' : 'Castro / Noe Valley';
  if (z < 1250) return x < -1200 ? 'Presidio Heights' : x > 1450 ? 'Financial District' : 'Civic Center';
  if (z < 2700) return x < -700 ? 'Presidio' : x > 1300 ? 'North Beach' : 'Pacific Heights';
  return x > 450 ? 'Marina / Fisherman’s Wharf' : 'Golden Gate';
}

function districtForSector(sectorKey) {
  if (AUTHORED_DISTRICT_BY_SECTOR[sectorKey]) return AUTHORED_DISTRICT_BY_SECTOR[sectorKey];
  const coordinates = parseSectorKey(sectorKey);
  if (!coordinates) return 'Unknown';
  return districtForPosition(coordinates.x * SECTOR_SIZE, coordinates.z * SECTOR_SIZE);
}

function districtProfileFor(sectorKey) {
  return DISTRICT_PROFILES[districtForSector(sectorKey)] || FALLBACK_DISTRICT_PROFILE;
}

function pickWeighted(seed, index, entries) {
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  let roll = seededUnit(seed, index) * total;
  for (const entry of entries) {
    roll -= entry[1];
    if (roll <= 0) return entry[0];
  }
  return entries[0][0];
}

function beatForElapsed(elapsed) {
  const dayHour = dayHourAt(elapsed);
  if (dayHour >= 7 && dayHour < 10) {
    return {
      id: 'morning-rush',
      label: 'Morning rush',
      vehiclePace: 1.06,
      pedestrianPace: 1.08,
    };
  }
  if (dayHour >= 16 && dayHour < 20) {
    return {
      id: 'evening-rush',
      label: 'Evening rush',
      vehiclePace: 1.04,
      pedestrianPace: 1.06,
    };
  }
  if (dayHour >= 20 && dayHour < 23) {
    return {
      id: 'night',
      label: 'Night',
      vehiclePace: 0.9,
      pedestrianPace: 0.86,
    };
  }
  if (dayHour >= 23 || dayHour < 5) {
    return {
      id: 'late-night',
      label: 'Late night',
      vehiclePace: 0.84,
      pedestrianPace: 0.8,
    };
  }
  return {
    id: 'midday',
    label: 'Midday',
    vehiclePace: 0.98,
    pedestrianPace: 1,
  };
}

function hash32(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return hash >>> 0;
}

function seededUnit(seed, index) {
  let value = (seed + Math.imul(index + 1, 0x6d2b79f5)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function liftReadableColor(color, minimumLightness, minimumSaturation = 0.12) {
  const hsl = {};
  color.getHSL(hsl);
  const saturation = hsl.s < 0.04
    ? hsl.s
    : Math.min(0.88, Math.max(hsl.s, minimumSaturation));
  color.setHSL(hsl.h, saturation, Math.max(hsl.l, minimumLightness));
  return color;
}

function modulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

function parseSectorKey(key) {
  const [x, z] = String(key).split(':').map(Number);
  return Number.isInteger(x) && Number.isInteger(z) ? { x, z } : null;
}

function streetLineFor(sectorKey, localSlot, kind) {
  const coordinates = parseSectorKey(sectorKey);
  const primaryLine = coordinates && Math.abs(coordinates.x + coordinates.z) % 2 === 1
    ? -64
    : 0;
  const nearFocusCount = kind === 'vehicle' ? 6 : 10;
  if (localSlot < nearFocusCount) return primaryLine;
  const alternatives = STREET_LINE_OFFSETS.filter((line) => line !== primaryLine);
  const rotation = hash32(`${kind}:${sectorKey}:street-lines`) % alternatives.length;
  return alternatives[(rotation + localSlot - nearFocusCount) % alternatives.length];
}

function nearFocusStreetLine(sectorKey, focusPosition, orientation, fallbackLine) {
  if (!focusPosition
    || !Number.isFinite(focusPosition.x)
    || !Number.isFinite(focusPosition.z)) return fallbackLine;
  const coordinates = parseSectorKey(sectorKey);
  if (!coordinates) return fallbackLine;
  const center = orientation === 'east-west'
    ? coordinates.z * SECTOR_SIZE
    : coordinates.x * SECTOR_SIZE;
  const focusLateral = (orientation === 'east-west' ? focusPosition.z : focusPosition.x) - center;
  return STREET_LINE_OFFSETS.reduce(
    (nearest, line) => (
      Math.abs(focusLateral - line) < Math.abs(focusLateral - nearest) ? line : nearest
    ),
    fallbackLine,
  );
}

function focusTableauRoute(kind, localSlot, sectorKey = CORE_KEY) {
  const routes = FOCUS_TABLEAU_ROUTES[kind];
  if (!routes?.length) return null;
  if (kind !== 'pedestrian') return routes[localSlot] || null;
  const rotation = hash32(`${sectorKey}:tableau-rotation`) % routes.length;
  const index = (localSlot + rotation) % routes.length;
  return routes[index] || null;
}

function nearFocusProgress(
  sectorKey,
  focusPosition,
  orientation,
  localSlot,
  spacing,
  phase = 0,
  spreadCount = 5,
  longitudinalOffset = 0,
) {
  if (!focusPosition
    || !Number.isFinite(focusPosition.x)
    || !Number.isFinite(focusPosition.z)) return null;
  const coordinates = parseSectorKey(sectorKey);
  if (!coordinates) return null;
  const centerX = coordinates.x * SECTOR_SIZE;
  const centerZ = coordinates.z * SECTOR_SIZE;
  const focusLongitudinal = orientation === 'east-west'
    ? focusPosition.x - centerX
    : focusPosition.z - centerZ;
  const count = Math.max(1, Math.floor(spreadCount));
  const spreadSlot = (localSlot % count) - (count - 1) * 0.5 + phase;
  const group = Math.floor(localSlot / count);
  const groupOffset = group * spacing * count * 0.85;
  const longitudinal = THREE.MathUtils.clamp(
    focusLongitudinal + spreadSlot * spacing + groupOffset + longitudinalOffset,
    -SECTOR_SIZE * 0.44,
    SECTOR_SIZE * 0.44,
  );
  return modulo(longitudinal + SECTOR_SIZE * 0.5, SECTOR_SIZE);
}

function nearFocusProgressAt(sectorKey, focusPosition, orientation, longitudinalOffset) {
  return nearFocusProgress(
    sectorKey,
    focusPosition,
    orientation,
    0,
    0,
    0,
    1,
    longitudinalOffset,
  );
}

function keepLivingBlockVehicleInCameraBand(actor) {
  if (!actor
    || actor.kind !== 'vehicle'
    || !LIVING_BLOCK_ACTOR_SECTORS.has(actor.sectorKey)
    || !Number.isFinite(actor.livingBlockFocusLongitudinal)) return;
  const localLongitudinal = -SECTOR_SIZE * 0.5 + actor.progress;
  const targetOffset = LIVING_BLOCK_FOCUS_LONGITUDINAL_OFFSETS[actor.localSlot] || 0;
  let relative = localLongitudinal - actor.livingBlockFocusLongitudinal - targetOffset;
  if (relative < -LIVING_BLOCK_FOCUS_SLOT_BAND) {
    relative = -LIVING_BLOCK_FOCUS_SLOT_BAND;
    actor.direction = 1;
  } else if (relative > LIVING_BLOCK_FOCUS_SLOT_BAND) {
    relative = LIVING_BLOCK_FOCUS_SLOT_BAND;
    actor.direction = -1;
  } else {
    return;
  }
  const boundedLongitudinal = THREE.MathUtils.clamp(
    actor.livingBlockFocusLongitudinal + targetOffset + relative,
    -SECTOR_SIZE * 0.44,
    SECTOR_SIZE * 0.44,
  );
  actor.progress = modulo(boundedLongitudinal + SECTOR_SIZE * 0.5, SECTOR_SIZE);
}

function createInstancedMesh(geometry, material, capacity, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

function geometryTriangles(geometry) {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute('position').count / 3;
}

function createPools(scene) {
  const vehicleProfile = getStreamedVehicleVisualProfile();
  const pedestrianProfile = getStreamedPedestrianVisualProfile();
  const root = new THREE.Group();
  root.name = 'Streamed district visible agents';
  root.userData.streamedAgentPool = true;

  const bodyMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: false,
    fog: true,
    toneMapped: false,
  });
  const vehicleAccentMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: false,
    fog: true,
    toneMapped: false,
  });
  const vehicleIdentityMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: false,
    fog: true,
    toneMapped: false,
  });
  const glassMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: false,
    fog: true,
    toneMapped: false,
  });
  const tireMaterial = new THREE.MeshStandardMaterial({
    color: 0x171a1d,
    roughness: 0.86,
  });
  const headlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xeaf4ff,
    emissive: 0xffe1ac,
    emissiveIntensity: 0.78,
    roughness: 0.26,
    vertexColors: true,
  });
  const torsoMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x101820,
    emissiveIntensity: 0.12,
    roughness: 0.78,
    vertexColors: false,
  });
  const skinMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x2a1810,
    emissiveIntensity: 0.08,
    roughness: 0.8,
    vertexColors: false,
  });
  const clothingMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x101418,
    emissiveIntensity: 0.1,
    roughness: 0.84,
    vertexColors: false,
  });
  const hairMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x0c1014,
    emissiveIntensity: 0.08,
    roughness: 0.88,
    vertexColors: false,
  });
  const roleCueMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x0c1014,
    emissiveIntensity: 0.1,
    roughness: 0.72,
    metalness: 0.04,
    vertexColors: false,
    fog: true,
  });

  const bodyGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.1);
  const cabinGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.075);
  const vehicleTrimGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.055);
  const vehicleRoofGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.06);
  const wheelGeometry = new THREE.CylinderGeometry(1, 1, 1, 12);
  wheelGeometry.rotateZ(Math.PI * 0.5);
  const lampGeometry = new THREE.BoxGeometry(1, 1, 1);
  const torsoGeometry = new THREE.CapsuleGeometry(0.26, 0.66, 3, 8);
  const shoulderGeometry = new THREE.CapsuleGeometry(0.1, 0.24, 2, 6);
  const headGeometry = new THREE.SphereGeometry(0.17, 10, 7);
  const hairGeometry = new THREE.SphereGeometry(0.17, 8, 5);
  const roleCueGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.05);
  const limbGeometry = new THREE.CapsuleGeometry(0.072, 0.56, 2, 6);

  const meshes = {
    vehicleBodies: createInstancedMesh(
      bodyGeometry,
      bodyMaterial,
      VEHICLE_CAPACITY,
      'Streamed vehicle bodies',
    ),
    vehicleSideTrims: createInstancedMesh(
      vehicleTrimGeometry,
      vehicleAccentMaterial,
      VEHICLE_CAPACITY * 2,
      'Streamed vehicle identity side trims',
    ),
    vehicleRoofDetails: createInstancedMesh(
      vehicleRoofGeometry,
      vehicleIdentityMaterial,
      VEHICLE_CAPACITY,
      'Streamed vehicle identity roof cues',
    ),
    vehicleCabins: createInstancedMesh(
      cabinGeometry,
      glassMaterial,
      VEHICLE_CAPACITY,
      'Streamed vehicle cabins',
    ),
    vehicleWheels: createInstancedMesh(
      wheelGeometry,
      tireMaterial,
      VEHICLE_CAPACITY * 2,
      'Streamed vehicle wheel pairs',
    ),
    vehicleHeadlights: createInstancedMesh(
      lampGeometry,
      headlightMaterial,
      VEHICLE_CAPACITY * 2,
      'Streamed vehicle headlights',
    ),
    pedestrianTorsos: createInstancedMesh(
      torsoGeometry,
      torsoMaterial,
      PEDESTRIAN_CAPACITY,
      'Streamed pedestrian torsos',
    ),
    pedestrianShoulders: createInstancedMesh(
      shoulderGeometry,
      clothingMaterial,
      PEDESTRIAN_CAPACITY * 2,
      'Streamed pedestrian shoulder layers',
    ),
    pedestrianHeads: createInstancedMesh(
      headGeometry,
      skinMaterial,
      PEDESTRIAN_CAPACITY,
      'Streamed pedestrian heads',
    ),
    pedestrianHair: createInstancedMesh(
      hairGeometry,
      hairMaterial,
      PEDESTRIAN_CAPACITY,
      'Streamed pedestrian hair silhouettes',
    ),
    pedestrianRoleCues: createInstancedMesh(
      roleCueGeometry,
      roleCueMaterial,
      PEDESTRIAN_CAPACITY,
      'Streamed pedestrian role cues',
    ),
    pedestrianLegs: createInstancedMesh(
      limbGeometry,
      clothingMaterial,
      PEDESTRIAN_CAPACITY * 2,
      'Streamed pedestrian legs',
    ),
    pedestrianArms: createInstancedMesh(
      limbGeometry,
      torsoMaterial,
      PEDESTRIAN_CAPACITY * 2,
      'Streamed pedestrian arms',
    ),
  };
  Object.values(meshes).forEach((mesh) => root.add(mesh));
  scene.add(root);

  const triangleCapacity = Object.values(meshes).reduce(
    (total, mesh) => total + geometryTriangles(mesh.geometry) * mesh.count,
    0,
  );
  return {
    root,
    meshes,
    vehicleProfile,
    pedestrianProfile,
    bodyMaterial,
    vehicleAccentMaterial,
    vehicleIdentityMaterial,
    glassMaterial,
    headlightMaterial,
    hairMaterial,
    roleCueMaterial,
    triangleCapacity: Math.round(triangleCapacity),
    drawCallEstimate: Object.keys(meshes).length,
  };
}

function createActorSlots(capacity, kind) {
  return Array.from({ length: capacity }, (_, poolIndex) => ({
    poolIndex,
    kind,
    active: false,
    everAssigned: false,
    id: null,
    sectorKey: null,
    sectorSeed: 0,
    sourceRevision: 0,
    sourceClock: 0,
    sourcePopulation: 0,
    localSlot: -1,
    tier: 'detail',
    role: null,
    destination: null,
    activity: null,
    pace: 1,
    dwellUntil: 0,
    direction: 1,
    orientation: 'east-west',
    roadLine: 0,
    laneOffset: VEHICLE_LANE_OFFSET,
    sidewalkOffset: SIDEWALK_OFFSET,
    spacingOffset: 0,
    visualScale: 1,
    bodyWidthScale: 1,
    bodyDepthScale: 1,
    limbScale: 1,
    gaitScale: 1,
    gaitRate: 8,
    gaitPhase: 0,
    progress: 0,
    livingBlockFocusLongitudinal: Number.NaN,
    speed: 0,
    moving: false,
    waiting: false,
    crossing: false,
    crossingProgress: 0,
    crossingLine: 0,
    sidewalkSide: 1,
    dwelling: false,
    dwellUntil: 0,
    signalIntent: null,
    indicatorSide: 0,
    focusTableau: false,
    focusStageRevision: 0,
    storyLabel: null,
    storyBeat: null,
    storyMood: null,
    storyChoice: null,
    storyPartnerSlot: -1,
    presentationCue: null,
    appearance: null,
    behaviorTree: null,
    behaviorActivity: null,
    blackboard: null,
    btIntent: null,
    btAnimCue: null,
    btUrgency: 0.55,
    position: new THREE.Vector3(0, PARK_Y, 0),
  }));
}

export function createStreamedAgentSystem({
  scene,
  streaming,
  maxActiveSectors = MAX_ACTIVE_SECTORS,
} = {}) {
  if (!scene?.isScene) throw new TypeError('createStreamedAgentSystem requires a THREE.Scene.');
  if (!streaming?.getSectorSimulationState) {
    throw new TypeError('createStreamedAgentSystem requires a streaming state provider.');
  }

  const configuredMaxActiveSectors = Math.min(
    MAX_ACTIVE_SECTORS,
    Math.max(1, Math.floor(maxActiveSectors)),
  );
  const pools = createPools(scene);
  const vehicleSlots = createActorSlots(VEHICLE_CAPACITY, 'vehicle');
  const pedestrianSlots = createActorSlots(PEDESTRIAN_CAPACITY, 'pedestrian');
  const actorById = new Map();
  const leasedBySector = new Map();
  const lastFocusPosition = new THREE.Vector3(Number.NaN, 0, Number.NaN);
  const lastStageFocusPosition = new THREE.Vector3(Number.NaN, 0, Number.NaN);
  const travel = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const yawQuat = new THREE.Quaternion();
  const pitchQuat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const workPosition = new THREE.Vector3();
  const localOffset = new THREE.Vector3();
  const cueScale = new THREE.Vector3();
  const cueOffset = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3(1, 0, 0);
  let activeSectorKeys = [];
  let previousEdgeCandidates = [];
  let edgeSectorKeys = [];
  let focusSectorKey = CORE_KEY;
  let predictedSectorKey = null;
  let scheduleBeat = beatForElapsed(0);
  let weather = 'clear';
  let vehicleAccumulator = 0;
  let pedestrianAccumulator = 0;
  let elapsedTime = 0;
  let reusedVehicles = 0;
  let reusedPedestrians = 0;
  let activationRevision = 0;
  let updatesSuppressedInCore = 0;
  let lastPredictor = { x: 1, z: 0 };
  let updateCount = 0;
  let vehicleStepCount = 0;
  let pedestrianStepCount = 0;
  let actorEvaluationCount = 0;
  let reconcileCount = 0;
  let tierTransitions = 0;
  let configuredRepresentatives = 0;
  let statesQueried = 0;
  let matricesDirty = true;
  let colorsDirty = true;

  const setMatrix = (mesh, index, position, yaw, sx, sy, sz, pitch = 0) => {
    yawQuat.setFromAxisAngle(yAxis, yaw);
    if (pitch) {
      pitchQuat.setFromAxisAngle(xAxis, pitch);
      rotation.copy(yawQuat).multiply(pitchQuat);
    } else {
      rotation.copy(yawQuat);
    }
    scale.set(sx, sy, sz);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
    matricesDirty = true;
  };

  const parkActorVisual = (actor) => {
    workPosition.set(0, PARK_Y, 0);
    if (actor.kind === 'vehicle') {
      setMatrix(pools.meshes.vehicleBodies, actor.poolIndex, workPosition, 0, 0.001, 0.001, 0.001);
      setMatrix(pools.meshes.vehicleCabins, actor.poolIndex, workPosition, 0, 0.001, 0.001, 0.001);
      setMatrix(pools.meshes.vehicleRoofDetails, actor.poolIndex, workPosition, 0, 0.001, 0.001, 0.001);
      for (let part = 0; part < 2; part += 1) {
        setMatrix(pools.meshes.vehicleSideTrims, actor.poolIndex * 2 + part, workPosition, 0, 0.001, 0.001, 0.001);
        setMatrix(pools.meshes.vehicleWheels, actor.poolIndex * 2 + part, workPosition, 0, 0.001, 0.001, 0.001);
        setMatrix(pools.meshes.vehicleHeadlights, actor.poolIndex * 2 + part, workPosition, 0, 0.001, 0.001, 0.001);
      }
    } else {
      setMatrix(pools.meshes.pedestrianTorsos, actor.poolIndex, workPosition, 0, 0.001, 0.001, 0.001);
      setMatrix(pools.meshes.pedestrianShoulders, actor.poolIndex * 2, workPosition, 0, 0.001, 0.001, 0.001);
      setMatrix(pools.meshes.pedestrianShoulders, actor.poolIndex * 2 + 1, workPosition, 0, 0.001, 0.001, 0.001);
      setMatrix(pools.meshes.pedestrianHeads, actor.poolIndex, workPosition, 0, 0.001, 0.001, 0.001);
      setMatrix(pools.meshes.pedestrianHair, actor.poolIndex, workPosition, 0, 0.001, 0.001, 0.001);
      setMatrix(pools.meshes.pedestrianRoleCues, actor.poolIndex, workPosition, 0, 0.001, 0.001, 0.001);
      for (let part = 0; part < 2; part += 1) {
        setMatrix(pools.meshes.pedestrianLegs, actor.poolIndex * 2 + part, workPosition, 0, 0.001, 0.001, 0.001);
        setMatrix(pools.meshes.pedestrianArms, actor.poolIndex * 2 + part, workPosition, 0, 0.001, 0.001, 0.001);
      }
    }
    actor.position.set(0, PARK_Y, 0);
  };

  [...vehicleSlots, ...pedestrianSlots].forEach(parkActorVisual);

  const releaseActor = (actor) => {
    actorById.delete(actor.id);
    actor.active = false;
    actor.id = null;
    actor.sectorKey = null;
    actor.appearance = null;
    actor.waiting = false;
    actor.moving = false;
    actor.crossing = false;
    actor.crossingProgress = 0;
    actor.dwelling = false;
    actor.dwellUntil = 0;
    actor.signalIntent = null;
    actor.indicatorSide = 0;
    actor.storyLabel = null;
    actor.storyBeat = null;
    actor.storyMood = null;
    actor.storyChoice = null;
    actor.storyPartnerSlot = -1;
    parkActorVisual(actor);
  };

  const acquireActor = (slots, id) => {
    const existing = actorById.get(id);
    if (existing) return { actor: existing, reused: true };
    const start = hash32(id) % slots.length;
    for (let offset = 0; offset < slots.length; offset += 1) {
      const actor = slots[(start + offset) % slots.length];
      if (!actor.active) {
        const reused = actor.everAssigned;
        actor.active = true;
        actor.everAssigned = true;
        actor.id = id;
        actorById.set(id, actor);
        return { actor, reused };
      }
    }
    return { actor: null, reused: false };
  };

  const configureVehicle = (
    actor,
    sectorKey,
    state,
    localSlot,
    tier,
    keepMotion = false,
    focusPosition = null,
  ) => {
    const coordinates = parseSectorKey(sectorKey);
    const seed = hash32(`${state.stateId}:${localSlot}:vehicle`);
    const district = districtForSector(sectorKey);
    const profile = districtProfileFor(sectorKey);
    const focusTableau = Boolean(
      tier === 'detail'
      && localSlot < FOCUS_TABLEAU_VEHICLES
      && focusPosition,
    );
    const livingBlockSectorActor = tier === 'detail' && LIVING_BLOCK_ACTOR_SECTORS.has(sectorKey);
    const livingBlockActor = livingBlockSectorActor && focusTableau;
    const tableauSlot = localSlot < FOCUS_TABLEAU_VEHICLES;
    // Focus tableau locks a readable four-class set so taxi / SFMTA bus /
    // service van / private do not collapse into repeated black boxes.
    const className = tableauSlot
      ? FOCUS_VEHICLE_CLASS_ORDER[localSlot % FOCUS_VEHICLE_CLASS_ORDER.length]
      : pickWeighted(seed, 1, profile.classWeights);
    const spec = className === 'bus'
      ? STREAMED_BUS_CLASS
      : (pools.vehicleProfile.classes[className] || pools.vehicleProfile.classes.sedan);
    const schedulePhase = vehicleSchedulePhaseFor(className, dayHourAt(elapsedTime));
    const bodyColors = pools.vehicleProfile.bodyColors;
    const focusBodyPalette = FOCUS_VEHICLE_BODY_COLORS[className]
      || FOCUS_VEHICLE_BODY_COLORS.sedan;
    const bodyColor = className === 'taxi'
      ? pools.vehicleProfile.taxiColor
      : className === 'bus'
        ? BUS_BODY_COLOR
        : focusBodyPalette[Math.floor(seededUnit(seed, 2) * focusBodyPalette.length)]
          || bodyColors[Math.floor(seededUnit(seed, 2) * bodyColors.length)];
    const bodyTint = new THREE.Color(bodyColor);
    if (LIVING_BLOCK_ACTOR_SECTORS.has(sectorKey) && tableauSlot && localSlot === 3) {
      bodyTint.setHex(0x5f83b8);
    }
    // Private cars still get a lift so graphite paints do not read as black boxes.
    const minLightness = className === 'bus'
      ? (tableauSlot ? 0.58 : 0.5)
      : className === 'taxi'
        ? (tableauSlot ? 0.62 : 0.54)
        : className === 'bike'
          ? (tableauSlot ? 0.48 : 0.4)
        : className === 'van'
          ? (tableauSlot ? 0.52 : 0.44)
          : (tableauSlot ? 0.5 : 0.42);
    liftReadableColor(
      bodyTint,
      minLightness,
      className === 'taxi' || className === 'van' || className === 'bike' ? 0.24 : 0.16,
    );
    if (livingBlockSectorActor) {
      // Per-instance albedo lift keeps the ordinary day/night tableau
      // readable without changing the shared material or adding emissive
      // glow.  Class hues remain the identity cue (taxi yellow, bus cream,
      // van orange/blue, private cool neutrals).
      liftReadableColor(
        bodyTint,
        Math.min(0.74, minLightness + 0.1),
        className === 'bus' || className === 'van' ? 0.3 : 0.24,
      );
    }
    const displayBodyColor = bodyTint.getHex();
    const accentColor = VEHICLE_ACCENT_COLORS[className] || VEHICLE_ACCENT_COLORS.sedan;
    const roofCueColor = VEHICLE_ROOF_CUE_COLORS[className] || VEHICLE_ROOF_CUE_COLORS.sedan;
    const roofCueSize = VEHICLE_ROOF_CUE_SIZES[className] || VEHICLE_ROOF_CUE_SIZES.sedan;
    const silhouette = VEHICLE_SILHOUETTE[className] || VEHICLE_SILHOUETTE.sedan;
    const previousProgress = actor.progress;
    actor.sectorKey = sectorKey;
    actor.sectorSeed = seed;
    actor.sourceRevision = state.handoffRevision;
    actor.sourceClock = state.trafficClock;
    actor.sourcePopulation = state.vehicleCount;
    actor.localSlot = localSlot;
    actor.tier = tier;
    actor.activity = schedulePhase.activity;
    actor.pace = schedulePhase.pace;
    actor.orientation = Math.abs(coordinates.x + coordinates.z) % 2 === 1
      ? 'east-west'
      : 'north-south';
    actor.livingBlockFocusLongitudinal = livingBlockActor
      ? (actor.orientation === 'east-west'
        ? focusPosition.x - coordinates.x * SECTOR_SIZE
        : focusPosition.z - coordinates.z * SECTOR_SIZE)
      : Number.NaN;
    actor.roadLine = streetLineFor(sectorKey, localSlot, 'vehicle');
    actor.direction = localSlot % 2 === 0 ? 1 : -1;
    actor.sidewalkSide = localSlot % 4 < 2 ? -1 : 1;
    const laneBias = VEHICLE_CLASS_LANE_BIAS[className] || 0;
    actor.laneOffset = VEHICLE_LANE_OFFSET
      + laneBias
      + (seededUnit(seed, 4) - 0.5) * (className === 'bus' ? 0.18 : className === 'bike' ? 0.12 : 0.34);
    actor.spacingOffset = (seededUnit(seed, 5) - 0.5) * VEHICLE_SPACING_JITTER
      + (VEHICLE_CLASS_SPACING[className] || 0) * (actor.direction > 0 ? 1 : -1);
    actor.focusTableau = focusTableau;
    actor.presentationCue = livingBlockActor ? 'ordinary-living-block-near-traffic' : null;
    actor.visualScale = tableauSlot
      ? (className === 'bus' ? 1.02 : className === 'bike' ? 1.2 : 1.08) + seededUnit(seed, 6) * 0.08
      : (className === 'bus' ? 0.94 : className === 'bike' ? 1.08 : 0.97) + seededUnit(seed, 6) * 0.08;
    if (livingBlockSectorActor) {
      actor.visualScale *= LIVING_BLOCK_VEHICLE_SCALE;
      if (livingBlockActor && localSlot === 3) actor.visualScale *= 1.28;
    }
    actor.dwelling = false;
    actor.dwellUntil = 0;
    actor.signalIntent = null;
    actor.indicatorSide = 0;
    const focusPhase = focusTableau
      ? (seededUnit(seed, 13) - 0.5) * 0.18
      : 0;
    const focusSpacing = FOCUS_VEHICLE_SPACING
      + (className === 'bus' ? 10 : className === 'van' ? 4 : 0);
    actor.progress = nearFocusProgress(
      sectorKey,
      focusPosition,
      actor.orientation,
      localSlot,
      focusSpacing,
      focusPhase,
      FOCUS_TABLEAU_VEHICLES,
    ) ?? modulo(
      (localSlot + 0.5) * (SECTOR_SIZE / VEHICLES_PER_SECTOR)
        + actor.spacingOffset
        + state.trafficClock * GRID_STEP,
      SECTOR_SIZE,
    );
    const baseSpeed = className === 'bus'
      ? 6.4
      : className === 'bike'
        ? 5.8
      : className === 'van'
        ? 7.4
        : className === 'taxi'
          ? 8.8
          : 8.2;
    actor.speed = baseSpeed + seededUnit(seed, 3) * (className === 'bus' ? 0.9 : className === 'bike' ? 1.1 : 1.4);
    actor.destination = `${district} ${schedulePhase.destination} ${localSlot + 1}`;
    actor.appearance = {
      className,
      bodyColor: displayBodyColor,
      district,
      fleetRole: schedulePhase.fleetRole,
      destination: actor.destination,
      length: spec.len,
      width: spec.wid,
      height: spec.hgt,
      wheelRadius: spec.wheelR,
      accentColor,
      roofCueColor,
      roofCueSize: {
        width: roofCueSize.width * (tableauSlot ? 1.18 : 1.08),
        height: roofCueSize.height * (tableauSlot ? 1.16 : 1.08),
        length: roofCueSize.length * (tableauSlot ? 1.14 : 1.06),
      },
      silhouette: { ...silhouette },
      cabinColor: className === 'bus'
        ? 0x6f8fa0
        : className === 'taxi'
          ? 0xd8e8ef
          : 0xc1d9e2,
      indicatorColor: 0xffa51f,
      brakeColor: 0xff3d4a,
    };
    if (keepMotion) actor.progress = previousProgress;
    pools.meshes.vehicleBodies.setColorAt(actor.poolIndex, bodyTint);
    const cabinTint = new THREE.Color(actor.appearance.cabinColor);
    const trimTint = new THREE.Color(accentColor);
    const roofTint = new THREE.Color(roofCueColor);
    if (livingBlockSectorActor) {
      liftReadableColor(cabinTint, 0.5, 0.2);
      liftReadableColor(trimTint, 0.54, 0.3);
      liftReadableColor(roofTint, 0.52, 0.28);
    }
    pools.meshes.vehicleCabins.setColorAt(
      actor.poolIndex,
      cabinTint,
    );
    pools.meshes.vehicleRoofDetails.setColorAt(actor.poolIndex, roofTint);
    pools.meshes.vehicleSideTrims.setColorAt(actor.poolIndex * 2, trimTint);
    pools.meshes.vehicleSideTrims.setColorAt(actor.poolIndex * 2 + 1, trimTint);
    const rearLamp = new THREE.Color(actor.appearance.brakeColor);
    const frontLamp = new THREE.Color(livingBlockActor ? 0xfff8da : 0xfff4cf);
    if (livingBlockActor) liftReadableColor(frontLamp, 0.74, 0.24);
    pools.meshes.vehicleHeadlights.setColorAt(actor.poolIndex * 2, rearLamp);
    pools.meshes.vehicleHeadlights.setColorAt(actor.poolIndex * 2 + 1, frontLamp);
    colorsDirty = true;
  };

  const configurePedestrian = (
    actor,
    sectorKey,
    state,
    localSlot,
    tier,
    keepMotion = false,
    focusPosition = null,
  ) => {
    const coordinates = parseSectorKey(sectorKey);
    const seed = hash32(`${state.stateId}:${localSlot}:pedestrian`);
    const profile = pools.pedestrianProfile;
    const district = districtForSector(sectorKey);
    const districtProfile = districtProfileFor(sectorKey);
    const focusTableau = Boolean(
      tier === 'detail'
      && localSlot < FOCUS_TABLEAU_PEDESTRIANS
      && focusPosition,
    );
    const livingBlockActor = focusTableau && LIVING_BLOCK_ACTOR_SECTORS.has(sectorKey);
    const tableauSlot = localSlot < FOCUS_TABLEAU_PEDESTRIANS;
    const tableauStory = tableauSlot ? FOCUS_TABLEAU_MICRO_STORIES[localSlot] : null;
    let role = tableauStory?.role || pickWeighted(seed, 1, districtProfile.roles);
    if (districtForSector(sectorKey) === 'Outer Sunset' && localSlot === 4) {
      // Guarantee an Outer Sunset focus always carries a beachgoer
      // representative; weighted sampling can otherwise roll zero on a quiet
      // morning and the district loses its Ocean Beach identity cue.
      role = 'beachgoer';
    }
    const schedulePhase = schedulePhaseForRole(role, dayHourAt(elapsedTime));
    const wardrobe = districtProfile.wardrobe;
    const topColors = wardrobe.tops.length ? wardrobe.tops : profile.topColors;
    const bottomColors = wardrobe.bottoms.length ? wardrobe.bottoms : profile.bottomColors;
    const roleAccent = PEDESTRIAN_ROLE_ACCENTS[role] || DEFAULT_PEDESTRIAN_ROLE_ACCENT;
    const roleCueColor = new THREE.Color(roleAccent.color);
    liftReadableColor(roleCueColor, tableauSlot ? 0.62 : 0.52, 0.28);
    const topColor = new THREE.Color(
      topColors[Math.floor(seededUnit(seed, 2) * topColors.length)],
    );
    const northBeachTableau = sectorKey === '4:4' && tableauSlot;
    liftReadableColor(topColor, northBeachTableau ? 0.52 : 0.48, 0.2);
    if (tableauSlot) {
      topColor.lerp(roleCueColor, 0.42);
      liftReadableColor(topColor, northBeachTableau ? 0.62 : 0.55, 0.24);
    }
    const skinColor = new THREE.Color(
      profile.skinColors[Math.floor(seededUnit(seed, 1) * profile.skinColors.length)],
    );
    liftReadableColor(skinColor, 0.48, 0.14);
    const bottomColor = new THREE.Color(
      bottomColors[Math.floor(seededUnit(seed, 3) * bottomColors.length)],
    );
    liftReadableColor(bottomColor, 0.4, 0.12);
    const hairColor = new THREE.Color(
      PEDESTRIAN_HAIR_COLORS[Math.floor(seededUnit(seed, 12) * PEDESTRIAN_HAIR_COLORS.length)],
    );
    const previousProgress = actor.progress;
    actor.sectorKey = sectorKey;
    actor.sectorSeed = seed;
    actor.sourceRevision = state.handoffRevision;
    actor.sourceClock = state.pedestrianClock;
    actor.sourcePopulation = state.pedestrianCount;
    actor.localSlot = localSlot;
    actor.tier = tier;
    actor.role = role;
    actor.activity = schedulePhase.activity;
    actor.pace = schedulePhase.pace;
    actor.destination = `${district} ${schedulePhase.destination} ${localSlot + 1}`;
    actor.orientation = Math.abs(coordinates.x + coordinates.z) % 2 === 1
      ? 'east-west'
      : 'north-south';
    actor.roadLine = streetLineFor(sectorKey, localSlot, 'pedestrian');
    actor.direction = localSlot % 2 === 0 ? 1 : -1;
    actor.sidewalkOffset = SIDEWALK_ROAM_OFFSETS[
      (localSlot + hash32(`${sectorKey}:sidewalk-lanes`)) % SIDEWALK_ROAM_OFFSETS.length
    ];
    actor.spacingOffset = (seededUnit(seed, 6) - 0.5) * PEDESTRIAN_SPACING_JITTER;
    const roleCue = PEDESTRIAN_ROLE_CUES[role] || DEFAULT_PEDESTRIAN_ROLE_CUE;
    actor.focusTableau = focusTableau;
    actor.presentationCue = livingBlockActor ? 'ordinary-living-block-near-pedestrian' : null;
    actor.storyLabel = tableauStory?.label || null;
    actor.storyBeat = tableauStory?.beat || null;
    actor.storyMood = tableauStory?.mood || null;
    actor.storyChoice = tableauStory?.choice || null;
    actor.storyPartnerSlot = tableauStory?.partnerSlot ?? -1;
    if (tableauStory?.dwell && seededUnit(seed, 64) < 0.5) {
      actor.dwelling = true;
      actor.dwellUntil = elapsedTime + 2.4 + seededUnit(seed, 63) * 2.2;
      actor.moving = false;
      actor.waiting = false;
    }
    const tableauScaleBoost = northBeachTableau ? 1.12 : 1;
    actor.bodyWidthScale = roleCue.width * tableauScaleBoost * (
      tableauSlot ? 1.06 + seededUnit(seed, 7) * 0.1 : 0.96 + seededUnit(seed, 7) * 0.08
    );
    actor.bodyDepthScale = roleCue.depth * tableauScaleBoost * (
      tableauSlot ? 1.05 + seededUnit(seed, 8) * 0.1 : 0.95 + seededUnit(seed, 8) * 0.1
    );
    actor.limbScale = roleCue.limb * (
      tableauSlot ? 1.01 + seededUnit(seed, 9) * 0.1 : 0.96 + seededUnit(seed, 9) * 0.08
    );
    if (livingBlockActor) {
      actor.bodyWidthScale *= LIVING_BLOCK_PEDESTRIAN_SCALE;
      actor.bodyDepthScale *= LIVING_BLOCK_PEDESTRIAN_SCALE;
      actor.limbScale *= 1.05;
    }
    actor.gaitScale = roleCue.gait;
    actor.gaitRate = 7.4 + seededUnit(seed, 10) * 1.2;
    actor.gaitPhase = seededUnit(seed, 11) * Math.PI * 2;
    const focusPhase = focusTableau
      ? (seededUnit(seed, 13) - 0.5) * 0.16
      : 0;
    actor.progress = nearFocusProgress(
      sectorKey,
      focusPosition,
      actor.orientation,
      localSlot,
      FOCUS_PEDESTRIAN_SPACING,
      focusPhase,
      FOCUS_TABLEAU_PEDESTRIANS,
    ) ?? modulo(
      (localSlot + 0.35) * (SECTOR_SIZE / PEDESTRIANS_PER_SECTOR)
        + actor.spacingOffset
        + state.pedestrianClock * 18,
      SECTOR_SIZE,
    );
    actor.speed = 1.08 + seededUnit(seed, 4) * 0.36;
    actor.appearance = {
      skinColor: skinColor.getHex(),
      topColor: topColor.getHex(),
      bottomColor: bottomColor.getHex(),
      hairColor: hairColor.getHex(),
      roleCueKind: roleAccent.kind,
      roleCueColor: roleCueColor.getHex(),
      district,
      role,
      destination: actor.destination,
      storyLabel: actor.storyLabel,
      storyBeat: actor.storyBeat,
      heightScale: 1 + seededUnit(seed, 5) * 0.14,
    };
    if (keepMotion) actor.progress = previousProgress;
    pools.meshes.pedestrianTorsos.setColorAt(actor.poolIndex, new THREE.Color(actor.appearance.topColor));
    pools.meshes.pedestrianHeads.setColorAt(actor.poolIndex, new THREE.Color(actor.appearance.skinColor));
    pools.meshes.pedestrianHair.setColorAt(actor.poolIndex, hairColor);
    pools.meshes.pedestrianRoleCues.setColorAt(actor.poolIndex, roleCueColor);
    pools.meshes.pedestrianLegs.setColorAt(actor.poolIndex * 2, new THREE.Color(actor.appearance.bottomColor));
    pools.meshes.pedestrianLegs.setColorAt(actor.poolIndex * 2 + 1, new THREE.Color(actor.appearance.bottomColor));
    pools.meshes.pedestrianArms.setColorAt(actor.poolIndex * 2, new THREE.Color(actor.appearance.topColor));
    pools.meshes.pedestrianArms.setColorAt(actor.poolIndex * 2 + 1, new THREE.Color(actor.appearance.topColor));
    pools.meshes.pedestrianShoulders.setColorAt(actor.poolIndex * 2, new THREE.Color(actor.appearance.topColor));
    pools.meshes.pedestrianShoulders.setColorAt(actor.poolIndex * 2 + 1, new THREE.Color(actor.appearance.topColor));
    colorsDirty = true;
  };

  const ensurePedestrianBehaviorTree = (actor) => {
    if (actor.kind !== 'pedestrian' || !actor.activity) return;
    if (actor.behaviorActivity !== actor.activity || !actor.behaviorTree) {
      actor.behaviorTree = createStreamedTreeForActivity(actor.activity);
      actor.behaviorActivity = actor.activity;
      actor.blackboard = createBlackboard({
        roleId: actor.role,
        activity: actor.activity,
        atCrossing: false,
        signalClear: false,
        atDestination: false,
        preferWork: false,
        handoffReady: false,
        intent: 'walk',
        animCue: 'stream-commute',
        urgency: 0.55,
      });
    }
  };

  const tickStreamedPedestrianBehavior = (actor, step) => {
    if (actor.kind !== 'pedestrian') return;
    ensurePedestrianBehaviorTree(actor);
    if (!actor.behaviorTree || !actor.blackboard) return;
    const bb = actor.blackboard;
    bb.roleId = actor.role;
    bb.activity = actor.activity;
    bb.atCrossing = Boolean(actor.crossing || actor.waiting);
    bb.signalClear = Boolean(actor.crossing) && !actor.waiting;
    bb.atDestination = Boolean(actor.dwelling);
    bb.preferWork = actor.dwelling && (
      actor.activity === 'working'
      || actor.activity === 'service'
      || actor.activity === 'shopping'
      || actor.activity === 'studying'
    );
    tickBehaviorTree(actor.behaviorTree, bb, step);
    actor.btIntent = bb.intent;
    actor.btAnimCue = bb.animCue;
    actor.btUrgency = Number.isFinite(bb.urgency) ? bb.urgency : 0.55;
    if (actor.btIntent === 'walk' || actor.btIntent === 'cross') {
      actor.pace = THREE.MathUtils.clamp(
        actor.pace * (0.92 + actor.btUrgency * 0.2),
        0.72,
        1.45,
      );
    }
  };

  const refreshActorSchedule = (actor) => {
    const dayHour = dayHourAt(elapsedTime);
    if (actor.kind === 'vehicle') {
      const phase = vehicleSchedulePhaseFor(actor.appearance.className, dayHour);
      actor.activity = phase.activity;
      actor.pace = phase.pace;
      actor.destination = `${actor.appearance.district} ${phase.destination} ${actor.localSlot + 1}`;
      actor.appearance.fleetRole = phase.fleetRole;
      actor.appearance.destination = actor.destination;
    } else {
      const phase = schedulePhaseForRole(actor.role, dayHour);
      actor.activity = phase.activity;
      actor.pace = phase.pace;
      actor.destination = `${actor.appearance.district} ${phase.destination} ${actor.localSlot + 1}`;
      actor.appearance.destination = actor.destination;
      ensurePedestrianBehaviorTree(actor);
    }
  };

  const reconcileActors = (desiredKeys, edgeCandidateKeys, focusPosition = null) => {
    const desiredIds = new Set();
    const nextLeases = new Map();
    const plan = [];
    // Free sectors that fell out of the focus/prediction window before
    // acquiring replacements. Retained sector actors keep their instance
    // index, while a 2 -> 2 sector transition never needs transient capacity.
    [...actorById.values()].forEach((actor) => {
      if (!desiredKeys.includes(actor.sectorKey)) releaseActor(actor);
    });
    desiredKeys.forEach((sectorKey) => {
      const state = streaming.getSectorSimulationState(sectorKey);
      statesQueried += 1;
      if (!state) return;
      plan.push({ sectorKey, state, tier: 'detail' });
    });
    let edgeAdded = false;
    edgeCandidateKeys.forEach((sectorKey) => {
      if (edgeAdded) return;
      if (!desiredKeys.includes(sectorKey)
        && streaming.isSectorActive(sectorKey)
        && !streaming.isSectorDetailed(sectorKey)) {
        const state = streaming.getSectorSimulationState(sectorKey);
        statesQueried += 1;
        if (state) {
          plan.push({ sectorKey, state, tier: 'edge' });
          edgeAdded = true;
        }
      }
    });
    plan.forEach(({ sectorKey, state, tier }) => {
      const vehicleLeaseCount = Math.min(
        tier === 'edge' ? EDGE_VEHICLES_PER_SECTOR : VEHICLES_PER_SECTOR,
        state.vehicleCount,
      );
      const pedestrianLeaseCount = Math.min(
        tier === 'edge' ? EDGE_PEDESTRIANS_PER_SECTOR : PEDESTRIANS_PER_SECTOR,
        state.pedestrianCount,
      );
      const lease = {
        mode: 'read-only-representative',
        tier,
        district: districtForSector(sectorKey),
        sourceStateId: state.stateId,
        sourceRevision: state.handoffRevision,
        aggregateVehicles: state.vehicleCount,
        aggregatePedestrians: state.pedestrianCount,
        visibleVehicleRepresentatives: vehicleLeaseCount,
        visiblePedestrianRepresentatives: pedestrianLeaseCount,
        aggregateMutation: false,
      };
      nextLeases.set(sectorKey, lease);
      const idPrefix = 'sf-agent';
      for (let localSlot = 0; localSlot < vehicleLeaseCount; localSlot += 1) {
        const id = `${idPrefix}:${state.stateId}:vehicle:${localSlot}`;
        desiredIds.add(id);
        const acquired = acquireActor(vehicleSlots, id);
        if (!acquired.actor) continue;
        if (acquired.reused && acquired.actor.tier !== tier) tierTransitions += 1;
        if (!acquired.reused || acquired.actor.sectorKey !== sectorKey
          || acquired.actor.sourceRevision !== state.handoffRevision
          || acquired.actor.tier !== tier) {
          const keepMotion = acquired.reused && acquired.actor.sectorKey === sectorKey;
          configureVehicle(
            acquired.actor,
            sectorKey,
            state,
            localSlot,
            tier,
            keepMotion,
            tier === 'detail' && sectorKey === focusSectorKey ? focusPosition : null,
          );
          configuredRepresentatives += 1;
          if (acquired.reused) reusedVehicles += 1;
        }
      }
      for (let localSlot = 0; localSlot < pedestrianLeaseCount; localSlot += 1) {
        const id = `${idPrefix}:${state.stateId}:pedestrian:${localSlot}`;
        desiredIds.add(id);
        const acquired = acquireActor(pedestrianSlots, id);
        if (!acquired.actor) continue;
        if (acquired.reused && acquired.actor.tier !== tier) tierTransitions += 1;
        if (!acquired.reused || acquired.actor.sectorKey !== sectorKey
          || acquired.actor.sourceRevision !== state.handoffRevision
          || acquired.actor.tier !== tier) {
          const keepMotion = acquired.reused && acquired.actor.sectorKey === sectorKey;
          configurePedestrian(
            acquired.actor,
            sectorKey,
            state,
            localSlot,
            tier,
            keepMotion,
            tier === 'detail' && sectorKey === focusSectorKey ? focusPosition : null,
          );
          configuredRepresentatives += 1;
          if (acquired.reused) reusedPedestrians += 1;
        }
      }
    });
    [...actorById.values()].forEach((actor) => {
      if (!desiredIds.has(actor.id)) releaseActor(actor);
    });
    leasedBySector.clear();
    nextLeases.forEach((lease, key) => leasedBySector.set(key, lease));
    edgeSectorKeys = plan.filter((entry) => entry.tier === 'edge').map((entry) => entry.sectorKey);
    activationRevision += 1;
    reconcileCount += 1;
  };

  const stageFocusTableau = (focusPosition, force = false) => {
    if (focusSectorKey === CORE_KEY || !focusPosition
      || !Number.isFinite(focusPosition.x) || !Number.isFinite(focusPosition.z)) return false;
    const focusMoved = !Number.isFinite(lastStageFocusPosition.x)
      || !Number.isFinite(lastStageFocusPosition.z)
      || Math.hypot(
        focusPosition.x - lastStageFocusPosition.x,
        focusPosition.z - lastStageFocusPosition.z,
      ) >= FOCUS_RESTAGE_DISTANCE;
    if (!force && !focusMoved) return false;

    const focusActors = [...vehicleSlots, ...pedestrianSlots]
      .filter((actor) => actor.active && actor.tier === 'detail'
        && actor.sectorKey === focusSectorKey)
      .sort((a, b) => a.localSlot - b.localSlot);
    focusActors.forEach((actor) => {
      const isVehicle = actor.kind === 'vehicle';
      const tableauCount = isVehicle ? FOCUS_TABLEAU_VEHICLES : FOCUS_TABLEAU_PEDESTRIANS;
      if (actor.localSlot >= tableauCount) return;
      const route = focusTableauRoute(actor.kind, actor.localSlot, focusSectorKey);
      if (!route) return;
      const livingBlockVehicle = actor.kind === 'vehicle'
        && LIVING_BLOCK_ACTOR_SECTORS.has(focusSectorKey);
      const livingBlockPedestrian = actor.kind === 'pedestrian'
        && LIVING_BLOCK_ACTOR_SECTORS.has(focusSectorKey);
      const stagedLongitudinalOffset = livingBlockVehicle
        ? (LIVING_BLOCK_FOCUS_LONGITUDINAL_OFFSETS[actor.localSlot]
          ?? route.longitudinalOffset)
        : livingBlockPedestrian
          ? (LIVING_BLOCK_FOCUS_PEDESTRIAN_OFFSETS[actor.localSlot]
            ?? route.longitudinalOffset)
        : route.longitudinalOffset;
      const stagedProgress = nearFocusProgressAt(
        focusSectorKey,
        focusPosition,
        route.orientation,
        stagedLongitudinalOffset,
      );
      if (stagedProgress === null) return;
      // A QA teleport can leave a representative mid-crossing or in a dwell
      // state from the previous doorway. Re-seed only the staged tableau's
      // local presentation state; IDs, schedules, clocks, and leases remain
      // untouched and the next fixed step resumes ordinary motion.
      actor.progress = stagedProgress;
      actor.orientation = route.orientation;
      if (livingBlockVehicle) {
        const coordinates = parseSectorKey(actor.sectorKey);
        actor.livingBlockFocusLongitudinal = route.orientation === 'east-west'
          ? focusPosition.x - coordinates.x * SECTOR_SIZE
          : focusPosition.z - coordinates.z * SECTOR_SIZE;
        actor.presentationCue = 'ordinary-living-block-near-traffic';
      }
      actor.roadLine = nearFocusStreetLine(
        focusSectorKey,
        focusPosition,
        actor.orientation,
        actor.roadLine,
      );
      if (route.sidewalkSide === -1 || route.sidewalkSide === 1) {
        actor.sidewalkSide = route.sidewalkSide;
      }
      actor.crossing = false;
      actor.crossingProgress = 0;
      actor.waiting = false;
      actor.dwelling = false;
      actor.dwellUntil = 0;
      actor.signalIntent = null;
      actor.indicatorSide = 0;
      actor.moving = true;
      actor.focusTableau = true;
      actor.focusStageRevision += 1;
      if (actor.kind === 'pedestrian') {
        const story = FOCUS_TABLEAU_MICRO_STORIES[actor.localSlot];
        if (story?.dwell && seededUnit(actor.sectorSeed, 64) < 0.5) {
          actor.dwelling = true;
          actor.dwellUntil = elapsedTime + 2.4 + seededUnit(actor.sectorSeed, 63) * 2.2;
          actor.moving = false;
          actor.waiting = false;
        }
      }
    });
    lastStageFocusPosition.copy(focusPosition);
    return true;
  };

  const choosePredictedCoordinates = (focus) => {
    if (travel.lengthSq() > 1) {
      lastPredictor = Math.abs(travel.x) >= Math.abs(travel.z)
        ? { x: Math.sign(travel.x) || 1, z: 0 }
        : { x: 0, z: Math.sign(travel.z) || 1 };
    }
    if (!lastPredictor.x && !lastPredictor.z) {
      const direction = hash32(`${focus.x}:${focus.z}`) % 4;
      lastPredictor = [
        { x: 1, z: 0 },
        { x: 0, z: 1 },
        { x: -1, z: 0 },
        { x: 0, z: -1 },
      ][direction];
    }
    return {
      x: focus.x + lastPredictor.x,
      z: focus.z + lastPredictor.z,
    };
  };

  const reconcileSectors = (position) => {
    const focus = {
      x: Math.round(position.x / SECTOR_SIZE),
      z: Math.round(position.z / SECTOR_SIZE),
    };
    const nextFocusKey = `${focus.x}:${focus.z}`;
    const desired = [];
    const edgeCandidates = [];
    if (nextFocusKey !== CORE_KEY && streaming.isSectorDetailed(nextFocusKey)) {
      desired.push(nextFocusKey);
      const predicted = choosePredictedCoordinates(focus);
      const nextPredictedKey = `${predicted.x}:${predicted.z}`;
      if (nextPredictedKey !== CORE_KEY
        && streaming.isSectorDetailed(nextPredictedKey)
        && desired.length < Math.min(MILESTONE_ACTIVE_SECTORS, configuredMaxActiveSectors)) {
        desired.push(nextPredictedKey);
      }
      predictedSectorKey = desired[1] ?? null;
      const axis = Math.abs(lastPredictor.x) >= Math.abs(lastPredictor.z)
        ? { primary: Math.sign(lastPredictor.x) || 1, cross: 0 }
        : { primary: 0, cross: Math.sign(lastPredictor.z) || 1 };
      const candidates = [
        [axis.primary * 2, 0],
        [axis.primary * 2, 1],
        [axis.primary * 2, -1],
        [axis.primary, 2],
        [axis.primary, -2],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      const seed = hash32(`${focus.x}:${focus.z}:edge`);
      const forwardSign = axis.primary !== 0
        ? axis.primary
        : lastPredictor.z >= 0 ? 1 : -1;
      candidates.sort((a, b) => {
        const forwardA = a[0] * forwardSign;
        const forwardB = b[0] * forwardSign;
        if (forwardA !== forwardB) return forwardB - forwardA;
        return ((seed + a[0] * 7 + a[1] * 13) % 101)
          - ((seed + b[0] * 7 + b[1] * 13) % 101);
      });
      for (let index = 0; index < candidates.length && edgeCandidates.length < 6; index += 1) {
        const [dx, dz] = candidates[index];
        edgeCandidates.push(`${focus.x + dx}:${focus.z + dz}`);
      }
    } else {
      predictedSectorKey = null;
    }
    const focusChanged = nextFocusKey !== focusSectorKey;
    focusSectorKey = nextFocusKey;
    const leasesChanged = desired.join('|') !== activeSectorKeys.join('|')
      || edgeCandidates.join('|') !== previousEdgeCandidates.join('|');
    if (leasesChanged) {
      activeSectorKeys = desired;
      previousEdgeCandidates = edgeCandidates;
      reconcileActors(desired, edgeCandidates, position);
    }
    stageFocusTableau(position, focusChanged || leasesChanged);
    pools.root.visible = activeSectorKeys.length > 0;
  };

  const vehicleWeatherFactor = () => (
    weather === 'drizzle' ? 0.78 : weather === 'fog' ? 0.88 : 1
  );
  const pedestrianWeatherFactor = () => (
    weather === 'drizzle' ? 0.86 : weather === 'fog' ? 0.94 : 1
  );

  const surfaceY = (x, z) => {
    const value = streaming.getSurfaceHeight({ x, z });
    return Number.isFinite(value) ? value : 0;
  };

  const placeVehicle = (actor) => {
    const coordinates = parseSectorKey(actor.sectorKey);
    const centerX = coordinates.x * SECTOR_SIZE;
    const centerZ = coordinates.z * SECTOR_SIZE;
    const longitudinal = -SECTOR_SIZE * 0.5 + actor.progress;
    // Pull curb-service vehicles slightly toward the near curb while dwelling.
    const dwellPull = actor.dwelling
      ? (actor.appearance.className === 'bus'
        ? 0.55
        : actor.appearance.className === 'taxi' || actor.appearance.className === 'van'
          ? 0.42
          : 0.18)
      : 0;
    const lane = actor.laneOffset + dwellPull * actor.sidewalkSide * actor.direction;
    const livingBlockLateral = actor.presentationCue === 'ordinary-living-block-near-traffic'
      ? LIVING_BLOCK_FOCUS_LATERAL_OFFSETS[actor.localSlot]
      : Number.NaN;
    let x;
    let z;
    let yaw;
    if (actor.orientation === 'east-west') {
      x = centerX + longitudinal;
      z = centerZ + actor.roadLine + (Number.isFinite(livingBlockLateral)
        ? livingBlockLateral
        : actor.direction * lane);
      yaw = actor.direction > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    } else {
      x = centerX + actor.roadLine + (Number.isFinite(livingBlockLateral)
        ? livingBlockLateral
        : -actor.direction * lane);
      z = centerZ + longitudinal;
      yaw = actor.direction > 0 ? 0 : Math.PI;
    }
    const ground = surfaceY(x, z);
    const visual = actor.appearance;
    const visualScale = actor.visualScale;
    const silhouette = visual.silhouette
      || VEHICLE_SILHOUETTE[visual.className]
      || VEHICLE_SILHOUETTE.sedan;
    const bodyY = ground + visual.height * silhouette.bodyHeight * 0.5 * visualScale;
    actor.position.set(x, bodyY, z);
    setMatrix(
      pools.meshes.vehicleBodies,
      actor.poolIndex,
      actor.position,
      yaw,
      visual.width * visualScale,
      visual.height * silhouette.bodyHeight * visualScale,
      visual.length * visualScale,
    );
    localOffset.set(
      0,
      visual.height * silhouette.cabinLift * visualScale,
      visual.length * silhouette.cabinShift * visualScale,
    ).applyAxisAngle(yAxis, yaw);
    workPosition.set(x, ground, z).add(localOffset);
    setMatrix(
      pools.meshes.vehicleCabins,
      actor.poolIndex,
      workPosition,
      yaw,
      visual.width * silhouette.cabinWidth * visualScale,
      visual.height * silhouette.cabinHeight * visualScale,
      visual.length * silhouette.cabinLength * visualScale,
    );
    const roofCue = visual.roofCueSize || VEHICLE_ROOF_CUE_SIZES.sedan;
    // Taxi roof sign sits high and short; bus route board is long and low;
    // van keeps a cargo rack; private cars use a small roof rail.
    const roofShiftZ = visual.className === 'taxi'
      ? visual.length * 0.08
      : visual.className === 'bus'
        ? visual.length * 0.18
        : visual.className === 'van'
          ? -visual.length * 0.06
          : 0;
    localOffset.set(
      0,
      visual.height * silhouette.roofLift * visualScale,
      roofShiftZ * visualScale,
    ).applyAxisAngle(yAxis, yaw);
    workPosition.set(x, ground, z).add(localOffset);
    setMatrix(
      pools.meshes.vehicleRoofDetails,
      actor.poolIndex,
      workPosition,
      yaw,
      roofCue.width * visualScale,
      roofCue.height * visualScale,
      roofCue.length * visualScale,
    );
    for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
      const sideSign = sideIndex ? 1 : -1;
      // Bus/van side stripe is taller and longer; private chrome is thinner.
      const trimHeight = visual.height * silhouette.trimHeight * visualScale
        * (visual.className === 'bus' ? 1.15 : visual.className === 'van' ? 1.08 : 1);
      const trimLength = visual.length * (
        visual.className === 'bus' ? 0.9
          : visual.className === 'van' ? 0.78
            : visual.className === 'taxi' ? 0.62
              : 0.5
      ) * visualScale;
      const trimThickness = (
        visual.className === 'bus' || visual.className === 'van' ? 0.09 : 0.055
      ) * visualScale;
      localOffset.set(
        sideSign * visual.width * 0.515 * visualScale,
        visual.height * (visual.className === 'bus' ? 0.48 : 0.36) * visualScale,
        0,
      ).applyAxisAngle(yAxis, yaw);
      workPosition.set(x, ground, z).add(localOffset);
      setMatrix(
        pools.meshes.vehicleSideTrims,
        actor.poolIndex * 2 + sideIndex,
        workPosition,
        yaw,
        trimThickness,
        trimHeight,
        trimLength,
      );
    }
    for (let axle = 0; axle < 2; axle += 1) {
      localOffset.set(
        0,
        visual.wheelRadius * visualScale,
        (axle ? 1 : -1) * visual.length * silhouette.wheelBase * visualScale,
      );
      localOffset.applyAxisAngle(yAxis, yaw);
      workPosition.set(x, ground, z).add(localOffset);
      setMatrix(
        pools.meshes.vehicleWheels,
        actor.poolIndex * 2 + axle,
        workPosition,
        yaw,
        visual.width * (visual.className === 'bus' ? 1.08 : 1.02) * visualScale,
        visual.wheelRadius * visualScale,
        visual.wheelRadius * visualScale,
      );
    }
    // axle-slot 0 = rear brake/indicator pair cue, 1 = front headlamp cue.
    const lampStates = [
      {
        z: -0.505,
        y: visual.className === 'bus' ? 0.52 : 0.4,
        width: visual.className === 'bus' ? 0.34 : 0.24,
        height: (actor.waiting || actor.dwelling || actor.signalIntent) ? 0.17 : 0.13,
        depth: 0.12,
        side: actor.indicatorSide || 0,
      },
      {
        z: 0.505,
        y: visual.className === 'bus' ? 0.48 : 0.4,
        width: visual.className === 'bus' ? 0.3 : 0.2,
        height: 0.13,
        depth: 0.11,
        side: 0,
      },
    ];
    for (let lampIndex = 0; lampIndex < 2; lampIndex += 1) {
      const lamp = lampStates[lampIndex];
      const widen = lampIndex === 0 && lamp.side !== 0 ? 1.45 : 1;
      localOffset.set(
        lamp.side * visual.width * 0.16 * visualScale,
        visual.height * lamp.y * visualScale,
        visual.length * lamp.z * visualScale,
      ).applyAxisAngle(yAxis, yaw);
      workPosition.set(x, ground, z).add(localOffset);
      setMatrix(
        pools.meshes.vehicleHeadlights,
        actor.poolIndex * 2 + lampIndex,
        workPosition,
        yaw,
        visual.width * lamp.width * widen * visualScale,
        lamp.height * visualScale,
        lamp.depth * visualScale,
      );
    }
  };

  const updateVehicleActor = (actor, step) => {
    refreshActorSchedule(actor);
    const className = actor.appearance?.className || 'sedan';
    const coordinates = parseSectorKey(actor.sectorKey);
    const centerX = coordinates.x * SECTOR_SIZE;
    const centerZ = coordinates.z * SECTOR_SIZE;
    const longitudinal = -SECTOR_SIZE * 0.5 + actor.progress;
    const nextGrid = actor.direction > 0
      ? Math.ceil((longitudinal + 0.001) / GRID_STEP) * GRID_STEP
      : Math.floor((longitudinal - 0.001) / GRID_STEP) * GRID_STEP;
    const distanceToSignal = actor.direction > 0
      ? nextGrid - longitudinal
      : longitudinal - nextGrid;
    const intersectionX = actor.orientation === 'east-west'
      ? centerX + nextGrid
      : centerX + actor.roadLine;
    const intersectionZ = actor.orientation === 'east-west'
      ? centerZ + actor.roadLine
      : centerZ + nextGrid;
    const group = actor.orientation === 'east-west' ? 0 : 1;
    const phase = signalPhaseAt(
      group,
      elapsedTime,
      signalOffsetForPosition(intersectionX, intersectionZ),
    );
    const stopWindow = className === 'bus' ? 8.4 : 7.2;
    const stopStart = className === 'bus' ? 5.4 : 4.8;
    const shouldStop = phase !== 'green'
      && distanceToSignal >= stopStart
      && distanceToSignal < stopWindow;

    // Class-specific curb dwell: buses at stops, taxis/vans at mid-block curb.
    if (actor.dwelling) {
      actor.waiting = true;
      actor.moving = false;
      actor.indicatorSide = actor.sidewalkSide;
      actor.signalIntent = 'dwell';
      if (elapsedTime >= actor.dwellUntil) {
        actor.dwelling = false;
        actor.dwellUntil = 0;
        actor.signalIntent = 'merge';
        actor.indicatorSide = -actor.sidewalkSide;
      }
      // Keep brake/indicator colors live while dwelling.
      const rear = new THREE.Color(
        actor.signalIntent === 'dwell' || actor.waiting
          ? actor.appearance.brakeColor
          : 0xff5663,
      );
      const blinkOn = Math.floor(elapsedTime * 3.2) % 2 === 0;
      const indicator = new THREE.Color(
        blinkOn ? actor.appearance.indicatorColor : actor.appearance.brakeColor,
      );
      pools.meshes.vehicleHeadlights.setColorAt(actor.poolIndex * 2, blinkOn ? indicator : rear);
      colorsDirty = true;
      keepLivingBlockVehicleInCameraBand(actor);
      placeVehicle(actor);
      return;
    }

    // Start dwells away from the signal box so heavy vehicles do not block it.
    const midBlock = Math.abs(longitudinal - nextGrid) > 18;
    if (!shouldStop && midBlock && !actor.waiting) {
      const cycle = className === 'bus'
        ? 18 + seededUnit(actor.sectorSeed, 70) * 10
        : className === 'taxi'
          ? 14 + seededUnit(actor.sectorSeed, 70) * 12
          : className === 'van'
            ? 20 + seededUnit(actor.sectorSeed, 70) * 14
            : 0;
      if (cycle > 0) {
        const window = className === 'bus' ? 1.6 : 1.1;
        const pos = (dayHourAt(elapsedTime) * 17 + actor.localSlot * 3.1) % cycle;
        const chance = className === 'bus' ? 0.72 : className === 'taxi' ? 0.48 : 0.38;
        if (pos >= 0.4 && pos < 0.4 + window
          && seededUnit(actor.sectorSeed, 71 + actor.localSlot) < chance) {
          actor.dwelling = true;
          actor.dwellUntil = elapsedTime
            + (className === 'bus'
              ? 2.8 + seededUnit(actor.sectorSeed, 72) * 2.2
              : className === 'taxi'
                ? 2.2 + seededUnit(actor.sectorSeed, 72) * 2.4
                : 2.6 + seededUnit(actor.sectorSeed, 72) * 2.8);
          actor.signalIntent = 'dwell';
          actor.indicatorSide = actor.sidewalkSide;
        }
      }
    }

    // Turn-indicator window approaching intersections (yellow phase or red).
    if (!actor.dwelling && distanceToSignal < 16 && distanceToSignal > 2.5) {
      if (phase === 'yellow' || phase === 'red') {
        actor.signalIntent = 'stop';
        actor.indicatorSide = actor.sidewalkSide !== 0
          ? actor.sidewalkSide
          : (seededUnit(actor.sectorSeed, 73) > 0.5 ? 1 : -1);
      } else if (phase === 'green' && distanceToSignal < 9) {
        // Occasional protected turn read on green approach.
        actor.signalIntent = seededUnit(actor.sectorSeed, 74 + actor.localSlot) > 0.72
          ? 'turn'
          : null;
        actor.indicatorSide = actor.signalIntent
          ? (seededUnit(actor.sectorSeed, 75) > 0.5 ? 1 : -1)
          : 0;
      } else {
        actor.signalIntent = null;
        actor.indicatorSide = 0;
      }
    } else if (!actor.dwelling) {
      actor.signalIntent = null;
      actor.indicatorSide = 0;
    }

    actor.waiting = shouldStop;
    actor.moving = !shouldStop;
    if (!shouldStop) {
      actor.progress = modulo(
        actor.progress
          + actor.direction * actor.speed * vehicleWeatherFactor() * scheduleBeat.vehiclePace * actor.pace * step,
        SECTOR_SIZE,
      );
    }

    // Lamp color: brakes when stopped/dwelling; amber blink for turn intent.
    const blinkOn = Math.floor(elapsedTime * 3.4) % 2 === 0;
    let rearColor = actor.appearance.brakeColor;
    if (actor.waiting || actor.dwelling) {
      rearColor = actor.appearance.brakeColor;
    } else if (actor.signalIntent === 'turn' || actor.signalIntent === 'stop') {
      rearColor = blinkOn ? actor.appearance.indicatorColor : 0x5a2a00;
    } else {
      rearColor = 0xc94a52;
    }
    pools.meshes.vehicleHeadlights.setColorAt(
      actor.poolIndex * 2,
      new THREE.Color(rearColor),
    );
    colorsDirty = true;
    keepLivingBlockVehicleInCameraBand(actor);
    placeVehicle(actor);
  };

  const placePedestrian = (actor) => {
    const coordinates = parseSectorKey(actor.sectorKey);
    const centerX = coordinates.x * SECTOR_SIZE;
    const centerZ = coordinates.z * SECTOR_SIZE;
    const longitudinal = -SECTOR_SIZE * 0.5 + actor.progress;
    const crossingLine = actor.crossing ? actor.crossingLine : Math.round(longitudinal / GRID_STEP) * GRID_STEP;
    const lateral = actor.crossing
      ? THREE.MathUtils.lerp(
        actor.sidewalkSide * actor.sidewalkOffset,
        -actor.sidewalkSide * actor.sidewalkOffset,
        actor.crossingProgress,
      )
      : actor.sidewalkSide * actor.sidewalkOffset;
    let x;
    let z;
    let yaw;
    if (actor.orientation === 'east-west') {
      x = centerX + (actor.crossing ? crossingLine : longitudinal);
      z = centerZ + actor.roadLine + lateral;
      yaw = actor.crossing
        ? (lateral >= 0 ? 0 : Math.PI)
        : (actor.direction > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
    } else {
      x = centerX + actor.roadLine + lateral;
      z = centerZ + (actor.crossing ? crossingLine : longitudinal);
      yaw = actor.crossing
        ? (lateral >= 0 ? Math.PI * 0.5 : -Math.PI * 0.5)
        : (actor.direction > 0 ? 0 : Math.PI);
    }
    const ground = surfaceY(x, z);
    const height = actor.appearance.heightScale;
    const hurry = actor.crossing ? 1.12 : 1;
    const dwell = actor.dwelling || actor.waiting;
    const phase = elapsedTime * actor.gaitRate * hurry + actor.localSlot * 1.7 + actor.gaitPhase;
    const sinPhase = Math.sin(phase);
    const gaitAmp = actor.moving && !dwell ? actor.gaitScale * hurry : 0;
    // Rotational limb swing (not Z-offset sticks). Opposite legs / arms.
    // Clamp so hot QA/cross hurry never folds capsules into a ground V-sit.
    const rawLeg = (actor.crossing ? 0.62 : 0.74) * gaitAmp;
    const legPitchL = THREE.MathUtils.clamp(sinPhase * rawLeg, -0.78, 0.78);
    const legPitchR = THREE.MathUtils.clamp(-sinPhase * rawLeg, -0.78, 0.78);
    const armPitchL = THREE.MathUtils.clamp(-sinPhase * 0.55 * gaitAmp, -0.7, 0.7);
    const armPitchR = THREE.MathUtils.clamp(sinPhase * 0.55 * gaitAmp, -0.7, 0.7);
    const bob = actor.moving && !dwell
      ? -Math.abs(Math.cos(phase)) * 0.034 * height * gaitAmp
      : Math.sin(elapsedTime * 1.5 + actor.gaitPhase) * 0.006 * height;
    const idleSway = dwell ? Math.sin(elapsedTime * 0.85 + actor.gaitPhase) * 0.04 : 0;
    const torsoLean = (actor.crossing ? 0.08 : 0)
      + (actor.activity === 'working' || actor.activity === 'service' ? 0.04 : 0)
      + (actor.activity === 'resting' || actor.activity === 'lunch' ? -0.02 : 0);
    const gazeSeed = Number.isFinite(actor.gazePhase) ? actor.gazePhase : actor.gaitPhase;
    const headLook = dwell
      ? Math.sin(elapsedTime * 0.55 + gazeSeed) * 0.22
      : sinPhase * 0.06 * gaitAmp;
    // CapsuleGeometry(r, length) half-height = length/2 + r; keep in sync with
    // limbGeometry / uniform sy scale so hip pins don't open a waist hollow.
    const legHalfExtent = (0.28 + 0.072) * height * actor.limbScale;
    const armHalfExtent = (0.28 + 0.072) * height * 0.78 * actor.limbScale;
    // Bulbous capsule sides sit above the geometric tip — pin hips into the
    // lower third so side/rear views don't show a waist hollow.
    const torsoBottomY = 0.56 * height;
    const shoulderY = 1.42 * height;
    const bodyWidth = height * actor.bodyWidthScale;
    const bodyDepth = height * actor.bodyDepthScale;
    if (actor.storyPartnerSlot >= 0 && actor.focusTableau && actor.dwelling) {
      const partner = pedestrianSlots[actor.storyPartnerSlot];
      if (partner?.active) {
        const partnerDeltaX = partner.position.x - x;
        const partnerDeltaZ = partner.position.z - z;
        if (Math.hypot(partnerDeltaX, partnerDeltaZ) > 0.05) {
          yaw = Math.atan2(partnerDeltaX, partnerDeltaZ);
        }
      }
    }
    actor.position.set(x, ground + 1.05 * height + bob, z);
    setMatrix(
      pools.meshes.pedestrianTorsos,
      actor.poolIndex,
      actor.position,
      yaw + idleSway * 0.35,
      bodyWidth,
      height,
      bodyDepth,
      torsoLean,
    );
    for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
      const sign = sideIndex ? 1 : -1;
      // Tuck deltoids into the capsule — large side pads read as floating cubes.
      localOffset.set(
        sign * bodyWidth * 0.22,
        1.42 * height + bob,
        bodyDepth * 0.01,
      ).applyAxisAngle(yAxis, yaw);
      workPosition.set(x, ground, z).add(localOffset);
      setMatrix(
        pools.meshes.pedestrianShoulders,
        actor.poolIndex * 2 + sideIndex,
        workPosition,
        yaw,
        bodyWidth * 0.2,
        height * 0.12,
        bodyDepth * 0.28,
        sideIndex ? armPitchR * 0.44 : armPitchL * 0.44,
      );
    }
    localOffset.set(
      Math.sin(headLook) * 0.04 * height,
      1.72 * height + bob,
      Math.cos(headLook) * 0.02 * height,
    ).applyAxisAngle(yAxis, yaw);
    workPosition.set(x, ground, z).add(localOffset);
    setMatrix(
      pools.meshes.pedestrianHeads,
      actor.poolIndex,
      workPosition,
      yaw + headLook,
      bodyWidth * 0.96,
      height,
      bodyDepth * 0.96,
    );
    localOffset.set(0, 1.84 * height + bob, 0).applyAxisAngle(yAxis, yaw);
    workPosition.set(x, ground, z).add(localOffset);
    setMatrix(
      pools.meshes.pedestrianHair,
      actor.poolIndex,
      workPosition,
      yaw + headLook,
      bodyWidth * 1.02,
      height * 0.52,
      bodyDepth * 1.02,
    );
    const roleCueKind = actor.appearance.roleCueKind || DEFAULT_PEDESTRIAN_ROLE_ACCENT.kind;
    if (roleCueKind === 'backpack') {
      cueScale.set(bodyWidth * 0.48, height * 0.42, bodyDepth * 0.22);
      cueOffset.set(0, 1.08 * height, -bodyDepth * 0.22);
    } else if (roleCueKind === 'tote') {
      cueScale.set(bodyWidth * 0.18, height * 0.3, bodyDepth * 0.16);
      cueOffset.set(bodyWidth * 0.31, 0.78 * height, bodyDepth * 0.1);
    } else if (roleCueKind === 'badge') {
      // Commuter lanyard / tourist map fold — worn at the chest, not a UI marker.
      cueScale.set(bodyWidth * 0.16, height * 0.22, bodyDepth * 0.08);
      cueOffset.set(bodyWidth * 0.18, 1.08 * height, bodyDepth * 0.2);
    } else if (roleCueKind === 'hi-vis') {
      // Vest should read as torso trim, not a floating tray around the hips.
      cueScale.set(bodyWidth * 0.72, height * 0.34, bodyDepth * 0.52);
      cueOffset.set(0, 1.18 * height, 0);
    } else if (roleCueKind === 'beach-gear') {
      cueScale.set(bodyWidth * 0.18, height * 0.8, bodyDepth * 0.12);
      cueOffset.set(-bodyWidth * 0.42, 1.0 * height, -bodyDepth * 0.16);
    } else {
      // No default waist/chest band — it read as a floating UI tray from rear cams.
      cueScale.set(0.001, 0.001, 0.001);
      cueOffset.set(0, 1.2 * height, 0);
    }
    // Role cues are part of the silhouette language, not floating UI.
    if (actor.focusTableau) cueScale.multiplyScalar(1.1);
    cueOffset.y += bob;
    cueOffset.applyAxisAngle(yAxis, yaw);
    workPosition.set(x, ground, z).add(cueOffset);
    setMatrix(
      pools.meshes.pedestrianRoleCues,
      actor.poolIndex,
      workPosition,
      yaw,
      cueScale.x,
      cueScale.y,
      cueScale.z,
    );
    for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
      const sign = sideIndex ? 1 : -1;
      const legPitch = sideIndex ? legPitchR : legPitchL;
      const armPitch = sideIndex ? armPitchR : armPitchL;
      // Keep capsule TOP pinned at the hip while the limb pitches — placing the
      // instance at the geometric center with only a Z sine left a hollow gap.
      // Hinge at hip: center = hip + Rx(pitch)*(0,-half,0) so the capsule TOP
      // stays on the waist (Z must be -sin, not +sin, or the crown walks off).
      const legHalf = legHalfExtent * 0.96;
      localOffset.set(
        sign * 0.12 * actor.bodyWidthScale,
        torsoBottomY + bob - Math.cos(legPitch) * legHalf,
        -Math.sin(legPitch) * legHalf,
      ).applyAxisAngle(yAxis, yaw);
      workPosition.set(x, ground, z).add(localOffset);
      setMatrix(
        pools.meshes.pedestrianLegs,
        actor.poolIndex * 2 + sideIndex,
        workPosition,
        yaw,
        height * actor.limbScale,
        height * actor.limbScale,
        height * actor.limbScale,
        legPitch,
      );
      const armHalf = armHalfExtent * 0.96;
      localOffset.set(
        sign * 0.26 * actor.bodyWidthScale,
        shoulderY + bob - Math.cos(armPitch) * armHalf,
        -Math.sin(armPitch) * armHalf * 0.9,
      ).applyAxisAngle(yAxis, yaw);
      workPosition.set(x, ground, z).add(localOffset);
      setMatrix(
        pools.meshes.pedestrianArms,
        actor.poolIndex * 2 + sideIndex,
        workPosition,
        yaw,
        height * 0.78 * actor.limbScale,
        height * 0.78 * actor.limbScale,
        height * 0.78 * actor.limbScale,
        armPitch,
      );
    }
  };

  let qaForceWalkId = null;

  const setQaForceWalk = (actorId = null) => {
    qaForceWalkId = typeof actorId === 'string' && actorId ? actorId : null;
    if (!qaForceWalkId) return;
    for (const actor of pedestrianSlots) {
      if (!actor.active || actor.id !== qaForceWalkId) continue;
      actor.dwelling = false;
      actor.waiting = false;
      actor.dwellUntil = 0;
      actor.crossing = false;
      actor.moving = true;
      actor.pace = Math.max(actor.pace || 1, 1.18);
      actor.gaitScale = Math.max(actor.gaitScale || 1, 1.22);
      actor.gaitRate = Math.max(actor.gaitRate || 7.4, 9.0);
      actor.sidewalkOffset = Math.min(actor.sidewalkOffset || SIDEWALK_OFFSET, 6.4);
    }
  };

  const updatePedestrianActor = (actor, step) => {
    if (qaForceWalkId && actor.id === qaForceWalkId) {
      actor.dwelling = false;
      actor.waiting = false;
      actor.dwellUntil = 0;
      actor.crossing = false;
      actor.crossingProgress = 0;
      actor.moving = true;
    }
    refreshActorSchedule(actor);
    tickStreamedPedestrianBehavior(actor, step);
    if (qaForceWalkId && actor.id === qaForceWalkId) {
      actor.dwelling = false;
      actor.waiting = false;
      actor.dwellUntil = 0;
      actor.crossing = false;
      actor.crossingProgress = 0;
      actor.moving = true;
      // Pull curb-ward so QA subjects clear facade planters.
      actor.sidewalkOffset = Math.min(actor.sidewalkOffset || SIDEWALK_OFFSET, 6.4);
      actor.pace = Math.max(actor.pace || 1, 1.18);
      actor.gaitScale = Math.max(actor.gaitScale || 1, 1.22);
      actor.gaitRate = Math.max(actor.gaitRate || 7.4, 9.0);
    }
    const coordinates = parseSectorKey(actor.sectorKey);
    const centerX = coordinates.x * SECTOR_SIZE;
    const centerZ = coordinates.z * SECTOR_SIZE;
    const longitudinal = -SECTOR_SIZE * 0.5 + actor.progress;
    const nearestGrid = Math.round(longitudinal / GRID_STEP) * GRID_STEP;
    const intersectionX = actor.orientation === 'east-west'
      ? centerX + nearestGrid
      : centerX + actor.roadLine;
    const intersectionZ = actor.orientation === 'east-west'
      ? centerZ + actor.roadLine
      : centerZ + nearestGrid;
    const roadGroup = actor.orientation === 'east-west' ? 0 : 1;
    const phase = signalPhaseAt(
      roadGroup,
      elapsedTime,
      signalOffsetForPosition(intersectionX, intersectionZ),
    );
    // Keep only a sparse subset near crosswalks. Earlier slots 0-5 all waited
    // at the same intersection, so a focus frame could show most of a sector
    // frozen on red. A modest modulo subset preserves signal behavior while
    // leaving the street visibly alive.
    const atCrosswalk = actor.localSlot % 5 === 0
      && Math.abs(longitudinal - nearestGrid) < 1.3;
    if (actor.dwelling) {
      actor.moving = true;
      actor.waiting = false;
      if (elapsedTime >= actor.dwellUntil) {
        actor.dwelling = false;
        actor.progress = modulo(
          actor.progress
            + actor.direction * actor.speed * pedestrianWeatherFactor() * scheduleBeat.pedestrianPace * actor.pace * step,
          SECTOR_SIZE,
        );
      }
      placePedestrian(actor);
      return;
    }
    if (!actor.crossing
      && !actor.waiting
      && !actor.dwelling
      && !(qaForceWalkId && actor.id === qaForceWalkId)
      && DWELL_ACTIVITIES.has(actor.activity)) {
      const cycle = 14 + seededUnit(actor.sectorSeed, 60) * 18;
      const phaseWindow = 0.75 + seededUnit(actor.sectorSeed, 61) * 0.6;
      const cyclePosition = dayHourAt(elapsedTime) % cycle;
      if (cyclePosition >= 0.6 && cyclePosition < 0.6 + phaseWindow
        && seededUnit(actor.sectorSeed, 62) < 0.55) {
        actor.dwelling = true;
        actor.dwellUntil = elapsedTime + 1.1 + seededUnit(actor.sectorSeed, 63) * 1.4;
      }
    }
    if (actor.crossing) {
      actor.crossingProgress = Math.min(
        1,
        actor.crossingProgress
          + actor.speed * pedestrianWeatherFactor() * scheduleBeat.pedestrianPace * actor.pace * step
          / (SIDEWALK_OFFSET * 2),
      );
      actor.moving = true;
      actor.waiting = false;
      if (actor.crossingProgress >= 1) {
        actor.crossing = false;
        actor.crossingProgress = 0;
        actor.sidewalkSide *= -1;
      }
    } else if (atCrosswalk && !(qaForceWalkId && actor.id === qaForceWalkId)) {
      actor.waiting = phase !== 'red';
      actor.moving = !actor.waiting;
      if (!actor.waiting) {
        actor.crossing = true;
        actor.crossingLine = nearestGrid;
        actor.crossingProgress = 0.001;
      }
    } else if (atCrosswalk && qaForceWalkId && actor.id === qaForceWalkId) {
      // Keep strolling through the intersection for animation QA.
      actor.waiting = false;
      actor.moving = true;
      actor.progress = modulo(
        actor.progress
          + actor.direction * actor.speed * pedestrianWeatherFactor() * scheduleBeat.pedestrianPace * actor.pace * step,
        SECTOR_SIZE,
      );
    } else {
      actor.waiting = false;
      actor.moving = true;
      actor.progress = modulo(
        actor.progress
          + actor.direction * actor.speed * pedestrianWeatherFactor() * scheduleBeat.pedestrianPace * actor.pace * step,
        SECTOR_SIZE,
      );
    }
    placePedestrian(actor);
  };

  const flagMatrices = () => {
    if (!matricesDirty && !colorsDirty) return;
    Object.values(pools.meshes).forEach((mesh) => {
      if (matricesDirty) mesh.instanceMatrix.needsUpdate = true;
      if (colorsDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    matricesDirty = false;
    colorsDirty = false;
  };

  const update = (position, dt = 0, elapsed = undefined) => {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return;
    updateCount += 1;
    if (Number.isFinite(lastFocusPosition.x)) travel.copy(position).sub(lastFocusPosition);
    else travel.set(0, 0, 0);
    lastFocusPosition.copy(position);
    elapsedTime = Number.isFinite(elapsed)
      ? Math.max(elapsedTime, elapsed)
      : elapsedTime + Math.max(0, dt);
    scheduleBeat = beatForElapsed(elapsedTime);
    reconcileSectors(position);
    if (focusSectorKey === CORE_KEY || activeSectorKeys.length === 0) {
      updatesSuppressedInCore += focusSectorKey === CORE_KEY ? 1 : 0;
      flagMatrices();
      return;
    }
    vehicleAccumulator = Math.min(0.25, vehicleAccumulator + Math.max(0, dt));
    pedestrianAccumulator = Math.min(0.25, pedestrianAccumulator + Math.max(0, dt));
    while (vehicleAccumulator >= VEHICLE_STEP) {
      vehicleSlots.forEach((actor) => {
        if (actor.active) {
          updateVehicleActor(actor, VEHICLE_STEP);
          actorEvaluationCount += 1;
        }
      });
      vehicleAccumulator -= VEHICLE_STEP;
      vehicleStepCount += 1;
    }
    while (pedestrianAccumulator >= PEDESTRIAN_STEP) {
      pedestrianSlots.forEach((actor) => {
        if (actor.active) {
          updatePedestrianActor(actor, PEDESTRIAN_STEP);
          actorEvaluationCount += 1;
        }
      });
      pedestrianAccumulator -= PEDESTRIAN_STEP;
      pedestrianStepCount += 1;
    }
    flagMatrices();
  };

  const setWeather = (mode) => {
    weather = VALID_WEATHER.has(mode) ? mode : 'clear';
    pools.bodyMaterial.roughness = weather === 'drizzle' ? 0.54 : weather === 'fog' ? 0.74 : 0.68;
    pools.glassMaterial.opacity = weather === 'fog' ? 0.82 : 1;
    pools.headlightMaterial.emissiveIntensity = weather === 'clear' ? 0.78 : weather === 'fog' ? 2.8 : 3.4;
    // Keep the low-energy lamp/tail contrast visible in clear weather too;
    // fog and drizzle still raise emissive intensity for distance readability.
    pools.meshes.vehicleHeadlights.visible = true;
  };

  const actorSnapshot = (actor) => ({
    id: actor.id,
    kind: actor.kind,
    sectorKey: actor.sectorKey,
    poolIndex: actor.poolIndex,
    tier: actor.tier,
    role: actor.role,
    presentationCue: actor.presentationCue || null,
    destination: actor.destination,
    activity: actor.activity,
    pace: Math.round(actor.pace * 1000) / 1000,
    sourceRevision: actor.sourceRevision,
    sourceClock: actor.sourceClock,
    state: actor.crossing
      ? 'crossing'
      : actor.dwelling
        ? 'dwelling'
        : actor.waiting
          ? 'waiting'
          : 'moving',
    position: {
      x: Math.round(actor.position.x * 1000) / 1000,
      y: Math.round(actor.position.y * 1000) / 1000,
      z: Math.round(actor.position.z * 1000) / 1000,
    },
    progress: Math.round(actor.progress * 1000) / 1000,
    gaitPhase: Math.round(actor.gaitPhase * 1000) / 1000,
    gaitScale: Math.round((actor.gaitScale || 1) * 1000) / 1000,
    // Synthetic limb drives for QA — instanced capsules have no bone tree.
    legSwing: actor.moving
      ? Math.round(Math.sin(
        elapsedTime * (actor.gaitRate || 8) * (actor.crossing ? 1.12 : 1)
          + actor.localSlot * 1.7
          + actor.gaitPhase,
      ) * (actor.gaitScale || 1) * 1000) / 1000
      : 0,
    axis: actor.axis,
    direction: actor.direction,
    yaw: actor.axis === 'x'
      ? (actor.direction > 0 ? Math.PI * 0.5 : -Math.PI * 0.5)
      : (actor.direction > 0 ? 0 : Math.PI),
    appearance: { ...actor.appearance },
  });

  const getStats = () => {
    const activeVehicles = vehicleSlots.filter((actor) => actor.active);
    const activePedestrians = pedestrianSlots.filter((actor) => actor.active);
    const allIds = [...activeVehicles, ...activePedestrians].map((actor) => actor.id);
    const duplicateIds = allIds.length - new Set(allIds).size;
    const pedestrianRoles = activePedestrians.reduce((counts, actor) => {
      counts[actor.role] = (counts[actor.role] || 0) + 1;
      return counts;
    }, {});
    const pedestrianActivities = activePedestrians.reduce((counts, actor) => {
      counts[actor.activity] = (counts[actor.activity] || 0) + 1;
      return counts;
    }, {});
    const vehicleActivities = activeVehicles.reduce((counts, actor) => {
      counts[actor.activity] = (counts[actor.activity] || 0) + 1;
      return counts;
    }, {});
    const vehicleFleetRoles = activeVehicles.reduce((counts, actor) => {
      counts[actor.appearance.fleetRole] = (counts[actor.appearance.fleetRole] || 0) + 1;
      return counts;
    }, {});
    const sectorActivityCounts = [...activeVehicles, ...activePedestrians].reduce((counts, actor) => {
      const entry = counts.get(actor.sectorKey) || {};
      entry[`${actor.kind}:${actor.activity}`] = (entry[`${actor.kind}:${actor.activity}`] || 0) + 1;
      counts.set(actor.sectorKey, entry);
      return counts;
    }, new Map());
    const districts = [...new Set(activeSectorKeys.map(districtForSector))].sort();
    const leaseTotals = [...leasedBySector.values()].reduce(
      (totals, lease) => {
        totals.vehicles += lease.visibleVehicleRepresentatives;
        totals.pedestrians += lease.visiblePedestrianRepresentatives;
        totals.aggregateVehicles += lease.aggregateVehicles;
        totals.aggregatePedestrians += lease.aggregatePedestrians;
        return totals;
      },
      { vehicles: 0, pedestrians: 0, aggregateVehicles: 0, aggregatePedestrians: 0 },
    );
    const conservationError = Math.abs(activeVehicles.length - leaseTotals.vehicles)
      + Math.abs(activePedestrians.length - leaseTotals.pedestrians);
    const capErrors = Number(activeSectorKeys.length > configuredMaxActiveSectors)
      + Number(activeSectorKeys.length > MILESTONE_ACTIVE_SECTORS)
      + Number(activeVehicles.length > VEHICLE_CAPACITY)
      + Number(activePedestrians.length > PEDESTRIAN_CAPACITY)
      + Number(pools.drawCallEstimate > 24);
    return {
      mode: 'milestone-1-read-only-representative-leases',
      limitation: 'Aggregate core counts stay read-only; living schedules are derived per representative inside this file, while atomic cross-sector population handoff remains owned by streaming core.',
      focusSectorKey,
      predictedSectorKey,
      activeSectorKeys: [...activeSectorKeys],
      activeSectors: activeSectorKeys.length,
      edgeSectorKeys: [...edgeSectorKeys],
      edgeSectors: edgeSectorKeys.length,
      schedule: {
        dayHour: Math.round(dayHourAt(elapsedTime) * 10) / 10,
        beat: scheduleBeat.id,
        beatLabel: scheduleBeat.label,
        activities: pedestrianActivities,
        vehicleActivities,
      },
      districts,
      maxActiveSectors: MAX_ACTIVE_SECTORS,
      configuredMaxActiveSectors,
      milestoneActiveLimit: MILESTONE_ACTIVE_SECTORS,
      coreSuppressed: focusSectorKey === CORE_KEY,
      updatesSuppressedInCore,
      vehicles: {
        visible: activeVehicles.length,
        moving: activeVehicles.filter((actor) => actor.moving).length,
        waiting: activeVehicles.filter((actor) => actor.waiting).length,
        dwelling: activeVehicles.filter((actor) => actor.dwelling).length,
        classes: activeVehicles.reduce((counts, actor) => {
          const key = actor.appearance?.className || 'unknown';
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}),
        crossing: 0,
        fleetRoles: vehicleFleetRoles,
        activities: vehicleActivities,
        capacity: VEHICLE_CAPACITY,
        pool: {
          created: VEHICLE_CAPACITY,
          reused: reusedVehicles,
          parked: VEHICLE_CAPACITY - activeVehicles.length,
        },
      },
      pedestrians: {
        visible: activePedestrians.length,
        moving: activePedestrians.filter((actor) => actor.moving).length,
        waiting: activePedestrians.filter((actor) => actor.waiting).length,
        crossing: activePedestrians.filter((actor) => actor.crossing).length,
        dwelling: activePedestrians.filter((actor) => actor.dwelling).length,
        roles: pedestrianRoles,
        activities: pedestrianActivities,
        capacity: PEDESTRIAN_CAPACITY,
        pool: {
          created: PEDESTRIAN_CAPACITY,
          reused: reusedPedestrians,
          parked: PEDESTRIAN_CAPACITY - activePedestrians.length,
        },
      },
      leases: {
        mode: 'read-only-representative',
        sectors: Object.fromEntries(
          [...leasedBySector.entries()].map(([key, lease]) => [key, {
            ...lease,
            schedule: {
              dayHour: Math.round(dayHourAt(elapsedTime) * 10) / 10,
              beat: scheduleBeat.id,
              representativeActivities: sectorActivityCounts.get(key) || {},
            },
          }]),
        ),
        aggregateVehicles: leaseTotals.aggregateVehicles,
        aggregatePedestrians: leaseTotals.aggregatePedestrians,
        visibleVehicleRepresentatives: leaseTotals.vehicles,
        visiblePedestrianRepresentatives: leaseTotals.pedestrians,
        aggregateMutation: false,
      },
      duplicateIds,
      conservationError,
      capErrors,
      incrementalDrawCallEstimate: activeSectorKeys.length ? pools.drawCallEstimate : 0,
      incrementalTriangles: activeSectorKeys.length ? pools.triangleCapacity : 0,
      weather,
      fixedStepsHz: { vehicles: 20, pedestrians: 15 },
      activationRevision,
      continuity: {
        tierStableIds: true,
        representativeIdPrefix: 'sf-agent',
        tierTransitions,
        reconciles: reconcileCount,
        retainedInstanceOwnership: true,
      },
      perf: {
        updates: updateCount,
        vehicleFixedSteps: vehicleStepCount,
        pedestrianFixedSteps: pedestrianStepCount,
        actorEvaluations: actorEvaluationCount,
        statesQueried,
        configuredRepresentatives,
        budget: {
          sectors: configuredMaxActiveSectors,
          vehicles: VEHICLE_CAPACITY,
          pedestrians: PEDESTRIAN_CAPACITY,
          perStepActorEvaluations: VEHICLE_CAPACITY + PEDESTRIAN_CAPACITY,
        },
      },
    };
  };

  const getEvidenceState = (origin = null, radius = 120) => {
    const radiusSquared = radius * radius;
    const actors = [...vehicleSlots, ...pedestrianSlots]
      .filter((actor) => actor.active)
      .filter((actor) => !origin || (
        (actor.position.x - origin.x) ** 2
        + (actor.position.y - origin.y) ** 2
        + (actor.position.z - origin.z) ** 2 <= radiusSquared
      ))
      .map(actorSnapshot);
    return {
      capturedAtElapsed: elapsedTime,
      radius,
      origin: origin ? { x: origin.x, y: origin.y, z: origin.z } : null,
      visibleWithinRadius: {
        vehicles: actors.filter((actor) => actor.kind === 'vehicle').length,
        pedestrians: actors.filter((actor) => actor.kind === 'pedestrian').length,
      },
      actors,
      stats: getStats(),
    };
  };

  const getFeaturedResidentSnapshots = () => {
    const focusPedestrians = pedestrianSlots
      .filter((actor) => actor.active && actor.tier === 'detail' && actor.focusTableau)
      .sort((a, b) => a.localSlot - b.localSlot);
    return focusPedestrians.map((actor) => {
      const story = FOCUS_TABLEAU_MICRO_STORIES[actor.localSlot];
      const partner = actor.storyPartnerSlot >= 0
        ? pedestrianSlots[actor.storyPartnerSlot]
        : null;
      const partnerLabel = partner?.storyLabel || partner?.appearance?.role || null;
      const destination = story?.destination || actor.destination || 'sidewalk stop';
      const action = actor.storyBeat
        || (actor.dwelling ? `paused at ${destination}` : `heading toward ${destination}`);
      return {
        id: `stream-${actor.sectorKey}-${actor.localSlot}`,
        label: actor.storyLabel || story?.label || `Walker ${actor.localSlot + 1}`,
        role: actor.role,
        activity: actor.dwelling ? 'paused' : actor.crossing ? 'crossing' : 'walking',
        action,
        mood: actor.storyMood || story?.mood || (actor.dwelling ? 'paused' : 'on the move'),
        choice: actor.storyChoice || story?.choice || 'continue along the route',
        destination,
        need: partnerLabel
          ? (actor.storyPartnerSlot < actor.localSlot
            ? `a brief exchange with ${partnerLabel}`
            : `to finish with ${partnerLabel}`)
          : `to reach ${destination}`,
        intent: actor.storyChoice || story?.choice || `continue toward ${destination}`,
        visible: actor.active && actor.sectorKey === focusSectorKey,
        relationship: partner?.active && partnerLabel
          ? {
            kind: (actor.localSlot === 2 || actor.localSlot === 3
              || actor.storyPartnerSlot === 2 || actor.storyPartnerSlot === 3)
              ? 'handoff'
              : 'conversation',
            actorId: `stream-${partner.sectorKey}-${partner.localSlot}`,
            actorLabel: partnerLabel,
            role: partner.role,
            side: actor.localSlot === 2 || actor.storyPartnerSlot === 3 ? 'courier' : 'listener',
          }
          : null,
        sceneCue: (actor.localSlot === 2 || actor.localSlot === 3)
          ? 'delivery handoff'
          : (actor.localSlot === 8 || actor.localSlot === 9)
            ? 'conversation'
            : (actor.dwelling ? 'work stop' : 'street walk'),
      };
    });
  };

  setWeather('clear');
  flagMatrices();

  return {
    group: pools.root,
    update,
    setWeather,
    setQaForceWalk,
    getStats,
    getEvidenceState,
    getFeaturedResidentSnapshots,
    get stats() {
      return getStats();
    },
  };
}
