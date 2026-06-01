// Global motion-detection camera settings shared across all patterns and the Options menu.

export type DeviceInfo = { deviceId: string; label: string };

export const cameraState = $state({
  enabled:        false,  // camera hardware on/off (starts the stream)
  motionEnabled:  true,   // motion detection on/off (uses stream to boost controls)
  deviceId:       '',
  devices:        [] as DeviceInfo[],
  sensitivity:    50,
  level:          0,
});

export async function enumerateCameras(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const video = all.filter(d => d.kind === 'videoinput');
    cameraState.devices = video.map((d, i) => ({
      deviceId: d.deviceId,
      label:    d.label || `Camera ${i + 1}`,
    }));
    // Default to first device if none selected or selection gone
    if (cameraState.deviceId && !cameraState.devices.find(d => d.deviceId === cameraState.deviceId)) {
      cameraState.deviceId = cameraState.devices[0]?.deviceId ?? '';
    }
  } catch {
    cameraState.devices = [];
  }
}
