/** Global 3-colour system: Haupt / Kontrast / Glow + Saturation / Brightness */

const COLORS_KEY = 'pp:colors3';

export const COLOR_DEFAULTS = {
  haupt:      '#00ffff',
  kontrast:   '#ff00cc',
  glow:       '#ffffff',
  saturation: 1.0,
  brightness: 1.0,
} as const;

function loadColors() {
  try {
    const s = localStorage.getItem(COLORS_KEY);
    if (!s) return { ...COLOR_DEFAULTS };
    const p = JSON.parse(s);
    const hex = /^#[0-9a-fA-F]{6}$/;
    return {
      haupt:      hex.test(p.haupt)      ? p.haupt      : COLOR_DEFAULTS.haupt,
      kontrast:   hex.test(p.kontrast)   ? p.kontrast   : COLOR_DEFAULTS.kontrast,
      glow:       hex.test(p.glow)       ? p.glow       : COLOR_DEFAULTS.glow,
      saturation: typeof p.saturation === 'number' ? p.saturation : COLOR_DEFAULTS.saturation,
      brightness: typeof p.brightness === 'number' ? p.brightness : COLOR_DEFAULTS.brightness,
    };
  } catch {
    return { ...COLOR_DEFAULTS };
  }
}

export const colorC2 = $state(
  typeof localStorage !== 'undefined' ? loadColors() : { ...COLOR_DEFAULTS }
);

export function saveColorC2() {
  try {
    localStorage.setItem(COLORS_KEY, JSON.stringify({ ...colorC2 }));
  } catch {}
}
