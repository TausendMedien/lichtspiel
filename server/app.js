// Lichtspiel remote-control relay — Bun-native and Node/Passenger-compatible.
//
// Plain stateless WebSocket relay with room codes. The relay's only state is,
// per room, who is connected and which display is "primary" (first display to
// join; promotes to the longest-connected remaining display on disconnect).
//
// Message shapes mirror src/lib/remote/protocol.ts (the TS schema source of
// truth) — kept in sync by hand since Node/Passenger can't load TS directly.
//
// Start: `node server/app.js` or `bun server/app.js`. Port from process.env.PORT
// (Passenger sets this), falls back to 3000 locally.

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 3000;
const GRACE_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const ROOM_CODE_RE = /^[A-Z0-9]{4}$/;

/** @typedef {{ ws: import('ws').WebSocket, role: 'display'|'remote', joinedAt: number, isAlive: boolean }} Peer */
/** @typedef {{ displays: Peer[], remotes: Peer[], pendingSnapshots: Map<string, import('ws').WebSocket>, emptyTimer: ReturnType<typeof setTimeout>|null }} Room */

/** @type {Map<string, Room>} */
const rooms = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { displays: [], remotes: [], pendingSnapshots: new Map(), emptyTimer: null };
    rooms.set(code, room);
  } else if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
  return room;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastPeerStatus(room) {
  const msg = { type: 'peer-status', displayCount: room.displays.length, remoteCount: room.remotes.length };
  for (const p of [...room.displays, ...room.remotes]) send(p.ws, msg);
}

function primaryOf(room) {
  return room.displays[0] ?? null;
}

function requestSnapshotFor(room, code, joinerWs) {
  const primary = primaryOf(room);
  if (!primary) return;
  const reqId = Math.random().toString(36).slice(2);
  room.pendingSnapshots.set(reqId, joinerWs);
  send(primary.ws, { type: 'snapshot-request', reqId });
}

function scheduleEmptyDeletion(room, code) {
  if (room.displays.length > 0 || room.remotes.length > 0) return;
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    rooms.delete(code);
    log('room expired', code);
  }, GRACE_MS);
}

function removePeer(room, code, ws) {
  const wasPrimary = primaryOf(room)?.ws === ws;
  room.displays = room.displays.filter(p => p.ws !== ws);
  room.remotes = room.remotes.filter(p => p.ws !== ws);
  for (const [reqId, pendingWs] of room.pendingSnapshots) {
    if (pendingWs === ws) room.pendingSnapshots.delete(reqId);
  }
  if (wasPrimary && room.displays.length > 0) {
    log('room', code, 'primary promoted ->', room.displays[0].joinedAt);
  }
  broadcastPeerStatus(room);
  scheduleEmptyDeletion(room, code);
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('lichtspiel relay');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  /** @type {{ code: string, role: 'display'|'remote' } | null} */
  let joined = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { send(ws, { type: 'error', code: 'bad-message' }); return; }
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') {
      send(ws, { type: 'error', code: 'bad-message' });
      return;
    }

    if (msg.type === 'join') {
      if (joined) return; // already joined, ignore duplicate join
      const code = typeof msg.room === 'string' ? msg.room.trim().toUpperCase() : '';
      const role = msg.role;
      if (!ROOM_CODE_RE.test(code) || (role !== 'display' && role !== 'remote')) {
        send(ws, { type: 'error', code: 'bad-message' });
        return;
      }
      if (role === 'remote' && !rooms.has(code)) {
        send(ws, { type: 'error', code: 'room-not-found' });
        return;
      }
      const room = getOrCreateRoom(code);
      const peer = { ws, role, joinedAt: Date.now(), isAlive: true };
      if (role === 'display') room.displays.push(peer);
      else room.remotes.push(peer);
      joined = { code, role };
      log('join', code, role, `(displays=${room.displays.length} remotes=${room.remotes.length})`);
      broadcastPeerStatus(room);
      const primary = primaryOf(room);
      if (primary && primary.ws !== ws) requestSnapshotFor(room, code, ws);
      return;
    }

    if (!joined) return; // must join before anything else
    const room = rooms.get(joined.code);
    if (!room) return;

    switch (msg.type) {
      case 'param-update': {
        if (typeof msg.param !== 'string') return;
        const v = msg.value;
        if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') return;
        const out = { type: 'param-update', param: msg.param, value: v };
        for (const p of room.displays) send(p.ws, out);
        break;
      }
      case 'state-snapshot': {
        if (typeof msg.params !== 'object' || msg.params === null) return;
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : undefined;
        if (reqId && room.pendingSnapshots.has(reqId)) {
          const target = room.pendingSnapshots.get(reqId);
          room.pendingSnapshots.delete(reqId);
          send(target, { type: 'state-snapshot', params: msg.params });
        } else {
          for (const p of room.remotes) send(p.ws, { type: 'state-snapshot', params: msg.params });
        }
        break;
      }
      case 'snapshot-request': {
        // Client-initiated refresh (e.g. remote resyncing after reconnect).
        requestSnapshotFor(room, joined.code, ws);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!joined) return;
    const room = rooms.get(joined.code);
    if (!room) return;
    removePeer(room, joined.code, ws);
    log('leave', joined.code, joined.role, `(displays=${room.displays.length} remotes=${room.remotes.length})`);
  });
});

// Heartbeat — terminate connections that stop responding to pings.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  log(`lichtspiel relay listening on :${PORT}`);
});
