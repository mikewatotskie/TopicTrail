export interface AccountIdentity {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  /** Supabase project identity; never inferred from email or display name. */
  projectNamespace?: string;
}
export type AuthState = { status: 'loading' | 'guest' | 'unavailable' }
  | { status: 'account'; account: AccountIdentity };
export type AuthErrorCode = 'invalid_credentials' | 'invalid_email' | 'weak_password'
  | 'email_in_use' | 'rate_limit' | 'network' | 'unavailable' | 'busy'
  | 'timeout' | 'cancelled' | 'validation' | 'unauthorized' | 'forbidden' | 'conflict' | 'server' | 'email_submission' | 'invalid_response'
  | 'account_created' | 'already_signed_in' | 'confirmation_required' | 'invalid_code' | 'stale_session';
export class AuthOperationError extends Error {
  constructor(public readonly code: AuthErrorCode, message: string, public readonly ambiguousOutcome = false) {
    super(message); this.name = 'AuthOperationError';
  }
}
export interface AuthGateway {
  getSnapshot(): AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  register(displayName: string, email: string, password: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
  verification?: AuthVerificationGateway;
  /** Changes on identity/availability transitions; refresh of the same identity retains its epoch. */
  getSessionEpoch?(): number;
  dispose(): void;
}
export interface AuthVerificationGateway {
  verifyEmail(email: string, code: string): Promise<void>;
  resendConfirmation(email: string): Promise<void>;
  beginRecovery(email: string, code: string): Promise<void>;
  verifyLink(tokenHash: string, purpose: 'signup' | 'recovery'): Promise<void>;
  hasRecoverySession(): boolean;
  recoveryEmail(): string | null;
  completeRecovery(password: string): Promise<void>;
  cancelRecovery(): void;
}
/** Provider IO only; application lifecycle and registration rules belong to the gateway. */
export interface AuthBackend {
  currentIdentity(): AccountIdentity | null;
  observe(changed: () => void, failed: () => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  createAccount(email: string, password: string): Promise<void>;
  updateDisplayName(displayName: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
}
