import { browserLocalPersistence, indexedDBLocalPersistence, type Persistence } from 'firebase/auth';

// Firebase owns saved auth state and cross-tab synchronization. Never store passwords ourselves.
// Both choices are LOCAL: use localStorage if IndexedDB is unavailable in this browser.
export const authPersistence: Persistence[] = [indexedDBLocalPersistence, browserLocalPersistence];
