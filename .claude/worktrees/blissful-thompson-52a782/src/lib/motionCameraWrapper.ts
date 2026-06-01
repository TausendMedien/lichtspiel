// Generic motion-camera wrapper.
// Wraps any Pattern, appends Motion Detection Camera controls, and boosts the
// first two range controls in proportion to detected motion. Uses the Spatial
// Patchiness detector (same as Particle Field · Spatial).

import type { Pattern, PatternControl, PatternContext } from "./patterns/types";
import { MotionCamera, SpatialPatchinessDetector, showMotionOverlay } from "./motionDetector";

export function addMotionCamera(pattern: Pattern): Pattern {
  // ── Motion state ───────────────────────────────────────────────────────────
  let sensitivity    = 10;   // restored by wrapWithPersist
  let cameraEnabled  = false; // restored by wrapWithPersist
  let deviceIndex    = 0;    // restored by wrapWithPersist
  let motionDisplay  = 0;
  let smoothedMotion = 0;

  let cameraDevices: MediaDeviceInfo[] = [];
  const cameraNames = (): string[] =>
    cameraDevices.length > 0
      ? cameraDevices.map((d, i) => d.label || `Camera ${i + 1}`)
      : ['Rear / External', 'Front'];

  let motionCamera: MotionCamera | null = null;
  const detector = new SpatialPatchinessDetector();
  let canvasRef: HTMLCanvasElement | null = null;
  let overlay: HTMLDivElement | null = null;

  // ── Identify the range controls to boost ──────────────────────────────────
  // Uses motionControlLabels if specified, otherwise falls back to first two.
  type RangeCtrl = PatternControl & { type: "range" };
  const allRangeControls = (pattern.controls ?? []).filter((c): c is RangeCtrl => c.type === "range");
  const firstTwoRange = pattern.motionControlLabels
    ? allRangeControls.filter((c) => pattern.motionControlLabels!.includes(c.label))
    : allRangeControls.slice(0, 2);

  // Base values (what the user dragged the slider to)
  const baseVals: number[]      = firstTwoRange.map((c) => c.get());
  // Effective values (base + boost, shown on sliders)
  const effectiveVals: number[] = [...baseVals];

  // ── Camera helpers ─────────────────────────────────────────────────────────
  async function refreshDeviceList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const all = devices.filter((d) => d.kind === 'videoinput');
      const labelled = all.filter((d) => d.label);
      cameraDevices = labelled.length > 0 ? labelled : all;
    } catch { /* ignore */ }
  }

  const onDeviceChange = () => { refreshDeviceList(); };

  function startCamera() {
    motionCamera?.dispose();
    motionCamera = null;
    if (!canvasRef) return;
    const device = cameraDevices[deviceIndex];
    const constraints: MediaStreamConstraints = {
      video: device
        ? { deviceId: { exact: device.deviceId }, width: { ideal: 320 }, height: { ideal: 180 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 180 } },
      audio: false,
    };
    overlay = showMotionOverlay(canvasRef, 'Requesting camera…');
    MotionCamera.createWithConstraints(canvasRef, constraints).then(async (cam) => {
      overlay?.remove();
      overlay = null;
      motionCamera = cam ?? null;
      if (cam) {
        await refreshDeviceList();
        navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
      }
    });
  }

  function enableCamera(on: boolean) {
    cameraEnabled = on;
    if (on) {
      startCamera();
    } else {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      motionCamera?.dispose();
      motionCamera = null;
      smoothedMotion = 0;
      motionDisplay  = 0;
      overlay?.remove();
      overlay = null;
      // Reset effective vals to base so sliders snap back
      for (let i = 0; i < firstTwoRange.length; i++) {
        effectiveVals[i] = baseVals[i];
        firstTwoRange[i].set(baseVals[i]);
      }
    }
  }

  // ── Build the wrapped controls list ────────────────────────────────────────
  // For the first two range controls: override get() → effectiveVal,
  //                                              set() → only updates baseVal.
  const wrappedPatternControls: PatternControl[] = (pattern.controls ?? []).map((ctrl) => {
    const idx = firstTwoRange.indexOf(ctrl as RangeCtrl);
    if (idx === -1) return ctrl;
    // Sync baseVal if wrapWithPersist has already restored a saved value
    baseVals[idx] = (ctrl as RangeCtrl).get();
    effectiveVals[idx] = baseVals[idx];
    return {
      ...ctrl,
      get: () => effectiveVals[idx],
      set: (v: number) => { baseVals[idx] = v; },
    } as RangeCtrl;
  });

  const motionControls: PatternControl[] = [
    {
      label: 'Motion Detection Camera',
      type:  'section',
      get: () => cameraEnabled,
      set: (v) => enableCamera(v),
    },
    {
      label: 'Motion Sensitivity',
      type: 'range', min: 0, max: 100, step: 1,
      get: () => sensitivity,
      set: (v) => { sensitivity = v; },
    },
    {
      label: 'Motion Level',
      type: 'range', min: 0, max: 100, step: 1,
      readonly: true,
      get: () => motionDisplay,
      set: () => {},
    },
    {
      label: 'Camera',
      type: 'select',
      options: cameraNames,
      get: () => deviceIndex,
      set: (v) => {
        deviceIndex = v;
        if (cameraEnabled) startCamera();
      },
    },
  ];

  // ── Wrapped pattern ────────────────────────────────────────────────────────
  return {
    ...pattern,
    controls: [...wrappedPatternControls, ...motionControls],

    init(ctx: PatternContext) {
      canvasRef = ctx.renderer.domElement;
      // Re-sync base vals in case wrapWithPersist set them before init
      for (let i = 0; i < firstTwoRange.length; i++) {
        baseVals[i] = firstTwoRange[i].get();
        effectiveVals[i] = baseVals[i];
      }
      pattern.init(ctx);
    },

    activate() {
      if (cameraEnabled) startCamera();
      pattern.activate?.();
    },

    update(dt: number, elapsed: number) {
      // ── Motion detection ─────────────────────────────────────────────────
      if (motionCamera) {
        const diff = motionCamera.tick();
        if (diff) {
          const raw = Math.min(detector.update(diff), 1.0);
          smoothedMotion = raw > smoothedMotion
            ? 0.90 * smoothedMotion + 0.10 * raw
            : 0.97 * smoothedMotion + 0.03 * raw;
        }
      }
      motionDisplay = Math.round(smoothedMotion * 100);

      // ── Boost first two controls ─────────────────────────────────────────
      // Linear formula calibrated so that:
      //   motionLevel 70 (smoothedMotion 0.7) at sensitivity 10 → +80 % of range
      //   0.7 × (10/10) × (8/7) = 0.800  ✓
      // Higher sensitivity multiplies the factor linearly; result is clamped at max.
      const scaledMotion = smoothedMotion * (sensitivity / 10) * (8 / 7);

      for (let i = 0; i < firstTwoRange.length; i++) {
        const ctrl = firstTwoRange[i];
        const range = ctrl.max - ctrl.min;
        const added = Math.min(scaledMotion * range, range);   // cap at full range
        const effective = Math.min(baseVals[i] + added, ctrl.max);
        effectiveVals[i] = effective;
        ctrl.set(effective);
      }

      pattern.update(dt, elapsed);
    },

    resize(width: number, height: number) {
      pattern.resize(width, height);
    },

    dispose() {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      motionCamera?.dispose();
      motionCamera = null;
      overlay?.remove();
      overlay = null;
      smoothedMotion = 0;
      canvasRef = null;
      // Restore base values so pattern's internal state is clean
      for (let i = 0; i < firstTwoRange.length; i++) {
        firstTwoRange[i].set(baseVals[i]);
      }
      pattern.dispose();
    },
  };
}
