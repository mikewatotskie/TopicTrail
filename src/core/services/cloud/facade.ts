import type { DocumentStorageApi } from '../document_storage_contract';
import { snapshotImportAttempt } from '../document_import_contract';
export interface LibrarySelection { key: string; epoch: number; uid: string | null; store: DocumentStorageApi }
const changed = () => new Error('The account library changed. Return to your library and try again.');
/** Stable object retained by importers, but each operation captures its own immutable account boundary. */
export function createDocumentFacade(selection: () => LibrarySelection, afterWrite: (upload: boolean) => void): DocumentStorageApi {
  async function run<T>(operation: (store: DocumentStorageApi, selected: LibrarySelection) => Promise<T>, write?: boolean): Promise<T> {
    const selected = selection(); const result = await operation(selected.store, selected);
    const current = selection();
    if (selected.key !== current.key || selected.epoch !== current.epoch) throw changed();
    if (write !== undefined) afterWrite(write);
    return result;
  }
  return {
    get guestUploadPolicy() { try { return selection().store.guestUploadPolicy; } catch { return 'disabled'; } },
    initialize: () => run(store => store.initialize()),
    getAllDocuments: () => run(store => store.getAllDocuments()),
    getDocument: id => run(store => store.getDocument(id)),
    getGuestAllowance: () => run(store => store.getGuestAllowance()),
    lookupGuestImportOutcome: id => run(store => store.lookupGuestImportOutcome(id)),
    documentFileExists: id => run(store => store.documentFileExists(id)),
    saveDocument(input) {
      const submitted = { ...input, attempt: snapshotImportAttempt(input.attempt) };
      return run((store, selected) => {
        const actor = submitted.attempt?.actor;
        if (actor && (actor.kind === 'account' ? actor.uid !== selected.uid : selected.uid !== null)) throw changed();
        return store.saveDocument(submitted);
      }, true);
    },
    updateDocument: document => run(store => store.updateDocument(document), true),
    deleteDocument: id => run(store => store.deleteDocument(id), false),
    updateLastOpened: id => run(store => store.updateLastOpened(id), false),
  };
}
