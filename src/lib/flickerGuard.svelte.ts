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
const NOTICE_KEY  = 'pp:flickerGuardNotice';

function loadFlag(key: string): boolean {
  try { return localStorage.getItem(key) !== 'false'; } catch { return true; }
}

export const flickerGuard = $state({
  enabled: loadFlag(STORAGE_KEY), // default true (only the string 'false' disables)
  /** Whether the on-screen "guard active" badge is shown. The guard itself keeps
   *  working either way — during a performance the text in the projection is
   *  unwanted, but the protection must never be silently tied to it. */
  showNotice: loadFlag(NOTICE_KEY),
});

export function saveFlickerGuard(): void {
  try { localStorage.setItem(STORAGE_KEY, String(flickerGuard.enabled)); } catch {}
}

export function saveFlickerGuardNotice(): void {
  try { localStorage.setItem(NOTICE_KEY, String(flickerGuard.showNotice)); } catch {}
}
