// Global motion-detection camera settings shared across all patterns and the Options menu.

import { guardedGetUserMedia } from './sensorGuard';

export type DeviceInfo = { deviceId: string; label: string };

function loadPatternMotionEnabled(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem('lichtspiel-pattern-motion') ?? '{}'); } catch { return {}; }
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
  sensitivity:    50,
  level:          0,      // 0–100 smoothed motion level
  /** Motion direction: -1 = left/top, +1 = right/bottom. Updated by motionCameraWrapper. */
  dirX:           0,
  dirY:           0,
  /** Sudden burst pulse 0–100. Spikes on quick gestures, decays fast. */
  burst:          0,
  patternMotionEnabled: loadPatternMotionEnabled() as Record<string, boolean>,
});

export function savePatternMotionEnabled(): void {
  try { localStorage.setItem('lichtspiel-pattern-motion', JSON.stringify(cameraState.patternMotionEnabled)); } catch {}
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
    // Ensure a CONCRETE device is always selected so every pattern requests the
    // exact same lens (deviceId:{exact}) — no ambiguous facingMode fallback that
    // could resolve to a different camera per pattern (e.g. Light Painting vs Motion).
    const stillValid = !!cameraState.deviceId &&
      cameraState.devices.some(d => d.deviceId === cameraState.deviceId);
    if (!stillValid) {
      // Re-match a previously saved choice by label (deviceIds can change across sessions),
      // otherwise prefer a rear/back-facing lens, otherwise the first device.
      const bySavedLabel = _savedCamera.label
        ? cameraState.devices.find(d => d.label === _savedCamera.label) : undefined;
      const rear = cameraState.devices.find(d => /back|rear|environment/i.test(d.label));
      cameraState.deviceId = (bySavedLabel ?? rear ?? cameraState.devices[0]).deviceId;
      saveCameraDevice();
    }
  } catch {
    cameraState.devices = [];
  }
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
