# Changelog

## v0.7.260816-0930 — Text Overlay · Demo fixes

**Text Overlay** — 3D text drawn on top of whichever pattern is running, set up once in Options and left alone. It stays put as patterns change and through Demo, and because it is rendered into the picture rather than laid over it in the interface, it appears in screenshots and recordings and on a projector fed by the canvas. Text, Align, Style, Size, Depth, Line Spacing, Position X/Y, Opacity and Spin. The text is not touched by the colour grade or the flicker guard, so titles stay crisp and the colour you pick is the colour you get.

**Several lines of text** — both the overlay and the 3D Typography pattern take multi-line text: press Enter for a new line. New **Align** (left / centre / right) and **Line Spacing** controls. A long-standing centring bug is fixed along the way — the block was positioned by half its extent rather than its true centre, which was invisible on one line and pushed a multi-line block half its own height too low.

**Show / hide cycle** — optional on both: the text appears for a while, disappears for a while, and comes back, fading at each edge rather than popping. Off by default; when switched on it starts at 10 seconds visible, 2 minutes hidden.

**Face Camera actually faces the camera.** It used to stop the spin and freeze the text at whatever angle it had reached, because the accumulated rotation was never cleared and was written straight back on the next frame — and the lock only ever held the tilt, not the turn. It now eases to face front, taking the shorter way round, and holds there even with Heat running.

**Demo no longer takes over while you work.** After the idle time, Demo starts on its own — that part is intended — but moving the mouse only flashed a small ✕ and never postponed the next pattern, the interface stayed hidden so nothing said Demo was running, and the state was saved, so the next launch booted straight back into an invisible demo. Now any real interaction ends an idle-started demo and hands the controls straight back, the exit reads **● Demo — ✕ Stop** instead of a bare ✕ and stays up longer, and an idle start is no longer remembered. A demo you started yourself still behaves as before: interacting only postpones the next pattern. Default idle time is now 5 minutes. To leave Demo at any time: **Escape**, the ✕ pill, or **D** for the Demo panel.

**Dwell time** now runs from 5 seconds to 15 minutes, on a slider that steps in 5 seconds at the short end and a minute at the long end, so both a quick cycle and a slow gallery loop are easy to dial in.

**Greyed-out controls tell the truth.** A control that switches others on and off — Kaleidoscope, Mirror Fold, Cycle — left them greyed and unclickable after an Undo, a preset recall or a change pushed from a Remote, even though the effect was plainly running. The knob corrected itself every frame while the greying did not; both now do.

## v0.7.260816-0204 — Push is its own sensor

**Push stands on its own.** It used to be a knob buried under Heat; now it sits in the Interactive panel next to Motion, Heat and Audio, with its own toggle and its own settings — Solidity, Push Strength, Return Speed, Softness and Sensitivity. Those settings are global rather than per-pattern, like Motion's Sensitivity, so the feel of the interaction stays put as patterns change under it. Heat and Push are independent: run either, both, or neither. With both on, Push drives the picture and Heat's displacement steps aside.

**Push now works across the app** — Particle Field, Hyper Mix, Gravity Lines, Particle Lines, Parallel Lines, Parallel Waves, Tunnel, Shader Gradient, Warped Surfaces, Curl Orbs and all nine Static Images. Every one of those already moved with the heat map, so your body clears a path through each of them. Left out are the patterns where heat does something a push has no meaning for: a camera tilt toward whoever is moving (Tunnel Edge, 3D Typography, 3D Lines, Crystal Gem, Wavy Sphere) or a bend of a flow angle rather than a position (Baroque Swirls, Flow Lines).

**Blur Radius honours its decimals.** The knob offered 0.1 steps but the blur quantised them, so 2.4 looked exactly like 2.0 and preset sweeps stepped between whole numbers instead of morphing. Fractional radii now blur properly, and a radius under 1 blurs a little instead of doing nothing at all.

**Under the hood** — eleven patterns each carried their own copy of the heat map's smoothing and blur; that now lives in one module, which is also what let Push reach all of them.

## v0.7.260815-1022 — Solidity

**Solidity** — Push Away now treats your body as a real object. Until now the push came from the *outline* of your movement, which meant the middle of your hand barely pushed at all and you had to sweep an area several times to clear it. Now everything the camera reads as you is vacated in one pass: sweep once and you carve an empty path, the way a hand sweeps balls off a floor. The slider sets how solid you are — 1 clears what you cover out to the edge of your silhouette, higher piles it up beyond that, 0 goes back to the old soft nudge. On Particle Field, Hyper Mix and Gravity Lines, starting at 1.

