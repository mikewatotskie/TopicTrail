import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OcrCacheStore, type OcrCacheIO, type OcrCacheScope } from '../src/core/services/ocr_cache';

const accountA = { project: 'abcdefghijklmnopqrst', uid: 'a0a0a0a0-0000-0000-0000-000000000001' };
const accountB = { ...accountA, uid: 'a0a0a0a0-0000-0000-0000-000000000002' };
const otherProject = { ...accountA, project: 'abcdefghijklmnopqrs1' };
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const result = { text: 'Recognized fixture line.', confidence: 94.5, truncated: false };

function fixture() {
  const stored = new Map<string, string>();
  const io: OcrCacheIO = {
    async getItem(key) { return stored.get(key) ?? null; },
    async setItem(key, value) { stored.set(key, value); },
  };
  return { stored, io, cache: new OcrCacheStore(io) };
}

test('OCR results survive recreating the store and remain isolated by owner, project, hash and page', async () => {
  const { io, cache, stored } = fixture();
  assert.equal(await cache.read(accountA, hashA, 1), null);
  await cache.save(accountA, hashA, 1, result);
  const reopened = new OcrCacheStore(io);
  assert.deepEqual(await reopened.read(accountA, hashA, 1), result);
  for (const [scope, hash, page] of [
    ['guest', hashA, 1], [accountB, hashA, 1], [otherProject, hashA, 1],
    [accountA, hashB, 1], [accountA, hashA, 2],
  ] as const) assert.equal(await reopened.read(scope, hash, page), null);
  assert.match([...stored.keys()][0], /tesseract-7-eng-1.*eng/);
});

test('separate writers do not lose unrelated page results, and explicit retries replace one page', async () => {
  const { io, cache, stored } = fixture();
  const other = new OcrCacheStore(io);
  const blank = { text: '', confidence: 0, truncated: false };
  const limited = { text: 'Shortened OCR output', confidence: 100, truncated: true };
  await Promise.all([cache.save('guest', hashA, 1, blank), other.save('guest', hashA, 2, limited),
    cache.save(accountA, hashA, 1, result)]);
  assert.deepEqual(await cache.read('guest', hashA, 1), blank);
  assert.deepEqual(await other.read('guest', hashA, 2), limited);
  await other.save('guest', hashA, 1, result);
  assert.deepEqual(await cache.read('guest', hashA, 1), result);
  assert.deepEqual(await cache.read(accountA, hashA, 1), result);
  assert.deepEqual(await cache.read('guest', hashA, 2), limited);
  assert.equal(stored.size, 3);
});

test('invalid identifiers, noncanonical hashes, pages, and OCR output are rejected before IO', async () => {
  const io: OcrCacheIO = {
    async getItem() { assert.fail('invalid input reached the local read'); },
    async setItem() { assert.fail('invalid input reached the local write'); },
  };
  const cache = new OcrCacheStore(io);
  for (const scope of [
    null, 'anonymous', { ...accountA, project: '../../private' }, { ...accountA, uid: 'a/b' },
    { ...accountA, project: [accountA.project] },
  ]) await assert.rejects(cache.read(scope as OcrCacheScope, hashA, 1), /scope|identity/i);
  for (const hash of ['', hashA.toUpperCase(), hashA.slice(1), 'z'.repeat(64)]) {
    await assert.rejects(cache.read('guest', hash, 1), /hash/i);
  }
  for (const page of [0, -1, 1.5, 100_001, Infinity, NaN]) {
    await assert.rejects(cache.read('guest', hashA, page), /page/i);
  }
  for (const invalid of [
    { ...result, text: 'a'.repeat(50_001) }, { ...result, confidence: 101 },
    { ...result, confidence: -1 }, { ...result, confidence: NaN },
  ]) await assert.rejects(cache.save('guest', hashA, 1, invalid), /result/i);
});

test('corrupt and misplaced values are reported without replacing any existing result', async () => {
  const { cache, stored } = fixture();
  await cache.save('guest', hashA, 1, result);
  await cache.save('guest', hashA, 2, result);
  const [first, second] = [...stored.keys()];
  const misplaced = stored.get(second)!;
  for (const corrupt of ['{"broken', JSON.stringify({ ...result, confidence: -10 }), 'x'.repeat(400_000), misplaced]) {
    stored.set(first, corrupt);
    await assert.rejects(cache.read('guest', hashA, 1), /stored OCR result/i);
    await assert.rejects(cache.save('guest', hashA, 1, result), /stored OCR result/i);
    assert.equal(stored.get(first), corrupt);
    assert.equal(stored.get(second), misplaced);
  }
});

test('storage read and write errors remain visible to the caller', async () => {
  const readError = new Error('Read failed');
  const writeError = new Error('Quota exceeded');
  const unreadable = new OcrCacheStore({ async getItem() { throw readError; }, async setItem() {} });
  const unwritable = new OcrCacheStore({ async getItem() { return null; }, async setItem() { throw writeError; } });
  await assert.rejects(unreadable.read('guest', hashA, 1), readError);
  await assert.rejects(unwritable.save('guest', hashA, 1, result), writeError);
});
