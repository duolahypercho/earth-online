import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const wss = new WebSocketServer({ port: PORT, host: HOST });
const clients = new Map();
let nextId = 1;
const vehicleLeases = new Map();
let nextVehicleLeaseRevision = 1;
const STATE_MIN_INTERVAL_MS = 35;
const GAMEPLAY_EVENT_MIN_INTERVAL_MS = 400;
const VEHICLE_LEASE_CLAIM_GRACE_MS = 3000;
const VEHICLE_LEASE_ACTIVE_TTL_MS = 2500;
const GAMEPLAY_ACTIVITIES = new Set([
  'idle', 'walking', 'driving', 'aiming', 'wanted', 'pursuit', 'working', 'downed',
]);
const GAMEPLAY_HEALTH_BANDS = new Set(['healthy', 'injured', 'critical', 'downed']);
const MISSION_STATUSES = new Set(['running', 'complete', 'failed']);
const configuredCoopSessionTtl = Number(process.env.SF_COOP_SESSION_TTL_MS);
const COOP_SESSION_TTL_MS = Number.isFinite(configuredCoopSessionTtl)
  ? Math.max(250, Math.min(120000, configuredCoopSessionTtl))
  : 120000;
const COOP_CASH_REWARD = 260;
// V1 opt-in is intentionally start-window only: both players enter through
// Welcome before step 2. Mid-run joins fail closed instead of silently
// granting skipped objectives or forcing a 0 -> N client progress leap.
const COOP_JOIN_STEP_INDEX = 0;
const COOP_STEPS = Object.freeze([
  Object.freeze({ id: 'welcome-center', kind: 'portal', label: 'Embarcadero Welcome Center', x: 46, z: 35.91, radius: 10, enterX: 348, enterZ: 12 }),
  Object.freeze({ id: 'welcome-desk', kind: 'hotspot', x: 348, z: 13.45, radius: 3.2 }),
  Object.freeze({ id: 'bay-route-model', kind: 'hotspot', x: 344.4, z: 9.75, radius: 3.2 }),
  Object.freeze({ id: 'map-archive', kind: 'hotspot', x: 352.95, z: 9.6, radius: 3.2 }),
  Object.freeze({ id: 'ferry-building', kind: 'portal', label: 'Ferry Building market hall', x: -8, z: 99.2, radius: 10, enterX: 380, enterZ: 12 }),
  Object.freeze({ id: 'coit-tower', kind: 'portal', label: 'Coit Tower observation deck', x: 82, z: 122.8, radius: 9, enterX: 364, enterZ: 12 }),
]);
let nextCoopSessionId = 1;
let nextCoopRevision = 1;
let activeCoopSession = null;
const GAMEPLAY_EVENT_KINDS = new Set([
  'arrested', 'critical', 'escaped', 'high-heat', 'near-miss', 'pedestrian-impact',
  'pursuit-start', 'responder-contact', 'traffic-violation', 'vehicle-theft',
  'witness-dispatch', 'witness-report', 'reckless-collision',
]);

function boundedNumber(value, min, max, fallback = 0) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function boundedInteger(value, min, max, fallback = min) {
  return Math.round(boundedNumber(value, min, max, fallback));
}

function sanitizeGameplayEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const id = String(event.id || '').trim().slice(0, 48);
  const kind = String(event.kind || '').trim();
  if (!id || !GAMEPLAY_EVENT_KINDS.has(kind)) return null;
  return {
    id,
    kind,
    message: String(event.message || '').trim().slice(0, 96),
    heat: boundedInteger(event.heat, 0, 100),
    wantedLevel: boundedInteger(event.wantedLevel, 0, 3),
  };
}

function sanitizeGameplay(gameplay, client) {
  if (!gameplay || typeof gameplay !== 'object') return null;
  const event = sanitizeGameplayEvent(gameplay.event);
  const now = Date.now();
  const freshEvent = event
    && event.id !== client.lastGameplayEventId
    && now - client.lastGameplayEventAt >= GAMEPLAY_EVENT_MIN_INTERVAL_MS
    ? event
    : null;
  if (freshEvent) {
    client.lastGameplayEventId = freshEvent.id;
    client.lastGameplayEventAt = now;
  }
  const eventId = event
    ? freshEvent?.id || client.lastGameplayEventId
    : null;
  const pursuitActive = gameplay.pursuitActive === true;
  const wantedLevel = pursuitActive
    ? Math.max(1, boundedInteger(gameplay.wantedLevel, 0, 3))
    : 0;
  return {
    heat: boundedInteger(gameplay.heat, 0, 100),
    wantedLevel,
    pursuitActive,
    healthBand: GAMEPLAY_HEALTH_BANDS.has(gameplay.healthBand)
      ? gameplay.healthBand
      : 'healthy',
    activity: GAMEPLAY_ACTIVITIES.has(gameplay.activity) ? gameplay.activity : 'idle',
    eventId,
    event: freshEvent,
  };
}

