// Shared message protocol for the Display/Remote WebSocket relay.
// This file is the schema source of truth — server/app.js re-implements the same
// shapes in plain JS (Node/Passenger can't load TS) and must be kept in sync by hand.

export type Role = 'display' | 'remote';

export interface JoinMessage {
  type: 'join';
  room: string;
  role: Role;
}

export interface ParamUpdateMessage {
  type: 'param-update';
  param: string; // "ctrl:<label>" | "global:<key>" | "app:pattern" | "app:preset"
  value: number | string | boolean;
}

export interface SnapshotRequestMessage {
  type: 'snapshot-request';
  /** Stamped by the relay when it forwards this to the primary display so the reply
   *  can be routed back to the one peer that asked for it. Absent on a raw client
   *  refresh request (relay stamps one before forwarding either way). */
  reqId?: string;
}

export interface StateSnapshotMessage {
  type: 'state-snapshot';
  reqId?: string;
  params: Record<string, number | string | boolean>;
}

export interface PeerStatusMessage {
  type: 'peer-status';
  displayCount: number;
  remoteCount: number;
}

export interface ErrorMessage {
  type: 'error';
  code: 'room-not-found' | 'bad-message';
}

export type RemoteMessage =
  | JoinMessage
  | ParamUpdateMessage
  | SnapshotRequestMessage
  | StateSnapshotMessage
  | PeerStatusMessage
  | ErrorMessage;

export const DEFAULT_RELAY_URL = 'wss://relay.1000lights.de';
export const SLIDER_THROTTLE_MS = 100;

// Room codes: 4 chars, no 0/O/1/I (easy to read aloud / type on a phone keyboard).
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_RE = /^[A-Z0-9]{4}$/;

export function generateRoomCode(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
  let code = '';
  for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length];
  return code;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_RE.test(code);
}

export function parseMessage(raw: string): RemoteMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || !('type' in obj)) return null;
  const m = obj as { type: unknown };
  switch (m.type) {
    case 'join': {
      const j = obj as Partial<JoinMessage>;
      if (typeof j.room !== 'string' || (j.role !== 'display' && j.role !== 'remote')) return null;
      return { type: 'join', room: j.room, role: j.role };
    }
    case 'param-update': {
      const p = obj as Partial<ParamUpdateMessage>;
      if (typeof p.param !== 'string') return null;
      if (typeof p.value !== 'number' && typeof p.value !== 'string' && typeof p.value !== 'boolean') return null;
      return { type: 'param-update', param: p.param, value: p.value };
    }
    case 'snapshot-request': {
      const s = obj as Partial<SnapshotRequestMessage>;
      return { type: 'snapshot-request', reqId: typeof s.reqId === 'string' ? s.reqId : undefined };
    }
    case 'state-snapshot': {
      const s = obj as Partial<StateSnapshotMessage>;
      if (typeof s.params !== 'object' || s.params === null) return null;
      return { type: 'state-snapshot', reqId: typeof s.reqId === 'string' ? s.reqId : undefined, params: s.params as Record<string, number | string | boolean> };
    }
    case 'peer-status': {
      const p = obj as Partial<PeerStatusMessage>;
      if (typeof p.displayCount !== 'number' || typeof p.remoteCount !== 'number') return null;
      return { type: 'peer-status', displayCount: p.displayCount, remoteCount: p.remoteCount };
    }
    case 'error': {
      const e = obj as Partial<ErrorMessage>;
      if (e.code !== 'room-not-found' && e.code !== 'bad-message') return null;
      return { type: 'error', code: e.code };
    }
    default:
      return null;
  }
}
