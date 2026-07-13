// Centralized camera stream acquisition, shared by every camera consumer (Motion/Heat,
// Pose, Light Painting family, ASCII Swirls) instead of each opening its own independent
// getUserMedia stream. Consumers requesting the exact same constraints (same device +
// resolution) share ONE underlying MediaStream/video element, reference-counted — the
// stream only stops once every consumer holding a handle has released it.
//
// Also centralizes track-ended recovery: every acquired stream is watched for its video
// track ending unexpectedly (device unplugged, OS revoked permission, sleep/wake), and
// every consumer sharing that stream is notified via its onEnded callback — previously
// this was implemented ad hoc (and inconsistently) per consumer.
//
// Sensor Block integration is implicit: acquireCamera() calls guardedGetUserMedia(), which
// registers the stream in sensorGuard's kill-switch registry and rejects new opens while
// privacyMode is active. When Sensor Block force-stops a track, its 'ended' event fires
// here exactly like any other track death, routing through the same recovery notification
// — no separate kill path needed.

import { guardedGetUserMedia } from './sensorGuard';

export interface CameraHandle {
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
  /** Release this consumer's hold on the stream. Idempotent. */
  release(): void;
}

interface Entry {
  constraints: MediaStreamConstraints;
  stream: MediaStream | null;
  video: HTMLVideoElement | null;
  consumers: Map<string, () => void>; // consumerId -> onEnded callback
  opening: Promise<void> | null;
  openToken: number; // bumped when this entry is torn down mid-open, invalidating it
}

const entries = new Map<string, Entry>();

function pick(c: unknown): unknown {
  if (c && typeof c === 'object') return (c as { exact?: unknown; ideal?: unknown }).exact ?? (c as { ideal?: unknown }).ideal ?? null;
  return c ?? null;
}

// Stable identity for a constraints object — only the fields that determine which
// physical device + resolution get requested matter; unrelated fields are ignored.
function keyFor(constraints: MediaStreamConstraints): string {
  const v = constraints.video;
  if (typeof v !== 'object' || v === null) return JSON.stringify(v ?? null);
  const o = v as MediaTrackConstraints;
  return JSON.stringify({
    d: pick(o.deviceId),
    w: pick(o.width),
    h: pick(o.height),
    f: pick(o.facingMode),
  });
}

function teardown(key: string, entry: Entry) {
  if (entries.get(key) === entry) entries.delete(key);
  entry.stream?.getTracks().forEach((t) => t.stop());
  if (entry.video) entry.video.srcObject = null;
  entry.stream = null;
  entry.video = null;
}

function onTrackEnded(key: string, entry: Entry) {
  if (entries.get(key) !== entry || !entry.stream) return; // already torn down / superseded
  entry.stream = null;
  entry.video = null;
  for (const cb of entry.consumers.values()) cb();
}

async function open(key: string, entry: Entry, myToken: number): Promise<void> {
  const stream = await guardedGetUserMedia(entry.constraints);
  if (entry.openToken !== myToken) {
    // Every consumer released (or the entry was replaced) while we were opening.
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', '');
  // autoplay is unreliable on iOS Safari for off-DOM video elements — call play()
  // explicitly. A rejection here isn't fatal: readyState-based waiting below still works
  // once the element starts producing frames (e.g. after a later user gesture).
  try { await video.play(); } catch { /* ignore */ }
  await new Promise<void>((resolve) => {
    if (video.readyState >= 2) { resolve(); return; }
    video.onloadeddata = () => resolve();
  });
  if (entry.openToken !== myToken) {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    return;
  }
  entry.stream = stream;
  entry.video = video;
  stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => onTrackEnded(key, entry)));
}

/**
 * Acquire a ready-to-use (loadeddata fired) video stream for `constraints`. Identical
 * constraints from other consumers share the same underlying stream. Throws if
 * getUserMedia fails (permission denied, device gone, blocked by Sensor Block) — the
 * caller should catch and show its own UI; nothing is retried automatically.
 *
 * `onEnded` fires if the track dies AFTER a successful acquire (device unplugged, OS
 * revoked, sleep/wake, or Sensor Block force-stopping it) — every consumer sharing the
 * stream gets called, each deciding independently whether/how to react.
 */
export async function acquireCamera(
  consumerId: string,
  constraints: MediaStreamConstraints,
  onEnded?: () => void,
): Promise<CameraHandle> {
  const key = keyFor(constraints);
  let entry = entries.get(key);
  if (!entry) {
    entry = { constraints, stream: null, video: null, consumers: new Map(), opening: null, openToken: 0 };
    entries.set(key, entry);
  }
  entry.consumers.set(consumerId, onEnded ?? (() => {}));

  if (!entry.stream) {
    const e = entry;
    if (!e.opening) {
      e.openToken++;
      const myToken = e.openToken;
      e.opening = open(key, e, myToken).finally(() => { if (e.opening && e.openToken === myToken) e.opening = null; });
    }
    try {
      await e.opening;
    } catch (err) {
      e.consumers.delete(consumerId);
      if (e.consumers.size === 0) entries.delete(key);
      throw err;
    }
    if (!e.consumers.has(consumerId)) {
      // Released while awaiting the open (rapid pattern switch) — nothing to hand back.
      throw new DOMException('Acquire cancelled', 'AbortError');
    }
  }
  if (!entry.stream || !entry.video) {
    entry.consumers.delete(consumerId);
    throw new DOMException('Camera stream unavailable', 'NotFoundError');
  }

  const stream = entry.stream;
  const video = entry.video;
  const finalEntry = entry;
  let released = false;
  return {
    stream,
    video,
    release() {
      if (released) return;
      released = true;
      finalEntry.consumers.delete(consumerId);
      if (finalEntry.consumers.size === 0) {
        if (finalEntry.opening) finalEntry.openToken++; // invalidate any in-flight open
        teardown(key, finalEntry);
      }
    },
  };
}
