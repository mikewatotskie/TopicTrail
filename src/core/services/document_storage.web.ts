import { DocumentRepository } from './document_repository';
import type { DocumentStorageApi } from './document_storage_contract';
import { getBrowserClient, type IndexedDbClient } from './web/indexeddb_client';
import { createWebDocumentPort } from './web/document_port';
import { resolveGuestUploadPolicy, type GuestUploadPolicy } from '../config/guest_upload_policy';
import { snapshotImportAttempt } from './document_import_contract';

export function createWebDocumentStore(getClient: () => Promise<IndexedDbClient>,
  guestUploadPolicy: GuestUploadPolicy = resolveGuestUploadPolicy('web')): DocumentStorageApi {
  let pending: Promise<unknown> = Promise.resolve();
  function run<T>(operation: (repo: DocumentRepository) => Promise<T>): Promise<T> {
    const result = pending.then(async () => operation(new DocumentRepository(createWebDocumentPort(await getClient()), guestUploadPolicy)));
    pending = result.catch(() => undefined); return result;
  }
  return {
    guestUploadPolicy,
    getGuestAllowance: () => run(repo => repo.getGuestAllowance()),
    lookupGuestImportOutcome: attemptId => run(repo => repo.lookupGuestImportOutcome(attemptId)),
    initialize: () => run(repo => repo.initialize()),
    getAllDocuments: () => run(repo => repo.getAllDocuments()),
    getDocument: id => run(repo => repo.getDocument(id)),
    saveDocument: input => {
      const submitted = { ...input, attempt: snapshotImportAttempt(input.attempt) };
      return run(repo => repo.saveDocument(submitted));
    },
    updateDocument: document => run(repo => repo.updateDocument(document)),
    deleteDocument: id => run(repo => repo.deleteDocument(id)),
    updateLastOpened: id => run(repo => repo.updateLastOpened(id)),
    documentFileExists: id => run(repo => repo.documentFileExists(id)),
  };
}
const store = createWebDocumentStore(getBrowserClient);
export class DocumentStorage {
  static get instance(): DocumentStorageApi { return store; }
}
