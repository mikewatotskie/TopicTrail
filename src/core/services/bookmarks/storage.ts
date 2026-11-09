import { File, Paths } from 'expo-file-system';
import { createBookmarkFilePort } from './file_port';
import { BookmarkRepository } from './repository';

// Keep bookmark metadata separate from owned documents and their recovery files.
const port = createBookmarkFilePort(() => ({
  main: new File(Paths.document, 'bookmarks.json'),
  pending: new File(Paths.document, 'bookmarks.pending.json'),
  backup: new File(Paths.document, 'bookmarks.backup.json'),
}));
export const bookmarkStore = new BookmarkRepository(port);
