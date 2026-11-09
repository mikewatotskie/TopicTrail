import { createIndexedDbClient, openTopicTrailDb } from '../../src/core/services/web/indexeddb_client';
import { DOCUMENT_STORE_PROTOCOL } from '../../src/core/services/document_recovery_contract';
import { openSuccessorDatabase, type BootstrapInspection, type SuccessorDatabase } from '../../src/core/services/web/successor_database';

const prefix = 'topictrail-successor-test-';
const path = 'topictrail-idb://documents/retained-file.pdf';
const orphan = 'topictrail-idb://documents/orphan-file.pdf';
const metadata = { json: JSON.stringify({ version: 3, documents: [{ id: 'retained-file', title: 'Retained fixture', format: 'pdf',
  filePath: path, importedAt: '2026-11-01T00:00:00.000Z', fileSize: 14, pendingDeletion: true }],
  guestImports: [{ attemptId: 'charged-deleted', documentId: 'deleted-file' }, { attemptId: 'charged-live', documentId: 'retained-file' }],
  importAttempts: [{ attemptId: 'charged-deleted', documentId: 'deleted-file' }, { attemptId: 'charged-live', documentId: 'retained-file' },
    { attemptId: 'uncharged-deleted', documentId: 'another-deleted-file' }],
  guestUsageRecoveryRequired: true, importReplayRecoveryRequired: true }, null, 2), revision: 9 };
