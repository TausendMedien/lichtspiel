export interface RecorderHandle {
  toggle(): void;
  dispose(): void;
}

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
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) ?? '';
    try {
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      mediaRecorder = new MediaRecorder(stream);
    }
    chunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pattern-projector-${timestamp}.webm`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      chunks = [];
      onChange(false);
    };
    mediaRecorder.start(1000); // collect chunks every second
    onChange(true);
  }

  function stop() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    mediaRecorder = null;
  }

  return {
    toggle() { if (mediaRecorder) stop(); else start(); },
    dispose() { stop(); },
  };
}
