// Push — a sensor mode of its own, alongside Motion, Heat and Audio.
//
// Heat displaces a pattern by the motion map and snaps back the moment you stop.
// Push instead treats you as a solid object moving through the picture: what you
// sweep through is cleared out and only slowly fills in again. It rides on the same
// camera stream as Heat but is independent of it — either, both, or neither can run.
//
// The settings are global rather than per-pattern (like Motion's Sensitivity), so
// the feel of the interaction stays the same as patterns change under it.

const KEY = 'lichtspiel-push';

export const PUSH_DEFAULTS = {
  enabled:     false,
  /** How solid your body is. 1 = one sweep clears what you cover, out to the edge
   *  of your silhouette. Higher throws it further; 0 leaves only the soft shove. */
  solidity:    1.0,
  /** Soft cumulative shove from your outline, on top of Solidity. */
  strength:    1.2,
  /** How fast the cleared area fills back in, per second. */
  returnSpeed: 0.35,
  /** Lateral diffusion — the gap's edge melts as neighbours roll in from the sides. */
  spread:      0.4,
  /** How much movement counts as your body. Higher = subtler motion registers. */
  sensitivity: 11,
} as const;

function load() {
  const d = { ...PUSH_DEFAULTS } as Record<string, number | boolean>;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = JSON.parse(raw);
    for (const k of Object.keys(d)) {
      const want = typeof d[k];
      if (typeof p?.[k] === want) d[k] = p[k];
    }
  } catch {}
  return d;
}

export const pushState = $state(
  typeof localStorage !== 'undefined' ? load() : { ...PUSH_DEFAULTS }
) as { enabled: boolean; solidity: number; strength: number; returnSpeed: number; spread: number; sensitivity: number };

export function savePushSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...pushState })); } catch {}
}
