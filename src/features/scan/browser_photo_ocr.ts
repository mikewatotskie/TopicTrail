import { createOfflineOcr } from '../reader/ocr_worker';
import type { ScanPhoto, ScanTranscript } from './photo_contract';
import { browserPhotoCanvas } from './browser_photo';
import { abortablePhoto, checkPhotoSignal } from './photo_abort';

const MAX_WORKER_BYTES = 32 * 1024 * 1024;

/** Only bundled, same-origin code is loaded. Cache public worker bytes in memory, never photos. */
export function createPhotoOcrLoader(assetUri: () => string, baseUri: () => string, transport: typeof fetch = fetch) {
  let source: Promise<string> | undefined;
  return function load(): Promise<string> {
    return source ??= (async () => {
      const base = new URL(baseUri()), url = new URL(assetUri(), base);
      if (url.origin !== base.origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('The bundled photo OCR must load from this application.');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await abortablePhoto(transport(url.href, { signal: controller.signal, credentials: 'omit', redirect: 'error' }), controller.signal);
        if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== base.origin)) throw new Error('The bundled photo OCR could not be loaded. Reconnect and try again.');
        const declared = Number(response.headers.get('content-length'));
        if (declared > MAX_WORKER_BYTES) throw new Error('The bundled photo OCR exceeds its size limit.');
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (!response.body) throw new Error('The bundled photo OCR could not be read.');
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await abortablePhoto(reader.read(), controller.signal);
            if (done) break;
            size += value.byteLength;
            if (size > MAX_WORKER_BYTES) throw new Error('The bundled photo OCR exceeds its size limit.');
            chunks.push(value);
          }
        } catch (error) { void reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!text.startsWith("'use strict';") || !text.includes('const topicTrailWasm=') || !text.includes('const topicTrailFilipino=')) throw new Error('The bundled photo OCR is invalid. Reload the app and try again.');
        return text;
      } finally { clearTimeout(timeout); }
    })().catch(error => { source = undefined; throw error; });
  };
}

/** Each photo operation owns its worker; abort/dispose always frees worker and canvas. */
export async function recognizeBrowserPhoto(photo: ScanPhoto, signal: AbortSignal, loadSource: () => Promise<string>): Promise<ScanTranscript> {
  checkPhotoSignal(signal);
  const source = await abortablePhoto(loadSource(), signal);
  checkPhotoSignal(signal);
  const canvas = await browserPhotoCanvas(photo, signal);
  let ocr: ReturnType<typeof createOfflineOcr> | undefined;
  const cancel = () => ocr?.dispose();
  try {
    checkPhotoSignal(signal);
    ocr = createOfflineOcr(source);
    signal.addEventListener('abort', cancel, { once: true });
    const result = await abortablePhoto(ocr.recognize(canvas), signal);
    checkPhotoSignal(signal);
    let text = result.text.slice(0, 50_000);
    // Do not leave a split surrogate at the transcript limit.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return { text, confidence: result.confidence, truncated: result.text.length > text.length };
  } finally {
    signal.removeEventListener('abort', cancel); ocr?.dispose();
    canvas.width = 0; canvas.height = 0;
  }
}
