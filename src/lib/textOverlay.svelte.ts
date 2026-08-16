// Text overlay — 3D typography drawn on top of whichever pattern is running.
//
// The "3D Typography" pattern shows text *instead of* a pattern. This is the same
// text laid over one, so a title can sit on a projection without giving up the
// visual behind it. It survives pattern switches and Demo because the renderer
// owns it rather than any pattern.
//
// Settings are global rather than per-pattern (like Motion's Sensitivity and the
// Push settings), so the text stays put as patterns change under it.

const KEY = 'lichtspiel-overlay';

export const OVERLAY_DEFAULTS = {
  enabled:     false,
  /** Newlines are real "\n" — the panel renders a textarea for this. */
  text:        'LICHTSPIEL',
  size:        0.6,
  depth:       0.3,
  /** 0 = Solid, 1 = Wireframe, 2 = Neon */
  style:       0,
  /** 0 = left, 1 = center, 2 = right */
  align:       1,
  /** Gap between baselines as a multiple of size. */
  lineSpacing: 1.3,
  /** Screen position, -1..1 from the centre. */
  posX:        0,
  posY:        0,
  opacity:     1,
  /** Radians per second about Y. 0 holds the text facing front. */
  spin:        0,

  // ── Show / hide cycle ──────────────────────────────────────────────────────
  /** Off by default: the text simply stays up while enabled. */
  cycle:       false,
  /** Seconds visible, then seconds hidden, repeating. */
  showFor:     10,
  hideFor:     120,
} as const;

function load() {
  const d = { ...OVERLAY_DEFAULTS } as Record<string, number | boolean | string>;
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

export const overlayState = $state(
  typeof localStorage !== 'undefined' ? load() : { ...OVERLAY_DEFAULTS }
) as {
  enabled: boolean; text: string; size: number; depth: number; style: number;
  align: number; lineSpacing: number; posX: number; posY: number; opacity: number;
  spin: number; cycle: boolean; showFor: number; hideFor: number;
};

export function saveOverlaySettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...overlayState })); } catch {}
}
