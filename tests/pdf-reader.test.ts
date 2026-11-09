import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('reader clears previous selected text and releases the worker when a corrupt or protected PDF fails', async () => {
  const bundlerPath = '../scripts/bundle-reader.mjs';
  const { buildOfflineWorker } = await import(bundlerPath);
  const { code } = await buildOfflineWorker();
  runInThisContext(code);
  const workerGlobal = globalThis as typeof globalThis & { pdfjsWorker: { WorkerMessageHandler: { initializeFromPort(port: unknown): void } }; Worker?: unknown };
  const workers: TestWorker[] = [];
  class TestWorker {
    ports = new MessageChannel();
    terminated = false;
    constructor() {
      workers.push(this);
      workerGlobal.pdfjsWorker.WorkerMessageHandler.initializeFromPort(this.ports.port2);
      this.ports.port1.start(); this.ports.port2.start();
    }
    postMessage(...args: Parameters<MessageChannel['port1']['postMessage']>) { this.ports.port1.postMessage(...args); }
    addEventListener(...args: Parameters<MessageChannel['port1']['addEventListener']>) { this.ports.port1.addEventListener(...args); }
    removeEventListener(...args: Parameters<MessageChannel['port1']['removeEventListener']>) { this.ports.port1.removeEventListener(...args); }
    terminate() { this.terminated = true; this.ports.port1.close(); this.ports.port2.close(); }
  }
  const priorWorker = workerGlobal.Worker;
  Object.assign(workerGlobal, { Worker: TestWorker });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const requests: NonNullable<Parameters<typeof pdfjs.getDocument>[0]>[] = [];
  const realPdfjs = { ...pdfjs, getDocument: (source: Parameters<typeof pdfjs.getDocument>[0]) => {
    if (source) requests.push(source);
    return pdfjs.getDocument(source);
  } };
  const result = await build({ entryPoints: ['src/features/reader/reader_web.ts'], bundle: true, write: false, format: 'iife',
    define: { PDF_WORKER_SOURCE: JSON.stringify(code) }, plugins: [{ name: 'node-real-pdfjs', setup(bundler) {
      bundler.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf.mjs$/ }, () => ({ path: 'pdfjs', namespace: 'test' }));
      // The actual installed PDF.js API is shared with the DOM test; only the
      // WebView/worker port is represented by an in-process MessageChannel.
      bundler.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const { getDocument, GlobalWorkerOptions, TextLayer } = window.testPdfjs;' }));
    } }] });
  const dom = new JSDOM('<main id="content"></main>', { runScripts: 'outside-only' });
  const messages: { type: string; text?: string; message?: string }[] = [];
  let revoked = 0;
  Object.assign(dom.window, { testPdfjs: realPdfjs, Worker: TestWorker, ReactNativeWebView: { postMessage: (json: string) => messages.push(JSON.parse(json)) } });
  Object.assign(dom.window.URL, { createObjectURL: () => 'blob:test-reader', revokeObjectURL: () => { revoked++; } });
  try {
    dom.window.eval(result.outputFiles[0].text);
    const api = dom.window.TopicTrailReader;
    for (const bytes of [new TextEncoder().encode('not a PDF'), await readFile('tests/fixtures/password-protected.pdf')]) {
      await api.load({ format: 'docx', paragraphs: ['Previous private selection'], dark: false });
      api.selectAll();
      assert.equal(messages.at(-1)?.text, 'Previous private selection');
      await api.load({ format: 'pdf', base64: Buffer.from(bytes).toString('base64'), dark: false });
      assert.equal(messages.at(-1)?.type, 'error');
      assert.match(messages.at(-1)?.message ?? '', bytes.length === 9 ? /damaged|valid PDF/ : /password protected/);
      assert.equal(requests.at(-1)?.useWorkerFetch, true, 'reader must route requests through the offline worker adapter');
      assert.equal(requests.at(-1)?.useWasm, true);
      assert.equal(requests.at(-1)?.useSystemFonts, false, 'reader must use its packaged font data');
      assert.equal(dom.window.document.querySelector('main')!.textContent, '', 'failed load must remove previous content');
      assert.equal(dom.window.getSelection()?.toString(), '');
      assert.ok(workers.at(-1)?.terminated, 'failed PDF worker must be released');
      assert.equal(revoked, workers.length, 'each worker Blob URL must be revoked');
    }
  } finally {
    workers.forEach(worker => worker.terminate());
    pdfjs.GlobalWorkerOptions.workerPort = null;
    Object.assign(workerGlobal, { Worker: priorWorker });
    dom.window.close();
  }
});
