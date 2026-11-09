import type { SupabaseClient, Session, VerifyOtpParams } from '@supabase/supabase-js';
import { AuthOperationError, type AccountIdentity, type AuthGateway, type AuthState } from './types';
import { signupOutcomeError, supabaseAuthError } from './supabase_errors';

export type SupabaseAuthPort = Pick<SupabaseClient['auth'], 'initialize' | 'getSession' | 'onAuthStateChange' | 'signInWithPassword'
  | 'signUp' | 'signOut' | 'resetPasswordForEmail' | 'resend' | 'verifyOtp' | 'updateUser' | 'dispose'>;
export interface SupabaseGatewayOptions {
  main: SupabaseAuthPort;
  temporary: () => SupabaseAuthPort;
  namespace: string;
  callbackUrl: () => string;
  command: <T>(action: () => Promise<T>) => Promise<T>;
  storageFailed?: () => boolean;
  watchStorageFailure?: (changed: () => void) => () => void;
  now?: () => number;
  cleanup?: () => void;
}
function identity(session: Session | null, namespace: string): AccountIdentity | null {
  if (!session) return null;
  const user = session.user;
  if (!user?.email_confirmed_at || user.is_anonymous || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(user.id)) {
    throw new AuthOperationError('confirmation_required', 'Verify your email before logging in.');
  }
  const name = user.user_metadata?.display_name;
  return { uid: user.id, email: user.email ?? null, emailVerified: true, projectNamespace: namespace,
    displayName: typeof name === 'string' && name.trim() && name.length <= 200 ? name.trim() : null };
}
const unavailable = () => new AuthOperationError('unavailable', 'Account services are unavailable. Please try again.');
const stale = () => new AuthOperationError('stale_session', 'The account changed. Please start this action again.');