const bookmarks = { json: '{"version":1,"bookmarks":[]}', revision: 12 };
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw Error(message); };
function ownedName(name: string) { assert(name.startsWith(prefix), 'Fixture database namespace required'); }
function code(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : undefined; }
async function rejects(action: () => unknown, expected?: string) {
  let failed = false;
  try { await action(); } catch (error) { failed = true; if (expected) assert(code(error) === expected, `Expected ${expected}, received ${String(code(error))}`); }
  assert(failed, 'Expected rejection');
}
function transaction<T>(db: IDBDatabase, names: string[], mode: IDBTransactionMode,
  action: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T;
    const tx = db.transaction(names, mode);
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error ?? Error('Fixture transaction aborted'));
    try { action(tx, value => { result = value; }); } catch (error) { tx.abort(); reject(error); }
  });
}
function read<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T> {
  return transaction(db, [store], 'readonly', (tx, set) => { const request = tx.objectStore(store).get(key); request.onsuccess = () => set(request.result as T); });
}
function rawOpen(name: string, version: number, upgrade?: (db: IDBDatabase, tx: IDBTransaction) => void): Promise<IDBDatabase> {
  ownedName(name);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result, request.transaction!);
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  });
}
function instrumentFactory(instrument: (request: IDBOpenDBRequest) => void): IDBFactory {
  return new Proxy(indexedDB, { get(target, key) {
    if (key === 'open') return (name: string, version?: number) => { ownedName(name); const request = target.open(name, version); instrument(request); return request; };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function seed(name: string): Promise<IDBDatabase> {
  ownedName(name);
  const db = await openTopicTrailDb(indexedDB, name);
  await transaction(db, ['libraries', 'documents'], 'readwrite', tx => {
    tx.objectStore('libraries').add(metadata, 'documents'); tx.objectStore('libraries').add(bookmarks, 'bookmarks');
    tx.objectStore('documents').add(new Blob(['%PDF-1.7 test']), path);
    tx.objectStore('documents').add(new Blob(['preserved orphan']), orphan);
  });
  return db;
}
function retained(snapshot: BootstrapInspection) {
  assert(snapshot.control.mode === 'migration' && snapshot.control.libraryId === null && snapshot.control.lastEnvelope === null,
    'Upgrade fabricated an active library');
  const doc = snapshot.records.find(item => item.sourceKey === 'documents')?.value;
  const saved = snapshot.records.find(item => item.sourceKey === 'bookmarks')?.value;
  assert(JSON.stringify(doc) === JSON.stringify(metadata), 'Raw V3 metadata, replay/receipt/deletion or recovery fields changed');
  assert(JSON.stringify(saved) === JSON.stringify(bookmarks), 'Bookmark record changed');
  assert(snapshot.capture.pinnedDocumentKeys.includes(path) && snapshot.capture.pinnedDocumentKeys.includes(orphan), 'Live/orphan bytes were not pinned');
}
async function removeFixture(name: string): Promise<void> {
  ownedName(name);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('A fixture connection was not closed'));
  });
}
export interface SuccessorBrowserResult { name: string; result: 'PASS' | 'FAIL'; error?: string }
export async function runSuccessorStorageCases(): Promise<SuccessorBrowserResult[]> {
  const results: SuccessorBrowserResult[] = [];
  const cases: Record<string, (name: string, track: <T extends { close(): void }>(value: T) => T) => Promise<void>> = {
    async 'upgrade preserves exact V3 receipts, replay tombstones, pending deletion, uncertainty, bookmarks and orphan bytes'(name, track) {
      const db = track(await seed(name)); const old = createIndexedDbClient(db);
      const next = track(await openSuccessorDatabase(indexedDB, { name }));
      assert(next.version === 3 && next.upgraded, 'Expected completed schema-3 upgrade'); retained(await next.inspectBootstrap());
      await rejects(() => old.commitLibrary('documents', metadata.revision, '[]'));
      await rejects(() => old.removeOwnedDocument(path, metadata.revision));
      const raw = track(await rawOpen(name, 3));
      assert(await (await read<Blob>(raw, 'documents', path)).text() === '%PDF-1.7 test', 'Document bytes changed');
      assert(await (await read<Blob>(raw, 'documents', orphan)).text() === 'preserved orphan', 'Orphan bytes changed');
      assert(JSON.stringify(await read(raw, 'libraries', 'documents')) === JSON.stringify(metadata), 'Primary was rewritten');
      await rejects(() => createIndexedDbClient(raw), 'upgrade_required');
      await rejects(() => openTopicTrailDb(indexedDB, name));
    },
    async 'corrupt structured-clone metadata is archived without a lossy JSON conversion'(name, track) {
      const db = track(await seed(name));
      const broken: { raw: string; date: Date; bytes: Uint8Array; self?: unknown; missing: undefined } = {
        raw: '{broken', date: new Date('2026-11-01T00:00:00Z'), bytes: new Uint8Array([0, 255, 17]), missing: undefined };
      broken.self = broken;
      await transaction(db, ['libraries', 'documents'], 'readwrite', tx => {
        tx.objectStore('libraries').put(broken, 'documents');
        tx.objectStore('libraries').add(new Map([['unrecognized', 123]]), ['unknown', 9]);
        tx.objectStore('documents').add(new Blob(['unknown-owned-data']), ['unknown', 9]);
      });
      const next = track(await openSuccessorDatabase(indexedDB, { name }));
      const snapshot = await next.inspectBootstrap();
      const value = snapshot.records.find(item => item.sourceKey === 'documents')!.value as typeof broken;
      assert(value.self === value && value.raw === '{broken' && Object.hasOwn(value, 'missing'), 'Corrupt raw shape was lost');
      assert(value.date instanceof Date && value.date.getTime() === broken.date.getTime(), 'Date clone lost');
      assert(value.bytes instanceof Uint8Array && value.bytes[1] === 255, 'Typed array lost');
      assert(snapshot.records.some(item => item.value instanceof Map), 'Unknown library entry was discarded');
      assert(snapshot.capture.pinnedDocumentKeys.some(key => Array.isArray(key)), 'Unknown byte key was discarded');
    },
    async 'reopening after interruption resumes the same persistent barrier and capture identity'(name, track) {
      track(await seed(name)); const first = await openSuccessorDatabase(indexedDB, { name });
      const before = await first.inspectBootstrap(); first.close();
      const second = track(await openSuccessorDatabase(indexedDB, { name }));
      assert(!second.upgraded, 'Reopen repeated the schema upgrade');
      const after = await second.inspectBootstrap();
      assert(JSON.stringify(after) === JSON.stringify(before), 'Reopen rewrote the barrier/capture'); retained(after);
    },
    async 'legacy transaction queued before versionchange is included in the atomic archive'(name, track) {
      const db = track(await seed(name)); const client = createIndexedDbClient(db);
      const updated = '{"version":1,"bookmarks":["committed-before-upgrade"]}';
      const pending = client.commitLibrary('bookmarks', bookmarks.revision, updated);
      const [revision, next] = await Promise.all([pending, openSuccessorDatabase(indexedDB, { name })]); track(next);
      const snapshot = await next.inspectBootstrap();
      const captured = snapshot.records.find(item => item.sourceKey === 'bookmarks')!.value as { revision: number; json: string };
      assert(captured.revision === revision && captured.json === updated, 'Upgrade captured a stale pre-transaction record');
    },
    async 'fresh database gets a migration barrier rather than an invented active guest identity'(name, track) {
      const next = track(await openSuccessorDatabase(indexedDB, { name })); const snapshot = await next.inspectBootstrap();
      assert(snapshot.control.sourceDatabaseVersion === 0 && snapshot.control.libraryId === null, 'Empty bootstrap fabricated ownership');
      assert(snapshot.records.length === 0 && snapshot.capture.pinnedDocumentKeys.length === 0, 'Empty capture is inconsistent');
      assert(snapshot.control.evidenceManifestIds.length === 0, 'Raw capture was incorrectly marked sealed');
    },
    async 'blocked request cannot upgrade secretly after the rejecting promise settles'(name, track) {
      const old = track(await seed(name)); old.onversionchange = () => undefined;
      await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'upgrade_blocked'); old.close();
      // Queued after the abandoned upgrade: success at v1 proves its delayed upgrade was aborted.
      const reopened = track(await rawOpen(name, 1));
      assert(reopened.version === 1 && reopened.objectStoreNames.length === 2, 'Abandoned upgrade mutated schema');
      assert(JSON.stringify(await read(reopened, 'libraries', 'documents')) === JSON.stringify(metadata), 'Blocked request changed data');
    },
    async 'cancel before open issues no database request'(name) {
      const controller = new AbortController(); controller.abort(); let calls = 0;
      const factory = instrumentFactory(() => { calls++; });
      await rejects(() => openSuccessorDatabase(factory, { name, signal: controller.signal }), 'cancelled');
      assert(calls === 0, 'Precancelled upgrade opened storage');
    },
    async 'cancellation during versionchange rolls back schema and evidence together'(name, track) {
      track(await seed(name)); const controller = new AbortController();
      const factory = instrumentFactory(request => request.addEventListener('upgradeneeded', () => {
        const check = request.transaction!.objectStore('libraries').get('documents');
        check.onsuccess = () => controller.abort();
      }));
      await rejects(() => openSuccessorDatabase(factory, { name, signal: controller.signal }), 'cancelled');
      const reopened = track(await rawOpen(name, 1));
      assert(reopened.objectStoreNames.length === 2, 'Cancelled upgrade left evidence/control stores');
      assert(JSON.stringify(await read(reopened, 'libraries', 'documents')) === JSON.stringify(metadata), 'Cancelled upgrade lost metadata');
    },
    async 'cancellation after the upgrade commit reports the actual committed barrier'(name, track) {
      track(await seed(name)); const controller = new AbortController();
      const factory = instrumentFactory(request => request.addEventListener('upgradeneeded', () => {
        request.transaction!.addEventListener('complete', () => controller.abort());
      }));
      const next = track(await openSuccessorDatabase(factory, { name, signal: controller.signal }));
      assert(next.upgraded && next.cancelledAfterUpgrade, 'Committed upgrade was falsely reported uncommitted'); retained(await next.inspectBootstrap());
    },
    async 'failed preservation after archive writes rolls back the whole upgrade'(name, track) {
      track(await seed(name)); const original = IDBObjectStore.prototype.add; let archived = 0;
      IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
        const request = original.call(this, value, key);
        if (this.transaction.db.name === name && this.name === 'document-evidence') {
          request.addEventListener('success', () => {
            archived++;
            if ((value as { kind?: string }).kind === 'upgrade-capture') this.transaction.abort();
          });
        }
        return request;
      };
      try { await rejects(() => openSuccessorDatabase(indexedDB, { name })); }
      finally { IDBObjectStore.prototype.add = original; }
      assert(archived >= 3, 'Fault did not occur after evidence writes');
      const reopened = track(await rawOpen(name, 1)); assert(reopened.objectStoreNames.length === 2, 'Partial upgrade survived abort');
      assert(JSON.stringify(await read(reopened, 'libraries', 'documents')) === JSON.stringify(metadata), 'Preservation failure lost authority');
      assert(await (await read<Blob>(reopened, 'documents', orphan)).text() === 'preserved orphan', 'Preservation failure lost orphan bytes');
    },
    async 'insufficient evidence storage returns storage-full and preserves the old schema and files'(name, track) {
      track(await seed(name)); const original = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
        if (this.transaction.db.name === name && this.name === 'document-evidence'
          && (value as { kind?: string }).kind === 'upgrade-capture') throw new DOMException('Controlled evidence quota failure', 'QuotaExceededError');
        return original.call(this, value, key);
      };
      try { await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'storage_full'); }
      finally { IDBObjectStore.prototype.add = original; }
      const raw = track(await rawOpen(name, 1)); assert(raw.objectStoreNames.length === 2, 'Quota failure left a partial upgrade');
      assert(JSON.stringify(await read(raw, 'libraries', 'documents')) === JSON.stringify(metadata), 'Quota failure reset metadata');
      assert(await (await read<Blob>(raw, 'documents', path)).text() === '%PDF-1.7 test', 'Quota failure changed bytes');
    },
    async 'missing secure randomness cannot fall back to a weak migration identity'(name, track) {
      track(await seed(name)); const previous = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
      try { await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'writer_unavailable'); }
      finally { if (previous) Object.defineProperty(crypto, 'randomUUID', previous); else Reflect.deleteProperty(crypto, 'randomUUID'); }
      const raw = track(await rawOpen(name, 1)); assert(raw.objectStoreNames.length === 2, 'Missing randomness left a partial migration');
    },
    async 'a partially structured successor schema requires recovery rather than creating missing stores'(name, track) {
      const old = await seed(name); old.close();
      const partial = await rawOpen(name, 3, db => { db.createObjectStore('document-control'); }); partial.close();
      await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'recovery_required');
      const raw = track(await rawOpen(name, 3)); assert(!raw.objectStoreNames.contains('document-evidence'), 'Partial schema was silently repaired');
      assert(JSON.stringify(await read(raw, 'libraries', 'documents')) === JSON.stringify(metadata), 'Partial schema reset data');
    },
    async 'missing control is a recovery error and cannot reopen the readable V3 branch'(name, track) {
      track(await seed(name)); const first = await openSuccessorDatabase(indexedDB, { name }); first.close();
      const raw = track(await rawOpen(name, 3));
      await transaction(raw, ['document-control'], 'readwrite', tx => { tx.objectStore('document-control').delete('state'); });
      await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'recovery_required');
      assert(JSON.stringify(await read(raw, 'libraries', 'documents')) === JSON.stringify(metadata), 'Missing control rewrote V3');
    },
    async 'missing raw evidence cannot be silently regenerated from the old library'(name, track) {
      track(await seed(name)); const first = await openSuccessorDatabase(indexedDB, { name });
      const snapshot = await first.inspectBootstrap(); first.close(); const raw = track(await rawOpen(name, 3));
      await transaction(raw, ['document-evidence'], 'readwrite', tx => { tx.objectStore('document-evidence').delete(snapshot.capture.recordIds[0]); });
      await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'recovery_required');
      assert(await read(raw, 'document-evidence', snapshot.capture.recordIds[0]) === undefined, 'Missing evidence was silently recreated');
    },
    async 'unsupported protocol and mandatory control fields reject without older fallback'(name, track) {
      track(await seed(name)); const first = await openSuccessorDatabase(indexedDB, { name });
      const snapshot = await first.inspectBootstrap(); first.close(); const raw = track(await rawOpen(name, 3));
      for (const protocol of [{ ...DOCUMENT_STORE_PROTOCOL, revision: 3 }, { ...DOCUMENT_STORE_PROTOCOL, minimumWriter: 5 },
        { ...DOCUMENT_STORE_PROTOCOL, unknownControl: true }]) {
        await transaction(raw, ['document-control'], 'readwrite', tx => { tx.objectStore('document-control').put({ ...snapshot.control, protocol }, 'state'); });
        await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'upgrade_required');
      }
      await transaction(raw, ['document-control'], 'readwrite', tx => { tx.objectStore('document-control').put({ ...snapshot.control, unknownField: true }, 'state'); });
      await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'recovery_required');
      assert(JSON.stringify(await read(raw, 'libraries', 'documents')) === JSON.stringify(metadata), 'Unsupported control changed source');
    },
    async 'changed byte inventory invalidates capture instead of erasing its pins'(name, track) {
      track(await seed(name)); const first = await openSuccessorDatabase(indexedDB, { name });
      const snapshot = await first.inspectBootstrap(); first.close(); const raw = track(await rawOpen(name, 3));
      await transaction(raw, ['documents'], 'readwrite', tx => { tx.objectStore('documents').delete(orphan); });
      await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'recovery_required');
      assert(JSON.stringify(await read(raw, 'document-evidence', snapshot.capture.id)) === JSON.stringify(snapshot.capture), 'Unreadable inventory rewrote pins');
    },
    async 'unrecognized existing schema-2 is preserved for a compatible migration'(name, track) {
      const old = await seed(name); old.close();
      const middle = await rawOpen(name, 2, db => { db.createObjectStore('unrecognized-control'); }); middle.close();
      await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'upgrade_required');
      const raw = track(await rawOpen(name, 2)); assert(raw.objectStoreNames.contains('unrecognized-control'), 'Schema-2 state was erased');
      assert(!raw.objectStoreNames.contains('document-evidence'), 'Unsupported schema was partly upgraded');
    },
    async 'future schema is upgrade-required and never downgraded'(name, track) {
      const old = await seed(name); old.close(); const future = await rawOpen(name, 4); future.close();
      await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'upgrade_required');
      const raw = track(await rawOpen(name, 4)); assert(JSON.stringify(await read(raw, 'libraries', 'documents')) === JSON.stringify(metadata), 'Future schema reset');
    },
    async 'unexpected existing stores abort the upgrade without dropping their data'(name, track) {
      const db = await rawOpen(name, 1, db => { db.createObjectStore('libraries'); db.createObjectStore('documents'); db.createObjectStore('unknown'); });
      await transaction(db, ['unknown'], 'readwrite', tx => { tx.objectStore('unknown').add('preserve', 'record'); }); db.close();
      await rejects(() => openSuccessorDatabase(indexedDB, { name }), 'recovery_required');
      const raw = track(await rawOpen(name, 1)); assert(await read(raw, 'unknown', 'record') === 'preserve', 'Unexpected store lost');
      assert(!raw.objectStoreNames.contains('document-control'), 'Aborted upgrade left a barrier');
    },
  };
  for (const [name, run] of Object.entries(cases)) {
    const databaseName = prefix + crypto.randomUUID(); const open: { close(): void }[] = [];
    const track = <T extends { close(): void }>(value: T): T => { open.push(value); return value; };
    try { await run(databaseName, track); results.push({ name, result: 'PASS' }); }
    catch (error) { results.push({ name, result: 'FAIL', error: String(error) }); }
    finally { for (const connection of open) connection.close(); await removeFixture(databaseName); }
  }
  return results;
}

