import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import type { AuthGateway } from '../src/core/auth/types';

// Render the actual screens/provider/theme/RN Web. Only platform, router and provider IO are faked.
// JSDOM verifies constraints and stretching ancestors, never measured browser geometry.
let ui: {
  Harness: React.ComponentType<{ kind: string; gateway: AuthGateway }>;
  viewport: { width: number; left: number; right: number };
  setFocused: (value: boolean) => void;
};
let dom: JSDOM;
let theme = 'light';
const routes: unknown[] = [];
const previous = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://auth-visual.test', pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), __authVisualRoutes: routes, __authVisualTheme: () => theme })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const boundaries: Record<string, string> = {
    'react-native': `export * from 'react-native-web';export const viewport={width:1440,left:0,right:0};export const useWindowDimensions=()=>({width:viewport.width,height:600,scale:1,fontScale:1});`,
    '@react-native-async-storage/async-storage': `export default {getItem:async()=>globalThis.__authVisualTheme(),setItem:async()=>{}};`,
    'expo-router': `import {useEffect} from 'react';export const router={replace(p){globalThis.__authVisualRoutes.push(p)}};
      let focused=true;const listeners=new Set();export function setAuthTestFocused(next){if(next===focused)return;focused=next;listeners.forEach(listener=>listener());}
      export function useFocusEffect(effect){useEffect(()=>{let cleanup;const changed=()=>{cleanup?.();cleanup=focused?effect():undefined;};listeners.add(changed);changed();return()=>{listeners.delete(changed);cleanup?.();};},[effect]);}`,
    'expo-image': `import React from 'react';export const Image=({source,style})=>React.createElement('img',{src:source,style,'aria-hidden':true});`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';import {viewport} from 'react-native';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:viewport.left,right:viewport.right});`,
  };
  const result = await build({ stdin: { contents: `import React from 'react';export {viewport} from 'react-native';export {setAuthTestFocused as setFocused} from 'expo-router';
    import {View} from 'react-native';import {ThemeProvider} from './src/core/theme/ThemeContext';import {AuthProvider} from './src/features/auth/AuthContext';
    import {LoginScreen,RegistrationScreen,RecoveryScreen,AccountCreatedScreen,ProfileScreen} from './src/features/auth/AuthScreens';
    import {AuthFrame} from './src/features/auth/AuthForm';import {AuthField} from './src/features/auth/AuthField';import {TTScreen,TTNoticeCard} from './src/components';
    const screens={login:LoginScreen,register:RegistrationScreen,recovery:RecoveryScreen,created:AccountCreatedScreen,profile:ProfileScreen};
    export function Harness({gateway,kind}){const Screen=screens[kind];return <ThemeProvider><AuthProvider gateway={gateway}>
      <View style={{flex:1,minWidth:0,alignItems:'stretch'}}>{kind==='form'?<TTScreen variant='form'><View testID='form-probe'/></TTScreen>:
      kind==='long'?<AuthFrame presentation='access' title='Long error' description='Error fixture' backLabel='Back' onBack={()=>{}}><TTNoticeCard type='error' title='Unable to log in' message={'Long provider-safe message '.repeat(50)}/><AuthField label='Password' value='secret' onChange={()=>{}} placeholder='Password' password error={'Unbroken'.repeat(100)}/></AuthFrame>:
      <Screen origin='upload' sessionId='abc-123'/>}</View></AuthProvider></ThemeProvider>;}`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', loader: { '.svg': 'dataurl' },
    plugins: [{ name: 'auth-visual-platform-io', setup(builder) {
      builder.onResolve({ filter: /core\/auth\/session$|\.\/session$/ }, () => ({ path: 'auth-session', namespace: 'io' }));
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'io' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'io' }, args => ({ contents: args.path === 'auth-session' ? `export function getTopicTrailAuthGateway(){throw Error('No Firebase IO allowed')}` : boundaries[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  ui = module.exports as typeof ui;
});
after(() => {
  dom?.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
function fake() {
  const calls: unknown[][] = [];
  const state = { status: 'guest' } as const;
  const gateway: AuthGateway = {
    getSnapshot: () => state, subscribe: () => () => {},
    async signIn(...args) { calls.push(['signIn', ...args]); }, async register(...args) { calls.push(['register', ...args]); },
    async signOut() { calls.push(['signOut']); }, async sendPasswordReset(...args) { calls.push(['reset', ...args]); }, dispose() {},
  };
  return { gateway, calls };
}
async function mounted(kind: string, run: () => Promise<void> | void, gateway = fake().gateway) {
  routes.length = 0; ui.setFocused(true);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.querySelector('main')!);
  try {
    await act(async () => root.render(React.createElement(ui.Harness, { kind, gateway })));
    const { StyleSheet } = createRequire(resolve('package.json'))('react-native-web');
    dom.window.document.head.innerHTML = '<style>' + StyleSheet.getSheet().textContent + '</style>';
    await run();
  } finally { await act(async () => root.unmount()); }
}
const doc = () => dom.window.document;
function node(id: string) { const el = doc().querySelector<HTMLElement>(`[data-testid="${id}"]`); assert.ok(el, id); return el; }
function button(label: string) { const el = doc().querySelector<HTMLElement>(`[role="button"][aria-label="${label}"]`); assert.ok(el, label); return el; }
function field(label: string) { const el = doc().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); assert.ok(el, label); return el; }
async function click(label: string) { await act(async () => button(label).click()); }
async function fill(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
function css(el: HTMLElement) { return dom.window.getComputedStyle(el); }
function svgSource(image: HTMLImageElement) {
  const source = image.getAttribute('src')!;
  return source.includes(';base64,') ? Buffer.from(source.split(',')[1], 'base64').toString() : decodeURIComponent(source.slice(source.indexOf(',') + 1));
}

// Catches accidental shared form-cap changes, duplicate gutters, rail subtraction, and nonstretching parents.
test('auth_access_shell_is_bounded_and_scoped', async () => {
  ui.viewport.width = 1440;
  for (const kind of ['login', 'register']) await mounted(kind, () => {
    const shell = node('screen-content-wide');
    assert.equal(shell.style.maxWidth, '1140px'); assert.equal(shell.style.width, '100%');
    assert.equal(shell.style.paddingLeft, ''); assert.equal(shell.style.paddingRight, '');
    assert.equal(css(shell.parentElement!).flexGrow, '1');
    assert.equal(css(shell.parentElement!.parentElement!).alignItems, 'stretch');
    const card = node('auth-access-card');
    assert.equal(card.style.width, '440px'); assert.equal(card.style.maxWidth, '100%');
    assert.equal(card.style.padding, '32px'); assert.equal(css(card).borderTopWidth, '1px');
    assert.equal(css(card).boxSizing, 'border-box'); assert.equal(css(card).borderTopLeftRadius, '24px');
    assert.equal(node('auth-access-composition').style.columnGap || node('auth-access-composition').style.gap, '96px');
    assert.equal(node('auth-access-intro').style.minWidth, '0px');
    const submit = button(kind === 'login' ? 'Log in' : 'Create account');
    assert.ok(card.contains(submit)); assert.equal(submit.style.width, '100%');
    // Derive the usable inner width from rendered constraints, not JSDOM geometry.
    const cardStyle = css(card);
    assert.equal(parseFloat(cardStyle.width) - parseFloat(cardStyle.paddingLeft) - parseFloat(cardStyle.paddingRight)
      - parseFloat(cardStyle.borderLeftWidth) - parseFloat(cardStyle.borderRightWidth), 374);
    assert.equal(css(node('auth-access-intro')).flexGrow, '1');
    assert.equal(css(node('auth-access-intro')).flexShrink, '1');
    assert.equal(doc().querySelectorAll('[data-testid="auth-study-illustration"]').length, 1);
  });
  for (const kind of ['recovery', 'created', 'profile', 'form']) await mounted(kind, () => {
    assert.equal(node('screen-content-wide').style.maxWidth, '800px');
    assert.equal(doc().querySelector('[data-testid="auth-access-card"]'), null);
  });
});

// Literal, hand-derived composition budgets. No JSDOM width/scrollWidth is treated as measurement.
test('auth_access_stacks_without_horizontal_overflow', async () => {
  for (const fixture of [
    { width: 320, max: 288, gap: 24, left: null }, { width: 390, max: 358, gap: 24, left: null },
    { width: 768, max: 704, gap: 24, left: null }, { width: 1024, max: 960, gap: 48, left: 472 },
    { width: 1440, max: 1140, gap: 96, left: 604 },
  ]) {
    ui.viewport.width = fixture.width;
    await mounted('register', () => {
      const shell = node('auth-access-composition').closest('[data-testid^="screen-content-"]') as HTMLElement;
      assert.equal(shell.style.maxWidth, fixture.max + 'px');
      const composition = node('auth-access-composition');
      assert.equal(composition.style.flexDirection, fixture.left === null ? 'column' : 'row');
      assert.equal(composition.style.gap, fixture.gap + 'px');
      assert.equal(composition.style.width, '100%'); assert.equal(composition.style.minWidth, '0px');
      assert.equal(composition.style.maxWidth, fixture.left === null ? '440px' : '100%');
      if (fixture.left !== null) assert.equal(parseFloat(shell.style.maxWidth) - parseFloat(composition.style.gap)
        - parseFloat(css(node('auth-access-card')).width), fixture.left);
      assert.equal(node('auth-access-card').style.padding, fixture.width < 768 ? '20px' : '32px');
      assert.equal(doc().querySelectorAll('[data-testid="auth-study-illustration"]').length, fixture.left === null ? 0 : 1);
      assert.equal(node('auth-access-top-row').style.flexWrap, 'wrap');
      assert.equal(button('Back to log in').style.minHeight, '48px');
      assert.equal(button('Back to log in').style.flexShrink, '0');
      for (const label of ['Show password', 'Show confirm password']) {
        assert.equal(button(label).style.width, '48px'); assert.equal(button(label).style.minHeight, '48px');
        assert.equal(button(label).style.flexShrink, '0');
      }
      for (const input of doc().querySelectorAll<HTMLInputElement>('input')) {
        assert.equal(input.parentElement!.style.minHeight, '48px'); assert.equal(input.parentElement!.style.height, '');
      }
      assert.equal(button('Create account').style.width, '100%');
      const logo = node('auth-access-top-row').querySelector('img')!;
      assert.equal(logo.style.width, fixture.left === null ? '32px' : '44px');
      assert.equal(logo.style.height, logo.style.width);
      assert.equal(composition.style.height, ''); assert.equal(node('auth-access-card').style.height, '');
    });
  }
  ui.viewport.width = 390; ui.viewport.left = 24; ui.viewport.right = 12;
  try { await mounted('login', () => assert.equal(node('screen-content-compact').style.maxWidth, '322px')); }
  finally { ui.viewport.left = 0; ui.viewport.right = 0; }
});

// Catches inaccessible loading-only spinners, disappearing focus, fixed fields/errors, and coupled Show/Hide controls.
test('auth_copy_and_theme_states_are_consistent', async () => {
  ui.viewport.width = 1440;
  for (const mode of ['light', 'dark']) {
    theme = mode;
    await mounted('register', async () => {
      const text = doc().body.textContent!;
      assert.match(text, /Your syllabus\.\s*Your next discovery\./);
      assert.match(text, /Open your syllabus, highlight a topic, and find resources to help you understand it\./);
      assert.match(text, /Create your account/); assert.match(text, /Start exploring your syllabus, one topic at a time\./);
      assert.doesNotMatch(text, /Facebook|Google|Remember me/);
      assert.equal(field('Email address').getAttribute('aria-invalid'), 'false');
      assert.equal(field('Email address').getAttribute('autocomplete'), 'email');
      assert.equal(field('Password').getAttribute('autocomplete'), 'new-password');
      assert.equal(svgSource(node('auth-access-top-row').querySelector('img')!), readFileSync(resolve(`src/assets/figma/${mode === 'dark' ? '726ad' : '4117e'}.svg`), 'utf8'));
      assert.equal(node('auth-access-card').style.backgroundColor, mode === 'dark' ? 'rgb(17, 29, 50)' : 'rgb(255, 255, 255)');
      assert.equal(css(node('auth-access-card')).borderTopColor, mode === 'dark' ? 'rgb(52, 68, 93)' : 'rgb(216, 221, 229)');
      assert.equal(node('screen-content-wide').style.backgroundColor, mode === 'dark' ? 'rgb(11, 18, 32)' : 'rgb(245, 245, 245)');
      assert.equal(css(button('Create account')).borderTopColor, mode === 'dark' ? 'rgb(141, 178, 255)' : 'rgb(0, 51, 153)');
      assert.equal(css(button('Create account')).borderTopWidth, '1px');
      await act(async () => field('Password').focus());
      assert.equal(css(field('Password').parentElement!).borderTopWidth, '2px');
      assert.equal(css(field('Password').parentElement!).borderTopColor, mode === 'dark' ? 'rgb(141, 178, 255)' : 'rgb(0, 51, 153)');
      for (const label of ['Back to log in', 'Already have an account? Log in', 'Show password']) {
        await act(async () => button(label).focus());
        assert.equal(css(button(label)).outlineWidth, '2px');
        assert.equal(css(button(label)).outlineColor, mode === 'dark' ? 'rgb(141, 178, 255)' : 'rgb(0, 51, 153)');
        await act(async () => button(label).blur());
        assert.equal(css(button(label)).outlineWidth, '0px');
      }
      await click('Show password'); assert.equal(field('Password').type, 'text'); assert.equal(field('Confirm password').type, 'password');
      await click('Show confirm password'); assert.equal(field('Confirm password').type, 'text');
      await act(async () => button('Create account').focus());
      assert.equal(css(button('Create account')).outlineWidth, '2px');
      await click('Create account'); assert.equal(field('Email address').getAttribute('aria-invalid'), 'true');
      assert.ok(doc().getElementById(field('Email address').getAttribute('aria-describedby')!));
    });
    await mounted('long', () => {
      const error = doc().getElementById(field('Password').getAttribute('aria-describedby')!)!;
      assert.equal(error.textContent!.length, 800); assert.equal(error.style.height, '');
      assert.equal(error.style.overflowWrap, 'anywhere');
      assert.match(node('auth-access-card').textContent!, /Long provider-safe message/);
      assert.equal(node('auth-access-card').style.height, '');
    });
    for (const kind of ['login', 'register']) {
      const f = fake(); let finish!: () => void;
      const pending = () => new Promise<void>(resolve => { finish = resolve; });
      f.gateway.signIn = pending; f.gateway.register = pending;
      await mounted(kind, async () => {
        if (kind === 'login') assert.match(doc().body.textContent!, /Welcome backReady to explore your next topic\?/);
        else { await fill('Full name', 'Ada'); await fill('Confirm password', 'private passphrase'); }
        await fill('Email address', 'ada@example.com'); await fill('Password', 'private passphrase');
        await click(kind === 'login' ? 'Log in' : 'Create account');
        const status = node('auth-access-pending');
        assert.equal(status.getAttribute('role'), 'status');
        assert.equal(status.getAttribute('aria-live'), 'polite');
        assert.equal(status.textContent, kind === 'login' ? 'Logging in…' : 'Creating account…');
        assert.equal(button(kind === 'login' ? 'Logging in' : 'Creating account').getAttribute('aria-busy'), 'true');
        assert.equal(button(kind === 'login' ? 'Back to Upload' : 'Back to log in').getAttribute('aria-disabled'), 'true');
        assert.equal(field('Password').readOnly, true);
      }, f.gateway);
      await act(async () => finish());
    }
  }
  theme = 'light';
});

test('profile status has readable theme colors and account actions retain visible focus in both themes', async () => {
  const gateway = fake().gateway;
  // useSyncExternalStore requires the same snapshot object until the state changes.
  const snapshot = { status: 'account' as const, account: { uid: 'fixture', displayName: 'Ada Lovelace', email: 'ada@example.com', emailVerified: false } };
  gateway.getSnapshot = () => snapshot;
  try {
    for (const mode of ['light', 'dark']) {
      theme = mode; ui.viewport.width = 1440;
      await mounted('profile', async () => {
        const badge = node('profile-status');
        const status = [...badge.children].find(child => child.textContent === 'Signed in') as HTMLElement;
        assert.ok(status);
        // Regression for undefined colors.success, which rendered black on the dark surface.
        assert.equal(css(status).color, mode === 'dark' ? 'rgb(141, 178, 255)' : 'rgb(0, 51, 153)');
        assert.equal(css(badge).backgroundColor, mode === 'dark' ? 'rgb(24, 54, 109)' : 'rgb(231, 238, 255)');
        for (const label of ['Back to Settings', 'Reset password', 'Log out']) {
          await act(async () => button(label).focus());
          assert.equal(css(button(label)).outlineWidth, '2px');
          assert.equal(css(button(label)).outlineColor, mode === 'dark' ? 'rgb(141, 178, 255)' : 'rgb(0, 51, 153)');
          assert.notEqual(button(label).getAttribute('aria-disabled'), 'true');
          assert.equal(button(label).tabIndex, 0);
          await act(async () => button(label).blur());
        }
        assert.equal(node('screen-content-wide').style.maxWidth, '800px');
        assert.equal(doc().querySelector('[data-testid="auth-access-card"]'), null);
      }, gateway);
    }
  } finally { theme = 'light'; }
});

// Existing auth-ui/guest-upload-ui exercise provider payloads, registration receipt/partial success,
// recovery/logout, retained-focus lifetimes and upload continuation. This adds access-shell blur/back coverage.
test('auth_visual_change_preserves_context_and_cleanup', async () => {
  ui.viewport.width = 390;
  const f = fake();
  await mounted('login', async () => {
    await fill('Password', 'private passphrase');
    await act(async () => { field('Password').focus(); field('Password').blur(); });
    assert.equal(field('Password').value, 'private passphrase'); assert.deepEqual(f.calls, []); assert.deepEqual(routes, []);
    await click('Create account');
    assert.deepEqual(routes.at(-1), { pathname: '/auth/register', params: { origin: 'upload', sessionId: 'abc-123' } });
    assert.equal(field('Password').value, '');
    await fill('Password', 'another secret');
    await act(async () => ui.setFocused(false)); assert.equal(field('Password').value, '');
  }, f.gateway);
  await mounted('login', async () => { await click('Back to Upload'); assert.equal(routes.at(-1), '/upload'); }, f.gateway);
  assert.deepEqual(f.calls, []);
});
