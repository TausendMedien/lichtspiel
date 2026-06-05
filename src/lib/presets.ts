export type Snapshot = Record<string, number | boolean | string>;

import { presetDefaults } from './preset-defaults';

function key(patternId: string): string {
  return `pp:slots:${patternId}`;
}

function defaults(patternId: string): (Snapshot | null)[] {
  const d = presetDefaults[patternId];
  if (!d) return [null, null, null];
  return [d[0] ?? null, d[1] ?? null, d[2] ?? null];
}

export function getSlots(patternId: string): (Snapshot | null)[] {
  try {
    const raw = localStorage.getItem(key(patternId));
    if (!raw) return defaults(patternId);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaults(patternId);
    return [parsed[0] ?? null, parsed[1] ?? null, parsed[2] ?? null];
  } catch {
    return defaults(patternId);
  }
}

export function saveSlot(patternId: string, idx: number, snap: Snapshot): void {
  const slots = getSlots(patternId);
  slots[idx] = snap;
  localStorage.setItem(key(patternId), JSON.stringify(slots));
}

export function clearSlot(patternId: string, idx: number): void {
  const slots = getSlots(patternId);
  slots[idx] = null;
  localStorage.setItem(key(patternId), JSON.stringify(slots));
}

// Remove this pattern's saved slots so getSlots() falls back to factory presetDefaults.
export function resetSlots(patternId: string): void {
  localStorage.removeItem(key(patternId));
}

// Remove every pattern's saved slots (full factory reset of all preset tiles).
export function resetAllSlots(): void {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("pp:slots:")) localStorage.removeItem(k);
  }
}
