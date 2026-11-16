import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { OcrResult } from '../src/features/reader/ocr_worker';
import type { CachedOcr, ReaderInput } from '../src/features/reader/reader_protocol';
import type { ReaderMessage } from '../src/features/reader/selection';

interface Viewer {
  load(input: ReaderInput): Promise<void>;
  recognize(jobId?: string): Promise<void>;
  cancelOcr(): void;
  showOcr(result: CachedOcr): void;
  selectAll(): void;
  dispose(): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let bundledReader: Promise<string> | undefined;
function readerSource() {
  return bundledReader ??= build({
    entryPoints: ['src/features/reader/reader_web.ts'], bundle: true, write: false, format: 'iife',
    define: { PDF_WORKER_SOURCE: '"fixture-pdf-worker"', OCR_WORKER_SOURCE: '"fixture-ocr-worker"' },
    plugins: [{ name: 'reader-commit-pdf-and-ocr-io', setup(bundler) {
      bundler.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf.mjs$/ }, () => ({ path: 'pdf', namespace: 'reader-commit-io' }));
      bundler.onResolve({ filter: /^\.\/ocr_worker$/ }, () => ({ path: 'ocr', namespace: 'reader-commit-io' }));
      bundler.onLoad({ filter: /.*/, namespace: 'reader-commit-io' }, ({ path }) => ({ contents: path === 'pdf'
        ? 'export const { getDocument, GlobalWorkerOptions, TextLayer } = window.readerCommitIO.pdf;'
        : 'export const createOfflineOcr = () => window.readerCommitIO.ocr;' }));
    } }],
  }).then(result => result.outputFiles[0].text);
}

async function fixture(onMessage?: (message: ReaderMessage) => void) {
  const source = await readerSource();
  const dom = new JSDOM('<main id="content"></main>', { runScripts: 'outside-only', url: 'https://reader-fixture.test' });
  const messages: ReaderMessage[] = [];
  const jobs: { entered: ReturnType<typeof deferred<HTMLCanvasElement>>; result: ReturnType<typeof deferred<OcrResult>> }[] = [];
  let active: typeof jobs[number] | undefined;
  let rasterizations = 0;
  let networkRequests = 0;
  const page = {
    view: [0, 0, 600, 800],
    getViewport({ scale }: { scale: number }) {
      return { width: 600 * scale, height: 800 * scale, scale, transform: [scale, 0, 0, -scale, 0, 800 * scale] };
    },
    render({ canvas }: { canvas: HTMLCanvasElement }) {
      assert.ok(canvas instanceof dom.window.HTMLCanvasElement);
      assert.ok(canvas.width > 0 && canvas.height > 0);
      rasterizations++;
      return { promise: Promise.resolve(), cancel() {} };
    },
    async getTextContent() { return { items: [], styles: {} }; },
    cleanup() {},
  };
  const io = {
    pdf: {
      getDocument() {
        return { promise: Promise.resolve({ numPages: 1, async getPage() { return page; } }), async destroy() {} };
      },
      GlobalWorkerOptions: {},
      TextLayer: class { textDivs: HTMLElement[] = []; async render() {} },
    },
    ocr: {
      recognize(canvas: HTMLCanvasElement) {
        const job = jobs.shift();
        assert.ok(job, 'every synthetic worker completion must be explicitly controlled by its test');
        active = job;
        job.entered.resolve(canvas);
        return job.result.promise.finally(() => { if (active === job) active = undefined; });
      },
      cancel() { active?.result.reject(new Error('Synthetic worker cancelled')); },
      dispose() { active?.result.reject(new Error('Synthetic worker disposed')); },
    },
  };
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: 640, configurable: true });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => ({}) });
  Object.assign(dom.window.URL, { createObjectURL: () => 'blob:reader-commit-pdf', revokeObjectURL() {} });
  Object.assign(dom.window, {
    readerCommitIO: io,
    Worker: class { terminate() {} },
    fetch: () => { networkRequests++; throw new Error('Reader commit regression attempted network IO'); },
    ReactNativeWebView: { postMessage(raw: string) {
      const message = JSON.parse(raw) as ReaderMessage;
      messages.push(message); onMessage?.(message);
    } },
  });
  dom.window.eval(source);
  const api = dom.window.TopicTrailReader as Viewer;
  try {
    // Only PDF raster/worker IO is represented. The viewer, DOM, selection,
    // protocol and annotation code are the actual bundled production modules.
    await api.load({ format: 'pdf', base64: 'JVBERi0xLjQK', dark: false });
    assert.ok(messages.some(message => message.type === 'page' && message.page === 1 && !message.hasText));
    assert.equal(messages.some(message => message.type === 'error'), false);
    assert.equal(rasterizations, 1);
  } catch (error) { api.dispose(); dom.window.close(); throw error; }

  return {
    api, messages, document: dom.window.document,
    nextJob() {
      const job = { entered: deferred<HTMLCanvasElement>(), result: deferred<OcrResult>() };
      jobs.push(job);
      return job;
    },
    async dispose() {
      api.dispose();
      await Promise.resolve();
      dom.window.close();
      assert.equal(networkRequests, 0);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function selected(f: Fixture) {
  f.api.selectAll();
  const message = f.messages.filter((value): value is Extract<ReaderMessage, { type: 'selection' }> => value.type === 'selection').at(-1);
  assert.ok(message, 'real viewer must emit a selection message');
  return message;
}
function assertUnexposed(f: Fixture) {
  assert.equal(f.document.querySelector('[data-ocr-result]'), null);
  assert.equal(f.document.querySelector('[data-annotation-surface="ocr-text"]'), null);
  const selection = selected(f);
  assert.equal(selection.text, '');
  assert.equal(selection.anchor, undefined);
}
function assertAccepted(f: Fixture, text: string) {
  const nodes = f.document.querySelectorAll<HTMLElement>('[data-ocr-text]');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].textContent, text);
  assert.equal(nodes[0].dataset.annotationText, text);
  assert.equal(nodes[0].dataset.annotationSurface, 'ocr-text');
  assert.equal(nodes[0].dataset.annotationBlock, 'ocr-page-text');
  const selection = selected(f);
  assert.equal(selection.text, text);
  assert.equal(selection.anchor?.quote, text);
  assert.deepEqual(selection.anchor?.ranges, [{ blockId: 'ocr-page-text', startUtf16: 0, endUtf16: text.length }]);
  return nodes[0];
}

