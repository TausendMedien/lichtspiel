import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";
import { cameraState } from "../globalCameraSettings.svelte";

const W = 160, H = 90;

let mesh: THREE.Mesh | null = null;
let geometry: THREE.SphereGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let fresnelStr   = 1.4;
let rotationSpeed = 0.5;
let facets       = 1;     // select index → 8, 16, 32, 64 segments

let rotX = 0, rotY = 0, rotZ = 0;

// Heat state
let heatTiltStrength = 1.0;
let heatSpinBoost    = 1.0;
let heatYawOffset    = 0;
let heatTiltOffset   = 0;

function computeHeatCentroid(): { cx: number; cy: number } {
  const map = cameraState.heatMap;
  let wx = 0, wy = 0, total = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = map[y * W + x];
      wx += v * x; wy += v * y; total += v;
    }
  return total > 0.01
    ? { cx: wx / total / W, cy: wy / total / H }
    : { cx: 0.5, cy: 0.5 };
}

function facetSegments(idx: number): number {
  return [8, 16, 32, 64][idx] ?? 16;
}

const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vViewDir  = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  uniform float uFresnel;
  uniform float uColorsV2;
  uniform vec3  uMainColor;

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  // Remap [0,1] hue to skip the green zone [0.20, 0.45]
  // → warm reds/oranges/yellows (0–0.20) then cyan/blues/violets/magentas (0.45–1.0)
  float remapHue(float h) {
    float t = fract(h) * 0.75;          // squeeze into 75 % of the wheel
    return t < 0.20 ? t : t + 0.25;    // shift up past the green gap
  }

  void main() {
    // Flat (per-face) normal via screen-space derivatives — creates the faceted gem look
    vec3 vNormal = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));

    // Fake environment: map normal to gradient
    float up   = dot(vNormal, vec3(0.0, 1.0, 0.0)) * 0.5 + 0.5;
    float side = dot(vNormal, vec3(1.0, 0.0, 0.0)) * 0.5 + 0.5;

    // Primary gem color — green zone excluded via remapHue
    float h1 = remapHue(0.6 + up * 0.15);
    float h2 = remapHue(0.6 + 0.5 + side * 0.2);
    vec3 col1 = hsv2rgb(vec3(h1, 1.0, 0.9));
    vec3 col2 = hsv2rgb(vec3(h2, 0.6, 0.5));

    // Blend based on viewing angle to simulate internal reflections
    float facetAngle = abs(dot(vNormal, vViewDir));
    vec3 col = mix(col2, col1, smoothstep(0.1, 0.7, facetAngle));

    // Fresnel rim glow
    float fresnel = pow(1.0 - max(0.0, dot(vNormal, vViewDir)), 3.0);
    vec3 rimColor = hsv2rgb(vec3(fract(0.6 + 0.15), 0.4, 1.0));
    col = mix(col, rimColor, fresnel * uFresnel * 0.6);

    // Specular highlight
    vec3 lightDir = normalize(vec3(0.5, 1.0, 0.8));
    float spec = pow(max(0.0, dot(reflect(-lightDir, vNormal), vViewDir)), 64.0);
    col += vec3(spec * 0.8);

    vec3 _orig = col;
    float _luma = dot(_orig, vec3(0.299, 0.587, 0.114));
    float _ph1 = clamp(uColorsV2, 0.0, 1.0);
    float _ph2 = clamp((uColorsV2 - 1.0) / 2.0, 0.0, 1.0);
    col = mix(mix(vec3(_luma), uMainColor * (0.2 + _luma * 0.8), _ph1), _orig, _ph2);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

function buildGeometry() {
  const segs = facetSegments(facets);
  const geo  = new THREE.SphereGeometry(1, segs, segs);
  // Compute flat (per-face) normals for the faceted crystal look
  geo.computeVertexNormals();
  return geo;
}

