import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { OcrCacheStore, type OcrCacheIO, type OcrCacheResult, type OcrEngine } from '../src/core/services/ocr_cache';

const hash = 'a'.repeat(64);
const engine = 'tesseract-7-eng-fil-1';
const legacyEngine = 'tesseract-7-eng-1';
const readable: OcrCacheResult = { text: '  Piña — exact\r\ntranscript.  ', confidence: 91, truncated: false };
const different: OcrCacheResult = { text: 'A different transcript.', confidence: null, truncated: false };
const blank: OcrCacheResult = { text: ' \r\n ', confidence: 0, truncated: false };
function key(version: OcrEngine, page = 1) {
  return `topictrail.ocr.v1/${version}/${version === legacyEngine ? 'eng' : 'eng+fil'}/guest/${hash}/${page}`;
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function memory() {
  const records = new Map<string, string>();
  const reads: string[] = [], writes: string[] = [];
  const io: OcrCacheIO = {
    async getItem(name) { reads.push(name); return records.get(name) ?? null; },
    async setItem(name, value) { writes.push(name); records.set(name, value); },
  };
  return { records, reads, writes, io };
}

test('parallel current writers and recreated stores return the first readable canonical transcript', async () => {
  const f = memory();
  const first = new OcrCacheStore(f.io, engine);
  // Distinct IO objects must not create distinct in-process lock domains.
  const other = new OcrCacheStore({ ...f.io }, engine);
  const results = await Promise.all([
    first.save('guest', hash, 1, readable), other.save('guest', hash, 1, different),
  ]);
  assert.deepEqual(results, [readable, readable]);
  assert.equal(f.writes.length, 1);
  const reopened = new OcrCacheStore({ ...f.io }, engine);
  assert.deepEqual(await reopened.read('guest', hash, 1), readable);
  assert.deepEqual(await reopened.save('guest', hash, 1, different), readable);
  assert.equal(f.writes.length, 1);
});

test('nonblank beats blank in either concurrent ordering without replacing readable text', async () => {
  for (const values of [[readable, blank], [blank, readable]] as const) {
    const f = memory();
    const stores = [new OcrCacheStore(f.io, engine), new OcrCacheStore({ ...f.io }, engine)];
    const saved = await Promise.all(values.map((value, i) => stores[i].save('guest', hash, 1, value)));
    assert.deepEqual(saved[0], values[0]);
    assert.deepEqual(saved[1], readable);
    assert.deepEqual(await stores[0].read('guest', hash, 1), readable);
    assert.equal(f.writes.length, values[0] === blank ? 2 : 1);
  }
});

test('readEntry marks only current-engine blanks retryable and keeps read compatible', async () => {
  for (const version of [legacyEngine, engine, 'mlkit-16.0.1-latin-1'] as const) {
    for (const value of [blank, { ...blank, text: '' }, readable]) {
      const f = memory();
      const raw = JSON.stringify({ key: key(version), result: value });
      f.records.set(key(version), raw);
      const cache = new OcrCacheStore(f.io, version);
      assert.deepEqual(await cache.readEntry('guest', hash, 1), {
        result: value, retryable: version !== legacyEngine && !value.text.trim(),
      });
      assert.deepEqual(await cache.read('guest', hash, 1), value);
      assert.deepEqual(await cache.readEntry('guest', hash, 2), null);
      assert.equal(f.records.get(key(version)), raw);
      assert.equal(f.writes.length, 0);
    }
  }
});

test('legacy fallback returns exact canonical bytes and is never retryable, including blanks', async () => {
  for (const value of [readable, blank, { ...blank, text: '' }]) {
    for (const version of [engine, 'mlkit-16.0.1-latin-1'] as const) {
      const f = memory();
      const raw = JSON.stringify({ key: key(legacyEngine), result: value });
      f.records.set(key(legacyEngine), raw);
      const cache = new OcrCacheStore(f.io, version);
      assert.deepEqual(await cache.readEntry('guest', hash, 1), { result: value, retryable: false });
      assert.deepEqual(await cache.save('guest', hash, 1, different), value);
      assert.deepEqual([...f.records], [[key(legacyEngine), raw]]);
      assert.equal(f.writes.length, 0);
    }
  }
});

test('legacy and both current engines serialize in one owner/document/page lock domain', { timeout: 5000 }, async () => {
  const f = memory(), writing = deferred(), release = deferred();
  const names: string[] = [];
  const io: OcrCacheIO = {
    ...f.io,
    async withLock(name, work) { names.push(name); return work(); },
    async setItem(name, value) { writing.resolve(); await release.promise; await f.io.setItem(name, value); },
  };
  const old = new OcrCacheStore(io, legacyEngine).save('guest', hash, 1, readable);
  await writing.promise;
  const web = new OcrCacheStore({ ...io }, engine).save('guest', hash, 1, different);
  const native = new OcrCacheStore({ ...io }, 'mlkit-16.0.1-latin-1').save('guest', hash, 1, blank);
  release.resolve();
  assert.deepEqual(await Promise.all([old, web, native]), [readable, readable, readable]);
  assert.equal(f.writes.length, 1);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 1, 'engine/language must not split the lock name');
});

