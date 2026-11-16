import AsyncStorage from '@react-native-async-storage/async-storage';
import { ReadingProgressStore } from './reading_progress';
import { productionMetadata } from './study_metadata';

export const progressStorageKey = (key: string) => key.replace(/^@topictrail\/reading-progress\/v1\//, 'guest/progress/');
export const progressIO = {
  async getItem(key: string) {
    const store = productionMetadata();
    return store ? (await store.read([progressStorageKey(key)]))[0] : AsyncStorage.getItem(key);
  },
  async setItem(key: string, value: string) {
    const store = productionMetadata();
    if (!store) return AsyncStorage.setItem(key, value);
    const keys = [progressStorageKey(key)];
    const previous = await store.read(keys);
    if (!await store.compareAndSet(keys, previous, [value])) throw Error('Reading progress changed. Reopen the document.');
  },
};
export const readingProgressStorage = new ReadingProgressStore(progressIO);
