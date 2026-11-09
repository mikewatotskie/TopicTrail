import type { SupportedStorage } from '@supabase/supabase-js';
import { AuthOperationError } from './types';

export const sessionStorage: SupportedStorage = {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
};
/** Serializes explicit sign-in/out across tabs. Never steal a live lock. SDK refresh has its own commit guard. */
export async function runAuthCommand<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) throw new AuthOperationError('unavailable', 'This browser cannot coordinate account changes.');
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    return await navigator.locks.request(`topictrail.auth.${key}`, { mode: 'exclusive', signal: abort.signal }, async lock => {
      clearTimeout(timeout);
      if (!lock) throw new AuthOperationError('busy', 'Another tab is changing the account. Try again.');
      return action();
    });
  } catch (error) {
    if (abort.signal.aborted) throw new AuthOperationError('busy', 'Another tab is changing the account. Try again.');
    throw error;
  } finally { clearTimeout(timeout); }
}
// The web SDK owns visibility-based refresh; no duplicate activity listener.
export function watchAuthActivity(_active: (foreground: boolean) => void) { return () => undefined; }
export function authCallbackUrl() {
  if (typeof window === 'undefined' || !/^https?:$/.test(window.location.protocol)) {
    throw new AuthOperationError('unavailable', 'Open TopicTrail in its browser page to continue.');
  }
  return `${window.location.origin}/auth/callback`;
}