test('an unrelated page progresses while another key waits for durable IO', { timeout: 5000 }, async () => {
  const f = memory(), writing = deferred(), release = deferred();
  const io: OcrCacheIO = { ...f.io, async setItem(name, value) {
    if (name.endsWith('/1')) { writing.resolve(); await release.promise; }
    await f.io.setItem(name, value);
  } };
  const first = new OcrCacheStore(io, engine).save('guest', hash, 1, readable);
  await writing.promise;
  try { assert.deepEqual(await new OcrCacheStore(io, engine).save('guest', hash, 2, different), different); }
  finally { release.resolve(); await first; }
});

test('already-stale and locally queued stale saves return null without acquiring IO locks or reading', { timeout: 5000 }, async () => {
  const f = memory(), writing = deferred(), release = deferred();
  let locks = 0;
  const io: OcrCacheIO = { ...f.io,
    async withLock(_name, work) { locks++; return work(); },
    async setItem(name, value) { writing.resolve(); await release.promise; await f.io.setItem(name, value); },
  };
  const cache = new OcrCacheStore(io, engine);
  assert.equal(await cache.save('guest', hash, 1, different, () => false), null);
  assert.equal(locks, 0); assert.equal(f.reads.length, 0);
  const first = cache.save('guest', hash, 1, readable);
  await writing.promise;
  let current = true;
  const queued = new OcrCacheStore({ ...io }, engine).save('guest', hash, 1, different, () => current);
  current = false; release.resolve();
  assert.deepEqual(await first, readable);
  assert.equal(await queued, null);
  assert.equal(locks, 1); assert.equal(f.reads.length, 2); assert.equal(f.writes.length, 1);
});

test('epoch loss while waiting for a cross-context lock prevents the callback from accessing storage', { timeout: 5000 }, async () => {
  const f = memory(), requested = deferred(), release = deferred();
  let current = true;
  const cache = new OcrCacheStore({ ...f.io, async withLock(_name, work) {
    requested.resolve(); await release.promise; return work();
  } }, engine);
  const saving = cache.save('guest', hash, 1, readable, () => current);
  await requested.promise; current = false; release.resolve();
  assert.equal(await saving, null);
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});

test('each asynchronous read rechecks the current fence before returning a winner or writing', async () => {
  for (const loseAt of [1, 2]) {
    let current = true, reads = 0, writes = 0;
    const cache = new OcrCacheStore({
      async getItem() { if (++reads === loseAt) current = false; return null; },
      async setItem() { writes++; },
    }, engine);
    assert.equal(await cache.save('guest', hash, 1, readable, () => current), null);
    assert.equal(reads, loseAt); assert.equal(writes, 0);
  }
});

test('epoch loss after a write or before lock release returns null and preserves committed bytes', async () => {
  for (const loseAt of ['write', 'release']) {
    const f = memory(); let current = true;
    const cache = new OcrCacheStore({ ...f.io,
      async setItem(name, value) { await f.io.setItem(name, value); if (loseAt === 'write') current = false; },
      async withLock(_name, work) { const result = await work(); if (loseAt === 'release') current = false; return result; },
    }, engine);
    assert.equal(await cache.save('guest', hash, 1, readable, () => current), null);
    assert.deepEqual(await new OcrCacheStore(f.io, engine).read('guest', hash, 1), readable);
    assert.equal(f.writes.length, 1);
  }
});

test('uncertain committed-write failure rejects without poisoning queued writers or replacing recovery data', async () => {
  const f = memory(), failure = new Error('Write acknowledgement lost'); let first = true;
  const io: OcrCacheIO = { ...f.io, async setItem(name, value) {
    await f.io.setItem(name, value);
    if (first) { first = false; throw failure; }
  } };
  const results = await Promise.allSettled([
    new OcrCacheStore(io, engine).save('guest', hash, 1, readable),
    new OcrCacheStore({ ...io }, engine).save('guest', hash, 1, different),
  ]);
  assert.deepEqual(results, [{ status: 'rejected', reason: failure }, { status: 'fulfilled', value: readable }]);
  assert.equal(f.writes.length, 1);
});

