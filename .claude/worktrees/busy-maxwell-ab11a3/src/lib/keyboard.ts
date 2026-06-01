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
  | { type: "undo" };

export function attachKeyboard(
  handler: (action: KeyAction) => void,
  onRHeldChange?: (held: boolean) => void,
): () => void {
  let rHeld = false;

  function onKeyDown(e: KeyboardEvent) {
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
      case "b": case "B":
        handler({ type: "resetToDefault" });
        e.preventDefault(); return;
      case " ":
        handler({ type: "freeze" });
        e.preventDefault(); return;
      case "a": case "A":
        handler({ type: "randomize" });
        e.preventDefault(); return;
      case "x": case "X":
        handler({ type: "blackout" });
        e.preventDefault(); return;
      case "l": case "L":
        handler({ type: "screenshot" });
        e.preventDefault(); return;
      case "y": case "Y":
        handler({ type: "toggleOverlay" });
        e.preventDefault(); return;
      case "m": case "M":
        handler({ type: "toggleCheatsheet" });
        e.preventDefault(); return;
      case "1":
        handler({ type: "toggleRecording" });
        e.preventDefault(); return;
      case "2":
        handler({ type: "toggleCamera" });
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
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}
