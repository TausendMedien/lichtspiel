/**
 * EnergyBeatDetector — bass-band energy-ratio beat detection.
 *
 * Algorithm identical to the reference beat_detection_interactive.html:
 * - getFloatFrequencyData with smoothingTimeConstant 0.8 (stable, not raw frames)
 * - Focus on a single bass band (default 60–180 Hz, covers kick drum)
 * - Convert dB values: energy = Σ (dB + 140)² per bin, normalised by bin count
 * - Rolling mean of last N energy values (default N=43, ~1.4 s at 30 fps)
 * - Beat when currentEnergy / meanEnergy > sensitivity AND 200 ms since last beat
 * - BPM from median of recent inter-beat intervals
 *
 * Same API as BeatDetector.svelte.ts — drop-in swap.
 *
 * Usage:
 *   const d = new EnergyBeatDetector();
 *   d.onBeat = (bpm) => console.log(bpm);
 *   d.sensitivity = 1.4;
 *   navigator.mediaDevices.getUserMedia({ audio: true }).then(s => d.start(s));
 */

const ENERGY_HISTORY = 43;   // rolling mean window
const MIN_BEAT_GAP   = 200;  // ms debounce
const TS_WINDOW      = 8000; // ms — keep timestamps for BPM estimate
const FFT_SIZE       = 2048;

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

export class EnergyBeatDetector {
  sensitivity = $state(1.5);  // ratio threshold: 1.1 = very sensitive, 2.5 = only loud beats
  bassLow     = $state(60);   // Hz — lower edge of detection band
  bassHigh    = $state(180);  // Hz — upper edge of detection band
  isRunning   = $state(false);

  onBeat: (bpm: number) => void = () => {};

  private audioCtx  : AudioContext               | null = null;
  private analyser  : AnalyserNode               | null = null;
  private source    : MediaStreamAudioSourceNode | null = null;
  private rafId     : number                           = 0;

  private fftData      : Float32Array = new Float32Array(0);
  private energyHistory: number[]     = [];
  private beatTs       : number[]     = [];
  private lastBeatTime : number       = -Infinity;
  private sampleRate   : number       = 44100;

  start(stream: MediaStream): void {
    this.stop();

    this.audioCtx   = new AudioContext();
    this.sampleRate = this.audioCtx.sampleRate;

    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize               = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.8;  // key: smoothed energy, not raw frames

    this.source = this.audioCtx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);

    this.fftData       = new Float32Array(this.analyser.frequencyBinCount);
    this.energyHistory = [];
    this.beatTs        = [];
    this.lastBeatTime  = -Infinity;

    this.isRunning = true;
    this.rafId = requestAnimationFrame(this._poll);
  }

  stop(): void {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.audioCtx?.close();
    this.source    = null;
    this.analyser  = null;
    this.audioCtx  = null;
    this.isRunning = false;
  }

  private _hz2bin(hz: number): number {
    return Math.round(hz / (this.sampleRate / FFT_SIZE));
  }

  private _poll = (): void => {
    if (!this.analyser) return;
    this.rafId = requestAnimationFrame(this._poll);

    this.analyser.getFloatFrequencyData(this.fftData);

    // Bass-band energy: Σ (dB + 140)² — dB range is roughly −140..0, so +140 shifts to 0..140
    const lo = this._hz2bin(this.bassLow);
    const hi = this._hz2bin(this.bassHigh);
    let sum = 0;
    for (let i = lo; i <= hi; i++) {
      const v = this.fftData[i] + 140;
      if (v > 0) sum += v * v;
    }
    const energy = sum / (hi - lo + 1);

    // Rolling mean
    this.energyHistory.push(energy);
    if (this.energyHistory.length > ENERGY_HISTORY) this.energyHistory.shift();
    const mean = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;

    // Beat trigger
    const now   = performance.now();
    const ratio = mean > 0 ? energy / mean : 0;
    if (ratio > this.sensitivity && (now - this.lastBeatTime) > MIN_BEAT_GAP) {
      this.lastBeatTime = now;
      this.beatTs.push(now);
      // Keep only timestamps within the BPM estimation window
      const cutoff = now - TS_WINDOW;
      while (this.beatTs.length > 0 && this.beatTs[0] < cutoff) this.beatTs.shift();
      this.onBeat(this._estimateBpm());
    }
  };

  private _estimateBpm(): number {
    if (this.beatTs.length < 2) return 120;
    const intervals: number[] = [];
    for (let i = 1; i < this.beatTs.length; i++) {
      intervals.push(this.beatTs[i] - this.beatTs[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    const med = intervals[Math.floor(intervals.length / 2)];
    return Math.round(clamp(60000 / med, 60, 200));
  }
}
