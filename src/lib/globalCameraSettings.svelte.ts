// Global motion-detection camera settings shared across all patterns and the Options menu.

import { guardedGetUserMedia } from './sensorGuard';

export type DeviceInfo = { deviceId: string; label: string };

function loadPatternMotionEnabled(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem('lichtspiel-pattern-motion') ?? '{}'); } catch { return {}; }
}

// ─── Capture resolution (for the camera-FEED patterns: Light Painting, ASCII) ──────
// This is a light-art app, so quality defaults to Full HD; lower options exist only
// as a performance fallback. Motion/Pose keep their own low res (they downscale).
export type CameraRes = { w: number; h: number; label: string };
export const CAMERA_RES_OPTIONS: CameraRes[] = [
  { w: 1920, h: 1080, label: 'Full HD · 1080p' },
  { w: 1280, h: 720,  label: 'HD · 720p' },
  { w: 640,  h: 480,  label: 'SD · 480p' },
];
const CAMERA_RES_KEY = 'lichtspiel-camera-res';
function loadCameraResWidth(): number {
  try {
    const w = parseInt(localStorage.getItem(CAMERA_RES_KEY) ?? '');
    if (CAMERA_RES_OPTIONS.some(o => o.w === w)) return w;
  } catch {}
  return 1920; // default Full HD
}

// ─── Real lenses vs virtual auto-switching combo devices ───────────────────────────
// Real single-lens cameras (front, back wide, ultra-wide, telephoto) always return
// the SAME physical lens regardless of requested resolution → stable. Virtual combo
// devices ("Back Dual/Triple Camera", "Desk View") auto-switch lens by zoom/res/light
// and cause Light Painting to land on a different lens than Motion. Hidden by default.
const VIRTUAL_RE = /dual|triple|combo|desk\s*view/i;
const REAR_RE    = /back|rear|environment/i;
const NON_WIDE_RE = /ultra|wide angle|tele|telephoto|dual|triple/i;

export function isVirtualCamera(label: string): boolean { return VIRTUAL_RE.test(label); }

const SHOW_VIRTUAL_KEY = 'lichtspiel-camera-virtual';
function loadShowVirtual(): boolean {
  try { return localStorage.getItem(SHOW_VIRTUAL_KEY) === 'true'; } catch { return false; }
}

// Persisted camera choice — survives reloads so a kiosk keeps the chosen lens.
const CAMERA_DEVICE_KEY = 'lichtspiel-camera-device';
function loadSavedCamera(): { deviceId: string; label: string } {
  try { return JSON.parse(localStorage.getItem(CAMERA_DEVICE_KEY) ?? '{}'); } catch { return { deviceId: '', label: '' }; }
}
const _savedCamera = loadSavedCamera();

export function saveCameraDevice(): void {
  const label = cameraState.devices.find(d => d.deviceId === cameraState.deviceId)?.label ?? '';
  try { localStorage.setItem(CAMERA_DEVICE_KEY, JSON.stringify({ deviceId: cameraState.deviceId, label })); } catch {}
}

export const cameraState = $state({
  enabled:        false,  // camera hardware on/off (starts the stream)
  motionEnabled:  true,   // motion detection on/off (uses stream to boost controls)
  deviceId:       _savedCamera.deviceId ?? '',
  devices:        [] as DeviceInfo[],
  resWidth:       loadCameraResWidth(),
  showVirtual:    loadShowVirtual(),
  sensitivity:    50,
  level:          0,      // 0–100 smoothed motion level
  /** Motion direction: -1 = left/top, +1 = right/bottom. Updated by motionCameraWrapper. */
  dirX:           0,
  dirY:           0,
  /** Sudden burst pulse 0–100. Spikes on quick gestures, decays fast. */
  burst:          0,
  /** Raw per-pixel motion buffer (320×180). Populated by motionCameraWrapper each frame. */
  heatMap:        new Float32Array(320 * 180),
  patternMotionEnabled: loadPatternMotionEnabled() as Record<string, boolean>,
});

export function savePatternMotionEnabled(): void {
  try { localStorage.setItem('lichtspiel-pattern-motion', JSON.stringify(cameraState.patternMotionEnabled)); } catch {}
}

/** The current capture resolution {w,h} for the camera-feed patterns. */
export function cameraResHeight(): number {
  return CAMERA_RES_OPTIONS.find(o => o.w === cameraState.resWidth)?.h ?? 1080;
}
export function setCameraResolution(w: number): void {
  cameraState.resWidth = w;
  try { localStorage.setItem(CAMERA_RES_KEY, String(w)); } catch {}
}

/** Cameras the user can pick: real lenses always; virtual combos only when opted in. */
export function getVisibleDevices(): DeviceInfo[] {
  return cameraState.showVirtual
    ? cameraState.devices
    : cameraState.devices.filter(d => !isVirtualCamera(d.label));
}

