export type Snapshot = Record<string, number | boolean | string>;

function key(patternId: string): string {
  return `pp:slots:${patternId}`;
}

export function getSlots(patternId: string): (Snapshot | null)[] {
  try {
    const raw = localStorage.getItem(key(patternId));
    if (!raw) return [null, null, null];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [null, null, null];
    return [parsed[0] ?? null, parsed[1] ?? null, parsed[2] ?? null];
  } catch {
    return [null, null, null];
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
