<script lang="ts">
  import { onMount } from "svelte";
  import { createRenderer, type RendererHandle } from "./lib/renderer";
  import { attachKeyboard, type KeyAction } from "./lib/keyboard";
  import { attachTouch } from "./lib/touch";
  import { patterns } from "./lib/patterns";
  import * as fs from "./lib/fullscreen";
  import { loadSettings, saveSettings, loadDemoSettings, saveDemoSettings } from "./lib/settings";
  import type { PatternControl } from "./lib/patterns/types";
  import { restoreFromKeys } from "./lib/persist";

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

  // Demo mode
  let demoActive = $state(false);
  let demoDwell = $state(30);
  let demoPatternIds = $state<Set<string>>(new Set(patterns.map(p => p.id)));
  let demoTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotUrl = $state<string | null>(null);
  let snapshotFading = $state(false);

  // Reactive mirror of current pattern's control values so the number display
  // updates live as the user drags a slider.
  let ctrlVals = $state<Record<string, number>>({});

  function syncCtrlVals() {
    const next: Record<string, number> = {};
    for (const c of patterns[index]?.controls ?? []) next[c.label] = c.get();
    ctrlVals = next;
  }

  // Re-sync whenever the active pattern changes.
  $effect(() => { const _ = index; syncCtrlVals(); });

  function resetCtrl(ctrl: PatternControl & { type: "range" }) {
    if (ctrl.default === undefined) return;
    ctrl.set(ctrl.default);
    ctrlVals[ctrl.label] = ctrl.default;
    saveSettings(patterns);
  }

  function poke() {
    hudVisible = true;
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
    appState = "active";
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
        case "jump":
          if (action.index < patterns.length) {
            focusedIndex = action.index;
            switchTo(focusedIndex);
          }
          break;
        case "enter":
          activatePattern(focusedIndex);
          break;
        case "fullscreen":
          activateFullscreen(focusedIndex);
          break;
      }
    } else if (appState === "active") {
      switch (action.type) {
        case "next":
          index = switchTo(index + 1);
          focusedIndex = index;
          resetDemoTimer();
          poke();
          break;
        case "prev":
          index = switchTo(index - 1);
          focusedIndex = index;
          resetDemoTimer();
          poke();
          break;
        case "jump":
          if (action.index < patterns.length) {
            index = switchTo(action.index);
            focusedIndex = index;
            resetDemoTimer();
            poke();
          }
          break;
        case "fullscreen":
          fs.toggle(document.documentElement);
          hudVisible = false;
          break;
        case "demo":
          demoActive ? stopDemo() : startDemo();
          break;
        case "escape":
          if (fs.isFullscreen()) fs.exit();
          appState = "preview";
          poke();
          break;
      }
    } else {
      // preview
      switch (action.type) {
        case "next":
          index = switchTo(index + 1);
          focusedIndex = index;
          resetDemoTimer();
          poke();
          break;
        case "prev":
          index = switchTo(index - 1);
          focusedIndex = index;
          resetDemoTimer();
          poke();
          break;
        case "jump":
          if (action.index < patterns.length) {
            index = switchTo(action.index);
            focusedIndex = index;
            resetDemoTimer();
            poke();
          }
          break;
        case "fullscreen":
          fs.enter(document.documentElement);
          appState = "active";
          hudVisible = false;
          break;
        case "demo":
          demoActive ? stopDemo() : startDemo();
          break;
        case "escape":
          focusedIndex = index;
          appState = "overview";
          break;
      }
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
    if (demo.demoActive) startDemo();

    // Keep ctrlVals in sync every frame so motion-reactive sliders move live.
    let liveRaf: number;
    const liveSync = () => {
      if (hudVisible && appState !== 'overview') {
        for (const c of patterns[index]?.controls ?? []) {
          if (c.type === 'range') {
            const v = c.get();
            if (ctrlVals[c.label] !== v) ctrlVals[c.label] = v;
          }
        }
      }
      liveRaf = requestAnimationFrame(liveSync);
    };
    liveRaf = requestAnimationFrame(liveSync);

    const detach = attachKeyboard(handleAction);
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

    return () => {
      cancelAnimationFrame(liveRaf);
      detach();
      detachTouch();
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      window.removeEventListener("mousemove", poke);
      if (hudTimer) clearTimeout(hudTimer);
      if (demoTimer) clearTimeout(demoTimer);
      handle?.dispose();
      handle = null;
    };
  });
</script>

