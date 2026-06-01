/**
 * BeatDetector — multi-band spectral-flux onset detection with adaptive threshold.
 *
 * Works for music (kick drums in a dense mix) as well as percussive events
 * (clapping, hand drums). Unlike simple energy comparators it tracks each
 * frequency band's own baseline, so a kick drum creates a clear flux spike
 * in the sub-bass band even when overall level is already high.
 *
 * Usage:
 *
 *   const bd = new BeatDetector();
 *   bd.onBeat = (bpm) => console.log('beat at', bpm, 'BPM');
 *   bd.sensitivity = 1.5;   // 1.0 = sensitive, 3.0 = only strong beats
 *
 *   navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
 *     bd.start(stream);
 *   });
 *
 *   // Later:
 *   bd.stop();
 *
 * `sensitivity` and `isRunning` are Svelte 5 $state fields and can be
 * bound reactively in .svelte files.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ─── BeatDetector ─────────────────────────────────────────────────────────────

const ODF_HISTORY     = 43;   // adaptive threshold window (~1.4 s at 30 fps)
const BEAT_HISTORY    = 8;    // timestamps kept for BPM estimation
const MIN_BEAT_GAP    = 200;  // ms debounce between triggers
// Absolute floor: prevents adaptive threshold from triggering on pure noise.
// Flux is summed byte differences (0–255 per bin) across three bands.
// Fan/room noise produces near-zero flux; any real transient far exceeds this.
const ABS_ODF_FLOOR   = 80;

export class BeatDetector {
  // Svelte 5 reactive fields — writable from outside, readable reactively
  sensitivity = $state(1.5);  // threshold multiplier, 1.0–3.0
  isRunning   = $state(false);

  /** Called on every detected beat with the estimated BPM. Set from outside. */
  onBeat: (bpm: number) => void = () => {};

  // Audio graph
  private audioCtx : AudioContext                  | null = null;
  private compressor: DynamicsCompressorNode       | null = null;
  private analyser  : AnalyserNode                 | null = null;
  private source    : MediaStreamAudioSourceNode   | null = null;
  private rafId     : number                             = 0;

  // DSP state
  private fftData     : Uint8Array = new Uint8Array(0);
  private prevMag     : Uint8Array = new Uint8Array(0);
  private odfHistory  : number[]     = [];
  private beatTs      : number[]     = [];
  private lastBeatTime: number       = -Infinity;

  // Band boundaries (bin indices, set at runtime from actual sample rate)
  private subBassStart = 0; private subBassEnd = 0;
  private bassStart    = 0; private bassEnd    = 0;
  private midStart     = 0; private midEnd     = 0;

  start(stream: MediaStream): void {
    this.stop();  // clean up any previous run

    this.audioCtx = new AudioContext();
    const ctx = this.audioCtx;

    // Dynamics compressor — prevents ADC clipping on loud line-in signals
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value      = 30;
    this.compressor.ratio.value     = 12;
    this.compressor.attack.value    = 0.003;
    this.compressor.release.value   = 0.25;

    // Analyser — no smoothing so flux differences are clean per-frame
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize                = 2048;
    this.analyser.smoothingTimeConstant  = 0.0;

    this.source = ctx.createMediaStreamSource(stream);
    this.source.connect(this.compressor);
    this.compressor.connect(this.analyser);
    // Do NOT connect to destination — we don't want to monitor the mic

    const binCount = this.analyser.frequencyBinCount;  // 1024
    this.fftData = new Uint8Array(binCount);
    this.prevMag = new Uint8Array(binCount);

    // Compute band boundaries from actual sample rate
    const sr         = ctx.sampleRate;
    const binWidth   = sr / this.analyser.fftSize;  // Hz per bin
    const hz2bin     = (hz: number) => Math.round(hz / binWidth);

    this.subBassStart = hz2bin(40);   this.subBassEnd = hz2bin(120);
    this.bassStart    = hz2bin(120);  this.bassEnd    = hz2bin(250);
    this.midStart     = hz2bin(250);  this.midEnd     = hz2bin(2000);

    // Reset DSP state
    this.odfHistory   = [];
    this.beatTs       = [];
    this.lastBeatTime = -Infinity;
    this.prevMag.fill(0);

    this.isRunning = true;
    this.rafId = requestAnimationFrame(this._poll);
  }

  stop(): void {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.source?.disconnect();
    this.compressor?.disconnect();
    this.analyser?.disconnect();
    this.audioCtx?.close();
    this.source     = null;
    this.compressor = null;
    this.analyser   = null;
    this.audioCtx   = null;
    this.isRunning  = false;
  }

  // ── Inner loop ──────────────────────────────────────────────────────────────

  private _poll = (): void => {
    if (!this.analyser || !this.audioCtx) return;

    this.rafId = requestAnimationFrame(this._poll);
    this.analyser.getByteFrequencyData(this.fftData);

    // Compute per-band spectral flux (half-wave rectified)
    const subFlux = this._bandFlux(this.subBassStart, this.subBassEnd);
    const basFlux = this._bandFlux(this.bassStart,    this.bassEnd);
    const midFlux = this._bandFlux(this.midStart,     this.midEnd);
    const odf     = subFlux + basFlux + midFlux;

    // Update previous magnitudes
    for (let i = 0; i < this.fftData.length; i++) {
      this.prevMag[i] = this.fftData[i];
    }

    // Adaptive threshold via median of recent ODF values
    this.odfHistory.push(odf);
    if (this.odfHistory.length > ODF_HISTORY) this.odfHistory.shift();
    const threshold = median(this.odfHistory) * this.sensitivity;

    // Beat trigger with debounce — must exceed both adaptive and absolute floor
    const now = performance.now();
    if (odf > threshold && odf > ABS_ODF_FLOOR && (now - this.lastBeatTime) > MIN_BEAT_GAP) {
      this.lastBeatTime = now;
      this.beatTs.push(now);
      if (this.beatTs.length > BEAT_HISTORY) this.beatTs.shift();
      this.onBeat(this._estimateBpm());
    }
  };

  private _bandFlux(startBin: number, endBin: number): number {
    let flux = 0;
    for (let i = startBin; i <= endBin; i++) {
      const diff = this.fftData[i] - this.prevMag[i];
      if (diff > 0) flux += diff;
    }
    return flux;
  }

  private _estimateBpm(): number {
    if (this.beatTs.length < 2) return 120;
    const intervals: number[] = [];
    for (let i = 1; i < this.beatTs.length; i++) {
      intervals.push(this.beatTs[i] - this.beatTs[i - 1]);
    }
    const medInterval = median(intervals);
    return Math.round(clamp(60000 / medInterval, 60, 200));
  }
}
