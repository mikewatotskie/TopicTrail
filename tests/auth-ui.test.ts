import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import type { AuthGateway, AuthState } from '../src/core/auth/types';
import { nativeProbeSource, type NativePropRecord } from './helpers/accessibility';

// Real screens, provider, theme and RN Web controls. Only router/platform/provider IO is replaced.
let ui: { Harness: React.ComponentType<{ gateway?: AuthGateway; kind: string; origin?: string; purpose?: string; missing?: boolean; strict?: boolean }>; setFocused: (focused: boolean) => void;
  setProbePlatform: (platform: 'web' | 'android') => void; nativeProps: NativePropRecord[]; roleViolations: string[];
  redirectSystemPath: typeof import('../src/app/+native-intent').redirectSystemPath;
  getEmailCallback: typeof import('../src/core/auth/email_callback').getEmailCallback };
let dom: JSDOM;
let routes: unknown[] = [];
const previous = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://auth.test', pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), __authRoutes: routes })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const boundaries: Record<string, string> = {
    'react-native': nativeProbeSource(),
    '@react-native-async-storage/async-storage': `export default {getItem:async()=> 'dark',setItem:async()=>{}};`,
    'expo-router': `import {useEffect} from 'react';
      export const router={canGoBack:()=>false,back(){throw Error('history Back is forbidden')},navigate(p){globalThis.__authRoutes.push(p)},push(p){globalThis.__authRoutes.push(p)},replace(p){globalThis.__authRoutes.push(p)}};
      let focused=true;const listeners=new Set();
      export function setAuthTestFocused(next){if(next===focused)return;focused=next;listeners.forEach(listener=>listener());}
      export function useFocusEffect(effect){useEffect(()=>{let cleanup;const changed=()=>{cleanup?.();cleanup=focused?effect():undefined;};listeners.add(changed);changed();return()=>{listeners.delete(changed);cleanup?.();};},[effect]);}`,
    'expo-image': `import React from 'react';export const Image=()=>React.createElement('span');`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
  };
  const compiled = await build({ stdin: { contents: `export {setProbePlatform,nativeProps,roleViolations} from 'react-native';export {redirectSystemPath} from './src/app/+native-intent';export {getEmailCallback} from './src/core/auth/email_callback';import React,{StrictMode} from 'react';export {setAuthTestFocused as setFocused} from 'expo-router';import {ThemeProvider} from './src/core/theme/ThemeContext';import {AuthProvider} from './src/features/auth/AuthContext';import {LoginScreen,RegistrationScreen,RecoveryScreen,AccountCreatedScreen,ProfileScreen} from './src/features/auth/AuthScreens';import {VerifyEmailScreen,UpdatePasswordScreen,EmailCallbackScreen} from './src/features/auth/AuthVerification';import {SettingsScreen} from './src/features/settings/SettingsScreen';import {WelcomeScreen} from './src/features/splash/WelcomeScreen';const screens={login:LoginScreen,register:RegistrationScreen,recovery:RecoveryScreen,created:AccountCreatedScreen,profile:ProfileScreen,settings:SettingsScreen,welcome:WelcomeScreen,verify:VerifyEmailScreen,update:UpdatePasswordScreen,callback:EmailCallbackScreen};export function Harness({gateway,kind,origin='welcome',purpose='signup',missing=false,strict=false}){const Screen=screens[kind];const content=<ThemeProvider>{missing?<Screen origin={origin} purpose={purpose}/>:<AuthProvider gateway={gateway}><Screen origin={origin} purpose={purpose}/></AuthProvider>}</ThemeProvider>;return strict?<StrictMode>{content}</StrictMode>:content;}`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', loader: { '.svg': 'dataurl' },
    plugins: [{ name: 'auth-platform-io', setup(builder) {
      builder.onResolve({ filter: /core\/auth\/session$|\.\/session$/ }, () => ({ path: 'auth-session', namespace: 'io' }));
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'io' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'io' }, args => ({ contents: args.path === 'auth-session' ? `export function getTopicTrailAuthGateway(){throw Error('Tests must inject their gateway; no Firebase IO allowed')}` : boundaries[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  ui = module.exports as typeof ui;
});
after(() => {
  dom?.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
function fake(initial: AuthState = { status: 'guest' }) {
  let state = initial;
  const listeners = new Set<(state: AuthState) => void>();
  const calls: unknown[][] = [];
  const gateway: AuthGateway = {
    getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async signIn(...args) { calls.push(['signIn', ...args]); }, async register(...args) { calls.push(['register', ...args]); },
    async sendPasswordReset(...args) { calls.push(['reset', ...args]); }, async signOut() { calls.push(['signOut']); emit({ status: 'guest' }); },
    dispose() { throw Error('Shared gateway must not be disposed by a UI mount'); },
  };
  function emit(next: AuthState) { state = next; listeners.forEach(listener => listener(state)); }
  return { gateway, calls, emit, listeners };
}
async function mounted(kind: string, gateway: AuthGateway | undefined, run: (show: (next: string) => Promise<void>) => Promise<void>, props: { origin?: string; purpose?: string; missing?: boolean; strict?: boolean; platform?: 'web' | 'android' } = {}) {
  routes.length = 0;
  ui.setProbePlatform(props.platform ?? 'web');
  ui.setFocused(true);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.querySelector('main')!);
  const show = async (next: string) => { await act(async () => root.render(React.createElement(ui.Harness, { kind: next, gateway, ...props }))); };
  try { await show(kind); await run(show); assert.deepEqual(ui.roleViolations, [], 'All simulated Android host props must satisfy the installed native role contract'); }
  finally { await act(async () => root.unmount()); }
}
function button(label: string, within: ParentNode = dom.window.document) {
  const control = [...within.querySelectorAll<HTMLElement>('[role="button"]')].find(node => node.getAttribute('aria-label') === label);
  assert.ok(control, `button ${label} exists`); return control;
}
async function click(label: string, within?: ParentNode) { await act(async () => button(label, within).click()); }
function field(label: string) { const input = dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); assert.ok(input, `input ${label} exists`); return input; }
async function fill(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
const account = { uid: 'real-provider-id', displayName: 'Ada Lovelace', email: 'ada@example.com', emailVerified: false };

for (const kind of ['login', 'register']) {
  test(`Android role boundary: ${kind} idle and initial account checking never render an invalid role`, async () => {
    for (const status of ['guest', 'loading', 'unavailable'] as const) await mounted(kind, fake({ status }).gateway, async () => {
      assert.deepEqual(ui.roleViolations, []);
      assert.equal(ui.nativeProps.some(props => props.accessibilityRole === 'status'), false);
    }, { platform: 'android' });
  });
  test(`Android role boundary: ${kind} pending request preserves feedback without invalid RCTText props`, async () => {
    const f = fake(); let finish!: () => void;
    const pending = () => new Promise<void>(resolve => { finish = resolve; });
    f.gateway.signIn = pending; f.gateway.register = pending;
    try {
      await mounted(kind, f.gateway, async () => {
        assert.deepEqual(ui.roleViolations, [], 'Idle entry must be safe before a request');
        if (kind === 'register') { await fill('Full name', 'Fixture'); await fill('Confirm password', 'fixture passphrase'); }
        await fill('Email address', 'fixture@example.test'); await fill('Password', 'fixture passphrase');
        await click(kind === 'login' ? 'Log in' : 'Create account');
        const pendingNode = dom.window.document.querySelector('[data-testid="auth-access-pending"]');
        assert.ok(pendingNode);
        assert.match(pendingNode.textContent!, kind === 'login' ? /Logging in/ : /Creating account/);
        assert.deepEqual(ui.roleViolations, [], 'Pending must not send accessibilityRole=status to RCTText');
      }, { platform: 'android' });
    } finally { if (finish) await act(async () => finish()); }
  });
}

test('validation blocks empty and invalid login requests; password visibility is a separate control', async () => {
  const f = fake();
  await mounted('login', f.gateway, async () => {
    await click('Log in'); assert.equal(f.calls.length, 0);
    assert.match(dom.window.document.body.textContent!, /Enter your email/);
    assert.equal(field('Email address').getAttribute('aria-invalid'), 'true');
    await fill('Email address', 'bad'); await fill('Password', 'secret'); await click('Log in'); assert.equal(f.calls.length, 0);
    assert.equal(field('Password').type, 'password'); await click('Show password'); assert.equal(field('Password').type, 'text');
    await click('Hide password'); assert.equal(field('Password').type, 'password');
  });
});
test('actual login submits typed values and preserves Welcome or Settings origin on success', async () => {
  for (const origin of ['welcome', 'settings']) {
    const f = fake(); f.gateway.signIn = async (...args) => { f.calls.push(['signIn', ...args]); f.emit({ status: 'account', account }); };
    await mounted('login', f.gateway, async () => {
      await fill('Email address', ' ada@example.com '); await fill('Password', 'real secret'); await click('Log in');
      assert.deepEqual(f.calls, [['signIn', 'ada@example.com', 'real secret']]);
      assert.equal(routes.at(-1), origin === 'settings' ? '/auth/profile' : '/(tabs)/home');
      assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Password"]')?.value ?? '', '');
    }, { origin });
  }
});
test('registration validates matching passwords and toggles both independently, then requires email confirmation while signed out', async () => {
  const f = fake();
  await mounted('register', f.gateway, async show => {
    await click('Create account'); assert.equal(f.calls.length, 0);
    await fill('Full name', 'Ada Lovelace'); await fill('Email address', 'ada@example.com');
    await fill('Password', 'secret123'); await fill('Confirm password', 'different');
    await click('Show password'); assert.equal(field('Password').type, 'text'); assert.equal(field('Confirm password').type, 'password');
    await click('Show confirm password'); assert.equal(field('Confirm password').type, 'text');
    await click('Hide password'); assert.equal(field('Password').type, 'password'); assert.equal(field('Confirm password').type, 'text');
    await click('Create account'); assert.equal(f.calls.length, 0);
    await fill('Confirm password', 'secret123'); await click('Create account');
    assert.deepEqual(f.calls, [['register', 'Ada Lovelace', 'ada@example.com', 'secret123']]);
    assert.equal(f.gateway.getSnapshot().status, 'guest');
    assert.deepEqual(routes.at(-1), { pathname: '/auth/created', params: { origin: 'settings' } });
    assert.equal(field('Password').value, ''); assert.equal(field('Confirm password').value, '');
    await show('created'); assert.match(dom.window.document.body.textContent!, /Email confirmation required/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /Your account is ready|You can now log in/);
    await click('Back to log in'); assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'settings' } });
    await show('created'); assert.doesNotMatch(dom.window.document.body.textContent!, /Email confirmation required/);
  }, { origin: 'settings' });
});
test('direct Account created route cannot claim an account was created without a confirmed registration', async () => {
  await mounted('created', fake().gateway, async () => {
    assert.doesNotMatch(dom.window.document.body.textContent!, /Your account is ready|You can now log in/);
    assert.match(dom.window.document.body.textContent!, /confirmation unavailable/i);
    await click('Back to log in'); assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'welcome' } });
  });
});
test('already-signed-in auth entry returns through Settings without a direct profile shortcut', async () => {
  await mounted('login', fake({ status: 'account', account }).gateway, async () => {
    assert.equal([...dom.window.document.querySelectorAll('[role="button"]')].some(node => node.getAttribute('aria-label') === 'View account'), false);
    await click('Open Settings'); assert.equal(routes.at(-1), '/(tabs)/settings');
  });
});
test('pending sign-in disables edits, exits and duplicate requests; unmounted completion cannot navigate', async () => {
  const f = fake(); let finish!: () => void; let requests = 0;
  f.gateway.signIn = () => { requests++; return new Promise<void>(resolve => { finish = () => { f.emit({ status: 'account', account }); resolve(); }; }); };
  await mounted('login', f.gateway, async () => {
    await fill('Email address', 'ada@example.com'); await fill('Password', 'secret123'); await click('Log in');
    assert.equal(button('Logging in').getAttribute('aria-disabled'), 'true');
    for (const label of ['Create account', 'Forgot password?', 'Back to Welcome', 'Show password']) assert.equal(button(label).getAttribute('aria-disabled'), 'true');
    assert.equal(field('Email address').readOnly, true); assert.equal(field('Password').readOnly, true);
    await click('Logging in'); assert.equal(requests, 1); assert.equal(routes.length, 0);
  });
  await act(async () => finish()); assert.equal(routes.length, 0); assert.equal(f.listeners.size, 0);
});
test('retained Login becomes usable after its request settles while blurred and it refocuses', async () => {
  const f = fake(); let finish!: () => void;
  f.gateway.signIn = () => new Promise<void>(resolve => { finish = resolve; });
  await mounted('login', f.gateway, async () => {
    await fill('Email address', 'ada@example.com'); await fill('Password', 'secret123'); await click('Log in');
    await act(async () => ui.setFocused(false)); assert.equal(field('Password').value, '');
    await act(async () => finish()); assert.equal(routes.length, 0);
    await act(async () => ui.setFocused(true));
    const submit = dom.window.document.querySelector('[aria-label="Log in"],[aria-label="Logging in"]'); assert.ok(submit);
    assert.notEqual(submit.getAttribute('aria-disabled'), 'true', 'settled request must not leave a retained screen busy after refocus');
    assert.notEqual(button('Back to Welcome').getAttribute('aria-disabled'), 'true');
    assert.equal(field('Password').readOnly, false); assert.equal(routes.length, 0);
  });
});
test('refocusing retained Login while a request is pending keeps it disabled until settlement without stale navigation', async () => {
  const f = fake(); let finish!: () => void;
  f.gateway.signIn = () => new Promise<void>(resolve => { finish = resolve; });
  await mounted('login', f.gateway, async () => {
    await fill('Email address', 'ada@example.com'); await fill('Password', 'secret123'); await click('Log in');
    await act(async () => ui.setFocused(false)); await act(async () => ui.setFocused(true));
    assert.equal(button('Logging in').getAttribute('aria-disabled'), 'true'); assert.equal(field('Password').readOnly, true);
    assert.equal(field('Password').value, ''); assert.equal(routes.length, 0);
    await act(async () => finish());
    assert.notEqual(button('Log in').getAttribute('aria-disabled'), 'true'); assert.equal(field('Password').readOnly, false);
    assert.equal(routes.length, 0); assert.doesNotMatch(dom.window.document.body.textContent!, /could not be confirmed/);
  });
});
test('a resolved login without an account snapshot cannot grant entry', async () => {
  const f = fake();
  await mounted('login', f.gateway, async () => {
    await fill('Email address', 'ada@example.com'); await fill('Password', 'secret123'); await click('Log in');
    assert.equal(routes.length, 0); assert.match(dom.window.document.body.textContent!, /could not be confirmed/);
  });
});
test('reset failure never shows confirmation; explicit retry can recover', async () => {
  const f = fake(); let attempts = 0;
  f.gateway.sendPasswordReset = async () => { attempts++; if (attempts === 1) throw Object.assign(new Error(), { code: 'network' }); };
  await mounted('recovery', f.gateway, async () => {
    await fill('Email address', 'ada@example.com'); await click('Send reset link');
    assert.doesNotMatch(dom.window.document.body.textContent!, /If an account uses this email/);
    assert.match(dom.window.document.body.textContent!, /connection/); assert.equal(routes.length, 0);
    await click('Send reset link'); assert.equal(attempts, 2); assert.match(dom.window.document.body.textContent!, /If an account uses this email/);
  });
});
test('logout failure keeps the account visible and offers retry or Cancel', async () => {
  const f = fake({ status: 'account', account });
  f.gateway.signOut = async () => { throw Object.assign(new Error(), { code: 'network' }); };
  await mounted('profile', f.gateway, async () => {
    await click('Log out'); const dialog = dom.window.document.querySelector('[aria-modal="true"]'); assert.ok(dialog);
    await click('Log out', dialog); assert.match(dialog.textContent!, /Unable to log out/);
    assert.equal(f.gateway.getSnapshot().status, 'account'); assert.equal(routes.length, 0);
    await click('Cancel'); assert.match(dom.window.document.body.textContent!, /Ada Lovelace/);
  });
});
test('network failure stays on login, preserves values for an explicit retry and never fakes success', async () => {
  const f = fake(); let attempts = 0;
  f.gateway.signIn = async () => { attempts++; if (attempts === 1) throw Object.assign(new Error(), { code: 'network' }); f.emit({ status: 'account', account }); };
  await mounted('login', f.gateway, async () => {
    await fill('Email address', 'ada@example.com'); await fill('Password', 'secret123'); await click('Log in');
    assert.equal(routes.length, 0); assert.equal(f.gateway.getSnapshot().status, 'guest');
    assert.match(dom.window.document.body.textContent!, /connection/i); assert.equal(field('Password').value, 'secret123');
    await click('Log in'); assert.equal(attempts, 2); assert.equal(routes.at(-1), '/(tabs)/home');
  });
});
test('partial account creation prevents duplicate registration and requires sign-out cleanup before login', async () => {
  const f = fake(); let registrations = 0; let cleanups = 0;
  f.gateway.register = async () => { registrations++; throw Object.assign(new Error(), { code: 'account_created' }); };
  f.gateway.signOut = async () => { cleanups++; if (cleanups === 1) throw Object.assign(new Error(), { code: 'network' }); };
  await mounted('register', f.gateway, async () => {
    await fill('Full name', 'Ada'); await fill('Email address', 'ada@example.com'); await fill('Password', 'secret123'); await fill('Confirm password', 'secret123'); await click('Create account');
    assert.match(dom.window.document.body.textContent!, /account was created/i); assert.equal(field('Password').value, '');
    assert.equal(button('Create account').getAttribute('aria-disabled'), 'true');
    await click('Continue to log in'); assert.equal(routes.length, 0); assert.equal(registrations, 1);
    await click('Continue to log in'); assert.equal(cleanups, 2); assert.equal(registrations, 1);
    assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'settings' } });
  }, { origin: 'settings' });
});
test('reset validates requests, shows neutral acknowledgement and returns to Login with origin intact', async () => {
  const f = fake();
  await mounted('recovery', f.gateway, async () => {
    await click('Send reset link'); assert.equal(f.calls.length, 0);
    await fill('Email address', 'ada@example.com'); await click('Send reset link');
    assert.deepEqual(f.calls, [['reset', 'ada@example.com']]);
    assert.match(dom.window.document.body.textContent!, /If an account uses this email/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /email (was|has been) sent/i);
    await click('Back to log in'); assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'settings' } });
  }, { origin: 'settings' });
});
test('profile waits for restored authentication before claiming the user is signed out', async () => {
  const f = fake({ status: 'loading' });
  await mounted('profile', f.gateway, async () => {
    assert.match(dom.window.document.body.textContent!, /Checking account/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /You are not signed in/);
    assert.equal(dom.window.document.querySelector('[aria-label="Log in"]'), null);
    await act(async () => f.emit({ status: 'account', account }));
    assert.match(dom.window.document.body.textContent!, /Ada Lovelace/);
    assert.equal(routes.length, 0); assert.equal(f.calls.length, 0);
  });
});
test('profile preserves identity and local-session information; reset and Back keep their destinations without provider requests', async () => {
  const f = fake({ status: 'account', account });
  await mounted('profile', f.gateway, async () => {
    const text = dom.window.document.body.textContent!;
    for (const content of ['Ada Lovelace', 'ada@example.com', 'Signed in', 'Your local library',
      'Your syllabi and saved links stay on this device.', 'Signing in or out does not change them.',
      'Your sign-in is remembered in this browser. Use Log out to end your session.']) assert.ok(text.includes(content), content);
    assert.doesNotMatch(text, /ends when you reload/);
    await click('Reset password');
    assert.deepEqual(routes.at(-1), { pathname: '/auth/recovery', params: { origin: 'settings' } });
    assert.deepEqual(f.calls, []); assert.equal(f.gateway.getSnapshot().status, 'account');
    await click('Back to Settings'); assert.equal(routes.at(-1), '/(tabs)/settings');
  });
});
test('profile actions remain disabled while confirmed logout is pending and a repeated confirmation sends one request', async () => {
  const f = fake({ status: 'account', account }); let finish!: () => void;
  f.gateway.signOut = () => { f.calls.push(['signOut']); return new Promise<void>(resolve => { finish = () => { f.emit({ status: 'guest' }); resolve(); }; }); };
  await mounted('profile', f.gateway, async () => {
    await click('Log out'); const dialog = dom.window.document.querySelector('[aria-modal="true"]'); assert.ok(dialog);
    await click('Log out', dialog);
    for (const label of ['Reset password', 'Back to Settings', 'Cancel']) assert.equal(button(label).getAttribute('aria-disabled'), 'true');
    await click('Logging out', dialog); assert.deepEqual(f.calls, [['signOut']]); assert.deepEqual(routes, []);
    await act(async () => finish());
    assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'settings' } });
  });
});
test('logout cancel preserves account; confirm signs out and opens empty Login with explicit Settings back', async () => {
  const f = fake({ status: 'account', account });
  await mounted('profile', f.gateway, async () => {
    assert.match(dom.window.document.body.textContent!, /Ada Lovelace/);
    await click('Log out'); await click('Cancel'); assert.equal(f.calls.length, 0);
    assert.equal(f.gateway.getSnapshot().status, 'account');
    await click('Log out'); const dialog = dom.window.document.querySelector('[aria-modal="true"]'); assert.ok(dialog);
    await click('Log out', dialog); assert.deepEqual(f.calls, [['signOut']]);
    assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'settings' } });
  });
  await mounted('login', f.gateway, async () => {
    assert.equal(field('Email address').value, ''); assert.equal(field('Password').value, '');
    await click('Back to Settings'); assert.equal(routes.at(-1), '/(tabs)/settings');
  }, { origin: 'settings' });
});
test('missing provider or unavailable gateway disables authentication honestly', async () => {
  for (const missing of [false, true]) await mounted('login', fake({ status: 'unavailable' }).gateway, async () => {
    assert.equal(button('Log in').getAttribute('aria-disabled'), 'true'); assert.match(dom.window.document.body.textContent!, /unavailable/i);
  }, { missing });
});
test('production factory failure keeps the app and local guest entry usable with unavailable auth controls', async () => {
  await mounted('login', undefined, async () => {
    assert.match(dom.window.document.body.textContent!, /Authentication unavailable/);
    assert.equal(button('Log in').getAttribute('aria-disabled'), 'true');
    await click('Back to Welcome'); assert.equal(routes.at(-1), '/welcome');
  });
  await mounted('welcome', undefined, async () => { await click('Get started'); assert.equal(routes.at(-1), '/(tabs)/home'); });
});
test('provider unsubscribes correctly in StrictMode; Settings updates real identity and preserves theme', async () => {
  const f = fake();
  await mounted('settings', f.gateway, async () => {
    assert.equal(f.listeners.size, 1); assert.match(dom.window.document.body.textContent!, /Guest/);
    assert.equal(dom.window.document.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true');
    await click('Log in'); assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'settings' } });
    await act(async () => f.emit({ status: 'account', account }));
    assert.match(dom.window.document.body.textContent!, /Ada Lovelace/); assert.match(dom.window.document.body.textContent!, /ada@example.com/);
    await click('View account'); assert.equal(routes.at(-1), '/auth/profile');
    assert.equal(dom.window.document.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true');
  }, { strict: true });
  assert.equal(f.listeners.size, 0);
});
test('Welcome keeps guest Get started and offers Login with Welcome origin', async () => {
  await mounted('welcome', fake().gateway, async () => {
    await click('Get started'); assert.equal(routes.at(-1), '/(tabs)/home');
    await click('Log in'); assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'welcome' } });
    assert.doesNotMatch(dom.window.document.body.textContent!, /2 uploads|two uploads/i);
  });
});

