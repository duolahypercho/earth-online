// traffic-graph.js — road-rule contract for law-lite traffic.
// Pure module (no Three.js). Authored networks may declare one-ways,
// intersection controls (signal/stop/none), and turn forbids. The traffic
// system normalizes these onto roads/nodes and enforces them at spawn,
// route choice, and stop lines.

export const NODE_EPS = 1.25;

const SIDE_NAME = {
  [-1]: 'left',
  0: 'straight',
  1: 'right',
};

export function normalizeRoadRules(raw = {}) {
  const oneway = raw.oneway === true
    || (Array.isArray(raw.dirs) && raw.dirs.length === 1 && raw.dirs[0] === 1);
  let dirs;
  if (Array.isArray(raw.dirs) && raw.dirs.length) {
    dirs = [...new Set(raw.dirs.map((d) => (d < 0 ? -1 : 1)))];
  } else {
    dirs = oneway ? [1] : [1, -1];
  }
  if (!dirs.length) dirs = [1, -1];

  const rawSpeedLimit = Number(raw.speedLimit);
  const speedLimit = Number.isFinite(rawSpeedLimit) && rawSpeedLimit > 0
    ? (rawSpeedLimit > 18 ? rawSpeedLimit * 0.44704 : rawSpeedLimit)
    : Infinity;

  const rawLaneWidth = Number(raw.laneWidth);
  const laneOffset = Number.isFinite(rawLaneWidth) && rawLaneWidth > 0
    ? rawLaneWidth
    : null;

  return { oneway, dirs, speedLimit, laneOffset };
}

export function isDirectionLegal(road, dir) {
  if (!road) return false;
  const want = dir < 0 ? -1 : 1;
  if (Array.isArray(road.dirs) && road.dirs.length) {
    return road.dirs.includes(want);
  }
  if (road.oneway) return want === 1;
  return true;
}

function readXZ(point, out = { x: 0, z: 0 }) {
  if (!point) return null;
  if (typeof point.x === 'number' && typeof point.z === 'number') {
    out.x = point.x;
    out.z = point.z;
    return out;
  }
  if (Array.isArray(point) && point.length >= 2) {
    out.x = Number(point[0]);
    out.z = Number(point[1]);
    return Number.isFinite(out.x) && Number.isFinite(out.z) ? out : null;
  }
  return null;
}

function near(ax, az, bx, bz, eps = NODE_EPS * 2) {
  return Math.hypot(ax - bx, az - bz) <= eps;
}

export function resolveNodeControl(node, {
  signalPlans = [],
  controls = [],
  degreeSignalized = false,
} = {}) {
  if (!node) return 'none';

  const controlHit = controls.find((entry) => {
    const p = readXZ(entry);
    if (!p) return false;
    const type = entry.type || entry.control;
    return type && near(p.x, p.z, node.x, node.z);
  });
  if (controlHit) {
    const type = controlHit.type || controlHit.control;
    if (type === 'stop' || type === 'signal' || type === 'none') return type;
  }

  const plan = signalPlans.find((candidate) => {
    const p = readXZ(candidate.position || candidate);
    return p && near(p.x, p.z, node.x, node.z);
  });
  if (plan) {
    if (plan.control === 'stop') return 'stop';
    if (plan.control === 'none' || plan.signalized === false) return 'none';
    // A matching signal plan defaults to signalized (matches buildSignals).
    return 'signal';
  }

  if (node.control === 'stop' || node.control === 'signal' || node.control === 'none') {
    return node.control;
  }

  if (degreeSignalized && (node.ends?.length || 0) >= 3) return 'signal';
  return 'none';
}

export function attachNodeControls(nodes, roadNetwork = {}) {
  const controls = Array.isArray(roadNetwork.controls) ? roadNetwork.controls : [];
  const signalPlans = Array.isArray(roadNetwork.signalPlans)
    ? roadNetwork.signalPlans
    : [];
  const useAuthored = controls.length > 0 || signalPlans.length > 0;
  for (let i = 0; i < nodes.length; i += 1) {
    nodes[i].control = resolveNodeControl(nodes[i], {
      controls,
      signalPlans,
      degreeSignalized: !useAuthored && nodes[i].ends.length >= 3,
    });
  }
  return nodes;
}

