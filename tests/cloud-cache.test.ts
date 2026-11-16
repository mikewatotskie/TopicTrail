import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Document, DocumentFormat } from '../src/core/models/document';
import { createAccountCache, type CachePort, type CacheWrite } from '../src/core/services/cloud/cache_store';
import type { StudyRecord, StudyMutation } from '../src/core/services/cloud/study_state';
import type { CloudDocumentRow } from '../src/core/services/cloud/types';
import { SyncRateLimit, SyncRetryGate } from '../src/core/services/cloud/sync_retry';
import { CloudSyncEngine } from '../src/core/services/cloud/engine';
import { StudyBookmarks } from '../src/core/services/cloud/study_bookmarks';

const owner = { project: 'abcdefghijklmnopqrst', uid: '10000000-2000-3000-4000-500000000000' };
const other = { ...owner, uid: '10000000-2000-3000-4000-500000000001' };
const pdf = Buffer.from('%PDF-1.7\ncache verification file\n%%EOF\n');
const secondPdf = Buffer.from('%PDF-1.7\nsecond cache verification file\n%%EOF\n');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const attempt = (attemptId: string, uid = owner.uid) => ({ attemptId, actor: { kind: 'account' as const, uid } });

class MemoryCachePort implements CachePort {
  snapshot: { revision: number; json: string | null } = { revision: 0, json: null };
  files = new Map<string, Uint8Array>();
  sources = new Map<string, Uint8Array>([['source', pdf]]);
  reportLostCommit = false;
  conflicts = 0;

  path(id: string, format: DocumentFormat) {
    return 'test://account/' + id + '.' + format;
  }

  async readState() { return { ...this.snapshot }; }

  async commit(expectedRevision: number, json: string, write?: CacheWrite) {
    if (this.snapshot.revision !== expectedRevision) { this.conflicts++; return false; }
    if (write) {
      assert(!this.files.has(write.path), 'existing document bytes cannot be overwritten');
      this.files.set(write.path, Uint8Array.from(write.bytes));
    }
    this.snapshot = { revision: expectedRevision + 1, json };
    if (this.reportLostCommit) throw Error('Storage reported a failure after committing the change');
    return true;
  }

  async readFile(path: string) { return this.files.get(path)?.slice() ?? null; }
  async fileExists(path: string) { return this.files.has(path); }
  async readImport(path: string) {
    const bytes = this.sources.get(path);
    if (!bytes) throw Error('The source is unavailable');
    return Uint8Array.from(bytes);
  }
}

const source = (attemptId: string, uid = owner.uid) => ({
  originalPath: 'source', title: 'Sample file', format: DocumentFormat.PDF, attempt: attempt(attemptId, uid),
});

function row(id: string, bytes: Uint8Array = pdf): CloudDocumentRow {
  return { user_id: owner.uid, id, title: 'Cloud title', format: 'pdf', byte_size: bytes.byteLength,
    sha256: digest(bytes), imported_at: '2026-10-10T14:30:00.000Z', object_path: owner.uid + '/' + id + '.pdf' };
}