// Explicit fixture endpoints for the driver's genuinely separate tabs/processes.
let held: IDBDatabase | undefined;
let successor: SuccessorDatabase | undefined;
let stale: ReturnType<typeof createIndexedDbClient> | undefined;
export const successorTabFixture = {
  async hold(name: string, blocking: boolean) {
    ownedName(name); held = await seed(name); stale = createIndexedDbClient(held);
    if (blocking) held.onversionchange = () => undefined;
  },
  close() { held?.close(); successor?.close(); held = undefined; successor = undefined; },
  async upgrade(name: string) {
    ownedName(name);
    try { successor = await openSuccessorDatabase(indexedDB, { name }); retained(await successor.inspectBootstrap()); return 'migration'; }
    catch (error) { return code(error); }
  },
  async ensureOld(name: string) {
    ownedName(name); const db = await rawOpen(name, 1);
    try { assert(JSON.stringify(await read(db, 'libraries', 'documents')) === JSON.stringify(metadata), 'Old authority changed'); return db.version; }
    finally { db.close(); }
  },
  async staleWritesFail() {
    assert(stale, 'No retained writer');
    await rejects(() => stale!.commitLibrary('documents', 9, '[]'));
    await rejects(() => stale!.commitLibrary('bookmarks', 12, '[]'));
    await rejects(() => stale!.removeOwnedDocument(path, 9)); return true;
  },
  async inspect(name: string) {
    ownedName(name); const db = await openSuccessorDatabase(indexedDB, { name });
    try { const snapshot = await db.inspectBootstrap(); retained(snapshot); return { mode: snapshot.control.mode, migrationId: snapshot.control.migrationId, records: snapshot.records.length }; }
    finally { db.close(); }
  },
  remove: removeFixture,
};
