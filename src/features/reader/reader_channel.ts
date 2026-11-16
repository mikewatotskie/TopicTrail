import { parseWebReaderEvent, validateReaderInput, validateCachedOcr, validateReaderAnnotations, type ReaderAnnotation, type CachedOcr, type ReaderCommand, type ReaderInput } from './reader_protocol';
import type { ReaderMessage } from './selection';
export interface ReaderConnection {
  load(input: ReaderInput): void; page(value: number): void; zoom(value: number): void;
  selectAll(): void; clearSelection(): void; theme(dark: boolean): void; dispose(): void;
  recognize(jobId?: string): void; cancelOcr(): void; showOcr(value: CachedOcr): void;
  setAnnotations(items: ReaderAnnotation[]): void; revealAnnotation(id: string): void;
  markArea(mode: 'drag' | 'corners'): void; cancelArea(): void; focus(): void;
}
export function connectWebReader(frame: HTMLIFrameElement, onMessage: (message: ReaderMessage) => void): ReaderConnection {
  const session = frame.dataset.readerSession;
  if (!session || !/^[a-z0-9-]{20,80}$/i.test(session)) throw new Error('Reader session is missing.');
  let port: MessagePort | undefined; let disposed = false; let bound = false; let generation = 0;
  let renderToken: number | undefined;
  const timeout = setTimeout(() => {
    if (!disposed && !bound) { onMessage({ type: 'error', message: 'The isolated reader did not respond. Please retry.' }); connection.dispose(); }
  }, 15000);
  const handshake = (event: MessageEvent) => {
    if (disposed || port || event.source !== frame.contentWindow || event.data?.protocol !== 1
      || event.data?.type !== 'topictrail-ready' || event.data?.session !== session) return;
    const channel = new MessageChannel(); port = channel.port1;
    port.onmessage = event => {
      if (disposed) return;
      const candidate = parseWebReaderEvent(event.data, session, generation);
      if (!candidate) return;
      if (candidate.type === 'ready' && Number.isSafeInteger(event.data.renderToken)) renderToken = event.data.renderToken;
      if ((candidate.type === 'render-start' || candidate.type === 'surface-change') && Number.isSafeInteger(event.data.renderToken) && event.data.renderToken > (renderToken ?? -1)) renderToken = event.data.renderToken;
      const message = parseWebReaderEvent(event.data, session, generation, renderToken);
      if (!message) return;
      if (message.type === 'ready') { if (bound) return; bound = true; clearTimeout(timeout); }
      if (bound) onMessage(message);
    };
    port.start();
    frame.contentWindow!.postMessage({ protocol: 1, type: 'topictrail-connect', session }, '*', [channel.port2]);
    window.removeEventListener('message', handshake);
  };
  window.addEventListener('message', handshake);
  const send = (command: ReaderCommand) => {
    if (disposed || !bound || !port) return;
    if (command.type === 'load' || command.type === 'page' || command.type === 'zoom') generation++;
    const transfer = command.type === 'load' && command.input.format === 'pdf' && command.input.bytes ? [command.input.bytes] : [];
    port.postMessage({ protocol: 1, session, generation, renderToken: renderToken ?? 0, command }, transfer);
  };
  const connection: ReaderConnection = {
    load(input) { if (!validateReaderInput(input)) throw new Error('Invalid document input.'); send({ type: 'load', input }); },
    page(value) { if (Number.isInteger(value) && value >= 1) send({ type: 'page', value }); },
    zoom(value) { if (Number.isFinite(value)) send({ type: 'zoom', value: Math.max(0.5, Math.min(3, value)) }); },
    selectAll() { send({ type: 'selectAll' }); }, clearSelection() { send({ type: 'clearSelection' }); },
    theme(dark) { send({ type: 'theme', dark }); },
    recognize(jobId) { send({ type: 'recognize', ...(jobId ? { jobId } : {}) }); },
    cancelOcr() { send({ type: 'cancelOcr' }); },
    showOcr(value) { if (validateCachedOcr(value)) send({ type: 'showOcr', page: value.page, text: value.text, confidence: value.confidence, truncated: value.truncated }); },
    ...annotationCommands(send),
    dispose() { if (disposed) return; send({ type: 'dispose' }); disposed = true; clearTimeout(timeout);
      window.removeEventListener('message', handshake); if (port) { port.onmessage = null; port.close(); } },
  };
  frame.contentWindow?.postMessage({ protocol: 1, type: 'topictrail-probe', session }, '*');
  return connection;
}

