import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OcrCacheIO } from './ocr_cache';

/** Native callers share OcrCacheStore's process-local write queue. */
export const ocrCacheStorage: OcrCacheIO = {
  getItem: key => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
};
