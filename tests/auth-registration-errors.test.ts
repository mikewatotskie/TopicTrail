import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthApiError, AuthRetryableFetchError, createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAuthError } from '../src/core/auth/supabase_errors';
import { createAuthTransport } from '../src/core/auth/supabase_transport';
import { createSupabaseAuthGateway } from '../src/core/auth/supabase_gateway';
import { reportAuthDiagnostic } from '../src/core/auth/supabase_diagnostics';
import { AuthOperationError, type AuthGateway } from '../src/core/auth/types';
import { createAuthFetch } from '../src/core/auth/supabase_fetch';
import type { AuthRequestEvidence } from '../src/core/auth/supabase_diagnostics';

test('installed SDK HTTP500/502 errors are server failures, not connectivity failures', () => {
  for (const status of [500, 502]) {
    const mapped = supabaseAuthError(new AuthRetryableFetchError('PRIVATE provider detail', status));
    assert.equal(mapped.code, 'server');
    assert.doesNotMatch(mapped.message, /PRIVATE/);
  }
});

const fixtureUser = { id: '00000000-0000-4000-8000-000000000001', email: 'fixture@example.invalid', aud: 'authenticated',
  role: 'authenticated', created_at: '2026-11-09T00:00:00Z', app_metadata: { provider: 'email' }, user_metadata: {} };
const requestId = '00000000-0000-4000-8000-000000000002';
async function fixture(reply: typeof fetch, run: (f: { gateway: AuthGateway; requests: string[] }) => Promise<void>, timeoutMs = 20_000) {
  const original = globalThis.fetch;
  const requests: string[] = [];
  const clients: SupabaseClient[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    assert.ok(path.startsWith('/auth/v1/')); requests.push(path);
    return reply(input, init);
  };
  const make = () => {
    const transport = createAuthTransport(timeoutMs);
    const client = createClient('https://fixture.example.invalid', 'synthetic-public-key', { global: { fetch: transport.fetch }, auth: {
      storageKey: 'registration-fixture-' + clients.length, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false,
    } });
    clients.push(client); return transport.wrap(client.auth);
  };
  const gateway = createSupabaseAuthGateway({ main: make(), temporary: make, namespace: 'fixture', callbackUrl: () => 'topictrail://auth/callback', command: action => action() });
  try { await run({ gateway, requests }); }
  finally { gateway.dispose(); await Promise.all(clients.map(client => client.auth.dispose())); globalThis.fetch = original; }
}

for (const [status, body, expected, ambiguous] of [
  [400, { code: 'validation_failed' }, 'validation', false],
  [401, {}, 'unauthorized', false], [403, {}, 'forbidden', false], [409, {}, 'conflict', false],
  [429, { code: 'over_email_send_rate_limit' }, 'rate_limit', false],
  [500, { code: 'unexpected_failure', msg: 'PRIVATE database detail' }, 'server', true],
  [502, { message: 'PRIVATE upstream detail' }, 'server', true],
  [422, { code: 'user_already_exists' }, 'email_in_use', false],
  [500, { code: 'unexpected_failure', msg: 'Error sending confirmation email' }, 'email_submission', true],
  [400, { code: 'email_address_not_authorized' }, 'email_submission', true],
] as const) {
  test(`production transport + installed SDK signup ${status}/${expected}: safe category, guest retained, no automatic retry`, async () => {
    await fixture(async () => Response.json(body, { status }), async ({ gateway, requests }) => {
      await assert.rejects(gateway.register('Fixture', 'fixture@example.invalid', 'PRIVATE password'), error => {
        assert.ok(error instanceof AuthOperationError); assert.equal(error.code, expected); assert.equal(error.ambiguousOutcome, ambiguous);
        assert.doesNotMatch(error.message, /PRIVATE|smtp\.gmail|password/); return true;
      });
      await Promise.resolve();
      assert.equal(gateway.getSnapshot().status, 'guest'); assert.deepEqual(requests, ['/auth/v1/signup']);
    });
  });
}

