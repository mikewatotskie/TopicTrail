import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { AnnotationListItem, AnnotationPayload, TextAnchorV1 } from '../src/core/services/annotations/types';
import type { ReaderMessage } from '../src/features/reader/selection';
import { canonicalSurface, captureTextAnchor, resolveTextAnchor } from '../src/features/reader/reader_anchors';
import { createOcrPlacementCheck, ocrPlacementCopy, ocrPlacementKey, type OcrPlacementOwner, type OcrRenderPlacements } from '../src/features/notes/ocrPlacement';

const date = '2026-11-14T00:00:00.000Z', hash = 'a'.repeat(64);
const transcript = '  Ang halaman 🌿 ay may mga selula.\r\nAng mga selula ay buhay.  ';
function anchorFor(text = transcript, quote = 'mga selula'): TextAnchorV1 {
  const dom = new JSDOM('<main><p data-annotation-block="ocr-page-text" data-annotation-surface="ocr-text"></p></main>');
  try {
    const root = dom.window.document.querySelector('main')!, block = root.firstElementChild!;
    block.textContent = text;
    const range = dom.window.document.createRange(), start = text.indexOf(quote), selection = dom.window.getSelection()!;
    assert.ok(start >= 0);
    range.setStart(block.firstChild!, start); range.setEnd(block.firstChild!, start + quote.length); selection.addRange(range);
    const anchor = captureTextAnchor(root, selection).anchor;
    assert.ok(anchor); return anchor;
  } finally { dom.window.close(); }
}
const note = (id = 'ocr-note', anchor = anchorFor()): AnnotationPayload => ({
  id, documentId: 'doc-1', documentHash: hash, format: 'pdf', location: { unit: 'page', index: 1 }, anchor,
  title: `Note ${id}`, body: 'Preserve my original explanation.', color: 'yellow', createdAt: date, updatedAt: date,
});

test('OCR cache placement matches the renderer’s canonical hash without altering Filipino, whitespace or UTF-16', () => {
  const anchor = anchorFor(), dom = new JSDOM('<main><p data-annotation-block="ocr-page-text" data-annotation-surface="ocr-text"></p></main>');
  try {
    const root = dom.window.document.querySelector('main')!; root.firstElementChild!.textContent = transcript;
    assert.equal(anchor.textHash, canonicalSurface(root, 'ocr-text').textHash);
    assert.ok(resolveTextAnchor(canonicalSurface(root, 'ocr-text'), anchor));
    assert.equal(createOcrPlacementCheck(transcript)(anchor), 'matches-text');
    assert.equal(createOcrPlacementCheck(null)(anchor), 'recognize-page');
    assert.equal(createOcrPlacementCheck('')(anchor), 'needs-review');
    assert.equal(ocrPlacementCopy['needs-review'].label, 'Needs review');
  } finally { dom.window.close(); }
});

test('different engines/devices never recover OCR placement by a repeated quote or normalized text', () => {
  const anchor = anchorFor();
  for (const text of [transcript.trim(), transcript.replace('\r\n', '\n'), transcript.replace('  ', ' '), transcript.replace('halaman', 'halamán'), `Other device: ${transcript}`]) {
    assert.ok(text.includes(anchor.quote));
    assert.equal(createOcrPlacementCheck(text)(anchor), 'needs-review');
  }
  const composed = 'Ang salitáng café ay café.', accentAnchor = anchorFor(composed, 'café');
  assert.equal(createOcrPlacementCheck(composed.normalize('NFD'))(accentAnchor), 'needs-review');
});

