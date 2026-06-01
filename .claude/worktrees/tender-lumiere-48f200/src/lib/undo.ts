export interface UndoEntry {
  patternId: string;
  label: string;
  value: number | boolean | string;
}

const MAX = 50;
const stack: UndoEntry[] = [];
let isUndoing = false;

export function pushUndo(entry: UndoEntry): void {
  if (isUndoing) return;
  stack.push(entry);
  if (stack.length > MAX) stack.shift();
}

export function popUndo(): UndoEntry | undefined {
  return stack.pop();
}

export function setUndoing(v: boolean): void {
  isUndoing = v;
}

export function clearUndo(): void {
  stack.length = 0;
}
