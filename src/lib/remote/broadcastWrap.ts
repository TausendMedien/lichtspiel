// Wraps a pattern's controls so every real write (set()) also broadcasts a
// param-update while in Remote mode — a no-op otherwise. Mirrors wrapWithPersist's
// shape/order in patterns/index.ts. setLive (transient Evolving-Range drift) is left
// untouched, so drift never gets broadcast.

import type { Pattern } from '../patterns/types';
import { sendThrottled } from './broadcast';

export function wrapWithBroadcast(pattern: Pattern): Pattern {
  const controls = pattern.controls?.map(ctrl => {
    if (ctrl.type === 'button' || ctrl.type === 'separator') return ctrl;
    if (ctrl.type === 'toggle' || ctrl.type === 'section') {
      return { ...ctrl, set(v: boolean) { ctrl.set(v); sendThrottled(`ctrl:${ctrl.label}`, v); } };
    }
    if (ctrl.type === 'text' || ctrl.type === 'color') {
      return { ...ctrl, set(v: string) { ctrl.set(v); sendThrottled(`ctrl:${ctrl.label}`, v); } };
    }
    // range | select
    return { ...ctrl, set(v: number) { ctrl.set(v); sendThrottled(`ctrl:${ctrl.label}`, v); } };
  });
  return { ...pattern, controls };
}
