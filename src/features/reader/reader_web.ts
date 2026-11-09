import { validateReaderInput, type ReaderInput, type ReaderCommand } from './reader_protocol';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { captureSelection, buildSelectionMessage } from './selection';
import { renderDocxParagraphs } from './document_dom';
import { offlinePdfOptions } from './pdf_offline';
import { extractPdfPageText } from '../../core/services/pdf_text_extraction';

declare const PDF_WORKER_SOURCE: string;
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    TopicTrailReader: { load(input: ReaderInput): Promise<void>; page(value: number): void;
      zoom(value: number): void; selectAll(): void; clearSelection(): void; theme(dark: boolean): void; dispose(): void };
  }
}
const content = document.getElementById('content')!;
let pdf: PDFDocumentProxy | undefined;
let loadingTask: PDFDocumentLoadingTask | undefined;
let worker: Worker | undefined;
let workerUrl: string | undefined;
let paragraphs: string[] = [];
let format: 'pdf' | 'docx' = 'docx';
let current = 1;
let totalPages = 1;
let scale = 1;
let queue: Promise<void> = Promise.resolve();
let hasInput = false;
let webPort: MessagePort | undefined;
let disposed = false;
let commandGeneration = 0;
let executingGeneration = 0;
let renderedGeneration = -1;
const session = document.documentElement.dataset.readerSession;
const parentOrigin = document.documentElement.dataset.parentOrigin;
const send = (data: object) => {
  if (disposed) return;
  window.ReactNativeWebView?.postMessage(JSON.stringify(data));
  webPort?.postMessage({ protocol: 1, session, generation: executingGeneration, message: data });
};
function fail(error: unknown) {
  clearSelection(); content.replaceChildren();
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  const message = name === 'PasswordException' ? 'This PDF is password protected. Import an unlocked copy to read it.'
    : name === 'InvalidPDFException' ? 'This PDF is damaged or is not a valid PDF. Try another copy.'
    : error instanceof Error ? error.message : 'Unable to read document';
  send({ type: 'error', message });
}
async function disposePdf() {
  const task = loadingTask;
  loadingTask = undefined; pdf = undefined;
  try { await task?.destroy(); }
  finally {
    worker?.terminate(); worker = undefined; GlobalWorkerOptions.workerPort = null;
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    workerUrl = undefined;
  }
}
function clearSelection() { window.getSelection()?.removeAllRanges(); send({ type: 'selection', text: '', page: current }); }
function selection() {
  if (webPort && renderedGeneration !== commandGeneration) return;
  const text = captureSelection(content, window.getSelection());
  send(buildSelectionMessage(text, current));
}
async function render() {
  clearSelection();
  content.replaceChildren();
  content.className = format;
  let hasText = false;
  if (format === 'pdf' && pdf) {
    const page = await pdf.getPage(current);
    const natural = page.getViewport({ scale: 1 });
    const fit = Math.max(240, document.documentElement.clientWidth - 32) / natural.width;
    const viewport = page.getViewport({ scale: fit * scale });
    content.style.width = viewport.width + 'px';
    content.style.height = viewport.height + 'px';
    content.style.setProperty('--total-scale-factor', String(viewport.scale));
    const canvas = document.createElement('canvas');
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
    content.appendChild(canvas);
    const text = document.createElement('div'); text.className = 'textLayer'; content.appendChild(text);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PDF rendering is unavailable in this WebView');
    await page.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] }).promise;
    const textContent = await page.getTextContent();
    await new TextLayer({ textContentSource: textContent, container: text, viewport }).render();
    hasText = !!(await extractPdfPageText(page)).trim();
    page.cleanup();
  } else {
    content.style.width = 'auto'; content.style.height = 'auto';
    content.style.fontSize = 16 * scale + 'px';
    const section = paragraphs.slice((current - 1) * 20, current * 20);
    renderDocxParagraphs(content, section);
    hasText = section.some(value => !!value.trim());
  }
  renderedGeneration = executingGeneration;
  send({ type: 'page', page: current, totalPages, hasText });
}
function enqueue(operation: () => Promise<void>) {
  const generation = commandGeneration;
  queue = queue.then(async () => { if (disposed) return; executingGeneration = generation; await operation(); }).catch(fail);
  return queue;
}
window.TopicTrailReader = {
  async load(input) {
    if (!validateReaderInput(input)) { fail(new Error('Invalid document input.')); return; }
    return enqueue(async () => {
      try {
        clearSelection(); content.replaceChildren(); paragraphs = [];
        await disposePdf();
        document.documentElement.dataset.theme = input.dark ? 'dark' : 'light';
        format = input.format; current = 1; totalPages = 1; scale = 1; hasInput = true;
        if (format === 'pdf') {
          workerUrl = URL.createObjectURL(new Blob([PDF_WORKER_SOURCE], { type: 'text/javascript' }));
          worker = new Worker(workerUrl);
          GlobalWorkerOptions.workerPort = worker;
          const bytes = input.format === 'pdf' && input.bytes ? new Uint8Array(input.bytes) : Uint8Array.from(atob(input.base64 ?? ''), char => char.charCodeAt(0));
          loadingTask = getDocument({ data: bytes, ...offlinePdfOptions });
          pdf = await loadingTask.promise;
          totalPages = pdf.numPages;
        } else { paragraphs = input.paragraphs ?? []; totalPages = Math.max(1, Math.ceil(paragraphs.length / 20)); }
        await render();
      } catch (error) {
        await disposePdf().catch(() => undefined); fail(error);
      }
    });
  },
  page(value) { enqueue(async () => { current = Math.max(1, Math.min(totalPages, Math.floor(value))); await render(); window.scrollTo(0, 0); }); },
  zoom(value) { enqueue(async () => { scale = Math.max(0.5, Math.min(3, value)); await render(); }); },
  selectAll() {
    const range = document.createRange();
    range.selectNodeContents(format === 'pdf' ? content.querySelector('.textLayer') ?? content : content);
    const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range); selection();
  },
  clearSelection,
  theme(dark) { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; },
  dispose() { if (disposed) return; clearSelection(); disposed = true; webPort?.close(); webPort = undefined; content.replaceChildren(); void disposePdf().catch(() => undefined); },
};
document.addEventListener('selectionchange', selection);
document.addEventListener('click', event => { if ((event.target as HTMLElement).closest('a')) event.preventDefault(); });
window.addEventListener('error', event => fail(new Error(event.message)));
window.addEventListener('unhandledrejection', event => fail(event.reason));
window.addEventListener('pagehide', () => window.TopicTrailReader.dispose());
send({ type: 'ready' });



