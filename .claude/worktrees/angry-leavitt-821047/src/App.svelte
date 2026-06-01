<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { createRenderer, type RendererHandle } from "./lib/renderer";
  import { attachKeyboard, type KeyAction } from "./lib/keyboard";
  import { createGamepadController, type GamepadAction } from "./lib/gamepad";
  import { takeScreenshot } from "./lib/screenshot";
  import { createRecorder, type RecorderHandle } from "./lib/recording";
  import { attachTouch } from "./lib/touch";
  import { patterns } from "./lib/patterns";
  import * as fs from "./lib/fullscreen";
  import { loadSettings, saveSettings, loadDemoSettings, saveDemoSettings } from "./lib/settings";
  import type { PatternControl } from "./lib/patterns/types";
  import { restoreFromKeys } from "./lib/persist";
  import { createMIDIController } from "./lib/midi";
  import type { MIDIAction } from "./lib/midi";
  import { popUndo, setUndoing } from "./lib/undo";
  import { encodeShare, decodeShare } from "./lib/shareUrl";
  import { getSlots, saveSlot } from "./lib/presets";
  import type { Snapshot } from "./lib/presets";
  import { poseState, startPoseTracking, stopPoseTracking } from "./lib/pose";

  type AppState = "overview" | "active" | "preview";

  let canvas: HTMLCanvasElement;
  let handle: RendererHandle | null = null;
  let appState = $state<AppState>("overview");
  let index = $state(0);
  let focusedIndex = $state(0);
  let hudVisible = $state(true);
  let hudTimer: ReturnType<typeof setTimeout> | null = null;
  let isTouch = $state(false);
  let isIosStandalone = $state(false);
  let isIosBrowser = $state(false);

  // Standard color palette
  const PALETTE_DEFAULTS = {
    cyan:    '#00ffff',
    magenta: '#ff00ff',
    purple:  '#9900ff',
    gold:    '#ffd700',
    white:   '#ffffff',
    black:   '#000000',
  } as const;
  type PaletteKey = keyof typeof PALETTE_DEFAULTS;
  const PALETTE_KEY = 'pp:palette';

  let palette = $state({ ...PALETTE_DEFAULTS });

  function savePalette() {
    localStorage.setItem(PALETTE_KEY, JSON.stringify(palette));
  }
  function resetPaletteColor(key: PaletteKey) {
    palette[key] = PALETTE_DEFAULTS[key];
    savePalette();
  }

  // Demo mode
  let demoActive = $state(false);
  let demoDwell = $state(30);
  let demoPatternIds = $state<Set<string>>(new Set(patterns.map(p => p.id)));
  let demoTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotUrl = $state<string | null>(null);
  let snapshotFading = $state(false);

  // MIDI / audio / sharing state
  let midiConnected = $state(false);
  let favorites = $state(new Set<string>());
  let showFavoritesOnly = $state(false);
  let presetSlots = $state<(Snapshot | null)[]>([null, null, null]);
  let copiedLink = $state(false);
  let slotPressTimer: ReturnType<typeof setTimeout> | null = null;
  let slotFlash = $state<number | null>(null);

  // Gamepad / controller state
  let gamepadConnected = $state(false);
  let kbRHeld  = $state(false);   // keyboard R hold
  const sliderModeActive = $derived(kbRHeld);
  let screenshotFlash = $state(false);
  let isRecording = $state(false);
  let recorder: RecorderHandle | null = null;
  let timeScaleMirror = $state(1.0);
  let frozenPrevScale = $state(1.0);
  let sliderFocusIndex = $state(0);
  let blackout = $state(false);
  let overlayHidden = $state(false);
  let cheatsheetVisible = $state(false);
  let collapsedSections = $state(new Set<string>());

  // Body pose tracking
  let posePersonCount = $state(0);
  let poseActive = $state(false);
  let poseError = $state<string | null>(null);
  let poseLoading = $state(false);
  let poseDebug = $state(false);
  let debugCanvas: HTMLCanvasElement | undefined = $state();

  async function togglePoseTracking() {
    if (poseLoading) return;
    if (poseState.active) {
      stopPoseTracking();
      poseActive = false;
      poseError = null;
    } else {
      poseLoading = true;
      poseError = null;
      try {
        await startPoseTracking();
        poseActive = true;
      } catch (e) {
        poseError = e instanceof Error ? e.message : "Camera access denied";
        poseActive = false;
      } finally {
        poseLoading = false;
      }
    }
  }

  type RandAnim  = { from: number; to: number; startMs: number };
  type FreezeAnim = { from: number; to: number; startMs: number };
  let randomizeAnims = $state<Record<string, RandAnim>>({});
  let freezeAnim = $state<FreezeAnim | null>(null);
  const isFreezing = $derived(freezeAnim ? freezeAnim.to === 0 : timeScaleMirror === 0);

  const rangeControls = $derived(
    (patterns[index]?.controls ?? []).filter(c => c.type === 'range') as
      (import('./lib/patterns/types').PatternControl & { type: 'range' })[]
  );

  // Reset slider focus when pattern changes
  $effect(() => { const _ = index; sliderFocusIndex = 0; });

  const displayPatterns = $derived(
    showFavoritesOnly
      ? patterns.map((p, i) => ({ p, i })).filter(({ p }) => favorites.has(p.id))
      : patterns.map((p, i) => ({ p, i }))
  );

  // Reactive mirror of current pattern's control values so the display
  // updates live as the user drags a slider (or types in a text field).
  let ctrlVals = $state<Record<string, number | string>>({});

  function syncCtrlVals() {
    const next: Record<string, number | string> = {};
    for (const c of patterns[index]?.controls ?? []) {
      if (c.type === 'separator') continue;
      if (c.type === 'button') continue;
      if (c.type === 'toggle' || c.type === 'section') next[c.label] = c.get() ? 1 : 0;
      else if (c.type === 'text' || c.type === 'color') next[c.label] = c.get();
      else next[c.label] = c.get();
    }
    ctrlVals = next;
  }

  // Re-sync whenever the active pattern changes.
  $effect(() => { const _ = index; syncCtrlVals(); });
  $effect(() => { const _ = index; presetSlots = getSlots(patterns[index]?.id ?? ''); });

  function resetCtrl(ctrl: PatternControl & { type: "range" }) {
    if (ctrl.default === undefined) return;
    ctrl.set(ctrl.default);
    ctrlVals[ctrl.label] = ctrl.default;
    saveSettings(patterns);
  }

  function resetAllControls() {
    for (const c of patterns[index]?.controls ?? []) {
      if (c.type === 'range' && c.default !== undefined && !c.readonly) {
        c.set(c.default);
        ctrlVals[c.label] = c.default;
      }
    }
    saveSettings(patterns);
  }

  function randomizeControls() {
    for (const c of patterns[index]?.controls ?? []) {
      if (c.type === 'range' && !c.readonly) {
        const steps = Math.round((c.max - c.min) / c.step);
        const r = Math.floor(Math.random() * (steps + 1));
        const v = parseFloat(Math.min(c.max, c.min + r * c.step).toFixed(10));
        c.set(v);
        ctrlVals[c.label] = v;
      }
    }
    saveSettings(patterns);
  }

  function poke() {
    hudVisible = true;
    overlayHidden = false;
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hudVisible = false), 5000);
  }

  function switchTo(n: number): number {
    const i = ((n % patterns.length) + patterns.length) % patterns.length;
    handle?.setPattern(patterns[i]);
    return i;
  }

  function activatePattern(n: number) {
    index = switchTo(n);
    focusedIndex = index;
    handle?.activateCurrentPattern();
    appState = "active";
    overlayHidden = false;
    poke();
  }

  function activateFullscreen(n: number) {
    activatePattern(n);
    fs.enter(document.documentElement);
  }

  function nextDemoIndex(from: number): number {
    const count = patterns.length;
    for (let i = 1; i <= count; i++) {
      const next = (from + i) % count;
      if (demoPatternIds.has(patterns[next].id)) return next;
    }
    return from; // all disabled or only current enabled — stay put
  }

  function crossFadeTo(n: number) {
    snapshotUrl = canvas.toDataURL();
    snapshotFading = false;
    index = switchTo(n);
    focusedIndex = index;
    requestAnimationFrame(() => requestAnimationFrame(() => { snapshotFading = true; }));
  }

  function scheduleNext() {
    demoTimer = setTimeout(() => {
      crossFadeTo(nextDemoIndex(index));
      scheduleNext();
    }, demoDwell * 1000);
  }

  function startDemo() {
    demoActive = true;
    if (appState === "overview") {
      handle?.setPattern(patterns[index]);
      appState = "active";
      poke();
    }
    saveDemoSettings(true, demoDwell, [...demoPatternIds]);
    if (demoTimer) clearTimeout(demoTimer);
    scheduleNext();
  }

  function stopDemo() {
    demoActive = false;
    saveDemoSettings(false, demoDwell, [...demoPatternIds]);
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  }

  function resetDemoTimer() {
    if (!demoActive) return;
    if (demoTimer) clearTimeout(demoTimer);
    scheduleNext();
  }

  function handleAction(action: KeyAction) {
    // Any action dismisses the cheatsheet
    if (cheatsheetVisible) { cheatsheetVisible = false; return; }

    // Global regardless of state
    if (action.type === "togglePose") { togglePoseTracking(); return; }

    // Overview: navigation + activate only; all other actions suppressed
    if (appState === "overview") {
      switch (action.type) {
        case "next":
          focusedIndex = (focusedIndex + 1) % patterns.length;
          switchTo(focusedIndex);
          break;
        case "prev":
          focusedIndex = (focusedIndex - 1 + patterns.length) % patterns.length;
          switchTo(focusedIndex);
          break;
        case "speedDown": // ↓ moves one row down in the 3-column grid
          focusedIndex = Math.min(patterns.length - 1, focusedIndex + 3);
          switchTo(focusedIndex);
          break;
        case "speedUp":   // ↑ moves one row up
          focusedIndex = Math.max(0, focusedIndex - 3);
          switchTo(focusedIndex);
          break;
        case "jump":
          if (action.index < patterns.length) { focusedIndex = action.index; switchTo(focusedIndex); }
          break;
        case "resetToDefault": // B / South → activate (confirm button)
        case "freeze":         // Space / Start / Enter → activate
        case "randomize":      // A → activate
          activatePattern(focusedIndex);
          break;
        case "fullscreen":
          activateFullscreen(focusedIndex);
          break;
        case "toggleCheatsheet":
          cheatsheetVisible = !cheatsheetVisible;
          break;
      }
      return;
    }

    // Global actions for active + preview
    switch (action.type) {
      case "freeze":           applyFreeze();    return;
      case "blackout":         blackout = !blackout; return;
      case "randomize":        startRandomize(performance.now()); return;
      case "resetToDefault":   resetAllControls(); return;
      case "screenshot":       applyScreenshot(); return;
      case "toggleRecording":  recorder?.toggle(); return;
      case "toggleCamera":     toggleCamera();        return;
      case "speedUp":          applySpeedUp();   return;
      case "speedDown":        applySpeedDown(); return;
      case "focusUp":          sliderFocusIndex = Math.max(0, sliderFocusIndex - 1); return;
      case "focusDown":        sliderFocusIndex = Math.min(Math.max(rangeControls.length - 1, 0), sliderFocusIndex + 1); return;
      case "sliderLeft":       applySliderStep("left");  return;
      case "sliderRight":      applySliderStep("right"); return;
      case "toggleOverlay":
        if (hudVisible && !overlayHidden) { overlayHidden = true; }
        else { overlayHidden = false; poke(); }
        return;
      case "toggleCheatsheet": cheatsheetVisible = !cheatsheetVisible; return;
      case "undo":             applyUndo(); return;
    }

    if (appState === "active") {
      switch (action.type) {
        case "next":
          index = switchTo(index + 1); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); break;
        case "prev":
          index = switchTo(index - 1); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); break;
        case "jump":
          if (action.index < patterns.length) { index = switchTo(action.index); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); }
          break;
        case "fullscreen":
          fs.toggle(document.documentElement); hudVisible = false; break;
        case "demo":
          demoActive ? stopDemo() : startDemo(); break;
        case "escape":
          if (fs.isFullscreen()) fs.exit();
          appState = "preview"; overlayHidden = false; break;
      }
    } else {
      // preview
      switch (action.type) {
        case "next":
          index = switchTo(index + 1); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); break;
        case "prev":
          index = switchTo(index - 1); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); break;
        case "jump":
          if (action.index < patterns.length) { index = switchTo(action.index); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); }
          break;
        case "fullscreen":
          fs.enter(document.documentElement); appState = "active"; hudVisible = false; break;
        case "demo":
          demoActive ? stopDemo() : startDemo(); break;
        case "escape":
          focusedIndex = index; appState = "overview"; overlayHidden = false; break;
      }
    }
  }

  function startRandomize(now: number) {
    const anims: Record<string, RandAnim> = {};
    for (const ctrl of patterns[index]?.controls ?? []) {
      if (/camera|microphone/i.test(ctrl.label)) continue;
      if (ctrl.type === 'range' && !ctrl.readonly) {
        anims[ctrl.label] = { from: ctrl.get(), to: ctrl.min + Math.random() * (ctrl.max - ctrl.min), startMs: now };
      } else if (ctrl.type === 'select' && !ctrl.disabled?.()) {
        const opts = typeof ctrl.options === 'function' ? ctrl.options() : ctrl.options;
        const idx = Math.floor(Math.random() * opts.length);
        ctrl.set(idx);
        ctrlVals[ctrl.label] = idx;
      }
    }
    randomizeAnims = anims;
  }

  function toggleCamera() {
    const ctrl = (patterns[index]?.controls ?? []).find(
      c => c.type === 'section' && c.label === 'Motion Detection Camera'
    );
    if (ctrl && ctrl.type === 'section') { ctrl.set(!ctrl.get()); syncCtrlVals(); }
  }

  function applyFreeze() {
    const currentTarget = freezeAnim ? freezeAnim.to : (handle?.getTimeScale() ?? 1);
    const curActual = handle?.getTimeScale() ?? currentTarget;
    if (currentTarget === 0) {
      const restore = frozenPrevScale > 0 ? frozenPrevScale : 1.0;
      freezeAnim = { from: curActual, to: restore, startMs: performance.now() };
    } else {
      frozenPrevScale = currentTarget;
      freezeAnim = { from: curActual, to: 0, startMs: performance.now() };
    }
  }

  function applySpeedUp() {
    freezeAnim = null;
    const cur = handle?.getTimeScale() ?? 1;
    const next = Math.min(8, parseFloat((cur + 0.1).toFixed(2)));
    handle?.setTimeScale(next);
    timeScaleMirror = next;
    if (next > 0) frozenPrevScale = next;
  }

  function applySpeedDown() {
    freezeAnim = null;
    const cur = handle?.getTimeScale() ?? 1;
    const next = Math.max(0, parseFloat((cur - 0.1).toFixed(2)));
    handle?.setTimeScale(next);
    timeScaleMirror = next;
    if (next > 0) frozenPrevScale = next;
  }

  function applyScreenshot() {
    const c = handle?.getCanvas();
    if (c) {
      takeScreenshot(c);
      screenshotFlash = true;
      setTimeout(() => { screenshotFlash = false; }, 800);
    }
  }

  function applyToggleRecording() {
    const c = handle?.getCanvas();
    if (!c) return;
    if (isRecording) { stopRecording(); isRecording = false; }
    else             { startRecording(c); isRecording = true; }
  }

  function applyUndo() {
    const entry = popUndo();
    if (!entry || entry.patternId !== patterns[index].id) return;
    const ctrl = (patterns[index].controls ?? []).find(
      c => c.type !== 'button' && c.type !== 'separator' && c.label === entry.label
    );
    if (!ctrl || ctrl.type === 'button' || ctrl.type === 'separator') return;
    setUndoing(true);
    if (ctrl.type === 'toggle' || ctrl.type === 'section') ctrl.set(entry.value as boolean);
    else if (ctrl.type === 'text' || ctrl.type === 'color') ctrl.set(String(entry.value));
    else ctrl.set(entry.value as number);
    ctrlVals[entry.label] = entry.value as number | string;
    saveSettings(patterns);
    setUndoing(false);
  }

  function applySliderStep(dir: "left" | "right") {
    const ctrl = rangeControls[sliderFocusIndex];
    if (ctrl && !ctrl.readonly) {
      const delta = dir === "right" ? ctrl.step : -ctrl.step;
      const next = Math.min(ctrl.max, Math.max(ctrl.min, ctrl.get() + delta));
      ctrl.set(next);
      ctrlVals[ctrl.label] = next;
      saveSettings(patterns);
    }
  }

  function handleMIDIAction(action: MIDIAction) {
    if (action.type === 'setSlider') {
      const ctrl = rangeControls[action.index];
      if (!ctrl || ctrl.readonly) return;
      const v = parseFloat((ctrl.min + action.value * (ctrl.max - ctrl.min)).toFixed(10));
      const clamped = Math.min(ctrl.max, Math.max(ctrl.min, v));
      ctrl.set(clamped);
      ctrlVals[ctrl.label] = clamped;
      saveSettings(patterns);
      return;
    }
    handleAction(action as import('./lib/keyboard').KeyAction);
  }

  // ── Preset slots ──────────────────────────────────────────────────────────

  function takeSnapshot(): Snapshot {
    const snap: Snapshot = {};
    for (const ctrl of patterns[index].controls ?? []) {
      if (ctrl.type === 'button' || ctrl.type === 'separator') continue;
      snap[ctrl.label] = ctrl.get();
    }
    return snap;
  }

  function restorePreset(idx: number) {
    const snap = presetSlots[idx];
    if (!snap) return;
    const anims: Record<string, RandAnim> = {};
    const now = performance.now();
    for (const ctrl of patterns[index].controls ?? []) {
      if (ctrl.type !== 'range' || ctrl.readonly) continue;
      const target = snap[ctrl.label];
      if (typeof target === 'number') {
        anims[ctrl.label] = { from: ctrl.get(), to: target, startMs: now };
      }
    }
    for (const ctrl of patterns[index].controls ?? []) {
      if (ctrl.type === 'button' || ctrl.type === 'separator' || ctrl.type === 'range') continue;
      const target = snap[ctrl.label];
      if (target !== undefined) {
        if (ctrl.type === 'toggle' || ctrl.type === 'section') ctrl.set(!!target);
        else if (ctrl.type === 'text' || ctrl.type === 'color') ctrl.set(String(target));
        else ctrl.set(target as number);
        ctrlVals[ctrl.label] = ctrl.get() as number | string;
      }
    }
    randomizeAnims = anims;
    saveSettings(patterns);
  }

  function saveCurrentToSlot(idx: number) {
    saveSlot(patterns[index].id, idx, takeSnapshot());
    presetSlots = getSlots(patterns[index].id);
    slotFlash = idx;
    setTimeout(() => { slotFlash = null; }, 400);
  }

  function onSlotPointerDown(idx: number) {
    if (presetSlots[idx] === null) { saveCurrentToSlot(idx); return; }
    slotPressTimer = setTimeout(() => { slotPressTimer = null; saveCurrentToSlot(idx); }, 500);
  }

  function onSlotPointerUp(idx: number) {
    if (slotPressTimer !== null) { clearTimeout(slotPressTimer); slotPressTimer = null; restorePreset(idx); }
  }

  function onSlotPointerCancel() {
    if (slotPressTimer !== null) { clearTimeout(slotPressTimer); slotPressTimer = null; }
  }

  // ── Favorites ─────────────────────────────────────────────────────────────

  const FAVORITES_KEY = 'pp:favorites';

  function loadFavorites() {
    const raw = localStorage.getItem(FAVORITES_KEY);
    favorites = new Set(raw ? raw.split(',').filter(Boolean) : []);
  }

  function toggleFavorite(patternId: string) {
    const next = new Set(favorites);
    if (next.has(patternId)) next.delete(patternId); else next.add(patternId);
    favorites = next;
    localStorage.setItem(FAVORITES_KEY, [...next].join(','));
  }

  // ── URL sharing ───────────────────────────────────────────────────────────

  function copyShare() {
    encodeShare(patterns[index]);
    navigator.clipboard?.writeText(location.href).then(() => {
      copiedLink = true;
      setTimeout(() => { copiedLink = false; }, 2000);
    }).catch(() => {});
  }

  function handleGamepadAction(action: GamepadAction) {
    // Any action dismisses the cheatsheet
    if (cheatsheetVisible) { cheatsheetVisible = false; return; }

    // Overview: navigation + activate only
    if (appState === "overview") {
      switch (action.type) {
        case "next":
          focusedIndex = (focusedIndex + 1) % patterns.length; switchTo(focusedIndex); break;
        case "prev":
          focusedIndex = (focusedIndex - 1 + patterns.length) % patterns.length; switchTo(focusedIndex); break;
        case "speedDown":
          focusedIndex = Math.min(patterns.length - 1, focusedIndex + 3); switchTo(focusedIndex); break;
        case "speedUp":
          focusedIndex = Math.max(0, focusedIndex - 3); switchTo(focusedIndex); break;
        case "resetToDefault":
        case "freeze":
        case "randomize":
          activatePattern(focusedIndex); break;
        case "toggleOverlay":
          if (hudVisible && !overlayHidden) { overlayHidden = true; }
          else { overlayHidden = false; poke(); }
          break;
      }
      return;
    }

    switch (action.type) {
      case "next":
        index = switchTo(index + 1); focusedIndex = index; resetDemoTimer(); break;
      case "prev":
        index = switchTo(index - 1); focusedIndex = index; resetDemoTimer(); break;
      case "speedUp":          applySpeedUp();   break;
      case "speedDown":        applySpeedDown(); break;
      case "freeze":           applyFreeze();    break;
      case "blackout":         blackout = !blackout; break;
      case "resetToDefault":   resetAllControls(); break;
      case "screenshot":       applyScreenshot(); break;
      case "toggleRecording":  recorder?.toggle(); break;
      case "randomize":        startRandomize(performance.now()); break;
      case "toggleCamera":     toggleCamera(); break;
      case "toggleOverlay":
        if (hudVisible && !overlayHidden) { overlayHidden = true; }
        else { overlayHidden = false; poke(); }
        break;
      case "toggleCheatsheet":  cheatsheetVisible = !cheatsheetVisible; return;
      case "escape":
        overlayHidden = false;
        if (appState === "active") { focusedIndex = index; appState = "overview"; }
        else if (appState === "preview") activatePattern(focusedIndex);
        return;
      case "focusUp":
        sliderFocusIndex = Math.max(0, sliderFocusIndex - 1); break;
      case "focusDown":
        sliderFocusIndex = Math.min(Math.max(rangeControls.length - 1, 0), sliderFocusIndex + 1); break;
      case "sliderLeft":  applySliderStep("left");  break;
      case "sliderRight": applySliderStep("right"); break;
    }
  }

  onMount(() => {
    isTouch = "ontouchstart" in window;
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    isIosStandalone = isIos && (navigator as any).standalone === true;
    isIosBrowser = isIos && !isIosStandalone;
    loadSettings(patterns);
    restoreFromKeys(patterns); // pp: keys are more current than the blob; let them win
    syncCtrlVals();
    const demo = loadDemoSettings(patterns.map(p => p.id));
    demoDwell = demo.demoDwell;
    demoPatternIds = new Set(demo.demoPatternIds);
    handle = createRenderer(canvas, patterns[0]);
    recorder = createRecorder(handle.getCanvas(), (r) => { isRecording = r; });
    if (demo.demoActive) startDemo();

    const gpController = createGamepadController(
      handleGamepadAction,
      (c) => { gamepadConnected = c; },
    );

    const midiController = createMIDIController(
      handleMIDIAction,
      (c) => { midiConnected = c; },
    );

    // Apply shared URL if present
    const shared = decodeShare();
    if (shared) {
      const pIdx = patterns.findIndex(p => p.id === shared.patternId);
      if (pIdx >= 0) {
        index = switchTo(pIdx);
        focusedIndex = pIdx;
        for (const ctrl of patterns[pIdx].controls ?? []) {
          if (ctrl.type === 'button' || ctrl.type === 'separator') continue;
          const val = shared.controls[ctrl.label];
          if (val === undefined) continue;
          if (ctrl.type === 'toggle' || ctrl.type === 'section') ctrl.set(!!val);
          else if (ctrl.type === 'text' || ctrl.type === 'color') ctrl.set(String(val));
          else ctrl.set(val as number);
        }
        syncCtrlVals();
        appState = 'active';
        poke();
      }
    }

    loadFavorites();

    const rawP = localStorage.getItem(PALETTE_KEY);
    if (rawP) {
      try {
        const p = JSON.parse(rawP);
        for (const k of Object.keys(PALETTE_DEFAULTS) as PaletteKey[]) {
          if (typeof p[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(p[k])) palette[k] = p[k];
        }
      } catch {}
    }


    // Keep ctrlVals in sync every frame so motion-reactive sliders move live.
    let liveRaf: number;
    const liveSync = (now: number) => {
      gpController.poll(now);

      // Animate freeze / unfreeze (ease-in-out over 0.5 s)
      if (freezeAnim) {
        const t = Math.min(1, (now - freezeAnim.startMs) / 500);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        const v = freezeAnim.from + (freezeAnim.to - freezeAnim.from) * ease;
        handle?.setTimeScale(v);
        timeScaleMirror = v;
        if (t >= 1) {
          handle?.setTimeScale(freezeAnim.to);
          timeScaleMirror = freezeAnim.to;
          freezeAnim = null;
        }
      }

      // Animate randomize targets (ease-in-out over 1 s)
      const animKeys = Object.keys(randomizeAnims);
      if (animKeys.length > 0) {
        let anyDone = false;
        for (const ctrl of patterns[index]?.controls ?? []) {
          if (ctrl.type !== 'range') continue;
          const anim = randomizeAnims[ctrl.label];
          if (!anim) continue;
          const t = Math.min(1, (now - anim.startMs) / 1000);
          const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
          ctrl.set(anim.from + (anim.to - anim.from) * ease);
          ctrlVals[ctrl.label] = ctrl.get();
          if (t >= 1) anyDone = true;
        }
        if (anyDone) {
          const next: Record<string, RandAnim> = {};
          for (const ctrl of patterns[index]?.controls ?? []) {
            if (ctrl.type === 'range' && ctrl.label in randomizeAnims) {
              const anim = randomizeAnims[ctrl.label];
              if ((now - anim.startMs) / 1000 < 1) next[ctrl.label] = anim;
            }
          }
          randomizeAnims = next;
          saveSettings(patterns);
        }
      }

      if (hudVisible && appState !== 'overview') {
        for (const c of patterns[index]?.controls ?? []) {
          if (c.type === 'range') {
            const v = c.get();
            if (ctrlVals[c.label] !== v) ctrlVals[c.label] = v;
          } else if (c.type === 'toggle' || c.type === 'section') {
            const v = c.get() ? 1 : 0;
            if (ctrlVals[c.label] !== v) ctrlVals[c.label] = v;
          } else if (c.type === 'select') {
            // Keep current index in sync; re-reading also lets Svelte re-evaluate ctrl.options()
            const v = c.get();
            if (ctrlVals[c.label] !== v) ctrlVals[c.label] = v;
          } else if (c.type === 'text' || c.type === 'color') {
            const v = c.get();
            if (ctrlVals[c.label] !== v) ctrlVals[c.label] = v;
          }
        }
      }
      // Sync pose person count for HUD reactivity
      const pc = poseState.persons.length;
      if (posePersonCount !== pc) posePersonCount = pc;

      // Debug overlay: draw landmarks on canvas
      if (poseDebug && debugCanvas) {
        const dw = window.innerWidth, dh = window.innerHeight;
        if (debugCanvas.width !== dw) debugCanvas.width = dw;
        if (debugCanvas.height !== dh) debugCanvas.height = dh;
        const dCtx = debugCanvas.getContext('2d');
        if (dCtx) {
          dCtx.clearRect(0, 0, dw, dh);
          // Point labels and colors: [leftWrist, rightWrist, hipCenter]
          const COLORS = ['#00ff88', '#4499ff', '#ffcc00'];
          const LABELS = ['LW', 'RW', 'HIP'];
          poseState.persons.forEach((person, pi) => {
            person.forEach((pt, ji) => {
              const cx = pt.x * dw, cy = pt.y * dh;
              dCtx.beginPath();
              dCtx.arc(cx, cy, 14, 0, Math.PI * 2);
              dCtx.fillStyle = COLORS[ji] + '44';
              dCtx.fill();
              dCtx.strokeStyle = COLORS[ji];
              dCtx.lineWidth = 2.5;
              dCtx.stroke();
              dCtx.fillStyle = COLORS[ji];
              dCtx.font = 'bold 11px monospace';
              dCtx.textAlign = 'center';
              dCtx.textBaseline = 'middle';
              dCtx.fillText(`P${pi + 1} ${LABELS[ji]}`, cx, cy);
            });
          });
          // Legend
          dCtx.font = '11px monospace';
          dCtx.textAlign = 'left';
          COLORS.forEach((c, i) => {
            dCtx.fillStyle = c;
            dCtx.fillRect(12, 12 + i * 18, 10, 10);
            dCtx.fillStyle = 'rgba(255,255,255,0.8)';
            dCtx.fillText(LABELS[i], 26, 18 + i * 18);
          });
          dCtx.fillStyle = 'rgba(255,255,255,0.5)';
          dCtx.fillText(`${poseState.persons.length} person(s)`, 12, 68);
        }
      } else if (debugCanvas) {
        const dCtx = debugCanvas.getContext('2d');
        dCtx?.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
      }

      liveRaf = requestAnimationFrame(liveSync);
    };
    liveRaf = requestAnimationFrame(liveSync);

    const detach = attachKeyboard(handleAction, (held) => { kbRHeld = held; });
    const detachTouch = attachTouch(handleAction);

    function onFsChange() {
      if (!fs.isFullscreen() && appState === "active") {
        appState = "preview";
        poke();
      }
    }
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    // Keep the blob fresh so it never lags behind pp: keys
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveSettings(patterns);
    });
    // Re-hydrate controls when Arc (or any browser) restores the page from bfcache
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) {
        loadSettings(patterns);
        restoreFromKeys(patterns);
        syncCtrlVals();
      }
    });
    window.addEventListener("mousemove", poke);
    window.addEventListener("keydown", poke);

    return () => {
      cancelAnimationFrame(liveRaf);
      gpController.dispose();
      midiController.dispose();
      detach();
      detachTouch();
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      window.removeEventListener("mousemove", poke);
      window.removeEventListener("keydown", poke);
      if (hudTimer) clearTimeout(hudTimer);
      if (demoTimer) clearTimeout(demoTimer);
      recorder?.dispose();
      recorder = null;
      handle?.dispose();
      handle = null;
    };
  });
