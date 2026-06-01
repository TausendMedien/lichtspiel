// Audio reactivity wrapper — mirrors motionCameraWrapper.ts.
// Wraps any Pattern, appends Audio Reactivity controls, and boosts the
// first two range controls in proportion to detected audio level.

import type { Pattern, PatternControl, PatternContext } from './patterns/types';

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

export function addAudioReactivity(pattern: Pattern): Pattern {
  let sensitivity   = 10;
  let audioEnabled  = false;
  let bandIndex     = 0;  // 0=Bass 1=Mid 2=High 3=Full
  let audioDisplay  = 0;
  let smoothed      = 0;

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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch (e) {
      console.warn('[audio] microphone access denied:', e);
      audioEnabled = false;
    }
  }

  function stopAudio() {
    source?.disconnect();
    analyser?.disconnect();
    audioCtx?.close();
    stream?.getTracks().forEach(t => t.stop());
    source = null; analyser = null; audioCtx = null; stream = null; dataArray = null;
    smoothed = 0; audioDisplay = 0;
    for (let i = 0; i < firstTwoRange.length; i++) {
      effectiveVals[i] = baseVals[i];
      firstTwoRange[i].set(baseVals[i]);
    }
  }

  function enableAudio(on: boolean) {
    audioEnabled = on;
    if (on) startAudio();
    else stopAudio();
  }

  const wrappedPatternControls: PatternControl[] = (pattern.controls ?? []).map(ctrl => {
    const idx = firstTwoRange.indexOf(ctrl as RangeCtrl);
    if (idx === -1) return ctrl;
    baseVals[idx] = (ctrl as RangeCtrl).get();
    effectiveVals[idx] = baseVals[idx];
    return {
      ...ctrl,
      get: () => effectiveVals[idx],
      set: (v: number) => { baseVals[idx] = v; },
    } as RangeCtrl;
  });

  const audioControls: PatternControl[] = [
    {
      label: 'Audio Reactivity',
      type: 'section',
      get: () => audioEnabled,
      set: v => enableAudio(v),
    },
    {
      label: 'Audio Sensitivity',
      type: 'range', min: 0, max: 100, step: 1,
      get: () => sensitivity,
      set: v => { sensitivity = v; },
    },
    {
      label: 'Frequency Band',
      type: 'select',
      options: [...BAND_OPTIONS],
      get: () => bandIndex,
      set: v => { bandIndex = v; },
    },
    {
      label: 'Audio Level',
      type: 'range', min: 0, max: 100, step: 1,
      readonly: true,
      get: () => audioDisplay,
      set: () => {},
    },
  ];

  return {
    ...pattern,
    controls: [...wrappedPatternControls, ...audioControls],

    init(ctx: PatternContext) {
      for (let i = 0; i < firstTwoRange.length; i++) {
        baseVals[i] = firstTwoRange[i].get();
        effectiveVals[i] = baseVals[i];
      }
      pattern.init(ctx);
      if (audioEnabled) startAudio();
    },

    update(dt: number, elapsed: number) {
      if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
        const raw = getLevel(dataArray, bandIndex);
        smoothed = raw > smoothed
          ? 0.85 * smoothed + 0.15 * raw
          : 0.97 * smoothed + 0.03 * raw;
      }
      audioDisplay = Math.round(smoothed * 100);

      const scaled = smoothed * (sensitivity / 10) * (8 / 7);
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