test('an account import persists a receipt that replays without the picker source', async () => {
  const port = new MemoryCachePort();
  const first = await createAccountCache(owner, port).saveDocument(source('same-attempt'));
  port.sources.clear();
  const reopened = createAccountCache(owner, port);
  const replay = await reopened.saveDocument(source('same-attempt'));
  assert.equal(replay.id, first.id);
  assert(first.id.includes(owner.uid));
  assert.match(first.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert(first.id.length <= 128);
  assert.deepEqual(await reopened.readBytes(replay), Uint8Array.from(pdf));
  assert.equal((await reopened.lookupGuestImportOutcome('same-attempt')).kind, 'committed');
  assert.deepEqual(await reopened.getGuestAllowance(), { kind: 'disabled' });
  assert.equal((await reopened.getAllDocuments()).length, 1);
});

test('an account cooldown survives reopen, cannot be shortened by another tab, and preserves document bytes', async () => {
  const port = new MemoryCachePort(), cache = createAccountCache(owner, port);
  const document = await cache.saveDocument(source('cooldown'));
  const now = Date.now(), first = new SyncRetryGate(cache.retryWindow, () => now);
  await first.defer(new SyncRateLimit(now+180_000));
  const reopened = createAccountCache(owner, port);
  const second = new SyncRetryGate(reopened.retryWindow, () => now);
  await assert.rejects(second.prepare(), (e:unknown)=>e instanceof SyncRateLimit && e.retryAt===now+180_000);
  await reopened.retryWindow!.extend({until:now+60_000,attempts:1});
  await reopened.retryWindow!.clear({until:now+60_000,attempts:1});
  assert.equal((await cache.retryWindow!.read())?.until,now+180_000);
  assert.deepEqual(await reopened.readBytes(document), Uint8Array.from(pdf));
});

test('a stale actor cannot save or replay an attempt in another account', async () => {
  const port = new MemoryCachePort();
  const cache = createAccountCache(owner, port);
  await cache.saveDocument(source('same-attempt'));
  await assert.rejects(cache.saveDocument(source('same-attempt', other.uid)), /account/i);
  await assert.rejects(cache.saveDocument({ ...source('guest-attempt'), attempt: {
    attemptId: 'guest-attempt', actor: { kind: 'guest' },
  } }), /account/i);
  assert.equal((await cache.getAllDocuments()).length, 1);
});

test('concurrent caches retry a stale revision without losing another import', async () => {
  const port = new MemoryCachePort();
  const first = createAccountCache(owner, port);
  const second = createAccountCache(owner, port);
  const documents = await Promise.all([
    first.saveDocument(source('first-tab')),
    second.saveDocument(source('second-tab')),
    first.saveDocument(source('third-import')),
  ]);
  assert(port.conflicts > 0);
  assert.deepEqual((await second.getAllDocuments()).map(doc => doc.id).sort(), documents.map(doc => doc.id).sort());
});

test('a committed import can be recovered after storage reports an ambiguous failure', async () => {
  const port = new MemoryCachePort();
  port.reportLostCommit = true;
  const cache = createAccountCache(owner, port);
  const imported = await cache.saveDocument(source('interrupted-response'));
  const reopened = createAccountCache(owner, port);
  const receipt = await reopened.lookupGuestImportOutcome('interrupted-response');
  assert.equal(receipt.kind === 'committed' && receipt.document.id, imported.id);
  assert.equal((await reopened.getAllDocuments()).length, 1);
});

test('malformed persisted state blocks writes and preserves the original metadata and files', async () => {
  const port = new MemoryCachePort();
  const cache = createAccountCache(owner, port);
  const file = await cache.saveDocument(source('saved'));
  const broken = '{"entries":';
  port.snapshot = { revision: port.snapshot.revision, json: broken };
  await assert.rejects(cache.initialize(), /metadata/i);
  await assert.rejects(cache.saveDocument(source('next')), /metadata/i);
  assert.equal(port.snapshot.json, broken);
  assert.deepEqual(port.files.get(file.filePath), Uint8Array.from(pdf));
});

test('downloads reject foreign or forged metadata and unverified bytes', async () => {
  const port = new MemoryCachePort();
  const cache = createAccountCache(owner, port);
  const id = 'doc-' + owner.uid + '-download';
  const metadata = row(id);
  await assert.rejects(cache.acceptRemote({ ...metadata, user_id: other.uid }, pdf));
  await assert.rejects(cache.acceptRemote({ ...metadata, object_path: metadata.object_path + '.pdf' }, pdf));
  await assert.rejects(cache.acceptRemote(row('download-without-owner'), pdf));
  await assert.rejects(cache.acceptRemote(metadata, secondPdf));
  await assert.rejects(cache.acceptRemote({ ...metadata, sha256: '0'.repeat(64) }, pdf));
  const fakePdf = Buffer.from('This is no PDF.');
  await assert.rejects(cache.acceptRemote(row(id, fakePdf), fakePdf));
  assert.deepEqual(await cache.getAllDocuments(), []);
  assert.equal(port.files.size, 0);
});

test('download reconciliation keeps local edits and never revives a hidden document', async () => {
  const port = new MemoryCachePort();
  const cache = createAccountCache(owner, port);
  const imported = await cache.saveDocument(source('pending'));
  const localActivity = new Date('2026-11-10T16:30:00Z');
  await cache.updateDocument(imported.copyWith({ title: 'Private local title', pageCount: 3, lastOpenedAt: localActivity }));
  const stored = await cache.acceptRemote(row(imported.id), pdf);
  assert.equal(stored.title, 'Private local title');
  assert.equal(stored.pageCount, 3);
  assert.deepEqual(stored.lastOpenedAt, localActivity);
  await cache.deleteDocument(imported.id);
  const reopened = createAccountCache(owner, port);
  await reopened.acceptRemote(row(imported.id), pdf);
  assert.equal(await reopened.getDocument(imported.id), null);
  assert.equal(await reopened.documentFileExists(imported.id), false);
  assert.deepEqual(await reopened.lookupGuestImportOutcome('pending'), { kind: 'deleted' });
  const [entry] = await reopened.listSyncEntries();
  assert.deepEqual({ hidden: entry.hidden, synced: entry.synced }, { hidden: true, synced: true });
  assert.deepEqual(port.files.get(imported.filePath), Uint8Array.from(pdf));
});

test('byte reads enforce account path and detect altered content', async () => {
  const port = new MemoryCachePort();
  const cache = createAccountCache(owner, port);
  const file = await cache.acceptRemote(row('doc-' + owner.uid + '-download'), pdf);
  await assert.rejects(cache.readBytes(file.copyWith({ filePath: 'file:///guest/secret.pdf' })), /account/i);
  await assert.rejects(createAccountCache(other, new MemoryCachePort()).readBytes(file), /account/i);
  port.files.set(file.filePath, Uint8Array.from(secondPdf));
  await assert.rejects(cache.readBytes(file), /integrity/i);
});

test('cloud receipts cannot mark conflicting bytes as uploaded', async () => {
  const cache = createAccountCache(owner, new MemoryCachePort());
  const file = await cache.saveDocument(source('upload'));
  await assert.rejects(cache.markSynced(file.id, row(file.id, secondPdf)), /conflict/i);
  assert.equal((await cache.listSyncEntries())[0].synced, false);
  await cache.markSynced(file.id, row(file.id));
  assert.equal((await cache.listSyncEntries())[0].synced, true);
});

test('explicit legacy copies are keyed by original ID and content and preserve hidden copies', async () => {
  const port = new MemoryCachePort();
  const cache = createAccountCache(owner, port);
  const legacy = new Document('old-syllabus', 'Original', DocumentFormat.PDF, 'file:///guest/old-syllabus.pdf',
    new Date('2026-10-01T04:00:00Z'), pdf.byteLength);
  const copied = await cache.copyLegacy(legacy, pdf);
  assert.notEqual(copied.id, legacy.id);
  assert.equal(copied.title, 'Original');
  assert.equal(copied.importedAt.toISOString(), '2026-10-01T04:00:00.000Z');
  assert.equal(legacy.filePath, 'file:///guest/old-syllabus.pdf');
  const reopened = createAccountCache(owner, port);
  assert.equal((await reopened.copyLegacy(legacy, pdf)).id, copied.id);
  const edited = await reopened.copyLegacy(legacy, secondPdf);
  assert.notEqual(edited.id, copied.id);
  await reopened.deleteDocument(copied.id);
  assert.equal((await cache.copyLegacy(legacy, pdf)).id, copied.id);
  assert.deepEqual((await cache.getAllDocuments()).map(doc => doc.id), [edited.id]);
});

test('a native account library can reopen after the sandbox root moves', async () => {
  const port = new MemoryCachePort();
  const original = await createAccountCache(owner, port).saveDocument(source('before-update'));
  const mounted = 'test://relocated-account/' + original.id + '.pdf';
  port.files.set(mounted, port.files.get(original.filePath)!);
  port.files.delete(original.filePath);
  port.path = (id, format) => 'test://relocated-account/' + id + '.' + format;
  const reopened = createAccountCache(owner, port);
  const file = await reopened.getDocument(original.id);
  assert.equal(file?.filePath, mounted);
  assert.deepEqual(await reopened.readBytes(file!), Uint8Array.from(pdf));
});

test('a remote retry restores absent bytes without replacing visible metadata', async () => {
  const port = new MemoryCachePort();
  const cache = createAccountCache(owner, port);
  const metadata = row('doc-' + owner.uid + '-download');
  const original = await cache.acceptRemote(metadata, pdf);
  await cache.updateDocument(original.copyWith({ title: 'Local rename' }));
  port.files.delete(original.filePath);
  assert.equal(await cache.documentFileExists(original.id), false);
  assert.equal((await cache.getDocument(original.id))?.title, 'Local rename');
  const restored = await cache.acceptRemote(metadata, pdf);
  assert.equal(restored.title, 'Local rename');
  assert.deepEqual(await cache.readBytes(restored), Uint8Array.from(pdf));
});

test('native metadata reads complete before another operation can replace a slot', async () => {
  const port = new MemoryCachePort();
  const cache = createAccountCache(owner, port);
  const readState = port.readState.bind(port);
  const readerStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  port.readState = async () => {
    if (first) {
      first = false;
      readerStarted.resolve();
      await release.promise;
    }
    return readState();
  };
  const reading = cache.getAllDocuments();
  await readerStarted.promise;
  const writing = cache.saveDocument(source('queued'));
  await new Promise<void>(resolve => setImmediate(resolve));
  const revisionWhileReading = port.snapshot.revision;
  release.resolve();
  await Promise.all([reading, writing]);
  assert.equal(revisionWhileReading, 0);
});

test('account cache identity keeps only the storage namespace and UID', () => {
  const session = { ...owner, accessToken: 'test-capability' };
  const cache = createAccountCache(session, new MemoryCachePort());
  assert.deepEqual(cache.identity, owner);
});


test('account study changes and outbox commit atomically across independent caches without losing originals', async()=>{
 const port=new MemoryCachePort();const first=createAccountCache(owner,port),second=createAccountCache(owner,port);
 const doc=await first.saveDocument(source('study-cache'));
 assert.ok(first.study);assert.ok(second.study);
 await Promise.all([
   first.study.queue({operationId:'first-study',kind:'document',id:doc.id,action:'put',payload:{title:'Renamed'}}),
   second.saveDocument(source('other-study-import')),
 ]);
 const reopened=createAccountCache(owner,port);assert.ok(reopened.study);
 assert.equal((await reopened.getDocument(doc.id))?.title,'Renamed');
 assert.equal((await reopened.study.read()).pending[0].operationId,'first-study');
 assert.equal((await reopened.getAllDocuments()).length,2);
 assert.deepEqual(await reopened.readBytes(doc),Uint8Array.from(pdf));
 await reopened.study.queue({operationId:'trash-study',kind:'document',id:doc.id,action:'remove',payload:{title:'Renamed'}});
 assert.equal(await reopened.getDocument(doc.id),null);
 assert.equal((await reopened.study.trashed())[0].id,doc.id);
 assert.equal(port.files.size,2);
});

// Exercise the production cache and sync engine together, including a crash after server commit.
test('an offline DuckDuckGo citation survives restart and syncs once across two account caches', async () => {
  const citation = {url: 'https://en.wikipedia.org/wiki/Iteration', title: 'Iteration', type: 'Article' as const,
    providerId: 'duckduckgo', providerName: 'Wikipedia', description: 'Iteration repeats a process.', topic: 'Iteration'};
  const firstDisk = new MemoryCachePort();
  const diskBookmarks = (cache: ReturnType<typeof createAccountCache>) => new StudyBookmarks(cache.study!.read, cache.study!.queue);
  const offline = diskBookmarks(createAccountCache(owner, firstDisk));
  const [saved, duplicate] = await Promise.all([offline.save(citation), offline.save(citation)]);
  assert.deepEqual(saved, duplicate);
  const first = createAccountCache(owner, firstDisk);
  const reopened = diskBookmarks(first);
  await reopened.initialize();
  assert.deepEqual(reopened.getSnapshot().bookmarks, [saved]);
  assert.equal((await first.study!.read()).pending.length, 1);

  const records: StudyRecord[] = [];
  const remote = {
    list: async () => [],
    download: async () => { throw Error('Unexpected file download'); },
    upload: async () => { throw Error('Unexpected file upload'); },
    listStudy: async () => records,
    applyStudy: async (op: StudyMutation) => {
      const record = {kind: op.kind, id: op.id, revision: 1, deleted: false, payload: op.payload};
      records.push(record);
      return {status: 'applied' as const, record};
    },
  };
  async function sync(cache: ReturnType<typeof createAccountCache>) {
    const engine = new CloudSyncEngine({cache: () => cache, remote: () => remote, session: async () => ({...owner, accessToken: 'synthetic'}),
      legacy: {getAllDocuments: async () => []}, readLegacy: async () => pdf});
    try { engine.select(owner); await engine.sync(); assert.equal(engine.getSnapshot().phase, 'ready'); }
    finally { engine.dispose(); }
  }
  await sync(first);
  const second = createAccountCache(owner, new MemoryCachePort());
  await sync(second);
  const received = diskBookmarks(second);
  await received.initialize();
  assert.deepEqual(received.getSnapshot().bookmarks, [saved]);
  assert.deepEqual(await received.save({...citation, providerId: 'wikipedia', title: 'Other title'}), saved);
  await sync(second);
  assert.equal((await second.study!.read()).pending.length, 0);
  assert.equal(records.length, 1);
});

test('Trash before first upload preserves originals and lost mutation replies replay after restart', async()=>{
 const port=new MemoryCachePort();let cache=createAccountCache(owner,port);
 const doc=await cache.saveDocument(source('offline-trash'));
 await cache.study!.queue({operationId:'offline-trash-op',kind:'document',id:doc.id,action:'remove',payload:{title:doc.title}});
 let metadata:CloudDocumentRow|undefined;let authoritative:StudyRecord|undefined;let failReply=true;let calls=0;
 const remote={list:async()=>metadata?[metadata]:[],download:async()=>Uint8Array.from(pdf),upload:async(d:Document,b:Uint8Array)=>{assert.deepEqual(b,Uint8Array.from(pdf));metadata={...row(d.id),title:d.title};return metadata;},
 listStudy:async()=>authoritative?[authoritative]:[],applyStudy:async(op:StudyMutation)=>{calls++;assert.equal(op.operationId,'offline-trash-op');assert.ok(metadata,'original uploads before study mutation');authoritative??={kind:'document',id:doc.id,revision:1,deleted:true,payload:{title:doc.title}};if(failReply){failReply=false;throw Error('Reply lost after server commit');}return {status:'applied' as const,record:authoritative};}};
 const make=()=>new CloudSyncEngine({cache:()=>cache,remote:()=>remote,session:async()=>({...owner,accessToken:'synthetic'}),legacy:{getAllDocuments:async()=>[]},readLegacy:async()=>pdf});
 const first=make();first.select(owner);await first.sync();assert.equal(first.getSnapshot().phase,'error');
 assert.equal((await cache.study!.read()).pending.length,1);first.dispose();cache=createAccountCache(owner,port);
 const restarted=make();restarted.select(owner);await restarted.sync();assert.equal(restarted.getSnapshot().phase,'ready');assert.equal(calls,2);
 assert.equal((await cache.study!.read()).pending.length,0);assert.equal(await cache.getDocument(doc.id),null);assert.equal((await cache.study!.trashed())[0].id,doc.id);assert.deepEqual(await cache.readBytes(doc),Uint8Array.from(pdf));restarted.dispose();
});
