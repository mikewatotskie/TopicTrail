import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState } from 'react-native';
import type { OcrCacheResult } from '../../core/services/ocr_cache';
import type { ReaderConnection } from './reader_channel';
import type { ReaderMessage } from './selection';
import { useOcrCache } from './useOcrCache';

interface PageInput { hash: string; page: number }
type Recognizer = (signal: AbortSignal) => Promise<OcrCacheResult>;

/** Owns one displayed page and its OCR job. The reader owns document access and rendering. */
export function usePageOcr(viewer: RefObject<ReaderConnection | null>) {
  const cache = useOcrCache();
  const current = useRef<PageInput | null>(null);
  const job = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const webJob = useRef<string | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [hasTranscript, setHasTranscript] = useState(false);

  const latestCancel = useRef<() => void>(() => {});
  useLayoutEffect(() => { latestCancel.current = cancel; });
  useFocusEffect(useCallback(() => () => latestCancel.current(), []));
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') latestCancel.current(); });
    return () => { listener.remove(); current.current = null; job.current?.abort(); };
  }, []);
  function cancel() {
    revision.current++;
    job.current?.abort();
    job.current = null;
    webJob.current = null;
    viewer.current?.cancelOcr();
    setRunning(false);
    setStatus('Recognition cancelled.');
  }
  function reset() {
    revision.current++;
    current.current = null;
    if (job.current) cancel();
    setStatus('');
    setHasTranscript(false);
  }
  function display(input: PageInput, result: OcrCacheResult) {
    viewer.current?.showOcr({ page: input.page, ...result });
    const readable = !!result.text.trim();
    setHasTranscript(readable);
    setStatus(readable ? 'Recognized text is below the page. Select a passage to copy, add a note, or study.'
      : 'No readable text found. Try a clearer scan.');
  }
  function onPage(hash: string, page: number) {
    reset();
    const input = { hash, page };
    current.current = input;
    const requested = revision.current;
    void cache.read(hash, page).then(result => {
      if (result && requested === revision.current && current.current === input && !job.current && cache.isCurrent()) display(input, result);
    });
  }
  async function accept(input: PageInput, controller: AbortController, result: OcrCacheResult) {
    const active = () => job.current === controller && current.current === input && !controller.signal.aborted && cache.isCurrent();
    if (!active()) return;
    const canonical = await cache.save(input.hash, input.page, result, active);
    if (!active()) return;
    if (canonical) display(input, canonical);
    else setStatus('Recognized text could not be saved. Retry recognition before adding notes or studying a new transcript.');
  }
  async function recognize(native?: Recognizer) {
    const input = current.current;
    if (!input || job.current || !cache.isCurrent() || !viewer.current) return;
    const controller = new AbortController();
    revision.current++;
    job.current = controller;
    setRunning(true);
    setStatus('Recognizing printed English and Filipino on this device…');
    const active = () => job.current === controller && current.current === input && cache.isCurrent();
    try {
      const saved = await cache.readEntry(input.hash, input.page);
      if (!active()) return;
      if (saved && !saved.retryable) {
        display(input, saved.result);
      } else if (native) {
        const result = await native(controller.signal);
        if (!active()) return;
        await accept(input, controller, result);
      } else {
        webJob.current = 'page-' + revision.current + '-' + Math.random().toString(36).slice(2);
        viewer.current?.recognize(webJob.current);
        return; // The web worker completes through receive().
      }
    } catch {
      if (active()) setStatus('Recognition could not finish. Try again or use a clearer scan.');
    }
    if (active()) { job.current = null; setRunning(false); }
  }
  async function receive(message: Extract<ReaderMessage, { type: 'ocr-status' | 'ocr-result' }>) {
    const input = current.current;
    if (!input || message.page !== input.page || !job.current || !webJob.current || message.jobId !== webJob.current || !cache.isCurrent()) return;
    if (message.type === 'ocr-status' && message.state === 'running') {
      setStatus(message.message ?? 'Recognizing text on this device…');
      return;
    }
    const controller = job.current;
    webJob.current = null;
    try {
      if (message.type === 'ocr-result') await accept(input, controller, message);
      else setStatus(message.message || (message.state === 'error' ? 'Recognition could not finish. Try again.' : 'Recognition cancelled.'));
    } catch {
      if (job.current === controller && cache.isCurrent()) setStatus('Recognized text could not be saved. Please retry.');
    } finally {
      if (job.current === controller) { job.current = null; setRunning(false); }
    }
  }
  return { running, status, hasTranscript, warning: cache.warning, cancel, reset, onPage, recognize, receive };
}
