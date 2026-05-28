// Global Tier 1 interaction settings and computed universal outputs.
// All five universals (Brightness, Color v2, Speed, Direction, Burst) share this state.

const INTERACTION_KEY = 'lichtspiel-interaction';

export interface PatternInteractionSettings {
  // Brightness (audio level → brighter)
  brightnessEnabled: boolean;
  brightnessGain: number;     // 0–2, default 1.0

  // Color v2 (motion level → less color variety)
  colorsV2Enabled: boolean;
  colorsV2Gain: number;       // 0–2, default 1.0

  // Speed (silence + stillness → slower idle drift)
  speedEnabled: boolean;
  speedGain: number;          // 0–2, default 1.0

  // Motion direction (center-of-mass → biases a native slider)
  directionEnabled: boolean;
  directionXBlend: number;    // 0–1
  directionYBlend: number;    // 0–1

  // Sudden burst (spike → flash on a native slider)
  burstEnabled: boolean;
  burstMagnitude: number;     // 0–1
}

function defaultPatternSettings(): PatternInteractionSettings {
  return {
    brightnessEnabled:  true,
    brightnessGain:     1.0,
    colorsV2Enabled:    true,
    colorsV2Gain:       1.0,
    speedEnabled:       true,
    speedGain:          1.0,
    directionEnabled:   true,
    directionXBlend:    0.5,
    directionYBlend:    0.0,
    burstEnabled:       true,
    burstMagnitude:     0.5,
  };
}

function loadInteractionSettings(): {
  strength: number;
  presenceTimeoutSec: number;
  burstThreshold: number;
  patternSettings: Record<string, PatternInteractionSettings>;
} {
  try {
    const s = localStorage.getItem(INTERACTION_KEY);
    if (s) {
      const p = JSON.parse(s);
      return {
        strength:           typeof p.strength === 'number'           ? Math.max(0, Math.min(1, p.strength)) : 0.4,
        presenceTimeoutSec: typeof p.presenceTimeoutSec === 'number' ? p.presenceTimeoutSec                : 5.0,
        burstThreshold:     typeof p.burstThreshold === 'number'     ? p.burstThreshold                   : 0.15,
        patternSettings:    typeof p.patternSettings === 'object' && p.patternSettings ? p.patternSettings : {},
      };
    }
  } catch {}
  return { strength: 0.4, presenceTimeoutSec: 5.0, burstThreshold: 0.15, patternSettings: {} };
}

const _loaded = typeof localStorage !== 'undefined' ? loadInteractionSettings() : { strength: 0.4, presenceTimeoutSec: 5.0, burstThreshold: 0.15, patternSettings: {} as Record<string, PatternInteractionSettings> };

export const interactionState = $state({
  // ── User-controlled settings ────────────────────────────────────────────────
  /** Master sensitivity for all Tier 1 universals. 0.0 = off, 1.0 = maximum. */
  strength:           _loaded.strength,
  /** Seconds of no motion + no audio before entering idle state. */
  presenceTimeoutSec: _loaded.presenceTimeoutSec,
  /** Raw-vs-smoothed delta threshold that triggers a Sudden Burst pulse. */
  burstThreshold:     _loaded.burstThreshold,
  /** Per-pattern overrides. Keyed by pattern id. */
  patternSettings:    _loaded.patternSettings as Record<string, PatternInteractionSettings>,

  // ── Computed outputs (written by wrappers and renderer) ────────────────────
  /** Whether a person is present (motion > threshold OR pose detected). */
  presence:           false,
  /** Seconds since last presence. Rises while absent, resets on presence. */
  absenceSeconds:     0,
  /** 0–1: how deeply into idle state we are. Rises slowly when absent. */
  idleAmount:         0,

  /** Brightness multiplier from audio. Applied in renderer post-pass.
   *  > 1.0 when loud; 1.0 at silence. */
  brightnessMult:     1.0,

  /** Driven Color v2 value from motion. Used by motionCameraWrapper.
   *  Range 0–3. High when still, low when moving. */
  colorsV2Drive:      3.0,

  /** Motion direction: -1 = left/up, +1 = right/down. */
  dirX:               0,
  dirY:               0,

  /** Sudden burst pulse. 0–1 with fast decay. */
  burst:              0,

  /** Speed multiplier driven by motion/idle.
   *  > 1.0 when motion active, < 1.0 during prolonged stillness.
   *  Written by motionCameraWrapper; applied in renderer. */
  speedMult:          1.0,
});

export function getPatternSettings(id: string): PatternInteractionSettings {
  if (!interactionState.patternSettings[id]) {
    interactionState.patternSettings[id] = defaultPatternSettings();
  }
  return interactionState.patternSettings[id];
}

export function saveInteractionSettings(): void {
  try {
    localStorage.setItem(INTERACTION_KEY, JSON.stringify({
      strength:           interactionState.strength,
      presenceTimeoutSec: interactionState.presenceTimeoutSec,
      burstThreshold:     interactionState.burstThreshold,
      patternSettings:    interactionState.patternSettings,
    }));
  } catch {}
}
