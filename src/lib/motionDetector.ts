// Motion detection from webcam feed.
// Separates "person motion" from background pattern motion using three algorithms.
import { guardedGetUserMedia } from './sensorGuard';

const W = 160;
const H = 90;
const GRID_COLS = 8;
const GRID_ROWS = 5;

const MOTION_OVERLAY_CLASS = "motion-camera-overlay";

// Some call sites (notably MotionCamera.createWithConstraints' catch below) don't hold
// onto the returned element to remove it later — always clearing prior overlays here,
// scoped by class, prevents them stacking up (e.g. repeated "Camera access denied").
// An optional onRetry makes the overlay interactive (e.g. after a permission denial,
// so the operator doesn't have to reload the whole app to try again).
export function showMotionOverlay(canvas: HTMLCanvasElement, message: string, onRetry?: () => void): HTMLDivElement {
  const parent = canvas.parentElement;
  parent?.querySelectorAll(`.${MOTION_OVERLAY_CLASS}`).forEach((el) => el.remove());
  const div = document.createElement("div");
  div.className = MOTION_OVERLAY_CLASS;
  div.style.cssText = [
    "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;",
    "color:#fff;font-family:sans-serif;font-size:16px;text-align:center;",
    `pointer-events:${onRetry ? "auto" : "none"};white-space:pre-line;padding:24px;background:rgba(0,0,0,0.55);`,
  ].join("");
  const msg = document.createElement("div");
  msg.textContent = message;
  div.appendChild(msg);
  if (onRetry) {
    const btn = document.createElement("button");
    btn.textContent = "↻ Retry";
    btn.style.cssText = "pointer-events:auto;cursor:pointer;padding:6px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.08);color:#fff;font-size:13px;font-family:sans-serif;";
    btn.onclick = onRetry;
    div.appendChild(btn);
  }
  parent?.appendChild(div);
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
  private warmupFrames = 2;
  /** Set when the underlying track ends unexpectedly (device unplugged, OS revoked
   *  permission, sleep/wake) — as opposed to a normal, caller-initiated dispose(). Callers
   *  should poll this and treat it like a dead stream (stop + restart if still wanted). */
  ended = false;

  private constructor(video: HTMLVideoElement, stream: MediaStream) {
    this.video = video;
    this.stream = stream;
    this.offCanvas = document.createElement("canvas");
    this.offCanvas.width = W;
    this.offCanvas.height = H;
    this.offCtx = this.offCanvas.getContext("2d", { willReadFrequently: true })!;
    stream.getVideoTracks().forEach((t) => t.addEventListener("ended", () => { this.ended = true; }));
  }

  static async create(
    domCanvas: HTMLCanvasElement,
    facingMode: 'environment' | 'user' = 'environment',
  ): Promise<MotionCamera | null> {
    return MotionCamera.createWithConstraints(domCanvas, {
      video: { facingMode: { ideal: facingMode }, width: { ideal: 320 }, height: { ideal: 180 } },
      audio: false,
    });
  }

  static async createWithConstraints(
    domCanvas: HTMLCanvasElement,
    constraints: MediaStreamConstraints,
  ): Promise<MotionCamera | null> {
    try {
      const stream = await guardedGetUserMedia(constraints);
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
      if (this.warmupFrames > 0) {
        this.warmupFrames--;
      } else {
        diff = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) {
          diff[i] = Math.abs(luma[i] - this.prevLuma[i]);
        }
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
//
// Also computes dirX / dirY: weighted center-of-mass of the motion grid,
// normalised to [-1, +1]. Free cost — cellMeans already exist.

export class SpatialPatchinessDetector {
  /** Last computed horizontal direction: -1 = left, +1 = right. */
  dirX = 0;
  /** Last computed vertical direction: -1 = top, +1 = bottom. */
  dirY = 0;

  update(diff: Float32Array): number {
    const n = diff.length;
    let totalSum = 0;
    for (let i = 0; i < n; i++) totalSum += diff[i];
    const totalMean = totalSum / n;
    if (totalMean < 0.002) { this.dirX = 0; this.dirY = 0; return 0; }

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

    // ── Direction: weighted center-of-mass of cellMeans ─────────────────────
    // Grid coordinates go 0..GRID_COLS-1 / 0..GRID_ROWS-1.
    // Normalise to [-1, +1] around the center.
    let wxSum = 0, wySum = 0, wSum = 0;
    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        const w = cellMeans[gy * GRID_COLS + gx];
        wxSum += w * (gx / (GRID_COLS - 1) * 2 - 1);
        wySum += w * (gy / (GRID_ROWS - 1) * 2 - 1);
        wSum  += w;
      }
    }
    if (wSum > 1e-6) {
      this.dirX = Math.max(-1, Math.min(1, wxSum / wSum));
      this.dirY = Math.max(-1, Math.min(1, wySum / wSum));
    } else {
      this.dirX = 0;
      this.dirY = 0;
    }

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
