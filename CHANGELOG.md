# Changelog

## v0.7.260711-0515 — Remote Control

**Display / Remote modes** — one device can now show the projection (**Display**) while another controls it live (**Remote**), paired over a WebSocket relay with a 4-character room code. Remote runs the full app — you see your own local preview and every change you make broadcasts to the Display in real time. New "Remote Control" section in Options to start either mode, plus `?mode=display` / `?mode=remote` URL parameters for kiosk setups.

**What syncs** — every per-pattern slider/toggle/color, pattern selection, presets, palette and custom colours, Apply Colors / Color Shuffle / Brightness, Interaction strength, Camera and Audio reactivity (Motion, Heat, Beat, sensitivities), Evolving Range, Freeze and Speed, and Demo (Remote configures and starts/stops Demo — it runs on the Display only, so the two devices never fight over which pattern is next). Camera and microphone selection is by device *name* rather than raw device ID, since a Mac's camera list means nothing on an iPhone — Remote shows the Display's own device list and picks from that.

**Display mode** — fullscreen, no menus; the room code and a live connection indicator appear on touch/pointer activity and fade again. Wake Lock keeps the screen from sleeping.

**Relay server** (`server/app.js`) — a minimal, stateless Node/Bun WebSocket relay (`bun run remote-server` locally, or deployed standalone) with no server-side state beyond who's currently in a room.

## v0.6.0942-260623 — Heat Reactivity · Control Tooltips

**Heat system** — a global motion-detection layer that turns the camera feed into a real-time heat map. A low-res motion buffer (320×180) tracks inter-frame pixel change and feeds an organic, blur-smoothed heat texture that influences particle attraction, shader warping, and camera shake across patterns.

**Heat-reactive patterns** — Particle Field Heat, Hyper Mix Heat, and Heat Map ship as dedicated slots; Wavy Sphere, Crystal Gem, and 3D Typography gain heat reactivity via centroid tracking (the camera's strongest-motion zone pulls the focal point). Static Images gain a heat-haze distortion layer. Heat Strength, Heat Gain, and Blur Radius are tunable per pattern.

**Heat controls** — a single **Heat** toggle in the Interactive section activates the shared heat sensor (independent from Motion). Demo mode has its own Heat toggle. The Colorize Light control was renamed for clarity.

**Control tooltips** — every slider and toggle in the HUD shows a short description on hover/focus, making the controls self-documenting for new users.

**Preset pattern-set for Demo** — a curated heat-optimised pattern set ships as the demo default.

---

## v0.5.260601-1911 — New patterns · Demo intensity modes · Audio & Camera rework

**Four new static-image patterns** — **Two Feather**, **Root Wave**, **Purple Ornate** and **Flowing Dots** — join the Static Images category. Each shares the full image engine (Drift, Zoom Breathe, Ripple, Chromatic Aberration, Edge Pulse, Vignette), reacts to pose and audio, and ships with the same Chilled / Balanced / Active preset slots as the other image patterns.

**Demo intensity modes (Pattern Start).** Demo / kiosk mode can now start every pattern at a chosen energy level instead of its plain default: **Chilled (slot 1)**, **Balanced (slot 2)** or **Active (slot 3)** — mapped to each pattern's three preset slots — plus **Default** and **Random**. Selecting an intensity mode automatically scopes the demo to your favourites. Also added: **Randomize order of patterns**, demo auto-fullscreen, and a **P** shortcut.

**Audio module rework.** A **noise gate** now suppresses fan and room noise so reactivity only fires on real signal. Microphone access added to the Light Painting family, frequency-band targeting (Mid), and clearer per-pattern audio-control labels (Flow Lines, Curl Orbs, Tunnels, Light Painting).

**Camera module rework.** Cameras now start **on-demand** from the Interactive section (with device pickers and a ↺ re-enumerate button) rather than grabbing the feed up front; the "Requesting camera…" flash is suppressed when permission is already granted, and a race condition on start/stop was fixed.

**Sensor Block** — a global camera + microphone kill-switch in the top-left HUD. It hard-stops every sensor stream (camera, mic, pose tracking) via a central stream registry and shows a blocked-state overlay; toggling it off restores the previous state immediately.

**Universal interaction architecture.** A shared Speed / Direction / Burst reactivity layer across patterns, a **Brightness Gain** slider (replacing the old on/off toggle), Colors v2 saved in preset slots, and **performance optimisations** for older machines.

## v0.4.260601-0318 — Light Painting: mirror, Colorize/Colors v2 wiring, preset tiles

**Mirror** toggle (default on) — the camera is now mirrored selfie-style, so moving a light left reads left on screen. Applies to trails, background and ghost consistently.

**"Trail Color" renamed to "Colorize"** and re-wired to the app-wide colour system. Colorize blends **Live (0) → your 3 Custom Colours (1)**, and it now sits at the `v2 = 3` end of the global **Colors v2** curve, so for Light Painting: **v2 = 0** grayscale · **v2 = 1** single main-colour tint · **v2 = 3** (default) = the Colorize result. Color Shuffle reorders the palette and Brightness scales it. At Colorize = 0 the output is identical to before (untouched live), so nothing else changes. Colors v2 affects these patterns again (it previously did nothing here).

**Seven preset tiles** under "Live Light Painting", each the same full toolbox with different starting defaults: **Light Paint**, **Light Trail** (sharp), **Light Paint Black** (trails on black), **Light Fly** (fly + vortex), **Kaleidoscope**, **Light Bloom**, **RGB Glitch**. Any tile can be tuned into any other look; each keeps its own saved settings.

## v0.4.260601-0126 — Light Painting unified + new feedback/look effects

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

Software Architecture of the initial version by [@olgen](https://github.com/olgen).
