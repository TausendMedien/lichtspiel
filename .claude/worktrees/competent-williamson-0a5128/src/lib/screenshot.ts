export function takeScreenshot(canvas: HTMLCanvasElement): void {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const filename = `Lichtspiel-Ulrich_Tausend-1000lights.de-${timestamp}.png`;

  canvas.toBlob((blob) => {
    if (!blob) { console.warn('[screenshot] toBlob returned null'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}