export function turnSideName(side, uTurn = false) {
  if (uTurn) return 'uturn';
  return SIDE_NAME[side] || 'straight';
}

export function isTurnAllowed({ side, uTurn = false, rule = null }) {
  if (!rule) return true;
  const forbid = Array.isArray(rule.forbid) ? rule.forbid : [];
  if (!forbid.length) return true;
  const name = turnSideName(side, uTurn);
  return !forbid.map((item) => String(item).toLowerCase()).includes(name);
}

export function findTurnRule(node, approachPoint, turnRules = []) {
  if (!node || !Array.isArray(turnRules) || !turnRules.length) return null;
  const from = readXZ(approachPoint);
  if (!from) return null;
  return turnRules.find((rule) => {
    const at = readXZ(rule);
    if (!at || !near(at.x, at.z, node.x, node.z)) return false;
    const ruleFrom = readXZ(rule.from);
    if (!ruleFrom) return true;
    return near(ruleFrom.x, ruleFrom.z, from.x, from.z, NODE_EPS * 3);
  }) || null;
}

/** Build a compact cross with one-way, stop control, and a banned left. */
export function createTrafficRuleScenario() {
  const C = { x: 0, y: 0, z: 0 };
  const W = { x: -72, y: 0, z: 0 };
  const E = { x: 72, y: 0, z: 0 };
  const S = { x: 0, y: 0, z: -72 };
  const N = { x: 0, y: 0, z: 72 };

  return {
    id: 'traffic-rule-sandbox',
    roads: [
      {
        id: 'west-oneway',
        start: W,
        end: C,
        lanes: 1,
        speedLimit: 25,
        oneway: true,
      },
      {
        id: 'east-arm',
        start: C,
        end: E,
        lanes: 2,
        speedLimit: 25,
      },
      {
        id: 'south-arm',
        start: S,
        end: C,
        lanes: 2,
        speedLimit: 25,
      },
      {
        id: 'north-arm',
        start: C,
        end: N,
        lanes: 2,
        speedLimit: 25,
      },
    ],
    intersections: [C, W, E, S, N],
    controls: [
      { x: 0, z: 0, type: 'stop' },
    ],
    turnRules: [
      // Arriving from the west one-way: no left (toward north).
      { x: 0, z: 0, from: { x: -72, z: 0 }, forbid: ['left'] },
    ],
    signalPlans: [],
  };
}

export function evaluateTrafficRuleSample(samples = [], diagnostics = {}) {
  const failures = [];
  if (!Array.isArray(samples) || samples.length === 0) {
    failures.push('no vehicle samples collected');
  }

  let wrongWay = 0;
  let illegalTurns = 0;
  let stopSightings = 0;

  for (const sample of samples) {
    if (sample.illegalDir) wrongWay += 1;
    if (sample.illegalTurn) illegalTurns += 1;
    if (sample.waitingAtStop || sample.stoppedAtStop) stopSightings += 1;
  }

  if (wrongWay > 0) {
    failures.push(`${wrongWay} wrong-way samples on one-way / directed edges`);
  }
  if (illegalTurns > 0) {
    failures.push(`${illegalTurns} illegal turn samples`);
  }

  const stopStops = Number(diagnostics.stopSignStops || 0);
  if (stopStops <= 0 && stopSightings <= 0) {
    failures.push('no stop-sign compliance observed (need stopSignStops or waitingAtStop)');
  }

  const gapFields = ['minLaneGap', 'minMovingHeadway', 'minStoppedGap'];
  for (const field of gapFields) {
    const value = diagnostics[field];
    if (value != null && value < -0.01) {
      failures.push(`${field} went negative (${value})`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    counts: {
      samples: samples.length,
      wrongWay,
      illegalTurns,
      stopSightings,
      stopSignStops: stopStops,
      stopSignReleases: Number(diagnostics.stopSignReleases || 0),
      oneWayRejects: Number(diagnostics.oneWayRejects || 0),
      illegalTurnRejects: Number(diagnostics.illegalTurnRejects || 0),
    },
  };
}
