export type GamepadAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "speedUp" }
  | { type: "speedDown" }
  | { type: "freeze" }
  | { type: "screenshot" }
  | { type: "focusUp" }
  | { type: "focusDown" }
  | { type: "sliderLeft" }
  | { type: "sliderRight" };

export interface GamepadController {
  poll(now: number): void;
  dispose(): void;
}

// Standard HID gamepad button indices
const BTN_A      = 0;
const BTN_L1     = 4;
const BTN_R1     = 5;
const BTN_DPAD_U = 12;
const BTN_DPAD_D = 13;
const BTN_DPAD_L = 14;
const BTN_DPAD_R = 15;

const INITIAL_DELAY_MS  = 400;
const REPEAT_INTERVAL_MS = 100;

interface RepeatEntry {
  nextFire: number;
}

export function createGamepadController(
  handler: (action: GamepadAction) => void,
  onConnectionChange: (connected: boolean) => void,
  onL1Change: (held: boolean) => void,
): GamepadController {
  let gamepadIndex: number | null = null;
  let prevButtons: Record<number, boolean> = {};
  let prevL1 = false;
  const repeating = new Map<string, RepeatEntry>();

  function onConnect(e: GamepadEvent) {
    if (gamepadIndex === null) {
      gamepadIndex = e.gamepad.index;
      onConnectionChange(true);
    }
  }

  function onDisconnect(e: GamepadEvent) {
    if (e.gamepad.index === gamepadIndex) {
      gamepadIndex = null;
      prevButtons = {};
      prevL1 = false;
      repeating.clear();
      onConnectionChange(false);
      onL1Change(false);
    }
  }

  window.addEventListener('gamepadconnected', onConnect);
  window.addEventListener('gamepaddisconnected', onDisconnect);

  // Detect already-connected gamepads (page loaded with controller already paired)
  const existing = navigator.getGamepads();
  for (let i = 0; i < existing.length; i++) {
    if (existing[i]) {
      gamepadIndex = i;
      onConnectionChange(true);
      break;
    }
  }

  function isPressed(gp: Gamepad, index: number): boolean {
    return gp.buttons[index]?.pressed ?? false;
  }

  function wasJustPressed(gp: Gamepad, index: number): boolean {
    return isPressed(gp, index) && !(prevButtons[index] ?? false);
  }

  function fireRepeatable(action: GamepadAction, now: number) {
    const key = action.type;
    const entry = repeating.get(key);
    if (!entry) {
      handler(action);
      repeating.set(key, { nextFire: now + INITIAL_DELAY_MS });
    } else if (now >= entry.nextFire) {
      handler(action);
      entry.nextFire = now + REPEAT_INTERVAL_MS;
    }
  }

  function poll(now: number) {
    if (gamepadIndex === null) return;
    const gp = navigator.getGamepads()[gamepadIndex];
    if (!gp) return;

    const l1   = isPressed(gp, BTN_L1);
    const dUp  = isPressed(gp, BTN_DPAD_U);
    const dDn  = isPressed(gp, BTN_DPAD_D);
    const dL   = isPressed(gp, BTN_DPAD_L);
    const dR   = isPressed(gp, BTN_DPAD_R);

    // L1 state change callback
    if (l1 !== prevL1) onL1Change(l1);

    // Track which repeatable action types are currently active
    const activeRepeatKeys = new Set<string>();

    if (l1) {
      if (dUp) { fireRepeatable({ type: "focusUp" },    now); activeRepeatKeys.add("focusUp"); }
      if (dDn) { fireRepeatable({ type: "focusDown" },  now); activeRepeatKeys.add("focusDown"); }
      if (dL)  { fireRepeatable({ type: "sliderLeft" }, now); activeRepeatKeys.add("sliderLeft"); }
      if (dR)  { fireRepeatable({ type: "sliderRight" },now); activeRepeatKeys.add("sliderRight"); }
    } else {
      if (dUp) { fireRepeatable({ type: "speedUp" },   now); activeRepeatKeys.add("speedUp"); }
      if (dDn) { fireRepeatable({ type: "speedDown" }, now); activeRepeatKeys.add("speedDown"); }
      // D-Pad L/R without modifier: single-fire only
      if (wasJustPressed(gp, BTN_DPAD_L)) handler({ type: "prev" });
      if (wasJustPressed(gp, BTN_DPAD_R)) handler({ type: "next" });
    }

    // Clear repeat state for released repeatable actions
    for (const key of repeating.keys()) {
      if (!activeRepeatKeys.has(key)) repeating.delete(key);
    }

    // Single-fire buttons
    if (wasJustPressed(gp, BTN_A))  handler({ type: "freeze" });
    if (wasJustPressed(gp, BTN_R1)) handler({ type: "screenshot" });

    // Update edge-detection state
    for (const idx of [BTN_A, BTN_L1, BTN_R1, BTN_DPAD_U, BTN_DPAD_D, BTN_DPAD_L, BTN_DPAD_R]) {
      prevButtons[idx] = isPressed(gp, idx);
    }
    prevL1 = l1;
  }

  function dispose() {
    window.removeEventListener('gamepadconnected', onConnect);
    window.removeEventListener('gamepaddisconnected', onDisconnect);
  }

  return { poll, dispose };
}
