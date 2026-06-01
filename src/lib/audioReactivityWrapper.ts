// Audio reactivity wrapper.
// Wraps any Pattern and:
//  1. Boosts selected range controls in proportion to detected audio level or
//     beat pulse (existing behaviour, driven by audioControlLabels).
//  2. Drives the Tier 1 universal Brightness: loud audio → brightnessMult > 1.0,
//     written to interactionState.brightnessMult for the renderer to apply.
//  3. Appends a Brightness sub-section to the existing "Interactions" section
//     (or creates it if the motion wrapper wasn't applied to this pattern).

import type { Pattern, PatternControl, PatternContext } from './patterns/types';
import { audioState, enumerateMicrophones } from './globalAudioSettings.svelte';
import { BeatDetector } from './BeatDetector.svelte';
import { EnergyBeatDetector } from './EnergyBeatDetector.svelte';
import { interactionState, getPatternSettings, saveInteractionSettings } from './interactionState.svelte';
import { privacyMode } from './privacyMode.svelte';


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
  let gateOpenAmount     = 1;   // 0=gated (silent), 1=fully open
  let noiseFloor         = 0;   // slow-tracking background RMS
  let prevEnabled        = false;
  let prevDeviceId       = '';
  let prevPatternEnabled = true;

  // ── Brightness interaction controls ─────────────────────────────────────
  function ps() { return getPatternSettings(pattern.id); }

  // Only add the "Interactions" section header if the motion wrapper hasn't
  // already added one (motion wrapper adds it for all motion-reactive patterns).
  const hasInteractionsSeparator = (pattern.controls ?? []).some(
    c => c.type === 'separator' && c.label === 'Interactions'
  );

  // Brightness is always active when audio is enabled — no toggle needed.
  const brightnessControls: PatternControl[] = hasInteractionsSeparator ? [] : [{
    label: 'Interactions',
    type:  'separator' as const,
  }] as PatternControl[];

  // Lightweight analyser for smoothed-level display only
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let stream: MediaStream | null = null;
  let dataArray: Uint8Array | null = null;
  let timeDomainArray: Uint8Array | null = null;

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

  const wrappedControls: PatternControl[] = [
    ...(pattern.controls ?? []).map((ctrl) => {
      const idx = audioTargets.indexOf(ctrl as RangeCtrl);
      if (idx === -1) return ctrl;
      baseVals[idx] = (ctrl as RangeCtrl).get();
      effectiveVals[idx] = baseVals[idx];
      return {
        ...ctrl,
        get: () => effectiveVals[idx],
        set: (v: number) => { baseVals[idx] = v; effectiveVals[idx] = v; },
      } as RangeCtrl;
    }),
    ...brightnessControls,
  ];

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
      timeDomainArray = new Uint8Array(analyser.fftSize);
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
    source = null; analyser = null; audioCtx = null; stream = null;
    dataArray = null; timeDomainArray = null;
    smoothed = 0;
    energyBeatPulse = 0;
    fluxBeatPulse   = 0;
    gateOpenAmount  = 1;
    noiseFloor      = 0;
    audioState.level      = 0;
    audioState.beat       = 0;
    audioState.energyBeat = 0;
    audioState.fluxBeat   = 0;
    interactionState.brightnessMult = 1.0;
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
      const shouldRun     = nowEnabled && nowPatternEnabled && !privacyMode.active;
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

      // Smoothed level + RMS for gate
      if (analyser && dataArray && timeDomainArray) {
        analyser.getByteFrequencyData(dataArray);
        const raw = getLevel(dataArray, audioState.bandIndex);
        smoothed = raw > smoothed
          ? 0.3 * smoothed + 0.7 * raw
          : 0.7 * smoothed + 0.3 * raw;

        // Compute RMS from time-domain waveform for accurate silence detection
        analyser.getByteTimeDomainData(timeDomainArray);
        let sum = 0;
        for (let i = 0; i < timeDomainArray.length; i++) {
          const s = (timeDomainArray[i] - 128) / 128;
          sum += s * s;
        }
        const rms = Math.sqrt(sum / timeDomainArray.length);
        noiseFloor = noiseFloor * 0.995 + rms * 0.005; // ~30s slow tracking

        // Gate: smoothstep from threshold to 2.5× threshold → 0..1
        const threshold = (audioState.noiseGate / 100) * 0.3;
        if (threshold < 0.001) {
          gateOpenAmount = 1;
        } else {
          const t = Math.max(0, Math.min(1, (rms - threshold) / (threshold * 1.5)));
          gateOpenAmount = t * t * (3 - 2 * t);
        }
      }
      audioState.level = Math.round(smoothed * gateOpenAmount * 100);

      // Decay both pulses every frame, then apply gate
      energyBeatPulse *= BEAT_DECAY;
      fluxBeatPulse   *= BEAT_DECAY;
      const gatedEnergyPulse = energyBeatPulse * gateOpenAmount;
      const gatedFluxPulse   = fluxBeatPulse   * gateOpenAmount;

      // Publish per-detector readouts (zero if that detector is disabled)
      audioState.energyBeat = audioState.energyEnabled ? Math.round(gatedEnergyPulse * 100) : 0;
      audioState.fluxBeat   = audioState.fluxEnabled   ? Math.round(gatedFluxPulse   * 100) : 0;

      // Combined beat: max of whichever detectors are enabled
      const combinedPulse = Math.max(
        audioState.energyEnabled ? gatedEnergyPulse : 0,
        audioState.fluxEnabled   ? gatedFluxPulse   : 0,
      );
      audioState.beat = Math.round(combinedPulse * 100);

      // Choose signal: combined beat or smoothed gated level
      const active = analyser && dataArray;
      const signal = active ? (audioState.beatMode ? combinedPulse : smoothed * gateOpenAmount) : 0;

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

      // ── Tier 1: Universal Brightness (audio level → brighter) ────────────
      const settings = getPatternSettings(pattern.id);
      if (audioState.enabled) {
        const gain = settings.brightnessGain;
        const str  = interactionState.strength;
        // Use gated smoothed level for brightness — more sustained and less jarring
        interactionState.brightnessMult = 1.0 + smoothed * gateOpenAmount * gain * str * 1.5;
      } else {
        // Decay gently back to 1.0 when disabled or audio is off
        interactionState.brightnessMult += (1.0 - interactionState.brightnessMult) * 0.1;
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
