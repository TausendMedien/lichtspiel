<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { createRenderer, type RendererHandle } from "./lib/renderer";
  import { attachKeyboard, type KeyAction } from "./lib/keyboard";
  import { createGamepadController, type GamepadAction } from "./lib/gamepad";
  import { takeScreenshot } from "./lib/screenshot";
  import { createRecorder, type RecorderHandle } from "./lib/recording";
  import { attachTouch } from "./lib/touch";
  import { patterns } from "./lib/patterns";
  import * as fs from "./lib/fullscreen";
  import { createWakeLock } from "./lib/wakelock";
  import { loadSettings, saveSettings, loadDemoSettings, saveDemoSettings } from "./lib/settings";
  import type { DemoStartBehavior } from "./lib/settings";
  import type { PatternControl } from "./lib/patterns/types";
  import { restoreFromKeys } from "./lib/persist";
  import { createMIDIController } from "./lib/midi";
  import type { MIDIAction } from "./lib/midi";
  import { popUndo, setUndoing } from "./lib/undo";
  import { encodeShare, decodeShare } from "./lib/shareUrl";
  import { getSlots, saveSlot, resetSlots, resetAllSlots } from "./lib/presets";
  import type { Snapshot } from "./lib/presets";
  import { poseState, poseSettings, startPoseTracking, stopPoseTracking } from "./lib/pose";
  import { cameraState, enumerateCameras, detectCameras, saveCameraDevice, savePatternMotionEnabled, getVisibleDevices, setShowVirtualCameras, setCameraResolution, CAMERA_RES_OPTIONS, probeCameras, type CameraProbe } from "./lib/globalCameraSettings.svelte";
  import { audioState, enumerateMicrophones, savePatternAudioEnabled } from "./lib/globalAudioSettings.svelte";
  import { privacyMode } from "./lib/privacyMode.svelte";
  import { killAllStreams } from "./lib/sensorGuard";
  import { colorC2, colorShuffle, saveColorC2, COLOR_DEFAULTS, getEnabledIndices, getColorByIndex } from "./lib/colorC2.svelte";
  import { interactionState, saveInteractionSettings } from "./lib/interactionState.svelte";
  import { flickerGuard, saveFlickerGuard } from "./lib/flickerGuard.svelte";

  // Camera/image patterns where Apply Colors defaults to OFF
  const NO_COLOR_IDS = new Set([
    'img-tealLines', 'img-organicWeb', 'img-dotWaves', 'img-baroqueVines', 'img-thinVerticals',
    'img-twoFeather', 'img-rootWave', 'img-purpleOrnate', 'img-flowingDots',
  ]);

  // Experimental patterns — hidden from next/prev navigation and deselected in demo by default
  const EXPERIMENTAL_IDS = new Set(['particlesPalette', 'tunnelEdgePalette', 'heatMap', 'particlesHeat', 'hyperMixHeat']);
  const EXPERIMENTAL_KEY = 'pp:experimentalEnabled';
  let experimentalEnabled = $state(typeof localStorage !== 'undefined' ? localStorage.getItem(EXPERIMENTAL_KEY) === 'true' : false);

  // ── Per-pattern colour state ───────────────────────────────────────────────
  const PCOLOR_KEY = 'pp:pcolor:';

  function patternColorDefaults(patternId: string) {
    const pat = patterns.find(p => p.id === patternId);
    return {
      enabled:    !NO_COLOR_IDS.has(patternId),
      saturation: pat?.colorDefaults?.saturation ?? 1.0,
      brightness: pat?.colorDefaults?.brightness ?? 1.0,
      assign:     [0, 1, 2] as [number, number, number],
    };
  }

  function loadPatternColor(patternId: string) {
    const def = patternColorDefaults(patternId);
    try {
      const s = localStorage.getItem(PCOLOR_KEY + patternId);
      if (s) {
        const p = JSON.parse(s);
        return {
          enabled:    typeof p.enabled === 'boolean' ? p.enabled : def.enabled,
          saturation: typeof p.sat === 'number' ? p.sat : def.saturation,
          brightness: typeof p.bri === 'number' ? p.bri : def.brightness,
          assign:     (Array.isArray(p.assign) && p.assign.length === 3 ? p.assign : def.assign) as [number, number, number],
        };
      }
    } catch {}
    return def;
  }

  function savePatternColor(patternId: string) {
    try {
      localStorage.setItem(PCOLOR_KEY + patternId, JSON.stringify({
        enabled: colorShuffle.enabled,
        sat:     colorShuffle.saturation,
        bri:     colorShuffle.brightness,
        assign:  colorShuffle.assign,
      }));
    } catch {}
  }

  function doColorShuffle() {
    const pool = getEnabledIndices();
    if (pool.length < 3) return;
    // Shuffle pool, pick first 3 — guaranteed different from current if pool is large enough
    let tries = 0;
    let next: [number, number, number];
    do {
      const s = [...pool].sort(() => Math.random() - 0.5);
      next = [s[0], s[1], s[2]];
      tries++;
    } while (tries < 20 && next.join() === colorShuffle.assign.join() && pool.length > 3);
    colorShuffle.assign = next;
    savePatternColor(patterns[index].id);
  }

  const AUDIO_BAND_OPTIONS = ['Bass', 'Mid', 'High', 'Full'] as const;

  type AppState = "overview" | "active" | "preview";

  let canvas: HTMLCanvasElement;
  let handle: RendererHandle | null = null;
  let appState = $state<AppState>("overview");
  let index = $state(0);
  let focusedIndex = $state(0);
  let hudVisible = $state(true);
  let hudPanelHeight = $state(0);
  let hudTimer: ReturnType<typeof setTimeout> | null = null;
  let isTouch = $state(false);
  let isIosStandalone = $state(false);
  let isIosBrowser = $state(false);

  // Demo mode
  let demoActive = $state(false);
  let demoDwell = $state(60);
  let pedalDwell = $state(180);
  // Plain let (NOT $state) — plain JS closures always read the current value, even
  // inside setTimeout callbacks where $state signal reads can be stale in Svelte 5.
  let demoPatternIds: Set<string> = new Set(patterns.map(p => p.id));
  // Reactive tick — incremented on every mutation to force template re-evaluation.
  let _demoPatternTick = $state(0);
  function applyDemoPatternIds(next: Set<string>) {
    demoPatternIds = next;    // plain assignment — always current everywhere
    _demoPatternTick++;       // trigger UI re-render
    saveDemoSettings(demoActive, demoDwell, pedalDwell, [...next], demoStartBehavior, demoRandomizeOrder, demoFavoritesOnly);
  }
  let demoTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotUrl = $state<string | null>(null);
  let snapshotFading = $state(false);
  let snapshotImg = $state<HTMLImageElement | null>(null);
  let demoPointerVisible = $state(false);
  let demoPointerTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorHidden = $state(false);
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  const DEMO_HIDE_HUD_KEY = 'pp:demo-hide-hud';
  let demoHideHud = $state(typeof localStorage !== 'undefined' ? localStorage.getItem(DEMO_HIDE_HUD_KEY) !== 'false' : true);
  // Pedal ('b') behaviour — applies in and out of Demo mode.
  // Short press → randomize (+ change pattern when pedalChangesPattern is on).
  // Double press → change pattern (when pedalDoubleChangesPattern is on).
  // Long press → one of: nothing, Light Paint, Screenshot, or a 10-second recording.
  const PEDAL_CHANGES_PATTERN_KEY = 'pp:pedal-changes-pattern';
  let pedalChangesPattern = $state(typeof localStorage !== 'undefined' ? localStorage.getItem(PEDAL_CHANGES_PATTERN_KEY) !== 'false' : true);
  const PEDAL_DOUBLE_CHANGES_PATTERN_KEY = 'pp:pedal-double-changes-pattern';
  let pedalDoubleChangesPattern = $state(typeof localStorage !== 'undefined' ? localStorage.getItem(PEDAL_DOUBLE_CHANGES_PATTERN_KEY) !== 'false' : true);
  // Pedal long-press action: 'none' | 'lightPaint' | 'screenshot' | 'record10'.
  // Migrates the old boolean key (true→screenshot, false→lightPaint); default 'none'.
  type PedalLongAction = 'none' | 'lightPaint' | 'screenshot' | 'record10';
  const PEDAL_LONG_ACTION_KEY = 'pp:pedal-long-action';
  function loadPedalLongAction(): PedalLongAction {
    if (typeof localStorage === 'undefined') return 'none';
    const stored = localStorage.getItem(PEDAL_LONG_ACTION_KEY);
    if (stored === 'none' || stored === 'lightPaint' || stored === 'screenshot' || stored === 'record10') return stored;
    const legacy = localStorage.getItem('pp:pedal-long-screenshot');
    if (legacy === 'true') return 'screenshot';
    if (legacy === 'false') return 'lightPaint';
    return 'none';
  }
  let pedalLongAction = $state<PedalLongAction>(loadPedalLongAction());
  const pedalLongLabels: Record<PedalLongAction, string> = {
    none: 'Nothing', lightPaint: 'Light Paint', screenshot: 'Screenshot', record10: 'Record 10s',
  };
  // Short-press (b key / pedal) behavior: 'cycle' steps through saved presets 1·2·3,
  // 'random' randomizes the current pattern's sliders.
  const RANDOMIZE_MODE_KEY = 'pp:randomize-mode';
  let randomizeMode = $state<'cycle' | 'random'>(typeof localStorage !== 'undefined' && localStorage.getItem(RANDOMIZE_MODE_KEY) === 'random' ? 'random' : 'cycle');
  let presetCycleIdx = $state(-1); // cursor over filled slots; reset on pattern change

  const cheatsheetRows = $derived((() => {
    const rows: [string, string, string][] = [
      ["Prev / next pattern",  "← →",                "D-Pad ← →"],
      ["Speed +/−",            "↑ ↓",                "D-Pad ↑ ↓"],
      ["Switch slider",        "R (hold) + ↑↓",      "R-Stick ↑↓"],
      ["Adjust slider",        "R (hold) + ←→",      "R-Stick ←→"],
      ["Reset controls",       "A",                  "× / A"],
      ["Freeze toggle",        "Space / Start",      "Options / Start"],
      [pedalChangesPattern ? "Randomize + change pattern" : "Randomize",
       "B  · Pedal",           "○ / B"],
      ...(pedalDoubleChangesPattern
        ? [["Change pattern",  "B B  · Pedal",       "—"] as [string, string, string]]
        : []),
      ...(pedalLongAction !== 'none'
        ? [[pedalLongLabels[pedalLongAction], "B (hold)  · Pedal", "—"] as [string, string, string]]
        : []),
      ["Blackout toggle",      "X",                  "△ / Y"],
      ["Hide / show HUD",      "Y",                  "□ / X"],
      ["Screenshot",           "S  ·  L  ·  2 (R2)", "R2 / RT"],
      ["Camera toggle",        "2  ·  L1",           "L1 / LB"],
      ["Record video",         "V  ·  1  ·  L2",     "L2 / LT"],
      ["About / Controls",     "M  ·  ?",            "R1 / RB"],
      ["Options",              "O",                  "—"],
      ["Fullscreen",           "F",                  "—"],
      ["Demo mode",            "D",                  "—"],
      ["Overview / back",      "Esc  ·  P",          "Share / Back"],
    ];
    return rows;
  })());

  // Demo auto-restart after idle
  const DEMO_AUTORESTART_KEY = 'pp:demo-autorestart';
  const DEMO_AUTORESTART_TIME_KEY = 'pp:demo-autorestart-time';
  // Default ON: an idle kiosk relaunches the demo automatically. Respect a stored choice.
  let demoAutoRestart = $state(typeof localStorage !== 'undefined' ? (localStorage.getItem(DEMO_AUTORESTART_KEY) ?? 'true') === 'true' : true);
  let demoAutoRestartTime = $state(typeof localStorage !== 'undefined' ? (localStorage.getItem(DEMO_AUTORESTART_TIME_KEY) ?? '00:03') : '00:03');
  let autoRestartTimer: ReturnType<typeof setTimeout> | null = null;

  // Start straight into Demo Mode when the app is first opened. Default OFF — opt-in for kiosks.
  const DEMO_AUTOSTART_KEY = 'pp:demo-autostart';
  let demoAutoStart = $state(typeof localStorage !== 'undefined' ? localStorage.getItem(DEMO_AUTOSTART_KEY) === 'true' : false);

  // Screenshot / recording toggles
  const SCREENSHOTS_ENABLED_KEY = 'pp:screenshots';
  const RECORDINGS_ENABLED_KEY  = 'pp:recordings';
  let screenshotsEnabled = $state(typeof localStorage !== 'undefined' ? localStorage.getItem(SCREENSHOTS_ENABLED_KEY) !== 'false' : true);
  let recordingsEnabled  = $state(typeof localStorage !== 'undefined' ? localStorage.getItem(RECORDINGS_ENABLED_KEY)  !== 'false' : true);

  // MIDI / audio / sharing state
  const MIDI_ENABLED_KEY = 'pp:midi';
  let midiEnabled = $state(typeof localStorage !== 'undefined' ? localStorage.getItem(MIDI_ENABLED_KEY) === 'true' : false);
  let midiConnected = $state(false);
  let favorites = $state(new Set<string>());
  let showFavoritesOnly = $state(false);
  let showPoseOnly = $state(false);
  let presetSlots = $state<(Snapshot | null)[]>([null, null, null]);
  let copiedLink = $state(false);
  let slotPressTimer: ReturnType<typeof setTimeout> | null = null;
  let slotFlash = $state<number | null>(null);

  // MIDI lifecycle callbacks populated in onMount
  let _midiStart: (() => void) | null = null;
  let _midiStop:  (() => void) | null = null;

  // Gamepad / controller state
  let gamepadConnected = $state(false);
  let kbRHeld  = $state(false);   // keyboard R hold
  const sliderModeActive = $derived(kbRHeld);
  let screenshotFlash = $state(false);
  let isRecording = $state(false);
  // Sensor Block — saved state for restore on unblock
  let _sbSavedCameraEnabled  = false;
  let _sbSavedMotionEnabled  = false;
  let _sbSavedAudioEnabled   = false;
  let _sbSavedPatternCams    = new Map<string, boolean>();
  let _sbSavedPoseActive     = false;
  let recorder: RecorderHandle | null = null;
  let timeScaleMirror = $state(1.0);
  let frozenPrevScale = $state(1.0);
  let sliderFocusIndex = $state(0);
  let blackout = $state(false);
  let overlayHidden = $state(false);
  let cheatsheetVisible = $state(false);
  let optionsVisible    = $state(false);
  let demoVisible       = $state(false);
  let flickerGuardConfirmVisible = $state(false); // safety-warning before disabling the guard
  let demoStartBehavior = $state<DemoStartBehavior>('default');
  let demoRandomizeOrder = $state(false);
  let demoFavoritesOnly = $state(false);

  const DEMO_GROUPS: { label: string; ids: readonly string[] }[] = [
    { label: 'Generative',        ids: ['hyperMix','particlesBody','particleLines','parallelLinesStraight','parallelLinesWave','flowLines','curlOrbsBody','tunnel','tunnelEdge','baroqueSwirlsBody','shaderGradient','warpedSurfaces','lines3d','asciiSwirls','wavySphere','crystalGem','typography3d'] },
    { label: 'Live Light Painting',ids: ['lightPaint','lightTrail','lightPaintBlack','lightFly','lightVortex','lightKaleido','lightGlitch'] },
    { label: 'Static Images',      ids: ['img-tealLines','img-organicWeb','img-dotWaves','img-baroqueVines','img-thinVerticals','img-twoFeather','img-rootWave','img-purpleOrnate','img-flowingDots'] },
    { label: 'Experimental',       ids: ['particlesPalette','tunnelEdgePalette','heatMap','particlesHeat','hyperMixHeat'] },
  ];
  const DEFAULT_FAVORITES = [
    'hyperMix', 'particlesBody', 'particleLines', 'parallelLinesWave',
    'tunnelEdge', 'baroqueSwirlsBody', 'shaderGradient', 'asciiSwirls',
    'wavySphere', 'crystalGem', 'typography3d',
    'lightPaint', 'lightPaintBlack', 'lightFly', 'lightKaleido', 'lightGlitch',
    'img-tealLines', 'img-organicWeb', 'img-dotWaves', 'img-baroqueVines', 'img-thinVerticals',
    'img-twoFeather', 'img-rootWave', 'img-purpleOrnate', 'img-flowingDots',
  ] as const;

  let collapsedSections = $state(new Set<string>());
  const _perPatternCollapsed = new Map<string, Set<string>>();
  const _perPatternColourCollapsed = new Map<string, boolean>();
  let colourCollapsed = $state(false);
  // Pattern group (collapsable wrapper for all pattern controls)
  const _perPatternGroupCollapsed = new Map<string, boolean>();
  let patternGroupCollapsed = $state(true);
  // Interactive section per-pattern state
  const _perPatternInteractiveOn = new Map<string, boolean>();
  const _perPatternInteractiveCollapsed = new Map<string, boolean>();
  let interactiveOn = $state(false);
  let interactiveCollapsed = $state(true);
  // Reactive fullscreen flag — updated by fullscreenchange event so template re-renders
  let isFullscreenState = $state(false);

  // Wake lock — held while demo mode or fullscreen is active
  const wl = createWakeLock();
  $effect(() => { if (demoActive || isFullscreenState) { wl.acquire(); } else { wl.release(); } });

  // Push the photosensitivity-guard on/off state into the renderer (single source of truth)
  $effect(() => { handle?.setFlickerGuard(flickerGuard.enabled); });

  // Body pose tracking
  let posePersonCount  = $state(0);
  let poseActive       = $state(false);
  let poseError        = $state<string | null>(null);
  let poseLoading      = $state(false);
  let poseDebug        = $state(false);
  // Which camera deviceId pose tracking was started with (plain var, not $state —
  // only read inside $effect, never needed in template).
  let _poseDeviceId    = '';
  // Reactive mirrors of poseSettings (plain object — not Svelte state)
  let poseLowRes       = $state(poseSettings.lowRes);
  let poseSkipFrames   = $state(poseSettings.skipFrames);
  let interactionDebug = $state(false);
  let debugCanvas: HTMLCanvasElement | undefined = $state();

  async function togglePoseTracking() {
    if (poseLoading) return;
    if (poseState.active) {
      stopPoseTracking();
      poseActive = false;
      poseError = null;
      _poseDeviceId = '';
      // Turn camera off in Options if motion detection isn't also using it
      if (!cameraState.motionEnabled) cameraState.enabled = false;
    } else {
      poseLoading = true;
      poseError = null;
      // Let the loading overlay render before the model freeze hits
      await tick();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      try {
        const devId = cameraState.deviceId || undefined;
        await startPoseTracking(devId);
        _poseDeviceId = devId ?? '';
        poseActive = true;
        // Reflect that camera is now active in the Options panel
        if (!cameraState.enabled) cameraState.enabled = true;
        enumerateCameras(); // always refresh so camera picker appears
      } catch (e) {
        poseError = e instanceof Error ? e.message : "Camera access denied";
        poseActive = false;
      } finally {
        poseLoading = false;
      }
    }
  }

  // Restart pose tracking when the selected camera device changes while pose is active.
  // This ensures the camera picker has effect on pose (not just motion detection).
  $effect(() => {
    const deviceId = cameraState.deviceId;
    if (!poseActive || !poseState.active || !deviceId || deviceId === _poseDeviceId) return;
    _poseDeviceId = deviceId;
    untrack(async () => {
      stopPoseTracking();
      poseLoading = true;
      poseError = null;
      try {
        await startPoseTracking(deviceId);
        poseActive = true;
      } catch (e) {
        poseError = e instanceof Error ? e.message : 'Camera error';
        poseActive = false;
        _poseDeviceId = '';
      } finally {
        poseLoading = false;
      }
    });
  });

  type RandAnim  = { from: number; to: number; startMs: number };
  type FreezeAnim = { from: number; to: number; startMs: number };
  let randomizeAnims = $state<Record<string, RandAnim>>({});
  let freezeAnim = $state<FreezeAnim | null>(null);
  const isFreezing = $derived(freezeAnim ? freezeAnim.to === 0 : timeScaleMirror === 0);

  const rangeControls = $derived(
    (patterns[index]?.controls ?? []).filter(c => c.type === 'range' && !(c as any).interactive) as
      (import('./lib/patterns/types').PatternControl & { type: 'range' })[]
  );

  const patternUsesPose = $derived(!!patterns[index]?.usesPose);
  const patternIsInteractive = $derived(
    !!(patterns[index]?.motionReactive || patterns[index]?.audioReactive || patterns[index]?.usesPose || patterns[index]?.usesCameraBlend)
  );

  // Reset slider focus when pattern changes or slider mode deactivates
  $effect(() => { const _ = index; sliderFocusIndex = 0; });
  $effect(() => { if (!sliderModeActive) sliderFocusIndex = 0; });

  const displayPatterns = $derived(
    patterns.map((p, i) => ({ p, i }))
      .filter(({ p }) => !showFavoritesOnly || favorites.has(p.id))
      .filter(({ p }) => !showPoseOnly || p.usesPose)
  );

  // Reactive mirror of current pattern's control values so the display
  // updates live as the user drags a slider (or types in a text field).
  let ctrlVals = $state<Record<string, number | string>>({});
  // Track which slider the user is actively dragging to avoid liveSync
  // overwriting the value attribute mid-drag (breaks touch/pointer on iPad/Mac).
  let draggingLabel: string | null = null;

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
  $effect(() => {
    const _ = index;
    syncCtrlVals();
    const pat = patterns[index];
    if (pat) {
      collapsedSections = _perPatternCollapsed.has(pat.id)
        ? new Set(_perPatternCollapsed.get(pat.id))
        : new Set(pat.defaultCollapsedSections ?? []);
      colourCollapsed = _perPatternColourCollapsed.has(pat.id)
        ? _perPatternColourCollapsed.get(pat.id)!
        : pat.id.startsWith('img-');
      patternGroupCollapsed = _perPatternGroupCollapsed.has(pat.id)
        ? _perPatternGroupCollapsed.get(pat.id)!
        : true;
      interactiveOn = _perPatternInteractiveOn.has(pat.id)
        ? _perPatternInteractiveOn.get(pat.id)!
        : !!(pat.usesCameraBlend || pat.usesPose || pat.audioReactive || pat.requiresCamera);  // camera/pose/audio patterns default to interactive ON
      interactiveCollapsed = _perPatternInteractiveCollapsed.has(pat.id)
        ? _perPatternInteractiveCollapsed.get(pat.id)!
        : !(pat.usesCameraBlend || pat.usesPose || pat.audioReactive || pat.requiresCamera);   // camera/pose/audio patterns default to interactive expanded
      // Enforce camera/audio/pose based on the incoming pattern's interactive state.
      // Skip in demo mode — Demo Options manages these features independently.
      if (!interactiveOn && !demoActive) {
        cameraState.motionEnabled = false;
        cameraState.enabled = false;
        audioState.enabled = false;
        // Use untrack so poseActive changes don't re-trigger this effect.
        if (untrack(() => poseActive)) { stopPoseTracking(); poseActive = false; poseError = null; }
        // Turn off per-pattern camera toggles (e.g. Light Trail / Light Paint)
        for (const c of (pat.controls ?? [])) {
          if (c.type === 'toggle' && (c as any).interactive === 'camera' && c.get()) c.set(false);
        }
      }
    }
  });
  $effect(() => { const _ = index; presetSlots = getSlots(patterns[index]?.id ?? ''); presetCycleIdx = -1; });

  function resetCtrl(ctrl: PatternControl & { type: "range" }) {
    if (ctrl.default === undefined) return;
    ctrl.set(ctrl.default);
    ctrlVals[ctrl.label] = ctrl.default;
    saveSettings(patterns);
  }

  function resetAllControls() {
    const pat = patterns[index];
    for (const c of pat?.controls ?? []) {
      if (c.type === 'range' && c.default !== undefined && !c.readonly) {
        c.set(c.default);
        ctrlVals[c.label] = c.default;
      }
    }
    resetAllColorState();
    saveSettings(patterns);
  }

  function resetAllColorState() {
    const def = patternColorDefaults(patterns[index].id);
    colorShuffle.enabled    = def.enabled;
    colorShuffle.saturation = def.saturation;
    colorShuffle.brightness = def.brightness;
    colorShuffle.assign     = [0, 1, 2];
    savePatternColor(patterns[index].id);
    // Reset palette to the three base colours
    Object.assign(colorC2, COLOR_DEFAULTS);
    saveColorC2();
  }

  function randomizeControls() {
    for (const c of patterns[index]?.controls ?? []) {
      if ((c as any).interactive) continue;
      if (c.type === 'range' && !c.readonly) {
        const steps = Math.round((c.max - c.min) / c.step);
        const r = Math.floor(Math.random() * (steps + 1));
        const v = parseFloat(Math.min(c.max, c.min + r * c.step).toFixed(10));
        c.set(v);
        ctrlVals[c.label] = v;
      }
    }
    doColorShuffle();
    colorShuffle.saturation = parseFloat((0.5 + Math.random() * 0.5).toFixed(2));
    colorShuffle.brightness = parseFloat((0.75 + Math.random() * 1.25).toFixed(2));
    // Colors v2: power-curve bias — mostly high (2–3), rarely low
    colorC2.colorsV2 = parseFloat((3 * (1 - Math.pow(Math.random(), 2.5))).toFixed(1));
    saveColorC2();
    savePatternColor(patterns[index].id);
    saveSettings(patterns);
  }

  function poke() {
    // While a demo runs, explicit interaction keeps the current pattern up — reset the
    // dwell countdown so an engaged visitor isn't yanked to the next pattern mid-play.
    // (Passive camera motion / audio don't call poke(), so a noisy empty room still advances.)
    if (demoActive) resetDemoTimer();
    if (demoActive && demoHideHud) { scheduleAutoRestart(); return; } // HUD hidden in demo mode
    hudVisible = true;
    overlayHidden = false;
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hudVisible = false), 5000);
    scheduleAutoRestart(); // reset idle timer on any user interaction
  }

  // Show the cursor on any mouse movement; hide it again after a short idle.
  function pokeCursor() {
    if (isTouch) return;
    cursorHidden = false;
    if (cursorTimer) clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => (cursorHidden = true), 1000);
  }
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('cursor-hidden', cursorHidden);
  });

  // Populate the camera picker whenever the Demo modal opens — the camera is used by
  // Light Painting/ASCII patterns too, so the picker is always offered there.
  $effect(() => {
    if (demoVisible) enumerateCameras();
  });

  // Camera diagnostic — "Test cameras" probes each pattern's constraints and reports
  // the resolved lens, so the operator can spot a per-pattern mismatch before a Demo.
  let cameraProbes = $state<CameraProbe[]>([]);
  let cameraTesting = $state(false);
  async function runCameraTest() {
    if (cameraTesting) return;
    cameraTesting = true;
    cameraProbes = [];
    try { cameraProbes = await probeCameras(); }
    finally { cameraTesting = false; }
  }
  // Probe status: 'ok' (all succeeded, one lens), 'mismatch' (>1 lens), 'error' (any failed).
  const cameraProbeStatus = $derived.by((): 'ok' | 'mismatch' | 'error' => {
    const ok = cameraProbes.filter(p => !p.error);
    if (ok.length === 0 || ok.length < cameraProbes.length) return 'error';
    return new Set(ok.map(p => p.label)).size > 1 ? 'mismatch' : 'ok';
  });

  function demoPoke() {
    demoPointerVisible = true;
    if (demoPointerTimer) clearTimeout(demoPointerTimer);
    demoPointerTimer = setTimeout(() => (demoPointerVisible = false), 3000);
  }

  function parseAutoRestartMs(): number {
    const [hhStr, mmStr] = demoAutoRestartTime.split(':');
    const hh = parseInt(hhStr ?? '0', 10) || 0;
    const mm = parseInt(mmStr ?? '0', 10) || 0;
    return (hh * 3600 + mm * 60) * 1000;
  }

  function scheduleAutoRestart() {
    if (autoRestartTimer) { clearTimeout(autoRestartTimer); autoRestartTimer = null; }
    if (!demoAutoRestart || demoActive) return;
    const ms = parseAutoRestartMs();
    if (ms <= 0) return;
    autoRestartTimer = setTimeout(() => { autoRestartTimer = null; startDemo(); }, ms);
  }

  function cancelAutoRestart() {
    if (autoRestartTimer) { clearTimeout(autoRestartTimer); autoRestartTimer = null; }
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

  // Load per-pattern colour state whenever the active pattern changes
  $effect(() => {
    const id = patterns[index]?.id;
    if (id) {
      const s = loadPatternColor(id);
      colorShuffle.enabled    = s.enabled;
      colorShuffle.saturation = s.saturation;
      colorShuffle.brightness = s.brightness;
      colorShuffle.assign     = s.assign;
    }
  });

  function nextVisibleIndex(from: number, delta: 1 | -1): number {
    const len = patterns.length;
    let n = ((from + delta) % len + len) % len;
    let tries = 0;
    while (tries++ < len && EXPERIMENTAL_IDS.has(patterns[n].id) && !experimentalEnabled) {
      n = ((n + delta) % len + len) % len;
    }
    return n;
  }

  function nextDemoIndex(from: number, delta: 1 | -1 = 1): number {
    const count = patterns.length;
    if (demoRandomizeOrder) {
      const pool = patterns
        .map((p, i) => i)
        .filter(i => i !== from && demoPatternIds.has(patterns[i].id) && (!demoFavoritesOnly || favorites.has(patterns[i].id)));
      if (!pool.length) return from;
      return pool[Math.floor(Math.random() * pool.length)];
    }
    for (let i = 1; i <= count; i++) {
      const next = ((from + delta * i) % count + count) % count;
      const id = patterns[next].id;
      if (demoPatternIds.has(id) && (!demoFavoritesOnly || favorites.has(id))) return next;
    }
    return from; // all disabled or only current enabled — stay put
  }

  async function crossFadeTo(n: number) {
    // Capture current frame BEFORE switching so snapshot covers the transition
    snapshotUrl = canvas.toDataURL();
    snapshotFading = false;
    // Freeze the renderer immediately so the canvas stays on the captured frame
    // while decode() runs. On iPad/Safari, toDataURL() is slow (~30–80 ms) and
    // decode() is async (~50–200 ms), so the canvas advances well past F0 before
    // the snapshot covers it — producing a visible "jump back" when it finally
    // appears. Freezing ensures canvas and snapshot always show the same frame.
    handle?.setTimeScale(0);
    freezeAnim = null;
    await tick(); // ensure snapshot img is in DOM before canvas switches
    // Ensure the snapshot img is fully decoded AND painted before switching the
    // canvas — otherwise (notably on iPad/Safari) the data-URL decode is async
    // and the incoming pattern flashes through for a frame before the cover appears.
    try { await snapshotImg?.decode(); } catch { /* ignore decode errors */ }
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    // Switch pattern while snapshot covers the canvas
    index = switchTo(n);
    focusedIndex = index;
    if (demoActive) {
      if (demoStartBehavior === 'random') {
        randomizeControls();
      } else if (demoStartBehavior !== 'default') {
        const slotIdx = ({ slot1: 0, slot2: 1, slot3: 2 } as Record<string, number>)[demoStartBehavior];
        const slots = getSlots(patterns[n].id);
        if (slots[slotIdx]) {
          presetSlots = slots;
          restorePreset(slotIdx);
        }
      }
    }
    // Unfreeze so the incoming pattern plays at normal speed.
    // crossFadeTo is only ever called in demo mode, so always reset to 1×.
    handle?.setTimeScale(1);
    timeScaleMirror = 1;
    freezeAnim = null;
    // Let new pattern render a couple frames, then fade out snapshot
    requestAnimationFrame(() => requestAnimationFrame(() => { snapshotFading = true; }));
  }

  function scheduleNext() {
    demoTimer = setTimeout(async () => {
      await crossFadeTo(nextDemoIndex(index));
      scheduleNext();
    }, demoDwell * 1000);
  }

  function firstDemoIndex(): number {
    for (let i = 0; i < patterns.length; i++) {
      if (demoPatternIds.has(patterns[i].id)) return i;
    }
    return index; // nothing selected — stay put
  }

  function startDemo() {
    demoActive = true;
    cancelAutoRestart(); // stop any pending auto-restart countdown
    hudVisible = false;
    if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
    demoVisible = false; // close the demo modal
    fs.enter(document.documentElement); // go fullscreen when demo starts
    saveDemoSettings(true, demoDwell, pedalDwell, [...demoPatternIds], demoStartBehavior, demoRandomizeOrder, demoFavoritesOnly);
    if (demoTimer) clearTimeout(demoTimer);

    const startIdx = firstDemoIndex();
    if (appState === "overview") {
      // In overview: switch directly (no crossfade needed)
      index = switchTo(startIdx);
      appState = "active";
      scheduleNext();
    } else if (startIdx !== index) {
      // In active but current pattern not selected: crossfade to first selected
      crossFadeTo(startIdx).then(() => scheduleNext());
    } else {
      scheduleNext();
    }
  }

  function stopDemo() {
    demoActive = false;
    saveDemoSettings(false, demoDwell, pedalDwell, [...demoPatternIds], demoStartBehavior, demoRandomizeOrder, demoFavoritesOnly);
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
    scheduleAutoRestart(); // begin idle countdown after demo stops
  }

  function resetDemoTimer() {
    if (!demoActive) return;
    if (demoTimer) clearTimeout(demoTimer);
    scheduleNext();
  }

  function handleAction(action: KeyAction) {
    // Any action dismisses modals first
    if (cheatsheetVisible) { cheatsheetVisible = false; return; }
    if (optionsVisible)    { optionsVisible = false; return; }
    if (demoVisible && action.type !== 'demo') { demoVisible = false; return; }

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
        case "toggleOverview":
          activatePattern(focusedIndex);
          break;
        case "fullscreen":
          fs.enter(document.documentElement);
          break;
        case "toggleCheatsheet":
          cheatsheetVisible = !cheatsheetVisible;
          break;
        case "toggleOptions":
          optionsVisible = !optionsVisible;
          break;
        case "demo":
          demoVisible = !demoVisible;
          break;
        case "escape":
          if (isFullscreenState) fs.exit();
          break;
      }
      return;
    }

    // Global actions for active + preview
    switch (action.type) {
      case "tap":              poke(); return;
      case "freeze":
        applyFreeze();
        if (demoActive) {
          // Freeze pauses the demo timer; unfreeze resumes it
          if (freezeAnim && freezeAnim.to === 0) {
            if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
          } else {
            scheduleNext();
          }
        }
        return;
      case "blackout":         blackout = !blackout; poke(); return;
      case "randomize":        applyPedalShort(); return;
      case "pedalShort":       applyPedalShort(); return;
      case "pedalDouble":      pedalChangePattern(); return;
      case "pedalLong":        applyPedalLong(); return;
      case "activatePattern": {
        const target = patterns.findIndex(p => p.id === action.id);
        if (target !== -1) { index = target; activatePattern(target); }
        return;
      }
      case "resetToDefault":   resetAllControls(); return;
      case "screenshot":       applyScreenshot(); return;
      case "toggleRecording":  recorder?.toggle(); return;
      case "toggleCamera":     toggleCamera(); poke(); return;
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
      case "toggleCheatsheet": cheatsheetVisible = !cheatsheetVisible; poke(); return;
      case "toggleOptions":    optionsVisible = !optionsVisible; poke(); return;
      case "undo":             applyUndo(); return;
    }

    if (appState === "active") {
      switch (action.type) {
        case "next":
          if (demoActive) { crossFadeTo(nextDemoIndex(index, 1)).then(() => resetDemoTimer()); }
          else { index = switchTo(nextVisibleIndex(index, 1)); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); }
          break;
        case "prev":
          if (demoActive) { crossFadeTo(nextDemoIndex(index, -1)).then(() => resetDemoTimer()); }
          else { index = switchTo(nextVisibleIndex(index, -1)); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); }
          break;
        case "jump":
          if (action.index < patterns.length) { index = switchTo(action.index); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); }
          break;
        case "fullscreen":
          fs.toggle(document.documentElement); hudVisible = false; break;
        case "demo":
          demoVisible = !demoVisible; poke(); break;
        case "escape":
          if (demoActive) { stopDemo(); poke(); } else { focusedIndex = index; appState = "overview"; overlayHidden = false; }
          break;
        case "toggleOverview":
          focusedIndex = index; appState = "overview"; overlayHidden = false;
          break;
      }
    } else {
      // preview
      switch (action.type) {
        case "next":
          if (demoActive) { crossFadeTo(nextDemoIndex(index, 1)).then(() => resetDemoTimer()); }
          else { index = switchTo(nextVisibleIndex(index, 1)); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); }
          break;
        case "prev":
          if (demoActive) { crossFadeTo(nextDemoIndex(index, -1)).then(() => resetDemoTimer()); }
          else { index = switchTo(nextVisibleIndex(index, -1)); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); }
          break;
        case "jump":
          if (action.index < patterns.length) { index = switchTo(action.index); focusedIndex = index; handle?.activateCurrentPattern(); resetDemoTimer(); }
          break;
        case "fullscreen":
          fs.enter(document.documentElement); appState = "active"; hudVisible = false; break;
        case "demo":
          demoVisible = !demoVisible; poke(); break;
        case "escape":
        case "toggleOverview":
          focusedIndex = index; appState = "overview"; overlayHidden = false; break;
      }
    }
  }

  // Change to the next pattern (demo-aware), then run `after` once it's live.
  function pedalChangePattern(after?: () => void) {
    if (demoActive) {
      if (demoTimer) clearTimeout(demoTimer);
      crossFadeTo(nextDemoIndex(index)).then(() => { after?.(); scheduleNext(); });
    } else {
      index = switchTo(nextVisibleIndex(index, 1));
      focusedIndex = index;
      handle?.activateCurrentPattern();
      resetDemoTimer();
      after?.();
    }
  }

  // Pedal short press / b key. In 'cycle' mode (default) step through the saved
  // presets 1·2·3 of the current pattern; in 'random' mode randomize (optionally
  // changing pattern first).
  function applyPedalShort() {
    if (randomizeMode === 'cycle') { cyclePreset(); return; }
    if (pedalChangesPattern) {
      pedalChangePattern(() => startRandomize(performance.now()));
    } else {
      startRandomize(performance.now());
    }
  }

  // Advance to the next filled slot (1→2→3→1) and restore it. Falls back to a
  // randomize when the current pattern has no saved slots.
  function cyclePreset() {
    const filled = presetSlots.map((s, i) => (s !== null ? i : -1)).filter(i => i >= 0);
    if (filled.length === 0) { startRandomize(performance.now()); return; }
    const next = filled.find(i => i > presetCycleIdx) ?? filled[0];
    presetCycleIdx = next;
    restorePreset(next);
  }

  // Pedal long press: configurable action (nothing / Light Paint / screenshot / 10s video).
  function applyPedalLong() {
    switch (pedalLongAction) {
      case 'lightPaint': {
        const target = patterns.findIndex(p => p.id === 'lightPaint');
        if (target !== -1) { index = target; activatePattern(target); }
        break;
      }
      case 'screenshot':
        applyScreenshot();
        break;
      case 'record10':
        recordTimed(10000);
        break;
      case 'none':
      default:
        break;
    }
  }

  // Record a fixed-length clip, then auto-stop and save. Reuses the existing recorder
  // (its onstop handler downloads/shares). No-op if recordings are disabled or one is
  // already running.
  function recordTimed(ms: number) {
    if (!recordingsEnabled || isRecording || !recorder) return;
    recorder.toggle(); // start
    setTimeout(() => { if (isRecording && recorder) recorder.toggle(); }, ms);
  }

  function startRandomize(now: number) {
    const anims: Record<string, RandAnim> = {};
    for (const ctrl of patterns[index]?.controls ?? []) {
      if (/camera|microphone/i.test(ctrl.label)) continue;
      if ((ctrl as any).interactive) continue;
      if (ctrl.type === 'range' && !ctrl.readonly) {
        // Snap to step so intermediate animated values are valid (e.g. integer line counts)
        const steps = Math.round((ctrl.max - ctrl.min) / ctrl.step);
        const r = Math.floor(Math.random() * (steps + 1));
        const to = parseFloat(Math.min(ctrl.max, ctrl.min + r * ctrl.step).toFixed(10));
        anims[ctrl.label] = { from: ctrl.get(), to, startMs: now };
      } else if (ctrl.type === 'select' && !ctrl.disabled?.()) {
        const opts = typeof ctrl.options === 'function' ? ctrl.options() : ctrl.options;
        const idx = Math.floor(Math.random() * opts.length);
        ctrl.set(idx);
        ctrlVals[ctrl.label] = idx;
      }
    }
    doColorShuffle();
    colorShuffle.saturation = parseFloat((0.5 + Math.random() * 0.5).toFixed(2));
    colorShuffle.brightness = parseFloat((0.75 + Math.random() * 1.25).toFixed(2));
    // Colors v2: power-curve bias — mostly high (2–3), rarely low
    colorC2.colorsV2 = parseFloat((3 * (1 - Math.pow(Math.random(), 2.5))).toFixed(1));
    saveColorC2();
    savePatternColor(patterns[index].id);
    randomizeAnims = anims;
  }

  function toggleCamera() {
    if (privacyMode.active) return; // Sensor Block prevents camera toggle
    cameraState.enabled = !cameraState.enabled;
    if (cameraState.enabled) {
      enumerateCameras();
    } else if (poseActive) {
      stopPoseTracking(); poseActive = false; poseError = null;
    }
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
    if (!screenshotsEnabled) return;
    const c = handle?.getCanvas();
    if (c) {
      takeScreenshot(c);
      screenshotFlash = true;
      setTimeout(() => { screenshotFlash = false; }, 800);
    }
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
      if ((ctrl as any).interactive) continue; // never save camera/mic device in a preset
      snap[ctrl.label] = ctrl.get();
    }
    // Per-pattern colour state
    snap['__colorEnabled'] = colorShuffle.enabled;
    snap['__colorAssign']  = colorShuffle.assign.join(',');
    snap['__colorSat']     = colorShuffle.saturation;
    snap['__colorBri']     = colorShuffle.brightness;
    // Colors v2 (variety slider) + palette colour values
    snap['__c2ColorsV2'] = colorC2.colorsV2;
    snap['__c2Main']     = colorC2.main;
    snap['__c2Contrast'] = colorC2.contrast;
    snap['__c2Glow']     = colorC2.glow;
    snap['__c2Extra1']   = colorC2.extra1;
    snap['__c2Extra2']   = colorC2.extra2;
    snap['__c2Extra3']   = colorC2.extra3;
    snap['__c2Extra1on'] = colorC2.extra1on;
    snap['__c2Extra2on'] = colorC2.extra2on;
    snap['__c2Extra3on'] = colorC2.extra3on;
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
      if ((ctrl as any).interactive) continue; // never restore camera/mic device from a preset
      const target = snap[ctrl.label];
      if (target !== undefined) {
        if (ctrl.type === 'toggle' || ctrl.type === 'section') ctrl.set(!!target);
        else if (ctrl.type === 'text' || ctrl.type === 'color') ctrl.set(String(target));
        else ctrl.set(target as number);
        ctrlVals[ctrl.label] = ctrl.get() as number | string;
      }
    }
    // Restore per-pattern colour state
    if (typeof snap['__colorEnabled'] === 'boolean') colorShuffle.enabled = snap['__colorEnabled'];
    if (typeof snap['__colorAssign'] === 'string') {
      const parts = String(snap['__colorAssign']).split(',').map(Number);
      if (parts.length === 3 && parts.every(n => n >= 0 && n <= 5)) {
        colorShuffle.assign = parts as [number, number, number];
      }
    }
    if (typeof snap['__colorSat'] === 'number') colorShuffle.saturation = snap['__colorSat'];
    if (typeof snap['__colorBri'] === 'number') colorShuffle.brightness  = snap['__colorBri'];
    savePatternColor(patterns[index].id);
    // Restore Colors v2 + palette colour values
    if (typeof snap['__c2ColorsV2'] === 'number') colorC2.colorsV2 = snap['__c2ColorsV2'] as number;
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    if (typeof snap['__c2Main']     === 'string' && hexRe.test(snap['__c2Main']     as string)) colorC2.main     = snap['__c2Main']     as string;
    if (typeof snap['__c2Contrast'] === 'string' && hexRe.test(snap['__c2Contrast'] as string)) colorC2.contrast = snap['__c2Contrast'] as string;
    if (typeof snap['__c2Glow']     === 'string' && hexRe.test(snap['__c2Glow']     as string)) colorC2.glow     = snap['__c2Glow']     as string;
    if (typeof snap['__c2Extra1']   === 'string' && hexRe.test(snap['__c2Extra1']   as string)) colorC2.extra1   = snap['__c2Extra1']   as string;
    if (typeof snap['__c2Extra2']   === 'string' && hexRe.test(snap['__c2Extra2']   as string)) colorC2.extra2   = snap['__c2Extra2']   as string;
    if (typeof snap['__c2Extra3']   === 'string' && hexRe.test(snap['__c2Extra3']   as string)) colorC2.extra3   = snap['__c2Extra3']   as string;
    if (typeof snap['__c2Extra1on'] === 'boolean') colorC2.extra1on = snap['__c2Extra1on'] as boolean;
    if (typeof snap['__c2Extra2on'] === 'boolean') colorC2.extra2on = snap['__c2Extra2on'] as boolean;
    if (typeof snap['__c2Extra3on'] === 'boolean') colorC2.extra3on = snap['__c2Extra3on'] as boolean;
    saveColorC2();
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
    if (raw === null) {
      // First launch — pre-populate with curated default set
      favorites = new Set(DEFAULT_FAVORITES);
      localStorage.setItem(FAVORITES_KEY, [...favorites].join(','));
    } else {
      favorites = new Set(raw.split(',').filter(Boolean));
    }
  }

  function toggleFavorite(patternId: string) {
    const next = new Set(favorites);
    if (next.has(patternId)) next.delete(patternId); else next.add(patternId);
    favorites = next;
    localStorage.setItem(FAVORITES_KEY, [...next].join(','));
  }

  // ── URL sharing ───────────────────────────────────────────────────────────

  function copyShare() {
    encodeShare(patterns[index], { cam: cameraState.enabled, audio: audioState.enabled });
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
        if (demoActive) { crossFadeTo(nextDemoIndex(index, 1)).then(() => resetDemoTimer()); }
        else { index = switchTo(nextVisibleIndex(index, 1)); focusedIndex = index; resetDemoTimer(); }
        break;
      case "prev":
        if (demoActive) { crossFadeTo(nextDemoIndex(index, -1)).then(() => resetDemoTimer()); }
        else { index = switchTo(nextVisibleIndex(index, -1)); focusedIndex = index; resetDemoTimer(); }
        break;
      case "speedUp":          applySpeedUp();   break;
      case "speedDown":        applySpeedDown(); break;
      case "freeze":
        applyFreeze();
        if (demoActive) {
          if (freezeAnim && freezeAnim.to === 0) {
            if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
          } else {
            scheduleNext();
          }
        }
        break;
      case "blackout":         blackout = !blackout; break;
      case "resetToDefault":   resetAllControls(); break;
      case "screenshot":       applyScreenshot(); break;
      case "toggleRecording":  recorder?.toggle(); break;
      case "randomize":        applyPedalShort(); break;
      case "activatePattern": {
        const target = patterns.findIndex(p => p.id === action.id);
        if (target !== -1) { index = target; activatePattern(target); }
        break;
      }
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
    pedalDwell = demo.pedalDwell;
    demoStartBehavior = demo.demoStartBehavior;
    demoRandomizeOrder = demo.demoRandomizeOrder;
    demoFavoritesOnly = demo.demoFavoritesOnly;
    // Exclude experimental patterns from demo by default when experimental is off
    const filteredDemoIds = demo.demoPatternIds.filter(id => experimentalEnabled || !EXPERIMENTAL_IDS.has(id));
    demoPatternIds = new Set(filteredDemoIds);
    handle = createRenderer(canvas, patterns[0]);
    handle.setFlickerGuard(flickerGuard.enabled);
    recorder = createRecorder(handle.getCanvas(), (r) => { isRecording = r; });
    // No saved demo config yet → this is the very first launch.
    const firstRun = localStorage.getItem('lichtspiel-demo') === null;
    if (demo.demoActive) {
      startDemo();
    } else if (demoAutoStart) {
      // Boot straight into the demo. On first launch fall back to a safe kiosk default:
      // Balanced 2 + favorites only, with all sensors (motion / pose / audio) off.
      if (firstRun) {
        demoStartBehavior = 'slot2';
        demoFavoritesOnly = true;
        cameraState.motionEnabled = false;
        cameraState.enabled = false;
        audioState.enabled = false;
        saveDemoSettings(false, demoDwell, pedalDwell, [...demoPatternIds], demoStartBehavior, demoRandomizeOrder, demoFavoritesOnly);
      }
      startDemo();
    }

    const gpController = createGamepadController(
      handleGamepadAction,
      (c) => { gamepadConnected = c; },
    );

    let midiController: ReturnType<typeof createMIDIController> | null = null;
    function startMidi() {
      if (midiController) return;
      midiController = createMIDIController(handleMIDIAction, (c) => { midiConnected = c; });
    }
    function stopMidi() {
      midiController?.dispose();
      midiController = null;
      midiConnected = false;
    }
    _midiStart = startMidi;
    _midiStop  = stopMidi;
    if (midiEnabled) startMidi();

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
        // Auto-enable only the sensors that were active when the link was created.
        // Old links without sensor info (shared before this feature) do nothing.
        if (!privacyMode.active && shared.sensors) {
          const sharePat = patterns[pIdx];
          if (shared.sensors.cam && ((sharePat as any).motionReactive || sharePat.usesCameraBlend || sharePat.usesPose)) {
            cameraState.motionEnabled = true;
            cameraState.enabled = true;
            enumerateCameras();
          }
          if (shared.sensors.audio && (sharePat as any).audioReactive) {
            audioState.enabled = true;
          }
        }
      }
    }

    loadFavorites();

    // Pre-enumerate camera/mic devices (labels only available after permission grant,
    // but even unlabelled list lets us show device count in Options)
    enumerateCameras();
    enumerateMicrophones();



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
            if (c.label === draggingLabel) continue;
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
      if ((poseDebug || interactionDebug) && debugCanvas) {
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
          // Legend — bottom-left
          dCtx.font = '11px monospace';
          dCtx.textAlign = 'left';
          const legendBaseY = dh - 12 - COLORS.length * 18;
          COLORS.forEach((c, i) => {
            dCtx.fillStyle = c;
            dCtx.fillRect(12, legendBaseY + i * 18, 10, 10);
            dCtx.fillStyle = 'rgba(255,255,255,0.8)';
            dCtx.fillText(LABELS[i], 26, legendBaseY + 6 + i * 18);
          });
          dCtx.fillStyle = 'rgba(255,255,255,0.5)';
          dCtx.fillText(`${poseState.persons.length} person(s)`, 12, legendBaseY - 10);
        }
      } else if (debugCanvas) {
        const dCtx = debugCanvas.getContext('2d');
        dCtx?.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
      }

      liveRaf = requestAnimationFrame(liveSync);
    };
    liveRaf = requestAnimationFrame(liveSync);

    const detach = attachKeyboard(handleAction, (held) => { kbRHeld = held; }, () => pedalDoubleChangesPattern);
    const detachTouch = attachTouch(handleAction);

    function onFsChange() {
      isFullscreenState = fs.isFullscreen();
      poke();
    }
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    // Keep the blob fresh so it never lags behind pp: keys
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { saveSettings(patterns); }
      else if (demoActive || isFullscreenState) { wl.acquire(); } // re-acquire after OS released it
    });
    // Re-hydrate controls when Arc (or any browser) restores the page from bfcache
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) {
        loadSettings(patterns);
        restoreFromKeys(patterns);
        syncCtrlVals();
      }
    });
    function onMouseMove() { pokeCursor(); (demoActive && demoHideHud) ? demoPoke() : poke(); }
    if (!isTouch) window.addEventListener("mousemove", onMouseMove);

    return () => {
      cancelAnimationFrame(liveRaf);
      gpController.dispose();
      stopMidi();
      detach();
      detachTouch();
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      if (!isTouch) window.removeEventListener("mousemove", onMouseMove);
      if (hudTimer) clearTimeout(hudTimer);
      if (demoTimer) clearTimeout(demoTimer);
      if (demoPointerTimer) clearTimeout(demoPointerTimer);
      if (autoRestartTimer) clearTimeout(autoRestartTimer);
      recorder?.dispose();
      recorder = null;
      wl.release();
      handle?.dispose();
      handle = null;
    };
  });
