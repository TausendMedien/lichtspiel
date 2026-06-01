/**
 * sensorGuard — single source of truth for all camera/audio hardware access.
 *
 * Every getUserMedia call in the app goes through `guardedGetUserMedia`.
 * The guard:
 *   1. Rejects immediately if Sensor Block is active (privacyMode.active)
 *   2. Registers every live MediaStream in a set
 *   3. Exposes `killAllStreams()` which stops ALL tracks across ALL registered
 *      streams — called by the Sensor Block toggle for an instant hard kill.
 *
 * Streams are automatically de-registered when all their tracks end.
 */

import { privacyMode } from './privacyMode.svelte';

const _live = new Set<MediaStream>();

export async function guardedGetUserMedia(
  constraints: MediaStreamConstraints,
): Promise<MediaStream> {
  if (privacyMode.active) {
    throw new DOMException('Blocked by Sensor Block', 'NotAllowedError');
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  _live.add(stream);
  // Auto-deregister once every track has ended (user revokes permission, etc.)
  const deregister = () => {
    if (stream.getTracks().every(t => t.readyState === 'ended')) _live.delete(stream);
  };
  stream.getTracks().forEach(t => t.addEventListener('ended', deregister));
  return stream;
}

/** Stop every track in every live stream and clear the registry. */
export function killAllStreams(): void {
  for (const stream of _live) {
    stream.getTracks().forEach(t => t.stop());
  }
  _live.clear();
}
