import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Document, DocumentFormat } from '../src/core/models/document';
import { CloudSyncEngine } from '../src/core/services/cloud/engine';
import { SyncRateLimit, syncDelayedMessage } from '../src/core/services/cloud/sync_retry';
import type { CloudCache, CloudDocumentRow, CloudIdentity, CloudLocalEntry, CloudRemote } from '../src/core/services/cloud/types';

const accountA = { project: 'abcdefghijklmnopqrst', uid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' };
const accountB = { project: accountA.project, uid: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' };
const pdfBytes = Uint8Array.of(37, 80, 68, 70, 45, 49, 46, 55);
const docxBytes = Uint8Array.of(80, 75, 3, 4);

function document(id: string, format = DocumentFormat.PDF): Document {
  return new Document(id, id, format, `file:///${id}.${format}`, new Date('2026-11-10T00:00:00Z'));
}

type CachedFile = CloudLocalEntry & { bytes: Uint8Array | null };

class DeviceCache implements CloudCache {
  readonly guestUploadPolicy = 'disabled';
  private readonly entries = new Map<string, CachedFile>();

  constructor(readonly identity: CloudIdentity) {}

  import(doc: Document, bytes: Uint8Array): void {
    this.entries.set(doc.id, { document: doc, bytes: bytes.slice(), synced: false, hidden: false });
  }

  loseBytes(id: string): void {
    this.entries.get(id)!.bytes = null;
  }

  async initialize(): Promise<void> {}
  async getGuestAllowance() { return { kind: 'disabled' } as const; }
  async lookupGuestImportOutcome() { return { kind: 'uncommitted' } as const; }
  async saveDocument(): Promise<Document> { throw new Error('Use the import fixture.'); }
  async updateDocument(): Promise<void> { throw new Error('Use the import fixture.'); }
  async updateLastOpened(): Promise<void> {}
  async documentFileExists(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    return Boolean(entry?.bytes && !entry.hidden);
  }

  async getAllDocuments(): Promise<Document[]> {
    return Array.from(this.entries.values()).filter(entry => !entry.hidden).map(entry => entry.document);
  }

  async getDocument(id: string): Promise<Document | null> {
    return (await this.getAllDocuments()).find(doc => doc.id === id) ?? null;
  }

  async deleteDocument(id: string): Promise<void> {
    this.entries.get(id)!.hidden = true;
  }

  async listSyncEntries(): Promise<CloudLocalEntry[]> {
    return Array.from(this.entries.values(), ({ document, synced, hidden }) => ({ document, synced, hidden }));
  }

  async readBytes(doc: Document): Promise<Uint8Array> {
    const bytes = this.entries.get(doc.id)?.bytes;
    if (!bytes) throw new Error('The local bytes are missing.');
    return bytes.slice();
  }

  async acceptRemote(row: CloudDocumentRow, bytes: Uint8Array): Promise<Document> {
    assert.equal(row.user_id, this.identity.uid);
    const existing = this.entries.get(row.id);
    if (existing) {
      if (!existing.hidden) existing.bytes ??= bytes.slice();
      return existing.document;
    }
    const remoteDocument = document(row.id, row.format as DocumentFormat);
    this.import(remoteDocument, bytes);
    await this.markSynced(row.id, row);
    return remoteDocument;
  }

  async markSynced(id: string, row: CloudDocumentRow): Promise<void> {
    assert.equal(id, row.id);
    assert.equal(row.user_id, this.identity.uid);
    this.entries.get(id)!.synced = true;
  }

  async copyLegacy(doc: Document, bytes: Uint8Array): Promise<Document> {
    const id = `${this.identity.uid}-copy-${doc.id}`;
    if (!this.entries.has(id)) this.import(doc.copyWith({ id }), bytes);
    return this.entries.get(id)!.document;
  }
}

function service() {
  const accounts = new Map<string, Map<string, { row: CloudDocumentRow; bytes: Uint8Array }>>();
  return (identity: CloudIdentity): CloudRemote => {
    const key = `${identity.project}/${identity.uid}`;
    const files = accounts.get(key) ?? new Map();
    accounts.set(key, files);
    return {
      async list() { return Array.from(files.values(), ({ row }) => ({ ...row })); },
      async upload(doc, bytes) {
        const row: CloudDocumentRow = {
          id: doc.id,
          user_id: identity.uid,
          title: doc.title,
          format: doc.format,
          byte_size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          imported_at: doc.importedAt.toISOString(),
          object_path: `${identity.uid}/${doc.id}.${doc.format}`,
        };
        files.set(doc.id, { row, bytes: bytes.slice() });
        return row;
      },
      async download(row) { return files.get(row.id)!.bytes.slice(); },
    };
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture(remoteFactory: (identity: CloudIdentity, signal: AbortSignal) => CloudRemote = service()) {
  const caches = [new DeviceCache(accountA), new DeviceCache(accountB)];
  const legacy = new Map<Document, Uint8Array>();
  let session: CloudIdentity | null = null;
  let legacyRead = async (doc: Document) => legacy.get(doc)!.slice();
  const engine = new CloudSyncEngine({
    cache(identity) { return caches.find(cache => cache.identity.uid === identity.uid)!; },
    session: async () => session ? { ...session, accessToken: 'fixture-access-token' } : null,
    remote: remoteFactory,
    legacy: { getAllDocuments: async () => Array.from(legacy.keys()) },
    readLegacy: doc => legacyRead(doc),
  });
  return {
    engine,
    cacheA: caches[0],
    cacheB: caches[1],
    legacy,
    interceptLegacyRead: (read: typeof legacyRead) => { legacyRead = read; },
    select(identity: CloudIdentity | null) {
      session = identity;
      engine.select(identity);
    },
    setSession(identity: CloudIdentity | null) { session = identity; },
  };
}

test('account documents imported on one device appear with identical bytes on another device', async () => {
  const remote = service();
  const deviceOne = fixture(remote);
  const deviceTwo = fixture(remote);
  const pdf = document('pdf-on-one');
  const docx = document('docx-on-two', DocumentFormat.DOCX);
  deviceOne.cacheA.import(pdf, pdfBytes);
  deviceTwo.cacheA.import(docx, docxBytes);

  const initialSync = new Promise<void>(resolve => {
    const unsubscribe = deviceOne.engine.subscribe(() => {
      if (deviceOne.engine.getSnapshot().phase === 'ready') {
        unsubscribe();
        resolve();
      }
    });
  });
  deviceOne.select(accountA);
  await initialSync;
  deviceTwo.select(accountA);
  await deviceTwo.engine.sync();
  await deviceOne.engine.sync();

  assert.deepEqual(await deviceTwo.cacheA.readBytes(pdf), pdfBytes);
  assert.deepEqual(await deviceOne.cacheA.readBytes(docx), docxBytes);
  assert.equal(deviceOne.engine.getSnapshot().phase, 'ready');
  assert.equal(deviceTwo.engine.getSnapshot().pending, 0);
});

test('an upload 429 pauses subsequent files and manual and periodic retries for this account only', async () => {
  const backend=service(),uploads:string[]=[];
  const device=fixture(identity=>{
    const remote=backend(identity);
    return {...remote,upload:async(doc,bytes)=>{
      uploads.push(identity.uid);
      if(identity.uid===accountA.uid)throw new SyncRateLimit(Date.now()+60_000);
      return remote.upload(doc,bytes);
    }};
  });
  try {
    device.cacheA.import(document('one'),pdfBytes);device.cacheA.import(document('two'),pdfBytes);
    device.select(accountA);await device.engine.sync();
    assert.equal(device.engine.getSnapshot().message,syncDelayedMessage);
    assert.equal(device.engine.getSnapshot().pending,2);
    await device.engine.sync();assert.deepEqual(uploads,[accountA.uid]);
    device.cacheB.import(document('one'),pdfBytes);device.select(accountB);await device.engine.sync();
    assert.deepEqual(uploads,[accountA.uid,accountB.uid]);assert.equal(device.engine.getSnapshot().phase,'ready');
  } finally {device.engine.dispose();}
});

test('the scheduled retry resumes an upload at Retry-After with no button press', async t => {
  t.mock.timers.enable({ apis:['Date','setTimeout'], now:Date.UTC(2026,10,11) });
  const backend=service();
  let attempts=0;
  const device=fixture(identity=>{
    const remote=backend(identity);
    return {...remote,upload:async(doc,bytes)=>{
      if(++attempts===1)throw new SyncRateLimit(Date.now()+5000);
      return remote.upload(doc,bytes);
    }};
  });
  try {
    device.cacheA.import(document('queued'),pdfBytes);
    device.select(accountA);await device.engine.sync();
    assert.equal(device.engine.getSnapshot().phase,'waiting');
    const ready=new Promise<void>(resolve=>{
      const unsubscribe=device.engine.subscribe(()=>{
        if(device.engine.getSnapshot().phase==='ready'){unsubscribe();resolve();}
      });
    });
    t.mock.timers.tick(4999);assert.equal(attempts,1);
    t.mock.timers.tick(1);await ready;
    assert.equal(attempts,2);assert.equal(device.engine.getSnapshot().pending,0);
  }finally{device.engine.dispose();t.mock.timers.reset();}
});

test('offline failure preserves local files, reports pending work and retries successfully', async () => {
  const online = service();
  let offline = true;
  const device = fixture(identity => {
    const remote = online(identity);
    return { ...remote, list: () => offline ? Promise.reject(new Error('Network unavailable')) : remote.list() };
  });
  const local = document('offline-import');
  device.cacheA.import(local, pdfBytes);
  device.select(accountA);
  await device.engine.sync();

  const failed = device.engine.getSnapshot();
  assert.equal(failed.phase, 'error');
  assert.equal(failed.pending, 1);
  assert.equal(failed.lastSyncedAt, null);
  assert.deepEqual(await device.cacheA.readBytes(local), pdfBytes);

  offline = false;
  await device.engine.sync();
  const retried = device.engine.getSnapshot();
  assert.equal(retried.phase, 'ready');
  assert.equal(retried.pending, 0);
  assert.ok(retried.lastSyncedAt);
  assert.deepEqual((await online(accountA).list()).map(row => row.id), ['offline-import']);
});

test('a stale token cannot create a transport for a different account or project', async () => {
  for (const mismatched of [accountB, { ...accountA, project: 'tsrqponmlkjihgfedcba' }]) {
    const connections: string[] = [];
    const remote = service();
    const device = fixture(identity => {
      connections.push(identity.uid);
      return remote(identity);
    });
    device.setSession(mismatched);
    device.engine.select(accountA);
    await device.engine.sync();

    assert.deepEqual(connections, []);
    assert.equal(device.engine.getSnapshot().phase, 'error');
  }
});

test('snapshot identity never exposes the access token of a supplied session object', async () => {
  const device = fixture();
  const session = { ...accountA, accessToken: 'private-test-token' };
  device.setSession(session);
  device.engine.select(session);
  await device.engine.sync();

  assert.deepEqual(device.engine.getSnapshot().identity, accountA);
});

test('logging out aborts a download and ignores its late bytes', async () => {
  const online = service();
  await online(accountA).upload(document('old-download'), pdfBytes);
  const entered = deferred();
  const finish = deferred();
  let signal: AbortSignal | undefined;
  const device = fixture((identity, requestSignal) => {
    signal = requestSignal;
    const remote = online(identity);
    return {
      ...remote,
      async download(row) {
        entered.release();
        await finish.promise;
        return remote.download(row);
      },
    };
  });
  device.select(accountA);
  const pending = device.engine.sync();
  await entered.promise;
  device.select(null);
  const signedOut = device.engine.getSnapshot();
  finish.release();
  await pending;

  assert.equal(signal?.aborted, true);
  assert.deepEqual(await device.cacheA.getAllDocuments(), []);
  assert.strictEqual(device.engine.getSnapshot(), signedOut);
  assert.equal(signedOut.phase, 'guest');
});

test('switching A to B and back to A ignores data and status from the first A selection', async () => {
  const online = service();
  const oldRow = await online(accountA).upload(document('stale-result'), pdfBytes);
  const entered = deferred();
  const finish = deferred();
  let aConnections = 0;
  const device = fixture(identity => {
    const remote = online(identity);
    if (identity.uid !== accountA.uid) return remote;
    if (++aConnections === 1) {
      return {
        ...remote,
        async list() {
          entered.release();
          await finish.promise;
          return [oldRow];
        },
      };
    }
    return { ...remote, list: async () => [] };
  });
  device.select(accountA);
  const old = device.engine.sync();
  await entered.promise;
  const firstEpoch = device.engine.getSnapshot().epoch;
  device.select(accountB);
  await device.engine.sync();
  device.select(accountA);
  await device.engine.sync();
  const current = device.engine.getSnapshot();
  finish.release();
  await old;

  assert.ok(current.epoch > firstEpoch);
  assert.strictEqual(device.engine.getSnapshot(), current);
  assert.deepEqual(await device.cacheA.getAllDocuments(), []);
  assert.deepEqual(await device.cacheB.getAllDocuments(), []);
});

test('existing device files copy only by explicit request and repeated copy stays idempotent', async () => {
  const online = service();
  const device = fixture(online);
  const guest = document('guest-document');
  device.legacy.set(guest, pdfBytes);
  device.select(accountA);
  await device.engine.sync();
  assert.deepEqual(await online(accountA).list(), []);

  await device.engine.copyLegacy();
  await device.engine.copyLegacy();

  const documents = await device.cacheA.getAllDocuments();
  assert.equal(documents.length, 1);
  assert.notEqual(documents[0].id, guest.id);
  assert.deepEqual(await device.cacheA.readBytes(documents[0]), pdfBytes);
  assert.equal((await online(accountA).list()).length, 1);
  assert.deepEqual(Array.from(device.legacy.entries()), [[guest, pdfBytes]]);
});

test('switching accounts during device copy prevents a stale copy or upload', async () => {
  const online = service();
  const device = fixture(online);
  const guest = document('guest-during-switch');
  device.legacy.set(guest, pdfBytes);
  const entered = deferred();
  const finish = deferred();
  device.interceptLegacyRead(async () => {
    entered.release();
    await finish.promise;
    return pdfBytes;
  });
  device.select(accountA);
  await device.engine.sync();
  const copy = device.engine.copyLegacy();
  const canceled = assert.rejects(copy);
  await entered.promise;
  device.select(accountB);
  await device.engine.sync();
  finish.release();
  await canceled;

  assert.deepEqual(await device.cacheA.getAllDocuments(), []);
  assert.deepEqual(await online(accountB).list(), []);
  assert.equal(device.engine.getSnapshot().identity?.uid, accountB.uid);
  assert.equal(device.engine.getSnapshot().phase, 'ready');
});

test('a locally hidden document is not re-downloaded from its retained cloud copy', async () => {
  const online = service();
  const device = fixture(identity => ({
    ...online(identity),
    async download() { throw new Error('The hidden document must not be downloaded.'); },
  }));
  const local = document('hide-locally');
  device.cacheA.import(local, pdfBytes);
  device.select(accountA);
  await device.engine.sync();
  await device.cacheA.deleteDocument(local.id);

  await device.engine.sync();

  assert.equal(device.engine.getSnapshot().phase, 'ready');
  assert.deepEqual(await device.cacheA.getAllDocuments(), []);
  assert.deepEqual((await online(accountA).list()).map(row => row.id), ['hide-locally']);
});

test('a later sync restores missing local bytes for an already synced visible document', async () => {
  const device = fixture();
  const local = document('lost-local-bytes');
  device.cacheA.import(local, pdfBytes);
  device.select(accountA);
  await device.engine.sync();
  device.cacheA.loseBytes(local.id);

  await device.engine.sync();

  assert.deepEqual(await device.cacheA.readBytes(local), pdfBytes);
});

test('sync requests during an upload coalesce into a follow-up pass that includes new imports', async () => {
  const online = service();
  const entered = deferred();
  const finish = deferred();
  let passes = 0;
  const device = fixture(identity => {
    passes++;
    const remote = online(identity);
    return {
      ...remote,
      async upload(doc, bytes) {
        if (doc.id === 'first') {
          entered.release();
          await finish.promise;
        }
        return remote.upload(doc, bytes);
      },
    };
  });
  device.cacheA.import(document('first'), pdfBytes);
  device.select(accountA);
  const first = device.engine.sync();
  await entered.promise;
  device.cacheA.import(document('new-while-uploading'), pdfBytes);
  const requested = [device.engine.sync(), device.engine.sync()];
  finish.release();
  await Promise.all([first, ...requested]);

  assert.equal(passes, 2);
  assert.deepEqual((await online(accountA).list()).map(row => row.id), ['first', 'new-while-uploading']);
  assert.equal(device.engine.getSnapshot().pending, 0);
});
