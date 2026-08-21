// Watermark — a still image laid over whichever pattern is running.
//
// Rendered in the same overlay pass as the text (see renderer.ts), so it is neither
// colour-graded nor damped by the flicker guard, and it lands in screenshots,
// recordings and anything fed from the canvas — unlike a DOM overlay, which would
// be invisible in all of those.
//
// Settings are global rather than per-pattern, like the text overlay's, so a logo
// stays where you put it as patterns change under it.

const KEY = 'lichtspiel-watermark';

/** Corner the image is pinned to. Index into ANCHOR_OPTIONS. */
export const ANCHOR_OPTIONS = [
  'top left', 'top right', 'bottom left', 'bottom right', 'centre',
] as const;

export const WATERMARK_DEFAULTS = {
  enabled: false,
  /** Width as a fraction of the visible width. */
  scale:   0.18,
  /** Inset from the pinned corner, as a fraction of the visible half-height. */
  margin:  0.06,
  opacity: 0.8,
  /** Index into ANCHOR_OPTIONS. */
  anchor:  3,
} as const;

/**
 * The image itself, kept out of WATERMARK_DEFAULTS because the typeof-based load
 * guard below can't vet them meaningfully.
 *  - dataUrl: a PNG data URL, already downscaled on upload (see watermarkTexture.ts)
 *  - aspect:  width / height, captured at upload so the renderer never has to
 *             decode the image just to learn its shape
 */
const IMAGE_DEFAULTS = { dataUrl: null as string | null, aspect: 1 };

function load() {
  const d = { ...WATERMARK_DEFAULTS, ...IMAGE_DEFAULTS } as Record<string, unknown>;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = JSON.parse(raw);
    for (const k of Object.keys(WATERMARK_DEFAULTS)) {
      const want = typeof (WATERMARK_DEFAULTS as Record<string, unknown>)[k];
      if (typeof p?.[k] === want) d[k] = p[k];
    }
    if (typeof p?.dataUrl === 'string' && p.dataUrl.startsWith('data:image/')) d.dataUrl = p.dataUrl;
    if (typeof p?.aspect === 'number' && isFinite(p.aspect) && p.aspect > 0) d.aspect = p.aspect;
  } catch {}
  return d;
}

export const watermarkState = $state(
  typeof localStorage !== 'undefined' ? load() : { ...WATERMARK_DEFAULTS, ...IMAGE_DEFAULTS }
) as {
  enabled: boolean; scale: number; margin: number; opacity: number; anchor: number;
  dataUrl: string | null; aspect: number;
};

export function saveWatermarkSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...watermarkState })); } catch {}
}
