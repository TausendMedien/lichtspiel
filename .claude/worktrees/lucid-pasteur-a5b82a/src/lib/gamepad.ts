export type GamepadAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "speedUp" }
  | { type: "speedDown" }
  | { type: "freeze" }
  | { type: "randomize" }
  | { type: "screenshot" }
  | { type: "toggleRecording" }
  | { type: "toggleCamera" }
  | { type: "focusUp" }
  | { type: "focusDown" }
  | { type: "sliderLeft" }
  | { type: "sliderRight" }
  | { type: "blackout" }
  | { type: "resetToDefault" }
  | { type: "toggleOverlay" };

export interface GamepadController {
  poll(now: number): void;
  dispose(): void;
}

// Standard HID gamepad button indices
// Face buttons follow positional layout (South/East/West/North)
// consistent between 8BitDo (B/A/Y/X) and PlayStation (×/○/□/△)
const BTN_SOUTH           = 0;  // South: × / B  → Reset to default
const BTN_RANDOMIZE       = 1;  // East:  ○ / A  → Randomize
const BTN_TOGGLE_OVERLAY  = 2;  // West:  □ / Y  → Toggle Overlay (hide/show HUD)
const BTN_BLACKOUT        = 3;  // North: △ / X  → Blackout toggle
const BTN_L1              = 4;
const BTN_R1              = 5;  // Screenshot
const BTN_START           = 9;  // Options/Start → Freeze
const BTN_L2              = 6;  // Toggle Recording
const BTN_R2              = 7;  // Toggle Camera
const BTN_DPAD_U    = 12;
const BTN_DPAD_D    = 13;
const BTN_DPAD_L    = 14;
const BTN_DPAD_R    = 15;

const INITIAL_DELAY_MS   = 400;
const REPEAT_INTERVAL_MS = 100;
const AXIS_THRESHOLD     = 0.5;

interface RepeatEntry { nextFire: number; }
interface DPad { up: boolean; down: boolean; left: boolean; right: boolean; }

function readDPad(gp: Gamepad): DPad {
  const bU = gp.buttons[BTN_DPAD_U]?.pressed ?? false;
  const bD = gp.buttons[BTN_DPAD_D]?.pressed ?? false;
  const bL = gp.buttons[BTN_DPAD_L]?.pressed ?? false;
  const bR = gp.buttons[BTN_DPAD_R]?.pressed ?? false;
  if (bU || bD || bL || bR) return { up: bU, down: bD, left: bL, right: bR };

  // Axis-based D-Pad fallback (controllers without analog sticks, e.g. 8BitDo Micro in D-mode)
  const pairs: [number, number][] = [[6, 7], [4, 5], [0, 1]];
  for (const [hAxis, vAxis] of pairs) {
    if (gp.axes.length > vAxis) {
      const h = gp.axes[hAxis] ?? 0;
      const v = gp.axes[vAxis] ?? 0;
      if (Math.abs(h) > AXIS_THRESHOLD || Math.abs(v) > AXIS_THRESHOLD) {
        return {
          up:    v < -AXIS_THRESHOLD,
          down:  v >  AXIS_THRESHOLD,
          left:  h < -AXIS_THRESHOLD,
          right: h >  AXIS_THRESHOLD,
        };
      }
    }
  }
  return { up: false, down: false, left: false, right: false };
}

