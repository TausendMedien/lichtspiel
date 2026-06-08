// Runtime photosensitivity guard (ITU-R BT.1702 / Harding-inspired) — UI state.
//
// The actual detection + damping lives in the renderer; this store only holds the
// reactive on/off flag for the Options UI. App.svelte pushes `enabled` into the
// renderer via handle.setFlickerGuard() so the render loop never depends on a
// shared module instance.
//
// `enabled` defaults ON and persists in localStorage. Turning it off is gated
// behind a safety-warning confirmation (see App.svelte).

const STORAGE_KEY = 'pp:flickerGuard';

function loadEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== 'false'; } catch { return true; }
}

export const flickerGuard = $state({
  enabled: loadEnabled(), // default true (only the string 'false' disables)
});

export function saveFlickerGuard(): void {
  try { localStorage.setItem(STORAGE_KEY, String(flickerGuard.enabled)); } catch {}
}
