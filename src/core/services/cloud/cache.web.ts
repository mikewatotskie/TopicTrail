import { MAX_FILE_SIZE_BYTES } from '../document_validation';
import { getWebImportSource } from '../web/import_sources';
import { notifyLibraryChange } from '../web/library_events';
import { BrowserStorageError, createIndexedDbClient, openTopicTrailDb, type IndexedDbClient } from '../web/indexeddb_client';
import { createAccountCache } from './cache_store';
import { cloudIdentityKey, type CloudCache, type CloudIdentity } from './types';

const caches = new Map<string, CloudCache>();

async function boundedBytes(file: Blob): Promise<Uint8Array> {
  if (file.size > MAX_FILE_SIZE_BYTES) throw new Error('This document exceeds the 50 MiB limit.');
  return new Uint8Array(await file.arrayBuffer());
}

export function createCloudCache({ project, uid }: CloudIdentity): CloudCache {
  const identity = { project, uid };
  const key = cloudIdentityKey(identity);
  const cached = caches.get(key);
  if (cached) return cached;
  const name = 'topictrail-cloud-v1-' + key.replace('/', '-');
  const prefix = 'topictrail-cloud://' + key + '/';
  let current: Promise<IndexedDbClient> | undefined;

  function client() {
    return current ??= openTopicTrailDb(globalThis.indexedDB, name).then(db => {
      db.addEventListener('versionchange', () => { current = undefined; });
      return createIndexedDbClient(db, notifyLibraryChange);
    }).catch(error => { current = undefined; throw error; });
  }

  function blobPath(path: string) {
    if (!path.startsWith(prefix)) throw new Error('This document does not belong to the active account.');
    // The shared IndexedDB client validates this inner key. The client is
    // connected only to the separate account database above.
    return 'topictrail-idb://documents/' + path.slice(prefix.length);
  }

  async function readBlob(path: string): Promise<Blob | null> {
    try { return await (await client()).readOwnedDocument(blobPath(path)); }
    catch (error) {
      if (error instanceof BrowserStorageError && error.code === 'missing') return null;
      throw error;
    }
  }

  const cache = createAccountCache(identity, {
    path: (id, format) => prefix + id + '.' + format,
    async readState() { return (await client()).readLibrary('documents'); },
    async commit(revision, json, write) {
      try {
        const pending = write ? [{ path: blobPath(write.path), blob: new Blob([write.bytes.slice()]) }] : [];
        await (await client()).commitLibrary('documents', revision, json, pending);
        return true;
      } catch (error) {
        if (error instanceof BrowserStorageError && error.code === 'conflict') return false;
        throw error;
      }
    },
    async readFile(path) {
      const blob = await readBlob(path);
      return blob ? boundedBytes(blob) : null;
    },
    async fileExists(path) { return Boolean(await readBlob(path)); },
    async readImport(path) { return boundedBytes(getWebImportSource(path)); },
  });
  caches.set(key, cache);
  return cache;
}