export function createGamepadController(
  handler: (action: GamepadAction) => void,
  onConnectionChange: (connected: boolean) => void,
  onL1Change: (held: boolean) => void,
): GamepadController {
  let gamepadIndex: number | null = null;
  let prevButtons: Record<number, boolean> = {};
  let prevAxes: Record<number, number> = {};
  let prevDPad: DPad = { up: false, down: false, left: false, right: false };
  let prevL1 = false;
  const repeating = new Map<string, RepeatEntry>();

  function logGamepad(gp: Gamepad) {
    console.log(
      `[gamepad] connected: "${gp.id}"\n` +
      `  mapping="${gp.mapping || '(none)'}" ` +
      `${gp.buttons.length} buttons  ${gp.axes.length} axes\n` +
      `  axes: [${Array.from(gp.axes).map(a => a.toFixed(2)).join(', ')}]`
    );
    console.log('[gamepad] Press each button/dpad to see its index in the console.');
  }

  function onConnect(e: GamepadEvent) {
    if (gamepadIndex === null) {
      gamepadIndex = e.gamepad.index;
      logGamepad(e.gamepad);
      onConnectionChange(true);
    }
  }

  function onDisconnect(e: GamepadEvent) {
    if (e.gamepad.index === gamepadIndex) {
      console.log('[gamepad] disconnected');
      gamepadIndex = null;
      prevButtons = {};
      prevAxes = {};
      prevDPad = { up: false, down: false, left: false, right: false };
      prevL1 = false;
      repeating.clear();
      onConnectionChange(false);
      onL1Change(false);
    }
  }

  window.addEventListener('gamepadconnected', onConnect);
  window.addEventListener('gamepaddisconnected', onDisconnect);

  for (const gp of navigator.getGamepads()) {
    if (gp) {
      gamepadIndex = gp.index;
      logGamepad(gp);
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

    // Debug: log newly pressed buttons and significant axis changes
    for (let i = 0; i < gp.buttons.length; i++) {
      if ((gp.buttons[i]?.pressed ?? false) && !(prevButtons[i] ?? false)) {
        console.log(`[gamepad] button ${i} pressed`);
      }
    }
    for (let i = 0; i < gp.axes.length; i++) {
      const v = gp.axes[i] ?? 0;
      const prev = prevAxes[i] ?? 0;
      if (Math.abs(v) > AXIS_THRESHOLD && Math.abs(prev) <= AXIS_THRESHOLD) {
        console.log(`[gamepad] axis ${i} = ${v.toFixed(2)}`);
      }
    }

    const l1 = isPressed(gp, BTN_L1);
    const dp  = readDPad(gp);

    if (l1 !== prevL1) onL1Change(l1);

    const activeRepeatKeys = new Set<string>();

    if (l1) {
      if (dp.up)    { fireRepeatable({ type: "focusUp" },    now); activeRepeatKeys.add("focusUp"); }
      if (dp.down)  { fireRepeatable({ type: "focusDown" },  now); activeRepeatKeys.add("focusDown"); }
      if (dp.left)  { fireRepeatable({ type: "sliderLeft" }, now); activeRepeatKeys.add("sliderLeft"); }
      if (dp.right) { fireRepeatable({ type: "sliderRight" },now); activeRepeatKeys.add("sliderRight"); }
    } else {
      if (dp.up)   { fireRepeatable({ type: "speedUp" },   now); activeRepeatKeys.add("speedUp"); }
      if (dp.down) { fireRepeatable({ type: "speedDown" }, now); activeRepeatKeys.add("speedDown"); }
      if (dp.left  && !prevDPad.left)  handler({ type: "prev" });
      if (dp.right && !prevDPad.right) handler({ type: "next" });
    }

    for (const key of repeating.keys()) {
      if (!activeRepeatKeys.has(key)) repeating.delete(key);
    }

    // Single-fire buttons
    if (wasJustPressed(gp, BTN_SOUTH))           handler({ type: "resetToDefault" });
    if (wasJustPressed(gp, BTN_START))           handler({ type: "freeze" });
    if (wasJustPressed(gp, BTN_RANDOMIZE))      handler({ type: "randomize" });
    if (wasJustPressed(gp, BTN_TOGGLE_OVERLAY)) handler({ type: "toggleOverlay" });
    if (wasJustPressed(gp, BTN_BLACKOUT))       handler({ type: "blackout" });
    if (wasJustPressed(gp, BTN_R1))             handler({ type: "screenshot" });
    if (wasJustPressed(gp, BTN_L2))             handler({ type: "toggleRecording" });
    if (wasJustPressed(gp, BTN_R2))             handler({ type: "toggleCamera" });

    for (let i = 0; i < gp.buttons.length; i++) {
      prevButtons[i] = gp.buttons[i]?.pressed ?? false;
    }
    for (let i = 0; i < gp.axes.length; i++) {
      prevAxes[i] = gp.axes[i] ?? 0;
    }
    prevDPad = { ...dp };
    prevL1 = l1;
  }

  function dispose() {
    window.removeEventListener('gamepadconnected', onConnect);
    window.removeEventListener('gamepaddisconnected', onDisconnect);
  }

  return { poll, dispose };
}
