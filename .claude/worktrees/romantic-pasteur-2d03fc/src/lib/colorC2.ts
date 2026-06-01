/** C2 global color controls — read by the renderer post-process pass each frame. */
export const colorC2 = {
  saturation: 1.0,   // 0 = grayscale, 1 = full color
  hue:        0.0,   // 0–1, rotates all hues by up to 360°
  brightness: 1.0,   // 0.75–2.0 scalar
};