<canvas bind:this={canvas} class="block w-full h-full"
  onclick={() => { if (appState !== "overview") hudVisible = false; }}
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
      <p class="text-xs uppercase tracking-[0.35em] text-white/35">Pattern Projector</p>
    </div>

    <div class="grid grid-cols-3 gap-2 px-3 w-full max-w-lg pb-4">
      {#each patterns as p, i}
        <button
          class="relative flex flex-col gap-1 rounded-xl border px-3 py-3 text-left transition-all duration-150 cursor-pointer
            {focusedIndex === i
              ? 'border-white bg-white/10 shadow-[0_0_28px_rgba(255,255,255,0.12)]'
              : 'border-white/15 bg-white/[0.04] hover:border-white/40 hover:bg-white/[0.07]'}"
          onclick={() => activatePattern(i)}
          onmouseenter={() => { focusedIndex = i; switchTo(i); }}
        >
          <span class="text-[10px] font-mono text-white/35">{i + 1}</span>
          <span class="text-[13px] font-semibold leading-snug text-white">{p.name}</span>
          {#if focusedIndex === i}
            <span class="absolute right-3.5 top-3.5 h-1.5 w-1.5 rounded-full bg-white"></span>
          {/if}
        </button>
      {/each}
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

<!-- ─── Controls panel (active + preview) ─────────────────────────────── -->
{#if appState !== "overview"}
  <div
    data-no-swipe
    class="pointer-events-auto fixed bottom-4 right-4 z-10 select-none transition-opacity duration-500 min-w-48"
    style="max-height: calc(100dvh - 2rem)"
    class:opacity-0={!hudVisible}
    class:opacity-100={hudVisible}
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
        <!-- Pattern controls -->
        <div class="mb-2 shrink-0 border-t border-white/10 pt-3 text-xs uppercase tracking-widest text-white/50">Controls</div>
        <div class="flex flex-col gap-2.5 overflow-y-auto overscroll-contain">
          {#each patterns[index].controls! as ctrl}
            <div class="flex flex-col gap-1">
              {#if ctrl.type !== "button"}
              <div class="flex justify-between text-xs text-white/70">
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <span
                  class={ctrl.type === "range" && ctrl.default !== undefined ? "cursor-pointer select-none hover:text-white transition-colors" : ""}
                  title={ctrl.type === "range" && ctrl.default !== undefined ? "Click to reset" : undefined}
                  onclick={() => { if (ctrl.type === "range") resetCtrl(ctrl); }}
                >{ctrl.label}</span>
                {#if ctrl.type === "range"}
                  <span class="font-mono text-white/40">
                    {(ctrlVals[ctrl.label] ?? ctrl.get()).toFixed(ctrl.step < 0.01 ? 3 : ctrl.step < 0.1 ? 2 : ctrl.step < 1 ? 1 : 0)}
                  </span>
                {/if}
              </div>
              {/if}
              {#if ctrl.type === "range"}
                <input
                  type="range"
                  min={ctrl.min}
                  max={ctrl.max}
                  step={ctrl.step}
                  value={ctrlVals[ctrl.label] ?? ctrl.get()}
                  oninput={(e) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    ctrl.set(v);
                    ctrlVals[ctrl.label] = v;
                    saveSettings(patterns);
                  }}
                  ondblclick={() => resetCtrl(ctrl)}
                  class="w-full accent-white cursor-pointer"
                />
              {:else if ctrl.type === "select"}
                <select
                  value={ctrl.get()}
                  onchange={(e) => { ctrl.set(parseInt((e.target as HTMLSelectElement).value)); saveSettings(patterns); }}
                  class="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none cursor-pointer"
                >
                  {#each ctrl.options as opt, i}
                    <option value={i}>{opt}</option>
                  {/each}
                </select>
              {:else if ctrl.type === "button"}
                <button
                  onclick={() => ctrl.action()}
                  class="w-full rounded bg-white/10 px-2 py-1 text-xs text-white cursor-pointer hover:bg-white/20 active:bg-white/30 transition-colors"
                >{ctrl.label}</button>
              {/if}
            </div>
          {/each}
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
    class:opacity-0={!hudVisible}
    class:opacity-100={hudVisible}
  >
    <div class="rounded-md border border-white/10 bg-black/60 px-4 py-3 text-white backdrop-blur-sm">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-xs uppercase tracking-widest text-white/50">Pattern</div>
          <div class="text-lg font-semibold">{patterns[index].name}</div>
          <div class="mt-1 text-xs text-white/40">{index + 1} / {patterns.length}</div>
        </div>
        <div class="flex flex-col items-end gap-1.5">
          <button
            class="pointer-events-auto rounded-md border px-3 py-1.5 text-xs transition-colors {demoActive ? 'border-white/40 bg-white/15 text-white' : 'border-white/15 bg-white/[0.07] text-white/70 hover:border-white/40 hover:bg-white/15'} active:bg-white/20"
            onclick={() => { demoActive ? stopDemo() : startDemo(); }}
          >
            {demoActive ? "● Demo" : "Demo"}
          </button>
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
      {#if isTouch}
        <button
          class="pointer-events-auto mt-3 w-full rounded-md border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/15 active:bg-white/20"
          onclick={() => { if (fs.isFullscreen()) fs.exit(); focusedIndex = index; appState = "overview"; }}
        >
          ← Patterns
        </button>
      {/if}
      <div class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-white/70">
        {#if isTouch}
          <span>↔</span><span>swipe to change pattern</span>
        {:else}
          <kbd class="rounded bg-white/10 px-1.5 font-mono">D</kbd>
          <span>demo mode</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">F</kbd>
          <span>fullscreen</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">→ ↓</kbd>
          <span>next</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">← ↑</kbd>
          <span>previous</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">1–{patterns.length}</kbd>
          <span>jump</span>
          <kbd class="rounded bg-white/10 px-1.5 font-mono">Esc</kbd>
          <span>{appState === "preview" ? "overview" : "preview"}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
