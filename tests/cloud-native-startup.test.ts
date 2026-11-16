import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

type Listener = () => void;
type Cleanup = () => void;

/** Execute the production provider's effects without adding JSDOM's browser APIs to native globals. */
function providerHarness(platform: 'android' | 'ios' | 'web', browserApi: 'complete' | 'partial' | 'absent' = 'absent') {
  const effects: (() => void | Cleanup)[] = [];
  const cleanups: Cleanup[] = [];
  const timers = new Map<number, Listener>();
  const browserListeners = new Map<string, Listener>();
  const browserAdded: string[] = [], browserRemoved: string[] = [];
  let activeListener: ((state: string) => void) | undefined;
  let syncCount = 0, attachCount = 0, detachCount = 0, nativeRemoved = 0;
  const gateway = {};
  const appState = {
    currentState: 'active',
    addEventListener(event: string, listener: (state: string) => void) {
      assert.equal(event, 'change');
      activeListener = listener;
      return { remove() { activeListener = undefined; nativeRemoved++; } };
    },
  };
  const runtime = {
    attach(value: unknown) { assert.equal(value, gateway); attachCount++; return () => { detachCount++; }; },
    sync() { syncCount++; return Promise.resolve(); },
  };
  const scope: Record<string, unknown> = {
    module: { exports: {} },
    require(name: string) {
      if (name === 'react') return { useEffect: (effect: () => void | Cleanup) => effects.push(effect), createElement: () => null };
      if (name === 'react-native') return { AppState: appState, Platform: { OS: platform } };
      if (name.endsWith('/AuthContext')) return { useAuth: () => ({ gateway }) };
      if (name.endsWith('/CloudLibraryContext')) return { CloudRuntimeContext: { Provider: {} } };
      throw Error('Unexpected production import: ' + name);
    },
    setInterval(callback: Listener, milliseconds: number) { assert.equal(milliseconds, 60000); timers.set(1, callback); return 1; },
    clearInterval(id: number) { timers.delete(id); },
  };
  const nativeModule = scope.module as { exports: { CloudLibraryProvider?: (props: unknown) => void } };
  scope.exports = nativeModule.exports;
  // RN 0.88 setUpGlobals defines window as globalThis; it does not create browser event methods.
  scope.window = scope;
  if (platform === 'web') scope.document = { visibilityState: 'visible' };
  if (browserApi !== 'absent') scope.addEventListener = (event: string, listener: Listener) => {
    browserAdded.push(event); browserListeners.set(event, listener);
  };
  if (browserApi === 'complete') scope.removeEventListener = (event: string, listener: Listener) => {
    browserRemoved.push(event); assert.equal(browserListeners.get(event), listener); browserListeners.delete(event);
  };
  const source = readFileSync(new URL('../src/features/library/CloudLibraryProvider.tsx', import.meta.url), 'utf8');
  runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code, scope,
    { filename: 'CloudLibraryProvider.tsx' });
  nativeModule.exports.CloudLibraryProvider!({ children: null, runtime });
  return {
    mount() { for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } },
    unmount() { for (const cleanup of cleanups.reverse()) cleanup(); },
    state(value: string) { appState.currentState = value; activeListener?.(value); },
    tick() { for (const callback of timers.values()) callback(); },
    event(value: string) { browserListeners.get(value)?.(); },
    visibility(value: string) { (scope.document as { visibilityState: string }).visibilityState = value; },
    replaceWindow() { scope.window = {}; },
    stats: () => ({ syncCount, attachCount, detachCount, nativeRemoved, timers: timers.size,
      browserListeners: browserListeners.size, browserAdded: [...browserAdded], browserRemoved: [...browserRemoved] }),
  };
}

for (const platform of ['android', 'ios'] as const) {
  test(platform + ' root provider mounts with the real native window shape and cleans up', () => {
    const app = providerHarness(platform);
    assert.doesNotThrow(() => app.mount());
    assert.equal(app.stats().attachCount, 1);
    app.state('background'); app.tick();
    assert.equal(app.stats().syncCount, 0);
    app.state('active');
    assert.equal(app.stats().syncCount, 1);
    app.tick();
    assert.equal(app.stats().syncCount, 2);
    assert.doesNotThrow(() => app.unmount());
    assert.deepEqual(app.stats(), { syncCount: 2, attachCount: 1, detachCount: 1, nativeRemoved: 1,
      timers: 0, browserListeners: 0, browserAdded: [], browserRemoved: [] });
    app.state('active'); app.tick();
    assert.equal(app.stats().syncCount, 2);
  });
}

test('native provider uses AppState even when an unrelated global exposes browser-like methods', () => {
  const app = providerHarness('android', 'complete');
  app.mount();
  assert.deepEqual(app.stats().browserAdded, []);
  app.state('active');
  assert.equal(app.stats().syncCount, 1);
  app.unmount();
});

test('web focus/online synchronization respects visibility and removes captured browser listeners', () => {
  const app = providerHarness('web', 'complete');
  app.mount();
  assert.deepEqual(app.stats().browserAdded, ['focus', 'online']);
  app.event('focus'); app.event('online');
  assert.equal(app.stats().syncCount, 2);
  app.visibility('hidden'); app.event('focus'); app.tick();
  assert.equal(app.stats().syncCount, 2);
  app.visibility('visible'); app.tick();
  assert.equal(app.stats().syncCount, 3);
  app.replaceWindow();
  app.unmount();
  assert.deepEqual(app.stats().browserRemoved, ['focus', 'online']);
  assert.equal(app.stats().browserListeners, 0);
  assert.equal(app.stats().timers, 0);
});

for (const capability of ['absent', 'partial'] as const) {
  test('web provider remains usable with ' + capability + ' browser event capability', () => {
    const app = providerHarness('web', capability);
    assert.doesNotThrow(() => app.mount());
    assert.deepEqual(app.stats().browserAdded, []);
    app.tick();
    assert.equal(app.stats().syncCount, 1);
    assert.doesNotThrow(() => app.unmount());
    assert.equal(app.stats().timers, 0);
  });
}
