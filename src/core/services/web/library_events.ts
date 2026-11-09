import type { LibraryKey } from './indexeddb_client';
const listeners = new Set<(key: LibraryKey) => void>();
let channel: BroadcastChannel | undefined;
function emit(key: LibraryKey) { for (const listener of listeners) { try { listener(key); } catch { /* Notification failure cannot undo a commit. */ } } }
function connect() {
  if (channel || typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return;
  try {
    channel = new window.BroadcastChannel('topictrail-library-changes');
    channel.onmessage = event => {
      const value: unknown = event.data;
      if (value && typeof value === 'object' && 'version' in value && value.version === 1 && 'key' in value
          && (value.key === 'documents' || value.key === 'bookmarks')) emit(value.key);
    };
  } catch { /* Focus refresh remains available when channels are restricted. */ }
}
export function notifyLibraryChange(key: LibraryKey): void {
  connect(); try { channel?.postMessage({ version: 1, key }); } catch { /* Best effort. */ } emit(key);
}
export function subscribeLibraryChanges(key: LibraryKey, listener: () => void): () => void {
  connect(); const callback = (changed: LibraryKey) => { if (changed === key) listener(); };
  listeners.add(callback); return () => { listeners.delete(callback); };
}
