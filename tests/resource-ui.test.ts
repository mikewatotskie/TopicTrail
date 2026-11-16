import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import type { DiscoveryResult, ResourceSource, SearchSelection, SearchOrigin } from '../src/core/services/resources/types';

// Real resource screen, hook, query/session logic and RN controls. Only platform IO and provider IO are replaced.
interface Request { selection: SearchSelection | SearchOrigin; query: string; signal: AbortSignal; source: ResourceSource; resolve: (v: DiscoveryResult) => void; reject: (e: Error) => void }
interface Harness {
  ResourceHarness: React.ComponentType<{ selection?: SearchSelection | null; dark?: boolean; manual?: boolean; runtime?: unknown }>;
  createRuntime(): { nextAccount(): void };
  requests: Request[]; opened: string[]; launch: { fail: boolean };
  failure: (code: string, retryAt?: number) => Error;
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
    'react-native': `export * from 'react-native-web';export const Platform={OS:'android',select:v=>v.android??v.default};export const UIManager={getViewManagerConfig:()=>({Constants:{topicTrailDownloadPolicyVersion:1}})};`,
    'react-native-webview': `export const WebView=()=>null;`,
    bookmarks: `import {BookmarkRepository} from '${bookmarks}';let metadata=null;export const bookmarkStore=new BookmarkRepository({readMetadata:async()=>metadata,writeMetadata:async value=>{metadata=value}});`,
    'expo-router': `export const useRouter=()=>router;export const router={canGoBack:()=>true,back(){},replace(){}};`,
    'expo-linking': `export const opened=[]; export const launch={fail:false}; export async function openURL(url){if(launch.fail)throw Error('platform launch failed');opened.push(url)}`,
    'expo-image': `import React from 'react';export const Image=({source,style})=>React.createElement('img',{src:typeof source==='string'?source:undefined,style,alt:''});`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    theme: `import React from 'react';import {TTLightColors,TTDarkColors} from '${tokens}';const Context=React.createContext(false);export const Theme=Context.Provider;export const useTheme=()=>{const dark=React.useContext(Context);const colors=dark?{...TTLightColors,...TTDarkColors,soft:TTDarkColors.highlight,link:'#8DB2FF',danger:'#FFB4BE',dangerSoft:'#3B1822'}:TTLightColors;return {colors,colorScheme:dark?'dark':'light'}};export const useColors=()=>useTheme();`,
    provider: `export const requests=[];export const resourceDiscovery={search:(selection,query,signal,source)=>new Promise((resolve,reject)=>requests.push({selection,query,signal,source,resolve,reject}))};`,
  };
  const result = await build({ stdin: { contents: `import React,{useEffect} from 'react';import {ResourceSearchScreen} from './src/features/resources/ResourceSearchScreen';import {CloudRuntimeContext} from './src/features/library/CloudLibraryContext';export function createRuntime(){let state={identity:null,key:null,epoch:0,revision:0,phase:'guest',message:'',pending:0,lastSyncedAt:null};const listeners=new Set();return {getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},nextAccount(){state={...state,epoch:state.epoch+1};listeners.forEach(fn=>fn())}}}import {StudySelectionProvider,useStudySelection} from './src/features/reader/StudySelectionContext';import {Theme} from './src/core/theme/ThemeContext';import {DiscoveryError} from './src/core/services/resources/types';export {requests} from './src/core/services/resources';export {opened,launch} from 'expo-linking';export const failure=(code,retryAt)=>new DiscoveryError(code,'SECRET provider internals',retryAt);function Selected({selection,manual}){const {setSelection}=useStudySelection();useEffect(()=>{if(selection)setSelection(selection)},[selection,setSelection]);return <ResourceSearchScreen manual={manual}/>}export function ResourceHarness({selection,dark=false,manual=false,runtime=null}){return <Theme value={dark}><CloudRuntimeContext.Provider value={runtime}><StudySelectionProvider><Selected selection={selection} manual={manual}/></StudySelectionProvider></CloudRuntimeContext.Provider></Theme>}`, resolveDir: process.cwd(), loader: 'tsx' },
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
async function mounted(run: (doc: globalThis.Document, update: (selection: SearchSelection) => Promise<void>, unmount: () => Promise<void>) => Promise<void>, dark = false, selected: SearchSelection | null = selection, manual = false, runtime?: unknown) {
  ui.requests.length = 0; ui.opened.length = 0; ui.launch.fail = false;
  const { createRoot } = await import('react-dom/client');
  const main = dom.window.document.querySelector('main')!; const root = createRoot(main); let active = true;
  const update = async (value: SearchSelection | null) => { await act(async () => root.render(React.createElement(ui.ResourceHarness, { selection: value, dark, manual, runtime }))); };
  const unmount = async () => { if (active) { await act(async () => root.unmount()); active = false; } };
  try { await update(selected); await run(dom.window.document, update, unmount); } finally { await unmount(); }
}
async function press(doc: globalThis.Document, label: string) {
  if (['Search with DuckDuckGo','Look up on Wikipedia','Clear search'].includes(label) && !doc.querySelector('[aria-label="Topic query"]')) await press(doc, 'Edit topic');
  const button = Array.from(doc.querySelectorAll<HTMLElement>('[role="button"]')).find(v => v.getAttribute('aria-label') === label);
  assert.ok(button, label); await act(async () => button.click());
}
async function edit(doc: globalThis.Document, value: string) {
  if (!doc.querySelector('[aria-label="Topic query"]')) await press(doc, 'Edit topic');
  const input = doc.querySelector<HTMLInputElement>('[aria-label="Topic query"]')!; assert.ok(input);
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}
function result(request: Request, title = 'Iteration', discarded = 0): DiscoveryResult {
  return { query: { query: request.query, originalText: request.selection.text, shortened: false }, discarded, fromCache: false,
    resources: [{ id: 'wikipedia:1', title, providerId: 'wikipedia', providerName: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Iteration', type: 'Article', description: 'Iteration repeats a process.', providerOrder: 0,
      ...('documentId' in request.selection ? {selectedTopic: request.selection.text, documentId: request.selection.documentId, page: request.selection.page} : {origin:request.selection}),
      attribution: { author: 'Wikipedia contributors', licenseName: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceUrl: 'https://en.wikipedia.org/wiki/Iteration', revisionUrl: 'https://en.wikipedia.org/w/index.php?oldid=123' } }] };
}

test('manual topic search reviews input, shows results first, and never adds syllabus context', async () => {
  await mounted(async doc => {
    assert.equal(ui.requests.length, 0);
    assert.equal(doc.querySelector('[data-testid="selected-passage"]'), null);
    assert.equal(doc.querySelector('[aria-label="Back to syllabus"]'), null);
    await edit(doc, 'Particle physics'); await press(doc, 'Look up on Wikipedia');
    assert.deepEqual(ui.requests[0].selection, {kind:'manual',text:'Particle physics'});
    assert.equal(doc.querySelector('[aria-label="Topic query"]'), null);
    await act(async () => ui.requests[0].resolve(result(ui.requests[0], 'Physics')));
    assert.ok(doc.querySelector('[aria-label="View details for Physics"]'));
    assert.equal(doc.querySelector('[data-testid="selected-passage"]'), null);
    await press(doc, 'View details for Physics');
    assert.equal(doc.querySelector('[data-testid="selected-passage"]'), null);
    await press(doc, 'Close resource details'); await press(doc, 'Edit topic');
    assert.equal((doc.querySelector('[aria-label="Topic query"]') as HTMLInputElement).value, 'Particle physics');
    await edit(doc, 'Wave mechanics'); await press(doc, 'Look up on Wikipedia'); await press(doc, 'Cancel search');
    assert.ok(ui.requests[1].signal.aborted);
    assert.doesNotMatch(doc.body.textContent!, /Your selected passage/);
  }, false, null, true);
});

test('document results collapse query setup until Edit topic while preserving the exact original passage', async () => {
  await mounted(async doc => {
    await press(doc, 'Look up on Wikipedia'); await act(async () => ui.requests[0].resolve(result(ui.requests[0])));
    assert.equal(doc.querySelector('[aria-label="Topic query"]'), null);
    assert.equal(doc.querySelector('[data-testid="selected-passage"]'), null);
    await press(doc, 'Edit topic');
    assert.equal(doc.querySelector('[data-testid="selected-passage"]')?.textContent, selection.text);
    assert.ok(doc.querySelector('[aria-label="View details for Iteration"]'));
  });
});

test('manual search clears drafts and cancels pending results at the account epoch boundary', async () => {
  const runtime = ui.createRuntime();
  await mounted(async doc => {
    await edit(doc, 'Account A topic'); await press(doc, 'Look up on Wikipedia'); const previous=ui.requests[0];
    await act(async () => runtime.nextAccount());
    assert.ok(previous.signal.aborted);
    assert.equal((doc.querySelector('[aria-label="Topic query"]') as HTMLInputElement).value, '');
    await act(async () => previous.resolve(result(previous, 'Old private context')));
    assert.doesNotMatch(doc.body.textContent!, /Account A topic|Old private context/);
    await edit(doc, 'Account B topic'); await press(doc, 'Look up on Wikipedia');
    assert.equal(ui.requests[1].query, 'Account B topic');
  }, false, null, true, runtime);
});

test('exact selected text, origin, processed technical query and privacy precede explicit search', async () => {
  await mounted(async doc => {
    assert.equal(doc.querySelector('[data-testid="selected-passage"]')?.textContent, selection.text);
    assert.match(doc.body.textContent!, /page \/ section 3/i); assert.match(doc.body.textContent!, /Only the topic shown above is sent to the source you choose/);
    assert.equal((doc.querySelector('[aria-label="Topic query"]') as HTMLInputElement).value, 'C++ loops C# and .NET');
    assert.equal(ui.requests.length, 0); await edit(doc, 'C++ iteration'); assert.equal(ui.requests.length, 0);
    await press(doc, 'Look up on Wikipedia'); assert.equal(ui.requests[0].query, 'C++ iteration');
    assert.match(doc.body.textContent!, /Finding resources/); await press(doc, 'Cancel search'); assert.ok(ui.requests[0].signal.aborted);
    assert.match(doc.body.textContent!, /Search cancelled/);
    await press(doc, 'Clear search'); assert.match(doc.body.textContent!, /Enter a topic/);
  });
});
test('real results open details with source, original association, excerpt and actionable attribution', async () => {
  await mounted(async doc => {
    await press(doc, 'Look up on Wikipedia'); await act(async () => ui.requests[0].resolve(result(ui.requests[0], 'Iteration', 2)));
    assert.match(doc.body.textContent!, /2 results omitted/); await press(doc, 'View details for Iteration');
    await press(doc, 'Source attribution');
    assert.match(doc.body.textContent!, /Resource details/); assert.match(doc.body.textContent!, /Iteration repeats a process/);
    assert.match(doc.body.textContent!, /Wikipedia contributors/); assert.match(doc.body.textContent!, /CC BY-SA 4.0/);
    assert.match(doc.body.textContent!, /C\+\+ loops C# and .NET/); assert.match(doc.body.textContent!, /https:\/\/en.wikipedia.org\/wiki\/Iteration/);
    await press(doc, 'Open in external browser'); await press(doc, 'View license'); await press(doc, 'View revision'); await press(doc, 'View source');
    assert.deepEqual(ui.opened, ['https://en.wikipedia.org/wiki/Iteration', 'https://creativecommons.org/licenses/by-sa/4.0/', 'https://en.wikipedia.org/w/index.php?oldid=123', 'https://en.wikipedia.org/wiki/Iteration']);
    ui.launch.fail = true; await press(doc, 'Open in external browser'); assert.match(doc.body.textContent!, /Could not open this link/);
    await press(doc, 'Close resource details'); await press(doc, 'Look up on Wikipedia'); assert.doesNotMatch(doc.body.textContent!, /Resource details/);
  });
});
test('empty results support retry and editing without fabricated resources', async () => {
  await mounted(async doc => { await press(doc, 'Look up on Wikipedia'); const response = result(ui.requests[0]); response.resources = [];
    await act(async () => ui.requests[0].resolve(response)); assert.match(doc.body.textContent!, /No resources found/);
    await press(doc, 'Try again'); assert.equal(ui.requests.length, 2);
  });
});
test('long passages retain exact text separately while the reviewed outbound query is bounded', async () => {
  const long = { ...selection, text: '  ' + Array.from({ length: 32 }, (_, i) => 'concept' + i).join('\n') + '  ' };
  await mounted(async doc => {
    assert.equal(doc.querySelector('[data-testid="selected-passage"]')?.textContent, long.text);
    await press(doc, 'Show full passage'); assert.ok(doc.querySelector('[aria-label="Collapse passage"]'));
    await edit(doc, Array.from({ length: 25 }, () => 'iteration').join(' ')); assert.equal(ui.requests.length, 0);
    await press(doc, 'Look up on Wikipedia'); const query = ui.requests[0].query;
    assert.ok([...query].length <= 140); assert.ok(query.split(' ').length <= 16);
    assert.ok(doc.body.textContent!.includes(query)); assert.equal(ui.requests[0].selection.text, long.text);
  }, false, long);
});
test('cleared or short topic queries remain explanatory and never send requests', async () => {
  await mounted(async doc => {
    await press(doc, 'Clear search'); await press(doc, 'Look up on Wikipedia'); assert.equal(ui.requests.length, 0);
    await edit(doc, 'x'); assert.match(doc.body.textContent!, /Add a little context/); await press(doc, 'Look up on Wikipedia'); assert.equal(ui.requests.length, 0);
    await edit(doc, 'C#'); await press(doc, 'Look up on Wikipedia'); assert.equal(ui.requests[0].query, 'C#');
    await act(async () => ui.requests[0].reject(ui.failure('invalid_query'))); assert.match(doc.body.textContent!, /Review your topic/);
    assert.doesNotMatch(doc.body.textContent!, /SECRET/);
  });
});
test('missing descriptions are honest and unsafe platform URLs never launch', async () => {
  await mounted(async doc => {
    await press(doc, 'Look up on Wikipedia'); const response = result(ui.requests[0]); const resource = response.resources[0];
    resource.description = undefined; resource.url = 'https://en.wikipedia.org.evil.test/wiki/Iteration'; resource.attribution!.licenseUrl = 'javascript:alert(1)';
    await act(async () => ui.requests[0].resolve(response)); assert.match(doc.body.textContent!, /Description unavailable/);
    await press(doc, 'View details for Iteration'); await press(doc, 'Open website'); assert.match(doc.body.textContent!, /This link is unavailable/);
    await press(doc, 'Source attribution'); await press(doc, 'View license'); assert.equal(ui.opened.length, 0);
  });
});
for (const [code, copy] of [['network', /connection|network/i], ['timeout', /too long/i], ['api', /Wikipedia.*unavailable/i], ['invalid_data', /usable results/i]] as const) {
  test(`${code} is recoverable and does not leak provider internals or claim offline certainty`, async () => {
    await mounted(async doc => { await press(doc, 'Look up on Wikipedia'); await act(async () => ui.requests[0].reject(ui.failure(code)));
      assert.match(doc.body.textContent!, copy); assert.doesNotMatch(doc.body.textContent!, /SECRET|You're offline|You’re offline/);
      await press(doc, 'Try again'); assert.equal(ui.requests.length, 2);
    });
  });
}
test('rate-limit wait disables both retry and new search until cooldown passes', async () => {
  const actualNow = Date.now; let now = actualNow(); Date.now = () => now;
  try { await mounted(async doc => { await press(doc, 'Look up on Wikipedia'); await act(async () => ui.requests[0].reject(ui.failure('rate_limit', now + 3000)));
    assert.match(doc.body.textContent!, /Try again in 3 seconds/); await press(doc, 'Try again'); await press(doc, 'Look up on Wikipedia'); assert.equal(ui.requests.length, 1);
    now += 3100; await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    await press(doc, 'Try again'); assert.equal(ui.requests.length, 2);
  }); } finally { Date.now = actualNow; }
});
for (const offset of [0, -5000]) test(`expired retry deadline (${offset}ms) after idle never locks search or retry`, async () => {
  const actualNow = Date.now; let now = actualNow(); Date.now = () => now;
  try { await mounted(async doc => {
    now += 60000;
    await press(doc, 'Look up on Wikipedia'); await act(async () => ui.requests[0].reject(ui.failure('rate_limit', now + offset)));
    assert.doesNotMatch(doc.body.textContent!, /Try again in \d/);
    assert.notEqual(doc.querySelector('[aria-label="Look up on Wikipedia"]')?.getAttribute('aria-disabled'), 'true');
    assert.notEqual(doc.querySelector('[aria-label="Try again"]')?.getAttribute('aria-disabled'), 'true');
    await press(doc, 'Try again'); assert.equal(ui.requests.length, 2);
    await act(async () => ui.requests[1].reject(ui.failure('rate_limit', now + offset)));
    await press(doc, 'Look up on Wikipedia'); assert.equal(ui.requests.length, 3);
  }); } finally { Date.now = actualNow; }
});
test('a future retry deadline starts from the current clock after idle and expires without automatic requests', async () => {
  const actualNow = Date.now; let now = actualNow(); Date.now = () => now;
  try { await mounted(async doc => {
    now += 60000;
    await press(doc, 'Look up on Wikipedia'); await act(async () => ui.requests[0].reject(ui.failure('rate_limit', now + 2000)));
    assert.match(doc.body.textContent!, /Try again in 2 seconds/);
    await press(doc, 'Try again'); assert.equal(ui.requests.length, 1);
    now += 2100; await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    assert.doesNotMatch(doc.body.textContent!, /Try again in \d/); assert.equal(ui.requests.length, 1);
    await press(doc, 'Look up on Wikipedia'); assert.equal(ui.requests.length, 2);
  }); } finally { Date.now = actualNow; }
});
test('superseded requests, selection changes and unmount cannot show stale resources', async () => {
  await mounted(async (doc, update, unmount) => {
    await press(doc, 'Look up on Wikipedia'); const first = ui.requests[0]; await edit(doc, 'Fresh topic'); await press(doc, 'Look up on Wikipedia');
    assert.ok(first.signal.aborted); await act(async () => ui.requests[1].resolve(result(ui.requests[1], 'Fresh result')));
    await act(async () => first.resolve(result(first, 'STALE result'))); assert.match(doc.body.textContent!, /Fresh result/); assert.doesNotMatch(doc.body.textContent!, /STALE/);
    await update({ ...selection, page: 4, text: 'Replacement topic' }); assert.doesNotMatch(doc.body.textContent!, /Fresh result/);
    await press(doc, 'Look up on Wikipedia'); const pending = ui.requests[2]; await unmount(); assert.ok(pending.signal.aborted);
    await act(async () => pending.resolve(result(pending))); assert.equal(doc.querySelector('main')!.textContent, '');
  });
});
test('only an explicit source action searches and switching sources rejects a late answer for the same topic', async () => {
  await mounted(async doc => {
    await edit(doc, 'C++ & graph theory');
    const input = doc.querySelector<HTMLInputElement>('[aria-label="Topic query"]')!;
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'Enter', bubbles:true})); });
    assert.equal(ui.requests.length, 0);
    await press(doc, 'Search with DuckDuckGo');
    const duck = ui.requests[0];
    assert.equal(duck.source, 'duckduckgo');
    assert.equal(duck.query, 'C++ & graph theory');
    await press(doc, 'Look up on Wikipedia');
    const wiki = ui.requests[1];
    assert.equal(wiki.source, 'wikipedia');
    assert.equal(wiki.query, duck.query);
    assert.equal(duck.signal.aborted, true);
    await act(async () => wiki.resolve(result(wiki, 'Article result')));
    await act(async () => duck.resolve(result(duck, 'Late answer')));
    assert.match(doc.body.textContent!, /Article result/);
    assert.doesNotMatch(doc.body.textContent!, /Late answer|View full results on DuckDuckGo/);
  });
});

