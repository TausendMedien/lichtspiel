import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { acquireCamera, type CameraHandle } from './cameraManager';

export interface PersonPoints {
  x: number; // normalized 0–1, mirrored (left hand = left side)
  y: number; // normalized 0–1, y=0 top
}

// Mutable singleton — patterns read this directly in their update() loop every frame.
export const poseState = {
  persons: [] as PersonPoints[][],  // persons[i] = [leftWrist, rightWrist, hipCenter]
  active: false,
};

// Performance settings — change before or after startPoseTracking().
// lowRes requires a restart (stopPoseTracking + startPoseTracking) to take effect.
// skipFrames takes effect immediately on the next frame.
export const poseSettings = {
  lowRes:     false,  // 320×240 instead of 640×480 — lighter on older GPUs
  skipFrames: false,  // run inference every 2nd frame, reuse last result otherwise
};

let landmarker: PoseLandmarker | null = null;
let video: HTMLVideoElement | null = null;
let cameraHandle: CameraHandle | null = null;
let rafId = 0;
let frameCounter = 0;
// Bumped on every start/stop — an in-flight startPoseTracking() checks this after each
// await and bails out (cleaning up its own resources) if a stop superseded it, so a slow
// asset load or a rapid pattern switch can't resurrect tracking after stopPoseTracking().
let startToken = 0;

// Notified when tracking stops because the underlying stream died unexpectedly (device
// unplugged, OS revoked permission, sleep/wake) rather than a normal stopPoseTracking()
// call — lets the UI (poseActive/poseError) stay honest instead of showing "on" forever
// with no frames arriving. The app decides whether/how to retry.
let onInterrupted: (() => void) | null = null;
export function setPoseInterruptedHandler(cb: (() => void) | null): void { onInterrupted = cb; }

const LOAD_TIMEOUT_MS = 15000;

