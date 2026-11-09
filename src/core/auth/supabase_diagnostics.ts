import type { AuthErrorCode } from './types';

export type AuthOperation = 'signup' | 'login' | 'recovery_request' | 'resend_confirmation' | 'verify_email' | 'password_update' | 'logout';
export interface AuthRequestEvidence {
  httpStatus?: number;
  supabaseCode?: string;
  requestId?: string;
  failure?: 'network' | 'timeout' | 'cancelled' | 'invalid_response';
  emailSubmissionFailed?: boolean;
}
export type AuthDiagnosticCategory = AuthErrorCode | 'success' | 'awaiting_confirmation';

// Never turn arbitrary response text, headers or caller data into diagnostic strings.
const providerCodes = new Set(['invalid_credentials', 'user_banned', 'user_not_found', 'email_not_confirmed',
  'email_address_invalid', 'email_address_not_authorized', 'validation_failed', 'weak_password', 'same_password',
  'user_already_exists', 'email_exists', 'over_request_rate_limit', 'over_email_send_rate_limit', 'over_sms_send_rate_limit',
  'otp_expired', 'otp_disabled', 'bad_code_verifier', 'unexpected_failure', 'request_timeout', 'conflict',
  'signup_disabled', 'email_provider_disabled', 'not_admin', 'bad_jwt', 'no_authorization', 'session_not_found']);
const operations = new Set<AuthOperation>(['signup', 'login', 'recovery_request', 'resend_confirmation', 'verify_email', 'password_update', 'logout']);
const categories = new Set<AuthDiagnosticCategory>(['invalid_credentials', 'invalid_email', 'weak_password', 'email_in_use',
  'rate_limit', 'network', 'unavailable', 'busy', 'timeout', 'cancelled', 'validation', 'unauthorized', 'forbidden', 'conflict',
  'server', 'email_submission', 'invalid_response', 'account_created', 'already_signed_in', 'confirmation_required',
  'invalid_code', 'stale_session', 'success', 'awaiting_confirmation']);
export function safeSupabaseCode(value: unknown) { return typeof value === 'string' && providerCodes.has(value) ? value : undefined; }
export function safeHttpStatus(value: unknown) { return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined; }
export function safeRequestId(value: unknown) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}
export function reportAuthDiagnostic(operation: AuthOperation, category: AuthDiagnosticCategory, evidence: AuthRequestEvidence) {
  if (typeof __DEV__ === 'undefined' || !__DEV__ || !operations.has(operation) || !categories.has(category)) return;
  const diagnostic = { operation, category, httpStatus: safeHttpStatus(evidence.httpStatus),
    supabaseCode: safeSupabaseCode(evidence.supabaseCode), requestId: safeRequestId(evidence.requestId) };
  try { console.info('[TopicTrail auth]', diagnostic); } catch { /* Diagnostics cannot alter an auth result. */ }
}
