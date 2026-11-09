import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { BookmarkRepository, type BookmarkStoragePort } from '../src/core/services/bookmarks/repository';
import type { BookmarkInput } from '../src/core/services/bookmarks/types';
import { createBookmarkFilePort, type BookmarkFile } from '../src/core/services/bookmarks/file_port';

const date = () => new Date('2026-10-27T03:00:00.000Z');
const article: BookmarkInput = { url: 'https://en.wikipedia.org/wiki/Iteration', title: 'Iteration',
  providerId: 'wikipedia', providerName: 'Wikipedia', type: 'Article', description: 'A repeated process.', topic: 'C++ iteration',
  attribution: { author: 'Wikipedia contributors', licenseName: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://en.wikipedia.org/wiki/Iteration', revisionUrl: 'https://en.wikipedia.org/w/index.php?oldid=123' } };
function memory(initial: string | null = null) {
  let persisted = initial; let writes = 0; let failure = false;
  const port: BookmarkStoragePort = { async readMetadata() { return persisted; }, async writeMetadata(json) {
    if (failure) throw new Error('Disk full: PRIVATE STORAGE PATH'); persisted = json; writes++;
  } };
  return { port, read: () => persisted, writes: () => writes, fail: (value: boolean) => { failure = value; } };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('bookmark metadata survives restart and removal without persisting original passage or document association', async () => {
  const disk = memory(); const repository = new BookmarkRepository(disk.port, date);
  const saved = await repository.save({ ...article, documentId: 'private-document', page: 9, originalText: 'PRIVATE PASSAGE' } as BookmarkInput);
  assert.equal(saved.savedAt, '2026-10-27T03:00:00.000Z'); assert.ok(saved.id);
  const envelope = JSON.parse(disk.read()!); assert.equal(envelope.version, 1); assert.equal(envelope.bookmarks.length, 1);
  assert.doesNotMatch(disk.read()!, /private-document|PRIVATE PASSAGE|documentId|originalText|"page"/);
  const restarted = new BookmarkRepository(disk.port, date); await restarted.initialize();
  assert.deepEqual(restarted.getSnapshot().bookmarks, [saved]);
  await restarted.remove(article.url); const empty = new BookmarkRepository(disk.port); await empty.initialize();
  assert.deepEqual(empty.getSnapshot().bookmarks, []);
});
test('first initialization is serialized with queued saves and removal without a lost update', async () => {
  const disk = memory(); const read = deferred<string | null>(); let reads = 0;
  const repository = new BookmarkRepository({ ...disk.port, readMetadata() { reads++; return read.promise; } }, date);
  const initialization = repository.initialize();
  const saved = repository.save(article); const second = repository.save({ ...article, url: 'https://docs.python.org/3/tutorial/' });
  const removed = repository.remove(article.url); await Promise.resolve();
  assert.equal(repository.getSnapshot().status, 'loading'); assert.equal(disk.writes(), 0);
  read.resolve(null); await Promise.all([initialization, saved, second, removed]);
  assert.equal(reads, 1); assert.equal(repository.getSnapshot().bookmarks.length, 1);
  assert.equal(repository.getSnapshot().bookmarks[0].url, 'https://docs.python.org/3/tutorial/');
  assert.equal(JSON.parse(disk.read()!).bookmarks.length, 1);
});
test('save waits for durable storage before notifying subscribers or changing bookmark snapshots', async () => {
  const disk = memory(); const barrier = deferred<void>(); const write = disk.port.writeMetadata;
  const repository = new BookmarkRepository({ ...disk.port, async writeMetadata(json) { await barrier.promise; await write(json); } }, date);
  await repository.initialize(); const before = repository.getSnapshot(); const observed: number[] = [];
  const unsubscribe = repository.subscribe(() => observed.push(repository.getSnapshot().bookmarks.length));
  const saving = repository.save(article); await new Promise(resolve => setImmediate(resolve));
  assert.equal(repository.getSnapshot(), before); assert.equal(disk.read(), null); assert.deepEqual(observed, []);
  barrier.resolve(); await saving; assert.deepEqual(observed, [1]); assert.equal(JSON.parse(disk.read()!).bookmarks.length, 1);
  unsubscribe(); await repository.remove(article.url); assert.deepEqual(observed, [1]);
});
test('failed save and remove reject, retain durable records, and permit a later retry', async () => {
  const disk = memory(); const repository = new BookmarkRepository(disk.port, date); const saved = await repository.save(article);
  const original = disk.read(); disk.fail(true);
  await assert.rejects(repository.save({ ...article, url: 'https://docs.python.org/3/' }), /save|saved|storage/i);
  assert.deepEqual(repository.getSnapshot().bookmarks, [saved]); assert.equal(repository.getSnapshot().status, 'error');
  assert.doesNotMatch(repository.getSnapshot().error!, /PRIVATE STORAGE PATH/);
  await assert.rejects(repository.remove(article.url), /remove|saved|storage/i);
  assert.deepEqual(repository.getSnapshot().bookmarks, [saved]); assert.equal(disk.read(), original);
  const restarted = new BookmarkRepository(disk.port); await restarted.initialize(); assert.deepEqual(restarted.getSnapshot().bookmarks, [saved]);
  disk.fail(false); await repository.remove(article.url); assert.deepEqual(repository.getSnapshot().bookmarks, []);
  assert.equal(repository.getSnapshot().status, 'ready'); assert.equal(repository.getSnapshot().error, undefined);
});
test('failed initialization preserves corrupt metadata and can be retried after repair', async () => {
  const disk = memory('{bad'); const repository = new BookmarkRepository(disk.port);
  await assert.rejects(repository.initialize(), /metadata|read/i); assert.equal(repository.getSnapshot().status, 'error');
  await assert.rejects(repository.save(article), /metadata|read/i); assert.equal(disk.read(), '{bad'); assert.equal(disk.writes(), 0);
  await disk.port.writeMetadata('{"version":1,"bookmarks":[]}'); await repository.initialize();
  assert.equal(repository.getSnapshot().status, 'ready'); await repository.save(article); assert.equal(repository.getSnapshot().bookmarks.length, 1);
});
test('transient read failure has an explicit recoverable state and no write', async () => {
  const disk = memory(); let failing = true;
  const repository = new BookmarkRepository({ ...disk.port, async readMetadata() { if (failing) throw Error('permission denied'); return null; } });
  await assert.rejects(repository.initialize()); assert.equal(repository.getSnapshot().status, 'error'); assert.equal(disk.writes(), 0);
  failing = false; await repository.initialize(); assert.equal(repository.getSnapshot().status, 'ready');
});
test('canonical duplicate saves retain one stable ID/date and preserve distinct fragment/query identities', async () => {
  const disk = memory(); const repository = new BookmarkRepository(disk.port, date);
  const first = await repository.save({ ...article, url: 'https://EN.WIKIPEDIA.ORG:443/wiki/Iteration?b=2&a=1#Part' });
  const again = await repository.save({ ...article, url: 'https://en.wikipedia.org/wiki/Iteration?b=2&a=1#Part', title: 'Different' });
  assert.equal(again, first); assert.equal(disk.writes(), 1);
  await Promise.all(['https://en.wikipedia.org/wiki/Iteration?a=1&b=2#Part', 'https://en.wikipedia.org/wiki/Iteration?b=2&a=1#Other',
    'https://en.wikipedia.org/wiki/iteration?b=2&a=1#Part'].map(url => repository.save({ ...article, url })));
  assert.equal(repository.getSnapshot().bookmarks.length, 4); assert.equal(new Set(repository.getSnapshot().bookmarks.map(value => value.id)).size, 4);
  await repository.remove('https://EN.WIKIPEDIA.ORG:443/wiki/Iteration?b=2&a=1#Part'); assert.equal(repository.getSnapshot().bookmarks.length, 3);
});
test('subscriber methods are bound, snapshots stable, nested metadata immutable, and input captured before queued work', async () => {
  const disk = memory(); const gate = deferred<string | null>();
  const repository = new BookmarkRepository({ ...disk.port, readMetadata: () => gate.promise }, date);
  const { getSnapshot, subscribe } = repository; assert.equal(getSnapshot(), getSnapshot()); let notifications = 0;
  subscribe(() => { notifications++; }); subscribe(() => { throw new Error('consumer failed'); });
  const input = { ...article, attribution: { ...article.attribution! } }; const saving = repository.save(input);
  input.title = 'CHANGED'; input.attribution.author = 'CHANGED'; gate.resolve(null); const saved = await saving;
  assert.equal(saved.title, 'Iteration'); assert.equal(saved.attribution?.author, 'Wikipedia contributors');
  assert.ok(Object.isFrozen(getSnapshot())); assert.ok(Object.isFrozen(getSnapshot().bookmarks)); assert.ok(Object.isFrozen(saved));
  assert.ok(Object.isFrozen(saved.attribution)); assert.ok(notifications >= 2);
  assert.throws(() => { (saved as { title: string }).title = 'mutable'; }, TypeError);
  assert.equal(JSON.parse(disk.read()!).bookmarks[0].title, 'Iteration');
});
for (const [name, patch] of [
  ['unsafe URL', { url: 'javascript:alert(1)' }], ['private address', { url: 'https://127.0.0.1/file' }],
  ['empty title', { title: '  ' }], ['overlong title', { title: 'x'.repeat(301) }], ['wrong type', { type: 'Video' }],
  ['overlong topic', { topic: '😀'.repeat(141) }], ['overlong excerpt', { description: 'x'.repeat(2001) }],
  ['unsafe attribution', { attribution: { ...article.attribution!, licenseUrl: 'file:///private' } }],
] as const) test(`invalid bookmark ${name} is rejected without a durable mutation`, async () => {
  const disk = memory(); const repository = new BookmarkRepository(disk.port);
  await assert.rejects(repository.save({ ...article, ...patch } as BookmarkInput)); assert.equal(disk.writes(), 0); assert.deepEqual(repository.getSnapshot().bookmarks, []);
});
test('Unicode topic limits count codepoints and valid public unknown hosts can be bookmarked without a recognition claim', async () => {
  const disk = memory(); const repository = new BookmarkRepository(disk.port, date);
  const saved = await repository.save({ ...article, url: 'https://public-resource.example/path', topic: '😀'.repeat(140) });
  assert.equal([...saved.topic!].length, 140); assert.equal(saved.url, 'https://public-resource.example/path');
});
test('invalid removal rejects without removing unrelated records and missing valid URLs are idempotent', async () => {
  const disk = memory(); const repository = new BookmarkRepository(disk.port); const saved = await repository.save(article);
  await assert.rejects(repository.remove('file:///private')); await repository.remove('https://docs.python.org/3/');
  assert.deepEqual(repository.getSnapshot().bookmarks, [saved]); assert.equal(disk.writes(), 1);
});
test('unsupported envelope, invalid date, duplicate canonical URLs/IDs, and leaked association fields are preserved as corruption', async () => {
  const disk = memory(); const repository = new BookmarkRepository(disk.port, date); const saved = await repository.save(article);
  for (const value of [[], { version: 2, bookmarks: [] }, { version: 1, bookmarks: [{ ...saved, savedAt: 'yesterday' }] },
    { version: 1, bookmarks: [{ ...saved, id: 'a' }, { ...saved, id: 'b', url: 'https://EN.WIKIPEDIA.ORG/wiki/Iteration' }] },
    { version: 1, bookmarks: [saved, { ...saved, url: 'https://docs.python.org/3/' }] },
    { version: 1, bookmarks: [{ ...saved, originalText: 'private passage' }] }]) {
    const corrupt = JSON.stringify(value); const bad = memory(corrupt); const restarted = new BookmarkRepository(bad.port);
    await assert.rejects(restarted.initialize(), /metadata/i); assert.equal(bad.read(), corrupt); assert.equal(bad.writes(), 0);
  }
});
test('metadata and record-count limits reject oversized persisted libraries without resetting them', async () => {
  const disk = memory(); const repository = new BookmarkRepository(disk.port, date); const saved = await repository.save(article);
  for (const corrupt of [' '.repeat(4 * 1024 * 1024 + 1), JSON.stringify({ version: 1, bookmarks: Array.from({ length: 501 }, (_, i) =>
    ({ ...saved, id: 'id-' + i, url: `https://en.wikipedia.org/wiki/Topic_${i}` })) })]) {
    const bad = memory(corrupt); await assert.rejects(new BookmarkRepository(bad.port).initialize(), /metadata/i);
    assert.equal(bad.read(), corrupt); assert.equal(bad.writes(), 0);
  }
});
test('a full library rejects a new record but still permits deduplication and removal', async () => {
  const seed = memory(); const source = new BookmarkRepository(seed.port, date); const saved = await source.save(article);
  const initial = JSON.stringify({ version: 1, bookmarks: Array.from({ length: 500 }, (_, i) =>
    ({ ...saved, id: 'id-' + i, url: `https://en.wikipedia.org/wiki/Topic_${i}` })) });
  const disk = memory(initial); const repository = new BookmarkRepository(disk.port, date);
  await assert.rejects(repository.save(article), /full|limit/i); assert.equal(disk.read(), initial); assert.equal(disk.writes(), 0);
  assert.equal(repository.getSnapshot().bookmarks.length, 500);
  await repository.save({ ...article, url: 'https://en.wikipedia.org/wiki/Topic_1' }); assert.equal(disk.writes(), 0);
  await repository.remove('https://en.wikipedia.org/wiki/Topic_1'); await repository.save(article);
  assert.equal(repository.getSnapshot().bookmarks.length, 500); assert.equal(disk.writes(), 2);
});
test('a clock outside the supported ISO year range cannot commit metadata that fails on restart', async () => {
  const disk = memory(); const repository = new BookmarkRepository(disk.port, () => new Date('+010000-01-01T00:00:00.000Z'));
  await assert.rejects(repository.save(article), /date/i);
  assert.equal(disk.writes(), 0); assert.deepEqual(repository.getSnapshot().bookmarks, []);
});

const roots: string[] = [];
after(async () => { for (const root of roots) {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('topictrail-bookmarks-'));
  await rm(root, { recursive: true, force: true });
} });
async function files() {
  const root = await mkdtemp(join(tmpdir(), 'topictrail-bookmarks-')); roots.push(root);
  let fail: 'write' | 'copy' | 'move' | 'move-after-delete' | undefined; let texts = 0;
  class DiskFile implements BookmarkFile<DiskFile> {
    constructor(public path: string) {}
    get exists() { return existsSync(this.path); }
    get size() { return this.exists ? statSync(this.path).size : null; }
    async text() { texts++; return readFile(this.path, 'utf8'); }
    async write(json: string) { if (fail === 'write') throw Error('disk write failed'); await writeFile(this.path, json); }
    async copy(destination: DiskFile, options: { overwrite: boolean }) {
      assert.equal(options.overwrite, true); if (fail === 'copy') throw Error('backup copy failed'); await copyFile(this.path, destination.path);
    }
    async move(destination: DiskFile, options: { overwrite: boolean }) {
      assert.equal(options.overwrite, true); if (fail === 'move') throw Error('staged replacement failed');
      if (fail === 'move-after-delete') { await rm(destination.path); throw Error('replacement failed after removing main'); }
      await rename(this.path, destination.path); this.path = destination.path;
    }
  }
  const path = (name: string) => join(root, name);
  const port = createBookmarkFilePort(() => ({ main: new DiskFile(path('bookmarks.json')), pending: new DiskFile(path('bookmarks.pending.json')),
    backup: new DiskFile(path('bookmarks.backup.json')) }));
  return { port, path, fail: (value?: typeof fail) => { fail = value; }, texts: () => texts };
}
test('staged file replacement preserves the preceding committed backup and loads it only when main is absent', async () => {
  const f = await files(); const repository = new BookmarkRepository(f.port, date); const first = await repository.save(article);
  await repository.save({ ...article, url: 'https://docs.python.org/3/' });
  assert.equal(JSON.parse(await readFile(f.path('bookmarks.json'), 'utf8')).bookmarks.length, 2);
  assert.deepEqual(JSON.parse(await readFile(f.path('bookmarks.backup.json'), 'utf8')).bookmarks, [first]);
  await rm(f.path('bookmarks.json')); const restarted = new BookmarkRepository(f.port); await restarted.initialize();
  assert.deepEqual(restarted.getSnapshot().bookmarks, [first]);
  await restarted.save({ ...article, url: 'https://docs.python.org/3/new' });
  assert.equal(restarted.getSnapshot().bookmarks.length, 2); assert.deepEqual(JSON.parse(await readFile(f.path('bookmarks.backup.json'), 'utf8')).bookmarks, [first]);
});
for (const phase of ['write', 'copy', 'move'] as const) test(`failed ${phase} keeps prior committed file/state and retry survives restart`, async () => {
  const f = await files(); const repository = new BookmarkRepository(f.port, date); const first = await repository.save(article);
  f.fail(phase); await assert.rejects(repository.save({ ...article, url: 'https://docs.python.org/3/' }));
  assert.deepEqual(repository.getSnapshot().bookmarks, [first]); const restarted = new BookmarkRepository(f.port); await restarted.initialize();
  assert.deepEqual(restarted.getSnapshot().bookmarks, [first]); f.fail(); await repository.save({ ...article, url: 'https://docs.python.org/3/' });
  const final = new BookmarkRepository(f.port); await final.initialize(); assert.equal(final.getSnapshot().bookmarks.length, 2);
});
test('corrupt main is preserved even with valid backup; uncommitted pending data is not recovered as saved', async () => {
  const f = await files(); await writeFile(f.path('bookmarks.json'), '{bad');
  await writeFile(f.path('bookmarks.backup.json'), '{"version":1,"bookmarks":[]}');
  await assert.rejects(new BookmarkRepository(f.port).initialize(), /metadata/i);
  assert.equal(await readFile(f.path('bookmarks.json'), 'utf8'), '{bad');
  await rm(f.path('bookmarks.json')); await rm(f.path('bookmarks.backup.json'));
  await writeFile(f.path('bookmarks.pending.json'), '{bad uncommitted');
  const restarted = new BookmarkRepository(f.port); await restarted.initialize(); assert.deepEqual(restarted.getSnapshot().bookmarks, []);
  assert.equal(await readFile(f.path('bookmarks.pending.json'), 'utf8'), '{bad uncommitted');
});
test('file adapter rejects oversized files before reading their text', async () => {
  const f = await files(); await writeFile(f.path('bookmarks.json'), 'x'.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(new BookmarkRepository(f.port).initialize(), /metadata|read/i); assert.equal(f.texts(), 0);
});
test('interrupted replacement after main deletion recovers the last committed backup and can retry', async () => {
  const f = await files(); const repository = new BookmarkRepository(f.port, date); const first = await repository.save(article);
  f.fail('move-after-delete'); await assert.rejects(repository.save({ ...article, url: 'https://docs.python.org/3/' }));
  assert.deepEqual(repository.getSnapshot().bookmarks, [first]); assert.equal(existsSync(f.path('bookmarks.json')), false);
  const restarted = new BookmarkRepository(f.port, date); await restarted.initialize(); assert.deepEqual(restarted.getSnapshot().bookmarks, [first]);
  f.fail(); await restarted.save({ ...article, url: 'https://docs.python.org/3/' });
  const final = new BookmarkRepository(f.port); await final.initialize(); assert.equal(final.getSnapshot().bookmarks.length, 2);
});
test('a failed first staged replacement never promotes its pending record on restart', async () => {
  const f = await files(); f.fail('move'); const repository = new BookmarkRepository(f.port, date);
  await assert.rejects(repository.save(article));
  assert.equal(JSON.parse(await readFile(f.path('bookmarks.pending.json'), 'utf8')).bookmarks.length, 1);
  const restarted = new BookmarkRepository(f.port); await restarted.initialize(); assert.deepEqual(restarted.getSnapshot().bookmarks, []);
});
