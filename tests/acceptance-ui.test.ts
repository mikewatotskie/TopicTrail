import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import type { WebViewProps } from 'react-native-webview';
import {
  acceptanceGate, isFixtureUrl, makeNativeEvent, appendNativeEvent, nativeErrorMessage,
} from '../src/features/acceptance/policy';

// These are headless source/guard checks. Native callbacks are not device evidence.
const approved = { development: true, platform: 'android', packageName: 'com.teamjam.topictrail.acceptance',
  nativeConfig: { Constants: { topicTrailDownloadPolicyVersion: 1 } } };

test('headless acceptance gate refuses release and normal packages before a local source can be used', () => {
  assert.equal(acceptanceGate(approved).enabled, true);
  assert.equal(acceptanceGate({ ...approved, development: false }).enabled, false);
  for (const packageName of [undefined, '', 'com.teamjam.topictrail', 'com.teamjam.topictrail.acceptance.extra'])
    assert.equal(acceptanceGate({ ...approved, packageName }).enabled, false);
  for (const platform of ['ios', 'web']) assert.equal(acceptanceGate({ ...approved, platform }).enabled, false);
});

test('headless acceptance gate requires a numeric native marker 1 inside actual view-manager constants', () => {
  for (const nativeConfig of [null, {}, { Constants: null }, { Constants: {} },
    { topicTrailDownloadPolicyVersion: 1 }, { Constants: { topicTrailDownloadPolicyVersion: '1' } },
    { Constants: { topicTrailDownloadPolicyVersion: 0 } }, { Constants: { topicTrailDownloadPolicyVersion: 2 } }])
    assert.equal(acceptanceGate({ ...approved, nativeConfig }).enabled, false);
});

test('headless fixture policy allows only the exact approved loopback endpoints', () => {
  for (const path of ['/page/one', '/page/two', '/attachment', '/redirect/same', '/redirect/blocked',
    '/popup', '/scheme', '/http/404', '/http/500', '/stall'])
    assert.equal(isFixtureUrl(`http://127.0.0.1:8765${path}`), true, path);
  for (const url of ['http://localhost:8765/page/one', 'http://127.0.0.1:8766/page/one',
    'http://127.0.0.1:8765/unknown', 'http://127.0.0.1:8765/page/one?private=passage',
    'http://127.0.0.1:8765/page/one#fragment', 'http://user@127.0.0.1:8765/page/one',
    'https://blocked.invalid/', 'https://en.wikipedia.org/', 'topictrail-test://denied',
    'javascript:alert(1)', 'file:///private.pdf', 'about:blank', 'http://2130706433:8765/page/one'])
    assert.equal(isFixtureUrl(url), false, url);
});

test('headless diagnostic events retain safe fixture fields and redact arbitrary content and destinations', () => {
  assert.deepEqual(makeNativeEvent(4, 'error', { url: 'http://127.0.0.1:8765/attachment', code: -9001,
    title: 'SECRET DOCUMENT', description: 'SECRET PASSAGE', loading: false, canGoBack: true }),
  { sequence: 4, kind: 'error', url: 'http://127.0.0.1:8765/attachment', code: -9001, loading: false, canGoBack: true });
  const event = makeNativeEvent(5, 'request', { url: 'https://private.example/SECRET', code: Number.NaN });
  assert.equal(event.url, '[unapproved URL redacted]'); assert.equal(event.code, undefined);
  assert.equal(makeNativeEvent(6, 'request', { url: 'https://blocked.invalid/' }).url, 'https://blocked.invalid/');
  assert.equal(makeNativeEvent(7, 'request', { url: 'topictrail-test://denied' }).url, 'topictrail-test://denied');
});

test('headless native event journal keeps the last twenty callbacks in their received order', () => {
  let events: ReturnType<typeof makeNativeEvent>[] = [];
  for (let index = 1; index <= 25; index++) events = appendNativeEvent(events,
    makeNativeEvent(index, 'load', { url: 'http://127.0.0.1:8765/page/one' }));
  assert.equal(events.length, 20); assert.equal(events[0].sequence, 6); assert.equal(events[19].sequence, 25);
});

test('headless native denial retains error -9001 while other errors do not disclose native descriptions', () => {
  assert.match(nativeErrorMessage(-9001), /-9001.*download denied/i);
  assert.match(nativeErrorMessage(-2), /-2/);
});

