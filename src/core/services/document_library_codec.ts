import { Document, type DocumentJson } from '../models/document';
import { ImportOperationError } from './document_import_contract';
export interface GuestImportReceipt { readonly attemptId: string; readonly documentId: string }
export interface DocumentLibrary {
  documents: Document[];
  pendingDeletion: ReadonlySet<string>;
  guestImports: readonly GuestImportReceipt[];
  // Independent of guest charges; deleted documents retain lifetime replay tombstones.
  importAttempts: readonly GuestImportReceipt[];
  guestUsageRecoveryRequired: boolean;
  importReplayRecoveryRequired: boolean;
  versioned: boolean;
}
function replayEntries(value: unknown): GuestImportReceipt[] {
  if (!Array.isArray(value)) throw Error('Invalid replay journal');
  const entries = value.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.attemptId !== 'string' || !entry.attemptId.trim()
      || typeof entry.documentId !== 'string' || !entry.documentId.trim()) throw Error('Invalid replay entry');
    return { attemptId: entry.attemptId, documentId: entry.documentId };
  });
  if (new Set(entries.map(r => r.attemptId)).size !== entries.length
    || new Set(entries.map(r => r.documentId)).size !== entries.length) throw Error('Duplicate replay entries');
  return entries;
}
export function decodeDocumentLibrary(json: string | null): DocumentLibrary {
  try {
    const value: unknown = json === null ? [] : JSON.parse(json);
    const versioned = !Array.isArray(value);
    let raw: unknown = value, receipts: unknown = [], attempts: unknown = [];
    let recovery = false, replayRecovery = false;
    if (versioned) {
      if (!value || typeof value !== 'object' || !('version' in value) || (value.version !== 2 && value.version !== 3)
        || !('documents' in value) || !('guestImports' in value)) throw Error('Unknown envelope');
      raw = value.documents; receipts = value.guestImports;
      if (value.version === 3) {
        if (!('importAttempts' in value)) throw Error('Missing replay journal');
        attempts = value.importAttempts;
        if ('importReplayRecoveryRequired' in value) {
          if (value.importReplayRecoveryRequired !== true) throw Error('Invalid replay recovery flag');
          replayRecovery = true;
        }
      } else {
        if ('importAttempts' in value || 'importReplayRecoveryRequired' in value) throw Error('Invalid V2 envelope');
        attempts = receipts;
      }
      if ('guestUsageRecoveryRequired' in value) {
        if (value.guestUsageRecoveryRequired !== true) throw Error('Invalid recovery flag');
        recovery = true;
      }
    }
    if (!Array.isArray(raw) || !Array.isArray(receipts) || receipts.length > 2) throw Error('Invalid library');
    const pendingDeletion = new Set<string>();
    const documents = raw.map(entry => {
      const document = Document.fromJson(entry);
      if ('pendingDeletion' in entry) {
        if (typeof entry.pendingDeletion !== 'boolean') throw Error('Invalid deletion intent');
        if (entry.pendingDeletion) pendingDeletion.add(document.id);
      }
      if (entry.lastOpenedAt !== undefined && typeof entry.lastOpenedAt !== 'string') throw Error('Invalid date');
      return document;
    });
    if (new Set(documents.map(doc => doc.id)).size !== documents.length) throw Error('Duplicate documents');
    const guestImports = replayEntries(receipts);
    // Legacy uncharged imports have no trustworthy attempt identity to invent.
    const importAttempts = replayEntries(attempts);
    const journal = new Map(importAttempts.map(r => [r.attemptId, r.documentId]));
    if (guestImports.some(r => journal.get(r.attemptId) !== r.documentId)) throw Error('Inconsistent guest receipts');
    return { documents, pendingDeletion, guestImports, importAttempts,
      guestUsageRecoveryRequired: recovery, importReplayRecoveryRequired: replayRecovery, versioned };
  } catch { throw new ImportOperationError('guest_usage_recovery', 'Document metadata could not be read. Your existing files have been preserved. Recovery is required.'); }
}
export function encodeDocumentLibrary(library: DocumentLibrary): string {
  const documents: (DocumentJson & { pendingDeletion?: true })[] = library.documents.map(document =>
    library.pendingDeletion.has(document.id) ? { ...document.toJson(), pendingDeletion: true } : document.toJson());
  // Reads never migrate on disk. Every successful mutation writes the full V3 journal.
  return JSON.stringify({ version: 3, documents, guestImports: library.guestImports, importAttempts: library.importAttempts,
    ...(library.guestUsageRecoveryRequired ? { guestUsageRecoveryRequired: true } : {}),
    ...(library.importReplayRecoveryRequired ? { importReplayRecoveryRequired: true } : {}) });
}
