import type { DocumentStoragePort } from '../document_repository';
import { assertOwnedDocumentPath, BrowserStorageError, type IndexedDbClient } from './indexeddb_client';
import { getWebImportSource } from './import_sources';

export function createWebDocumentPort(client: IndexedDbClient): DocumentStoragePort {
  let revision: number | undefined;
  const pending = new Map<string, Blob>();
  return {
    async readMetadata() { const record = await client.readLibrary('documents'); revision = record.revision; return record.json; },
    async writeMetadata(json) {
      if (revision === undefined) throw Error('Read the browser library before changing it.');
      revision = await client.commitLibrary('documents', revision, json, [...pending].map(([path, blob]) => ({ path, blob })));
      pending.clear();
    },
    async copyToDocuments(source, id, format) {
      const path = `topictrail-idb://documents/${id}.${format}`; assertOwnedDocumentPath(path);
      const blob = getWebImportSource(source); pending.set(path, blob);
      return { filePath: path, size: blob.size };
    },
    async removeFile(path) {
      assertOwnedDocumentPath(path);
      if (pending.delete(path)) return;
      if (revision === undefined) throw Error('Read the browser library before deleting a document.');
      revision = await client.removeOwnedDocument(path, revision);
    },
    async fileExists(path) {
      assertOwnedDocumentPath(path); if (pending.has(path)) return true;
      try { await client.readOwnedDocument(path); return true; }
      catch (error) { if (error instanceof BrowserStorageError && error.code === 'missing') return false; throw error; }
    },
  };
}