for (const response of ['empty', 'network', 'cited'] as const) {
  test(`DuckDuckGo ${response} response retains the exact external web search in the study flow`, async () => {
    await mounted(async doc => {
      const topic = 'C++ / C# & 日本語';
      await edit(doc, topic);
      await press(doc, 'Search with DuckDuckGo');
      const request = ui.requests[0];
      const payload = result(request);
      payload.resources = response === 'cited' ? [{
        id:'duckduckgo:example', title:'Programming languages', description:'Both languages support classes.',
        providerId:'duckduckgo', providerName:'Example Encyclopedia', type:'Instant Answer',
        url:'https://example.org/languages', providerOrder:0,
      }] : [];
      await act(async () => response === 'network' ? request.reject(ui.failure('network')) : request.resolve(payload));
      if (response === 'empty') {
        assert.ok(doc.body.textContent!.includes(`DuckDuckGo has no quick answer for “${topic}”.`));
        assert.ok(doc.body.textContent!.includes('https://duckduckgo.com/?q='));
        assert.equal(doc.querySelector('[aria-label="View full results on DuckDuckGo"]'), null);
      } else {
        assert.equal(doc.querySelector('[aria-label="Open DuckDuckGo results in browser"]'), null);
      }
      if (response === 'network') assert.match(doc.body.textContent!, /could not reach DuckDuckGo/i);
      if (response === 'cited') {
        assert.ok(doc.querySelector('[data-testid="resource-side-panel"]'));
        assert.match(doc.body.textContent!, /Programming languages/);
        assert.doesNotMatch(doc.body.textContent!, /Wikipedia contributors/);
      }
      assert.equal(ui.opened.length, 0);
      if (response === 'empty') {
        await press(doc, 'Open DuckDuckGo results in browser');
      } else {
        await press(doc, 'View full results on DuckDuckGo');
        assert.equal(ui.opened.length, 0);
        await press(doc, 'Continue in external browser');
      }
      const opened = new URL(ui.opened[0]);
      assert.equal(opened.origin, 'https://duckduckgo.com');
      assert.equal(opened.searchParams.get('q'), topic);
      assert.equal(ui.requests.length, 1);
    }, false, response === 'cited' ? selection : null, response !== 'cited');
  });
}

