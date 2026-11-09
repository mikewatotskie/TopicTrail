import { createClient } from '@supabase/supabase-js';
import type { SupabaseConfiguration } from './supabase_config';
import { guardedSessionStorage } from './session_storage';
import { createSupabaseAuthGateway } from './supabase_gateway';
import { authCallbackUrl, runAuthCommand, sessionStorage, watchAuthActivity } from './supabase_platform';
import { createAuthTransport } from './supabase_transport';
let temporarySequence = 0;
let retiringStorage: Promise<unknown> = Promise.resolve();
export function createSupabaseSession(config: SupabaseConfiguration) {
  const key = `tt.sb.${config.namespace}.auth.v1`;
  const predecessor = retiringStorage;
  const persistence = guardedSessionStorage({
    async getItem(key) { await predecessor; return sessionStorage.getItem(key); },
    async setItem(key, value) { await predecessor; return sessionStorage.setItem(key, value); },
    async removeItem(key) { await predecessor; return sessionStorage.removeItem(key); },
  });
  const transport = createAuthTransport();
  const client = createClient(config.url, config.publishableKey, { global: { fetch: transport.fetch }, auth: {
    storageKey: key, storage: { ...persistence.storage,
      // SDK2.119's internal initial-session observers do not catch storage-read rejections.
      // Only the SDK sees absence on failure: the sticky failure flag/notification closes
      // the app gateway immediately. No fallback session, plaintext store or deletion.
      getItem: async name => { try { return await persistence.storage.getItem(name); } catch { return null; } },
    }, persistSession: true, autoRefreshToken: true,
    detectSessionInUrl: false, debug: false,
  } });
  let disposed = false;
  let activityRevision = 0;
  let activityWork: Promise<void> = Promise.resolve();
  const detachActivity = watchAuthActivity(foreground => {
    const revision = ++activityRevision;
    // Native SDK initialization starts its own ticker. Apply the latest AppState only
    // afterward, and serialize start/stop so a late start cannot beat background/disposal.
    activityWork = activityWork.catch(() => undefined).then(async () => {
      await client.auth.initialize();
      if (disposed || revision !== activityRevision) return;
      await (foreground && !persistence.hasFailed() ? client.auth.startAutoRefresh() : client.auth.stopAutoRefresh());
    });
    void activityWork.catch(() => undefined);
  });
  const gateway = createSupabaseAuthGateway({ main: transport.wrap(client.auth), namespace: config.namespace,
    temporary: () => {
      const temporaryTransport = createAuthTransport();
      const temporary = createClient(config.url, config.publishableKey, { global: { fetch: temporaryTransport.fetch }, auth: {
        storageKey: `${key}.email.${++temporarySequence}`, persistSession: false, autoRefreshToken: false,
        detectSessionInUrl: false, debug: false,
      } });
      return temporaryTransport.wrap(temporary.auth);
    },
    callbackUrl: authCallbackUrl, command: action => runAuthCommand(key, action), storageFailed: persistence.hasFailed,
    watchStorageFailure: persistence.subscribeFailure,
    cleanup() {
      disposed = true; activityRevision++; detachActivity();
      const stopped = activityWork.catch(() => undefined).then(() => client.auth.stopAutoRefresh()).catch(() => undefined);
      retiringStorage = Promise.all([persistence.close(), stopped]);
    },
  });
  return gateway;
}
