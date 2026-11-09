import type { SupabaseAuthPort } from './supabase_gateway';
import { createAuthFetch } from './supabase_fetch';
import { reportAuthDiagnostic, type AuthOperation, type AuthRequestEvidence } from './supabase_diagnostics';
import { signupOutcomeError, supabaseAuthError } from './supabase_errors';
import { AuthOperationError } from './types';

function operationFor(input: RequestInfo | URL, init?: RequestInit): AuthOperation | undefined {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method?.toUpperCase();
  if (method === 'POST' && url.pathname.endsWith('/token') && url.searchParams.get('grant_type') === 'password') return 'login';
  if (method === 'PUT' && url.pathname.endsWith('/user')) return 'password_update';
  if (method !== 'POST') return undefined;
  const routes: Record<string, AuthOperation> = { signup: 'signup', recover: 'recovery_request', resend: 'resend_confirmation', verify: 'verify_email', logout: 'logout' };
  return routes[url.pathname.split('/').at(-1) ?? ''];
}

/** One transport per SDK client. Refresh requests cannot overwrite an explicit password operation. */
export function createAuthTransport(timeoutMs?: number) {
  const active = new Map<AuthOperation, { dispatched: boolean; evidence: AuthRequestEvidence }>();
  const fetch = createAuthFetch((input, init, evidence) => {
    const operation = operationFor(input, init);
    const trace = operation && active.get(operation);
    if (trace) { trace.dispatched = true; trace.evidence = { ...evidence }; }
  }, timeoutMs);
  function wrap(auth: SupabaseAuthPort): SupabaseAuthPort {
    async function request<T extends { error: unknown }>(operation: AuthOperation, action: () => Promise<T>): Promise<T> {
      if (active.has(operation)) throw new AuthOperationError('busy', 'An account request is already running.');
      const trace = { dispatched: false, evidence: {} as AuthRequestEvidence };
      active.set(operation, trace);
      try {
        const result = await action();
        if (result.error) {
          // Logout reconciles local state even when remote revocation fails. Recovery/resend
          // deliberately keep user-not-found acknowledgements neutral in the gateway.
          const code = typeof result.error === 'object' && 'code' in result.error ? result.error.code : undefined;
          if (operation === 'logout' || ((operation === 'recovery_request' || operation === 'resend_confirmation') && code === 'user_not_found')) {
            reportAuthDiagnostic(operation, supabaseAuthError(result.error, trace.evidence).code, trace.evidence);
            return result;
          }
          throw result.error;
        }
        if (operation === 'signup') {
          const data = (result as { data?: { user?: { id?: unknown }; session?: unknown } }).data;
          if (!data?.user || typeof data.user.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.user.id)) {
            throw new AuthOperationError('invalid_response', 'The registration result could not be confirmed.');
          }
          reportAuthDiagnostic(operation, data.session ? 'account_created' : 'awaiting_confirmation', trace.evidence);
        } else reportAuthDiagnostic(operation, 'success', trace.evidence);
        return result;
      } catch (error) {
        const mapped = supabaseAuthError(error, trace.evidence);
        reportAuthDiagnostic(operation, mapped.code, trace.evidence);
        throw operation === 'signup' ? signupOutcomeError(mapped, trace.dispatched) : mapped;
      } finally { active.delete(operation); }
    }
    return {
      initialize: auth.initialize.bind(auth), getSession: auth.getSession.bind(auth), onAuthStateChange: auth.onAuthStateChange.bind(auth), dispose: auth.dispose.bind(auth),
      signUp: args => request('signup', () => auth.signUp(args)),
      signInWithPassword: args => request('login', () => auth.signInWithPassword(args)),
      resetPasswordForEmail: (...args) => request('recovery_request', () => auth.resetPasswordForEmail(...args)),
      resend: args => request('resend_confirmation', () => auth.resend(args)),
      verifyOtp: args => request('verify_email', () => auth.verifyOtp(args)),
      updateUser: (...args) => request('password_update', () => auth.updateUser(...args)),
      signOut: args => request('logout', () => auth.signOut(args)),
    };
  }
  return { fetch, wrap };
}
