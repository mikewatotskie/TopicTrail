import type { ScanPhoto } from './photo_contract';
import { captureBrowserPhoto, releaseBrowserPhoto } from './browser_photo';
import { abortablePhoto, checkPhotoSignal } from './photo_abort';

export type BrowserCameraState = 'idle' | 'requesting' | 'ready' | 'capturing';
export interface BrowserCamera {
  open(): Promise<void>; capture(): Promise<void>; close(): void; dispose(): void;
}
interface CameraOptions {
  video(): HTMLVideoElement | null;
  onState(state: BrowserCameraState): void;
  onPhoto(photo: ScanPhoto): void;
  onError(message: string): void;
  onActiveChange?(active: boolean): void;
  secure?: () => boolean;
  visible?: () => boolean;
  getMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  captureFrame?: typeof captureBrowserPhoto;
  releasePhoto?: typeof releaseBrowserPhoto;
}

export function stopCameraStream(stream: MediaStream) {
  for (const track of stream.getTracks()) { try { track.stop(); } catch { /* Stop the remaining tracks too. */ } }
}

function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was not granted. You can still choose a photo.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No usable camera was found. Choose a JPG or PNG photo instead.';
  if (name === 'NotReadableError') return 'The camera is busy or unavailable. Close other camera apps, or choose a photo.';
  return 'The camera could not open or capture a photo. You can still choose a photo.';
}

function waitForVideo(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer); video.removeEventListener('loadeddata', ready); video.removeEventListener('canplay', ready);
      video.removeEventListener('error', error); signal.removeEventListener('abort', abort);
    };
    const ready = () => { if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) { cleanup(); resolve(); } };
    const error = () => { cleanup(); reject(new Error('Camera preview is unavailable.')); };
    const abort = () => { cleanup(); try { checkPhotoSignal(signal); } catch (reason) { reject(reason); } };
    const timer = setTimeout(error, 15_000);
    video.addEventListener('loadeddata', ready); video.addEventListener('canplay', ready); video.addEventListener('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else ready();
  });
}

/** Construction never requests permission. open() is called only by the explicit camera button. */
export function createBrowserCamera(options: CameraOptions): BrowserCamera {
  let disposed = false, state: BrowserCameraState = 'idle';
  let operation: AbortController | undefined, stream: MediaStream | undefined, attached: HTMLVideoElement | undefined;
  let removeEnded: (() => void) | undefined;
  const visible = options.visible ?? (() => document.visibilityState !== 'hidden');
  const release = options.releasePhoto ?? releaseBrowserPhoto;
  const setState = (next: BrowserCameraState) => {
    const wasActive = state !== 'idle'; state = next;
    if (!disposed) options.onState(next);
    if (wasActive !== (next !== 'idle')) options.onActiveChange?.(next !== 'idle');
  };
  const stop = () => {
    removeEnded?.(); removeEnded = undefined;
    if (stream) stopCameraStream(stream);
    stream = undefined;
    if (attached) {
      const video = attached; attached = undefined;
      try { video.pause(); } catch { /* Still detach a stopped stream if the element was removed. */ }
      video.srcObject = null;
    }
  };
  const close = () => { operation?.abort(); operation = undefined; stop(); setState('idle'); };
  const current = (run: AbortController) => !disposed && operation === run && !run.signal.aborted && visible();
  return {
    async open() {
      if (disposed || state !== 'idle' || !visible()) return;
      if (!(options.secure ?? (() => globalThis.isSecureContext === true))()) {
        options.onError('Camera access requires HTTPS or localhost. You can still choose a photo.'); return;
      }
      const getMedia = options.getMedia ?? (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints) : undefined);
      if (!getMedia) { options.onError('Camera access is unavailable in this browser. You can still choose a photo.'); return; }
      const run = new AbortController(); operation = run; setState('requesting');
      try {
        const acquired = await abortablePhoto(getMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false }), run.signal, stopCameraStream);
        if (!current(run)) { stopCameraStream(acquired); if (operation === run) close(); return; }
        stream = acquired;
        if (!stream.getVideoTracks().some(track => track.readyState === 'live') || stream.getAudioTracks().length) throw new Error('A video-only stream is required.');
        const ended = () => { if (operation === run) { close(); if (!disposed) options.onError('The camera stopped. Open it again, or choose a photo.'); } };
        for (const track of stream.getTracks()) track.addEventListener('ended', ended);
        removeEnded = () => { for (const track of acquired.getTracks()) track.removeEventListener('ended', ended); };
        const video = options.video();
        if (!video) throw new Error('Camera preview is unavailable.');
        attached = video; video.muted = true; video.playsInline = true; video.srcObject = acquired;
        await abortablePhoto(Promise.all([video.play(), waitForVideo(video, run.signal)]), run.signal);
        if (!current(run)) { if (operation === run) close(); return; }
        setState('ready');
      } catch (error) {
        if (operation !== run) return;
        close();
        if (!disposed && visible() && (error as Error)?.name !== 'AbortError') options.onError(cameraError(error));
      }
    },
    async capture() {
      const run = operation, video = attached;
      if (!run || !video || !current(run) || state !== 'ready') return;
      setState('capturing');
      try {
        const photo = await abortablePhoto((options.captureFrame ?? captureBrowserPhoto)(video, run.signal, stop), run.signal, release);
        if (!current(run)) { release(photo); if (operation === run) close(); return; }
        close();
        if (disposed) release(photo); else options.onPhoto(photo);
      } catch (error) {
        if (operation !== run) return;
        close();
        if (!disposed && visible() && (error as Error)?.name !== 'AbortError') options.onError(cameraError(error));
      }
    },
    close,
    dispose() { disposed = true; close(); },
  };
}

export function bindCameraPageLifetime(camera: BrowserCamera, page: Document = document, host: Window = window) {
  const hide = () => { if (page.visibilityState === 'hidden') camera.close(); };
  const leave = () => camera.close();
  page.addEventListener('visibilitychange', hide); host.addEventListener('pagehide', leave);
  return () => { page.removeEventListener('visibilitychange', hide); host.removeEventListener('pagehide', leave); };
}
