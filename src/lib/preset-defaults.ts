import type { Snapshot } from './presets';

const colorDefaults = {
  __colorEnabled: false,
  __colorAssign: "0,2,1",
  __colorSat: 0.99,
  __colorBri: 1.7,
  __c2Main: "#00ffff",
  __c2Contrast: "#ff00cc",
  __c2Glow: "#ffffff",
  __c2Extra1: "#ff6600",
  __c2Extra2: "#ffcc00",
  __c2Extra3: "#7700ff",
  __c2Extra1on: false,
  __c2Extra2on: false,
  __c2Extra3on: false,
};

const base: Snapshot = {
  Camera: true, Mirror: true, Threshold: 0.8, Lock: false,
  "Fade Speed": 0.03, Colorize: 0, Black: 0.3,
  Additional: false,
  Gain: 0.5, "Brush Size": 0, Ghost: 0, Bloom: 0,
  "Fly In/Out": 0, Vortex: 0, "RGB Split": 0,
  Kaleidoscope: false, Segments: 5,
  ...colorDefaults,
};

export const presetDefaults: Record<string, (Snapshot | null)[]> = {
  lightPaint:      [{ ...base }, null, null],
  lightTrail:      [{ ...base, "Fade Speed": 0.01 }, null, null],
  lightPaintBlack: [{ ...base, Black: 1.0 }, null, null],
  lightFly:        [{ ...base, "Fly In/Out": -0.20 }, null, null],
  lightVortex:     [{ ...base, Vortex: -0.10 }, null, null],
  lightKaleido:    [{ ...base, Kaleidoscope: true, Segments: 3 }, null, null],
  lightGlitch:     [{ ...base, "RGB Split": 0.020 }, null, null],
};
