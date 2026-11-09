import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import type { AuthGateway, AuthState } from '../src/core/auth/types';
import { redirectSystemPath } from '../src/app/+native-intent';
import { clearEmailCallback, getEmailCallback } from '../src/core/auth/email_callback';

// Real production native factory/adapter + installed SDK; native IO and provider HTTP are synthetic.
// These tests do not execute Android Keystore or establish phone acceptance.
const namespace = 'abcdefghijklmnopqrst';
const key = `tt.sb.${namespace}.auth.v1`;
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
function session(uid = first, revision = 0): Session {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const access = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: uid, exp: expires, iat: expires - 3600 })).toString('base64url'), 'synthetic'].join('.');
  return { access_token: access, refresh_token: `synthetic-${uid}-${revision}`, expires_in: 3600, expires_at: expires,
    token_type: 'bearer', user: { id: uid, email: 'native@example.test', aud: 'authenticated', role: 'authenticated',
      created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function stateIs(gateway: AuthGateway, expected: AuthState['status']) {
  if (gateway.getSnapshot().status === expected) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { detach(); reject(Error('Expected authentication state was not observed')); }, 3000);
    const detach = gateway.subscribe(state => { if (state.status === expected) { clearTimeout(timer); queueMicrotask(() => { detach(); resolve(); }); } });
  });
}
const unavailable = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'unavailable';
test('native signup response classification does not alter SecureStore or grant a session', async t => {
  const f = await fixture(t); const gateway = f.open(); await stateIs(gateway, 'guest');
  f.values.set('unrelated', 'preserved');
  f.respond(async url => url.pathname.endsWith('/signup') ? Response.json({ code: 'unexpected_failure', msg: 'Error sending confirmation email' }, { status: 500 }) : undefined);
  await assert.rejects(gateway.register('Fixture', 'fixture@example.test', 'synthetic'), error => !!error && typeof error === 'object'
    && 'code' in error && error.code === 'email_submission' && 'ambiguousOutcome' in error && error.ambiguousOutcome === true);
  assert.deepEqual([...f.values], [['unrelated', 'preserved']]); assert.equal(gateway.getSnapshot().status, 'guest');
  f.respond(async url => url.pathname.endsWith('/signup') ? Response.json({ ...session().user, email_confirmed_at: undefined }) : undefined);
  await gateway.register('Fixture', 'fixture@example.test', 'synthetic');
  assert.deepEqual([...f.values], [['unrelated', 'preserved']]); assert.equal(gateway.getSnapshot().status, 'guest');
});
test('native local logout still succeeds after an offline remote revocation failure', async t => {
  const f = await fixture(t); const gateway = f.open(); await stateIs(gateway, 'guest');
  await gateway.signIn('fixture@example.test', 'synthetic');
  f.respond(async url => { if (url.pathname.endsWith('/logout')) throw new TypeError('synthetic offline'); return undefined; });
  await gateway.signOut(); assert.equal(gateway.getSnapshot().status, 'guest'); assert.equal(f.values.has(key), false);
});
async function fixture(t: TestContext) {
  const values = new Map<string, string>();
  const requests: { path: string; refresh: boolean; callbackMatches: boolean; refreshMatches: boolean }[] = [];
  const clients: SupabaseClient[] = []; const gateways: AuthGateway[] = [];
  const listeners = new Set<(state: string) => void>();
  let available = true; let loseWrite = false; let denyDelete = false; let uid = first; let revision = 0;
  let reply: ((url: URL) => Promise<Response | undefined>) | undefined;
  const secure = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
    async isAvailableAsync() { return available; },
    async getItemAsync(storageKey: string) { return values.get(storageKey) ?? null; },
    async setItemAsync(storageKey: string, value: string, options: { keychainService?: string }) {
      assert.equal(options.keychainService, 'topictrail.supabase.auth');
      if (!loseWrite) values.set(storageKey, value);
    },
    async deleteItemAsync(storageKey: string) { if (denyDelete) throw Error('synthetic private native detail'); values.delete(storageKey); },
  };
  const originalFetch = globalThis.fetch;
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__ttAndroidAuth');
  const native = { secure, AppState: { currentState: 'background', addEventListener(_name: string, listener: (state: string) => void) {
    listeners.add(listener); return { remove() { listeners.delete(listener); } };
  } }, createClient: (...args: Parameters<typeof createClient>) => { const client = createClient(...args); clients.push(client); return client; } };
  Object.defineProperty(globalThis, '__ttAndroidAuth', { value: native, configurable: true });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, `https://${namespace}.supabase.co`, 'No live provider endpoint is allowed');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const refresh = url.searchParams.get('grant_type') === 'refresh_token';
    requests.push({ path: url.pathname, refresh, callbackMatches: url.searchParams.get('redirect_to') === 'topictrail://auth/callback',
      refreshMatches: refresh && body.refresh_token === session(uid, revision).refresh_token });
    const custom = await reply?.(url); if (custom) return custom;
    if (url.pathname.endsWith('/token') || url.pathname.endsWith('/verify')) return Response.json(session(uid, refresh ? ++revision : revision));
    if (url.pathname.endsWith('/user')) return Response.json(session(uid).user);
    return Response.json({});
  };
  const bundled = await build({ entryPoints: ['src/core/auth/supabase_client.ts'], bundle: true, platform: 'node', format: 'cjs',
    write: false, packages: 'external', metafile: true, plugins: [{ name: 'android-native-io', setup(builder) {
      builder.onResolve({ filter: /^(react-native|react-native-url-polyfill\/auto|expo-secure-store|@supabase\/supabase-js)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'react-native'
        ? 'export const AppState=globalThis.__ttAndroidAuth.AppState;'
        : args.path === 'expo-secure-store' ? 'export const {WHEN_UNLOCKED_THIS_DEVICE_ONLY,isAvailableAsync,getItemAsync,setItemAsync,deleteItemAsync}=globalThis.__ttAndroidAuth.secure;'
          : args.path === '@supabase/supabase-js' ? 'export const createClient=globalThis.__ttAndroidAuth.createClient;' : 'export {};', loader: 'js' }));
    } }] });
  assert.ok(!Object.keys(bundled.metafile!.inputs).some(path => /async-storage/i.test(path)), 'No plaintext session dependency');
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(resolve('package.json')), compiled, compiled.exports);
  const factory = compiled.exports as typeof import('../src/core/auth/supabase_client');
  function open() {
    const gateway = factory.createSupabaseSession({ url: `https://${namespace}.supabase.co`, publishableKey: 'sb_publishable_' + 'x'.repeat(32), namespace });
    gateways.push(gateway); return gateway;
  }
  t.after(async () => {
    gateways.forEach(gateway => gateway.dispose()); await Promise.all(clients.map(client => client.auth.dispose()));
    globalThis.fetch = originalFetch;
    if (previous) Object.defineProperty(globalThis, '__ttAndroidAuth', previous); else Reflect.deleteProperty(globalThis, '__ttAndroidAuth');
  });
  return { open, values, clients, requests, listeners, setAvailable: (value: boolean) => { available = value; },
    loseWrites: () => { loseWrite = true; }, denyDeletes: () => { denyDelete = true; },
    account: (value: string) => { uid = value; }, respond: (value: typeof reply) => { reply = value; },
    activity: (value: string) => { for (const listener of listeners) listener(value); } };
}