</script>

<canvas bind:this={debugCanvas} class="pointer-events-none fixed inset-0 z-30 w-full h-full"></canvas>

<!-- Interaction debug overlay — bottom-left, toggled by ⬡ button in Options/Interactions -->
{#if interactionDebug}
<div class="pointer-events-none fixed bottom-3 left-3 z-40 flex flex-col gap-0.5 rounded bg-black/70 px-2 py-1.5 font-mono text-[10px] leading-[1.6] text-white/80 backdrop-blur-sm">
  <div class="mb-0.5 text-[9px] uppercase tracking-widest text-white/40">Interaction Debug</div>
  <div class="flex gap-3">
    <div class="flex flex-col gap-0.5">
      <span class="text-white/40">CAM</span>
      <span>level <span class="text-green-400">{cameraState.level}</span></span>
      <span>dirX  <span class="text-cyan-400">{interactionState.dirX.toFixed(2)}</span></span>
      <span>dirY  <span class="text-cyan-400">{interactionState.dirY.toFixed(2)}</span></span>
      <span>burst <span class="text-yellow-400">{(interactionState.burst * 100).toFixed(0)}</span></span>
    </div>
    <div class="flex flex-col gap-0.5">
      <span class="text-white/40">AUDIO</span>
      <span>level <span class="text-green-400">{audioState.level}</span></span>
      <span>beat  <span class="text-yellow-400">{audioState.beat}</span></span>
      <span class="text-white/40 mt-0.5">UNIVERSALS</span>
      <span>colV2 <span class="text-purple-400">{colorC2.colorsV2.toFixed(1)}</span></span>
      <span>brit  <span class="text-orange-400">{interactionState.brightnessMult.toFixed(2)}</span></span>
      <span>idle  <span class="text-blue-400">{(interactionState.idleAmount * 100).toFixed(0)}</span></span>
      <span>here  <span class="{interactionState.presence ? 'text-green-400' : 'text-red-400'}">{interactionState.presence ? 'YES' : 'no'}</span></span>
    </div>
  </div>
</div>
{/if}

<canvas bind:this={canvas} class="block w-full h-full"
  onclick={() => { if (appState !== "overview" && !isTouch) hudVisible = false; }}
  ontouchstart={() => {
    if (appState !== "overview") {
      if (demoActive && demoHideHud) {
        demoPoke();
      } else if (hudVisible && !overlayHidden) {
        hudVisible = false;
        if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
      }
      // HUD is shown on tap (handled via "tap" action), not here,
      // so that swipes do not accidentally reveal the HUD.
    }
  }}
></canvas>

<!-- ─── Cross-fade snapshot overlay ──────────────────────────────────── -->
{#if snapshotUrl}
  <img
    src={snapshotUrl}
    bind:this={snapshotImg}
    class="pointer-events-none fixed inset-0 z-[5] h-full w-full object-cover transition-opacity duration-[1500ms]"
    class:opacity-0={snapshotFading}
    class:opacity-100={!snapshotFading}
    ontransitionend={() => { snapshotUrl = null; snapshotFading = false; }}
    alt=""
  />
{/if}

<!-- ─── Demo pointer dismiss button ──────────────────────────────────── -->
{#if demoActive && demoPointerVisible}
  <button
    class="fixed top-4 right-4 z-[70] rounded-full bg-black/60 px-3 py-1.5 text-sm text-white/80 hover:bg-black/80 transition-colors cursor-pointer"
    onclick={() => { stopDemo(); demoPointerVisible = false; poke(); }}
  >✕</button>
{/if}

<!-- ─── Overview overlay ──────────────────────────────────────────────── -->
{#if appState === "overview"}
  <div
    role="presentation"
    class="fixed inset-0 z-20 flex flex-col items-center overflow-y-auto bg-black/70 backdrop-blur-sm"
    onclick={(e) => { if (e.target === e.currentTarget) activatePattern(focusedIndex); }}
  >

    <div class="shrink-0 pt-10 pb-4 text-center">
      <p class="text-sm uppercase tracking-[0.35em] text-white/60 inline-flex items-center gap-2">Lichtspiel<span class="text-[9px] font-semibold tracking-widest text-white/40 border border-white/25 rounded px-1.5 py-0.5 normal-case">beta</span></p>
      <p class="text-[10px] tracking-widest text-white/30">by <a href="https://1000lights.de" target="_blank" rel="noopener noreferrer" class="hover:text-white/60 transition-colors">1000lights</a></p>
      <div class="mt-3 flex justify-center gap-2 flex-wrap">
        {#if !isIosBrowser && !isIosStandalone}
          <button
            class="rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/60 transition-colors cursor-pointer hover:border-white/40 hover:bg-white/15"
            onclick={() => { fs.enter(document.documentElement); }}
          >{isFullscreenState ? "Exit ⛶" : "⛶ Fullscreen"}</button>
        {/if}
        <button
          class="rounded-md border px-3 py-1.5 text-xs transition-colors cursor-pointer {demoActive ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 bg-white/[0.07] text-white/60 hover:border-white/40 hover:bg-white/15'}"
          onclick={() => { demoVisible = true; }}
        >{demoActive ? "● Demo" : "Demo"}</button>
        <button
          class="rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/60 transition-colors cursor-pointer hover:border-white/40 hover:bg-white/15"
          onclick={() => { optionsVisible = true; }}
        >⚙ Options</button>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div
          class="rounded-md border px-3 py-1.5 text-xs cursor-pointer select-none transition-all duration-200
                 {privacyMode.active ? 'border-purple-500/50 bg-purple-900/50 text-purple-300' : 'border-white/15 bg-white/[0.07] text-white/60 hover:border-white/40 hover:bg-white/15'}"
          title="Sensor Block — overrides all camera and audio inputs globally."
          onclick={() => {
            if (!privacyMode.active) {
              _sbSavedCameraEnabled = cameraState.enabled;
              _sbSavedMotionEnabled = cameraState.motionEnabled;
              _sbSavedAudioEnabled  = audioState.enabled;
              _sbSavedPatternCams.clear();
              for (const c of (patterns[index].controls ?? [])) {
                if (c.type === 'toggle' && (c as any).interactive === 'camera') {
                  _sbSavedPatternCams.set(c.label, c.get());
                  (c as import('./lib/patterns/types').PatternControl & { type: 'toggle' }).set(false);
                  ctrlVals[c.label] = 0;
                }
              }
              cameraState.motionEnabled = false;
              cameraState.enabled = false;
              audioState.enabled = false;
              _sbSavedPoseActive = poseActive;
              if (poseActive) { stopPoseTracking(); poseActive = false; poseError = null; }
              privacyMode.active = true;
              killAllStreams();
            } else {
              privacyMode.active = false;
              if (_sbSavedCameraEnabled) { cameraState.motionEnabled = _sbSavedMotionEnabled; cameraState.enabled = true; }
              if (_sbSavedAudioEnabled) { audioState.enabled = true; enumerateMicrophones(); }
              for (const c of (patterns[index].controls ?? [])) {
                if (c.type === 'toggle' && (c as any).interactive === 'camera') {
                  const wasOn = _sbSavedPatternCams.get(c.label) ?? false;
                  if (wasOn) { (c as import('./lib/patterns/types').PatternControl & { type: 'toggle' }).set(true); ctrlVals[c.label] = 1; }
                }
              }
            }
          }}
        >⊘ Sensor Block</div>
        <button
          class="rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/60 transition-colors cursor-pointer hover:border-white/40 hover:bg-white/15"
          onclick={() => { cheatsheetVisible = true; }}
        >?</button>
      </div>
    </div>

    <!-- Filter bar -->
    <div class="flex gap-1.5 px-3 pb-3 flex-wrap justify-center">
      <button
        class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer
          {!showFavoritesOnly && !showPoseOnly ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/50 hover:border-white/30'}"
        onclick={() => { showFavoritesOnly = false; showPoseOnly = false; }}
      >All</button>
      <button
        class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer
          {showFavoritesOnly ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/50 hover:border-white/30'}"
        onclick={() => { showFavoritesOnly = true; showPoseOnly = false; }}
      >★ Favorites</button>
      <button
        class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer
          {showPoseOnly ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/50 hover:border-white/30'}"
        onclick={() => { showPoseOnly = true; showFavoritesOnly = false; }}
      >⬡ Pose</button>
    </div>

    <div class="grid grid-cols-3 gap-2 px-3 w-full max-w-lg pb-4">
      {#if displayPatterns.length === 0}
        <div class="col-span-3 py-8 text-center text-sm text-white/35">
          {#if showFavoritesOnly}No favorites yet — star a pattern to add it here{:else}No patterns match this filter{/if}
        </div>
      {:else}
        {#each displayPatterns as { p, i }}
          {#if p.id === 'lightPaint' && !showFavoritesOnly && !showPoseOnly}
            <div class="col-span-3 mt-2 flex items-center gap-2">
              <div class="h-px flex-1 bg-white/20"></div>
              <span class="text-[10px] uppercase tracking-widest text-white/40">Live Light Painting</span>
              <div class="h-px flex-1 bg-white/20"></div>
            </div>
          {/if}
          {#if p.id === 'img-tealLines' && !showFavoritesOnly}
            <div class="col-span-3 mt-2 flex items-center gap-2">
              <div class="h-px flex-1 bg-white/20"></div>
              <span class="text-[10px] uppercase tracking-widest text-white/40">Static Images</span>
              <div class="h-px flex-1 bg-white/20"></div>
            </div>
          {/if}
          {#if p.id === 'particlesPalette' && !showFavoritesOnly && !showPoseOnly}
            <div class="col-span-3 mt-2 flex items-center gap-2">
              <div class="h-px flex-1 bg-white/20"></div>
              <span class="text-[10px] uppercase tracking-widest text-white/40">Experimental</span>
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <div
                class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {experimentalEnabled ? 'bg-white/60' : 'bg-white/20'}"
                onclick={() => {
                  experimentalEnabled = !experimentalEnabled;
                  localStorage.setItem(EXPERIMENTAL_KEY, String(experimentalEnabled));
                  if (!experimentalEnabled) {
                    const next = new Set(demoPatternIds);
                    EXPERIMENTAL_IDS.forEach(id => next.delete(id));
                    applyDemoPatternIds(next);
                  }
                }}
                role="switch"
                aria-checked={experimentalEnabled}
                tabindex="0"
              >
                <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {experimentalEnabled ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
              </div>
              <div class="h-px flex-1 bg-white/20"></div>
            </div>
          {/if}
          <button
            class="relative flex flex-col gap-1 rounded-xl border px-3 py-3 text-left transition-all duration-150 cursor-pointer
              {EXPERIMENTAL_IDS.has(p.id) && !experimentalEnabled ? 'opacity-35' : ''}
              {focusedIndex === i
                ? 'border-white bg-white/10 shadow-[0_0_28px_rgba(255,255,255,0.12)]'
                : 'border-white/15 bg-white/[0.04] hover:border-white/40 hover:bg-white/[0.07]'}"
            onclick={() => activatePattern(i)}
            onmouseenter={() => { focusedIndex = i; switchTo(i); }}
          >
            <div class="flex items-center gap-1.5">
              <span class="text-[10px] font-mono text-white/35">{i + 1}</span>
              {#if p.usesPose}
                <span class="text-[9px] font-semibold tracking-widest text-white/40 border border-white/25 rounded px-1 py-0.5 normal-case">pose</span>
              {/if}
            </div>
            <span class="text-[13px] font-semibold leading-snug text-white pr-5">{p.name}</span>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <span
              class="absolute right-3 top-2.5 text-sm transition-colors cursor-pointer {favorites.has(p.id) ? 'text-yellow-300/80' : 'text-white/20 hover:text-white/50'}"
              onclick={(e) => { e.stopPropagation(); toggleFavorite(p.id); }}
            >{favorites.has(p.id) ? '★' : '☆'}</span>
          </button>
        {/each}
        <div class="col-span-3 pt-3 pb-1 text-center font-mono text-[10px] text-white/20">{__VERSION__}</div>
      {/if}
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


  </div>
{/if}

<!-- ─── Screenshot flash ─────────────────────────────────────────────── -->
{#if screenshotFlash}
  <div class="pointer-events-none fixed inset-0 z-50 bg-white/25 transition-opacity duration-500"></div>
{/if}

<!-- ─── Pose loading overlay ────────────────────────────────────────────── -->
{#if poseLoading}
  <div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
    <div class="rounded-xl border border-white/20 bg-black/70 px-6 py-4 text-center backdrop-blur-sm">
      <div class="mb-1 text-sm font-semibold text-white">Enabling body tracking…</div>
      <div class="text-xs text-white/50">This takes a moment on first use</div>
    </div>
  </div>
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
    data-no-swipe
    class="fixed inset-0 z-[60] flex items-start justify-center bg-black/75 backdrop-blur-sm overflow-y-auto py-8"
    onclick={() => { cheatsheetVisible = false; }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="mx-4 w-full max-w-3xl rounded-xl border border-white/10 bg-black/90 p-5 text-white"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="mb-4 flex items-center justify-between">
        <span class="text-xs font-semibold uppercase tracking-[0.3em] text-white/60">About</span>
        <button
          class="cursor-pointer rounded px-2 py-0.5 text-xs text-white/50 hover:text-white/80 transition-colors"
          onclick={() => { cheatsheetVisible = false; }}
        >✕  any key</button>
      </div>
      <p class="mb-4 text-sm text-white/70 leading-relaxed">
        Lichtspiel is being created by light artist Ulrich Tausend
        <a href="https://1000lights.de" target="_blank" rel="noopener noreferrer"
           class="text-white/90 underline hover:text-white transition-colors">1000lights.de</a>
      </p>
      <div class="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-white/50">Controls</div>
      <table class="w-full border-collapse">
        <thead>
          <tr class="border-b border-white/20">
            <th class="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-white/50">Controls</th>
            <th class="pb-2 pl-4 text-left text-xs font-semibold uppercase tracking-wider text-white/50">Keyboard / 8BitDo Micro (Pedal)</th>
            <th class="pb-2 pl-4 text-left text-xs font-semibold uppercase tracking-wider text-white/50">Dual Shock</th>
          </tr>
        </thead>
        <tbody>
          {#each cheatsheetRows as row}
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

<!-- ─── Flicker-guard disable confirmation ───────────────────────────────── -->
{#if flickerGuardConfirmVisible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    data-no-swipe
    class="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
    onclick={() => { flickerGuardConfirmVisible = false; }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="mx-4 w-full max-w-md rounded-xl border border-red-500/30 bg-black/90 p-5 text-white"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="mb-3 flex items-center gap-2">
        <span class="text-lg">⚠</span>
        <span class="text-xs font-semibold uppercase tracking-[0.2em] text-red-400/80">Disable epilepsy guard?</span>
      </div>
      <div class="mb-4 space-y-2 text-xs leading-relaxed text-white/70">
        <p>The flicker guard continuously analyses screen brightness (based on the broadcast standard <span class="text-white/90">ITU-R BT.1702 / Harding</span>) and damps abrupt light–dark flashing that can trigger photosensitive epilepsy.</p>
        <p><span class="text-red-300/90">It cannot guarantee that seizures are prevented</span> — this is not a medical assurance. Disabling removes this protection entirely; not recommended with an audience or at festivals.</p>
        <p class="text-white/50">Note: on older or low-powered devices the guard can cost frame rate — which is why it can be switched off.</p>
      </div>
      <div class="flex justify-end gap-2">
        <button
          class="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs text-white/80 hover:bg-white/15 transition-colors cursor-pointer"
          onclick={() => { flickerGuardConfirmVisible = false; }}
        >Cancel</button>
        <button
          class="rounded-md border border-red-500/40 bg-red-500/15 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/25 transition-colors cursor-pointer"
          onclick={() => { flickerGuard.enabled = false; saveFlickerGuard(); flickerGuardConfirmVisible = false; }}
        >Disable guard</button>
      </div>
    </div>
  </div>
{/if}

<!-- ─── Options modal ────────────────────────────────────────────────────── -->
{#if optionsVisible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    data-no-swipe
    class="fixed inset-0 z-[60] flex items-start justify-center bg-black/75 backdrop-blur-sm overflow-y-auto py-8"
    onclick={() => { optionsVisible = false; }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="mx-4 w-full max-w-sm rounded-xl border border-white/10 bg-black/90 p-5 text-white"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="mb-4 flex items-center justify-between">
        <span class="text-xs font-semibold uppercase tracking-[0.3em] text-white/60">Options</span>
        <button
          class="cursor-pointer rounded px-2 py-0.5 text-xs text-white/50 hover:text-white/80 transition-colors"
          onclick={() => { optionsVisible = false; }}
        >✕</button>
      </div>


      <!-- Demo section -->
      <div class="mb-5">
        <div class="mb-3 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/15"></div>
          <span class="text-[10px] uppercase tracking-widest text-white/40">Demo</span>
          <div class="h-px flex-1 bg-white/15"></div>
        </div>
        <div class="flex flex-col gap-3">
          <!-- Start in Demo Mode on launch -->
          <div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-white/70">Start in Demo Mode on launch</span>
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <div
                class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {demoAutoStart ? 'bg-white/60' : 'bg-white/20'}"
                onclick={() => {
                  demoAutoStart = !demoAutoStart;
                  localStorage.setItem(DEMO_AUTOSTART_KEY, String(demoAutoStart));
                }}
                role="switch"
                aria-checked={demoAutoStart}
                tabindex="0"
              >
                <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {demoAutoStart ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
              </div>
            </div>
            <div class="mt-1 text-[10px] leading-snug text-white/30">Boots straight into the demo — for kiosks/installations.</div>
          </div>
          <!-- Auto-restart toggle -->
          <div class="flex items-center justify-between">
            <span class="text-xs text-white/70">Auto-restart demo on idle</span>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {demoAutoRestart ? 'bg-white/60' : 'bg-white/20'}"
              onclick={() => {
                demoAutoRestart = !demoAutoRestart;
                localStorage.setItem(DEMO_AUTORESTART_KEY, String(demoAutoRestart));
                scheduleAutoRestart();
              }}
              role="switch"
              aria-checked={demoAutoRestart}
              tabindex="0"
            >
              <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {demoAutoRestart ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
            </div>
          </div>
          <!-- Idle time input — only shown when toggle is on -->
          {#if demoAutoRestart}
            <div class="flex items-center justify-between gap-3">
              <span class="text-xs text-white/50">Idle time before restart <span class="font-mono text-white/30">(hh:mm)</span></span>
              <input
                type="text"
                value={demoAutoRestartTime}
                placeholder="hh:mm"
                maxlength={5}
                oninput={(e) => {
                  const v = (e.target as HTMLInputElement).value.trim();
                  demoAutoRestartTime = v;
                  if (/^\d{1,2}:\d{2}$/.test(v)) {
                    localStorage.setItem(DEMO_AUTORESTART_TIME_KEY, v);
                    scheduleAutoRestart();
                  }
                }}
                onblur={(e) => {
                  // Normalise to hh:mm on blur
                  const raw = (e.target as HTMLInputElement).value.trim();
                  const [hhStr, mmStr] = raw.split(':');
                  const hh = Math.max(0, parseInt(hhStr ?? '0', 10) || 0);
                  const mm = Math.min(59, Math.max(0, parseInt(mmStr ?? '0', 10) || 0));
                  const normalised = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
                  demoAutoRestartTime = normalised;
                  localStorage.setItem(DEMO_AUTORESTART_TIME_KEY, normalised);
                  scheduleAutoRestart();
                }}
                class="w-16 rounded bg-white/10 px-2 py-0.5 font-mono text-xs text-white text-center outline-none placeholder-white/30 focus:bg-white/15"
              />
            </div>
          {/if}
        </div>
      </div>

      <!-- Camera section -->
      <div class="mb-5">
        <div class="mb-3 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/15"></div>
          <span class="text-[10px] uppercase tracking-widest text-white/40">Camera</span>
          <div class="h-px flex-1 bg-white/15"></div>
        </div>
        <!-- Capture resolution (camera-feed patterns: Light Painting / ASCII) -->
        <div class="mb-3 flex items-center justify-between gap-2">
          <span class="shrink-0 text-xs text-white/70">Capture resolution</span>
          <select
            value={cameraState.resWidth}
            onchange={(e) => setCameraResolution(parseInt((e.target as HTMLSelectElement).value))}
            class="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
          >
            {#each CAMERA_RES_OPTIONS as o}
              <option value={o.w}>{o.label}</option>
            {/each}
          </select>
        </div>
        <div class="mb-2 text-[10px] leading-snug text-white/30">Applies to Light Painting &amp; ASCII. Motion / Pose stay low-res for performance.</div>

        <!-- Show virtual multi-lens cameras toggle -->
        <div class="flex items-center justify-between">
          <span class="text-xs text-white/70">Show virtual multi-lens cameras</span>
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="relative h-[18px] w-7 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {cameraState.showVirtual ? 'bg-white/70' : 'bg-white/20'}"
            onclick={() => setShowVirtualCameras(!cameraState.showVirtual)}
            role="switch"
            aria-checked={cameraState.showVirtual}
            tabindex="0"
          >
            <div class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 {cameraState.showVirtual ? 'translate-x-[11px]' : 'translate-x-[2px]'}"></div>
          </div>
        </div>
        <div class="mb-3 text-[10px] leading-snug text-white/30">Off by default. Real lenses (wide / ultra-wide / telephoto) are stable. Virtual “Dual/Triple” cameras auto-switch lens by zoom &amp; lighting — handy creatively, but they can make different patterns use a different lens.</div>

        <!-- Test cameras -->
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-white/70">Test cameras</span>
          <button
            onclick={() => runCameraTest()}
            disabled={cameraTesting}
            class="rounded border border-white/15 px-2 py-0.5 text-[11px] text-white/60 hover:border-white/40 hover:text-white/90 transition-colors cursor-pointer disabled:opacity-40"
          >{cameraTesting ? 'Testing…' : 'Run test'}</button>
        </div>
        {#if cameraProbes.length > 0}
          <div class="mt-2 rounded bg-white/[0.05] px-2 py-1.5 text-[11px]">
            <div class="mb-1 {cameraProbeStatus === 'mismatch' ? 'text-amber-400' : cameraProbeStatus === 'error' ? 'text-white/50' : 'text-emerald-400/80'}">
              {cameraProbeStatus === 'mismatch' ? '⚠ Patterns resolve to different cameras:' : cameraProbeStatus === 'error' ? 'Camera test results:' : '✓ All patterns use the same camera:'}
            </div>
            {#each cameraProbes as p}
              <div class="flex justify-between gap-2 text-white/60">
                <span class="shrink-0">{p.name}</span>
                <span class="min-w-0 truncate text-right text-white/80">{p.error ? '⚠ ' + p.error : `${p.label} · ${p.width}×${p.height}`}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- MIDI section -->
      <div class="mb-5">
        <div class="mb-3 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/15"></div>
          <span class="text-[10px] uppercase tracking-widest text-white/40">MIDI</span>
          <div class="h-px flex-1 bg-white/15"></div>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-xs text-white/70">Enable MIDI</span>
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {midiEnabled ? 'bg-white/60' : 'bg-white/20'}"
            onclick={() => {
              midiEnabled = !midiEnabled;
              localStorage.setItem(MIDI_ENABLED_KEY, String(midiEnabled));
              if (midiEnabled) _midiStart?.(); else _midiStop?.();
            }}
            role="switch"
            aria-checked={midiEnabled}
            tabindex="0"
          >
            <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {midiEnabled ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
          </div>
        </div>
        {#if midiEnabled}
          <div class="mt-2 text-[11px] text-white/40">{midiConnected ? '♪ Device connected' : 'No device detected'}</div>
        {/if}
      </div>

      <!-- Capture section -->
      <div class="mb-5">
        <div class="mb-3 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/15"></div>
          <span class="text-[10px] uppercase tracking-widest text-white/40">Capture</span>
          <div class="h-px flex-1 bg-white/15"></div>
        </div>
        <div class="flex flex-col gap-2.5">
          <div class="flex items-center justify-between">
            <span class="text-xs text-white/70">Screenshots</span>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {screenshotsEnabled ? 'bg-white/60' : 'bg-white/20'}"
              onclick={() => { screenshotsEnabled = !screenshotsEnabled; localStorage.setItem(SCREENSHOTS_ENABLED_KEY, String(screenshotsEnabled)); }}
              role="switch"
              aria-checked={screenshotsEnabled}
              tabindex="0"
            >
              <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {screenshotsEnabled ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs text-white/70">Screen Recording</span>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {recordingsEnabled ? 'bg-white/60' : 'bg-white/20'}"
              onclick={() => { recordingsEnabled = !recordingsEnabled; localStorage.setItem(RECORDINGS_ENABLED_KEY, String(recordingsEnabled)); }}
              role="switch"
              aria-checked={recordingsEnabled}
              tabindex="0"
            >
              <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {recordingsEnabled ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Pedal section -->
      <div class="mb-5">
        <div class="mb-3 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/15"></div>
          <span class="text-[10px] uppercase tracking-widest text-white/40">Pedal</span>
          <div class="h-px flex-1 bg-white/15"></div>
        </div>
        <div class="flex flex-col gap-2.5">
          <div class="flex items-center justify-between">
            <span class="text-xs text-white/70">Short press <span class="text-white/30">/ b key</span></span>
            <div class="flex gap-1">
              {#each ([{ v: 'cycle' as const, label: 'Cycle 1·2·3' }, { v: 'random' as const, label: 'Randomize' }]) as opt}
                <button
                  onclick={() => { randomizeMode = opt.v; localStorage.setItem(RANDOMIZE_MODE_KEY, opt.v); }}
                  class="rounded px-2 py-0.5 text-[10px] border transition-colors cursor-pointer {randomizeMode === opt.v ? 'border-white/50 bg-white/15 text-white' : 'border-white/15 text-white/50 hover:border-white/40 hover:text-white/80'}"
                >{opt.label}</button>
              {/each}
            </div>
          </div>
          <div class="flex items-center justify-between {randomizeMode === 'cycle' ? 'opacity-40' : ''}">
            <span class="text-xs text-white/70">Short press changes pattern <span class="text-white/30">(off = randomize only)</span></span>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {pedalChangesPattern ? 'bg-white/60' : 'bg-white/20'}"
              onclick={() => { pedalChangesPattern = !pedalChangesPattern; localStorage.setItem(PEDAL_CHANGES_PATTERN_KEY, String(pedalChangesPattern)); }}
              role="switch"
              aria-checked={pedalChangesPattern}
              tabindex="0"
            >
              <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {pedalChangesPattern ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs text-white/70">Double-press changes pattern</span>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {pedalDoubleChangesPattern ? 'bg-white/60' : 'bg-white/20'}"
              onclick={() => { pedalDoubleChangesPattern = !pedalDoubleChangesPattern; localStorage.setItem(PEDAL_DOUBLE_CHANGES_PATTERN_KEY, String(pedalDoubleChangesPattern)); }}
              role="switch"
              aria-checked={pedalDoubleChangesPattern}
              tabindex="0"
            >
              <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {pedalDoubleChangesPattern ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
            </div>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="shrink-0 text-xs text-white/70">Long press</span>
            <select
              value={pedalLongAction}
              onchange={(e) => { pedalLongAction = (e.target as HTMLSelectElement).value as PedalLongAction; localStorage.setItem(PEDAL_LONG_ACTION_KEY, pedalLongAction); }}
              class="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
            >
              <option value="none">Nothing happens</option>
              <option value="lightPaint">Light Paint</option>
              <option value="screenshot">Screenshot</option>
              <option value="record10">Record 10-second video</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Presets section -->
      <div class="mb-5">
        <div class="mb-3 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/15"></div>
          <span class="text-[10px] uppercase tracking-widest text-white/40">Presets</span>
          <div class="h-px flex-1 bg-white/15"></div>
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-white/70">Reset slots 1·2·3 to factory defaults</span>
          <div class="flex gap-1 shrink-0">
            <button
              onclick={() => { resetSlots(patterns[index].id); presetSlots = getSlots(patterns[index].id); presetCycleIdx = -1; resetAllControls(); }}
              class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer"
            >This pattern</button>
            <button
              onclick={() => { if (confirm('Reset ALL patterns to factory defaults? This deletes every saved preset slot.')) { resetAllSlots(); presetSlots = getSlots(patterns[index].id); presetCycleIdx = -1; resetAllControls(); } }}
              class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-rose-300/50 hover:text-rose-200/90 transition-colors cursor-pointer"
            >All patterns</button>
          </div>
        </div>
      </div>

      <!-- Custom Colours section -->
      <div class="mb-5">
        <div class="mb-2 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/15"></div>
          <span class="text-[10px] uppercase tracking-widest text-white/40">Custom Colours</span>
          <div class="h-px flex-1 bg-white/15"></div>
        </div>
        <div class="mb-2 flex justify-end">
          <button
            onclick={() => { Object.assign(colorC2, COLOR_DEFAULTS); saveColorC2(); }}
            class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer"
          >Reset All</button>
        </div>
        <!-- Base 3 colours (always on) -->
        <div class="flex flex-col gap-2">
          {#each ([
            { key: 'main'     as const, label: 'Main'     },
            { key: 'contrast' as const, label: 'Contrast' },
            { key: 'glow'     as const, label: 'Glow'     },
          ]) as cp}
            <div class="flex items-center gap-2">
              <input type="color" value={colorC2[cp.key]}
                oninput={(e) => { colorC2[cp.key] = (e.target as HTMLInputElement).value; saveColorC2(); }}
                class="h-7 w-10 shrink-0 cursor-pointer rounded border border-white/20 bg-transparent p-0.5" />
              <span class="text-xs text-white/70 w-14 shrink-0">{cp.label}</span>
              <input type="text" value={colorC2[cp.key]} placeholder="#rrggbb"
                oninput={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (/^#[0-9a-fA-F]{6}$/.test(v)) { colorC2[cp.key] = v; saveColorC2(); } }}
                class="min-w-0 flex-1 rounded bg-white/10 px-2 py-0.5 font-mono text-xs text-white outline-none placeholder-white/30 focus:bg-white/15" />
              {#if colorC2[cp.key] !== COLOR_DEFAULTS[cp.key]}
                <button onclick={() => { colorC2[cp.key] = COLOR_DEFAULTS[cp.key]; saveColorC2(); }}
                  class="text-sm text-white/50 hover:text-white/80 border border-white/20 hover:border-white/50 rounded px-2 py-1 transition-colors cursor-pointer shrink-0">↺</button>
              {/if}
            </div>
          {/each}
        </div>
        <!-- Extra 3 colours (toggleable) -->
        <div class="mt-3 flex flex-col gap-2">
          <span class="text-[10px] uppercase tracking-widest text-white/30">Extras</span>
          {#each ([
            { key: 'extra1' as const, onKey: 'extra1on' as const, label: 'Extra 1' },
            { key: 'extra2' as const, onKey: 'extra2on' as const, label: 'Extra 2' },
            { key: 'extra3' as const, onKey: 'extra3on' as const, label: 'Extra 3' },
          ]) as ep}
            <div class="flex items-center gap-2 transition-opacity" class:opacity-40={!colorC2[ep.onKey]}>
              <!-- Toggle -->
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <div class="relative h-[16px] w-6 shrink-0 cursor-pointer rounded-full transition-colors duration-200 {colorC2[ep.onKey] ? 'bg-white/70' : 'bg-white/20'}"
                onclick={() => { colorC2[ep.onKey] = !colorC2[ep.onKey]; saveColorC2(); }}>
                <div class="absolute top-[2px] h-3 w-3 rounded-full bg-white shadow transition-transform duration-200 {colorC2[ep.onKey] ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
              </div>
              <input type="color" value={colorC2[ep.key]} disabled={!colorC2[ep.onKey]}
                oninput={(e) => { colorC2[ep.key] = (e.target as HTMLInputElement).value; saveColorC2(); }}
                class="h-7 w-10 shrink-0 cursor-pointer rounded border border-white/20 bg-transparent p-0.5 disabled:cursor-not-allowed" />
              <span class="text-xs text-white/70 w-14 shrink-0">{ep.label}</span>
              <input type="text" value={colorC2[ep.key]} placeholder="#rrggbb" disabled={!colorC2[ep.onKey]}
                oninput={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (/^#[0-9a-fA-F]{6}$/.test(v)) { colorC2[ep.key] = v; saveColorC2(); } }}
                class="min-w-0 flex-1 rounded bg-white/10 px-2 py-0.5 font-mono text-xs text-white outline-none placeholder-white/30 focus:bg-white/15 disabled:cursor-not-allowed" />
              {#if colorC2[ep.key] !== COLOR_DEFAULTS[ep.key]}
                <button onclick={() => { colorC2[ep.key] = COLOR_DEFAULTS[ep.key]; saveColorC2(); }}
                  class="text-sm text-white/50 hover:text-white/80 border border-white/20 hover:border-white/50 rounded px-2 py-1 transition-colors cursor-pointer shrink-0">↺</button>
              {/if}
            </div>
          {/each}
        </div>
      </div>

      <!-- Interactions section -->
      <div class="mb-5">
        <div class="mb-3 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/15"></div>
          <span class="text-[10px] uppercase tracking-widest text-white/40">Interactions</span>
          <div class="h-px flex-1 bg-white/15"></div>
        </div>
        <div class="flex flex-col gap-3">
          <!-- Interaction Strength -->
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-white/70">Interaction Strength</span>
              <span class="font-mono text-[11px] text-white/40">{interactionState.strength.toFixed(1)}</span>
            </div>
            <input
              type="range" min={0} max={1} step={0.05}
              value={interactionState.strength}
              oninput={(e) => { interactionState.strength = parseFloat((e.target as HTMLInputElement).value); saveInteractionSettings(); }}
              class="w-full accent-white cursor-pointer"
            />
            <div class="mt-0.5 text-[10px] text-white/30">Scales all universal reactions (Brightness, Colors, Speed)</div>
          </div>
          <!-- Presence Timeout -->
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-white/70">Idle Timeout</span>
              <span class="font-mono text-[11px] text-white/40">{interactionState.presenceTimeoutSec.toFixed(0)} s</span>
            </div>
            <input
              type="range" min={2} max={15} step={1}
              value={interactionState.presenceTimeoutSec}
              oninput={(e) => { interactionState.presenceTimeoutSec = parseFloat((e.target as HTMLInputElement).value); saveInteractionSettings(); }}
              class="w-full accent-white cursor-pointer"
            />
            <div class="mt-0.5 text-[10px] text-white/30">Seconds of stillness before entering idle / Speed boost state</div>
          </div>
          <!-- Burst Threshold -->
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-white/70">Burst Threshold</span>
              <span class="font-mono text-[11px] text-white/40">{interactionState.burstThreshold.toFixed(2)}</span>
            </div>
            <input
              type="range" min={0.05} max={0.5} step={0.01}
              value={interactionState.burstThreshold}
              oninput={(e) => { interactionState.burstThreshold = parseFloat((e.target as HTMLInputElement).value); saveInteractionSettings(); }}
              class="w-full accent-white cursor-pointer"
            />
            <div class="mt-0.5 text-[10px] text-white/30">How sharp a gesture spike needs to be to trigger a Burst flash</div>
          </div>
          <!-- Debug overlay toggle -->
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="flex items-center justify-between">
            <span class="text-xs text-white/70">Signal debug overlay</span>
            <div
              class="relative h-[16px] w-6 shrink-0 cursor-pointer rounded-full transition-colors duration-200 {interactionDebug ? 'bg-white/70' : 'bg-white/20'}"
              onclick={() => { interactionDebug = !interactionDebug; }}
            >
              <div class="absolute top-[2px] h-3 w-3 rounded-full bg-white shadow transition-transform duration-200 {interactionDebug ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Developer section -->
      <div class="mb-5">
        <div class="mb-3 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/15"></div>
          <span class="text-[10px] uppercase tracking-widest text-white/40">Developer</span>
          <div class="h-px flex-1 bg-white/15"></div>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-xs text-white/70">Export preset defaults</span>
          <button
            onclick={() => {
              const entries: string[] = [];
              const validIds = new Set(patterns.map(p => p.id));
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i)!;
                if (k.startsWith('pp:slots:')) {
                  const patternId = k.slice('pp:slots:'.length);
                  if (!validIds.has(patternId)) continue; // skip zombie keys from renamed/removed patterns
                  const val = localStorage.getItem(k);
                  entries.push(`  '${patternId}': ${val},`);
                }
              }
              const ts = `  // paste into src/lib/preset-defaults.ts\n${entries.join('\n')}`;
              navigator.clipboard.writeText(ts);
            }}
            class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer"
          >Copy Defaults</button>
        </div>

        <div class="mt-2 flex items-center justify-between">
          <span class="text-xs text-white/70">Factory reset</span>
          <button
            onclick={() => {
              if (confirm('Reset ALL settings to factory defaults? This clears every saved value and reloads the app.')) {
                localStorage.clear();
                location.reload();
              }
            }}
            class="rounded px-2 py-0.5 text-[10px] text-red-400/70 border border-red-500/20 hover:border-red-400/50 hover:text-red-300 transition-colors cursor-pointer"
          >Reset & Reload</button>
        </div>

        <!-- Epilepsy guard (photosensitivity flicker damping) -->
        <div class="mt-3 flex items-center justify-between">
          <span class="text-xs text-white/70">Epilepsy guard</span>
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {flickerGuard.enabled ? 'bg-white/60' : 'bg-white/20'}"
            onclick={() => {
              if (flickerGuard.enabled) {
                flickerGuardConfirmVisible = true;   // disabling requires confirmation
              } else {
                flickerGuard.enabled = true;
                saveFlickerGuard();
              }
            }}
            role="switch"
            aria-checked={flickerGuard.enabled}
            tabindex="0"
          >
            <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {flickerGuard.enabled ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
          </div>
        </div>
        <div class="mt-1 text-[10px] leading-snug {flickerGuard.enabled ? 'text-white/30' : 'text-red-400/70'}">
          {flickerGuard.enabled
            ? 'Real-time flicker damping for photosensitivity (ITU-R BT.1702 / Harding-based).'
            : '⚠ Disabled — no flicker protection active.'}
        </div>
      </div>

    </div>
  </div>
{/if}

<!-- ─── Demo modal ────────────────────────────────────────────────────────── -->
{#if demoVisible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    data-no-swipe
    class="fixed inset-0 z-[60] flex items-start justify-center bg-black/75 backdrop-blur-sm overflow-y-auto py-8"
    onclick={() => { demoVisible = false; }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="mx-4 w-full max-w-lg rounded-xl border border-white/10 bg-black/90 p-5 text-white"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="mb-4 flex items-center justify-between">
        <span class="text-xs font-semibold uppercase tracking-[0.3em] text-white/60">Demo</span>
        <div class="flex gap-2 items-center">
          <button
            class="rounded-md border px-3 py-1 text-xs transition-colors cursor-pointer {demoActive ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 bg-white/[0.07] text-white/60 hover:border-white/40'}"
            onclick={() => { demoActive ? stopDemo() : startDemo(); }}
          >{demoActive ? "● Stop Demo" : "▶ Start Demo"}</button>
          <button
            class="cursor-pointer rounded px-2 py-0.5 text-xs text-white/50 hover:text-white/80 transition-colors"
            onclick={() => { demoVisible = false; }}
          >✕</button>
        </div>
      </div>

      <!-- Dwell time -->
      <div class="mb-3">
        <div class="flex justify-between mb-1 text-xs text-white/70">
          <span>Dwell time</span>
          <span class="font-mono text-white/40">{demoDwell < 60 ? demoDwell + ' s' : Math.floor(demoDwell / 60) + 'm' + (demoDwell % 60 ? ' ' + (demoDwell % 60) + 's' : '')}</span>
        </div>
        <input
          type="range" min={5} max={240} step={5} value={demoDwell}
          oninput={(e) => { demoDwell = parseInt((e.target as HTMLInputElement).value); saveDemoSettings(demoActive, demoDwell, pedalDwell, [...demoPatternIds], demoStartBehavior, demoRandomizeOrder, demoFavoritesOnly); if (demoActive) resetDemoTimer(); }}
          class="w-full accent-white cursor-pointer"
        />
      </div>

      <!-- Interactive features -->
      <div class="mb-3">
        <div class="mb-1.5 text-[10px] uppercase tracking-widest text-white/40">Interactive features</div>
        <div class="flex gap-2">
          <button
            class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer {cameraState.enabled && cameraState.motionEnabled ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/40 hover:border-white/30'}"
            onclick={() => {
              const isOn = cameraState.enabled && cameraState.motionEnabled;
              const next = !isOn;
              cameraState.motionEnabled = next;
              if (next) {
                // Override any per-pattern disabled flags for all demo patterns
                for (const p of patterns) { cameraState.patternMotionEnabled[p.id] = true; }
                savePatternMotionEnabled();
                if (!cameraState.enabled) cameraState.enabled = true;
                enumerateCameras();
              }
            }}
          >Motion</button>
          <button
            class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer {poseLoading ? 'border-white/20 text-white/30 cursor-wait' : poseActive ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/40 hover:border-white/30'}"
            onclick={() => togglePoseTracking()}
            disabled={poseLoading}
          >{poseLoading ? '…' : 'Pose'}</button>
          <button
            class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer {audioState.enabled ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/40 hover:border-white/30'}"
            onclick={() => {
              audioState.enabled = !audioState.enabled;
              if (audioState.enabled) {
                // Override any per-pattern disabled flags for all demo patterns
                for (const p of patterns) { audioState.patternAudioEnabled[p.id] = true; }
                savePatternAudioEnabled();
                enumerateMicrophones();
              }
            }}
          >Audio</button>
        </div>
        {#if poseError}
          <div class="mt-1.5 text-[11px] text-red-400/80">{poseError}</div>
        {/if}

        <!-- Device pickers — camera is always available (Light Painting/ASCII patterns
             use it too, not just Motion/Pose); mic shown when Audio active. -->
        <div class="mt-2.5 flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <span class="w-14 shrink-0 text-[11px] text-white/40">Camera</span>
              {#if getVisibleDevices().length > 0}
                <select
                  value={getVisibleDevices().findIndex(d => d.deviceId === cameraState.deviceId)}
                  onchange={(e) => { const i = parseInt((e.target as HTMLSelectElement).value); cameraState.deviceId = getVisibleDevices()[i]?.deviceId ?? ''; saveCameraDevice(); }}
                  class="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
                >
                  {#each getVisibleDevices() as d, i}
                    <option value={i}>{d.label}</option>
                  {/each}
                </select>
              {:else}
                <span class="min-w-0 flex-1 text-xs text-white/30">No cameras detected — tap ↺</span>
              {/if}
              <button onclick={() => detectCameras()} class="shrink-0 text-[11px] text-white/30 hover:text-white/60 transition-colors cursor-pointer" title="Detect cameras">↺</button>
              <button onclick={() => runCameraTest()} disabled={cameraTesting} class="shrink-0 rounded border border-white/15 px-2 py-0.5 text-[11px] text-white/50 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer disabled:opacity-40" title="Open each pattern's camera and show which lens it resolves to">{cameraTesting ? '…' : 'Test'}</button>
            </div>
            {#if cameraProbes.length > 0}
              <div class="rounded bg-white/[0.05] px-2 py-1.5 text-[11px]">
                <div class="mb-1 {cameraProbeStatus === 'mismatch' ? 'text-amber-400' : cameraProbeStatus === 'error' ? 'text-white/50' : 'text-emerald-400/80'}">
                  {cameraProbeStatus === 'mismatch' ? '⚠ Patterns resolve to different cameras:' : cameraProbeStatus === 'error' ? 'Camera test results:' : '✓ All patterns use the same camera:'}
                </div>
                {#each cameraProbes as p}
                  <div class="flex justify-between gap-2 text-white/60">
                    <span class="shrink-0">{p.name}</span>
                    <span class="min-w-0 truncate text-right text-white/80">{p.error ? '⚠ ' + p.error : `${p.label} · ${p.width}×${p.height}`}</span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if audioState.enabled}
              <div class="flex items-center gap-2">
                <span class="w-14 shrink-0 text-[11px] text-white/40">Mic</span>
                {#if audioState.devices.length >= 1}
                  <select
                    value={audioState.devices.findIndex(d => d.deviceId === audioState.deviceId)}
                    onchange={(e) => { const i = parseInt((e.target as HTMLSelectElement).value); audioState.deviceId = audioState.devices[i]?.deviceId ?? ''; }}
                    class="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
                  >
                    {#each audioState.devices as d, i}
                      <option value={i}>{d.label}</option>
                    {/each}
                  </select>
                {:else}
                  <span class="min-w-0 flex-1 text-xs text-white/30">No microphones found</span>
                {/if}
                <button onclick={() => enumerateMicrophones()} class="shrink-0 text-[11px] text-white/30 hover:text-white/60 transition-colors cursor-pointer" title="Re-detect microphones">↺</button>
              </div>
            {/if}
        </div>
      </div>

      <!-- Toggles: hide HUD + randomize order -->
      <div class="mb-4 flex flex-col gap-2.5">
        <div class="flex items-center justify-between text-xs text-white/70">
          <span>Hide HUD in Demo Mode</span>
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="relative h-[18px] w-7 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {demoHideHud ? 'bg-white/70' : 'bg-white/20'}"
            onclick={() => { demoHideHud = !demoHideHud; localStorage.setItem(DEMO_HIDE_HUD_KEY, String(demoHideHud)); }}
          >
            <div class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 {demoHideHud ? 'translate-x-[11px]' : 'translate-x-[2px]'}"></div>
          </div>
        </div>
        <div class="flex items-center justify-between text-xs text-white/70">
          <span>Randomize order of patterns</span>
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="relative h-[18px] w-7 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {demoRandomizeOrder ? 'bg-white/70' : 'bg-white/20'}"
            onclick={() => { demoRandomizeOrder = !demoRandomizeOrder; saveDemoSettings(demoActive, demoDwell, pedalDwell, [...demoPatternIds], demoStartBehavior, demoRandomizeOrder, demoFavoritesOnly); }}
          >
            <div class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 {demoRandomizeOrder ? 'translate-x-[11px]' : 'translate-x-[2px]'}"></div>
          </div>
        </div>
      </div>

      <!-- Pattern start behavior selector -->
      <div class="mb-4">
        <div class="mb-1.5 text-[10px] uppercase tracking-widest text-white/40">Pattern Start</div>
        <div class="flex flex-wrap gap-1">
          {#each ([['default','Default'],['slot1','Chilled 1'],['slot2','Balanced 2'],['slot3','Active 3'],['random','Random']] as const) as [val, label]}
            <button
              class="rounded-full border px-2.5 py-0.5 text-[11px] transition-colors cursor-pointer {demoStartBehavior === val ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/50 hover:border-white/30'}"
              onclick={() => {
                demoStartBehavior = val;
                if (val === 'slot1' || val === 'slot2' || val === 'slot3') {
                  demoFavoritesOnly = true;
                }
                saveDemoSettings(demoActive, demoDwell, pedalDwell, [...demoPatternIds], demoStartBehavior, demoRandomizeOrder, demoFavoritesOnly);
              }}
            >{label}</button>
          {/each}
        </div>
      </div>

      <!-- Favorites filter -->
      <div class="mb-3 flex gap-2">
        <button
          class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer {!demoFavoritesOnly ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/50 hover:border-white/30'}"
          onclick={() => { demoFavoritesOnly = false; saveDemoSettings(demoActive, demoDwell, pedalDwell, [...demoPatternIds], demoStartBehavior, demoRandomizeOrder, false); }}
        >All</button>
        <button
          class="rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer {demoFavoritesOnly ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 text-white/50 hover:border-white/30'}"
          onclick={() => {
            demoFavoritesOnly = true;
            applyDemoPatternIds(new Set([...demoPatternIds].filter(id => favorites.has(id))));
            saveDemoSettings(demoActive, demoDwell, pedalDwell, [...demoPatternIds], demoStartBehavior, demoRandomizeOrder, true);
          }}
        >★ Favorites</button>
      </div>

      <!-- Pattern list — 2-col on sm+, 1-col on mobile.
           No inner scroll: the whole modal scrolls as one area via the backdrop. -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-0.5 pr-1">
        {#each DEMO_GROUPS as group}
          {@const visiblePatterns = patterns.filter(p =>
            (group.ids as readonly string[]).includes(p.id) &&
            (!demoFavoritesOnly || favorites.has(p.id)) &&
            (group.label !== 'Experimental' || experimentalEnabled)
          )}
          {#if visiblePatterns.length > 0}
            {@const allOn  = _demoPatternTick >= 0 && (group.ids as readonly string[]).every(id => demoPatternIds.has(id))}
            {@const someOn = _demoPatternTick >= 0 && !allOn && (group.ids as readonly string[]).some(id => demoPatternIds.has(id))}
            <!-- Group header with select-all checkbox -->
            <div class="col-span-1 sm:col-span-2 mt-2 mb-0.5 flex items-center gap-2">
              <div class="h-px flex-1 bg-white/20"></div>
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <div class="flex items-center gap-1.5 cursor-pointer group/hdr"
                onclick={() => {
                  const ids = group.ids as readonly string[];
                  const next = new Set(demoPatternIds);
                  const currentlyAllOn = ids.every(id => next.has(id));
                  if (currentlyAllOn) { ids.forEach(id => next.delete(id)); }
                  else               { ids.forEach(id => next.add(id)); }
                  applyDemoPatternIds(next);
                }}
              >
                <div class="h-3 w-3 rounded-sm border flex items-center justify-center transition-colors
                  {allOn ? 'border-white/50 bg-white/30' : someOn ? 'border-white/30 bg-white/10' : 'border-white/20'}">
                  {#if allOn}<span class="text-[8px] leading-none text-white">✓</span>{/if}
                  {#if someOn}<span class="text-[8px] leading-none text-white/60">–</span>{/if}
                </div>
                <span class="text-[10px] uppercase tracking-widest text-white/40 group-hover/hdr:text-white/60 transition-colors">{group.label}</span>
              </div>
              <div class="h-px flex-1 bg-white/20"></div>
            </div>

            {#each visiblePatterns as p}
              {@const enabled = _demoPatternTick >= 0 && demoPatternIds.has(p.id)}
              <button
                class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors cursor-pointer
                  {enabled ? 'text-white/80 hover:bg-white/10' : 'text-white/25 hover:bg-white/5'}"
                onclick={() => {
                  const next = new Set(demoPatternIds);
                  if (enabled) { next.delete(p.id); } else { next.add(p.id); }
                  applyDemoPatternIds(next);
                }}
              >
                <span class="shrink-0 font-mono text-[10px] {enabled ? 'text-white/30' : 'text-white/15'}">{patterns.indexOf(p) + 1}</span>
                <span class="flex-1 leading-snug">{p.name}</span>
                {#if enabled}<span class="shrink-0 h-1.5 w-1.5 rounded-full bg-white/50"></span>{/if}
              </button>
            {/each}
          {/if}
        {/each}
      </div>
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
    inert={!hudVisible || overlayHidden}
    onpointerdown={() => poke()}
    class="pointer-events-auto fixed bottom-4 right-4 z-10 select-none transition-opacity duration-500 min-w-48 overflow-auto"
    style="max-height: {isTouch ? `calc(100dvh - ${hudPanelHeight + 40}px)` : 'calc(100dvh - 2rem)'}"
    class:opacity-0={!hudVisible || overlayHidden}
    class:opacity-100={hudVisible && !overlayHidden}
  >
    <div class="flex flex-col rounded-md border border-white/10 bg-black/60 px-4 py-3 text-white backdrop-blur-sm">
      {#if patterns[index].controls?.length}
        {@const controlMeta = (() => {
          let sectionOn = true;
          let currentSection: string | null = null;
          return (patterns[index].controls ?? []).map(ctrl => {
            if (ctrl.type === 'section') {
              sectionOn = !!(ctrlVals[ctrl.label] ?? 0);
              currentSection = ctrl.label;
            } else if (ctrl.type === 'separator') {
              // A separator always ends the current section scope
              currentSection = null;
              sectionOn = true;
            }
            const groupDisabled = !sectionOn && ctrl.type !== 'section' && ctrl.type !== 'separator';
            const inSection = (ctrl.type !== 'section' && ctrl.type !== 'separator') ? currentSection : null;
            const hidden = inSection !== null && collapsedSections.has(inSection);
            // Skip controls that belong to the Interactive section (camera toggles, select, etc.)
            const isInteractive = !!(ctrl as any).interactive;
            return { ctrl, groupDisabled, hidden, isInteractive };
          });
        })()}
        <!-- Pattern controls header -->
        <div class="mb-2 shrink-0 flex items-center justify-between gap-2">
          <span class="text-xs uppercase tracking-widest text-white/50">Controls</span>
          <div class="flex gap-1">
            <button onclick={applyUndo} class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer">Undo</button>
            <button onclick={resetAllControls} class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer">Default</button>
            <button onclick={() => { startRandomize(performance.now()); }} class="rounded px-2 py-0.5 text-[10px] text-white/50 border border-white/15 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer">Randomize</button>
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

        <!-- ── Pattern group (collapsable, no toggle) ────────────────────── -->
        <div class="mt-1 flex items-center gap-2">
          <div class="h-px flex-1 bg-white/20"></div>
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <span
            class="text-[10px] uppercase tracking-widest text-white/40 hover:text-white/60 transition-colors cursor-pointer flex items-center gap-1 select-none"
            onclick={() => {
              patternGroupCollapsed = !patternGroupCollapsed;
              _perPatternGroupCollapsed.set(patterns[index].id, patternGroupCollapsed);
            }}
          >Pattern <span class="text-[8px] transition-transform duration-200 {patternGroupCollapsed ? '' : 'rotate-180 inline-block'}" style="display:inline-block">▼</span></span>
          <div class="h-px flex-1 bg-white/20"></div>
        </div>

        {#if !patternGroupCollapsed}
        <div class="flex flex-col gap-2.5">
          {#each controlMeta as { ctrl, groupDisabled, hidden, isInteractive }}
            {#if isInteractive}{:else}
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
              <!-- Section header: click label to collapse/expand, mini toggle enables/disables -->
              <div class="mt-1 flex items-center gap-2">
                <div class="h-px flex-1 bg-white/20"></div>
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <span
                  class="text-[10px] uppercase tracking-widest text-white/40 flex items-center gap-1 select-none cursor-pointer hover:text-white/60 transition-colors"
                  onclick={() => {
                    const next = new Set(collapsedSections);
                    if (isCollapsed) next.delete(ctrl.label); else next.add(ctrl.label);
                    collapsedSections = next;
                    _perPatternCollapsed.set(patterns[index].id, next);
                  }}
                >{ctrl.label} <span class="text-[8px]">{isCollapsed ? '▶' : '▼'}</span></span>
                {#if !(ctrl as any).collapsible}
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div
                  class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {isOn ? 'bg-white/60' : 'bg-white/20'}"
                  onclick={() => { const nv = !ctrl.get(); ctrl.set(nv); ctrlVals[ctrl.label] = nv ? 1 : 0; saveSettings(patterns); }}
                >
                  <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {isOn ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
                </div>
                {/if}
                <div class="h-px flex-1 bg-white/20"></div>
              </div>
            {:else if !hidden && ctrl.type === "toggle" && !(ctrl as any).linkedTo}
              {@const isOn = !!(ctrlVals[ctrl.label] ?? 0)}
              <!-- Standalone toggle row -->
              <div title={(ctrl as any).title ?? ''} class="flex items-center justify-between text-xs text-white/70 transition-opacity duration-200 {groupDisabled ? 'opacity-35 pointer-events-none' : ''}">
                <span class="flex items-center gap-1.5">
                  {ctrl.label}
                  {#if ctrl.label === 'Burst' && cameraState.burst > 0}
                    <span class="inline-block h-2 w-2 rounded-full" style="background: rgba(250,204,21,{Math.min(1, cameraState.burst / 100)})"></span>
                  {/if}
                </span>
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
                  {#if (ctrl as any).exp}
                    <span class="text-[9px] text-white/30 border border-white/20 rounded px-1 py-0.5">exp.</span>
                  {/if}
                  {#if ctrl.type === "range"}
                    {@const linkedToggle = (patterns[index].controls ?? []).find(c => c.type === 'toggle' && (c as any).linkedTo === ctrl.label) as (PatternControl & { type: 'toggle' }) | undefined}
                    {#if linkedToggle}
                      {@const isLinkedOn = !!(ctrlVals[linkedToggle.label] ?? linkedToggle.get())}
                      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                      <div class="flex items-center gap-1 ml-1 mr-auto" title={linkedToggle.title ?? linkedToggle.label}>
                        <span class="text-[10px] text-white/30">{linkedToggle.label}</span>
                        <div
                          class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {isLinkedOn ? 'bg-white/60' : 'bg-white/20'}"
                          onclick={() => { const nv = !linkedToggle.get(); linkedToggle.set(nv); ctrlVals[linkedToggle.label] = nv ? 1 : 0; saveSettings(patterns); }}
                        >
                          <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {isLinkedOn ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
                        </div>
                      </div>
                    {/if}
                  {/if}
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
                      onpointerdown={ctrl.readonly ? undefined : () => {
                        draggingLabel = ctrl.label;
                      }}
                      onpointerup={ctrl.readonly ? undefined : (e) => {
                        const v = parseFloat((e.target as HTMLInputElement).value);
                        ctrl.set(v);
                        ctrlVals[ctrl.label] = v;
                        saveSettings(patterns);
                        requestAnimationFrame(() => { draggingLabel = null; });
                      }}
                      onpointercancel={ctrl.readonly ? undefined : () => {
                        requestAnimationFrame(() => { draggingLabel = null; });
                      }}
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
                  {@const hexVal = String(ctrlVals[ctrl.label] ?? ctrl.get())}
                  <div class="flex items-center gap-2">
                    <input
                      type="color"
                      value={hexVal}
                      oninput={(e) => {
                        const v = (e.target as HTMLInputElement).value;
                        ctrl.set(v); ctrlVals[ctrl.label] = v; saveSettings(patterns);
                      }}
                      class="h-7 w-10 shrink-0 cursor-pointer rounded border border-white/20 bg-transparent p-0.5"
                    />
                    <input
                      type="text"
                      value={hexVal}
                      placeholder="#rrggbb"
                      oninput={(e) => {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                          ctrl.set(v); ctrlVals[ctrl.label] = v; saveSettings(patterns);
                        }
                      }}
                      class="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 font-mono text-xs text-white outline-none placeholder-white/30 focus:bg-white/15"
                    />
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
            {/if}
          {/each}
        </div>
        {/if}
        <!-- C2 global colour controls -->
          <div class="mt-1 flex items-center gap-2">
            <div class="h-px flex-1 bg-white/20"></div>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <span
              class="text-[10px] uppercase tracking-widest text-white/40 cursor-pointer hover:text-white/70 select-none transition-colors"
              onclick={() => { colourCollapsed = !colourCollapsed; _perPatternColourCollapsed.set(patterns[index].id, colourCollapsed); }}
            >Colour <span class="text-[8px] transition-transform duration-200 {colourCollapsed ? '' : 'rotate-180 inline-block'}" style="display:inline-block">▼</span></span>
            <div class="h-px flex-1 bg-white/20"></div>
          </div>
          {#if !colourCollapsed}
            <!-- Apply Colors toggle -->
            <div class="mt-1 flex items-center justify-between">
              <span class="text-xs text-white/70 select-none">Apply Colors</span>
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <div class="relative h-[18px] w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-200 {colorShuffle.enabled ? 'bg-white/70' : 'bg-white/20'}"
                onclick={() => { colorShuffle.enabled = !colorShuffle.enabled; savePatternColor(patterns[index].id); }}>
                <div class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 {colorShuffle.enabled ? 'translate-x-[11px]' : 'translate-x-[2px]'}"></div>
              </div>
            </div>
            <!-- Color Shuffle (only when enabled) -->
            {#if colorShuffle.enabled}
              <button
                onclick={doColorShuffle}
                class="mt-1.5 w-full rounded bg-white/10 px-2 py-1.5 text-xs text-white/70 cursor-pointer hover:bg-white/20 hover:text-white active:bg-white/30 transition-colors"
              >⟳ Color Shuffle</button>
            {/if}
            <!-- Colors v2 + Brightness -->
            <div class="mt-1 flex flex-col gap-0.5">
              <div class="flex items-center justify-between">
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <span class="text-xs text-white/70 cursor-pointer hover:text-white transition-colors select-none"
                  onclick={() => { colorC2.colorsV2 = 3.0; saveColorC2(); }}
                  title="Click to reset"
                >Colors</span>
                <span class="text-xs text-white/50">{colorC2.colorsV2.toFixed(1)}</span>
              </div>
              <input type="range" min={0} max={3} step={0.1}
                value={colorC2.colorsV2}
                oninput={(e) => { colorC2.colorsV2 = parseFloat((e.target as HTMLInputElement).value); saveColorC2(); }}
                class="w-full accent-white cursor-pointer" />
            </div>
            <div class="mt-1 flex flex-col gap-0.5">
              <div class="flex items-center justify-between">
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <span class="text-xs text-white/70 cursor-pointer hover:text-white transition-colors select-none"
                  onclick={() => { colorShuffle.brightness = 1.0; savePatternColor(patterns[index].id); }}
                  title="Click to reset"
                >Brightness</span>
                <span class="text-xs text-white/50 flex items-center gap-1">
                  {colorShuffle.brightness.toFixed(2)}
                  {#if Math.abs(interactionState.brightnessMult - 1.0) > 0.02}
                    <span class="text-white/30">×{interactionState.brightnessMult.toFixed(2)}</span>
                  {/if}
                </span>
              </div>
              <input type="range" min={0.75} max={2} step={0.05}
                value={colorShuffle.brightness}
                oninput={(e) => { colorShuffle.brightness = parseFloat((e.target as HTMLInputElement).value); savePatternColor(patterns[index].id); }}
                class="w-full accent-white cursor-pointer" />
            </div>
          {/if}

        <!-- ── Interactive section ─────────────────────────────────────── -->
        {#if patternIsInteractive}
          <div class="mt-1 flex items-center gap-2">
            <div class="h-px flex-1 bg-white/20"></div>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <span
              class="text-[10px] uppercase tracking-widest text-white/40 hover:text-white/60 transition-colors cursor-pointer flex items-center gap-1 select-none"
              onclick={() => {
                interactiveCollapsed = !interactiveCollapsed;
                _perPatternInteractiveCollapsed.set(patterns[index].id, interactiveCollapsed);
              }}
            >Interactive <span class="text-[8px] transition-transform duration-200 {interactiveCollapsed ? '' : 'rotate-180 inline-block'}" style="display:inline-block">▼</span></span>
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="relative h-[14px] w-[22px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {interactiveOn ? 'bg-white/60' : 'bg-white/20'}"
              onclick={() => {
                interactiveOn = !interactiveOn;
                if (interactiveOn) {
                  interactiveCollapsed = false;
                  _perPatternInteractiveCollapsed.set(patterns[index].id, false);
                  // Restart camera for patterns where it is the primary content
                  if (patterns[index].requiresCamera && !privacyMode.active) {
                    cameraState.enabled = true;
                  }
                }
                _perPatternInteractiveOn.set(patterns[index].id, interactiveOn);
                if (!interactiveOn) {
                  cameraState.motionEnabled = false;
                  cameraState.enabled = false;
                  audioState.enabled = false;
                  if (poseActive) { stopPoseTracking(); poseActive = false; poseError = null; }
                  // Turn off per-pattern camera toggles (e.g. Light Trail / Light Paint)
                  for (const c of (patterns[index].controls ?? [])) {
                    if (c.type === 'toggle' && (c as any).interactive === 'camera') {
                      (c as import('./lib/patterns/types').PatternControl & { type: 'toggle' }).set(false);
                      ctrlVals[c.label] = 0;
                    }
                  }
                  saveSettings(patterns);
                }
              }}
            >
              <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {interactiveOn ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
            </div>
            <div class="h-px flex-1 bg-white/20"></div>
          </div>

          {#if !interactiveCollapsed}
            <div class="flex flex-col gap-2.5 mt-1 transition-opacity duration-200 {interactiveOn ? '' : 'opacity-40 pointer-events-none'}">

              {#if privacyMode.active}
                <div class="flex items-center gap-1.5 rounded border border-purple-500/30 bg-purple-900/40 px-2 py-1.5 text-[11px] text-purple-300">
                  <span>⊘</span><span>Sensors blocked by Sensor Block</span>
                </div>
              {/if}

              <!-- Camera section -->
              {#if patterns[index].motionReactive || patterns[index].usesPose || patterns[index].usesCameraBlend}
                <div class="{privacyMode.active ? 'opacity-40 pointer-events-none' : ''}">
                  <div class="mb-1 text-xs text-white/70">Camera</div>
                  {#if patterns[index].usesCameraBlend}
                    <!-- Light-painting patterns: render interactive:'camera' controls from pattern -->
                    {@const camControls = (patterns[index].controls ?? []).filter(c => (c as any).interactive === 'camera')}
                    <div class="flex flex-col gap-2">
                      {#each camControls as ctrl}
                        {#if ctrl.type === 'toggle'}
                          {@const isOn = !!(ctrlVals[ctrl.label] ?? ctrl.get())}
                          <div class="flex items-center justify-between text-xs text-white/70">
                            <span>{ctrl.label}</span>
                            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                            <div
                              class="relative h-[18px] w-7 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {isOn ? 'bg-white/70' : 'bg-white/20'}"
                              onclick={() => { const nv = !ctrl.get(); ctrl.set(nv); ctrlVals[ctrl.label] = nv ? 1 : 0; saveSettings(patterns); }}
                            >
                              <div class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 {isOn ? 'translate-x-[11px]' : 'translate-x-[2px]'}"></div>
                            </div>
                          </div>
                        {:else if ctrl.type === 'select'}
                          {@const opts = typeof ctrl.options === 'function' ? ctrl.options() : ctrl.options}
                          {#if opts.length > 1}
                            <select
                              value={ctrlVals[ctrl.label] ?? ctrl.get()}
                              onchange={(e) => { const v = parseInt((e.target as HTMLSelectElement).value); ctrl.set(v); ctrlVals[ctrl.label] = v; saveSettings(patterns); }}
                              class="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
                            >
                              {#each opts as opt, i}
                                <option value={i}>{opt}</option>
                              {/each}
                            </select>
                          {/if}
                        {:else if ctrl.type === 'range'}
                          <div>
                            <div class="flex justify-between mb-1 text-xs text-white/70">
                              <span>{ctrl.label}</span>
                              <span class="font-mono text-white/40">{Number(ctrlVals[ctrl.label] ?? ctrl.get()).toFixed(ctrl.step < 0.1 ? 2 : ctrl.step < 1 ? 1 : 0)}</span>
                            </div>
                            <input type="range" min={ctrl.min} max={ctrl.max} step={ctrl.step}
                              value={ctrlVals[ctrl.label] ?? ctrl.get()}
                              oninput={(e) => { const v = parseFloat((e.target as HTMLInputElement).value); ctrl.set(v); ctrlVals[ctrl.label] = v; }}
                              onchange={() => saveSettings(patterns)}
                              class="w-full accent-white cursor-pointer" />
                          </div>
                        {/if}
                      {/each}
                      <!-- Detect + Test, matching the motion/pose picker below -->
                      <div class="flex items-center justify-end gap-2">
                        <button onclick={() => detectCameras()} class="shrink-0 text-[11px] text-white/30 hover:text-white/60 transition-colors cursor-pointer" title="Detect cameras">↺</button>
                        <button onclick={() => runCameraTest()} disabled={cameraTesting} class="shrink-0 rounded border border-white/15 px-2 py-0.5 text-[11px] text-white/50 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer disabled:opacity-40" title="Open each pattern's camera and show which lens it resolves to">{cameraTesting ? '…' : 'Test'}</button>
                      </div>
                      {#if cameraProbes.length > 0}
                        <div class="rounded bg-white/[0.05] px-2 py-1.5 text-[11px]">
                          <div class="mb-1 {cameraProbeStatus === 'mismatch' ? 'text-amber-400' : cameraProbeStatus === 'error' ? 'text-white/50' : 'text-emerald-400/80'}">
                            {cameraProbeStatus === 'mismatch' ? '⚠ Patterns resolve to different cameras:' : cameraProbeStatus === 'error' ? 'Camera test results:' : '✓ All patterns use the same camera:'}
                          </div>
                          {#each cameraProbes as p}
                            <div class="flex justify-between gap-2 text-white/60">
                              <span class="shrink-0">{p.name}</span>
                              <span class="min-w-0 truncate text-right text-white/80">{p.error ? '⚠ ' + p.error : `${p.label} · ${p.width}×${p.height}`}</span>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {:else}
                    <!-- Motion/pose patterns: global motion camera picker -->
                    {#if getVisibleDevices().length > 0}
                      <div class="flex items-center gap-2">
                        <select
                          value={getVisibleDevices().findIndex(d => d.deviceId === cameraState.deviceId)}
                          onchange={(e) => {
                            const i = parseInt((e.target as HTMLSelectElement).value);
                            cameraState.deviceId = getVisibleDevices()[i]?.deviceId ?? '';
                            saveCameraDevice();
                          }}
                          class="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
                        >
                          {#each getVisibleDevices() as d, i}
                            <option value={i}>{d.label}</option>
                          {/each}
                        </select>
                        <button onclick={() => detectCameras()} class="shrink-0 text-[11px] text-white/30 hover:text-white/60 transition-colors cursor-pointer" title="Detect cameras">↺</button>
                        <button onclick={() => runCameraTest()} disabled={cameraTesting} class="shrink-0 rounded border border-white/15 px-2 py-0.5 text-[11px] text-white/50 hover:border-white/40 hover:text-white/80 transition-colors cursor-pointer disabled:opacity-40" title="Open each pattern's camera and show which lens it resolves to">{cameraTesting ? '…' : 'Test'}</button>
                      </div>
                      {#if cameraProbes.length > 0}
                        <div class="mt-2 rounded bg-white/[0.05] px-2 py-1.5 text-[11px]">
                          <div class="mb-1 {cameraProbeStatus === 'mismatch' ? 'text-amber-400' : cameraProbeStatus === 'error' ? 'text-white/50' : 'text-emerald-400/80'}">
                            {cameraProbeStatus === 'mismatch' ? '⚠ Patterns resolve to different cameras:' : cameraProbeStatus === 'error' ? 'Camera test results:' : '✓ All patterns use the same camera:'}
                          </div>
                          {#each cameraProbes as p}
                            <div class="flex justify-between gap-2 text-white/60">
                              <span class="shrink-0">{p.name}</span>
                              <span class="min-w-0 truncate text-right text-white/80">{p.error ? '⚠ ' + p.error : `${p.label} · ${p.width}×${p.height}`}</span>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    {:else}
                      <button
                        onclick={() => enumerateCameras()}
                        class="text-xs text-white/40 hover:text-white/70 transition-colors cursor-pointer"
                      >Detect cameras</button>
                    {/if}
                  {/if}
                </div>
              {/if}

              <!-- Motion Detection -->
              {#if patterns[index].motionReactive}
                <div class="{privacyMode.active ? 'opacity-40 pointer-events-none' : ''} flex items-center justify-between text-xs text-white/70">
                  <span class="flex items-center gap-1.5">Motion Detection <span class="text-[9px] text-white/30 border border-white/20 rounded px-1 py-0.5">exp.</span></span>
                  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                  <div
                    class="relative h-[18px] w-7 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {cameraState.enabled && cameraState.motionEnabled ? 'bg-white/70' : 'bg-white/20'}"
                    onclick={() => {
                      const isOn = cameraState.enabled && cameraState.motionEnabled;
                      const next = !isOn;
                      cameraState.motionEnabled = next;
                      if (next && !cameraState.enabled) { cameraState.enabled = true; enumerateCameras(); }
                    }}
                  >
                    <div class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 {cameraState.enabled && cameraState.motionEnabled ? 'translate-x-[11px]' : 'translate-x-[2px]'}"></div>
                  </div>
                </div>
                {#if cameraState.enabled && cameraState.motionEnabled}
                  <div class="flex flex-col gap-1.5 pl-1">
                    <div>
                      <div class="flex justify-between mb-1 text-xs text-white/70">
                        <span>Sensitivity</span>
                        <span class="font-mono text-white/40">{cameraState.sensitivity}</span>
                      </div>
                      <input type="range" min={0} max={100} step={1} bind:value={cameraState.sensitivity}
                        class="w-full accent-white cursor-pointer" />
                    </div>
                    <div>
                      <div class="flex justify-between mb-1 text-xs text-white/70">
                        <span>Level</span>
                        <span class="font-mono text-white/40">{cameraState.level}</span>
                      </div>
                      <input type="range" min={0} max={100} step={1} value={cameraState.level}
                        class="w-full accent-white pointer-events-none" />
                    </div>
                  </div>
                {/if}
              {/if}

              <!-- Pose -->
              {#if patterns[index].usesPose}
                <div class="flex items-center justify-between text-xs text-white/70">
                  <span class="flex items-center gap-1.5">
                    Pose
                    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                    <span class="cursor-pointer select-none transition-colors {poseDebug ? 'text-white/70' : 'text-white/25 hover:text-white/50'}"
                      onclick={() => { poseDebug = !poseDebug; }}
                      title="Show pose skeleton overlay"
                    >⬡</span>
                  </span>
                  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                  <div
                    class="relative h-[18px] w-7 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {poseActive ? 'bg-white/70' : 'bg-white/20'}"
                    onclick={togglePoseTracking}
                  >
                    <div class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 {poseActive ? 'translate-x-[11px]' : 'translate-x-[2px]'}"></div>
                  </div>
                </div>
                {#if poseLoading}
                  <div class="text-xs text-white/40">⟳ Loading pose model…</div>
                {:else if poseError}
                  <div class="text-xs text-red-400/80">{poseError}</div>
                {:else if poseActive && posePersonCount > 0}
                  <div class="text-xs text-green-400/70">◉ {posePersonCount} person{posePersonCount > 1 ? 's' : ''} detected</div>
                {/if}
                <!-- Pose performance options -->
                <div class="flex flex-col gap-1.5 pt-0.5">
                  <div class="text-xs text-white/50">Performance (slower machines)</div>
                  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                  <div class="flex items-center gap-2 cursor-pointer" title="Half video resolution — reduces GPU load, requires restart"
                    onclick={async () => {
                      poseLowRes = !poseLowRes;
                      poseSettings.lowRes = poseLowRes;
                      if (poseActive) { stopPoseTracking(); poseActive = false; poseError = null; poseLoading = true; try { const devId = cameraState.deviceId || undefined; await startPoseTracking(devId); _poseDeviceId = devId ?? ''; poseActive = true; } catch(e) { poseError = e instanceof Error ? e.message : 'error'; } finally { poseLoading = false; } }
                    }}>
                    <div class="relative h-[14px] w-[22px] flex-shrink-0 rounded-full transition-colors duration-200 {poseLowRes ? 'bg-white/60' : 'bg-white/20'}">
                      <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {poseLowRes ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
                    </div>
                    <span class="text-xs text-white/70">Low Res (320×240)</span>
                  </div>
                  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                  <div class="flex items-center gap-2 cursor-pointer" title="Run pose inference every 2nd frame"
                    onclick={() => { poseSkipFrames = !poseSkipFrames; poseSettings.skipFrames = poseSkipFrames; }}>
                    <div class="relative h-[14px] w-[22px] flex-shrink-0 rounded-full transition-colors duration-200 {poseSkipFrames ? 'bg-white/60' : 'bg-white/20'}">
                      <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {poseSkipFrames ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
                    </div>
                    <span class="text-xs text-white/70">Skip Frames (every 2nd)</span>
                  </div>
                </div>
                {#if poseActive}
                  {@const poseControls = (patterns[index].controls ?? []).filter(c => c.type === 'range' && (c as any).interactive === 'pose')}
                  {#each poseControls as ctrl}
                    {@const c = ctrl as (typeof ctrl & { type: 'range' })}
                    <div class="flex flex-col gap-1">
                      <div class="flex justify-between text-xs text-white/70">
                        <span class="cursor-pointer hover:text-white transition-colors select-none"
                          onclick={() => { if (c.default !== undefined) { c.set(c.default); ctrlVals[c.label] = c.default; saveSettings(patterns); } }}
                          title="Click to reset"
                        >{c.label}</span>
                        <span class="font-mono text-white/40">{Number(ctrlVals[c.label] ?? c.get()).toFixed(c.step < 0.1 ? 2 : c.step < 1 ? 1 : 0)}</span>
                      </div>
                      <input type="range" min={c.min} max={c.max} step={c.step}
                        value={ctrlVals[c.label] ?? c.get()}
                        oninput={(e) => { const v = parseFloat((e.target as HTMLInputElement).value); c.set(v); ctrlVals[c.label] = v; saveSettings(patterns); }}
                        class="w-full accent-white cursor-pointer" />
                    </div>
                  {/each}
                {/if}
              {/if}

              <!-- Audio Reactivity -->
              {#if patterns[index].audioReactive}
                <div class="{privacyMode.active ? 'opacity-40 pointer-events-none' : ''}">
                <div class="flex items-center justify-between text-xs text-white/70">
                  <span class="flex items-center gap-1.5">Audio <span class="text-[9px] text-white/30 border border-white/20 rounded px-1 py-0.5">exp.</span></span>
                  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                  <div
                    class="relative h-[18px] w-7 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 {audioState.enabled ? 'bg-white/70' : 'bg-white/20'}"
                    onclick={() => { audioState.enabled = !audioState.enabled; if (audioState.enabled) enumerateMicrophones(); }}
                  >
                    <div class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 {audioState.enabled ? 'translate-x-[11px]' : 'translate-x-[2px]'}"></div>
                  </div>
                </div>
                {#if audioState.enabled}
                  <div class="flex flex-col gap-1.5 pl-1">
                    <div>
                      <div class="mb-1 text-xs text-white/70">Microphone</div>
                      {#if audioState.devices.length > 0}
                        <select
                          value={audioState.devices.findIndex(d => d.deviceId === audioState.deviceId)}
                          onchange={(e) => { const i = parseInt((e.target as HTMLSelectElement).value); audioState.deviceId = audioState.devices[i]?.deviceId ?? ''; }}
                          class="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
                        >
                          {#each audioState.devices as d, i}
                            <option value={i}>{d.label}</option>
                          {/each}
                        </select>
                      {:else}
                        <div class="text-xs text-white/30">No microphones found</div>
                      {/if}
                    </div>
                    <div>
                      <div class="flex justify-between mb-1 text-xs text-white/70">
                        <span>Sensitivity</span>
                        <span class="font-mono text-white/40">{audioState.sensitivity}</span>
                      </div>
                      <input type="range" min={0} max={100} step={1} bind:value={audioState.sensitivity}
                        class="w-full accent-white cursor-pointer" />
                    </div>
                    <div>
                      <div class="flex justify-between mb-1 text-xs text-white/70">
                        <span>Noise Gate <span class="text-white/30 text-[10px]">silence floor</span></span>
                        <span class="font-mono text-white/40">{audioState.noiseGate}</span>
                      </div>
                      <input type="range" min={0} max={60} step={1} bind:value={audioState.noiseGate}
                        class="w-full accent-white cursor-pointer" />
                    </div>
                    <div>
                      <div class="mb-1 text-xs text-white/70">Frequency Band</div>
                      <select
                        value={audioState.bandIndex}
                        onchange={(e) => { audioState.bandIndex = parseInt((e.target as HTMLSelectElement).value); }}
                        class="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
                      >
                        {#each AUDIO_BAND_OPTIONS as band, i}
                          <option value={i}>{band}</option>
                        {/each}
                      </select>
                    </div>
                    <div>
                      <div class="flex justify-between mb-1 text-xs text-white/70">
                        <span>Level <span class="text-white/30 text-[10px]">(always active)</span></span>
                        <span class="font-mono text-white/40">{audioState.level}</span>
                      </div>
                      <input type="range" min={0} max={100} step={1} value={audioState.level}
                        class="w-full accent-white pointer-events-none" />
                    </div>
                    <div class="flex items-center gap-2 pt-0.5">
                      <label class="flex items-center gap-1.5 cursor-pointer select-none">
                        <input type="checkbox" bind:checked={audioState.beatMode}
                          class="accent-white cursor-pointer" />
                        <span class="text-xs {audioState.beatMode ? 'text-white/80' : 'text-white/40'}">
                          {audioState.beatMode ? 'Beat drives controls' : 'Level drives controls'}
                        </span>
                      </label>
                    </div>
                    <div class="flex flex-col gap-1.5 pt-0.5">
                      <div class="text-xs text-white/50">Beat detectors</div>
                      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                      <div class="flex items-center gap-2 cursor-pointer" onclick={() => { audioState.energyEnabled = !audioState.energyEnabled; }}>
                        <div class="relative h-[14px] w-[22px] flex-shrink-0 rounded-full transition-colors duration-200 {audioState.energyEnabled ? 'bg-white/60' : 'bg-white/20'}">
                          <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {audioState.energyEnabled ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
                        </div>
                        <span class="text-xs text-white/70 flex-1">Energy Ratio</span>
                        <div class="h-2 w-2 rounded-full flex-shrink-0 transition-none"
                          style="background: rgba(255,255,255,{audioState.energyBeat / 100})"></div>
                      </div>
                      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                      <div class="flex items-center gap-2 cursor-pointer" onclick={() => { audioState.fluxEnabled = !audioState.fluxEnabled; }}>
                        <div class="relative h-[14px] w-[22px] flex-shrink-0 rounded-full transition-colors duration-200 {audioState.fluxEnabled ? 'bg-white/60' : 'bg-white/20'}">
                          <div class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-transform duration-200 {audioState.fluxEnabled ? 'translate-x-[10px]' : 'translate-x-[2px]'}"></div>
                        </div>
                        <span class="text-xs text-white/70 flex-1">Spectral Flux</span>
                        <div class="h-2 w-2 rounded-full flex-shrink-0 transition-none"
                          style="background: rgba(255,255,255,{audioState.fluxBeat / 100})"></div>
                      </div>
                    </div>
                    <div>
                      <div class="flex justify-between mb-1 text-xs text-white/70">
                        <span>Beat Threshold</span>
                        <span class="font-mono text-white/40">{audioState.beatSensitivity.toFixed(1)}</span>
                      </div>
                      <input type="range" min={1.0} max={3.0} step={0.1}
                        bind:value={audioState.beatSensitivity}
                        class="w-full accent-white cursor-pointer" />
                    </div>
                  </div>
                {/if}
                </div><!-- /privacy wrapper -->
              {/if}

            </div>
          {/if}
        {/if}

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
    inert={!hudVisible || overlayHidden}
    bind:clientHeight={hudPanelHeight}
    class="pointer-events-none fixed top-4 left-4 z-10 select-none transition-opacity duration-500"
    class:opacity-0={!hudVisible || overlayHidden}
    class:opacity-100={hudVisible && !overlayHidden}
  >
    <div class="rounded-md border bg-black/60 px-4 py-3 text-white backdrop-blur-sm transition-colors duration-300 {privacyMode.active ? 'border-purple-500/40' : 'border-white/10'}">
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
          {/if}
          {#if Math.abs(interactionState.speedMult - 1.0) > 0.05}
            <div class="mt-0.5 text-xs font-mono text-blue-400/60">spd ×{interactionState.speedMult.toFixed(2)}</div>
          {/if}
          {#if isRecording}
            <div class="mt-1 text-xs font-mono text-red-400/90">● REC</div>
          {/if}
          {#if gamepadConnected}
            <div class="mt-1 text-xs text-white/30">⎮ Gamepad</div>
          {/if}
          {#if midiEnabled && midiConnected}
            <div class="mt-1 text-xs text-white/30">♪ MIDI</div>
          {/if}
          <!-- Sensor Block toggle -->
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="pointer-events-auto mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] cursor-pointer select-none transition-all duration-200
                   {privacyMode.active ? 'border-purple-500/50 bg-purple-900/50 text-purple-300' : 'border-white/15 text-white/30 hover:border-white/30 hover:text-white/50'}"
            title="Sensor Block — overrides all camera and audio inputs globally. Individual pattern settings are preserved and resume when Sensor Block is turned off."
            onclick={() => {
              if (!privacyMode.active) {
                // ── Activating Sensor Block — save state, stop everything ──
                _sbSavedCameraEnabled = cameraState.enabled;
                _sbSavedMotionEnabled = cameraState.motionEnabled;
                _sbSavedAudioEnabled  = audioState.enabled;
                _sbSavedPatternCams.clear();
                for (const c of (patterns[index].controls ?? [])) {
                  if (c.type === 'toggle' && (c as any).interactive === 'camera') {
                    _sbSavedPatternCams.set(c.label, c.get());
                    (c as import('./lib/patterns/types').PatternControl & { type: 'toggle' }).set(false);
                    ctrlVals[c.label] = 0;
                  }
                }
                cameraState.motionEnabled = false;
                cameraState.enabled = false;
                audioState.enabled = false;
                // Stop pose tracking (has its own camera stream)
                _sbSavedPoseActive = poseActive;
                if (poseActive) { stopPoseTracking(); poseActive = false; poseError = null; }
                privacyMode.active = true;
                // Hard-kill every registered stream immediately
                killAllStreams();
              } else {
                // ── Deactivating Sensor Block — restore saved state ──
                privacyMode.active = false;
                if (_sbSavedCameraEnabled) {
                  cameraState.motionEnabled = _sbSavedMotionEnabled;
                  cameraState.enabled = true;
                }
                if (_sbSavedAudioEnabled) {
                  audioState.enabled = true;
                  enumerateMicrophones();
                }
                for (const c of (patterns[index].controls ?? [])) {
                  if (c.type === 'toggle' && (c as any).interactive === 'camera') {
                    const wasOn = _sbSavedPatternCams.get(c.label) ?? false;
                    if (wasOn) {
                      (c as import('./lib/patterns/types').PatternControl & { type: 'toggle' }).set(true);
                      ctrlVals[c.label] = 1;
                    }
                  }
                }
              }
            }}
          >
            <span>⊘</span>
            <span>{privacyMode.active ? 'Sensor Block' : 'Sensor Block'}</span>
          </div>
          {#if !freezeAnim && Math.abs(timeScaleMirror - 1.0) > 0.05}
            <div
              class="mt-1 text-xs font-mono text-white/50 pointer-events-auto cursor-default"
              title="Global speed — adjust with ↑ ↓ keys or D-Pad"
            >Speed: {timeScaleMirror.toFixed(1)}x</div>
          {/if}
        </div>
        <div class="flex flex-col items-end gap-1.5">
          {#if isIosBrowser}
            <div class="mt-0.5 max-w-[140px] text-right text-[10px] leading-snug text-white/40">
              Tap <span class="text-white/60">Share ↑</span> → Add to Home Screen for fullscreen
            </div>
          {:else if !isIosStandalone}
            <button
              class="pointer-events-auto rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/15 active:bg-white/20"
              onclick={() => { fs.enter(document.documentElement); }}
              title="Toggle fullscreen (F)"
            >
              {isFullscreenState ? "Exit ⛶" : "⛶ Fullscreen (F)"}
            </button>
          {/if}
          <button
            class="pointer-events-auto rounded-md border px-3 py-1.5 text-xs transition-colors {demoActive ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 bg-white/[0.07] text-white/70 hover:border-white/40 hover:bg-white/15'} active:bg-white/20"
            onclick={() => { demoActive ? stopDemo() : demoVisible = true; }}
            title="Demo / kiosk mode (D)"
          >
            {demoActive ? "● Demo (D)" : "Demo (D)"}
          </button>
          <button
            class="pointer-events-auto rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/15 active:bg-white/20"
            onclick={() => { optionsVisible = true; }}
            title="Options (O)"
          >⚙ Options (O)</button>
          <button
            class="pointer-events-auto rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/15 active:bg-white/20"
            onclick={() => { cheatsheetVisible = true; }}
            title="About / Controls (M)"
          >? About (M)</button>
        </div>
      </div>
      <div class="mt-3 flex gap-1.5">
        <button
          class="pointer-events-auto flex-1 rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/15 active:bg-white/20 whitespace-nowrap min-w-[7rem]"
          onclick={() => { focusedIndex = index; appState = "overview"; }}
          title="Back to pattern grid"
        >
          ← Patterns
        </button>
        <button
          class="pointer-events-auto rounded-md border px-3 py-1.5 text-xs transition-colors {copiedLink ? 'border-green-400/50 bg-green-400/10 text-green-300' : 'border-white/15 bg-white/[0.07] text-white/70 hover:border-white/40 hover:bg-white/15'}"
          onclick={copyShare}
          title="Copy shareable link"
        >{#if copiedLink}✓ Copied!{:else}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 122.88 122.88" class="inline-block h-[1em] w-[1em] fill-current align-[-0.1em]"><path d="M60.54,34.07A7.65,7.65,0,0,1,49.72,23.25l13-12.95a35.38,35.38,0,0,1,49.91,0l.07.08a35.37,35.37,0,0,1-.07,49.83l-13,12.95A7.65,7.65,0,0,1,88.81,62.34l13-13a20.08,20.08,0,0,0,0-28.23l-.11-.11a20.08,20.08,0,0,0-28.2.07l-12.95,13Zm14,3.16A7.65,7.65,0,0,1,85.31,48.05L48.05,85.31A7.65,7.65,0,0,1,37.23,74.5L74.5,37.23ZM62.1,89.05A7.65,7.65,0,0,1,72.91,99.87l-12.7,12.71a35.37,35.37,0,0,1-49.76.14l-.28-.27a35.38,35.38,0,0,1,.13-49.78L23,50A7.65,7.65,0,1,1,33.83,60.78L21.12,73.49a20.09,20.09,0,0,0,0,28.25l0,0a20.07,20.07,0,0,0,28.27,0L62.1,89.05Z"/></svg>{/if}</button>
        {#if screenshotsEnabled}
          <button
            class="pointer-events-auto rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/15 active:bg-white/20"
            onclick={applyScreenshot}
            title="Screenshot  (S / L)"
          ><span class="text-sm leading-none">📷</span></button>
        {/if}
        {#if recordingsEnabled}
          <button
            class="pointer-events-auto rounded-md border px-3 py-1.5 text-xs transition-colors {isRecording ? 'border-red-400/50 bg-red-400/10 text-red-300' : 'border-white/15 bg-white/[0.07] text-white/70 hover:border-white/40 hover:bg-white/15'} active:bg-white/20"
            onclick={() => recorder?.toggle()}
            title="Record video  (V / 1)"
          ><span class="text-sm leading-none">{isRecording ? '⏹' : '⏺'}</span></button>
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
          <kbd class="rounded bg-white/10 px-1.5 font-mono">A</kbd>
          <span>reset controls</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">B</kbd>
          <span>randomize</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">X</kbd>
          <span>blackout</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">L</kbd>
          <span>screenshot</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">M</kbd>
          <span>all shortcuts</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