function annotationCommands(send: (command: ReaderCommand) => void): Pick<ReaderConnection,'setAnnotations'|'revealAnnotation'|'markArea'|'cancelArea'|'focus'> {
  return {
    setAnnotations(items) { if (!validateReaderAnnotations(items)) throw new Error('Too many or invalid highlights for this page.'); send({type:'setAnnotations',items}); },
    revealAnnotation(id) { if (typeof id === 'string' && id.length > 0 && id.length <= 160) send({type:'revealAnnotation',id}); },
    markArea(mode) { if (mode === 'drag' || mode === 'corners') send({type:'markArea',mode}); },
    cancelArea() { send({type:'cancelArea'}); },
    focus() { send({type:'focus'}); },
  };
}

/** Native commands use the same session/generation/render boundary as the isolated web port. */
export function connectNativeReader(inject: (script: string) => void, onMessage: (message: ReaderMessage) => void): ReaderConnection & { receive(raw: string): boolean; documentLoaded(viewerStarted?: boolean): void } {
  const session = 'native-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  let generation = 0, renderToken = 0, bound = false, binding = false, disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  function stopBinding() {
    clearTimeout(timeout);
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  const failHandshake = () => {
    if (disposed || bound) return;
    disposed = true;
    stopBinding();
    let message = 'The offline reader did not finish starting. Please retry.';
    if (loaded) message = 'The reader opened but did not finish connecting. Please retry.';
    if (viewerStarted) message = 'The viewer started, but its Android connection did not respond. Please retry.';
    onMessage({type:'error', message});
  };
  // Opening the bundled offline viewer can outlast its handshake on a cold WebView.
  let timeout = setTimeout(failHandshake, 120000);
  let loaded = false;
  let viewerStarted = false;
  function requestBinding() {
    if (disposed || bound) return;
    binding = true;
    // A cold WebView can miss an injection or its first reply. Keep one retry pending.
    if (retryTimer === undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        requestBinding();
      }, 1000);
    }
    inject('window.TopicTrailReader?.connectNative(' + JSON.stringify(session) + '); true;');
  }
  const send = (command: ReaderCommand) => {
    if (!bound || disposed) return;
    if (command.type === 'load' || command.type === 'page' || command.type === 'zoom') generation++;
    const envelope = {protocol:1,session,generation,renderToken,command};
    // JSON is data inside a direct call, never document markup or a URL.
    inject('window.TopicTrailReader?.dispatch(' + JSON.stringify(envelope).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029') + '); true;');
  };
  return {
    documentLoaded(started = false) {
      if (disposed || bound) return;
      viewerStarted ||= started;
      if (loaded) return;
      loaded = true;
      clearTimeout(timeout);
      timeout = setTimeout(failHandshake, 15000);
      requestBinding();
    },
    receive(raw) {
      if (disposed || raw.length > 320000) return false;
      let data: any; try { data = JSON.parse(raw); } catch { return false; }
      if (!bound && data?.type === 'ready') {
        requestBinding(); return true;
      }
      const candidate = parseWebReaderEvent(data,session,generation);
      if (!candidate || !Number.isSafeInteger(data.renderToken) || data.renderToken < 0) return false;
      if (!bound) {
        if (!binding || candidate.type !== 'ready' || data.renderToken !== 0) return false;
        bound = true;
        stopBinding();
      } else if (candidate.type === 'ready') return false;
      if ((candidate.type === 'render-start' || candidate.type === 'surface-change') && data.renderToken > renderToken) renderToken = data.renderToken;
      const message = parseWebReaderEvent(data,session,generation,renderToken);
      if (!message) return false; onMessage(message); return true;
    },
    load(input) { if (!validateReaderInput(input)) throw new Error('Invalid document input.'); send({type:'load',input}); },
    page(value) { if (Number.isSafeInteger(value) && value >= 1) send({type:'page',value}); },
    zoom(value) { if (Number.isFinite(value)) send({type:'zoom',value:Math.max(0.5,Math.min(3,value))}); },
    selectAll() { send({type:'selectAll'}); }, clearSelection() { send({type:'clearSelection'}); },
    theme(dark) { send({type:'theme',dark}); }, recognize(jobId) { send({type:'recognize',...(jobId?{jobId}:{})}); }, cancelOcr() { send({type:'cancelOcr'}); },
    showOcr(value) { if (validateCachedOcr(value)) send({type:'showOcr',...value}); },
    ...annotationCommands(send),
    dispose() {stopBinding();if (disposed) return; send({type:'dispose'}); disposed = true; bound = false; },
  };
}
