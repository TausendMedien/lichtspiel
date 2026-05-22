import * as THREE from 'three';
import type { Pattern, PatternContext } from './types';
import { poseState } from '../pose';
import { audioState } from '../globalAudioSettings.svelte';

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
  uniform float uRotation;       // 0/1/2/3 × 90°
  uniform float uImgAspect;
  uniform float uScreenAspect;
  uniform float uVignette;       // 0-1
  uniform float uDrift;          // 0-1
  uniform float uZoomBreathe;    // 0-1
  uniform float uRipple;         // 0-1
  uniform float uChromaticAb;    // 0-1
  uniform float uEdgePulse;      // 0-1
  uniform float uAudioLevel;     // 0-1
  uniform vec2  uParallaxShift;  // from pose centroid
  uniform float uPoseDistort;    // 0-1
  uniform vec2  uJoints[8];
  uniform float uFitMode;        // 0=cover, 1=fitWidth

  varying vec2 vUv;

  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  vec2 coverUv(vec2 uv) {
    vec2 c = uv - 0.5;
    if (uFitMode > 0.5 && uScreenAspect < uImgAspect) {
      // Fit width: show full image width, scale y to maintain aspect ratio.
      // y will tile outside [0,1] — handled at sampling time with mod().
      c.y *= uImgAspect / uScreenAspect;
    } else if (uScreenAspect > uImgAspect) {
      c.y *= uImgAspect / uScreenAspect;
    } else {
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

    // 9. Luma (needed for audio flash)
    float luma = dot(col, vec3(0.299, 0.587, 0.114));

    // 10. Edge pulse (Sobel-ish, pulsed by time + audio)
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
      col += edge * uEdgePulse * pulse;
    }

    // 14. Mic flash (luminance-masked brightness boost)
    if (uAudioLevel > 0.001) {
      col += uAudioLevel * luma * 0.55;
    }

    // 15. Vignette — Gaussian falloff; higher slider = extends further from corners inward.
    // Uses dist^4 so corners darken much faster than edges (rectangular feel).
    if (uVignette > 0.001) {
      vec2 uv = (vUv - 0.5) * 2.0;   // center 0, edges ±1, corners ±√2
      float d2 = dot(uv, uv);         // 0→center, 1→mid-edge, 2→corner
      float vig = exp(-d2 * d2 * uVignette);
      col *= vig;
    }

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeImagePattern(id: string, name: string, src: string, fitMode: 'cover' | 'fitWidth' = 'cover'): Pattern {
  let rotation     = 0;     // 0/1/2/3

  let drift        = 0.0;
  let zoomBreathe  = 0.0;
  let ripple       = 0.0;

  let vignette     = 0.0;
  let motionOn     = false;
  let styleOn      = false;
  let chromaticAb  = 0.0;
  let edgePulse    = 0.0;

  let mesh: THREE.Mesh | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let geometry: THREE.PlaneGeometry | null = null;
  let texture: THREE.Texture | null = null;
  let imgAspect    = 1.0;
  let screenAspect = 1.0;

  const joints = Array.from({ length: 8 }, () => new THREE.Vector2(0, 0));

  return {
    id,
    name,
    usesPose: true,
    motionControlLabels: [],
    colorDefaults: { saturation: 1.0, brightness: 1.20 },
    defaultCollapsedSections: ['Motion', 'Style'],

    controls: [
      // ── Image section ────────────────────────────────────────────────
      { label: 'Image', type: 'section', get: () => true, set: () => {} },
      { label: 'Rotate 90°',  type: 'button', action: () => { rotation = (rotation + 1) % 4; } },

      // ── Motion section ───────────────────────────────────────────────
      { label: 'Motion', type: 'section', get: () => motionOn, set: (v: boolean) => { motionOn = v; } },
      { label: 'Drift',        type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => drift,       set: v => { drift = v; } },
      { label: 'Zoom Breathe', type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => zoomBreathe, set: v => { zoomBreathe = v; } },
      { label: 'Ripple',       type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => ripple,      set: v => { ripple = v; } },

      // ── Style section ────────────────────────────────────────────────
      { label: 'Style', type: 'section', get: () => styleOn, set: (v: boolean) => { styleOn = v; } },
      { label: 'Vignette',     type: 'range', min: 0, max: 3, step: 0.1,  default: 0.0, get: () => vignette,   set: v => { vignette = v; } },
      { label: 'Chromatic AB', type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => chromaticAb, set: v => { chromaticAb = v; } },
      { label: 'Edge Pulse',   type: 'range', min: 0, max: 1, step: 0.05, default: 0.0, get: () => edgePulse,  set: v => { edgePulse = v; } },
    ],

    init(ctx: PatternContext) {
      screenAspect = ctx.size.width / Math.max(1, ctx.size.height);

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
          uRotation:     { value: rotation },
          uImgAspect:    { value: imgAspect },
          uScreenAspect: { value: screenAspect },
          uVignette:     { value: vignette },
          uDrift:        { value: drift },
          uZoomBreathe:  { value: zoomBreathe },
          uRipple:       { value: ripple },
          uChromaticAb:  { value: chromaticAb },
          uEdgePulse:    { value: edgePulse },
          uAudioLevel:   { value: 0 },
          uParallaxShift: { value: new THREE.Vector2(0, 0) },
          uPoseDistort:  { value: 0 },
          uJoints:       { value: joints },
          uFitMode:      { value: fitMode === 'fitWidth' ? 1.0 : 0.0 },
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

      const u = material.uniforms;

      u.uTime.value          = elapsed;
      u.uRotation.value      = rotation;
      u.uVignette.value      = styleOn  ? vignette    : 0;
      u.uDrift.value         = motionOn ? drift        : 0;
      u.uZoomBreathe.value   = motionOn ? zoomBreathe  : 0;
      u.uRipple.value        = motionOn ? ripple       : 0;
      u.uChromaticAb.value   = styleOn  ? chromaticAb : 0;
      u.uEdgePulse.value     = styleOn  ? edgePulse   : 0;

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
