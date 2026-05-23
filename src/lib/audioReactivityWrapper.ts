// Audio reactivity wrapper.
// Wraps any Pattern and boosts selected range controls in proportion to
// detected audio level or beat pulse. Both beat detectors run simultaneously;
// each has an independent on/off flag in audioState. Their pulses are tracked
// separately (energyBeat, fluxBeat) and combined into beat (max of both).

import type { Pattern, PatternControl, PatternContext } from './patterns/types';
import { audioState, enumerateMicrophones } from './globalAudioSettings.svelte';
import { BeatDetector } from './BeatDetector.svelte';
import { EnergyBeatDetector } from './EnergyBeatDetector.svelte';


const BAND_OPTIONS = ['Bass', 'Mid', 'High', 'Full'] as const;

function getLevel(dataArray: Uint8Array, band: number): number {
  let start: number, end: number;
  if (band === 0)      { start = 0;  end = 3;  }
  else if (band === 1) { start = 4;  end = 20; }
  else if (band === 2) { start = 21; end = 40; }
  else                 { start = 0;  end = 127; }
  let sum = 0;
  for (let i = start; i <= end; i++) sum += dataArray[i];
  return sum / ((end - start + 1) * 255);
}

export { BAND_OPTIONS };

const BEAT_DECAY = 0.82;

export function addAudioReactivity(pattern: Pattern): Pattern {
  let smoothed           = 0;
  let energyBeatPulse    = 0;   // decaying pulse from Energy Ratio detector
  let fluxBeatPulse      = 0;   // decaying pulse from Spectral Flux detector
  let prevEnabled        = false;
  let prevDeviceId       = '';
  let prevPatternEnabled = true;

  // Lightweight analyser for smoothed-level display only
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let stream: MediaStream | null = null;
  let dataArray: Uint8Array | null = null;

  // Both detectors always instantiated; both start with the same stream.
  // onBeat callbacks only register a pulse if the detector is enabled.
  const energyDetector = new EnergyBeatDetector();
  const fluxDetector   = new BeatDetector();
  energyDetector.onBeat = () => { if (audioState.energyEnabled) energyBeatPulse = 1.0; };
  fluxDetector.onBeat   = () => { if (audioState.fluxEnabled)   fluxBeatPulse   = 1.0; };

  type RangeCtrl = PatternControl & { type: 'range' };
  const allRangeControls = (pattern.controls ?? []).filter((c): c is RangeCtrl => c.type === 'range');

  const audioTargets = pattern.audioControlLabels
    ? allRangeControls.filter(c => pattern.audioControlLabels!.includes(c.label))
    : pattern.motionControlLabels
      ? allRangeControls.filter(c => pattern.motionControlLabels!.includes(c.label))
      : allRangeControls.slice(0, 2);

  const baseVals: number[]      = audioTargets.map(c => c.get());
  const effectiveVals: number[] = [...baseVals];

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

      // Both detectors get the same stream; both run in parallel
      energyDetector.sensitivity = audioState.beatSensitivity;
      fluxDetector.sensitivity   = audioState.beatSensitivity;
      energyDetector.start(stream);
      fluxDetector.start(stream);

      await enumerateMicrophones();
    } catch (e) {
      console.warn('[audio] microphone access denied:', e);
      audioState.enabled = false;
    }
  }

  function stopAudio() {
    energyDetector.stop();
    fluxDetector.stop();
    source?.disconnect();
    analyser?.disconnect();
    audioCtx?.close();
    stream?.getTracks().forEach(t => t.stop());
    source = null; analyser = null; audioCtx = null; stream = null; dataArray = null;
    smoothed = 0;
    energyBeatPulse = 0;
    fluxBeatPulse   = 0;
    audioState.level      = 0;
    audioState.beat       = 0;
    audioState.energyBeat = 0;
    audioState.fluxBeat   = 0;
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
      const nowEnabled        = audioState.enabled;
      const nowDeviceId       = audioState.deviceId;
      const nowPatternEnabled = audioState.patternAudioEnabled[pattern.id] ?? true;
      const shouldRun     = nowEnabled && nowPatternEnabled;
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

      // Sync sensitivity to both detectors
      if (energyDetector.isRunning) energyDetector.sensitivity = audioState.beatSensitivity;
      if (fluxDetector.isRunning)   fluxDetector.sensitivity   = audioState.beatSensitivity;

      // Smoothed level for level display
      if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
        const raw = getLevel(dataArray, audioState.bandIndex);
        smoothed = raw > smoothed
          ? 0.3 * smoothed + 0.7 * raw
          : 0.7 * smoothed + 0.3 * raw;
      }
      audioState.level = Math.round(smoothed * 100);

      // Decay both pulses every frame
      energyBeatPulse *= BEAT_DECAY;
      fluxBeatPulse   *= BEAT_DECAY;

      // Publish per-detector readouts (zero if that detector is disabled)
      audioState.energyBeat = audioState.energyEnabled ? Math.round(energyBeatPulse * 100) : 0;
      audioState.fluxBeat   = audioState.fluxEnabled   ? Math.round(fluxBeatPulse   * 100) : 0;

      // Combined beat: max of whichever detectors are enabled
      const combinedPulse = Math.max(
        audioState.energyEnabled ? energyBeatPulse : 0,
        audioState.fluxEnabled   ? fluxBeatPulse   : 0,
      );
      audioState.beat = Math.round(combinedPulse * 100);

      // Choose signal: combined beat or smoothed level
      const active = analyser && dataArray;
      const signal = active ? (audioState.beatMode ? combinedPulse : smoothed) : 0;

      // Boost controls
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
