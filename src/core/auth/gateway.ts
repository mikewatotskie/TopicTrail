import { AuthOperationError, type AuthBackend, type AuthGateway, type AuthState } from './types';

function providerCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}
export function toAuthError(error: unknown): AuthOperationError {
  if (error instanceof AuthOperationError) return error;
  switch (providerCode(error)) {
    case 'auth/invalid-credential': case 'auth/invalid-login-credentials':
    case 'auth/wrong-password': case 'auth/user-not-found': case 'auth/user-disabled':
      return new AuthOperationError('invalid_credentials', 'Email or password is incorrect.');
    case 'auth/invalid-email': return new AuthOperationError('invalid_email', 'Enter a valid email address.');
    case 'auth/weak-password': case 'auth/password-does-not-meet-requirements':
      return new AuthOperationError('weak_password', 'Choose a password that meets the account requirements.');
    case 'auth/email-already-in-use': return new AuthOperationError('email_in_use', 'Unable to create an account with these details. Try logging in or resetting your password.');
    case 'auth/too-many-requests': case 'auth/quota-exceeded': return new AuthOperationError('rate_limit', 'Too many attempts. Please wait before trying again.');
    case 'auth/network-request-failed': case 'auth/timeout': return new AuthOperationError('network', 'Unable to connect. Check your connection and try again.');
    default: return new AuthOperationError('unavailable', 'Sign-in is unavailable right now. Please try again.');
  }
}

export function createAuthGateway(backend: AuthBackend): AuthGateway {
  let state: AuthState = { status: 'loading' };
  let disposed = false;
  let busy = false;
  let registering = false;
  let registrationNeedsSignOut = false;
  const listeners = new Set<(state: AuthState) => void>();
  function publish(next: AuthState) {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener(state);
  }
  function refresh() {
    if (disposed || registering) return;
    if (registrationNeedsSignOut) { publish({ status: 'unavailable' }); return; }
    // Read the current SDK snapshot so a delayed callback cannot restore an old user.
    const account = backend.currentIdentity();
    publish(account ? { status: 'account', account } : { status: 'guest' });
  }
  const detach = backend.observe(refresh, () => publish({ status: 'unavailable' }));
  async function run(operation: () => Promise<void>) {
    if (disposed) throw new AuthOperationError('unavailable', 'Sign-in is unavailable right now. Please try again.');
    if (busy) throw new AuthOperationError('busy', 'Please wait for the current account action to finish.');
    busy = true;
    try { await operation(); }
    catch (error) { throw toAuthError(error); }
    finally { busy = false; }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (disposed) { listener({ status: 'unavailable' }); return () => {}; }
      listeners.add(listener); listener(state);
      return () => { listeners.delete(listener); };
    },
    signIn(email, password) {
      return run(async () => {
        if (registrationNeedsSignOut) {
          await backend.signOut(); registrationNeedsSignOut = false;
        }
        await backend.signIn(email.trim(), password); refresh();
      });
    },
    register(displayName, email, password) {
      return run(async () => {
        if (registrationNeedsSignOut) throw new AuthOperationError('unavailable', 'Finish signing out before trying again.');
        if (backend.currentIdentity()) throw new AuthOperationError('already_signed_in', 'Sign out before creating another account.');
        if (!displayName.trim()) throw new AuthOperationError('unavailable', 'Enter your name to create an account.');
        registering = true;
        let created = false;
        let problem: unknown;
        try {
          await backend.createAccount(email.trim(), password); created = true;
          await backend.updateDisplayName(displayName.trim());
        } catch (error) { problem = error; }
        finally {
          if (created) {
            try { await backend.signOut(); }
            catch (error) { registrationNeedsSignOut = true; problem ??= error; }
          }
          registering = false; refresh();
        }
        if (created && problem) throw new AuthOperationError('account_created', registrationNeedsSignOut
          ? 'Your account was created, but sign-out could not finish. Retry signing out, then log in. Do not register again.'
          : 'Your account was created, but its setup could not finish. Log in or reset your password. Do not register again.');
        if (problem) throw problem;
      });
    },
    sendPasswordReset(email) {
      return run(async () => {
        try { await backend.sendPasswordReset(email.trim()); }
        catch (error) { if (providerCode(error) !== 'auth/user-not-found') throw error; }
      });
    },
    signOut() {
      return run(async () => {
        try { await backend.signOut(); registrationNeedsSignOut = false; }
        finally { refresh(); }
      });
    },
    dispose() { if (!disposed) { disposed = true; detach(); listeners.clear(); } },
  };
}
