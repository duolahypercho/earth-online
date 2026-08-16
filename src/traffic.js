// traffic.js — systemic urban traffic simulation for the SF scene.
// Lane-following vehicle pool with signalized intersections, car-following,
// brake/indicator lighting, wheel spin and body bob. Deterministic via seed.
//
// Exports: createTrafficSystem({ scene, roadNetwork })
//   -> { group, update(dt, elapsed), setFocus(position, radius), getStats(),
//        getDiagnostics(), setWeather(mode), getVehicleLifeSnapshot() }

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import {
  SIGNAL_PERIOD,
  signalOffsetForPosition,
  signalPhaseAt,
} from './signals.js';
import {
  attachNodeControls,
  createTrafficRuleScenario,
  evaluateTrafficRuleSample,
  findTurnRule,
  isDirectionLegal,
  isTurnAllowed,
  normalizeRoadRules,
} from './traffic-graph.js';
import { createSfTaxiModel } from './vehicles/createSfTaxiModel.js';

const publicAsset = (path) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;

/* ---------------- deterministic rng ---------------- */

const SEED = 20260801;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- tuning ---------------- */

const LANE_OFFSET = 2.62;     // center of each marked right-hand lane (m)
const STOP_MARGIN = 6.9;      // front bumper standoff from crossing node (m)
const MIN_GAP = 3.0;          // bumper-to-bumper standstill gap (m)
const MIN_MOVING_HEADWAY = 1.2;
const HEADWAY_PLANNING_BUFFER = 0.18;
const NODE_EPS = 1.25;        // endpoint clustering tolerance (m)
const MAX_DT = 0.05;          // clamp to avoid tunneling on hitches
const ROUTE_LOOKAHEAD = 22;   // choose a turn early enough to signal it (m)
const TURN_SPAN = 8.2;        // lane path either side of an intersection (m)
const BRAKE_LIGHT_DECEL = -0.65;
const SIGNAL_REACTION = 0.32; // perception/actuation allowance for stop planning
const STOP_SIGN_HOLD = 0.45;  // full stop dwell before release at stop control
const PLAYER_PEDESTRIAN_IMPACT_MIN_SPEED = 4;
const PLAYER_PEDESTRIAN_IMPACT_RADIUS = 0.42;
const ON_FOOT_VEHICLE_IMPACT_MIN_SPEED = 4;
// The running Traveler reaches roughly 0.99 m from the root in the widest
// authored pose. Keep a small visual gap outside that rendered silhouette.
const ON_FOOT_PLAYER_RADIUS = 1.05;
// Vehicle specs describe the chassis collision core; bumpers, wheels and
// pursuit kits extend the rendered shell by up to ~0.36 m longitudinally and
// ~0.19 m laterally in the current fleet.
const ON_FOOT_VEHICLE_SHELL_LENGTH_PAD = 0.4;
const ON_FOOT_VEHICLE_SHELL_WIDTH_PAD = 0.22;
const ON_FOOT_VEHICLE_CLEARANCE_MARGIN = 0.18;
const ON_FOOT_VEHICLE_REARM_GAP = 0.75;
const CURB_LANE_LIMIT = 5.2;  // moving vehicles hug the marked right lane (m)
const CURB_LANE_OFFSET = 4.9; // parking-lane centerline (m)
const BIKE_LANE_OFFSET = 3.95; // between travel lane and parking / curb
const TAXI_DWELL_MIN = 2.6;
const TAXI_DWELL_SPAN = 3.6;
const SERVICE_DWELL_MIN = 4.2;
const SERVICE_DWELL_SPAN = 3.8;
const DELIVERY_DWELL_MIN = 5.0;
const DELIVERY_DWELL_SPAN = 4.5;
const CURB_APPROACH_DISTANCE = 20;
const CURB_STOP_END_MARGIN = ROUTE_LOOKAHEAD + 4;
const MERGE_SIGNAL_SECONDS = 3.2;
const BUS_DWELL_MIN = 3.4;
const BUS_DWELL_SPAN = 4.6;
const HERO_GATE_SECONDS = 14;
const HERO_ROAD_CAP = 6;
const HERO_HEAVY_CROSS_CAP = 1;
const MAX_VEHICLES = 42;
const MIN_VEHICLES = 38;
// Keep full wheels/glass/lighting details inside the street-view pocket. The
// lane simulation and signal behavior continue citywide; vehicles outside
// this radius use the already-pooled readable silhouette instead of
// submitting every manufactured submesh from the 39-car fleet.
// Preserve close sidewalk/car interaction detail while switching the rest of
// the live fleet to its single pooled silhouette early enough to keep the
// original core district inside the frame budget.
const TRAFFIC_NEAR_DETAIL_RADIUS_SQUARED = 72 * 72;
// The optional production hero asset is intentionally more expensive than the
// pooled low-poly vehicle. Keep it for a true close-up, but let the procedural
// shell carry the readable silhouette through the normal street-view band.
const TRAFFIC_PRODUCTION_DETAIL_RADIUS_SQUARED = 26 * 26;
const BUS_STOP_GAP_MIN = 42;
const BUS_STOP_GAP_SPAN = 30;
const VEHICLE_DAMAGE_COOLDOWN = 0.85;
const PURSUIT_RESPONDER_REARM_DISTANCE = 8.5;
const MAX_PERSISTED_COLLISION_AFTERMATH = 8;
const PERSISTED_COLLISION_DAMAGE_SOURCES = new Set([
  'reckless-collision',
  'combat-impact',
]);
const VEHICLE_HEALTH_BY_CLASS = Object.freeze({
  bike: 60,
  sedan: 100,
  taxi: 100,
  suv: 115,
  pickup: 125,
  van: 135,
  truck: 165,
  bus: 190,
});

// Bay Area-ish body color distribution (whites/silvers/blacks dominate)
const BODY_PALETTE = [
  { c: 0xf2f3f1, w: 0.24 }, // white
  { c: 0xc7cbd1, w: 0.17 }, // silver
  { c: 0x343a44, w: 0.16 }, // graphite-black: preserves night-car identity without losing silhouette
  { c: 0x5b626c, w: 0.12 }, // gray
  { c: 0x2a4d7f, w: 0.09 }, // blue
  { c: 0x7e2026, w: 0.06 }, // red
  { c: 0x3f5c46, w: 0.05 }, // green
  { c: 0xb08a3e, w: 0.04 }, // gold
  { c: 0x6b4e7a, w: 0.03 }, // plum
  { c: 0x9aa37f, w: 0.02 }, // sage
  { c: 0x8a5a2b, w: 0.02 }, // bronze
];

const CLASSES = {
  sedan: {
    len: 4.55, wid: 1.85, hgt: 1.42, wheelR: 0.33,
    vMin: 8.5, vMax: 13.0, accel: 2.35, brake: 4.6,
    headway: 1.34, reaction: 0.36, jerkUp: 2.8, jerkDown: 5.8,
  },
  taxi: {
    len: 4.55, wid: 1.85, hgt: 1.42, wheelR: 0.33,
    vMin: 8.2, vMax: 12.5, accel: 2.55, brake: 4.7,
    headway: 1.31, reaction: 0.3, jerkUp: 3.2, jerkDown: 6.2,
  },
  suv: {
    len: 4.86, wid: 1.96, hgt: 1.72, wheelR: 0.36,
    vMin: 8.0, vMax: 12.0, accel: 2.15, brake: 4.35,
    headway: 1.36, reaction: 0.39, jerkUp: 2.6, jerkDown: 5.4,
  },
  pickup: {
    len: 5.52, wid: 2.02, hgt: 1.78, wheelR: 0.38,
    vMin: 7.4, vMax: 11.3, accel: 1.9, brake: 4.0,
    headway: 1.42, reaction: 0.43, jerkUp: 2.35, jerkDown: 5.0,
  },
  van: {
    len: 5.35, wid: 2.00, hgt: 2.10, wheelR: 0.36,
    vMin: 7.5, vMax: 11.0, accel: 1.95, brake: 4.0,
    headway: 1.45, reaction: 0.44, jerkUp: 2.25, jerkDown: 4.8,
  },
  truck: {
    len: 7.30, wid: 2.30, hgt: 2.90, wheelR: 0.44,
    vMin: 6.5, vMax: 9.5, accel: 1.45, brake: 3.4,
    headway: 1.58, reaction: 0.52, jerkUp: 1.75, jerkDown: 3.8,
  },
  bus: {
    len: 11.0, wid: 2.55, hgt: 3.00, wheelR: 0.47,
    vMin: 6.0, vMax: 9.0, accel: 1.25, brake: 3.1,
    headway: 1.65, reaction: 0.56, jerkUp: 1.55, jerkDown: 3.5,
  },
  bike: {
    len: 1.72, wid: 0.52, hgt: 1.05, wheelR: 0.31,
    vMin: 4.2, vMax: 7.4, accel: 2.1, brake: 3.8,
    headway: 1.05, reaction: 0.26, jerkUp: 3.6, jerkDown: 6.4,
  },
};

const TAXI_COLOR = 0xffc324;
const BUS_BODY = 0xe9e6e0;
const BUS_STRIPE = 0xc8352c; // Muni-ish red
const BUS_ROUTE_BOARD = 'MUNI 1 CALIFORNIA'; // text on the shared coach sign board
const TRUCK_CABS = [0x6b4a2a, 0xf0ede6, 0x8c2f2a, 0x3a3f46]; // UPS brown, white, red, charcoal

const VEHICLE_IDENTITIES = {
  private: {
    key: 'private',
    category: 'private',
    label: 'Private vehicle',
    curbService: null,
  },
  taxi: {
    key: 'sf-taxi',
    category: 'taxi',
    label: 'San Francisco taxi',
    curbService: 'taxi',
  },
  sfmtaTransit: {
    key: 'sfmta-transit',
    category: 'sfmta',
    label: 'SFMTA Muni transit',
    curbService: null,
  },
  sfmtaService: {
    key: 'sfmta-service',
    category: 'sfmta',
    label: 'SFMTA service vehicle',
    curbService: 'service',
  },
  cityService: {
    key: 'city-service',
    category: 'service',
    label: 'City service vehicle',
    curbService: 'service',
  },
  delivery: {
    key: 'local-delivery',
    category: 'delivery',
    label: 'Local delivery vehicle',
    curbService: 'delivery',
  },
  bike: {
    key: 'sf-bike',
    category: 'bike',
    label: 'San Francisco bicycle',
    curbService: null,
  },
};

const CURB_SERVICE_PROFILES = {
  taxi: {
    firstDelay: 10,
    cooldown: 24,
    cooldownSpan: 26,
    ahead: 22,
    aheadSpan: 6,
    dwell: TAXI_DWELL_MIN,
    dwellSpan: TAXI_DWELL_SPAN,
  },
  service: {
    firstDelay: 16,
    cooldown: 38,
    cooldownSpan: 24,
    ahead: 24,
    aheadSpan: 6,
    dwell: SERVICE_DWELL_MIN,
    dwellSpan: SERVICE_DWELL_SPAN,
  },
  delivery: {
    firstDelay: 22,
    cooldown: 46,
    cooldownSpan: 30,
    ahead: 26,
    aheadSpan: 4,
    dwell: DELIVERY_DWELL_MIN,
    dwellSpan: DELIVERY_DWELL_SPAN,
  },
};

function vehicleIdentityFor(cls, ordinal) {
  if (cls === 'bus') return VEHICLE_IDENTITIES.sfmtaTransit;
  if (cls === 'taxi') return VEHICLE_IDENTITIES.taxi;
  if (cls === 'bike') return VEHICLE_IDENTITIES.bike;
  if (cls === 'truck') return VEHICLE_IDENTITIES.delivery;
  if (cls === 'van') {
    if (ordinal === 0) return VEHICLE_IDENTITIES.sfmtaService;
    return ordinal <= 2
      ? VEHICLE_IDENTITIES.delivery
      : VEHICLE_IDENTITIES.private;
  }
  if (cls === 'pickup' && ordinal === 0) return VEHICLE_IDENTITIES.cityService;
  return VEHICLE_IDENTITIES.private;
}

function routeSideCue(side, uTurn = false) {
  if (uTurn) return 'u-turn';
  if (side > 0) return 'right';
  if (side < 0) return 'left';
  return 'straight';
}

// Livery labels mirror the shared badge/sign vocabulary painted in
// `buildShared`, so UI/QA cues stay in lockstep with the visible fleet.
function liveryCueFor(identity, cls) {
  if (identity.key === 'sf-taxi') {
    return { key: 'sf-taxi', label: 'Taxi yellow / TAXI' };
  }
  if (identity.key === 'sf-bike') {
    return { key: 'sf-bike', label: 'City bicycle' };
  }
  if (identity.key === 'sfmta-transit') {
    return { key: 'muni-transit', label: 'Muni white / red stripe' };
  }
  if (identity.key === 'sfmta-service') {
    return { key: 'sfmta-service', label: 'SFMTA street service' };
  }
  if (identity.key === 'city-service') {
    return { key: 'city-service', label: 'City field service' };
  }
  if (identity.key === 'local-delivery') {
    return cls === 'truck'
      ? { key: 'delivery-truck', label: 'Bay Parcel box truck' }
      : { key: 'delivery-van', label: 'Bay Parcel van' };
  }
  return { key: 'private', label: 'Private vehicle' };
}

// Streamed districts use one global instanced fleet rather than cloning this
// full authored-core simulation. Expose only the compact, immutable visual
// vocabulary needed by that pool so both presentations keep the same scale
// and Bay Area-biased paint distribution.
export function getStreamedVehicleVisualProfile() {
  return {
    bodyColors: BODY_PALETTE.map((entry) => entry.c),
    classes: {
      sedan: { ...CLASSES.sedan },
      suv: { ...CLASSES.suv },
      taxi: { ...CLASSES.taxi },
      van: { ...CLASSES.van },
      bike: { ...CLASSES.bike },
    },
    taxiColor: TAXI_COLOR,
  };
}

// Vehicles adopt the coastal lighting cycle like every other actor system:
// lamps step up as the sun drops so the fleet keeps its presence under fog
// and drizzle, and taxi/bus signage brightens to stay readable.
const LIGHTING_PRESETS = {
  clear: {
    head: 2.0,
    tailOff: 0.42,
    tailBrake: 3.2,
    indicatorOff: 0.08,
    indicatorOn: 3.0,
    taxiSign: 1.2,
    destination: 1.35,
    beaconOff: 0.14,
    beaconOn: 3.4,
  },
  fog: {
    head: 3.4,
    tailOff: 1.0,
    tailBrake: 4.2,
    indicatorOff: 0.2,
    indicatorOn: 3.8,
    taxiSign: 2.4,
    destination: 2.6,
    beaconOff: 0.28,
    beaconOn: 4.1,
  },
  drizzle: {
    head: 4.4,
    tailOff: 1.5,
    tailBrake: 5.0,
    indicatorOff: 0.3,
    indicatorOn: 4.4,
    taxiSign: 3.2,
    destination: 3.4,
    beaconOff: 0.4,
    beaconOn: 4.8,
  },
};

/* ---------------- road network normalization ---------------- */

function readPoint(p, out) {
  if (p == null) return false;
  if (Array.isArray(p)) {
    if (p.length === 2) { out.x = +p[0]; out.y = 0; out.z = +p[1]; return isFinite(out.x) && isFinite(out.z); }
    if (p.length >= 3) { out.x = +p[0]; out.y = +p[1] || 0; out.z = +p[2]; return isFinite(out.x) && isFinite(out.z); }
    return false;
  }
  if (typeof p.x === 'number' && typeof p.z === 'number') {
    out.x = p.x; out.y = typeof p.y === 'number' ? p.y : 0; out.z = p.z; return true;
  }
  return false;
}

function extractPointList(r) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') {
    const arr = r.points || r.path || r.polyline || r.nodes || r.vertices;
    if (Array.isArray(arr)) return arr;
    if (r.start && r.end) return [r.start, r.end];
    if (r.from && r.to) return [r.from, r.to];
  }
  return null;
}

function extractSignalPlanPoint(plan, out) {
  if (!plan) return false;
  return readPoint(plan.position || plan.world || plan, out);
}

function splitAtKnownIntersections(list, intersections) {
  if (!Array.isArray(list) || list.length !== 2 || !intersections.length) return [list];

  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  if (!readPoint(list[0], a) || !readPoint(list[1], b)) return [list];

  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < 1e-6) return [list];

  const points = [{ ...a, t: 0 }];
  for (const candidate of intersections) {
    const p = { x: 0, y: 0, z: 0 };
    if (!readPoint(candidate, p)) continue;
    const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq;
    if (t <= 0.0001 || t >= 0.9999) continue;
    const distance = Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / Math.sqrt(lengthSq);
    if (distance > NODE_EPS * 1.5) continue;
    points.push({ ...p, t });
  }
  points.push({ ...b, t: 1 });
  points.sort((left, right) => left.t - right.t);

  const segments = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    segments.push([
      new THREE.Vector3(start.x, start.y, start.z),
      new THREE.Vector3(end.x, end.y, end.z),
    ]);
  }
  return segments;
}

// -> roads: [{ px,py,pz, cum, len, endNode:[a,b] }]
// -> nodes: [{ x,y,z, ends:[{road,end}] }]
function normalizeNetwork(roadNetwork) {
  const roads = [];
  const nodes = [];
  if (!roadNetwork || !Array.isArray(roadNetwork.roads)) return { roads, nodes };

  const tmp = { x: 0, y: 0, z: 0 };
  const intersections = Array.isArray(roadNetwork.intersections) ? roadNetwork.intersections : [];
  const turnRules = Array.isArray(roadNetwork.turnRules) ? roadNetwork.turnRules : [];
  for (const raw of roadNetwork.roads) {
    const list = extractPointList(raw);
    if (!list || list.length < 2) continue;
    const rules = normalizeRoadRules(raw);
    const speedLimit = rules.speedLimit;
    const laneOffset = rules.laneOffset ?? (
      Number.isFinite(Number(raw?.laneWidth)) && Number(raw.laneWidth) > 0
        ? Number(raw.laneWidth)
        : LANE_OFFSET
    );
    for (const segment of splitAtKnownIntersections(list, intersections)) {
      const px = [], py = [], pz = [];
      let lx = null, lz = null;
      for (const p of segment) {
        if (!readPoint(p, tmp)) continue;
        if (lx !== null && Math.abs(tmp.x - lx) < 1e-4 && Math.abs(tmp.z - lz) < 1e-4) continue;
        px.push(tmp.x); py.push(tmp.y); pz.push(tmp.z);
        lx = tmp.x; lz = tmp.z;
      }
      if (px.length < 2) continue;
      const cum = new Float64Array(px.length);
      let len = 0;
      for (let i = 1; i < px.length; i++) {
        len += Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
        cum[i] = len;
      }
      if (len < 12) continue; // too short to drive
      const firstDx = px[1] - px[0];
      const firstDz = pz[1] - pz[0];
      const last = px.length - 1;
      const lastDx = px[last] - px[last - 1];
      const lastDz = pz[last] - pz[last - 1];
      roads.push({
        px,
        py,
        pz,
        cum,
        len,
        speedLimit,
        laneOffset,
        oneway: rules.oneway,
        dirs: rules.dirs,
        endNode: [-1, -1],
        signalGroup: [
          Math.abs(firstDx) >= Math.abs(firstDz) ? 0 : 1,
          Math.abs(lastDx) >= Math.abs(lastDz) ? 0 : 1,
        ],
      });
    }
  }

  // cluster endpoints into intersection nodes
  for (let ri = 0; ri < roads.length; ri++) {
    const r = roads[ri];
    for (let end = 0; end < 2; end++) {
      const i = end === 0 ? 0 : r.px.length - 1;
      const x = r.px[i], y = r.py[i], z = r.pz[i];
      let ni = -1;
      for (let n = 0; n < nodes.length; n++) {
        if (Math.abs(nodes[n].x - x) < NODE_EPS && Math.abs(nodes[n].z - z) < NODE_EPS) { ni = n; break; }
      }
      if (ni === -1) { ni = nodes.length; nodes.push({ x, y, z, ends: [], control: 'none' }); }
      nodes[ni].ends.push({ road: ri, end });
      r.endNode[end] = ni;
    }
  }
  attachNodeControls(nodes, roadNetwork);
  return {
    roads,
    nodes,
    signalPlans: Array.isArray(roadNetwork.signalPlans) ? roadNetwork.signalPlans : [],
    turnRules,
    controls: Array.isArray(roadNetwork.controls) ? roadNetwork.controls : [],
  };
}

/* ---------------- signals ---------------- */

// Nodes where >= 3 road ends meet are treated as signalized crossings.
// The phase group belongs to each road end (horizontal 0, vertical 1), not
// the whole node: opposing approaches move together while cross traffic waits.
function buildSignals(nodes, signalPlans = []) {
  const signals = new Map();
  const useAuthoredPlans = signalPlans.length > 0;
  const planPoint = { x: 0, y: 0, z: 0 };
  for (let n = 0; n < nodes.length; n++) {
    if (nodes[n].control === 'stop' || nodes[n].control === 'none') continue;
    if (nodes[n].ends.length < 3 && nodes[n].control !== 'signal') continue;
    let plan = null;
    if (useAuthoredPlans) {
      plan = signalPlans.find((candidate) => {
        if (!extractSignalPlanPoint(candidate, planPoint)) return false;
        return Math.hypot(planPoint.x - nodes[n].x, planPoint.z - nodes[n].z) <= NODE_EPS * 2;
      });
      if (nodes[n].control !== 'signal') {
        if (!plan || plan.signalized === false) continue;
      }
    } else if (nodes[n].control !== 'signal' && nodes[n].ends.length < 3) {
      continue;
    }
    signals.set(n, {
      offset: signalOffsetForPosition(nodes[n].x, nodes[n].z),
      planId: plan?.id || null,
      cycleSeconds: Number.isFinite(plan?.cycleSeconds) ? plan.cycleSeconds : null,
      pedestrianLeadSeconds: Number.isFinite(plan?.pedestrianLeadSeconds)
        ? plan.pedestrianLeadSeconds
        : null,
    });
  }
  return signals;
}

/* ---------------- shared geometry / materials ---------------- */

function buildShared() {
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitPlane = new THREE.PlaneGeometry(1, 1);
  // Keep the fleet on shared, low-cost primitives, but give the close-range
  // silhouettes enough curvature that tires and body corners do not resolve
  // as toy blocks at the player camera.
  const roundedBox = new RoundedBoxGeometry(1, 1, 1, 0.12, 3);
  const unitWheel = new THREE.CylinderGeometry(1, 1, 1, 24);
  const contactDisc = new THREE.CircleGeometry(1, 24);
  const wheelWell = new THREE.CircleGeometry(1, 24);
  unitWheel.rotateZ(Math.PI / 2); // axle along X

  // A tapered cabin gives every light vehicle a real windshield/backlight
  // rake while keeping the geometry shared across the pooled fleet.  The
  // values are normalized so each class can scale the same topology.
  const taperedPrism = (frontInset, rearInset, roofWidth = 0.88) => {
    const halfRoof = roofWidth * 0.5;
    const positions = new Float32Array([
      -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,
       0.5, -0.5,  0.5, -0.5, -0.5,  0.5,
      -halfRoof, 0.5, -0.5 + rearInset,
       halfRoof, 0.5, -0.5 + rearInset,
       halfRoof, 0.5,  0.5 - frontInset,
      -halfRoof, 0.5,  0.5 - frontInset,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // The cabin glass uses the default front-side material. Keep every face
    // wound outward so its windshield, side glass, and backlight survive
    // normal exterior camera angles instead of being back-face culled.
    geometry.setIndex([
      0, 1, 2, 0, 2, 3,
      0, 5, 1, 0, 4, 5,
      1, 6, 2, 1, 5, 6,
      2, 7, 3, 2, 6, 7,
      3, 4, 0, 3, 7, 4,
      4, 6, 5, 4, 7, 6,
    ]);
    geometry.computeVertexNormals();
    return geometry;
  };
  const sedanCabin = taperedPrism(0.18, 0.14, 0.86);
  const suvCabin = taperedPrism(0.12, 0.11, 0.9);
  const utilityCabin = taperedPrism(0.15, 0.1, 0.88);

  const colorMats = new Map();
  const bodyMat = (hex) => {
    let m = colorMats.get(hex);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({
        color: hex,
        roughness: 0.3,
        metalness: 0.18,
        clearcoat: 0.38,
        clearcoatRoughness: 0.16,
        envMapIntensity: 1.02,
      });
      colorMats.set(hex, m);
    }
    return m;
  };

  const fleetLabelMat = ({
    background,
    accent,
    ink,
    title,
    subtitle,
  }) => {
    if (typeof document === 'undefined') {
      return new THREE.MeshStandardMaterial({
        color: background,
        roughness: 0.68,
        metalness: 0.04,
        side: THREE.DoubleSide,
      });
    }
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const context = canvas.getContext('2d');
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = accent;
    context.fillRect(0, 0, 42, canvas.height);
    context.fillRect(42, 0, canvas.width - 42, 12);
    context.fillStyle = ink;
    context.font = '800 56px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(title, canvas.width * 0.55, canvas.height * 0.43);
    context.font = '700 24px Arial, sans-serif';
    context.fillText(subtitle, canvas.width * 0.55, canvas.height * 0.75);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return new THREE.MeshStandardMaterial({
      map: texture,
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
  };

  const plateMat = (() => {
    if (typeof document === 'undefined') {
      return new THREE.MeshStandardMaterial({
        color: 0xe4dfd0,
        roughness: 0.58,
        metalness: 0.08,
      });
    }
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    context.fillStyle = '#f4f0dd';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#1f4a72';
    context.lineWidth = 8;
    context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
    context.fillStyle = '#b52c36';
    context.font = 'italic 700 20px Georgia, serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('California', canvas.width * 0.5, 20);
    context.fillStyle = '#193d62';
    context.font = '800 43px Arial, sans-serif';
    context.fillText('7SF 2026', canvas.width * 0.5, 61);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return new THREE.MeshStandardMaterial({
      map: texture,
      color: 0xffffff,
      roughness: 0.58,
      metalness: 0.08,
    });
  })();

  const taxiSignMat = (() => {
    if (typeof document === 'undefined') {
      return new THREE.MeshStandardMaterial({
        color: 0x222018,
        emissive: 0xffe27a,
        emissiveIntensity: 1.2,
      });
    }
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff0a8';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#28231a';
    context.lineWidth = 8;
    context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
    context.fillStyle = '#242018';
    context.font = '800 48px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('TAXI', canvas.width * 0.5, canvas.height * 0.53);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return new THREE.MeshStandardMaterial({
      map: texture,
      color: 0xffffff,
      emissive: 0xffe27a,
      emissiveIntensity: 1.2,
      roughness: 0.54,
    });
  })();

  const busRouteMat = (() => {
    if (typeof document === 'undefined') {
      return new THREE.MeshStandardMaterial({
        color: 0x211b0c,
        emissive: 0xffa91f,
        emissiveIntensity: 1.35,
        roughness: 0.68,
      });
    }
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    context.fillStyle = '#201d16';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#e5aa48';
    context.lineWidth = 5;
    context.strokeRect(7, 7, canvas.width - 14, canvas.height - 14);
    context.fillStyle = '#ffe8a9';
    context.font = '700 35px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(BUS_ROUTE_BOARD, canvas.width * 0.5, canvas.height * 0.53);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return new THREE.MeshStandardMaterial({
      map: texture,
      color: 0xffffff,
      emissive: 0x5b3b0b,
      emissiveIntensity: 0.68,
      roughness: 0.58,
      metalness: 0.04,
    });
  })();
  const busLogoMat = (() => {
    if (typeof document === 'undefined') {
      return new THREE.MeshBasicMaterial({ color: 0xf0e8d6 });
    }
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    context.fillStyle = '#f1e9d7';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#d43d45';
    context.fillRect(0, 0, 26, canvas.height);
    context.fillStyle = '#26363c';
    context.font = '700 38px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('SFMTA · MUNI', canvas.width * 0.54, canvas.height * 0.53);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return new THREE.MeshStandardMaterial({
      map: texture,
      color: 0xffffff,
      roughness: 0.7,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
  })();

  return {
    unitBox, unitPlane, roundedBox, unitWheel, contactDisc, wheelWell,
    sedanCabin, suvCabin, utilityCabin, bodyMat,
    windowMat: new THREE.MeshPhysicalMaterial({
      color: 0x315461,
      roughness: 0.12,
      metalness: 0.16,
      clearcoat: 0.22,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.16,
      transparent: true,
      // Keep the real seated Traveler readable without turning the fleet into
      // clear plastic. The cabin furniture and dark aperture retain depth.
      opacity: 0.38,
      depthWrite: false,
    }),
    busWindowMat: new THREE.MeshPhysicalMaterial({
      color: 0x315461,
      roughness: 0.22,
      metalness: 0.12,
      clearcoat: 0.3,
      clearcoatRoughness: 0.12,
      envMapIntensity: 0.88,
      transparent: true,
      opacity: 0.74,
      depthWrite: true,
    }),
    tireMat: new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.92, metalness: 0.0 }),
    wheelWellMat: new THREE.MeshStandardMaterial({
      color: 0x111416,
      roughness: 0.88,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
    underbodyMat: new THREE.MeshStandardMaterial({ color: 0x17191b, roughness: 0.82, metalness: 0.16 }),
    interiorMat: new THREE.MeshStandardMaterial({ color: 0x11171b, roughness: 0.82, metalness: 0.04 }),
    seatMat: new THREE.MeshStandardMaterial({ color: 0x2c3131, roughness: 0.75, metalness: 0.02 }),
    grilleMat: new THREE.MeshStandardMaterial({ color: 0x24292d, roughness: 0.46, metalness: 0.58 }),
    plateMat,
    headMat: new THREE.MeshStandardMaterial({ color: 0x4a4532, emissive: 0xffedbd, emissiveIntensity: 2.0 }),
    tailOffMat: new THREE.MeshStandardMaterial({ color: 0x360707, emissive: 0xb9140d, emissiveIntensity: 0.42 }),
    tailBrakeMat: new THREE.MeshStandardMaterial({ color: 0x6a0b08, emissive: 0xff2f1c, emissiveIntensity: 3.2 }),
    indicatorOffMat: new THREE.MeshStandardMaterial({ color: 0x302100, emissive: 0x8a4200, emissiveIntensity: 0.08 }),
    indicatorOnMat: new THREE.MeshStandardMaterial({ color: 0x6b3500, emissive: 0xffa51f, emissiveIntensity: 3.0 }),
    stripeMat: new THREE.MeshStandardMaterial({ color: BUS_STRIPE, roughness: 0.5, metalness: 0.2 }),
    signMat: taxiSignMat,
    trimMat: new THREE.MeshStandardMaterial({ color: 0x6d7477, roughness: 0.34, metalness: 0.76 }),
    mirrorMat: new THREE.MeshStandardMaterial({ color: 0x152027, roughness: 0.2, metalness: 0.5 }),
    hubMat: new THREE.MeshStandardMaterial({ color: 0x737b80, roughness: 0.38, metalness: 0.7 }),
    hubCapMat: new THREE.MeshStandardMaterial({ color: 0xb1b5b5, roughness: 0.26, metalness: 0.78 }),
    lightHousingMat: new THREE.MeshStandardMaterial({ color: 0x22282b, roughness: 0.46, metalness: 0.48 }),
    reverseMat: new THREE.MeshStandardMaterial({
      color: 0xc5c2b5,
      emissive: 0xd7e4e4,
      emissiveIntensity: 0.28,
      roughness: 0.34,
    }),
    rubberTrimMat: new THREE.MeshStandardMaterial({ color: 0x171b1d, roughness: 0.7, metalness: 0.16 }),
    roofEquipmentMat: new THREE.MeshStandardMaterial({ color: 0xb5b4ae, roughness: 0.68, metalness: 0.26 }),
    destinationMat: new THREE.MeshStandardMaterial({
      color: 0x211b0c,
      emissive: 0xffa91f,
      emissiveIntensity: 1.35,
      roughness: 0.68,
    }),
    busRouteMat,
    busLogoMat,
    taxiBadgeMat: fleetLabelMat({
      background: '#201d18',
      accent: '#f3ba20',
      ink: '#fff2b8',
      title: 'TAXI',
      subtitle: 'SAN FRANCISCO',
    }),
    sfmtaServiceMat: fleetLabelMat({
      background: '#f2eadb',
      accent: '#c8352c',
      ink: '#27383d',
      title: 'SFMTA',
      subtitle: 'STREET SERVICE',
    }),
    cityServiceMat: fleetLabelMat({
      background: '#183f50',
      accent: '#f0a331',
      ink: '#f7f1dc',
      title: 'CITY',
      subtitle: 'FIELD SERVICE',
    }),
    deliveryBadgeMat: fleetLabelMat({
      background: '#f1ead9',
      accent: '#c66c2d',
      ink: '#3b3026',
      title: 'BAY PARCEL',
      subtitle: 'LOCAL DELIVERY',
    }),
    pursuitBadgeMat: fleetLabelMat({
      background: '#112535',
      accent: '#4aa3ff',
      ink: '#f7fbff',
      title: 'SFPD',
      subtitle: 'STREET RESPONSE',
    }),
    taxiTrimMat: new THREE.MeshStandardMaterial({ color: 0x24211b, roughness: 0.58, metalness: 0.2 }),
    beaconOffMat: new THREE.MeshStandardMaterial({
      color: 0x5b3408,
      emissive: 0xa44f00,
      emissiveIntensity: 0.14,
      roughness: 0.38,
    }),
    beaconOnMat: new THREE.MeshStandardMaterial({
      color: 0xffa51f,
      emissive: 0xff8a16,
      emissiveIntensity: 3.4,
      roughness: 0.3,
    }),
    pursuitRedOffMat: new THREE.MeshStandardMaterial({
      color: 0x4b1015,
      emissive: 0x8f101c,
      emissiveIntensity: 0.18,
      roughness: 0.3,
    }),
    pursuitRedOnMat: new THREE.MeshStandardMaterial({
      color: 0xff2638,
      emissive: 0xff1329,
      emissiveIntensity: 4.4,
      roughness: 0.22,
    }),
    pursuitBlueOffMat: new THREE.MeshStandardMaterial({
      color: 0x102c56,
      emissive: 0x123f8e,
      emissiveIntensity: 0.18,
      roughness: 0.3,
    }),
    pursuitBlueOnMat: new THREE.MeshStandardMaterial({
      color: 0x247bff,
      emissive: 0x176dff,
      emissiveIntensity: 4.4,
      roughness: 0.22,
    }),
    contactMat: new THREE.MeshBasicMaterial({
      color: 0x111516,
      transparent: true,
      opacity: 0.19,
      depthWrite: false,
      toneMapped: false,
    }),
    heroContactMat: new THREE.MeshBasicMaterial({
      color: 0x080d10,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      toneMapped: false,
    }),
  };
}

