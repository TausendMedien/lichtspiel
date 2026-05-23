import * as THREE from "three";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";

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
  const primaryColor = colorC2.main;
  const glowColor    = '#' + new THREE.Color().lerpColors(
    new THREE.Color(colorC2.main),
    new THREE.Color(colorC2.contrast),
    colorC2.colorsV2 / 3.0
  ).getHexString();
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
  controls: [
    { label: "Text",          type: "text",  placeholder: "Burn", get: () => textStr,
      set: v => { textStr = v; scheduleRebuild(); } },
    { label: "Size",          type: "range", min: 0.2, max: 2.0, step: 0.05, default: 0.82,
      get: () => textSize,   set: v => { textSize = v; scheduleRebuild(); } },
    { label: "Depth",         type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.6,
      get: () => textDepth,  set: v => { textDepth = v; scheduleRebuild(); } },
    { label: "Rotate Speed",  type: "range", min: 0.0, max: 5.0, step: 0.1, default: 0.6,
      get: () => rotSpeed,   set: v => { rotSpeed = v; rotLocked = false; } },
    { label: "⊙ Face Camera", type: "button", action: () => {
        rotSpeed = 0; rotLocked = true;
        if (textGroup) textGroup.rotation.set(0, 0, 0);
      } },
    { label: "Float Speed",   type: "range", min: 0.0, max: 1.0, step: 0.01, default: 0.4,
      get: () => floatSpeed, set: v => { floatSpeed = v; } },
    { label: "Style",         type: "select", options: ["Solid", "Wireframe", "Neon"],
      get: () => styleIndex, set: v => { styleIndex = v; buildText(); } },
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
    textGroup.rotation.y += dt * rotSpeed * 0.8;
    if (!rotLocked) textGroup.rotation.x = Math.sin(animTime * 0.3) * 0.15;
    textGroup.position.y = Math.sin(animTime * floatSpeed) * 0.3;
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
    _lastPrimary  = "";
    _lastGlow     = "";
    _lastColorsV2 = -1;
  },
};
