import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { createSupabaseAuthGateway } from '../src/core/auth/supabase_gateway';
import { validateSupabaseConfiguration } from '../src/core/auth/supabase_config';
import { guardedSessionStorage } from '../src/core/auth/session_storage';
import { captureEmailCallback, clearEmailCallback, getEmailCallback } from '../src/core/auth/email_callback';
import type { AuthGateway, AuthState } from '../src/core/auth/types';

const url = 'https://abcdefghijklmnopqrst.supabase.co';
const key = `sb_publishable_${'x'.repeat(32)}`;
const uid = '00000000-0000-4000-8000-000000000001';
const otherUid = '00000000-0000-4000-8000-000000000002';
const email = 'student@example.test';
function user(id = uid, confirmed = true): User {
  return { id, email, aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString(),
    email_confirmed_at: confirmed ? new Date().toISOString() : undefined, app_metadata: { provider: 'email' }, user_metadata: { display_name: 'Student' } };
}
function session(id = uid, confirmed = true): Session {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const payload = { sub: id, exp: expires, iat: expires - 3600, aud: 'authenticated', role: 'authenticated' };
  const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url'), 'fictional-signature'].join('.');
  return { access_token: jwt, refresh_token: `fictional-refresh-${id}`, expires_in: 3600, expires_at: expires, token_type: 'bearer', user: user(id, confirmed) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function stateIs(gateway: AuthGateway, status: AuthState['status']) {
  if (gateway.getSnapshot().status === status) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { detach(); reject(Error(`Expected ${status}; found ${gateway.getSnapshot().status}`)); }, 3000);
    const detach = gateway.subscribe(state => { if (state.status === status) { clearTimeout(timeout); queueMicrotask(() => { detach(); resolve(); }); } });
  });
}
async function fixture(t: TestContext, persisted = new Map<string, string>()) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let reply: ((path: string, body: Record<string, unknown>) => Promise<Response | undefined>) | undefined;
  const clients: SupabaseClient[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const parsed = new URL(String(input)); const path = parsed.pathname.replace('/auth/v1', '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ path, body });
    const override = await reply?.(path, body); if (override) return override;
    if (path === '/token' || path === '/verify') return Response.json(session());
    if (path === '/signup') return Response.json(user());
    if (path === '/user') return Response.json(user());
    if (path === '/recover' || path === '/resend' || path === '/logout') return Response.json({});
    throw Error(`Unexpected synthetic endpoint ${path}`);
  };
  const persistence = guardedSessionStorage({ getItem: k => persisted.get(k) ?? null,
    setItem: (k, v) => { persisted.set(k, v); }, removeItem: k => { persisted.delete(k); } });
  const create = (temporary = false) => {
    const client = createClient(url, key, { global: { fetch: fetcher }, auth: {
      storageKey: temporary ? `fixture-email-${clients.length}` : 'fixture-main',
      storage: temporary ? undefined : persistence.storage, persistSession: !temporary, autoRefreshToken: false, detectSessionInUrl: false,
    } }); clients.push(client); return client;
  };
  const main = create();
  let clock = Date.now();
  const gateway = createSupabaseAuthGateway({ main: main.auth, temporary: () => create(true).auth, namespace: 'abcdefghijklmnopqrst',
    command: action => action(), callbackUrl: () => 'http://localhost:8081/auth/callback', now: () => clock, storageFailed: persistence.hasFailed,
    cleanup: () => { void persistence.close(); },
  });
  t.after(async () => { gateway.dispose(); await Promise.all(clients.map(client => client.auth.dispose())); });
  await stateIs(gateway, persisted.size ? 'account' : 'guest');
  return { gateway, main, persisted, requests, clients, respond: (handler: typeof reply) => { reply = handler; }, advance: (ms: number) => { clock += ms; } };
}
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;

