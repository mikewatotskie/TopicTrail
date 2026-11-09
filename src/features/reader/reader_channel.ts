import { parseWebReaderEvent, validateReaderInput, type ReaderCommand, type ReaderInput } from './reader_protocol';
import type { ReaderMessage } from './selection';
export interface ReaderConnection {
  load(input: ReaderInput): void; page(value: number): void; zoom(value: number): void;
  selectAll(): void; clearSelection(): void; theme(dark: boolean): void; dispose(): void;
}
export function connectWebReader(frame: HTMLIFrameElement, onMessage: (message: ReaderMessage) => void): ReaderConnection {
  const session = frame.dataset.readerSession;
  if (!session || !/^[a-z0-9-]{20,80}$/i.test(session)) throw new Error('Reader session is missing.');
  let port: MessagePort | undefined; let disposed = false; let bound = false; let generation = 0;
  const timeout = setTimeout(() => {
    if (!disposed && !bound) { onMessage({ type: 'error', message: 'The isolated reader did not respond. Please retry.' }); connection.dispose(); }
  }, 15000);
  const handshake = (event: MessageEvent) => {
    if (disposed || port || event.source !== frame.contentWindow || event.data?.protocol !== 1
      || event.data?.type !== 'topictrail-ready' || event.data?.session !== session) return;
    const channel = new MessageChannel(); port = channel.port1;
    port.onmessage = event => {
      if (disposed) return;
      const message = parseWebReaderEvent(event.data, session, generation);
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
    port.postMessage({ protocol: 1, session, generation, command }, transfer);
  };
  const connection: ReaderConnection = {
    load(input) { if (!validateReaderInput(input)) throw new Error('Invalid document input.'); send({ type: 'load', input }); },
    page(value) { if (Number.isInteger(value) && value >= 1) send({ type: 'page', value }); },
    zoom(value) { if (Number.isFinite(value)) send({ type: 'zoom', value: Math.max(0.5, Math.min(3, value)) }); },
    selectAll() { send({ type: 'selectAll' }); }, clearSelection() { send({ type: 'clearSelection' }); },
    theme(dark) { send({ type: 'theme', dark }); },
    dispose() { if (disposed) return; send({ type: 'dispose' }); disposed = true; clearTimeout(timeout);
      window.removeEventListener('message', handshake); if (port) { port.onmessage = null; port.close(); } },
  };
  frame.contentWindow?.postMessage({ protocol: 1, type: 'topictrail-probe', session }, '*');
  return connection;
}
