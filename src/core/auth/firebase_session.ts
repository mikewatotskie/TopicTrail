// Retained rollback implementation; the production session.ts uses Supabase exclusively.
import { initializeAuth } from 'firebase/auth';
import { getTopicTrailFirebaseApp } from './firebase_app';
import { createFirebaseAuthGateway } from './firebase_gateway';
import { authPersistence } from './persistence';
import type { AuthGateway } from './types';

let gateway: AuthGateway | undefined;
export function getTopicTrailFirebaseGateway(): AuthGateway {
  if (!gateway) {
    const auth = initializeAuth(getTopicTrailFirebaseApp(), { persistence: authPersistence });
    const owned = createFirebaseAuthGateway(auth);
    const current: AuthGateway = { ...owned, dispose() {
      owned.dispose(); if (gateway === current) gateway = undefined;
    } };
    gateway = current;
  }
  return gateway;
}
