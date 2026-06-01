import * as THREE from 'three';
import type { Pattern, PatternContext } from './types';
import { poseState } from '../pose';
import { audioState } from '../globalAudioSettings.svelte';

const PALETTE_KEYS = ['cyan', 'magenta', 'purple', 'gold', 'white', 'black'] as const;
const PALETTE_DEFAULTS = ['#00ffff', '#ff00ff', '#9900ff', '#ffd700', '#ffffff', '#000000'];

function loadPalette(): THREE.Color[] {
  try {
    const stored = localStorage.getItem('pp:palette');
    if (stored) {
      const obj = JSON.parse(stored) as Record<string, string>;
      return PALETTE_KEYS.map((k, i) => new THREE.Color(obj[k] ?? PALETTE_DEFAULTS[i]));
    }
  } catch { /* ignore */ }
  return PALETTE_DEFAULTS.map(c => new THREE.Color(c));
}

function lerpColor(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  return new THREE.Color(
    a.r + t * (b.r - a.r),
    a.g + t * (b.g - a.g),
    a.b + t * (b.b - a.b),
  );
}

function paletteColorAt(palette: THREE.Color[], t: number): THREE.Color {
  const idx = Math.max(0, Math.min(1, t)) * (palette.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, palette.length - 1);
  return lerpColor(palette[lo], palette[hi], idx - lo);
}

// ─── Vertex shader ────────────────────────────────────────────────────────────

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// ─── Fragment shader ──────────────────────────────────────────────────────────

