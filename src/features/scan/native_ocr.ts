import { NativeModules, Platform } from 'react-native';
import type { ScanPhoto, ScanTranscript } from './photo_contract';

interface NativeOcr {
  version: number; bundledLatin: boolean; engine: string;
  normalizePhoto(uri: string, rotate: boolean): Promise<ScanPhoto>;
  capturePhoto(id: string): Promise<ScanPhoto | null>;
  cancelCapture(id: string): void;
  releasePhoto(uri: string): void;
  previewByteLength?(uri: string): Promise<number>;
  recognizePhoto(uri: string, id: string): Promise<ScanTranscript>;
  recognizePdf(uri: string, hash: string, page: number, id: string): Promise<ScanTranscript>;
  cancelOcr(id: string): void;
}
export function nativeOcr(): NativeOcr {
  const module = Platform.OS === 'android' ? NativeModules.TopicTrailOcr as NativeOcr | undefined : undefined;
  const methods = ['normalizePhoto', 'capturePhoto', 'cancelCapture', 'releasePhoto', 'recognizePhoto', 'recognizePdf', 'cancelOcr'] as const;
  if (module?.version !== 1 || module.bundledLatin !== true || module.engine !== 'mlkit-16.0.1-latin-1'
    || methods.some(method => typeof module[method] !== 'function')) {
    throw new Error('This app build does not include on-device scanning. Install the updated Android build or use TopicTrail on the web.');
  }
  return module;
}
function requestId() { return 'scan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }

export function validateNativePhoto(value: ScanPhoto): ScanPhoto {
  if (!value || typeof value.uri !== 'string' || !/^file:\/\/\/[^?#\r\n]+\/topictrail-scan-previews-v1\/scan-[a-f0-9-]{36}\.jpg$/.test(value.uri)
    || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1
    || value.width > 8192 || value.height > 8192 || value.width * value.height > 4_000_000) {
    throw new Error('The photo preview is unreadable. Choose another JPG or PNG.');
  }
  return { uri: value.uri, width: value.width, height: value.height };
}

/** Cancellation owns only this request, and any late normalized preview is released. */
export async function captureNativePhoto(signal: AbortSignal): Promise<ScanPhoto | null> {
  if (signal.aborted) return null;
  const module = nativeOcr();
  const id = requestId();
  return new Promise((resolve, reject) => {
    let ended = false;
    const finish = () => { ended = true; signal.removeEventListener('abort', abort); };
    const release = (value: ScanPhoto | null) => {
      if (value && typeof value.uri === 'string') { try { module.releasePhoto(value.uri); } catch { /* Native teardown. */ } }
    };
    const abort = () => {
      if (ended) return;
      finish();
      try { module.cancelCapture(id); } catch { /* The old context may already be gone. */ }
      resolve(null);
    };
    const failure = () => {
      if (ended) return;
      finish();
      reject(new Error('The camera is unavailable or the photo could not be prepared. Choose a photo instead.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      void module.capturePhoto(id).then(value => {
        if (ended) { release(value); return; }
        if (!value) { finish(); resolve(null); return; }
        try { const photo = validateNativePhoto(value); finish(); resolve(photo); }
        catch { release(value); failure(); }
      }, failure);
    } catch { failure(); }
  });
}

function recognitionFailure(error: unknown): Error {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'OCR_BUSY': return new Error('Another page is still being recognized. Wait a moment, then try again.');
    case 'OCR_CANCELLED': return new Error('Recognition cancelled.');
    case 'OCR_TIMEOUT': return new Error('Recognition took too long. Try a smaller page or photo.');
    case 'OCR_PREVIEW': return new Error('The scan preview could not be opened. Choose the photo again.');
    case 'OCR_PDF_INPUT': return new Error('This PDF page could not be opened for recognition. Reopen it and try again.');
    case 'OCR_MEMORY': return new Error('There is not enough memory to recognize this image. Try a smaller photo or page.');
    case 'OCR_ENGINE_INIT':
    case 'OCR_ENGINE_UNAVAILABLE': return new Error('The on-device text recognizer is unavailable. Reopen TopicTrail and try again.');
    case 'OCR_ENGINE_PROCESS': return new Error('The on-device recognizer could not process this image. Try a different photo or page.');
    default: return new Error('Recognition could not finish. Try again or use a clearer scan.');
  }
}

export async function runNativeOcr(signal: AbortSignal, run: (module: NativeOcr, id: string) => Promise<ScanTranscript>): Promise<ScanTranscript> {
  if (signal.aborted) throw new Error('Recognition cancelled.');
  const module = nativeOcr();
  const id = requestId();
  return new Promise((resolve, reject) => {
    let ended = false;
    const finish = () => { ended = true; clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const cancel = () => { try { module.cancelOcr(id); } catch { /* Context teardown must not strand the caller. */ } };
    const abort = () => { if (ended) return; finish(); cancel(); reject(new Error('Recognition cancelled.')); };
    const timer = setTimeout(() => { if (!ended) { finish(); cancel(); reject(new Error('Recognition took too long. Try a clearer scan.')); } }, 120_000);
    const failure = (error: unknown) => { if (!ended) { finish(); reject(recognitionFailure(error)); } };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      void run(module, id).then(value => {
        if (ended) return;
        finish();
        if (!value || typeof value.text !== 'string' || value.text.length > 50000 || value.confidence !== null || typeof value.truncated !== 'boolean') reject(new Error('Recognition returned an unreadable result.'));
        else resolve({ text: value.text, confidence: null, truncated: value.truncated });
      }, failure);
    } catch (error) { cancel(); failure(error); }
  });
}