**Push Strength** keeps its old job as the soft, cumulative shove from your outline, on top of Solidity. **Heat Gain** now also decides how much movement counts as solid.

**Bend Strength** — Gravity Lines gets a knob for how far your motion swings the capsules' *direction*, separate from moving them. Past about 1 the whole grid starts snapping radially onto you and the vortices flatten out, which is a look in itself.

## v0.7.260815-0553 — Gravity Lines · Push Away

**Gravity Lines** — a new Generative pattern: a fine grid of short rounded capsules, each one aligned to a field of drifting gravity centres. Nothing travels across the screen; the masses move *under* a still grid, so what you see is the field itself becoming visible — vortices winding up, bands fanning out between them, dark cores where a mass sits. Every third mass repels instead of attracts, which is what opens the bright ridges. **Masses**, **Swirl** (point at the centres, or orbit them), **Softening** (core size), **Depth** (flat grid, or a sheet folding in 3D), plus Line Count, Width and Length. It takes its colours from the palette, from black through the enabled colours as the field gets stronger, and it reacts to motion, audio and heat exactly like Particle Field.

**Push Away** — a new heat mode on **Particle Field**, **Hyper Mix** and **Gravity Lines**. Normally heat pulls the visuals around as you move and they snap back the instant you stop. Switched on, your movement instead shoves them aside and the gap stays: like balls lying on a floor pushed away with your hands, then slowly rolling back to cover it again. **Push Strength** sets how deep a gap you carve, **Return Speed** how long it stays open, and **Spread** how softly its edge melts as neighbours roll in from the sides. Off by default; the third preset slot on Gravity Lines starts with it on.

**Under the hood** — the heat map's smoothing and blur, which three patterns each carried their own copy of, now live in one place, along with the palette ramp shared with Heat Map.

## v0.7.260813-1532 — Mirror · Kaleidoscope · Saved Configs

**Mirror** — a new Live Light Painting pattern that folds the image across a single axis: a two-segment kaleidoscope. A **Direction** control picks the axis and which half is the source — horizontally, horizontally mirrored, vertically, vertically mirrored. Everything else starts from the Light Paint defaults.

**Kaleidoscope — Only Light** — a new knob, on by default, that repeats only the light above the Threshold. Everything darker stays a normal, unfolded image, so the room reads naturally while the painted light fans out around it. Switch it off for the previous behaviour, where the whole picture folds. **Segments** now runs 3–12 and starts at 5.

**Fold controls** — Mirror and Kaleidoscope share three new options. **Fold Angle** rotates the mirror seam or wedge orientation, which used to be locked to the horizontal; while you drag it, the pattern outlines the part of the image it is actually sampling and dims the rest, so you can see what you are aiming at. **Round** gives the kaleidoscope circular wedges instead of ones stretched by the screen shape. **Center on Person**, off by default, pivots the fold on whoever is moving instead of the image centre — it needs Heat. Controls that don't apply to the active fold are now greyed out, and Heat starts neutral on both patterns because its warp fights the fold.

**Controls fade while you adjust them** — dragging a slider or flipping a knob fades the panel backgrounds to transparent so you can see the change on the projection underneath. Typography, sliders and knobs stay fully visible, and the background returns half a second after you let go. Mac, iPhone and iPad.

**Tap to hide on iPhone and iPad** — a tap on the canvas now hides the interface the way a click already did on the Mac, and a second tap brings it back. Previously the interface flickered off and came straight back, and lingered longer on touch devices than on desktop.

**Saved Configs** — two configurations now ship on first launch, including "Interactive Planetary", and existing installs are retrofitted with them.

**Camera reliability** — the Heat and Motion toggles no longer fight each other on Hyper Mix, Particle Field and ASCII Swirls, and every pattern now goes through one central CameraManager that shares a single stream and recovers when a camera drops out.

**Fixes** — black flashes on pattern switch and on preset restore with Heat active, 3D Typography blacking out and not reacting to its controls, fullscreen exit, and preset/share export silently dropping Heat and Pose values. Hyper Mix regained its distinct Chilled/Balanced/Active presets with explicit Heat Strength, Gain and Blur Radius.

**Interface** — Move/Heat/Audio filter chips in both the pattern menu and Demo, category dividers that stay put under the filters, consistent Options and Demo headers, first-run hints, an Exit button on the Display-mode splash, sensitivity via preset slots, an epilepsy-guard badge, and credits for @olgen. Number-key pattern jumping was removed so typing can no longer throw you into another pattern.

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