interface HeadlessUI {
  default: React.ComponentType;
  Screen: React.ComponentType;
  platform: { OS: string };
  config: { expoConfig: { android: { package: string } } };
  native: { value: unknown; throws: boolean; calls: string[] };
  web: { props: WebViewProps | null; mounted: number; stops: number; backs: number };
}
let ui: HeadlessUI;
let dom: JSDOM;
const originals = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://acceptance-headless.test', pretendToBeVisual: true });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true, __ACCEPTANCE_TEST_DEV__: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const tokens = resolve('src/core/design/tokens.ts').replaceAll('\\', '/');
  const boundaries: Record<string, string> = {
    'react-native': `export * from 'react-native-web';export const native={value:null,throws:false,calls:[]};export const UIManager={getViewManagerConfig(name){native.calls.push(name);if(native.throws)throw Error('native lookup unavailable');return native.value}};`,
    'react-native-webview': `import React from 'react';export const web={props:null,mounted:0,stops:0,backs:0};export const WebView=React.forwardRef((props,ref)=>{web.props=props;React.useImperativeHandle(ref,()=>({stopLoading(){web.stops++},goBack(){web.backs++}}));React.useEffect(()=>{web.mounted++;return()=>{web.mounted--}},[]);return React.createElement('div',{'data-testid':props.testID})});`,
    'expo-constants': `export default {expoConfig:{android:{package:'com.teamjam.topictrail.acceptance'}}};`,
    'expo-linking': `export async function openURL(){throw Error('No external launch is authorized by a headless acceptance test')};`,
    'expo-router': `import React from 'react';export const router={canGoBack:()=>false,back(){},replace(){}};export const Redirect=()=>null;`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';`,
    'expo-image': `import React from 'react';export const Image=()=>React.createElement('span');`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    theme: `import {TTLightColors} from '${tokens}';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
  };
  const compiled = await build({ stdin: { contents: `export {default} from './src/app/acceptance';export {AcceptanceScreen as Screen} from './src/features/acceptance/AcceptanceScreen';export {native} from 'react-native';import {Platform} from 'react-native';export const platform=Platform;export {default as config} from 'expo-constants';export {web} from 'react-native-webview';`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', loader: { '.svg': 'dataurl' },
    define: { __DEV__: 'globalThis.__ACCEPTANCE_TEST_DEV__' },
    plugins: [{ name: 'headless-platform-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const name = /ThemeContext$/.test(args.path) ? 'theme' : args.path;
        if (Object.hasOwn(boundaries, name)) return { path: name, namespace: 'boundary' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: boundaries[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  ui = module.exports as HeadlessUI;
});
after(() => { dom?.window.close(); for (const [key, descriptor] of originals) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
} });

async function mounted(run: (doc: globalThis.Document) => Promise<void>, prepare?: () => void, directScreen = false) {
  Reflect.set(globalThis, '__ACCEPTANCE_TEST_DEV__', true);
  ui.platform.OS = 'android'; ui.config.expoConfig.android.package = 'com.teamjam.topictrail.acceptance';
  ui.native.value = { Constants: { topicTrailDownloadPolicyVersion: 1, nativeDiagnostic: 73 } };
  ui.native.throws = false; ui.native.calls.length = 0;
  ui.web.props = null; ui.web.mounted = 0; ui.web.stops = 0; ui.web.backs = 0;
  prepare?.();
  const { createRoot } = await import('react-dom/client'); const root = createRoot(dom.window.document.querySelector('main')!);
  try { await act(async () => root.render(React.createElement(directScreen ? ui.Screen : ui.default))); await run(dom.window.document); }
  finally { await act(async () => root.unmount()); }
}
async function press(doc: globalThis.Document, label: string) {
  const button = doc.querySelector<HTMLElement>(`[role="button"][aria-label="${label}"]`);
  assert.ok(button, label); await act(async () => button.click());
}
function invoke(name: keyof WebViewProps, data: object, nativeEvent = true) {
  const callback = ui.web.props?.[name] as unknown as (event: object) => unknown;
  assert.equal(typeof callback, 'function', String(name));
  return callback(nativeEvent ? { nativeEvent: data } : data);
}
const pageOne = 'http://127.0.0.1:8765/page/one';
const pageTwo = 'http://127.0.0.1:8765/page/two';

// Android Fabric's compiled RNCWebViewProps converter requires an array here.
// A public-API-valid string reached that converter and caused native SIGABRT.
for (const label of ['Open fixture /page/one', 'Production browser: Wikipedia Photosynthesis'])
  test(`headless ${label} sends an array to the native data-detector boundary to avoid Android Fabric abort`, async () => {
    await mounted(async doc => {
      await press(doc, label);
      assert.deepEqual(ui.web.props?.dataDetectorTypes, ['none']);
    });
  });

test('headless actual acceptance route is unavailable in release or a normal production package', async () => {
  for (const prepare of [() => Reflect.set(globalThis, '__ACCEPTANCE_TEST_DEV__', false),
    () => { ui.config.expoConfig.android.package = 'com.teamjam.topictrail'; }])
    await mounted(async doc => {
      assert.equal(doc.querySelector('[aria-label="Open fixture /page/one"]'), null);
      assert.equal(ui.web.mounted, 0); assert.deepEqual(ui.native.calls, []);
    }, prepare);
});

test('headless direct screen hides all native diagnostics and emits no diagnostic logs outside the acceptance debug build', async context => {
  const logging = context.mock.method(console, 'info', () => {});
  try {
    for (const prepare of [() => Reflect.set(globalThis, '__ACCEPTANCE_TEST_DEV__', false),
      () => { ui.config.expoConfig.android.package = 'com.teamjam.topictrail'; },
      () => { ui.platform.OS = 'ios'; }])
      await mounted(async doc => {
        assert.match(doc.body.textContent!, /Acceptance unavailable/);
        assert.ok(doc.querySelector('[aria-label="Exit acceptance"]'));
        assert.equal(doc.querySelector('[data-testid="acceptance-native-constants"]'), null);
        assert.equal(doc.querySelector('[data-testid="acceptance-native-events"]'), null);
        assert.equal(doc.querySelector('[aria-label="Open fixture /page/one"]'), null);
        assert.doesNotMatch(doc.body.textContent!, /nativeDiagnostic|UIManager|RNCWebView|127\.0\.0\.1|topicTrailDownloadPolicyVersion/);
        assert.deepEqual(ui.native.calls, []); assert.equal(ui.web.mounted, 0);
      }, prepare, true);
    assert.equal(logging.mock.calls.length, 0);
  } finally { logging.mock.restore(); }
});

test('headless screen displays the returned native constants unchanged and missing native proof mounts no fixture', async () => {
  await mounted(async doc => {
    assert.deepEqual(ui.native.calls, ['RNCWebView']);
    assert.match(doc.body.textContent!, /"nativeDiagnostic":73/);
    assert.match(doc.body.textContent!, /"topicTrailDownloadPolicyVersion":1/);
    assert.equal(ui.web.mounted, 0);
  });
  for (const prepare of [() => { ui.native.value = { Constants: {} }; }, () => { ui.native.throws = true; }])
    await mounted(async doc => {
      assert.match(doc.body.textContent!, /marker 1 is required/);
      assert.equal(doc.querySelector('[aria-label="Open fixture /page/one"]'), null);
      assert.equal(ui.web.mounted, 0);
    }, prepare);
});

test('headless real screen mounts only a chosen fixture with scripts, file access, cookies and automatic external handoff disabled', async () => {
  await mounted(async doc => {
    await press(doc, 'Open fixture /page/one'); assert.equal(ui.web.mounted, 1);
    const props = ui.web.props!; assert.deepEqual(props.source, { uri: pageOne }); assert.deepEqual(props.originWhitelist, ['*']);
    for (const property of ['javaScriptEnabled', 'javaScriptCanOpenWindowsAutomatically', 'allowFileAccess',
      'allowFileAccessFromFileURLs', 'allowUniversalAccessFromFileURLs', 'domStorageEnabled', 'thirdPartyCookiesEnabled',
      'sharedCookiesEnabled', 'geolocationEnabled', 'cacheEnabled', 'webviewDebuggingEnabled'] as const)
      assert.equal(props[property], false, property);
    assert.equal(props.incognito, true); assert.equal(props.mixedContentMode, 'never');
    assert.equal(props.onMessage, undefined); assert.equal(props.injectedJavaScript, undefined);
    let allowed: unknown; await act(async () => { allowed = invoke('onShouldStartLoadWithRequest', { url: pageTwo }, false); });
    assert.equal(allowed, true);
    await act(async () => invoke('onLoad', { url: pageTwo }));
    assert.match(doc.body.textContent!, /Ready/); assert.match(doc.body.textContent!, /page\/two/);
    await press(doc, 'Close fixture'); assert.equal(ui.web.mounted, 0);
    assert.match(doc.body.textContent!, /load/);
  });
});

test('headless later cross-origin and unknown-scheme callbacks stop and unmount the current fixture', async () => {
  for (const url of ['https://blocked.invalid/', 'topictrail-test://denied', 'https://private.example/SECRET'])
    await mounted(async doc => {
      await press(doc, 'Open fixture /page/one'); let allowed: unknown;
      await act(async () => { allowed = invoke('onShouldStartLoadWithRequest', { url }, false); });
      assert.equal(allowed, false); assert.equal(ui.web.mounted, 0); assert.equal(ui.web.stops, 1);
      assert.match(doc.body.textContent!, /Blocked destination/); assert.doesNotMatch(doc.body.textContent!, /SECRET/);
    });
});

test('headless popup callback is denied even when its target is an approved local fixture', async () => {
  await mounted(async doc => {
    await press(doc, 'Open fixture /popup');
    await act(async () => invoke('onOpenWindow', { targetUrl: pageTwo }));
    assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /Popup blocked/);
  });
});

test('headless callback screening also denies a request explicitly lacking a target frame', async () => {
  await mounted(async doc => {
    await press(doc, 'Open fixture /popup'); let allowed: unknown;
    await act(async () => { allowed = invoke('onShouldStartLoadWithRequest', { url: pageTwo, hasTargetFrame: false }, false); });
    assert.equal(allowed, false); assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /Popup blocked/);
  });
});

for (const name of ['onNavigationStateChange', 'onLoadStart', 'onLoad', 'onLoadProgress', 'onLoadEnd', 'onHttpError'] as const)
  test(`headless late ${name} stops an unapproved destination without a shouldStart callback`, async () => {
    await mounted(async doc => {
      await press(doc, 'Open fixture /redirect/blocked');
      await act(async () => invoke(name, { url: 'https://blocked.invalid/', progress: 0.5, statusCode: 500 }, name !== 'onNavigationStateChange'));
      assert.equal(ui.web.mounted, 0, name); assert.match(doc.body.textContent!, /Blocked destination/);
    });
  });

test('headless native download denial is visible as -9001 and retry creates a fresh fixture lifetime', async () => {
  await mounted(async doc => {
    await press(doc, 'Open fixture /attachment'); const previousLoad = ui.web.props!.onLoad!;
    await act(async () => invoke('onError', { url: 'http://127.0.0.1:8765/attachment', code: -9001, description: 'SECRET native description' }));
    assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /-9001.*download denied/i);
    assert.doesNotMatch(doc.body.textContent!, /SECRET/);
    await press(doc, 'Reload fixture'); assert.equal(ui.web.mounted, 1);
    await act(async () => previousLoad({ nativeEvent: { url: pageOne } } as never));
    assert.doesNotMatch(doc.body.textContent!, /Ready/);
  });
});

test('headless navigation enables native back, stop unmounts, and reload preserves the current allowed page', async () => {
  await mounted(async doc => {
    await press(doc, 'Open fixture /page/one');
    await act(async () => invoke('onNavigationStateChange', { url: pageTwo, canGoBack: true, loading: false }, false));
    await press(doc, 'Fixture back'); assert.equal(ui.web.backs, 1);
    await press(doc, 'Stop fixture'); assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /Stopped by operator/);
    await press(doc, 'Reload fixture'); assert.equal(ui.web.mounted, 1); assert.deepEqual(ui.web.props!.source, { uri: pageTwo });
  });
});

test('headless HTTP failure displays its actual status and unmounts the fixture', async () => {
  await mounted(async doc => {
    await press(doc, 'Open fixture /http/500');
    await act(async () => invoke('onHttpError', { url: 'http://127.0.0.1:8765/http/500', statusCode: 500, description: 'SECRET' }));
    assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /HTTP 500/); assert.doesNotMatch(doc.body.textContent!, /SECRET/);
  });
});

test('headless direct production entry uses the real ResourceBrowser without creating provider results', async () => {
  await mounted(async doc => {
    await press(doc, 'Production browser: Wikipedia Photosynthesis');
    assert.equal(ui.web.mounted, 1);
    assert.deepEqual(ui.web.props!.source, { uri: 'https://en.wikipedia.org/wiki/Photosynthesis' });
    assert.equal(doc.querySelector('[data-testid="acceptance-fixture-webview"]'), null);
    assert.match(doc.body.textContent!, /Direct production component/);
    await press(doc, 'Close website'); assert.equal(ui.web.mounted, 0);
  });
});

test('headless direct production initial gates retain the unchanged HTTP, IP, unknown-host and scheme rejection', async () => {
  for (const label of ['Blocked HTTP initial', 'Blocked local IP initial', 'Unknown host initial', 'Blocked scheme initial'])
    await mounted(async doc => {
      await press(doc, `Production browser: ${label}`);
      assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /Cannot open this link in TopicTrail/);
      await press(doc, 'Close website'); assert.equal(ui.web.mounted, 0);
    });
});

test('headless stall timeout unmounts after twenty seconds and adds no fabricated native callback', async context => {
  await mounted(async doc => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await press(doc, 'Open fixture /stall');
      await act(async () => context.mock.timers.tick(19999)); assert.equal(ui.web.mounted, 1);
      await act(async () => context.mock.timers.tick(1)); assert.equal(ui.web.mounted, 0);
      assert.match(doc.body.textContent!, /App timeout after 20 seconds/);
      assert.match(doc.body.textContent!, /No fixture callbacks received/);
    } finally { context.mock.timers.reset(); }
  });
});
