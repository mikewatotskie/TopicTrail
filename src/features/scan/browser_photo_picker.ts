import { photoCancelled } from './photo_abort';

/** Runs synchronously from the Choose photo gesture; no source object URL is created. */
export function pickBrowserPhotoFile(signal?: AbortSignal): Promise<File | null> {
  if (typeof document === 'undefined') return Promise.reject(new Error('Photo selection is available in the browser.'));
  if (signal?.aborted) return Promise.reject(photoCancelled());
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png'; input.multiple = false;
  input.style.display = 'none'; input.tabIndex = -1;
  document.body.appendChild(input);
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      input.removeEventListener('change', change); input.removeEventListener('cancel', cancel);
      window.removeEventListener('pagehide', cancel); signal?.removeEventListener('abort', abort);
      input.remove();
    };
    const finish = (file: File | null) => { if (!done) { done = true; cleanup(); resolve(file); } };
    const change = () => finish(input.files?.[0] ?? null);
    const cancel = () => finish(null);
    const abort = () => { if (!done) { done = true; cleanup(); reject(photoCancelled()); } };
    input.addEventListener('change', change); input.addEventListener('cancel', cancel);
    window.addEventListener('pagehide', cancel); signal?.addEventListener('abort', abort, { once: true });
    try { input.click(); } catch { done = true; cleanup(); reject(new Error('Photo selection could not open. Tap Choose photo again.')); }
  });
}
