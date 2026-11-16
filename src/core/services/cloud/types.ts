import type { Document } from '../../models/document';
import type { DocumentStorageApi } from '../document_storage_contract';
import type { StudyKind, StudyMutation, StudyRecord, StudyReply, StudyState } from './study_state';
import type { RetryWindowStore } from './sync_retry';

export interface CloudIdentity { project: string; uid: string }
export interface CloudSession extends CloudIdentity { accessToken: string }
export interface CloudDocumentRow {
  user_id: string; id: string; title: string; format: 'pdf' | 'docx' | 'pptx';
  byte_size: number; sha256: string; imported_at: string; object_path: string;
  created_at?: string;
}
export interface CloudLocalEntry { document: Document; synced: boolean; hidden: boolean }
export interface CloudCache extends DocumentStorageApi {
  readonly identity: CloudIdentity;
  readonly retryWindow?: RetryWindowStore;
  listSyncEntries(): Promise<readonly CloudLocalEntry[]>;
  readBytes(document: Document): Promise<Uint8Array>;
  acceptRemote(row: CloudDocumentRow, bytes: Uint8Array): Promise<Document>;
  markSynced(id: string, row: CloudDocumentRow): Promise<void>;
  copyLegacy(document: Document, bytes: Uint8Array): Promise<Document>;
  study?: {
    read(): Promise<StudyState>;
    queue(input: Omit<StudyMutation, 'expectedRevision'>): Promise<void>;
    merge(records: readonly StudyRecord[]): Promise<void>;
    acknowledge(operationId: string, reply: StudyReply): Promise<void>;
    resolve(kind: StudyKind, id: string, choice: 'local' | 'cloud', operationId: string): Promise<void>;
    documentHash(id: string): Promise<string>;
    trashed(): Promise<Document[]>;
  };
}
export interface CloudRemote {
  list(): Promise<CloudDocumentRow[]>;
  upload(document: Document, bytes: Uint8Array): Promise<CloudDocumentRow>;
  download(row: CloudDocumentRow): Promise<Uint8Array>;
  listStudy?(): Promise<StudyRecord[]>;
  applyStudy?(mutation: StudyMutation): Promise<StudyReply>;
}
export function cloudIdentityKey(identity: CloudIdentity): string {
  if (!/^[a-z0-9]{20}$/.test(identity.project) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(identity.uid)) {
    throw new Error('The account library identity is invalid.');
  }
  return `${identity.project}/${identity.uid}`;
}