function emailGateway() {
  const f = fake(); let ready = false;
  f.gateway.verification = {
    async verifyEmail(...args) { f.calls.push(['verify', ...args]); },
    async resendConfirmation(...args) { f.calls.push(['resend', ...args]); },
    async beginRecovery(...args) { f.calls.push(['beginRecovery', ...args]); ready = true; },
    async verifyLink() {},
    hasRecoverySession: () => ready,
    recoveryEmail: () => ready ? 'ada@example.com' : null,
    async completeRecovery(...args) { f.calls.push(['completeRecovery', ...args]); ready = false; },
    cancelRecovery() { ready = false; f.calls.push(['cancelRecovery']); },
  };
  return { ...f, ready: () => { ready = true; } };
}
test('email verification validates code, requires explicit submission, stays signed out and preserves return origin', async () => {
  const f = emailGateway();
  await mounted('verify', f.gateway, async () => {
    await click('Verify code'); assert.equal(f.calls.length, 0);
    await fill('Email address', 'ada@example.com'); await fill('Email code', '123456');
    assert.equal(field('Email code').getAttribute('autocomplete'), 'one-time-code');
    await click('Verify code'); assert.deepEqual(f.calls, [['verify', 'ada@example.com', '123456']]);
    assert.match(dom.window.document.body.textContent!, /Email verified/); assert.equal(f.gateway.getSnapshot().status, 'guest');
    assert.equal(routes.length, 0); await click('Back to log in');
    assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'settings' } });
  }, { origin: 'settings', strict: true });
});
test('recovery code routes only a verified temporary session to password update without route secrets', async () => {
  const f = emailGateway();
  await mounted('verify', f.gateway, async () => {
    await fill('Email address', 'ada@example.com'); await fill('Email code', '123456'); await click('Verify code');
    assert.deepEqual(f.calls, [['beginRecovery', 'ada@example.com', '123456']]);
    assert.deepEqual(routes.at(-1), { pathname: '/auth/update-password', params: { origin: 'settings' } });
    assert.equal(f.gateway.verification!.hasRecoverySession(), true);
    await act(async () => ui.setFocused(false));
    assert.equal(f.gateway.verification!.hasRecoverySession(), true, 'handoff to password screen retains verified flow');
  }, { origin: 'settings', purpose: 'recovery', strict: true });
});
test('direct password-update entry is blocked; a verified flow survives StrictMode and clears secrets on real blur', async () => {
  const f = emailGateway();
  await mounted('update', f.gateway, async () => {
    assert.match(dom.window.document.body.textContent!, /Recovery verification required/);
    assert.equal(dom.window.document.querySelector('[aria-label="New password"]'), null);
  });
  f.ready(); f.calls.length = 0;
  await mounted('update', f.gateway, async () => {
    assert.equal(f.gateway.verification!.hasRecoverySession(), true);
    await fill('New password', 'fictional private value'); await fill('Confirm new password', 'fictional private value');
    await act(async () => ui.setFocused(false));
    assert.equal(f.gateway.verification!.hasRecoverySession(), false);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('[aria-label="New password"]')?.value ?? '', '');
    assert.equal(routes.length, 0);
  }, { strict: true });
});
test('password update validates matching fields and shows success without logging in', async () => {
  const f = emailGateway(); f.ready();
  await mounted('update', f.gateway, async () => {
    await fill('New password', 'fictional first'); await fill('Confirm new password', 'different'); await click('Change password');
    assert.equal(f.calls.length, 0);
    await fill('Confirm new password', 'fictional first'); await click('Change password');
    assert.deepEqual(f.calls, [['completeRecovery', 'fictional first']]); assert.match(dom.window.document.body.textContent!, /Password changed/);
    assert.equal(dom.window.document.querySelector('[aria-label="New password"]'), null);
    assert.equal(f.gateway.getSnapshot().status, 'guest'); assert.equal(routes.length, 0);
  });
});
test('a warm callback replaces an already visible email action without submitting its stale hash', async () => {
  const f = emailGateway(); const verified: string[] = [];
  f.gateway.verification!.verifyLink = async hash => { verified.push(hash); };
  ui.redirectSystemPath({ initial: true, path: 'topictrail://auth/callback?type=signup&token_hash=' + 'a'.repeat(64) });
  await mounted('callback', f.gateway, async () => {
    await act(async () => { ui.redirectSystemPath({ initial: false, path: 'topictrail://auth/callback?type=signup&token_hash=' + 'b'.repeat(64) }); });
    assert.equal(verified.slice().length, 0, 'Incoming callbacks require explicit Continue');
    await click('Continue email action');
    assert.ok(verified.length === 1 && verified[0] === 'b'.repeat(64), 'Only the newest callback may be verified');
    assert.match(dom.window.document.body.textContent!, /Email verified/);
  }, { strict: true });
});
test('invalid warm callback removes the previous actionable link from the retained screen', async () => {
  const f = emailGateway();
  ui.redirectSystemPath({ initial: true, path: 'topictrail://auth/callback?type=signup&token_hash=' + 'a'.repeat(64) });
  await mounted('callback', f.gateway, async () => {
    button('Continue email action');
    await act(async () => { ui.redirectSystemPath({ initial: false, path: 'topictrail://auth/callback#access_token=synthetic' }); });
    assert.ok(dom.window.document.querySelector('[aria-label="Continue email action"]') === null, 'Invalid callback removes Continue');
    assert.equal(ui.getEmailCallback(), undefined);
  });
});
test('replaced callback completion cannot navigate or clear a newer pending email action', async () => {
  const f = emailGateway(); let finish!: () => void;
  f.gateway.verification!.verifyLink = () => new Promise<void>(resolve => { finish = resolve; });
  ui.redirectSystemPath({ initial: true, path: 'topictrail://auth/callback?type=recovery&token_hash=' + 'a'.repeat(64) });
  await mounted('callback', f.gateway, async () => {
    await click('Continue email action');
    await act(async () => { ui.redirectSystemPath({ initial: false, path: 'topictrail://auth/callback?type=signup&token_hash=' + 'b'.repeat(64) }); });
    await act(async () => finish());
    assert.equal(routes.length, 0, 'A superseded recovery callback must not navigate to password update');
    assert.ok(ui.getEmailCallback()?.tokenHash === 'b'.repeat(64), 'Old cleanup must preserve the new callback');
    assert.notEqual(button('Continue email action').getAttribute('aria-disabled'), 'true');
  });
});

