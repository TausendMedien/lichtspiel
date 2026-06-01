import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

// Each line rendered as a screen-space quad (2 triangles) for real pixel-width control.
// A second glow-points pass adds per-particle blur and size variation like Particle Field.

let lineCount  = 1000;
let brightness = 0.55;
let flowSpeed  = 0.1;
let colorRange = 1.0;
let saturation = 1.0;
let tailLength = 4.0;
let lineWidth  = 4.0;  // pixels

let lineMesh:   THREE.Mesh   | null = null;
let glowPoints: THREE.Points | null = null;
let lineGeo:  THREE.BufferGeometry | null = null;
let glowGeo:  THREE.BufferGeometry | null = null;
let lineMat:  THREE.ShaderMaterial | null = null;
let glowMat:  THREE.ShaderMaterial | null = null;
let camera:   THREE.PerspectiveCamera | null = null;
let sceneRef: THREE.Scene | null = null;
let accTime = 0;
let needsRebuild = false;
let vpWidth = 1, vpHeight = 1;

// ─── Shared flow field ────────────────────────────────────────────────────────
const FLOW_GLSL = /* glsl */ `
  vec3 _flow(vec3 p, float t) {
    float a = sin(p.y * 0.7 + t * 0.4) + cos(p.z * 0.6 - t * 0.3);
    float b = sin(p.z * 0.5 - t * 0.35) + cos(p.x * 0.7 + t * 0.25);
    float c = sin(p.x * 0.6 + t * 0.5) + cos(p.y * 0.5 - t * 0.4);
    return vec3(a, b, c);
  }
  vec3 _animPt(vec3 pos, float seed, float t) {
    vec3 p = pos + _flow(pos * 0.5 + seed, t) * 0.6;
    float ang = t * 0.05 + seed * 0.0002;
    float cs = cos(ang), sn = sin(ang);
    p.xz = mat2(cs, -sn, sn, cs) * p.xz;
    return p;
  }
`;

// ─── Fat line shaders ─────────────────────────────────────────────────────────
// Each vertex knows its own base position and the other endpoint's base position.
// Both are animated in the vertex shader so the quad stays aligned with the
// animated line direction. The perpendicular offset is computed in screen space
// so lineWidth means actual pixels regardless of depth.
const lineVertShader = /* glsl */ `
  uniform float uTime;
  uniform float uLineWidth;
  uniform vec2  uResolution;
  attribute vec3  aOtherPos;
  attribute float aSeed;
  attribute float aOtherSeed;
  attribute float aSide;
  varying float vSeed;

  ${FLOW_GLSL}

  void main() {
    vSeed = aSeed;

    vec3 thisWorld  = _animPt(position,  aSeed,       uTime);
    vec3 otherWorld = _animPt(aOtherPos, aOtherSeed,  uTime);

    vec4 clipThis  = projectionMatrix * modelViewMatrix * vec4(thisWorld,  1.0);
    vec4 clipOther = projectionMatrix * modelViewMatrix * vec4(otherWorld, 1.0);

    // Direction in NDC → pixel space (so aspect ratio is handled correctly)
    vec2 ndcDir = (clipOther.xy / clipOther.w) - (clipThis.xy / clipThis.w);
    vec2 pxDir  = vec2(ndcDir.x * uResolution.x, ndcDir.y * uResolution.y);
    if (length(pxDir) < 0.0001) pxDir = vec2(0.0, 1.0);
    pxDir = normalize(pxDir);

    // Perpendicular in pixel space → back to NDC → clip space offset
    vec2 pxPerp  = vec2(-pxDir.y, pxDir.x);
    vec2 ndcPerp = vec2(pxPerp.x / uResolution.x, pxPerp.y / uResolution.y);
    vec2 offset  = ndcPerp * uLineWidth * aSide * clipThis.w;

    gl_Position    = clipThis;
    gl_Position.xy += offset;
  }
`;

const lineFragShader = /* glsl */ `
  uniform float uColorRange;
  uniform float uSaturation;
  uniform float uBrightness;
  varying float vSeed;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    float hue = 0.5 + fract(vSeed * uColorRange) * 0.33;
    vec3  col = hsl2rgb(hue, 1.0, 0.6);
    // sat=0 → white at full brightness; avoids desaturating to mid-gray
    vec3  white = vec3(uBrightness);
    col = mix(white, col, uSaturation);
    gl_FragColor = vec4(col, uBrightness);
  }
`;

