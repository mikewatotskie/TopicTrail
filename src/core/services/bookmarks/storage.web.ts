import { BookmarkRepository } from './repository';
import { createWebBookmarkPort } from '../web/bookmark_port';
import { getBrowserClient, type IndexedDbClient } from '../web/indexeddb_client';
import { subscribeLibraryChanges } from '../web/library_events';
export function createWebBookmarkStore(getClient = getBrowserClient) {
  let current: ReturnType<typeof createWebBookmarkPort> | undefined;
  let client: IndexedDbClient | undefined;
  async function port() {
    const next = await getClient();
    if (next !== client) { client = next; current = createWebBookmarkPort(next); }
    return current!;
  }
  return new BookmarkRepository({
    readMetadata: async () => (await port()).readMetadata(),
    writeMetadata: async json => (await port()).writeMetadata(json),
  });
}
export const bookmarkStore = createWebBookmarkStore();
if (typeof window !== 'undefined') {
  subscribeLibraryChanges('bookmarks', () => { void bookmarkStore.reload().catch(() => {}); });
  window.addEventListener('focus', () => { void bookmarkStore.reload().catch(() => {}); });
}
