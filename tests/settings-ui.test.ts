import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

// Real Settings, ThemeProvider, navigation and RN Web controls; only platform IO is replaced.
let ui: { SettingsHarness: React.ComponentType; NavigationHarness: React.ComponentType };
let dom: JSDOM;
const previous = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://settings.test', pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const boundaries: Record<string, string> = {
    '@react-native-async-storage/async-storage': `export default {getItem:async()=> 'light',setItem:async()=>{}};`,
    'expo-router': `export const router={canGoBack:()=>false,back(){},navigate(){}};`,
    'expo-image': `import React from 'react';export const Image=()=>React.createElement('span');`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
  };
  const compiled = await build({ stdin: { contents: `import React,{useState} from 'react';import {ThemeProvider} from './src/core/theme/ThemeContext';import {SettingsScreen} from './src/features/settings/SettingsScreen';import {TTBottomNavigationBar} from './src/navigation';export function SettingsHarness(){return <ThemeProvider><SettingsScreen/></ThemeProvider>}export function NavigationHarness(){const [current,setCurrent]=useState('home');return <ThemeProvider><TTBottomNavigationBar currentDestination={current} onDestinationSelected={setCurrent}/></ThemeProvider>}`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', alias: { 'react-native': 'react-native-web' }, loader: { '.svg': 'dataurl' },
    plugins: [{ name: 'settings-platform-io', setup(builder) {
      builder.onResolve({ filter: /core\/auth\/session$/ }, () => ({ path: 'auth-session', namespace: 'io' }));
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'io' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'io' }, args => ({ contents: args.path === 'auth-session'
        ? `export function getTopicTrailAuthGateway(){throw Error('Settings tests must not initialize provider IO')}`
        : boundaries[args.path], loader: 'tsx', resolveDir: process.cwd() }));
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
async function mounted(component: React.ComponentType, run: (document: globalThis.Document) => Promise<void>) {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.querySelector('main')!);
  try { await act(async () => root.render(React.createElement(component))); await run(dom.window.document); }
  finally { await act(async () => root.unmount()); }
}

test('theme switch exposes its actual checked state to browser accessibility across toggles', async () => {
  await mounted(ui.SettingsHarness, async document => {
    const control = document.querySelector<HTMLElement>('[role="switch"][aria-label="Dark mode"]');
    assert.ok(control);
    assert.equal(control.getAttribute('aria-checked'), 'false');
    await act(async () => control.click());
    assert.equal(control.getAttribute('aria-checked'), 'true');
    await act(async () => control.click());
    assert.equal(control.getAttribute('aria-checked'), 'false');
  });
});

test('bottom tabs expose the selected destination and update that state after navigation input', async () => {
  await mounted(ui.NavigationHarness, async document => {
    const home = document.querySelector<HTMLElement>('[role="tab"][aria-label="Home"]');
    const saved = document.querySelector<HTMLElement>('[role="tab"][aria-label="Saved"]');
    assert.ok(home); assert.ok(saved);
    assert.equal(home.getAttribute('aria-selected'), 'true');
    assert.equal(saved.getAttribute('aria-selected'), 'false');
    await act(async () => saved.click());
    assert.equal(home.getAttribute('aria-selected'), 'false');
    assert.equal(saved.getAttribute('aria-selected'), 'true');
  });
});

test('closing privacy details preserves that content throughout the modal exit animation', async () => {
  await mounted(ui.SettingsHarness, async document => {
    const open = document.querySelector<HTMLElement>('[role="button"][aria-label="Privacy details"]');
    assert.ok(open);
    await act(async () => open.click());
    const dialog = document.querySelector('[aria-modal="true"]');
    assert.ok(dialog);
    assert.ok(dialog.textContent?.includes('Your documents and selections'));
    const close = dialog.querySelector<HTMLElement>('[role="button"][aria-label="Back to Settings"]');
    assert.ok(close);
    await act(async () => close.click());
    // RN Web retains the real modal until its CSS exit animation finishes.
    const closingDialog = document.querySelector('[aria-modal="true"]');
    assert.ok(closingDialog);
    assert.ok(closingDialog.textContent?.includes('Your documents and selections'), 'privacy content must remain while sliding out');
    assert.ok(!closingDialog.textContent?.includes('Reputation checks are unavailable'), 'closing privacy must not reveal the other detail screen');
  });
});
