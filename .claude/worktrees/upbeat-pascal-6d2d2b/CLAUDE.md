# Pattern Projector — Claude Code Guidelines

## Stack (do not deviate)
- **Runtime/package manager:** Bun only. Never use npm, npx, yarn, or pnpm.
- **Framework:** Svelte 5 with runes (`$state`, `$derived`, `$effect`). No Options API.
- **Styling:** Tailwind CSS v4 via `@tailwindcss/vite`. No separate `tailwind.config.js`. All DOM/HUD styling via Tailwind utility classes. Three.js canvas content is unstyled.
- **3D rendering:** Three.js only. No other WebGL libraries.
- **No router, no state library, no backend.** This is a static single-page app.

## Commands
```sh
bun run dev      # start dev server on :5173
bun run build    # production build → dist/
bun run preview  # preview dist/
```

## Architecture

### Pattern interface (`src/lib/patterns/types.ts`)
Every visual is a `Pattern` object with five methods:
- `init(ctx)` — called once when pattern becomes active; add meshes to `ctx.scene`
- `update(dt, elapsed)` — called every frame; animate
- `resize(width, height)` — called on viewport change; update camera/uniforms
- `dispose()` — called when switching away; free all THREE geometries/materials/textures

### Adding a new pattern
1. Create `src/lib/patterns/my-pattern.ts` exporting a `Pattern`
2. Append it to the array in `src/lib/patterns/index.ts`
No other wiring needed — the keyboard `1`–`9` jump and arrow cycle pick it up automatically.

### Renderer (`src/lib/renderer.ts`)
- One `WebGLRenderer`, `Scene`, and `PerspectiveCamera` are reused across all patterns.
- `setPattern(next)` calls `dispose()` on the current pattern, clears `scene.children`, then calls `init` on the next.
- A single RAF loop drives `update` then `renderer.render`.
- A `ResizeObserver` on the canvas drives `resize`.

### HUD (`src/App.svelte`)
- Overlay fades after 2 s of no keyboard/mouse activity.
- All HUD markup uses Tailwind utility classes.
- Keyboard handling lives in `src/lib/keyboard.ts`; fullscreen in `src/lib/fullscreen.ts`.

## Deployment
GitHub Pages via `.github/workflows/pages.yml`. Builds `dist/` on push to `main`. Enable Pages in repo settings (source: **GitHub Actions**).

## Git workflow
Push directly to `main`. Do not open pull requests.
