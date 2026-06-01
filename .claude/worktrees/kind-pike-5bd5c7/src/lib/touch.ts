import type { KeyAction } from "./keyboard";

export function attachTouch(handler: (action: KeyAction) => void): () => void {
  let startX = 0;
  let startY = 0;
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let pendingDoubleTap = false;

  function onTouchStart(e: TouchEvent) {
    // If the touch starts on a HUD panel, ignore all gestures for this touch
    if ((e.target as Element | null)?.closest('[data-no-swipe]')) {
      pendingDoubleTap = false;
      startX = -1; // sentinel: skip onTouchEnd processing
      return;
    }

    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;

    const now = Date.now();
    const tapDist = Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY);

    if (now - lastTapTime < 350 && tapDist < 60) {
      // Second tap of a double-tap — prevent browser zoom immediately
      e.preventDefault();
      pendingDoubleTap = true;
    } else {
      pendingDoubleTap = false;
    }

    lastTapTime = now;
    lastTapX = t.clientX;
    lastTapY = t.clientY;
  }

  function onTouchEnd(e: TouchEvent) {
    if (startX === -1) return; // touch started on a panel — ignore
    const t = e.changedTouches[0];
    const deltaX = t.clientX - startX;
    const deltaY = t.clientY - startY;
    const elapsed = Date.now() - lastTapTime;

    if (pendingDoubleTap) {
      e.preventDefault();
      pendingDoubleTap = false;
      lastTapTime = 0;
      handler({ type: "fullscreen" });
      return;
    }

    // Swipe: fast, horizontal, significant distance
    if (elapsed < 400 && Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(deltaY)) {
      e.preventDefault();
      lastTapTime = 0; // reset double-tap tracking after a swipe
      handler({ type: deltaX < 0 ? "next" : "prev" });
    }
  }

  // passive: false on touchstart so we can preventDefault on double-tap second touch
  window.addEventListener("touchstart", onTouchStart, { passive: false });
  window.addEventListener("touchend", onTouchEnd, { passive: false });

  return () => {
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchend", onTouchEnd);
  };
}
