import { AuthOperationError } from './types';
import { safeHttpStatus, type AuthRequestEvidence } from './supabase_diagnostics';

export function supabaseAuthError(error: unknown, evidence: AuthRequestEvidence = {}): AuthOperationError {
  if (error instanceof AuthOperationError) return error;
  if (evidence.failure) return new AuthOperationError(evidence.failure, 'The account request did not complete.');
  const status = safeHttpStatus(evidence.httpStatus) ?? safeHttpStatus(error && typeof error === 'object' && 'status' in error ? error.status : undefined);
  const code = evidence.supabaseCode ?? (error && typeof error === 'object' && 'code' in error ? error.code : undefined);
  if (status === 429) return new AuthOperationError('rate_limit', 'Too many attempts. Please wait before trying again.');
  if (status === 408 || status === 504 || code === 'request_timeout') return new AuthOperationError('timeout', 'The account request timed out.');
  if (evidence.emailSubmissionFailed || code === 'email_address_not_authorized') {
    return new AuthOperationError('email_submission', 'The account email could not be submitted. Please try again later.');
  }
  if (status && status >= 500) return new AuthOperationError('server', 'TopicTrail authentication service is temporarily unavailable.');
  switch (code) {
    case 'invalid_credentials': case 'user_banned': case 'user_not_found':
      return new AuthOperationError('invalid_credentials', 'Email or password is incorrect.');
    case 'email_not_confirmed':
      return new AuthOperationError('confirmation_required', 'Verify your email before logging in.');
    case 'email_address_invalid':
      return new AuthOperationError('invalid_email', 'Check your email address and try again.');
    case 'weak_password': case 'same_password':
      return new AuthOperationError('weak_password', 'Choose a different, long and unique password.');
    case 'user_already_exists': case 'email_exists':
      return new AuthOperationError('email_in_use', 'This email is already registered. Try logging in.');
    case 'over_request_rate_limit': case 'over_email_send_rate_limit': case 'over_sms_send_rate_limit':
      return new AuthOperationError('rate_limit', 'Too many attempts. Please wait before trying again.');
    case 'otp_expired': case 'otp_disabled': case 'bad_code_verifier':
      return new AuthOperationError('invalid_code', 'This code has expired or is invalid. Request a new code.');
  }
  if (status === 401) return new AuthOperationError('unauthorized', 'The account request could not be authenticated.');
  if (status === 403 || code === 'signup_disabled' || code === 'email_provider_disabled') return new AuthOperationError('forbidden', 'This account action is not permitted right now.');
  if (status === 409 || code === 'conflict') return new AuthOperationError('conflict', 'This account request conflicts with the current account state.');
  if (status === 400 || status === 422 || code === 'validation_failed') return new AuthOperationError('validation', 'Check your account details and try again.');
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  if (name === 'AbortError') return new AuthOperationError('cancelled', 'The account request was interrupted.');
  if (!status && (name === 'AuthRetryableFetchError' || name === 'TypeError')) {
    return new AuthOperationError('network', 'Unable to connect. Check your connection and try again.');
  }
  return new AuthOperationError('unavailable', 'Account services are unavailable. Please try again.');
}

/** Once signup was dispatched, lost/server/email responses cannot prove whether a user was created. */
export function signupOutcomeError(error: AuthOperationError, dispatched: boolean) {
  const ambiguous = dispatched && ['network', 'timeout', 'cancelled', 'server', 'email_submission', 'invalid_response', 'unavailable', 'stale_session'].includes(error.code);
  return ambiguous && !error.ambiguousOutcome ? new AuthOperationError(error.code, error.message, true) : error;
}