</script>

<canvas bind:this={debugCanvas} class="pointer-events-none fixed inset-0 z-30 w-full h-full"></canvas>

<canvas bind:this={canvas} class="block w-full h-full"
  onclick={() => { if (appState !== "overview" && !isTouch) hudVisible = false; }}
  ontouchstart={() => { if (appState !== "overview") poke(); }}
></canvas>

<!-- ─── Cross-fade snapshot overlay ──────────────────────────────────── -->
{#if snapshotUrl}
  <img
    src={snapshotUrl}
    class="pointer-events-none fixed inset-0 z-[5] h-full w-full object-cover transition-opacity duration-[1500ms]"
    class:opacity-0={snapshotFading}
    class:opacity-100={!snapshotFading}
    ontransitionend={() => { snapshotUrl = null; snapshotFading = false; }}
    alt=""
  />
{/if}

<!-- ─── Overview overlay ──────────────────────────────────────────────── -->
{#if appState === "overview"}
  <div
    role="presentation"
    class="fixed inset-0 z-20 flex flex-col items-center overflow-y-auto bg-black/70 backdrop-blur-sm"
    onclick={(e) => { if (e.target === e.currentTarget) activatePattern(focusedIndex); }}
  >

    <div class="shrink-0 pt-10 pb-4 text-center">
      <p class="text-sm uppercase tracking-[0.35em] text-white/60">Lichtspiel</p>
      <p class="text-[10px] tracking-widest text-white/30">by <a href="https://1000lights.de" target="_blank" rel="noopener noreferrer" class="hover:text-white/60 transition-colors">1000lights</a></p>
      <div class="mt-3 flex justify-center gap-2">
        <button
          class="rounded-md border px-3 py-1.5 text-xs transition-colors cursor-pointer {demoActive ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 bg-white/[0.07] text-white/60 hover:border-white/40 hover:bg-white/15'}"
          onclick={() => { demoActive ? stopDemo() : startDemo(); }}
        >{demoActive ? "● Demo" : "Demo"}</button>
        {#if !isIosBrowser && !isIosStandalone}
          <button
            class="rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/60 transition-colors cursor-pointer hover:border-white/40 hover:bg-white/15"
            onclick={() => { handleAction({ type: "fullscreen" }); }}
          >{fs.isFullscreen() ? "Exit ⛶" : "⛶ Fullscreen"}</button>
        {/if}
      </div>
    </div>

    <!-- Favorites filter bar -->
    <div class="flex gap-1.5 px-3 pb-3 flex-wrap justify-center">
      <button
        class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer
          {!showFavoritesOnly ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/50 hover:border-white/30'}"
        onclick={() => { showFavoritesOnly = false; }}
      >All</button>
      <button
        class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer
          {showFavoritesOnly ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/50 hover:border-white/30'}"
        onclick={() => { showFavoritesOnly = true; }}
      >★ Favorites</button>
      <div class="flex gap-1">
        <button
          class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer
            {poseActive ? 'border-green-400/50 bg-green-400/15 text-green-300' : poseError ? 'border-red-400/40 text-red-300/70' : 'border-white/15 text-white/50 hover:border-white/30'}"
          onclick={togglePoseTracking}
          disabled={poseLoading}
          title={poseError ?? (poseActive ? "Stop body tracking (T)" : "Start body tracking (T)")}
        >
          {#if poseLoading}⟳ Pose…{:else if poseActive}◉ Pose{posePersonCount > 0 ? ` (${posePersonCount})` : ''}{:else if poseError}✕ Pose{:else}◎ Pose{/if}
        </button>
        {#if poseActive}
          <button
            class="rounded-full border px-2.5 py-1 text-[11px] transition-colors cursor-pointer
              {poseDebug ? 'border-yellow-400/50 bg-yellow-400/15 text-yellow-300' : 'border-white/15 text-white/40 hover:border-white/30'}"
            onclick={() => { poseDebug = !poseDebug; }}
            title="Toggle landmark debug overlay"
          >⊹</button>
        {/if}
      </div>
    </div>

    <div class="grid grid-cols-3 gap-2 px-3 w-full max-w-lg pb-4">
      {#if showFavoritesOnly && displayPatterns.length === 0}
        <div class="col-span-3 py-8 text-center text-sm text-white/35">
          No favorites yet — star a pattern to add it here
        </div>
      {:else}
        {#each displayPatterns as { p, i }}
          {#if p.id === 'lightTrail' && !showFavoritesOnly}
            <div class="col-span-3 mt-2 flex items-center gap-2">
              <div class="h-px flex-1 bg-white/20"></div>
              <span class="text-[10px] uppercase tracking-widest text-white/40">Live Light Painting</span>
              <div class="h-px flex-1 bg-white/20"></div>
            </div>
          {/if}
          <button
            class="relative flex flex-col gap-1 rounded-xl border px-3 py-3 text-left transition-all duration-150 cursor-pointer
              {focusedIndex === i
                ? 'border-white bg-white/10 shadow-[0_0_28px_rgba(255,255,255,0.12)]'
                : 'border-white/15 bg-white/[0.04] hover:border-white/40 hover:bg-white/[0.07]'}"
            onclick={() => activatePattern(i)}
            onmouseenter={() => { focusedIndex = i; switchTo(i); }}
          >
            <span class="text-[10px] font-mono text-white/35">{i + 1}</span>
            <span class="text-[13px] font-semibold leading-snug text-white pr-5">{p.name}</span>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <span
              class="absolute right-3 top-2.5 text-sm transition-colors cursor-pointer {favorites.has(p.id) ? 'text-yellow-300/80' : 'text-white/20 hover:text-white/50'}"
              onclick={(e) => { e.stopPropagation(); toggleFavorite(p.id); }}
            >{favorites.has(p.id) ? '★' : '☆'}</span>
          </button>
        {/each}
      {/if}
    </div>

    <!-- Custom Palette -->
    <div class="w-full max-w-lg px-3 pb-5">
      <div class="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
        <div class="mb-3 flex items-center justify-between gap-2">
          <span class="text-xs uppercase tracking-widest text-white/50">Custom</span>
          <button
            onclick={() => { palette = { ...PALETTE_DEFAULTS }; savePalette(); }}
            class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer"
          >Reset All</button>
        </div>
        <div class="flex flex-col gap-2">
          {#each Object.entries(PALETTE_DEFAULTS) as [key]}
            {@const k = key as PaletteKey}
            <div class="flex items-center gap-2">
              <input
                type="color"
                value={palette[k]}
                oninput={(e) => { palette[k] = (e.target as HTMLInputElement).value; savePalette(); }}
                class="h-7 w-10 cursor-pointer rounded border border-white/20 bg-transparent p-0.5 shrink-0"
              />
              <span class="text-xs text-white/70 capitalize w-16 shrink-0">{key}</span>
              <span class="font-mono text-xs text-white/40 flex-1">{palette[k]}</span>
              {#if palette[k] !== PALETTE_DEFAULTS[k]}
                <button
                  onclick={() => resetPaletteColor(k)}
                  class="text-[10px] text-white/40 hover:text-white/70 border border-white/15 hover:border-white/40 rounded px-1.5 py-0.5 transition-colors cursor-pointer shrink-0"
                >↺</button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>

    <div class="shrink-0 pb-8 flex gap-5 text-[11px] text-white/30 px-4 text-center flex-wrap justify-center">
      {#if isIosBrowser}
        <span>tap to select · swipe to browse · <span class="text-white/50">Share ↑ → Add to Home Screen</span> for fullscreen</span>
      {:else if isTouch}
        <span>tap to select · swipe to browse</span>
      {:else}
        <span><kbd class="rounded bg-white/10 px-1.5 py-0.5 font-mono">← →</kbd> browse</span>
        <span><kbd class="rounded bg-white/10 px-1.5 py-0.5 font-mono">Enter</kbd> select</span>
        <span><kbd class="rounded bg-white/10 px-1.5 py-0.5 font-mono">F</kbd> fullscreen</span>
        <span><kbd class="rounded bg-white/10 px-1.5 py-0.5 font-mono">1–{patterns.length}</kbd> jump</span>
      {/if}
    </div>

    <div class="absolute bottom-4 right-4 font-mono text-[10px] text-white/20">{__COMMIT__}</div>

  </div>
{/if}

<!-- ─── Screenshot flash ─────────────────────────────────────────────── -->
{#if screenshotFlash}
  <div class="pointer-events-none fixed inset-0 z-50 bg-white/25 transition-opacity duration-500"></div>
{/if}

<!-- ─── Recording indicator ────────────────────────────────────────────── -->
{#if isRecording}
  <div class="pointer-events-none fixed top-4 right-4 z-50 flex items-center gap-2">
    <span class="h-3 w-3 animate-pulse rounded-full bg-red-500"></span>
    <span class="font-mono text-xs text-white/70">REC</span>
  </div>
{/if}

<!-- ─── Cheatsheet modal ──────────────────────────────────────────────── -->
{#if cheatsheetVisible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm"
    onclick={() => { cheatsheetVisible = false; }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="mx-4 w-full max-w-3xl rounded-xl border border-white/10 bg-black/90 p-5 text-white"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="mb-4 flex items-center justify-between">
        <span class="text-xs font-semibold uppercase tracking-[0.3em] text-white/60">Controls Reference</span>
        <button
          class="cursor-pointer rounded px-2 py-0.5 text-xs text-white/50 hover:text-white/80 transition-colors"
          onclick={() => { cheatsheetVisible = false; }}
        >✕  any key</button>
      </div>
      <table class="w-full border-collapse">
        <thead>
          <tr class="border-b border-white/20">
            <th class="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-white/50">Controls</th>
            <th class="pb-2 pl-4 text-left text-xs font-semibold uppercase tracking-wider text-white/50">Keyboard and 8BitDo Micro</th>
            <th class="pb-2 pl-4 text-left text-xs font-semibold uppercase tracking-wider text-white/50">Dual Shock</th>
          </tr>
        </thead>
        <tbody>
          {#each [
            ["Prev / next pattern",  "← →",               "D-Pad ← →"],
            ["Speed +/−",            "↑ ↓",               "D-Pad ↑ ↓"],
            ["Switch slider",        "R (hold) + ↑↓",     "R-Stick ↑↓"],
            ["Adjust slider",        "R (hold) + ←→",     "R-Stick ←→"],
            ["Reset controls",       "B  (South)",        "× / A"],
            ["Freeze toggle",        "Space / Start",     "Options / Start"],
            ["Randomize",            "A",                 "○ / B"],
            ["Blackout toggle",      "X",                 "△ / Y"],
            ["Hide / show HUD",      "Y",                 "□ / X"],
            ["Screenshot",           "L  ·  2 (R2)",      "R2 / RT"],
            ["Camera toggle",        "2  ·  L1",          "L1 / LB"],
            ["Record video",         "1  ·  L2",          "L2 / LT"],
            ["Controls reference",   "M",                 "R1 / RB"],
            ["Fullscreen",           "F",                 "—"],
            ["Demo mode",            "D",                 "—"],
            ["Jump to pattern",      "3 – 9",             "—"],
            ["Overview / back",      "Esc",               "Share / Back"],
          ] as row}
            <tr class="border-b border-white/[0.06]">
              <td class="py-1.5 pr-4 text-sm text-white/70 whitespace-nowrap">{row[0]}</td>
              <td class="py-1.5 pl-4 pr-4 font-mono text-xs text-white/80 whitespace-nowrap">{row[1]}</td>
              <td class="py-1.5 pl-4 font-mono text-xs text-white/80 whitespace-nowrap">{row[2]}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<!-- ─── Blackout ────────────────────────────────────────────────────────── -->
{#if blackout}
  <div transition:fade={{ duration: 500 }} class="fixed inset-0 z-40 bg-black"></div>
{/if}

<!-- ─── Controls panel (active + preview) ─────────────────────────────── -->
{#if appState !== "overview"}
  <div
    data-no-swipe
    class="pointer-events-auto fixed bottom-4 right-4 z-10 select-none transition-opacity duration-500 min-w-48"
    style="max-height: calc(100dvh - 2rem)"
    class:opacity-0={!hudVisible || overlayHidden}
    class:opacity-100={hudVisible && !overlayHidden}
  >
    <div class="flex max-h-full flex-col rounded-md border border-white/10 bg-black/60 px-4 py-3 text-white backdrop-blur-sm">
      <!-- Demo section — only visible when demo is active -->
      {#if demoActive}
        <div class="mb-2 shrink-0 text-xs uppercase tracking-widest text-white/50">Demo</div>
        <div class="mb-3 flex flex-col gap-2.5">
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs text-white/70">
              <span>Dwell time</span>
              <span class="font-mono text-white/40">{demoDwell < 60 ? demoDwell + ' s' : Math.floor(demoDwell / 60) + 'm' + (demoDwell % 60 ? ' ' + (demoDwell % 60) + 's' : '')}</span>
            </div>
            <input
              type="range"
              min={5}
              max={240}
              step={5}
              value={demoDwell}
              oninput={(e) => {
                demoDwell = parseInt((e.target as HTMLInputElement).value);
                saveDemoSettings(demoActive, demoDwell, [...demoPatternIds]);
                if (demoActive) resetDemoTimer();
              }}
              class="w-full accent-white cursor-pointer"
            />
          </div>
          <!-- Pattern selection -->
          <div class="flex flex-col gap-1">
            <div class="text-xs text-white/70">Patterns in cycle</div>
            <div class="flex flex-col gap-0.5">
              {#each patterns as p, i}
                {#if i === patterns.length - 2}
                  <div class="mt-1 mb-0.5 flex items-center gap-2">
                    <div class="h-px flex-1 bg-white/20"></div>
                    <span class="text-[10px] uppercase tracking-widest text-white/40">Live Light Painting</span>
                    <div class="h-px flex-1 bg-white/20"></div>
                  </div>
                {/if}
                {@const enabled = demoPatternIds.has(p.id)}
                <button
                  class="flex items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors cursor-pointer
                    {enabled ? 'text-white/80 hover:bg-white/10' : 'text-white/25 hover:bg-white/5'}"
                  onclick={() => {
                    const next = new Set(demoPatternIds);
                    if (enabled) { next.delete(p.id); } else { next.add(p.id); }
                    demoPatternIds = next;
                    saveDemoSettings(demoActive, demoDwell, [...demoPatternIds]);
                  }}
                >
                  <span class="shrink-0 font-mono text-[10px] {enabled ? 'text-white/30' : 'text-white/15'}">{i + 1}</span>
                  <span class="leading-snug">{p.name}</span>
                  {#if enabled}
                    <span class="ml-auto shrink-0 h-1.5 w-1.5 rounded-full bg-white/50"></span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        </div>
      {/if}
      {#if patterns[index].controls?.length}
        {@const controlMeta = (() => {
          let sectionOn = true;
          let currentSection: string | null = null;
          return (patterns[index].controls ?? []).map(ctrl => {
            if (ctrl.type === 'section') {
              sectionOn = !!(ctrlVals[ctrl.label] ?? 0);
              currentSection = ctrl.label;
            }
            const groupDisabled = !sectionOn && ctrl.type !== 'section' && ctrl.type !== 'separator';
            const inSection = (ctrl.type !== 'section' && ctrl.type !== 'separator') ? currentSection : null;
            const hidden = inSection !== null && collapsedSections.has(inSection);
            return { ctrl, groupDisabled, hidden };
          });
        })()}
        <!-- Pattern controls -->
        <div class="mb-2 shrink-0 flex items-center justify-between gap-2">
          <span class="text-xs uppercase tracking-widest text-white/50">Controls</span>
          <div class="flex gap-1">
            <button onclick={resetAllControls} class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer">Default</button>
            <button onclick={() => { poke(); startRandomize(performance.now()); }} class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer">Randomize</button>
          </div>
        </div>
        <!-- Preset slots: empty=click to save, filled=click to restore / long-press to update -->
        <div class="mb-2.5 flex gap-1 shrink-0">
          {#each presetSlots as slot, idx}
            {@const filled = slot !== null}
            {@const flashing = slotFlash === idx}
            <button
              class="flex-1 rounded border py-1 text-[10px] font-mono transition-all duration-150 cursor-pointer select-none
                {flashing ? 'border-white bg-white/40 text-white' :
                 filled   ? 'border-white/30 bg-white/10 text-white/70 hover:bg-white/20' :
                            'border-dashed border-white/20 text-white/25 hover:border-white/35'}"
              onpointerdown={() => onSlotPointerDown(idx)}
              onpointerup={() => onSlotPointerUp(idx)}
              onpointercancel={() => onSlotPointerCancel()}
              title={filled ? 'Click to restore · Hold to update' : 'Click to save snapshot'}
            >{filled ? (idx + 1) : '+'}</button>
          {/each}
        </div>
        <div class="flex flex-col gap-2.5 overflow-y-auto overscroll-contain min-h-0">
          {#each controlMeta as { ctrl, groupDisabled, hidden }}
            {@const focusedRangeCtrl = sliderModeActive ? rangeControls[sliderFocusIndex] : null}
            {@const activeFocusedCtrl = rangeControls[sliderFocusIndex]}
            {#if ctrl.type === "separator"}
              <!-- Plain section divider (no toggle) -->
              <div class="mt-1 flex items-center gap-2">
                <div class="h-px flex-1 bg-white/20"></div>
                <span class="text-[10px] uppercase tracking-widest text-white/40">{ctrl.label}</span>
                <div class="h-px flex-1 bg-white/20"></div>
              </div>
            {:else if ctrl.type === "section"}
              {@const isOn = !!(ctrlVals[ctrl.label] ?? 0)}
              {@const isCollapsed = collapsedSections.has(ctrl.label)}
              <!-- Section header with integrated mini toggle + collapse chevron -->
              <div class="mt-1 flex items-center gap-2">
                <div class="h-px flex-1 bg-white/20"></div>
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <span
                  class="text-[10px] uppercase tracking-widest text-white/40 hover:text-white/60 transition-colors cursor-pointer flex items-center gap-1 select-none"
                  onclick={() => { const s = new Set(collapsedSections); isCollapsed ? s.delete(ctrl.label) : s.add(ctrl.label); collapsedSections = s; }}
                >{ctrl.label} <span class="text-[8px] transition-transform duration-200 {isCollapsed ? '' : 'rotate-180 inline-block'}" style="display:inline-block">▼</span></span>
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div
                  class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {isOn ? 'bg-white/60' : 'bg-white/20'}"
                  onclick={() => { const nv = !ctrl.get(); ctrl.set(nv); ctrlVals[ctrl.label] = nv ? 1 : 0; saveSettings(patterns); }}
                >
                  <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {isOn ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
                </div>
                <div class="h-px flex-1 bg-white/20"></div>
              </div>
            {:else if !hidden && ctrl.type === "toggle"}
              {@const isOn = !!(ctrlVals[ctrl.label] ?? 0)}
              <!-- Standalone toggle row -->
              <div class="flex items-center justify-between text-xs text-white/70 transition-opacity duration-200 {groupDisabled ? 'opacity-35 pointer-events-none' : ''}">
                <span>{ctrl.label}</span>
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div
                  class="relative h-[18px] w-7 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {isOn ? 'bg-white/70' : 'bg-white/20'}"
                  onclick={() => { const nv = !ctrl.get(); ctrl.set(nv); ctrlVals[ctrl.label] = nv ? 1 : 0; saveSettings(patterns); }}
                >
                  <div class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 {isOn ? 'translate-x-[11px]' : 'translate-x-[2px]'}"></div>
                </div>
              </div>
            {:else if !hidden}
              <div class="flex flex-col gap-1 transition-all duration-150 {groupDisabled ? 'opacity-35 pointer-events-none' : ''} {ctrl === focusedRangeCtrl ? 'rounded bg-white/10 px-1.5 py-0.5 -mx-1.5' : ''}">
                {#if ctrl.type !== "button"}
                <div class="flex justify-between text-xs text-white/70">
                  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                  <span
                    class={ctrl.type === "range" && !ctrl.readonly && ctrl.default !== undefined ? "cursor-pointer select-none hover:text-white transition-colors" : ""}
                    title={ctrl.type === "range" && !ctrl.readonly && ctrl.default !== undefined ? "Click to reset" : undefined}
                    onclick={() => { if (ctrl.type === "range" && !ctrl.readonly) resetCtrl(ctrl); }}
                  >{ctrl.label}</span>
                  {#if ctrl.type === "range"}
                    <span class="font-mono text-white/40">
                      {Number(ctrlVals[ctrl.label] ?? ctrl.get()).toFixed(ctrl.step < 0.01 ? 3 : ctrl.step < 0.1 ? 2 : ctrl.step < 1 ? 1 : 0)}
                    </span>
                  {/if}
                </div>
                {/if}
                {#if ctrl.type === "range"}
                  {@const focused = ctrl === activeFocusedCtrl && !ctrl.readonly}
                  <div class="flex items-center gap-1">
                    <span class="select-none text-[10px] text-white/50 transition-opacity duration-150 {focused ? 'opacity-100' : 'opacity-0'}">◄</span>
                    <input
                      type="range"
                      min={ctrl.min}
                      max={ctrl.max}
                      step={ctrl.step}
                      value={ctrlVals[ctrl.label] ?? ctrl.get()}
                      oninput={ctrl.readonly ? undefined : (e) => {
                        const v = parseFloat((e.target as HTMLInputElement).value);
                        ctrl.set(v);
                        ctrlVals[ctrl.label] = v;
                        saveSettings(patterns);
                      }}
                      ondblclick={() => { if (!ctrl.readonly) resetCtrl(ctrl); }}
                      class="min-w-0 flex-1 accent-white {ctrl.readonly ? 'pointer-events-none' : 'cursor-pointer'}"
                    />
                    <span class="select-none text-[10px] text-white/50 transition-opacity duration-150 {focused ? 'opacity-100' : 'opacity-0'}">►</span>
                  </div>
                {:else if ctrl.type === "select"}
                  {@const opts = typeof ctrl.options === 'function' ? ctrl.options() : ctrl.options}
                  <select
                    value={ctrlVals[ctrl.label] ?? ctrl.get()}
                    onchange={(e) => { ctrl.set(parseInt((e.target as HTMLSelectElement).value)); saveSettings(patterns); }}
                    class="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
                  >
                    {#each opts as opt, i}
                      <option value={i}>{opt}</option>
                    {/each}
                  </select>
                {:else if ctrl.type === "color"}
                  <div class="flex items-center gap-2">
                    <input
                      type="color"
                      value={String(ctrlVals[ctrl.label] ?? ctrl.get())}
                      oninput={(e) => {
                        const v = (e.target as HTMLInputElement).value;
                        ctrl.set(v); ctrlVals[ctrl.label] = v; saveSettings(patterns);
                      }}
                      class="h-7 w-10 cursor-pointer rounded border border-white/20 bg-transparent p-0.5"
                    />
                    <span class="font-mono text-xs text-white/40">{String(ctrlVals[ctrl.label] ?? ctrl.get())}</span>
                  </div>
                {:else if ctrl.type === "text"}
                  <input
                    type="text"
                    placeholder={ctrl.placeholder ?? ''}
                    value={String(ctrlVals[ctrl.label] ?? ctrl.get())}
                    oninput={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      ctrl.set(v); ctrlVals[ctrl.label] = v; saveSettings(patterns);
                    }}
                    class="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none placeholder-white/30 focus:bg-white/15"
                  />
                {:else if ctrl.type === "button"}
                  <button
                    onclick={() => { ctrl.action(); syncCtrlVals(); }}
                    class="w-full rounded bg-white/10 px-2 py-1 text-xs text-white cursor-pointer hover:bg-white/20 active:bg-white/30 transition-colors"
                  >{ctrl.label}</button>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      {#if patterns[index].attribution}
        <div class="mt-3 pt-2 border-t border-white/10 text-[10px] text-white/25 leading-snug">
          {patterns[index].attribution}
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- ─── HUD (active + preview) ────────────────────────────────────────── -->
{#if appState !== "overview"}
  <div
    data-no-swipe
    class="pointer-events-none fixed top-4 left-4 z-10 select-none transition-opacity duration-500"
    class:opacity-0={!hudVisible || overlayHidden}
    class:opacity-100={hudVisible && !overlayHidden}
  >
    <div class="rounded-md border border-white/10 bg-black/60 px-4 py-3 text-white backdrop-blur-sm">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-[10px] font-semibold tracking-[0.3em] text-white/25 mb-1">LICHTSPIEL</div>
          <div class="text-xs uppercase tracking-widest text-white/50">Pattern</div>
          <div class="text-lg font-semibold flex items-center gap-2">
            <span>{patterns[index].name}</span>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <span
              class="pointer-events-auto text-sm transition-colors cursor-pointer {favorites.has(patterns[index].id) ? 'text-yellow-300/80' : 'text-white/20 hover:text-white/50'}"
              onclick={() => toggleFavorite(patterns[index].id)}
              title="Toggle favorite"
            >{favorites.has(patterns[index].id) ? '★' : '☆'}</span>
          </div>
          <div class="mt-1 text-xs text-white/40">{index + 1} / {patterns.length}</div>
          {#if isFreezing}
            <div class="mt-1 text-xs font-mono text-amber-400/80">FREEZE</div>
          {:else if !freezeAnim && Math.abs(timeScaleMirror - 1.0) > 0.05}
            <div class="mt-1 text-xs font-mono text-white/50">{timeScaleMirror.toFixed(1)}×</div>
          {/if}
          {#if isRecording}
            <div class="mt-1 text-xs font-mono text-red-400/90">● REC</div>
          {/if}
          {#if gamepadConnected}
            <div class="mt-1 text-xs text-white/30">⎮ Gamepad</div>
          {/if}
          {#if midiConnected}
            <div class="mt-1 text-xs text-white/30">♪ MIDI</div>
          {/if}
        </div>
        <div class="flex flex-col items-end gap-1.5">
          <button
            class="pointer-events-auto rounded-md border px-3 py-1.5 text-xs transition-colors {demoActive ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 bg-white/[0.07] text-white/70 hover:border-white/40 hover:bg-white/15'} active:bg-white/20"
            onclick={() => { demoActive ? stopDemo() : startDemo(); }}
          >
            {demoActive ? "● Demo" : "Demo"}
          </button>
          <div class="flex gap-1">
            <button
              class="pointer-events-auto flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors active:bg-white/20
                {poseActive ? 'border-green-400/50 bg-green-400/10 text-green-300' : poseError ? 'border-red-400/40 bg-red-400/10 text-red-300' : 'border-white/15 bg-white/[0.07] text-white/70 hover:border-white/40 hover:bg-white/15'}"
              onclick={togglePoseTracking}
              title={poseError ?? (poseActive ? "Stop body tracking (T)" : "Start body tracking (T)")}
              disabled={poseLoading}
            >
              {#if poseLoading}
                ⟳ Pose…
              {:else if poseActive}
                ◉ Pose {posePersonCount > 0 ? `(${posePersonCount})` : ''}
              {:else if poseError}
                ✕ Pose
              {:else}
                ◎ Pose
              {/if}
            </button>
            {#if poseActive}
              <button
                class="pointer-events-auto rounded-md border px-2 py-1.5 text-xs transition-colors active:bg-white/20
                  {poseDebug ? 'border-yellow-400/50 bg-yellow-400/10 text-yellow-300' : 'border-white/15 bg-white/[0.07] text-white/50 hover:border-white/40'}"
                onclick={() => { poseDebug = !poseDebug; }}
                title="Toggle landmark debug overlay"
              >⊹</button>
            {/if}
          </div>
          {#if isIosBrowser}
            <div class="mt-0.5 max-w-[140px] text-right text-[10px] leading-snug text-white/40">
              Tap <span class="text-white/60">Share ↑</span> → Add to Home Screen for fullscreen
            </div>
          {:else if !isIosStandalone}
            <button
              class="pointer-events-auto rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/15 active:bg-white/20"
              onclick={() => { handleAction({ type: "fullscreen" }); }}
            >
              {fs.isFullscreen() ? "Exit ⛶" : "⛶ Fullscreen"}
            </button>
          {/if}
        </div>
      </div>
      <div class="mt-3 flex gap-1.5">
        <button
          class="pointer-events-auto flex-1 rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/15 active:bg-white/20"
          onclick={() => { if (fs.isFullscreen()) fs.exit(); focusedIndex = index; appState = "overview"; }}
        >
          ← Patterns
        </button>
        <button
          class="pointer-events-auto rounded-md border px-3 py-1.5 text-xs transition-colors {copiedLink ? 'border-green-400/50 bg-green-400/10 text-green-300' : 'border-white/15 bg-white/[0.07] text-white/70 hover:border-white/40 hover:bg-white/15'}"
          onclick={copyShare}
          title="Copy shareable link"
        >{copiedLink ? '✓ Copied!' : '⛓'}</button>
        {#if isTouch}
          <button
            class="pointer-events-auto rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/15 active:bg-white/20"
            onclick={applyScreenshot}
            title="Screenshot"
          >📷</button>
          <button
            class="pointer-events-auto rounded-md border px-3 py-1.5 text-xs transition-colors {isRecording ? 'border-red-400/50 bg-red-400/10 text-red-300' : 'border-white/15 bg-white/[0.07] text-white/70 hover:border-white/40 hover:bg-white/15'} active:bg-white/20"
            onclick={() => recorder?.toggle()}
            title="Record video"
          >{isRecording ? '⏹' : '⏺'}</button>
        {/if}
      </div>
      <div class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-white/70">
        {#if isTouch}
          <span>↔</span><span>swipe to change pattern</span>
        {:else}
          <kbd class="rounded bg-white/10 px-1.5 font-mono">← →</kbd>
          <span>prev / next</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">↑ ↓</kbd>
          <span>speed +/−</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">Space</kbd>
          <span>freeze</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">B</kbd>
          <span>reset controls</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">A / X</kbd>
          <span>randomize / blackout</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">L</kbd>
          <span>screenshot</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">R + ←→</kbd>
          <span>adjust slider</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">M</kbd>
          <span>all shortcuts</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
