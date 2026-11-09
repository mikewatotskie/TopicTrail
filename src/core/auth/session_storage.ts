import type { SupportedStorage } from '@supabase/supabase-js';
import { AuthOperationError } from './types';

/** Fail closed on persistence failure; never silently fall back to a memory/AsyncStorage session. */
export function guardedSessionStorage(port: SupportedStorage) {
  let closed = false;
  let failed = false;
  const failures = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();
  const problem = () => new AuthOperationError('unavailable', 'Secure session storage is unavailable.');
  async function perform<T>(operation: () => PromiseLike<T> | T): Promise<T> {
    if (closed || failed) throw problem();
    const task = Promise.resolve().then(() => { if (closed || failed) throw problem(); return operation(); });
    pending.add(task);
    try {
      const value = await task;
      if (closed) throw problem();
      return value;
    } catch {
      if (!failed) { failed = true; for (const listener of failures) listener(); }
      throw problem();
    }
    finally { pending.delete(task); }
  }
  return {
    storage: {
      getItem: (key: string) => perform(() => port.getItem(key)),
      setItem: (key: string, value: string) => perform(() => port.setItem(key, value)),
      removeItem: (key: string) => perform(() => port.removeItem(key)),
    } satisfies SupportedStorage,
    hasFailed: () => failed,
    subscribeFailure(listener: () => void) { failures.add(listener); if (failed) listener(); return () => { failures.delete(listener); }; },
    async close() { closed = true; await Promise.allSettled([...pending]); },
  };
}
