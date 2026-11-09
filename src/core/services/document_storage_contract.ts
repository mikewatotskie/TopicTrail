import type { DocumentRepository } from './document_repository';
export type DocumentStorageApi = Pick<DocumentRepository, 'initialize' | 'getAllDocuments' | 'getDocument' | 'saveDocument'
  | 'updateDocument' | 'deleteDocument' | 'updateLastOpened' | 'documentFileExists'
  | 'guestUploadPolicy' | 'getGuestAllowance' | 'lookupGuestImportOutcome'>;
