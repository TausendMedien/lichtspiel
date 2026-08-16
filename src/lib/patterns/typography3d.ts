import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import {
  loadFont, getFont, buildTextGroup as buildSharedTextGroup, disposeTextGroup,
  applyTextOpacity, cycleAlpha, ALIGN_OPTIONS, STYLE_OPTIONS,
} from "../overlayText";
import { colorC2 } from "../colorC2.svelte";
import { cameraState } from "../globalCameraSettings.svelte";
import { audioState } from "../globalAudioSettings.svelte";

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
let alignIndex = 1;  // 0=left 1=center 2=right
let lineSpacing = 1.3;

// Show / hide cycle — off by default, so the text simply stays up.
let cycleOn   = false;
let showForS  = 10;
let hideForS  = 120;
let cyclePhase = 0;

// Heat centroid tracking state
let baseYaw        = 0;
let heatYawOffset  = 0;
let heatTiltOffset = 0;
// Face Camera: eased turn to front. `facing` is the transient turn, `rotLocked` the
// steady state that keeps update() from writing spin or tilt afterwards.
const FACE_TURN_S = 0.4;
let facing      = false;
let faceT       = 0;
let faceFromYaw = 0;
let faceToYaw   = 0;
let heatTrackingStrength = 1.0;
let heatFloatBoost       = 1.0;

// CPU Sobel — locally pushes text in XY based on heat gradient at text position
let heatStrength  = 1.8;
let heatBlurR     = 1;
let heatSmoothed: Float32Array | null = null;
let heatTmp:      Float32Array | null = null;
let heatTexData:  Float32Array | null = null;
let heatXPush     = 0;
let camera: THREE.PerspectiveCamera | null = null;
const _tProjVec   = new THREE.Vector3();

// Motion→size / audio→depth as smoothed scale multipliers (no geometry rebuild)
let motionSizeAmt = 0;   // 0..~1: extra uniform scale from camera motion
let audioDepthAmt = 0;   // 0..~1: extra z-scale (extrusion depth) from audio level

function heatBoxBlur(src: Float32Array, tmp: Float32Array, dst: Float32Array, r: number) {
  if (r < 1) { dst.set(src); return; }
  for (let y = 0; y < H; y++) {
    const yo = y * W;
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, W - 1); k++) { sum += src[yo + k]; cnt++; }
    tmp[yo] = sum / cnt;
    for (let x = 1; x < W; x++) {
      if (x + r < W)     { sum += src[yo + x + r];     cnt++; }
      if (x - r - 1 >= 0) { sum -= src[yo + x - r - 1]; cnt--; }
      tmp[yo + x] = sum / cnt;
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, H - 1); k++) { sum += tmp[k * W + x]; cnt++; }
    dst[x] = sum / cnt;
    for (let y = 1; y < H; y++) {
      if (y + r < H)     { sum += tmp[(y + r) * W + x];     cnt++; }
      if (y - r - 1 >= 0) { sum -= tmp[(y - r - 1) * W + x]; cnt--; }
      dst[y * W + x] = sum / cnt;
    }
  }
}

function sampleHeatArr(arr: Float32Array, u: number, v: number): number {
  const col = Math.max(0, Math.min(W - 1, Math.floor((1 - u) * W)));
  const row = Math.max(0, Math.min(H - 1, Math.floor((1 - v) * H)));
  return arr[row * W + col];
}

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

