// Display/Remote sync layer: param addressing, snapshot build/apply, and the
// throttled broadcast used by Remote mode to mirror every local change to the
// relay. Both roles run the exact same app — this module is what turns local
// state writes into `param-update` messages (Remote) and turns incoming
// `param-update`/`state-snapshot` messages back into local state writes (Display).

import { tick } from 'svelte';
import { patterns } from '../patterns';
import { audioState } from '../globalAudioSettings.svelte';
import { cameraState } from '../globalCameraSettings.svelte';
import { interactionState, saveInteractionSettings } from '../interactionState.svelte';
import { colorC2, colorShuffle, saveColorC2 } from '../colorC2.svelte';
import { evolving, saveEvolving } from '../evolving.svelte';
import { sendThrottled, setSuppressed, type ParamValue } from './broadcast';

export type { ParamValue };

export interface DisplayAdapter {
  getPatternIndex(): number;
  switchToPatternId(id: string): void;
  restorePresetSlot(slot: number): void; // 0..2
  onCtrlChanged(label: string, value: ParamValue): void; // mirror ctrlVals + saveSettings
  onColorShuffleChanged(): void; // persist colorShuffle.* for the current pattern (savePatternColor)
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

interface RegistryEntry { get(): ParamValue; set(v: ParamValue): void }

// Explicit whitelist — never arbitrary property access. Setters call the same
// save*() functions the existing UI calls (or none, where the field is session-only,
// matching current behavior for audio.*/camera.* which are not persisted today).
const GLOBAL_REGISTRY: Record<string, RegistryEntry> = {
  'audio.enabled':         { get: () => audioState.enabled,         set: v => { audioState.enabled = !!v; } },
  'audio.sensitivity':     { get: () => audioState.sensitivity,     set: v => { audioState.sensitivity = Number(v); } },
  'audio.beatMode':        { get: () => audioState.beatMode,        set: v => { audioState.beatMode = !!v; } },
  'audio.beatSensitivity': { get: () => audioState.beatSensitivity, set: v => { audioState.beatSensitivity = Number(v); } },

  'camera.enabled':       { get: () => cameraState.enabled,       set: v => { cameraState.enabled = !!v; } },
  'camera.motionEnabled': { get: () => cameraState.motionEnabled, set: v => { cameraState.motionEnabled = !!v; } },
  'camera.heatEnabled':   { get: () => cameraState.heatEnabled,   set: v => { cameraState.heatEnabled = !!v; } },
  'camera.sensitivity':   { get: () => cameraState.sensitivity,   set: v => { cameraState.sensitivity = Number(v); } },

  'interaction.strength': {
    get: () => interactionState.strength,
    set: v => { interactionState.strength = clamp(Number(v), 0, 1); saveInteractionSettings(); },
  },

  'evolving.active': { get: () => evolving.active, set: v => { evolving.active = !!v; saveEvolving(); } },
  'evolving.speed':  { get: () => evolving.speed,  set: v => { evolving.speed = clamp(Number(v), 0, 1); saveEvolving(); } },
  'evolving.maxConcurrent': {
    get: () => evolving.maxConcurrent,
    set: v => { evolving.maxConcurrent = clamp(Math.round(Number(v)), 1, 3); saveEvolving(); },
  },

  'color.colorsV2': { get: () => colorC2.colorsV2, set: v => { colorC2.colorsV2 = Number(v); saveColorC2(); } },
  'color.main':     { get: () => colorC2.main,     set: v => { if (typeof v === 'string' && HEX_RE.test(v)) { colorC2.main = v; saveColorC2(); } } },
  'color.contrast': { get: () => colorC2.contrast, set: v => { if (typeof v === 'string' && HEX_RE.test(v)) { colorC2.contrast = v; saveColorC2(); } } },
  'color.glow':     { get: () => colorC2.glow,     set: v => { if (typeof v === 'string' && HEX_RE.test(v)) { colorC2.glow = v; saveColorC2(); } } },

  // Per-pattern colour-shuffle state ("Apply Colors" toggle, "Color Shuffle" button's
  // result, Brightness slider). Persistence (savePatternColor) needs the CURRENT
  // pattern id, which this module doesn't track — applyParam calls
  // adapter.onColorShuffleChanged() right after any colorShuffle.* set below.
  'colorShuffle.enabled':    { get: () => colorShuffle.enabled,    set: v => { colorShuffle.enabled = !!v; } },
  'colorShuffle.saturation': { get: () => colorShuffle.saturation, set: v => { colorShuffle.saturation = Number(v); } },
  'colorShuffle.brightness': { get: () => colorShuffle.brightness, set: v => { colorShuffle.brightness = Number(v); } },
  'colorShuffle.assign': {
    get: () => colorShuffle.assign.join(','),
    set: v => {
      if (typeof v !== 'string') return;
      const parts = v.split(',').map(Number);
      if (parts.length === 3 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 5)) {
        colorShuffle.assign = parts as [number, number, number];
      }
    },
  },
};

