import type { Pattern } from './patterns/types';

// Re-read pp: keys and push values into controls.
// Call this AFTER loadSettings so individual keys (updated more
// frequently) can override a stale settings blob.
export function restoreFromKeys(patterns: Pattern[]): void {
  for (const pattern of patterns) {
    for (const ctrl of pattern.controls ?? []) {
      if (ctrl.type === 'button') continue;
      const key = `pp:${pattern.id}:${ctrl.label}`;
      const raw = localStorage.getItem(key);
      if (raw !== null) ctrl.set(parseFloat(raw));
    }
  }
}

export function wrapWithPersist(pattern: Pattern): Pattern {
  const controls = pattern.controls?.map(ctrl => {
    if (ctrl.type === 'button') return ctrl;
    const key = `pp:${pattern.id}:${ctrl.label}`;
    return {
      ...ctrl,
      set(v: number) {
        ctrl.set(v);
        localStorage.setItem(key, String(v));
      },
    };
  });

  // Restore saved values immediately. Three.js objects are null here so any
  // side-effectful set (e.g. tunnel's buildRings) will early-return safely.
  controls?.forEach(ctrl => {
    if (ctrl.type === 'button') return;
    const key = `pp:${pattern.id}:${ctrl.label}`;
    const raw = localStorage.getItem(key);
    if (raw !== null) ctrl.set(parseFloat(raw));
  });

  return { ...pattern, controls };
}
