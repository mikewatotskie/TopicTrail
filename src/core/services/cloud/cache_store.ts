import { strToU8 } from 'fflate';
import { Document, DocumentFormat } from '../../models/document';
import { createImportAttempt, ImportOperationError, snapshotImportAttempt, type GuestImportOutcome } from '../document_import_contract';
import { MAX_FILE_SIZE_BYTES, validateDocument } from '../document_validation';
import { sha256 } from './sha256';
import { validRetryWindow, type RetryWindow } from './sync_retry';
import { cloudIdentityKey, type CloudCache, type CloudDocumentRow, type CloudIdentity, type CloudLocalEntry } from './types';
import { acknowledgeStudyMutation, decodeStudyState, emptyStudyState, mergeStudyRecords, newStudyOperationId, queueStudyMutation, resolveStudyConflict, studyView, type StudyState } from './study_state';

export interface CacheSnapshot { json: string | null; revision: number }
export interface CacheWrite { path: string; bytes: Uint8Array; hash: string }
export interface CachePort {
  path(id: string, format: DocumentFormat): string;
  readState(): Promise<CacheSnapshot>;
  // Return false on revision conflict. Successful commits publish bytes with the new state.
  commit(expectedRevision: number, json: string, write?: CacheWrite): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array | null>;
  fileExists(path: string): Promise<boolean>;
  readImport(path: string): Promise<Uint8Array>;
}

interface CacheEntry extends CloudLocalEntry { hash: string }
interface CacheState { entries: Map<string, CacheEntry>; receipts: Map<string, string>; study: StudyState; retryWindow?: RetryWindow }
interface Mutation<T> { value: T; changed?: true; write?: CacheWrite }

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hashPattern = /^[a-f0-9]{64}$/;
const metadataError = () => new Error('Account library metadata could not be read. Existing data has been preserved.');

function validTitle(title: unknown): title is string {
  return typeof title === 'string' && Boolean(title.trim()) && Array.from(title.trim()).length <= 512 &&
    !/[\0\uD800-\uDFFF]/u.test(title);
}

function requireTitle(title: string): string {
  if (!validTitle(title)) throw new Error('Enter a document title of up to 512 characters.');
  return title.trim();
}

function validSize(size: unknown): size is number {
  return typeof size === 'number' && Number.isSafeInteger(size) && size > 0 && size <= MAX_FILE_SIZE_BYTES;
}

function validFormat(format: unknown): format is DocumentFormat {
  return format === DocumentFormat.PDF || format === DocumentFormat.DOCX || format === DocumentFormat.PPTX;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw metadataError();
  return value as Record<string, unknown>;
}

export function accountCacheCodec(identity: CloudIdentity, path: CachePort['path']) {
  const key = cloudIdentityKey(identity);

  function ownsId(id: unknown): id is string {
    return typeof id === 'string' && id.length <= 128 && idPattern.test(id) &&
      ('-' + id + '-').includes('-' + identity.uid + '-');
  }

  function ownsPath(document: Document): boolean {
    return ownsId(document.id) && validFormat(document.format) && document.filePath === path(document.id, document.format);
  }

  function decode(snapshot: CacheSnapshot): CacheState {
    const entries = new Map<string, CacheEntry>();
    const receipts = new Map<string, string>();
    if (snapshot.revision === 0 && snapshot.json === null) return { entries, receipts, study: emptyStudyState() };
    try {
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || typeof snapshot.json !== 'string') throw metadataError();
      const state = record(JSON.parse(snapshot.json));
      if ((state.version !== 1 && state.version !== 2) || state.account !== key || !Array.isArray(state.entries) || !Array.isArray(state.receipts)) throw metadataError();
      for (const item of state.entries) {
        const raw = record(item);
        const metadata = record(raw.document);
        if (metadata.lastOpenedAt !== undefined && typeof metadata.lastOpenedAt !== 'string') throw metadataError();
        const stored = Document.fromJson(metadata);
        if (!ownsId(stored.id) || stored.filePath !== stored.id + '.' + stored.format || !validSize(stored.fileSize) || !validTitle(stored.title) ||
            typeof raw.synced !== 'boolean' || typeof raw.hidden !== 'boolean' ||
            typeof raw.hash !== 'string' || !hashPattern.test(raw.hash) || entries.has(stored.id)) throw metadataError();
        const document = stored.copyWith({ filePath: path(stored.id, stored.format) });
        entries.set(document.id, { document, synced: raw.synced, hidden: raw.hidden, hash: raw.hash });
      }
      for (const item of state.receipts) {
        const raw = record(item);
        if (typeof raw.attemptId !== 'string' || !raw.attemptId.trim() || receipts.has(raw.attemptId) ||
            typeof raw.documentId !== 'string' || !entries.has(raw.documentId)) throw metadataError();
        receipts.set(raw.attemptId, raw.documentId);
      }
      return { entries, receipts, study: state.version === 1 ? emptyStudyState() : decodeStudyState(state.study),
        retryWindow: validRetryWindow(state.retryWindow) ? state.retryWindow : undefined };
    } catch {
      throw metadataError();
    }
  }

  function encode(state: CacheState): string {
    return JSON.stringify({ version: 2, account: key, study: state.study, retryWindow: state.retryWindow,
      entries: [...state.entries.values()].map(({ document, ...entry }) => ({ ...entry,
        document: { ...document.toJson(), filePath: document.id + '.' + document.format } })),
      receipts: [...state.receipts].map(([attemptId, documentId]) => ({ attemptId, documentId })) });
  }

  return { encode, decode, ownsId, ownsPath };
}