test('RR04: completed worker text is emitted but not visible or selectable before explicit host acceptance', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const job = f.nextJob();
    const raw = { text: '  Niño reads the worker result.\nSecond line.  ', confidence: 92 };
    const start = f.messages.length;
    const complete = f.api.recognize('commit-1');
    await job.entered.promise;
    job.result.resolve(raw);
    await complete;
    assert.deepEqual(f.messages.filter(message => message.type === 'ocr-result'),
      [{ type: 'ocr-result', page: 1, ...raw, truncated: false, jobId: 'commit-1' }]);
    assert.equal(f.messages.slice(start).some(message => message.type === 'surface-change'), false, 'a proposed result is not an accepted surface');
    assertUnexposed(f);
    f.api.showOcr({ page: 1, ...raw, truncated: false });
    assertAccepted(f, raw.text);
    assert.equal(f.messages.slice(start).filter(message => message.type === 'surface-change').length, 1);
  } finally { await f.dispose(); }
});

test('RR04: delayed parent cancellation after an ignored worker result leaves no new OCR surface', { timeout: 10_000 }, async () => {
  let parentCancelled = false;
  const ignored: ReaderMessage[] = [];
  const f = await fixture(message => {
    if (message.type === 'ocr-result' && parentCancelled) ignored.push(message);
  });
  try {
    const job = f.nextJob();
    const complete = f.api.recognize('cancel-delayed');
    await job.entered.promise;
    // Parent invalidates the job now; its cancel transport is deliberately not
    // delivered until after the actual iframe has emitted the worker result.
    parentCancelled = true;
    job.result.resolve({ text: 'Late transcript from the cancelled job', confidence: 90 });
    await complete;
    assert.equal(ignored.length, 1);
    assert.equal(ignored[0].type === 'ocr-result' && ignored[0].jobId, 'cancel-delayed');
    f.api.cancelOcr();
    assertUnexposed(f);
    assert.equal(f.document.getElementById('content')?.textContent?.includes('Late transcript'), false);
  } finally { await f.dispose(); }
});

test('RR04: cancelling a later pending or completed job preserves previously accepted cached text', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const cached = '  Accepted cached Niño text.\n\nKeep exact offsets.  \n';
    f.api.showOcr({ page: 1, text: cached, confidence: null, truncated: false });
    const originalNode = assertAccepted(f, cached);

    const pending = f.nextJob();
    const pendingCompletion = f.api.recognize('cancel-pending');
    await pending.entered.promise;
    f.api.cancelOcr();
    await pendingCompletion;
    pending.result.resolve({ text: 'Cancelled worker completion', confidence: 88 });
    assert.equal(assertAccepted(f, cached), originalNode);
    assert.equal(f.messages.filter(message => message.type === 'ocr-result').length, 0);

    const finished = f.nextJob();
    const finishedCompletion = f.api.recognize('cancel-after-result');
    await finished.entered.promise;
    finished.result.resolve({ text: 'Unaccepted newer worker transcript', confidence: 89 });
    await finishedCompletion;
    assert.equal(f.messages.filter(message => message.type === 'ocr-result').length, 1);
    f.api.cancelOcr();
    assert.equal(assertAccepted(f, cached), originalNode, 'cancellation must neither remove nor replace the accepted surface');
  } finally { await f.dispose(); }
});

test('RR04: optional-job-ID direct recognition exposes only the exact canonical host winner, not raw worker text', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const job = f.nextJob();
    const raw = { text: 'Raw losing worker text: Nino.', confidence: 96 };
    const complete = f.api.recognize();
    await job.entered.promise;
    job.result.resolve(raw);
    await complete;
    assert.deepEqual(f.messages.filter(message => message.type === 'ocr-result'),
      [{ type: 'ocr-result', page: 1, ...raw, truncated: false }]);
    assertUnexposed(f);
    const canonical = '  Niño reads; Doña writes.\n\nExact  spaces; punctuation!  \n';
    f.api.showOcr({ page: 1, text: canonical, confidence: null, truncated: false });
    assertAccepted(f, canonical);
    assert.equal(f.document.getElementById('content')?.textContent?.includes(raw.text), false);
    assert.equal(f.messages.filter(message => message.type === 'ocr-result').length, 1, 'showOcr must not echo a new recognition result');
  } finally { await f.dispose(); }
});

test('new worker transcripts preserve complete Unicode characters at the 50,000-unit limit', async () => {
  const f = await fixture();
  try {
    const prefix = 'ñ'.repeat(49_999), job = f.nextJob();
    const complete = f.api.recognize('unicode-boundary');
    await job.entered.promise;
    job.result.resolve({ text: prefix + '😀 end', confidence: 90 });
    await complete;
    const result = f.messages.find(message => message.type === 'ocr-result');
    assert.ok(result?.type === 'ocr-result');
    assert.equal(result.text, prefix);assert.equal(result.truncated, true);
    assertUnexposed(f);
  } finally { await f.dispose(); }
});
