import { safeHttpStatus, safeRequestId, safeSupabaseCode, type AuthRequestEvidence } from './supabase_diagnostics';

/** Only fixed provider phrases identify mail submission; arbitrary SMTP text is never surfaced. */
function emailSubmissionFailure(body: Record<string, unknown>) {
  return [body.msg, body.message, body.error_description].some(value => typeof value === 'string'
    && /^Error sending (confirmation|recovery|magic link|email change|reauthentication) email\.?$/i.test(value.trim()));
}

/** Bounded transport; its observer receives a fresh allowlisted record, never a payload or URL. */
export function createAuthFetch(observe?: (input: RequestInfo | URL, init: RequestInit | undefined, evidence: AuthRequestEvidence) => void, timeoutMs = 20_000): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    let timedOut = false;
    let evidence: AuthRequestEvidence = {};
    const emit = () => { try { observe?.(input, init, evidence); } catch { /* Observers cannot alter transport. */ } };
    const cancel = () => controller.abort();
    if (init?.signal?.aborted) controller.abort();
    init?.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    emit();
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      evidence = { httpStatus: safeHttpStatus(response.status),
        requestId: safeRequestId(response.headers.get('sb-request-id')) ?? safeRequestId(response.headers.get('x-request-id')) };
      emit();
      if (response.status === 204) return response;
      let body: unknown;
      try { body = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        if (response.ok) { evidence.failure = 'invalid_response'; throw new Error('Invalid account response.'); }
      }
      if (controller.signal.aborted) throw new Error('Account request interrupted.');
      if (response.ok) return new Response(JSON.stringify(body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
      if (body && typeof body === 'object') {
        const fields = body as Record<string, unknown>;
        evidence = { ...evidence, supabaseCode: safeSupabaseCode(fields.code) ?? safeSupabaseCode(fields.error_code),
          emailSubmissionFailed: emailSubmissionFailure(fields) };
      }
      emit();
      return new Response(JSON.stringify({ code: evidence.supabaseCode, error_code: evidence.supabaseCode,
        message: 'Account request could not complete.', msg: 'Account request could not complete.', error_description: 'Account request could not complete.' }), {
        status: response.status, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01',
          ...(response.headers.has('retry-after') ? { 'Retry-After': response.headers.get('retry-after')! } : {}) },
      });
    } catch {
      evidence.failure = timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : evidence.failure ?? 'network';
      emit();
      throw new TypeError('Account network request failed.');
    } finally { clearTimeout(timeout); init?.signal?.removeEventListener('abort', cancel); }
  };
}
export const authFetch = createAuthFetch();
