type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
};
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
};

export function isFullscreen(): boolean {
  const d = document as FsDocument;
  return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement);
}

export async function enter(el: HTMLElement = document.documentElement): Promise<void> {
  const e = el as FsElement;
  if (e.requestFullscreen) await e.requestFullscreen();
  else if (e.webkitRequestFullscreen) await e.webkitRequestFullscreen();
}

export async function exit(): Promise<void> {
  const d = document as FsDocument;
  if (d.exitFullscreen) await d.exitFullscreen();
  else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
}

export async function toggle(el?: HTMLElement): Promise<void> {
  if (isFullscreen()) await exit();
  else await enter(el);
}
