import type { Pattern } from './patterns/types';

// Re-read pp: keys and push values into controls.
// Call this AFTER loadSettings so individual keys (updated more
// frequently) can override a stale settings blob.
export function restoreFromKeys(patterns: Pattern[]): void {
  for (const pattern of patterns) {
    for (const ctrl of pattern.controls ?? []) {
      if (ctrl.type === 'button' || ctrl.type === 'separator') continue;
      const key = `pp:${pattern.id}:${ctrl.label}`;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      if (ctrl.type === 'toggle' || ctrl.type === 'section') ctrl.set(raw === '1');
      else ctrl.set(parseFloat(raw));
    }
  }
}

export function wrapWithPersist(pattern: Pattern): Pattern {
  const controls = pattern.controls?.map(ctrl => {
    if (ctrl.type === 'button' || ctrl.type === 'separator') return ctrl;
    const key = `pp:${pattern.id}:${ctrl.label}`;
    if (ctrl.type === 'toggle' || ctrl.type === 'section') {
      return {
        ...ctrl,
        set(v: boolean) {
          ctrl.set(v);
          localStorage.setItem(key, v ? '1' : '0');
        },
      };
    }
    return {
      ...ctrl,
      set(v: number) {
        ctrl.set(v);
        localStorage.setItem(key, String(v));
      },
    };
  });

  // Restore saved values immediately.
  controls?.forEach(ctrl => {
    if (ctrl.type === 'button' || ctrl.type === 'separator') return;
    const key = `pp:${pattern.id}:${ctrl.label}`;
    const raw = localStorage.getItem(key);
    if (raw === null) return;
    if (ctrl.type === 'toggle' || ctrl.type === 'section') ctrl.set(raw === '1');
    else ctrl.set(parseFloat(raw));
  });

  return { ...pattern, controls };
}
