// Audio reactivity wrapper.
// Wraps any Pattern and boosts selected range controls in proportion to
// detected audio level or beat pulse. Audio settings (enable, microphone,
// sensitivity, band, beat mode) come from the global Options menu via
// globalAudioSettings.svelte.ts — no controls are added to the pattern's
// own controls list.
//
// Beat detection is delegated to BeatDetector (multi-band spectral flux).
// The wrapper keeps its own lightweight AnalyserNode solely for the
// smoothed-level display in the HUD.

import type { Pattern, PatternControl, PatternContext } from './patterns/types';
import { audioState, enumerateMicrophones } from './globalAudioSettings.svelte';
import { BeatDetector } from './BeatDetector.svelte';


const BAND_OPTIONS = ['Bass', 'Mid', 'High', 'Full'] as const;

function getLevel(dataArray: Uint8Array, band: number): number {
  // fftSize 256 → 128 bins; at 48kHz each bin ≈ 375Hz
  // Bass: bins 0–3 (0–1.5kHz), Mid: 4–20, High: 21–40, Full: all 128
  let start: number, end: number;
  if (band === 0)      { start = 0;  end = 3;  }  // Bass
  else if (band === 1) { start = 4;  end = 20; }  // Mid
  else if (band === 2) { start = 21; end = 40; }  // High
  else                 { start = 0;  end = 127; } // Full
  let sum = 0;
  for (let i = start; i <= end; i++) sum += dataArray[i];
  return sum / ((end - start + 1) * 255);
}

export { BAND_OPTIONS };

const BEAT_DECAY = 0.82;  // beat pulse half-life ≈ 8 frames at 30fps

export function addAudioReactivity(pattern: Pattern): Pattern {
  let smoothed            = 0;
  let beatPulse           = 0;
  let prevEnabled         = false;
  let prevDeviceId        = '';
  let prevPatternEnabled  = true;

  // Lightweight analyser for smoothed-level display only
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let stream: MediaStream | null = null;
  let dataArray: Uint8Array | null = null;

  // Multi-band spectral-flux beat detector
  const beatDetector = new BeatDetector();
  beatDetector.onBeat = () => { beatPulse = 1.0; };

  type RangeCtrl = PatternControl & { type: 'range' };
  const allRangeControls = (pattern.controls ?? []).filter((c): c is RangeCtrl => c.type === 'range');

  // Prefer explicit audioControlLabels, then motionControlLabels, then first two
  const audioTargets = pattern.audioControlLabels
    ? allRangeControls.filter(c => pattern.audioControlLabels!.includes(c.label))
    : pattern.motionControlLabels
      ? allRangeControls.filter(c => pattern.motionControlLabels!.includes(c.label))
      : allRangeControls.slice(0, 2);

  const baseVals: number[]      = audioTargets.map(c => c.get());
  const effectiveVals: number[] = [...baseVals];

  // Wrap the boosted controls so user drags update baseVals only;
  // the actual pattern value is written by update() using effectiveVals.
  const wrappedControls: PatternControl[] = (pattern.controls ?? []).map((ctrl) => {
    const idx = audioTargets.indexOf(ctrl as RangeCtrl);
    if (idx === -1) return ctrl;
    baseVals[idx] = (ctrl as RangeCtrl).get();
    effectiveVals[idx] = baseVals[idx];
    return {
      ...ctrl,
      get: () => (ctrl as RangeCtrl).get(),
      set: (v: number) => { baseVals[idx] = v; effectiveVals[idx] = v; },
    } as RangeCtrl;
  });

  async function startAudio() {
    stopAudio();
    try {
      const deviceId = audioState.deviceId;
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false,
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Lightweight analyser for level display
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      // Beat detector — gets same stream, manages its own AudioContext
      beatDetector.sensitivity = audioState.beatSensitivity;
      beatDetector.start(stream);

      await enumerateMicrophones();
    } catch (e) {
      console.warn('[audio] microphone access denied:', e);
      audioState.enabled = false;
    }
  }

  function stopAudio() {
    beatDetector.stop();
    source?.disconnect();
    analyser?.disconnect();
    audioCtx?.close();
    stream?.getTracks().forEach(t => t.stop());
    source = null; analyser = null; audioCtx = null; stream = null; dataArray = null;
    smoothed = 0;
    beatPulse = 0;
    audioState.level = 0;
    audioState.beat  = 0;
    for (let i = 0; i < audioTargets.length; i++) {
      effectiveVals[i] = baseVals[i];
      audioTargets[i].set(baseVals[i]);
    }
  }

  return {
    ...pattern,
    audioReactive: true,
    controls: wrappedControls,

    init(ctx: PatternContext) {
      for (let i = 0; i < audioTargets.length; i++) {
        baseVals[i] = audioTargets[i].get();
        effectiveVals[i] = baseVals[i];
      }
      prevEnabled        = audioState.enabled;
      prevDeviceId       = audioState.deviceId;
      prevPatternEnabled = audioState.patternAudioEnabled[pattern.id] ?? true;
      pattern.init(ctx);
      if (audioState.enabled && prevPatternEnabled) startAudio();
    },

    update(dt: number, elapsed: number) {
      // React to global enable/device changes and per-pattern toggle
      const nowEnabled        = audioState.enabled;
      const nowDeviceId       = audioState.deviceId;
      const nowPatternEnabled = audioState.patternAudioEnabled[pattern.id] ?? true;
      const shouldRun = nowEnabled && nowPatternEnabled;
      const prevShouldRun = prevEnabled && prevPatternEnabled;
      if (shouldRun !== prevShouldRun) {
        if (shouldRun) startAudio();
        else stopAudio();
      } else if (shouldRun && nowDeviceId !== prevDeviceId) {
        startAudio();
      }
      prevEnabled        = nowEnabled;
      prevDeviceId       = nowDeviceId;
      prevPatternEnabled = nowPatternEnabled;

      // Keep beat detector sensitivity in sync with HUD slider
      if (beatDetector.isRunning) {
        beatDetector.sensitivity = audioState.beatSensitivity;
      }

      // Smoothed level (for level display and non-beat mode)
      if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
        const raw = getLevel(dataArray, audioState.bandIndex);
        smoothed = raw > smoothed
          ? 0.3 * smoothed + 0.7 * raw
          : 0.7 * smoothed + 0.3 * raw;
      }
      audioState.level = Math.round(smoothed * 100);

      // Beat pulse — set to 1.0 by beatDetector.onBeat callback, decays here
      beatPulse *= BEAT_DECAY;
      audioState.beat = Math.round(beatPulse * 100);

      // Choose signal: beat pulse (sharp transient) or smoothed level (sustained)
      const active = analyser && dataArray;
      const signal = active ? (audioState.beatMode ? beatPulse : smoothed) : 0;

      // Boost controls — respecting per-control audioWeight (default 1.0)
      const scaled = signal * (audioState.sensitivity / 100);
      for (let i = 0; i < audioTargets.length; i++) {
        const ctrl = audioTargets[i];
        const range = ctrl.max - ctrl.min;
        const weight = (ctrl as RangeCtrl & { audioWeight?: number }).audioWeight ?? 1.0;
        const added = Math.min(scaled * range * weight, range * weight);
        effectiveVals[i] = Math.min(baseVals[i] + added, ctrl.max);
        audioTargets[i].set(effectiveVals[i]);
      }

      pattern.update(dt, elapsed);
    },

    resize(w: number, h: number) { pattern.resize(w, h); },

    dispose() {
      stopAudio();
      for (let i = 0; i < audioTargets.length; i++) audioTargets[i].set(baseVals[i]);
      pattern.dispose();
    },
  };
}
