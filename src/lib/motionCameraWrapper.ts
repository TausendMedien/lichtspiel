// Generic motion-camera wrapper.
// Wraps any Pattern and:
//  1. Boosts selected range controls in proportion to detected motion
//     (existing behaviour, still driven by motionControlLabels or first two range controls).
//  2. Drives the Tier 1 universals: Color v2 reduction, Motion Direction, Sudden Burst.
//  3. Appends an "Interactions" section to the pattern's controls with per-pattern
//     toggles and gain sliders for all three motion universals.

import type { Pattern, PatternControl, PatternContext } from "./patterns/types";
import { MotionCamera, SpatialPatchinessDetector, showMotionOverlay } from "./motionDetector";
import { cameraState, enumerateCameras } from "./globalCameraSettings.svelte";
import { privacyMode } from "./privacyMode.svelte";
import { colorC2 } from "./colorC2.svelte";
import { interactionState, getPatternSettings, saveInteractionSettings } from "./interactionState.svelte";

const BURST_DECAY = 0.85;

export function addMotionCamera(pattern: Pattern): Pattern {
  let smoothedMotion = 0;
  let rawMotion      = 0;
  let burstPulse     = 0;
  let motionCamera: MotionCamera | null = null;
  const detector = new SpatialPatchinessDetector();
  let canvasRef: HTMLCanvasElement | null = null;
  let overlay: HTMLDivElement | null = null;
  let startId = 0;

  let prevEnabled        = false;
  let prevDeviceId       = '';
  let prevPatternEnabled = true;
  let overlayTimeout: ReturnType<typeof setTimeout> | null = null;

  // ── Identify the range controls to boost (existing per-pattern behaviour) ──
  type RangeCtrl = PatternControl & { type: "range" };
  const allRangeControls = (pattern.controls ?? []).filter((c): c is RangeCtrl => c.type === "range");
  const boostTargets = pattern.motionControlLabels
    ? allRangeControls.filter((c) => pattern.motionControlLabels!.includes(c.label))
    : allRangeControls.slice(0, 2);

  const baseVals: number[]      = boostTargets.map((c) => c.get());
  const effectiveVals: number[] = [...baseVals];
  const lastWritten: number[]   = [...baseVals];

  const wrappedBoostControls: PatternControl[] = (pattern.controls ?? []).map((ctrl) => {
    const idx = boostTargets.indexOf(ctrl as RangeCtrl);
    if (idx === -1) return ctrl;
    baseVals[idx] = (ctrl as RangeCtrl).get();
    effectiveVals[idx] = baseVals[idx];
    return {
      ...ctrl,
      get: () => effectiveVals[idx],
      set: (v: number) => { baseVals[idx] = v; effectiveVals[idx] = v; },
    } as RangeCtrl;
  });

  // ── Interaction section controls ───────────────────────────────────────────
  // We lazily create a settings entry and bind all controls to it so that
  // get/set read the live reactive state.

  function ps() { return getPatternSettings(pattern.id); }

  const interactionControls: PatternControl[] = [
    {
      label: 'Interactions',
      type:  'separator' as const,
    },
    // ── Color v2 ────────────────────────────────────────────────────────────
    {
      label: 'Colors',
      type:  'toggle' as const,
      get:   () => ps().colorsV2Enabled,
      set:   (v: boolean) => { ps().colorsV2Enabled = v; saveInteractionSettings(); },
    },
    {
      label: 'Colors Gain',
      type:  'range' as const,
      min:   0, max: 2, step: 0.1, default: 1.0,
      get:   () => ps().colorsV2Gain,
      set:   (v: number) => { ps().colorsV2Gain = v; saveInteractionSettings(); },
    },
    // ── Speed ───────────────────────────────────────────────────────────────
    {
      label: 'Speed Reactivity',
      type:  'toggle' as const,
      get:   () => ps().speedEnabled,
      set:   (v: boolean) => { ps().speedEnabled = v; saveInteractionSettings(); },
    },
    {
      label: 'Speed Gain',
      type:  'range' as const,
      min:   0, max: 2, step: 0.1, default: 1.0,
      get:   () => ps().speedGain,
      set:   (v: number) => { ps().speedGain = v; saveInteractionSettings(); },
    },
    // ── Direction ───────────────────────────────────────────────────────────
    {
      label: 'Direction',
      type:  'toggle' as const,
      get:   () => ps().directionEnabled,
      set:   (v: boolean) => { ps().directionEnabled = v; saveInteractionSettings(); },
    },
    {
      label: 'Dir X Blend',
      type:  'range' as const,
      min:   0, max: 1, step: 0.05, default: 0.5,
      get:   () => ps().directionXBlend,
      set:   (v: number) => { ps().directionXBlend = v; saveInteractionSettings(); },
    },
    {
      label: 'Dir Y Blend',
      type:  'range' as const,
      min:   0, max: 1, step: 0.05, default: 0.0,
      get:   () => ps().directionYBlend,
      set:   (v: number) => { ps().directionYBlend = v; saveInteractionSettings(); },
    },
    // ── Burst ───────────────────────────────────────────────────────────────
    {
      label: 'Burst',
      type:  'toggle' as const,
      get:   () => ps().burstEnabled,
      set:   (v: boolean) => { ps().burstEnabled = v; saveInteractionSettings(); },
    },
    {
      label: 'Burst Magnitude',
      type:  'range' as const,
      min:   0, max: 1, step: 0.05, default: 0.5,
      get:   () => ps().burstMagnitude,
      set:   (v: number) => { ps().burstMagnitude = v; saveInteractionSettings(); },
    },
  ];

  // ── Camera helpers ─────────────────────────────────────────────────────────
  function startCamera() {
    stopCamera();
    if (!canvasRef) return;
    if (privacyMode.active) {
      overlay = showMotionOverlay(canvasRef, 'Camera blocked by Sensor Block');
      return;
    }
    const deviceId = cameraState.deviceId;
    const constraints: MediaStreamConstraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 320 }, height: { ideal: 180 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 180 } },
      audio: false,
    };
    // Delay the overlay — only show if camera hasn't started within 500ms
    // (avoids a flash when permission is already granted)
    const myId = ++startId;
    const ref = canvasRef;
    overlayTimeout = setTimeout(() => {
      if (myId === startId) overlay = showMotionOverlay(ref, 'Requesting camera…');
    }, 500);
    MotionCamera.createWithConstraints(canvasRef, constraints).then(async (cam) => {
      clearTimeout(overlayTimeout!); overlayTimeout = null;
      if (myId !== startId) { cam?.dispose(); return; }
      overlay?.remove();
      overlay = null;
      motionCamera = cam ?? null;
      if (cam) await enumerateCameras();
    });
  }

  function stopCamera() {
    ++startId;
    if (overlayTimeout) { clearTimeout(overlayTimeout); overlayTimeout = null; }
    motionCamera?.dispose();
    motionCamera = null;
    smoothedMotion = 0;
    rawMotion      = 0;
    burstPulse     = 0;
    cameraState.level = 0;
    cameraState.dirX  = 0;
    cameraState.dirY  = 0;
    cameraState.burst = 0;
    overlay?.remove();
    overlay = null;
    for (let i = 0; i < boostTargets.length; i++) {
      effectiveVals[i] = baseVals[i];
      boostTargets[i].set(baseVals[i]);
    }
    // Restore colorsV2 and speedMult to defaults when camera stops
    colorC2.colorsV2 = 3.0;
    interactionState.speedMult = 1.0;
  }

  return {
    ...pattern,
    motionReactive: true,
    controls: [...wrappedBoostControls, ...interactionControls],

    init(ctx: PatternContext) {
      canvasRef = ctx.renderer.domElement;
      for (let i = 0; i < boostTargets.length; i++) {
        baseVals[i]      = boostTargets[i].get();
        effectiveVals[i] = baseVals[i];
        lastWritten[i]   = baseVals[i];
      }
      prevEnabled        = cameraState.enabled;
      prevDeviceId       = cameraState.deviceId;
      prevPatternEnabled = cameraState.patternMotionEnabled[pattern.id] ?? true;
      pattern.init(ctx);
      if (cameraState.enabled && prevPatternEnabled) startCamera();
    },

    activate() {
      if (cameraState.enabled && (cameraState.patternMotionEnabled[pattern.id] ?? true)) startCamera();
      pattern.activate?.();
    },

    update(dt: number, elapsed: number) {
      // React to global enable/device changes and per-pattern toggle
      const nowEnabled        = cameraState.enabled;
      const nowDeviceId       = cameraState.deviceId;
      const nowPatternEnabled = cameraState.patternMotionEnabled[pattern.id] ?? true;
      const shouldRun     = nowEnabled && nowPatternEnabled && !privacyMode.active;
      const prevShouldRun = prevEnabled && prevPatternEnabled;
      if (shouldRun !== prevShouldRun) {
        if (shouldRun) startCamera(); else stopCamera();
      } else if (shouldRun && nowDeviceId !== prevDeviceId) {
        startCamera();
      }
      prevEnabled        = nowEnabled;
      prevDeviceId       = nowDeviceId;
      prevPatternEnabled = nowPatternEnabled;

      // ── Motion detection ─────────────────────────────────────────────────
      if (motionCamera && cameraState.motionEnabled) {
        const diff = motionCamera.tick();
        if (diff) {
          rawMotion = Math.min(detector.update(diff), 1.0);
          smoothedMotion = rawMotion > smoothedMotion
            ? 0.75 * smoothedMotion + 0.25 * rawMotion   // fast rise
            : 0.55 * smoothedMotion + 0.45 * rawMotion;  // fast fall
        }
      } else if (!cameraState.motionEnabled) {
        smoothedMotion = Math.max(0, smoothedMotion * 0.95);
        rawMotion      = 0;
      }
      cameraState.level = Math.round(smoothedMotion * 100);

      // ── Direction (from detector center-of-mass) ──────────────────────────
      cameraState.dirX = detector.dirX;
      cameraState.dirY = detector.dirY;

      // ── Sudden burst: raw spike above 2× smoothed ─────────────────────────
      const burstThreshold = interactionState.burstThreshold;
      if (cameraState.motionEnabled && rawMotion - smoothedMotion > burstThreshold) {
        burstPulse = 1.0;
      }
      burstPulse *= BURST_DECAY;
      cameraState.burst = Math.round(burstPulse * 100);

      // ── Boost per-pattern native controls + Direction bias ───────────────
      const settings = getPatternSettings(pattern.id);
      const str = interactionState.strength;
      const scaledMotion = cameraState.motionEnabled
        ? smoothedMotion * (cameraState.sensitivity / 10) * (8 / 7)
        : 0;
      for (let i = 0; i < boostTargets.length; i++) {
        const ctrl  = boostTargets[i];
        const range = ctrl.max - ctrl.min;
        const added = Math.min(scaledMotion * range, range);
        let effective = baseVals[i] + added;
        // Direction bias: dirX/Y shifts the effective value left/right along the control's range
        if (settings.directionEnabled && cameraState.motionEnabled) {
          effective += cameraState.dirX * settings.directionXBlend * range * 0.3;
          effective += cameraState.dirY * settings.directionYBlend * range * 0.3;
        }
        effectiveVals[i] = Math.max(ctrl.min, Math.min(ctrl.max, effective));
        if (effectiveVals[i] !== lastWritten[i]) {
          lastWritten[i] = effectiveVals[i];
          ctrl.set(effectiveVals[i]);
        }
      }

      // ── Tier 1: Universal Color v2 (motion reduces variety) ──────────────
      if (cameraState.motionEnabled && cameraState.enabled && settings.colorsV2Enabled) {
        const gain       = settings.colorsV2Gain;
        // No motion = colorsV2 stays at 3 (max variety).
        // Full motion = colorsV2 driven toward 0 (monochrome).
        const motionNorm = Math.pow(smoothedMotion, 0.4);
        const target     = 3 * (1 - motionNorm * gain * str);
        colorC2.colorsV2 = parseFloat(Math.max(0, Math.min(3, target)).toFixed(2));
      }

      // ── Tier 1: Publish direction and burst for patterns to use ──────────
      if (settings.directionEnabled) {
        interactionState.dirX  = cameraState.dirX;
        interactionState.dirY  = cameraState.dirY;
      }
      if (settings.burstEnabled) {
        interactionState.burst = burstPulse * settings.burstMagnitude * str;
      }

      // ── Tier 1: Presence / idle tracking ─────────────────────────────────
      const isPresent = smoothedMotion > 0.05;
      if (isPresent) {
        interactionState.presence       = true;
        interactionState.absenceSeconds = 0;
        interactionState.idleAmount     = Math.max(0, interactionState.idleAmount - dt * 0.5);
      } else {
        interactionState.absenceSeconds += dt;
        if (interactionState.absenceSeconds >= interactionState.presenceTimeoutSec) {
          interactionState.presence   = false;
          interactionState.idleAmount = Math.min(1, interactionState.idleAmount + dt * 0.1);
        }
      }

      // ── Tier 1: Speed universal — motion→faster, idle→slower ────────────
      // speedMult > 1 when motion active; < 1 during prolonged stillness.
      if (settings.speedEnabled && cameraState.enabled) {
        const gain       = settings.speedGain;
        const motionBoost = smoothedMotion * gain * str;
        const idleSlow    = interactionState.idleAmount * gain * str * 0.5;
        interactionState.speedMult = Math.max(0.2, 1.0 + motionBoost - idleSlow);
      } else {
        interactionState.speedMult = 1.0;
      }

      pattern.update(dt, elapsed);
    },

    resize(width: number, height: number) {
      pattern.resize(width, height);
    },

    dispose() {
      stopCamera();
      canvasRef = null;
      for (let i = 0; i < boostTargets.length; i++) {
        boostTargets[i].set(baseVals[i]);
      }
      pattern.dispose();
    },
  };
}
