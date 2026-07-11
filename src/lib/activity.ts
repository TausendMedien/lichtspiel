// Tiny activity pub-sub: lets a control-write choke point (wrapWithPersist) notify
// App.svelte-level "the user is interacting" logic (poke() / demo dwell reset)
// without coupling persist.ts to App.svelte specifics.

type Listener = () => void;
const listeners = new Set<Listener>();

export function notifyActivity(): void {
  for (const l of listeners) l();
}

export function onActivity(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
