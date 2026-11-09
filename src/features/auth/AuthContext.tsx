import React, { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react';
import { getTopicTrailAuthGateway } from '../../core/auth/session';
import { AuthOperationError, type AuthGateway, type AuthState } from '../../core/auth/types';

const unavailableState: AuthState = { status: 'unavailable' };
const unavailable = async () => { throw new AuthOperationError('unavailable', 'Authentication is unavailable.'); };
const unavailableGateway: AuthGateway = {
  getSnapshot: () => unavailableState, subscribe: () => () => undefined,
  signIn: unavailable, register: unavailable, sendPasswordReset: unavailable, signOut: unavailable, dispose() {},
};
interface AuthContextValue {
  state: AuthState; gateway: AuthGateway; registrationCreatedAt: number | null;
  recordAccountCreated: () => void; clearAccountCreated: () => void;
}
const AuthContext = createContext<AuthContextValue>({ state: unavailableState, gateway: unavailableGateway,
  registrationCreatedAt: null, recordAccountCreated() {}, clearAccountCreated() {} });

export function AuthProvider({ children, gateway: injected }: { children: React.ReactNode; gateway?: AuthGateway }) {
  const [production] = useState(() => {
    if (injected) return injected;
    try { return getTopicTrailAuthGateway(); }
    catch { return unavailableGateway; }
  });
  const gateway = injected ?? production;
  const [registrationCreatedAt, setRegistrationCreatedAt] = useState<number | null>(null);
  const recordAccountCreated = useCallback(() => setRegistrationCreatedAt(Date.now()), []);
  const clearAccountCreated = useCallback(() => setRegistrationCreatedAt(null), []);
  const subscribe = useCallback((changed: () => void) => gateway.subscribe(changed), [gateway]);
  const snapshot = useCallback(() => gateway.getSnapshot(), [gateway]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  // The shared session factory owns the gateway. StrictMode mounts only own their subscriptions.
  return <AuthContext.Provider value={{ state, gateway, registrationCreatedAt, recordAccountCreated, clearAccountCreated }}>{children}</AuthContext.Provider>;
}
export function useAuth() { return useContext(AuthContext); }