test('Supabase config accepts public hosted settings and rejects secrets, injected URLs and missing values without echoing them', () => {
  assert.deepEqual(validateSupabaseConfiguration(url + '/', key), { url, publishableKey: key, namespace: 'abcdefghijklmnopqrst' });
  for (const [u, k] of [[undefined, key], [url, undefined], [url, 'sb_secret_private'], ['http://' + url.slice(8), key],
    [url + '/rest/v1', key], [url + '?token=private', key], ['https://abcdefghijklmnopqrst.supabase.co.evil.test', key],
    [url.replace('https://', 'https://secret@'), key]]) {
    assert.throws(() => validateSupabaseConfiguration(u, k), error => hasCode('unavailable')(error) && !String(error).includes('private'));
  }
});
test('real SDK hydrates guest without network, signs in explicitly, persists and logs out locally', async t => {
  const f = await fixture(t); assert.equal(f.requests.length, 0);
  await f.gateway.signIn(` ${email} `, '  fictional pass phrase  ');
  const state = f.gateway.getSnapshot(); assert.equal(state.status, 'account');
  if (state.status === 'account') { assert.equal(state.account.uid, uid); assert.equal(state.account.projectNamespace, 'abcdefghijklmnopqrst'); assert.equal(state.account.emailVerified, true); }
  assert.deepEqual(f.requests[0].body, { email, password: '  fictional pass phrase  ', gotrue_meta_security: {} });
  assert.ok(f.persisted.has('fixture-main'));
  await f.gateway.signOut(); assert.equal(f.gateway.getSnapshot().status, 'guest'); assert.equal(f.persisted.has('fixture-main'), false);
});
test('persisted normal login restores in a new SDK client without a new credential request', async t => {
  const f = await fixture(t); await f.gateway.signIn(email, 'fictional');
  f.gateway.dispose();
  const second = await fixture(t, f.persisted);
  assert.equal(second.gateway.getSnapshot().status, 'account'); assert.equal(second.requests.length, 0);
});
test('invalid credentials and confirmation-required responses are sanitized', async t => {
  const f = await fixture(t);
  for (const [provider, code] of [['invalid_credentials', 'invalid_credentials'], ['email_not_confirmed', 'confirmation_required'], ['over_request_rate_limit', 'rate_limit']]) {
    f.respond(async () => Response.json({ code: provider, msg: 'PRIVATE raw provider detail' }, { status: 400, headers: { 'x-supabase-api-version': '2024-01-01' } }));
    await assert.rejects(f.gateway.signIn(email, 'wrong'), error => hasCode(code)(error) && !String(error).includes('PRIVATE'));
    assert.equal(f.gateway.getSnapshot().status, 'guest');
  }
});
test('registration metadata and confirmation use isolated SDK sessions and never persist or publish an account', async t => {
  const f = await fixture(t); const states: string[] = []; f.gateway.subscribe(value => states.push(value.status));
  await f.gateway.register(' Student ', ` ${email} `, 'fictional');
  assert.equal(f.gateway.getSnapshot().status, 'guest'); assert.equal(f.persisted.size, 0); assert.ok(!states.includes('account'));
  assert.equal(f.clients.length, 2);
  assert.deepEqual((f.requests[0].body.data as object), { display_name: 'Student' });
  await f.gateway.verification!.verifyEmail(email, '123456');
  assert.equal(f.gateway.getSnapshot().status, 'guest'); assert.equal(f.persisted.size, 0);
  assert.ok(f.requests.some(request => request.path === '/verify' && request.body.type === 'signup'));
});
test('a server that disables confirmation cannot automatically sign the app in during registration', async t => {
  const f = await fixture(t);
  f.respond(async path => path === '/signup' ? Response.json(session()) : undefined);
  await assert.rejects(f.gateway.register('Student', email, 'fictional'), hasCode('account_created'));
  assert.equal(f.gateway.getSnapshot().status, 'guest'); assert.equal(f.persisted.size, 0);
});
test('registration and sign-in cannot replace an already signed-in account', async t => {
  const f = await fixture(t); await f.gateway.signIn(email, 'fictional'); const count = f.requests.length;
  await assert.rejects(f.gateway.register('Other', email, 'fictional'), hasCode('already_signed_in'));
  await assert.rejects(f.gateway.signIn('other@example.test', 'fictional'), hasCode('already_signed_in'));
  assert.equal(f.requests.length, count);
});
test('expired or malformed email codes cannot grant a recovery session', async t => {
  const f = await fixture(t);
  await assert.rejects(f.gateway.verification!.beginRecovery(email, 'bad'), hasCode('invalid_code'));
  assert.equal(f.requests.length, 0);
  f.respond(async path => path === '/verify' ? Response.json({ code: 'otp_expired', msg: 'PRIVATE' }, { status: 403, headers: { 'x-supabase-api-version': '2024-01-01' } }) : undefined);
  await assert.rejects(f.gateway.verification!.beginRecovery(email, '123456'), hasCode('invalid_code'));
  assert.equal(f.gateway.verification!.hasRecoverySession(), false); assert.equal(f.persisted.size, 0);
});
test('password recovery requires a verified temporary session, preserves password bytes and ends without library sign-in', async t => {
  const f = await fixture(t); const verify = f.gateway.verification!;
  await assert.rejects(verify.completeRecovery('fictional'), hasCode('invalid_code'));
  await f.gateway.sendPasswordReset(email); assert.equal(f.persisted.size, 0);
  await verify.beginRecovery(email, '123456'); assert.equal(verify.hasRecoverySession(), true);
  assert.equal(verify.recoveryEmail(), email);
  assert.equal(f.gateway.getSnapshot().status, 'guest'); assert.equal(f.persisted.size, 0);
  await verify.completeRecovery('  new fictional password  ');
  assert.ok(f.requests.some(request => request.path === '/user' && request.body.password === '  new fictional password  '));
  assert.equal(verify.hasRecoverySession(), false); assert.equal(f.gateway.getSnapshot().status, 'guest'); assert.equal(f.persisted.size, 0);
});
test('email actions cannot replace an unrelated signed-in account or its persisted tokens', async t => {
  const f = await fixture(t); f.respond(async path => path === '/token' ? Response.json(session(otherUid)) : undefined);
  await f.gateway.signIn('other@example.test', 'fictional'); const original = f.persisted.get('fixture-main');
  await f.gateway.verification!.beginRecovery(email, '123456'); await f.gateway.verification!.completeRecovery('fictional new');
  assert.equal(f.persisted.get('fixture-main'), original);
  const state = f.gateway.getSnapshot(); assert.equal(state.status === 'account' && state.account.uid, otherUid);
});
test('recovery expires and cancelled in-flight verification cannot revive it', async t => {
  const f = await fixture(t); const verify = f.gateway.verification!;
  await verify.beginRecovery(email, '123456'); f.advance(600_001);
  await assert.rejects(verify.completeRecovery('fictional'), hasCode('invalid_code'));
  const entered = deferred<void>(); const response = deferred<Response>();
  f.respond(async path => { if (path !== '/verify') return; entered.resolve(); return response.promise; });
  const pending = verify.beginRecovery(email, '123456'); await entered.promise; verify.cancelRecovery(); response.resolve(Response.json(session()));
  await assert.rejects(pending, hasCode('stale_session')); assert.equal(verify.hasRecoverySession(), false);
});
test('sign-out advances the session epoch, cancels recovery and a subsequent account has a different epoch', async t => {
  const f = await fixture(t); const initial = f.gateway.getSessionEpoch!(); await f.gateway.signIn(email, 'fictional');
  const signedIn = f.gateway.getSessionEpoch!(); assert.ok(signedIn > initial);
  await f.gateway.verification!.beginRecovery(email, '123456'); await f.gateway.signOut();
  assert.ok(f.gateway.getSessionEpoch!() > signedIn); assert.equal(f.gateway.verification!.hasRecoverySession(), false);
  f.respond(async path => path === '/token' ? Response.json(session(otherUid)) : undefined);
  await f.gateway.signIn(email, 'fictional'); assert.ok(f.gateway.getSessionEpoch!() > signedIn + 1);
});
test('duplicate auth actions are rejected while a credential request is pending', async t => {
  const f = await fixture(t); const entered = deferred<void>(); const response = deferred<Response>();
  f.respond(async path => { if (path !== '/token') return; entered.resolve(); return response.promise; });
  const pending = f.gateway.signIn(email, 'fictional'); await entered.promise;
  await assert.rejects(f.gateway.signIn(email, 'fictional'), hasCode('busy'));
  response.resolve(Response.json(session())); await pending;
  assert.equal(f.requests.filter(request => request.path === '/token').length, 1);
});
test('storage failures are sanitized and fenced; a disposed writer cannot persist a late login', async () => {
  let writes = 0;
  const bad = guardedSessionStorage({ getItem() { throw Error('PRIVATE storage location'); }, setItem() {}, removeItem() {} });
  await assert.rejects(bad.storage.getItem('session'), error => hasCode('unavailable')(error) && !String(error).includes('PRIVATE'));
  assert.equal(bad.hasFailed(), true);
  const storage = guardedSessionStorage({ getItem: () => null, setItem() { writes++; }, removeItem() {} });
  const pending = storage.storage.setItem('session', 'fictional'); await storage.close();
  await assert.rejects(pending, hasCode('unavailable')); assert.equal(writes, 0);
  await assert.rejects(storage.storage.setItem('session', 'late'), hasCode('unavailable')); assert.equal(writes, 0);
});
test('callback parsing retains only allowed one-time hashes and rejects ambiguous parameters and bearer sessions', () => {
  clearEmailCallback(); const token = 'a'.repeat(64);
  assert.equal(captureEmailCallback(`topictrail://auth/callback?type=recovery&token_hash=${token}`), true);
  assert.deepEqual(getEmailCallback(), { purpose: 'recovery', tokenHash: token });
  assert.equal(captureEmailCallback(`https://localhost:8081/auth/callback?type=signup&type=recovery&token_hash=${token}`), true);
  assert.equal(getEmailCallback(), undefined);
  assert.equal(captureEmailCallback('http://localhost:8081/auth/callback#access_token=PRIVATE&refresh_token=PRIVATE&type=recovery'), true);
  assert.equal(getEmailCallback(), undefined);
  assert.equal(captureEmailCallback(`topictrail://other/callback?type=recovery&token_hash=${token}`), false);
});
test('mismatched verified email cannot authorize a password reset for a different account', async t => {
  const f = await fixture(t);
  await assert.rejects(f.gateway.verification!.beginRecovery('someone-else@example.test', '123456'), hasCode('unavailable'));
  assert.equal(f.gateway.verification!.hasRecoverySession(), false); assert.equal(f.gateway.verification!.recoveryEmail(), null);
  assert.ok(!f.requests.some(request => request.path === '/user'));
});
test('unconfirmed or anonymous provider session never grants account entry', async t => {
  const f = await fixture(t);
  f.respond(async path => path === '/token' ? Response.json(session(uid, false)) : undefined);
  await assert.rejects(f.gateway.signIn(email, 'fictional'), hasCode('unavailable'));
  assert.equal(f.gateway.getSnapshot().status, 'unavailable');
  await f.gateway.signOut(); assert.equal(f.gateway.getSnapshot().status, 'guest');
});
test('another account arriving during signup cannot turn signup success into a request to sign that account out', async t => {
  const f = await fixture(t); const entered = deferred<void>(); const response = deferred<Response>();
  f.respond(async path => {
    if (path === '/signup') { entered.resolve(); return response.promise; }
    if (path === '/token') return Response.json(session(otherUid));
  });
  const registration = f.gateway.register('Student', email, 'fictional'); await entered.promise;
  await f.main.auth.signInWithPassword({ email, password: 'fictional other-tab command' }); await stateIs(f.gateway, 'account');
  response.resolve(Response.json(user()));
  await assert.rejects(registration, hasCode('stale_session'));
  const state = f.gateway.getSnapshot(); assert.equal(state.status === 'account' && state.account.uid, otherUid);
  assert.equal(f.requests.filter(request => request.path === '/logout').length, 0);
});
test('storage failure after a write cannot report confirmed guest or login success', async t => {
  const persisted = new Map<string, string>();
  const storage = guardedSessionStorage({ getItem: k => persisted.get(k) ?? null, removeItem: k => { persisted.delete(k); },
    setItem(k, v) { persisted.set(k, v); throw Error('uncertain native write'); } });
  const main = createClient(url, key, { auth: { storageKey: 'uncertain-write', storage: storage.storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async () => Response.json(session()) } });
  const gateway = createSupabaseAuthGateway({ main: main.auth, namespace: 'abcdefghijklmnopqrst', command: action => action(),
    callbackUrl: () => 'http://localhost:8081/auth/callback', temporary: () => { throw Error('not needed'); }, storageFailed: storage.hasFailed });
  t.after(async () => { gateway.dispose(); await main.auth.dispose(); });
  await stateIs(gateway, 'guest'); await assert.rejects(gateway.signIn(email, 'fictional'), hasCode('unavailable'));
  assert.equal(gateway.getSnapshot().status, 'unavailable'); assert.ok(persisted.has('uncertain-write'), 'uncertain persisted data is not wiped');
});
test('oversized email callbacks are scrubbed and cannot reuse an earlier action', () => {
  assert.equal(captureEmailCallback(`topictrail://auth/callback?type=signup&token_hash=${'a'.repeat(64)}`), true);
  assert.ok(getEmailCallback());
  assert.equal(captureEmailCallback('topictrail://auth/callback?token_hash=' + 'a'.repeat(20_000)), true);
  assert.equal(getEmailCallback(), undefined);
});