const COLOR_SHUFFLE_PREFIX = 'colorShuffle.';

// ── Display side: apply incoming param-updates / snapshots to local state ──────

export function applyParam(adapter: DisplayAdapter, param: string, value: ParamValue): void {
  const sep = param.indexOf(':');
  if (sep < 0) return;
  const ns = param.slice(0, sep);
  const key = param.slice(sep + 1);

  if (ns === 'ctrl') {
    const idx = adapter.getPatternIndex();
    const ctrl = patterns[idx]?.controls?.find(c => c.label === key);
    if (!ctrl || ctrl.type === 'button' || ctrl.type === 'separator') return; // unknown/unsupported — skip silently (version-skew safe)
    if ((ctrl as { readonly?: boolean }).readonly) return;
    if ((ctrl as { interactive?: string }).interactive) return; // never remote-drive camera/mic device controls
    if (ctrl.type === 'range') {
      if (typeof value !== 'number') return;
      const clamped = clamp(value, ctrl.min, ctrl.max);
      ctrl.set(clamped);
      adapter.onCtrlChanged(key, clamped);
    } else if (ctrl.type === 'select') {
      if (typeof value !== 'number') return;
      ctrl.set(value);
      adapter.onCtrlChanged(key, value);
    } else if (ctrl.type === 'toggle' || ctrl.type === 'section') {
      if (typeof value !== 'boolean') return;
      ctrl.set(value);
      adapter.onCtrlChanged(key, value);
    } else if (ctrl.type === 'text' || ctrl.type === 'color') {
      if (typeof value !== 'string') return;
      ctrl.set(value);
      adapter.onCtrlChanged(key, value);
    }
    return;
  }

  if (ns === 'global') {
    GLOBAL_REGISTRY[key]?.set(value);
    if (key.startsWith(COLOR_SHUFFLE_PREFIX)) adapter.onColorShuffleChanged();
    return;
  }

  if (ns === 'app') {
    if (key === 'pattern' && typeof value === 'string') adapter.switchToPatternId(value);
    else if (key === 'preset' && typeof value === 'number') adapter.restorePresetSlot(clamp(Math.round(value), 0, 2));
  }
}

export function buildSnapshot(patternIndex: number): Record<string, ParamValue> {
  const snap: Record<string, ParamValue> = {};
  const pattern = patterns[patternIndex];
  if (!pattern) return snap;
  snap['app:pattern'] = pattern.id;
  for (const ctrl of pattern.controls ?? []) {
    if (ctrl.type === 'button' || ctrl.type === 'separator') continue;
    if ((ctrl as { interactive?: string }).interactive) continue; // never share camera/mic device selection
    snap[`ctrl:${ctrl.label}`] = ctrl.get();
  }
  for (const [key, entry] of Object.entries(GLOBAL_REGISTRY)) {
    snap[`global:${key}`] = entry.get();
  }
  return snap;
}

/** Apply a full snapshot to local state — used by a Display joining a room that
 *  already has a primary, and by a Remote seeding its own preview on connect. */
export async function applySnapshotToLocalState(adapter: DisplayAdapter, params: Record<string, ParamValue>): Promise<void> {
  setSuppressed(true);
  try {
    if (typeof params['app:pattern'] === 'string') applyParam(adapter, 'app:pattern', params['app:pattern']);
    for (const [param, value] of Object.entries(params)) {
      if (param === 'app:pattern') continue;
      applyParam(adapter, param, value);
    }
    await tick();
  } finally {
    setSuppressed(false);
  }
}

// ── Remote side: broadcast local changes as param-updates ──────────────────────

export function broadcastPatternChange(patternId: string): void {
  sendThrottled('app:pattern', patternId);
}

/** Broadcast a range control's value directly — for the two spots (Randomize,
 *  preset restore) that animate the CURRENT pattern's range sliders toward a target
 *  via setLive() instead of set(), which the normal wrapWithBroadcast hook never sees. */
export function broadcastCtrlValue(label: string, value: ParamValue): void {
  sendThrottled(`ctrl:${label}`, value);
}

/** Registers one $effect per whitelisted global field that broadcasts on change while
 *  in Remote mode. Must be called synchronously during component setup (not inside an
 *  async continuation) since $effect requires an owning component/effect-root context. */
export function initGlobalBroadcastEffects(): void {
  for (const [key, entry] of Object.entries(GLOBAL_REGISTRY)) {
    $effect(() => {
      const v = entry.get();
      sendThrottled(`global:${key}`, v);
    });
  }
}
