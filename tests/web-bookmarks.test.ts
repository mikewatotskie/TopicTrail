import assert from 'node:assert/strict';
import test from 'node:test';
import { BookmarkRepository } from '../src/core/services/bookmarks/repository';
import { encodeBookmarks } from '../src/core/services/bookmarks/metadata';

test('explicit reload recovers another tab’s committed bookmark metadata', async () => {
  let json: string | null = null;
  const store = new BookmarkRepository({ readMetadata: async () => json, writeMetadata: async value => { json = value; } });
  await store.initialize();
  json = encodeBookmarks([{ id: 'saved-1', savedAt: '2026-11-03T00:00:00.000Z', url: 'https://en.wikipedia.org/wiki/Iteration',
    title: 'Iteration', providerId: 'wikipedia', providerName: 'Wikipedia', type: 'Article' }]);
  await store.reload();
  assert.equal(store.getSnapshot().bookmarks.length, 1);
  assert.equal(store.getSnapshot().bookmarks[0].title, 'Iteration');
  json = '{broken';
  await assert.rejects(store.reload());
  assert.equal(store.getSnapshot().bookmarks.length, 1);
  assert.equal(store.getSnapshot().status, 'error');
});