function buildText() {
  if (!scene || !getFont()) return;
  const _ph1 = Math.min(1.0, colorC2.colorsV2);
  const _ph2 = Math.max(0, colorC2.colorsV2 - 1) / 2;
  const _cW  = new THREE.Color(1, 1, 1);
  const _cM  = new THREE.Color(colorC2.main);
  const _cPrimary = new THREE.Color().lerpColors(_cW, _cM, _ph1);
  const _cGlow    = new THREE.Color().lerpColors(_cPrimary, new THREE.Color(colorC2.contrast), _ph2);
  const primaryColor = '#' + _cPrimary.getHexString();
  const glowColor    = '#' + _cGlow.getHexString();

  // Build the replacement group FIRST and only swap it in on success — a failed
  // or degenerate TextGeometry (e.g. Depth 0 with bevel) must never leave the
  // scene empty, since update() has no other way to bring the text back.
  let group: THREE.Group;
  try {
    group = buildSharedTextGroup({
      text: textStr, size: textSize, depth: textDepth, style: styleIndex,
      align: alignIndex, lineSpacing, primaryColor, glowColor,
    });
  } catch (err) {
    console.error('[typo] buildText failed — keeping previous text', err);
    return;
  }

  if (textGroup) {
    disposeTextGroup(textGroup);
    scene.remove(textGroup);
    textGroup = null;
  }

  scene.add(group);
  textGroup = group;
  _lastPrimary  = colorC2.main;
  _lastGlow     = colorC2.contrast;
  _lastColorsV2 = colorC2.colorsV2;
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
  // Size/Depth must NOT be generic boost targets: their set() rebuilds the
  // TextGeometry behind a 300ms debounce, and per-frame boost writes keep
  // resetting that timer so the rebuild never fires (sliders appear dead).
  // Motion→size and audio→depth are instead applied as cheap per-frame
  // scale transforms in update() below.
  motionControlLabels: [],
  audioControlLabels:  [],
  controls: [
    { label: "Text",          type: "text",  multiline: true, placeholder: "Burn", get: () => textStr,
      tip: "The text to show. Press Enter for a new line.",
      set: v => { textStr = v; scheduleRebuild(); } },
    { label: "Align",         type: "select", options: [...ALIGN_OPTIONS],
      tip: "How the lines line up with each other.",
      get: () => alignIndex, set: v => { alignIndex = v; scheduleRebuild(); } },
    { label: "Line Spacing",  type: "range", min: 0.6, max: 3.0, step: 0.05, default: 1.3,
      tip: "Gap between lines, as a multiple of the text size.",
      get: () => lineSpacing, set: v => { lineSpacing = v; scheduleRebuild(); } },
    { label: "Size",          type: "range", min: 0.2, max: 2.0, step: 0.01, default: 0.82,
      tip: "Overall size of the 3D text.",
      get: () => textSize,   set: v => { textSize = v; scheduleRebuild(); } },
    { label: "Depth",         type: "range", min: 0.0, max: 1.0, step: 0.01, default: 0.6,
      tip: "Extrusion depth — how thick the 3D letterforms are.",
      get: () => textDepth,  set: v => { textDepth = v; scheduleRebuild(); } },
    { label: "Rotate Speed",  type: "range", min: 0.0, max: 5.0, step: 0.1, default: 0.6,
      tip: "How fast the text spins. Set to 0 to stop rotation.",
      // Only a real move off zero releases the lock. Persist/preset/share restores all
      // call set() on load, and clearing the lock there silently undid Face Camera.
      get: () => rotSpeed,   set: v => { rotSpeed = v; if (v > 0) rotLocked = false; } },
    { label: "⊙ Face Camera", type: "button",
      tip: "Turn the text to face directly at the camera and stop rotating.",
      action: () => {
        // Turn to front over FACE_TURN_S rather than snapping, taking the short way
        // round. update() drives the easing; it must also stop writing the spin, or
        // the accumulated baseYaw would overwrite this on the very next frame.
        rotSpeed = 0;
        rotLocked = true;
        facing = true;
        faceFromYaw = baseYaw;
        // Nearest full turn, so a text at 359° eases 1° forward instead of 359° back.
        faceToYaw = Math.round(baseYaw / (Math.PI * 2)) * Math.PI * 2;
        faceT = 0;
      } },
    { label: "Float Speed",   type: "range", min: 0.0, max: 1.0, step: 0.01, default: 0.4,
      tip: "How fast the text bobs up and down.",
      get: () => floatSpeed, set: v => { floatSpeed = v; } },
    { label: "Style",         type: "select", options: [...STYLE_OPTIONS],
      tip: "Visual style — Solid, Wireframe (lattice), or Neon (edge glow).",
      get: () => styleIndex, set: v => { styleIndex = v; buildText(); } },
    { label: "Cycle",         type: "toggle",
      tip: "Show the text for a while, then hide it, over and over.",
      get: () => cycleOn, set: v => { cycleOn = !!v; cyclePhase = 0; } },
    { label: "Show for",      type: "range", min: 1, max: 300, step: 1, default: 10,
      disabled: () => !cycleOn,
      tip: "Seconds the text stays visible each time round.",
      get: () => showForS, set: v => { showForS = v; } },
    { label: "Hide for",      type: "range", min: 5, max: 1800, step: 5, default: 120,
      disabled: () => !cycleOn,
      tip: "Seconds the text stays hidden before it comes back.",
      get: () => hideForS, set: v => { hideForS = v; } },
    { label: "Tracking Strength", type: "range", min: 0, max: 2,   step: 0.1, default: 1.0,
      interactive: 'heat' as const,
      tip: "How much heat-map motion rotates the text toward the person. Requires Heat.",
      get: () => heatTrackingStrength, set: v => { heatTrackingStrength = v; } },
    { label: "Float Boost",       type: "range", min: 0, max: 2,   step: 0.1, default: 1.0,
      interactive: 'heat' as const,
      tip: "Amplify floating motion when heat-map motion is detected. Requires Heat.",
      get: () => heatFloatBoost,       set: v => { heatFloatBoost = v; } },
    { label: "Heat Strength",     type: "range", min: 0, max: 2.5, step: 0.1, default: 1.8,
      interactive: 'heat' as const,
      tip: "How much heat-map edges locally push the text sideways. Requires Heat.",
      get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Blur Radius",       type: "range", min: 0, max: 8,   step: 1,   default: 1,
      interactive: 'heat' as const,
      tip: "Radius of heat-map blur — larger = broader glow around motion zones. Requires Heat.",
      get: () => heatBlurR, set: v => { heatBlurR = v; } },
  ],

  init(ctx: PatternContext) {
    scene = ctx.scene;
    camera = ctx.camera;
    animTime = 0;

    heatSmoothed = new Float32Array(W * H);
    heatTmp      = new Float32Array(W * H);
    heatTexData  = new Float32Array(W * H);

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

    if (getFont()) buildText();
    else loadFont().then(() => buildText()).catch(err => console.error('[typo] font load failed:', err));
  },

  update(dt: number, _elapsed: number) {
    // Rebuild if custom colors changed — checked BEFORE the textGroup guard so a
    // previously failed build can recover instead of dead-ending on black forever.
    if (colorC2.main !== _lastPrimary || colorC2.contrast !== _lastGlow || colorC2.colorsV2 !== _lastColorsV2) {
      buildText();
    }
    if (!textGroup) return;

    animTime += dt;

    // Motion→size / audio→depth as scale transforms — cheap per-frame, never
    // touches the debounced TextGeometry rebuild path the sliders use.
    // Sensitivity scales the motion response linearly around its default (50).
    const motionTarget = cameraState.motionEnabled && cameraState.enabled
      ? Math.min(1, (cameraState.level / 100) * (cameraState.sensitivity / 50))
      : 0;
    const audioTarget = audioState.enabled ? audioState.level / 100 : 0;
    const lerp = Math.min(1, dt * 4);
    motionSizeAmt += (motionTarget - motionSizeAmt) * lerp;
    audioDepthAmt += (audioTarget - audioDepthAmt) * lerp;
    const sizeScale = 1 + motionSizeAmt * 0.5;   // up to +50% size at full motion
    const depthScale = 1 + audioDepthAmt * 1.5;  // up to 2.5× extrusion depth at full level
    textGroup.scale.set(sizeScale, sizeScale, sizeScale * depthScale);

    // Show / hide cycle — fade rather than remove, so nothing pops.
    if (cycleOn) {
      cyclePhase += dt;
      applyTextOpacity(textGroup, cycleAlpha(cyclePhase, showForS, hideForS));
    } else if (cyclePhase !== 0) {
      cyclePhase = 0;
      applyTextOpacity(textGroup, 1);
    }

    // Accumulate idle spin separately so heat offset is additive, not compounding
    if (!rotLocked) baseYaw += dt * rotSpeed * 0.8;

    // Face Camera: ease the accumulated yaw to the nearest full turn, then hold.
    if (facing) {
      faceT = Math.min(1, faceT + dt / FACE_TURN_S);
      const e = faceT * faceT * (3 - 2 * faceT); // smoothstep
      baseYaw = faceFromYaw + (faceToYaw - faceFromYaw) * e;
      const decay = Math.max(0, 1 - dt * 6);
      heatYawOffset  *= decay;
      heatTiltOffset *= decay;
      if (faceT >= 1) { baseYaw = faceToYaw; heatYawOffset = 0; heatTiltOffset = 0; facing = false; }
    }

    if (heatSmoothed && heatTmp && heatTexData) {
      const raw = cameraState.heatMap;
      for (let i = 0; i < W * H; i++)
        heatSmoothed[i] = heatSmoothed[i] * 0.82 + Math.max(0, raw[i] - 0.008) * 0.18;
      heatBoxBlur(heatSmoothed, heatTmp, heatTexData, heatBlurR);
    }

    if (cameraState.heatEnabled) {
      const { cx, cy } = computeHeatCentroid();
      const targetYaw  = (0.5 - cx) * Math.PI * 0.6 * heatTrackingStrength;
      const targetTilt = (cy - 0.5) * 0.3 * heatTrackingStrength;
      const speed = Math.min(1, dt * 2.5);
      // Face Camera holds the text still: heat must not keep swinging it afterwards.
      if (!rotLocked) {
        heatYawOffset  += (targetYaw  - heatYawOffset)  * speed;
        heatTiltOffset += (targetTilt - heatTiltOffset) * speed;
      }
      const ampBoost = (cameraState.level / 100) * heatFloatBoost;

      // Local heat push: gradient at text's current screen position nudges text sideways
      if (heatStrength > 0 && camera && heatTexData) {
        _tProjVec.set(textGroup.position.x, textGroup.position.y, 0).project(camera);
        const u = _tProjVec.x * 0.5 + 0.5;
        const v = _tProjVec.y * 0.5 + 0.5;
        const EX = 1.5 / W;
        const gx = sampleHeatArr(heatTexData, u + EX, v) - sampleHeatArr(heatTexData, u - EX, v);
        heatXPush += (gx * heatStrength * 0.8 - heatXPush) * Math.min(1, dt * 2.5);
      }

      textGroup.rotation.y = baseYaw + heatYawOffset;
      textGroup.rotation.x = rotLocked
        ? heatTiltOffset   // decays to 0 through the Face Camera turn, then holds flat
        : Math.sin(animTime * 0.3) * 0.15 + heatTiltOffset;
      textGroup.position.x = heatXPush;
      textGroup.position.y = Math.sin(animTime * floatSpeed) * (0.3 + ampBoost * 0.5);
    } else {
      const decay = Math.max(0, 1 - dt * 3);
      heatYawOffset  *= decay;
      heatTiltOffset *= decay;
      heatXPush      *= decay;
      textGroup.rotation.y = baseYaw + heatYawOffset;
      textGroup.rotation.x = rotLocked
        ? heatTiltOffset   // decays to 0 through the Face Camera turn, then holds flat
        : Math.sin(animTime * 0.3) * 0.15 + heatTiltOffset;
      textGroup.position.x = heatXPush;
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
    camera = null;
    animTime = 0;
    rotLocked = false;
    facing = false;
    faceT = 0;
    baseYaw = 0;
    heatYawOffset  = 0;
    heatTiltOffset = 0;
    heatXPush      = 0;
    motionSizeAmt  = 0;
    audioDepthAmt  = 0;
    heatSmoothed = null; heatTmp = null; heatTexData = null;
    _lastPrimary  = "";
    _lastGlow     = "";
    _lastColorsV2 = -1;
  },
};