test('successful unconfirmed signup resolves with guest state and exactly one request', async () => {
  await fixture(async () => Response.json(fixtureUser), async ({ gateway, requests }) => {
    await gateway.register('Fixture', 'fixture@example.invalid', 'PRIVATE password');
    assert.equal(gateway.getSnapshot().status, 'guest'); assert.deepEqual(requests, ['/auth/v1/signup']);
  });
});
test('actual fetch rejection is network and signup outcome remains uncertain', async () => {
  await fixture(async () => { throw new TypeError('PRIVATE URL/header/password'); }, async ({ gateway, requests }) => {
    await assert.rejects(gateway.register('Fixture', 'fixture@example.invalid', 'PRIVATE'), error => error instanceof AuthOperationError && error.code === 'network' && error.ambiguousOutcome);
    assert.equal(requests.length, 1);
  });
});
test('request deadline is timeout, not network, with one ambiguous signup and no background retry', async () => {
  await fixture(async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new DOMException('PRIVATE', 'AbortError')), { once: true });
  }), async ({ gateway, requests }) => {
    await assert.rejects(gateway.register('Fixture', 'fixture@example.invalid', 'PRIVATE'), error => error instanceof AuthOperationError && error.code === 'timeout' && error.ambiguousOutcome);
    assert.equal(requests.length, 1); assert.equal(gateway.getSnapshot().status, 'guest');
  }, 5);
});
test('the transport deadline also bounds a stalled response body and retains received HTTP evidence', async () => {
  const original = globalThis.fetch;
  const observed: AuthRequestEvidence[] = [];
  try {
    globalThis.fetch = async (_input, init) => {
      const response = new Response(null, { status: 500, headers: { 'sb-request-id': requestId } });
      response.json = () => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('PRIVATE body error', 'AbortError')), { once: true });
      });
      return response;
    };
    await assert.rejects(createAuthFetch((_input, _init, evidence) => observed.push({ ...evidence }), 5)('https://fixture.example.invalid/auth/v1/signup'));
    assert.deepEqual(observed.at(-1), { httpStatus: 500, requestId, failure: 'timeout' });
  } finally { globalThis.fetch = original; }
});
test('caller cancellation is distinct from timeout and does not expose the abort reason', async () => {
  const original = globalThis.fetch;
  const observed: AuthRequestEvidence[] = [];
  const caller = new AbortController();
  try {
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('PRIVATE reason', 'AbortError')), { once: true });
      caller.abort('PRIVATE reason');
    });
    await assert.rejects(createAuthFetch((_input, _init, evidence) => observed.push({ ...evidence }))('https://fixture.example.invalid/auth/v1/signup', { signal: caller.signal }),
      error => !String(error).includes('PRIVATE'));
    assert.deepEqual(observed.at(-1), { failure: 'cancelled' });
  } finally { globalThis.fetch = original; }
});
test('unreadable or malformed HTTP200 signup is uncertain invalid-response rather than fake success', async () => {
  for (const reply of [() => new Response('PRIVATE invalid JSON'), () => Response.json({})]) {
    await fixture(async () => reply(), async ({ gateway }) => {
      await assert.rejects(gateway.register('Fixture', 'fixture@example.invalid', 'PRIVATE'), error => error instanceof AuthOperationError && error.code === 'invalid_response' && error.ambiguousOutcome);
      assert.equal(gateway.getSnapshot().status, 'guest');
    });
  }
});
test('recovery preserves neutral missing-user acknowledgement and classifies email failure without signup claims', async () => {
  let mailFailure = false;
  await fixture(async () => mailFailure
    ? Response.json({ code: 'unexpected_failure', msg: 'Error sending recovery email' }, { status: 500 })
    : Response.json({ code: 'user_not_found' }, { status: 400 }), async ({ gateway }) => {
    await gateway.sendPasswordReset('fixture@example.invalid');
    await gateway.verification!.resendConfirmation('fixture@example.invalid');
    mailFailure = true;
    await assert.rejects(gateway.sendPasswordReset('fixture@example.invalid'), error => error instanceof AuthOperationError && error.code === 'email_submission' && !error.ambiguousOutcome);
    assert.equal(gateway.getSnapshot().status, 'guest');
  });
});
test('development diagnostics preserve only allowlisted fields and never raw bodies or identities', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
  const info = console.info; const entries: unknown[][] = [];
  Object.defineProperty(globalThis, '__DEV__', { value: true, configurable: true });
  console.info = (...args) => { entries.push(args); };
  try {
    await fixture(async () => Response.json({ code: 'unexpected_failure', message: 'PRIVATE password email token SMTP details' },
      { status: 500, headers: { 'sb-request-id': requestId, 'authorization': 'PRIVATE bearer' } }), async ({ gateway }) => {
      await assert.rejects(gateway.register('PRIVATE name', 'private@example.invalid', 'PRIVATE password'));
    });
    assert.deepEqual(entries, [['[TopicTrail auth]', { operation: 'signup', category: 'server', httpStatus: 500, supabaseCode: 'unexpected_failure', requestId }]]);
    assert.doesNotMatch(JSON.stringify(entries), /PRIVATE|example|bearer/);
    entries.length = 0;
    reportAuthDiagnostic('signup', 'server', { httpStatus: 500, supabaseCode: 'private_token_as_code', requestId: 'PRIVATE' });
    assert.deepEqual(entries, [['[TopicTrail auth]', { operation: 'signup', category: 'server', httpStatus: 500, supabaseCode: undefined, requestId: undefined }]]);
    entries.length = 0;
    Object.defineProperty(globalThis, '__DEV__', { value: false, configurable: true });
    reportAuthDiagnostic('signup', 'server', { httpStatus: 500, requestId }); assert.deepEqual(entries, []);
  } finally { console.info = info; if (before) Object.defineProperty(globalThis, '__DEV__', before); else Reflect.deleteProperty(globalThis, '__DEV__'); }
});
test('a new explicit attempt never inherits a previous request ID or mail-submission category', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
  const info = console.info; const entries: Record<string, unknown>[] = [];
  Object.defineProperty(globalThis, '__DEV__', { value: true, configurable: true });
  console.info = (_label, value) => { entries.push(value); };
  let calls = 0;
  try {
    await fixture(async () => ++calls === 1 ? Response.json({ msg: 'Error sending confirmation email' }, { status: 500, headers: { 'sb-request-id': requestId } })
      : Response.json({ code: 'validation_failed' }, { status: 400 }), async ({ gateway, requests }) => {
      await assert.rejects(gateway.register('Fixture', 'fixture@example.invalid', 'PRIVATE'));
      assert.equal(requests.length, 1);
      await assert.rejects(gateway.register('Fixture', 'fixture@example.invalid', 'PRIVATE'));
      assert.equal(requests.length, 2);
    });
    assert.equal(entries[0].category, 'email_submission'); assert.equal(entries[0].requestId, requestId);
    assert.equal(entries[1].category, 'validation'); assert.equal(entries[1].requestId, undefined);
  } finally { console.info = info; if (before) Object.defineProperty(globalThis, '__DEV__', before); else Reflect.deleteProperty(globalThis, '__DEV__'); }
});
test('unrelated refresh and another SDK client cannot replace an in-flight signup diagnostic', async () => {
  const originalFetch = globalThis.fetch;
  const originalDev = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
  const originalInfo = console.info;
  const entries: Record<string, unknown>[] = [];
  const clients: SupabaseClient[] = [];
  Object.defineProperty(globalThis, '__DEV__', { value: true, configurable: true });
  console.info = (_label, value) => { entries.push(value); };
  let signups = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/token')) return Response.json({ code: 'unexpected_failure' }, { status: 503 });
    assert.ok(url.pathname.endsWith('/signup'));
    return ++signups === 1
      ? Response.json({ code: 'unexpected_failure', msg: 'Error sending confirmation email' }, { status: 500, headers: { 'sb-request-id': requestId } })
      : Response.json({ code: 'validation_failed' }, { status: 400 });
  };
  function make() {
    const transport = createAuthTransport();
    const client = createClient('https://fixture.example.invalid', 'synthetic-public-key', { global: { fetch: transport.fetch }, auth: {
      storageKey: 'correlation-fixture-' + clients.length, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    } });
    clients.push(client); return { client, transport };
  }
  try {
    const first = make(); const second = make();
    await Promise.all(clients.map(client => client.auth.initialize()));
    const originalSignup = first.client.auth.signUp.bind(first.client.auth);
    const secondPort = second.transport.wrap(second.client.auth);
    first.client.auth.signUp = async args => {
      const result = await originalSignup(args);
      await first.transport.fetch('https://fixture.example.invalid/auth/v1/token?grant_type=refresh_token', { method: 'POST' });
      await assert.rejects(secondPort.signUp(args), error => error instanceof AuthOperationError && error.code === 'validation');
      return result;
    };
    await assert.rejects(first.transport.wrap(first.client.auth).signUp({ email: 'fixture@example.invalid', password: 'PRIVATE' }),
      error => error instanceof AuthOperationError && error.code === 'email_submission' && error.ambiguousOutcome);
    assert.deepEqual(entries.map(({ category, httpStatus, requestId }) => ({ category, httpStatus, requestId })), [
      { category: 'validation', httpStatus: 400, requestId: undefined },
      { category: 'email_submission', httpStatus: 500, requestId },
    ]);
    assert.equal(signups, 2, 'Only the two explicitly invoked fixture signups run');
  } finally {
    await Promise.all(clients.map(client => client.auth.dispose())); globalThis.fetch = originalFetch; console.info = originalInfo;
    if (originalDev) Object.defineProperty(globalThis, '__DEV__', originalDev); else Reflect.deleteProperty(globalThis, '__DEV__');
  }
});
test('HTTP validation, authorization, conflict and rate-limit categories remain distinct', () => {
  for (const [status, expected] of [[400, 'validation'], [401, 'unauthorized'], [403, 'forbidden'], [409, 'conflict'], [429, 'rate_limit']] as const) {
    assert.equal(supabaseAuthError(new AuthApiError('PRIVATE', status, undefined)).code, expected);
  }
});
