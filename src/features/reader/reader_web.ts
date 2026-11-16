import { validateReaderInput, validateCachedOcr, validateReaderAnnotations, type ReaderAnnotation, type ReaderEnvelope, type CachedOcr, type ReaderInput, type ReaderCommand } from './reader_protocol';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { captureSelection, buildSelectionMessage } from './selection';
import { renderDocxParagraphs, renderPptxSlide } from './document_dom';
import type { PptxSlide } from '../../core/services/pptx_parser';
import { offlinePdfOptions } from './pdf_offline';
import { extractPdfPageText } from '../../core/services/pdf_text_extraction';
import { createOfflineOcr, type OfflineOcr } from './ocr_worker';
import { captureTextAnchor } from './reader_anchors';
import { installAnnotationStyles, drawAnnotations, revealAnnotation } from './reader_overlays';
import { createAreaController, type RegionViewport } from './reader_regions';
import type { RegionAnchorV1 } from '../../core/services/annotations/types';

declare const PDF_WORKER_SOURCE: string;
declare const OCR_WORKER_SOURCE: string;
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    TopicTrailReader: { load(input: ReaderInput): Promise<void>; page(value: number): void;
      zoom(value: number): void; selectAll(): void; clearSelection(): void; theme(dark: boolean): void; dispose(): void;
      recognize(jobId?: string): Promise<void>; cancelOcr(): void; showOcr(value: CachedOcr): void;
      setAnnotations(items:ReaderAnnotation[]):void;revealAnnotation(id:string):void;markArea(mode:'drag'|'corners'):void;cancelArea():void;
      connectNative(session:string):void;dispatch(envelope:ReaderEnvelope):void;focus():void };
  }
}
const content = document.getElementById('content')!;
installAnnotationStyles(document);
let annotations:ReaderAnnotation[]=[];
let annotationsPage=0;
let pdfSurface:HTMLElement|undefined;
let regionViewport:RegionViewport|undefined;
let area:ReturnType<typeof createAreaController>|undefined;
let retainedPreview:RegionAnchorV1|undefined;
let nativeSession:string|undefined;
let pdf: PDFDocumentProxy | undefined;
let loadingTask: PDFDocumentLoadingTask | undefined;
let worker: Worker | undefined;
let workerUrl: string | undefined;
let paragraphs: string[] = [];
let slides:PptxSlide[]=[];
let format: 'pdf' | 'docx' | 'pptx' = 'docx';
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
let viewRevision = 0;
let executingViewRevision = 0;
let renderedViewRevision = -1;
let ocrRevision = 0;
let ocr: OfflineOcr | undefined;
let ocrRenderTask: { cancel(): void; promise: Promise<void> } | undefined;
let ocrJob: { revision: number; view: number; page: number; document: PDFDocumentProxy; jobId?: string } | undefined;
const session = document.documentElement.dataset.readerSession;
const parentOrigin = document.documentElement.dataset.parentOrigin;
const send = (data: object, generation = executingGeneration, renderToken = executingViewRevision) => {
  if (disposed) return;
  const bridge = window.ReactNativeWebView;
  if (typeof bridge?.postMessage === 'function') {
    bridge.postMessage(JSON.stringify(nativeSession ? {protocol:1,session:nativeSession,generation,renderToken,message:data} : data));
  }
  webPort?.postMessage({ protocol: 1, session, generation, renderToken, message: data });
};
function repaintAnnotations(){
  if(disposed||renderedViewRevision!==viewRevision||renderedGeneration!==commandGeneration)return;
  const placements=drawAnnotations(content,annotationsPage===current?annotations:[],pdfSurface,regionViewport);
  send({type:'annotation-placements',page:current,placements});
}
function fail(error: unknown) {
  area?.dispose();area=undefined;retainedPreview=undefined;pdfSurface=undefined;regionViewport=undefined;
  cancelOcr(false);
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
function clearSelection() { window.getSelection()?.removeAllRanges();send({type:'selection-reset',page:current});send({ type: 'selection', text: '', page: current }); }
function cancelOcr(notify = true) {
  const previous = ocrJob;
  ocrJob = undefined; ocrRevision++;
  ocrRenderTask?.cancel(); ocrRenderTask = undefined;
  ocr?.cancel();
  if (notify && previous) send({ type: 'ocr-status', page: previous.page, jobId: previous.jobId, state: 'cancelled', progress: 0, message: 'Text recognition cancelled.' });
}
function changingView(preservePreview=false) {
  retainedPreview=preservePreview ? area?.preview ?? retainedPreview : undefined;
  area?.dispose();area=undefined;
  viewRevision++; renderedViewRevision = -1;
  cancelOcr(false);
  send({type:'render-start',page:current},commandGeneration,viewRevision);
}
function currentOcr(job: NonNullable<typeof ocrJob>) {
  return !disposed && ocrJob === job && ocrRevision === job.revision && viewRevision === job.view && current === job.page && pdf === job.document;
}
function showOcr(value: CachedOcr) {
  if (!validateCachedOcr(value) || disposed || format !== 'pdf' || value.page !== current || renderedViewRevision !== viewRevision ||
      (webPort && renderedGeneration !== commandGeneration)) return;
  if(content.querySelector('[data-ocr-text]')?.textContent===value.text)return;
  if(area&&!area.preview)area.cancel();
  viewRevision++;executingViewRevision=viewRevision;renderedViewRevision=viewRevision;
  send({type:'surface-change',page:current});
  clearSelection();
  content.querySelector('[data-ocr-result]')?.remove();
  const section = document.createElement('section'); section.dataset.ocrResult = 'true'; section.className = 'ocr-result';
  section.setAttribute('aria-label', 'Recognized text');
  const heading = document.createElement('h2'); heading.textContent = 'OCR text—may contain errors';
  const note = document.createElement('p');
  note.textContent = value.truncated ? 'Showing the first 50,000 characters. The original PDF is unchanged.'
    : value.text.trim() ? 'Review this text against the original page before studying.' : 'No readable text was found on this page. Try a clearer scan.';
  const text = document.createElement('div'); text.dataset.ocrText = 'true'; text.className = 'ocr-text'; text.textContent = value.text;
  text.dataset.annotationBlock='ocr-page-text';text.dataset.annotationSurface='ocr-text';text.dataset.annotationText=value.text;
  section.append(heading, note, text); content.append(section); content.style.height = 'auto';
  repaintAnnotations();
}
async function recognize(jobId?: string) {
  if (jobId !== undefined && !/^[a-z0-9-]{1,100}$/i.test(jobId)) return;
  if (disposed) return;
  if (ocrJob) return;
  if (format !== 'pdf' || !pdf || renderedViewRevision !== viewRevision || (webPort && renderedGeneration !== commandGeneration)) {
    send({ type: 'ocr-status', page: current, jobId, state: 'error', progress: 0, message: 'Wait for a PDF page to finish rendering before recognizing text.' }); return;
  }
  const job = { revision: ++ocrRevision, view: viewRevision, page: current, document: pdf, jobId };
  ocrJob = job;
  send({ type: 'ocr-status', page: job.page, jobId, state: 'running', progress: 0, message: 'Preparing this page locally…' });
  let canvas: HTMLCanvasElement | undefined;
  try {
    const page = await job.document.getPage(job.page);
    if (!currentOcr(job)) return;
    const natural = page.getViewport({ scale: 1 });
    if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width <= 0 || natural.height <= 0) throw new Error('This PDF page has invalid dimensions.');
    const factor = Math.min(2.5, Math.sqrt(4_000_000 / (natural.width * natural.height)), 8192 / natural.width, 8192 / natural.height);
    const viewport = page.getViewport({ scale: factor });
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Page images are unavailable in this reader.');
    const task = page.render({ canvas, canvasContext: context, viewport });
    ocrRenderTask = task;
    await task.promise;
    if (ocrRenderTask === task) ocrRenderTask = undefined;
    if (!currentOcr(job)) return;
    ocr ??= createOfflineOcr(OCR_WORKER_SOURCE, progress => {
      if (ocrJob && currentOcr(ocrJob)) send({ type: 'ocr-status', page: ocrJob.page, jobId: ocrJob.jobId, state: 'running', progress: progress.progress, message: 'Recognizing text on this device…' });
    });
    const result = await ocr.recognize(canvas);
    if (!currentOcr(job)) return;
    let text = result.text.slice(0, 50000);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    const value = { page: job.page, text, confidence: result.confidence, truncated: result.text.length > text.length };
    // Only the host may expose an accepted canonical transcript as an annotation surface.
    // A completed worker can lose a cache race or arrive after host cancellation.
    ocrJob = undefined;
    send({ type: 'ocr-result', ...value, jobId });
  } catch (error) {
    if (currentOcr(job)) {
      ocrJob = undefined;
      send({ type: 'ocr-status', page: job.page, jobId, state: 'error', progress: 0, message: error instanceof Error ? error.message.slice(0, 500) : 'Text recognition could not finish. Try a clearer scan.' });
    }
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
function selection() {
  if (renderedGeneration !== commandGeneration || renderedViewRevision !== viewRevision) return;
  const text = captureSelection(content, window.getSelection());
  const captured=captureTextAnchor(content,window.getSelection());
  const message=buildSelectionMessage(captured.anchor?.quote ?? text,current);
  send(message.type==='selection'?{...message,...(captured.anchor?{anchor:captured.anchor}:{}),...(captured.reason?{annotationUnavailable:captured.reason}:{})}:message);
}
async function render() {
  if(executingGeneration!==commandGeneration||executingViewRevision!==viewRevision)return;
  clearSelection();
  area?.dispose();area=undefined;pdfSurface=undefined;regionViewport=undefined;
  content.replaceChildren();
  content.className = format;
  let hasText = false;
  if (format === 'pdf' && pdf) {
    const page = await pdf.getPage(current);
    const natural = page.getViewport({ scale: 1 });
    const fit = Math.max(240, document.documentElement.clientWidth - 16) / natural.width;
    const viewport = page.getViewport({ scale: fit * scale });
    content.style.width = viewport.width + 'px';
    content.style.height = 'auto';
    content.style.setProperty('--total-scale-factor', String(viewport.scale));
    const canvas = document.createElement('canvas');
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
    const surface=document.createElement('div');surface.className='tt-pdf-surface';surface.style.width=viewport.width+'px';surface.style.height=viewport.height+'px';
    content.appendChild(surface);surface.appendChild(canvas);pdfSurface=surface;
    regionViewport={width:viewport.width,height:viewport.height,transform:viewport.transform,pageBox:[page.view[0],page.view[1],page.view[2],page.view[3]]};
    const text = document.createElement('div'); text.className = 'textLayer'; surface.appendChild(text);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PDF rendering is unavailable in this WebView');
    await page.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] }).promise;
    const textContent = await page.getTextContent();
    const layer=new TextLayer({ textContentSource: textContent, container: text, viewport });await layer.render();
    // IDs are the original source item indices, including marked-content gaps. DOM spans are only bindings.
    let textIndex=0;for(const [sourceIndex,item] of textContent.items.entries()){if(!('str' in item))continue;const node=layer.textDivs[textIndex++];if(!node)continue;
      node.dataset.annotationBlock='pdf-item-'+sourceIndex;node.dataset.annotationSurface='pdf-text';node.dataset.annotationText=item.str;}
    hasText = !!(await extractPdfPageText(page)).trim();
    page.cleanup();
  } else {
    content.style.width = 'auto'; content.style.height = 'auto';
    content.style.fontSize = 16 * scale + 'px';
    if(format==='pptx'){const slide=slides[current-1];renderPptxSlide(content,slide);hasText=[...slide.paragraphs,...slide.tables.flat(2),...slide.notes].some(value=>!!value.trim());}
    else {const section = paragraphs.slice((current - 1) * 20, current * 20);
      renderDocxParagraphs(content, section,(current-1)*20);hasText = section.some(value => !!value.trim());}
  }
  if(executingGeneration!==commandGeneration||executingViewRevision!==viewRevision)return;
  renderedGeneration = executingGeneration;
  renderedViewRevision = executingViewRevision;
  if(pdfSurface&&regionViewport){area=createAreaController(pdfSurface,regionViewport,anchor=>{retainedPreview=anchor;send({type:'area-preview',page:current,anchor});},()=>{retainedPreview=undefined;send({type:'area-cancelled',page:current});});if(retainedPreview)area.restore(retainedPreview);}
  send({ type: 'page', page: current, totalPages, hasText });
  repaintAnnotations();
}
function enqueue(operation: () => Promise<void>) {
  const generation = commandGeneration;
  const view = viewRevision;
  queue = queue.then(async () => { if (disposed) return; executingGeneration = generation; executingViewRevision = view; await operation(); }).catch(fail);
  return queue;
}
window.TopicTrailReader = {
  async load(input) {
    annotations=[];annotationsPage=0;
    changingView();
    if (!validateReaderInput(input)) { fail(new Error('Invalid document input.')); return; }
    return enqueue(async () => {
      try {
        clearSelection(); content.replaceChildren(); paragraphs = [];slides=[];
        await disposePdf();
        document.documentElement.dataset.theme = input.dark ? 'dark' : 'light';
        format = input.format; current = 1; totalPages = 1; scale = 1; hasInput = true;
        if (input.format === 'pdf') {
          workerUrl = URL.createObjectURL(new Blob([PDF_WORKER_SOURCE], { type: 'text/javascript' }));
          worker = new Worker(workerUrl);
          GlobalWorkerOptions.workerPort = worker;
          const bytes = input.format === 'pdf' && input.bytes ? new Uint8Array(input.bytes) : Uint8Array.from(atob(input.base64 ?? ''), char => char.charCodeAt(0));
          loadingTask = getDocument({ data: bytes, ...offlinePdfOptions });
          pdf = await loadingTask.promise;
          totalPages = pdf.numPages;
        } else if(input.format==='pptx'){slides=input.slides;totalPages=slides.length;}
        else { paragraphs = input.paragraphs ?? []; totalPages = Math.max(1, Math.ceil(paragraphs.length / 20)); }
        await render();
      } catch (error) {
        await disposePdf().catch(() => undefined); fail(error);
      }
    });
  },
  page(value) { changingView(); enqueue(async () => { current = Math.max(1, Math.min(totalPages, Math.floor(value))); await render(); window.scrollTo(0, 0); }); },
  zoom(value) { changingView(true); enqueue(async () => { scale = Math.max(0.5, Math.min(3, value)); await render(); }); },
  selectAll() {
    const range = document.createRange();
    range.selectNodeContents(format === 'pdf' ? content.querySelector('[data-ocr-text]') ?? content.querySelector('.textLayer') ?? content : content);
    const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range); selection();
  },
  clearSelection,
  recognize,
  cancelOcr,
  showOcr,
  setAnnotations(items){if(!validateReaderAnnotations(items)||renderedViewRevision!==viewRevision)return;annotations=items;annotationsPage=current;repaintAnnotations();},
  revealAnnotation(id){const item=annotationsPage===current?annotations.find(item=>item.id===id):undefined;if(!item)return;revealAnnotation(content,item);repaintAnnotations();revealAnnotation(content,item);},
  markArea(mode){if((mode!=='drag'&&mode!=='corners')||renderedViewRevision!==viewRevision)return;if(!area){send({type:'error',message:'Area marks are available on PDF pages.'});return;}clearSelection();retainedPreview=undefined;area.begin(mode);},
  cancelArea(){retainedPreview=undefined;area?.cancel();},
  focus(){content.tabIndex=-1;content.focus({preventScroll:true});},
  connectNative(value) {
    if (disposed || webPort || typeof window.ReactNativeWebView?.postMessage !== 'function' || !/^[a-z0-9-]{20,80}$/i.test(value)) return;
    if (nativeSession !== undefined && nativeSession !== value) return;
    // Re-send a lost acknowledgment until the host starts its first document.
    if (commandGeneration !== 0) return;
    nativeSession = value;
    send({type:'ready'}, commandGeneration, viewRevision);
  },
  dispatch(envelope){dispatchCommand(envelope,nativeSession);},
  theme(dark) { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; },
  dispose() { if (disposed) return; area?.dispose();area=undefined;retainedPreview=undefined;annotations=[];cancelOcr(false); ocr?.dispose(); ocr = undefined; clearSelection(); disposed = true; webPort?.close(); webPort = undefined; content.replaceChildren(); void disposePdf().catch(() => undefined); },
};
document.addEventListener('selectionchange', selection);
content.addEventListener('pointerdown',()=>{if(renderedViewRevision===viewRevision)send({type:'selection-reset',page:current});});
content.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Escape'].includes(event.key))send({type:'selection-reset',page:current});});
document.addEventListener('click', event => { if ((event.target as HTMLElement).closest('a')) event.preventDefault(); });
window.addEventListener('error', event => fail(new Error(event.message)));
window.addEventListener('unhandledrejection', event => fail(event.reason));
window.addEventListener('pagehide', () => window.TopicTrailReader.dispose());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')window.TopicTrailReader.cancelArea();});
content.addEventListener('toggle',()=>{repaintAnnotations();},true);
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
  webPort.onmessage = event => dispatchCommand(event.data,session);
  webPort.start(); send({ type: 'ready' },commandGeneration,viewRevision);
}
function dispatchCommand(envelope:ReaderEnvelope, expectedSession:string|undefined) {
    if (disposed || !expectedSession || envelope?.protocol !== 1 || envelope.session !== expectedSession || !Number.isSafeInteger(envelope.generation)
      || envelope.generation < commandGeneration || !Number.isSafeInteger(envelope.renderToken) || envelope.renderToken<0 || !envelope.command) return;
    const command = envelope.command as ReaderCommand;
    const api = window.TopicTrailReader;
    if (command.type === 'load' || command.type === 'page' || command.type === 'zoom') {
      if (envelope.generation <= commandGeneration) return;
      if(command.type==='load'&&!validateReaderInput(command.input))return;
      if(command.type==='page'&&(!Number.isSafeInteger(command.value)||command.value<1))return;
      if(command.type==='zoom'&&!Number.isFinite(command.value))return;
      commandGeneration = envelope.generation; renderedGeneration = -1;
    } else if(envelope.generation!==commandGeneration)return;
    const interaction=['selectAll','recognize','showOcr','setAnnotations','revealAnnotation','markArea','focus'];
    if(interaction.includes(command.type)&&(envelope.renderToken!==viewRevision||renderedViewRevision!==viewRevision||renderedGeneration!==commandGeneration))return;
    switch (command.type) {
      case 'load': if (validateReaderInput(command.input)) void api.load(command.input); break;
      case 'page': if (Number.isInteger(command.value) && command.value >= 1) api.page(command.value); break;
      case 'zoom': if (Number.isFinite(command.value)) api.zoom(command.value); break;
      case 'selectAll': if (renderedGeneration === commandGeneration) api.selectAll(); break;
      case 'clearSelection': api.clearSelection(); break;
      case 'recognize': if (renderedGeneration === commandGeneration && (command.jobId === undefined || (typeof command.jobId === 'string' && /^[a-z0-9-]{1,100}$/i.test(command.jobId)))) void api.recognize(command.jobId); break;
      case 'cancelOcr': api.cancelOcr(); break;
      case 'showOcr': if (renderedGeneration === commandGeneration && validateCachedOcr(command)) api.showOcr(command); break;
      case 'setAnnotations': if(validateReaderAnnotations(command.items))api.setAnnotations(command.items);break;
      case 'revealAnnotation': if(typeof command.id==='string'&&command.id.length<=160)api.revealAnnotation(command.id);break;
      case 'markArea': if(command.mode==='drag'||command.mode==='corners')api.markArea(command.mode);break;
      case 'cancelArea': api.cancelArea();break;
      case 'focus':api.focus();break;
      case 'theme': if (typeof command.dark === 'boolean') api.theme(command.dark); break;
      case 'dispose': api.dispose(); break;
    }
}
window.addEventListener('message', bootstrap);

let lastWidth = document.documentElement.clientWidth;
window.addEventListener('resize', () => {
  const width = document.documentElement.clientWidth;
  if (disposed || !hasInput || width === lastWidth) return;
  lastWidth = width; renderedGeneration = -1;
  changingView(true);
  enqueue(async () => { await render(); });
});
