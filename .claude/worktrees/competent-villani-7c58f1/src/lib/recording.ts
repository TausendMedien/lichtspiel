export interface RecorderHandle {
  toggle(): void;
  dispose(): void;
}

// Codec candidates in preference order.
// MP4/H.264 is preferred — natively playable on macOS, iOS, Windows without extra codecs.
const CANDIDATES = [
  { mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4' },
  { mime: 'video/mp4',                    ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9',        ext: 'webm' },
  { mime: 'video/webm;codecs=vp8',        ext: 'webm' },
  { mime: 'video/webm',                   ext: 'webm' },
];

export function createRecorder(
  canvas: HTMLCanvasElement,
  onChange: (recording: boolean) => void,
): RecorderHandle {
  let mediaRecorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];

  function start() {
    if (typeof (canvas as any).captureStream !== 'function') {
      console.warn('[recording] canvas.captureStream not supported in this browser');
      return;
    }
    const stream: MediaStream = (canvas as any).captureStream(60);

    const chosen = CANDIDATES.find(c => {
      try { return MediaRecorder.isTypeSupported(c.mime); } catch { return false; }
    }) ?? CANDIDATES[CANDIDATES.length - 1];

    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, { mimeType: chosen.mime });
    } catch {
      try { mr = new MediaRecorder(stream); } catch (err) {
        console.error('[recording] MediaRecorder failed to start:', err);
        return;
      }
    }

    mediaRecorder = mr;
    chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(chunks, { type: mr.mimeType || chosen.mime });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pattern-projector-${timestamp}.${chosen.ext}`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      chunks = [];
      mediaRecorder = null;
      onChange(false);
    };
    mr.start(1000); // collect chunks every second
    onChange(true);
    console.log(`[recording] started — ${chosen.mime} → .${chosen.ext}`);
  }

  function stop() {
    const mr = mediaRecorder;
    if (mr && mr.state !== 'inactive') {
      mr.stop();
    } else {
      mediaRecorder = null;
    }
  }

  return {
    toggle() { if (mediaRecorder) stop(); else start(); },
    dispose() { stop(); },
  };
}
