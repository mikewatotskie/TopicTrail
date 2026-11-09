import type { BookmarkStoragePort } from '../bookmarks/repository';
import { MAX_METADATA_BYTES } from '../bookmarks/metadata';
import type { IndexedDbClient } from './indexeddb_client';

export function createWebBookmarkPort(client: IndexedDbClient): BookmarkStoragePort {
  let revision: number | undefined;
  function check(json: string | null) {
    if (json !== null && new TextEncoder().encode(json).length > MAX_METADATA_BYTES) throw Error('Saved resource metadata is too large. Existing data has been preserved.');
  }
  return {
    async readMetadata() { const record = await client.readLibrary('bookmarks'); check(record.json); revision = record.revision; return record.json; },
    async writeMetadata(json) {
      if (revision === undefined) throw Error('Read saved resources before updating them.');
      check(json); revision = await client.commitLibrary('bookmarks', revision, json);
    },
  };
}