function sanitizeMission(mission, client) {
  if (mission == null) {
    client.lastMission = null;
    return null;
  }
  if (!mission || typeof mission !== 'object' || Array.isArray(mission)) {
    return client.lastMission ? { ...client.lastMission } : null;
  }
  const revision = Number(mission.revision);
  const completedSteps = Number(mission.completedSteps);
  const totalSteps = Number(mission.totalSteps);
  if (!Number.isInteger(revision)
    || revision < 1
    || revision > 1000000000
    || !MISSION_STATUSES.has(mission.status)
    || !Number.isInteger(completedSteps)
    || !Number.isInteger(totalSteps)
    || totalSteps < 1
    || totalSteps > 24
    || completedSteps < 0
    || completedSteps > totalSteps) {
    return client.lastMission ? { ...client.lastMission } : null;
  }
  if (revision <= client.lastMissionRevision) {
    return client.lastMission ? { ...client.lastMission } : null;
  }
  client.lastMissionRevision = revision;
  client.lastMission = {
    revision,
    status: mission.status,
    completedSteps,
    totalSteps,
    objective: String(mission.objective || '').trim().slice(0, 72),
  };
  return { ...client.lastMission };
}

function sanitizeState(message, client) {
  const vehicleId = Number.isInteger(message.vehicleId)
    ? boundedInteger(message.vehicleId, 0, 100000)
    : null;
  const requestedMode = message.mode === 'drive'
    ? 'drive'
    : message.mode === 'interior' ? 'interior' : 'walk';
  const lease = client.vehicleLease;
  const validDriveLease = requestedMode === 'drive'
    && vehicleId !== null
    && lease?.vehicleId === vehicleId
    && message.vehicleLeaseToken === lease.token
    && Number(message.vehicleLeaseRevision) === lease.revision
    && vehicleLeases.get(vehicleId) === lease;
  if (validDriveLease) {
    lease.active = true;
    lease.lastHeartbeatAt = Date.now();
  }
  const mode = requestedMode === 'drive' && !validDriveLease ? 'walk' : requestedMode;
  return {
    type: 'state',
    name: client.name,
    color: client.color,
    x: boundedNumber(message.x, -10000, 10000),
    y: boundedNumber(message.y, -1000, 4000),
    z: boundedNumber(message.z, -10000, 10000),
    yaw: boundedNumber(message.yaw, -Math.PI * 4, Math.PI * 4),
    mode,
    moving: message.moving === true,
    talking: message.talking === true,
    vehicleId: mode === 'drive' ? vehicleId : null,
    vehicleLeaseRevision: mode === 'drive' ? lease.revision : null,
    vehicleClass: String(message.vehicleClass || '').trim().slice(0, 24) || null,
    vehicleColor: Number.isFinite(message.vehicleColor)
      ? boundedInteger(message.vehicleColor, 0, 0xffffff)
      : null,
    gameplay: sanitizeGameplay(message.gameplay, client),
    mission: sanitizeMission(message.mission, client),
  };
}

function vehicleLeaseMessage(lease, status = 'granted', extra = {}) {
  return {
    type: 'vehicle:lease',
    status,
    vehicleId: lease.vehicleId,
    ownerId: lease.ownerId,
    revision: lease.revision,
    ...extra,
  };
}

function denyVehicleLease(client, message, reason, revision = null) {
  safeSend(client.ws, {
    type: 'vehicle:lease',
    status: 'denied',
    requestId: String(message.requestId || '').trim().slice(0, 64),
    vehicleId: Number.isInteger(message.vehicleId) ? message.vehicleId : null,
    revision,
    reason,
  });
}

