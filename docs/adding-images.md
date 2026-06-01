# Adding your own images

Lichtspiel can turn any still image into a live, reactive visual. Once added, your
image gets the full set of motion, audio and pose effects automatically — drifting,
breathing, rippling, flashing to sound and reacting to people in front of the camera.

You don't need to touch any code. You drop the image into a folder and ask Claude to
register it.

---

## What you need

- An image you want to use (a photo, a pattern, artwork, a logo…)
- Best results with **`.webp`** files (smallest). **`.jpg`** and **`.png`** also work.
- Recommended size: around **1024–2048 pixels** on the longest edge. Bigger isn't
  better — it just loads slower.
- Any shape is fine. Lichtspiel fits it to the screen for you.

---

## Step 1 — Put the image in the project

Copy your image file into this folder:

```
public/images/
```

Give it a simple, lowercase name with no spaces, for example:

```
public/images/sunset.webp
```

> Tip: if your name has spaces, use dashes instead — `my-photo.webp`, not `my photo.webp`.

---

## Step 2 — Ask Claude to register it

Tell Claude something like:

> "Add `public/images/sunset.webp` as an image pattern called **Sunset**."

Claude makes the small code change that hooks it into the app (a couple of lines in
`src/lib/patterns/index.ts`). You don't have to edit anything yourself.

Mention any preferences while you're at it, for example:

- the **name** you want shown on screen (e.g. "Sunset")
- whether it should **fill the screen** (default, may crop) or **show the full width**
  (tiles top and bottom)

> Doing it by hand? The two-line edit lives in `src/lib/patterns/index.ts` — copy any
> existing `makeImagePattern(...)` line, point it at your file, and add the new name to
> the list just below. But the easy path is to let Claude do it.

---

## Step 3 — See it

Start (or restart) the app:

```sh
bun run dev
```

Your image now appears in the rotation. Use the number keys **1–9** to jump between
visuals, or the **arrow keys** to cycle through them until you reach yours. Its name
shows in the on-screen overlay.

---

## Adjusting how it looks

Every image visual comes with the same controls, grouped in the overlay:

- **Rotate 90°** — turn the image a quarter-turn at a time.
- **Drift** — slow, organic warping.
- **Zoom Breathe** — gentle in-and-out zoom.
- **Ripple** — wavy distortion.
- **Brightness** — how strongly the image flashes to sound (needs the microphone on).
- **Vignette** — darken the corners.
- **Chromatic AB** — colour-fringe / glitch look.
- **Edge Pulse** — make outlines glow and pulse.

If the camera and pose tracking are on, the image also tilts and bends slightly toward
people moving in front of it.

---

## Common mistakes

- **Image doesn't appear:** make sure the file is inside `public/images/` and that you
  asked Claude to register it — dropping the file in alone isn't enough.
- **Odd colours or it loads slowly:** re-export at a sensible size (1024–2048px) and as
  `.webp` if you can.
