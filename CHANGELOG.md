# Changelog

## v0.3.260601-0126 — Light Painting unified + new feedback/look effects

**Light Trail and Light Paint merged into one pattern, "Light Painting."** Brush Size = 0 reproduces the old sharp Light-Trail look; higher values give the soft Light-Paint brush. The redundant Gain/Brightness controls are now a single **Gain**.

**Trail Color reworked** — was a chroma boost that defaulted to 2.0 and oversaturated a clean feed. It is now a single slider blending **Live/natural colour (0) → custom palette (1)**, defaulting to 0 (untouched colour). This replaces the old per-frame chroma amplification and the global Colors v2 tint for this pattern.

**Threshold isolation** — no separate toggle needed: **Background = Black** already shows only above-threshold trails on pure black.

**New effects:**
- *Fly In/Out* (−1…1) — feedback zoom; trails rush inward or fly outward through space
- *Vortex* (−1…1) — rotational feedback swirl
- *Bloom* (0…1) — separable-blur soft glow around bright trails
- *RGB Split* (0…0.02) — chromatic channel offset
- *Kaleidoscope* + *Segments* (2…12) — radial mirror symmetry

## v0.4.260527-0142 — Demo Mode Overhaul

Comprehensive rework of demo / kiosk mode.

**HUD suppression** — mouse and touch activity no longer shows the HUD during demo. Moving the mouse or touching the screen reveals a small ✕ button in the top-right corner instead; pressing it stops the demo and restores the HUD. Escape also stops demo cleanly.

**Foot pedal (b key)** — short press now advances to the next pattern and randomizes its settings instead of only randomizing. Holding the pedal no longer fires rapid key-repeats (browser key-repeat suppressed). New toggle in Demo Options: **Pedal changes pattern** (off = randomize settings only, no pattern change).

**Freeze during demo** — Space / gamepad Start pauses the dwell timer while the pattern is frozen; unfreeze resumes the countdown.

**Demo Options — new controls:**
- *Interactive features* — global Motion, Pose, and Audio toggles apply to all demo patterns at once; enabling Motion or Audio overrides any per-pattern disabled flags
- *Camera / mic device pickers* — appear when Motion or Pose is active (camera) / Audio is active (mic); ↺ button re-enumerates devices
- *Hide HUD in Demo Mode* toggle — persisted; when off, the normal 5 s auto-hide HUD behaviour is restored during demo
- *Pedal changes pattern* toggle — persisted
- *Randomize settings on pattern change* toggle (existing, now also persisted)

**Auto-restart on idle** — new toggle in Options (Demo section): re-enables demo automatically after a configurable idle period. Timer input uses `hh:mm` format.

---

## v0.3.260521-xxxx — Static Images Defaults

Film Grain removed (broken). Static Images now default to all controls at minimum, Motion and Style sections collapsed and off, Colour section collapsed. Bug fix: Style section toggle was always-on and could not be turned off.

---

## v0.3.260521-1430 — Color System

Three global color pickers (Main, Contrast, Glow) replace the old hue/palette system. Per-pattern **Color Shuffle** randomly reassigns palette slots. Per-pattern Saturation and Brightness sliders. **Apply Colors** toggle. MSAA anti-aliasing. Preset slots now save color state. Default reset targets base colors only.

---

## v0.3.260519-0908 — USB Foot Pedal

Short and long press mapped to demo-jump and light-paint mode toggle.

---

## v0.3.260518-0057 — Static Images · Presets · MIDI · iOS

Five artwork images added as a pattern category with shared motion engine: Drift, Zoom Breathe, Ripple, Chromatic Aberration, Edge Pulse, audio reactivity. Interactive GLSL shader pattern added. Bundled preset defaults ship with the app. MIDI controller toggle in Options. Demo modal for kiosk display. Developer "Copy Defaults" export. iOS fixes: screenshot, Photos save, version label.

---

## v0.3.260515-0519 — Body Pose Tracking

MediaPipe pose tracking. Four spatial patterns (Particle Field, Particle Lines, Wavy Sphere, Flow Lines) react to detected body position. Global **T** key toggles tracking. Debug skeleton overlay. Per-pattern audio and motion reactivity toggles.

---

## v0.2 — Gamepad · 8 Interactive Features

Gamepad support: right stick controls the focused slider, left stick cycles patterns, L1 shows the keyboard reference. DualShock and generic layouts supported.

Eight features added in one batch: audio reactivity, URL sharing, preset slots, 3D Typography, MIDI scaffold, undo, favorites, pattern overview grid.

---

## v0.1 — Initial Patterns · Particle Lines Overhaul

Core pattern library: Particle Field, Flow Dots, Flow Lines, Tunnel, Baroque Swirls, Shader Gradient, Hyper Mix, Pearl Flow, 3D Lines, Curl Orbs, Crystal Gem, Dot Rain, Parallel Lines. Svelte 5 + Three.js + Tailwind v4 stack. GitHub Pages deployment.

Particle Lines rebuilt with fat screen-space quads for pixel-accurate line width and a glow-point pass per line head. Wavy Sphere gained a dissolve/reformation animation.
