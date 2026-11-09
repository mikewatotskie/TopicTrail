import { Document, DocumentFormat } from '../models/document';
import type { GuestUploadPolicy } from '../config/guest_upload_policy';
import { decodeDocumentLibrary, encodeDocumentLibrary, type DocumentLibrary } from './document_library_codec';
import { ImportOperationError, snapshotImportAttempt, type GuestAllowance, type GuestImportOutcome, type ImportAttempt } from './document_import_contract';

export interface MetadataWithOrigin { json: string | null; origin: 'main' | 'backup' | 'empty' }
export interface DocumentStoragePort {
  readMetadata(): Promise<string | null>;
  readMetadataWithOrigin?(): Promise<MetadataWithOrigin>;
  writeMetadata(json: string): Promise<void>;
  copyToDocuments(source: string, id: string, format: DocumentFormat): Promise<{ filePath: string; size: number }>;
  removeFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
}
export interface SaveDocumentInput { originalPath: string; title: string; format: DocumentFormat; attempt?: ImportAttempt }

/** Serializes mutations and publishes state only after metadata is durably written. */
export class DocumentRepository {
  private library: DocumentLibrary = decodeDocumentLibrary(null);
  private initialization?: Promise<void>;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly port: DocumentStoragePort, public readonly guestUploadPolicy: GuestUploadPolicy = 'disabled') {}
  private async readLibrary(): Promise<DocumentLibrary> {
    const stored = this.port.readMetadataWithOrigin ? await this.port.readMetadataWithOrigin()
      : { json: await this.port.readMetadata(), origin: 'main' as const };
    const library = decodeDocumentLibrary(stored.json);
    if (stored.origin === 'backup') {
      library.guestUsageRecoveryRequired = true;
      library.importReplayRecoveryRequired = true;
    }
    const recovered: Document[] = [];
    for (const doc of library.documents) {
      if (!library.pendingDeletion.has(doc.id) || await this.port.fileExists(doc.filePath)) recovered.push(doc);
    }
    library.documents = recovered.sort((a, b) => b.importedAt.getTime() - a.importedAt.getTime());
    return library;
  }
  initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.readLibrary().then(library => { this.library = library; })
      .catch(error => { this.initialization = undefined; throw error; });
    return this.initialization;
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => { await this.initialize(); return operation(); });
    this.pending = result.catch(() => undefined); return result;
  }
  private outcome(attemptId: string): GuestImportOutcome {
    const receipt = this.library.importAttempts.find(r => r.attemptId === attemptId);
    if (!receipt) {
      this.requireReplayHistory();
      return { kind: 'uncommitted' };
    }
    const document = this.library.documents.find(d => d.id === receipt.documentId);
    return document ? { kind: 'committed', document } : { kind: 'deleted' };
  }
  private requireReplayHistory() {
    if (this.library.importReplayRecoveryRequired) throw new ImportOperationError('retry',
      'Import replay history requires recovery. Existing files and your selection have been preserved. Signing in cannot resolve this uncertainty.');
  }
  async lookupGuestImportOutcome(attemptId: string): Promise<GuestImportOutcome> {
    await this.pending; await this.initialize(); return this.outcome(attemptId);
  }
  async getGuestAllowance(): Promise<GuestAllowance> {
    await this.pending; await this.initialize();
    if (this.guestUploadPolicy === 'disabled') return { kind: 'disabled' };
    if (this.library.guestUsageRecoveryRequired) return { kind: 'recovery_required' };
    const used = this.library.guestImports.length; return { kind: 'ready', used, remaining: 2 - used };
  }
  private async writeMetadata(json: string): Promise<void> {
    try { await this.port.writeMetadata(json); }
    catch (error) {
      // A reported failure may follow a committed native move. Every later read
      // or mutation must recover authoritative metadata before using the cache.
      this.initialization = undefined;
      throw error;
    }
  }
  private async persist(documents: Document[], extra: Partial<DocumentLibrary> = {}) {
    const library = { ...this.library, documents, pendingDeletion: new Set<string>(), ...extra };
    await this.writeMetadata(encodeDocumentLibrary(library)); this.library = library;
  }
  async getAllDocuments(): Promise<Document[]> {
    await this.pending; await this.initialize(); return [...this.library.documents];
  }
  async getDocument(id: string): Promise<Document | null> { return (await this.getAllDocuments()).find(d => d.id === id) ?? null; }
  saveDocument(input: SaveDocumentInput): Promise<Document> {
    const attempt = snapshotImportAttempt(input.attempt);
    return this.mutate(async () => {
      if (attempt) {
        const prior = this.outcome(attempt.attemptId);
        if (prior.kind === 'committed') return prior.document;
        if (prior.kind === 'deleted') throw new ImportOperationError('already_deleted', 'This import was already completed and its document was deleted.');
      }
      // Missing attempt context must not bypass a backup's unknown replay history.
      this.requireReplayHistory();
      const enabled = this.guestUploadPolicy === 'two_guest_successes_v1';
      if (enabled && !attempt) throw new ImportOperationError('retry', 'An import attempt and actor are required.');
      const charge = enabled && attempt?.actor.kind === 'guest';
      if (charge && this.library.guestUsageRecoveryRequired) throw new ImportOperationError('guest_usage_recovery', 'Guest usage recovery is required. Sign in to continue.');
      if (charge && this.library.guestImports.length >= 2) throw new ImportOperationError('guest_limit', 'The two guest imports have been used. Sign in to continue.');
      const title = input.title.trim(); if (!title) throw new Error('Enter a document title');
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      const owned = await this.port.copyToDocuments(input.originalPath, id, input.format);
      const doc = new Document(id, title, input.format, owned.filePath, new Date(), owned.size);
      const guestImports = charge ? [...this.library.guestImports, { attemptId: attempt!.attemptId, documentId: id }] : this.library.guestImports;
      const importAttempts = attempt ? [...this.library.importAttempts, { attemptId: attempt.attemptId, documentId: id }] : this.library.importAttempts;
      try { await this.persist([doc, ...this.library.documents], { guestImports, importAttempts }); }
      catch (error) {
        // A native move may commit before reporting failure. Read authoritative
        // metadata before removing bytes; an unverifiable result keeps them safe.
        let actual: DocumentLibrary;
        try { actual = await this.readLibrary(); }
        catch { throw new ImportOperationError('retry', 'The import commit could not be verified. Preserve the selection and retry.'); }
        if (actual.documents.some(d => d.filePath === owned.filePath)) {
          this.library = actual; return actual.documents.find(d => d.id === id)!;
        }
        if (actual.importReplayRecoveryRequired) throw new ImportOperationError('retry',
          'The import commit could not be verified from recovered replay history. Preserve the selection and existing files. Recovery is required.');
        await this.port.removeFile(owned.filePath).catch(() => undefined); throw error;
      }
      return doc;
    });
  }
  updateDocument(document: Document): Promise<void> {
    return this.mutate(async () => {
      const existing = this.library.documents.find(d => d.id === document.id);
      if (!existing) throw new Error('Document not found');
      if (!document.title.trim()) throw new Error('Enter a document title');
      const updated = existing.copyWith({ title: document.title.trim(), pageCount: document.pageCount, lastOpenedAt: document.lastOpenedAt });
      await this.persist(this.library.documents.map(d => d.id === document.id ? updated : d));
    });
  }
  deleteDocument(id: string): Promise<void> {
    return this.mutate(async () => {
      const doc = this.library.documents.find(d => d.id === id); if (!doc) throw new Error('Document not found');
      const previous = [...this.library.documents];
      await this.writeMetadata(encodeDocumentLibrary({ ...this.library, pendingDeletion: new Set([id]) }));
      try { if (await this.port.fileExists(doc.filePath)) await this.port.removeFile(doc.filePath); }
      catch (error) { await this.persist(previous).catch(() => undefined); throw error; }
      const remaining = previous.filter(d => d.id !== id);
      await this.persist(remaining).catch(() => { this.library = { ...this.library, documents: remaining }; });
    });
  }
  updateLastOpened(id: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.library.documents.some(d => d.id === id)) throw new Error('Document not found');
      await this.persist(this.library.documents.map(d => d.id === id ? d.copyWith({ lastOpenedAt: new Date() }) : d));
    });
  }
  async documentFileExists(id: string): Promise<boolean> { const doc = await this.getDocument(id); return doc ? this.port.fileExists(doc.filePath) : false; }
}