test('native factory persists, restores, rotates refresh token and logs out without touching unrelated SecureStore entries', async t => {
  const f = await fixture(t); f.values.set('unrelated-owner', 'retained');
  const a = f.open(); await stateIs(a, 'guest'); assert.equal(f.requests.length, 0);
  await a.signIn('native@example.test', 'synthetic'); assert.ok(f.values.has(key));
  a.dispose();
  const restored = f.open(); await stateIs(restored, 'account'); assert.equal(f.requests.length, 1);
  const original = f.values.get(key); await f.clients[1].auth.refreshSession();
  assert.ok(f.requests.some(request => request.refresh && request.refreshMatches));
  assert.ok(f.values.get(key) !== original, 'Rotated session must replace the stored envelope');
  await restored.signOut(); assert.equal(restored.getSnapshot().status, 'guest'); assert.ok(!f.values.has(key));
  assert.equal(f.values.get('unrelated-owner'), 'retained'); restored.dispose();
  const afterLogout = f.open(); await stateIs(afterLogout, 'guest');
});
test('unavailable SecureStore leaves native authentication closed without preventing factory creation', async t => {
  const f = await fixture(t); f.setAvailable(false);
  const gateway = f.open(); await stateIs(gateway, 'unavailable');
  await assert.rejects(gateway.signIn('native@example.test', 'synthetic'), unavailable);
  assert.equal(f.requests.length, 0); assert.equal(f.values.size, 0);
});
test('a silently lost native SecureStore write leaves authentication unavailable', async t => {
  const f = await fixture(t); const gateway = f.open(); await stateIs(gateway, 'guest'); f.loseWrites();
  await assert.rejects(gateway.signIn('native@example.test', 'synthetic'), unavailable);
  assert.equal(gateway.getSnapshot().status, 'unavailable'); assert.equal(f.values.size, 0);
});
test('native logout storage failure stays unavailable instead of falsely reporting a cleared session', async t => {
  const f = await fixture(t); const gateway = f.open(); await stateIs(gateway, 'guest');
  await gateway.signIn('native@example.test', 'synthetic'); f.denyDeletes();
  await assert.rejects(gateway.signOut(), unavailable); assert.equal(gateway.getSnapshot().status, 'unavailable');
  assert.ok(f.values.has(key), 'Failed deletion preserves uncertain persisted state');
});
test('native read failure immediately closes the account gateway and preserves uncertain stored data', async t => {
  const f = await fixture(t); const gateway = f.open(); await stateIs(gateway, 'guest');
  await gateway.signIn('native@example.test', 'synthetic'); const saved = f.values.get(key);
  f.setAvailable(false); await f.clients[0].auth.getSession();
  assert.equal(gateway.getSnapshot().status, 'unavailable'); assert.ok(f.values.get(key) === saved);
  f.setAvailable(true);
  await assert.rejects(gateway.signIn('native@example.test', 'synthetic'), unavailable);
});
test('native initialization refreshes an expired stored session using the installed SDK', async t => {
  const f = await fixture(t);
  f.values.set(key, JSON.stringify({ ...session(), expires_at: Math.floor(Date.now() / 1000) - 10 }));
  const gateway = f.open(); await stateIs(gateway, 'account');
  assert.ok(f.requests.some(request => request.refresh && request.refreshMatches));
  assert.ok(JSON.parse(f.values.get(key)!).expires_at > Date.now() / 1000);
});
test('a provider-rejected expired refresh token cannot restore a native account', async t => {
  const f = await fixture(t);
  f.values.set(key, JSON.stringify({ ...session(), expires_at: Math.floor(Date.now() / 1000) - 10 }));
  f.respond(async url => url.searchParams.get('grant_type') === 'refresh_token'
    ? Response.json({ code: 'refresh_token_not_found', message: 'synthetic provider detail' }, { status: 400 }) : undefined);
  const gateway = f.open(); await stateIs(gateway, 'guest'); assert.ok(!f.values.has(key));
});
test('disposed native login cannot write over a replacement account session', async t => {
  const f = await fixture(t); const old = f.open(); await stateIs(old, 'guest');
  const entered = deferred<void>(); const response = deferred<Response>(); let held = false;
  f.respond(async url => { if (!held && url.pathname.endsWith('/token')) { held = true; entered.resolve(); return response.promise; } });
  const pending = old.signIn('native@example.test', 'synthetic').then(() => false, () => true);
  await entered.promise; old.dispose(); f.account(second); const current = f.open();
  response.resolve(Response.json(session(first))); assert.equal(await pending, true);
  await stateIs(current, 'guest'); await current.signIn('native@example.test', 'synthetic');
  const state = current.getSnapshot(); assert.ok(state.status === 'account' && state.account.uid === second);
  assert.ok(JSON.parse(f.values.get(key)!).user.id === second);
});
test('native recovery uses the expected redirect and isolated memory session while keeping an existing account', async t => {
  const f = await fixture(t); const gateway = f.open(); await stateIs(gateway, 'guest');
  await gateway.signIn('native@example.test', 'synthetic'); const saved = f.values.get(key);
  await gateway.sendPasswordReset('native@example.test');
  assert.ok(f.requests.some(request => request.path.endsWith('/recover') && request.callbackMatches));
  await gateway.verification!.beginRecovery('native@example.test', '123456');
  assert.equal(gateway.verification!.hasRecoverySession(), true); assert.ok(f.values.get(key) === saved);
  await gateway.verification!.completeRecovery('synthetic-new');
  assert.equal(gateway.verification!.hasRecoverySession(), false); assert.ok(f.values.get(key) === saved);
  assert.equal(gateway.getSnapshot().status, 'account');
});
test('native activity listener forwards foreground/background refresh control and is detached on disposal', async t => {
  const f = await fixture(t); const gateway = f.open(); await stateIs(gateway, 'guest');
  let starts = 0; let stops = 0;
  f.clients[0].auth.startAutoRefresh = async () => { starts++; };
  f.clients[0].auth.stopAutoRefresh = async () => { stops++; };
  f.activity('active'); await new Promise<void>(resolve => setImmediate(resolve));
  f.activity('background'); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(starts, 1); assert.equal(stops, 1);
  gateway.dispose(); assert.equal(f.listeners.size, 0);
});
test('SDK initialization cannot restart native refresh while AppState is background', async t => {
  const f = await fixture(t); const gateway = f.open(); await stateIs(gateway, 'guest');
  await new Promise<void>(resolve => setImmediate(resolve));
  const sdk = f.clients[0].auth as unknown as { autoRefreshTicker: unknown };
  assert.ok(sdk.autoRefreshTicker === null, 'Background initialization must leave the real SDK ticker stopped');
  f.activity('active'); f.activity('background');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(sdk.autoRefreshTicker === null, 'The last activity event must win over an earlier asynchronous start');
});
test('cold and warm native intents strip credentials before Router receives a route', () => {
  for (const initial of [true, false]) {
    assert.equal(redirectSystemPath({ initial, path: 'topictrail://auth/callback?type=recovery&token_hash=' + 'a'.repeat(64) }), '/auth/callback');
    assert.equal(getEmailCallback()?.purpose, 'recovery');
    assert.equal(redirectSystemPath({ initial, path: 'topictrail://auth/callback#access_token=synthetic&refresh_token=synthetic' }), '/auth/callback');
    assert.equal(getEmailCallback(), undefined);
    assert.equal(redirectSystemPath({ initial, path: 'topictrail://auth/callback?type=signup&type=recovery&token_hash=' + 'a'.repeat(64) }), '/auth/callback');
    assert.equal(getEmailCallback(), undefined);
  }
  clearEmailCallback();
});
