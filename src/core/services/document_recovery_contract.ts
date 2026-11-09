/** V4 recovery plus account/sync semantics; independent of IndexedDB's schema number. */
export const DOCUMENT_STORE_PROTOCOL = Object.freeze({
  name: 'topictrail-document-recovery', revision: 2, minimumReader: 4, minimumWriter: 4,
} as const);
export type DocumentStoreProtocol = typeof DOCUMENT_STORE_PROTOCOL;
export type DocumentRecoveryErrorCode = 'upgrade_required' | 'upgrade_blocked' | 'cancelled'
  | 'recovery_required' | 'storage_unavailable' | 'storage_full' | 'writer_unavailable';
export class DocumentRecoveryError extends Error {
  constructor(public readonly code: DocumentRecoveryErrorCode, message: string) {
    super(message); this.name = 'DocumentRecoveryError';
  }
}
export function assertDocumentStoreProtocol(value: unknown): asserts value is DocumentStoreProtocol {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 4
    || Object.entries(DOCUMENT_STORE_PROTOCOL).some(([key, expected]) => !Object.hasOwn(value, key)
      || (value as Record<string, unknown>)[key] !== expected)) {
    throw new DocumentRecoveryError('upgrade_required', 'This library requires a compatible TopicTrail storage version.');
  }
}
