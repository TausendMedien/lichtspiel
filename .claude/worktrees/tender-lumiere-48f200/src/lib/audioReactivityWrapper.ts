// Audio reactivity wrapper.
// Wraps any Pattern and boosts the first two range controls in proportion to
// detected audio level. Audio settings (enable, microphone, sensitivity, band)
// come from the global Options menu via globalAudioSettings.svelte.ts — no
// controls are added to the pattern's own controls list.

import type { Pattern, PatternControl, PatternContext } from './patterns/types';
import { audioState, enumerateMicrophones } from './globalAudioSettings.svelte';

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

export function addAudioReactivity(pattern: Pattern): Pattern {
  let smoothed     = 0;
  let prevEnabled  = false;
  let prevDeviceId = '';

  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let stream: MediaStream | null = null;
  let dataArray: Uint8Array | null = null;

  type RangeCtrl = PatternControl & { type: 'range' };
  const allRangeControls = (pattern.controls ?? []).filter((c): c is RangeCtrl => c.type === 'range');
  const firstTwoRange = pattern.motionControlLabels
    ? allRangeControls.filter(c => pattern.motionControlLabels!.includes(c.label))
    : allRangeControls.slice(0, 2);

  const baseVals: number[]      = firstTwoRange.map(c => c.get());
  const effectiveVals: number[] = [...baseVals];

  async function startAudio() {
    stopAudio();
    try {
      const deviceId = audioState.deviceId;
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false,
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      await enumerateMicrophones();
    } catch (e) {
      console.warn('[audio] microphone access denied:', e);
      audioState.enabled = false;
    }
  }

  function stopAudio() {
    source?.disconnect();
    analyser?.disconnect();
    audioCtx?.close();
    stream?.getTracks().forEach(t => t.stop());
    source = null; analyser = null; audioCtx = null; stream = null; dataArray = null;
    smoothed = 0;
    audioState.level = 0;
    for (let i = 0; i < firstTwoRange.length; i++) {
      effectiveVals[i] = baseVals[i];
      firstTwoRange[i].set(baseVals[i]);
    }
  }

  return {
    ...pattern,
    // Pass through the pattern's own controls unchanged — no audio controls added
    controls: pattern.controls,

    init(ctx: PatternContext) {
      for (let i = 0; i < firstTwoRange.length; i++) {
        baseVals[i] = firstTwoRange[i].get();
        effectiveVals[i] = baseVals[i];
      }
      prevEnabled  = audioState.enabled;
      prevDeviceId = audioState.deviceId;
      pattern.init(ctx);
      if (audioState.enabled) startAudio();
    },

    update(dt: number, elapsed: number) {
      // React to global enable/device changes
      const nowEnabled  = audioState.enabled;
      const nowDeviceId = audioState.deviceId;
      if (nowEnabled !== prevEnabled) {
        prevEnabled = nowEnabled;
        if (nowEnabled) startAudio();
        else stopAudio();
      } else if (nowEnabled && nowDeviceId !== prevDeviceId) {
        prevDeviceId = nowDeviceId;
        startAudio();
      }
      prevDeviceId = nowDeviceId;

      // Read audio level
      if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
        const raw = getLevel(dataArray, audioState.bandIndex);
        smoothed = raw > smoothed
          ? 0.85 * smoothed + 0.15 * raw
          : 0.97 * smoothed + 0.03 * raw;
      }
      audioState.level = Math.round(smoothed * 100);

      // Boost first two controls
      const scaled = smoothed * (audioState.sensitivity / 10) * (8 / 7);
      for (let i = 0; i < firstTwoRange.length; i++) {
        const ctrl = firstTwoRange[i];
        const range = ctrl.max - ctrl.min;
        const added = Math.min(scaled * range, range);
        effectiveVals[i] = Math.min(baseVals[i] + added, ctrl.max);
        ctrl.set(effectiveVals[i]);
      }

      pattern.update(dt, elapsed);
    },

    resize(w: number, h: number) { pattern.resize(w, h); },

    dispose() {
      stopAudio();
      for (let i = 0; i < firstTwoRange.length; i++) firstTwoRange[i].set(baseVals[i]);
      pattern.dispose();
    },
  };
}
