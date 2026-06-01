# Lichtspiel

A browser-based, keyboard-operated abstract visual instrument built with Svelte 5, Three.js, and Tailwind CSS. Drop it on a projector PC, go fullscreen, and cycle through animated visuals entirely from the keyboard.

## Controls

| Key | Action |
|-----|--------|
| `F` | Toggle fullscreen |
| `→` / `↓` | Next pattern |
| `←` / `↑` | Previous pattern |
| `1`–`4` | Jump to pattern by number |
| `Esc` | Exit fullscreen |

## Patterns

1. **3D Lines** — Catmull-Rom curves animated with wave noise, slow scene rotation
2. **Particle Field** — 50k GPU particles driven by a flow-noise vertex shader
3. **Tunnel** — Wireframe rings flying toward the camera, hue-cycling colour
4. **Shader Gradient** — Domain-warped FBM noise gradient in a fullscreen GLSL shader

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

## Deployment

The included `.github/workflows/pages.yml` builds and publishes `dist/` to GitHub Pages on every push to `main`. Enable Pages in your repo settings (source: **GitHub Actions**).

## License

MIT
