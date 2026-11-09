import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { XMLValidator } from 'fast-xml-parser';
import { guardedSessionStorage } from '../src/core/auth/session_storage';
import { authFetch } from '../src/core/auth/supabase_fetch';

test('native platform stores sessions only through SecureStore, forwards activity and propagates persistence failures', async () => {
  const values = new Map<string, string>(); const calls: { method: string; key: string; options: object }[] = [];
  let allowed = true; let failure = false; let changed: ((state: string) => void) | undefined; let removed = false;
  const fixture = {
    async isAvailableAsync() { return allowed; },
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
    async getItemAsync(key: string, options: object) { if (failure) throw Error('PRIVATE native storage error'); calls.push({ method: 'get', key, options }); return values.get(key) ?? null; },
    async setItemAsync(key: string, value: string, options: object) { if (failure) throw Error('PRIVATE native storage error'); calls.push({ method: 'set', key, options }); values.set(key, value); },
    async deleteItemAsync(key: string, options: object) { calls.push({ method: 'delete', key, options }); values.delete(key); },
    AppState: { currentState: 'active', addEventListener(_event: string, listener: (state: string) => void) { changed = listener; return { remove() { removed = true; } }; } },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__ttSecureFixture');
  Object.defineProperty(globalThis, '__ttSecureFixture', { value: fixture, configurable: true });
  try {
    const bundle = await build({ entryPoints: ['src/core/auth/supabase_platform.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true,
      plugins: [{ name: 'native-platform-boundaries', setup(builder) {
        builder.onResolve({ filter: /^(expo-secure-store|react-native|react-native-url-polyfill\/auto)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'expo-secure-store'
          ? 'const f=globalThis.__ttSecureFixture;export const {isAvailableAsync,WHEN_UNLOCKED_THIS_DEVICE_ONLY,getItemAsync,setItemAsync,deleteItemAsync}=f;'
          : args.path === 'react-native' ? 'export const AppState=globalThis.__ttSecureFixture.AppState;' : 'export {};', loader: 'js' }));
      } }],
    });
    assert.ok(!Object.keys(bundle.metafile!.inputs).some(path => /async-storage/i.test(path)));
    const compiled = { exports: {} };
    new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(resolve('package.json')), compiled, compiled.exports);
    const platform = compiled.exports as typeof import('../src/core/auth/supabase_platform');
    const guarded = guardedSessionStorage(platform.sessionStorage);
    const key = 'tt.sb.abcdefghijklmnopqrst.auth.v1';
    await guarded.storage.setItem(key, 'synthetic-token-envelope'); assert.equal(await guarded.storage.getItem(key), 'synthetic-token-envelope');
    await guarded.storage.removeItem(key); assert.equal(values.size, 0);
    assert.ok(calls.every(call => call.key === key));
    for (const call of calls) assert.deepEqual(call.options, { keychainService: 'topictrail.supabase.auth', keychainAccessible: 7 });
    const activity: boolean[] = []; const detach = platform.watchAuthActivity(active => activity.push(active));
    changed?.('background'); changed?.('active'); detach(); assert.deepEqual(activity, [true, false, true]); assert.equal(removed, true);
    allowed = false; await assert.rejects(guarded.storage.setItem(key, 'synthetic'), /session storage is unavailable/); assert.equal(values.size, 0);
    allowed = true; failure = true;
    await assert.rejects(guarded.storage.getItem(key), error => /session storage is unavailable/.test(String(error)) && !String(error).includes('PRIVATE'));
    assert.equal(platform.authCallbackUrl(), 'topictrail://auth/callback');
  } finally {
    if (previous) Object.defineProperty(globalThis, '__ttSecureFixture', previous); else Reflect.deleteProperty(globalThis, '__ttSecureFixture');
  }
});
test('Auth transport preserves typed failures and Retry-After but removes raw errors and request detail', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ code: 'over_email_send_rate_limit', message: 'PRIVATE email token and URL' },
      { status: 429, headers: { 'retry-after': '60', 'x-supabase-api-version': '2024-01-01' } });
    const response = await authFetch('https://fixture.example.test');
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60');
    const body = await response.text(); assert.match(body, /over_email_send_rate_limit/); assert.doesNotMatch(body, /PRIVATE/);
    globalThis.fetch = async () => { throw Error('PRIVATE request credentials'); };
    await assert.rejects(authFetch('https://fixture.example.test'), error => /network request failed/.test(String(error)) && !String(error).includes('PRIVATE'));
  } finally { globalThis.fetch = original; }
});
test('Android backup XML excludes SecureStore without changing the existing file-backup default', () => {
  const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  assert.match(manifest, /android:fullBackupContent="@xml\/topictrail_backup_rules"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/topictrail_data_extraction_rules"/);
  for (const name of ['topictrail_backup_rules', 'topictrail_data_extraction_rules']) {
    const xml = readFileSync(`android/app/src/main/res/xml/${name}.xml`, 'utf8');
    assert.equal(XMLValidator.validate(xml), true); assert.match(xml, /<exclude domain="sharedpref" path="SecureStore"\/>/);
    assert.doesNotMatch(xml, /<include|domain="file"|domain="database"/);
  }
});
test('an older binary without SecureStore can load the app boundary and only authentication fails closed', async () => {
  const bundle = await build({ entryPoints: ['src/core/auth/supabase_platform.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'missing-native-module', setup(builder) {
      builder.onResolve({ filter: /^(expo-secure-store|react-native|react-native-url-polyfill\/auto)$/ }, args => ({ path: args.path, namespace: 'missing' }));
      builder.onLoad({ filter: /.*/, namespace: 'missing' }, args => ({ contents: args.path === 'expo-secure-store'
        ? `throw Error('ExpoSecureStore is not compiled into this historical binary');export const isAvailableAsync=async()=>false;export const WHEN_UNLOCKED_THIS_DEVICE_ONLY=7;export const getItemAsync=async()=>null;export const setItemAsync=async()=>{};export const deleteItemAsync=async()=>{};`
        : args.path === 'react-native' ? 'export const AppState={currentState:"active",addEventListener(){return{remove(){}}}};' : 'export {};', loader: 'js' }));
    } }],
  });
  const compiled = { exports: {} };
  assert.doesNotThrow(() => new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(resolve('package.json')), compiled, compiled.exports),
    'Guest startup must not evaluate a missing optional native authentication module');
  const platform = compiled.exports as typeof import('../src/core/auth/supabase_platform');
  await assert.rejects(async () => platform.sessionStorage.getItem('fixture'), /Secure session storage is unavailable/);
});
