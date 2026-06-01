// Generates icon-192.png and icon-512.png for the PWA manifest.
// Run with: bun scripts/gen-icons.ts

import { deflateSync } from "zlib";
import { writeFileSync } from "fs";

function makePng(size: number): Uint8Array {
  // RGBA pixel buffer — black background with a simple "P" monogram in white
  const pixels = new Uint8Array(size * size * 4);

  // Fill black
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 255;
  }

  // Draw colourful diagonal lines like the app patterns
  const colors: [number, number, number][] = [
    [255,  0, 200], // hot magenta
    [  0, 240, 255], // electric cyan
    [180,  0, 255], // neon purple
    [  0, 180, 255], // electric blue
    [255, 40, 100], // neon red-pink
  ];
  const lineWidth = Math.max(2, Math.round(size / 40));

  function setPixel(x: number, y: number, r: number, g: number, b: number) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
  }

  function drawLine(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    while (true) {
      for (let w = -lineWidth; w <= lineWidth; w++) {
        setPixel(x + w, y, r, g, b);
        setPixel(x, y + w, r, g, b);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  // Draw 5 diagonal lines across the icon
  const step = size / 5;
  for (let i = 0; i < colors.length; i++) {
    const [r, g, b] = colors[i];
    const offset = Math.round(step * i);
    drawLine(offset, 0, offset + size, size, r, g, b);   // diagonal top-left to bottom-right
    drawLine(0, offset, size, offset + size, r, g, b);   // diagonal left-top to right-bottom
  }

  // --- PNG encoding ---
  function adler32(data: Uint8Array): number {
    let s1 = 1, s2 = 0;
    for (const b of data) { s1 = (s1 + b) % 65521; s2 = (s2 + s1) % 65521; }
    return (s2 << 16) | s1;
  }

  function crc32(data: Uint8Array): number {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    let crc = 0xffffffff;
    for (const b of data) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u32be(n: number): Uint8Array {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  }

  function chunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes); crcInput.set(data, typeBytes.length);
    const crc = u32be(crc32(crcInput));
    const out = new Uint8Array(4 + 4 + data.length + 4);
    out.set(u32be(data.length)); out.set(typeBytes, 4); out.set(data, 8); out.set(crc, 8 + data.length);
    return out;
  }

  // IHDR
  const ihdrData = new Uint8Array(13);
  const dv = new DataView(ihdrData.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size);
  ihdrData[8] = 8; ihdrData[9] = 2; // 8-bit RGB (no alpha needed but we have it — use 6 for RGBA)
  ihdrData[9] = 6; // RGBA

  // Raw image data with filter bytes
  const raw = new Uint8Array(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter type None
    raw.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (1 + size * 4) + 1);
  }

  const compressed = deflateSync(raw);
  const idat = chunk("IDAT", compressed);
  const ihdr = chunk("IHDR", ihdrData);
  const iend = chunk("IEND", new Uint8Array(0));

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const total = sig.length + ihdr.length + idat.length + iend.length;
  const png = new Uint8Array(total);
  let off = 0;
  for (const part of [sig, ihdr, idat, iend]) { png.set(part, off); off += part.length; }
  return png;
}

writeFileSync("public/icon-192.png", makePng(192));
writeFileSync("public/icon-512.png", makePng(512));
console.log("Generated public/icon-192.png and public/icon-512.png");