test('same hash still requires exact source ID, ordered range, UTF-16 boundaries, quote and context', () => {
  const anchor = anchorFor(), range = anchor.ranges[0];
  const invalid: TextAnchorV1[] = [
    { ...anchor, textHash: 'b'.repeat(64) }, { ...anchor, surface: 'pdf-text' },
    { ...anchor, ranges: [{ ...range, blockId: 'another-engine-block' }] },
    { ...anchor, ranges: [{ ...range, startUtf16: range.startUtf16 + 1 }] },
    { ...anchor, ranges: [{ ...range, endUtf16: transcript.length + 1 }] },
    { ...anchor, ranges: [range, { ...range, blockId: 'second-block' }] },
    { ...anchor, ranges: [{ ...range, startUtf16: -1 }] },
    { ...anchor, quote: 'selula' }, { ...anchor, prefix: 'different prefix' }, { ...anchor, suffix: 'different suffix' },
    { ...anchor, ranges: [{ ...range, startUtf16: transcript.indexOf('🌿') + 1 }] },
  ];
  const dom = new JSDOM('<main><p data-annotation-block="ocr-page-text" data-annotation-surface="ocr-text"></p></main>');
  try {
    const root = dom.window.document.querySelector('main')!; root.firstElementChild!.textContent = transcript;
    const model = canonicalSurface(root, 'ocr-text'), check = createOcrPlacementCheck(transcript);
    for (const candidate of invalid) { assert.equal(resolveTextAnchor(model, candidate), null); assert.equal(check(candidate), 'needs-review'); }
    const before = JSON.stringify(anchor); check(anchor); assert.equal(JSON.stringify(anchor), before);
  } finally { dom.window.close(); }
});

interface ProbeProps { payloads: AnnotationPayload[]; rendered?: OcrRenderPlacements }
let ui: {
  Probe: React.ComponentType<ProbeProps>; Reader: React.ComponentType;
  NotesPanel: React.ComponentType<{ ocrPlacements?: OcrRenderPlacements }>;
  reset(payloads: AnnotationPayload[], account?: string): void;
  owner(): OcrPlacementOwner; items(): AnnotationListItem[];
  seed(text: string | null, page?: number, legacy?: boolean): string;
  corrupt(): string; raw(key: string): string | null; reads(): string[]; writes(): number;
  holdReads(): void; releaseReads(): void;
  reader(): { receive(message: ReaderMessage): void; openPanel(): void; openNote(): void; beforeNavigation(): void };
};

