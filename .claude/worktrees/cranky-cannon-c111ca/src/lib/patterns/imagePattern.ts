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

function paletteColorAt(palette: THREE.Color[], t: number): THREE.Color {
  const idx = Math.max(0, Math.min(1, t)) * (palette.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, palette.length - 1);
  const f = idx - lo;
  const a = palette[lo], b = palette[hi];
  return new THREE.Color(a.r + f * (b.r - a.r), a.g + f * (b.g - a.g), a.b + f * (b.b - a.b));
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
  uniform vec3  uPaletteColor;
  uniform float uColorize;
  uniform vec3  uTint;
  uniform float uTintStrength;
  uniform float uRotation;       // 0/1/2/3
  uniform float uImgAspect;
  uniform float uScreenAspect;
  uniform float uVignette;
  uniform float uDrift;
  uniform float uRipple;
  uniform float uChromaticAb;
  uniform float uEdgePulse;
  uniform float uAudioLevel;
  uniform vec2  uParallaxShift;
  uniform float uPoseDistort;
  uniform vec2  uJoints[2];     // only wrists

  varying vec2 vUv;

  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  // Cover UV: image fills screen, excess is cropped (no letterbox, no stretch)
  vec2 coverUv(vec2 uv) {
    vec2 c = uv - 0.5;
    if (uScreenAspect > uImgAspect) {
      // Screen wider than image — fit to width, crop top/bottom
      c.y *= uImgAspect / uScreenAspect;
    } else {
      // Screen taller than image — fit to height, crop left/right
      c.x *= uScreenAspect / uImgAspect;
    }
    return c + 0.5;
  }

  vec2 rotateUv90(vec2 uv, float r) {
    if (r < 0.5)  return uv;
    if (r < 1.5)  return vec2(1.0 - uv.y, uv.x);
    if (r < 2.5)  return vec2(1.0 - uv.x, 1.0 - uv.y);
                  return vec2(uv.y, 1.0 - uv.x);
  }

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
    return vec3(hueHelper(p, q, c.x + 1.0/3.0), hueHelper(p, q, c.x), hueHelper(p, q, c.x - 1.0/3.0));
  }

  void main() {
    vec2 uv = vUv;

    // 1. Cover (crop to fill screen, no stretch)
    uv = coverUv(uv);

    // 2. Rotation
    uv = rotateUv90(uv, uRotation);

    // 3. Parallax (pose-driven, wrists only)
    uv += uParallaxShift;

    // 4. Drift
    if (uDrift > 0.001) {
      float dx = uDrift * 0.018 * sin(uTime * 0.14 + uv.y * 2.8);
      float dy = uDrift * 0.018 * cos(uTime * 0.11 + uv.x * 3.1);
      uv += vec2(dx, dy);
    }

    // 5. Ripple
    if (uRipple > 0.001) {
      float r = uRipple * 0.012 * sin(uv.x * 9.0 + uTime * 1.1) * cos(uv.y * 7.0 + uTime * 0.8);
      uv += vec2(r);
    }

    // 6. Pose distort (wrists push UV outward)
    if (uPoseDistort > 0.001) {
      for (int i = 0; i < 2; i++) {
        vec2 j = uJoints[i];
        if (j.x < 0.01 && j.y < 0.01) continue;
        vec2 diff = uv - j;
        float d2 = dot(diff, diff);
        float push = 0.002 / (d2 + 0.05);
        uv += normalize(diff) * push;
      }
    }

    vec2 clampedUv = clamp(uv, 0.0, 1.0);

    // 7. Chromatic aberration
    vec3 col;
    if (uChromaticAb > 0.001) {
      vec2 ab = (uv - 0.5) * uChromaticAb * 0.028;
      col.r = texture2D(uTexture, clamp(uv + ab, 0.0, 1.0)).r;
      col.g = texture2D(uTexture, clampedUv).g;
      col.b = texture2D(uTexture, clamp(uv - ab, 0.0, 1.0)).b;
    } else {
      col = texture2D(uTexture, clampedUv).rgb;
    }

    // 8. Saturation
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, uSaturation);

    // 9. Brightness
    col *= uBrightness;

    // 10. Palette colorize (hue shift toward selected custom color)
    if (uColorize > 0.001) {
      vec3 imgHsl = rgb2hsl(col);
      vec3 palHsl = rgb2hsl(uPaletteColor);
      float newH = mix(imgHsl.x, palHsl.x, uColorize);
      float newS = mix(imgHsl.y, max(palHsl.y, 0.3), uColorize * 0.9);
      col = hsl2rgb(vec3(newH, newS, imgHsl.z));
    }

    // 11. Manual tint overlay
    if (uTintStrength > 0.001) {
      col = mix(col, uTint * luma * 2.0, uTintStrength);
    }

    // 12. Edge pulse
    if (uEdgePulse > 0.001) {
      float px = 1.5 / 1024.0;
      float lC = dot(texture2D(uTexture, clampedUv).rgb,                                   vec3(0.299, 0.587, 0.114));
      float lR = dot(texture2D(uTexture, clamp(clampedUv + vec2(px,  0.0), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
      float lU = dot(texture2D(uTexture, clamp(clampedUv + vec2(0.0, px),  0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
      float lL = dot(texture2D(uTexture, clamp(clampedUv - vec2(px,  0.0), 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
      float lD = dot(texture2D(uTexture, clamp(clampedUv - vec2(0.0, px),  0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
      float edge = abs(lC - lR) + abs(lC - lU) + abs(lC - lL) + abs(lC - lD);
      edge = smoothstep(0.02, 0.12, edge);
      float pulse = (0.5 + 0.5 * sin(uTime * 2.5)) * (1.0 + uAudioLevel * 2.0);
      col += edge * uEdgePulse * pulse * uPaletteColor;
    }

    // 13. Mic flash (boost bright pixels)
    if (uAudioLevel > 0.001) {
      col += uAudioLevel * luma * 0.55;
    }

    // 14. Vignette — at low values subtle edge softening, at 1 edges are pure black
    if (uVignette > 0.001) {
      vec2 vigUv = vUv * 2.0 - 1.0;
      float dist2 = dot(vigUv, vigUv);
      // At low strength: gentle rolloff starting near the very edge
      // At high strength: hard black edges (projection masking)
      float falloff = mix(0.1, 0.9, uVignette);   // how far from center the darkening starts
      float power   = mix(0.4, 5.0, uVignette);    // how hard the rolloff is
      float vig = 1.0 - smoothstep(1.0 - falloff, 1.0, dist2);
      vig = pow(max(vig, 0.0), power);
      col *= vig;
    }

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeImagePattern(id: string, name: string, src: string): Pattern {
  // Image section
  let imgOn        = true;
  let saturation   = 1.0;
  let brightness   = 1.0;
  let hueShift     = 0.0;
  let colorize     = 0.0;
  let tintColor    = '#ffffff';
  let tintStrength = 0.0;
  let rotation     = 0;

  // Style section
  let styleOn      = true;
  let vignette     = 0.0;
  let chromaticAb  = 0.0;
  let edgePulse    = 0.0;

  // Motion section
  let motionOn     = true;
  let drift        = 0.0;
  let ripple       = 0.0;

  let mesh: THREE.Mesh | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let geometry: THREE.PlaneGeometry | null = null;
  let texture: THREE.Texture | null = null;
  let imgAspect    = 1.0;
  let screenAspect = 1.0;
  let palette: THREE.Color[] = loadPalette();
  let paletteAge   = 0;

  // Only wrists (indices 0 and 1 in poseState.persons[i])
  const wristJoints = [new THREE.Vector2(0, 0), new THREE.Vector2(0, 0)];

  return {
    id,
    name,
    usesPose: true,
    motionControlLabels: [],

    controls: [
      // ── Motion ───────────────────────────────────────────────────────
      { label: 'Motion',      type: 'section', get: () => motionOn, set: v => { motionOn = v; } },
      { label: 'Drift',       type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => drift,  set: v => { drift = v; } },
      { label: 'Ripple',      type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => ripple, set: v => { ripple = v; } },

      // ── Image ────────────────────────────────────────────────────────
      { label: 'Image',       type: 'section', get: () => imgOn,   set: v => { imgOn = v; } },
      { label: 'Saturation',  type: 'range', min: 0,    max: 2,  step: 0.05, default: 1.0, get: () => saturation,   set: v => { saturation = v; } },
      { label: 'Brightness',  type: 'range', min: 0.75, max: 2,  step: 0.05, default: 1.0, get: () => brightness,   set: v => { brightness = v; } },
      { label: 'Hue Shift',   type: 'range', min: 0,    max: 1,  step: 0.01, default: 0.0, get: () => hueShift,     set: v => { hueShift = v; } },
      { label: 'Colorize',    type: 'range', min: 0,    max: 1,  step: 0.05, default: 0.0, get: () => colorize,     set: v => { colorize = v; } },
      { label: 'Tint',        type: 'color',                                 default: '#ffffff', get: () => tintColor,    set: v => { tintColor = v; } } as never,
      { label: 'Tint Strength', type: 'range', min: 0,  max: 1,  step: 0.05, default: 0.0, get: () => tintStrength, set: v => { tintStrength = v; } },
      { label: 'Rotate 90°',  type: 'button', action: () => { rotation = (rotation + 1) % 4; } },

      // ── Style ────────────────────────────────────────────────────────
      { label: 'Style',       type: 'section', get: () => styleOn, set: v => { styleOn = v; } },
      { label: 'Vignette',    type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => vignette,   set: v => { vignette = v; } },
      { label: 'Chromatic AB', type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => chromaticAb, set: v => { chromaticAb = v; } },
      { label: 'Edge Pulse',  type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => edgePulse,  set: v => { edgePulse = v; } },
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
          uRipple:       { value: ripple },
          uChromaticAb:  { value: chromaticAb },
          uEdgePulse:    { value: edgePulse },
          uAudioLevel:   { value: 0 },
          uParallaxShift: { value: new THREE.Vector2(0, 0) },
          uPoseDistort:  { value: 0 },
          uJoints:       { value: wristJoints },
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

      paletteAge += dt;
      if (paletteAge > 2) { palette = loadPalette(); paletteAge = 0; }

      const pc = paletteColorAt(palette, hueShift);
      const u = material.uniforms;

      u.uTime.value         = elapsed;
      u.uSaturation.value   = imgOn ? saturation : 1.0;
      u.uBrightness.value   = imgOn ? brightness : 1.0;
      u.uPaletteColor.value.set(pc.r, pc.g, pc.b);
      u.uColorize.value     = imgOn ? colorize : 0;
      u.uTint.value.set(tintColor);
      u.uTintStrength.value = imgOn ? tintStrength : 0;
      u.uRotation.value     = rotation;

      u.uVignette.value     = styleOn ? vignette : 0;
      u.uChromaticAb.value  = styleOn ? chromaticAb : 0;
      u.uEdgePulse.value    = styleOn ? edgePulse : 0;

      u.uDrift.value        = motionOn ? drift : 0;
      u.uRipple.value       = motionOn ? ripple : 0;

      u.uAudioLevel.value = audioState.enabled ? audioState.level / 100 : 0;

      // Pose: use left + right wrist only (indices 0 and 1)
      if (poseState.active && poseState.persons.length > 0) {
        const person = poseState.persons[0];
        const lw = person[0]; // left wrist
        const rw = person[1]; // right wrist

        if (lw && rw) {
          // Parallax from average wrist position (arms raised = parallax shift)
          const wx = (lw.x + rw.x) / 2;
          const wy = (lw.y + rw.y) / 2;
          u.uParallaxShift.value.set((wx - 0.5) * 0.06, (wy - 0.5) * -0.06);
        } else if (lw) {
          u.uParallaxShift.value.set((lw.x - 0.5) * 0.06, (lw.y - 0.5) * -0.06);
        } else if (rw) {
          u.uParallaxShift.value.set((rw.x - 0.5) * 0.06, (rw.y - 0.5) * -0.06);
        }

        // Distort: wrist positions only
        wristJoints[0].set(lw ? lw.x : 0, lw ? lw.y : 0);
        wristJoints[1].set(rw ? rw.x : 0, rw ? rw.y : 0);
        u.uPoseDistort.value = 1.0;
      } else {
        u.uParallaxShift.value.set(0, 0);
        u.uPoseDistort.value = 0;
        wristJoints[0].set(0, 0);
        wristJoints[1].set(0, 0);
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
