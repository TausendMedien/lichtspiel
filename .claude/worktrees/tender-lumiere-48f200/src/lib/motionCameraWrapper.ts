// Generic motion-camera wrapper.
// Wraps any Pattern and boosts the first two range controls in proportion to
// detected motion. Camera settings (enable, device, sensitivity) come from the
// global Options menu via globalCameraSettings.svelte.ts — no controls are
// added to the pattern's own controls list.

import type { Pattern, PatternControl, PatternContext } from "./patterns/types";
import { MotionCamera, SpatialPatchinessDetector, showMotionOverlay } from "./motionDetector";
import { cameraState, enumerateCameras } from "./globalCameraSettings.svelte";

export function addMotionCamera(pattern: Pattern): Pattern {
  let smoothedMotion = 0;
  let motionCamera: MotionCamera | null = null;
  const detector = new SpatialPatchinessDetector();
  let canvasRef: HTMLCanvasElement | null = null;
  let overlay: HTMLDivElement | null = null;

  // Track previous global state to detect changes in update()
  let prevEnabled  = false;
  let prevDeviceId = '';

  // ── Identify the range controls to boost ──────────────────────────────────
  type RangeCtrl = PatternControl & { type: "range" };
  const allRangeControls = (pattern.controls ?? []).filter((c): c is RangeCtrl => c.type === "range");
  const firstTwoRange = pattern.motionControlLabels
    ? allRangeControls.filter((c) => pattern.motionControlLabels!.includes(c.label))
    : allRangeControls.slice(0, 2);

  const baseVals: number[]      = firstTwoRange.map((c) => c.get());
  const effectiveVals: number[] = [...baseVals];

  // Wrap the boosted controls so user drags update baseVals only;
  // the actual pattern value is written by update() using effectiveVals.
  const wrappedControls: PatternControl[] = (pattern.controls ?? []).map((ctrl) => {
    const idx = firstTwoRange.indexOf(ctrl as RangeCtrl);
    if (idx === -1) return ctrl;
    baseVals[idx] = (ctrl as RangeCtrl).get();
    effectiveVals[idx] = baseVals[idx];
    return {
      ...ctrl,
      get: () => effectiveVals[idx],
      // Update both baseVals AND effectiveVals so liveSync sees the new value
      // immediately (before update() runs) — fixes slider snapping on drag.
      set: (v: number) => { baseVals[idx] = v; effectiveVals[idx] = v; },
    } as RangeCtrl;
  });

  // ── Camera helpers ─────────────────────────────────────────────────────────
  function startCamera() {
    stopCamera();
    if (!canvasRef) return;
    const deviceId = cameraState.deviceId;
    const constraints: MediaStreamConstraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 320 }, height: { ideal: 180 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 180 } },
      audio: false,
    };
    overlay = showMotionOverlay(canvasRef, 'Requesting camera…');
    MotionCamera.createWithConstraints(canvasRef, constraints).then(async (cam) => {
      overlay?.remove();
      overlay = null;
      motionCamera = cam ?? null;
      if (cam) await enumerateCameras();
    });
  }

  function stopCamera() {
    motionCamera?.dispose();
    motionCamera = null;
    smoothedMotion = 0;
    cameraState.level = 0;
    overlay?.remove();
    overlay = null;
    for (let i = 0; i < firstTwoRange.length; i++) {
      effectiveVals[i] = baseVals[i];
      firstTwoRange[i].set(baseVals[i]);
    }
  }

  return {
    ...pattern,
    controls: wrappedControls,

    init(ctx: PatternContext) {
      canvasRef = ctx.renderer.domElement;
      for (let i = 0; i < firstTwoRange.length; i++) {
        baseVals[i] = firstTwoRange[i].get();
        effectiveVals[i] = baseVals[i];
      }
      prevEnabled  = cameraState.enabled;
      prevDeviceId = cameraState.deviceId;
      pattern.init(ctx);
      if (cameraState.enabled) startCamera();
    },

    activate() {
      if (cameraState.enabled) startCamera();
      pattern.activate?.();
    },

    update(dt: number, elapsed: number) {
      // React to global enable/device changes
      const nowEnabled  = cameraState.enabled;
      const nowDeviceId = cameraState.deviceId;
      if (nowEnabled !== prevEnabled) {
        prevEnabled = nowEnabled;
        if (nowEnabled) startCamera();
        else stopCamera();
      } else if (nowEnabled && nowDeviceId !== prevDeviceId) {
        prevDeviceId = nowDeviceId;
        startCamera();
      }
      prevDeviceId = nowDeviceId;

      // Motion detection (only when motionEnabled)
      if (motionCamera && cameraState.motionEnabled) {
        const diff = motionCamera.tick();
        if (diff) {
          const raw = Math.min(detector.update(diff), 1.0);
          smoothedMotion = raw > smoothedMotion
            ? 0.90 * smoothedMotion + 0.10 * raw
            : 0.97 * smoothedMotion + 0.03 * raw;
        }
      } else if (!cameraState.motionEnabled) {
        smoothedMotion = Math.max(0, smoothedMotion * 0.95); // decay when disabled
      }
      cameraState.level = Math.round(smoothedMotion * 100);

      // Boost first two controls only when motion detection is enabled
      const scaledMotion = cameraState.motionEnabled
        ? smoothedMotion * (cameraState.sensitivity / 10) * (8 / 7)
        : 0;
      for (let i = 0; i < firstTwoRange.length; i++) {
        const ctrl = firstTwoRange[i];
        const range = ctrl.max - ctrl.min;
        const added = Math.min(scaledMotion * range, range);
        effectiveVals[i] = Math.min(baseVals[i] + added, ctrl.max);
        ctrl.set(effectiveVals[i]);
      }

      pattern.update(dt, elapsed);
    },

    resize(width: number, height: number) {
      pattern.resize(width, height);
    },

    dispose() {
      stopCamera();
      canvasRef = null;
      for (let i = 0; i < firstTwoRange.length; i++) {
        firstTwoRange[i].set(baseVals[i]);
      }
      pattern.dispose();
    },
  };
}
