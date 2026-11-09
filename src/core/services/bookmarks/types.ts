import type { Attribution } from '../resources/types';

/** Link metadata only. Original passages, document identifiers and pages are never stored. */
export interface BookmarkInput {
  readonly url: string;
  readonly title: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly type: 'Article';
  readonly description?: string;
  readonly topic?: string;
  readonly attribution?: Readonly<Attribution>;
}
export interface Bookmark extends BookmarkInput {
  readonly id: string;
  readonly savedAt: string;
}
export interface BookmarkSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly bookmarks: readonly Bookmark[];
  readonly error?: string;
}
