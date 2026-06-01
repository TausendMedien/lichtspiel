import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.SphereGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let hue          = 0.6;   // 0–1 full hue cycle
let saturation   = 0.8;
let fresnelStr   = 1.4;
let rotationSpeed = 0.5;
let brightness   = 1.1;
let facets       = 1;     // select index → 8, 16, 32, 64 segments

let rotX = 0, rotY = 0, rotZ = 0;

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
  uniform float uHue;
  uniform float uSaturation;
  uniform float uFresnel;
  uniform float uBrightness;

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
    float h1 = remapHue(uHue + up * 0.15);
    float h2 = remapHue(uHue + 0.5 + side * 0.2);
    vec3 col1 = hsv2rgb(vec3(h1, uSaturation, 0.9));
    vec3 col2 = hsv2rgb(vec3(h2, uSaturation * 0.6, 0.5));

    // Blend based on viewing angle to simulate internal reflections
    float facetAngle = abs(dot(vNormal, vViewDir));
    vec3 col = mix(col2, col1, smoothstep(0.1, 0.7, facetAngle));

    // Fresnel rim glow
    float fresnel = pow(1.0 - max(0.0, dot(vNormal, vViewDir)), 3.0);
    vec3 rimColor = hsv2rgb(vec3(fract(uHue + 0.15), 0.4, 1.0));
    col = mix(col, rimColor, fresnel * uFresnel * 0.6);

    // Specular highlight
    vec3 lightDir = normalize(vec3(0.5, 1.0, 0.8));
    float spec = pow(max(0.0, dot(reflect(-lightDir, vNormal), vViewDir)), 64.0);
    col += vec3(spec * 0.8);

    col *= uBrightness;
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
  controls: [
    { label: "Hue",        type: "range",  min: 0.0, max: 1.0, step: 0.01, default: 0.6,  get: () => hue,          set: (v) => { hue = v; } },
    { label: "Saturation", type: "range",  min: 0.0, max: 1.0, step: 0.05, default: 0.8,  get: () => saturation,   set: (v) => { saturation = v; } },
    { label: "Fresnel",    type: "range",  min: 0.0, max: 3.0, step: 0.1,  default: 1.4,  get: () => fresnelStr,   set: (v) => { fresnelStr = v; } },
    { label: "Brightness", type: "range",  min: 0.2, max: 2.0, step: 0.05, default: 1.1,  get: () => brightness,   set: (v) => { brightness = v; } },
    { label: "Rotation",   type: "range",  min: 0.0, max: 2.0, step: 0.05, default: 0.5,  get: () => rotationSpeed, set: (v) => { rotationSpeed = v; } },
    { label: "Facets",     type: "select", options: ["8", "16", "32", "64"],
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
  ],

  init(ctx: PatternContext) {
    geometry = buildGeometry();
    material = new THREE.ShaderMaterial({
      uniforms: {
        uHue:        { value: hue },
        uSaturation: { value: saturation },
        uFresnel:    { value: fresnelStr },
        uBrightness: { value: brightness },
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
    rotY += dt * rotationSpeed * 0.3;
    rotX += dt * rotationSpeed * 0.1;
    rotZ += dt * rotationSpeed * 0.2;
    mesh.rotation.set(rotX, rotY, rotZ);
    material.uniforms.uHue.value        = hue;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uFresnel.value    = fresnelStr;
    material.uniforms.uBrightness.value = brightness;
  },

  resize(_width: number, _height: number) {},

  dispose() {
    geometry?.dispose(); material?.dispose();
    mesh = null; geometry = null; material = null;
    rotX = 0; rotY = 0; rotZ = 0;
  },
};
