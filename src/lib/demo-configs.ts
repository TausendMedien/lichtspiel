// Demo Configurations — save / recall a complete demo setup under a user-chosen name.
// Captures all demo-level state: pattern selection, start behavior, timing, pedal
// settings, Evolving Ranges, and sensor toggles (Motion / Heat / Audio).
// Distinct from the per-pattern 1/2/3 slots, which remain unchanged.

const KEY = 'pp:demo-configs';

export interface DemoConfig {
  demoPatternIds: string[];
  demoStartBehavior: string;
  demoDwell: number;
  pedalDwell: number;
  demoRandomizeOrder: boolean;
  demoFavoritesOnly: boolean;
  randomizeMode: string;
  pedalChangesPattern: boolean;
  pedalDoubleChangesPattern: boolean;
  pedalLongAction: string;
  demoHideHud: boolean;
  evoActive: boolean;
  evoSpeed: number;
  evoConcurrent: number;
  motionEnabled: boolean;
  heatEnabled: boolean;
  audioEnabled: boolean;
}

export function listDemoConfigs(): Record<string, DemoConfig> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? (p as Record<string, DemoConfig>) : {};
  } catch {
    return {};
  }
}

export function saveDemoConfig(name: string, cfg: DemoConfig): void {
  const all = listDemoConfigs();
  all[name] = cfg;
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
}

export function deleteDemoConfig(name: string): void {
  const all = listDemoConfigs();
  delete all[name];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
}
