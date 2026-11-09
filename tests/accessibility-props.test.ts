import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { nativeProbeSource, type NativePropRecord } from './helpers/accessibility';

let ui: { components: Record<string, React.ComponentType<any>>; setProbePlatform: (platform: string) => void;
  nativeProps: NativePropRecord[]; roleViolations: string[] };
let dom: JSDOM;
const previous = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://accessibility.test', pretendToBeVisual: true });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const boundaries: Record<string, string> = {
    'react-native': nativeProbeSource(),
    'theme': `import {TTLightColors} from './src/core/design/tokens';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    'expo-image': `import React from 'react';export const Image=()=>React.createElement('span');`,
    'react-native-safe-area-context': `export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
  };
  const compiled = await build({ stdin: { contents: `export {setProbePlatform,nativeProps,roleViolations} from 'react-native';
    import {TTFeedback,TTFeedbackRegion} from './src/components/TTFeedback';import {TTNoticeCard,TTUploadDocumentCard} from './src/components/TTCard';
    import {TTButton} from './src/components/TTButton';import {TTIconButton} from './src/components/TTIconButton';import {TTSearchInput} from './src/components/TTInput';
    import {Text} from 'react-native';import {AuthField} from './src/features/auth/AuthField';export const components={Text,TTFeedback,TTFeedbackRegion,TTNoticeCard,TTUploadDocumentCard,TTButton,TTIconButton,TTSearchInput,AuthField};`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', loader: { '.svg': 'dataurl' },
    plugins: [{ name: 'accessibility-boundaries', setup(builder) {
      builder.onResolve({ filter: /ThemeContext$/ }, () => ({ path: 'theme', namespace: 'io' }));
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'io' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'io' }, args => ({ contents: boundaries[args.path], loader: 'tsx', resolveDir: process.cwd() }));
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
async function mounted(name: string, platform: string, props: object, run: (update: (props: object) => Promise<void>) => Promise<void>) {
  ui.setProbePlatform(platform);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.querySelector('main')!);
  const update = async (next: object) => { await act(async () => root.render(React.createElement(React.StrictMode, {}, React.createElement(ui.components[name], next)))); };
  try { await update(props); await run(update); assert.deepEqual(ui.roleViolations, []); }
  finally { await act(async () => root.unmount()); }
}
const doc = () => dom.window.document;
const record = (id: string) => ui.nativeProps.filter(item => item.testID === id).at(-1)!;
const node = (id: string) => doc().querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

test('Android feedback primes a single native node, uses polite status and a valid assertive alert, and survives intent changes', async () => {
  await mounted('TTFeedback', 'android', { message: 'Working', testID: 'feedback' }, async update => {
    const history = ui.nativeProps.filter(item => item.testID === 'feedback');
    assert.equal(history[0].text, ''); assert.equal(history[0].accessible, false);
    assert.equal(history.at(-1)!.text, 'Working'); assert.equal(history.at(-1)!.accessible, true);
    assert.equal(record('feedback').accessibilityRole, undefined); assert.equal(record('feedback').role, undefined);
    assert.equal(record('feedback').accessibilityLiveRegion, 'polite'); assert.equal(record('feedback')['aria-live'], undefined);
    const stable = node('feedback');
    await update({ message: 'Finished', testID: 'feedback' }); assert.equal(node('feedback'), stable);
    await update({ message: 'Failed', kind: 'alert', testID: 'feedback' });
    assert.equal(record('feedback').accessibilityRole, 'alert'); assert.equal(record('feedback').accessibilityLiveRegion, 'assertive');
    await update({ message: 'Ordinary information', kind: 'off', testID: 'feedback' });
    assert.equal(record('feedback').accessibilityRole, undefined); assert.equal(record('feedback').accessibilityLiveRegion, undefined);
  });
});

test('web feedback retains status/alert semantics and updates one stable region without hiding it from accessibility', async () => {
  await mounted('TTFeedback', 'web', { message: '', testID: 'feedback' }, async update => {
    const stable = node('feedback');
    assert.equal(stable.getAttribute('role'), 'status'); assert.equal(stable.getAttribute('aria-live'), 'polite');
    await update({ message: 'Working', testID: 'feedback', visuallyHidden: true });
    assert.equal(node('feedback'), stable); assert.equal(stable.textContent, 'Working');
    assert.equal(stable.getAttribute('aria-hidden'), null); assert.notEqual(stable.style.display, 'none');
    assert.equal(doc().querySelectorAll('[role="status"]').length, 1);
    await update({ message: 'Failed', kind: 'alert', testID: 'feedback' });
    assert.equal(node('feedback').getAttribute('role'), 'alert'); assert.equal(node('feedback').getAttribute('aria-live'), 'assertive');
    // ARIA status/alert supply implicit atomic=true; RN Web 0.21.4 drops explicit aria-atomic.
    assert.equal(doc().querySelectorAll('[role="status"]').length, 0);
  });
});

test('feedback keeps SSR content and hydrates without dropping the message or generating mismatches', async () => {
  ui.setProbePlatform('web');
  const element = React.createElement(ui.components.TTNoticeCard, { type: 'error', title: 'Failed', message: 'Please retry', actionLabel: 'Retry', onActionPressed() {} });
  const html = renderToString(element);
  assert.match(html, /Failed/); assert.match(html, /Please retry/); assert.match(html, /role="alert"/);
  const container = doc().querySelector('main')!; container.innerHTML = html;
  const existing = container.querySelector('[role="alert"]');
  const errors: unknown[] = [];
  const { hydrateRoot } = await import('react-dom/client');
  let root!: ReturnType<typeof hydrateRoot>;
  try {
    await act(async () => { root = hydrateRoot(container, element, { onRecoverableError: error => errors.push(error) }); });
    assert.deepEqual(errors, []); assert.equal(container.querySelector('[role="alert"]'), existing);
    assert.match(existing!.textContent!, /FailedPlease retry/);
  } finally { if (root) await act(async () => root.unmount()); }
});

for (const platform of ['android', 'web']) {
  test(`${platform} feedback ignores injected raw roles/live props and fails malformed intent closed`, async () => {
    for (const name of ['TTFeedback', 'TTFeedbackRegion']) await mounted(name, platform, {
      kind: 'status', message: 'Safe', children: React.createElement(ui.components.Text, {}, 'Safe'), testID: 'safe', accessibilityRole: 'status', role: 'bogus', 'aria-live': 'assertive', accessibilityLiveRegion: 'broken',
    }, async update => {
      if (platform === 'android') { assert.equal(record('safe').role, undefined); assert.equal(record('safe').accessibilityRole, undefined); }
      else assert.equal(node('safe').getAttribute('role'), 'status');
      await update({ kind: 'malformed', message: 'Ordinary', children: React.createElement(ui.components.Text, {}, 'Ordinary'), testID: 'safe' });
      assert.equal(node('safe').getAttribute('role'), null); assert.equal(node('safe').getAttribute('aria-live'), null);
    });
  });

  test(`${platform} shared controls override malformed/conflicting role spreads but retain labels, state and handlers`, async () => {
    for (const name of ['TTButton', 'TTIconButton']) for (const role of ['status', 'checkbox', 'not-a-role', 42, { bad: true }]) {
      let presses = 0;
      const props = { label: 'Run', icon: 'close', testID: 'control', accessibilityLabel: 'Custom label', onPress: () => { presses++; }, role, accessibilityRole: role };
      await mounted(name, platform, props, async update => {
        assert.equal(node('control').getAttribute('role'), 'button'); assert.equal(node('control').getAttribute('aria-label'), 'Custom label');
        await act(async () => node('control').click()); assert.equal(presses, 1);
        await update({ ...props, disabled: true }); await act(async () => node('control').click()); assert.equal(presses, 1);
        assert.equal(node('control').getAttribute('aria-disabled'), 'true');
        if (platform === 'android') { assert.equal(record('control').accessibilityRole, 'button'); assert.equal(record('control').role, undefined); }
      });
    }
  });

  test(`${platform} search input clears role injection and retains native input semantics, edits and clear action`, async () => {
    const changes: string[] = [];
    const props = { value: 'topic', hintText: 'Search topics', testID: 'search', onChanged: (value: string) => changes.push(value), role: 'button', accessibilityRole: 'status' };
    await mounted('TTSearchInput', platform, props, async update => {
      const input = node('search') as HTMLInputElement;
      assert.equal(input.tagName, 'INPUT'); assert.equal(input.getAttribute('role'), null); assert.equal(input.getAttribute('aria-label'), 'Search topics');
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'biology');
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      await act(async () => doc().querySelector<HTMLElement>('[aria-label="Clear search"]')!.click());
      assert.deepEqual(changes, ['biology', '']);
      if (platform === 'android') { assert.equal(record('search').role, undefined); assert.equal(record('search').accessibilityRole, undefined); }
      for (const malformed of ['not-a-role', 42, { bad: true }]) {
        await update({ ...props, role: malformed, accessibilityRole: malformed });
        assert.equal(node('search').getAttribute('role'), null);
      }
    });
  });

  test(`${platform} notices announce only the message, leave actions outside, and opt ordinary info out`, async () => {
    let actions = 0, dismisses = 0;
    const props = { title: 'Notice', message: 'Message', actionLabel: 'Retry', onActionPressed: () => { actions++; }, onDismiss: () => { dismisses++; } };
    await mounted('TTNoticeCard', platform, props, async update => {
      assert.equal(doc().querySelector('[aria-live]'), null);
      for (const type of ['error', 'success']) {
        await update({ ...props, type });
        const region = doc().querySelector('[aria-live]')!;
        assert.ok(region); assert.equal(region.textContent, 'NoticeMessage');
        assert.equal(region.getAttribute('aria-live'), type === 'error' ? 'assertive' : 'polite');
        assert.equal(region.querySelector('[role="button"]'), null);
        assert.equal(doc().querySelectorAll('[aria-live]').length, 1);
        if (platform === 'android') {
          const group = ui.nativeProps.filter(p => p.host === 'View' && p.text === 'NoticeMessage').at(-1)!;
          assert.equal(group.accessible, true); assert.equal(group.accessibilityRole, type === 'error' ? 'alert' : undefined);
        } else assert.equal(region.getAttribute('role'), type === 'error' ? 'alert' : 'status');
        await act(async () => { doc().querySelector<HTMLElement>('[aria-label="Retry"]')!.click(); doc().querySelector<HTMLElement>('[aria-label="Dismiss notice"]')!.click(); });
      }
      assert.equal(actions, 2); assert.equal(dismisses, 2);
      await update({ ...props, announcement: 'status' }); assert.equal(doc().querySelector('[aria-live]')?.getAttribute('aria-live'), 'polite');
      await update({ ...props, type: 'error', announcement: 'off' }); assert.equal(doc().querySelector('[aria-live]'), null);
    });
  });

  test(`${platform} upload loading/error and field validation expose live feedback without duplicate actionable regions`, async () => {
    await mounted('TTUploadDocumentCard', platform, {}, async update => {
      await update({ isProcessing: true });
      assert.ok([...doc().querySelectorAll('[aria-live="polite"]')].some(node => node.textContent === 'Importing document…'));
      await update({ errorMessage: 'Cannot import this file' });
      assert.equal(doc().querySelector('[aria-live="assertive"]')?.textContent, 'Cannot import this file');
    });
    const props = { label: 'Email', value: '', onChange() {}, placeholder: 'Email' };
    await mounted('AuthField', platform, props, async update => {
      const region = doc().querySelector('[aria-live="polite"]')!;
      await update({ ...props, error: 'Enter email' });
      assert.equal(doc().querySelector('[aria-live="polite"]'), region); assert.equal(region.textContent, 'Enter email');
      const input = doc().querySelector('input')!;
      if (platform === 'web') { assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.equal(input.getAttribute('aria-describedby'), region.id); }
      else assert.equal(ui.nativeProps.filter(p => p.host === 'TextInput').at(-1)!.accessibilityHint, 'Enter email');
      await update(props); assert.equal(region.textContent, '');
    });
  });
}

test('loading button has one named busy control and a decorative spinner', async () => {
  await mounted('TTButton', 'android', { label: 'Save', isLoading: true, onPress() {}, testID: 'button' }, async () => {
    assert.equal(record('button').accessibilityLabel, 'Save'); assert.equal(record('button').accessibilityState?.busy, true);
    const spinner = ui.nativeProps.find(p => p.host === 'ActivityIndicator')!;
    assert.equal(spinner.accessible, false); assert.equal(spinner['aria-hidden'], true); assert.equal(spinner.importantForAccessibility, 'no');
  });
});
