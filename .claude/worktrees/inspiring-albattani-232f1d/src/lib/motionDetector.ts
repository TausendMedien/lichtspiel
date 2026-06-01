// Motion detection from webcam feed.
// Separates "person motion" from background pattern motion using three algorithms.

const W = 160;
const H = 90;
const GRID_COLS = 8;
const GRID_ROWS = 5;

export function showMotionOverlay(canvas: HTMLCanvasElement, message: string): HTMLDivElement {
  const div = document.createElement("div");
  div.style.cssText = [
    "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;",
    "color:#fff;font-family:sans-serif;font-size:16px;text-align:center;",
    "pointer-events:none;white-space:pre-line;padding:24px;background:rgba(0,0,0,0.55);",
  ].join("");
  div.textContent = message;
  canvas.parentElement?.appendChild(div);
  return div;
}

// ─── Camera capture ───────────────────────────────────────────────────────────

export class MotionCamera {
  readonly video: HTMLVideoElement;
  private stream: MediaStream;
  private offCanvas: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private prevLuma: Float32Array | null = null;
  private lastVideoTime = -1;

  private constructor(video: HTMLVideoElement, stream: MediaStream) {
    this.video = video;
    this.stream = stream;
    this.offCanvas = document.createElement("canvas");
    this.offCanvas.width = W;
    this.offCanvas.height = H;
    this.offCtx = this.offCanvas.getContext("2d", { willReadFrequently: true })!;
  }

  static async create(
    domCanvas: HTMLCanvasElement,
    facingMode: 'environment' | 'user' = 'environment',
  ): Promise<MotionCamera | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 320 }, height: { ideal: 180 } },
        audio: false,
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.setAttribute("playsinline", "");
      video.muted = true;
      await video.play();
      return new MotionCamera(video, stream);
    } catch {
      showMotionOverlay(domCanvas, "Camera access denied.\nAllow camera in browser settings and reload.");
      return null;
    }
  }

  // Returns per-pixel absolute luminance diff [0..1], or null if video not ready / no new frame.
  tick(): Float32Array | null {
    if (this.video.readyState < 2) return null;
    if (this.video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = this.video.currentTime;

    this.offCtx.drawImage(this.video, 0, 0, W, H);
    const { data } = this.offCtx.getImageData(0, 0, W, H);

    const luma = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      luma[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    }

    let diff: Float32Array | null = null;
    if (this.prevLuma) {
      diff = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) {
        diff[i] = Math.abs(luma[i] - this.prevLuma[i]);
      }
    }
    this.prevLuma = luma;
    return diff;
  }

  dispose() {
    this.stream.getTracks().forEach((t) => t.stop());
    this.video.pause();
    this.video.srcObject = null;
  }
}

// ─── Algorithm 1: Spatial Patchiness ─────────────────────────────────────────
//
// Pattern motion is spatially uniform (whole-frame flow); people create
// localised blobs. Measure variance of per-cell motion vs mean — low variance
// means uniform (pattern), high variance means patchy (people).

export class SpatialPatchinessDetector {
  update(diff: Float32Array): number {
    const n = diff.length;
    let totalSum = 0;
    for (let i = 0; i < n; i++) totalSum += diff[i];
    const totalMean = totalSum / n;
    if (totalMean < 0.002) return 0;

    const cellW = (W / GRID_COLS) | 0;
    const cellH = (H / GRID_ROWS) | 0;
    const numCells = GRID_COLS * GRID_ROWS;
    const cellMeans = new Float32Array(numCells);
    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        let sum = 0, count = 0;
        for (let y = gy * cellH; y < (gy + 1) * cellH && y < H; y++) {
          for (let x = gx * cellW; x < (gx + 1) * cellW && x < W; x++) {
            sum += diff[y * W + x];
            count++;
          }
        }
        cellMeans[gy * GRID_COLS + gx] = count > 0 ? sum / count : 0;
      }
    }

    let varSum = 0;
    for (let i = 0; i < numCells; i++) {
      const d = cellMeans[i] - totalMean;
      varSum += d * d;
    }
    const variance = varSum / numCells;
    // Normalise variance by mean² — gives patchiness independent of brightness
    const patchiness = variance / (totalMean * totalMean + 1e-6);
    // Require both motion and patchiness; scale to [0,1]
    return Math.min(totalMean * Math.min(patchiness, 1.0) * 8.0, 1.0);
  }
}

// ─── Algorithm 2: Adaptive Baseline ──────────────────────────────────────────
//
// Build a rolling average of "normal" motion level (~1 s window).
// Sudden spikes above baseline × 1.4 = person motion.

export class AdaptiveBaselineDetector {
  private rollingAvg = 0.03;

  update(diff: Float32Array): number {
    const n = diff.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diff[i];
    const mean = sum / n;
    this.rollingAvg = 0.97 * this.rollingAvg + 0.03 * mean;
    const excess = (mean - this.rollingAvg * 1.4) / (this.rollingAvg + 1e-6);
    return Math.max(0, Math.min(excess, 1.0));
  }
}

// ─── Algorithm 3: Combined ────────────────────────────────────────────────────
//
// Requires BOTH a patchiness spike AND a baseline excess.
// Most conservative — fewest false positives from pattern motion.

export class CombinedDetector {
  private spatial = new SpatialPatchinessDetector();
  private baseline = new AdaptiveBaselineDetector();

  update(diff: Float32Array): number {
    const s = this.spatial.update(diff);
    const b = this.baseline.update(diff);
    return Math.min(s * b * 4.0, 1.0);
  }
}