before(async () => {
  const tokens = resolve('src/core/design/tokens.ts').replaceAll('\\', '/');
  const mocks: Record<string, string> = {
    'react-native': `import React from 'react';export * from 'react-native-web';export const Modal=({children,visible})=>visible?React.createElement('div',{role:'dialog'},children):null;`,
    'expo-router': `export const useLocalSearchParams=()=>({});export const useRouter=()=>({push(){},back(){},canGoBack:()=>false});`,
    'expo-image': `import React from 'react';export const Image=()=>React.createElement('span');`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    theme: `import {TTLightColors} from '${tokens}';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
    guestPort: `export const createAnnotationPort=()=>{throw Error('No note writes allowed');};`,
    cloud: `import {useSyncExternalStore} from 'react';let snapshot={identity:null,key:'guest',epoch:0,phase:'guest'};const listeners=new Set();const get=()=>snapshot;const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};const runtime={getSnapshot:get};export const getCloud=get;export const useCloudLibrary=()=>({state:useSyncExternalStore(subscribe,get,get),runtime});export function changeAccount(account='guest'){snapshot={identity:account==='guest'?null:{project:'abcdefghijklmnopqrst',uid:account},key:account==='guest'?'guest':'abcdefghijklmnopqrst/'+account,epoch:snapshot.epoch+1,phase:account==='guest'?'guest':'ready'};for(const fn of listeners)fn();}`,
    notes: `import {useSyncExternalStore} from 'react';import {changeAccount,getCloud} from '../library/CloudLibraryContext';let snapshot,controller;const listeners=new Set();const get=()=>snapshot;const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};export function reset(payloads,account='guest'){changeAccount(account);const scope=getCloud().key,epoch=getCloud().epoch;controller={context:{scope,epoch,account:account!=='guest',checkActive(){if(getCloud().key!==scope||getCloud().epoch!==epoch)throw Error('The account changed.');}},store:{saveDraft:async()=>{throw Error('Unexpected note write');}}};snapshot={items:payloads.map(payload=>({id:payload.id,payload,revision:1,deleted:false,parentDeleted:false,syncStatus:'local'})),trash:[],drafts:[],phase:'ready',message:'Saved notes',pending:0,lastSyncedAt:null};for(const fn of listeners)fn();}reset([]);export const owner=()=>controller.context;export const items=()=>snapshot.items;export const useNotes=()=>({controller,state:useSyncExternalStore(subscribe,get,get)});`,
    '@react-native-async-storage/async-storage': `import {getCloud} from '../library/CloudLibraryContext';const values=new Map();let readKeys=[],writeCount=0,held=false;const waiting=[];export const reads=()=>[...readKeys];export const writes=()=>writeCount;export const raw=key=>values.get(key)??null;export const resetIO=()=>{values.clear();readKeys=[];writeCount=0;held=false;};export const holdReads=()=>{held=true;};export const releaseReads=()=>{held=false;for(const complete of waiting.splice(0))complete();};function key(page=1,legacy=false){return 'topictrail.ocr.v1/'+(legacy?'tesseract-7-eng-1/eng':'tesseract-7-eng-fil-1/eng+fil')+'/'+getCloud().key+'/${hash}/'+page;}export function seed(text,page=1,legacy=false){const id=key(page,legacy);if(text!==null)values.set(id,JSON.stringify({key:id,result:{text,confidence:91,truncated:false}}));return id;}export function corrupt(){const id=key();values.set(id,'{preserve damaged cache');return id;}export default {getItem:async id=>{readKeys.push(id);const value=values.get(id)??null;if(held)return new Promise(resolve=>waiting.push(()=>resolve(value)));return value;},setItem:async(id,value)=>{writeCount++;values.set(id,value);}};`,
  };
  const built = await build({ stdin: { contents: `
    import React,{useRef} from 'react';
    import {useOcrNotePlacements} from './src/features/notes/ocrPlacementHooks';
    import {useNotes,reset as resetNotes} from './src/features/notes/NotesProvider';
    import {resetIO} from '@react-native-async-storage/async-storage';
    import {useReaderNotes} from './src/features/notes/useReaderNotes';
    export {owner,items} from './src/features/notes/NotesProvider';
    export {seed,corrupt,raw,reads,writes,holdReads,releaseReads} from '@react-native-async-storage/async-storage';
    export {NotesPanel} from './src/features/notes/NotesPanel';
    export function reset(payloads,account){resetIO();resetNotes(payloads,account);}
    export function Probe({payloads,rendered}){const {controller}=useNotes();const {placement,warning}=useOcrNotePlacements(payloads,controller.context,rendered);return <><p data-warning>{warning}</p>{payloads.map(payload=><p key={payload.id} data-ocr-id={payload.id} data-status={placement(payload)}>{placement(payload)}</p>)}</>;}
    let api;const document={id:'doc-1',format:'pdf'};export const reader=()=>api;
    export function Reader(){const viewer=useRef({setAnnotations(){},revealAnnotation(){},focus(){},cancelArea(){}});api=useReaderNotes(document,'${hash}',1,viewer,()=>{});return api.content;}
  `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.svg': 'dataurl' }, plugins: [{ name: 'ocr-placement-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const key = /ThemeContext$/.test(args.path) ? 'theme' : /NotesProvider$/.test(args.path) ? 'notes' : /CloudLibraryContext$/.test(args.path) ? 'cloud' : /annotation_port$/.test(args.path) ? 'guestPort' : args.path;
      if (key in mocks) return { path: key, namespace: 'boundary' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: mocks[args.path], loader: 'tsx', resolveDir: process.cwd() }));
  } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  ui = module.exports as typeof ui;
});

async function mounted(run: (doc: globalThis.Document, render: (element: React.ReactElement) => Promise<void>) => Promise<void>) {
  const dom = new JSDOM('<main></main>', { url: 'https://ocr-placement.test', pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.querySelector('main')!);
  const render = async (element: React.ReactElement) => { await act(async () => root.render(element)); };
  try { await run(dom.window.document, render); } finally {
    await act(async () => { root.unmount(); ui.releaseReads(); }); dom.window.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
}
const status = (doc: globalThis.Document, id = 'ocr-note') => doc.querySelector(`[data-ocr-id="${id}"]`)?.getAttribute('data-status');
async function press(doc: globalThis.Document, label: string) {
  const button = doc.querySelector<HTMLElement>(`[aria-label="${label}"]`); assert.ok(button, label); await act(async () => button.click());
}

test('hook deduplicates same-page reads and does not reread on new arrays or body/color edits', async () => {
  const first = note(), second = note('second'); ui.reset([first, second]); ui.seed(transcript);
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.Probe, { payloads: [first, second] }));
    assert.equal(status(doc), 'matches-text'); assert.equal(status(doc, 'second'), 'matches-text'); assert.equal(ui.reads().length, 2);
    await render(React.createElement(ui.Probe, { payloads: [{ ...first, body: 'Edited note', color: 'blue' }, { ...second }] }));
    assert.equal(ui.reads().length, 2); assert.equal(ui.writes(), 0);
    const unanchored = { ...first, anchor: null };
    await render(React.createElement(ui.Probe, { payloads: [unanchored] })); assert.equal(status(doc), null); assert.equal(ui.reads().length, 2);
  });
});

test('pending and absent OCR never claim a placed highlight, and legacy transcript is checked verbatim', async () => {
  const payload = note(); ui.reset([payload]); ui.holdReads();
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.Probe, { payloads: [payload] })); assert.equal(status(doc), 'check-on-open');
    await act(async () => ui.releaseReads()); assert.equal(status(doc), 'recognize-page'); assert.equal(ui.writes(), 0);
  });
  ui.reset([payload]); ui.seed(transcript, 1, true); ui.seed(transcript.trim());
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.Probe, { payloads: [payload] })); assert.equal(status(doc), 'matches-text'); assert.equal(ui.reads().length, 1); assert.equal(ui.writes(), 0);
  });
});

test('corrupt cached text is reported without repairing, replacing or deleting originals', async () => {
  const payload = note(), before = JSON.stringify(payload); ui.reset([payload]); const key = ui.corrupt(), original = ui.raw(key);
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.Probe, { payloads: [payload] })); assert.equal(status(doc), 'check-on-open');
    assert.match(doc.querySelector('[data-warning]')!.textContent!, /could not be read.*preserved/);
    assert.equal(ui.raw(key), original); assert.equal(ui.writes(), 0); assert.equal(JSON.stringify(ui.items()[0].payload), before);
  });
});

test('late account A reads and render placements cannot appear in account B or the next epoch', async () => {
  const payload = note(), accountA = '11111111-1111-1111-1111-111111111111', accountB = '22222222-2222-2222-2222-222222222222';
  ui.reset([payload], accountA); ui.seed(transcript); ui.holdReads();
  const oldRendered: OcrRenderPlacements = { owner: ui.owner(), checks: [{ key: ocrPlacementKey(payload)!, status: 'placed' }] };
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.Probe, { payloads: [payload] })); assert.equal(status(doc), 'check-on-open');
    await act(async () => { ui.reset([payload], accountB); ui.seed('Other engine: ' + transcript); });
    await render(React.createElement(ui.Probe, { payloads: [payload], rendered: oldRendered })); assert.equal(status(doc), 'check-on-open');
    await render(React.createElement(ui.Probe, { key: 'new-account', payloads: [payload], rendered: oldRendered }));
    assert.equal(status(doc), 'needs-review');
    await act(async () => ui.releaseReads()); assert.equal(status(doc), 'needs-review'); assert.equal(ui.writes(), 0);
    await act(async () => { ui.reset([payload], accountB); ui.seed(transcript); });
    assert.equal(status(doc), 'check-on-open');
    await render(React.createElement(ui.Probe, { key: 'same-account-new-epoch', payloads: [payload], rendered: oldRendered }));
    assert.equal(status(doc), 'matches-text');
  });
});

test('render placements are exact-anchor scoped and missing OCR cannot hide a known cache mismatch', async () => {
  const payload = note(); ui.reset([payload]); ui.seed('Different transcript: ' + transcript);
  const rendered: OcrRenderPlacements = { owner: ui.owner(), checks: [{ key: ocrPlacementKey(payload)!, status: 'recognize-page' }] };
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.Probe, { payloads: [payload], rendered })); assert.equal(status(doc), 'needs-review');
    const placed: OcrRenderPlacements = { ...rendered, checks: [{ key: ocrPlacementKey(payload)!, status: 'placed' }] };
    await render(React.createElement(ui.Probe, { payloads: [payload], rendered: placed })); assert.equal(status(doc), 'placed');
    const moved = { ...payload, location: { unit: 'page' as const, index: 2 } };
    await render(React.createElement(ui.Probe, { payloads: [moved], rendered: placed })); assert.equal(status(doc), 'recognize-page');
    assert.equal(ui.writes(), 0);
  });
});

test('NotesPanel outside the reader labels mismatched list, saved-note modal and real editor Needs review', async () => {
  const payload = note(), before = JSON.stringify(payload); ui.reset([payload]); ui.seed('Other engine: ' + transcript);
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.NotesPanel)); assert.match(doc.body.textContent!, /Needs review/);
    await press(doc, 'Open note: Note ocr-note');
    assert.match(doc.querySelector('[role="dialog"]')!.textContent!, /Needs review/);
    assert.match(doc.querySelector('[role="dialog"]')!.textContent!, /mga selula/);
    await press(doc, 'Edit note');
    const editor = [...doc.querySelectorAll('[role="dialog"]')].find(dialog => dialog.querySelector('[aria-label="Note text"]'))!;
    assert.match(editor.textContent!, /Needs review/);
    assert.equal(JSON.stringify(ui.items()[0].payload), before); assert.equal(ui.writes(), 0);
  });
});

test('NotesPanel without cached OCR says Recognize page rather than claiming placement', async () => {
  ui.reset([note()]);
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.NotesPanel)); assert.match(doc.body.textContent!, /Recognize page/); assert.doesNotMatch(doc.body.textContent!, /Placed on this page|Matches saved OCR text/);
  });
});

test('opening a retained NotesPanel item rechecks OCR that became available since its initial read', async () => {
  ui.reset([note()]);
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.NotesPanel)); assert.match(doc.body.textContent!, /Recognize page/);
    ui.seed('Newly recognized on this device: ' + transcript);
    await press(doc, 'Open note: Note ocr-note');
    assert.match(doc.querySelector('[role="dialog"]')!.textContent!, /Needs review/); assert.equal(ui.writes(), 0);
  });
});

test('conflicting versions sharing one note ID are checked against their own exact OCR anchor', async () => {
  const local = note(), cloudText = 'Other device: ' + transcript;
  const cloud = { ...local, anchor: anchorFor(cloudText), body: 'Cloud explanation' };
  ui.reset([local]); ui.seed(cloudText);
  ui.items()[0].conflict = { id: local.id, reason: 'revision', local: { id: local.id, operationId: 'local-operation', expectedRevision: 1, action: 'put', payload: local }, cloud: { id: local.id, revision: 2, deleted: false, payload: cloud } };
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.NotesPanel)); await press(doc, 'Compare versions: Note ocr-note');
    const dialog = doc.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent!, /Cloud version.*Cloud explanation.*Matches saved OCR text/);
    assert.match(dialog.textContent!, /This device.*Preserve my original explanation.*Needs review/);
    assert.equal(ui.writes(), 0);
  });
});

test('reader notice, note modal/editor and notes panel retain exact Needs review beside missing-OCR placements', async () => {
  const first = note(), second = note('other'); ui.reset([first, second]);
  await mounted(async (doc, render) => {
    await render(React.createElement(ui.Reader));
    await act(async () => { ui.reader().receive({ type: 'render-start', page: 1 }); ui.reader().receive({ type: 'page', page: 1, totalPages: 2, hasText: false }); });
    await act(async () => ui.reader().receive({ type: 'annotation-placements', page: 1, placements: [{ id: first.id, status: 'needs-review' }, { id: second.id, status: 'recognize-page' }] }));
    assert.match(doc.body.textContent!, /Needs review/); assert.match(doc.body.textContent!, /Recognize page/);
    await act(async () => ui.reader().openPanel());
    const panel = doc.querySelector('[role="dialog"]')!; assert.match(panel.textContent!, /Needs review/);
    await press(doc, 'Return to reading');
    // Select only one saved note, then use the same open/edit path as the reader.
    await act(async () => ui.reader().receive({ type: 'selection', page: 1, text: first.anchor!.kind === 'text' ? first.anchor!.quote : '', anchor: first.anchor as TextAnchorV1 }));
    await act(async () => ui.reader().openNote());
    await press(doc, 'Note ocr-note');
    assert.match(doc.querySelector('[role="dialog"]')!.textContent!, /Needs review/);
    await press(doc, 'Edit note or color');
    const editor = [...doc.querySelectorAll('[role="dialog"]')].find(dialog => dialog.querySelector('[aria-label="Note text"]'))!;
    assert.match(editor.textContent!, /Needs review/); assert.equal(ui.writes(), 0);
  });
});
