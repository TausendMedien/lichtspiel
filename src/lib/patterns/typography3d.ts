import * as THREE from "three";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";
import { cameraState } from "../globalCameraSettings.svelte";

const W = 160, H = 90;

// Module-scope state — reset in dispose()
let scene: THREE.Scene | null = null;
let textGroup: THREE.Group | null = null;
let animTime = 0;

let textStr    = "Burn";
let textSize   = 0.82;
let textDepth  = 0.6;
let rotSpeed   = 0.6;
let floatSpeed = 0.4;
let rotLocked  = false;
let styleIndex = 0;  // 0=Solid 1=Wireframe 2=Neon

// Heat centroid tracking state
let baseYaw        = 0;  // accumulated idle Y rotation (kept separate from heat offset)
let heatYawOffset  = 0;  // smooth centroid-driven offset, decays to 0 when heat off
let heatTiltOffset = 0;
let heatTrackingStrength = 1.0;
let heatFloatBoost       = 1.0;

function computeHeatCentroid(): { cx: number; cy: number; total: number } {
  const map = cameraState.heatMap;
  let wx = 0, wy = 0, total = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = map[y * W + x];
      wx += v * x; wy += v * y; total += v;
    }
  }
  return total > 0.01
    ? { cx: wx / total / W, cy: wy / total / H, total }
    : { cx: 0.5, cy: 0.5, total: 0 };
}

// Track last-seen colors to detect changes and rebuild
let _lastPrimary  = "";
let _lastGlow     = "";
let _lastColorsV2 = -1;

let fontCache: ReturnType<FontLoader["parse"]> | null = null;
const loader = new FontLoader();

function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

function buildText() {
  if (!scene || !fontCache) return;
  const _ph1 = Math.min(1.0, colorC2.colorsV2);
  const _ph2 = Math.max(0, colorC2.colorsV2 - 1) / 2;
  const _cW  = new THREE.Color(1, 1, 1);
  const _cM  = new THREE.Color(colorC2.main);
  const _cPrimary = new THREE.Color().lerpColors(_cW, _cM, _ph1);
  const _cGlow    = new THREE.Color().lerpColors(_cPrimary, new THREE.Color(colorC2.contrast), _ph2);
  const primaryColor = '#' + _cPrimary.getHexString();
  const glowColor    = '#' + _cGlow.getHexString();
  _lastPrimary  = colorC2.main;
  _lastGlow     = colorC2.contrast;
  _lastColorsV2 = colorC2.colorsV2;

  if (textGroup) {
    textGroup.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
    scene.remove(textGroup);
    textGroup = null;
  }

  const geo = new TextGeometry(textStr || "Burn", {
    font: fontCache,
    size: textSize,
    depth: textDepth,
    curveSegments: 6,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 3,
  });
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const cx = (bb.max.x - bb.min.x) / 2;
  const cy = (bb.max.y - bb.min.y) / 2;
  geo.translate(-cx, -cy, 0);

  const group = new THREE.Group();

  if (styleIndex === 1) {
    // Wireframe
    const glowEdges = new THREE.EdgesGeometry(geo);
    const glowMat = new THREE.LineBasicMaterial({ color: hexToColor(glowColor) });
    group.add(new THREE.LineSegments(glowEdges, glowMat));
    const primaryEdges = new THREE.EdgesGeometry(geo);
    const primaryMat = new THREE.LineBasicMaterial({
      color: hexToColor(primaryColor),
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
    });
    group.add(new THREE.LineSegments(primaryEdges, primaryMat));
    geo.dispose();
  } else if (styleIndex === 2) {
    // Neon
    const matInner = new THREE.MeshBasicMaterial({ color: hexToColor(primaryColor) });
    group.add(new THREE.Mesh(geo, matInner));
    const outerGeo = geo.clone();
    const matGlow = new THREE.MeshBasicMaterial({
      color: hexToColor(glowColor),
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });
    outerGeo.scale(1.04, 1.04, 1.04);
    group.add(new THREE.Mesh(outerGeo, matGlow));
  } else {
    // Solid
    const mat = new THREE.MeshBasicMaterial({ color: hexToColor(primaryColor) });
    group.add(new THREE.Mesh(geo, mat));
    const edges = new THREE.EdgesGeometry(geo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: hexToColor(glowColor),
      depthTest: false,
    });
    group.add(new THREE.LineSegments(edges, edgeMat));
  }

  scene.add(group);
  textGroup = group;
}

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { buildText(); rebuildTimer = null; }, 300);
}

