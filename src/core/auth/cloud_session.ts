import { AuthOperationError, type AuthState } from './types';
import type { CloudSession } from '../services/cloud/types';
interface ProviderSession {
  access_token: string; expires_at?: number;
  user: { id: string; email_confirmed_at?: string; is_anonymous?: boolean };
}
interface Options {
  namespace: string; snapshot(): AuthState; epoch(): number; unavailable(): boolean;
  session(): Promise<{ data: { session: ProviderSession | null }; error: unknown }>;
}
/** Only the existing normal session can authorize file IO; email-action clients never reach this capability. */
export function createCloudSessionReader(options: Options): () => Promise<CloudSession | null> {
  return async () => {
    const before = options.snapshot(); const epoch = options.epoch();
    if (options.unavailable()) throw new AuthOperationError('unavailable', 'Cloud account access is unavailable.');
    if (before.status === 'guest') return null;
    if (before.status !== 'account' || !before.account.emailVerified || before.account.projectNamespace !== options.namespace) {
      throw new AuthOperationError('unavailable', 'Cloud account access is unavailable.');
    }
    const result = await options.session(); const after = options.snapshot(); const session = result.data.session;
    if (options.unavailable() || result.error) throw new AuthOperationError('unavailable', 'Cloud account access is unavailable.');
    if (epoch !== options.epoch() || after.status !== 'account' || after.account.uid !== before.account.uid ||
        !session || session.user.id !== before.account.uid || !session.user.email_confirmed_at || session.user.is_anonymous) {
      throw new AuthOperationError('stale_session', 'The account changed. Retry from your current library.');
    }
    if (!session.access_token || !session.expires_at || session.expires_at * 1000 <= Date.now()) {
      throw new AuthOperationError('unavailable', 'Your session expired. Sign in again to sync.');
    }
    return { project: options.namespace, uid: before.account.uid, accessToken: session.access_token };
  };
}
