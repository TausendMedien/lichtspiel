// Global audio reactivity settings shared across all patterns and the Options menu.

export type DeviceInfo = { deviceId: string; label: string };

export const audioState = $state({
  enabled:    false,
  deviceId:   '',
  devices:    [] as DeviceInfo[],
  sensitivity: 10,
  bandIndex:   0,   // 0=Bass 1=Mid 2=High 3=Full
  level:       0,
});

export async function enumerateMicrophones(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const audio = all.filter(d => d.kind === 'audioinput');
    audioState.devices = audio.map((d, i) => ({
      deviceId: d.deviceId,
      label:    d.label || `Microphone ${i + 1}`,
    }));
    if (audioState.deviceId && !audioState.devices.find(d => d.deviceId === audioState.deviceId)) {
      audioState.deviceId = audioState.devices[0]?.deviceId ?? '';
    }
  } catch {
    audioState.devices = [];
  }
}
