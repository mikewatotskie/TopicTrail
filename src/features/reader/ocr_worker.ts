/** Local-only OCR for a PDF.js-rendered canvas. No URL or document-byte input is accepted. */
export interface OcrResult { text: string; confidence: number }
export interface OcrProgress { status: string; progress: number }
export interface OfflineOcr {
  recognize(canvas: HTMLCanvasElement): Promise<OcrResult>;
  cancel(): void;
  dispose(): void;
}

const MAX_PIXELS = 4_000_000;
const MAX_DIMENSION = 8192;
const MAX_PNG_BYTES = 16 * 1024 * 1024;
const MAX_TEXT = 1_000_000;
const JOB_TIMEOUT = 120_000;

export function createOfflineOcr(workerSource: string, onProgress?: (progress: OcrProgress) => void): OfflineOcr {
  if (typeof workerSource !== 'string' || !workerSource || workerSource.length > 32 * 1024 * 1024) {
    throw new Error('The bundled offline OCR worker is unavailable.');
  }
  let disposed = false;
  let worker: Worker | undefined;
  let workerUrl: string | undefined;
  let initialized: Promise<void> | undefined;
  let sequence = 0;
  let active: { resolve: (value: OcrResult) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();

  function stop(error: Error) {
    worker?.terminate();
    worker = undefined;
    initialized = undefined;
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    workerUrl = undefined;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  function fail(error: Error) {
    const job = active;
    active = undefined;
    if (job) { clearTimeout(job.timer); job.reject(error); }
    stop(error);
  }
  function ensureWorker() {
    if (worker) return worker;
    if (typeof Worker !== 'function' || typeof WebAssembly !== 'object') throw new Error('Offline OCR is unavailable in this reader runtime.');
    workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const instance = new Worker(workerUrl);
    worker = instance;
    instance.onmessage = ({ data }: MessageEvent) => {
      if (worker !== instance || !data || typeof data !== 'object') return;
      const request = pending.get(data.jobId);
      if (!request) return;
      if (data.status === 'progress') {
        if (active && typeof data.data?.progress === 'number' && Number.isFinite(data.data.progress)) {
          try { onProgress?.({ status: typeof data.data.status === 'string' ? data.data.status.slice(0, 120) : 'Recognizing text', progress: Math.max(0, Math.min(1, data.data.progress)) }); } catch { /* UI callbacks cannot strand worker promises. */ }
        }
        return;
      }
      pending.delete(data.jobId);
      if (data.status === 'resolve') request.resolve(data.data);
      else request.reject(new Error('Offline OCR could not recognize this page. Try a smaller, clearer page image.'));
    };
    instance.onerror = () => { if (worker === instance) fail(new Error('Offline OCR stopped. The page may exceed available memory.')); };
    instance.onmessageerror = () => { if (worker === instance) fail(new Error('Offline OCR returned an unreadable result.')); };
    return instance;
  }
  function request(action: string, payload: unknown): Promise<unknown> {
    const instance = ensureWorker();
    const jobId = 'topictrail-ocr-' + (++sequence);
    return new Promise((resolve, reject) => {
      pending.set(jobId, { resolve, reject });
      try { instance.postMessage({ workerId: 'topictrail-offline-ocr', jobId, action, payload }); }
      catch { pending.delete(jobId); reject(new Error('The OCR page could not be sent to the local worker.')); }
    });
  }
  function initialize(current: () => void): Promise<void> {
    return initialized ??= (async () => {
      current();
      await request('load', { options: { lstmOnly: true, logging: false } });
      current();
      await request('loadLanguage', { langs: 'eng+fil', options: { cacheMethod: 'none', lstmOnly: true, gzip: true } });
      current();
      await request('initialize', { langs: 'eng+fil', oem: 1, config: { user_defined_dpi: '300' } });
      current();
    })();
  }

  return {
    recognize(canvas) {
      if (disposed) return Promise.reject(new Error('This OCR reader has been disposed.'));
      if (active) return Promise.reject(new Error('An OCR job is already running.'));
      if (!canvas || !Number.isSafeInteger(canvas.width) || !Number.isSafeInteger(canvas.height) ||
          canvas.width < 1 || canvas.height < 1 || canvas.width > MAX_DIMENSION || canvas.height > MAX_DIMENSION) {
        return Promise.reject(new Error('The OCR image dimensions are invalid.'));
      }
      if (canvas.width * canvas.height > MAX_PIXELS) return Promise.reject(new Error('OCR accepts at most 4 million pixels per page. Render a smaller page image.'));
      return new Promise<OcrResult>((resolve, reject) => {
        const job = { resolve, reject, timer: setTimeout(() => fail(new Error('Offline OCR timed out. Try a smaller page image.')), JOB_TIMEOUT) };
        active = job;
        const current = () => { if (active !== job || disposed) throw new Error('OCR was cancelled.'); };
        void (async () => {
          const blob = await new Promise<Blob>((done, no) => {
            canvas.toBlob(value => value ? done(value) : no(new Error('This page image could not be prepared for OCR.')), 'image/png');
          });
          current();
          if (blob.size > MAX_PNG_BYTES || blob.size === 0) throw new Error('The OCR page image exceeds the local size limit.');
          const image = new Uint8Array(await blob.arrayBuffer());
          current();
          await initialize(current);
          current();
          const data = await request('recognize', { image, options: { rotateAuto: true }, output: { text: true, blocks: false } }) as Partial<OcrResult>;
          current();
          if (!data || typeof data.text !== 'string' || data.text.length > MAX_TEXT || typeof data.confidence !== 'number' ||
              !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 100) throw new Error('Offline OCR returned invalid text.');
          active = undefined;
          clearTimeout(job.timer);
          job.resolve({ text: data.text, confidence: data.confidence });
        })().catch(error => {
          if (active === job) fail(error instanceof Error ? error : new Error('Offline OCR failed.'));
        });
      });
    },
    cancel() { fail(new Error('OCR was cancelled.')); },
    dispose() { disposed = true; fail(new Error('This OCR reader has been disposed.')); },
  };
}