function feedback(text: RegExp, urgency: 'polite' | 'assertive') {
  const nodes = [...dom.window.document.querySelectorAll(`[aria-live="${urgency}"]`)].filter(node => text.test(node.textContent ?? ''));
  assert.equal(nodes.length, 1, `One ${urgency} message matching ${text}`);
  assert.equal(nodes[0].querySelector('[role="button"],input'), null, 'Feedback must not group interactive controls');
  return nodes[0];
}

for (const platform of ['android', 'web'] as const) {
  test(`${platform} registration distinguishes service failures and warns about uncertain outcomes without automatic retries`, async () => {
    for (const [code, message, ambiguous] of [
      ['server', /authentication service is temporarily unavailable/, true],
      ['email_submission', /account email could not be submitted/, true],
      ['timeout', /request timed out/, true], ['network', /internet connection/, true],
      ['validation', /Check your account details/, false], ['unauthorized', /could not be authenticated/, false],
      ['forbidden', /not permitted/, false], ['conflict', /conflicts with this request/, false],
      ['rate_limit', /Too many attempts/, false], ['email_in_use', /already registered/, false],
    ] as const) {
      const f = fake(); let calls = 0;
      f.gateway.register = async () => { calls++; throw { code, ambiguousOutcome: ambiguous, message: 'PRIVATE raw server data' }; };
      await mounted('register', f.gateway, async () => {
        await fill('Full name', 'Fixture'); await fill('Email address', 'fixture@example.invalid');
        await fill('Password', 'PRIVATE password'); await fill('Confirm password', 'PRIVATE password'); await click('Create account');
        const notice = feedback(message, 'assertive');
        assert.doesNotMatch(notice.textContent!, /PRIVATE/);
        assert.equal(/Check your email and existing account confirmation status/.test(notice.textContent!), ambiguous);
        if (code !== 'network') assert.doesNotMatch(notice.textContent!, /internet connection/);
        assert.equal(routes.length, 0); assert.equal(calls, 1); assert.equal(f.gateway.getSnapshot().status, 'guest');
        await act(async () => ui.setFocused(false)); await act(async () => ui.setFocused(true));
        assert.equal(calls, 1, 'Refocusing an uncertain registration must never retry signup');
      }, { platform });
    }
  });

  test(`${platform} availability feedback covers auth entry screens, recovery guards and account-created direct entry`, async () => {
    for (const kind of ['login', 'register', 'recovery', 'profile', 'verify']) {
      const f = emailGateway(); f.emit({ status: 'loading' });
      await mounted(kind, f.gateway, async () => {
        const pending = feedback(/Checking account/, 'polite');
        if (platform === 'web') assert.equal(pending.getAttribute('role'), 'status');
        await act(async () => f.emit({ status: 'unavailable' }));
        feedback(/Authentication unavailable/, 'assertive');
        assert.equal(dom.window.document.querySelector('[aria-live="polite"]')?.textContent ?? '', '');
      }, { platform });
    }
    await mounted('created', fake().gateway, async () => { feedback(/Account confirmation unavailable/, 'assertive'); }, { platform });
    await mounted('update', emailGateway().gateway, async () => { feedback(/Recovery verification required/, 'assertive'); }, { platform });
  });

  for (const kind of ['login', 'register', 'recovery', 'verify', 'update', 'callback', 'profile']) {
    test(`${platform} ${kind} pending → failure → retry → success uses valid feedback and preserves navigation`, async () => {
      const f = emailGateway();
      if (kind === 'profile') f.emit({ status: 'account', account });
      if (kind === 'update') f.ready();
      if (kind === 'callback') ui.redirectSystemPath({ initial: true, path: 'topictrail://auth/callback?type=signup&token_hash=' + 'c'.repeat(64) });
      let finish!: () => void, fail!: () => void, requests = 0;
      const operation = () => { requests++; return new Promise<void>((resolve, reject) => {
        finish = () => { if (kind === 'login') f.emit({ status: 'account', account }); if (kind === 'profile') f.emit({ status: 'guest' }); resolve(); };
        fail = () => reject(Object.assign(new Error(), { code: 'network' }));
      }); };
      if (kind === 'login') f.gateway.signIn = operation;
      else if (kind === 'register') f.gateway.register = operation;
      else if (kind === 'recovery') f.gateway.sendPasswordReset = operation;
      else if (kind === 'verify') f.gateway.verification!.verifyEmail = operation;
      else if (kind === 'update') f.gateway.verification!.completeRecovery = operation;
      else if (kind === 'callback') f.gateway.verification!.verifyLink = operation;
      else f.gateway.signOut = operation;
      const labels: Record<string, string> = { login: 'Log in', register: 'Create account', recovery: 'Send reset link', verify: 'Verify code', update: 'Change password', callback: 'Continue email action', profile: 'Log out' };
      const pending: Record<string, RegExp> = { login: /Logging in/, register: /Creating account/, recovery: /Requesting reset link/, verify: /Verifying email code/, update: /Changing password/, callback: /Verifying email action/, profile: /Logging out/ };
      await mounted(kind, f.gateway, async show => {
        if (['login', 'register', 'recovery', 'verify'].includes(kind)) await fill('Email address', 'fixture@example.test');
        if (['login', 'register'].includes(kind)) await fill('Password', 'fixture passphrase');
        if (kind === 'register') { await fill('Full name', 'Fixture'); await fill('Confirm password', 'fixture passphrase'); }
        if (kind === 'verify') await fill('Email code', '123456');
        if (kind === 'update') { await fill('New password', 'fixture passphrase'); await fill('Confirm new password', 'fixture passphrase'); }
        if (kind === 'profile') await click('Log out');
        const area = kind === 'profile' ? dom.window.document.querySelector('[aria-modal="true"]')! : undefined;
        await click(labels[kind], area);
        const message = feedback(pending[kind], 'polite');
        if (platform === 'web') assert.equal(message.getAttribute('role'), 'status');
        else {
          const props = ui.nativeProps.filter(p => pending[kind].test(p.text ?? '') && p.accessibilityLiveRegion === 'polite').at(-1)!;
          assert.ok(props); assert.equal(props.accessibilityRole, undefined); assert.equal(props.role, undefined);
        }
        assert.equal(requests, 1); assert.equal(routes.length, 0);
        await act(async () => fail());
        feedback(/Check your internet connection and try again/, 'assertive');
        assert.ok(![...dom.window.document.querySelectorAll('[aria-live="polite"]')].some(node => pending[kind].test(node.textContent ?? '')));
        assert.equal(routes.length, 0);
        await click(labels[kind], area); assert.equal(requests, 2); feedback(pending[kind], 'polite');
        await act(async () => finish());
        assert.equal(dom.window.document.querySelector('[aria-live="assertive"]'), null);
        if (kind === 'login') { assert.equal(routes.at(-1), '/(tabs)/home'); feedback(/You are signed in/, 'polite'); }
        else if (kind === 'register') { assert.deepEqual(routes.at(-1), { pathname: '/auth/created', params: { origin: 'welcome' } }); await show('created'); feedback(/Check your email/, 'polite'); }
        else if (kind === 'profile') assert.deepEqual(routes.at(-1), { pathname: '/auth/login', params: { origin: 'settings' } });
        else feedback(kind === 'recovery' ? /Check your email/ : kind === 'update' ? /Password changed/ : /Email verified/, 'polite');
      }, { platform, strict: true });
    });
  }

  test(`${platform} resend-code feedback clears during retries and does not repeat old success after failure`, async () => {
    const f = emailGateway(); let finish!: () => void, fail!: () => void;
    f.gateway.verification!.resendConfirmation = () => new Promise<void>((resolve, reject) => { finish = resolve; fail = () => reject({ code: 'network' }); });
    await mounted('verify', f.gateway, async () => {
      await fill('Email address', 'fixture@example.test');
      await click('Request another code'); feedback(/Requesting another code/, 'polite');
      await act(async () => finish()); feedback(/Check your email/, 'polite');
      await click('Request another code');
      assert.ok(![...dom.window.document.querySelectorAll('[aria-live="polite"]')].some(node => /Check your email/.test(node.textContent ?? '')));
      await act(async () => fail()); feedback(/connection/, 'assertive');
      assert.ok(![...dom.window.document.querySelectorAll('[aria-live="polite"]')].some(node => /Check your email/.test(node.textContent ?? '')));
    }, { platform });
  });

  test(`${platform} validation feedback changes without provider calls and recovery-code pending retains temporary-session navigation`, async () => {
    for (const kind of ['login', 'register', 'recovery', 'verify']) {
      const f = emailGateway();
      await mounted(kind, f.gateway, async () => {
        await click(kind === 'login' ? 'Log in' : kind === 'register' ? 'Create account' : kind === 'recovery' ? 'Send reset link' : 'Verify code');
        feedback(/Enter your email address/, 'polite'); assert.equal(f.calls.length, 0);
      }, { platform });
    }
    const f = emailGateway(); let finish!: () => void;
    f.gateway.verification!.beginRecovery = () => new Promise<void>(resolve => { finish = () => { f.ready(); resolve(); }; });
    await mounted('verify', f.gateway, async () => {
      await fill('Email address', 'fixture@example.test'); await fill('Email code', '123456'); await click('Verify code');
      feedback(/Verifying recovery code/, 'polite'); await act(async () => finish());
      assert.deepEqual(routes.at(-1), { pathname: '/auth/update-password', params: { origin: 'settings' } });
      assert.equal(f.gateway.verification!.hasRecoverySession(), true);
    }, { platform, purpose: 'recovery', origin: 'settings' });
  });
}