// Platform IO is represented by a synthetic Web Locks broker. No real browser or
// user storage is opened. Fresh evaluations give each client its own process queue.
const compiled = new Map<string, Promise<string>>();
async function loadPlatform(io: OcrCacheIO, navigator: unknown, web = true, store = false) {
  const id = `${web}:${store}`;
  let code = compiled.get(id);
  if (!code) {
    code = build({ stdin: { contents: store
      ? `import {OcrCacheStore} from './src/core/services/ocr_cache';import {ocrCacheStorage} from './src/core/services/ocr_cache_storage.web';export const cache=new OcrCacheStore(ocrCacheStorage,'${engine}');`
      : `export {ocrCacheStorage} from './src/core/services/ocr_cache_storage${web ? '.web' : ''}';`,
    resolveDir: process.cwd(), loader: 'ts' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false })
      .then(result => result.outputFiles[0].text);
    compiled.set(id, code);
  }
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'navigator', await code)((name: string) => {
    assert.equal(name, '@react-native-async-storage/async-storage'); return io;
  }, module, module.exports, navigator);
  return module.exports as { ocrCacheStorage: OcrCacheIO; cache: OcrCacheStore };
}
function lockBroker() {
  const pending = new Map<string, Promise<unknown>>();
  const requests: { name: string; mode: string | undefined }[] = [];
  return { requests, locks: {
    request<T>(name: string, options: { mode?: string }, work: (lock: { name: string; mode: string }) => Promise<T>) {
      requests.push({ name, mode: options.mode });
      assert.equal(options.mode, 'exclusive');
      const result = (pending.get(name) ?? Promise.resolve()).catch(() => undefined)
        .then(() => work({ name, mode: 'exclusive' }));
      pending.set(name, result.then(() => undefined, () => undefined));
      return result;
    },
  } };
}

test('web clients with independent process queues use one exclusive Web Lock and return the same winner', async () => {
  const f = memory(), broker = lockBroker();
  const first = (await loadPlatform(f.io, { locks: broker.locks }, true, true)).cache;
  const second = (await loadPlatform({ ...f.io }, { locks: broker.locks }, true, true)).cache;
  assert.deepEqual(await Promise.all([
    first.save('guest', hash, 1, readable), second.save('guest', hash, 1, different),
  ]), [readable, readable]);
  assert.equal(f.writes.length, 1);
  assert.equal(broker.requests.length, 2);
  assert.equal(broker.requests[0].name, broker.requests[1].name);
  assert.deepEqual(broker.requests.map(request => request.mode), ['exclusive', 'exclusive']);
});

test('web without safe Web Locks rejects saving before storage IO while reads still work', async () => {
  for (const navigator of [undefined, {}, { locks: {} }, { locks: { request: undefined } }]) {
    const f = memory();
    f.records.set(key(engine), JSON.stringify({ key: key(engine), result: readable }));
    const { ocrCacheStorage } = await loadPlatform(f.io, navigator);
    const cache = new OcrCacheStore(ocrCacheStorage, engine);
    await assert.rejects(cache.save('guest', hash, 1, different), /lock|safely/i);
    assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
    assert.deepEqual(await cache.read('guest', hash, 1), readable);
  }
});

test('web lock denial or an unacquired lock never falls back to unsafe writes', async () => {
  const denied = new Error('Lock request denied');
  for (const locks of [
    { request: async () => { throw denied; } },
    { request: async (_key: string, _options: unknown, work: (lock: null) => Promise<unknown>) => work(null) },
  ]) {
    const f = memory(); const { ocrCacheStorage } = await loadPlatform(f.io, { locks });
    await assert.rejects(new OcrCacheStore(ocrCacheStorage, engine).save('guest', hash, 1, readable), /denied|lock|safely/i);
    assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
  }
});

test('native storage uses AsyncStorage and the store queue without requiring browser globals', async () => {
  const f = memory(); const { ocrCacheStorage } = await loadPlatform(f.io, undefined, false);
  assert.equal(ocrCacheStorage.withLock, undefined);
  const cache = new OcrCacheStore(ocrCacheStorage, 'mlkit-16.0.1-latin-1');
  assert.deepEqual(await cache.save('guest', hash, 1, different), different);
  assert.deepEqual(await cache.read('guest', hash, 1), different);
  assert.equal(f.writes.length, 1);
});