test('an empty DuckDuckGo answer offers Wikipedia for the exact submitted topic and original page only on request', async () => {
  const selected = { documentId: 'approval-form', page: 8, text: 'Private passage about an approval process' };
  await mounted(async doc => {
    await edit(doc, 'approval');
    await press(doc, 'Search with DuckDuckGo');
    const duck = ui.requests[0];
    await act(async () => duck.resolve({ ...result(duck), resources: [] }));
    assert.deepEqual(ui.requests.map(r => r.source), ['duckduckgo']);
    assert.deepEqual(ui.opened, []);
    assert.equal(doc.querySelector('[aria-label="Topic query"]'), null);
    assert.equal(doc.querySelectorAll('[aria-label="Open DuckDuckGo results in browser"]').length, 1);

    ui.launch.fail = true;
    await press(doc, 'Open DuckDuckGo results in browser');
    assert.match(doc.body.textContent!, /Could not open this link/);
    await press(doc, 'Look up “approval” on Wikipedia');
    assert.equal(ui.requests.length, 2);
    const wiki = ui.requests[1];
    assert.equal(wiki.query, 'approval');
    assert.equal(wiki.source, 'wikipedia');
    assert.deepEqual(wiki.selection, { kind: 'document', ...selected });
    await act(async () => wiki.resolve(result(wiki, 'Approval article')));
    assert.ok(doc.body.textContent!.includes('Approval article'));
    assert.equal(doc.querySelector('[aria-label="Open DuckDuckGo results in browser"]'), null);
    assert.deepEqual(ui.opened, []);
  }, false, selected);
});

