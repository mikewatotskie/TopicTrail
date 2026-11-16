import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { bookmarkStore } from '../../core/services/bookmarks/storage';
import type { Bookmark, BookmarkInput, BookmarkSnapshot } from '../../core/services/bookmarks/types';
import { canonicalBookmarkUrl } from '../../core/services/link_shield';
import type { EducationalResource } from '../../core/services/resources/types';
import { useCloudLibrary } from '../library/CloudLibraryContext';

const unavailableSnapshot:BookmarkSnapshot={status:'loading',bookmarks:[]};
const unavailable={getSnapshot:()=>unavailableSnapshot,subscribe:()=>()=>{},initialize:async()=>{},reload:async()=>{},save:async(_input:BookmarkInput):Promise<Bookmark>=>{throw Error('Account is unavailable');},remove:async(_url:string)=>{throw Error('Account is unavailable');}};

export type ResourceMetadata = EducationalResource | Bookmark;

export function useBookmarks() {
  const {runtime,state}=useCloudLibrary();
  const store=runtime?(state.identity?runtime.bookmarks():state.phase==='guest'?bookmarkStore:unavailable):bookmarkStore;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { void store.initialize().catch(() => {}); }, [store]);
  return { ...snapshot,store, retry: () => { void store.reload().catch(() => {}); } };
}

export function useBookmarkAction(resource: ResourceMetadata, query?: string) {
  const snapshot = useBookmarks();
  const store=snapshot.store;
  const url = canonicalBookmarkUrl(resource.url);
  const saved = snapshot.bookmarks.find(bookmark => bookmark.url === url);
  const alreadySaved = !!saved && resource.providerId === 'duckduckgo' && !('savedAt' in resource);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function toggle() {
    if (lock.current || !url || alreadySaved) return;
    lock.current = true; setPending(true); setError('');
    try {
      await store.initialize();
      if (saved) await store.remove(url);
      else {
        const topic = query ?? ('topic' in resource ? resource.topic : undefined);
        // Persist metadata only: never the selected passage, document ID or page.
        const input: BookmarkInput = { url, title: resource.title, providerId: resource.providerId,
          // v10 and the account sync API accept "Article" for every saved link.
          providerName: resource.providerName, type: 'Article', description: resource.description,
          attribution: resource.attribution, topic: topic ? [...topic].slice(0, 140).join('') : undefined };
        await store.save(input);
      }
    } catch {
      if (active.current) setError(saved ? 'Couldn’t remove resource. Your saved link is unchanged. Try again.' : 'Couldn’t save resource. Try again.');
    } finally { lock.current = false; if (active.current) setPending(false); }
  }
  return { saved, alreadySaved, pending, error, toggle, available: !!url, snapshot };
}

export function savedDate(value: string) {
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
