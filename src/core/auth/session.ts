import { readSupabaseConfiguration } from './supabase_config';
import { createSupabaseSession } from './supabase_client';
import type { AuthGateway } from './types';

let gateway: AuthGateway | undefined;

/** Shared lifetime; ordinary React cleanup only unsubscribes. No Firebase fallback. */
export function getTopicTrailAuthGateway(): AuthGateway {
  if (!gateway) {
    const owned = createSupabaseSession(readSupabaseConfiguration());
    const current: AuthGateway = { ...owned, dispose() {
      owned.dispose();
      if (gateway === current) gateway = undefined;
    } };
    gateway = current;
  }
  return gateway;
}