const fragmentShader = /* glsl */`
  precision highp float;

  uniform sampler2D uTexture;
  uniform float uTime;
  uniform float uSaturation;
  uniform float uBrightness;
  uniform vec3  uPaletteColor;   // interpolated from custom palette
  uniform float uColorize;       // 0-1: strength of palette colorize
  uniform vec3  uTint;           // manual tint color
  uniform float uTintStrength;   // 0-1
  uniform float uRotation;       // 0/1/2/3 × 90°
  uniform float uImgAspect;
  uniform float uScreenAspect;
  uniform float uVignette;       // 0-1
  uniform float uDrift;          // 0-1
  uniform float uZoomBreathe;    // 0-1
  uniform float uRipple;         // 0-1
  uniform float uChromaticAb;    // 0-1
  uniform float uGrain;          // 0-1
  uniform float uEdgePulse;      // 0-1
  uniform float uAudioLevel;     // 0-1
  uniform vec2  uParallaxShift;  // from pose centroid
  uniform float uPoseDistort;    // 0-1
  uniform vec2  uJoints[8];

  varying vec2 vUv;

  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  // Scale UV so the image covers the screen (no letterbox)
  vec2 coverUv(vec2 uv) {
    vec2 c = uv - 0.5;
    if (uScreenAspect > uImgAspect) {
      c.y *= uScreenAspect / uImgAspect;
    } else {
      c.x *= uImgAspect / uScreenAspect;
    }
    return c + 0.5;
  }

  vec2 rotateUv90(vec2 uv, float r) {
    if (r < 0.5)  return uv;
    if (r < 1.5)  return vec2(1.0 - uv.y, uv.x);
    if (r < 2.5)  return vec2(1.0 - uv.x, 1.0 - uv.y);
                  return vec2(uv.y, 1.0 - uv.x);
  }

  // HSL helpers
  float hueHelper(float p, float q, float t) {
    t = mod(t, 1.0);
    if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5)      return q;
    if (t < 2.0/3.0)  return p + (q - p) * (2.0/3.0 - t) * 6.0;
    return p;
  }

  vec3 rgb2hsl(vec3 c) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float l = (mx + mn) * 0.5;
    if (mx == mn) return vec3(0.0, 0.0, l);
    float d = mx - mn;
    float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    float h;
    if      (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else                h = (c.r - c.g) / d + 4.0;
    return vec3(h / 6.0, s, l);
  }

  vec3 hsl2rgb(vec3 c) {
    if (c.y == 0.0) return vec3(c.z);
    float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y;
    float p = 2.0 * c.z - q;
    return vec3(
      hueHelper(p, q, c.x + 1.0/3.0),
      hueHelper(p, q, c.x),
      hueHelper(p, q, c.x - 1.0/3.0)
    );
  }

  void main() {
    vec2 uv = vUv;

    // 1. Cover UV
    uv = coverUv(uv);

    // 2. Rotation (90° steps)
    uv = rotateUv90(uv, uRotation);

    // 3. Parallax (pose centroid drives a subtle UV shift)
    uv += uParallaxShift;

    // 4. Zoom breathe
    float breathe = 1.0 + uZoomBreathe * 0.04 * sin(uTime * 0.35);
    uv = (uv - 0.5) / breathe + 0.5;

    // 5. Drift (slow organic warp)
    if (uDrift > 0.001) {
      float dx = uDrift * 0.018 * sin(uTime * 0.14 + uv.y * 2.8);
      float dy = uDrift * 0.018 * cos(uTime * 0.11 + uv.x * 3.1);
      uv += vec2(dx, dy);
    }

    // 6. Ripple
    if (uRipple > 0.001) {
      float r = uRipple * 0.012 * sin(uv.x * 9.0 + uTime * 1.1) * cos(uv.y * 7.0 + uTime * 0.8);
      uv += vec2(r);
    }

    // 7. Pose distort (joints push UV outward)
    if (uPoseDistort > 0.001) {
      for (int i = 0; i < 8; i++) {
        vec2 j = uJoints[i];
        if (j.x < 0.01 && j.y < 0.01) continue;
        vec2 diff = uv - j;
        float d2 = dot(diff, diff);
        float push = uPoseDistort * 0.0015 / (d2 + 0.04);
        uv += normalize(diff) * push;
      }
    }

    // Clamp so we don't sample outside [0,1]
    vec2 clampedUv = clamp(uv, 0.0, 1.0);

    // 8. Chromatic aberration
    vec3 col;
    if (uChromaticAb > 0.001) {
      vec2 ab = (uv - 0.5) * uChromaticAb * 0.028;
      col.r = texture2D(uTexture, clamp(uv + ab, 0.0, 1.0)).r;
      col.g = texture2D(uTexture, clampedUv).g;
      col.b = texture2D(uTexture, clamp(uv - ab, 0.0, 1.0)).b;
    } else {
      col = texture2D(uTexture, clampedUv).rgb;
    }

    // 9. Saturation
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, uSaturation);

    // 10. Brightness
    col *= uBrightness;

    // 11. Palette colorize (shift hue toward selected palette color, preserve luminance)
    if (uColorize > 0.001) {
      vec3 imgHsl = rgb2hsl(col);
      vec3 palHsl = rgb2hsl(uPaletteColor);
      float newH = mix(imgHsl.x, palHsl.x, uColorize);
      float newS = mix(imgHsl.y, max(palHsl.y, 0.3), uColorize * 0.9);
      col = hsl2rgb(vec3(newH, newS, imgHsl.z));
    }

    // 12. Manual tint (color overlay)
    if (uTintStrength > 0.001) {
      col = mix(col, uTint * luma * 2.0, uTintStrength);
    }

    // 13. Edge pulse (Sobel-ish, pulsed by time + audio)
    if (uEdgePulse > 0.001) {
      float px = 1.5 / 1024.0;
      float py = 1.5 / 1024.0;
      float lC = dot(texture2D(uTexture, clampedUv).rgb, vec3(0.299, 0.587, 0.114));
      float lR = dot(texture2D(uTexture, clamp(clampedUv + vec2(px, 0.0), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
      float lU = dot(texture2D(uTexture, clamp(clampedUv + vec2(0.0, py), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
      float lL = dot(texture2D(uTexture, clamp(clampedUv - vec2(px, 0.0), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
      float lD = dot(texture2D(uTexture, clamp(clampedUv - vec2(0.0, py), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
      float edge = abs(lC - lR) + abs(lC - lU) + abs(lC - lL) + abs(lC - lD);
      edge = smoothstep(0.02, 0.12, edge);
      float pulse = (0.5 + 0.5 * sin(uTime * 2.5)) * (1.0 + uAudioLevel * 2.0);
      col += edge * uEdgePulse * pulse * uPaletteColor;
    }

    // 14. Mic flash (luminance-masked brightness boost)
    if (uAudioLevel > 0.001) {
      col += uAudioLevel * luma * 0.55;
    }

    // 15. Film grain
    if (uGrain > 0.001) {
      float noise = rand(clampedUv + fract(uTime * 0.017)) - 0.5;
      col += noise * uGrain * 0.14;
    }

    // 16. Vignette — at max, edges are pure black (projection-edge masking)
    if (uVignette > 0.001) {
      vec2 vigUv = vUv * 2.0 - 1.0;
      float dist2 = dot(vigUv, vigUv);
      // power ramps up with uVignette: low=gentle, high=sharp black edges
      float power = mix(0.8, 6.0, uVignette);
      float vig = pow(max(1.0 - dist2, 0.0), power);
      col *= vig;
    }

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeImagePattern(id: string, name: string, src: string): Pattern {
  let saturation   = 1.0;
  let brightness   = 1.0;
  let hueShift     = 0.0;   // position in custom palette
  let colorize     = 0.0;   // strength of palette hue colorize
  let tintColor    = '#ffffff';
  let tintStrength = 0.0;
  let rotation     = 0;     // 0/1/2/3

  let drift        = 0.0;
  let zoomBreathe  = 0.0;
  let ripple       = 0.0;

  let vignette     = 0.3;
  let chromaticAb  = 0.0;
  let grain        = 0.0;
  let edgePulse    = 0.0;

  let mesh: THREE.Mesh | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let geometry: THREE.PlaneGeometry | null = null;
  let texture: THREE.Texture | null = null;
  let imgAspect    = 1.0;
  let screenAspect = 1.0;
  let palette: THREE.Color[] = loadPalette();
  let paletteAge   = 0;

  const joints = Array.from({ length: 8 }, () => new THREE.Vector2(0, 0));

  return {
    id,
    name,
    usesPose: true,
    motionControlLabels: [], // no motion-camera slider boosting for image patterns

    controls: [
      // ── Image section ────────────────────────────────────────────────
      { label: 'Image', type: 'section', get: () => true, set: () => {} },
      { label: 'Saturation',  type: 'range', min: 0, max: 2,   step: 0.05, default: 1.0, get: () => saturation,   set: v => { saturation = v; } },
      { label: 'Brightness',  type: 'range', min: 0, max: 2,   step: 0.05, default: 1.0, get: () => brightness,   set: v => { brightness = v; } },
      { label: 'Hue Shift',   type: 'range', min: 0, max: 1,   step: 0.01, default: 0.0, get: () => hueShift,     set: v => { hueShift = v; } },
      { label: 'Colorize',    type: 'range', min: 0, max: 1,   step: 0.05, default: 0.0, get: () => colorize,     set: v => { colorize = v; } },
      { label: 'Tint',        type: 'color',                               default: '#ffffff', get: () => tintColor,    set: v => { tintColor = v; } } as never,
      { label: 'Tint Strength', type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => tintStrength, set: v => { tintStrength = v; } },
      { label: 'Rotate 90°',  type: 'button', action: () => { rotation = (rotation + 1) % 4; } },

      // ── Motion section ───────────────────────────────────────────────
      { label: 'Motion', type: 'section', get: () => true, set: () => {} },
      { label: 'Drift',        type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => drift,       set: v => { drift = v; } },
      { label: 'Zoom Breathe', type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => zoomBreathe, set: v => { zoomBreathe = v; } },
      { label: 'Ripple',       type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => ripple,      set: v => { ripple = v; } },

      // ── Style section ────────────────────────────────────────────────
      { label: 'Style', type: 'section', get: () => true, set: () => {} },
      { label: 'Vignette',    type: 'range', min: 0, max: 1, step: 0.05, default: 0.3, get: () => vignette,   set: v => { vignette = v; } },
      { label: 'Chromatic AB', type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => chromaticAb, set: v => { chromaticAb = v; } },
      { label: 'Film Grain',   type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => grain,      set: v => { grain = v; } },
      { label: 'Edge Pulse',   type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => edgePulse,  set: v => { edgePulse = v; } },
    ],

    init(ctx: PatternContext) {
      screenAspect = ctx.size.width / Math.max(1, ctx.size.height);
      palette = loadPalette();
      paletteAge = 0;

      const loader = new THREE.TextureLoader();
      texture = loader.load(src, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        if (tex.image) imgAspect = tex.image.width / tex.image.height;
        if (material) material.uniforms.uImgAspect.value = imgAspect;
      });
      texture.colorSpace = THREE.SRGBColorSpace;

      geometry = new THREE.PlaneGeometry(2, 2);
      material = new THREE.ShaderMaterial({
        uniforms: {
          uTexture:      { value: texture },
          uTime:         { value: 0 },
          uSaturation:   { value: saturation },
          uBrightness:   { value: brightness },
          uPaletteColor: { value: new THREE.Color(1, 1, 1) },
          uColorize:     { value: colorize },
          uTint:         { value: new THREE.Color(tintColor) },
          uTintStrength: { value: tintStrength },
          uRotation:     { value: rotation },
          uImgAspect:    { value: imgAspect },
          uScreenAspect: { value: screenAspect },
          uVignette:     { value: vignette },
          uDrift:        { value: drift },
          uZoomBreathe:  { value: zoomBreathe },
          uRipple:       { value: ripple },
          uChromaticAb:  { value: chromaticAb },
          uGrain:        { value: grain },
          uEdgePulse:    { value: edgePulse },
          uAudioLevel:   { value: 0 },
          uParallaxShift: { value: new THREE.Vector2(0, 0) },
          uPoseDistort:  { value: 0 },
          uJoints:       { value: joints },
        },
        vertexShader,
        fragmentShader,
        depthTest: false,
        depthWrite: false,
      });

      mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      ctx.scene.add(mesh);
    },

    update(dt: number, elapsed: number) {
      if (!material) return;

      // Refresh palette from localStorage every 2 s
      paletteAge += dt;
      if (paletteAge > 2) {
        palette = loadPalette();
        paletteAge = 0;
      }

      const pc = paletteColorAt(palette, hueShift);
      const u = material.uniforms;

      u.uTime.value          = elapsed;
      u.uSaturation.value    = saturation;
      u.uBrightness.value    = brightness;
      u.uPaletteColor.value.set(pc.r, pc.g, pc.b);
      u.uColorize.value      = colorize;
      u.uTint.value.set(tintColor);
      u.uTintStrength.value  = tintStrength;
      u.uRotation.value      = rotation;
      u.uVignette.value      = vignette;
      u.uDrift.value         = drift;
      u.uZoomBreathe.value   = zoomBreathe;
      u.uRipple.value        = ripple;
      u.uChromaticAb.value   = chromaticAb;
      u.uGrain.value         = grain;
      u.uEdgePulse.value     = edgePulse;

      // Audio mic flash
      u.uAudioLevel.value = audioState.enabled ? audioState.level / 100 : 0;

      // Pose: parallax tilt + distort
      if (poseState.active && poseState.persons.length > 0) {
        const person = poseState.persons[0];
        let cx = 0, cy = 0;
        for (const pt of person) { cx += pt.x; cy += pt.y; }
        if (person.length > 0) {
          cx /= person.length; cy /= person.length;
          // Centroid offset from screen center drives parallax (±5% UV shift)
          u.uParallaxShift.value.set((cx - 0.5) * 0.06, (cy - 0.5) * -0.06);
        }
        // Copy up to 8 joint positions
        for (let i = 0; i < 8; i++) {
          const pt = person[i];
          joints[i].set(pt ? pt.x : 0, pt ? pt.y : 0);
        }
        u.uPoseDistort.value = 1.0;
      } else {
        u.uParallaxShift.value.set(0, 0);
        u.uPoseDistort.value = 0;
      }
    },

    resize(width: number, height: number) {
      screenAspect = width / Math.max(1, height);
      if (material) material.uniforms.uScreenAspect.value = screenAspect;
    },

    dispose() {
      geometry?.dispose();
      material?.dispose();
      texture?.dispose();
      mesh = null; geometry = null; material = null; texture = null;
    },
  };
}
