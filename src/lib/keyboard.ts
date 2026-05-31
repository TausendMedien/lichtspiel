export type KeyAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "jump"; index: number }
  | { type: "fullscreen" }
  | { type: "demo" }
  | { type: "escape" }
  | { type: "freeze" }
  | { type: "blackout" }
  | { type: "randomize" }
  | { type: "resetToDefault" }
  | { type: "screenshot" }
  | { type: "toggleRecording" }
  | { type: "toggleCamera" }
  | { type: "speedUp" }
  | { type: "speedDown" }
  | { type: "focusUp" }
  | { type: "focusDown" }
  | { type: "sliderLeft" }
  | { type: "sliderRight" }
  | { type: "toggleOverlay" }
  | { type: "toggleCheatsheet" }
  | { type: "toggleOptions" }
  | { type: "undo" }
  | { type: "togglePose" }
  | { type: "tap" }
  | { type: "pedalShort" }
  | { type: "pedalDouble" }
  | { type: "pedalLong" }
  | { type: "activatePattern"; id: string };

const PEDAL_LONG_MS = 500;    // hold ≥ this → long press
const PEDAL_DOUBLE_MS = 250;  // gap between releases ≤ this → double press

export function attachKeyboard(
  handler: (action: KeyAction) => void,
  onRHeldChange?: (held: boolean) => void,
  pedalDoubleEnabled?: () => boolean,
): () => void {
  let rHeld = false;
  let bPressedAt = 0; // tracks keydown time for long-press detection on 'b'
  let bSingleTimer: ReturnType<typeof setTimeout> | null = null; // pending single press awaiting a possible double

  function onKeyDown(e: KeyboardEvent) {
    // Don't fire shortcuts when typing in a text or textarea field
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    // Ctrl/Cmd+Z — undo (before the general modifier guard)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'z') {
      handler({ type: 'undo' });
      e.preventDefault();
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // R held: arrows navigate sliders (↑↓ = switch, ←→ = adjust)
    if (e.key === "r" || e.key === "R") {
      if (!rHeld) { rHeld = true; onRHeldChange?.(true); }
      e.preventDefault();
      return;
    }

    if (rHeld) {
      switch (e.key) {
        case "ArrowUp":    handler({ type: "focusUp" });    e.preventDefault(); return;
        case "ArrowDown":  handler({ type: "focusDown" });  e.preventDefault(); return;
        case "ArrowLeft":  handler({ type: "sliderLeft" }); e.preventDefault(); return;
        case "ArrowRight": handler({ type: "sliderRight" });e.preventDefault(); return;
      }
    }

    switch (e.key) {
      case "f": case "F":
        handler({ type: "fullscreen" });
        e.preventDefault(); return;
      case "d": case "D":
        handler({ type: "demo" });
        e.preventDefault(); return;
      case "n": case "N":
        handler({ type: "resetToDefault" });
        e.preventDefault(); return;
      case "b": case "B":
        if (e.repeat) { e.preventDefault(); return; }
        bPressedAt = performance.now(); // dispatch deferred to keyup for long-press detection
        e.preventDefault(); return;
      case " ":
        handler({ type: "freeze" });
        e.preventDefault(); return;
      case "a": case "A":
        handler({ type: "resetToDefault" });
        e.preventDefault(); return;
      case "x": case "X":
        handler({ type: "blackout" });
        e.preventDefault(); return;
      case "l": case "L":
      case "s": case "S":
        handler({ type: "screenshot" });
        e.preventDefault(); return;
      case "y": case "Y":
        handler({ type: "toggleOverlay" });
        e.preventDefault(); return;
      case "m": case "M":
        handler({ type: "toggleCheatsheet" });
        e.preventDefault(); return;
      case "o": case "O":
        handler({ type: "toggleOptions" });
        e.preventDefault(); return;
      case "1":
      case "v": case "V":
        handler({ type: "toggleRecording" });
        e.preventDefault(); return;
      case "2":
        handler({ type: "toggleCamera" });
        e.preventDefault(); return;
      case "t": case "T":
        handler({ type: "togglePose" });
        e.preventDefault(); return;
      case "ArrowRight":
        handler({ type: "next" });
        e.preventDefault(); return;
      case "ArrowLeft":
        handler({ type: "prev" });
        e.preventDefault(); return;
      case "ArrowUp":
        handler({ type: "speedUp" });
        e.preventDefault(); return;
      case "ArrowDown":
        handler({ type: "speedDown" });
        e.preventDefault(); return;
      case "Enter":
        handler({ type: "freeze" }); // Start button in K-Mode sends Enter
        e.preventDefault(); return;
      case "Escape":
        handler({ type: "escape" });
        // no preventDefault — let browser exit fullscreen natively
        return;
    }

    // 3–9 jump to pattern (1 and 2 reserved for recording / camera)
    if (e.key >= "3" && e.key <= "9") {
      handler({ type: "jump", index: Number(e.key) - 1 });
      e.preventDefault();
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.key === "r" || e.key === "R") {
      rHeld = false;
      onRHeldChange?.(false);
    }
    // Pedal ('b') gesture detection on release:
    //   hold ≥ 500 ms        → long press
    //   two quick taps       → double press (only when enabled)
    //   single tap           → short press
    if ((e.key === "b" || e.key === "B") && bPressedAt > 0) {
      const held = performance.now() - bPressedAt;
      bPressedAt = 0;
      if (held >= PEDAL_LONG_MS) {
        if (bSingleTimer !== null) { clearTimeout(bSingleTimer); bSingleTimer = null; }
        handler({ type: "pedalLong" });
      } else if (bSingleTimer !== null) {
        // Second tap within the window → double press
        clearTimeout(bSingleTimer);
        bSingleTimer = null;
        handler({ type: "pedalDouble" });
      } else if (pedalDoubleEnabled?.()) {
        // First tap — wait briefly to see if a second tap follows
        bSingleTimer = setTimeout(() => {
          bSingleTimer = null;
          handler({ type: "pedalShort" });
        }, PEDAL_DOUBLE_MS);
      } else {
        handler({ type: "pedalShort" });
      }
    }
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}
