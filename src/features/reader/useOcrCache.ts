import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { OcrCacheStore, type OcrCacheResult } from '../../core/services/ocr_cache';
import { ocrCacheStorage } from '../../core/services/ocr_cache_storage';
import { useCloudLibrary } from '../library/CloudLibraryContext';
const cache = new OcrCacheStore(ocrCacheStorage, Platform.OS === 'android' ? 'mlkit-16.0.1-latin-1' : 'tesseract-7-eng-fil-1');
/** Results stay on this device and are scoped to the captured account and exact original bytes. */
export function useOcrCache() {
  const { state, runtime } = useCloudLibrary();
  const captured = useRef({ epoch: state.epoch, scope: state.identity ?? 'guest' as const, available: !!state.identity || state.phase === 'guest' });
  const mounted = useRef(true);
  const [warning, setWarning] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && captured.current.available && (!runtime || runtime.getSnapshot().epoch === captured.current.epoch);
  return {
    warning,
    isCurrent: current,
    read: async (hash: string, page: number) => {
      if (!current()) return null;
      try { const value = await cache.read(captured.current.scope, hash, page); return current() ? value : null; }
      catch { if (current()) setWarning('Saved OCR text could not be read. Existing notes are preserved; a new recognition may need placement review.'); return null; }
    },
    readEntry: async (hash: string, page: number) => {
      if (!current()) return null;
      try { const value = await cache.readEntry(captured.current.scope, hash, page); return current() ? value : null; }
      catch { if (current()) setWarning('Saved OCR text could not be read. Existing notes are preserved; a new recognition may need placement review.'); return null; }
    },
    save: async (hash: string, page: number, result: OcrCacheResult, valid: () => boolean = () => true) => {
      const active = () => current() && valid();
      if (!active()) return null;
      try { return await cache.save(captured.current.scope, hash, page, result, active); }
      catch { if (active()) setWarning('OCR text could not be saved on this device. Retry before adding notes to a new transcript.'); return null; }
    },
  };
}
