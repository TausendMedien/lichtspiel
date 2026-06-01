import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

// ─── Module-level state ──────────────────────────────────────────────────────
let renderer3: THREE.WebGLRenderer | null = null;

// Internal scene that holds the Gosper curve line
let gosperScene:  THREE.Scene | null = null;
let gosperCamera: THREE.OrthographicCamera | null = null;
let line: THREE.Line | null = null;
let colorAttr: THREE.BufferAttribute | null = null;
let renderTarget: THREE.WebGLRenderTarget | null = null;

// Display mesh in the main scene (ctx.scene)
let displayMesh: THREE.Mesh | null = null;
let displayGeo:  THREE.PlaneGeometry | null = null;
let displayMat:  THREE.MeshBasicMaterial | null = null;

let colorSpeed    = 0.5;
let rotationSpeed = 0.15;
let zoom          = 1.0;

let colorOffset = 0;
let lineRotY    = 0;
let rtSize      = 512;

// ─── Gosper L-system ─────────────────────────────────────────────────────────

function gosperPoints(order: number): Float32Array {
  // L-system rewriting
  let s = "A";
  const rules: Record<string, string> = {
    A: "A-B--B+A++AA+B-",
    B: "+A-BB--B-A++A+B",
  };
  for (let i = 0; i < order; i++) {
    let next = "";
    for (const ch of s) next += rules[ch] ?? ch;
    s = next;
  }

  // Interpret: A/B = draw forward, + = turn left 60°, - = turn right 60°
  const DEG60 = Math.PI / 3;
  let x = 0, y = 0, angle = 0;
  const pts: number[] = [];
  for (const ch of s) {
    if (ch === "A" || ch === "B") {
      const nx = x + Math.cos(angle);
      const ny = y + Math.sin(angle);
      pts.push(x, y, 0, nx, ny, 0);
      x = nx; y = ny;
    } else if (ch === "+") {
      angle += DEG60;
    } else if (ch === "-") {
      angle -= DEG60;
    }
  }
  return new Float32Array(pts);
}

// ─── Pattern ─────────────────────────────────────────────────────────────────

export const gosperFeedback: Pattern = {
  id: "gosperFeedback",
  name: "Gosper Feedback",
  attribution: "Adapted from Three.js Examples by Ricardo Cabello (mrdoob)",
  controls: [
    { label: "Color Speed", type: "range", min: 0.0, max: 3.0, step: 0.05, default: 0.5,  get: () => colorSpeed,    set: (v) => { colorSpeed = v; } },
    { label: "Rotation",    type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0.15, get: () => rotationSpeed, set: (v) => { rotationSpeed = v; } },
    { label: "Zoom",        type: "range", min: 0.3, max: 3.0, step: 0.05, default: 1.0,  get: () => zoom,          set: (v) => { zoom = v; } },
  ],

  init(ctx: PatternContext) {
    renderer3 = ctx.renderer;
    rtSize    = Math.min(512, Math.max(128, Math.round(Math.min(ctx.size.width, ctx.size.height) * 0.5)));

    // ── Build Gosper geometry (order 5 → ~16 k segments) ──
    const pts  = gosperPoints(5);
    const geo  = new THREE.BufferGeometry();
    const posAttr = new THREE.Float32BufferAttribute(pts, 3);
    geo.setAttribute("position", posAttr);
    geo.center();

    // Color attribute (updated every frame)
    const colArr = new Float32Array(posAttr.count * 3);
    colorAttr = new THREE.BufferAttribute(colArr, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("color", colorAttr);

    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
    line = new THREE.Line(geo, lineMat);

    // Scale to fit inside a ±1 box
    geo.computeBoundingBox();
    const box  = geo.boundingBox!;
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
    line.scale.setScalar(2.0 / span);

    // ── Internal orthographic scene ──
    gosperScene = new THREE.Scene();
    gosperScene.background = new THREE.Color(0x000000);
    gosperScene.add(line);

    gosperCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    gosperCamera.position.z = 1;

    // ── Render target at 2× for supersampling (dramatically reduces stair-stepping) ──
    renderTarget = new THREE.WebGLRenderTarget(rtSize * 2, rtSize * 2, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      samples: 4, // MSAA on top of the 2× supersample
    });

    // ── Display quad in the main scene ──
    displayGeo = new THREE.PlaneGeometry(2, 2);
    displayMat = new THREE.MeshBasicMaterial({ map: renderTarget.texture });
    displayMesh = new THREE.Mesh(displayGeo, displayMat);
    displayMesh.frustumCulled = false;
    ctx.scene.add(displayMesh);

    // Park main camera so the display quad fills the screen
    ctx.camera.position.set(0, 0, 1);
    ctx.camera.near = 0.01;
    ctx.camera.far  = 10;
    ctx.camera.updateProjectionMatrix();
  },

  update(dt: number, _elapsed: number) {
    if (!renderer3 || !gosperScene || !gosperCamera || !renderTarget || !line || !colorAttr) return;

    // Animate vertex colors (cycling HSL offset)
    colorOffset += dt * colorSpeed * 25;
    const count = colorAttr.count;
    const col   = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const h = ((colorOffset + i) % count) / count;
      col.setHSL(h, 1.0, 0.5);
      colorAttr.setXYZ(i, col.r, col.g, col.b);
    }
    colorAttr.needsUpdate = true;

    // Rotate the line
    lineRotY += dt * rotationSpeed;
    if (line) line.rotation.z = lineRotY;

    // Zoom via camera frustum
    const half = 1.0 / zoom;
    gosperCamera.left   = -half;
    gosperCamera.right  =  half;
    gosperCamera.top    =  half;
    gosperCamera.bottom = -half;
    gosperCamera.updateProjectionMatrix();

    // Render Gosper scene into the render target
    const prevTarget = renderer3.getRenderTarget();
    renderer3.setRenderTarget(renderTarget);
    renderer3.render(gosperScene, gosperCamera);
    renderer3.setRenderTarget(prevTarget);
  },

  resize(width: number, height: number) {
    rtSize = Math.min(512, Math.max(128, Math.round(Math.min(width, height) * 0.5)));
    renderTarget?.setSize(rtSize * 2, rtSize * 2);
  },

  dispose() {
    line?.geometry.dispose();
    (line?.material as THREE.Material)?.dispose();
    gosperScene = null;
    gosperCamera = null;
    line = null;
    colorAttr = null;
    renderTarget?.dispose();
    renderTarget = null;
    displayGeo?.dispose();
    displayMat?.dispose();
    displayMesh = null;
    displayGeo  = null;
    displayMat  = null;
    renderer3   = null;
    colorOffset = 0;
    lineRotY    = 0;
  },
};
