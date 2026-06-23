# Lichtspiel

A browser-based, keyboard-operated abstract visual instrument built with Svelte 5, Three.js, and Tailwind CSS. Drop it on a projector PC, go fullscreen, and cycle through animated visuals entirely from the keyboard — or let Demo mode run it hands-free.

## Controls

| Key | Action |
|-----|--------|
| `F` | Toggle fullscreen |
| `→` / `↓` | Next pattern |
| `←` / `↑` | Previous pattern |
| `1`–`4` | Jump to pattern category |
| `Space` | Freeze / unfreeze |
| `P` | Start / stop Demo mode |
| `Esc` | Exit fullscreen / stop Demo |

## Patterns

**Generative** — 3D Lines, Particle Field, Particle Field Heat, Tunnel, Tunnel Edge, Parallel Lines, Flow Lines, Curl Orbs, Baroque Swirls, Wavy Sphere, Crystal Gem, Hyper Mix, Hyper Mix Heat, Heat Map, Shader Gradient, 3D Typography, Warp Surfaces, ASCII Swirls

**Static Images** — artwork and photos with live Drift, Zoom Breathe, Ripple, Chromatic Aberration, Edge Pulse, and heat-haze effects

**Light Painting** — camera-based light-trail and brush patterns with Kaleidoscope, Bloom, RGB Split, Vortex, and Fly effects

**Interactive** — body-pose tracking, audio reactivity, heat reactivity, and a real-time motion heat map

## Features

- **Heat system** — camera-based motion detection drives a live heat texture that pulls particles, warps shaders, and tracks focal points
- **Body pose tracking** — MediaPipe detects body position and routes it to particle and wave patterns
- **Audio reactivity** — noise-gated microphone feeds frequency-band reactivity to eligible patterns
- **Demo / kiosk mode** — cycles patterns automatically with configurable dwell time, intensity modes (Chilled / Balanced / Active), and auto-restart on idle
- **Preset slots** — three save slots per pattern; Demo can target a slot for a consistent energy level
- **Sensor block** — one-tap global kill-switch for all camera and microphone streams
- **Gamepad** — right stick for sliders, left stick for pattern cycle, L1 for keyboard reference
- **MIDI** — optional MIDI controller input
- **Control tooltips** — every slider and toggle shows a description on hover
- **Favourites** — star patterns; Demo can scope itself to favourites only
- **URL sharing** — share current pattern and settings via URL

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev      # http://localhost:5173
bun run build    # production build → dist/
bun run preview  # preview production build
```

## Adding a pattern

1. Create `src/lib/patterns/my-pattern.ts` exporting a `Pattern` object:

```ts
import type { Pattern } from "./types";

export const myPattern: Pattern = {
  id: "my-pattern",
  name: "My Pattern",
  init(ctx) { /* add meshes to ctx.scene */ },
  update(dt, elapsed) { /* animate */ },
  resize(width, height) { /* update camera/uniforms */ },
  dispose() { /* free geometries/materials */ },
};
```

2. Append it to the array in `src/lib/patterns/index.ts`. Done.

## Adding your own images

Want to use your own photos or artwork as live, reactive visuals? See
**[docs/adding-images.md](docs/adding-images.md)** for a step-by-step, no-coding-required guide.

## Deployment

The included `.github/workflows/pages.yml` builds and publishes `dist/` to GitHub Pages on every push to `main`. Enable Pages in your repo settings (source: **GitHub Actions**).

## License

MIT
