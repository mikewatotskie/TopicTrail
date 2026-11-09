import { canonicalBookmarkUrl } from '../link_shield';
import { decodeBookmarks, encodeBookmarks, validateBookmarkInput } from './metadata';
import type { Bookmark, BookmarkInput, BookmarkSnapshot } from './types';

export type { BookmarkSnapshot } from './types';
export interface BookmarkStoragePort {
  readMetadata(): Promise<string | null>;
  writeMetadata(json: string): Promise<void>;
}
const empty: readonly Bookmark[] = Object.freeze([]);
const readError = 'Saved resource metadata could not be read. Existing saved resources have been preserved. Try again.';

/** One queue includes initial reads and all writes; state is committed only after storage resolves. */
export class BookmarkRepository {
  private snapshot: BookmarkSnapshot = Object.freeze({ status: 'idle', bookmarks: empty });
  private pending: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private sequence = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly port: BookmarkStoragePort, private readonly now: () => Date = () => new Date()) {}
  getSnapshot = (): BookmarkSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(status: BookmarkSnapshot['status'], bookmarks = this.snapshot.bookmarks, error?: string): void {
    this.snapshot = Object.freeze({ status, bookmarks, ...(error ? { error } : {}) });
    for (const listener of this.listeners) {
      // A failing consumer must never turn a successful durable commit into a rejected mutation.
      try { listener(); } catch { /* Other subscribers still receive the committed state. */ }
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation); this.pending = result.catch(() => undefined); return result;
  }
  private async load(): Promise<void> {
    if (this.initialized) return;
    this.publish('loading');
    try {
      const json = await this.port.readMetadata(); const bookmarks = json === null ? empty : decodeBookmarks(json);
      this.initialized = true; this.publish('ready', bookmarks);
    } catch {
      this.publish('error', this.snapshot.bookmarks, readError); throw Error(readError);
    }
  }
  initialize(): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      if (this.snapshot.status === 'error') this.publish('ready');
    });
  }
  reload(): Promise<void> {
    return this.enqueue(async () => { this.initialized = false; await this.load(); });
  }
  save(input: BookmarkInput): Promise<Bookmark> {
    let fields: BookmarkInput;
    try { fields = validateBookmarkInput(input); } catch (error) { return Promise.reject(error); }
    return this.enqueue(async () => {
      await this.load();
      const existing = this.snapshot.bookmarks.find(bookmark => bookmark.url === fields.url);
      if (existing) { if (this.snapshot.status === 'error') this.publish('ready'); return existing; }
      const instant = this.now();
      if (!Number.isFinite(instant.getTime())) throw Error('Could not save the resource date. Try again.');
      const savedAt = instant.toISOString();
      if (savedAt.length !== 24) throw Error('Could not save the resource date. Try again.');
      let id: string;
      do { id = `bookmark-${instant.getTime().toString(36)}-${(++this.sequence).toString(36)}`; }
      while (this.snapshot.bookmarks.some(bookmark => bookmark.id === id));
      const bookmark: Bookmark = Object.freeze({ ...fields, id, savedAt });
      const bookmarks = Object.freeze([bookmark, ...this.snapshot.bookmarks]);
      await this.persist(bookmarks, 'Could not save this resource. Existing saved resources have been preserved. Try again.');
      return bookmark;
    });
  }
  remove(value: string): Promise<void> {
    const url = canonicalBookmarkUrl(value);
    if (!url) return Promise.reject(Error('This resource link cannot be removed.'));
    return this.enqueue(async () => {
      await this.load(); const bookmarks = this.snapshot.bookmarks.filter(bookmark => bookmark.url !== url);
      if (bookmarks.length === this.snapshot.bookmarks.length) return;
      await this.persist(Object.freeze(bookmarks), 'Could not remove this saved resource. Existing saved resources have been preserved. Try again.');
    });
  }
  private async persist(bookmarks: readonly Bookmark[], message: string): Promise<void> {
    const json = encodeBookmarks(bookmarks);
    try { await this.port.writeMetadata(json); }
    catch { this.publish('error', this.snapshot.bookmarks, message); throw Error(message); }
    this.publish('ready', bookmarks);
  }
}