/** Normal sessions and email-action sessions have separate clients, storage keys and lifetimes. */
export function createSupabaseAuthGateway(options: SupabaseGatewayOptions): AuthGateway {
  const { main } = options;
  const now = options.now ?? Date.now;
  let state: AuthState = { status: 'loading' };
  let epoch = 0;
  let disposed = false;
  let busy = false;
  let refresh = 0;
  let emailFlow = 0;
  let recovery: { auth: SupabaseAuthPort; expires: number; epoch: number; email: string | null } | undefined;
  const listeners = new Set<(state: AuthState) => void>();
  const temporary = new Set<SupabaseAuthPort>();
  const release = (auth: SupabaseAuthPort) => { temporary.delete(auth); void auth.dispose().catch(() => undefined); };
  function cancelRecovery() {
    emailFlow++;
    if (recovery) release(recovery.auth);
    recovery = undefined;
  }
  function publish(next: AuthState) {
    if (disposed) return;
    const key = (value: AuthState) => value.status === 'account' ? `account:${value.account.uid}` : value.status;
    if (key(state) !== key(next)) { epoch++; cancelRecovery(); }
    if (next.status === 'account') Object.freeze(next.account);
    state = Object.freeze(next);
    for (const listener of listeners) listener(state);
  }
  async function synchronize() {
    const revision = ++refresh;
    try {
      const { data, error } = await main.getSession();
      if (disposed || refresh !== revision) return;
      if (error || options.storageFailed?.()) throw unavailable();
      const account = identity(data.session, options.namespace);
      publish(account ? { status: 'account', account } : { status: 'guest' });
    } catch { if (!disposed && refresh === revision) publish({ status: 'unavailable' }); }
  }
  // Never return a getSession promise from the SDK observer (refresh callbacks can deadlock).
  const subscription = main.onAuthStateChange(event => {
    if (disposed || event === 'INITIAL_SESSION') return;
    if (event === 'SIGNED_OUT') { refresh++; publish({ status: options.storageFailed?.() ? 'unavailable' : 'guest' }); }
    else { void synchronize(); }
  }).data.subscription;
  const detachStorageFailure = options.watchStorageFailure?.(() => { refresh++; publish({ status: 'unavailable' }); });
  const ready = main.initialize().then(async ({ error }) => {
    if (error || options.storageFailed?.()) publish({ status: 'unavailable' });
    else await synchronize();
  }).catch(() => publish({ status: 'unavailable' }));
  async function run(action: () => Promise<void>) {
    if (disposed) throw unavailable();
    if (busy) throw new AuthOperationError('busy', 'Please wait for the current account action to finish.');
    busy = true;
    try { await ready; if (disposed) throw unavailable(); await action(); if (disposed) throw stale(); }
    catch (error) { if (options.storageFailed?.()) publish({ status: 'unavailable' }); throw supabaseAuthError(error); }
    finally { busy = false; }
  }
  async function assertGuest() {
    await synchronize();
    if (disposed) throw unavailable();
    if (state.status === 'account') throw new AuthOperationError('already_signed_in', 'Sign out before changing accounts.');
    if (state.status !== 'guest') throw unavailable();
  }
  function makeTemporary() { const auth = options.temporary(); temporary.add(auth); return auth; }
  async function isolated(action: (auth: SupabaseAuthPort) => Promise<void>) {
    const auth = makeTemporary();
    try { const { error } = await auth.initialize(); if (error) throw error; await action(auth); }
    finally { release(auth); }
  }
  async function verify(params: VerifyOtpParams, purpose: 'signup' | 'recovery') {
    cancelRecovery();
    const flow = emailFlow;
    const started = epoch;
    const auth = makeTemporary();
    let retained = false;
    try {
      const initialized = await auth.initialize(); if (initialized.error) throw initialized.error;
      const { data, error } = await auth.verifyOtp(params);
      if (error) throw error;
      if (disposed || flow !== emailFlow || started !== epoch) throw stale();
      const verified = identity(data.session, options.namespace);
      if (!verified) throw unavailable();
      if ('email' in params && params.email.toLowerCase() !== verified.email?.toLowerCase()) throw unavailable();
      if (purpose === 'recovery') {
        const expires = Math.min(now() + 10 * 60_000, (data.session?.expires_at ?? 0) * 1000);
        if (expires <= now()) throw new AuthOperationError('invalid_code', 'Request a fresh recovery code.');
        recovery = { auth, expires, epoch: started, email: verified.email }; retained = true;
      } else {
        // Revoke only this temporary session; normal login is a separate, explicit action.
        const result = await auth.signOut({ scope: 'local' }); if (result.error) throw result.error;
      }
    } finally { if (!retained) release(auth); }
  }
  function otp(email: string, code: string, type: 'signup' | 'recovery'): VerifyOtpParams {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !/^\d{6,10}$/.test(code.trim())) {
      throw new AuthOperationError('invalid_code', 'Enter your email and the code from your latest email.');
    }
    return { email: email.trim(), token: code.trim(), type };
  }
  const gateway: AuthGateway = {
    getSnapshot: () => state,
    getSessionEpoch: () => epoch,
    subscribe(listener) { if (disposed) return () => undefined; listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    signIn(email, password) {
      return run(() => options.command(async () => {
        await assertGuest();
        const { error } = await main.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        await synchronize();
        if (state.status !== 'account') throw unavailable();
      }));
    },
    register(displayName, email, password) {
      return run(async () => {
        await assertGuest();
        if (!displayName.trim() || displayName.trim().length > 200) throw unavailable();
        const started = epoch;
        let dispatched = false;
        try {
          await isolated(async auth => {
            dispatched = true;
            const { data, error } = await auth.signUp({ email: email.trim(), password,
              options: { data: { display_name: displayName.trim() }, emailRedirectTo: options.callbackUrl() } });
            if (error) throw error;
            if (!data.user?.id) throw new AuthOperationError('invalid_response', 'The registration result could not be confirmed.');
            if (data.session) {
              await auth.signOut({ scope: 'local' });
              throw new AuthOperationError('account_created', 'Email confirmation is required. Check the project configuration before continuing.');
            }
            // Supabase can return a masked existing account. Never assert identity or successful delivery here.
          });
          if (epoch !== started) throw stale();
        } catch (error) { throw signupOutcomeError(supabaseAuthError(error), dispatched); }
      });
    },
    sendPasswordReset(email) {
      return run(() => isolated(async auth => {
        const { error } = await auth.resetPasswordForEmail(email.trim(), { redirectTo: options.callbackUrl() });
        if (error && error.code !== 'user_not_found') throw error;
      }));
    },
    signOut() {
      return run(() => options.command(async () => {
        cancelRecovery();
        const { error } = await main.signOut({ scope: 'local' });
        await synchronize();
        // SDK 2.119 removes the local session before remote revocation; offline logout is local only.
        if (state.status !== 'guest') throw error ?? unavailable();
      }));
    },
    verification: {
      verifyEmail: (email, code) => run(() => verify(otp(email, code, 'signup'), 'signup')),
      resendConfirmation: email => run(() => isolated(async auth => {
        const { error } = await auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: options.callbackUrl() } });
        if (error && error.code !== 'user_not_found') throw error;
      })),
      beginRecovery: (email, code) => run(() => verify(otp(email, code, 'recovery'), 'recovery')),
      verifyLink: (tokenHash, purpose) => run(async () => {
        if (!/^[a-f0-9]{40,128}$/i.test(tokenHash) || (purpose !== 'signup' && purpose !== 'recovery')) {
          throw new AuthOperationError('invalid_code', 'This email link is invalid. Request a new code.');
        }
        await verify({ token_hash: tokenHash, type: purpose }, purpose);
      }),
      hasRecoverySession: () => !!recovery && !disposed && recovery.expires > now() && recovery.epoch === epoch,
      recoveryEmail: () => gateway.verification!.hasRecoverySession() ? recovery?.email ?? null : null,
      completeRecovery: password => run(async () => {
        const owned = recovery;
        if (!gateway.verification!.hasRecoverySession() || !owned) { cancelRecovery(); throw new AuthOperationError('invalid_code', 'Verify a fresh recovery code first.'); }
        if (!password) throw new AuthOperationError('weak_password', 'Enter your new password.');
        const { error } = await owned.auth.updateUser({ password });
        if (error) throw error;
        if (disposed || recovery !== owned || owned.epoch !== epoch) throw stale();
        // Once changed, never invite a repeat update due to a revocation-network error.
        recovery = undefined;
        try { await owned.auth.signOut({ scope: 'local' }); } finally { release(owned.auth); }
      }),
      cancelRecovery,
    },
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; refresh++; cancelRecovery(); subscription.unsubscribe(); detachStorageFailure?.(); listeners.clear();
      for (const auth of temporary) release(auth);
      options.cleanup?.();
      void main.dispose().catch(() => undefined);
    },
  };
  return gateway;
}