// Races a load step against a timeout so a stalled asset fetch shows an error instead of
// leaving poseLoading spinning forever. If the real promise resolves after the timeout
// already rejected, `cleanup` disposes it so it doesn't leak a GPU-backed resource.
function withTimeout<T>(p: Promise<T>, label: string, cleanup?: (v: T) => void): Promise<T> {
  let timedOut = false;
  const timeout = new Promise<T>((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timed out — check your connection and reload.`));
    }, LOAD_TIMEOUT_MS);
  });
  if (cleanup) p.then((v) => { if (timedOut) cleanup(v); }).catch(() => {});
  return Promise.race([p, timeout]);
}

export async function startPoseTracking(deviceId?: string): Promise<void> {
  if (poseState.active) return;
  const myToken = ++startToken;

  // Served from our own origin (public/mediapipe/) rather than jsdelivr.net /
  // storage.googleapis.com — a live show shouldn't depend on a third-party CDN
  // being reachable (venue wifi/firewalls, CDN outages) on top of our own.
  const base = import.meta.env.BASE_URL;
  const vision = await withTimeout(
    FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`),
    "Loading pose engine",
  );
  if (myToken !== startToken) return; // superseded while loading vision tasks

  const lm = await withTimeout(
    PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${base}mediapipe/pose_landmarker_lite.task`,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 5,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
    "Loading pose model",
    (v) => v.close(),
  );
  if (myToken !== startToken) { lm.close(); return; } // superseded while loading the model
  landmarker = lm;

  const vw = poseSettings.lowRes ? 320 : 640;
  const vh = poseSettings.lowRes ? 240 : 480;

  let handle: CameraHandle;
  try {
    // Recovery: device unplugged, OS revoked permission, or the track otherwise dies
    // mid-session (sleep/wake). Without this, poseState.active/UI stays stuck showing
    // "on" while no frames ever arrive again.
    handle = await acquireCamera('pose', {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: vw, height: vh }
        : { width: vw, height: vh, facingMode: "user" },
    }, () => {
      if (myToken !== startToken || !poseState.active) return; // already superseded/stopped normally
      stopPoseTracking();
      onInterrupted?.();
    });
  } catch (e) {
    lm.close();
    landmarker = null;
    // Re-throw so the caller (togglePoseTracking) sees the failure and sets
    // poseError/poseActive correctly instead of believing tracking started.
    throw e;
  }
  if (myToken !== startToken) { handle.release(); lm.close(); landmarker = null; return; }

  cameraHandle = handle;
  video = handle.video;
  poseState.active = true;

  let lastVideoTime = -1;
  // EMA smoothing: lower = smoother but more lag, higher = more responsive
  const ALPHA = 0.18;
  // Max hip-center distance (normalized) to consider two detections the same person
  const MATCH_THRESHOLD = 0.25;
  // Stable identity slots — each slot persists across frames and is matched by proximity
  let slots: PersonPoints[][] = [];

  function dist2(a: PersonPoints, b: PersonPoints) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  function detect() {
    if (!landmarker || !video || !poseState.active) return;
    if (video.readyState < 2) { rafId = requestAnimationFrame(detect); return; }
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      frameCounter++;
      // Skip inference on odd frames when skipFrames is enabled — reuse last result.
      // The EMA smoothing already masks the one-frame lag.
      if (poseSettings.skipFrames && (frameCounter & 1) === 1) {
        rafId = requestAnimationFrame(detect);
        return;
      }
      const results = landmarker.detectForVideo(video, performance.now());
      const raw = results.landmarks.map((lms) => {
        const lw = lms[15]; // left wrist
        const rw = lms[16]; // right wrist
        const lh = lms[23]; // left hip
        const rh = lms[24]; // right hip
        return [
          { x: 1 - lw.x, y: lw.y },
          { x: 1 - rw.x, y: rw.y },
          { x: 1 - (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 },
        ];
      });

      // Greedy nearest-neighbor matching by hip center (index 2)
      // Each raw detection is matched to the nearest unmatched slot within threshold.
      // Unmatched slots are dropped; unmatched detections become new slots.
      const matched = new Array<boolean>(slots.length).fill(false);
      const nextSlots: PersonPoints[][] = [];

      for (const person of raw) {
        const hip = person[2];
        let bestIdx = -1, bestD = MATCH_THRESHOLD * MATCH_THRESHOLD;
        for (let s = 0; s < slots.length; s++) {
          if (matched[s]) continue;
          const d = dist2(hip, slots[s][2]);
          if (d < bestD) { bestD = d; bestIdx = s; }
        }
        if (bestIdx >= 0) {
          // Match found — apply EMA to the existing slot
          matched[bestIdx] = true;
          nextSlots.push(person.map((pt, ji) => ({
            x: ALPHA * pt.x + (1 - ALPHA) * slots[bestIdx][ji].x,
            y: ALPHA * pt.y + (1 - ALPHA) * slots[bestIdx][ji].y,
          })));
        } else {
          // New person — initialise slot with raw position (no smoothing lag on entry)
          nextSlots.push(person.map(pt => ({ ...pt })));
        }
      }

      slots = nextSlots;
      poseState.persons = slots;
    }
    rafId = requestAnimationFrame(detect);
  }
  rafId = requestAnimationFrame(detect);
}

export function stopPoseTracking(): void {
  ++startToken; // invalidate any in-flight startPoseTracking()
  poseState.active = false;
  cancelAnimationFrame(rafId);
  frameCounter = 0;
  poseState.persons = [];
  cameraHandle?.release();
  cameraHandle = null;
  video = null;
  landmarker?.close();
  landmarker = null;
}

// Called on visibilitychange → visible (tab foregrounded, device woken from sleep).
// Some browsers pause background video elements without ever firing the track's 'ended'
// event, so the plain 'ended' listener in startPoseTracking() misses this case.
export function recheckPoseHealth(): void {
  if (poseState.active && video && (video.paused || video.readyState < 2)) {
    stopPoseTracking();
    onInterrupted?.();
  }
}
