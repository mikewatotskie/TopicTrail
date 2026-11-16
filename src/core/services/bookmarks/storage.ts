import { File, Paths } from 'expo-file-system';
import { createBookmarkFilePort } from './file_port';
import { BookmarkRepository } from './repository';
import { metadataPort, productionMetadata } from '../study_metadata';

// Keep bookmark metadata separate from owned documents and their recovery files.
const port = createBookmarkFilePort(() => ({
  main: new File(Paths.document, 'bookmarks.json'),
  pending: new File(Paths.document, 'bookmarks.pending.json'),
  backup: new File(Paths.document, 'bookmarks.backup.json'),
}));
const privateBookmarks = metadataPort('guest/bookmarks');
export const guestBookmarkPort = {
  readMetadata: () => (productionMetadata() ? privateBookmarks : port).readMetadata(),
  writeMetadata: (value: string) => (productionMetadata() ? privateBookmarks : port).writeMetadata(value),
};
export const bookmarkStore = new BookmarkRepository(guestBookmarkPort);