function claimVehicleLease(id, client, message) {
  const requestId = String(message.requestId || '').trim().slice(0, 64);
  const vehicleId = Number(message.vehicleId);
  if (!requestId || !Number.isInteger(vehicleId) || vehicleId < 0 || vehicleId > 100000) {
    denyVehicleLease(client, message, 'invalid-claim');
    return;
  }
  if (client.vehicleLease) {
    if (client.vehicleLease.vehicleId !== vehicleId) {
      denyVehicleLease(client, message, 'already-owning', client.vehicleLease.revision);
      return;
    }
    safeSend(client.ws, vehicleLeaseMessage(client.vehicleLease, 'granted', {
      requestId,
      token: client.vehicleLease.token,
    }));
    return;
  }
  const occupied = vehicleLeases.get(vehicleId);
  if (occupied) {
    denyVehicleLease(client, message, 'occupied', occupied.revision);
    return;
  }
  const revision = nextVehicleLeaseRevision;
  nextVehicleLeaseRevision += 1;
  const lease = {
    vehicleId,
    ownerId: id,
    revision,
    token: `${id}:${vehicleId}:${revision}`,
    active: false,
    grantedAt: Date.now(),
    lastHeartbeatAt: null,
  };
  vehicleLeases.set(vehicleId, lease);
  client.vehicleLease = lease;
  broadcast(vehicleLeaseMessage(lease));
  safeSend(client.ws, vehicleLeaseMessage(lease, 'granted', {
    requestId,
    token: lease.token,
  }));
}

function releaseVehicleLease(id, client, message = null, reason = 'released') {
  if (!client) return false;
  const lease = client.vehicleLease;
  if (!lease) {
    if (message) denyVehicleLease(client, message, 'not-owner');
    return false;
  }
  if (message && (
    Number(message.vehicleId) !== lease.vehicleId
    || message.token !== lease.token
    || Number(message.revision) !== lease.revision
  )) {
    denyVehicleLease(client, message, 'stale-release', lease.revision);
    return false;
  }
  if (vehicleLeases.get(lease.vehicleId) !== lease || lease.ownerId !== id) {
    client.vehicleLease = null;
    if (message) denyVehicleLease(client, message, 'not-owner');
    return false;
  }
  vehicleLeases.delete(lease.vehicleId);
  client.vehicleLease = null;
  const revision = nextVehicleLeaseRevision;
  nextVehicleLeaseRevision += 1;
  broadcast(vehicleLeaseMessage(lease, 'released', {
    revision,
    previousRevision: lease.revision,
    reason,
  }));
  return true;
}

function safeSend(ws, payload) {
  if (ws?.readyState === 1) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // A socket can close between the readyState check and the write.
    }
  }
}

function acceptCoopMotion(client, state, motion, now = Date.now()) {
  const previous = client.coopState;
  if (!previous) return false;
  if (state.mode === 'drive') {
    client.coopState = { x: previous.x, z: previous.z, mode: 'drive', at: now };
    client.coopExit = null;
    return false;
  }
  if (state.mode !== previous.mode) {
    if (previous.mode === 'drive' && state.mode === 'walk') {
      client.coopState = { x: previous.x, z: previous.z, mode: 'walk', at: now };
      return true;
    }
    if (previous.mode === 'walk' && state.mode === 'interior') {
      const portal = COOP_STEPS
        .filter((step) => step.kind === 'portal')
        .map((step) => ({ step, distance: Math.hypot(previous.x - step.x, previous.z - step.z) }))
        .filter(({ step, distance }) => distance <= step.radius)
        .sort((a, b) => a.distance - b.distance)[0]?.step;
      if (!portal) return false;
      client.coopState = { x: portal.enterX, z: portal.enterZ, mode: 'interior', at: now };
      client.coopExit = { x: portal.x, z: portal.z, radius: portal.radius };
      return true;
    }
    const exit = client.coopExit;
    if (previous.mode !== 'interior'
      || state.mode !== 'walk'
      || !exit) return false;
    client.coopExit = null;
    client.coopState = { x: exit.x, z: exit.z, mode: 'walk', at: now };
    return true;
  }
  const elapsed = Math.min(0.2, Math.max(0, (now - previous.at) / 1000));
  const inputX = boundedNumber(motion?.x, -1, 1);
  const inputZ = boundedNumber(motion?.z, -1, 1);
  const inputLength = Math.hypot(inputX, inputZ);
  const scale = inputLength > 1 ? 1 / inputLength : 1;
  const speed = motion?.sprint === true ? 9.5 : 5.6;
  client.coopState = {
    x: previous.x + inputX * scale * speed * elapsed,
    z: previous.z + inputZ * scale * speed * elapsed,
    mode: state.mode,
    at: now,
  };
  return true;
}

