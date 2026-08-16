import type * as THREE from "three";

export interface PatternContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  size: { width: number; height: number };
}

export type PatternControl =
  | { label: string; type: "range"; min: number; max: number; step: number; default?: number; readonly?: boolean; disabled?: () => boolean; interactive?: 'pose' | 'camera' | 'heat' | 'internal'; audioWeight?: number; exp?: true; tip?: string; get(): number; set(v: number): void; /** Set without persisting to localStorage or pushing undo — for transient drift (Evolving Range). Provided by wrapWithPersist. */ setLive?(v: number): void; /** Final write of an animated transition: persists to localStorage without pushing undo (the caller pushes one undo for the start value). Provided by wrapWithPersist. */ commit?(v: number): void }
  | { label: string; type: "select"; options: string[] | (() => string[]); disabled?: () => boolean; interactive?: 'camera'; tip?: string; get(): number; set(v: number): void }
  /** `interactive: 'camera'` additionally marks a toggle as *starting* the camera —
   *  App.svelte force-switches those off when the Interactive section is off. Other
   *  values ('heat', 'pose') only place the toggle in the Interactive section. */
  | { label: string; type: "toggle"; disabled?: () => boolean; interactive?: 'pose' | 'camera' | 'heat'; title?: string; tip?: string; linkedTo?: string; get(): boolean; set(v: boolean): void }
  /** Section header with an integrated on/off toggle. Controls below are dimmed while off.
   *  Set collapsible:true to get a collapse-only header with no on/off toggle. */
  | { label: string; type: "section"; collapsible?: boolean; get(): boolean; set(v: boolean): void }
  | { label: string; type: "separator" }
  | { label: string; type: "button"; tip?: string; action(): void }
  | { label: string; type: "color"; get(): string; set(v: string): void }
  | { label: string; type: "text"; placeholder?: string; tip?: string;
      /** Render a textarea so Enter inserts a newline. The value stays a plain
       *  string, so persist / preset / share / broadcast are unaffected. */
      multiline?: boolean;
      get(): string; set(v: string): void };

export interface Pattern {
  id: string;
  name: string;
  attribution?: string;
  controls?: PatternControl[];
  /** Labels of range controls that motion detection should boost. Defaults to first two range controls. */
  motionControlLabels?: string[];
  /** Labels of range controls that audio reactivity should boost. Falls back to motionControlLabels, then first two range controls. */
  audioControlLabels?: string[];
  /** True if this pattern actively uses body pose tracking data. */
  usesPose?: boolean;
  /** Set by addMotionCamera wrapper — true if this pattern supports motion reactivity. */
  motionReactive?: boolean;
  /** Set by addAudioReactivity wrapper — true if this pattern supports audio reactivity. */
  audioReactive?: boolean;
  /** True if this pattern blends a camera feed into its visuals (ASCII Swirls). */
  usesCameraBlend?: boolean;
  /** True if this pattern uses the heat map from camera motion detection. */
  heatReactive?: boolean;
  /** True if this pattern supports the Push sensor — your body clearing a path
   *  through it. Set in patterns/index.ts from PUSH_IDS. */
  pushReactive?: boolean;
  /** True if the camera is the pattern's primary content (e.g. Heat Map). Keeps the
   *  camera running even when the Interactive section is toggled off. */
  requiresCamera?: boolean;
  /** Default saturation and brightness for the per-pattern colour state. */
  colorDefaults?: { saturation?: number; brightness?: number };
  /** Section labels that should be collapsed by default (no saved state). */
  defaultCollapsedSections?: string[];
  init(ctx: PatternContext): void;
  /** Called only on real activation (not on overview hover preview). Start cameras here. */
  activate?(): void;
  update(dt: number, elapsed: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
