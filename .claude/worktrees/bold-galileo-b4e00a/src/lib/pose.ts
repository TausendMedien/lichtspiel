import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export interface PersonPoints {
  x: number; // normalized 0–1, mirrored (left hand = left side)
  y: number; // normalized 0–1, y=0 top
}

// Mutable singleton — patterns read this directly in their update() loop every frame.
export const poseState = {
  persons: [] as PersonPoints[][],  // persons[i] = [leftWrist, rightWrist, hipCenter]
  active: false,
};

let landmarker: PoseLandmarker | null = null;
let video: HTMLVideoElement | null = null;
let rafId = 0;

export async function startPoseTracking(): Promise<void> {
  if (poseState.active) return;

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
  );
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 5,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  video = document.createElement("video");
  video.width = 640;
  video.height = 480;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
  });
  video.srcObject = stream;
  await new Promise<void>((resolve) => {
    video!.onloadeddata = () => resolve();
  });

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
  poseState.active = false;
  cancelAnimationFrame(rafId);
  poseState.persons = [];
  if (video?.srcObject) {
    (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
  video = null;
  landmarker?.close();
  landmarker = null;
}
