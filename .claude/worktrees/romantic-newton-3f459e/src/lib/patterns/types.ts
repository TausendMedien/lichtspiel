import type * as THREE from "three";

export interface PatternContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  size: { width: number; height: number };
}

export type PatternControl =
  | { label: string; type: "range"; min: number; max: number; step: number; default?: number; readonly?: boolean; disabled?: () => boolean; get(): number; set(v: number): void }
  | { label: string; type: "select"; options: string[] | (() => string[]); disabled?: () => boolean; get(): number; set(v: number): void }
  | { label: string; type: "toggle"; disabled?: () => boolean; get(): boolean; set(v: boolean): void }
  /** Section header with an integrated on/off toggle. Controls below are dimmed while off. */
  | { label: string; type: "section"; get(): boolean; set(v: boolean): void }
  | { label: string; type: "separator" }
  | { label: string; type: "button"; action(): void };

export interface Pattern {
  id: string;
  name: string;
  controls?: PatternControl[];
  /** Labels of range controls that motion detection should boost. Defaults to first two range controls. */
  motionControlLabels?: string[];
  init(ctx: PatternContext): void;
  update(dt: number, elapsed: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