// Only the controlled parent can bind the opaque-origin web frame. Native transport remains separate.
function bootstrap(event: MessageEvent) {
  if (disposed || !session || !parentOrigin || webPort || event.source !== window.parent || event.origin !== parentOrigin
      || event.data?.protocol !== 1 || event.data?.session !== session) return;
  if (event.data.type === 'topictrail-probe') {
    window.parent.postMessage({ protocol: 1, type: 'topictrail-ready', session }, parentOrigin); return;
  }
  if (event.data.type !== 'topictrail-connect' || event.ports.length !== 1) return;
  webPort = event.ports[0]; window.removeEventListener('message', bootstrap);
  webPort.onmessage = event => {
    const envelope = event.data;
    if (disposed || envelope?.protocol !== 1 || envelope.session !== session || !Number.isSafeInteger(envelope.generation)
      || envelope.generation < commandGeneration || !envelope.command) return;
    const command = envelope.command as ReaderCommand;
    const api = window.TopicTrailReader;
    if (command.type === 'load' || command.type === 'page' || command.type === 'zoom') {
      if (envelope.generation <= commandGeneration) return;
      commandGeneration = envelope.generation; renderedGeneration = -1;
    }
    switch (command.type) {
      case 'load': if (validateReaderInput(command.input)) void api.load(command.input); break;
      case 'page': if (Number.isInteger(command.value) && command.value >= 1) api.page(command.value); break;
      case 'zoom': if (Number.isFinite(command.value)) api.zoom(command.value); break;
      case 'selectAll': if (renderedGeneration === commandGeneration) api.selectAll(); break;
      case 'clearSelection': api.clearSelection(); break;
      case 'theme': if (typeof command.dark === 'boolean') api.theme(command.dark); break;
      case 'dispose': api.dispose(); break;
    }
  };
  webPort.start(); send({ type: 'ready' });
}
window.addEventListener('message', bootstrap);

let lastWidth = document.documentElement.clientWidth;
window.addEventListener('resize', () => {
  const width = document.documentElement.clientWidth;
  if (disposed || !hasInput || width === lastWidth) return;
  lastWidth = width; renderedGeneration = -1;
  enqueue(async () => { await render(); });
});
