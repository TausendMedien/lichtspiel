import type { Pattern } from './patterns/types';

interface SharePayload {
  p: string;
  c: Record<string, number | boolean | string>;
}

export function encodeShare(pattern: Pattern): void {
  const c: Record<string, number | boolean | string> = {};
  for (const ctrl of pattern.controls ?? []) {
    if (ctrl.type === 'button' || ctrl.type === 'separator') continue;
    c[ctrl.label] = ctrl.get();
  }
  const payload: SharePayload = { p: pattern.id, c };
  const hash = btoa(JSON.stringify(payload));
  history.replaceState(null, '', `#s=${hash}`);
}

export interface ShareResult {
  patternId: string;
  controls: Record<string, number | boolean | string>;
}

export function decodeShare(): ShareResult | null {
  try {
    const hash = location.hash;
    if (!hash.startsWith('#s=')) return null;
    const raw = atob(hash.slice(3));
    const payload = JSON.parse(raw) as SharePayload;
    if (typeof payload.p !== 'string' || typeof payload.c !== 'object') return null;
    return { patternId: payload.p, controls: payload.c };
  } catch {
    return null;
  }
}

export function clearShare(): void {
  history.replaceState(null, '', location.pathname + location.search);
}
