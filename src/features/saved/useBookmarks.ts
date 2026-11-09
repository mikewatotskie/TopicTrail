import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { bookmarkStore } from '../../core/services/bookmarks/storage';
import type { Bookmark, BookmarkInput } from '../../core/services/bookmarks/types';
import { canonicalBookmarkUrl } from '../../core/services/link_shield';
import type { EducationalResource } from '../../core/services/resources/types';

export type ResourceMetadata = EducationalResource | Bookmark;

export function useBookmarks() {
  const snapshot = useSyncExternalStore(bookmarkStore.subscribe, bookmarkStore.getSnapshot, bookmarkStore.getSnapshot);
  useEffect(() => { void bookmarkStore.initialize().catch(() => {}); }, []);
  return { ...snapshot, retry: () => { void bookmarkStore.reload().catch(() => {}); } };
}

export function useBookmarkAction(resource: ResourceMetadata, query?: string) {
  const snapshot = useBookmarks();
  const url = canonicalBookmarkUrl(resource.url);
  const saved = snapshot.bookmarks.find(bookmark => bookmark.url === url);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function toggle() {
    if (lock.current || !url) return;
    lock.current = true; setPending(true); setError('');
    try {
      await bookmarkStore.initialize();
      if (saved) await bookmarkStore.remove(url);
      else {
        const topic = query ?? ('topic' in resource ? resource.topic : undefined);
        // Persist metadata only: never the selected passage, document ID or page.
        const input: BookmarkInput = { url, title: resource.title, providerId: resource.providerId,
          providerName: resource.providerName, type: resource.type, description: resource.description,
          attribution: resource.attribution, topic: topic ? [...topic].slice(0, 140).join('') : undefined };
        await bookmarkStore.save(input);
      }
    } catch {
      if (active.current) setError(saved ? 'Couldn’t remove resource. Your saved link is unchanged. Try again.' : 'Couldn’t save resource. Try again.');
    } finally { lock.current = false; if (active.current) setPending(false); }
  }
  return { saved, pending, error, toggle, available: !!url, snapshot };
}

export function savedDate(value: string) {
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
