// Leaf module: the throttled param-update sender used both by the pattern-control
// broadcast wrapper (patterns/index.ts) and by sync.svelte.ts's global-field watchers.
// Deliberately has no dependency on ../patterns to avoid an import cycle
// (patterns/index.ts -> remote/broadcastWrap.ts -> here).

import { remoteConn, send } from './connection.svelte';
import { SLIDER_THROTTLE_MS } from './protocol';

export type ParamValue = number | string | boolean;

// Suppressed while applying an incoming snapshot so the resulting local state
// writes don't loop back out as outgoing param-updates.
let suppressed = false;
export function setSuppressed(v: boolean): void { suppressed = v; }

function isBroadcasting(): boolean {
  return remoteConn.role === 'remote' && remoteConn.status === 'connected' && !suppressed;
}

const throttleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, ParamValue>();

export function sendThrottled(param: string, value: ParamValue): void {
  if (!isBroadcasting()) return;
  pendingValues.set(param, value);
  if (throttleTimers.has(param)) return; // a send is already scheduled — it will pick up the latest value
  const timer = setTimeout(() => {
    throttleTimers.delete(param);
    const v = pendingValues.get(param);
    pendingValues.delete(param);
    if (v !== undefined) send({ type: 'param-update', param, value: v });
  }, SLIDER_THROTTLE_MS);
  throttleTimers.set(param, timer);
}
