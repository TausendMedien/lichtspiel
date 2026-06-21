// Named presets — save a complete look (one pattern's full control snapshot, incl.
// colours and Evolving-Range bands) under a user-chosen name and recall it later from
// a dropdown. Distinct from the per-pattern 1/2/3 slots: these are global and carry the
// pattern they belong to, so loading one also switches to that pattern.

import type { Snapshot } from './presets';

const KEY = 'pp:named-presets';

export interface NamedPreset {
  patternId: string;
  snap: Snapshot;
}

export function listNamed(): Record<string, NamedPreset> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? (p as Record<string, NamedPreset>) : {};
  } catch {
    return {};
  }
}

export function saveNamed(name: string, preset: NamedPreset): void {
  const all = listNamed();
  all[name] = preset;
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
}

export function deleteNamed(name: string): void {
  const all = listNamed();
  delete all[name];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
}
