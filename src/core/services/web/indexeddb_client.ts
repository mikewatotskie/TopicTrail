import { notifyLibraryChange } from './library_events';
export type LibraryKey = 'documents' | 'bookmarks';
export interface MetadataSnapshot { json: string | null; revision: number }
export interface PendingBlob { path: string; blob: Blob }
export class BrowserStorageError extends Error {
  constructor(public readonly code: 'invalid' | 'missing' | 'conflict' | 'unavailable' | 'blocked' | 'quota' | 'upgrade_required', message: string) { super(message); }
}

export function assertOwnedDocumentPath(path: string): void {
  if (!/^topictrail-idb:\/\/documents\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:pdf|docx)$/.test(path))
    throw new BrowserStorageError('invalid', 'This document is outside TopicTrail browser storage.');
}
function storageFailure(error: unknown): Error {
  if (error instanceof BrowserStorageError) return error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return new BrowserStorageError('quota', 'Browser storage is full. Your existing documents have been preserved. Free some space and retry.');
  return new BrowserStorageError('unavailable', 'Browser storage could not be accessed. Existing data has been preserved. Check browser storage settings and retry.');
}
export function openTopicTrailDb(factory: IDBFactory, name = 'topictrail-web'): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(storageFailure(null)); return; }
    let abandoned = false;
    const fail = (error: unknown) => { abandoned = true; reject(storageFailure(error)); };
    try {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        if (abandoned) { request.transaction?.abort(); return; }
        if (!request.result.objectStoreNames.contains('libraries')) request.result.createObjectStore('libraries');
        if (!request.result.objectStoreNames.contains('documents')) request.result.createObjectStore('documents');
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new BrowserStorageError('blocked', 'Another tab is holding browser storage open. Close that tab and retry.'));
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned) { db.close(); return; }
        if (!db.objectStoreNames.contains('libraries') || !db.objectStoreNames.contains('documents')) {
          db.close(); fail(new BrowserStorageError('invalid', 'Browser storage has an incompatible structure. Existing data has been preserved.')); return;
        }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    } catch (error) { fail(error); }
  });
}

export interface IndexedDbClient {
  readLibrary(key: LibraryKey): Promise<MetadataSnapshot>;
  commitLibrary(key: LibraryKey, expectedRevision: number, json: string, pendingBlobs?: readonly PendingBlob[]): Promise<number>;
  readOwnedDocument(path: string): Promise<Blob>;
  removeOwnedDocument(path: string, expectedRevision: number): Promise<number>;
}
function decodeRecord(value: unknown): MetadataSnapshot {
  if (value === undefined) return { json: null, revision: 0 };
  if (!value || typeof value !== 'object' || !('json' in value) || typeof value.json !== 'string'
      || !('revision' in value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new BrowserStorageError('invalid', 'Browser library metadata could not be read. Existing data has been preserved.');
  return { json: value.json, revision: Number(value.revision) };
}
export function createIndexedDbClient(db: IDBDatabase, onCommit?: (key: LibraryKey) => void): IndexedDbClient {
  // The legacy raw writer must never be reused against an upgraded/control-fenced database.
  if (db.version !== 1) throw new BrowserStorageError('upgrade_required', 'This library requires the compatible TopicTrail storage adapter.');
  function transaction<T>(stores: string[], mode: IDBTransactionMode,
    operation: (tx: IDBTransaction, set: (value: T) => void, abort: (error: unknown) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      let value: T; let failure: unknown;
      try {
        const tx = db.transaction(stores, mode);
        const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(storageFailure(error)); } };
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(storageFailure(failure ?? tx.error));
        tx.onerror = () => { failure ??= tx.error; };
        try { operation(tx, next => { value = next; }, abort); } catch (error) { abort(error); }
      } catch (error) { reject(storageFailure(error)); }
    });
  }
  return {
    readLibrary(key) {
      return transaction(['libraries'], 'readonly', (tx, set, abort) => {
        const request = tx.objectStore('libraries').get(key);
        request.onsuccess = () => { try { set(decodeRecord(request.result)); } catch (error) { abort(error); } };
      });
    },
    commitLibrary(key, expectedRevision, json, pendingBlobs = []) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof json !== 'string')
        return Promise.reject(new BrowserStorageError('invalid', 'Invalid browser library write.'));
      return transaction<number>(['libraries', 'documents'], 'readwrite', (tx, set, abort) => {
        const libraries = tx.objectStore('libraries');
        const request = libraries.get(key);
        request.onsuccess = () => {
          try {
            const current = decodeRecord(request.result);
            if (current.revision !== expectedRevision) throw new BrowserStorageError('conflict', 'Your library changed in another tab. Retry to load the latest version.');
            for (const file of pendingBlobs) {
              assertOwnedDocumentPath(file.path);
              if (!(file.blob instanceof Blob)) throw new BrowserStorageError('invalid', 'Invalid document bytes.');
              // add, never put: an existing document must not be overwritten by a new import.
              tx.objectStore('documents').add(file.blob, file.path);
            }
            const revision = current.revision + 1;
            libraries.put({ json, revision }, key); set(revision);
          } catch (error) { abort(error); }
        };
      }).then(revision => { try { onCommit?.(key); } catch { /* A notification never invalidates committed bytes. */ } return revision; });
    },
    readOwnedDocument(path) {
      assertOwnedDocumentPath(path);
      return transaction(['documents'], 'readonly', (tx, set, abort) => {
        const request = tx.objectStore('documents').get(path);
        request.onsuccess = () => {
          if (request.result === undefined) { abort(new BrowserStorageError('missing', 'The stored document is missing. Please import it again.')); return; }
          if (!(request.result instanceof Blob)) { abort(new BrowserStorageError('invalid', 'Stored document bytes could not be read.')); return; }
          set(request.result);
        };
      });
    },
    removeOwnedDocument(path, expectedRevision) {
      assertOwnedDocumentPath(path);
      return transaction<number>(['libraries', 'documents'], 'readwrite', (tx, set, abort) => {
        const libraries = tx.objectStore('libraries'); const request = libraries.get('documents');
        request.onsuccess = () => {
          try {
            const current = decodeRecord(request.result);
            if (current.revision !== expectedRevision) throw new BrowserStorageError('conflict', 'Your library changed in another tab. Retry to load the latest version.');
            // Native repository journals deletion first. CAS and advance that journal's
            // revision with the bytes, so no reader of the old intent can resurrect it.
            if (current.json === null) throw new BrowserStorageError('invalid', 'Document deletion has no library record.');
            tx.objectStore('documents').delete(path);
            const revision = current.revision + 1;
            libraries.put({ json: current.json, revision }, 'documents'); set(revision);
          } catch (error) { abort(error); }
        };
      }).then(revision => { try { onCommit?.('documents'); } catch { /* Best effort notification. */ } return revision; });
    },
  };
}
let current: Promise<IndexedDbClient> | undefined;
export function getBrowserClient(): Promise<IndexedDbClient> {
  return current ??= openTopicTrailDb(globalThis.indexedDB).then(db => {
    db.addEventListener('versionchange', () => { current = undefined; });
    return createIndexedDbClient(db, notifyLibraryChange);
  }).catch(error => { current = undefined; throw error; });
}
