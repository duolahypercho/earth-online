import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { signalOffsetForPosition, signalPhaseAt } from './signals.js';
import { getStreamedVehicleVisualProfile } from './traffic.js';
import { getStreamedPedestrianVisualProfile } from './pedestrians.js';

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
const SIDEWALK_ROAM_OFFSETS = Object.freeze([7.35, 8.55, 9.55]);
const VEHICLE_SPACING_JITTER = 10;
const PEDESTRIAN_SPACING_JITTER = 6.5;
// The active sector gets a compact, deterministic street-level tableau. It is
// deliberately smaller than the representative lease so the rest of the
// pool can continue to read as background traffic/crowd while these actors
// remain legible from the 1280x720 QA framing.
const FOCUS_TABLEAU_VEHICLES = 6;
const FOCUS_TABLEAU_PEDESTRIANS = 10;
const FOCUS_VEHICLE_SPACING = 24;
const FOCUS_PEDESTRIAN_SPACING = 9;
const FOCUS_RESTAGE_DISTANCE = 40;
const VALID_WEATHER = new Set(['clear', 'fog', 'drizzle']);

const PEDESTRIAN_ROLE_CUES = Object.freeze({
  runner: Object.freeze({ width: 0.94, depth: 0.96, limb: 1.08, gait: 1.2 }),
  tourist: Object.freeze({ width: 1.06, depth: 1.02, limb: 0.94, gait: 0.78 }),
  delivery: Object.freeze({ width: 1.04, depth: 1.06, limb: 1.02, gait: 1.08 }),
  services: Object.freeze({ width: 1.06, depth: 1.04, limb: 1, gait: 0.94 }),
  student: Object.freeze({ width: 0.98, depth: 0.98, limb: 1.04, gait: 1.05 }),
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
const VEHICLE_ACCENT_COLORS = Object.freeze({
  sedan: 0xc7d5da,
  suv: 0x9db8c0,
  taxi: 0xffd04b,
  van: 0xe29a4b,
});
const VEHICLE_ROOF_CUE_COLORS = Object.freeze({
  sedan: 0x879ba3,
  suv: 0x78949f,
  taxi: 0xffd04b,
  van: 0xd95b3d,
});
const VEHICLE_ROOF_CUE_SIZES = Object.freeze({
  sedan: Object.freeze({ width: 0.22, height: 0.1, length: 0.42 }),
  suv: Object.freeze({ width: 0.28, height: 0.1, length: 0.46 }),
  taxi: Object.freeze({ width: 0.34, height: 0.14, length: 0.56 }),
  van: Object.freeze({ width: 0.46, height: 0.13, length: 0.5 }),
});
const FOCUS_VEHICLE_BODY_COLORS = Object.freeze({
  sedan: Object.freeze([0xd6d7cd, 0x6f8f98, 0xb29d82, 0x8c6c76, 0x78947f]),
  suv: Object.freeze([0xc2c9c0, 0x6e8e96, 0x7c916f, 0x9b886e, 0x6f7ea0]),
  taxi: Object.freeze([0xffc324]),
  van: Object.freeze([0xe2a15d, 0xd6d7cb, 0x7694a0, 0xb8756c, 0x8c9b76]),
});
const PEDESTRIAN_HAIR_COLORS = Object.freeze([
  0x252326, 0x3a2b27, 0x59402f, 0x765333, 0x4a4e4a, 0x1e2930,
]);
const PEDESTRIAN_ROLE_ACCENTS = Object.freeze({
  commuter: Object.freeze({ kind: 'badge', color: 0xb9cbd0 }),
  resident: Object.freeze({ kind: 'tote', color: 0xc4b59d }),
  shopper: Object.freeze({ kind: 'tote', color: 0xd6b36d }),
  worker: Object.freeze({ kind: 'hi-vis', color: 0xe1b05a }),
  services: Object.freeze({ kind: 'hi-vis', color: 0x9fbe78 }),
  delivery: Object.freeze({ kind: 'backpack', color: 0xe39a4b }),
  tourist: Object.freeze({ kind: 'badge', color: 0x4e9bb0 }),
  student: Object.freeze({ kind: 'backpack', color: 0x8b6a9c }),
  runner: Object.freeze({ kind: 'band', color: 0x6fa9a5 }),
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
    classWeights: [['sedan', 38], ['suv', 24], ['taxi', 24], ['van', 14]],
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
    classWeights: [['sedan', 34], ['van', 30], ['suv', 20], ['taxi', 16]],
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
    classWeights: [['sedan', 38], ['taxi', 26], ['suv', 22], ['van', 14]],
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
    classWeights: [['sedan', 42], ['suv', 30], ['taxi', 14], ['van', 14]],
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
    classWeights: [['sedan', 34], ['taxi', 30], ['suv', 22], ['van', 14]],
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
    classWeights: [['sedan', 46], ['suv', 24], ['van', 18], ['taxi', 12]],
  }),
  'Outer Sunset': Object.freeze({
    roles: [
      ['resident', 46], ['student', 14], ['commuter', 16], ['shopper', 10],
      ['services', 8], ['delivery', 6],
    ],
    wardrobe: Object.freeze({
      tops: [0x315c4c, 0x7a6b55, 0x2d3438, 0xc4b59d, 0x203a58, 0x59433a],
      bottoms: [0x2f3033, 0x42372f, 0x4d4d4b, 0x354a57],
    }),
    classWeights: [['sedan', 48], ['suv', 24], ['van', 18], ['taxi', 10]],
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
    classWeights: [['sedan', 44], ['suv', 24], ['van', 18], ['taxi', 14]],
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
    classWeights: [['sedan', 38], ['suv', 24], ['van', 22], ['taxi', 16]],
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
    classWeights: [['sedan', 44], ['suv', 26], ['van', 16], ['taxi', 14]],
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
    classWeights: [['sedan', 40], ['taxi', 24], ['suv', 20], ['van', 16]],
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
    classWeights: [['sedan', 44], ['suv', 28], ['van', 16], ['taxi', 12]],
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
    classWeights: [['sedan', 46], ['suv', 28], ['van', 14], ['taxi', 12]],
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
    classWeights: [['sedan', 36], ['van', 30], ['suv', 22], ['taxi', 12]],
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
    classWeights: [['sedan', 46], ['suv', 24], ['van', 20], ['taxi', 10]],
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
    classWeights: [['sedan', 40], ['suv', 22], ['van', 20], ['taxi', 18]],
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
    classWeights: [['sedan', 38], ['suv', 26], ['taxi', 22], ['van', 14]],
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
  classWeights: [['sedan', 42], ['suv', 24], ['van', 18], ['taxi', 16]],
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
      start: 0,
      end: 24,
      activity: 'transit',
      destination: 'transit hub',
      pace: 1.08,
      fleetRole: 'transit',
    }),
  ]),
  van: Object.freeze([
    Object.freeze({ start: 5, end: 20, activity: 'delivering', destination: 'drop-off', pace: 1.12, fleetRole: 'delivery' }),
    Object.freeze({ start: 20, end: 23, activity: 'returning', destination: 'depot', pace: 1, fleetRole: 'delivery' }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'depot', pace: 0.88, fleetRole: 'delivery' }),
  ]),
  sedan: Object.freeze([
    Object.freeze({ start: 5, end: 10, activity: 'commuting', destination: 'office district', pace: 1.12, fleetRole: 'commute' }),
    Object.freeze({ start: 10, end: 16, activity: 'errands', destination: 'local route', pace: 0.98, fleetRole: 'local' }),
    Object.freeze({ start: 16, end: 20, activity: 'commuting', destination: 'home district', pace: 1.1, fleetRole: 'commute' }),
    Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'local route', pace: 0.94, fleetRole: 'local' }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'local route', pace: 0.9, fleetRole: 'local' }),
  ]),
  suv: Object.freeze([
    Object.freeze({ start: 5, end: 10, activity: 'commuting', destination: 'office district', pace: 1.1, fleetRole: 'commute' }),
    Object.freeze({ start: 10, end: 16, activity: 'errands', destination: 'local route', pace: 0.96, fleetRole: 'local' }),
    Object.freeze({ start: 16, end: 20, activity: 'commuting', destination: 'home district', pace: 1.08, fleetRole: 'commute' }),
    Object.freeze({ start: 20, end: 23, activity: 'leisure', destination: 'local route', pace: 0.92, fleetRole: 'local' }),
    Object.freeze({ start: 23, end: 5, activity: 'resting', destination: 'local route', pace: 0.88, fleetRole: 'local' }),
  ]),
});