function coopSnapshot(session) {
  if (!session) return null;
  const complete = session.completedSteps === COOP_STEPS.length;
  return {
    sessionId: session.id,
    revision: session.revision,
    status: complete ? 'complete' : 'running',
    leaderId: session.members[0] || null,
    members: [...session.members],
    steps: COOP_STEPS.map((step) => step.id),
    completedSteps: session.completedSteps,
    currentStepId: complete ? null : COOP_STEPS[session.completedSteps].id,
    completionRevision: complete ? session.revision : null,
    cashReward: complete ? COOP_CASH_REWARD : 0,
  };
}

function sendCoopSnapshot(session) {
  const snapshot = coopSnapshot(session);
  for (const memberId of session?.members || []) {
    safeSend(clients.get(memberId)?.ws, { type: 'coop:state', session: snapshot });
  }
}

function endCoopSession(reason = 'ended') {
  const session = activeCoopSession;
  if (!session) return;
  activeCoopSession = null;
  const revision = nextCoopRevision;
  nextCoopRevision += 1;
  for (const memberId of session.members) {
    safeSend(clients.get(memberId)?.ws, {
      type: 'coop:state',
      session: null,
      sessionId: session.id,
      revision,
      reason,
    });
  }
}

function validateCoopStep(client, message, expected) {
  const context = message.context;
  const pose = client.coopState;
  const expectedMode = expected?.kind === 'hotspot' ? 'interior' : 'walk';
  if (!expected
    || !pose
    || Date.now() - pose.at > 750
    || pose.mode !== expectedMode
    || !context
    || typeof context !== 'object') {
    return false;
  }
  if (context.kind !== expected.kind) return false;
  if (expected.kind === 'portal'
    && (!String(context.id || '').trim() || String(context.label || '') !== expected.label)) return false;
  if (expected.kind === 'hotspot'
    && (String(context.id || '') !== expected.id || context.enabled !== true)) return false;
  return Math.hypot(pose.x - expected.x, pose.z - expected.z) <= expected.radius;
}

function handleCoopAdvance(id, client, message) {
  const requestId = String(message.requestId || '').trim().slice(0, 64);
  const stepId = String(message.stepId || '').trim();
  const stepIndex = Number(message.stepIndex);
  if (!requestId || requestId === client.lastCoopRequestId
    || !Number.isInteger(stepIndex)
    || stepIndex < 0
    || stepIndex >= COOP_STEPS.length
    || COOP_STEPS[stepIndex].id !== stepId) return;
  client.lastCoopRequestId = requestId;
  const now = Date.now();
  if (activeCoopSession && now - activeCoopSession.updatedAt > COOP_SESSION_TTL_MS) {
    endCoopSession('expired');
  }
  let session = activeCoopSession;
  if (!session) {
    if (stepIndex !== 0 || !validateCoopStep(client, message, COOP_STEPS[0])) return;
    session = {
      id: `waterfront-${nextCoopSessionId}`,
      revision: nextCoopRevision,
      members: [id],
      completedSteps: 0,
      updatedAt: now,
    };
    nextCoopSessionId += 1;
    nextCoopRevision += 1;
    activeCoopSession = session;
  } else if (!session.members.includes(id)) {
    if (session.members.length >= 2
      || session.completedSteps !== 1
      || stepIndex !== COOP_JOIN_STEP_INDEX
      || !validateCoopStep(client, message, COOP_STEPS[COOP_JOIN_STEP_INDEX])) return;
    session.members.push(id);
    session.revision = nextCoopRevision;
    session.updatedAt = now;
    nextCoopRevision += 1;
    client.coopState = {
      x: COOP_STEPS[0].enterX,
      z: COOP_STEPS[0].enterZ,
      mode: 'interior',
      at: now,
    };
    client.coopExit = {
      x: COOP_STEPS[0].x,
      z: COOP_STEPS[0].z,
      radius: COOP_STEPS[0].radius,
    };
    sendCoopSnapshot(session);
    return;
  }
  if (session.completedSteps !== stepIndex
    || session.status === 'complete'
    || !validateCoopStep(client, message, COOP_STEPS[stepIndex])) return;
  session.completedSteps += 1;
  if (COOP_STEPS[stepIndex].kind === 'portal') {
    const portal = COOP_STEPS[stepIndex];
    client.coopState = {
      x: portal.enterX,
      z: portal.enterZ,
      mode: 'interior',
      at: now,
    };
    client.coopExit = { x: portal.x, z: portal.z, radius: portal.radius };
  }
  session.revision = nextCoopRevision;
  session.updatedAt = now;
  nextCoopRevision += 1;
  sendCoopSnapshot(session);
}

function roster() {
  return [...clients.entries()].map(([id, client]) => ({
    id,
    name: client.name,
    color: client.color,
  }));
}