export function createAccountCache(account: CloudIdentity, port: CachePort): CloudCache {
  const identity = Object.freeze({ project: account.project, uid: account.uid });
  const { encode, decode, ownsId, ownsPath } = accountCacheCodec(identity, (id, format) => port.path(id, format));
  let pending: Promise<unknown> = Promise.resolve();
  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  }

  function readState(): Promise<CacheState> {
    return run(async () => decode(await port.readState()));
  }

  function mutate<T>(operation: (state: CacheState) => Mutation<T> | Promise<Mutation<T>>): Promise<T> {
    return run(async () => {
      for (let retries = 0; retries < 8; retries++) {
        const before = await port.readState();
        const state = decode(before);
        const outcome = await operation(state);
        if (!outcome.changed) return outcome.value;
        const json = encode(state);
        try {
          if (await port.commit(before.revision, json, outcome.write)) return outcome.value;
        } catch (error) {
          // Storage may report a failure after publishing a staged commit. Never
          // remove bytes on an uncertain outcome; reread the authoritative revision.
          const actual = await port.readState().catch(() => null);
          if (actual?.revision === before.revision + 1 && actual.json === json) return outcome.value;
          throw error;
        }
      }
      throw new ImportOperationError('storage_conflict', 'Your account library changed repeatedly. Retry to load the latest version.');
    });
  }

  function outcome(state: CacheState, attemptId: string): GuestImportOutcome {
    const id = state.receipts.get(attemptId);
    if (id === undefined) return { kind: 'uncommitted' };
    const entry = state.entries.get(id)!;
    return entry.hidden ? { kind: 'deleted' } : { kind: 'committed', document: entry.document };
  }

  function visibleEntry(state: CacheState, id: string): CacheEntry {
    const entry = state.entries.get(id);
    if (!entry || entry.hidden || studyView(state.study,'document',id)?.deleted) throw new Error('Document not found');
    return entry;
  }
  function displayed(state: CacheState, entry: CacheEntry): Document {
    const row=studyView(state.study,'document',entry.document.id);
    return typeof row?.payload.title==='string' ? entry.document.copyWith({title:row.payload.title}) : entry.document;
  }

  function validateBytes(format: DocumentFormat, bytes: Uint8Array): string {
    if (!validFormat(format)) throw new Error('Unsupported file format. Only PDF, DOCX and PPTX are allowed.');
    validateDocument('document.' + format, bytes);
    return sha256(bytes);
  }

  function validateRow(row: CloudDocumentRow) {
    const { user_id, id, title, format, byte_size, sha256: hash, imported_at, object_path } = row;
    if (user_id !== identity.uid || !ownsId(id) || !validFormat(format) || !validTitle(title) ||
        !validSize(byte_size) || typeof hash !== 'string' || !hashPattern.test(hash) ||
        typeof imported_at !== 'string' || !Number.isFinite(Date.parse(imported_at)) ||
        object_path !== identity.uid + '/' + id + '.' + format) {
      throw new Error('Invalid document metadata for this cloud account.');
    }
    const document = new Document(id, title.trim(), format, port.path(id, format), new Date(imported_at), byte_size);
    return { document, hash };
  }

  function requireMatch(entry: CacheEntry, document: Document, hash: string) {
    if (entry.hash !== hash || entry.document.format !== document.format || entry.document.fileSize !== document.fileSize) {
      throw new Error('The document conflicts with existing account bytes. The existing file has been preserved.');
    }
  }

  function add(state: CacheState, document: Document, bytes: Uint8Array, hash: string, synced: boolean): Mutation<Document> {
    state.entries.set(document.id, { document, hash, synced, hidden: false });
    return { value: document, changed: true, write: { path: document.filePath, bytes, hash } };
  }

  return {
    identity,
    retryWindow: {
      async read() { return (await readState()).retryWindow ?? null; },
      extend(window) {
        return mutate(state => {
          if (state.retryWindow && state.retryWindow.until >= window.until) return { value: state.retryWindow };
          state.retryWindow = { ...window };
          return { value: state.retryWindow, changed: true };
        });
      },
      clear(expected) {
        return mutate(state => {
          if (state.retryWindow?.until !== expected.until || state.retryWindow.attempts !== expected.attempts) return { value: undefined };
          delete state.retryWindow;
          return { value: undefined, changed: true };
        });
      },
    },
    study: {
      async read(){return (await readState()).study;},
      queue(input){return mutate(state=>{
        if(input.kind!=='bookmark'){
          const entry=state.entries.get(input.id);if(!entry)throw Error('Document not found in this account.');
          if(input.kind==='progress' && (input.payload.hash!==entry.hash||input.payload.format!==entry.document.format))throw Error('Reading position does not match this document.');
        }
        queueStudyMutation(state.study,input);return {value:undefined,changed:true};
      });},
      merge(records){return mutate(state=>{mergeStudyRecords(state.study,records);return {value:undefined,changed:true};});},
      acknowledge(operationId,reply){return mutate(state=>{acknowledgeStudyMutation(state.study,operationId,reply);return {value:undefined,changed:true};});},
      resolve(kind,id,choice,operationId){return mutate(state=>{resolveStudyConflict(state.study,kind,id,choice,operationId);return {value:undefined,changed:true};});},
      async documentHash(id){const entry=(await readState()).entries.get(id);if(!entry)throw Error('Document not found');return entry.hash;},
      async trashed(){const state=await readState();return [...state.entries.values()].filter(e=>studyView(state.study,'document',e.document.id)?.deleted).map(e=>displayed(state,e));},
    },
    guestUploadPolicy: 'disabled',
    async initialize() { await readState(); },
    async getGuestAllowance() { return { kind: 'disabled' }; },
    async lookupGuestImportOutcome(attemptId) { return outcome(await readState(), attemptId); },
    async getAllDocuments() {
      const state=await readState();
      return [...state.entries.values()]
        .filter(entry => !entry.hidden && !studyView(state.study,'document',entry.document.id)?.deleted).map(entry => displayed(state,entry))
        .sort((a, b) => b.importedAt.getTime() - a.importedAt.getTime());
    },
    async getDocument(id) {
      const state=await readState();const entry = state.entries.get(id);
      return entry && !entry.hidden && !studyView(state.study,'document',id)?.deleted ? displayed(state,entry) : null;
    },
    async saveDocument(input) {
      const attempt = snapshotImportAttempt(input.attempt);
      if (attempt && (attempt.actor.kind !== 'account' || attempt.actor.uid !== identity.uid)) {
        throw new ImportOperationError('retry', 'The active account has changed. Submit this file from the intended account.');
      }
      const attemptId = attempt?.attemptId ?? createImportAttempt().attemptId;
      const id = 'doc-' + identity.uid + '-' + sha256(strToU8(JSON.stringify(attemptId)));
      const { originalPath, title, format } = input;
      const importedAt = new Date();
      let candidate: { document: Document; bytes: Uint8Array; hash: string } | undefined;
      return mutate(async state => {
        const prior = outcome(state, attemptId);
        if (prior.kind === 'committed') return { value: prior.document };
        if (prior.kind === 'deleted') throw new ImportOperationError('already_deleted', 'This import was already completed and its document was removed.');
        if (!candidate) {
          const safeTitle = requireTitle(title);
          const bytes = await port.readImport(originalPath);
          const hash = validateBytes(format, bytes);
          candidate = { document: new Document(id, safeTitle, format, port.path(id, format), importedAt, bytes.byteLength), bytes, hash };
        }
        const { document, bytes, hash } = candidate;
        const existing = state.entries.get(id);
        state.receipts.set(attemptId, id);
        // A different device may have downloaded this immutable ID before the
        // original import was retried here. Persist the receipt without replacing it.
        if (existing) {
          requireMatch(existing, document, hash);
          if (existing.hidden) throw new ImportOperationError('already_deleted', 'This import was already completed and its document was removed.');
          return { value: existing.document, changed: true };
        }
        return add(state, document, bytes, hash, false);
      });
    },
    async updateDocument(document) {
      if (!ownsPath(document)) throw new Error('This document does not belong to the active account.');
      const id = document.id;
      const updates = { title: requireTitle(document.title), pageCount: document.pageCount,
        lastOpenedAt: document.lastOpenedAt && new Date(document.lastOpenedAt.getTime()) };
      const operationId=newStudyOperationId();
      return mutate(state => {
        const entry = visibleEntry(state, id);
        if(displayed(state,entry).title!==updates.title)queueStudyMutation(state.study,{operationId,kind:'document',id,action:'put',payload:{title:updates.title}});
        const updated = entry.document.copyWith(updates);
        Document.fromJson(updated.toJson());
        entry.document = updated;
        return { value: undefined, changed: true };
      });
    },
    deleteDocument(id) {
      return mutate(state => {
        const entry = state.entries.get(id);
        if (!entry) throw new Error('Document not found');
        if (entry.hidden) return { value: undefined };
        entry.hidden = true;
        return { value: undefined, changed: true };
      });
    },
    updateLastOpened(id) {
      return mutate(state => {
        const entry = visibleEntry(state, id);
        entry.document = entry.document.copyWith({ lastOpenedAt: new Date() });
        return { value: undefined, changed: true };
      });
    },
    async documentFileExists(id) {
      const entry = (await readState()).entries.get(id);
      return Boolean(entry && !entry.hidden && await port.fileExists(entry.document.filePath));
    },
    async listSyncEntries() {
      return [...(await readState()).entries.values()].map(({ document, synced, hidden }) => ({ document, synced, hidden }));
    },
    async readBytes(document) {
      if (!ownsPath(document)) throw new Error('This document does not belong to the active account.');
      const entry = (await readState()).entries.get(document.id);
      if (!entry || entry.document.filePath !== document.filePath) throw new Error('This document does not belong to the active account.');
      const bytes = await port.readFile(entry.document.filePath);
      if (!bytes) throw new Error('The stored document is missing. Sync the account library and retry.');
      if (bytes.byteLength !== entry.document.fileSize || sha256(bytes) !== entry.hash) {
        throw new Error('The stored document failed its integrity check.');
      }
      return bytes;
    },
    async acceptRemote(row, bytes) {
      const { document, hash } = validateRow(row);
      if (bytes.byteLength !== document.fileSize || validateBytes(document.format, bytes) !== hash) {
        throw new Error('The downloaded document failed its integrity check.');
      }
      const verified = Uint8Array.from(bytes);
      return mutate(async state => {
        const entry = state.entries.get(document.id);
        if (!entry) return add(state, document, verified, hash, true);
        requireMatch(entry, document, hash);
        const missing = !await port.fileExists(entry.document.filePath);
        if (entry.synced && !missing) return { value: entry.document };
        entry.synced = true;
        return { value: entry.document, changed: true,
          write: missing ? { path: entry.document.filePath, bytes: verified, hash } : undefined };
      });
    },
    async markSynced(id, row) {
      const { document, hash } = validateRow(row);
      if (id !== document.id) throw new Error('The cloud receipt does not match this document.');
      return mutate(state => {
        const entry = state.entries.get(id);
        if (!entry) throw new Error('Document not found');
        requireMatch(entry, document, hash);
        if (entry.synced) return { value: undefined };
        entry.synced = true;
        return { value: undefined, changed: true };
      });
    },
    async copyLegacy(document, bytes) {
      const hash = validateBytes(document.format, bytes);
      const id = 'legacy-' + identity.uid + '-' + sha256(strToU8(JSON.stringify([document.id, hash])));
      const copy = document.copyWith({ id, title: requireTitle(document.title),
        filePath: port.path(id, document.format), fileSize: bytes.byteLength });
      // Recreate the value from its metadata to keep caller-owned dates out of the cache.
      const owned = Document.fromJson(copy.toJson());
      const verified = Uint8Array.from(bytes);
      return mutate(async state => {
        const existing = state.entries.get(id);
        if (!existing) return add(state, owned, verified, hash, false);
        requireMatch(existing, owned, hash);
        const path = existing.document.filePath;
        if (await port.fileExists(path)) return { value: existing.document };
        return { value: existing.document, changed: true, write: { path, bytes: verified, hash } };
      });
    },
  };
}
