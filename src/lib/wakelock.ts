// Screen Wake Lock — prevents the display from sleeping.
// Only held while demo mode is active or the page is in fullscreen.
// Gracefully no-ops on browsers that don't support the API.

export function createWakeLock() {
  let sentinel: WakeLockSentinel | null = null;

  async function acquire() {
    if (!('wakeLock' in navigator) || sentinel) return;
    try {
      sentinel = await (navigator as any).wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch {
      // Browser or OS denied the request — not an error, just continue without it.
    }
  }

  function release() {
    sentinel?.release();
    sentinel = null;
  }

  return { acquire, release };
}
