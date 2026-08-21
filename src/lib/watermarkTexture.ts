import * as THREE from "three";

// ── Watermark image: upload, downscale, and texture cache ────────────────────
//
// The image is stored as a data URL in localStorage alongside every other setting,
// which shares a ~5-10MB quota for the whole app. A camera-resolution PNG would eat
// most of that on its own, so uploads are downscaled to MAX_EDGE first — far more
// than a projector needs for a logo, and a few hundred KB rather than several MB.

const MAX_EDGE = 1024;

export interface LoadedImage {
  dataUrl: string;
  /** width / height of the stored image. */
  aspect: number;
}

/**
 * Reads a user-picked image file and returns a downscaled PNG data URL plus its
 * aspect. PNG is kept (rather than JPEG) so transparency survives — the whole point
 * of a watermark. Rejects if the file isn't a decodable image.
 */
export function loadWatermarkFile(file: File): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not a readable image'));
      img.onload = () => {
        const { width: w, height: h } = img;
        if (!w || !h) { reject(new Error('image has no dimensions')); return; }
        const k = Math.min(1, MAX_EDGE / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * k));
        const ch = Math.max(1, Math.round(h * k));
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const cx = c.getContext('2d');
        if (!cx) { reject(new Error('no 2d context')); return; }
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, cw, ch);
        resolve({ dataUrl: c.toDataURL('image/png'), aspect: cw / ch });
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

// One texture per data URL. The renderer calls this every frame, so it must not
// re-decode; when the image changes the previous texture is released.
let cachedUrl: string | null = null;
let cachedTex: THREE.Texture | null = null;

/** Texture for a data URL, decoded once. Returns null until it has decoded. */
export function getWatermarkTexture(dataUrl: string | null): THREE.Texture | null {
  if (!dataUrl) { disposeWatermarkTexture(); return null; }
  if (dataUrl === cachedUrl) return cachedTex;
  disposeWatermarkTexture();
  cachedUrl = dataUrl;
  cachedTex = new THREE.TextureLoader().load(dataUrl);
  cachedTex.colorSpace = THREE.SRGBColorSpace;
  return cachedTex;
}

export function disposeWatermarkTexture(): void {
  cachedTex?.dispose();
  cachedTex = null;
  cachedUrl = null;
}
