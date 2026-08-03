import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const wss = new WebSocketServer({ port: PORT, host: HOST });
const clients = new Map();
let nextId = 1;

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
  clients.set(id, { ws, name: 'Traveler', color: 0 });

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
    const client = clients.get(id);
    if (!client) return;
    if (message.type === 'join' || message.type === 'rename') {
      client.name = String(message.name || 'Traveler').trim().slice(0, 18) || 'Traveler';
      client.color = Number.isFinite(message.color) ? message.color : 0;
      broadcast({ type: 'roster', peers: roster() }, id);
      return;
    }
    if (message.type === 'state') {
      broadcast({ ...message, from: id, name: client.name, color: client.color }, id);
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
