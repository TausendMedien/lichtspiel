import type { Pattern } from './patterns/types';

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