export const typography3d: Pattern = {
  id: "typography3d",
  name: "3D Typography",
  heatReactive: true,
  motionControlLabels: [],
  controls: [
    { label: "Text",          type: "text",  placeholder: "Burn", get: () => textStr,
      set: v => { textStr = v; scheduleRebuild(); } },
    { label: "Size",          type: "range", min: 0.2, max: 2.0, step: 0.05, default: 0.82,
      tip: "Overall size of the 3D text.",
      get: () => textSize,   set: v => { textSize = v; scheduleRebuild(); } },
    { label: "Depth",         type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.6,
      tip: "Extrusion depth — how thick the 3D letterforms are.",
      get: () => textDepth,  set: v => { textDepth = v; scheduleRebuild(); } },
    { label: "Rotate Speed",  type: "range", min: 0.0, max: 5.0, step: 0.1, default: 0.6,
      tip: "How fast the text spins. Set to 0 to stop rotation.",
      get: () => rotSpeed,   set: v => { rotSpeed = v; rotLocked = false; } },
    { label: "⊙ Face Camera", type: "button",
      tip: "Snap the text to face directly at the camera and stop rotating.",
      action: () => {
        rotSpeed = 0; rotLocked = true;
        if (textGroup) textGroup.rotation.set(0, 0, 0);
      } },
    { label: "Float Speed",   type: "range", min: 0.0, max: 1.0, step: 0.01, default: 0.4,
      tip: "How fast the text bobs up and down.",
      get: () => floatSpeed, set: v => { floatSpeed = v; } },
    { label: "Style",         type: "select", options: ["Solid", "Wireframe", "Neon"],
      tip: "Visual style — Solid, Wireframe (lattice), or Neon (edge glow).",
      get: () => styleIndex, set: v => { styleIndex = v; buildText(); } },
    { label: "Tracking Strength", type: "range", min: 0, max: 2, step: 0.1, default: 1.0,
      interactive: 'heat' as const,
      tip: "How much heat-map motion shifts the text position. Requires Heat.",
      get: () => heatTrackingStrength, set: v => { heatTrackingStrength = v; } },
    { label: "Float Boost",       type: "range", min: 0, max: 2, step: 0.1, default: 1.0,
      interactive: 'heat' as const,
      tip: "Amplify floating motion when heat-map motion is detected. Requires Heat.",
      get: () => heatFloatBoost,       set: v => { heatFloatBoost = v; } },
  ],

  init(ctx: PatternContext) {
    scene = ctx.scene;
    animTime = 0;

    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    ambient.name = "typo_ambient";
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.name = "typo_dir";
    dir.position.set(3, 5, 5);
    ctx.scene.add(ambient, dir);

    ctx.camera.position.set(0, 0, 5);
    ctx.camera.near = 0.1;
    ctx.camera.far  = 100;
    ctx.camera.lookAt(0, 0, 0);
    ctx.camera.updateProjectionMatrix();

    if (fontCache) {
      buildText();
    } else {
      fetch(import.meta.env.BASE_URL + 'helvetiker_bold.typeface.json')
        .then(r => r.json())
        .then(data => { fontCache = loader.parse(data); buildText(); })
        .catch(err => console.error('[typo] font load failed:', err));
    }
  },

  update(dt: number, _elapsed: number) {
    if (!textGroup) return;

    // Rebuild if custom colors changed
    if (colorC2.main !== _lastPrimary || colorC2.contrast !== _lastGlow || colorC2.colorsV2 !== _lastColorsV2) {
      buildText();
    }

    animTime += dt;

    // Accumulate idle spin separately so heat offset is additive, not compounding
    baseYaw += dt * rotSpeed * 0.8;

    if (cameraState.heatEnabled) {
      const { cx, cy } = computeHeatCentroid();
      const targetYaw  = (0.5 - cx) * Math.PI * 0.6 * heatTrackingStrength;
      const targetTilt = (cy - 0.5) * 0.3 * heatTrackingStrength;
      const speed = Math.min(1, dt * 2.5);
      heatYawOffset  += (targetYaw  - heatYawOffset)  * speed;
      heatTiltOffset += (targetTilt - heatTiltOffset) * speed;
      const ampBoost = (cameraState.level / 100) * heatFloatBoost;
      textGroup.rotation.y = baseYaw + heatYawOffset;
      if (!rotLocked) textGroup.rotation.x = Math.sin(animTime * 0.3) * 0.15 + heatTiltOffset;
      textGroup.position.y = Math.sin(animTime * floatSpeed) * (0.3 + ampBoost * 0.5);
    } else {
      const decay = Math.max(0, 1 - dt * 3);
      heatYawOffset  *= decay;
      heatTiltOffset *= decay;
      textGroup.rotation.y = baseYaw + heatYawOffset;
      if (!rotLocked) textGroup.rotation.x = Math.sin(animTime * 0.3) * 0.15 + heatTiltOffset;
      textGroup.position.y = Math.sin(animTime * floatSpeed) * 0.3;
    }
  },

  resize(width: number, height: number) {
    void width; void height;
  },

  dispose() {
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
    if (scene) {
      ["typo_ambient", "typo_dir"].forEach(name => {
        const obj = scene!.getObjectByName(name);
        if (obj) scene!.remove(obj);
      });
    }
    if (textGroup && scene) {
      textGroup.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
          else obj.material.dispose();
        }
      });
      scene.remove(textGroup);
    }
    textGroup = null;
    scene = null;
    animTime = 0;
    rotLocked = false;
    baseYaw = 0;
    heatYawOffset  = 0;
    heatTiltOffset = 0;
    _lastPrimary  = "";
    _lastGlow     = "";
    _lastColorsV2 = -1;
  },
};
