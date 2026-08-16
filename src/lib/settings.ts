import { z } from "zod";
import type { Pattern } from "./patterns/types";

// migrate from old key on first load
(function migrate() {
  try {
    const old = localStorage.getItem("pattern-projector-settings");
    if (old && !localStorage.getItem("lichtspiel-settings")) {
      localStorage.setItem("lichtspiel-settings", old);
      localStorage.removeItem("pattern-projector-settings");
    }
  } catch {}
})();

const STORAGE_KEY = "lichtspiel-settings";
const SETTINGS_VERSION = 1;

const SettingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION),
  patterns: z.record(z.string(), z.record(z.string(), z.number())),
});

type Settings = z.infer<typeof SettingsSchema>;

function readFromStorage(): Settings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return SettingsSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function loadSettings(patterns: Pattern[]): void {
  const settings = readFromStorage();
  if (!settings) return;

  for (const pattern of patterns) {
    const saved = settings.patterns[pattern.id];
    if (!saved || !pattern.controls) continue;
    for (const ctrl of pattern.controls) {
      if (ctrl.type === "range" && ctrl.label in saved) {
        const v = saved[ctrl.label];
        if (v >= ctrl.min && v <= ctrl.max) ctrl.set(v);
      } else if (ctrl.type === "select" && ctrl.label in saved) {
        const v = saved[ctrl.label];
        const optLen = typeof ctrl.options === 'function' ? ctrl.options().length : ctrl.options.length;
        if (Number.isInteger(v) && v >= 0 && v < optLen) ctrl.set(v);
      } else if ((ctrl.type === "toggle" || ctrl.type === "section") && ctrl.label in saved) {
        ctrl.set(!!saved[ctrl.label]);
      }
    }
  }
}

const DEMO_KEY = "lichtspiel-demo";

const DEMO_START_BEHAVIORS = ['default', 'slot1', 'slot2', 'slot3', 'random'] as const;
export type DemoStartBehavior = typeof DEMO_START_BEHAVIORS[number];

// Dwell time runs 5 s … 15 min. The slider is exponential so the short end stays
// fine-grained, then snaps to readable stops. Keep DWELL_MIN/MAX and the schema
// bound below in step — a value outside the schema makes the whole demo blob fail
// to parse, which silently resets every demo setting.
export const DWELL_MIN = 5;
export const DWELL_MAX = 900;

/** Slider position 0..1 → seconds. 5 s at 0, 900 s at 1, snapped to readable stops:
 *  5 s steps below a minute, 15 s up to five minutes, 1 min beyond. */
export function dwellFromSlider(p: number): number {
  const clamped = Math.min(1, Math.max(0, p));
  const raw = DWELL_MIN * Math.pow(DWELL_MAX / DWELL_MIN, clamped);
  const step = raw < 60 ? 5 : raw < 300 ? 15 : 60;
  return Math.min(DWELL_MAX, Math.max(DWELL_MIN, Math.round(raw / step) * step));
}

/** Seconds → slider position 0..1. Inverse of the curve above (before snapping). */
export function dwellToSlider(seconds: number): number {
  const s = Math.min(DWELL_MAX, Math.max(DWELL_MIN, seconds));
  return Math.log(s / DWELL_MIN) / Math.log(DWELL_MAX / DWELL_MIN);
}

const DemoSchema = z.object({
  demoActive: z.boolean(),
  demoDwell: z.number().min(DWELL_MIN).max(DWELL_MAX),
  pedalDwell: z.number().min(10).max(600).optional(),
  demoPatternIds: z.array(z.string()).optional(),
  demoStartBehavior: z.enum(DEMO_START_BEHAVIORS).optional(),
  demoRandomizeOrder: z.boolean().optional(),
  demoFavoritesOnly: z.boolean().optional(),
});

export function loadDemoSettings(allPatternIds: string[]): { demoActive: boolean; demoDwell: number; pedalDwell: number; demoPatternIds: string[]; demoStartBehavior: DemoStartBehavior; demoRandomizeOrder: boolean; demoFavoritesOnly: boolean } {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (!raw) return { demoActive: false, demoDwell: 60, pedalDwell: 180, demoPatternIds: allPatternIds, demoStartBehavior: 'default', demoRandomizeOrder: false, demoFavoritesOnly: false };
    const parsed = DemoSchema.parse(JSON.parse(raw));
    // Filter saved IDs to only those that still exist; fall back to all if none saved
    const saved = parsed.demoPatternIds?.filter(id => allPatternIds.includes(id));
    return {
      demoActive: parsed.demoActive,
      demoDwell: parsed.demoDwell,
      pedalDwell: parsed.pedalDwell ?? 180,
      demoPatternIds: saved?.length ? saved : allPatternIds,
      demoStartBehavior: parsed.demoStartBehavior ?? 'default',
      demoRandomizeOrder: parsed.demoRandomizeOrder ?? false,
      demoFavoritesOnly: parsed.demoFavoritesOnly ?? false,
    };
  } catch {
    return { demoActive: false, demoDwell: 60, pedalDwell: 180, demoPatternIds: allPatternIds, demoStartBehavior: 'default', demoRandomizeOrder: false, demoFavoritesOnly: false };
  }
}

export function saveDemoSettings(demoActive: boolean, demoDwell: number, pedalDwell: number, demoPatternIds: string[], demoStartBehavior: DemoStartBehavior, demoRandomizeOrder: boolean, demoFavoritesOnly: boolean): void {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify({ demoActive, demoDwell, pedalDwell, demoPatternIds, demoStartBehavior, demoRandomizeOrder, demoFavoritesOnly }));
  } catch {}
}

export function saveSettings(patterns: Pattern[]): void {
  const patternValues: Settings["patterns"] = {};
  for (const pattern of patterns) {
    if (!pattern.controls?.length) continue;
    const vals: Record<string, number> = {};
    for (const ctrl of pattern.controls) {
      if (ctrl.type === 'separator') continue;
      if (ctrl.type === 'button') continue;
      if (ctrl.type === 'toggle' || ctrl.type === 'section') vals[ctrl.label] = ctrl.get() ? 1 : 0;
      else vals[ctrl.label] = ctrl.get();
    }
    patternValues[pattern.id] = vals;
  }
  const settings: Settings = { version: SETTINGS_VERSION, patterns: patternValues };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable — silently ignore
  }
}
