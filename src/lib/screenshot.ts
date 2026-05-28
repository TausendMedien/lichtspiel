export function takeScreenshot(canvas: HTMLCanvasElement): void {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const filename = `Lichtspiel-Ulrich_Tausend-1000lights.de-${timestamp}.png`;

  canvas.toBlob(async (blob) => {
    if (!blob) { console.warn('[screenshot] toBlob returned null'); return; }
    const file = new File([blob], filename, { type: 'image/png' });
    const isMobileOrTablet = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
    if (isMobileOrTablet && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Lichtspiel' }); return; } catch {}
    }
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
