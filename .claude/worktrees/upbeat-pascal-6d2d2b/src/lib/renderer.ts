import * as THREE from "three";
import type { Pattern, PatternContext } from "./patterns/types";

export interface RendererHandle {
  setPattern: (next: Pattern) => void;
  setTimeScale: (v: number) => void;
  getTimeScale: () => number;
  getCanvas: () => HTMLCanvasElement;
  dispose: () => void;
}

export function createRenderer(canvas: HTMLCanvasElement, initial: Pattern): RendererHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, 5);

  let size = { width: 1, height: 1 };
  let current: Pattern = initial;
  let timeScale = 1.0;

  const ctx: PatternContext = { scene, camera, renderer, size };

  function applySize(width: number, height: number) {
    size.width = width;
    size.height = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    current.resize(width, height);
  }

  function clearScene() {
    while (scene.children.length > 0) scene.remove(scene.children[0]);
  }

  function setPattern(next: Pattern) {
    current.dispose();
    clearScene();
    current = next;
    current.init(ctx);
    current.resize(size.width, size.height);
  }

  current.init(ctx);

  const ro = new ResizeObserver((entries) => {
    const rect = entries[0].contentRect;
    applySize(Math.max(1, rect.width), Math.max(1, rect.height));
  });
  ro.observe(canvas);

  const initialRect = canvas.getBoundingClientRect();
  applySize(Math.max(1, initialRect.width), Math.max(1, initialRect.height));

  let raf = 0;
  let last = performance.now();
  const start = last;

  function loop(now: number) {
    const dt = (now - last) / 1000;
    const elapsed = (now - start) / 1000;
    last = now;
    current.update(dt * timeScale, elapsed);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    setPattern,
    setTimeScale(v: number) { timeScale = Math.max(0, v); },
    getTimeScale() { return timeScale; },
    getCanvas() { return canvas; },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      current.dispose();
      clearScene();
      renderer.dispose();
    },
  };
}