function dayHourAt(elapsed) {
  return modulo((elapsed * HOURS_PER_ELAPSED_SECOND + DAY_HOUR_OFFSET) % 24, 24);
}

function schedulePhaseForRole(role, dayHour) {
  const phases = ROLE_SCHEDULES[role] || FALLBACK_ROLE_SCHEDULE;
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    if (dayHour >= phase.start && dayHour < phase.end) return phase;
  }
  return phases[0];
}

function vehicleSchedulePhaseFor(className, dayHour) {
  const phases = VEHICLE_SCHEDULES[className] || VEHICLE_SCHEDULES.sedan;
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    if (dayHour >= phase.start && dayHour < phase.end) return phase;
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

function nearFocusProgress(
  sectorKey,
  focusPosition,
  orientation,
  localSlot,
  spacing,
  phase = 0,
  spreadCount = 5,
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
    focusLongitudinal + spreadSlot * spacing + groupOffset,
    -SECTOR_SIZE * 0.44,
    SECTOR_SIZE * 0.44,
  );
  return modulo(longitudinal + SECTOR_SIZE * 0.5, SECTOR_SIZE);
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

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.68,
    metalness: 0.12,
    vertexColors: true,
  });
  const vehicleAccentMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.52,
    metalness: 0.1,
    vertexColors: true,
  });
  const vehicleIdentityMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.46,
    metalness: 0.08,
    vertexColors: true,
  });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x90a8b2,
    roughness: 0.2,
    metalness: 0.22,
    vertexColors: true,
  });
  const tireMaterial = new THREE.MeshStandardMaterial({
    color: 0x171a1d,
    roughness: 0.86,
  });
  const headlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xeaf4ff,
    emissive: 0xdcecff,
    emissiveIntensity: 0,
    roughness: 0.26,
    vertexColors: true,
  });
  const torsoMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.82,
    vertexColors: true,
  });
  const skinMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8,
    vertexColors: true,
  });
  const clothingMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.84,
    vertexColors: true,
  });
  const hairMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    vertexColors: true,
  });
  const roleCueMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
    vertexColors: true,
  });

  const bodyGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.1);
  const cabinGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.075);
  const vehicleTrimGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.055);
  const vehicleRoofGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.06);
  const wheelGeometry = new THREE.CylinderGeometry(1, 1, 1, 12);
  wheelGeometry.rotateZ(Math.PI * 0.5);
  const lampGeometry = new THREE.BoxGeometry(1, 1, 1);
  const torsoGeometry = new THREE.CapsuleGeometry(0.23, 0.62, 3, 8);
  const headGeometry = new THREE.SphereGeometry(0.16, 10, 7);
  const hairGeometry = new THREE.SphereGeometry(0.16, 8, 5);
  const roleCueGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.05);
  const limbGeometry = new THREE.CapsuleGeometry(0.065, 0.52, 2, 6);

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
    speed: 0,
    moving: false,
    waiting: false,
    crossing: false,
    crossingProgress: 0,
    crossingLine: 0,
    sidewalkSide: 1,
    dwelling: false,
    dwellUntil: 0,
    focusTableau: false,
    focusStageRevision: 0,
    appearance: null,
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
  const scale = new THREE.Vector3();
  const workPosition = new THREE.Vector3();
  const localOffset = new THREE.Vector3();
  const cueScale = new THREE.Vector3();
  const cueOffset = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
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

  const setMatrix = (mesh, index, position, yaw, sx, sy, sz) => {
    rotation.setFromAxisAngle(yAxis, yaw);
    scale.set(sx, sy, sz);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
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
    const className = pickWeighted(seed, 1, profile.classWeights);
    const spec = pools.vehicleProfile.classes[className];
    const schedulePhase = vehicleSchedulePhaseFor(className, dayHourAt(elapsedTime));
    const bodyColors = pools.vehicleProfile.bodyColors;
    const focusTableau = Boolean(
      tier === 'detail'
      && localSlot < FOCUS_TABLEAU_VEHICLES
      && focusPosition,
    );
    const focusBodyPalette = FOCUS_VEHICLE_BODY_COLORS[className]
      || FOCUS_VEHICLE_BODY_COLORS.sedan;
    const bodyColor = className === 'taxi'
      ? pools.vehicleProfile.taxiColor
      : focusBodyPalette[Math.floor(seededUnit(seed, 2) * focusBodyPalette.length)]
        || bodyColors[Math.floor(seededUnit(seed, 2) * bodyColors.length)];
    const bodyTint = new THREE.Color(bodyColor);
    liftReadableColor(bodyTint, 0.4, 0.16);
    const displayBodyColor = bodyTint.getHex();
    const accentColor = VEHICLE_ACCENT_COLORS[className] || VEHICLE_ACCENT_COLORS.sedan;
    const roofCueColor = VEHICLE_ROOF_CUE_COLORS[className] || VEHICLE_ROOF_CUE_COLORS.sedan;
    const roofCueSize = VEHICLE_ROOF_CUE_SIZES[className] || VEHICLE_ROOF_CUE_SIZES.sedan;
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
    actor.roadLine = streetLineFor(sectorKey, localSlot, 'vehicle');
    actor.direction = localSlot % 2 === 0 ? 1 : -1;
    actor.sidewalkSide = localSlot % 4 < 2 ? -1 : 1;
    actor.laneOffset = VEHICLE_LANE_OFFSET + (seededUnit(seed, 4) - 0.5) * 0.42;
    actor.spacingOffset = (seededUnit(seed, 5) - 0.5) * VEHICLE_SPACING_JITTER;
    actor.focusTableau = focusTableau;
    actor.visualScale = focusTableau
      ? 1.07 + seededUnit(seed, 6) * 0.1
      : 0.96 + seededUnit(seed, 6) * 0.1;
    const focusPhase = focusTableau
      ? (seededUnit(seed, 13) - 0.5) * 0.18
      : 0;
    actor.progress = nearFocusProgress(
      sectorKey,
      focusPosition,
      actor.orientation,
      localSlot,
      FOCUS_VEHICLE_SPACING,
      focusPhase,
      FOCUS_TABLEAU_VEHICLES,
    ) ?? modulo(
      (localSlot + 0.5) * (SECTOR_SIZE / VEHICLES_PER_SECTOR)
        + actor.spacingOffset
        + state.trafficClock * GRID_STEP,
      SECTOR_SIZE,
    );
    actor.speed = 8.4 + seededUnit(seed, 3) * 1.4;
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
        width: roofCueSize.width * 1.12,
        height: roofCueSize.height * 1.08,
        length: roofCueSize.length * 1.08,
      },
    };
    if (keepMotion) actor.progress = previousProgress;
    pools.meshes.vehicleBodies.setColorAt(actor.poolIndex, bodyTint);
    pools.meshes.vehicleCabins.setColorAt(actor.poolIndex, new THREE.Color(0xa1b7be));
    pools.meshes.vehicleRoofDetails.setColorAt(actor.poolIndex, new THREE.Color(roofCueColor));
    pools.meshes.vehicleSideTrims.setColorAt(actor.poolIndex * 2, new THREE.Color(accentColor));
    pools.meshes.vehicleSideTrims.setColorAt(actor.poolIndex * 2 + 1, new THREE.Color(accentColor));
    const rearLamp = new THREE.Color(0xa83b43);
    const frontLamp = new THREE.Color(0xfff0c2);
    pools.meshes.vehicleHeadlights.setColorAt(actor.poolIndex * 2, rearLamp);
    pools.meshes.vehicleHeadlights.setColorAt(actor.poolIndex * 2 + 1, frontLamp);
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
    const role = pickWeighted(seed, 1, districtProfile.roles);
    const focusTableau = Boolean(
      tier === 'detail'
      && localSlot < FOCUS_TABLEAU_PEDESTRIANS
      && focusPosition,
    );
    const schedulePhase = schedulePhaseForRole(role, dayHourAt(elapsedTime));
    const wardrobe = districtProfile.wardrobe;
    const topColors = wardrobe.tops.length ? wardrobe.tops : profile.topColors;
    const bottomColors = wardrobe.bottoms.length ? wardrobe.bottoms : profile.bottomColors;
    const topColor = new THREE.Color(
      topColors[Math.floor(seededUnit(seed, 2) * topColors.length)],
    );
    liftReadableColor(topColor, 0.36, 0.16);
    const skinColor = new THREE.Color(
      profile.skinColors[Math.floor(seededUnit(seed, 1) * profile.skinColors.length)],
    );
    liftReadableColor(skinColor, 0.36, 0.12);
    const bottomColor = new THREE.Color(
      bottomColors[Math.floor(seededUnit(seed, 3) * bottomColors.length)],
    );
    liftReadableColor(bottomColor, 0.26, 0.1);
    const hairColor = new THREE.Color(
      PEDESTRIAN_HAIR_COLORS[Math.floor(seededUnit(seed, 12) * PEDESTRIAN_HAIR_COLORS.length)],
    );
    const roleAccent = PEDESTRIAN_ROLE_ACCENTS[role] || DEFAULT_PEDESTRIAN_ROLE_ACCENT;
    const roleCueColor = new THREE.Color(roleAccent.color);
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
    actor.bodyWidthScale = roleCue.width * (
      focusTableau ? 1.02 + seededUnit(seed, 7) * 0.1 : 0.96 + seededUnit(seed, 7) * 0.08
    );
    actor.bodyDepthScale = roleCue.depth * (
      focusTableau ? 1.01 + seededUnit(seed, 8) * 0.1 : 0.95 + seededUnit(seed, 8) * 0.1
    );
    actor.limbScale = roleCue.limb * (
      focusTableau ? 1.01 + seededUnit(seed, 9) * 0.1 : 0.96 + seededUnit(seed, 9) * 0.08
    );
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
      const stagedProgress = nearFocusProgress(
        focusSectorKey,
        focusPosition,
        actor.orientation,
        actor.localSlot,
        isVehicle ? FOCUS_VEHICLE_SPACING : FOCUS_PEDESTRIAN_SPACING,
        (seededUnit(actor.sectorSeed, 13) - 0.5) * (isVehicle ? 0.18 : 0.16),
        tableauCount,
      );
      if (stagedProgress === null) return;
      // A QA teleport can leave a representative mid-crossing or in a dwell
      // state from the previous doorway. Re-seed only the staged tableau's
      // local presentation state; IDs, schedules, clocks, and leases remain
      // untouched and the next fixed step resumes ordinary motion.
      actor.progress = stagedProgress;
      actor.crossing = false;
      actor.crossingProgress = 0;
      actor.waiting = false;
      actor.dwelling = false;
      actor.dwellUntil = 0;
      actor.moving = true;
      actor.focusTableau = true;
      actor.focusStageRevision += 1;
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
    let x;
    let z;
    let yaw;
    if (actor.orientation === 'east-west') {
      x = centerX + longitudinal;
      z = centerZ + actor.roadLine + actor.direction * actor.laneOffset;
      yaw = actor.direction > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    } else {
      x = centerX - actor.direction * actor.laneOffset + actor.roadLine;
      z = centerZ + longitudinal;
      yaw = actor.direction > 0 ? 0 : Math.PI;
    }
    const ground = surfaceY(x, z);
    const visual = actor.appearance;
    const visualScale = actor.visualScale;
    actor.position.set(x, ground + visual.height * 0.38 * visualScale, z);
    setMatrix(
      pools.meshes.vehicleBodies,
      actor.poolIndex,
      actor.position,
      yaw,
      visual.width * visualScale,
      visual.height * 0.52 * visualScale,
      visual.length * visualScale,
    );
    workPosition.set(x, ground + visual.height * 0.72 * visualScale, z);
    setMatrix(
      pools.meshes.vehicleCabins,
      actor.poolIndex,
      workPosition,
      yaw,
      visual.width * 0.72 * visualScale,
      visual.height * 0.42 * visualScale,
      visual.length * 0.48 * visualScale,
    );
    const roofCue = visual.roofCueSize || VEHICLE_ROOF_CUE_SIZES.sedan;
    workPosition.set(x, ground + visual.height * 0.98 * visualScale, z);
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
      localOffset.set(
        sideSign * visual.width * 0.515 * visualScale,
        visual.height * 0.38 * visualScale,
        0,
      ).applyAxisAngle(yAxis, yaw);
      workPosition.set(x, ground, z).add(localOffset);
      setMatrix(
        pools.meshes.vehicleSideTrims,
        actor.poolIndex * 2 + sideIndex,
        workPosition,
        yaw,
        0.045 * visualScale,
        visual.height * 0.14 * visualScale,
        visual.length * 0.62 * visualScale,
      );
    }
    for (let axle = 0; axle < 2; axle += 1) {
      localOffset.set(
        0,
        visual.wheelRadius * visualScale,
        (axle ? 1 : -1) * visual.length * 0.31 * visualScale,
      );
      localOffset.applyAxisAngle(yAxis, yaw);
      workPosition.set(x, ground, z).add(localOffset);
      setMatrix(
        pools.meshes.vehicleWheels,
        actor.poolIndex * 2 + axle,
        workPosition,
        yaw,
        visual.width * 1.02 * visualScale,
        visual.wheelRadius * visualScale,
        visual.wheelRadius * visualScale,
      );
      localOffset.set(
        (axle ? 1 : -1) * visual.width * 0.3 * visualScale,
        visual.height * 0.43 * visualScale,
        visual.length * 0.505 * visualScale,
      ).applyAxisAngle(yAxis, yaw);
      workPosition.set(x, ground, z).add(localOffset);
      setMatrix(
        pools.meshes.vehicleHeadlights,
        actor.poolIndex * 2 + axle,
        workPosition,
        yaw,
        visual.width * 0.16 * visualScale,
        0.11 * visualScale,
        0.08 * visualScale,
      );
    }
  };

  const updateVehicleActor = (actor, step) => {
    refreshActorSchedule(actor);
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
    const shouldStop = phase !== 'green' && distanceToSignal >= 4.8 && distanceToSignal < 7.2;
    actor.waiting = shouldStop;
    actor.moving = !shouldStop;
    if (!shouldStop) {
      actor.progress = modulo(
        actor.progress
          + actor.direction * actor.speed * vehicleWeatherFactor() * scheduleBeat.vehiclePace * actor.pace * step,
        SECTOR_SIZE,
      );
    }
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
    const gait = actor.moving
      ? Math.sin(elapsedTime * actor.gaitRate + actor.localSlot * 1.7 + actor.gaitPhase)
        * 0.12 * actor.gaitScale
      : 0;
    const bodyWidth = height * actor.bodyWidthScale;
    const bodyDepth = height * actor.bodyDepthScale;
    actor.position.set(x, ground + 1.05 * height, z);
    setMatrix(
      pools.meshes.pedestrianTorsos,
      actor.poolIndex,
      actor.position,
      yaw,
      bodyWidth,
      height,
      bodyDepth,
    );
    workPosition.set(x, ground + 1.72 * height, z);
    setMatrix(
      pools.meshes.pedestrianHeads,
      actor.poolIndex,
      workPosition,
      yaw,
      bodyWidth * 0.96,
      height,
      bodyDepth * 0.96,
    );
    localOffset.set(0, 1.84 * height, 0).applyAxisAngle(yAxis, yaw);
    workPosition.set(x, ground, z).add(localOffset);
    setMatrix(
      pools.meshes.pedestrianHair,
      actor.poolIndex,
      workPosition,
      yaw,
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
      cueScale.set(bodyWidth * 0.2, height * 0.2, 0.07 * height);
      cueOffset.set(bodyWidth * 0.25, 1.2 * height, bodyDepth * 0.24);
    } else if (roleCueKind === 'hi-vis') {
      cueScale.set(bodyWidth * 0.38, height * 0.34, 0.06 * height);
      cueOffset.set(0, 1.18 * height, bodyDepth * 0.24);
    } else {
      cueScale.set(bodyWidth * 0.52, height * 0.11, bodyDepth * 0.25);
      cueOffset.set(0, 1.12 * height, 0);
    }
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
      localOffset.set(
        sign * 0.115 * actor.bodyWidthScale,
        0.48 * height,
        gait * sign * actor.bodyDepthScale,
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
      );
      localOffset.set(
        sign * 0.31 * actor.bodyWidthScale,
        1.08 * height,
        -gait * sign * actor.bodyDepthScale,
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
      );
    }
  };

  const updatePedestrianActor = (actor, step) => {
    refreshActorSchedule(actor);
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
    const atCrosswalk = actor.localSlot < 6 && Math.abs(longitudinal - nearestGrid) < 1.3;
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
    } else if (atCrosswalk) {
      actor.waiting = phase !== 'red';
      actor.moving = !actor.waiting;
      if (!actor.waiting) {
        actor.crossing = true;
        actor.crossingLine = nearestGrid;
        actor.crossingProgress = 0.001;
      }
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
    Object.values(pools.meshes).forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
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
    pools.headlightMaterial.emissiveIntensity = weather === 'clear' ? 0 : weather === 'fog' ? 2.8 : 3.4;
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

  setWeather('clear');
  flagMatrices();

  return {
    group: pools.root,
    update,
    setWeather,
    getStats,
    getEvidenceState,
    get stats() {
      return getStats();
    },
  };
}