// ─── Glow-point shaders ───────────────────────────────────────────────────────
// One soft radial point per line-head. Size varies per seed (like Particle Field)
// giving the "blurry, different sizes" look.
const glowVertShader = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  attribute float aSeed;
  varying float vSeed;

  ${FLOW_GLSL}

  void main() {
    vSeed = aSeed;
    vec3 p  = _animPt(position, aSeed, uTime);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Vary size per particle using seed so each line-head looks different
    float sizeVar = 0.5 + fract(aSeed * 7.317) * 1.5;
    gl_PointSize  = uSize * sizeVar * (6.0 / -mv.z);
  }
`;

const glowFragShader = /* glsl */ `
  uniform float uColorRange;
  uniform float uSaturation;
  uniform float uBrightness;
  varying float vSeed;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, d) * uBrightness * 0.45;

    float hue = 0.5 + fract(vSeed * uColorRange) * 0.33;
    vec3  col = hsl2rgb(hue, 1.0, 0.7);
    vec3  white = vec3(uBrightness);
    col = mix(white, col, uSaturation);
    gl_FragColor = vec4(col, alpha);
  }
`;

// ─── Geometry builder ─────────────────────────────────────────────────────────
function buildGeometry() {
  if (lineMesh  && sceneRef) sceneRef.remove(lineMesh);
  if (glowPoints && sceneRef) sceneRef.remove(glowPoints);
  lineGeo?.dispose();
  glowGeo?.dispose();

  const N = lineCount;
  // 4 vertices per line (HL, HR, TL, TR), 6 indices per line
  const positions  = new Float32Array(N * 4 * 3);
  const otherPos   = new Float32Array(N * 4 * 3);
  const seeds      = new Float32Array(N * 4);
  const otherSeeds = new Float32Array(N * 4);
  const sides      = new Float32Array(N * 4);
  const indices    = new Uint32Array(N * 6);

  // Glow: one point per line-head
  const glowPositions = new Float32Array(N * 3);
  const glowSeeds     = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const r     = Math.cbrt(Math.random()) * 4;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const hx = r * Math.sin(phi) * Math.cos(theta);
    const hy = r * Math.sin(phi) * Math.sin(theta);
    const hz = r * Math.cos(phi);
    const headSeed = Math.random();

    const tx = hx + (Math.random() - 0.5) * tailLength;
    const ty = hy + (Math.random() - 0.5) * tailLength;
    const tz = hz + (Math.random() - 0.5) * tailLength;
    const tailSeed = headSeed + 0.0001;

    // Layout: base=i*4  → HL(+0), HR(+1), TL(+2), TR(+3)
    const b = i * 4;
    // HL
    positions[b*3]=hx; positions[b*3+1]=hy; positions[b*3+2]=hz;
    otherPos[b*3]=tx;  otherPos[b*3+1]=ty;  otherPos[b*3+2]=tz;
    seeds[b]=headSeed; otherSeeds[b]=tailSeed; sides[b]=-1.0;
    // HR
    positions[(b+1)*3]=hx; positions[(b+1)*3+1]=hy; positions[(b+1)*3+2]=hz;
    otherPos[(b+1)*3]=tx;  otherPos[(b+1)*3+1]=ty;  otherPos[(b+1)*3+2]=tz;
    seeds[b+1]=headSeed; otherSeeds[b+1]=tailSeed; sides[b+1]=+1.0;
    // TL
    positions[(b+2)*3]=tx; positions[(b+2)*3+1]=ty; positions[(b+2)*3+2]=tz;
    otherPos[(b+2)*3]=hx;  otherPos[(b+2)*3+1]=hy;  otherPos[(b+2)*3+2]=hz;
    seeds[b+2]=tailSeed; otherSeeds[b+2]=headSeed; sides[b+2]=-1.0;
    // TR
    positions[(b+3)*3]=tx; positions[(b+3)*3+1]=ty; positions[(b+3)*3+2]=tz;
    otherPos[(b+3)*3]=hx;  otherPos[(b+3)*3+1]=hy;  otherPos[(b+3)*3+2]=hz;
    seeds[b+3]=tailSeed; otherSeeds[b+3]=headSeed; sides[b+3]=+1.0;

    // Indices: HL,HR,TL, HR,TR,TL
    const ii = i * 6;
    indices[ii]=b; indices[ii+1]=b+1; indices[ii+2]=b+2;
    indices[ii+3]=b+1; indices[ii+4]=b+3; indices[ii+5]=b+2;

    // Glow point at head
    glowPositions[i*3]=hx; glowPositions[i*3+1]=hy; glowPositions[i*3+2]=hz;
    glowSeeds[i]=headSeed;
  }

  lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position",   new THREE.BufferAttribute(positions,  3));
  lineGeo.setAttribute("aOtherPos",  new THREE.BufferAttribute(otherPos,   3));
  lineGeo.setAttribute("aSeed",      new THREE.BufferAttribute(seeds,      1));
  lineGeo.setAttribute("aOtherSeed", new THREE.BufferAttribute(otherSeeds, 1));
  lineGeo.setAttribute("aSide",      new THREE.BufferAttribute(sides,      1));
  lineGeo.setIndex(new THREE.BufferAttribute(indices, 1));

  glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
  glowGeo.setAttribute("aSeed",    new THREE.BufferAttribute(glowSeeds,     1));

  if (lineMat && sceneRef) {
    lineMesh = new THREE.Mesh(lineGeo, lineMat);
    sceneRef.add(lineMesh);
  }
  if (glowMat && sceneRef) {
    glowPoints = new THREE.Points(glowGeo, glowMat);
    sceneRef.add(glowPoints);
  }
}

export const particleLines: Pattern = {
  id: "particleLines",
  name: "Particle Lines",
  controls: [
    { label: "Brightness",  type: "range", min: 0.05, max: 1.0,  step: 0.05, default: 0.55, get: () => brightness, set: (v) => { brightness = v; } },
    { label: "Flow Speed",  type: "range", min: 0.0,  max: 3.0,  step: 0.05, default: 0.1,  get: () => flowSpeed,  set: (v) => { flowSpeed  = v; } },
    { label: "Line Count",  type: "range", min: 50,   max: 2000, step: 50,   default: 1000, get: () => lineCount,  set: (v) => { lineCount  = v; needsRebuild = true; } },
    { label: "Line Width",  type: "range", min: 0.5,  max: 6.0,  step: 0.5,  default: 4.0,  get: () => lineWidth,  set: (v) => { lineWidth  = v; } },
    { label: "Tail Length", type: "range", min: 0.1,  max: 12.0, step: 0.1,  default: 4.0,  get: () => tailLength, set: (v) => { tailLength = v; needsRebuild = true; } },
    { label: "Colors",      type: "range", min: 0.0,  max: 1.0,  step: 0.05, default: 1.0,  get: () => colorRange, set: (v) => { colorRange = v; } },
    { label: "Saturation",  type: "range", min: 0.0,  max: 1.0,  step: 0.05, default: 1.0,  get: () => saturation, set: (v) => { saturation = v; } },
  ],

  init(ctx: PatternContext) {
    camera   = ctx.camera;
    sceneRef = ctx.scene;
    vpWidth  = ctx.size.width;
    vpHeight = ctx.size.height;
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);
    needsRebuild = false;

    lineMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uLineWidth:  { value: lineWidth },
        uResolution: { value: new THREE.Vector2(vpWidth, vpHeight) },
        uColorRange: { value: colorRange },
        uSaturation: { value: saturation },
        uBrightness: { value: brightness },
      },
      vertexShader:   lineVertShader,
      fragmentShader: lineFragShader,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
      side:        THREE.DoubleSide,
    });

    glowMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uSize:       { value: 10.0 },
        uColorRange: { value: colorRange },
        uSaturation: { value: saturation },
        uBrightness: { value: brightness },
      },
      vertexShader:   glowVertShader,
      fragmentShader: glowFragShader,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    buildGeometry();
  },

  update(dt: number) {
    if (!lineMat || !glowMat) return;
    if (needsRebuild) {
      needsRebuild = false;
      buildGeometry();
      return;
    }
    accTime += dt * flowSpeed;

    lineMat.uniforms.uTime.value       = accTime;
    lineMat.uniforms.uLineWidth.value  = lineWidth;
    lineMat.uniforms.uColorRange.value = colorRange;
    lineMat.uniforms.uSaturation.value = saturation;
    lineMat.uniforms.uBrightness.value = brightness;

    glowMat.uniforms.uTime.value       = accTime;
    glowMat.uniforms.uColorRange.value = colorRange;
    glowMat.uniforms.uSaturation.value = saturation;
    glowMat.uniforms.uBrightness.value = brightness;
  },

  resize(w: number, h: number) {
    vpWidth = w; vpHeight = h;
    if (lineMat) lineMat.uniforms.uResolution.value.set(w, h);
  },

  dispose() {
    if (lineMesh   && sceneRef) sceneRef.remove(lineMesh);
    if (glowPoints && sceneRef) sceneRef.remove(glowPoints);
    lineGeo?.dispose(); glowGeo?.dispose();
    lineMat?.dispose(); glowMat?.dispose();
    lineMesh = null; glowPoints = null;
    lineGeo  = null; glowGeo    = null;
    lineMat  = null; glowMat    = null;
    camera   = null; sceneRef   = null;
    accTime  = 0; needsRebuild = false;
  },
};