export const crystalGem: Pattern = {
  id: "crystalGem",
  name: "Crystal Gem",
  attribution: "Inspired by Mauricio Massaia — proto-07",
  heatReactive: true,
  controls: [
    { label: "Fresnel",  type: "range",  min: 0.0, max: 3.0, step: 0.1,  default: 1.4,  tip: "Edge glow intensity — brighter rim at glancing angles. 0 = flat, 3 = strong halo.", get: () => fresnelStr,    set: (v) => { fresnelStr = v; } },
    { label: "Rotation", type: "range",  min: 0.0, max: 2.0, step: 0.05, default: 0.5,  tip: "How fast the gem spins.",                                                             get: () => rotationSpeed, set: (v) => { rotationSpeed = v; } },
    { label: "Facets",   type: "select", options: ["8", "16", "32", "64"], tip: "Number of polygon faces. More = rounder gem, heavier on GPU.",
      get: () => facets,
      set: (v) => {
        facets = v;
        if (mesh && geometry) {
          geometry.dispose();
          geometry = buildGeometry();
          mesh.geometry = geometry;
        }
      },
    },
    { label: "Tilt Strength", type: "range", min: 0, max: 2, step: 0.1, default: 1.0, interactive: 'heat' as const, tip: "How much heat-map motion tilts the gem. Requires Heat.",                           get: () => heatTiltStrength, set: v => { heatTiltStrength = v; } },
    { label: "Spin Boost",    type: "range", min: 0, max: 3, step: 0.1, default: 1.0, interactive: 'heat' as const, tip: "Extra spin speed when heat-map motion is detected. Requires Heat.",                get: () => heatSpinBoost,    set: v => { heatSpinBoost = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = buildGeometry();
    material = new THREE.ShaderMaterial({
      uniforms: {
        uFresnel:   { value: fresnelStr },
        uColorsV2:  { value: colorC2.colorsV2 },
        uMainColor: { value: new THREE.Vector3() },
      },
      vertexShader, fragmentShader,
    });
    mesh = new THREE.Mesh(geometry, material);
    ctx.scene.add(mesh);
    ctx.camera.position.set(0, 0, 2.5);
    ctx.camera.near = 0.1;
    ctx.camera.far  = 100;
    ctx.camera.updateProjectionMatrix();
  },

  update(dt: number, _elapsed: number) {
    if (!material || !mesh) return;

    const speed = Math.min(1, dt * 2.5);
    if (cameraState.heatEnabled) {
      const { cx, cy } = computeHeatCentroid();
      const targetYaw  = (0.5 - cx) * Math.PI * 0.7 * heatTiltStrength;
      const targetTilt = (cy - 0.5) * 0.4 * heatTiltStrength;
      heatYawOffset  += (targetYaw  - heatYawOffset)  * speed;
      heatTiltOffset += (targetTilt - heatTiltOffset) * speed;
      const intensity = cameraState.level / 100;
      const spinMult  = 1 + intensity * heatSpinBoost;
      rotY += dt * rotationSpeed * 0.3 * spinMult;
      rotX += dt * rotationSpeed * 0.1 * spinMult;
      rotZ += dt * rotationSpeed * 0.2 * spinMult;
    } else {
      heatYawOffset  *= Math.max(0, 1 - dt * 3);
      heatTiltOffset *= Math.max(0, 1 - dt * 3);
      rotY += dt * rotationSpeed * 0.3;
      rotX += dt * rotationSpeed * 0.1;
      rotZ += dt * rotationSpeed * 0.2;
    }

    mesh.rotation.set(rotX + heatTiltOffset, rotY + heatYawOffset, rotZ);
    material.uniforms.uFresnel.value = fresnelStr;
    const _mc = new THREE.Color(colorC2.main);
    material.uniforms.uMainColor.value.set(_mc.r, _mc.g, _mc.b);
    material.uniforms.uColorsV2.value = colorC2.colorsV2;
  },

  resize(_width: number, _height: number) {},

  dispose() {
    geometry?.dispose(); material?.dispose();
    mesh = null; geometry = null; material = null;
    rotX = 0; rotY = 0; rotZ = 0;
    heatYawOffset = 0; heatTiltOffset = 0;
  },
};