test('editing an empty DuckDuckGo lookup hides its old actions without sending the replacement draft', async () => {
  await mounted(async doc => {
    await edit(doc, 'approval');
    await press(doc, 'Search with DuckDuckGo');
    const duck = ui.requests[0];
    await act(async () => duck.resolve({ ...result(duck), resources: [] }));
    await edit(doc, 'budget approval');
    assert.equal(doc.querySelector('[aria-label="Look up “approval” on Wikipedia"]'), null);
    assert.equal(doc.querySelector('[aria-label="Open DuckDuckGo results in browser"]'), null);
    assert.equal(ui.requests.length, 1);
    await press(doc, 'Look up on Wikipedia');
    assert.equal(ui.requests[1].query, 'budget approval');
    assert.deepEqual(ui.opened, []);
  }, false, null, true);
});

test('one source cooldown allows an immediate lookup on the other source', async () => {
  await mounted(async doc => {
    await press(doc, 'Search with DuckDuckGo');
    await act(async () => ui.requests[0].reject(ui.failure('rate_limit', Date.now() + 60000)));
    await press(doc, 'Look up on Wikipedia');
    assert.deepEqual(ui.requests.map(request => request.source), ['duckduckgo', 'wikipedia']);
  });
});
test('missing selection explains the Study entry point', async () => { await mounted(async doc => { assert.match(doc.body.textContent!, /Choose a topic first/); assert.equal(ui.requests.length, 0); }, false, null); });
test('light and dark use semantic surfaces and shared responsive bound with no fake checks or inert filters', async () => {
  for (const dark of [false, true]) await mounted(async doc => {
    const card = doc.querySelector<HTMLElement>('[data-testid="topic-preview"]')!;
    assert.equal(card.style.backgroundColor, dark ? 'rgb(24, 54, 109)' : 'rgb(231, 238, 255)');
    assert.match(doc.body.innerHTML, /max-width: 1440px/);
    assert.doesNotMatch(doc.body.textContent!, /Basic checks|Save resource|Web Docs Video|safe link/i);
  }, dark);
});
