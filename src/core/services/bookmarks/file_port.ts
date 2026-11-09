import { MAX_METADATA_BYTES } from './metadata';
import type { BookmarkStoragePort } from './repository';

/** Narrow structural boundary of Expo58 File, also usable with a real filesystem test driver. */
export interface BookmarkFile<Destination> {
  readonly exists: boolean;
  readonly size: number | null;
  text(): Promise<string>;
  write(json: string): Promise<void>;
  copy(destination: Destination, options: { overwrite: boolean }): Promise<void>;
  move(destination: Destination, options: { overwrite: boolean }): Promise<void>;
}
export interface BookmarkFiles<T> { main: T; pending: T; backup: T }

export function createBookmarkFilePort<T extends BookmarkFile<T>>(files: () => BookmarkFiles<T>): BookmarkStoragePort {
  return {
    async readMetadata() {
      const { main, backup } = files();
      // A present but corrupt main is reported by the repository, never silently replaced.
      const source = main.exists ? main : backup.exists ? backup : null;
      if (!source) return null;
      const size = source.size;
      if (size === null || !Number.isFinite(size) || size < 0 || size > MAX_METADATA_BYTES) throw Error('Saved resource metadata could not be read.');
      return source.text();
    },
    async writeMetadata(json) {
      const { main, pending, backup } = files();
      await pending.write(json);
      if (main.exists) await main.copy(backup, { overwrite: true });
      // Staging is never read as a committed library. A failed replacement leaves the backup available.
      await pending.move(main, { overwrite: true });
    },
  };
}
