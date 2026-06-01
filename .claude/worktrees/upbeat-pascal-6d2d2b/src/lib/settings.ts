import { z } from "zod";
import type { Pattern } from "./patterns/types";

const STORAGE_KEY = "pattern-projector-settings";
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

const DEMO_KEY = "pattern-projector-demo";

const DemoSchema = z.object({
  demoActive: z.boolean(),
  demoDwell: z.number().min(5).max(240),
  demoPatternIds: z.array(z.string()).optional(),
});

export function loadDemoSettings(allPatternIds: string[]): { demoActive: boolean; demoDwell: number; demoPatternIds: string[] } {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (!raw) return { demoActive: false, demoDwell: 30, demoPatternIds: allPatternIds };
    const parsed = DemoSchema.parse(JSON.parse(raw));
    // Filter saved IDs to only those that still exist; fall back to all if none saved
    const saved = parsed.demoPatternIds?.filter(id => allPatternIds.includes(id));
    return {
      demoActive: parsed.demoActive,
      demoDwell: parsed.demoDwell,
      demoPatternIds: saved?.length ? saved : allPatternIds,
    };
  } catch {
    return { demoActive: false, demoDwell: 30, demoPatternIds: allPatternIds };
  }
}

export function saveDemoSettings(demoActive: boolean, demoDwell: number, demoPatternIds: string[]): void {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify({ demoActive, demoDwell, demoPatternIds }));
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
