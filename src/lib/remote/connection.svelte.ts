// Role-agnostic WebSocket client for the Display/Remote relay. Handles reconnect
// with exponential backoff and exposes reactive connection status.

import { DEFAULT_RELAY_URL, parseMessage, type RemoteMessage, type Role } from './protocol';

export const REMOTE_MODE_KEY = 'pp:remote-mode';
export const REMOTE_URL_KEY = 'pp:remote-url';

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export const remoteConn = $state({
  status: 'idle' as ConnStatus,
  role: null as Role | null,
  room: '',
  url: '',
  displayCount: 0,
  remoteCount: 0,
  errorMessage: '',
});

export function loadRelayUrl(): string {
  try { return localStorage.getItem(REMOTE_URL_KEY) || DEFAULT_RELAY_URL; } catch { return DEFAULT_RELAY_URL; }
}

export function saveRelayUrl(url: string): void {
  try { localStorage.setItem(REMOTE_URL_KEY, url); } catch {}
}

/** Mixed-content guard: an https page can't open ws:// (only wss://), except localhost
 *  in some browsers — and Safari blocks even that. Surface a clear error instead of a
 *  silent connection failure. */
export function checkMixedContent(url: string): string | null {
  if (typeof location === 'undefined') return null;
  if (location.protocol !== 'https:') return null;
  if (!url.startsWith('ws://')) return null;
  const isLocalhost = /^ws:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
  if (isLocalhost) return null;
  return 'This page is loaded over HTTPS — it cannot connect to an insecure ws:// server (browser blocks mixed content). Use a wss:// relay, or open the app itself over http:// on the local network.';
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let intentionalDisconnect = false;

function backoffMs(attempt: number): number {
  const base = Math.min(15000, 1000 * 2 ** attempt);
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return Math.max(500, base + jitter);
}

function scheduleReconnect(url: string, room: string, role: Role, onMessage: (m: RemoteMessage) => void) {
  if (intentionalDisconnect) return;
  remoteConn.status = 'reconnecting';
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = backoffMs(reconnectAttempt++);
  reconnectTimer = setTimeout(() => openSocket(url, room, role, onMessage), delay);
}

function openSocket(url: string, room: string, role: Role, onMessage: (m: RemoteMessage) => void) {
  const mixedContentError = checkMixedContent(url);
  if (mixedContentError) {
    remoteConn.status = 'error';
    remoteConn.errorMessage = mixedContentError;
    return;
  }
  remoteConn.status = reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
  remoteConn.errorMessage = '';
  try {
    ws = new WebSocket(url);
  } catch {
    remoteConn.status = 'error';
    remoteConn.errorMessage = 'Could not open a connection to the relay.';
    return;
  }

  ws.onopen = () => {
    reconnectAttempt = 0;
    remoteConn.status = 'connected';
    ws?.send(JSON.stringify({ type: 'join', room, role }));
    if (role === 'remote') {
      // Re-sync in case a param changed on the display while we were disconnected.
      ws?.send(JSON.stringify({ type: 'snapshot-request' }));
    }
  };

  ws.onmessage = (ev) => {
    const msg = parseMessage(typeof ev.data === 'string' ? ev.data : '');
    if (!msg) return;
    if (msg.type === 'peer-status') {
      remoteConn.displayCount = msg.displayCount;
      remoteConn.remoteCount = msg.remoteCount;
    }
    if (msg.type === 'error') {
      remoteConn.status = 'error';
      remoteConn.errorMessage = msg.code === 'room-not-found' ? 'Room not found — check the code.' : 'Relay rejected a message.';
      if (msg.code === 'room-not-found') { intentionalDisconnect = true; ws?.close(); return; }
    }
    onMessage(msg);
  };

  ws.onclose = () => {
    if (remoteConn.status !== 'error') scheduleReconnect(url, room, role, onMessage);
  };

  ws.onerror = () => {
    // onclose fires right after; reconnect scheduling happens there.
  };
}

export function connect(url: string, room: string, role: Role, onMessage: (m: RemoteMessage) => void): void {
  disconnect();
  intentionalDisconnect = false;
  reconnectAttempt = 0;
  remoteConn.role = role;
  remoteConn.room = room;
  remoteConn.url = url;
  openSocket(url, room, role, onMessage);
}

export function send(msg: RemoteMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function disconnect(): void {
  intentionalDisconnect = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
  remoteConn.status = 'idle';
  remoteConn.role = null;
  remoteConn.room = '';
  remoteConn.displayCount = 0;
  remoteConn.remoteCount = 0;
  remoteConn.errorMessage = '';
}