function box(shared, mat, w, h, d, x, y, z, parent) {
  const m = new THREE.Mesh(shared.unitBox, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function roundedBox(shared, mat, w, h, d, x, y, z, parent) {
  const m = new THREE.Mesh(shared.roundedBox, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function taperedBox(shared, geometry, mat, w, h, d, x, y, z, parent) {
  const m = new THREE.Mesh(geometry, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function sideBadge(shared, mat, w, h, x, y, z, parent, name) {
  const badge = new THREE.Mesh(shared.unitPlane, mat);
  badge.name = name;
  badge.scale.set(w, h, 1);
  badge.position.set(x, y, z);
  badge.rotation.y = x > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
  badge.userData.noShadow = true;
  badge.userData.noReceiveShadow = true;
  parent.add(badge);
  return badge;
}

function frontBadge(shared, mat, w, h, x, y, z, parent, name) {
  const badge = new THREE.Mesh(shared.unitPlane, mat);
  badge.name = name;
  badge.scale.set(w, h, 1);
  badge.position.set(x, y, z);
  badge.userData.noShadow = true;
  badge.userData.noReceiveShadow = true;
  parent.add(badge);
  return badge;
}

// Forward is +Z. Static body meshes have frozen local matrices; only the
// root, sprung body group and wheels participate in per-frame transforms.
function buildVehicleMesh(shared, cls, spec, color, identity = VEHICLE_IDENTITIES.private) {
  const { len, wid, hgt, wheelR } = spec;
  const root = new THREE.Group();
  const bodyG = new THREE.Group();
  const wheelG = new THREE.Group();
  root.name = cls === 'bus' ? 'Muni transit coach' : `${cls} traffic vehicle`;
  root.userData.vehicleClass = cls;
  root.userData.vehicleIdentity = identity.key;
  root.userData.vehicleCategory = identity.category;
  root.userData.vehicleColor = color;
  root.add(bodyG, wheelG);

  // A compact baked contact patch grounds the pooled fleet even when its
  // submeshes are intentionally excluded from the expensive sun shadow map.
  const contactShadow = new THREE.Mesh(
    shared.contactDisc,
    cls === 'sedan' ? shared.heroContactMat : shared.contactMat,
  );
  contactShadow.name = 'Vehicle contact shadow';
  contactShadow.rotation.x = -Math.PI * 0.5;
  contactShadow.position.y = 0.025;
  contactShadow.scale.set(
    wid * (cls === 'sedan' ? 0.66 : 0.52),
    len * (cls === 'sedan' ? 0.58 : 0.43),
    1,
  );
  contactShadow.renderOrder = 1;
  contactShadow.frustumCulled = true;
    contactShadow.updateMatrix();
    contactShadow.matrixAutoUpdate = false;
    root.add(contactShadow);

    // Rain behavior needs a readable manufactured cue: a parked wiper on the
    // windshield sweeps while weather is wet. The pivot lives on the body
    // group so a single rotation reads from every exterior angle.
    let wiperPivot = null;
    if (cls !== 'bus' && cls !== 'bike') {
      // Anchor at the base of each class's actual windshield (front-bottom
      // edge of its cabin volume), raked to match the glass slope.
      const wiperSeat = cls === 'sedan' || cls === 'taxi'
        ? { y: hgt * 0.64, z: len * 0.22, rake: 0.58 }
        : cls === 'suv'
          ? { y: hgt * 0.6, z: len * 0.24, rake: 0.5 }
          : cls === 'pickup'
            ? { y: hgt * 0.64, z: len * 0.32, rake: 0.48 }
            : cls === 'van'
              ? { y: hgt * 0.66, z: len * 0.41, rake: 0.42 }
              : { y: hgt * 0.63, z: len * 0.445, rake: 0.42 };
      wiperPivot = new THREE.Group();
      wiperPivot.position.set(wid * 0.16, wiperSeat.y, wiperSeat.z);
      const bladeLength = Math.min(0.62, hgt * 0.42);
      const blade = new THREE.Mesh(shared.unitBox, shared.rubberTrimMat);
      blade.scale.set(0.05, bladeLength, 0.04);
      blade.position.y = bladeLength * 0.5;
      blade.updateMatrix();
      blade.matrixAutoUpdate = false;
      wiperPivot.add(blade);
      wiperPivot.rotation.x = -wiperSeat.rake;
      wiperPivot.userData.rake = wiperSeat.rake;
      wiperPivot.rotation.z = 0.82; // parked against the A-pillar edge
      wiperPivot.visible = false;
      bodyG.add(wiperPivot);
    }

  const paint = shared.bodyMat(readableBodyColor(color, cls));
  // A single pooled silhouette keeps citywide traffic visible without
  // submitting every glass pane, wheel hub, indicator, and trim mesh once the
  // vehicle is beyond the near street-view pocket. Simulation and collision
  // state remain unchanged; the full assembly returns inside the pocket.
  const proxyProfile = cls === 'bike'
    ? { width: 0.42, height: 0.16, length: 0.82, y: 0.34 }
    : cls === 'sedan' || cls === 'taxi'
      ? { width: 1.58, height: 0.46, length: 1.78, y: 0.34 }
      : cls === 'suv'
        ? { width: 0.98, height: 0.62, length: 0.98, y: 0.4 }
        : cls === 'pickup'
          ? { width: 0.98, height: 0.5, length: 0.98, y: 0.35 }
          : cls === 'van'
            ? { width: 0.98, height: 0.62, length: 0.98, y: 0.42 }
            : cls === 'truck'
              ? { width: 0.98, height: 0.36, length: 0.98, y: 0.3 }
              : { width: 0.985, height: 0.68, length: 0.985, y: 0.46 };
  const proxyBody = new THREE.Mesh(shared.roundedBox, paint);
  proxyBody.name = 'Traffic distance silhouette';
  proxyBody.position.y = hgt * proxyProfile.y;
  proxyBody.scale.set(
    wid * proxyProfile.width,
    hgt * proxyProfile.height,
    len * proxyProfile.length,
  );
  proxyBody.castShadow = false;
  proxyBody.receiveShadow = true;
  proxyBody.visible = false;
  root.add(proxyBody);
  const proxyCueG = addProxyClassCue(shared, root, cls, spec, paint);
  const wheels = [];
  const frontWheels = [];
  const beaconLights = [];
  const addWheel = (x, z, r, front = false) => {
    // A dark wheel well sits just inside the tire.  It is deliberately a
    // separate shared disc rather than a boolean cutout so the low-poly pool
    // gets a convincing arch and the body never appears to clip through a
    // floating wheel at close range.
    const well = new THREE.Mesh(shared.wheelWell, shared.wheelWellMat);
    well.scale.set(r * 1.1, r * 1.1, 1);
    well.position.set(Math.sign(x) * wid * 0.452, r * 1.03, z);
    well.rotation.y = Math.PI * 0.5;
    bodyG.add(well);
    const w = new THREE.Mesh(shared.unitWheel, shared.tireMat);
    const tireWidth = Math.min(0.3, Math.max(0.2, wid * 0.125));
    w.scale.set(tireWidth, r, r);
    w.position.set(Math.sign(x) * wid * 0.447, r, z);
    w.castShadow = false;
    w.receiveShadow = true;
    const hub = new THREE.Mesh(shared.unitWheel, shared.hubMat);
    hub.scale.set(1.04, 0.57, 0.57);
    hub.castShadow = false;
    hub.receiveShadow = true;
    hub.updateMatrix();
    hub.matrixAutoUpdate = false;
    w.add(hub);
    const cap = new THREE.Mesh(shared.unitWheel, shared.hubCapMat);
    cap.scale.set(1.055, 0.16, 0.16);
    cap.castShadow = false;
    cap.receiveShadow = true;
    cap.updateMatrix();
    cap.matrixAutoUpdate = false;
    hub.add(cap);
    wheelG.add(w);
    wheels.push(w);
    if (front) frontWheels.push(w);
  };

  const addCabin = ({ geometry, width, height, length, y, z, roofLength = 0.34 }) => {
    // Keep the glazing and cabin furniture separate: transparent raked glass
    // catches the environment, while the dash and two seat rows create actual
    // depth instead of a single opaque blue slab.
    taperedBox(shared, geometry, shared.windowMat, width, height, length, 0, y, z, bodyG);
    const cabinFloor = box(shared, shared.interiorMat, width * 0.72, 0.055, length * 0.66,
      0, y - height * 0.31, z - length * 0.02, bodyG);
    cabinFloor.name = `${cls} cabin floor`;
    cabinFloor.userData.embodimentCabin = true;
    const dashboard = box(shared, shared.interiorMat, width * 0.72, height * 0.12, length * 0.13,
      0, y - height * 0.1, z + length * 0.29, bodyG);
    dashboard.name = `${cls} dashboard`;
    dashboard.userData.embodimentCabin = true;
    for (const seatZ of [-0.13, -0.28]) {
      for (const side of [-1, 1]) {
        roundedBox(shared, shared.seatMat, width * 0.22, height * 0.3, length * 0.17,
          side * width * 0.22, y - height * 0.08, z + length * seatZ, bodyG);
      }
    }
    roundedBox(shared, paint, width * 0.68, Math.min(0.075, height * 0.16), length * roofLength,
      0, y + height * 0.51, z - length * 0.02, bodyG);
    for (const side of [-1, 1]) {
      box(shared, shared.rubberTrimMat, 0.045, height * 0.9, 0.052,
        side * width * 0.492, y, z + length * 0.3, bodyG);
      box(shared, shared.rubberTrimMat, 0.045, height * 0.92, 0.052,
        side * width * 0.492, y, z - length * 0.03, bodyG);
      box(shared, shared.rubberTrimMat, 0.045, height * 0.88, 0.052,
        side * width * 0.492, y, z - length * 0.3, bodyG);
      box(shared, shared.rubberTrimMat, 0.034, 0.04, length * 0.82,
        side * width * 0.505, y - height * 0.2, z - length * 0.02, bodyG);
    }
  };

  if (['sedan', 'taxi', 'suv', 'pickup', 'van'].includes(cls)) {
    const rockerWidth = cls === 'pickup' ? wid * 0.08 : wid * 0.1;
    const rockerOffset = cls === 'pickup' ? wid * 0.4 : wid * 0.455;
    for (const side of [-1, 1]) {
      const rocker = roundedBox(
        shared,
        paint,
        rockerWidth,
        wheelR * 0.5,
        len * 0.72,
        side * rockerOffset,
        wheelR * 1.14,
        0,
        bodyG,
      );
      rocker.name = `${cls} connected rocker and fender bridge`;
    }
  }

  if (cls === 'bike') {
    // Low-poly city bike: diamond frame, disc wheels, flat bars, seat.
    const frameMat = shared.bodyMat(readableBodyColor(color, cls));
    const fork = box(shared, frameMat, 0.05, hgt * 0.42, 0.05, 0, hgt * 0.42, len * 0.28, bodyG);
    void fork;
    box(shared, frameMat, 0.05, 0.05, len * 0.55, 0, hgt * 0.48, 0, bodyG);
    box(shared, frameMat, 0.05, hgt * 0.28, 0.05, 0, hgt * 0.34, -len * 0.22, bodyG);
    box(shared, frameMat, 0.42, 0.04, 0.04, 0, hgt * 0.78, len * 0.22, bodyG);
    box(shared, shared.rubberTrimMat, 0.18, 0.06, 0.22, 0, hgt * 0.72, -len * 0.18, bodyG);
    addWheel(-wid * 0.02, len * 0.32, wheelR, true);
    addWheel(wid * 0.02, -len * 0.32, wheelR);
    // Narrow the contact patch for a bike footprint.
    contactShadow.scale.set(wid * 0.9, len * 0.55, 1);
  } else if (cls === 'sedan' || cls === 'taxi') {
    // Build the sedan lower body around a real occupant cavity. A single
    // full-width solid slab made the authored driver intersect painted metal
    // even when the visible seated pose was correct. The floor, side sills,
    // engine bay and trunk retain the same exterior silhouette while leaving
    // the central footwell/cabin volume physically empty.
    const floor = roundedBox(
      shared, shared.underbodyMat,
      wid * 0.72, hgt * 0.07, len * 0.58,
      0, hgt * 0.13, -len * 0.015, bodyG,
    );
    floor.name = `${cls} occupant cabin floor pan`;
    for (const side of [-1, 1]) {
      const sill = roundedBox(
        shared, paint,
        wid * 0.105, hgt * 0.5, len * 0.98,
        side * wid * 0.438, hgt * 0.34, 0, bodyG,
      );
      sill.name = `${cls} exterior side sill`;
    }
    const engineBay = roundedBox(
      shared, paint,
      wid * 0.88, hgt * 0.46, len * 0.27,
      0, hgt * 0.33, len * 0.355, bodyG,
    );
    engineBay.name = `${cls} front engine body`;
    const trunkBody = roundedBox(
      shared, paint,
      wid * 0.9, hgt * 0.44, len * 0.22,
      0, hgt * 0.32, -len * 0.39, bodyG,
    );
    trunkBody.name = `${cls} rear trunk body`;
    // Hood and trunk decks sit lower than the roof so the side profile reads
    // as a three-box sedan rather than one extruded slab.
    roundedBox(shared, paint, wid * 0.94, hgt * 0.15, len * 0.28,
      0, hgt * 0.56, len * 0.345, bodyG);
    roundedBox(shared, paint, wid * 0.94, hgt * 0.15, len * 0.2,
      0, hgt * 0.55, -len * 0.395, bodyG);
    addCabin({
      geometry: shared.sedanCabin,
      width: wid * 0.86,
      height: hgt * 0.28,
      length: len * 0.48,
      y: hgt * 0.62,
      z: -len * 0.02,
      roofLength: 0.36,
    });
    if (cls === 'taxi') {
      box(shared, shared.signMat, 0.54, 0.17, 0.3, 0, hgt + 0.13, -len * 0.03, bodyG);
      for (const side of [-1, 1]) {
        box(shared, shared.taxiTrimMat, 0.035, 0.11, len * 0.68,
          side * wid * 0.505, hgt * 0.48, 0, bodyG);
      }
    }
    addWheel(-wid * 0.47, len * 0.32, wheelR, true);
    addWheel(wid * 0.47, len * 0.32, wheelR, true);
    addWheel(-wid * 0.47, -len * 0.32, wheelR);
    addWheel(wid * 0.47, -len * 0.32, wheelR);
  } else if (cls === 'suv') {
    roundedBox(shared, paint, wid * 0.98, hgt * 0.54, len * 0.98, 0, hgt * 0.33, 0, bodyG);
    roundedBox(shared, paint, wid * 0.93, hgt * 0.2, len * 0.22,
      0, hgt * 0.56, len * 0.36, bodyG);
    roundedBox(shared, paint, wid * 0.94, hgt * 0.18, len * 0.16,
      0, hgt * 0.55, -len * 0.41, bodyG);
    addCabin({
      geometry: shared.suvCabin,
      width: wid * 0.88,
      height: hgt * 0.46,
      length: len * 0.56,
      y: hgt * 0.84,
      z: -len * 0.04,
      roofLength: 0.42,
    });
    for (const side of [-1, 1]) {
      box(shared, shared.rubberTrimMat, 0.055, 0.075, len * 0.72,
        side * wid * 0.505, hgt * 0.2, 0, bodyG);
      box(shared, shared.roofEquipmentMat, 0.055, 0.055, len * 0.58,
        side * wid * 0.34, hgt * 1.15, -len * 0.03, bodyG);
    }
    addWheel(-wid * 0.47, len * 0.33, wheelR, true);
    addWheel(wid * 0.47, len * 0.33, wheelR, true);
    addWheel(-wid * 0.47, -len * 0.32, wheelR);
    addWheel(wid * 0.47, -len * 0.32, wheelR);
  } else if (cls === 'pickup') {
    roundedBox(shared, paint, wid * 0.9, hgt * 0.47, len * 0.98, 0, hgt * 0.32, 0, bodyG);
    roundedBox(shared, paint, wid * 0.86, hgt * 0.38, len * 0.37,
      0, hgt * 0.57, len * 0.17, bodyG);
    addCabin({
      geometry: shared.utilityCabin,
      width: wid * 0.8,
      height: hgt * 0.28,
      length: len * 0.28,
      y: hgt * 0.68,
      z: len * 0.18,
      roofLength: 0.42,
    });
    box(shared, shared.underbodyMat, wid * 0.72, 0.08, len * 0.28,
      0, hgt * 0.42, -len * 0.29, bodyG);
    for (const side of [-1, 1]) {
      box(shared, paint, 0.13, hgt * 0.35, len * 0.34,
        side * wid * 0.4, hgt * 0.57, -len * 0.28, bodyG);
      box(shared, shared.rubberTrimMat, 0.045, 0.055, len * 0.34,
        side * wid * 0.45, hgt * 0.76, -len * 0.28, bodyG);
    }
    box(shared, paint, wid * 0.84, hgt * 0.34, 0.12,
      0, hgt * 0.56, -len * 0.46, bodyG);
    box(shared, shared.rubberTrimMat, wid * 0.7, 0.055, 0.05,
      0, hgt * 0.76, -len * 0.46, bodyG);
    addWheel(-wid * 0.47, len * 0.34, wheelR, true);
    addWheel(wid * 0.47, len * 0.34, wheelR, true);
    addWheel(-wid * 0.47, -len * 0.33, wheelR);
    addWheel(wid * 0.47, -len * 0.33, wheelR);
  } else if (cls === 'van') {
    roundedBox(shared, paint, wid * 0.98, hgt * 0.76, len * 0.98, 0, hgt * 0.47, 0, bodyG);
    addCabin({
      geometry: shared.utilityCabin,
      width: wid * 0.9,
      height: hgt * 0.3,
      length: len * 0.32,
      y: hgt * 0.79,
      z: len * 0.25,
      roofLength: 0.46,
    });
    for (const side of [-1, 1]) {
      box(shared, shared.rubberTrimMat, 0.035, 0.055, len * 0.48,
        side * wid * 0.505, hgt * 0.54, -len * 0.1, bodyG);
      box(shared, shared.rubberTrimMat, 0.04, hgt * 0.48, 0.045,
        side * wid * 0.505, hgt * 0.53, -len * 0.1, bodyG);
    }
    for (const z of [-len * 0.26, len * 0.22]) {
      box(shared, shared.trimMat, wid * 0.78, 0.045, 0.07,
        0, hgt * 0.98, z, bodyG);
    }
    addWheel(-wid * 0.47, len * 0.33, wheelR, true);
    addWheel(wid * 0.47, len * 0.33, wheelR, true);
    addWheel(-wid * 0.47, -len * 0.33, wheelR);
    addWheel(wid * 0.47, -len * 0.33, wheelR);
  } else if (cls === 'truck') {
    const cabL = len * 0.26;
    roundedBox(shared, paint, wid * 0.96, hgt * 0.62, cabL, 0, hgt * 0.42, len / 2 - cabL / 2, bodyG);
    addCabin({
      geometry: shared.utilityCabin,
      width: wid * 0.88,
      height: hgt * 0.32,
      length: cabL * 0.7,
      y: hgt * 0.77,
      z: len / 2 - cabL * 0.56,
      roofLength: 0.44,
    });
    roundedBox(shared, shared.bodyMat(0xf0ede6), wid, hgt * 0.82, len * 0.68, 0, hgt * 0.55, -len * 0.12, bodyG);
    addWheel(-wid * 0.46, len * 0.36, wheelR, true);
    addWheel(wid * 0.46, len * 0.36, wheelR, true);
    addWheel(-wid * 0.46, -len * 0.18, wheelR);
    addWheel(wid * 0.46, -len * 0.18, wheelR);
    addWheel(-wid * 0.46, -len * 0.36, wheelR);
    addWheel(wid * 0.46, -len * 0.36, wheelR);
  } else { // bus
    roundedBox(shared, paint, wid * 0.985, hgt * 0.88, len * 0.985, 0, hgt * 0.55, 0, bodyG);
    // The coach gets a dark cabin volume plus framed individual panes rather
    // than a single blue extrusion.  This keeps its long flank readable as
    // a transit vehicle from close to the sidewalk and in rain reflections.
    box(shared, shared.interiorMat, wid * 0.84, hgt * 0.28, len * 0.84,
      0, hgt * 0.78, 0, bodyG);
    for (const z of [-0.36, -0.18, 0, 0.18, 0.36]) {
      for (const side of [-1, 1]) {
        box(shared, shared.rubberTrimMat, 0.07, hgt * 0.31, len * 0.145,
          side * wid * 0.502, hgt * 0.78, len * z, bodyG);
        box(shared, shared.busWindowMat, 0.076, hgt * 0.245, len * 0.125,
          side * wid * 0.508, hgt * 0.78, len * z, bodyG);
      }
    }
    box(shared, shared.stripeMat, wid * 1.018, hgt * 0.115, len * 0.985, 0, hgt * 0.43, 0, bodyG);
    box(shared, shared.rubberTrimMat, wid * 0.88, hgt * 0.25, 0.065,
      0, hgt * 0.78, len * 0.5 + 0.025, bodyG);
    box(shared, shared.busWindowMat, wid * 0.76, hgt * 0.18, 0.07,
      0, hgt * 0.8, len * 0.5 + 0.06, bodyG);
    box(shared, shared.busRouteMat, wid * 0.53, 0.18, 0.075,
      0, hgt * 0.985, len * 0.5 + 0.065, bodyG);
    box(shared, shared.busWindowMat, wid * 0.74, hgt * 0.2, 0.065,
      0, hgt * 0.79, -len * 0.5 - 0.05, bodyG);
    // Right-side double doors and rooftop HVAC are the large identity cues
    // that keep this readable as a Muni coach rather than a generic long box.
    for (const doorZ of [len * 0.29, -len * 0.26]) {
      box(shared, shared.rubberTrimMat, 0.06, hgt * 0.54, 1.22,
        wid * 0.51, hgt * 0.54, doorZ, bodyG);
      box(shared, shared.busWindowMat, 0.065, hgt * 0.32, 0.48,
        wid * 0.515, hgt * 0.68, doorZ - 0.28, bodyG);
      box(shared, shared.busWindowMat, 0.065, hgt * 0.32, 0.48,
        wid * 0.515, hgt * 0.68, doorZ + 0.28, bodyG);
    }
    roundedBox(shared, shared.roofEquipmentMat, wid * 0.58, 0.18, len * 0.24,
      0, hgt * 1.02, -len * 0.08, bodyG);
    box(shared, shared.rubberTrimMat, wid * 0.42, 0.025, len * 0.17,
      0, hgt * 1.12, -len * 0.08, bodyG);
    box(shared, shared.destinationMat, 0.065, 0.15, len * 0.2,
      -wid * 0.514, hgt * 0.92, len * 0.18, bodyG);
    for (const side of [-1, 1]) {
      const logo = new THREE.Mesh(new THREE.PlaneGeometry(1.62, 0.38), shared.busLogoMat);
      logo.name = 'Muni agency side mark';
      logo.position.set(side * wid * 0.52, hgt * 0.56, -len * 0.02);
      logo.rotation.y = side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
      logo.userData.noShadow = true;
      logo.userData.noReceiveShadow = true;
      bodyG.add(logo);
    }
    // A rear route display and vertical corner markers keep a close rear view
    // legible as a Muni coach instead of an unbroken dark window slab.
    box(shared, shared.busRouteMat, wid * 0.48, 0.16, 0.075,
      0, hgt * 0.91, -len * 0.5 - 0.06, bodyG);
    for (const side of [-1, 1]) {
      box(shared, shared.stripeMat, 0.08, hgt * 0.38, 0.075,
        side * wid * 0.43, hgt * 0.56, -len * 0.5 - 0.055, bodyG);
    }
    for (const side of [-1, 1]) {
      box(shared, shared.rubberTrimMat, 0.045, 0.16, len * 0.74,
        side * wid * 0.507, hgt * 0.25, 0, bodyG);
    }
    addWheel(-wid * 0.46, len * 0.36, wheelR, true);
    addWheel(wid * 0.46, len * 0.36, wheelR, true);
    addWheel(-wid * 0.46, -len * 0.32, wheelR);
    addWheel(wid * 0.46, -len * 0.32, wheelR);
  }

  // Commercial identity is carried by a single shared side label per flank,
  // not unique geometry or materials per actor. Private cars retain their
  // varied paint and class silhouettes; fleet vehicles get marks readable
  // from a sidewalk camera without multiplying detail across all 40 actors.
  let identityBadge = null;
  let badgeWidth = 0;
  let badgeHeight = 0;
  let badgeY = 0;
  let badgeZ = 0;
  if (identity.key === 'sf-taxi') {
    identityBadge = shared.taxiBadgeMat;
    badgeWidth = 0.82;
    badgeHeight = 0.3;
    badgeY = hgt * 0.52;
    badgeZ = -len * 0.08;
  } else if (identity.key === 'sfmta-service') {
    identityBadge = shared.sfmtaServiceMat;
    badgeWidth = 1.55;
    badgeHeight = 0.48;
    badgeY = hgt * 0.57;
    badgeZ = -len * 0.1;
  } else if (identity.key === 'city-service') {
    identityBadge = shared.cityServiceMat;
    badgeWidth = 0.9;
    badgeHeight = 0.42;
    badgeY = hgt * 0.62;
    badgeZ = len * 0.18;
  } else if (identity.key === 'local-delivery') {
    identityBadge = shared.deliveryBadgeMat;
    badgeWidth = cls === 'truck' ? 2.45 : 1.65;
    badgeHeight = cls === 'truck' ? 0.72 : 0.52;
    badgeY = cls === 'truck' ? hgt * 0.64 : hgt * 0.58;
    badgeZ = cls === 'truck' ? -len * 0.12 : -len * 0.11;
  }
  if (identityBadge) {
    for (const side of [-1, 1]) {
      sideBadge(
        shared,
        identityBadge,
        badgeWidth,
        badgeHeight,
        side * wid * 0.514,
        badgeY,
        badgeZ,
        bodyG,
        `${identity.label} side mark`,
      );
    }
    // The hero lens is predominantly head-on. A restrained front placard
    // keeps taxi/service identity readable without turning every fleet unit
    // into a billboard or adding a unique material per actor.
    if (identity.key === 'sf-taxi') {
      frontBadge(
        shared,
        identityBadge,
        0.56,
        0.18,
        0,
        hgt * 0.6,
        len * 0.5 + 0.045,
        bodyG,
        `${identity.label} front mark`,
      );
    } else if (identity.key === 'sfmta-service') {
      frontBadge(
        shared,
        identityBadge,
        0.92,
        0.26,
        0,
        hgt * 0.65,
        len * 0.5 + 0.045,
        bodyG,
        `${identity.label} front mark`,
      );
    } else if (identity.key === 'city-service') {
      frontBadge(
        shared,
        identityBadge,
        0.7,
        0.24,
        0,
        hgt * 0.62,
        len * 0.5 + 0.045,
        bodyG,
        `${identity.label} front mark`,
      );
    }
  }
  if (identity.curbService === 'service') {
    const beaconY = cls === 'pickup' ? hgt * 1.02 : hgt * 1.01;
    const beaconZ = cls === 'pickup' ? len * 0.17 : len * 0.12;
    beaconLights.push(box(
      shared,
      shared.beaconOffMat,
      0.34,
      0.13,
      0.22,
      0,
      beaconY,
      beaconZ,
      bodyG,
    ));
  }

  // Any eligible fleet car can be recruited as a live law responder. Keep
  // the kit dormant during ordinary traffic duty, then reveal a shared SFPD
  // placard and alternating emergency lamps while the vehicle is assigned.
  // The group lives on the root so its authority cue remains visible when the
  // detailed body swaps to the distance silhouette.
  let pursuitKit = null;
  const pursuitLights = { red: [], blue: [] };
  if (!['bike', 'bus', 'truck', 'taxi'].includes(cls)) {
    pursuitKit = new THREE.Group();
    pursuitKit.name = 'SFPD pursuit response kit';
    pursuitKit.visible = false;
    const roofY = hgt * (cls === 'pickup' || cls === 'van' ? 1.06 : 1.08);
    const roofZ = cls === 'pickup' ? len * 0.15 : len * 0.04;
    box(shared, shared.lightHousingMat, Math.min(1.08, wid * 0.62), 0.055, 0.22,
      0, roofY, roofZ, pursuitKit);
    pursuitLights.red.push(box(
      shared,
      shared.pursuitRedOffMat,
      Math.min(0.42, wid * 0.23),
      0.13,
      0.18,
      -Math.min(0.27, wid * 0.17),
      roofY + 0.055,
      roofZ,
      pursuitKit,
    ));
    pursuitLights.blue.push(box(
      shared,
      shared.pursuitBlueOffMat,
      Math.min(0.42, wid * 0.23),
      0.13,
      0.18,
      Math.min(0.27, wid * 0.17),
      roofY + 0.055,
      roofZ,
      pursuitKit,
    ));
    const grilleY = Math.max(0.42, hgt * 0.48);
    pursuitLights.red.push(box(
      shared,
      shared.pursuitRedOffMat,
      0.16,
      0.09,
      0.055,
      -wid * 0.18,
      grilleY,
      len * 0.5 + 0.08,
      pursuitKit,
    ));
    pursuitLights.blue.push(box(
      shared,
      shared.pursuitBlueOffMat,
      0.16,
      0.09,
      0.055,
      wid * 0.18,
      grilleY,
      len * 0.5 + 0.08,
      pursuitKit,
    ));
    const pursuitBadgeWidth = identity.key === 'sfmta-service' ? 1.68 : 1.12;
    const pursuitBadgeHeight = identity.key === 'sfmta-service' ? 0.52 : 0.4;
    for (const side of [-1, 1]) {
      sideBadge(
        shared,
        shared.pursuitBadgeMat,
        pursuitBadgeWidth,
        pursuitBadgeHeight,
        side * wid * 0.526,
        identity.key === 'sfmta-service' ? hgt * 0.57 : hgt * 0.58,
        identity.key === 'sfmta-service' ? -len * 0.1 : 0,
        pursuitKit,
        'SFPD pursuit side mark',
      );
    }
    frontBadge(
      shared,
      shared.pursuitBadgeMat,
      Math.min(0.96, wid * 0.58),
      0.28,
      0,
      hgt * 0.64,
      len * 0.5 + 0.09,
      pursuitKit,
      'SFPD pursuit front mark',
    );
    pursuitKit.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = false;
      child.receiveShadow = child.userData.noReceiveShadow !== true;
      child.updateMatrix();
      child.matrixAutoUpdate = false;
    });
    root.add(pursuitKit);
  }

  // Small manufactured details give the pooled traffic a shared automotive
  // language with the authored hero car: bumpers, mirrors, window breaks and
  // a low belt line are visible even when a vehicle is several car lengths
  // away. They stay on the shared unit geometry to keep the pool inexpensive.
  // Bikes keep the diamond-frame assembly above and skip car fascia language.
  const tailLights = [];
  const rearIndicatorLeft = [];
  const rearIndicatorRight = [];
  const indicatorLeft = [];
  const indicatorRight = [];
  if (cls !== 'bike') {
  if (cls === 'sedan' || cls === 'taxi') {
    for (const side of [-1, 1]) {
      const chassisRail = box(
        shared, shared.underbodyMat,
        wid * 0.07, 0.13, len * 0.76,
        side * wid * 0.44, wheelR * 0.72, 0, bodyG,
      );
      chassisRail.name = `${cls} underbody side rail`;
    }
  } else {
    box(shared, shared.underbodyMat, wid * 0.78, 0.13, len * 0.76, 0, wheelR * 0.72, 0, bodyG);
  }
  if (cls !== 'bus' && cls !== 'truck') {
    // Roof antenna fin seated on each class's actual cabin roof, plus a
    // single exhaust tip: the small manufactured cues that keep the light
    // vehicles reading as automobiles rather than painted blocks at range.
    const roofAnchor = cls === 'pickup' ? [hgt * 0.79, len * 0.13]
      : cls === 'van' ? [hgt * 0.96, len * 0.18]
        : cls === 'suv' ? [hgt, -len * 0.14]
          : [hgt, -len * 0.16];
    box(shared, shared.mirrorMat, 0.1, 0.075, 0.17, 0, roofAnchor[0] + 0.01, roofAnchor[1], bodyG);
    box(shared, shared.trimMat, 0.1, 0.07, 0.14, -wid * 0.27, Math.max(0.22, wheelR * 0.66), -len / 2 - 0.02, bodyG);
  }
  if (cls === 'sedan' || cls === 'taxi') {
    box(shared, shared.trimMat, wid * 0.82, 0.07, 0.08, 0, hgt * 0.2, -len * 0.5 - 0.025, bodyG);
    box(shared, shared.trimMat, wid * 0.82, 0.07, 0.08, 0, hgt * 0.2, len * 0.5 + 0.025, bodyG);
    // Front fascia: grille bar between the lamps and a slim lower intake keep
    // the nose from reading as a blank painted wall at street level.
    box(shared, shared.grilleMat, wid * 0.4, 0.09, 0.05, 0, hgt * 0.5, len * 0.5 + 0.01, bodyG);
    box(shared, shared.grilleMat, wid * 0.52, 0.06, 0.05, 0, hgt * 0.28, len * 0.5 + 0.012, bodyG);
    box(shared, shared.mirrorMat, 0.12, 0.12, 0.24, -wid * 0.56, hgt * 0.7, -len * 0.08, bodyG);
    box(shared, shared.mirrorMat, 0.12, 0.12, 0.24, wid * 0.56, hgt * 0.7, -len * 0.08, bodyG);
    box(shared, shared.trimMat, 0.06, 0.06, len * 0.38, -wid * 0.505, hgt * 0.34, 0, bodyG);
    box(shared, shared.trimMat, 0.06, 0.06, len * 0.38, wid * 0.505, hgt * 0.34, 0, bodyG);
    for (const side of [-1, 1]) {
      box(shared, shared.trimMat, 0.04, 0.045, 0.2,
        side * wid * 0.512, hgt * 0.58, -len * 0.1, bodyG);
    }
  } else if (cls === 'suv' || cls === 'pickup' || cls === 'van' || cls === 'truck') {
    box(shared, shared.trimMat, wid * 0.82, 0.08, 0.1, 0, hgt * 0.18, -len * 0.5 - 0.03, bodyG);
    if (cls === 'suv') {
      // Upright grille and high bumper distinguish the SUV from the lower,
      // wider sedan even when the paint color happens to match.
      box(shared, shared.grilleMat, wid * 0.56, hgt * 0.11, 0.055,
        0, hgt * 0.47, len * 0.5 + 0.012, bodyG);
      box(shared, shared.trimMat, wid * 0.82, 0.075, 0.07,
        0, hgt * 0.28, len * 0.5 + 0.02, bodyG);
    } else if (cls === 'pickup') {
      // A broad grille and exposed tailgate break make the utility bed read
      // as a pickup instead of a sedan with a square rear overhang.
      box(shared, shared.grilleMat, wid * 0.62, hgt * 0.14, 0.055,
        0, hgt * 0.46, len * 0.5 + 0.012, bodyG);
      box(shared, shared.trimMat, wid * 0.72, 0.055, 0.055,
        0, hgt * 0.62, -len * 0.5 - 0.025, bodyG);
    } else if (cls === 'van') {
      box(shared, shared.grilleMat, wid * 0.48, hgt * 0.1, 0.055,
        0, hgt * 0.35, len * 0.5 + 0.012, bodyG);
      box(shared, shared.trimMat, wid * 0.76, 0.06, 0.055,
        0, hgt * 0.7, -len * 0.5 - 0.022, bodyG);
    } else { // truck
      box(shared, shared.grilleMat, wid * 0.58, hgt * 0.12, 0.055,
        0, hgt * 0.48, len * 0.5 + 0.014, bodyG);
      box(shared, shared.trimMat, wid * 0.76, 0.085, 0.075,
        0, hgt * 0.24, len * 0.5 + 0.022, bodyG);
      // Cab-roof clearance lamps give the freight silhouette its DOT
      // signature, readable from behind and above in traffic.
      for (const lampX of [-0.56, -0.28, 0, 0.28, 0.56]) {
        box(shared, shared.indicatorOffMat, 0.09, 0.06, 0.07,
          lampX, hgt * 0.95, len * 0.5 - 0.24, bodyG);
      }
    }
    const utilityMirrorOffset = cls === 'pickup' ? wid * 0.47 : wid * 0.56;
    box(shared, shared.mirrorMat, 0.14, 0.18, 0.28, -utilityMirrorOffset, hgt * 0.72, len * 0.23, bodyG);
    box(shared, shared.mirrorMat, 0.14, 0.18, 0.28, utilityMirrorOffset, hgt * 0.72, len * 0.23, bodyG);
  } else {
    box(shared, shared.trimMat, wid * 0.84, 0.09, 0.1, 0, hgt * 0.18, -len * 0.5 - 0.04, bodyG);
    box(shared, shared.trimMat, wid * 0.84, 0.09, 0.1, 0, hgt * 0.2, len * 0.5 + 0.04, bodyG);
  }

  // Shared on/off materials keep lighting state readable without allocating
  // unique shader materials for every pooled vehicle.
  const ly = Math.min(hgt * 0.55, 0.9);
  for (const side of [-1, 1]) {
    box(shared, shared.lightHousingMat, wid * 0.225, 0.155, 0.05,
      side * wid * 0.32, ly, len / 2 + 0.005, bodyG);
    box(shared, shared.headMat, wid * 0.155, 0.095, 0.06,
      side * wid * 0.32, ly, len / 2 + 0.035, bodyG);
  }
  for (const side of [-1, 1]) {
    box(shared, shared.lightHousingMat, wid * 0.215, 0.155, 0.05,
      side * wid * 0.34, ly, -len / 2 - 0.005, bodyG);
    const rearLamp = box(shared, shared.tailOffMat, wid * 0.135, 0.095, 0.06,
      side * wid * 0.34, ly, -len / 2 - 0.035, bodyG);
    tailLights.push(rearLamp);
    (side < 0 ? rearIndicatorLeft : rearIndicatorRight).push(rearLamp);
    box(shared, shared.reverseMat, wid * 0.055, 0.055, 0.065,
      side * wid * 0.22, ly, -len / 2 - 0.04, bodyG);
  }
  if (cls === 'sedan' || cls === 'taxi') {
    tailLights.push(box(shared, shared.tailOffMat, wid * 0.34, 0.055, 0.055, 0, hgt * 0.86, -len / 2 - 0.015, bodyG));
  } else if (cls === 'suv') {
    for (const side of [-1, 1]) {
      tailLights.push(box(shared, shared.tailOffMat, 0.09, hgt * 0.19, 0.06,
        side * wid * 0.39, hgt * 0.63, -len / 2 - 0.04, bodyG));
    }
  } else if (cls === 'pickup') {
    for (const side of [-1, 1]) {
      tailLights.push(box(shared, shared.tailOffMat, wid * 0.17, hgt * 0.08, 0.06,
        side * wid * 0.31, hgt * 0.57, -len / 2 - 0.04, bodyG));
    }
  } else if (cls === 'van') {
    for (const side of [-1, 1]) {
      tailLights.push(box(shared, shared.tailOffMat, 0.08, hgt * 0.22, 0.06,
        side * wid * 0.39, hgt * 0.63, -len / 2 - 0.04, bodyG));
    }
  } else if (cls === 'truck') {
    for (const side of [-1, 1]) {
      tailLights.push(box(shared, shared.tailOffMat, wid * 0.15, hgt * 0.08, 0.06,
        side * wid * 0.31, hgt * 0.5, -len / 2 - 0.04, bodyG));
    }
  } else if (cls === 'bus') {
    for (const side of [-1, 1]) {
      tailLights.push(box(shared, shared.tailOffMat, wid * 0.105, 0.16, 0.06,
        side * wid * 0.37, hgt * 0.69, -len / 2 - 0.04, bodyG));
    }
  }
  box(shared, shared.plateMat, Math.min(0.62, wid * 0.42), 0.11, 0.035, 0, Math.max(0.42, ly - 0.12), -len / 2 - 0.045, bodyG);
  box(shared, shared.plateMat, Math.min(0.62, wid * 0.42), 0.11, 0.035, 0, Math.max(0.42, ly - 0.12), len / 2 + 0.045, bodyG);
  box(shared, shared.grilleMat, wid * 0.38, 0.1, 0.045, 0, Math.max(0.35, ly - 0.14), len / 2 + 0.045, bodyG);
  // Front repeaters beside the headlamps make a pending turn legible to a
  // camera looking at oncoming traffic, not only from the flank.
  indicatorLeft.push(box(shared, shared.indicatorOffMat, 0.1, 0.06, 0.06, -wid * 0.44, ly, len / 2 + 0.03, bodyG));
  indicatorRight.push(box(shared, shared.indicatorOffMat, 0.1, 0.06, 0.06, wid * 0.44, ly, len / 2 + 0.03, bodyG));
  indicatorLeft.push(box(shared, shared.indicatorOffMat, 0.065, 0.1, 0.15, -wid / 2 - 0.01, ly, len * 0.32, bodyG));
  indicatorRight.push(box(shared, shared.indicatorOffMat, 0.065, 0.1, 0.15, wid / 2 + 0.01, ly, len * 0.32, bodyG));
  } // end non-bike automotive fascia / lighting

  // Continuous local-player embodiment sockets. They are authored on the
  // ordinary traffic root, so the seat and door follow the exact settled car
  // transform without creating a second vehicle authority. AI leaves both
  // pivots at zero/closed; main animates only the active player's selected
  // side during its bounded ingress/egress presentation.
  let embodiment = null;
  if (identity.category === 'private' && ['sedan', 'suv', 'pickup', 'van'].includes(cls)) {
    const seatY = cls === 'sedan' ? 0.23 : cls === 'suv' ? 0.46 : cls === 'pickup' ? 0.52 : 0.66;
    const seatZ = cls === 'pickup' || cls === 'van' ? len * 0.17 : len * 0.035;
    const doorHeight = Math.min(1.14, hgt * 0.62);
    const doorLength = Math.min(1.35, len * 0.3);
    const doors = {};
    const seats = {};
    for (const side of [-1, 1]) {
      const sideKey = side < 0 ? 'left' : 'right';
      const seat = new THREE.Object3D();
      seat.name = `Traveler ${sideKey} driver seat socket`;
      seat.position.set(0, seatY, seatZ);
      bodyG.add(seat);

      const pivot = new THREE.Group();
      pivot.name = `Traveler ${sideKey} driver door pivot`;
      pivot.userData.vehicleEmbodimentDoor = true;
      pivot.userData.apertureAngle = 0;
      pivot.userData.traversal = 0;
      pivot.position.set(side * wid * 0.505, hgt * 0.5, seatZ + doorLength * 0.5);
      const aperture = box(
        shared,
        shared.interiorMat,
        0.035,
        doorHeight * 0.92,
        doorLength * 0.92,
        side * wid * 0.499,
        hgt * 0.5,
        seatZ,
        bodyG,
      );
      aperture.name = `Traveler ${sideKey} driver door dark aperture`;
      aperture.visible = false;
      aperture.userData.vehicleEmbodimentAperture = true;
      const panel = roundedBox(
        shared,
        paint,
        0.055,
        doorHeight,
        doorLength,
        0,
        0,
        -doorLength * 0.5,
        pivot,
      );
      panel.name = `Traveler ${sideKey} driver door panel`;
      panel.userData.vehicleEmbodimentDoorPanel = true;
      bodyG.add(pivot);
      seats[sideKey] = seat;
      doors[sideKey] = { pivot, panel, aperture, side, angle: 0 };
    }
    embodiment = {
      class: cls,
      halfWidth: wid * 0.5,
      halfLength: len * 0.5,
      cabin: {
        centerY: hgt * (cls === 'van' ? 0.7 : 0.62),
        halfWidth: wid * 0.43,
        halfHeight: hgt * (cls === 'van' ? 0.3 : 0.22),
        halfLength: len * (cls === 'pickup' ? 0.17 : cls === 'van' ? 0.2 : 0.25),
      },
      seats,
      doors,
    };
    root.userData.vehicleEmbodiment = embodiment;
  }

  bodyG.traverse((child) => {
    if (!child.isMesh) return;
    // Bikes are cheap enough to cast; the car fleet keeps contact discs so
    // the sun atlas is not flooded by forty multi-mesh vehicles.
    child.castShadow = cls === 'bike';
    child.receiveShadow = child.userData.noReceiveShadow !== true;
    child.updateMatrix();
    child.matrixAutoUpdate = false;
  });

  return {
    root,
    bodyG,
    wheelG,
    proxyBody,
    proxyCueG,
    wheels,
    frontWheels,
    beaconLights,
    pursuitKit,
    pursuitLights,
    tailLights,
    rearIndicatorLeft,
    rearIndicatorRight,
    indicatorLeft,
    indicatorRight,
    tailOffMat: shared.tailOffMat,
    tailBrakeMat: shared.tailBrakeMat,
    indicatorOffMat: shared.indicatorOffMat,
    indicatorOnMat: shared.indicatorOnMat,
    wiperPivot,
    embodiment,
    // Keep the former material keys wired during Vite hot reloads so an
    // already-running update closure cannot dereference a missing material.
    tailMat: shared.tailOffMat,
    indMat: shared.indicatorOffMat,
    wheelR,
  };
}

/* ---------------- class mix ---------------- */

function pickColor(rng) {
  let r = rng(), acc = 0;
  for (const e of BODY_PALETTE) { acc += e.w; if (r <= acc) return e.c; }
  return BODY_PALETTE[0].c;
}

function readableBodyColor(hex, cls) {
  if (cls === 'taxi' || cls === 'bus' || cls === 'bike') return hex;
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum >= 0.24) return hex;
  const lift = 0.24 / Math.max(lum, 0.08);
  const rr = Math.min(255, Math.round(r * lift));
  const gg = Math.min(255, Math.round(g * lift));
  const bb = Math.min(255, Math.round(b * lift));
  return (rr << 16) | (gg << 8) | bb;
}

function addProxyClassCue(shared, root, cls, spec, paint) {
  const proxyCueG = new THREE.Group();
  proxyCueG.name = 'Traffic distance class cue';
  proxyCueG.visible = false;
  const { wid, hgt, len, wheelR } = spec;
  if (cls !== 'bike') {
    const proxyWheelRadius = wheelR;
    const frontZ = len * (cls === 'bus' ? 0.36 : cls === 'truck' ? 0.35 : 0.32);
    const rearZ = -len * (cls === 'bus' ? 0.32 : cls === 'truck' ? 0.26 : 0.32);
    for (const z of [frontZ, rearZ]) {
      for (const side of [-1, 1]) {
        const wheel = new THREE.Mesh(shared.unitWheel, shared.tireMat);
        wheel.name = 'Connected proxy wheel';
        wheel.scale.set(Math.min(0.3, Math.max(0.2, wid * 0.125)), proxyWheelRadius, proxyWheelRadius);
        wheel.position.set(side * wid * 0.447, proxyWheelRadius, z);
        wheel.castShadow = false;
        wheel.receiveShadow = true;
        proxyCueG.add(wheel);
      }
    }
  }
  if (cls === 'bike') {
    box(shared, paint, wid * 0.35, hgt * 0.08, len * 0.72,
      0, hgt * 0.48, 0, proxyCueG);
  } else if (cls === 'bus') {
    roundedBox(shared, shared.windowMat, wid * 0.86, hgt * 0.26, len * 0.84,
      0, hgt * 0.76, 0, proxyCueG);
    roundedBox(shared, shared.bodyMat(BUS_STRIPE), wid * 0.92, hgt * 0.1, len * 0.94,
      0, hgt * 0.58, 0, proxyCueG);
    frontBadge(shared, shared.busRouteMat, wid * 0.34, hgt * 0.12, 0, hgt * 0.66, len * 0.47, proxyCueG,
      'Pooled Muni route board');
  } else if (cls === 'taxi') {
    taperedBox(shared, shared.sedanCabin, shared.windowMat,
      wid * 0.9, hgt * 0.28, len * 0.52, 0, hgt * 0.66, -len * 0.02, proxyCueG);
    box(shared, shared.signMat, wid * 0.42, hgt * 0.12, len * 0.22,
      0, hgt * 0.92, -len * 0.04, proxyCueG);
    for (const side of [-1, 1]) {
      box(shared, shared.taxiTrimMat, 0.03, hgt * 0.08, len * 0.72,
        side * wid * 0.5, hgt * 0.48, 0, proxyCueG);
    }
  } else if (cls === 'truck') {
    roundedBox(shared, shared.bodyMat(0xf0ede6), wid * 0.94, hgt * 0.66, len * 0.64,
      0, hgt * 0.58, -len * 0.13, proxyCueG);
    taperedBox(shared, shared.utilityCabin, shared.windowMat,
      wid * 0.82, hgt * 0.25, len * 0.2, 0, hgt * 0.7, len * 0.33, proxyCueG);
  } else if (cls === 'van') {
    roundedBox(shared, paint, wid * 0.92, hgt * 0.42, len * 0.88,
      0, hgt * 0.68, -len * 0.02, proxyCueG);
    taperedBox(shared, shared.utilityCabin, shared.windowMat,
      wid * 0.84, hgt * 0.25, len * 0.28, 0, hgt * 0.78, len * 0.28, proxyCueG);
  } else if (cls === 'pickup') {
    taperedBox(shared, shared.utilityCabin, shared.windowMat,
      wid * 0.82, hgt * 0.28, len * 0.3, 0, hgt * 0.68, len * 0.18, proxyCueG);
    for (const side of [-1, 1]) {
      box(shared, paint, 0.12, hgt * 0.28, len * 0.34,
        side * wid * 0.42, hgt * 0.54, -len * 0.28, proxyCueG);
    }
  } else if (cls === 'suv') {
    taperedBox(shared, shared.suvCabin, shared.windowMat,
      wid * 0.84, hgt * 0.46, len * 0.56, 0, hgt * 0.8, -len * 0.04, proxyCueG);
    box(shared, shared.roofEquipmentMat, wid * 0.42, hgt * 0.05, len * 0.52,
      0, hgt * 1.06, -len * 0.03, proxyCueG);
  } else {
    taperedBox(shared, shared.sedanCabin, shared.windowMat,
      wid * 0.9, hgt * 0.28, len * 0.52, 0, hgt * 0.66, -len * 0.02, proxyCueG);
  }
  root.add(proxyCueG);
  return proxyCueG;
}

function buildClassList(rng, count) {
  // Seed the fleet with one Muni coach, cabs, and a few bikes, then bias the
  // remainder toward sedans/SUVs with a light taxi/bike presence. Freight is a
  // small share: box trucks on every block read as a distribution yard.
  const list = ['bus', 'taxi', 'taxi', 'bike', 'bike', 'bike', 'truck', 'truck', 'van', 'van', 'pickup', 'suv', 'suv'];
  while (list.length < count) {
    const r = rng();
    list.push(
      r < 0.42 ? 'sedan'
        : r < 0.62 ? 'suv'
          : r < 0.72 ? 'van'
            : r < 0.8 ? 'pickup'
              : r < 0.88 ? 'taxi'
                : r < 0.94 ? 'bike'
                  : 'truck',
    );
  }
  // deterministic shuffle
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  return list.slice(0, count);
}

/* ---------------- factory ---------------- */

export function createTrafficSystem({
  scene,
  roadNetwork,
  fleetSize,
  onPlayerTrafficViolation,
  onPlayerVehicleCollision,
  onPlayerOnFootVehicleContact,
  canRepairPlayerVehicle,
} = {}) {
  const group = new THREE.Group();
  group.name = 'traffic';
  if (scene && typeof scene.add === 'function') scene.add(group);

  const rng = mulberry32(SEED);
  const { roads, nodes, signalPlans, turnRules } = normalizeNetwork(roadNetwork);
  const signals = buildSignals(nodes, signalPlans);
  const vehicles = [];
  const stats = {
    active: 0,
    visible: 0,
    avgSpeed: 0,
    signalPhase: signals.size ? 'green' : 'off',
  };
  const diagnostics = {
    classMix: {},
    identityMix: {},
    elapsed: 0,
    maxInputDt: 0,
    dtClampCount: 0,
    invalidDtCount: 0,
    minLaneGap: null,
    minMovingHeadway: null,
    minStoppedGap: null,
    minTurnRadius: null,
    worstHeadway: null,
    maxAcceleration: 0,
    maxDeceleration: 0,
    maxJerk: 0,
    meanSpeed: 0,
    moving: 0,
    queued: 0,
    maxQueued: 0,
    signalQueued: 0,
    turning: 0,
    routeTransitions: 0,
    uTurnStarts: 0,
    uTurnTransitions: 0,
    signalStops: 0,
    greenReleases: 0,
    stopSignStops: 0,
    stopSignReleases: 0,
    oneWayRejects: 0,
    illegalTurnRejects: 0,
    safetyClamps: 0,
    maxSafetyCorrection: 0,
    weather: 'clear',
    curbPullOuts: 0,
    busStopDwells: 0,
    taxiPickups: 0,
    serviceStops: 0,
    deliveryStops: 0,
    vehicleDamageEvents: 0,
    collisionDamageEvents: 0,
    recklessCollisionEvents: 0,
    lastPlayerCollision: null,
    disabledVehicles: 0,
    vehicleRepairs: 0,
    vehicleThefts: 0,
    playerRedLightViolations: 0,
    pedestrianImpactEvents: 0,
    sweptVehicleCollisionTests: 0,
    sweptVehicleCollisionEvents: 0,
    sweptVehicleNearMisses: 0,
    lastSweptVehicleCollision: null,
    onFootVehicleContactTests: 0,
    onFootVehicleContacts: 0,
    onFootVehicleCorrections: 0,
    onFootVehicleBlockingContacts: 0,
    onFootVehicleDamageContacts: 0,
    lastOnFootVehicleContact: null,
    lastOnFootVehicleCorrection: null,
    pursuitRouteDecisions: 0,
    pursuitRouteFallbacks: 0,
    lastPursuitRouteDecision: null,
  };
  let playerVehicle = null;
  let lastPlayerParkedVehicle = null;
  let impoundedPlayerVehicle = null;
  const playerGarageSlots = [null, null];
  let playerGarageRetrieveCursor = 0;
  let taxiRide = null;
  let muniRide = null;
  let playerSignalViolationLatch = null;
  let playerPedestrianImpactProbe = null;
  let playerPedestrianImpactLatch = new Set();
  let playerVehicleCollisionLatch = new Set();
  let onFootPlayerCollisionProbe = null;
  let onFootVehicleCollisionLatch = new Set();
  let onFootVehicleImpactQaStage = null;
  let vehicleEmbodimentQaHold = null;
  const playerInput = { throttle: 0, brake: 0, steer: 0 };
  let shared = null;
  let focusActive = false;
  let focusX = 0;
  let focusZ = 0;
  let focusRadiusSquared = Infinity;
  const pursuitResponder = {
    active: false,
    targetIndex: -1,
    targetIndexes: [],
    playerVehicleId: null,
    playerX: 0,
    playerZ: 0,
    level: 1,
    distance: null,
  };
  const pursuitBookingVisual = {
    vehicleIndex: -1,
    until: 0,
  };
  const pursuitDeploymentHoldIds = new Set();
  const pursuitDeploymentHoldingIds = new Set();

  function damageStateFor(vehicle) {
    if (vehicle.disabled || vehicle.health <= 0) return 'disabled';
    const ratio = vehicle.health / Math.max(1, vehicle.maxHealth);
    if (ratio <= 0.28) return 'critical';
    if (ratio <= 0.68) return 'damaged';
    return 'clear';
  }

  function distanceSquaredToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= 1e-8) {
      return (point.x - start.x) ** 2 + (point.z - start.z) ** 2;
    }
    const along = THREE.MathUtils.clamp(
      ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared,
      0,
      1,
    );
    const closestX = start.x + dx * along;
    const closestZ = start.z + dz * along;
    return (point.x - closestX) ** 2 + (point.z - closestZ) ** 2;
  }

  function footprintAxes(heading = 0) {
    const forward = { x: Math.sin(heading), z: Math.cos(heading) };
    return {
      forward,
      right: { x: forward.z, z: -forward.x },
    };
  }

  function footprintsOverlap(left, right, margin = 0.04) {
    const leftAxes = footprintAxes(left.heading);
    const rightAxes = footprintAxes(right.heading);
    const dx = right.x - left.x;
    const dz = right.z - left.z;
    const axes = [leftAxes.forward, leftAxes.right, rightAxes.forward, rightAxes.right];
    for (const axis of axes) {
      const centerDistance = Math.abs(dx * axis.x + dz * axis.z);
      const leftRadius = left.halfLength * Math.abs(
        leftAxes.forward.x * axis.x + leftAxes.forward.z * axis.z,
      ) + left.halfWidth * Math.abs(
        leftAxes.right.x * axis.x + leftAxes.right.z * axis.z,
      );
      const rightRadius = right.halfLength * Math.abs(
        rightAxes.forward.x * axis.x + rightAxes.forward.z * axis.z,
      ) + right.halfWidth * Math.abs(
        rightAxes.right.x * axis.x + rightAxes.right.z * axis.z,
      );
      if (centerDistance > leftRadius + rightRadius + margin) return false;
    }
    return true;
  }

  function aabbFootprintSatClearance(bounds, footprint) {
    if (!Number.isFinite(bounds?.min?.x)
      || !Number.isFinite(bounds?.min?.z)
      || !Number.isFinite(bounds?.max?.x)
      || !Number.isFinite(bounds?.max?.z)) return null;
    const center = {
      x: (bounds.min.x + bounds.max.x) * 0.5,
      z: (bounds.min.z + bounds.max.z) * 0.5,
    };
    const half = {
      x: Math.max(0, (bounds.max.x - bounds.min.x) * 0.5),
      z: Math.max(0, (bounds.max.z - bounds.min.z) * 0.5),
    };
    const footprintBasis = footprintAxes(footprint.heading);
    const axes = [
      { x: 1, z: 0 },
      { x: 0, z: 1 },
      footprintBasis.forward,
      footprintBasis.right,
    ];
    const dx = center.x - footprint.x;
    const dz = center.z - footprint.z;
    let greatestAxisGap = -Infinity;
    for (const axis of axes) {
      const centerDistance = Math.abs(dx * axis.x + dz * axis.z);
      const bodyRadius = half.x * Math.abs(axis.x) + half.z * Math.abs(axis.z);
      const vehicleRadius = footprint.halfLength * Math.abs(
        footprintBasis.forward.x * axis.x + footprintBasis.forward.z * axis.z,
      ) + footprint.halfWidth * Math.abs(
        footprintBasis.right.x * axis.x + footprintBasis.right.z * axis.z,
      );
      greatestAxisGap = Math.max(greatestAxisGap, centerDistance - bodyRadius - vehicleRadius);
    }
    return greatestAxisGap;
  }

  function interpolateHeading(start, end, amount) {
    const delta = Math.atan2(Math.sin(end - start), Math.cos(end - start));
    return start + delta * amount;
  }

  function vehicleFootprint(vehicle, pose) {
    return {
      x: pose.x,
      z: pose.z,
      heading: Number.isFinite(pose.heading) ? pose.heading : 0,
      halfLength: vehicle.spec.len * 0.5,
      halfWidth: vehicle.spec.wid * 0.5,
    };
  }

  function onFootVehicleFootprint(vehicle, pose) {
    const footprint = vehicleFootprint(vehicle, pose);
    footprint.halfLength += ON_FOOT_VEHICLE_SHELL_LENGTH_PAD;
    footprint.halfWidth += ON_FOOT_VEHICLE_SHELL_WIDTH_PAD;
    return footprint;
  }

  function sweptFootprintContact(player, playerStart, other, otherStart) {
    const playerEnd = player.mesh.root.position;
    const otherEnd = other.mesh.root.position;
    const playerHeading = Number.isFinite(player.heading) ? player.heading : playerStart.heading;
    const otherHeading = Number.isFinite(other.heading) ? other.heading : otherStart.heading;
    const playerTravel = Math.hypot(playerEnd.x - playerStart.x, playerEnd.z - playerStart.z);
    const otherTravel = Math.hypot(otherEnd.x - otherStart.x, otherEnd.z - otherStart.z);
    const broadRadius = Math.hypot(player.spec.len, player.spec.wid) * 0.5
      + Math.hypot(other.spec.len, other.spec.wid) * 0.5
      + 0.2;
    const relativeStart = {
      x: playerStart.x - otherStart.x,
      z: playerStart.z - otherStart.z,
    };
    const relativeEnd = {
      x: playerEnd.x - otherEnd.x,
      z: playerEnd.z - otherEnd.z,
    };
    if (distanceSquaredToSegment({ x: 0, z: 0 }, relativeStart, relativeEnd)
      > broadRadius * broadRadius) return null;

    const steps = Math.max(3, Math.min(12, Math.ceil((playerTravel + otherTravel) / 0.25)));
    for (let step = 0; step <= steps; step += 1) {
      const amount = step / steps;
      const playerPose = {
        x: THREE.MathUtils.lerp(playerStart.x, playerEnd.x, amount),
        z: THREE.MathUtils.lerp(playerStart.z, playerEnd.z, amount),
        heading: interpolateHeading(playerStart.heading, playerHeading, amount),
      };
      const otherPose = {
        x: THREE.MathUtils.lerp(otherStart.x, otherEnd.x, amount),
        z: THREE.MathUtils.lerp(otherStart.z, otherEnd.z, amount),
        heading: interpolateHeading(otherStart.heading, otherHeading, amount),
      };
      diagnostics.sweptVehicleCollisionTests += 1;
      if (footprintsOverlap(
        vehicleFootprint(player, playerPose),
        vehicleFootprint(other, otherPose),
      )) {
        return {
          amount,
          safeAmount: Math.max(0, (step - 1) / steps),
          playerPose,
          otherPose,
        };
      }
    }
    return null;
  }

  function discFootprintClearance(point, footprint, radius = ON_FOOT_PLAYER_RADIUS) {
    const axes = footprintAxes(footprint.heading);
    const dx = point.x - footprint.x;
    const dz = point.z - footprint.z;
    const localRight = dx * axes.right.x + dz * axes.right.z;
    const localForward = dx * axes.forward.x + dz * axes.forward.z;
    const outsideRight = Math.max(0, Math.abs(localRight) - footprint.halfWidth);
    const outsideForward = Math.max(0, Math.abs(localForward) - footprint.halfLength);
    if (outsideRight > 0 || outsideForward > 0) {
      return Math.hypot(outsideRight, outsideForward) - radius;
    }
    return -Math.min(
      footprint.halfWidth - Math.abs(localRight),
      footprint.halfLength - Math.abs(localForward),
    ) - radius;
  }

  function separateDiscFromFootprint(point, footprint, radius = ON_FOOT_PLAYER_RADIUS) {
    const axes = footprintAxes(footprint.heading);
    const dx = point.x - footprint.x;
    const dz = point.z - footprint.z;
    const localRight = dx * axes.right.x + dz * axes.right.z;
    const localForward = dx * axes.forward.x + dz * axes.forward.z;
    const clampedRight = THREE.MathUtils.clamp(
      localRight,
      -footprint.halfWidth,
      footprint.halfWidth,
    );
    const clampedForward = THREE.MathUtils.clamp(
      localForward,
      -footprint.halfLength,
      footprint.halfLength,
    );
    let separatedRight = localRight;
    let separatedForward = localForward;
    const deltaRight = localRight - clampedRight;
    const deltaForward = localForward - clampedForward;
    const outsideDistance = Math.hypot(deltaRight, deltaForward);
    if (outsideDistance > 1e-5) {
      const push = Math.max(0, radius - outsideDistance) + ON_FOOT_VEHICLE_CLEARANCE_MARGIN;
      separatedRight += (deltaRight / outsideDistance) * push;
      separatedForward += (deltaForward / outsideDistance) * push;
    } else {
      const rightDepth = footprint.halfWidth + radius - Math.abs(localRight);
      const forwardDepth = footprint.halfLength + radius - Math.abs(localForward);
      if (rightDepth <= forwardDepth) {
        separatedRight = (localRight < 0 ? -1 : 1)
          * (footprint.halfWidth + radius + ON_FOOT_VEHICLE_CLEARANCE_MARGIN);
      } else {
        separatedForward = (localForward < 0 ? -1 : 1)
          * (footprint.halfLength + radius + ON_FOOT_VEHICLE_CLEARANCE_MARGIN);
      }
    }
    return {
      x: footprint.x
        + axes.right.x * separatedRight
        + axes.forward.x * separatedForward,
      z: footprint.z
        + axes.right.z * separatedRight
        + axes.forward.z * separatedForward,
    };
  }

  function sweptDiscFootprintContact(probe, vehicle, vehicleStart) {
    const vehicleEnd = vehicle.mesh.root.position;
    const endHeading = Number.isFinite(vehicle.heading)
      ? vehicle.heading
      : vehicleStart.heading;
    const broadRadius = Math.hypot(
      vehicle.spec.len * 0.5 + ON_FOOT_VEHICLE_SHELL_LENGTH_PAD,
      vehicle.spec.wid * 0.5 + ON_FOOT_VEHICLE_SHELL_WIDTH_PAD,
    ) + probe.radius + 0.2;
    const relativeStart = {
      x: probe.start.x - vehicleStart.x,
      z: probe.start.z - vehicleStart.z,
    };
    const relativeEnd = {
      x: probe.end.x - vehicleEnd.x,
      z: probe.end.z - vehicleEnd.z,
    };
    if (distanceSquaredToSegment({ x: 0, z: 0 }, relativeStart, relativeEnd)
      > broadRadius * broadRadius) return null;
    const playerTravel = Math.hypot(
      probe.end.x - probe.start.x,
      probe.end.z - probe.start.z,
    );
    const vehicleTravel = Math.hypot(
      vehicleEnd.x - vehicleStart.x,
      vehicleEnd.z - vehicleStart.z,
    );
    const steps = Math.max(3, Math.min(16, Math.ceil((playerTravel + vehicleTravel) / 0.2)));
    for (let step = 0; step <= steps; step += 1) {
      const amount = step / steps;
      const point = {
        x: THREE.MathUtils.lerp(probe.start.x, probe.end.x, amount),
        z: THREE.MathUtils.lerp(probe.start.z, probe.end.z, amount),
      };
      const footprint = onFootVehicleFootprint(vehicle, {
        x: THREE.MathUtils.lerp(vehicleStart.x, vehicleEnd.x, amount),
        z: THREE.MathUtils.lerp(vehicleStart.z, vehicleEnd.z, amount),
        heading: interpolateHeading(vehicleStart.heading, endHeading, amount),
      });
      diagnostics.onFootVehicleContactTests += 1;
      if (discFootprintClearance(point, footprint, probe.radius)
        <= ON_FOOT_VEHICLE_CLEARANCE_MARGIN) {
        const safeAmount = Math.max(0, (step - 1) / steps);
        return {
          amount,
          safeAmount,
          point,
          footprint,
          safeFootprint: onFootVehicleFootprint(vehicle, {
            x: THREE.MathUtils.lerp(vehicleStart.x, vehicleEnd.x, safeAmount),
            z: THREE.MathUtils.lerp(vehicleStart.z, vehicleEnd.z, safeAmount),
            heading: interpolateHeading(vehicleStart.heading, endHeading, safeAmount),
          }),
        };
      }
    }
    return null;
  }

  function setOnFootPlayerCollisionProbe(probe = null) {
    if (!probe?.active
      || !Number.isFinite(probe.start?.x)
      || !Number.isFinite(probe.start?.z)
      || !Number.isFinite(probe.end?.x)
      || !Number.isFinite(probe.end?.z)) {
      onFootPlayerCollisionProbe = null;
      onFootVehicleCollisionLatch.clear();
      return false;
    }
    onFootPlayerCollisionProbe = {
      start: { x: probe.start.x, z: probe.start.z },
      end: { x: probe.end.x, z: probe.end.z },
      radius: THREE.MathUtils.clamp(
        Number(probe.radius) || ON_FOOT_PLAYER_RADIUS,
        0.2,
        1.25,
      ),
    };
    return true;
  }

  function resolveOnFootPlayerVehicleContacts(motionStarts) {
    const probe = onFootPlayerCollisionProbe;
    if (!probe || !motionStarts) {
      onFootVehicleCollisionLatch.clear();
      return null;
    }
    const nextLatch = new Set();
    let best = null;
    let bestNew = null;
    for (let index = 0; index < vehicles.length; index += 1) {
      const vehicle = vehicles[index];
      const vehicleStart = motionStarts.get(vehicle);
      if (!vehicleStart
        || vehicle.mesh.root.visible !== true
        || vehicle.remoteControlled
        || vehicle.garageStored
        || vehicle.impounded) continue;
      const footprint = onFootVehicleFootprint(vehicle, {
        x: vehicle.mesh.root.position.x,
        z: vehicle.mesh.root.position.z,
        heading: vehicle.heading ?? vehicle.mesh.root.rotation.y,
      });
      const finalClearance = discFootprintClearance(probe.end, footprint, probe.radius);
      if (onFootVehicleCollisionLatch.has(index)
        && finalClearance <= ON_FOOT_VEHICLE_REARM_GAP) {
        nextLatch.add(index);
      }
      const contact = sweptDiscFootprintContact(probe, vehicle, vehicleStart);
      if (!contact) continue;
      nextLatch.add(index);
      const candidate = {
        index,
        vehicle,
        contact,
        footprint,
        latched: onFootVehicleCollisionLatch.has(index),
      };
      if (!best || contact.amount < best.contact.amount) best = candidate;
      if (!candidate.latched && (!bestNew || contact.amount < bestNew.contact.amount)) {
        bestNew = candidate;
      }
    }
    onFootVehicleCollisionLatch = nextLatch;
    if (!best) return null;

    // Correction always belongs to the earliest physical obstruction. A new
    // contact can authorize an event only when it is that same earliest hit;
    // a latched car in front therefore occludes later cars in the sweep.
    const eventCandidate = bestNew
      && bestNew.index === best.index
      && bestNew.contact.amount <= best.contact.amount + 1e-6
      ? bestNew
      : null;
    const newContact = Boolean(eventCandidate);

    const speed = Math.max(0, Number(best.vehicle.speed) || 0);
    const responderVehicle = pursuitResponder.active
      && pursuitResponder.targetIndexes.includes(best.index);
    const damaging = newContact
      && best.vehicle.disabled !== true
      && !responderVehicle
      && speed >= ON_FOOT_VEHICLE_IMPACT_MIN_SPEED;
    const safePoint = {
      x: THREE.MathUtils.lerp(probe.start.x, probe.end.x, best.contact.safeAmount),
      z: THREE.MathUtils.lerp(probe.start.z, probe.end.z, best.contact.safeAmount),
    };
    let correctedPosition = discFootprintClearance(
      safePoint,
      best.contact.safeFootprint,
      probe.radius,
    ) < ON_FOOT_VEHICLE_CLEARANCE_MARGIN
      ? separateDiscFromFootprint(safePoint, best.contact.safeFootprint, probe.radius)
      : safePoint;
    // A fast vehicle can travel far enough between the sampled contact and
    // the end of this frame that contact-time rewind alone still leaves the
    // rendered body inside its final shell. Preserve the contact-time result,
    // then apply one bounded end-OBB push only when it is still required.
    if (discFootprintClearance(correctedPosition, best.footprint, probe.radius)
      < ON_FOOT_VEHICLE_CLEARANCE_MARGIN) {
      correctedPosition = separateDiscFromFootprint(
        correctedPosition,
        best.footprint,
        probe.radius,
      );
    }
    const damage = damaging
      ? THREE.MathUtils.clamp(8 + speed * 2.6, 18, 48)
      : 0;
    const event = {
      kind: 'on-foot-vehicle-contact',
      vehicleId: best.index,
      vehicleClass: best.vehicle.cls,
      vehicleLabel: best.vehicle.identity?.label || best.vehicle.cls,
      speed: Math.round(speed * 10) / 10,
      latched: best.latched,
      pursuitResponder: responderVehicle,
      damaging,
      damage: Math.round(damage * 10) / 10,
      threshold: ON_FOOT_VEHICLE_IMPACT_MIN_SPEED,
      contactAmount: Math.round(best.contact.amount * 1000) / 1000,
      contactFootprint: { ...best.contact.footprint },
      endFootprint: { ...best.footprint },
      bodyRadius: probe.radius,
      correctedPosition,
    };
    diagnostics.onFootVehicleCorrections += 1;
    if (newContact) {
      diagnostics.onFootVehicleContacts += 1;
      if (damaging) diagnostics.onFootVehicleDamageContacts += 1;
      else diagnostics.onFootVehicleBlockingContacts += 1;
    }
    const consequence = onPlayerOnFootVehicleContact?.(event) ?? null;
    const appliedPosition = Number.isFinite(consequence?.correctedPosition?.x)
      && Number.isFinite(consequence?.correctedPosition?.z)
      ? { ...consequence.correctedPosition }
      : { ...correctedPosition };
    const resolvedEvent = consequence && typeof consequence === 'object'
      ? { ...event, correctedPosition: appliedPosition, consequence: { ...consequence } }
      : { ...event, correctedPosition: appliedPosition };
    diagnostics.lastOnFootVehicleCorrection = {
      ...resolvedEvent,
      correctedPosition: { ...resolvedEvent.correctedPosition },
    };
    if (newContact) {
      diagnostics.lastOnFootVehicleContact = {
        ...resolvedEvent,
        correctedPosition: { ...resolvedEvent.correctedPosition },
      };
    }
    return resolvedEvent;
  }

  function resolvePlayerVehicleFootprintCollisions(motionStarts, elapsed) {
    if (!playerVehicle || !motionStarts?.has(playerVehicle) || playerVehicle.disabled) {
      playerVehicleCollisionLatch.clear();
      return;
    }
    const playerStart = motionStarts.get(playerVehicle);
    const currentOverlaps = new Set();
    let emitted = false;
    for (let index = 0; index < vehicles.length; index += 1) {
      const other = vehicles[index];
      if (other === playerVehicle
        || !motionStarts.has(other)
        || other.impounded
        || other.garageStored
        || other.remoteControlled
        || other === impoundedPlayerVehicle) continue;
      const otherStart = motionStarts.get(other);
      const centerDistance = Math.hypot(
        playerVehicle.mesh.root.position.x - other.mesh.root.position.x,
        playerVehicle.mesh.root.position.z - other.mesh.root.position.z,
      );
      const responderVehicle = pursuitResponder.active
        && pursuitResponder.targetIndexes.includes(index);
      if (responderVehicle
        && playerVehicleCollisionLatch.has(index)
        && centerDistance < PURSUIT_RESPONDER_REARM_DISTANCE) {
        currentOverlaps.add(index);
      }
      const currentOverlap = footprintsOverlap(
        vehicleFootprint(playerVehicle, {
          x: playerVehicle.mesh.root.position.x,
          z: playerVehicle.mesh.root.position.z,
          heading: playerVehicle.heading,
        }),
        vehicleFootprint(other, {
          x: other.mesh.root.position.x,
          z: other.mesh.root.position.z,
          heading: other.heading,
        }),
      );
      if (currentOverlap) currentOverlaps.add(index);
      const contact = sweptFootprintContact(playerVehicle, playerStart, other, otherStart);
      if (!contact) {
        if (centerDistance <= 5.5) diagnostics.sweptVehicleNearMisses += 1;
        continue;
      }
      currentOverlaps.add(index);
      if (emitted
        || playerVehicleCollisionLatch.has(index)
        || elapsed < playerVehicle.damageCooldownUntil
        || other.disabled) continue;

      const playerHeading = Number.isFinite(playerVehicle.heading) ? playerVehicle.heading : 0;
      const otherHeading = Number.isFinite(other.heading) ? other.heading : 0;
      const playerVelocity = {
        x: Math.sin(playerHeading) * playerVehicle.speed,
        z: Math.cos(playerHeading) * playerVehicle.speed,
      };
      const otherVelocity = {
        x: Math.sin(otherHeading) * other.speed,
        z: Math.cos(otherHeading) * other.speed,
      };
      const relativeSpeed = Math.hypot(
        playerVelocity.x - otherVelocity.x,
        playerVelocity.z - otherVelocity.z,
      );
      if (relativeSpeed <= 1.5) continue;

      const responderContact = responderVehicle;
      const damage = responderContact
        ? 22
        : THREE.MathUtils.clamp(relativeSpeed * 5.8, 6, 42);
      const playerDamage = applyVehicleDamage(
        playerVehicle,
        damage,
        responderContact ? 'pursuit-contact' : 'traffic-impact',
      );
      const victimDamage = applyVehicleDamage(
        other,
        THREE.MathUtils.clamp(damage * (responderContact ? 0.32 : 0.55), 4, 24),
        responderContact ? 'pursuit-response-impact' : 'reckless-collision',
      );
      playerVehicle.speed *= responderContact ? 0.48 : 0.58;
      playerVehicle.longitudinalAccel = Math.min(0, playerVehicle.longitudinalAccel);
      other.speed *= 0.68;
      other.longitudinalAccel = Math.min(0, other.longitudinalAccel);
      other.hazardUntil = Math.max(other.hazardUntil, elapsed + 2.4);

      // Rewind the player's path to just before the first sampled overlap.
      // This keeps the visible bodies separated and keeps the authoritative
      // straight or turn path parameter coherent with the rendered pose.
      const safeAmount = contact.safeAmount;
      const playerPath = playerVehicle.turn ? 'turn' : 'road';
      const turnDistanceBeforeRewind = playerVehicle.turn?.distance ?? null;
      if (playerVehicle.turn) {
        const turnStartDistance = playerStart.turn === playerVehicle.turn
          && Number.isFinite(playerStart.turnDistance)
          ? playerStart.turnDistance
          : 0;
        playerVehicle.turn.distance = THREE.MathUtils.lerp(
          turnStartDistance,
          playerVehicle.turn.distance,
          safeAmount,
        );
      } else if (playerStart.road === playerVehicle.road
        && Number.isFinite(playerStart.s)
        && Number.isFinite(playerVehicle.s)) {
        playerVehicle.s = THREE.MathUtils.lerp(playerStart.s, playerVehicle.s, safeAmount);
      }
      playerVehicle.mesh.root.position.x = THREE.MathUtils.lerp(
        playerStart.x,
        playerVehicle.mesh.root.position.x,
        safeAmount,
      );
      playerVehicle.mesh.root.position.z = THREE.MathUtils.lerp(
        playerStart.z,
        playerVehicle.mesh.root.position.z,
        safeAmount,
      );
      const postContactOverlap = footprintsOverlap(
        vehicleFootprint(playerVehicle, {
          x: playerVehicle.mesh.root.position.x,
          z: playerVehicle.mesh.root.position.z,
          heading: interpolateHeading(playerStart.heading, playerVehicle.heading, safeAmount),
        }),
        vehicleFootprint(other, {
          x: other.mesh.root.position.x,
          z: other.mesh.root.position.z,
          heading: other.heading,
        }),
      );

      diagnostics.sweptVehicleCollisionEvents += 1;
      if (!responderContact) diagnostics.recklessCollisionEvents += 1;
      const collisionEvent = {
        kind: responderContact ? 'pursuit-contact' : 'reckless-collision',
        sequence: diagnostics.sweptVehicleCollisionEvents,
        playerVehicleId: vehicles.indexOf(playerVehicle),
        victimVehicleId: index,
        victimClass: other.cls,
        victimLabel: other.identity?.label || other.cls,
        responderId: responderContact ? index : null,
        responderContact,
        relativeSpeed: Math.round(relativeSpeed * 10) / 10,
        sweepAmount: Math.round(contact.amount * 1000) / 1000,
        postContactOverlap,
        playerPath,
        turnDistanceBeforeRewind,
        turnDistanceAfterRewind: playerVehicle.turn?.distance ?? null,
        playerDamage,
        victimDamage,
      };
      const aftermath = onPlayerVehicleCollision?.(collisionEvent) ?? null;
      if (aftermath && typeof aftermath === 'object') collisionEvent.aftermath = { ...aftermath };
      diagnostics.lastPlayerCollision = collisionEvent;
      diagnostics.lastSweptVehicleCollision = collisionEvent;
      playerVehicle.damageCooldownUntil = elapsed + VEHICLE_DAMAGE_COOLDOWN;
      emitted = true;
    }
    playerVehicleCollisionLatch = currentOverlaps;
  }

  function vehicleDamageSnapshot(vehicle) {
    if (!vehicle) return null;
    return {
      health: Math.round(vehicle.health * 10) / 10,
      maxHealth: vehicle.maxHealth,
      ratio: Math.round(vehicle.health / Math.max(1, vehicle.maxHealth) * 1000) / 1000,
      state: vehicle.damageState,
      disabled: vehicle.disabled,
      lastDamage: vehicle.lastDamage ? { ...vehicle.lastDamage } : null,
    };
  }

  function syncVehicleDamageMetadata(vehicle) {
    const userData = vehicle.mesh.root.userData || (vehicle.mesh.root.userData = {});
    userData.vehicleHealth = vehicle.health;
    userData.vehicleMaxHealth = vehicle.maxHealth;
    userData.vehicleDamageState = vehicle.damageState;
    userData.vehicleDisabled = vehicle.disabled;
  }

  function syncVehicleCombatDisabledMetadata(vehicle, disabled) {
    const userData = vehicle?.mesh?.root?.userData;
    if (!userData) return;
    if (disabled) {
      userData.combatDisabled = true;
      userData.combatDefeated = true;
      userData.combatBrakeUntil = Number.MAX_SAFE_INTEGER;
      return;
    }
    delete userData.combatDisabled;
    delete userData.combatDefeated;
    delete userData.combatDefeatedAt;
    delete userData.combatBrakeUntil;
  }

  function vehicleEligibleForCombatDamage(vehicle) {
    return Boolean(vehicle
      && !vehicle.disabled
      && vehicle !== playerVehicle
      && vehicle !== lastPlayerParkedVehicle
      && vehicle !== impoundedPlayerVehicle
      && !vehicle.garageStored
      && !vehicle.remoteControlled);
  }

  function applyVehicleDamage(vehicle, amount = 0, source = 'impact') {
    if (!vehicle || vehicle.disabled) return vehicleDamageSnapshot(vehicle);
    const damage = THREE.MathUtils.clamp(Number(amount) || 0, 0, vehicle.maxHealth);
    if (damage <= 0) return vehicleDamageSnapshot(vehicle);
    vehicle.health = Math.max(0, vehicle.health - damage);
    vehicle.disabled = vehicle.health <= 0;
    vehicle.damageState = damageStateFor(vehicle);
    vehicle.lastDamage = {
      amount: Math.round(damage * 10) / 10,
      source: String(source || 'impact'),
      at: Math.round(lastElapsed * 1000) / 1000,
    };
    vehicle.hazardUntil = vehicle.disabled ? Infinity : Math.max(vehicle.hazardUntil, lastElapsed + 2.4);
    diagnostics.vehicleDamageEvents += 1;
    if (vehicle.lastDamage.source === 'traffic-impact') diagnostics.collisionDamageEvents += 1;
    if (vehicle.disabled) {
      diagnostics.disabledVehicles += 1;
      vehicle.speed = 0;
      vehicle.longitudinalAccel = 0;
      vehicle.route = null;
      vehicle.turn = null;
      vehicle.blinkSide = 0;
      if (vehicle.playerControlled) {
        playerInput.throttle = 0;
        playerInput.brake = 1;
        playerInput.steer = 0;
      }
    }
    syncVehicleDamageMetadata(vehicle);
    return vehicleDamageSnapshot(vehicle);
  }

  function repairVehicleRecord(vehicle, source = 'repair') {
    if (!vehicle) return null;
    const needsRepair = vehicle.disabled
      || vehicle.health < vehicle.maxHealth
      || vehicle.lastDamage !== null;
    const wasDisabled = vehicle.disabled;
    vehicle.health = vehicle.maxHealth;
    vehicle.disabled = false;
    vehicle.damageState = 'clear';
    vehicle.damageCooldownUntil = 0;
    vehicle.lastDamage = null;
    if (!vehicle.pursuitResponder) vehicle.hazardUntil = 0;
    if (wasDisabled) diagnostics.disabledVehicles = Math.max(0, diagnostics.disabledVehicles - 1);
    if (needsRepair) diagnostics.vehicleRepairs += 1;
    syncVehicleDamageMetadata(vehicle);
    return { ...vehicleDamageSnapshot(vehicle), source };
  }

  // Muni coach curb program: per-direction stop lines along each road, far
  // enough from intersections that a dwelling bus never blocks the box. The
  // coach cycles lines in order and merges back after a timed dwell.
  const busStopPlans = roads.map((road) => {
    if (road.len < CURB_STOP_END_MARGIN * 2) return null;
    const first = CURB_STOP_END_MARGIN;
    const last = road.len - CURB_STOP_END_MARGIN;
    const stops = [];
    for (let s = first; s <= last + 0.01; s += BUS_STOP_GAP_MIN + BUS_STOP_GAP_SPAN * 0.5) {
      stops.push(s);
    }
    return stops.length ? { stops } : null;
  });

  if (roads.length > 0) {
    shared = buildShared();
    let count = Number.isFinite(fleetSize)
      ? Math.max(1, Math.floor(fleetSize))
      : MIN_VEHICLES + Math.floor(rng() * (MAX_VEHICLES - MIN_VEHICLES + 1));
    if (!Number.isFinite(fleetSize)) {
      count = Math.max(6, Math.min(count, roads.length * 6));
    } else {
      count = Math.max(1, Math.min(count, Math.max(roads.length * 8, count)));
    }
    const classes = buildClassList(rng, count);
    const classOrdinals = {};

    for (let fleetIndex = 0; fleetIndex < classes.length; fleetIndex += 1) {
      const cls = classes[fleetIndex];
      const ordinal = classOrdinals[cls] || 0;
      classOrdinals[cls] = ordinal + 1;
      const identity = vehicleIdentityFor(cls, ordinal);
      const spec = CLASSES[cls];
      const cruise = spec.vMin + rng() * (spec.vMax - spec.vMin);
      const initialSpeed = cruise * (0.38 + rng() * 0.42);
      // A subset of the light fleet starts curbside: parked mid-block cars
      // sell SF street parking, and taxis staged in the parking lane pull
      // out through a timed dwell instead of teleporting into traffic.
      const spawnParked = cls === 'sedan' || cls === 'suv'
        ? rng() < 0.14
        : cls === 'taxi' ? rng() < 0.3 : false;
      const bikeColors = [0x2c5f8a, 0xc45c2a, 0x2f6b4f, 0x343a44, 0xb08a3e];
      const baseColor = cls === 'taxi' ? TAXI_COLOR
        : cls === 'bus' ? BUS_BODY
        : cls === 'bike' ? bikeColors[Math.floor(rng() * bikeColors.length)]
        : cls === 'truck' ? TRUCK_CABS[Math.floor(rng() * TRUCK_CABS.length)]
        : pickColor(rng);
      const color = identity.key === 'sfmta-service' ? 0xf1eee7
        : identity.key === 'city-service' ? 0x315d6b
          : identity.key === 'local-delivery' && cls === 'van' ? 0xe6dfcf
            : baseColor;
      const mesh = buildVehicleMesh(shared, cls, spec, color, identity);

      // spawn on a random road with clearance, trying to avoid overlaps
      let placed = false;
      let placedParked = false;
      const heavyVehicle = cls === 'truck' || cls === 'bus';
      for (let attempt = 0; attempt < 32 && !placed; attempt++) {
        const ri = Math.floor(rng() * roads.length);
        const road = roads[ri];
        if (road.len < spec.len + 16) continue;
        const legalDirs = Array.isArray(road.dirs) && road.dirs.length
          ? road.dirs
          : [1, -1];
        const dir = legalDirs[Math.floor(rng() * legalDirs.length)];
        if (!isDirectionLegal(road, dir)) {
          diagnostics.oneWayRejects += 1;
          continue;
        }
        const edgeClearance = heavyVehicle
          ? Math.min(32, road.len * 0.46)
          : Math.min(24, road.len * 0.36);
        const s = edgeClearance + rng() * Math.max(1, road.len - edgeClearance * 2);
        let clear = true;
        for (const v of vehicles) {
          if (v.parked && v.road === ri && v.dir === dir
            && Math.abs(v.s - s) < v.half + spec.len / 2 + MIN_GAP) {
            clear = false;
            break;
          }
          if (spawnParked && !v.parked && v.road === ri && v.dir === dir
            && Math.abs(v.s - s) < v.half + spec.len / 2 + MIN_GAP + 1.5) {
            clear = false;
            break;
          }
          if (spawnParked || v.parked) continue;
          const movingClearance = MIN_GAP
            + Math.max(v.speed, initialSpeed)
              * (MIN_MOVING_HEADWAY + HEADWAY_PLANNING_BUFFER);
          if (
            v.road === ri
            && v.dir === dir
            && Math.abs(v.s - s) < v.half + spec.len / 2 + movingClearance
          ) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;
        // Curb cars sit close to intersections so the pull-out reads as a
        // curb cut within a few seconds instead of after a long block walk.
        if (spawnParked
          && Math.min(s, road.len - s) > Math.min(42, road.len * 0.4)) {
          continue;
        }
        const classSpeedBias = cls === 'taxi' ? 1.025
          : cls === 'bike' ? 1.05
          : cls === 'bus' || cls === 'truck' ? 0.965
            : 1;
        const identitySpeedBias = identity.curbService === 'service' ? 0.94
          : identity.curbService === 'delivery' ? 0.96
            : 1;
        const driverFactor = classSpeedBias * identitySpeedBias * (0.92 + rng() * 0.14);
        const timeHeadway = spec.headway * (0.92 + rng() * 0.16);
        const reactionDelay = spec.reaction * (0.88 + rng() * 0.28);
        const laneBias = (rng() - 0.5) * 0.16;
        const bobPhase = rng() * Math.PI * 2;
        const servicePhase = bobPhase / (Math.PI * 2);
        const serviceProfile = CURB_SERVICE_PROFILES[identity.curbService];
        const maxHealth = VEHICLE_HEALTH_BY_CLASS[cls] || 100;
        vehicles.push({
          cls, spec, mesh, identity,
          road: ri, dir, s,
          speed: spawnParked ? 0 : initialSpeed,
          cruise,
          driverFactor,
          timeHeadway,
          reactionDelay,
          half: spec.len / 2,
          laneBias,
          bobPhase,
          servicePhase,
          longitudinalAccel: 0,
          accelSm: 0,
          rollSm: 0,
          steerSm: 0,
          heading: null,
          route: null,
          turn: null,
          leader: null,
          blinkSide: 0,
          waitingForGreen: false,
          greenReleaseAt: Infinity,
          waitingAtStop: false,
          stopHoldUntil: Infinity,
          stopClearedNode: -1,
          safetyClamped: false,
          parked: spawnParked,
          parkedAt: null,
          dwellUntil: spawnParked ? 5 + servicePhase * 12 : 0,
          curbDwellUntil: Infinity,
          nextCurbStopAt: Infinity,
          nextServiceAt: serviceProfile
            ? serviceProfile.firstDelay + servicePhase * 9
            : Infinity,
          busStopIndex: -1,
          pullOutBlockedSince: null,
          hazardUntil: 0,
          mergeSignalUntil: 0,
          pursuitResponder: false,
          pursuitLevel: 0,
          pursuitRouteRevision: 0,
          pursuitRouteScore: null,
          pursuitRouteTargetDistance: null,
          pursuitRoutePlannedAt: null,
          maxHealth,
          health: maxHealth,
          damageState: 'clear',
          disabled: false,
          impounded: false,
          garageStored: false,
          damageCooldownUntil: 0,
          lastDamage: null,
          theftReported: false,
          registeredOwner: false,
        });
        placed = true;
        placedParked = spawnParked;
      }
      if (placedParked) continue;
    }
    for (const v of vehicles) group.add(v.mesh.root);
    for (const v of vehicles) syncVehicleDamageMetadata(v);
    stats.active = vehicles.length;
    for (const vehicle of vehicles) {
      diagnostics.classMix[vehicle.cls] = (diagnostics.classMix[vehicle.cls] || 0) + 1;
      diagnostics.identityMix[vehicle.identity.category] = (
        diagnostics.identityMix[vehicle.identity.category] || 0
      ) + 1;
    }
  }

  // Compose the opening northbound avenue deterministically: keep the camera
  // foreground clear, then reserve readable mid-distance slots for one local
  // transit coach and the production-car LOD. Displaced actors remain active
  // and are rehomed with the same lane-clearance rule used during spawning.
  const heroRoad = roads.find((road) => (
    Math.abs(road.px[0] - 28) < 0.5
    && road.pz[0] < -40
    && road.pz[road.pz.length - 1] > -20
  ));
  const heroNorthRoad = roads.find((road) => (
    Math.abs(road.px[0] - 28) < 0.5
    && road.pz[0] > -1
    && road.pz[road.pz.length - 1] > 40
  ));
  const heroRoadIndex = heroRoad ? roads.indexOf(heroRoad) : -1;
  const heroNorthRoadIndex = heroNorthRoad ? roads.indexOf(heroNorthRoad) : -1;
  const heroCrossRoadIndexes = roads.reduce((indexes, road, index) => {
    const last = road.px.length - 1;
    const liesOnCrossStreet = Math.abs(road.pz[0]) < 0.5
      && Math.abs(road.pz[last]) < 0.5;
    const minX = Math.min(road.px[0], road.px[last]);
    const maxX = Math.max(road.px[0], road.px[last]);
    if (liesOnCrossStreet && minX <= 28.1 && maxX >= 27.9) indexes.push(index);
    return indexes;
  }, []);
  const heroCrossRoadSet = new Set(heroCrossRoadIndexes);
  const occupancyOnRoad = (roadIndex, predicate = () => true) => {
    let count = 0;
    for (const actor of vehicles) {
      const occupies = actor.road === roadIndex
        || actor.turn?.route.road === roadIndex;
      if (occupies && predicate(actor)) count += 1;
    }
    return count;
  };
  const heroForegroundCutoff = heroRoad
    ? Math.min(48, heroRoad.len * 0.76)
    : -Infinity;
  const heroCameraCutoff = heroRoad
    ? Math.min(30, heroRoad.len * 0.48)
    : -Infinity;
  const heroBus = vehicles.find((vehicle) => vehicle.cls === 'bus');
  const heroSedan = vehicles.find((vehicle) => vehicle.cls === 'sedan') || vehicles[0];

  const slotIsClear = (target, roadIndex, dir, s) => vehicles.every((vehicle) => (
    vehicle === target
    || vehicle.road !== roadIndex
    || vehicle.dir !== dir
    || Math.abs(vehicle.s - s) >= vehicle.half + target.half
      + MIN_GAP
      + Math.max(vehicle.speed, target.speed)
        * (MIN_MOVING_HEADWAY + HEADWAY_PLANNING_BUFFER)
  ));

  const moveVehicleTo = (vehicle, roadIndex, dir, s) => {
    vehicle.road = roadIndex;
    vehicle.dir = dir;
    vehicle.s = s;
    vehicle.route = null;
    vehicle.turn = null;
    vehicle.leader = null;
    vehicle.blinkSide = 0;
    vehicle.heading = null;
    vehicle.waitingForGreen = false;
    vehicle.greenReleaseAt = Infinity;
    vehicle.waitingAtStop = false;
    vehicle.stopHoldUntil = Infinity;
    vehicle.stopClearedNode = -1;
    vehicle.longitudinalAccel = 0;
    vehicle.dwellUntil = 0;
    vehicle.curbDwellUntil = Infinity;
    vehicle.nextCurbStopAt = Infinity;
    vehicle.nextServiceAt = vehicle.identity.curbService ? 0 : Infinity;
    vehicle.busStopIndex = -1;
    vehicle.pullOutBlockedSince = null;
    vehicle.hazardUntil = 0;
    vehicle.mergeSignalUntil = 0;
    vehicle.speed = Math.min(
      vehicle.cruise * 0.68,
      Math.max(vehicle.speed, vehicle.cruise * 0.44),
    );
  };

  const relocateOffHero = (vehicle, avoidCrossStreet = false) => {
    const heavy = vehicle.cls === 'truck' || vehicle.cls === 'bus';
    for (let roadIndex = 0; roadIndex < roads.length; roadIndex += 1) {
      if (roadIndex === heroRoadIndex) continue;
      if ((heavy || avoidCrossStreet) && heroCrossRoadSet.has(roadIndex)) continue;
      const road = roads[roadIndex];
      if (road.len < vehicle.spec.len + 16) continue;
      const edge = vehicle.half + 5;
      const candidateDirs = Array.isArray(road.dirs) && road.dirs.length
        ? road.dirs
        : [vehicle.dir, -vehicle.dir];
      for (const dir of candidateDirs) {
        if (!isDirectionLegal(road, dir)) {
          diagnostics.oneWayRejects += 1;
          continue;
        }
        for (const fraction of [0, 0.18, 0.36, 0.54, 0.72, 0.9, 1]) {
          const s = edge + (road.len - edge * 2) * fraction;
          if (!slotIsClear(vehicle, roadIndex, dir, s)) continue;
          moveVehicleTo(vehicle, roadIndex, dir, s);
          return true;
        }
        // Also probe immediately before and after occupied actors. This
        // completes the useful gaps missed by fixed fractions on a dense lane.
        for (const other of vehicles) {
          if (other === vehicle || other.road !== roadIndex || other.dir !== dir) continue;
          const clearance = vehicle.half + other.half
            + MIN_GAP
            + Math.max(vehicle.speed, other.speed)
              * (MIN_MOVING_HEADWAY + HEADWAY_PLANNING_BUFFER)
            + 0.2;
          for (const s of [other.s - clearance, other.s + clearance]) {
            if (s < edge || s > road.len - edge) continue;
            if (!slotIsClear(vehicle, roadIndex, dir, s)) continue;
            moveVehicleTo(vehicle, roadIndex, dir, s);
            return true;
          }
        }
      }
    }
    // Never trade the beauty-frame guard for an overlapping teleport.
    return false;
  };

  const reserveHeroSlot = (vehicle, preferredS) => {
    if (!vehicle || heroRoadIndex < 0) return false;
    for (const requestedS of [preferredS, preferredS - 6, preferredS - 12]) {
      const s = Math.max(
        vehicle.half + 4,
        heroForegroundCutoff + 0.5,
        Math.min(heroRoad.len - vehicle.half - 4, requestedS),
      );
      let available = true;
      for (const other of vehicles) {
        if (
          other === vehicle
          || other.road !== heroRoadIndex
          || other.dir !== 1
          || Math.abs(other.s - s) >= other.half + vehicle.half + MIN_GAP
        ) continue;
        if (!relocateOffHero(other)) {
          available = false;
          break;
        }
      }
      if (!available || !slotIsClear(vehicle, heroRoadIndex, 1, s)) continue;
      moveVehicleTo(vehicle, heroRoadIndex, 1, s);
      return true;
    }
    return false;
  };

  const reservePresentationSlot = (vehicle, roadIndex, dir, preferredS) => {
    if (!vehicle || roadIndex < 0) return false;
    const road = roads[roadIndex];
    const s = Math.max(
      vehicle.half + 4,
      Math.min(road.len - vehicle.half - 4, preferredS),
    );
    for (const other of vehicles) {
      if (
        other === vehicle
        || other.road !== roadIndex
        || other.dir !== dir
        || Math.abs(other.s - s) >= other.half + vehicle.half + MIN_GAP
      ) continue;
      if (!relocateOffHero(other)) return false;
    }
    moveVehicleTo(vehicle, roadIndex, dir, s);
    return true;
  };

  // Heavy silhouettes crossing abreast at z=0 read as a solid wall from the
  // opening lens. Keep transit and freight on the surrounding grid, then
  // compose a sparse stagger of light vehicles across the same intersection.
  for (const vehicle of vehicles) {
    if (
      (vehicle.cls === 'truck' || vehicle.cls === 'bus')
      && heroCrossRoadSet.has(vehicle.road)
    ) {
      relocateOffHero(vehicle);
    }
  }

  const westCrossRoadIndex = heroCrossRoadIndexes.find((index) => {
    const road = roads[index];
    return Math.min(road.px[0], road.px[road.px.length - 1]) < 27;
  }) ?? -1;
  const eastCrossRoadIndex = heroCrossRoadIndexes.find((index) => {
    const road = roads[index];
    return Math.max(road.px[0], road.px[road.px.length - 1]) > 29;
  }) ?? -1;
  const presentationTaxis = vehicles.filter((vehicle) => vehicle.cls === 'taxi');
  const presentationSedan = vehicles.find((vehicle) => (
    vehicle.cls === 'sedan' && vehicle !== heroSedan
  ));
  const presentationCars = [
    presentationTaxis[0],
    presentationSedan,
    presentationTaxis[1],
  ].filter(Boolean);
  for (const vehicle of vehicles) {
    if (
      heroCrossRoadSet.has(vehicle.road)
      && !presentationCars.includes(vehicle)
    ) {
      relocateOffHero(vehicle, true);
    }
  }
  if (westCrossRoadIndex >= 0 && presentationCars[0]) {
    reservePresentationSlot(
      presentationCars[0],
      westCrossRoadIndex,
      -1,
      roads[westCrossRoadIndex].len * 0.58,
    );
  }
  if (eastCrossRoadIndex >= 0 && presentationCars[1]) {
    reservePresentationSlot(
      presentationCars[1],
      eastCrossRoadIndex,
      1,
      roads[eastCrossRoadIndex].len * 0.38,
    );
  }
  if (eastCrossRoadIndex >= 0 && presentationCars[2]) {
    reservePresentationSlot(
      presentationCars[2],
      eastCrossRoadIndex,
      1,
      roads[eastCrossRoadIndex].len * 0.76,
    );
  }
  if (heroRoadIndex >= 0) {
    // z=-42 lies about 22 m along the authored -64..0 hero segment.
    for (const vehicle of vehicles) {
      if (
        vehicle.road === heroRoadIndex
        && vehicle.s < heroForegroundCutoff
      ) {
        relocateOffHero(vehicle);
      }
    }
    // Pass-10 hero lens: the static California Street cable car owns the avenue.
    // Keep the Muni coach off both California segments so it cannot crop the
    // open-sided coach, twin rails, or overhead span wires in capture.
    if (heroBus) relocateOffHero(heroBus);
    // Keep the production sedan off the hero avenue entirely; a mid-distance
    // car was reading as a second hero vehicle in the cable-car capture band.
    if (heroSedan) relocateOffHero(heroSedan);
  }

  // The first block is an authored morning-rush tableau on the far avenue.
  // Curb actors stay north of the cable-car lens so the coach remains hero.
  if (heroNorthRoadIndex >= 0) {
    const curbTaxi = presentationTaxis[2];
    if (curbTaxi && reservePresentationSlot(curbTaxi, heroNorthRoadIndex, 1, 82)) {
      curbTaxi.parked = true;
      curbTaxi.parkedAt = null;
      curbTaxi.dwellUntil = 9.5 + curbTaxi.servicePhase * 4.5;
      curbTaxi.curbDwellUntil = Infinity;
      curbTaxi.nextCurbStopAt = Infinity;
      curbTaxi.nextServiceAt = Infinity;
      curbTaxi.hazardUntil = 0;
      curbTaxi.mergeSignalUntil = 0;
      curbTaxi.blinkSide = 0;
      curbTaxi.speed = 0;
      curbTaxi.laneOffsetSm = CURB_LANE_OFFSET;
      curbTaxi.mesh.root.userData.heroTrafficCue = 'curb-taxi';
    }

    const serviceVan = vehicles.find((vehicle) => vehicle.identity.key === 'sfmta-service');
    if (serviceVan && reservePresentationSlot(serviceVan, heroNorthRoadIndex, -1, 88)) {
      serviceVan.parked = false;
      serviceVan.parkedAt = null;
      serviceVan.curbDwellUntil = Infinity;
      serviceVan.nextCurbStopAt = Infinity;
      serviceVan.nextServiceAt = 0;
      serviceVan.hazardUntil = 0;
      serviceVan.mergeSignalUntil = 0;
      serviceVan.blinkSide = 0;
      serviceVan.laneOffsetSm = LANE_OFFSET;
      serviceVan.speed = Math.min(serviceVan.speed, serviceVan.cruise * 0.55);
      serviceVan.mesh.root.userData.heroTrafficCue = 'sfmta-curb-approach';
    }
  }

  // Keep two ordinary private cars available at the curb for the normal
  // on-foot vehicle-entry loop. They remain regular fleet actors (and use the
  // same pull-out path later); the longer opening dwell simply makes the
  // theft consequence reachable without racing the first simulation frames.
  const theftReadyVehicles = vehicles.filter((vehicle) => (
    vehicle.identity.category === 'private'
    && vehicle.cls !== 'bike'
    && vehicle !== heroSedan
    && !presentationCars.includes(vehicle)
  )).slice(0, 2);
  theftReadyVehicles.forEach((vehicle, index) => {
    vehicle.parked = true;
    vehicle.parkedAt = null;
    vehicle.dwellUntil = 42 + index * 4 + vehicle.servicePhase * 3;
    vehicle.speed = 0;
    vehicle.longitudinalAccel = 0;
    vehicle.accelSm = 0;
    vehicle.route = null;
    vehicle.turn = null;
    vehicle.leader = null;
    vehicle.waitingForGreen = false;
    vehicle.greenReleaseAt = Infinity;
    vehicle.curbDwellUntil = Infinity;
    vehicle.nextCurbStopAt = Infinity;
    vehicle.nextServiceAt = Infinity;
    vehicle.busStopIndex = -1;
    vehicle.pullOutBlockedSince = null;
    vehicle.hazardUntil = 0;
    vehicle.mergeSignalUntil = 0;
    vehicle.blinkSide = 0;
    vehicle.laneOffsetSm = CURB_LANE_OFFSET;
    vehicle.mesh.root.userData.theftReady = true;
  });

  // Wire the img2threejs polished taxi into near-detail LOD for every cab.
  // Procedural yellow shells remain the distance silhouette + rain fallback.
  if (typeof document !== 'undefined') {
    for (const target of vehicles) {
      if (target.cls !== 'taxi') continue;
      const detailedHeroRoot = new THREE.Group();
      detailedHeroRoot.name = 'Polished SF taxi LOD';
      target.detailedRoot = detailedHeroRoot;
      target.detailedReady = false;
      detailedHeroRoot.visible = false;
      target.mesh.root.add(detailedHeroRoot);
      try {
        const hero = createSfTaxiModel({
          castShadow: true,
          receiveShadow: true,
          scale: target.spec.len / 4.35,
        });
        // Contact shadow already lives on the traffic root; hide the preview disc.
        const previewShadow = hero.userData?.sculptRuntime?.meshes?.contactShadow;
        if (previewShadow) previewShadow.visible = false;
        hero.position.y = 0;
        hero.traverse((child) => {
          if (!child.isMesh) return;
          child.frustumCulled = true;
        });
        detailedHeroRoot.add(hero);
        target.detailedReady = true;
        target.detailedTick = typeof hero.userData?.tick === 'function'
          ? (dt) => hero.userData.tick(dt)
          : null;
      } catch (error) {
        console.warn('Polished SF taxi LOD unavailable; using procedural taxi.', error);
        target.detailedRoot = null;
        target.detailedReady = false;
      }
    }
  }

  /* ---- per-frame sim ---- */

  const samp = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0 };

  function setTangent(road, i) {
    const dx = road.px[i + 1] - road.px[i];
    const dy = road.py[i + 1] - road.py[i];
    const dz = road.pz[i + 1] - road.pz[i];
    const l = Math.hypot(dx, dz) || 1;
    samp.tx = dx / l;
    samp.ty = dy / l;
    samp.tz = dz / l;
  }

  function sampleRoad(road, s) {
    const { px, py, pz, cum } = road;
    const n = px.length;
    if (s <= 0) {
      samp.x = px[0]; samp.y = py[0]; samp.z = pz[0];
      setTangent(road, 0);
      return;
    }
    if (s >= road.len) {
      samp.x = px[n - 1]; samp.y = py[n - 1]; samp.z = pz[n - 1];
      setTangent(road, n - 2);
      return;
    }
    let i = 1;
    while (i < n - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    samp.x = px[i - 1] + (px[i] - px[i - 1]) * t;
    samp.y = py[i - 1] + (py[i] - py[i - 1]) * t;
    samp.z = pz[i - 1] + (pz[i] - pz[i - 1]) * t;
    setTangent(road, i - 1);
  }

  const laneBuckets = Array.from({ length: roads.length * 2 }, () => []);
  const firstSignal = signals.size ? signals.values().next().value : null;
  let lastElapsed = 0;
  let weatherMode = 'clear';
  let frameMinLaneGap = Infinity;
  let frameMinMovingHeadway = Infinity;
  let frameMinStoppedGap = Infinity;
  let frameWorstHeadway = null;
  let speedIntegral = 0;
  let diagnosticDuration = 0;

  function distanceToEnd(v, road = roads[v.road]) {
    return v.dir === 1 ? road.len - v.s : v.s;
  }

  function signalApproachFor(v, road = roads[v.road], time = lastElapsed) {
    if (!v || !road || v.turn) return null;
    const end = v.dir === 1 ? 1 : 0;
    const nodeIndex = road.endNode[end];
    const signal = signals.get(nodeIndex);
    if (!signal) return null;
    const group = road.signalGroup[end];
    return {
      nodeIndex,
      group,
      phase: signalPhaseAt(group, time, signal.offset),
      remaining: signalPhaseAt.remaining(group, time, signal.offset),
      offset: signal.offset,
      distance: distanceToEnd(v, road) - STOP_MARGIN - v.half,
    };
  }

  function reportPlayerRedLightCrossing(v, road, nextS, time) {
    if (!v?.playerControlled || v.turn) return null;
    const approach = signalApproachFor(v, road, time);
    if (!approach || approach.phase !== 'red') return null;
    const nextDistance = (v.dir === 1 ? road.len - nextS : nextS)
      - STOP_MARGIN
      - v.half;
    if (approach.distance < 0 || nextDistance >= 0) return null;
    const phaseCycle = Math.floor((time + approach.offset) / SIGNAL_PERIOD);
    const key = `${v.road}:${approach.nodeIndex}:${phaseCycle}`;
    if (playerSignalViolationLatch === key) return null;
    playerSignalViolationLatch = key;
    diagnostics.playerRedLightViolations += 1;
    const event = {
      kind: 'traffic-violation',
      violation: 'red-light',
      vehicleId: vehicles.indexOf(v),
      road: v.road,
      nodeIndex: approach.nodeIndex,
      turnSide: v.route?.side ?? 0,
      phase: approach.phase,
      at: time,
    };
    onPlayerTrafficViolation?.(event);
    return event;
  }

  function roadCruise(v, road) {
    const weatherSpeedFactor = weatherMode === 'drizzle'
      ? 0.84
      : weatherMode === 'fog' ? 0.9 : 1;
    return Math.min(v.cruise, road.speedLimit * v.driverFactor) * weatherSpeedFactor;
  }

  function weatherHeadwayFactor() {
    return weatherMode === 'drizzle' ? 1.24 : weatherMode === 'fog' ? 1.12 : 1;
  }

  function weatherGapFactor() {
    return weatherMode === 'drizzle' ? 1.16 : weatherMode === 'fog' ? 1.08 : 1;
  }

  function weatherBrakeFactor() {
    return weatherMode === 'drizzle' ? 0.78 : weatherMode === 'fog' ? 0.88 : 1;
  }

  function planRoute(v) {
    if (v.route || v.turn) return;
    const road = roads[v.road];
    const end = v.dir === 1 ? 1 : 0;
    const node = nodes[road.endNode[end]];
    if (!node) {
      if (!isDirectionLegal(road, -v.dir)) {
        diagnostics.oneWayRejects += 1;
        v.route = null;
        return;
      }
      v.route = { uTurn: true };
      if (v.mergeSignalUntil <= lastElapsed) v.blinkSide = 1;
      return;
    }

    sampleRoad(road, end === 1 ? road.len : 0);
    const inX = samp.tx * v.dir;
    const inZ = samp.tz * v.dir;
    const approachPoint = {
      x: road.px[end === 1 ? 0 : road.px.length - 1],
      z: road.pz[end === 1 ? 0 : road.pz.length - 1],
    };
    const turnRule = findTurnRule(node, approachPoint, turnRules);
    const choices = [];
    let totalWeight = 0;

    for (const edge of node.ends) {
      if (edge.road === v.road) continue;
      // Keep the authored composition clean during startup, then admit normal
      // traffic into the hero segment up to a small live occupancy cap.
      if (
        edge.road === heroRoadIndex
        && ((v.cls === 'truck' || v.cls === 'bus')
          || lastElapsed < HERO_GATE_SECONDS
          || occupancyOnRoad(edge.road) >= HERO_ROAD_CAP)
      ) continue;
      if (
        (v.cls === 'truck' || v.cls === 'bus')
        && heroCrossRoadSet.has(edge.road)
        && (v.cls === 'bus'
          || lastElapsed < HERO_GATE_SECONDS
          || occupancyOnRoad(edge.road, (actor) => (
            actor.cls === 'truck' || actor.cls === 'bus'
          )) >= HERO_HEAVY_CROSS_CAP)
      ) continue;
      const nextRoad = roads[edge.road];
      if (nextRoad.len < v.spec.len + TURN_SPAN * 2) continue;

      const dir = edge.end === 0 ? 1 : -1;
      if (!isDirectionLegal(nextRoad, dir)) {
        diagnostics.oneWayRejects += 1;
        continue;
      }
      sampleRoad(nextRoad, edge.end === 0 ? 0 : nextRoad.len);
      const outX = samp.tx * dir;
      const outZ = samp.tz * dir;
      const dot = inX * outX + inZ * outZ;
      if (dot < -0.72) continue;

      const cross = inX * outZ - inZ * outX;
      const side = dot > 0.86 ? 0 : (cross < 0 ? 1 : -1);
      if (!isTurnAllowed({ side, rule: turnRule })) {
        diagnostics.illegalTurnRejects += 1;
        continue;
      }
      let weight = side === 0 ? 5.2 : side > 0 ? 2.4 : 1.45;
      if ((v.cls === 'bus' || v.cls === 'truck') && side < 0) weight *= 0.7;
      // After the protected opening, refill an under-occupied hero avenue
      // through ordinary route choice instead of teleporting presentation
      // cars into view. The cap still prevents a staged wall of traffic.
      if (edge.road === heroRoadIndex && lastElapsed >= HERO_GATE_SECONDS) {
        const heroOccupancy = occupancyOnRoad(heroRoadIndex);
        if (heroOccupancy === 0) weight *= 3.5;
        else if (heroOccupancy < 2) weight *= 2;
      }
      totalWeight += weight;
      choices.push({
        road: edge.road,
        dir,
        side,
        weight,
        outX,
        outZ,
      });
    }

    if (!choices.length) {
      if (v.pursuitResponder && pursuitResponder.active) {
        diagnostics.pursuitRouteFallbacks += 1;
      }
      if (!isDirectionLegal(road, -v.dir) || !isTurnAllowed({ side: 1, uTurn: true, rule: turnRule })) {
        diagnostics.oneWayRejects += 1;
        v.route = null;
        return;
      }
      v.route = { uTurn: true };
      if (v.mergeSignalUntil <= lastElapsed) v.blinkSide = 1;
      return;
    }

    let route = choices[choices.length - 1];
    if (v.pursuitResponder && pursuitResponder.active) {
      const targetX = pursuitResponder.playerX;
      const targetZ = pursuitResponder.playerZ;
      const targetDistanceFromNode = Math.hypot(targetX - node.x, targetZ - node.z);
      let bestScore = Infinity;
      for (const choice of choices) {
        const nextRoad = roads[choice.road];
        const lookAhead = Math.min(
          Math.max(0, nextRoad.len - TURN_SPAN),
          THREE.MathUtils.clamp(targetDistanceFromNode, 18, 64),
        );
        const lookAheadS = choice.dir === 1
          ? lookAhead
          : nextRoad.len - lookAhead;
        sampleRoad(nextRoad, lookAheadS);
        const distance = Math.hypot(targetX - samp.x, targetZ - samp.z);
        const targetLength = Math.max(0.1, targetDistanceFromNode);
        const targetDirectionX = (targetX - node.x) / targetLength;
        const targetDirectionZ = (targetZ - node.z) / targetLength;
        const alignment = choice.outX * targetDirectionX + choice.outZ * targetDirectionZ;
        const turnCost = choice.side === 0 ? 0 : choice.side > 0 ? 0.3 : 0.5;
        const score = distance
          - alignment * Math.min(18, targetDistanceFromNode * 0.18)
          + turnCost;
        if (score < bestScore - 1e-6
          || (Math.abs(score - bestScore) <= 1e-6 && choice.road < route.road)) {
          bestScore = score;
          route = choice;
        }
      }
      v.pursuitRouteRevision = (v.pursuitRouteRevision || 0) + 1;
      v.pursuitRouteScore = Math.round(bestScore * 1000) / 1000;
      v.pursuitRouteTargetDistance = Math.round(targetDistanceFromNode * 1000) / 1000;
      v.pursuitRoutePlannedAt = Math.round(lastElapsed * 1000) / 1000;
      diagnostics.pursuitRouteDecisions += 1;
      diagnostics.lastPursuitRouteDecision = {
        vehicleId: vehicles.indexOf(v),
        revision: v.pursuitRouteRevision,
        fromRoad: v.road,
        toRoad: route.road,
        dir: route.dir,
        side: route.side,
        score: v.pursuitRouteScore,
        targetDistance: v.pursuitRouteTargetDistance,
        targetX: Math.round(targetX * 1000) / 1000,
        targetZ: Math.round(targetZ * 1000) / 1000,
        at: v.pursuitRoutePlannedAt,
      };
    } else {
      let pick = rng() * totalWeight;
      for (const choice of choices) {
        pick -= choice.weight;
        if (pick <= 0) {
          route = choice;
          break;
        }
      }
    }
    v.route = route;
    if (v.mergeSignalUntil <= lastElapsed) v.blinkSide = route.side;
  }

  // Player routes follow the same intersections as AI traffic, but the turn
  // choice comes from steering instead of a weighted random draw. Straight is
  // preferred unless the player is clearly steering into a side road.
  function planPlayerRoute(v) {
    const road = roads[v.road];
    const end = v.dir === 1 ? 1 : 0;
    const node = nodes[road.endNode[end]];
    if (!node) {
      v.route = { uTurn: true };
      if (v.mergeSignalUntil <= lastElapsed) v.blinkSide = 1;
      return;
    }

    sampleRoad(road, end === 1 ? road.len : 0);
    const inX = samp.tx * v.dir;
    const inZ = samp.tz * v.dir;
    const approachPoint = {
      x: road.px[end === 1 ? 0 : road.px.length - 1],
      z: road.pz[end === 1 ? 0 : road.pz.length - 1],
    };
    const turnRule = findTurnRule(node, approachPoint, turnRules);
    const choices = [];

    for (const edge of node.ends) {
      if (edge.road === v.road) continue;
      const nextRoad = roads[edge.road];
      if (nextRoad.len < v.spec.len + TURN_SPAN * 2) continue;
      const dir = edge.end === 0 ? 1 : -1;
      if (!isDirectionLegal(nextRoad, dir)) {
        diagnostics.oneWayRejects += 1;
        continue;
      }
      sampleRoad(nextRoad, edge.end === 0 ? 0 : nextRoad.len);
      const outX = samp.tx * dir;
      const outZ = samp.tz * dir;
      const dot = inX * outX + inZ * outZ;
      if (dot < -0.72) continue;
      const cross = inX * outZ - inZ * outX;
      const side = dot > 0.86 ? 0 : (cross < 0 ? 1 : -1);
      if (!isTurnAllowed({ side, rule: turnRule })) {
        diagnostics.illegalTurnRejects += 1;
        continue;
      }
      choices.push({ road: edge.road, dir, side });
    }

    if (!choices.length) {
      if (!isDirectionLegal(road, -v.dir) || !isTurnAllowed({ side: 1, uTurn: true, rule: turnRule })) {
        diagnostics.oneWayRejects += 1;
        v.route = null;
        return;
      }
      v.route = { uTurn: true };
      if (v.mergeSignalUntil <= lastElapsed) v.blinkSide = 1;
      return;
    }

    const steer = v.playerSteer ?? 0;
    const turningLeft = steer < -0.3;
    const turningRight = steer > 0.3;
    let route = null;
    if (turningLeft) {
      route = choices.find((choice) => choice.side < 0)
        || choices.find((choice) => choice.side === 0)
        || choices[0];
    } else if (turningRight) {
      route = choices.find((choice) => choice.side > 0)
        || choices.find((choice) => choice.side === 0)
        || choices[0];
    } else {
      route = choices.find((choice) => choice.side === 0) || choices[0];
    }
    v.route = route;
    if (v.mergeSignalUntil <= lastElapsed) v.blinkSide = route.side;
  }

  function sampleTurn(turn, u) {
    const inv = 1 - u;
    const inv2 = inv * inv;
    const u2 = u * u;
    samp.x = inv2 * inv * turn.p0x
      + 3 * inv2 * u * turn.p1x
      + 3 * inv * u2 * turn.p2x
      + u2 * u * turn.p3x;
    samp.y = inv2 * inv * turn.p0y
      + 3 * inv2 * u * turn.p1y
      + 3 * inv * u2 * turn.p2y
      + u2 * u * turn.p3y;
    samp.z = inv2 * inv * turn.p0z
      + 3 * inv2 * u * turn.p1z
      + 3 * inv * u2 * turn.p2z
      + u2 * u * turn.p3z;

    const dx = 3 * inv2 * (turn.p1x - turn.p0x)
      + 6 * inv * u * (turn.p2x - turn.p1x)
      + 3 * u2 * (turn.p3x - turn.p2x);
    const dy = 3 * inv2 * (turn.p1y - turn.p0y)
      + 6 * inv * u * (turn.p2y - turn.p1y)
      + 3 * u2 * (turn.p3y - turn.p2y);
    const dz = 3 * inv2 * (turn.p1z - turn.p0z)
      + 6 * inv * u * (turn.p2z - turn.p1z)
      + 3 * u2 * (turn.p3z - turn.p2z);
    const horizontal = Math.hypot(dx, dz) || 1;
    samp.tx = dx / horizontal;
    samp.ty = dy / horizontal;
    samp.tz = dz / horizontal;
  }

  function measureTurnArc(turn) {
    sampleTurn(turn, 0);
    let lastX = samp.x;
    let lastY = samp.y;
    let lastZ = samp.z;
    let lastHeading = Math.atan2(samp.tx, samp.tz);
    let minRadius = Infinity;
    for (let step = 1; step <= 12; step += 1) {
      sampleTurn(turn, step / 12);
      const segmentLength = Math.hypot(
        samp.x - lastX,
        samp.y - lastY,
        samp.z - lastZ,
      );
      turn.length += segmentLength;
      turn.arc[step] = turn.length;
      const heading = Math.atan2(samp.tx, samp.tz);
      const headingDelta = Math.abs(Math.atan2(
        Math.sin(heading - lastHeading),
        Math.cos(heading - lastHeading),
      ));
      if (headingDelta > 1e-4) {
        minRadius = Math.min(minRadius, segmentLength / headingDelta);
      }
      lastX = samp.x;
      lastY = samp.y;
      lastZ = samp.z;
      lastHeading = heading;
    }
    turn.length = Math.max(0.1, turn.length);
    turn.minRadius = minRadius;
    if (Number.isFinite(minRadius)) {
      diagnostics.minTurnRadius = diagnostics.minTurnRadius === null
        ? minRadius
        : Math.min(diagnostics.minTurnRadius, minRadius);
    }
  }

  function beginTurn(v, overshoot = 0) {
    const route = v.route;
    if (!route || route.uTurn) return;

    const road = roads[v.road];
    const entryS = v.dir === 1 ? road.len - TURN_SPAN : TURN_SPAN;
    const offset = (road.laneOffset ?? LANE_OFFSET) + v.laneBias;
    sampleRoad(road, entryS);
    const inX = samp.tx * v.dir;
    const inY = samp.ty * v.dir;
    const inZ = samp.tz * v.dir;
    const p0x = samp.x + inZ * offset;
    const p0y = samp.y;
    const p0z = samp.z - inX * offset;

    const nextRoad = roads[route.road];
    const exitS = route.dir === 1 ? TURN_SPAN : nextRoad.len - TURN_SPAN;
    sampleRoad(nextRoad, exitS);
    const outX = samp.tx * route.dir;
    const outY = samp.ty * route.dir;
    const outZ = samp.tz * route.dir;
    const p3x = samp.x + outZ * offset;
    const p3y = samp.y;
    const p3z = samp.z - outX * offset;
    const turnRadius = route.side > 0
      ? TURN_SPAN - offset
      : route.side < 0 ? TURN_SPAN + offset : Infinity;
    const control = route.side === 0
      ? TURN_SPAN * 0.66
      : Math.max(2.8, turnRadius * 0.55228475);

    const turn = {
      route,
      node: road.endNode[v.dir === 1 ? 1 : 0],
      fromRoad: v.road,
      exitS,
      distance: 0,
      length: 0,
      arc: new Float32Array(13),
      p0x,
      p0y,
      p0z,
      p1x: p0x + inX * control,
      p1y: p0y + inY * control,
      p1z: p0z + inZ * control,
      p2x: p3x - outX * control,
      p2y: p3y - outY * control,
      p2z: p3z - outZ * control,
      p3x,
      p3y,
      p3z,
    };

    measureTurnArc(turn);
    v.s = entryS;
    v.turn = turn;
    if (overshoot > 0) advanceTurn(v, overshoot);
  }

  function beginUTurn(v, overshoot = 0) {
    const road = roads[v.road];
    const reverseDir = -v.dir;
    if (!isDirectionLegal(road, reverseDir)) {
      diagnostics.oneWayRejects += 1;
      // One-ways cannot reverse in place — rehome onto a legal directed edge.
      if (relocateOffHero(v)) return;
      v.speed = 0;
      v.route = null;
      v.turn = null;
      return;
    }
    const boundaryS = v.dir === 1 ? road.len : 0;
    sampleRoad(road, boundaryS);
    const inX = samp.tx * v.dir;
    const inY = samp.ty * v.dir;
    const inZ = samp.tz * v.dir;
    const outX = -inX;
    const outY = -inY;
    const outZ = -inZ;
    const offset = (road.laneOffset ?? LANE_OFFSET) + v.laneBias;
    const rightX = inZ;
    const rightZ = -inX;
    const p0x = samp.x + rightX * offset;
    const p0y = samp.y;
    const p0z = samp.z + rightZ * offset;
    const p3x = samp.x - rightX * offset;
    const p3y = samp.y;
    const p3z = samp.z - rightZ * offset;
    const control = Math.max(3.2, offset * 1.46);
    const route = {
      road: v.road,
      dir: reverseDir,
      side: 1,
      uTurn: true,
    };
    const turn = {
      route,
      node: road.endNode[v.dir === 1 ? 1 : 0],
      fromRoad: v.road,
      exitS: boundaryS,
      distance: 0,
      length: 0,
      arc: new Float32Array(13),
      p0x,
      p0y,
      p0z,
      p1x: p0x + inX * control,
      p1y: p0y + inY * control,
      p1z: p0z + inZ * control,
      p2x: p3x - outX * control,
      p2y: p3y - outY * control,
      p2z: p3z - outZ * control,
      p3x,
      p3y,
      p3z,
    };
    measureTurnArc(turn);
    diagnostics.uTurnStarts += 1;
    v.s = boundaryS;
    v.route = route;
    v.turn = turn;
    v.blinkSide = 1;
    if (overshoot > 0) advanceTurn(v, overshoot);
  }

  function turnParameterAtDistance(turn) {
    const target = Math.max(0, Math.min(turn.length, turn.distance));
    let step = 1;
    while (step < 12 && turn.arc[step] < target) step += 1;
    const before = turn.arc[step - 1];
    const segment = Math.max(1e-6, turn.arc[step] - before);
    return (step - 1 + (target - before) / segment) / 12;
  }

  function advanceTurn(v, distance) {
    const turn = v.turn;
    if (!turn) return;
    turn.distance += distance;
    if (turn.distance < turn.length) return;

    const overshoot = turn.distance - turn.length;
    const nextRoad = roads[turn.route.road];
    v.road = turn.route.road;
    v.dir = turn.route.dir;
    v.s = Math.max(0, Math.min(
      nextRoad.len,
      turn.exitS + v.dir * overshoot,
    ));
    v.turn = null;
    v.route = null;
    v.blinkSide = 0;
    diagnostics.routeTransitions += 1;
    if (turn.route.uTurn) diagnostics.uTurnTransitions += 1;
  }

  function exitIsBlocked(v) {
    const route = v.route;
    if (!route || route.uTurn) return false;
    const exitRoad = roads[route.road];
    const exitS = route.dir === 1 ? TURN_SPAN : exitRoad.len - TURN_SPAN;

    for (const other of vehicles) {
      if (other === v) continue;
      if (other.parked || vehicleIsCurbside(other)) continue;
      if (
        other.turn
        && other.turn.route.road === route.road
        && other.turn.route.dir === route.dir
      ) {
        // Only another turner ahead of this one in the arc blocks it. While
        // this vehicle is still approaching (v.turn null) it yields; once
        // both are in the intersection the leader owns the exit.
        if (!v.turn) return true;
        if (other.turn.distance > v.turn.distance) return true;
        continue;
      }
      if (other.road !== route.road || other.dir !== route.dir) continue;
      // The turn exits onto the far half of the crossing road; only traffic
      // at or ahead of the exit point in the receiving direction conflicts.
      const centerDelta = (other.s - exitS) * route.dir;
      if (centerDelta < 0 && Math.abs(centerDelta) > other.half + v.half + 1.2) continue;
      const required = other.half + v.half
        + MIN_GAP * weatherGapFactor()
        + Math.max(v.speed, other.speed)
          * MIN_MOVING_HEADWAY
          * weatherHeadwayFactor();
      if (centerDelta > -required * 0.25 && centerDelta < required) return true;
    }
    return false;
  }

  // Signal phasing protects cross traffic, but a fixed two-phase light does
  // not protect a permissive left across the opposing approach. Yield the
  // left to opposing oncoming traffic that can reach the node before this
  // turn clears; right turns and parallel through traffic stay concurrent.
  function opposingOncomingBlocksLeft(v, nodeIndex) {
    const road = roads[v.road];
    const node = nodes[nodeIndex];
    if (!node) return false;
    for (const edge of node.ends) {
      if (edge.road === v.road) continue;
      const approachDir = edge.end === 0 ? 1 : -1;
      const sampleRoadRef = roads[edge.road];
      const endPointS = edge.end === 0 ? 0 : sampleRoadRef.len;
      sampleRoad(sampleRoadRef, endPointS);
      const outX = samp.tx * approachDir;
      const outZ = samp.tz * approachDir;
      sampleRoad(road, v.dir === 1 ? road.len : 0);
      const inX = samp.tx * v.dir;
      const inZ = samp.tz * v.dir;
      if (inX * outX + inZ * outZ > -0.86) continue; // not the opposing approach
      for (const other of vehicles) {
        if (other === v || other.parked || vehicleIsCurbside(other)) continue;
        if (other.turn) {
          if (other.turn.node === nodeIndex && other.turn.route.side <= 0) return true;
          continue;
        }
        if (other.road !== edge.road || other.dir !== approachDir) continue;
        const distanceToNode = Math.abs(other.s - endPointS);
        if (distanceToNode > 30) continue;
        if (other.speed < 0.8) continue; // a queued approach poses no conflict
        const arrival = distanceToNode / Math.max(1.5, other.speed);
        if (arrival < 2.6) return true;
      }
    }
    return false;
  }

  function leftTurnConflict(v) {
    const route = v.route;
    if (!route || route.uTurn) return false;
    if (route.side >= 0) return false;
    const road = roads[v.road];
    const end = v.dir === 1 ? 1 : 0;
    const nodeIndex = road.endNode[end];
    if (opposingOncomingBlocksLeft(v, nodeIndex)) return true;
    for (const other of vehicles) {
      if (other === v || !other.turn || other.turn.node !== nodeIndex) continue;
      if (other.turn.fromRoad === v.road) continue;
      if (other.turn.route.side < 0) return true;
    }
    return false;
  }

  // Two permissive lefts from opposing approaches swing through each other at
  // these compact nodes. Serialize them: the first vehicle to commit to the
  // pocket (within 1.5 s of arrival) goes, the other holds at the line.
  function opposingLeftTurnWait(v) {
    const route = v.route;
    if (!route || route.uTurn || route.side >= 0) return false;
    const road = roads[v.road];
    const end = v.dir === 1 ? 1 : 0;
    const nodeIndex = road.endNode[end];
    for (const other of vehicles) {
      if (other === v || other.parked || vehicleIsCurbside(other)) continue;
      if (other.turn) {
        if (other.turn.node !== nodeIndex || other.turn.fromRoad === v.road) continue;
        if (other.turn.route.side < 0) return true;
        continue;
      }
      const otherRoute = other.route;
      if (!otherRoute || otherRoute.uTurn || otherRoute.side >= 0) continue;
      const otherRoad = roads[other.road];
      const otherEnd = other.dir === 1 ? 1 : 0;
      if (otherRoad.endNode[otherEnd] !== nodeIndex) continue;
      if (other.road === v.road) continue;
      // Same axis but opposite direction = the opposing approach.
      sampleRoad(road, end === 1 ? road.len : 0);
      const inX = samp.tx * v.dir;
      const inZ = samp.tz * v.dir;
      sampleRoad(otherRoad, otherEnd === 1 ? otherRoad.len : 0);
      const outX = samp.tx * other.dir;
      const outZ = samp.tz * other.dir;
      if (inX * outX + inZ * outZ > -0.86) continue;
      const myArrival = (distanceToEnd(v, road) - STOP_MARGIN - v.half)
        / Math.max(1.5, v.speed);
      const otherArrival = (distanceToEnd(other, otherRoad) - STOP_MARGIN - other.half)
        / Math.max(1.5, other.speed);
      if (otherArrival < myArrival - 0.25) return true;
    }
    return false;
  }

  function turnSpeedLimit(v, side = v.route?.side ?? v.turn?.route.side ?? 0) {
    const activeRoute = v.turn?.route || v.route;
    const surfaceFactor = weatherMode === 'drizzle' ? 0.82 : weatherMode === 'fog' ? 0.9 : 1;
    if (activeRoute?.uTurn) {
      return (v.cls === 'bus' || v.cls === 'truck' ? 2.35 : 3.15) * surfaceFactor;
    }
    if (side === 0) return Infinity;
    const heavyFactor = v.cls === 'bus' ? 0.78 : v.cls === 'truck' ? 0.84 : 1;
    // SF drivers take compact right turns more slowly than broad left arcs.
    return (side > 0 ? 4.7 : 6.2) * heavyFactor * surfaceFactor;
  }

  function compareLaneProgress(a, b) {
    return b.s * b.dir - a.s * a.dir;
  }

  function vehicleIsCurbside(v) {
    return Number.isFinite(v.curbDwellUntil);
  }

  // Gap gate shared by parked cars and curb-service vehicles merging back
  // into the travel lane: the nearest moving follower must be able to lift
  // without emergency braking while this vehicle accelerates from zero.
  function pullOutClear(v) {
    const bucket = laneBuckets[v.road * 2 + (v.dir === 1 ? 0 : 1)];
    for (const other of bucket) {
      if (other === v || other.parked) continue;
      const behind = (v.s - other.s) * v.dir;
      if (behind <= -other.half - v.half) continue; // other is already ahead
      const gap = behind - other.half - v.half;
      const mergeRoom = MIN_GAP * weatherGapFactor()
        + 2.2
        + other.speed * (MIN_MOVING_HEADWAY + 0.55) * weatherHeadwayFactor();
      if (gap < mergeRoom) return false;
    }
    return true;
  }

  function rebuildLaneLeaders() {
    frameMinLaneGap = Infinity;
    frameMinMovingHeadway = Infinity;
    frameMinStoppedGap = Infinity;
    frameWorstHeadway = null;
    for (const bucket of laneBuckets) bucket.length = 0;
    for (const v of vehicles) {
      v.leader = null;
      // A locally driven vehicle still participates in the lane ordering so
      // its forward safety correction can produce a real impact consequence.
      // Remote vehicles remain excluded because their network poses do not
      // own a reliable road-progress value in this simulation.
      if (v.parked || v.impounded || v.garageStored || vehicleIsCurbside(v) || v.remoteControlled) continue;
      const bucketIndex = v.road * 2 + (v.dir === 1 ? 0 : 1);
      laneBuckets[bucketIndex].push(v);
    }

    for (const bucket of laneBuckets) {
      if (bucket.length < 2) continue;
      bucket.sort(compareLaneProgress);
      for (let index = 1; index < bucket.length; index += 1) {
        const follower = bucket[index];
        const leader = bucket[index - 1];
        follower.leader = leader;
        follower.leadS = leader.s;
        follower.leadSpeed = leader.speed;
        follower.leadHalf = leader.half;
        const gap = (leader.s - follower.s) * follower.dir
          - leader.half
          - follower.half;
        frameMinLaneGap = Math.min(frameMinLaneGap, gap);
        if (!follower.turn && follower.speed > 1) {
          const headway = gap / follower.speed;
          if (headway < frameMinMovingHeadway) {
            frameMinMovingHeadway = headway;
            frameWorstHeadway = {
              follower: follower.cls,
              leader: leader.cls,
              gap: Math.round(gap * 100) / 100,
              speed: Math.round(follower.speed * 100) / 100,
              road: follower.road,
              turningFollower: false,
              turningLeader: Boolean(leader.turn),
            };
          }
        } else if (!follower.turn && follower.speed < 0.35 && leader.speed < 0.35) {
          frameMinStoppedGap = Math.min(frameMinStoppedGap, gap);
        }
      }
    }
  }

  function updateMuniRideProgress() {
    if (!muniRide || muniRide.arrived) return;
    const vehicle = muniRide.vehicle;
    const point = vehicle.mesh.root.position;
    muniRide.traveled += Math.hypot(point.x - muniRide.lastX, point.z - muniRide.lastZ);
    muniRide.lastX = point.x;
    muniRide.lastZ = point.z;
    const dwelling = vehicle.speed < 0.25
      && Number.isFinite(vehicle.curbDwellUntil)
      && vehicle.curbDwellUntil > lastElapsed;
    if (!muniRide.departed) {
      if (!dwelling && (muniRide.traveled > 1.5 || vehicle.speed > 0.6)) {
        muniRide.departed = true;
      }
      return;
    }
    if (dwelling && muniRide.traveled >= 8) {
      muniRide.arrived = true;
      muniRide.arrivedAt = lastElapsed;
    }
  }

  function update(dt, elapsed) {
    if (!vehicles.length) return;
    if (!Number.isFinite(dt) || dt <= 0) {
      diagnostics.invalidDtCount += 1;
      return;
    }
    diagnostics.maxInputDt = Math.max(diagnostics.maxInputDt, dt);
    if (dt > MAX_DT) diagnostics.dtClampCount += 1;
    dt = Math.min(dt, MAX_DT);
    lastElapsed = Number.isFinite(elapsed) ? elapsed : lastElapsed + dt;
    const t = lastElapsed;
    if (pursuitBookingVisual.vehicleIndex >= 0 && t >= pursuitBookingVisual.until) {
      const bookingVehicle = vehicles[pursuitBookingVisual.vehicleIndex];
      if (bookingVehicle) bookingVehicle.mesh.root.userData.pursuitBooking = false;
      pursuitBookingVisual.vehicleIndex = -1;
      pursuitBookingVisual.until = 0;
    }
    const playerImpactStart = playerVehicle
      ? {
        x: playerVehicle.mesh.root.position.x,
        z: playerVehicle.mesh.root.position.z,
      }
      : null;
    const vehicleMotionStarts = new Map(vehicles.map((vehicle) => [vehicle, {
      x: vehicle.mesh.root.position.x,
      z: vehicle.mesh.root.position.z,
      heading: Number.isFinite(vehicle.heading) ? vehicle.heading : vehicle.mesh.root.rotation.y,
      road: vehicle.road,
      s: vehicle.s,
      turn: vehicle.turn,
      turnDistance: vehicle.turn?.distance ?? null,
    }]));
    rebuildLaneLeaders();

    let speedSum = 0;
    let movingCount = 0;
    let queuedCount = 0;
    let signalQueuedCount = 0;
    let turningCount = 0;
    let visibleCount = 0;

    for (let vehicleIndex = 0; vehicleIndex < vehicles.length; vehicleIndex += 1) {
      const v = vehicles[vehicleIndex];
      const embodimentQaHeld = vehicleEmbodimentQaHold?.vehicle === v
        && !v.playerControlled;
      let road = roads[v.road];
      if (v.impounded || v.garageStored) {
        v.speed = 0;
        v.longitudinalAccel = 0;
        v.accelSm = 0;
        v.blinkSide = 0;
        v.mesh.root.visible = false;
        continue;
      }
      const pursuitResponderActive = pursuitResponder.active
        && pursuitResponder.targetIndexes.includes(vehicleIndex)
        && !v.playerControlled
        && !v.remoteControlled;
      const pursuitDeploymentHoldRequested = pursuitResponderActive
        && pursuitDeploymentHoldIds.has(vehicleIndex);
      const pursuitBookingActive = !pursuitResponder.active
        && pursuitBookingVisual.vehicleIndex === vehicleIndex
        && t < pursuitBookingVisual.until
        && !v.playerControlled
        && !v.remoteControlled;
      if (pursuitResponderActive) {
        v.pursuitResponder = true;
        v.pursuitLevel = pursuitResponder.level;
        const userData = v.mesh.root.userData || (v.mesh.root.userData = {});
        userData.pursuitResponder = true;
        userData.pursuitLevel = pursuitResponder.level;
        v.hazardUntil = Math.max(v.hazardUntil, t + 0.42);
      }
      if (v.mesh.pursuitKit) {
        const pursuitVisualActive = pursuitResponderActive || pursuitBookingActive;
        v.mesh.pursuitKit.visible = pursuitVisualActive;
        const redOn = pursuitVisualActive
          && (t * 5.4 + vehicleIndex * 0.17) % 1 < 0.46;
        const blueOn = pursuitVisualActive && !redOn;
        const redMaterial = redOn ? shared.pursuitRedOnMat : shared.pursuitRedOffMat;
        const blueMaterial = blueOn ? shared.pursuitBlueOnMat : shared.pursuitBlueOffMat;
        for (const light of v.mesh.pursuitLights.red) {
          if (light.material !== redMaterial) light.material = redMaterial;
        }
        for (const light of v.mesh.pursuitLights.blue) {
          if (light.material !== blueMaterial) light.material = blueMaterial;
        }
      }
      const combatData = v.mesh.root.userData || {};
      const combatBrakeUntil = Number(combatData.combatBrakeUntil);
      const combatBrakeActive = Number.isFinite(combatBrakeUntil)
        && combatBrakeUntil > 0
        && (combatData.combatReaction === 'brake' || combatData.combatReaction === 'staggered');
      if (combatBrakeActive) {
        v.hazardUntil = Math.max(v.hazardUntil, t + 0.75);
      }

      // A remote player owns this vehicle: the networking layer drives its
      // mesh directly and the local AI must not move, queue, or rehome it.
      if (v.remoteControlled) {
        v.speed = 0;
        v.longitudinalAccel = 0;
        v.blinkSide = 0;
        continue;
      }

      // Parked vehicles wait out a staggered curb window, then rejoin the
      // moving lane through the pull-out path below. They never route, queue
      // in lane buckets, or hold signals while curbside.
      if (v.parked) {
        if (v.parkedAt === null) v.parkedAt = t;
        v.longitudinalAccel = 0;
        v.accelSm = 0;
        v.speed = 0;
        v.blinkSide = 0;
        if (t >= v.parkedAt + v.dwellUntil) {
          v.blinkSide = -1;
          if (pullOutClear(v)) {
            v.parked = false;
            v.parkedAt = null;
            v.speed = 0;
            v.blinkSide = -1;
            v.mergeSignalUntil = t + MERGE_SIGNAL_SECONDS;
            v.pullOutBlockedSince = null;
            diagnostics.curbPullOuts += 1;
            v.route = null;
          } else if (v.pullOutBlockedSince === null) {
            v.pullOutBlockedSince = t;
          } else if (t - v.pullOutBlockedSince > 45) {
            // A genuinely boxed-in curb slot: relocate rather than strand the
            // actor forever. Rare by construction (spawn keeps clearance).
            relocateOffHero(v);
            v.parkedAt = t;
            v.pullOutBlockedSince = null;
            road = roads[v.road];
          }
        }
      }

      if (
        !v.parked
        && v.mergeSignalUntil > 0
        && t >= v.mergeSignalUntil
      ) {
        v.mergeSignalUntil = 0;
        v.blinkSide = v.route?.side ?? 0;
      }

      if (!embodimentQaHeld && !v.turn && !v.route && distanceToEnd(v, road) < ROUTE_LOOKAHEAD) {
        if (v.playerControlled) planPlayerRoute(v);
        else planRoute(v);
      }

      const targetRoad = v.turn ? roads[v.turn.route.road] : road;
      let desired = roadCruise(v, targetRoad)
        * (1 + 0.035 * Math.sin(t * 0.31 + v.bobPhase));
      if (pursuitResponderActive && !v.parked) {
        const roadLimit = targetRoad.speedLimit ?? v.cruise;
        desired = Math.max(
          desired,
          Math.min(v.cruise * 1.28, roadLimit * 1.22),
        );
      }
      if (Number.isFinite(v.qaOnFootImpactSpeedCap)) {
        desired = Math.min(desired, Math.max(0, v.qaOnFootImpactSpeedCap));
      }
      let holdS = null;
      let curbHoldS = null;
      let curbApproach = 0;
      let signalRequiresStop = false;

      if (v.parked) {
        desired = 0;
      }
      if (pursuitBookingActive) {
        desired = 0;
        v.hazardUntil = Math.max(v.hazardUntil, pursuitBookingVisual.until);
      }

      if (!v.playerControlled) {
        if (v.turn) {
          desired = Math.min(desired, turnSpeedLimit(v));
          if (exitIsBlocked(v)) {
            const remaining = Math.max(0, v.turn.length - v.turn.distance - 0.22);
            const exitSpeed = Math.sqrt(
              2 * v.spec.brake * weatherBrakeFactor() * 0.58 * remaining,
            );
            desired = Math.min(desired, exitSpeed);
          }
          turningCount += 1;
        } else {
        const end = v.dir === 1 ? 1 : 0;
        const distLine = distanceToEnd(v, road) - STOP_MARGIN - v.half;
        const nodeIndex = road.endNode[end];
        const nodeControl = nodes[nodeIndex]?.control || 'none';
        const signal = nodeControl === 'stop' ? null : signals.get(nodeIndex);
        let mustStop = exitIsBlocked(v) || leftTurnConflict(v) || opposingLeftTurnWait(v);
        let stopRequiresStop = false;

        // Bleed speed before the curve rather than braking only after entering
        // it. The kinematic envelope yields natural approach speeds without a
        // path solver or allocations in the hot loop.
        if (v.route && !v.route.uTurn && v.route.side !== 0) {
          const curveSpeed = turnSpeedLimit(v, v.route.side);
          const distanceToCurve = Math.max(0, distanceToEnd(v, road) - TURN_SPAN);
          const approachSpeed = Math.sqrt(
            curveSpeed * curveSpeed
            + 2 * v.spec.brake * weatherBrakeFactor() * 0.58 * distanceToCurve,
          );
          desired = Math.min(desired, approachSpeed);
        }

        if (nodeControl === 'stop' && distLine >= -0.05 && v.stopClearedNode !== nodeIndex) {
          stopRequiresStop = true;
          if (
            distLine < 2.6
            && v.speed < 0.45
          ) {
            if (!v.waitingAtStop) {
              diagnostics.stopSignStops += 1;
              v.waitingAtStop = true;
              v.stopHoldUntil = t + STOP_SIGN_HOLD;
            }
            if (t < v.stopHoldUntil || exitIsBlocked(v)) {
              stopRequiresStop = true;
            } else {
              v.waitingAtStop = false;
              v.stopHoldUntil = Infinity;
              v.stopClearedNode = nodeIndex;
              stopRequiresStop = false;
              diagnostics.stopSignReleases += 1;
            }
          }
        } else if (v.stopClearedNode === nodeIndex && distLine < -1.5) {
          // Left the cleared node far enough that a later revisit must stop.
          v.stopClearedNode = -1;
        } else if (nodeControl !== 'stop') {
          v.waitingAtStop = false;
          v.stopHoldUntil = Infinity;
        }

        if (signal && distLine >= -0.05) {
          const phase = signalPhaseAt(road.signalGroup[end], t, signal.offset);
          const comfortableBrake = v.spec.brake * weatherBrakeFactor() * 0.72;
          const brakeDistance = (v.speed * v.speed) / (2 * comfortableBrake)
            + v.speed * SIGNAL_REACTION;
          if (phase === 'red') signalRequiresStop = true;
          // Commit through a yellow when stopping would require emergency
          // braking. Otherwise settle at the line with the normal decel model.
          if (phase === 'yellow' && distLine > brakeDistance + 0.35) {
            signalRequiresStop = true;
          }
        }

        // Curb program: transit, taxis, field service and local delivery all
        // enter the parking lane before stopping. The stop targets stay clear
        // of intersections, and a dwell actor leaves the travel-lane leader
        // buckets so through traffic can pass instead of forming a fake queue.
        if (!v.parked) {
          if (v.cls === 'bus') {
            const plan = busStopPlans[v.road];
            if (plan && v.busStopIndex < 0) {
              const position = v.dir === 1 ? v.s : road.len - v.s;
              for (let i = 0; i < plan.stops.length; i += 1) {
                if (plan.stops[i] - position > 8) {
                  v.busStopIndex = i;
                  v.nextCurbStopAt = plan.stops[i];
                  break;
                }
              }
            }
            if (v.busStopIndex >= 0) {
              const stopS = v.dir === 1
                ? v.nextCurbStopAt
                : road.len - v.nextCurbStopAt;
              const distStop = (stopS - v.s) * v.dir - v.half;
              if (distStop < 26) {
                if (distStop < CURB_APPROACH_DISTANCE) {
                  const approachLinear = Math.max(
                    0,
                    Math.min(1, (CURB_APPROACH_DISTANCE - Math.max(0, distStop))
                      / CURB_APPROACH_DISTANCE),
                  );
                  curbApproach = approachLinear * approachLinear * (3 - 2 * approachLinear);
                  if (distStop > 0.45 && v.mergeSignalUntil <= t) v.blinkSide = 1;
                }
                const comfort = v.spec.brake * weatherBrakeFactor() * 0.55;
                const stopSpeed = distStop > 0.1
                  ? Math.sqrt(2 * comfort * Math.max(0, distStop - 0.1))
                  : 0;
                desired = Math.min(desired, stopSpeed);
                if (distStop < 0.5 && v.speed < 0.2) {
                  curbHoldS = stopS;
                  if (v.curbDwellUntil === Infinity) {
                    v.curbDwellUntil = t + BUS_DWELL_MIN
                      + v.servicePhase * BUS_DWELL_SPAN;
                    diagnostics.busStopDwells += 1;
                    v.hazardUntil = v.curbDwellUntil;
                  }
                }
              }
            }
          } else {
            const serviceProfile = CURB_SERVICE_PROFILES[v.identity.curbService];
            if (
              serviceProfile
              && v.nextCurbStopAt === Infinity
              && t >= v.nextServiceAt
              && !v.route
            ) {
              const position = v.dir === 1 ? v.s : road.len - v.s;
              const ahead = serviceProfile.ahead
                + v.servicePhase * serviceProfile.aheadSpan;
              const latestTarget = road.len - CURB_STOP_END_MARGIN;
              if (latestTarget - position >= CURB_APPROACH_DISTANCE * 0.8) {
                v.nextCurbStopAt = Math.min(position + ahead, latestTarget);
              } else {
                // Retry on the next long block instead of carrying a curb
                // target through an intersection or stopping in the box.
                v.nextServiceAt = t + 4;
              }
            }
            if (serviceProfile && v.nextCurbStopAt !== Infinity) {
              const stopS = v.dir === 1
                ? v.nextCurbStopAt
                : road.len - v.nextCurbStopAt;
              const distStop = (stopS - v.s) * v.dir - v.half;
              if (distStop < CURB_APPROACH_DISTANCE + 2) {
                const approachLinear = Math.max(
                  0,
                  Math.min(1, (CURB_APPROACH_DISTANCE - Math.max(0, distStop))
                    / CURB_APPROACH_DISTANCE),
                );
                curbApproach = approachLinear * approachLinear * (3 - 2 * approachLinear);
                if (distStop > 0.45 && v.mergeSignalUntil <= t) v.blinkSide = 1;
                const comfort = v.spec.brake * weatherBrakeFactor() * 0.55;
                const stopSpeed = distStop > 0.1
                  ? Math.sqrt(2 * comfort * Math.max(0, distStop - 0.1))
                  : 0;
                desired = Math.min(desired, stopSpeed);
                if (distStop < 0.45 && v.speed < 0.2) {
                  curbHoldS = stopS;
                  if (v.curbDwellUntil === Infinity) {
                    v.curbDwellUntil = t + serviceProfile.dwell
                      + v.servicePhase * serviceProfile.dwellSpan;
                    v.hazardUntil = v.curbDwellUntil;
                    if (v.identity.curbService === 'taxi') {
                      diagnostics.taxiPickups += 1;
                    } else if (v.identity.curbService === 'delivery') {
                      diagnostics.deliveryStops += 1;
                    } else {
                      diagnostics.serviceStops += 1;
                    }
                  }
                }
              }
            }
          }
        }

        if (
          signalRequiresStop
          && distLine < 2.6
          && distLine >= -0.05
          && v.speed < 0.45
        ) {
          if (!v.waitingForGreen) diagnostics.signalStops += 1;
          v.waitingForGreen = true;
          v.greenReleaseAt = Infinity;
        } else if (!signalRequiresStop && v.waitingForGreen) {
          if (!Number.isFinite(v.greenReleaseAt)) {
            v.greenReleaseAt = t + v.reactionDelay;
          }
          if (t < v.greenReleaseAt) {
            signalRequiresStop = true;
          } else {
            v.waitingForGreen = false;
            v.greenReleaseAt = Infinity;
            diagnostics.greenReleases += 1;
          }
        }
        mustStop ||= signalRequiresStop || stopRequiresStop;

        if (mustStop && distLine >= -0.05) {
          const comfortableBrake = v.spec.brake * weatherBrakeFactor() * 0.72;
          const stopSpeed = distLine > 0.08
            ? Math.sqrt(2 * comfortableBrake * Math.max(0, distLine - 0.08))
            : 0;
          desired = Math.min(desired, stopSpeed);
          holdS = v.dir === 1
            ? road.len - STOP_MARGIN - v.half
            : STOP_MARGIN + v.half;
        }

        if (v.leader) {
          const ahead = (v.leadS - v.s) * v.dir;
          const leadGap = ahead - v.leadHalf - v.half;
          const surfaceGap = MIN_GAP * weatherGapFactor();
          const minimumHeadway = (MIN_MOVING_HEADWAY + HEADWAY_PLANNING_BUFFER)
            * weatherHeadwayFactor();
          const wantedGap = surfaceGap
            + v.speed * v.timeHeadway * weatherHeadwayFactor();
          const headwaySpeed = Math.max(
            0,
            (leadGap - surfaceGap) / Math.max(0.1, minimumHeadway + dt),
          );
          desired = Math.min(desired, headwaySpeed);
          const closing = Math.max(0, v.speed - v.leadSpeed);
          const safeGap = wantedGap
            + (closing * closing) / Math.max(
              0.1,
              2 * v.spec.brake * weatherBrakeFactor() * 0.78,
            );
          if (leadGap < safeGap) {
            const usableGap = Math.max(
              0,
              leadGap - surfaceGap,
            );
            const reaction = v.timeHeadway * weatherHeadwayFactor() * 0.42;
            const braking = v.spec.brake * weatherBrakeFactor() * 0.72;
            const safeSpeed = Math.max(
              0,
              -braking * reaction + Math.sqrt(
                braking * braking * reaction * reaction
                + v.leadSpeed * v.leadSpeed
                + 2 * braking * usableGap,
              ),
            );
            const followSpeed = Math.max(
              0,
              v.leadSpeed + (leadGap - wantedGap) * 0.72,
            );
            desired = Math.min(desired, followSpeed, safeSpeed);
          }
          if (leadGap < surfaceGap) desired = 0;
        }
        }
      } else {
        const roadLimit = road.speedLimit ?? v.cruise;
        const throttle = THREE.MathUtils.clamp(playerInput.throttle, 0, 1);
        const brake = THREE.MathUtils.clamp(playerInput.brake, 0, 1);
        const targetSpeed = throttle > 0
          ? Math.min(v.cruise * 1.2, roadLimit * 1.08) * throttle
          : 0;
        desired = brake > 0 ? 0 : targetSpeed;
        v.playerSteer = THREE.MathUtils.clamp(playerInput.steer, -1, 1);
        v.blinkSide = Math.abs(v.playerSteer) > 0.28 ? Math.sign(v.playerSteer) : 0;
        if (v.turn) desired = Math.min(desired, turnSpeedLimit(v));
        if (brake > 0 && v.speed > 0) {
          v.longitudinalAccel = Math.max(
            -v.spec.brake * 0.92 * brake,
            v.longitudinalAccel,
          );
        }
      }

      // A nearby shot makes civilian traffic brake hard for a brief, visible
      // beat. The normal kinematic envelope still owns the actual movement,
      // so lane safety, turns, and recovery back to cruising remain intact.
      if (combatBrakeActive && !v.parked) {
        const urgency = 1;
        const brakeTarget = Math.max(
          0,
          v.speed - v.spec.brake * (0.78 + urgency * 0.34) * dt,
        );
        desired = Math.min(desired, brakeTarget);
        v.longitudinalAccel = Math.min(
          v.longitudinalAccel,
          -v.spec.brake * (0.4 + urgency * 0.45),
        );
      }
      if (v.disabled) {
        desired = 0;
        v.playerSteer = 0;
        v.longitudinalAccel = Math.min(0, v.longitudinalAccel);
      }

      // On-foot responders make a real curbside handoff instead of driving
      // through their paired officer. The normal deceleration envelope owns
      // the approach; once the car is below deployment speed, pin its exact
      // road/turn coordinate until the caller releases the bounded hold.
      if (pursuitDeploymentHoldRequested) {
        desired = 0;
        v.hazardUntil = Math.max(v.hazardUntil, t + 0.42);
        if (v.speed <= 2) {
          v.speed = 0;
          v.longitudinalAccel = 0;
          v.accelSm = 0;
          pursuitDeploymentHoldingIds.add(vehicleIndex);
        } else {
          pursuitDeploymentHoldingIds.delete(vehicleIndex);
        }
      } else {
        pursuitDeploymentHoldingIds.delete(vehicleIndex);
      }
      if (v.mesh.root.userData) {
        v.mesh.root.userData.pursuitDeploymentHoldRequested = pursuitDeploymentHoldRequested;
        v.mesh.root.userData.pursuitDeploymentHolding = pursuitDeploymentHoldingIds.has(vehicleIndex);
      }

      // Servicing a curb hold: stay stopped in the parking lane until the
      // dwell elapses, then merge back through a gap check.
      if (curbHoldS !== null && t < v.curbDwellUntil) {
        desired = 0;
      } else if (curbHoldS !== null && t >= v.curbDwellUntil) {
        if (pullOutClear(v)) {
          const serviceProfile = CURB_SERVICE_PROFILES[v.identity.curbService];
          v.curbDwellUntil = Infinity;
          v.nextCurbStopAt = Infinity;
          v.nextServiceAt = serviceProfile
            ? t + serviceProfile.cooldown + v.servicePhase * serviceProfile.cooldownSpan
            : Infinity;
          v.busStopIndex = -1;
          v.blinkSide = -1;
          v.mergeSignalUntil = t + MERGE_SIGNAL_SECONDS;
          v.hazardUntil = 0;
          v.pullOutBlockedSince = null;
          diagnostics.curbPullOuts += 1;
        } else {
          desired = 0;
          if (v.pullOutBlockedSince === null) v.pullOutBlockedSince = t;
        }
      } else if (!v.parked) {
        v.pullOutBlockedSince = null;
      }

      const previousSpeed = v.speed;
      const speedDelta = desired - v.speed;
      const accelerationTarget = Math.max(
        -v.spec.brake,
        Math.min(v.spec.accel, speedDelta * 1.75),
      );
      const jerkLimit = accelerationTarget < v.longitudinalAccel
        ? v.spec.jerkDown
        : v.spec.jerkUp;
      const previousCommandAccel = v.longitudinalAccel;
      v.longitudinalAccel += Math.max(
        -jerkLimit * dt,
        Math.min(jerkLimit * dt, accelerationTarget - v.longitudinalAccel),
      );
      diagnostics.maxAcceleration = Math.max(
        diagnostics.maxAcceleration,
        v.longitudinalAccel,
      );
      diagnostics.maxDeceleration = Math.min(
        diagnostics.maxDeceleration,
        v.longitudinalAccel,
      );
      diagnostics.maxJerk = Math.max(
        diagnostics.maxJerk,
        Math.abs((v.longitudinalAccel - previousCommandAccel) / dt),
      );
      const integratedSpeed = v.speed + v.longitudinalAccel * dt;
      v.speed = speedDelta >= 0
        ? Math.min(desired, integratedSpeed)
        : Math.max(desired, integratedSpeed);
      v.speed = Math.max(0, v.speed);
      if (v.speed < 0.015 && desired < 0.015) v.speed = 0;
      if (v.speed === 0 && v.longitudinalAccel < 0) v.longitudinalAccel = 0;

      if (v.turn) {
        const turnStep = v.speed * dt;
        if (
          v.turn.distance + turnStep >= v.turn.length
          && exitIsBlocked(v)
        ) {
          v.turn.distance = Math.min(v.turn.distance, v.turn.length - 0.22);
          v.speed = 0;
          v.longitudinalAccel = 0;
        } else {
          advanceTurn(v, turnStep);
        }
      } else {
        let positionClamped = false;
        let nextS = v.s + v.dir * v.speed * dt;
        if (v.leader) {
          const leaderIndex = vehicles.indexOf(v.leader);
          const responderContact = pursuitResponder.active
            && pursuitResponder.targetIndexes.includes(leaderIndex);
          const gapAfter = (v.leadS - nextS) * v.dir - v.leadHalf - v.half;
          const emergencyGap = v.playerControlled
            ? 0.12
            : MIN_GAP * weatherGapFactor()
              + v.speed * MIN_MOVING_HEADWAY * weatherHeadwayFactor();
          if (gapAfter < emergencyGap) {
            const correction = emergencyGap - gapAfter;
            diagnostics.maxSafetyCorrection = Math.max(
              diagnostics.maxSafetyCorrection,
              correction,
            );
            const relativeImpactSpeed = Math.max(0, previousSpeed - v.leadSpeed);
            if (v.playerControlled
              && !v.disabled
              && t >= v.damageCooldownUntil
              && (!responderContact || !playerVehicleCollisionLatch.has(leaderIndex))
              && relativeImpactSpeed > 1.5) {
              const damage = responderContact
                ? 22
                : THREE.MathUtils.clamp(
                  relativeImpactSpeed * 7.5 + correction * 4,
                  6,
                  42,
                );
              const playerDamage = applyVehicleDamage(
                v,
                damage,
                responderContact ? 'pursuit-contact' : 'traffic-impact',
              );
              if (!v.leader.disabled) {
                const victimDamageAmount = THREE.MathUtils.clamp(
                  damage * (responderContact ? 0.32 : 0.55),
                  4,
                  24,
                );
                const victimDamage = applyVehicleDamage(
                  v.leader,
                  victimDamageAmount,
                  responderContact ? 'pursuit-response-impact' : 'reckless-collision',
                );
                v.leader.speed *= 0.72;
                v.leader.longitudinalAccel = Math.min(0, v.leader.longitudinalAccel);
                v.leader.hazardUntil = Math.max(v.leader.hazardUntil, t + 2.4);
                if (responderContact) diagnostics.sweptVehicleCollisionEvents += 1;
                else diagnostics.recklessCollisionEvents += 1;
                const collisionEvent = {
                  kind: responderContact ? 'pursuit-contact' : 'reckless-collision',
                  sequence: responderContact
                    ? diagnostics.sweptVehicleCollisionEvents
                    : diagnostics.recklessCollisionEvents,
                  playerVehicleId: vehicles.indexOf(v),
                  victimVehicleId: leaderIndex,
                  victimClass: v.leader.cls,
                  victimLabel: v.leader.identity?.label || v.leader.cls,
                  responderId: responderContact ? leaderIndex : null,
                  responderContact,
                  relativeSpeed: Math.round(relativeImpactSpeed * 10) / 10,
                  playerPath: 'road',
                  playerDamage,
                  victimDamage,
                };
                const aftermath = onPlayerVehicleCollision?.(collisionEvent) ?? null;
                if (aftermath && typeof aftermath === 'object') {
                  collisionEvent.aftermath = { ...aftermath };
                }
                diagnostics.lastPlayerCollision = collisionEvent;
                if (responderContact) {
                  diagnostics.lastSweptVehicleCollision = collisionEvent;
                  playerVehicleCollisionLatch.add(leaderIndex);
                }
              }
              v.damageCooldownUntil = t + VEHICLE_DAMAGE_COOLDOWN;
            }
            nextS = v.leadS - v.dir * (v.leadHalf + v.half + emergencyGap);
            v.speed = Math.min(v.speed, v.leadSpeed);
            v.longitudinalAccel = Math.min(0, v.longitudinalAccel);
            positionClamped = true;
          }
        }

        if (holdS !== null && (nextS - holdS) * v.dir >= 0) {
          nextS = holdS;
          v.speed = 0;
          v.longitudinalAccel = 0;
        }
        if (curbHoldS !== null && (nextS - curbHoldS) * v.dir >= 0) {
          nextS = curbHoldS;
          v.speed = 0;
          v.longitudinalAccel = 0;
        }
        if (v.playerControlled) {
          // This runs before beginTurn below. Enterable vehicle front bumpers
          // reach the authored stop line before their center reaches the
          // TURN_SPAN curve entry, so straight and steer-selected crossings
          // share the same red-light edge and debounce path.
          reportPlayerRedLightCrossing(v, road, nextS, t);
        }
        v.s = nextS;

        if (v.route && !v.route.uTurn) {
          const entryS = v.dir === 1 ? road.len - TURN_SPAN : TURN_SPAN;
          if (
            (v.s - entryS) * v.dir >= 0
            && (!v.playerControlled || v.speed > 0.6)
          ) {
            if (exitIsBlocked(v) || leftTurnConflict(v)) {
              v.s = entryS - v.dir * 0.2;
              v.speed = 0;
            } else {
              const overshoot = (v.s - entryS) * v.dir;
              v.s = entryS;
              beginTurn(v, overshoot);
            }
          }
        } else if (
          v.route?.uTurn
          && (v.dir === 1 ? v.s >= road.len : v.s <= 0)
          && (!v.playerControlled || v.speed > 0.6)
        ) {
          const boundaryS = v.dir === 1 ? road.len : 0;
          const overshoot = (v.s - boundaryS) * v.dir;
          v.s = boundaryS;
          beginUTurn(v, overshoot);
          v.speed = Math.min(v.speed, turnSpeedLimit(v));
        }
        if (positionClamped && !v.safetyClamped) diagnostics.safetyClamps += 1;
        v.safetyClamped = positionClamped;
      }

      // Keep an exact near-camera safety pocket at all times, while the wider
      // foreground remains protected only during startup. Actors leave through
      // the bottom edge before their roof clips the lens; normal post-gate
      // traffic can still occupy the rest of the avenue.
      if (
        lastElapsed < HERO_GATE_SECONDS
        &&
        !v.turn
        && !pursuitResponderActive
        && (v.cls === 'truck' || v.cls === 'bus')
        && heroCrossRoadSet.has(v.road)
      ) {
        relocateOffHero(v);
        road = roads[v.road];
        v.heading = null;
      }
      if (
        !v.turn
        && !pursuitResponderActive
        && v.road === heroRoadIndex
        && (
          v.s < heroCameraCutoff
          || (lastElapsed < HERO_GATE_SECONDS && v.s < heroForegroundCutoff)
        )
      ) {
        if (relocateOffHero(v)) {
          road = roads[v.road];
          v.heading = null;
          v.speed = Math.min(v.speed, v.cruise * 0.4);
        } else {
          // An extremely saturated network holds the actor at the visual
          // boundary rather than allowing overlap or entry into the lens.
          v.s = heroForegroundCutoff;
          v.speed = 0;
          v.route = null;
          v.blinkSide = 0;
        }
      }

      // Coaches on the northbound California segment dominate the pass-10
      // cable-car hero band. Rehome them to the surrounding grid continuously.
      if (
        !v.turn
        && !pursuitResponderActive
        && v.cls === 'bus'
        && heroNorthRoadIndex >= 0
        && v.road === heroNorthRoadIndex
        && v.s < Math.min(roads[heroNorthRoadIndex].len * 0.72, 58)
      ) {
        if (relocateOffHero(v)) {
          road = roads[v.road];
          v.heading = null;
          v.speed = Math.min(v.speed, v.cruise * 0.35);
        } else {
          v.speed = 0;
          v.route = null;
          v.blinkSide = 0;
        }
      }

      // Taxis staged on the northbound California curb were stealing the
      // cable-car hero band during QA captures. Keep them north of the lens.
      if (
        !v.turn
        && !pursuitResponderActive
        && v.cls === 'taxi'
        && heroNorthRoadIndex >= 0
        && v.road === heroNorthRoadIndex
        && v.s < Math.min(roads[heroNorthRoadIndex].len * 0.82, 72)
      ) {
        if (relocateOffHero(v)) {
          road = roads[v.road];
          v.heading = null;
          v.speed = Math.min(v.speed, v.cruise * 0.35);
        } else {
          v.speed = 0;
          v.route = null;
          v.blinkSide = 0;
        }
      }

      // Keep the central beauty aperture free of broadside light vehicles as
      // well. They continue on the connected grid, but a teleport at the
      // exact zebra/camera overlap prevents one-frame van walls from owning
      // the composition while the simulation is still warming up.
      if (
        lastElapsed < HERO_GATE_SECONDS
        &&
        !v.turn
        && !pursuitResponderActive
        && !(v.cls === 'truck' || v.cls === 'bus')
        && heroCrossRoadSet.has(v.road)
      ) {
        sampleRoad(roads[v.road], v.s);
        if (Math.abs(samp.x - 28) < 8.5 && Math.abs(samp.z) < 4.2) {
          if (relocateOffHero(v, true)) {
            road = roads[v.road];
            v.heading = null;
            v.speed = Math.min(v.speed, v.cruise * 0.4);
          }
        }
      }

      const actualAccel = (v.speed - previousSpeed) / dt;
      v.accelSm += (actualAccel - v.accelSm) * Math.min(1, dt * 5);
      road = roads[v.road];
      let fx;
      let fy;
      let fz;
      let px;
      let py;
      let pz;
      if (v.turn) {
        sampleTurn(v.turn, turnParameterAtDistance(v.turn));
        fx = samp.tx;
        fy = samp.ty;
        fz = samp.tz;
        px = samp.x;
        py = samp.y;
        pz = samp.z;
      } else {
        sampleRoad(road, v.s);
        fx = samp.tx * v.dir;
        fy = samp.ty * v.dir;
        fz = samp.tz * v.dir;
        const rightX = fz;
        const rightZ = -fx;
        const classLane = v.cls === 'bike'
          ? BIKE_LANE_OFFSET
          : (road.laneOffset ?? LANE_OFFSET);
        let normalOffset = classLane + v.laneBias;
        if (v.playerControlled) {
          const steerRate = 0.7 + Math.min(1, v.speed / 9) * 0.85;
          v.laneOffsetSm = v.laneOffsetSm === undefined
            ? normalOffset
            : THREE.MathUtils.clamp(
              v.laneOffsetSm + v.playerSteer * dt * steerRate,
              normalOffset - 1.65,
              normalOffset + 1.65,
            );
        } else {
          // A ~14 s wander period reads as human lane placement instead of
          // the visible 33 s weave the previous 0.19 rad/s produced at
          // city speeds.
          const laneDrift = Math.sin(t * 0.46 + v.bobPhase) * 0.028;
          normalOffset += laneDrift;
          const curbOffset = Math.min(
            CURB_LANE_LIMIT,
            CURB_LANE_OFFSET + v.laneBias * 0.3,
          );
          const curbHoldActive = v.cls !== 'bike' && (
            curbHoldS !== null
            || v.parked
            || vehicleIsCurbside(v)
          );
          const curbBlend = curbHoldActive ? 1 : (v.cls === 'bike' ? 0 : curbApproach);
          const targetOffset = normalOffset
            + (curbOffset - normalOffset) * curbBlend;
          const lateralRate = curbHoldActive ? 1.8
            : curbBlend > 0 ? 1.55
              : v.mergeSignalUntil > t ? 1.65
                : 2.2;
          if (embodimentQaHeld) {
            v.laneOffsetSm = vehicleEmbodimentQaHold.laneOffset;
          } else if (v === lastPlayerParkedVehicle && v.parked) {
            v.laneOffsetSm = v.laneOffsetSm === undefined ? targetOffset : v.laneOffsetSm;
          } else {
            v.laneOffsetSm = v.laneOffsetSm === undefined
              ? targetOffset
              : v.laneOffsetSm + (targetOffset - v.laneOffsetSm)
                * Math.min(1, dt * lateralRate);
          }
        }
        const offset = v.laneOffsetSm;
        if (
          v.mergeSignalUntil > t
          && v.speed > 0.8
          && Math.abs(offset - normalOffset) < 0.12
        ) {
          v.mergeSignalUntil = 0;
          v.blinkSide = v.route?.side ?? 0;
        }
        px = samp.x + rightX * offset;
        py = samp.y;
        pz = samp.z + rightZ * offset;
      }

      const heading = Math.atan2(fx, fz);
      const headingDelta = v.heading === null
        ? 0
        : Math.atan2(
          Math.sin(heading - v.heading),
          Math.cos(heading - v.heading),
        );
      v.heading = heading;
      const yawRate = headingDelta / dt;
      v.mesh.root.position.set(px, py, pz);
      v.mesh.root.rotation.set(
        -Math.atan2(fy, Math.hypot(fx, fz)),
        heading,
        0,
      );
      const distanceSquared = (px - focusX) ** 2 + (pz - focusZ) ** 2;
      const visible = !focusActive || distanceSquared <= focusRadiusSquared;
      const nearDetail = !focusActive || distanceSquared <= TRAFFIC_NEAR_DETAIL_RADIUS_SQUARED;
      v.mesh.root.visible = (embodimentQaHeld || visible) && v.qaOnFootImpactHidden !== true;
      if (v.mesh.root.visible) visibleCount += 1;

      const speedRatio = Math.min(1, v.speed / v.spec.vMax);
      const damageRatio = 1 - v.health / Math.max(1, v.maxHealth);
      const damageSag = v.disabled ? 0.075 : damageRatio > 0.72 ? 0.035 : 0;
      v.mesh.bodyG.position.y = Math.sin(t * 8.5 + v.bobPhase) * 0.014 * speedRatio
        + Math.sin(t * 2.05 + v.bobPhase * 2) * 0.005
        - damageSag;
      v.mesh.bodyG.rotation.x = Math.max(
        -0.045,
        Math.min(0.045, -v.accelSm * 0.012),
      ) + (v.disabled ? 0.018 : 0);
      const rollTarget = Math.max(
        -0.06,
        Math.min(0.06, -yawRate * v.speed * 0.006),
      );
      v.rollSm += (rollTarget - v.rollSm) * Math.min(1, dt * 6);
      const damageLean = v.disabled
        ? (v.servicePhase < 0.5 ? -0.035 : 0.035)
        : damageRatio > 0.72 ? (v.servicePhase < 0.5 ? -0.014 : 0.014) : 0;
      v.mesh.bodyG.rotation.z = v.rollSm + damageLean;

      const wheelbase = v.spec.len * (v.cls === 'bus' ? 0.62 : 0.6);
      const steerTarget = Math.max(
        -0.52,
        Math.min(0.52, Math.atan((wheelbase * yawRate) / Math.max(0.8, v.speed))),
      );
      v.steerSm += (steerTarget - v.steerSm) * Math.min(1, dt * 9);
      if (v.playerControlled) {
        v.steerSm += (THREE.MathUtils.clamp(v.playerSteer * 0.5, -0.52, 0.52) - v.steerSm)
          * Math.min(1, dt * 5);
      }
      const spin = (v.speed / v.mesh.wheelR) * dt;
      for (const wheel of v.mesh.wheels) {
        wheel.rotation.x += spin;
        if (Math.abs(wheel.rotation.x) > Math.PI * 200) {
          wheel.rotation.x %= Math.PI * 2;
        }
      }
      for (const wheel of v.mesh.frontWheels) wheel.rotation.y = v.steerSm;

      if (v.mesh.wiperPivot) {
        if (weatherMode === 'drizzle' && !v.parked) {
          v.mesh.wiperPivot.visible = true;
          // Triangle-ish sweep: fast pass, brief park pause at the pillar.
          const cycle = (t * 0.9 + v.bobPhase) % 1.6;
          const sweep = cycle < 1.1 ? Math.sin(cycle / 1.1 * Math.PI) : 0;
          v.mesh.wiperPivot.rotation.z = 0.82 - sweep * 1.55;
        } else {
          v.mesh.wiperPivot.visible = false;
        }
      }

      if (v.detailedRoot) {
        // Polished taxi LOD stays up in clear/fog; drizzle keeps the opaque
        // procedural shell so wet-road reflections stay cheap and readable.
        const showDetailed = nearDetail
          && distanceSquared <= TRAFFIC_PRODUCTION_DETAIL_RADIUS_SQUARED
          && v.detailedReady
          && weatherMode !== 'drizzle'
          && v.detailedRoot.children.length > 0;
        v.detailedRoot.visible = showDetailed;
        v.mesh.bodyG.visible = nearDetail && !showDetailed;
        v.mesh.wheelG.visible = nearDetail && !showDetailed;
        if (showDetailed) {
          v.detailedRoot.position.copy(v.mesh.bodyG.position);
          v.detailedRoot.rotation.copy(v.mesh.bodyG.rotation);
          v.detailedTick?.(dt);
        }
      }

      v.mesh.proxyBody.visible = visible && !nearDetail;
      if (v.mesh.proxyCueG) v.mesh.proxyCueG.visible = visible && !nearDetail;
      if (!v.detailedRoot) {
        v.mesh.bodyG.visible = nearDetail;
        v.mesh.wheelG.visible = nearDetail;
      }

      const holdActive = v.waitingForGreen
        || (holdS !== null && v.speed < 0.3)
        || (curbHoldS !== null)
        || v.parked;
      const brakeOn = !v.parked
        && (v.disabled
          || actualAccel <= BRAKE_LIGHT_DECEL
          || holdActive
          || combatBrakeActive
          || (desired < 0.05 && v.speed < 0.12)
          || (v.playerControlled && playerInput.brake > 0 && v.speed > 0.4));
      const tailLights = v.mesh.tailLights;
      if (Array.isArray(tailLights)) {
        const brakeMaterial = brakeOn ? v.mesh.tailBrakeMat : v.mesh.tailOffMat;
        for (const light of tailLights) {
          if (light.material !== brakeMaterial) light.material = brakeMaterial;
        }
      } else if (v.mesh.tailMat) {
        v.mesh.tailMat.emissiveIntensity = brakeOn ? 2.6 : 0.8;
      }

      const hazardOn = v.disabled || t < v.hazardUntil;
      const blinkOn = (hazardOn || Boolean(v.blinkSide)) && (t * 2.2) % 1 < 0.52;
      if (Array.isArray(v.mesh.indicatorLeft) && Array.isArray(v.mesh.indicatorRight)) {
        const leftMaterial = blinkOn && (hazardOn || v.blinkSide < 0)
          ? v.mesh.indicatorOnMat
          : v.mesh.indicatorOffMat;
        const rightMaterial = blinkOn && (hazardOn || v.blinkSide > 0)
          ? v.mesh.indicatorOnMat
          : v.mesh.indicatorOffMat;
        for (const light of v.mesh.indicatorLeft) {
          if (light.material !== leftMaterial) light.material = leftMaterial;
        }
        for (const light of v.mesh.indicatorRight) {
          if (light.material !== rightMaterial) light.material = rightMaterial;
        }
        if (blinkOn && (hazardOn || v.blinkSide < 0)) {
          for (const light of v.mesh.rearIndicatorLeft || []) {
            if (light.material !== v.mesh.indicatorOnMat) {
              light.material = v.mesh.indicatorOnMat;
            }
          }
        }
        if (blinkOn && (hazardOn || v.blinkSide > 0)) {
          for (const light of v.mesh.rearIndicatorRight || []) {
            if (light.material !== v.mesh.indicatorOnMat) {
              light.material = v.mesh.indicatorOnMat;
            }
          }
        }
      } else if (v.mesh.indMat) {
        v.mesh.indMat.emissiveIntensity = blinkOn ? 2.2 : 0.05;
      }

      if (Array.isArray(v.mesh.beaconLights) && v.mesh.beaconLights.length) {
        const beaconActive = !pursuitResponderActive && (curbApproach > 0.05
          || vehicleIsCurbside(v)
          || v.mergeSignalUntil > t);
        const beaconOn = beaconActive && (t * 2.8 + v.servicePhase) % 1 < 0.42;
        const beaconMaterial = beaconOn ? shared.beaconOnMat : shared.beaconOffMat;
        for (const light of v.mesh.beaconLights) {
          if (light.material !== beaconMaterial) light.material = beaconMaterial;
        }
      }

      speedSum += v.speed;
      if (v.speed > 0.6) movingCount += 1;
      if (v.speed < 0.35 && (v.leader || v.waitingForGreen)) queuedCount += 1;
      if (v.waitingForGreen) signalQueuedCount += 1;
    }

    resolvePlayerVehicleFootprintCollisions(vehicleMotionStarts, t);
    resolveOnFootPlayerVehicleContacts(vehicleMotionStarts);

    stats.active = vehicles.length;
    stats.visible = visibleCount;
    stats.avgSpeed = Math.round((speedSum / vehicles.length) * 10) / 10;
    stats.signalPhase = firstSignal
      ? signalPhaseAt(0, t, firstSignal.offset)
      : 'off';
    diagnostics.elapsed = t;
    diagnostics.minLaneGap = Number.isFinite(frameMinLaneGap)
      ? Math.round(frameMinLaneGap * 100) / 100
      : null;
    diagnostics.minMovingHeadway = Number.isFinite(frameMinMovingHeadway)
      ? Math.round(frameMinMovingHeadway * 100) / 100
      : null;
    diagnostics.minStoppedGap = Number.isFinite(frameMinStoppedGap)
      ? Math.round(frameMinStoppedGap * 100) / 100
      : null;
    diagnostics.worstHeadway = frameWorstHeadway;
    diagnostics.moving = movingCount;
    diagnostics.queued = queuedCount;
    diagnostics.maxQueued = Math.max(diagnostics.maxQueued, queuedCount);
    diagnostics.signalQueued = signalQueuedCount;
    diagnostics.turning = turningCount;
    diagnostics.weather = weatherMode;
    diagnosticDuration += dt;
    speedIntegral += (speedSum / vehicles.length) * dt;
    diagnostics.meanSpeed = speedIntegral / diagnosticDuration;
    if (playerVehicle && playerImpactStart) {
      const point = playerVehicle.mesh.root.position;
      playerPedestrianImpactProbe = {
        vehicleId: vehicles.indexOf(playerVehicle),
        start: playerImpactStart,
        end: { x: point.x, z: point.z },
        speed: playerVehicle.speed,
        halfWidth: playerVehicle.spec.wid * 0.5,
      };
    } else {
      playerPedestrianImpactProbe = null;
      playerPedestrianImpactLatch.clear();
    }
    updateMuniRideProgress();
  }

  function getStats() {
    return {
      active: stats.active,
      visible: stats.visible,
      avgSpeed: stats.avgSpeed,
      signalPhase: stats.signalPhase,
    };
  }

  function getOnFootVehicleContactDiagnostics() {
    return {
      probeActive: Boolean(onFootPlayerCollisionProbe),
      latchCount: onFootVehicleCollisionLatch.size,
      tests: diagnostics.onFootVehicleContactTests,
      contacts: diagnostics.onFootVehicleContacts,
      corrections: diagnostics.onFootVehicleCorrections,
      blockingContacts: diagnostics.onFootVehicleBlockingContacts,
      damageContacts: diagnostics.onFootVehicleDamageContacts,
      lastContact: diagnostics.lastOnFootVehicleContact
        ? {
          ...diagnostics.lastOnFootVehicleContact,
          correctedPosition: {
            ...diagnostics.lastOnFootVehicleContact.correctedPosition,
          },
          contactFootprint: diagnostics.lastOnFootVehicleContact.contactFootprint
            ? { ...diagnostics.lastOnFootVehicleContact.contactFootprint }
            : undefined,
          endFootprint: diagnostics.lastOnFootVehicleContact.endFootprint
            ? { ...diagnostics.lastOnFootVehicleContact.endFootprint }
            : undefined,
          consequence: diagnostics.lastOnFootVehicleContact.consequence
            ? {
              ...diagnostics.lastOnFootVehicleContact.consequence,
              correctedPosition: diagnostics.lastOnFootVehicleContact.consequence.correctedPosition
                ? { ...diagnostics.lastOnFootVehicleContact.consequence.correctedPosition }
                : undefined,
            }
            : undefined,
        }
        : null,
      lastCorrection: diagnostics.lastOnFootVehicleCorrection
        ? {
          ...diagnostics.lastOnFootVehicleCorrection,
          correctedPosition: {
            ...diagnostics.lastOnFootVehicleCorrection.correctedPosition,
          },
          contactFootprint: diagnostics.lastOnFootVehicleCorrection.contactFootprint
            ? { ...diagnostics.lastOnFootVehicleCorrection.contactFootprint }
            : undefined,
          endFootprint: diagnostics.lastOnFootVehicleCorrection.endFootprint
            ? { ...diagnostics.lastOnFootVehicleCorrection.endFootprint }
            : undefined,
          consequence: diagnostics.lastOnFootVehicleCorrection.consequence
            ? {
              ...diagnostics.lastOnFootVehicleCorrection.consequence,
              correctedPosition: diagnostics.lastOnFootVehicleCorrection.consequence.correctedPosition
                ? { ...diagnostics.lastOnFootVehicleCorrection.consequence.correctedPosition }
                : undefined,
            }
            : undefined,
        }
        : null,
    };
  }

  function restoreOnFootVehicleImpactQaStage() {
    const saved = onFootVehicleImpactQaStage?.saved;
    const vehicle = onFootVehicleImpactQaStage?.vehicle;
    if (!saved || !vehicle) return;
    vehicle.remoteControlled = saved.remoteControlled;
    vehicle.disabled = saved.disabled;
    vehicle.garageStored = saved.garageStored;
    vehicle.impounded = saved.impounded;
    vehicle.parked = saved.parked;
    vehicle.parkedAt = saved.parkedAt;
    vehicle.dwellUntil = saved.dwellUntil;
    vehicle.speed = saved.speed;
    vehicle.longitudinalAccel = saved.longitudinalAccel;
    vehicle.accelSm = saved.accelSm;
    vehicle.health = saved.health;
    vehicle.damageState = saved.damageState;
    vehicle.mesh.root.visible = saved.visible;
    delete vehicle.qaOnFootImpactSpeedCap;
    delete vehicle.qaOnFootImpactHidden;
    syncVehicleDamageMetadata(vehicle);
    syncVehicleCombatDisabledMetadata(vehicle, vehicle.disabled);
    onFootVehicleImpactQaStage = null;
  }

  function stageOnFootVehicleImpactQa({ kind = 'high-speed', referencePosition = null } = {}) {
    restoreOnFootVehicleImpactQaStage();
    setOnFootPlayerCollisionProbe(null);
    const allowed = new Set([
      'high-speed', 'low-speed', 'disabled', 'parallel', 'hidden', 'garage',
      'impounded', 'remote', 'downed', 'pursuit-responder',
    ]);
    if (!allowed.has(kind)) return null;
    const reference = Number.isFinite(referencePosition?.x) && Number.isFinite(referencePosition?.z)
      ? referencePosition
      : { x: focusX, z: focusZ };
    const responderCandidates = kind === 'pursuit-responder'
      ? pursuitResponder.targetIndexes.map((index) => vehicles[index]).filter(Boolean)
      : null;
    const eligible = (responderCandidates || vehicles).filter((vehicle) => (
      vehicle
      && vehicle.mesh.root.visible
      && !vehicle.playerControlled
      && !vehicle.remoteControlled
      && !vehicle.garageStored
      && !vehicle.impounded
      && vehicle.cls !== 'bike'
    ));
    const wantsMoving = kind === 'high-speed';
    const movingPrivate = eligible.filter((vehicle) => wantsMoving
      && vehicle.identity.category === 'private'
      && !vehicle.identity.curbService
      && !vehicle.disabled
      && !vehicle.parked
      && vehicle.speed >= 2);
    const preferred = movingPrivate.length ? movingPrivate : eligible.filter((vehicle) => wantsMoving
      ? !vehicle.disabled && !vehicle.parked && vehicle.speed >= 2
      : !vehicle.disabled && (vehicle.parked || vehicle.speed <= 0.5));
    const candidates = preferred.length ? preferred : eligible.filter((vehicle) => !vehicle.disabled);
    candidates.sort((left, right) => (
      Math.hypot(
        left.mesh.root.position.x - reference.x,
        left.mesh.root.position.z - reference.z,
      ) - Math.hypot(
        right.mesh.root.position.x - reference.x,
        right.mesh.root.position.z - reference.z,
      )
    ));
    const vehicle = candidates[0];
    if (!vehicle) return null;
    const saved = {
      remoteControlled: vehicle.remoteControlled,
      disabled: vehicle.disabled,
      garageStored: vehicle.garageStored,
      impounded: vehicle.impounded,
      parked: vehicle.parked,
      parkedAt: vehicle.parkedAt,
      dwellUntil: vehicle.dwellUntil,
      speed: vehicle.speed,
      longitudinalAccel: vehicle.longitudinalAccel,
      accelSm: vehicle.accelSm,
      health: vehicle.health,
      damageState: vehicle.damageState,
      visible: vehicle.mesh.root.visible,
    };
    onFootVehicleImpactQaStage = { kind, vehicle, saved };
    const negativeContext = ['hidden', 'garage', 'impounded', 'remote', 'downed']
      .includes(kind);
    if (wantsMoving) {
      vehicle.parked = false;
      vehicle.speed = 4.4;
      vehicle.qaOnFootImpactSpeedCap = 4.4;
    } else {
      vehicle.parked = kind !== 'pursuit-responder';
      vehicle.parkedAt = lastElapsed;
      vehicle.dwellUntil = 10000;
      vehicle.speed = 0;
      vehicle.longitudinalAccel = 0;
      vehicle.accelSm = 0;
      vehicle.qaOnFootImpactSpeedCap = 0;
    }
    if (kind === 'disabled') {
      vehicle.disabled = true;
      vehicle.health = 0;
      vehicle.damageState = 'disabled';
      syncVehicleDamageMetadata(vehicle);
      syncVehicleCombatDisabledMetadata(vehicle, true);
    } else if (kind === 'hidden') {
      vehicle.qaOnFootImpactHidden = true;
      vehicle.mesh.root.visible = false;
    } else if (kind === 'garage') {
      vehicle.garageStored = true;
      vehicle.mesh.root.visible = false;
    } else if (kind === 'impounded') {
      vehicle.impounded = true;
      vehicle.mesh.root.visible = false;
    } else if (kind === 'remote') {
      vehicle.remoteControlled = true;
    }
    const heading = Number(vehicle.heading ?? vehicle.mesh.root.rotation.y) || 0;
    const axes = footprintAxes(heading);
    const halfLength = vehicle.spec.len * 0.5;
    const halfWidth = vehicle.spec.wid * 0.5;
    const stagedHalfLength = halfLength + ON_FOOT_VEHICLE_SHELL_LENGTH_PAD;
    const stagedHalfWidth = halfWidth + ON_FOOT_VEHICLE_SHELL_WIDTH_PAD;
    let playerPose;
    if (kind === 'parallel') {
      playerPose = {
        x: vehicle.mesh.root.position.x
          - axes.right.x * (stagedHalfWidth + ON_FOOT_PLAYER_RADIUS + 0.55),
        z: vehicle.mesh.root.position.z
          - axes.right.z * (stagedHalfWidth + ON_FOOT_PLAYER_RADIUS + 0.55),
        yaw: heading + Math.PI,
      };
    } else if (negativeContext) {
      playerPose = {
        x: vehicle.mesh.root.position.x
          + axes.right.x * (stagedHalfWidth + ON_FOOT_PLAYER_RADIUS + 0.55),
        z: vehicle.mesh.root.position.z
          + axes.right.z * (stagedHalfWidth + ON_FOOT_PLAYER_RADIUS + 0.55),
        yaw: heading,
      };
    } else {
      playerPose = {
        x: vehicle.mesh.root.position.x
          - axes.forward.x * (stagedHalfLength + ON_FOOT_PLAYER_RADIUS + 0.52),
        z: vehicle.mesh.root.position.z
          - axes.forward.z * (stagedHalfLength + ON_FOOT_PLAYER_RADIUS + 0.52),
        yaw: heading + Math.PI,
      };
    }
    return {
      kind,
      vehicleId: vehicles.indexOf(vehicle),
      playerPose,
      speed: vehicle.speed,
      disabled: vehicle.disabled,
      excluded: negativeContext,
    };
  }

  function clearVehicleEmbodimentQaHold({ restore = true } = {}) {
    const held = vehicleEmbodimentQaHold;
    if (!held?.vehicle) return;
    const { vehicle, saved } = held;
    if (restore && saved) {
      vehicle.road = saved.road;
      vehicle.dir = saved.dir;
      vehicle.s = saved.s;
      vehicle.laneOffsetSm = saved.laneOffsetSm;
      vehicle.heading = saved.heading;
      vehicle.speed = saved.speed;
      vehicle.longitudinalAccel = saved.longitudinalAccel;
      vehicle.accelSm = saved.accelSm;
      vehicle.playerSteer = saved.playerSteer;
      vehicle.route = saved.route;
      vehicle.turn = saved.turn;
      vehicle.leader = saved.leader;
      vehicle.parked = saved.parked;
      vehicle.parkedAt = saved.parkedAt;
      vehicle.dwellUntil = saved.dwellUntil;
      vehicle.curbDwellUntil = saved.curbDwellUntil;
      vehicle.blinkSide = saved.blinkSide;
      vehicle.pullOutBlockedSince = saved.pullOutBlockedSince;
      vehicle.mesh.root.position.copy(saved.position);
      vehicle.mesh.root.rotation.copy(saved.rotation);
      vehicle.mesh.root.visible = saved.visible;
    }
    if (vehicle.mesh.root.userData) delete vehicle.mesh.root.userData.vehicleEmbodimentQaHeld;
    vehicleEmbodimentQaHold = null;
  }

  function stagePlayerVehicleEmbodimentQa({ referencePosition = null, preferredClass = null } = {}) {
    if (playerVehicle || impoundedPlayerVehicle || taxiRide || muniRide) return null;
    clearVehicleEmbodimentQaHold();
    const reference = Number.isFinite(referencePosition?.x) && Number.isFinite(referencePosition?.z)
      ? referencePosition
      : { x: focusX, z: focusZ };
    const candidates = vehicles.map((vehicle, index) => ({ vehicle, index })).filter(({ vehicle }) => (
      vehicle
      && (vehicle.identity.category === 'private' || Boolean(preferredClass))
      && vehicle.mesh.root.userData?.vehicleEmbodiment
      && (!preferredClass || vehicle.cls === preferredClass)
      && !vehicle.remoteControlled
      && !vehicle.garageStored
      && !vehicle.impounded
      && !vehicle.disabled
      && (preferredClass || (
        Math.abs(vehicle.mesh.root.position.x) <= 220
        && Math.abs(vehicle.mesh.root.position.z) <= 220
      ))
    ));
    candidates.sort((left, right) => (
      (left.vehicle.identity.category === 'private' ? 0 : 1)
      - (right.vehicle.identity.category === 'private' ? 0 : 1)
      || Math.hypot(
        left.vehicle.mesh.root.position.x - reference.x,
        left.vehicle.mesh.root.position.z - reference.z,
      ) - Math.hypot(
        right.vehicle.mesh.root.position.x - reference.x,
        right.vehicle.mesh.root.position.z - reference.z,
      ) || left.index - right.index
    ));
    const selected = candidates[0];
    if (!selected) return null;
    const vehicle = selected.vehicle;
    const saved = {
      road: vehicle.road,
      dir: vehicle.dir,
      s: vehicle.s,
      laneOffsetSm: vehicle.laneOffsetSm,
      heading: vehicle.heading,
      speed: vehicle.speed,
      longitudinalAccel: vehicle.longitudinalAccel,
      accelSm: vehicle.accelSm,
      playerSteer: vehicle.playerSteer,
      route: vehicle.route,
      turn: vehicle.turn,
      leader: vehicle.leader,
      parked: vehicle.parked,
      parkedAt: vehicle.parkedAt,
      dwellUntil: vehicle.dwellUntil,
      curbDwellUntil: vehicle.curbDwellUntil,
      blinkSide: vehicle.blinkSide,
      pullOutBlockedSince: vehicle.pullOutBlockedSince,
      position: vehicle.mesh.root.position.clone(),
      rotation: vehicle.mesh.root.rotation.clone(),
      visible: vehicle.mesh.root.visible,
    };
    if (!vehicle.mesh.root.visible) {
      const stagedProjection = projectVehiclePoseToRoad(
        reference,
        vehicle.heading ?? vehicle.mesh.root.rotation.y ?? 0,
      );
      if (!stagedProjection) return null;
      vehicle.road = stagedProjection.road;
      vehicle.dir = stagedProjection.dir;
      vehicle.s = stagedProjection.s;
      vehicle.laneOffsetSm = stagedProjection.lateral;
      vehicle.heading = stagedProjection.heading;
      vehicle.mesh.root.position.set(
        stagedProjection.x,
        stagedProjection.y,
        stagedProjection.z,
      );
      vehicle.mesh.root.rotation.y = stagedProjection.heading;
    }
    vehicle.speed = 0;
    vehicle.longitudinalAccel = 0;
    vehicle.accelSm = 0;
    vehicle.playerSteer = 0;
    vehicle.route = null;
    vehicle.turn = null;
    vehicle.leader = null;
    vehicle.parked = true;
    vehicle.parkedAt = lastElapsed;
    vehicle.dwellUntil = Infinity;
    vehicle.curbDwellUntil = Infinity;
    vehicle.mesh.root.visible = true;
    vehicleEmbodimentQaHold = {
      vehicle,
      index: selected.index,
      saved,
      laneOffset: Number.isFinite(vehicle.laneOffsetSm)
        ? vehicle.laneOffsetSm
        : roads[vehicle.road]?.laneOffset ?? LANE_OFFSET,
    };
    vehicle.mesh.root.userData.vehicleEmbodimentQaHeld = true;
    return {
      kind: 'core-private',
      vehicleId: selected.index,
      class: vehicle.cls,
      position: {
        x: vehicle.mesh.root.position.x,
        y: vehicle.mesh.root.position.y,
        z: vehicle.mesh.root.position.z,
      },
      heading: Number(vehicle.heading ?? vehicle.mesh.root.rotation.y) || 0,
      syntheticEvents: 0,
    };
  }

  function getOnFootVehicleImpactQaState(playerProbe = null) {
    const stage = onFootVehicleImpactQaStage;
    const vehicle = stage?.vehicle;
    if (!stage || !vehicle) return null;
    const playerPosition = playerProbe?.position || playerProbe;
    const playerRenderedBounds = playerProbe?.renderedBounds || null;
    const footprint = onFootVehicleFootprint(vehicle, {
      x: vehicle.mesh.root.position.x,
      z: vehicle.mesh.root.position.z,
      heading: vehicle.heading ?? vehicle.mesh.root.rotation.y,
    });
    const rootClearance = Number.isFinite(playerPosition?.x) && Number.isFinite(playerPosition?.z)
      ? discFootprintClearance(playerPosition, footprint, ON_FOOT_PLAYER_RADIUS)
      : null;
    const finalOverlap = Number.isFinite(rootClearance)
      ? rootClearance <= 0
      : false;
    const renderedSatClearance = aabbFootprintSatClearance(playerRenderedBounds, footprint);
    vehicle.mesh.root.updateWorldMatrix(true, true);
    const renderedBox = new THREE.Box3().setFromObject(vehicle.mesh.root, true);
    const renderedBounds = renderedBox.isEmpty() ? null : {
      min: { x: renderedBox.min.x, y: renderedBox.min.y, z: renderedBox.min.z },
      max: { x: renderedBox.max.x, y: renderedBox.max.y, z: renderedBox.max.z },
    };
    return {
      kind: stage.kind,
      vehicleId: vehicles.indexOf(vehicle),
      speed: Math.round(vehicle.speed * 10) / 10,
      position: { x: footprint.x, z: footprint.z },
      heading: footprint.heading,
      halfLength: footprint.halfLength,
      halfWidth: footprint.halfWidth,
      obb: {
        center: { x: footprint.x, z: footprint.z },
        heading: footprint.heading,
        halfLength: footprint.halfLength,
        halfWidth: footprint.halfWidth,
      },
      renderedBounds,
      bodyClearance: {
        radius: ON_FOOT_PLAYER_RADIUS,
        root: Number.isFinite(rootClearance)
          ? Math.round(rootClearance * 1000) / 1000
          : null,
        renderedSat: Number.isFinite(renderedSatClearance)
          ? Math.round(renderedSatClearance * 1000) / 1000
          : null,
        renderedOverlap: Number.isFinite(renderedSatClearance)
          ? renderedSatClearance <= 0
          : null,
      },
      visible: vehicle.mesh.root.visible,
      disabled: vehicle.disabled,
      parked: vehicle.parked,
      garageStored: vehicle.garageStored,
      impounded: vehicle.impounded,
      remote: vehicle.remoteControlled,
      finalOverlap,
      actorCount: vehicles.length,
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
  }

  function clearPursuitResponder() {
    for (const vehicle of vehicles) {
      if (!vehicle.pursuitResponder) continue;
      vehicle.pursuitResponder = false;
      vehicle.pursuitLevel = 0;
      const userData = vehicle.mesh.root.userData || {};
      userData.pursuitResponder = false;
      userData.pursuitLevel = 0;
      userData.pursuitSlot = null;
      if (vehicle.mesh.pursuitKit) vehicle.mesh.pursuitKit.visible = false;
    }
    pursuitResponder.active = false;
    pursuitResponder.targetIndex = -1;
    pursuitResponder.targetIndexes.length = 0;
    pursuitResponder.playerVehicleId = null;
    pursuitResponder.distance = null;
    pursuitDeploymentHoldIds.clear();
    pursuitDeploymentHoldingIds.clear();
  }

  function setPursuitDeploymentHolds(responderIds = []) {
    const next = new Set();
    for (const id of responderIds) {
      if (!Number.isInteger(id) || next.size >= 3) continue;
      if (!pursuitResponder.targetIndexes.includes(id)) continue;
      next.add(id);
    }
    for (const id of pursuitDeploymentHoldIds) {
      if (next.has(id)) continue;
      pursuitDeploymentHoldingIds.delete(id);
      const root = vehicles[id]?.mesh?.root;
      if (root?.userData) {
        root.userData.pursuitDeploymentHoldRequested = false;
        root.userData.pursuitDeploymentHolding = false;
      }
    }
    pursuitDeploymentHoldIds.clear();
    for (const id of next) pursuitDeploymentHoldIds.add(id);
    for (const id of next) {
      const root = vehicles[id]?.mesh?.root;
      if (!root?.userData) continue;
      root.userData.pursuitDeploymentHoldRequested = true;
      root.userData.pursuitDeploymentHolding = pursuitDeploymentHoldingIds.has(id);
    }
    return pursuitDeploymentHoldIds.size;
  }

  function setPursuitResponder({
    active = false,
    position = null,
    playerVehicleId = null,
    level = 1,
    presentation = null,
  } = {}) {
    if (!active || !Number.isFinite(position?.x) || !Number.isFinite(position?.z)) {
      if (presentation === 'booking' && pursuitResponder.targetIndexes.length > 0) {
        let nearestIndex = pursuitResponder.targetIndexes[0];
        let nearestDistance = Infinity;
        for (const index of pursuitResponder.targetIndexes) {
          const vehicle = vehicles[index];
          if (!vehicle) continue;
          const distance = Math.hypot(
            vehicle.mesh.root.position.x - pursuitResponder.playerX,
            vehicle.mesh.root.position.z - pursuitResponder.playerZ,
          );
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = index;
          }
        }
        const bookingVehicle = vehicles[nearestIndex];
        pursuitBookingVisual.vehicleIndex = nearestIndex;
        pursuitBookingVisual.until = lastElapsed + 5;
        if (bookingVehicle) {
          bookingVehicle.speed = 0;
          bookingVehicle.longitudinalAccel = 0;
          bookingVehicle.accelSm = 0;
          bookingVehicle.hazardUntil = pursuitBookingVisual.until;
          bookingVehicle.mesh.root.userData.pursuitBooking = true;
        }
      }
      clearPursuitResponder();
      return getPursuitResponder();
    }
    if (pursuitBookingVisual.vehicleIndex >= 0) {
      const bookingVehicle = vehicles[pursuitBookingVisual.vehicleIndex];
      if (bookingVehicle) bookingVehicle.mesh.root.userData.pursuitBooking = false;
      pursuitBookingVisual.vehicleIndex = -1;
      pursuitBookingVisual.until = 0;
    }
    pursuitResponder.active = true;
    pursuitResponder.playerVehicleId = Number.isInteger(playerVehicleId) ? playerVehicleId : null;
    pursuitResponder.playerX = position.x;
    pursuitResponder.playerZ = position.z;
    pursuitResponder.level = THREE.MathUtils.clamp(Math.floor(Number(level) || 1), 1, 3);
    const requiredCount = pursuitResponder.level;
    const eligible = (vehicle, index) => Boolean(
      vehicle
      && index !== pursuitResponder.playerVehicleId
      && vehicle.mesh.root.visible
      && !vehicle.playerControlled
      && !vehicle.remoteControlled
      && !vehicle.impounded
      && !vehicle.garageStored
      && !vehicle.disabled
      && !vehicle.parked
      && !taxiAtServiceStop(vehicle)
      && !deliveryAtServiceStop(vehicle)
      && vehicle.cls !== 'bike'
      && vehicle.cls !== 'bus'
      && vehicle.cls !== 'truck'
      && vehicle.cls !== 'taxi'
      && vehicle.identity.category !== 'delivery',
    );
    const retained = pursuitResponder.targetIndexes.filter(
      (index) => eligible(vehicles[index], index),
    ).slice(0, requiredCount);
    const retainedSet = new Set(retained);
    const candidates = [];
    for (let index = 0; index < vehicles.length; index += 1) {
      const vehicle = vehicles[index];
      if (!eligible(vehicle, index) || retainedSet.has(index)) continue;
      const dx = vehicle.mesh.root.position.x - pursuitResponder.playerX;
      const dz = vehicle.mesh.root.position.z - pursuitResponder.playerZ;
      const distance = Math.hypot(dx, dz);
      const toPlayerX = -dx / Math.max(0.1, distance);
      const toPlayerZ = -dz / Math.max(0.1, distance);
      const facingPlayer = Math.sin(vehicle.mesh.root.rotation.y) * toPlayerX
        + Math.cos(vehicle.mesh.root.rotation.y) * toPlayerZ;
      candidates.push({
        index,
        score: distance * (facingPlayer > 0.1 ? 0.52 : 1.2),
      });
    }
    candidates.sort((a, b) => a.score - b.score || a.index - b.index);
    while (retained.length < requiredCount && candidates.length) {
      retained.push(candidates.shift().index);
    }
    const nextSet = new Set(retained);
    for (let index = 0; index < vehicles.length; index += 1) {
      const vehicle = vehicles[index];
      if (!vehicle.pursuitResponder || nextSet.has(index)) continue;
      vehicle.pursuitResponder = false;
      vehicle.pursuitLevel = 0;
      vehicle.mesh.root.userData.pursuitResponder = false;
      vehicle.mesh.root.userData.pursuitLevel = 0;
      vehicle.mesh.root.userData.pursuitSlot = null;
      if (vehicle.mesh.pursuitKit) vehicle.mesh.pursuitKit.visible = false;
    }
    pursuitResponder.targetIndexes = retained;
    pursuitResponder.targetIndex = retained[0] ?? -1;
    if (!retained.length) {
      pursuitResponder.active = false;
      pursuitResponder.distance = null;
      return getPursuitResponder();
    }
    retained.forEach((index, slot) => {
      const target = vehicles[index];
      const newlyAssigned = !target.pursuitResponder;
      target.pursuitResponder = true;
      target.pursuitLevel = pursuitResponder.level;
      // Ambient traffic can already have a random junction choice queued when
      // it is recruited. Re-plan that unopened choice against the live player
      // target so the first visible responder turn belongs to the chase.
      if (newlyAssigned && !target.turn) {
        target.route = null;
        target.blinkSide = 0;
      }
      const userData = target.mesh.root.userData || (target.mesh.root.userData = {});
      userData.pursuitResponder = true;
      userData.pursuitLevel = pursuitResponder.level;
      userData.pursuitSlot = slot;
    });
    const primary = vehicles[pursuitResponder.targetIndex];
    pursuitResponder.distance = Math.hypot(
      primary.mesh.root.position.x - pursuitResponder.playerX,
      primary.mesh.root.position.z - pursuitResponder.playerZ,
    );
    return getPursuitResponder();
  }

  function pursuitRouteIsLegal(vehicle, route) {
    if (!vehicle || !route) return true;
    const sourceRoad = roads[vehicle.road];
    if (!sourceRoad) return false;
    if (route.uTurn) {
      return route.road === vehicle.road
        && route.dir === -vehicle.dir
        && isDirectionLegal(sourceRoad, route.dir);
    }
    const nextRoad = roads[route.road];
    if (!nextRoad || !isDirectionLegal(nextRoad, route.dir)) return false;
    const end = vehicle.dir === 1 ? 1 : 0;
    const nodeIndex = sourceRoad.endNode[end];
    const node = nodes[nodeIndex];
    if (!node?.ends?.some((edge) => (
      edge.road === route.road
      && (edge.end === 0 ? 1 : -1) === route.dir
    ))) return false;
    const approachPoint = {
      x: sourceRoad.px[end === 1 ? 0 : sourceRoad.px.length - 1],
      z: sourceRoad.pz[end === 1 ? 0 : sourceRoad.pz.length - 1],
    };
    return isTurnAllowed({
      side: route.side,
      rule: findTurnRule(node, approachPoint, turnRules),
    });
  }

  function pursuitRouteSnapshot(vehicle) {
    const route = vehicle?.turn?.route || vehicle?.route;
    if (!route) return null;
    if (route.uTurn) {
      return {
        road: Number.isInteger(route.road) ? route.road : vehicle.road,
        dir: Number.isInteger(route.dir) ? route.dir : -vehicle.dir,
        side: route.side ?? 1,
        uTurn: true,
      };
    }
    return {
      road: route.road,
      dir: route.dir,
      side: route.side ?? 0,
      uTurn: Boolean(route.uTurn),
    };
  }

  function getPursuitChaseDiagnostics() {
    return {
      active: pursuitResponder.active,
      level: pursuitResponder.active ? pursuitResponder.level : 0,
      target: pursuitResponder.active
        ? {
          x: Math.round(pursuitResponder.playerX * 1000) / 1000,
          z: Math.round(pursuitResponder.playerZ * 1000) / 1000,
        }
        : null,
      routeDecisions: diagnostics.pursuitRouteDecisions,
      routeFallbacks: diagnostics.pursuitRouteFallbacks,
      lastDecision: diagnostics.lastPursuitRouteDecision
        ? { ...diagnostics.lastPursuitRouteDecision }
        : null,
      bookingVisual: pursuitBookingVisual.vehicleIndex >= 0
        && lastElapsed < pursuitBookingVisual.until
        ? {
          vehicleId: pursuitBookingVisual.vehicleIndex,
          remaining: Math.round((pursuitBookingVisual.until - lastElapsed) * 1000) / 1000,
        }
        : null,
      responders: pursuitResponder.targetIndexes.map((index) => {
        const vehicle = vehicles[index];
        if (!vehicle) return null;
        const route = pursuitRouteSnapshot(vehicle);
        return {
          id: index,
          road: vehicle.road,
          dir: vehicle.dir,
          s: Math.round(vehicle.s * 1000) / 1000,
          speed: Math.round(vehicle.speed * 1000) / 1000,
          heading: Math.round((vehicle.heading ?? vehicle.mesh.root.rotation.y) * 1000) / 1000,
          position: {
            x: Math.round(vehicle.mesh.root.position.x * 1000) / 1000,
            y: Math.round(vehicle.mesh.root.position.y * 1000) / 1000,
            z: Math.round(vehicle.mesh.root.position.z * 1000) / 1000,
          },
          routeRevision: vehicle.pursuitRouteRevision || 0,
          route,
          routeLegal: pursuitRouteIsLegal(vehicle, route),
          routeScore: Number.isFinite(vehicle.pursuitRouteScore)
            ? vehicle.pursuitRouteScore
            : null,
          plannedTargetDistance: Number.isFinite(vehicle.pursuitRouteTargetDistance)
            ? vehicle.pursuitRouteTargetDistance
            : null,
          plannedAt: Number.isFinite(vehicle.pursuitRoutePlannedAt)
            ? vehicle.pursuitRoutePlannedAt
            : null,
          targetDistance: Math.round(Math.hypot(
            vehicle.mesh.root.position.x - pursuitResponder.playerX,
            vehicle.mesh.root.position.z - pursuitResponder.playerZ,
          ) * 1000) / 1000,
        };
      }).filter(Boolean),
    };
  }

  function getPursuitResponders() {
    if (!pursuitResponder.active) return [];
    return pursuitResponder.targetIndexes.map((index, slot) => {
      const target = vehicles[index];
      if (!target) return null;
      const point = target.mesh.root.position;
      const distance = Math.hypot(
        point.x - pursuitResponder.playerX,
        point.z - pursuitResponder.playerZ,
      );
      return {
        active: true,
        id: index,
        index,
        slot,
        class: target.cls,
        identity: target.identity.key,
        label: target.identity.label,
        distance: Math.round(distance * 10) / 10,
        position: { x: point.x, y: point.y, z: point.z },
        speed: Math.round(target.speed * 10) / 10,
        level: pursuitResponder.level,
        closing: target.speed > 0,
        deploymentHold: {
          requested: pursuitDeploymentHoldIds.has(index),
          holding: pursuitDeploymentHoldingIds.has(index),
        },
        deploymentHoldRequested: pursuitDeploymentHoldIds.has(index),
        deploymentHolding: pursuitDeploymentHoldingIds.has(index),
        road: target.road,
        dir: target.dir,
        routeRevision: target.pursuitRouteRevision || 0,
        route: pursuitRouteSnapshot(target),
      };
    }).filter(Boolean);
  }

  function getPursuitResponder() {
    const primary = getPursuitResponders()[0];
    if (!primary) {
      return {
        active: false,
        id: null,
        index: null,
        distance: null,
        position: null,
        level: 0,
      };
    }
    pursuitResponder.distance = primary.distance;
    return primary;
  }

  function getDiagnostics() {
    return {
      ...diagnostics,
      classMix: { ...diagnostics.classMix },
      identityMix: { ...diagnostics.identityMix },
      maxInputDt: Math.round(diagnostics.maxInputDt * 1000) / 1000,
      minTurnRadius: diagnostics.minTurnRadius === null
        ? null
        : Math.round(diagnostics.minTurnRadius * 100) / 100,
      maxAcceleration: Math.round(diagnostics.maxAcceleration * 100) / 100,
      maxDeceleration: Math.round(diagnostics.maxDeceleration * 100) / 100,
      maxJerk: Math.round(diagnostics.maxJerk * 100) / 100,
      meanSpeed: Math.round(diagnostics.meanSpeed * 100) / 100,
      maxSafetyCorrection: Math.round(diagnostics.maxSafetyCorrection * 1000) / 1000,
    };
  }

  // QA/UI view of the fleet: plain values derived only from live vehicle
  // records, so callers never reach into THREE objects or internal mutation
  // state. Deterministic for a given simulation clock and never written back.
  function getVehicleLifeSnapshot() {
    const t = lastElapsed;
    const records = [];
    let featuredCount = 0;
    for (let index = 0; index < vehicles.length; index += 1) {
      const v = vehicles[index];
      const combatData = v.mesh.root.userData || {};
      const combatReaction = combatData.combatReaction;
      const combatBrakeUntil = Number(combatData.combatBrakeUntil);
      const combatBrakeActive = !v.parked
        && Number.isFinite(combatBrakeUntil)
        && combatBrakeUntil > 0
        && (combatReaction === 'brake' || combatReaction === 'staggered');
      const pursuitResponderActive = pursuitResponder.active
        && pursuitResponder.targetIndexes.includes(index)
        && v.pursuitResponder;
      const taxiPassengerActive = taxiRide?.vehicle === v;
      const muniPassengerActive = muniRide?.vehicle === v;
      const curbside = Number.isFinite(v.curbDwellUntil);
      const parkedDwellEnd = (v.parkedAt ?? t) + v.dwellUntil;
      const activeRoute = v.turn?.route || v.route;
      const routeCue = activeRoute ? routeSideCue(activeRoute.side, activeRoute.uTurn) : null;

      let actionKey = 'driving';
      let actionLabel = 'Driving';
      let actionDetail = null;
      if (v.garageStored) {
        actionKey = 'garage-stored';
        actionLabel = 'Stored at Ferry garage';
        actionDetail = 'owned roster';
      } else if (v.impounded) {
        actionKey = 'impounded';
        actionLabel = 'Held at Ferry impound';
        actionDetail = 'retrieval pending';
      } else if (v.disabled) {
        actionKey = 'vehicle-disabled';
        actionLabel = 'Vehicle disabled';
        actionDetail = v.lastDamage?.source || 'damage';
      } else if (pursuitResponderActive) {
        actionKey = 'pursuit-responder';
        actionLabel = 'Pursuit responder';
        actionDetail = 'closing on player';
      } else if (combatBrakeActive) {
        actionKey = 'combat-brake';
        actionLabel = 'Braking after gunfire';
        actionDetail = 'reacting to nearby fire';
      } else if (taxiPassengerActive) {
        actionKey = 'taxi-passenger';
        actionLabel = 'Taxi passenger boarding';
        actionDetail = 'Ferry Building fare';
      } else if (muniPassengerActive) {
        actionKey = muniRide.arrived ? 'muni-arrival' : 'muni-passenger';
        actionLabel = muniRide.arrived ? 'Muni passenger arrival' : 'Muni passenger ride';
        actionDetail = 'one-stop fare';
      } else if (v.parked) {
        actionKey = 'parked';
        actionLabel = 'Parked at curb';
        actionDetail = parkedDwellEnd > t ? 'dwelling' : 'pull-out pending';
      } else if (curbside) {
        actionKey = 'at-stop';
        actionLabel = 'Servicing stop';
        actionDetail = v.pullOutBlockedSince !== null ? 'pull-out blocked' : 'dwelling';
      } else if (v.turn) {
        actionKey = 'turning';
        actionLabel = 'Turning';
        actionDetail = routeCue;
      } else if (v.waitingForGreen) {
        actionKey = 'waiting-at-signal';
        actionLabel = 'Waiting at signal';
      } else if (v.mergeSignalUntil > t) {
        actionKey = 'merging';
        actionLabel = 'Merging from curb';
      } else if (v.route) {
        actionKey = 'approaching-turn';
        actionLabel = 'Approaching turn';
        actionDetail = routeCue;
      } else if (v.speed < 0.35 && v.leader) {
        actionKey = 'queued';
        actionLabel = 'Queued in traffic';
      }

      let stopCue = null;
      let dwellRemaining = null;
      if (v.garageStored) {
        stopCue = 'garage-stored';
      } else if (v.impounded) {
        stopCue = 'impounded';
      } else if (taxiPassengerActive) {
        stopCue = 'taxi-passenger';
      } else if (muniPassengerActive) {
        stopCue = muniRide.arrived ? 'muni-arrival' : 'muni-passenger';
      } else if (v.parked) {
        stopCue = 'parked';
        dwellRemaining = Math.max(0, parkedDwellEnd - t);
      } else if (curbside) {
        stopCue = v.cls === 'bus' ? 'transit-stop' : 'curb-service';
        dwellRemaining = Math.max(0, v.curbDwellUntil - t);
      } else if (Number.isFinite(v.nextCurbStopAt)) {
        stopCue = 'approaching-stop';
      }

      const storedColor = v.mesh.root.userData.vehicleColor;
      const paintColor = typeof storedColor === 'number'
        ? null
        : v.mesh.bodyG.children.find(
          (child) => child.isMesh && child.material?.color,
        )?.material?.color;
      const colorHex = typeof storedColor === 'number'
        ? `#${storedColor.toString(16).padStart(6, '0')}`
        : paintColor && typeof paintColor.getHex === 'function'
          ? `#${paintColor.getHex().toString(16).padStart(6, '0')}`
          : null;
      const heroCue = v.mesh.root.userData.heroTrafficCue ?? null;
      const featured = heroCue !== null
        || v === heroBus
        || v === heroSedan
        || presentationCars.includes(v);
      if (featured) featuredCount += 1;

      const hazardOn = v.disabled || t < v.hazardUntil;
      records.push({
        id: index,
        class: v.cls,
        identity: {
          key: v.identity.key,
          category: v.identity.category,
          label: v.identity.label,
          service: v.identity.curbService,
        },
        action: {
          key: actionKey,
          label: actionLabel,
          detail: actionDetail,
        },
        route: {
          cue: routeCue,
          inTurn: Boolean(v.turn),
          targetRoad: activeRoute?.road ?? null,
          targetDir: activeRoute?.dir ?? null,
        },
        stop: {
          cue: stopCue,
          service: v.identity.curbService ?? (v.cls === 'bus' ? 'transit' : null),
          targetS: Number.isFinite(v.nextCurbStopAt)
            ? Math.round(v.nextCurbStopAt * 10) / 10
            : null,
          dwellRemaining: dwellRemaining === null
            ? null
            : Math.round(dwellRemaining * 10) / 10,
          blocked: v.pullOutBlockedSince !== null,
        },
        livery: {
          ...liveryCueFor(v.identity, v.cls),
          colorHex,
          board: v.cls === 'bus' ? BUS_ROUTE_BOARD : null,
        },
        damage: vehicleDamageSnapshot(v),
        combatEligible: vehicleEligibleForCombatDamage(v),
        theft: {
          eligible: v.identity.category === 'private',
          reported: v.theftReported === true,
          registeredOwner: v.registeredOwner === true,
        },
        indicators: {
          left: v.blinkSide < 0,
          right: v.blinkSide > 0,
          hazard: hazardOn,
        },
        speed: Math.round(v.speed * 10) / 10,
        heading: v.heading ?? v.mesh.root.rotation.y ?? 0,
        road: v.road,
        s: Math.round(v.s * 10) / 10,
        position: {
          x: Math.round(v.mesh.root.position.x * 10) / 10,
          z: Math.round(v.mesh.root.position.z * 10) / 10,
        },
        visible: v.mesh.root.visible,
        featured,
        heroCue,
        reaction: combatBrakeActive
          ? {
            key: 'brake',
            source: combatData.combatReactionSource || 'combat',
            remaining: null,
          }
          : null,
        pursuit: pursuitResponderActive
          ? {
            active: true,
            level: pursuitResponder.level,
            distance: Math.round(Math.hypot(
              v.mesh.root.position.x - pursuitResponder.playerX,
              v.mesh.root.position.z - pursuitResponder.playerZ,
            ) * 10) / 10,
          }
          : null,
      });
    }
    return {
      time: Math.round(t * 10) / 10,
      count: vehicles.length,
      featured: featuredCount,
      vehicles: records,
    };
  }

  let nightLightingAmount = 0;

  // Keep the shared lighting materials in step with the coastal weather cycle
  // and the day/night clock. Mutating the pooled materials updates every
  // vehicle in one pass, matching `createCity().setWeather()`.
  function applyVehicleLighting() {
    if (!shared) return;
    const preset = LIGHTING_PRESETS[weatherMode];
    const night = nightLightingAmount;
    const headScale = THREE.MathUtils.lerp(0.42, 1.55, night);
    const signScale = THREE.MathUtils.lerp(0.7, 1.45, night);
    shared.headMat.emissiveIntensity = preset.head * headScale;
    shared.tailOffMat.emissiveIntensity = THREE.MathUtils.lerp(
      preset.tailOff * 0.65,
      preset.tailOff * 1.35,
      night,
    );
    shared.tailBrakeMat.emissiveIntensity = preset.tailBrake * THREE.MathUtils.lerp(0.9, 1.2, night);
    shared.indicatorOffMat.emissiveIntensity = preset.indicatorOff;
    shared.indicatorOnMat.emissiveIntensity = preset.indicatorOn * THREE.MathUtils.lerp(0.95, 1.25, night);
    shared.signMat.emissiveIntensity = preset.taxiSign * signScale;
    shared.destinationMat.emissiveIntensity = preset.destination * signScale;
    shared.beaconOffMat.emissiveIntensity = preset.beaconOff;
    shared.beaconOnMat.emissiveIntensity = preset.beaconOn * THREE.MathUtils.lerp(1, 1.2, night);
  }

  function setWeather(mode = 'clear') {
    if (!shared) return;
    weatherMode = ['clear', 'fog', 'drizzle'].includes(mode) ? mode : 'clear';
    applyVehicleLighting();
  }

  function setNightLighting(amount = 0) {
    nightLightingAmount = THREE.MathUtils.clamp(Number(amount) || 0, 0, 1);
    applyVehicleLighting();
  }

  /* ---- player driving ---- */

  function projectVehiclePoseToRoad(position, heading, {
    maxDistance = 6.5,
    snapToLane = false,
  } = {}) {
    if (!Number.isFinite(position?.x)
      || !Number.isFinite(position?.z)
      || !Number.isFinite(heading)) return null;
    const headingX = Math.sin(heading);
    const headingZ = Math.cos(heading);
    let best = null;
    for (let roadIndex = 0; roadIndex < roads.length; roadIndex += 1) {
      const road = roads[roadIndex];
      const legalDirs = Array.isArray(road.dirs) && road.dirs.length ? road.dirs : [1, -1];
      for (let segment = 0; segment < road.px.length - 1; segment += 1) {
        const dx = road.px[segment + 1] - road.px[segment];
        const dz = road.pz[segment + 1] - road.pz[segment];
        const segmentLengthSquared = dx * dx + dz * dz;
        if (segmentLengthSquared <= 1e-8) continue;
        const segmentLength = Math.sqrt(segmentLengthSquared);
        const t = THREE.MathUtils.clamp(
          ((position.x - road.px[segment]) * dx
            + (position.z - road.pz[segment]) * dz) / segmentLengthSquared,
          0,
          1,
        );
        const centerX = road.px[segment] + dx * t;
        const centerY = road.py[segment]
          + (road.py[segment + 1] - road.py[segment]) * t;
        const centerZ = road.pz[segment] + dz * t;
        const offsetX = position.x - centerX;
        const offsetZ = position.z - centerZ;
        const distanceSquared = offsetX * offsetX + offsetZ * offsetZ;
        for (const dir of legalDirs) {
          const tangentX = dx / segmentLength * dir;
          const tangentZ = dz / segmentLength * dir;
          const alignment = headingX * tangentX + headingZ * tangentZ;
          const score = distanceSquared + (1 - alignment) * 4;
          if (best && score >= best.score) continue;
          const rightX = tangentZ;
          const rightZ = -tangentX;
          best = {
            score,
            distanceSquared,
            road: roadIndex,
            dir,
            s: road.cum[segment] + segmentLength * t,
            lateral: offsetX * rightX + offsetZ * rightZ,
            centerX,
            centerZ,
            rightX,
            rightZ,
            x: centerX + rightX * (offsetX * rightX + offsetZ * rightZ),
            y: centerY,
            z: centerZ + rightZ * (offsetX * rightX + offsetZ * rightZ),
            heading: Math.atan2(tangentX, tangentZ),
          };
        }
      }
    }
    const safeDistance = Math.max(0, Number(maxDistance) || 0);
    if (!best || Math.sqrt(best.distanceSquared) > safeDistance) {
      return null;
    }
    if (snapToLane) {
      const laneOffset = roads[best.road]?.laneOffset ?? LANE_OFFSET;
      best.lateral = laneOffset;
      best.x = best.centerX + best.rightX * laneOffset;
      best.z = best.centerZ + best.rightZ * laneOffset;
    } else if (Math.abs(best.lateral) > 6.5) {
      return null;
    }
    return best;
  }

  function activatePlayerVehicleRecord(vehicle) {
    if (!vehicle
      || vehicle.impounded
      || vehicle.garageStored
      || (playerVehicle && playerVehicle !== vehicle)) return false;
    if (lastPlayerParkedVehicle && lastPlayerParkedVehicle !== vehicle) {
      lastPlayerParkedVehicle.dwellUntil = 4;
      lastPlayerParkedVehicle.curbDwellUntil = Infinity;
    }
    vehicle.playerControlled = true;
    vehicle.impounded = false;
    vehicle.parked = false;
    vehicle.parkedAt = null;
    vehicle.speed = 0;
    vehicle.longitudinalAccel = 0;
    vehicle.accelSm = 0;
    vehicle.route = null;
    vehicle.turn = null;
    vehicle.leader = null;
    vehicle.waitingForGreen = false;
    vehicle.greenReleaseAt = Infinity;
    vehicle.curbDwellUntil = Infinity;
    vehicle.nextCurbStopAt = Infinity;
    vehicle.nextServiceAt = Infinity;
    vehicle.busStopIndex = -1;
    vehicle.mergeSignalUntil = 0;
    vehicle.pullOutBlockedSince = null;
    vehicle.playerSteer = 0;
    playerSignalViolationLatch = null;
    playerVehicleCollisionLatch.clear();
    lastPlayerParkedVehicle = null;
    playerVehicle = vehicle;
    return true;
  }

  function getNearestEnterableVehicle(position, maxDistance = 3.6) {
    if (!position) return null;
    const held = vehicleEmbodimentQaHold;
    if (held?.vehicle) {
      const vehicle = held.vehicle;
      const eligible = vehicle.cls !== 'bike'
        && !vehicle.impounded
        && !vehicle.garageStored
        && !taxiAtServiceStop(vehicle)
        && !transitAtStop(vehicle)
        && !deliveryAtServiceStop(vehicle)
        && !vehicle.disabled
        && !vehicle.playerControlled
        && !vehicle.remoteControlled
        && vehicle.parked
        && vehicle.mesh.root.visible;
      const distance = Math.hypot(
        vehicle.mesh.root.position.x - position.x,
        vehicle.mesh.root.position.z - position.z,
      );
      if (eligible && distance <= maxDistance) {
        return { index: held.index, vehicle, distance };
      }
      clearVehicleEmbodimentQaHold();
    }
    let best = null;
    for (let index = 0; index < vehicles.length; index += 1) {
      const vehicle = vehicles[index];
      if (vehicle.cls === 'bike') continue;
      if (vehicle.impounded) continue;
      if (vehicle.garageStored) continue;
      if (taxiAtServiceStop(vehicle)) continue;
      if (transitAtStop(vehicle)) continue;
      if (deliveryAtServiceStop(vehicle)) continue;
      if (vehicle.disabled && vehicle !== lastPlayerParkedVehicle) continue;
      if (vehicle.playerControlled || vehicle.remoteControlled) continue;
      if (!vehicle.parked && vehicle.speed > 0.9) continue;
      const point = vehicle.mesh.root.position;
      const distance = Math.hypot(point.x - position.x, point.z - position.z);
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = { index, vehicle, distance };
      }
    }
    return best;
  }

  function taxiAtServiceStop(vehicle) {
    return Boolean(
      vehicle
      && vehicle.identity.category === 'taxi'
      && vehicle.identity.curbService === 'taxi'
      && !vehicle.disabled
      && !vehicle.impounded
      && !vehicle.playerControlled
      && !vehicle.remoteControlled
      && !vehicle.parked
      && vehicle.speed < 0.25
      && Number.isFinite(vehicle.curbDwellUntil)
      && vehicle.curbDwellUntil > lastElapsed,
    );
  }

  function getNearestTaxiService(position, maxDistance = 3.8) {
    if (!position || taxiRide || muniRide) return null;
    let best = null;
    for (let index = 0; index < vehicles.length; index += 1) {
      const vehicle = vehicles[index];
      if (!taxiAtServiceStop(vehicle)) continue;
      const point = vehicle.mesh.root.position;
      const distance = Math.hypot(point.x - position.x, point.z - position.z);
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = { index, vehicle, distance };
      }
    }
    return best;
  }

  function deliveryAtServiceStop(vehicle) {
    return Boolean(
      vehicle
      && vehicle.identity.category === 'delivery'
      && vehicle.identity.curbService === 'delivery'
      && !vehicle.disabled
      && !vehicle.impounded
      && !vehicle.playerControlled
      && !vehicle.remoteControlled
      && !vehicle.parked
      && vehicle.speed < 0.25
      && Number.isFinite(vehicle.curbDwellUntil)
      && vehicle.curbDwellUntil > lastElapsed,
    );
  }

  function getNearestDeliveryService(position, maxDistance = 3.8) {
    if (!position || taxiRide || muniRide) return null;
    let best = null;
    for (let index = 0; index < vehicles.length; index += 1) {
      const vehicle = vehicles[index];
      if (!deliveryAtServiceStop(vehicle)) continue;
      const point = vehicle.mesh.root.position;
      const distance = Math.hypot(point.x - position.x, point.z - position.z);
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = {
          index,
          distance,
          class: vehicle.cls,
          identity: vehicle.identity.key,
          label: vehicle.identity.label,
          dwellRemaining: Math.max(0, vehicle.curbDwellUntil - lastElapsed),
          position: { x: point.x, y: point.y, z: point.z },
        };
      }
    }
    return best;
  }

  function acceptDeliveryService(index) {
    if (playerVehicle || taxiRide || muniRide || !Number.isInteger(index)) return null;
    const vehicle = vehicles[index];
    if (!deliveryAtServiceStop(vehicle)) return null;
    vehicle.curbDwellUntil = Math.max(vehicle.curbDwellUntil, lastElapsed + 1.2);
    vehicle.hazardUntil = Math.max(vehicle.hazardUntil, vehicle.curbDwellUntil);
    const point = vehicle.mesh.root.position;
    return {
      vehicleId: index,
      class: vehicle.cls,
      identity: vehicle.identity.key,
      label: vehicle.identity.label,
      position: { x: point.x, y: point.y, z: point.z },
    };
  }

  function transitAtStop(vehicle, minimumDwell = 0) {
    return Boolean(
      vehicle
      && vehicle.cls === 'bus'
      && vehicle.mesh.root.visible
      && !vehicle.disabled
      && !vehicle.impounded
      && !vehicle.garageStored
      && !vehicle.playerControlled
      && !vehicle.remoteControlled
      && !vehicle.parked
      && vehicle.speed < 0.25
      && Number.isFinite(vehicle.curbDwellUntil)
      && vehicle.curbDwellUntil - lastElapsed >= Math.max(0, minimumDwell),
    );
  }

  function getNearestTransitService(position, maxDistance = 3.8, minimumDwell = 2.8) {
    if (!position || taxiRide || muniRide) return null;
    let best = null;
    for (let index = 0; index < vehicles.length; index += 1) {
      const vehicle = vehicles[index];
      if (!transitAtStop(vehicle, minimumDwell)) continue;
      const point = vehicle.mesh.root.position;
      const distance = Math.hypot(point.x - position.x, point.z - position.z);
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = {
          index,
          distance,
          class: vehicle.cls,
          identity: vehicle.identity.key,
          label: vehicle.identity.label,
          dwellRemaining: Math.max(0, vehicle.curbDwellUntil - lastElapsed),
          road: vehicle.road,
          position: { x: point.x, y: point.y, z: point.z },
        };
      }
    }
    return best;
  }

  function beginMuniRide(index) {
    if (muniRide
      || taxiRide
      || playerVehicle
      || impoundedPlayerVehicle
      || !Number.isInteger(index)) return null;
    const vehicle = vehicles[index];
    if (!transitAtStop(vehicle, 0.35)) return null;
    vehicle.curbDwellUntil = Math.max(vehicle.curbDwellUntil, lastElapsed + 0.7);
    vehicle.hazardUntil = Math.max(vehicle.hazardUntil, vehicle.curbDwellUntil);
    const point = vehicle.mesh.root.position;
    muniRide = {
      vehicle,
      vehicleId: index,
      startedAt: lastElapsed,
      departed: false,
      arrived: false,
      arrivedAt: null,
      traveled: 0,
      lastX: point.x,
      lastZ: point.z,
    };
    return getMuniRideState();
  }

  function getMuniRideState() {
    if (!muniRide) return null;
    const vehicle = muniRide.vehicle;
    const point = vehicle.mesh.root.position;
    return {
      active: true,
      phase: muniRide.arrived ? 'arrived' : muniRide.departed ? 'en-route' : 'boarding',
      arrived: muniRide.arrived,
      vehicleId: muniRide.vehicleId,
      class: vehicle.cls,
      identity: vehicle.identity.key,
      position: { x: point.x, y: point.y, z: point.z },
      heading: vehicle.heading ?? vehicle.mesh.root.rotation.y ?? 0,
      road: vehicle.road,
      s: vehicle.s,
      traveled: Math.round(muniRide.traveled * 10) / 10,
      elapsed: Math.max(0, lastElapsed - muniRide.startedAt),
      dwellRemaining: Number.isFinite(vehicle.curbDwellUntil)
        ? Math.max(0, vehicle.curbDwellUntil - lastElapsed)
        : 0,
    };
  }

  function completeMuniRide() {
    const state = getMuniRideState();
    if (!state?.arrived) return null;
    const vehicle = muniRide.vehicle;
    vehicle.curbDwellUntil = Math.max(vehicle.curbDwellUntil, lastElapsed + 0.6);
    vehicle.hazardUntil = Math.max(vehicle.hazardUntil, vehicle.curbDwellUntil);
    muniRide = null;
    return { ...state, active: false };
  }

  function cancelMuniRide() {
    if (!muniRide) return false;
    muniRide = null;
    return true;
  }

  function beginTaxiRide(index) {
    if (taxiRide
      || muniRide
      || playerVehicle
      || !Number.isInteger(index)) return null;
    const vehicle = vehicles[index];
    if (!taxiAtServiceStop(vehicle)) return null;
    vehicle.curbDwellUntil = Math.max(vehicle.curbDwellUntil, lastElapsed + 4.2);
    vehicle.hazardUntil = Math.max(vehicle.hazardUntil, vehicle.curbDwellUntil);
    taxiRide = {
      vehicle,
      vehicleId: index,
      startedAt: lastElapsed,
    };
    return getTaxiRideState();
  }

  function getTaxiRideState() {
    if (!taxiRide) return null;
    const point = taxiRide.vehicle.mesh.root.position;
    return {
      active: true,
      vehicleId: taxiRide.vehicleId,
      class: taxiRide.vehicle.cls,
      identity: taxiRide.vehicle.identity.key,
      position: { x: point.x, y: point.y, z: point.z },
      elapsed: Math.max(0, lastElapsed - taxiRide.startedAt),
    };
  }

  function completeTaxiRide() {
    const state = getTaxiRideState();
    if (!state) return null;
    const vehicle = taxiRide.vehicle;
    vehicle.curbDwellUntil = Math.max(vehicle.curbDwellUntil, lastElapsed + 0.6);
    vehicle.hazardUntil = Math.max(vehicle.hazardUntil, vehicle.curbDwellUntil);
    taxiRide = null;
    return { ...state, active: false };
  }

  function cancelTaxiRide() {
    if (!taxiRide) return false;
    taxiRide = null;
    return true;
  }

  function enterPlayerVehicle(index) {
    if (playerVehicle || impoundedPlayerVehicle || taxiRide || muniRide || !Number.isInteger(index)) return false;
    const vehicle = vehicles[index];
    if (!vehicle
      || vehicle.playerControlled
      || vehicle.remoteControlled
      || vehicle.garageStored
      || (vehicle.disabled && vehicle !== lastPlayerParkedVehicle)) return false;
    vehicle.hazardUntil = 0;
    vehicle.laneOffsetSm = (roads[vehicle.road]?.laneOffset ?? LANE_OFFSET) + vehicle.laneBias;
    const entered = activatePlayerVehicleRecord(vehicle);
    if (entered && vehicleEmbodimentQaHold?.vehicle === vehicle) {
      clearVehicleEmbodimentQaHold({ restore: false });
    }
    return entered;
  }

  function serializePlayerVehicleState(vehicle, mode) {
    if (!vehicle) return null;
    const index = vehicles.indexOf(vehicle);
    const point = vehicle.mesh.root.position;
    return {
      mode,
      vehicleId: index,
      class: vehicle.cls,
      identity: vehicle.identity.key,
      position: { x: point.x, z: point.z },
      heading: vehicle.heading ?? vehicle.mesh.root.rotation.y ?? 0,
      damage: vehicleDamageSnapshot(vehicle),
      theftReported: vehicle.theftReported === true,
      registeredOwner: vehicle.registeredOwner === true,
    };
  }

  function exportPlayerVehicleState() {
    if (playerVehicle) return serializePlayerVehicleState(playerVehicle, 'driving');
    if (impoundedPlayerVehicle) {
      return serializePlayerVehicleState(impoundedPlayerVehicle, 'impounded');
    }
    return serializePlayerVehicleState(lastPlayerParkedVehicle, 'parked');
  }

  function exportCollisionAftermathState() {
    const records = [];
    for (let index = 0; index < vehicles.length; index += 1) {
      const vehicle = vehicles[index];
      if (records.length >= MAX_PERSISTED_COLLISION_AFTERMATH) break;
      if (!vehicle
        || vehicle === playerVehicle
        || vehicle === lastPlayerParkedVehicle
        || vehicle === impoundedPlayerVehicle
        || vehicle.garageStored
        || vehicle.remoteControlled
        || !PERSISTED_COLLISION_DAMAGE_SOURCES.has(vehicle.lastDamage?.source)
        || vehicle.health >= vehicle.maxHealth) continue;
      records.push({
        vehicleId: index,
        class: vehicle.cls,
        identity: vehicle.identity.key,
        damage: vehicleDamageSnapshot(vehicle),
      });
    }
    return { version: 1, vehicles: records };
  }

  function validateCollisionAftermathState(snapshot, excludedVehicleIds = []) {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.vehicles)
      || snapshot.vehicles.length > MAX_PERSISTED_COLLISION_AFTERMATH) return null;
    const validated = [];
    const ids = new Set();
    const excludedIds = new Set(
      Array.isArray(excludedVehicleIds)
        ? excludedVehicleIds.filter((id) => Number.isInteger(id))
        : [],
    );
    for (const record of snapshot.vehicles) {
      const vehicleId = Number(record?.vehicleId);
      const health = Number(record?.damage?.health);
      const maxHealth = Number(record?.damage?.maxHealth);
      const lastDamage = record?.damage?.lastDamage;
      const vehicle = vehicles[vehicleId];
      const combatHealthStep = vehicle?.maxHealth / 4;
      const normalizedHealth = lastDamage?.source === 'combat-impact'
        ? Math.round(health / combatHealthStep) * combatHealthStep
        : health;
      if (!Number.isInteger(vehicleId)
        || ids.has(vehicleId)
        || excludedIds.has(vehicleId)
        || !vehicle
        || vehicle === playerVehicle
        || vehicle === lastPlayerParkedVehicle
        || vehicle === impoundedPlayerVehicle
        || vehicle.garageStored
        || vehicle.remoteControlled
        || record.class !== vehicle.cls
        || record.identity !== vehicle.identity.key
        || maxHealth !== vehicle.maxHealth
        || !Number.isFinite(health)
        || health < 0
        || health >= vehicle.maxHealth
        || (lastDamage?.source === 'combat-impact'
          && Math.abs(health - normalizedHealth) > 0.051)
        || typeof record.damage?.disabled !== 'boolean'
        || record.damage.disabled !== (normalizedHealth <= 0)
        || !lastDamage
        || !PERSISTED_COLLISION_DAMAGE_SOURCES.has(lastDamage.source)
        || !Number.isFinite(Number(lastDamage.amount))
        || Number(lastDamage.amount) <= 0
        || Number(lastDamage.amount) > vehicle.maxHealth
        || !Number.isFinite(Number(lastDamage.at))
        || Number(lastDamage.at) < 0
        || Number(lastDamage.at) > 1000000000) return null;
      ids.add(vehicleId);
      validated.push({ vehicle, health: normalizedHealth, lastDamage });
    }
    return validated;
  }

  function canImportCollisionAftermathState(snapshot, excludedVehicleIds = []) {
    return validateCollisionAftermathState(snapshot, excludedVehicleIds) !== null;
  }

  function importCollisionAftermathState(snapshot) {
    const validated = validateCollisionAftermathState(snapshot);
    if (!validated) return false;
    for (const vehicle of vehicles) {
      if (!PERSISTED_COLLISION_DAMAGE_SOURCES.has(vehicle.lastDamage?.source)
        || vehicle === playerVehicle
        || vehicle === lastPlayerParkedVehicle
        || vehicle === impoundedPlayerVehicle
        || vehicle.garageStored
        || vehicle.remoteControlled) continue;
      if (vehicle.disabled) diagnostics.disabledVehicles = Math.max(0, diagnostics.disabledVehicles - 1);
      vehicle.health = vehicle.maxHealth;
      vehicle.disabled = false;
      vehicle.damageState = 'clear';
      vehicle.lastDamage = null;
      vehicle.hazardUntil = 0;
      syncVehicleDamageMetadata(vehicle);
      syncVehicleCombatDisabledMetadata(vehicle, false);
    }
    for (const { vehicle, health, lastDamage } of validated) {
      vehicle.health = health;
      vehicle.disabled = health <= 0;
      vehicle.damageState = damageStateFor(vehicle);
      vehicle.lastDamage = {
        amount: Math.round(Number(lastDamage.amount) * 10) / 10,
        source: lastDamage.source,
        at: Math.max(0, Number(lastDamage.at)),
      };
      vehicle.damageCooldownUntil = 0;
      vehicle.hazardUntil = vehicle.disabled ? Infinity : 0;
      if (vehicle.disabled) {
        diagnostics.disabledVehicles += 1;
        vehicle.speed = 0;
        vehicle.longitudinalAccel = 0;
        vehicle.route = null;
        vehicle.turn = null;
        vehicle.blinkSide = 0;
      }
      syncVehicleDamageMetadata(vehicle);
      syncVehicleCombatDisabledMetadata(
        vehicle,
        vehicle.disabled && lastDamage.source === 'combat-impact',
      );
    }
    return true;
  }

  function importPlayerVehicleState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const mode = snapshot.mode === undefined ? 'driving' : snapshot.mode;
    const vehicleId = Number(snapshot.vehicleId);
    const heading = Number(snapshot.heading);
    const health = Number(snapshot.damage?.health);
    const maxHealth = Number(snapshot.damage?.maxHealth);
    if (!['driving', 'parked', 'impounded'].includes(mode)
      || !Number.isInteger(vehicleId)
      || !Number.isFinite(heading)
      || !Number.isFinite(health)
      || !Number.isFinite(maxHealth)
      || typeof snapshot.class !== 'string'
      || typeof snapshot.identity !== 'string'
      || typeof snapshot.theftReported !== 'boolean'
      || (snapshot.registeredOwner !== undefined
        && typeof snapshot.registeredOwner !== 'boolean')
      || typeof snapshot.damage?.disabled !== 'boolean') return false;
    const vehicle = vehicles[vehicleId];
    if (!vehicle
      || vehicle.cls !== snapshot.class
      || vehicle.identity.key !== snapshot.identity
      || vehicle.remoteControlled
      || vehicle.garageStored
      || (snapshot.registeredOwner === true && vehicle.identity.category !== 'private')
      || (playerVehicle && playerVehicle !== vehicle)
      || (mode !== 'driving' && playerVehicle)
      || maxHealth !== vehicle.maxHealth
      || health < 0
      || health > vehicle.maxHealth
      || snapshot.damage.disabled !== (health <= 0)) return false;
    const projection = projectVehiclePoseToRoad(snapshot.position, heading);
    if (!projection) return false;
    const lastDamage = snapshot.damage.lastDamage;
    if (lastDamage !== null && lastDamage !== undefined && (
      typeof lastDamage !== 'object'
      || !Number.isFinite(Number(lastDamage.amount))
      || !Number.isFinite(Number(lastDamage.at))
      || typeof lastDamage.source !== 'string'
    )) return false;

    const wasDisabled = vehicle.disabled;
    playerVehicleCollisionLatch.clear();
    vehicle.road = projection.road;
    vehicle.dir = projection.dir;
    vehicle.s = projection.s;
    vehicle.laneOffsetSm = projection.lateral;
    vehicle.heading = projection.heading;
    vehicle.mesh.root.position.set(projection.x, projection.y, projection.z);
    vehicle.mesh.root.rotation.y = projection.heading;
    vehicle.health = health;
    vehicle.disabled = snapshot.damage.disabled;
    vehicle.damageState = damageStateFor(vehicle);
    vehicle.lastDamage = lastDamage ? {
      amount: Math.round(Number(lastDamage.amount) * 10) / 10,
      source: lastDamage.source.slice(0, 64),
      at: Math.max(0, Number(lastDamage.at)),
    } : null;
    vehicle.damageCooldownUntil = 0;
    vehicle.hazardUntil = vehicle.disabled ? Infinity : 0;
    vehicle.theftReported = snapshot.theftReported;
    vehicle.registeredOwner = snapshot.registeredOwner === true;
    vehicle.garageStored = false;
    if (wasDisabled !== vehicle.disabled) {
      diagnostics.disabledVehicles += vehicle.disabled ? 1 : -1;
      diagnostics.disabledVehicles = Math.max(0, diagnostics.disabledVehicles);
    }
    syncVehicleDamageMetadata(vehicle);
    if (mode === 'driving') {
      if (impoundedPlayerVehicle === vehicle) impoundedPlayerVehicle = null;
      if (!activatePlayerVehicleRecord(vehicle)) return false;
    } else if (mode === 'parked') {
      if (lastPlayerParkedVehicle && lastPlayerParkedVehicle !== vehicle) {
        lastPlayerParkedVehicle.dwellUntil = 4;
        lastPlayerParkedVehicle.curbDwellUntil = Infinity;
      }
      vehicle.playerControlled = false;
      vehicle.playerSteer = 0;
      vehicle.speed = 0;
      vehicle.longitudinalAccel = 0;
      vehicle.accelSm = 0;
      vehicle.route = null;
      vehicle.turn = null;
      vehicle.leader = null;
      vehicle.parked = true;
      vehicle.impounded = false;
      vehicle.parkedAt = null;
      vehicle.dwellUntil = Infinity;
      vehicle.curbDwellUntil = Infinity;
      lastPlayerParkedVehicle = vehicle;
      if (impoundedPlayerVehicle === vehicle) impoundedPlayerVehicle = null;
    } else {
      if (lastPlayerParkedVehicle === vehicle) lastPlayerParkedVehicle = null;
      vehicle.playerControlled = false;
      vehicle.playerSteer = 0;
      vehicle.speed = 0;
      vehicle.longitudinalAccel = 0;
      vehicle.accelSm = 0;
      vehicle.route = null;
      vehicle.turn = null;
      vehicle.leader = null;
      vehicle.parked = true;
      vehicle.impounded = true;
      vehicle.parkedAt = null;
      vehicle.dwellUntil = Infinity;
      vehicle.curbDwellUntil = Infinity;
      vehicle.mesh.root.visible = false;
      impoundedPlayerVehicle = vehicle;
    }
    if (mode === 'driving' && vehicle.disabled) {
      playerInput.throttle = 0;
      playerInput.brake = 1;
      playerInput.steer = 0;
    }
    return true;
  }

  function reportPlayerVehicleTheft() {
    if (!playerVehicle || playerVehicle.identity.category !== 'private') return null;
    if (playerVehicle.registeredOwner) {
      return {
        reported: false,
        reason: 'registered-owner',
        vehicleId: vehicles.indexOf(playerVehicle),
      };
    }
    if (playerVehicle.theftReported) {
      return {
        reported: false,
        reason: 'already-reported',
        vehicleId: vehicles.indexOf(playerVehicle),
      };
    }
    playerVehicle.theftReported = true;
    diagnostics.vehicleThefts += 1;
    return {
      reported: true,
      vehicleId: vehicles.indexOf(playerVehicle),
      class: playerVehicle.cls,
      identity: playerVehicle.identity.key,
      label: playerVehicle.identity.label,
    };
  }

  function getPlayerVehicleRegistrationState() {
    const vehicle = lastPlayerParkedVehicle;
    if (!vehicle || playerVehicle || impoundedPlayerVehicle) return null;
    return {
      ...serializePlayerVehicleState(vehicle, 'parked'),
      eligible: vehicle.identity.category === 'private',
    };
  }

  function registerParkedPlayerVehicle() {
    const vehicle = lastPlayerParkedVehicle;
    if (!vehicle
      || playerVehicle
      || impoundedPlayerVehicle
      || vehicle.identity.category !== 'private'
      || vehicle.registeredOwner) return null;
    vehicle.registeredOwner = true;
    return serializePlayerVehicleState(vehicle, 'parked');
  }

  function setGarageStoredState(vehicle, stored) {
    if (!vehicle) return;
    vehicle.garageStored = stored;
    vehicle.impounded = false;
    vehicle.playerControlled = false;
    vehicle.playerSteer = 0;
    vehicle.speed = 0;
    vehicle.longitudinalAccel = 0;
    vehicle.accelSm = 0;
    vehicle.route = null;
    vehicle.turn = null;
    vehicle.leader = null;
    vehicle.parked = true;
    vehicle.parkedAt = null;
    vehicle.dwellUntil = Infinity;
    vehicle.curbDwellUntil = Infinity;
    vehicle.hazardUntil = vehicle.disabled ? Infinity : 0;
    vehicle.mesh.root.visible = !stored;
  }

  function getPlayerGarageState() {
    const slots = playerGarageSlots.map((vehicle, slot) => (
      vehicle ? { slot, ...serializePlayerVehicleState(vehicle, 'garage') } : null
    ));
    return {
      capacity: playerGarageSlots.length,
      count: slots.filter(Boolean).length,
      nextRetrieveSlot: playerGarageRetrieveCursor,
      slots,
    };
  }

  function exportPlayerGarageState() {
    return getPlayerGarageState();
  }

  function storeParkedPlayerVehicleInGarage() {
    const vehicle = lastPlayerParkedVehicle;
    const slot = playerGarageSlots.findIndex((entry) => entry === null);
    if (!vehicle
      || slot < 0
      || playerVehicle
      || impoundedPlayerVehicle
      || taxiRide
      || muniRide
      || vehicle.identity.category !== 'private'
      || vehicle.registeredOwner !== true
      || vehicle.garageStored) return null;
    lastPlayerParkedVehicle = null;
    playerGarageSlots[slot] = vehicle;
    setGarageStoredState(vehicle, true);
    return { slot, vehicle: serializePlayerVehicleState(vehicle, 'garage') };
  }

  function retrievePlayerGarageVehicle(position, heading = 0, requestedSlot = null) {
    if (playerVehicle
      || lastPlayerParkedVehicle
      || impoundedPlayerVehicle
      || taxiRide
      || muniRide) return null;
    const hasRequestedSlot = Number.isInteger(requestedSlot);
    let slot = hasRequestedSlot ? requestedSlot : -1;
    if (hasRequestedSlot && (
      slot < 0 || slot >= playerGarageSlots.length || !playerGarageSlots[slot]
    )) return null;
    if (!hasRequestedSlot) {
      slot = -1;
      for (let offset = 0; offset < playerGarageSlots.length; offset += 1) {
        const candidate = (playerGarageRetrieveCursor + offset) % playerGarageSlots.length;
        if (playerGarageSlots[candidate]) {
          slot = candidate;
          break;
        }
      }
    }
    if (slot < 0) return null;
    const vehicle = playerGarageSlots[slot];
    const projection = projectVehiclePoseToRoad(position, heading, {
      maxDistance: 96,
      snapToLane: true,
    });
    if (!projection) return null;
    vehicle.road = projection.road;
    vehicle.dir = projection.dir;
    vehicle.s = projection.s;
    vehicle.laneOffsetSm = projection.lateral;
    vehicle.heading = projection.heading;
    vehicle.mesh.root.position.set(projection.x, projection.y, projection.z);
    vehicle.mesh.root.rotation.y = projection.heading;
    setGarageStoredState(vehicle, false);
    playerGarageSlots[slot] = null;
    playerGarageRetrieveCursor = (slot + 1) % playerGarageSlots.length;
    lastPlayerParkedVehicle = vehicle;
    return { slot, vehicle: serializePlayerVehicleState(vehicle, 'parked') };
  }

  function importPlayerGarageState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.slots)) return false;
    if (snapshot.slots.length !== playerGarageSlots.length) return false;
    const cursor = Number(snapshot.nextRetrieveSlot ?? 0);
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= playerGarageSlots.length) return false;
    const validated = [];
    const vehicleIds = new Set();
    for (let slot = 0; slot < snapshot.slots.length; slot += 1) {
      const entry = snapshot.slots[slot];
      if (entry === null) {
        validated.push(null);
        continue;
      }
      const vehicleId = Number(entry.vehicleId);
      const heading = Number(entry.heading);
      const health = Number(entry.damage?.health);
      const maxHealth = Number(entry.damage?.maxHealth);
      if (entry.mode !== 'garage'
        || entry.slot !== slot
        || !Number.isInteger(vehicleId)
        || vehicleIds.has(vehicleId)
        || !Number.isFinite(heading)
        || !Number.isFinite(health)
        || !Number.isFinite(maxHealth)
        || typeof entry.class !== 'string'
        || entry.identity !== 'private'
        || entry.registeredOwner !== true
        || typeof entry.theftReported !== 'boolean'
        || typeof entry.damage?.disabled !== 'boolean') return false;
      const vehicle = vehicles[vehicleId];
      if (!vehicle
        || vehicle.cls !== entry.class
        || vehicle.identity.key !== entry.identity
        || vehicle.identity.category !== 'private'
        || vehicle.remoteControlled
        || vehicle === playerVehicle
        || vehicle === lastPlayerParkedVehicle
        || vehicle === impoundedPlayerVehicle
        || maxHealth !== vehicle.maxHealth
        || health < 0
        || health > maxHealth
        || entry.damage.disabled !== (health <= 0)) return false;
      const projection = projectVehiclePoseToRoad(entry.position, heading);
      if (!projection) return false;
      const lastDamage = entry.damage.lastDamage;
      if (lastDamage !== null && lastDamage !== undefined && (
        typeof lastDamage !== 'object'
        || !Number.isFinite(Number(lastDamage.amount))
        || !Number.isFinite(Number(lastDamage.at))
        || typeof lastDamage.source !== 'string'
      )) return false;
      vehicleIds.add(vehicleId);
      validated.push({
        vehicle,
        projection,
        health,
        disabled: entry.damage.disabled,
        theftReported: entry.theftReported,
        lastDamage,
      });
    }

    for (const vehicle of playerGarageSlots) {
      if (vehicle && !vehicleIds.has(vehicles.indexOf(vehicle))) setGarageStoredState(vehicle, false);
    }
    playerGarageSlots.fill(null);
    validated.forEach((entry, slot) => {
      if (!entry) return;
      const { vehicle, projection, health, disabled, theftReported, lastDamage } = entry;
      const wasDisabled = vehicle.disabled;
      vehicle.road = projection.road;
      vehicle.dir = projection.dir;
      vehicle.s = projection.s;
      vehicle.laneOffsetSm = projection.lateral;
      vehicle.heading = projection.heading;
      vehicle.mesh.root.position.set(projection.x, projection.y, projection.z);
      vehicle.mesh.root.rotation.y = projection.heading;
      vehicle.health = health;
      vehicle.disabled = disabled;
      vehicle.damageState = damageStateFor(vehicle);
      vehicle.lastDamage = lastDamage ? {
        amount: Math.round(Number(lastDamage.amount) * 10) / 10,
        source: lastDamage.source.slice(0, 64),
        at: Math.max(0, Number(lastDamage.at)),
      } : null;
      vehicle.damageCooldownUntil = 0;
      vehicle.theftReported = theftReported;
      vehicle.registeredOwner = true;
      if (wasDisabled !== disabled) {
        diagnostics.disabledVehicles += disabled ? 1 : -1;
        diagnostics.disabledVehicles = Math.max(0, diagnostics.disabledVehicles);
      }
      syncVehicleDamageMetadata(vehicle);
      setGarageStoredState(vehicle, true);
      playerGarageSlots[slot] = vehicle;
    });
    playerGarageRetrieveCursor = cursor;
    return true;
  }

  function exitPlayerVehicle() {
    if (!playerVehicle) return null;
    const vehicle = playerVehicle;
    const currentPoint = vehicle.mesh.root.position;
    const parkedProjection = projectVehiclePoseToRoad({
      x: currentPoint.x,
      z: currentPoint.z,
    }, vehicle.heading ?? vehicle.mesh.root.rotation.y ?? 0);
    if (parkedProjection) {
      vehicle.road = parkedProjection.road;
      vehicle.dir = parkedProjection.dir;
      vehicle.s = parkedProjection.s;
      vehicle.laneOffsetSm = parkedProjection.lateral;
      vehicle.heading = parkedProjection.heading;
      vehicle.mesh.root.position.set(
        parkedProjection.x,
        parkedProjection.y,
        parkedProjection.z,
      );
      vehicle.mesh.root.rotation.y = parkedProjection.heading;
    }
    const point = vehicle.mesh.root.position;
    const exit = {
      x: point.x,
      y: point.y,
      z: point.z,
      heading: vehicle.heading ?? 0,
    };
    vehicle.playerControlled = false;
    vehicle.playerSteer = 0;
    vehicle.speed = 0;
    vehicle.longitudinalAccel = 0;
    vehicle.route = null;
    vehicle.turn = null;
    vehicle.parked = true;
    vehicle.parkedAt = null;
    vehicle.dwellUntil = Infinity;
    vehicle.curbDwellUntil = Infinity;
    lastPlayerParkedVehicle = vehicle;
    playerVehicle = null;
    playerVehicleCollisionLatch.clear();
    return exit;
  }

  function impoundPlayerVehicle() {
    const vehicle = lastPlayerParkedVehicle;
    if (!vehicle || playerVehicle || impoundedPlayerVehicle) return null;
    lastPlayerParkedVehicle = null;
    impoundedPlayerVehicle = vehicle;
    vehicle.impounded = true;
    vehicle.playerControlled = false;
    vehicle.speed = 0;
    vehicle.longitudinalAccel = 0;
    vehicle.accelSm = 0;
    vehicle.route = null;
    vehicle.turn = null;
    vehicle.leader = null;
    vehicle.parked = true;
    vehicle.parkedAt = null;
    vehicle.dwellUntil = Infinity;
    vehicle.curbDwellUntil = Infinity;
    vehicle.mesh.root.visible = false;
    return exportPlayerVehicleState();
  }

  function getImpoundedVehicleState() {
    return serializePlayerVehicleState(impoundedPlayerVehicle, 'impounded');
  }

  function retrieveImpoundedPlayerVehicle(position, heading = 0) {
    const vehicle = impoundedPlayerVehicle;
    if (!vehicle || playerVehicle || lastPlayerParkedVehicle) return null;
    const projection = projectVehiclePoseToRoad(position, heading, {
      maxDistance: 96,
      snapToLane: true,
    });
    if (!projection) return null;
    vehicle.road = projection.road;
    vehicle.dir = projection.dir;
    vehicle.s = projection.s;
    vehicle.laneOffsetSm = projection.lateral;
    vehicle.heading = projection.heading;
    vehicle.mesh.root.position.set(projection.x, projection.y, projection.z);
    vehicle.mesh.root.rotation.y = projection.heading;
    vehicle.impounded = false;
    vehicle.playerControlled = false;
    vehicle.playerSteer = 0;
    vehicle.speed = 0;
    vehicle.longitudinalAccel = 0;
    vehicle.accelSm = 0;
    vehicle.route = null;
    vehicle.turn = null;
    vehicle.leader = null;
    vehicle.parked = true;
    vehicle.parkedAt = null;
    vehicle.dwellUntil = Infinity;
    vehicle.curbDwellUntil = Infinity;
    vehicle.hazardUntil = vehicle.disabled ? Infinity : 0;
    impoundedPlayerVehicle = null;
    lastPlayerParkedVehicle = vehicle;
    return exportPlayerVehicleState();
  }

  function setPlayerInput(input = {}) {
    if (playerVehicle?.disabled) {
      playerInput.throttle = 0;
      playerInput.brake = 1;
      playerInput.steer = 0;
      return;
    }
    playerInput.throttle = THREE.MathUtils.clamp(Number(input.throttle) || 0, 0, 1);
    playerInput.brake = THREE.MathUtils.clamp(Number(input.brake) || 0, 0, 1);
    playerInput.steer = THREE.MathUtils.clamp(Number(input.steer) || 0, -1, 1);
  }

  function getPlayerVehicleState() {
    if (!playerVehicle) return null;
    const vehicle = playerVehicle;
    const point = vehicle.mesh.root.position;
    return {
      index: vehicles.indexOf(vehicle),
      class: vehicle.cls,
      color: typeof vehicle.mesh.root.userData.vehicleColor === 'number'
        ? vehicle.mesh.root.userData.vehicleColor
        : null,
      position: { x: point.x, y: point.y, z: point.z },
      heading: vehicle.heading ?? 0,
      speed: vehicle.speed,
      road: vehicle.road,
      signalAhead: signalApproachFor(vehicle),
      damage: vehicleDamageSnapshot(vehicle),
      theft: {
        eligible: vehicle.identity.category === 'private',
        reported: vehicle.theftReported === true,
        registeredOwner: vehicle.registeredOwner === true,
      },
    };
  }

  function getPlayerPedestrianImpactProbe() {
    if (!playerPedestrianImpactProbe || !playerVehicle) return null;
    return {
      vehicleId: playerPedestrianImpactProbe.vehicleId,
      start: { ...playerPedestrianImpactProbe.start },
      end: { ...playerPedestrianImpactProbe.end },
      speed: playerPedestrianImpactProbe.speed,
      halfWidth: playerPedestrianImpactProbe.halfWidth,
    };
  }

  function resolvePlayerPedestrianImpact(candidates = []) {
    const probe = playerPedestrianImpactProbe;
    if (!playerVehicle || !probe || !Array.isArray(candidates)) {
      playerPedestrianImpactLatch.clear();
      return null;
    }
    const currentOverlaps = new Set();
    let contact = null;
    let contactDistanceSquared = Infinity;
    for (const candidate of candidates) {
      if (!candidate?.id
        || candidate.combatDefeated === true
        || !Number.isFinite(candidate.position?.x)
        || !Number.isFinite(candidate.position?.z)) continue;
      const radius = probe.halfWidth
        + Math.max(PLAYER_PEDESTRIAN_IMPACT_RADIUS, Number(candidate.radius) || 0);
      const distanceSquared = distanceSquaredToSegment(
        candidate.position,
        probe.start,
        probe.end,
      );
      if (distanceSquared > radius * radius) continue;
      const wasLatched = playerPedestrianImpactLatch.has(candidate.id);
      if (wasLatched) currentOverlaps.add(candidate.id);
      if (probe.speed < PLAYER_PEDESTRIAN_IMPACT_MIN_SPEED || wasLatched || contact) continue;
      currentOverlaps.add(candidate.id);
      contact = candidate;
      contactDistanceSquared = distanceSquared;
    }
    playerPedestrianImpactLatch = currentOverlaps;
    if (!contact) return null;

    const travelX = probe.end.x - probe.start.x;
    const travelZ = probe.end.z - probe.start.z;
    const travelLength = Math.hypot(travelX, travelZ);
    const directionX = travelLength > 1e-4
      ? travelX / travelLength
      : Math.sin(playerVehicle.heading || 0);
    const directionZ = travelLength > 1e-4
      ? travelZ / travelLength
      : Math.cos(playerVehicle.heading || 0);
    const impactSpeed = probe.speed;
    const damageAmount = THREE.MathUtils.clamp(4 + impactSpeed * 0.9, 7, 14);
    const damage = applyVehicleDamage(playerVehicle, damageAmount, 'pedestrian-impact');
    playerVehicle.speed *= 0.72;
    playerVehicle.longitudinalAccel = Math.min(0, playerVehicle.longitudinalAccel);
    playerVehicle.hazardUntil = Math.max(playerVehicle.hazardUntil, lastElapsed + 1.8);
    diagnostics.pedestrianImpactEvents += 1;
    return {
      kind: 'pedestrian-impact',
      residentId: contact.id,
      residentLabel: contact.label || 'Resident',
      speed: Math.round(impactSpeed * 10) / 10,
      distance: Math.round(Math.sqrt(contactDistanceSquared) * 100) / 100,
      directionX,
      directionZ,
      damage,
    };
  }

  function damagePlayerVehicle(amount = 0, source = 'impact') {
    if (!playerVehicle) return null;
    return applyVehicleDamage(playerVehicle, amount, source);
  }

  function damageTrafficVehicleFromCombat(index) {
    const vehicle = vehicles[index];
    if (!vehicleEligibleForCombatDamage(vehicle)) return null;
    const damage = applyVehicleDamage(vehicle, vehicle.maxHealth / 4, 'combat-impact');
    if (damage?.disabled) syncVehicleCombatDisabledMetadata(vehicle, true);
    return {
      vehicleId: index,
      class: vehicle.cls,
      identity: vehicle.identity.key,
      damage,
    };
  }

  function repairPlayerVehicle(source = 'repair') {
    if (!playerVehicle) return null;
    if (canRepairPlayerVehicle?.({
      index: playerVehicle.index,
      disabled: playerVehicle.disabled,
      source,
    }) === false) return null;
    return repairVehicleRecord(playerVehicle, source);
  }

  /* ---- remote player vehicles ---- */

  function setRemotePose(index, pose = {}) {
    const vehicle = vehicles[index];
    if (!vehicle || vehicle.playerControlled || vehicle.impounded || vehicle.garageStored) return false;
    if (!vehicle.remoteControlled) {
      vehicle.remoteControlled = true;
      vehicle.parked = false;
      vehicle.parkedAt = null;
      vehicle.speed = 0;
      vehicle.route = null;
      vehicle.turn = null;
      vehicle.leader = null;
      vehicle.curbDwellUntil = Infinity;
      vehicle.nextCurbStopAt = Infinity;
      vehicle.nextServiceAt = Infinity;
      vehicle.busStopIndex = -1;
      vehicle.hazardUntil = 0;
      vehicle.mergeSignalUntil = 0;
      vehicle.heading = null;
    }
    const point = vehicle.mesh.root.position;
    const x = Number.isFinite(pose.x) ? pose.x : point.x;
    const y = Number.isFinite(pose.y) ? pose.y : point.y;
    const z = Number.isFinite(pose.z) ? pose.z : point.z;
    const yaw = Number.isFinite(pose.yaw) ? pose.yaw : (vehicle.heading ?? 0);
    vehicle.mesh.root.position.set(x, y, z);
    vehicle.mesh.root.rotation.set(0, yaw, 0);
    vehicle.mesh.root.visible = true;
    vehicle.remoteYaw = yaw;
    return true;
  }

  function clearRemotePose(index) {
    const vehicle = vehicles[index];
    if (!vehicle) return;
    vehicle.remoteControlled = false;
    vehicle.remoteYaw = null;
    vehicle.heading = null;
    vehicle.parked = true;
    vehicle.parkedAt = null;
    vehicle.dwellUntil = 4 + vehicle.servicePhase * 3;
  }

  function isPlayerDriving() {
    return Boolean(playerVehicle);
  }

  function getRuleProbeSample() {
    return vehicles.map((v) => {
      const road = roads[v.road];
      const illegalDir = road ? !isDirectionLegal(road, v.dir) : true;
      return {
        road: v.road,
        dir: v.dir,
        s: v.s,
        speed: v.speed,
        waitingAtStop: Boolean(v.waitingAtStop),
        stoppedAtStop: Boolean(v.waitingAtStop && v.speed < 0.2),
        waitingForGreen: Boolean(v.waitingForGreen),
        routeSide: v.route?.side ?? null,
        illegalDir,
        illegalTurn: false,
        oneway: Boolean(road?.oneway),
        controlAhead: nodes[road?.endNode[v.dir === 1 ? 1 : 0]]?.control || 'none',
      };
    });
  }

  return {
    group,
    update,
    setFocus,
    getStats,
    getDiagnostics,
    getOnFootVehicleContactDiagnostics,
    getOnFootVehicleImpactQaState,
    getVehicleLifeSnapshot,
    setPursuitResponder,
    setPursuitDeploymentHolds,
    setOnFootPlayerCollisionProbe,
    stageOnFootVehicleImpactQa,
    stagePlayerVehicleEmbodimentQa,
    getPursuitResponder,
    getPursuitResponders,
    getPursuitChaseDiagnostics,
    getRuleProbeSample,
    setWeather,
    setNightLighting,
    getNearestEnterableVehicle,
    getNearestTaxiService,
    getNearestTransitService,
    getNearestDeliveryService,
    acceptDeliveryService,
    beginMuniRide,
    getMuniRideState,
    completeMuniRide,
    cancelMuniRide,
    beginTaxiRide,
    getTaxiRideState,
    completeTaxiRide,
    cancelTaxiRide,
    enterPlayerVehicle,
    exportPlayerVehicleState,
    importPlayerVehicleState,
    exportCollisionAftermathState,
    canImportCollisionAftermathState,
    importCollisionAftermathState,
    getPlayerGarageState,
    exportPlayerGarageState,
    importPlayerGarageState,
    storeParkedPlayerVehicleInGarage,
    retrievePlayerGarageVehicle,
    reportPlayerVehicleTheft,
    getPlayerVehicleRegistrationState,
    registerParkedPlayerVehicle,
    exitPlayerVehicle,
    impoundPlayerVehicle,
    getImpoundedVehicleState,
    retrieveImpoundedPlayerVehicle,
    setPlayerInput,
    getPlayerVehicleState,
    getPlayerPedestrianImpactProbe,
    resolvePlayerPedestrianImpact,
    damageTrafficVehicleFromCombat,
    damagePlayerVehicle,
    repairPlayerVehicle,
    isPlayerDriving,
    setRemotePose,
    clearRemotePose,
  };
}

/** Headless multi-vehicle law-lite probe on the sandbox cross. */
export function createTrafficRulesHarness({ vehicleCount = 24 } = {}) {
  const scenario = createTrafficRuleScenario();
  const traffic = createTrafficSystem({
    roadNetwork: scenario,
    fleetSize: vehicleCount,
  });

  function sample() {
    return traffic.getRuleProbeSample();
  }

  function run(seconds = 18, dt = 1 / 30) {
    const samples = [];
    let t = 0;
    const steps = Math.max(1, Math.ceil(seconds / dt));
    for (let i = 0; i < steps; i += 1) {
      t += dt;
      traffic.update(dt, t);
      if (i % 8 === 0 || i === steps - 1) {
        samples.push(...sample());
      }
    }
    const diagnostics = traffic.getDiagnostics();
    const evaluation = evaluateTrafficRuleSample(samples, diagnostics);
    return {
      ...evaluation,
      diagnostics,
      active: traffic.getStats().active,
      scenarioId: scenario.id,
      vehicleCount,
      seconds,
    };
  }

  return { traffic, scenario, sample, run };
}

export { createTrafficRuleScenario, evaluateTrafficRuleSample };