export function setShowVirtualCameras(v: boolean): void {
  cameraState.showVirtual = v;
  try { localStorage.setItem(SHOW_VIRTUAL_KEY, String(v)); } catch {}
  // If a now-hidden virtual device was selected, fall back to a visible real lens.
  if (!getVisibleDevices().some(d => d.deviceId === cameraState.deviceId)) {
    cameraState.deviceId = pickDefaultDevice();
    saveCameraDevice();
  }
}

// Default selection: saved-label match → plain back wide lens → any back → first visible.
function pickDefaultDevice(): string {
  const visible = getVisibleDevices();
  if (visible.length === 0) return cameraState.devices[0]?.deviceId ?? '';
  const bySaved  = _savedCamera.label ? visible.find(d => d.label === _savedCamera.label) : undefined;
  const backWide = visible.find(d => REAR_RE.test(d.label) && !NON_WIDE_RE.test(d.label));
  const anyBack  = visible.find(d => REAR_RE.test(d.label));
  return (bySaved ?? backWide ?? anyBack ?? visible[0]).deviceId;
}

export async function enumerateCameras(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const video = all.filter(d => d.kind === 'videoinput');
    cameraState.devices = video.map((d, i) => ({
      deviceId: d.deviceId,
      label:    d.label || `Camera ${i + 1}`,
    }));
    if (cameraState.devices.length === 0) return;
    // Ensure a CONCRETE, VISIBLE real-lens device is selected so every pattern requests
    // the exact same physical lens (deviceId:{exact}) — resolution can't switch it.
    const stillValid = !!cameraState.deviceId &&
      getVisibleDevices().some(d => d.deviceId === cameraState.deviceId);
    if (!stillValid) {
      cameraState.deviceId = pickDefaultDevice();
      saveCameraDevice();
    }
  } catch {
    cameraState.devices = [];
  }
}

/**
 * Build the video constraints for the camera-FEED patterns (Light Painting, ASCII):
 * the chosen lens at the chosen resolution with an explicit width AND height, so the
 * aspect ratio is defined and both patterns request an identical stream.
 */
export function cameraFeedConstraints(): MediaStreamConstraints {
  const id = cameraState.deviceId;
  const w = cameraState.resWidth;
  const h = cameraResHeight();
  const video: MediaTrackConstraints = id
    ? { deviceId: { exact: id }, width: { ideal: w }, height: { ideal: h } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: w }, height: { ideal: h } };
  return { video, audio: false };
}

/**
 * Request one-time camera permission (so device labels/IDs are revealed), then
 * enumerate. Use this for the Demo "Detect cameras" control — patterns that need
 * the camera (Light Painting, ASCII) only prompt when they run, so without this
 * the picker can't show real devices during setup.
 */
export async function detectCameras(): Promise<void> {
  try {
    const stream = await guardedGetUserMedia({ video: true });
    stream.getTracks().forEach(t => t.stop());
  } catch { /* permission denied or blocked — still try to enumerate */ }
  await enumerateCameras();
}

// ─── Diagnostic: which lens does each camera pattern actually resolve to? ───────────
export type CameraProbe = { name: string; label: string; width: number; height: number; deviceId: string; error?: string };

/**
 * Open the camera with each pattern's actual constraints (sequentially), read the
 * resolved track label + resolution, then stop before the next. Lets the operator
 * SEE whether every pattern lands on the same lens before relying on a Demo.
 */
export async function probeCameras(): Promise<CameraProbe[]> {
  const id = cameraState.deviceId;
  const base = (w: number, h: number): MediaTrackConstraints => id
    ? { deviceId: { exact: id }, width: { ideal: w }, height: { ideal: h } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: w }, height: { ideal: h } };
  const configs: { name: string; c: MediaTrackConstraints }[] = [
    { name: 'Light Painting / ASCII', c: base(cameraState.resWidth, cameraResHeight()) },
    { name: 'Motion',                 c: base(320, 180) },
    { name: 'Pose',                   c: base(640, 480) },
  ];
  const out: CameraProbe[] = [];
  for (const cfg of configs) {
    try {
      const s = await guardedGetUserMedia({ video: cfg.c, audio: false });
      const t = s.getVideoTracks()[0];
      const st = t.getSettings();
      out.push({
        name: cfg.name,
        label: t.label || '(unknown)',
        width: st.width ?? 0,
        height: st.height ?? 0,
        deviceId: st.deviceId ?? '',
      });
      s.getTracks().forEach(x => x.stop());
      await new Promise(r => setTimeout(r, 150)); // brief gap so iOS releases the device
    } catch (e) {
      out.push({ name: cfg.name, label: '', width: 0, height: 0, deviceId: '', error: e instanceof Error ? e.message : 'error' });
    }
  }
  return out;
}
