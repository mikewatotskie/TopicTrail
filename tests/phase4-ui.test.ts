import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import type { DiscoveryResult, SearchSelection } from '../src/core/services/resources/types';
import type { BookmarkRepository } from '../src/core/services/bookmarks/repository';
import type { WebViewProps } from 'react-native-webview';

// Real resource screen, hook, query/session logic and RN controls. Only platform IO and provider IO are replaced.
interface Request { selection: SearchSelection; query: string; signal: AbortSignal; resolve: (v: DiscoveryResult) => void; reject: (e: Error) => void }
interface Harness {
  ResourceHarness: React.ComponentType<{ selection?: SearchSelection | null; dark?: boolean }>;
  requests: Request[]; opened: string[]; launch: { fail: boolean };
  failure: (code: string, retryAt?: number) => Error;
  SavedHarness: React.ComponentType<{dark?: boolean}>;
  BrowserHarness: React.ComponentType<{url: string}>;
  web: { props: WebViewProps | null; stops: number; backs: number; mounted: number; closes: number };
  platform: { OS: string };
  nativePolicy: { config: unknown; throws: boolean; calls: string[] };
  persistence: { failWrite: boolean; failRead: boolean; metadata: string | null };
  resetStore: () => void;
  store: () => BookmarkRepository;
}
let ui: Harness;
const selection = { documentId: 'course-1', page: 3, text: '  C++ loops\n C# and .NET  ' };
let dom: JSDOM;
const originals = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://resources.test', pretendToBeVisual: true });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const tokens = resolve('src/core/design/tokens.ts').replaceAll('\\', '/');
  const bookmarks = resolve('src/core/services/bookmarks/repository.ts').replaceAll('\\', '/');
  const substitutions: Record<string, string> = {
    'react-native': `export * from 'react-native-web';export const nativePolicy={config:{Constants:{topicTrailDownloadPolicyVersion:1}},throws:false,calls:[]};export const UIManager={getViewManagerConfig(name){nativePolicy.calls.push(name);if(nativePolicy.throws)throw Error('native constants unavailable');return nativePolicy.config}};`,
    'react-native-webview': `import React from 'react';export const web={props:null,stops:0,backs:0,mounted:0,closes:0};export const WebView=React.forwardRef((props,ref)=>{web.props=props;React.useImperativeHandle(ref,()=>({stopLoading(){web.stops++},goBack(){web.backs++}}));React.useEffect(()=>{web.mounted++;return()=>{web.mounted--}},[]);return React.createElement('div',{'data-testid':'native-webview-boundary'})});`,
    bookmarks: `import {BookmarkRepository} from '${bookmarks}';export const persistence={failWrite:false,failRead:false,metadata:null};export let bookmarkStore;export function resetStore(){persistence.failWrite=false;persistence.failRead=false;persistence.metadata=null;bookmarkStore=new BookmarkRepository({readMetadata:async()=>{if(persistence.failRead)throw Error('private read error');return persistence.metadata},writeMetadata:async value=>{if(persistence.failWrite)throw Error('private disk error');persistence.metadata=value}},()=>new Date('2026-10-27T12:00:00.000Z'))};resetStore();export const store=()=>bookmarkStore;`,
    'expo-router': `export const router={canGoBack:()=>true,back(){},replace(){}};`,
    'expo-linking': `export const opened=[]; export const launch={fail:false}; export async function openURL(url){if(launch.fail)throw Error('platform launch failed');opened.push(url)}`,
    'expo-image': `import React from 'react';export const Image=({source,style})=>React.createElement('img',{src:typeof source==='string'?source:undefined,style,alt:''});`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    theme: `import React from 'react';import {TTLightColors,TTDarkColors} from '${tokens}';const Context=React.createContext(false);export const Theme=Context.Provider;export const useTheme=()=>{const dark=React.useContext(Context);const colors=dark?{...TTLightColors,...TTDarkColors,soft:TTDarkColors.highlight,link:'#8DB2FF',danger:'#FFB4BE',dangerSoft:'#3B1822'}:TTLightColors;return {colors,colorScheme:dark?'dark':'light'}};export const useColors=()=>useTheme();`,
    provider: `export const requests=[];export const resourceDiscovery={search:(selection,query,signal)=>new Promise((resolve,reject)=>requests.push({selection,query,signal,resolve,reject}))};`,
  };
  const result = await build({ stdin: { contents: `import React,{useEffect} from 'react';import {Platform} from 'react-native';export const platform=Platform;export {nativePolicy} from 'react-native';import {ResourceSearchScreen} from './src/features/resources/ResourceSearchScreen';import {SavedScreen} from './src/features/saved/SavedScreen';import {ResourceBrowser} from './src/features/resources/ResourceBrowser';import {web} from 'react-native-webview';export {web};export {persistence,resetStore,store} from './src/core/services/bookmarks/storage';import {StudySelectionProvider,useStudySelection} from './src/features/reader/StudySelectionContext';import {Theme} from './src/core/theme/ThemeContext';import {DiscoveryError} from './src/core/services/resources/types';export {requests} from './src/core/services/resources';export {opened,launch} from 'expo-linking';export const failure=(code,retryAt)=>new DiscoveryError(code,'SECRET provider internals',retryAt);function Selected({selection}){const {setSelection}=useStudySelection();useEffect(()=>{if(selection)setSelection(selection)},[selection,setSelection]);return <ResourceSearchScreen/>}export function ResourceHarness({selection,dark=false}){return <Theme value={dark}><StudySelectionProvider><Selected selection={selection}/></StudySelectionProvider></Theme>}export function SavedHarness({dark=false}){return <Theme value={dark}><SavedScreen/></Theme>}export function BrowserHarness({url}){return <Theme value={false}><ResourceBrowser url={url} title='Article' onClose={()=>web.closes++}/></Theme>}`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', loader: { '.svg': 'dataurl' },
    plugins: [{ name: 'resource-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const name = /ThemeContext$/.test(args.path) ? 'theme' : /core\/services\/bookmarks\/storage$/.test(args.path) ? 'bookmarks' : /core\/services\/resources$/.test(args.path) ? 'provider' : args.path;
        if (Object.hasOwn(substitutions, name)) return { path: name, namespace: 'boundary' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: substitutions[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  ui = module.exports as Harness;
});
after(() => { dom?.window.close(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
async function mounted(run: (doc: globalThis.Document, update: (selection: SearchSelection) => Promise<void>, unmount: () => Promise<void>) => Promise<void>, dark = false, selected: SearchSelection | null = selection) {
  ui.requests.length = 0; ui.opened.length = 0; ui.launch.fail = false;
  ui.resetStore(); ui.platform.OS = 'android'; resetNativePolicy(); ui.web.props = null; ui.web.stops = 0; ui.web.backs = 0; ui.web.closes = 0;
  const { createRoot } = await import('react-dom/client');
  const main = dom.window.document.querySelector('main')!; const root = createRoot(main); let active = true;
  const update = async (value: SearchSelection | null) => { await act(async () => root.render(React.createElement(ui.ResourceHarness, { selection: value, dark }))); };
  const unmount = async () => { if (active) { await act(async () => root.unmount()); active = false; } };
  try { await update(selected); await run(dom.window.document, update, unmount); } finally { await unmount(); }
}
async function press(doc: globalThis.Document, label: string) {
  const button = Array.from(doc.querySelectorAll<HTMLElement>('[role="button"]')).find(v => v.getAttribute('aria-label') === label);
  assert.ok(button, label); await act(async () => button.click());
}
function result(request: Request, title = 'Iteration', discarded = 0): DiscoveryResult {
  return { query: { query: request.query, originalText: request.selection.text, shortened: false }, discarded, fromCache: false,
    resources: [{ id: 'wikipedia:1', title, providerId: 'wikipedia', providerName: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Iteration', type: 'Article', description: 'Iteration repeats a process.', providerOrder: 0,
      selectedTopic: request.selection.text, documentId: request.selection.documentId, page: request.selection.page,
      attribution: { author: 'Wikipedia contributors', licenseName: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceUrl: 'https://en.wikipedia.org/wiki/Iteration', revisionUrl: 'https://en.wikipedia.org/w/index.php?oldid=123' } }] };
}

test('details offer local saving and source checks before an in-app website opens', async () => {
  await mounted(async doc => {
    await press(doc, 'Search Wikipedia'); await act(async () => ui.requests[0].resolve(result(ui.requests[0])));
    await press(doc, 'View details for Iteration');
    assert.ok(doc.querySelector('[aria-label="Save resource"]'));
    assert.match(doc.body.textContent!, /Reputation not checked/);
    assert.ok(doc.querySelector('[aria-label="Open in TopicTrail"]'));
  });
});

const sourceUrl = 'https://en.wikipedia.org/wiki/Iteration';
function navigation(url = sourceUrl, extra = {}) { return { url, title: 'Iteration', loading: false, canGoBack: false, canGoForward: false, lockIdentifier: 1, ...extra }; }
function nativeEvent(url = sourceUrl, extra = {}) { return { nativeEvent: navigation(url, extra) }; }
function invoke(name: keyof WebViewProps, event: unknown) {
  const callback = ui.web.props?.[name] as unknown as (event: unknown) => unknown;
  assert.equal(typeof callback, 'function', String(name)); return callback(event);
}
function resetNativePolicy() {
  ui.nativePolicy.config = {Constants:{topicTrailDownloadPolicyVersion:1}};
  ui.nativePolicy.throws = false; ui.nativePolicy.calls.length = 0;
}
async function standalone(kind: 'browser' | 'saved', run: (doc: globalThis.Document) => Promise<void>, url = sourceUrl, platform = 'android', dark = false, prepare?: () => void) {
  ui.resetStore(); ui.requests.length = 0; ui.opened.length = 0; ui.launch.fail = false;
  ui.platform.OS = platform; resetNativePolicy(); ui.web.props = null; ui.web.stops = 0; ui.web.backs = 0; ui.web.closes = 0;
  prepare?.();
  const { createRoot } = await import('react-dom/client'); const root = createRoot(dom.window.document.querySelector('main')!);
  try { await act(async () => root.render(kind === 'browser' ? React.createElement(ui.BrowserHarness, { url }) : React.createElement(ui.SavedHarness, { dark })));
    await run(dom.window.document);
  } finally { await act(async () => root.unmount()); }
}

test('supported details open a screened WebView and preserve exact selection and results on closing', async () => {
  await mounted(async doc => {
    await press(doc, 'Search Wikipedia'); await act(async () => ui.requests[0].resolve(result(ui.requests[0])));
    await press(doc, 'View details for Iteration'); await press(doc, 'Open in TopicTrail');
    assert.equal(ui.web.mounted, 1); assert.deepEqual(ui.web.props!.source, {uri:sourceUrl});
    const props = ui.web.props!;
    assert.deepEqual(props.originWhitelist, ['*']);
    for (const property of ['javaScriptEnabled','javaScriptCanOpenWindowsAutomatically','allowFileAccess','allowFileAccessFromFileURLs','allowUniversalAccessFromFileURLs','domStorageEnabled','thirdPartyCookiesEnabled','sharedCookiesEnabled','geolocationEnabled','cacheEnabled'] as const) assert.equal(props[property], false, property);
    assert.equal(props.mixedContentMode, 'never'); assert.equal(props.onMessage, undefined); assert.equal(props.injectedJavaScript, undefined);
    await act(async () => invoke('onLoadProgress', nativeEvent(sourceUrl, {progress:0.6})));
    assert.equal(doc.querySelector('[aria-label="Website load progress"]')?.getAttribute('aria-valuenow'), '60');
    await act(async () => invoke('onLoad', nativeEvent()));
    assert.equal(doc.querySelector('[aria-label="Loading website"]'), null);
    await act(async () => invoke('onNavigationStateChange', navigation(sourceUrl + '#History', {canGoBack:true})));
    await press(doc, 'Browser back'); assert.equal(ui.web.backs, 1);
    await press(doc, 'Close website'); assert.equal(ui.web.mounted, 0);
    await press(doc, 'Close resource details');
    assert.equal(doc.querySelector('[data-testid="selected-passage"]')?.textContent, selection.text);
    assert.ok(doc.querySelector('[aria-label="View details for Iteration"]')); assert.equal(ui.requests.length, 1); assert.equal(ui.opened.length, 0);
  });
});

for (const url of ['javascript:alert(1)','http://en.wikipedia.org/wiki/Iteration','https://127.0.0.1/','https://example.org/']) {
  test(`initial URL is screened before native mount: ${url}`, async () => {
    await standalone('browser', async doc => { assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /Cannot open this link in TopicTrail/); assert.equal(ui.opened.length, 0); }, url);
  });
}
test('web platform shows an honest fallback without mounting native WebView', async () => {
  await standalone('browser', async doc => { assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /unavailable on this platform/); }, sourceUrl, 'web');
});

for (const [name, config] of [
  ['absent config', null], ['absent constants', {}], ['absent marker', {Constants:{}}],
  ['old policy', {Constants:{topicTrailDownloadPolicyVersion:0}}],
  ['future policy', {Constants:{topicTrailDownloadPolicyVersion:2}}],
  ['string policy', {Constants:{topicTrailDownloadPolicyVersion:'1'}}],
  ['malformed constants', {Constants:'1'}], ['malformed config', '1'],
] as const) test(`Android ${name} requires an updated viewer before any native source mounts`, async () => {
  await standalone('browser', async doc => {
    assert.equal(ui.web.mounted, 0); assert.equal(ui.web.props, null);
    assert.match(doc.body.textContent!, /updated.*viewer/i); assert.equal(ui.opened.length, 0);
    assert.ok(ui.nativePolicy.calls.includes('RNCWebView'));
    assert.equal(doc.querySelector('[aria-label="Reload"]'), null);
    await press(doc, 'Continue in external browser'); assert.deepEqual(ui.opened, [sourceUrl]);
    await press(doc, 'Close website'); assert.equal(ui.web.closes, 1);
  }, sourceUrl, 'android', false, () => { ui.nativePolicy.config = config; });
});

test('throwing Android native capability lookup fails closed without an automatic external action', async () => {
  await standalone('browser', async doc => {
    assert.equal(ui.web.mounted, 0); assert.equal(ui.web.props, null);
    assert.match(doc.body.textContent!, /updated.*viewer/i); assert.equal(ui.opened.length, 0);
  }, sourceUrl, 'android', false, () => { ui.nativePolicy.throws = true; });
});

test('iOS supports its download callback without reading an Android capability marker', async () => {
  await standalone('browser', async doc => {
    assert.equal(ui.web.mounted, 1); assert.deepEqual(ui.nativePolicy.calls, []);
    await act(async () => invoke('onFileDownload', {nativeEvent:{downloadUrl:sourceUrl}}));
    assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /Downloads are not supported/);
    assert.equal(ui.opened.length, 0); await press(doc, 'Try again'); assert.equal(ui.web.mounted, 1);
  }, sourceUrl, 'ios', false, () => { ui.nativePolicy.config = null; ui.nativePolicy.throws = true; });
});

test('Android native download denial becomes a recoverable error with no automatic external action', async () => {
  await standalone('browser', async doc => {
    await act(async () => invoke('onError', nativeEvent(sourceUrl, {code:-9001,description:'PRIVATE_NATIVE_DIAGNOSTIC'})));
    assert.equal(ui.web.mounted, 0); assert.equal(ui.web.stops, 1);
    assert.match(doc.body.textContent!, /Downloads are not supported/);
    assert.doesNotMatch(doc.body.textContent!, /PRIVATE_NATIVE_DIAGNOSTIC|Check your connection/);
    assert.equal(ui.opened.length, 0); await press(doc, 'Try again'); assert.equal(ui.web.mounted, 1);
    await act(async () => invoke('onError', nativeEvent(sourceUrl, {code:-9001})));
    await press(doc, 'Open in browser'); assert.equal(ui.opened.length, 0);
    await press(doc, 'Continue in external browser'); assert.deepEqual(ui.opened, [sourceUrl]);
  });
});

test('same group navigation is allowed; cross-source navigation unmounts for explicit external review', async () => {
  await standalone('browser', async doc => {
    assert.equal(invoke('onShouldStartLoadWithRequest', navigation('https://en.m.wikipedia.org/wiki/Iteration')), true);
    await act(async () => { assert.equal(invoke('onShouldStartLoadWithRequest', navigation('https://docs.python.org/3/')), false); });
    assert.equal(ui.web.mounted, 0); assert.equal(ui.web.stops, 1); assert.equal(ui.opened.length, 0);
    assert.match(doc.body.textContent!, /Review external destination/);
    ui.launch.fail = true; await press(doc, 'Continue in external browser'); assert.match(doc.body.textContent!, /Could not open this link/);
    ui.launch.fail = false; await press(doc, 'Continue in external browser'); assert.deepEqual(ui.opened, ['https://docs.python.org/3/']);
    await press(doc, 'Cancel external opening'); assert.equal(ui.web.mounted, 1);
  });
});
for (const event of ['onShouldStartLoadWithRequest','onNavigationStateChange','onLoadStart','onLoad'] as const) {
  test(`blocked destination stops late or early navigation through ${event}`, async () => {
    await standalone('browser', async doc => {
      await act(async () => invoke(event, event === 'onLoadStart' || event === 'onLoad' ? nativeEvent('intent://other') : navigation('intent://other')));
      assert.equal(ui.web.mounted, 0); assert.equal(ui.opened.length, 0); assert.match(doc.body.textContent!, /destination is blocked/);
    });
  });
}
test('popups are screened and never open automatically, even on the same source', async () => {
  await standalone('browser', async doc => {
    await act(async () => invoke('onOpenWindow', {nativeEvent:{targetUrl:sourceUrl + '#popup'}}));
    assert.equal(ui.web.mounted, 0); assert.equal(ui.opened.length, 0); assert.match(doc.body.textContent!, /Review external destination/);
  });
});
test('a stale native request after reload cannot stop the replacement viewer', async () => {
  await standalone('browser', async doc => {
    const old = ui.web.props!.onShouldStartLoadWithRequest!;
    await press(doc, 'Reload');
    await act(async () => { assert.equal(old(navigation('javascript:stale') as Parameters<typeof old>[0]), false); });
    assert.equal(ui.web.mounted, 1); assert.doesNotMatch(doc.body.textContent!, /destination is blocked/);
  });
});
test('a subresource HTTP failure does not replace a successful page', async () => {
  await standalone('browser', async doc => {
    await act(async () => invoke('onLoad', nativeEvent()));
    await act(async () => invoke('onHttpError', nativeEvent('https://upload.wikimedia.org/missing-image.png', {statusCode:404})));
    assert.equal(ui.web.mounted, 1); assert.doesNotMatch(doc.body.textContent!, /website returned an error/);
  });
});
test('HTTP errors for the page still match a bookmarked fragment destination', async () => {
  await standalone('browser', async doc => {
    await act(async () => invoke('onHttpError', nativeEvent(sourceUrl, {statusCode:503})));
    assert.equal(ui.web.mounted, 0); assert.match(doc.body.textContent!, /website returned an error/);
  }, sourceUrl + '#History');
});
for (const event of ['onError','onHttpError','onRenderProcessGone','onContentProcessDidTerminate'] as const) {
  test(`${event} removes the viewer, hides native internals and allows retry`, async () => {
    await standalone('browser', async doc => {
      await act(async () => invoke(event, nativeEvent(sourceUrl, {description:'PRIVATE_NATIVE_DIAGNOSTIC'})));
      assert.equal(ui.web.mounted, 0); assert.doesNotMatch(doc.body.textContent!, /PRIVATE_NATIVE_DIAGNOSTIC/);
      await press(doc, 'Try again'); assert.equal(ui.web.mounted, 1);
    });
  });
}

test('save and unsave synchronize details, result cards and Saved without persisting the passage', async () => {
  await mounted(async doc => {
    await press(doc, 'Search Wikipedia'); await act(async () => ui.requests[0].resolve(result(ui.requests[0])));
    await press(doc, 'View details for Iteration');
    ui.persistence.failWrite = true; await press(doc, 'Save resource');
    assert.match(doc.body.textContent!, /Couldn’t save resource/); assert.equal(ui.store().getSnapshot().bookmarks.length, 0);
    ui.persistence.failWrite = false; await press(doc, 'Retry save');
    assert.equal(ui.store().getSnapshot().bookmarks.length, 1); assert.ok(doc.querySelector('[aria-label="Unsave Iteration"]'));
    assert.ok(doc.querySelector('[aria-label="Unsave resource"]')); assert.match(doc.body.textContent!, /Saved 27 Oct 2026/);
    const persisted = JSON.parse(ui.persistence.metadata!); assert.ok(persisted);
    assert.doesNotMatch(ui.persistence.metadata!, /documentId|selectedTopic|course-1|"page"/);
    await press(doc, 'Close resource details');
    const host = doc.createElement('aside'); doc.body.append(host); const {createRoot} = await import('react-dom/client'); const savedRoot = createRoot(host);
    try {
      await act(async () => savedRoot.render(React.createElement(ui.SavedHarness)));
      assert.match(host.textContent!, /1 saved resource/); assert.match(host.textContent!, /not downloaded for offline reading/);
      await press(doc, 'Unsave Iteration');
      assert.match(host.textContent!, /No saved resources yet/); assert.ok(doc.querySelector('[aria-label="Save Iteration"]'));
    } finally { await act(async () => savedRoot.unmount()); host.remove(); }
  });
});

test('Saved searches title, source and topic, opens metadata details, and recovers failed removal', async () => {
  await standalone('saved', async doc => {
    await act(async () => { await ui.store().save({url:sourceUrl,title:'Iteration',providerId:'wikipedia',providerName:'Wikipedia',type:'Article',topic:'Loops'}); });
    const input = doc.querySelector<HTMLInputElement>('[aria-label="Search saved resources"]')!;
    async function search(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value); input.dispatchEvent(new dom.window.Event('input',{bubbles:true})); }); }
    for (const term of ['Iteration','wikipedia','loops']) { await search(term); assert.ok(doc.querySelector('[aria-label="View details for Iteration"]')); }
    await search('not matching'); assert.match(doc.body.textContent!, /No matching saved resources/);
    await press(doc, 'Clear saved search'); await press(doc, 'View details for Iteration');
    assert.equal(doc.querySelector('[data-testid="selected-passage"]'), null); assert.doesNotMatch(doc.body.textContent!, /page \/ section|SELECTED PASSAGE/);
    ui.persistence.failWrite = true; await press(doc, 'Unsave resource'); assert.equal(ui.store().getSnapshot().bookmarks.length, 1);
    assert.match(doc.body.textContent!, /Couldn’t remove resource/);
    ui.persistence.failWrite = false; await press(doc, 'Retry removal'); assert.equal(ui.store().getSnapshot().bookmarks.length, 0);
    await press(doc, 'Close resource details'); assert.match(doc.body.textContent!, /No saved resources yet/);
  });
});

test('Saved uses Light and Dark semantic surfaces with shared width and offline metadata copy', async () => {
  for (const dark of [false,true]) await standalone('saved', async doc => {
    assert.match(doc.body.innerHTML, /max-width: 1440px/); assert.match(doc.body.textContent!, /Only link metadata/);
    const search = doc.querySelector<HTMLInputElement>('[aria-label="Search saved resources"]')!; assert.ok(search);
    const screen = doc.querySelector<HTMLElement>('[data-testid^="screen-content-"]'); assert.ok(screen);
    assert.equal(screen.style.backgroundColor, dark ? 'rgb(11, 18, 32)' : 'rgb(245, 245, 245)');
  }, sourceUrl, 'android', dark);
});

test('initial metadata read failure is recoverable and is never presented as an empty library', async () => {
  await standalone('saved', async doc => {
    assert.match(doc.body.textContent!, /Couldn’t load or update saved resources/);
    assert.doesNotMatch(doc.body.textContent!, /No saved resources yet|private read error/);
    ui.persistence.failRead = false; await press(doc, 'Retry saved resources');
    assert.match(doc.body.textContent!, /No saved resources yet/);
  }, sourceUrl, 'android', false, () => { ui.persistence.failRead = true; });
});

test('viewer timeout removes native content, retries and clears its timer on close', async () => {
  const originalSet = globalThis.setTimeout; const originalClear = globalThis.clearTimeout;
  let expire: (() => void) | null = null; let outstanding = false;
  const timerToken = {phase4:true} as unknown as ReturnType<typeof setTimeout>;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 20000) { expire = () => callback(...args); outstanding = true; return timerToken; }
    return originalSet(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => { if (handle === timerToken) outstanding = false; else originalClear(handle); }) as typeof clearTimeout;
  try {
    await standalone('browser', async doc => {
      assert.equal(outstanding, true); assert.ok(expire);
      await act(async () => expire!()); assert.equal(ui.web.mounted, 0); assert.equal(outstanding, false);
      assert.match(doc.body.textContent!, /page took too long/); assert.equal(ui.opened.length, 0);
      await press(doc, 'Try again'); assert.equal(ui.web.mounted, 1); assert.equal(outstanding, true);
    });
    assert.equal(outstanding, false);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

test('an unknown Saved destination stays neutral and requires confirmation before external launch', async () => {
  await standalone('saved', async doc => {
    await act(async () => { await ui.store().save({url:'https://example.org/learn',title:'Unknown source',providerId:'example',providerName:'Example',type:'Article'}); });
    await press(doc, 'View details for Unknown source');
    assert.match(doc.body.textContent!, /Unrecognized source/); assert.doesNotMatch(doc.body.textContent!, /guaranteed safe|credibility score/i);
    assert.equal(doc.querySelector('[aria-label="Open in TopicTrail"]')?.getAttribute('aria-disabled'), 'true');
    await press(doc, 'Open website'); assert.equal(ui.opened.length, 0); assert.match(doc.body.textContent!, /Review external destination/);
    await press(doc, 'Continue in external browser'); assert.deepEqual(ui.opened, ['https://example.org/learn']);
  });
});

