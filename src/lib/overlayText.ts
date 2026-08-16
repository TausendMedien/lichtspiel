import * as THREE from "three";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { FontLoader, type Font } from "three/examples/jsm/loaders/FontLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// ── Shared 3D text builder ───────────────────────────────────────────────────
// Owns font loading and geometry construction for both the "3D Typography"
// pattern and the global text overlay, so multi-line layout, alignment and the
// show/hide cycle behave identically in both places.
//
// The font is parsed once per page load and deliberately kept across dispose().

let fontCache: Font | null = null;
let fontPromise: Promise<Font> | null = null;
const loader = new FontLoader();

export function getFont(): Font | null {
  return fontCache;
}

/** Resolves once the typeface is parsed. Safe to call repeatedly. */
export function loadFont(): Promise<Font> {
  if (fontCache) return Promise.resolve(fontCache);
  if (!fontPromise) {
    fontPromise = fetch(import.meta.env.BASE_URL + 'helvetiker_bold.typeface.json')
      .then(r => r.json())
      .then(data => { fontCache = loader.parse(data); return fontCache; })
      .catch(err => { fontPromise = null; throw err; });
  }
  return fontPromise;
}

export const ALIGN_OPTIONS = ["left", "center", "right"] as const;
export const STYLE_OPTIONS = ["Solid", "Wireframe", "Neon"] as const;

export interface TextBuildOpts {
  text: string;
  size: number;
  depth: number;
  /** 0 = Solid, 1 = Wireframe, 2 = Neon */
  style: number;
  /** 0 = left, 1 = center, 2 = right */
  align: number;
  /** Gap between baselines as a multiple of size. */
  lineSpacing: number;
  primaryColor: string;
  glowColor: string;
}

/**
 * One TextGeometry per line, stacked and aligned, merged into a single geometry.
 *
 * Building per line rather than letting the font loader handle "\n" is what makes
 * a Line Spacing control and left/center/right alignment possible at all — the
 * loader hard-codes the gap to the font's own line height and always starts each
 * line at x = 0.
 *
 * Throws on degenerate geometry so callers can keep the previous text on screen.
 */
export function buildTextGeometry(o: TextBuildOpts): THREE.BufferGeometry {
  const lines = (o.text || "Burn").split("\n");
  // A trailing newline shouldn't add an invisible line that shifts the block.
  while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();

  const lineHeight = o.size * o.lineSpacing;
  const parts: THREE.BufferGeometry[] = [];

  lines.forEach((line, i) => {
    // An empty line still occupies a row, but has no geometry to place.
    if (line.trim() === "") return;
    const geo = new TextGeometry(line, {
      font: fontCache!,
      size: o.size,
      // Depth 0 with bevel produces degenerate/NaN extrusion; stored settings and
      // presets may still carry 0, so clamp here rather than at the control.
      depth: Math.max(0.01, o.depth),
      curveSegments: 6,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 3,
    });
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb || !isFinite(bb.min.x) || !isFinite(bb.max.x)) {
      geo.dispose();
      parts.forEach(p => p.dispose());
      throw new Error('degenerate text geometry (non-finite bounding box)');
    }
    const dx = o.align === 0 ? -bb.min.x                      // left edges flush
             : o.align === 2 ? -bb.max.x                      // right edges flush
             : -(bb.min.x + bb.max.x) / 2;                    // centred
    geo.translate(dx, -i * lineHeight, 0);
    parts.push(geo);
  });

  if (!parts.length) throw new Error('no renderable lines');

  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) { parts.forEach(p => p.dispose()); throw new Error('geometry merge failed'); }
  if (parts.length > 1) parts.forEach(p => p.dispose());

  // Centre the whole block on the origin. Note this is (max + min) / 2 — the true
  // centre. Using half the *extent* only looks right when min is ~0, which is the
  // case for a single line and emphatically not for a stack of them.
  merged.computeBoundingBox();
  const bb = merged.boundingBox!;
  merged.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, 0);
  return merged;
}

/** Builds the styled group. Materials are transparent so the cycle can fade them. */
export function buildTextGroup(o: TextBuildOpts): THREE.Group {
  const geo = buildTextGeometry(o);
  const primary = new THREE.Color(o.primaryColor);
  const glow = new THREE.Color(o.glowColor);
  const group = new THREE.Group();

  if (o.style === 1) {
    // Wireframe
    group.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: glow, transparent: true, opacity: 1 })));
    group.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({
        color: primary, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending })));
    geo.dispose();
  } else if (o.style === 2) {
    // Neon — solid core with an additive shell
    group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: primary, transparent: true, opacity: 1 })));
    const outer = geo.clone();
    outer.scale(1.04, 1.04, 1.04);
    group.add(new THREE.Mesh(outer, new THREE.MeshBasicMaterial({
      color: glow, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, side: THREE.BackSide })));
  } else {
    // Solid
    group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: primary, transparent: true, opacity: 1 })));
    group.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: glow, transparent: true, opacity: 1, depthTest: false })));
  }

  // Remember each material's design opacity so the cycle can scale it without
  // flattening the style's own transparency (Neon's shell, Wireframe's overlay).
  group.traverse(obj => {
    const m = (obj as THREE.Mesh | THREE.LineSegments).material as THREE.Material | undefined;
    if (m && 'opacity' in m) (m as any).userData.baseOpacity = (m as THREE.Material & { opacity: number }).opacity;
  });
  return group;
}

/** Frees every geometry and material in a group built above. */
export function disposeTextGroup(group: THREE.Group): void {
  group.traverse(obj => {
    const o = obj as THREE.Mesh | THREE.LineSegments;
    if (o.geometry) o.geometry.dispose();
    const m = o.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach(x => x.dispose());
    else if (m) m.dispose();
  });
}

/** Scales every material by `alpha`, relative to its design opacity. */
export function applyTextOpacity(group: THREE.Group, alpha: number): void {
  group.visible = alpha > 0.001;
  group.traverse(obj => {
    const m = (obj as THREE.Mesh).material as (THREE.Material & { opacity: number }) | undefined;
    if (!m || !('opacity' in m)) return;
    const base = (m as any).userData?.baseOpacity ?? 1;
    m.opacity = base * alpha;
  });
}

/**
 * Visibility for the show/hide cycle at a given phase, with a short fade at each
 * edge so the text doesn't pop. Returns 1 while shown, 0 while hidden.
 */
export function cycleAlpha(phase: number, showFor: number, hideFor: number, fade = 0.4): number {
  const period = showFor + hideFor;
  if (period <= 0) return 1;
  const t = ((phase % period) + period) % period;
  const f = Math.min(fade, showFor / 2, hideFor / 2);
  if (f <= 0) return t < showFor ? 1 : 0;
  if (t < f) return t / f;                                  // fading in
  if (t < showFor - f) return 1;                            // fully shown
  if (t < showFor) return (showFor - t) / f;                // fading out
  return 0;                                                 // hidden
}
