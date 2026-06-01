let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

export function startRecording(canvas: HTMLCanvasElement): void {
  if (recorder) return;
  const stream = canvas.captureStream(30);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  recorder = new MediaRecorder(stream, { mimeType });
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = saveRecording;
  recorder.start();
}

export function stopRecording(): void {
  recorder?.stop();
  recorder = null;
}

function saveRecording(): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `pattern-projector-Ulrich_Tausend-1000lights.de-${timestamp}.webm`;
  const blob = new Blob(chunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