function broadcast(payload, exceptId = null) {
  for (const [id, client] of clients) {
    if (id === exceptId) continue;
    safeSend(client.ws, payload);
  }
}

wss.on('connection', (ws) => {
  const id = `peer-${nextId}`;
  nextId += 1;
  clients.set(id, {
    ws,
    name: 'Traveler',
    color: 0,
    lastStateAt: 0,
    lastGameplayEventId: null,
    lastGameplayEventAt: 0,
    lastMissionRevision: 0,
    lastMission: null,
    lastState: null,
    lastCoopRequestId: null,
    vehicleLease: null,
    coopState: { x: 28, z: 38, mode: 'walk', at: Date.now() },
    coopExit: null,
  });

  safeSend(ws, {
    type: 'welcome',
    id,
    name: clients.get(id).name,
    peers: roster().filter((peer) => peer.id !== id),
    vehicleLeases: [...vehicleLeases.values()].map((lease) => vehicleLeaseMessage(lease)),
  });
  broadcast({ type: 'peer:join', peer: { id, name: clients.get(id).name, color: clients.get(id).color } }, id);
  broadcast({ type: 'roster', peers: roster() }, id);

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const client = clients.get(id);
    if (!client) return;
    if (message.type === 'join' || message.type === 'rename') {
      client.name = String(message.name || 'Traveler').trim().slice(0, 18) || 'Traveler';
      client.color = Number.isFinite(message.color) ? message.color : 0;
      broadcast({ type: 'roster', peers: roster() }, id);
      return;
    }
    if (message.type === 'state') {
      const now = Date.now();
      if (now - client.lastStateAt < STATE_MIN_INTERVAL_MS) return;
      client.lastStateAt = now;
      const sanitized = sanitizeState(message, client);
      client.lastState = sanitized;
      acceptCoopMotion(client, sanitized, message.coopMotion, now);
      broadcast({ ...sanitized, from: id }, id);
      return;
    }
    if (message.type === 'vehicle:claim') {
      claimVehicleLease(id, client, message);
      return;
    }
    if (message.type === 'vehicle:release') {
      releaseVehicleLease(
        id,
        client,
        message,
        String(message.reason || 'released').trim().slice(0, 32) || 'released',
      );
      return;
    }
    if (message.type === 'coop:advance') {
      handleCoopAdvance(id, client, message);
      return;
    }
    if (message.type === 'coop:leave') {
      if (activeCoopSession?.members.includes(id)) endCoopSession('left');
      return;
    }
    if (message.type === 'chat') {
      broadcast(
        { type: 'chat', from: id, name: client.name, text: String(message.text || '').slice(0, 180) },
        id,
      );
      return;
    }
    if (message.type === 'rtc' && message.to) {
      const target = clients.get(message.to);
      if (!target) return;
      safeSend(target.ws, { type: 'rtc', from: id, data: message.data });
    }
  });

  ws.on('close', () => {
    if (activeCoopSession?.members.includes(id)) endCoopSession('disconnected');
    releaseVehicleLease(id, clients.get(id), null, 'disconnected');
    clients.delete(id);
    broadcast({ type: 'peer:leave', id });
  });
  ws.on('error', () => {
    if (activeCoopSession?.members.includes(id)) endCoopSession('disconnected');
    releaseVehicleLease(id, clients.get(id), null, 'disconnected');
    clients.delete(id);
    broadcast({ type: 'peer:leave', id });
  });
});

const coopExpiryTimer = setInterval(() => {
  if (activeCoopSession
    && Date.now() - activeCoopSession.updatedAt > COOP_SESSION_TTL_MS) {
    endCoopSession('expired');
  }
}, Math.min(1000, Math.max(100, COOP_SESSION_TTL_MS / 4)));
coopExpiryTimer.unref?.();

const vehicleLeaseExpiryTimer = setInterval(() => {
  const now = Date.now();
  for (const lease of vehicleLeases.values()) {
    const baseline = lease.active ? lease.lastHeartbeatAt : lease.grantedAt;
    const ttl = lease.active ? VEHICLE_LEASE_ACTIVE_TTL_MS : VEHICLE_LEASE_CLAIM_GRACE_MS;
    if (!Number.isFinite(baseline) || now - baseline <= ttl) continue;
    releaseVehicleLease(lease.ownerId, clients.get(lease.ownerId), null, 'expired');
  }
}, 500);
vehicleLeaseExpiryTimer.unref?.();

console.log(`San Francisco multiplayer relay listening on ws://${HOST}:${PORT}`);
