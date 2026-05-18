# Changelog

## Color System C2 (2026-05)

Three global sliders — **Saturation**, **Hue**, and **Brightness** — now control color across all patterns via a post-process pass in the renderer. Individual per-pattern Saturation, Brightness, Hue Shift, Colorize, Tint, and Tint Strength sliders have been removed. The previous state is tagged `color-system-c1` in git for per-pattern rollback.

- Saturation 0 = fully grayscale, 1 = full palette color
- Hue 0–1 rotates all pattern hues up to 360°
- Brightness 0.75–2.0 scales luminance

---

## Static Images + Interactive Shader (2026-05)

Five artwork images added as a new pattern category. Each runs through the same image-pattern engine with Drift, Zoom Breathe, Ripple, Chromatic Aberration, Film Grain, Edge Pulse, and audio reactivity. An interactive GLSL shader pattern was also added.

---

## Presets + MIDI + Demo Mode (2026-05)

- Bundled preset defaults shipped with the app so the first run starts with sensible values
- MIDI toggle in Options (enables/disables MIDI controller input)
- Demo modal for kiosk / unattended display
- Developer "Copy Defaults" button exports current control values as TypeScript

---

## Pose Tracking: Body Patterns (2026-04)

MediaPipe pose tracking added. Four spatial patterns (Particle Field, Particle Lines, Wavy Sphere, Flow Lines) react to detected body position. A global **T** key toggles pose tracking. Per-pattern controls filter pose behavior. Debug overlay shows skeleton.

---

## Custom Palette + Palette Pattern Variants (2026-04)

Six-slot color palette (Cyan, Magenta, Purple, Gold, White, Dark) added to Options. Colors persist in localStorage. Two palette-first pattern variants added: **Particle Field — Palette** and **Tunnel — Edge Palette**.

---

## 8 Interactive Features (2026-04)

Added in one batch:
- **Audio reactivity** — mic input drives pattern brightness/pulse
- **URL sharing** — encode current pattern + control state as a share link
- **Preset slots** — save and restore up to 4 named snapshots
- **3D Typography** — text overlay rendered in Three.js
- **MIDI scaffold** — MIDI controller input routing
- **Undo** — step back through control changes
- **Favorites** — star patterns for quick access
- **Overview** — grid of all patterns with thumbnails

---

## Gamepad Support (2026-03)

Right stick controls the focused slider; left stick navigates patterns. DualShock and generic gamepad layouts supported. L1 shows the keyboard reference panel.

---

## Particle Lines Overhaul + Wavy Sphere Dissolve (2026-03)

Particle Lines rebuilt with fat screen-space quads for pixel-accurate line width and a glow-point pass per line head. Wavy Sphere gained a dissolve / reformation animation.

---

## Initial Patterns (2026-02 and earlier)

Core pattern library: Particle Field, Flow Dots, Flow Lines, Tunnel (smooth + edge variants), Baroque Swirls, Shader Gradient, Hyper Mix, Pearl Flow, 3D Lines, Curl Orbs, Crystal Gem, Dot Rain, Parallel Lines. Svelte 5 + Three.js + Tailwind v4 stack. GitHub Pages deployment.
