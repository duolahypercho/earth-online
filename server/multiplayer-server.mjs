import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const wss = new WebSocketServer({ port: PORT, host: HOST });
const clients = new Map();
let nextId = 1;
const STATE_MIN_INTERVAL_MS = 35;
const GAMEPLAY_EVENT_MIN_INTERVAL_MS = 400;
const GAMEPLAY_ACTIVITIES = new Set([
  'idle', 'walking', 'driving', 'aiming', 'wanted', 'pursuit', 'working', 'downed',
]);
const GAMEPLAY_HEALTH_BANDS = new Set(['healthy', 'injured', 'critical', 'downed']);
const MISSION_STATUSES = new Set(['running', 'complete', 'failed']);
const GAMEPLAY_EVENT_KINDS = new Set([
  'arrested', 'critical', 'escaped', 'high-heat', 'near-miss', 'pedestrian-impact',
  'pursuit-start', 'responder-contact', 'traffic-violation', 'vehicle-theft',
  'witness-dispatch', 'witness-report',
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
  const mode = message.mode === 'drive' ? 'drive' : 'walk';
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
    vehicleId: Number.isInteger(message.vehicleId)
      ? boundedInteger(message.vehicleId, 0, 100000)
      : null,
    vehicleClass: String(message.vehicleClass || '').trim().slice(0, 24) || null,
    vehicleColor: Number.isFinite(message.vehicleColor)
      ? boundedInteger(message.vehicleColor, 0, 0xffffff)
      : null,
    gameplay: sanitizeGameplay(message.gameplay, client),
    mission: sanitizeMission(message.mission, client),
  };
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
  });

  safeSend(ws, { type: 'welcome', id, name: clients.get(id).name, peers: roster().filter((peer) => peer.id !== id) });
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
      broadcast({ ...sanitizeState(message, client), from: id }, id);
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
    clients.delete(id);
    broadcast({ type: 'peer:leave', id });
  });
  ws.on('error', () => {
    clients.delete(id);
    broadcast({ type: 'peer:leave', id });
  });
});

console.log(`San Francisco multiplayer relay listening on ws://${HOST}:${PORT}`);
