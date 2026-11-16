import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OcrCacheIO } from './ocr_cache';

/** Web Locks serialize the read/compare/write across this origin's tabs and windows. */
export const ocrCacheStorage: OcrCacheIO = {
  getItem: key => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks || typeof locks.request !== 'function') {
      throw new Error('OCR text cannot be saved safely without Web Locks. Use a supported browser on localhost or HTTPS.');
    }
    return locks.request(key, { mode: 'exclusive' }, async lock => {
      if (!lock) throw new Error('The exclusive OCR storage lock could not be acquired.');
      return work();
    });
  },
};
