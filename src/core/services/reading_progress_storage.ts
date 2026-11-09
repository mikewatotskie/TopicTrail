import AsyncStorage from '@react-native-async-storage/async-storage';
import { ReadingProgressStore } from './reading_progress';

export const readingProgressStorage = new ReadingProgressStore({
  getItem: key => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
});
