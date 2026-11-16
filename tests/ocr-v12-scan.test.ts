import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import type { CloudSyncSnapshot } from '../src/core/services/cloud/engine';
import { Document, DocumentFormat } from '../src/core/models/document';
import { DocumentRepository, type DocumentStoragePort } from '../src/core/services/document_repository';
import type { DocumentStorageApi } from '../src/core/services/document_storage_contract';
import { ImportResult, type ImportAttempt } from '../src/core/services/document_import_contract';
import { sha256 } from '../src/core/services/cloud/sha256';
import { OcrCacheStore } from '../src/core/services/ocr_cache';
import { guardScanStorage, ScanDraft, type ScanDraftIO } from '../src/features/scan/scan_draft';
import type { ScanPhoto, ScanTranscript } from '../src/features/scan/photo_contract';

const photo: ScanPhoto = { uri: 'scratch:fixture-photo', width: 4, height: 3 };
const transcript: ScanTranscript = { text: 'PRIVATE fixture transcript. Review this text.', confidence: null, truncated: false };
// Structural color-JPEG fixture for the PDF writer, not an OCR/decoder-accuracy fixture.
function jpeg(width = 4, height = 3) {
  return Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255,
    3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 0xff, 0xda, 0, 12, 3, 1, 0, 2, 17, 3, 17, 0, 63, 0, 0, 0xff, 0xd9);
}
let web: {
  DocumentImportService: new (storage: DocumentStorageApi) => { importFile(uri: string, name: string, attempt: ImportAttempt): Promise<ImportResult> };
  withScanPdfSource: ScanDraftIO['withPdfSource'];
  getWebImportSource(uri: string): Blob;
};

before(async () => {
  // Execute the actual web importer/source lifetime with only picker/default storage replaced.
  const result = await build({ stdin: { contents: `export {DocumentImportService} from './src/core/services/document_import.web';
    export {withScanPdfSource} from './src/features/scan/pdf_source.web';
    export {getWebImportSource} from './src/core/services/web/import_sources';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', plugins: [{ name: 'scan-import-io', setup(b) {
      b.onResolve({ filter: /^(expo-document-picker|\.\/document_storage)$/ }, args => ({ path: args.path, namespace: 'test-io' }));
      b.onLoad({ filter: /.*/, namespace: 'test-io' }, args => ({ loader: 'ts', contents: args.path === 'expo-document-picker'
        ? 'export function getDocumentAsync(){throw Error("No real picker in Node");}' : 'export const DocumentStorage={instance:{}};' }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  web = module.exports as typeof web;
});

function fixture() {
  const counts = { choose: 0, rotate: 0, recognize: 0, bytes: 0, copies: 0, writes: 0 };
  const released: string[] = [], attempts: ImportAttempt[] = [], sources: string[] = [], copies: string[] = [];
  const files = new Map<string, Uint8Array>(), cacheValues = new Map<string, string>();
  const cache = new OcrCacheStore({ getItem: async key => cacheValues.get(key) ?? null,
    setItem: async (key, value) => { cacheValues.set(key, value); } }, 'mlkit-16.0.1-latin-1');
  const cacheCalls: { hash: string; page: number; value: ScanTranscript }[] = [];
  let json: string | null = null, epoch = 1;
  const port: DocumentStoragePort = {
    readMetadata: async () => json,
    writeMetadata: async value => { counts.writes++; json = value; },
    copyToDocuments: async (source, id) => {
      counts.copies++; const bytes = new Uint8Array(await web.getWebImportSource(source).arrayBuffer());
      files.set(id, bytes); return { filePath: id, size: bytes.length };
    },
    removeFile: async path => { files.delete(path); }, fileExists: async path => files.has(path),
  };
  const repo = new DocumentRepository(port);
  const io: ScanDraftIO = {
    isCurrent: () => epoch === 1,
    actor: { kind: 'guest' },
    choosePhoto: async () => { counts.choose++; return photo; },
    releasePhoto: value => { released.push(value.uri); },
    rotatePhoto: async value => { counts.rotate++; return { uri: 'scratch:rotated', width: value.height, height: value.width }; },
    photoBytes: async value => { counts.bytes++; return jpeg(value.width, value.height); },
    recognizePhoto: async () => { counts.recognize++; return transcript; },
    withPdfSource: (bytes, use) => web.withScanPdfSource(bytes, uri => { sources.push(uri); return use(uri); }),
    importFile: (uri, name, attempt, current) => {
      attempts.push(attempt);
      return new web.DocumentImportService(guardScanStorage(repo, current)).importFile(uri, name, attempt);
    },
    saveTranscript: async (hash, page, value) => { cacheCalls.push({ hash, page, value }); await cache.save('guest', hash, page, value); },
    copyText: async text => { copies.push(text); },
  };
  const draft = new ScanDraft(io);
  return { draft, io, repo, port, counts, released, attempts, sources, files, cache, cacheCalls, copies, cacheValues,
    changeEpoch: () => { epoch++; }, json: () => json };
}
async function ready(f: ReturnType<typeof fixture>) {
  f.draft.activate(); await f.draft.choose(); await f.draft.recognize();
}
function noLibraryWrites(f: ReturnType<typeof fixture>) {
  assert.equal(f.counts.copies, 0); assert.equal(f.counts.writes, 0); assert.equal(f.attempts.length, 0); assert.equal(f.cacheValues.size, 0);
}
function sourcesReleased(f: ReturnType<typeof fixture>) {
  for (const uri of f.sources) assert.throws(() => web.getWebImportSource(uri), /available|source/i);
}

test('construction, activation and camera review perform no capture, recognition or import; Use photo is explicit', async () => {
  const f = fixture(); f.draft.subscribe(() => {}); f.draft.activate();
  assert.deepEqual(Object.values(f.counts), [0, 0, 0, 0, 0, 0]);
  f.draft.acceptPhoto(photo, 'camera');
  assert.equal(f.draft.getSnapshot().confirmed, false);
  await f.draft.recognize(); await f.draft.save();
  assert.equal(f.counts.recognize, 0); noLibraryWrites(f);
  f.draft.usePhoto(); await f.draft.recognize();
  assert.deepEqual(f.draft.getSnapshot().transcript, transcript);
  await f.draft.copyTranscript(); assert.deepEqual(f.copies, [transcript.text]);
  f.draft.discard(); noLibraryWrites(f);
  assert.deepEqual(f.released, [photo.uri]); assert.equal(f.draft.getSnapshot().photo, null);
});

test('photo chooser stays in the user gesture; duplicate activation is blocked and cancel preserves the current draft', async () => {
  const f = fixture(); const pending = Promise.withResolvers<ScanPhoto | null>();
  f.io.choosePhoto = () => { f.counts.choose++; return pending.promise; };
  f.draft.activate(); const selected = f.draft.choose();
  assert.equal(f.counts.choose, 1, 'picker invoked synchronously');
  await f.draft.choose(); assert.equal(f.counts.choose, 1);
  pending.resolve(photo); await selected;
  f.io.choosePhoto = async () => null;
  await f.draft.choose(); assert.equal(f.draft.getSnapshot().photo, photo);
  assert.match(f.draft.getSnapshot().message, /cancelled.*unchanged/);
  f.io.choosePhoto = async () => { throw Error('Unreadable JPG'); };
  await f.draft.choose(); assert.match(f.draft.getSnapshot().error, /Unreadable/);
  assert.equal(f.draft.getSnapshot().photo, photo); noLibraryWrites(f);
});

test('late chosen and captured photos are released after focus exit; reactivation does not revive the old picker', async () => {
  const f = fixture(); const pending = Promise.withResolvers<ScanPhoto | null>();
  f.io.choosePhoto = () => pending.promise;
  f.draft.activate(); const selected = f.draft.choose(); f.draft.deactivate(); f.draft.activate();
  pending.resolve(photo); await selected;
  assert.equal(f.draft.getSnapshot().photo, null); assert.deepEqual(f.released, [photo.uri]);
  f.draft.deactivate(); f.draft.acceptPhoto({ ...photo, uri: 'scratch:late-camera' }, 'camera');
  assert.deepEqual(f.released, [photo.uri, 'scratch:late-camera']); noLibraryWrites(f);
});

test('rotation releases the prior preview, clears stale text and uses the final dimensions for recognition', async () => {
  const f = fixture(); await ready(f); await f.draft.rotate();
  assert.equal(f.draft.getSnapshot().transcript, null);
  assert.deepEqual(f.draft.getSnapshot().photo, { uri: 'scratch:rotated', width: 3, height: 4 });
  assert.deepEqual(f.released, [photo.uri]);
  f.io.recognizePhoto = async value => { assert.equal(value.uri, 'scratch:rotated'); return transcript; };
  await f.draft.recognize(); f.draft.discard();
  assert.deepEqual(f.released, [photo.uri, 'scratch:rotated']); noLibraryWrites(f);
});

test('a rotated photo arriving after account invalidation is cleaned without publishing private pixels', async () => {
  const f = fixture(); await ready(f); const pending = Promise.withResolvers<ScanPhoto>();
  f.io.rotatePhoto = () => pending.promise;
  const rotating = f.draft.rotate(); f.changeEpoch(); f.draft.deactivate();
  pending.resolve({ uri: 'scratch:late-rotation', width: 3, height: 4 }); await rotating;
  assert.equal(f.draft.getSnapshot().photo, null);
  assert.deepEqual(f.released, [photo.uri, 'scratch:late-rotation']); noLibraryWrites(f);
});

test('Cancel recognition aborts and rejects even a non-cooperative late result, retaining the private photo', async () => {
  const f = fixture(); f.draft.activate(); await f.draft.choose();
  const pending = Promise.withResolvers<ScanTranscript>(); let signal!: AbortSignal;
  f.io.recognizePhoto = (_photo, value) => { signal = value; return pending.promise; };
  const recognizing = f.draft.recognize(); f.draft.cancelRecognition();
  assert.equal(signal.aborted, true); assert.match(f.draft.getSnapshot().message, /cancelled/);
  pending.resolve(transcript); await recognizing;
  assert.equal(f.draft.getSnapshot().transcript, null); assert.equal(f.draft.getSnapshot().photo, photo);
  noLibraryWrites(f);
});

test('blank, malformed and failed recognition have distinct feedback, with null native confidence preserved', async () => {
  const f = fixture(); f.draft.activate(); await f.draft.choose();
  f.io.recognizePhoto = async () => ({ text: '  ', confidence: null, truncated: false });
  await f.draft.recognize(); assert.match(f.draft.getSnapshot().message, /No readable text/);
  await f.draft.copyTranscript(); assert.equal(f.copies.length, 0);
  f.io.recognizePhoto = async () => ({ ...transcript, text: 'x'.repeat(50_001) });
  await f.draft.recognize(); assert.match(f.draft.getSnapshot().error, /unreadable/); assert.equal(f.draft.getSnapshot().transcript, null);
  f.io.recognizePhoto = async () => { throw Error('Local recognizer unavailable'); };
  await f.draft.recognize(); assert.match(f.draft.getSnapshot().error, /Local recognizer unavailable/);
  noLibraryWrites(f);
});

test('focus exit clears private text and blocks late OCR on the next focus lifetime', async () => {
  const f = fixture(); await ready(f);
  const pending = Promise.withResolvers<ScanTranscript>(); f.io.recognizePhoto = () => pending.promise;
  const recognizing = f.draft.recognize(); f.draft.deactivate(); f.draft.activate();
  pending.resolve(transcript); await recognizing;
  assert.equal(f.draft.getSnapshot().photo, null); assert.equal(f.draft.getSnapshot().transcript, null);
  assert.equal(f.draft.getSnapshot().busy, null); noLibraryWrites(f);
});

test('Save imports one real image-only PDF and caches the transcript by its exact final hash/page 1', async () => {
  const f = fixture(); await ready(f); const document = await f.draft.save(); assert.ok(document);
  assert.equal(document.format, DocumentFormat.PDF); assert.match(document.title, /^Scan /);
  assert.equal(f.counts.copies, 1); assert.equal(f.counts.writes, 1);
  const bytes = f.files.get(document.filePath)!;
  assert.match(new TextDecoder().decode(bytes), /^%PDF-1.4/);
  assert.doesNotMatch(new TextDecoder().decode(bytes), /PRIVATE|fixture-photo|transcript/);
  assert.deepEqual(f.cacheCalls, [{ hash: sha256(bytes), page: 1, value: transcript }]);
  assert.deepEqual(await f.cache.read('guest', sha256(bytes), 1), transcript);
  assert.equal((await f.repo.getAllDocuments()).length, 1);
  assert.deepEqual(await f.repo.getGuestAllowance(), { kind: 'disabled' });
  assert.equal(JSON.parse(f.json()!).guestImports.length, 0);
  assert.equal(JSON.parse(f.json()!).importAttempts[0].attemptId, f.attempts[0].attemptId);
  assert.equal(f.draft.getSnapshot().photo, null); assert.deepEqual(f.released, [photo.uri]); sourcesReleased(f);
  await f.draft.save(); assert.equal(f.attempts.length, 1, 'success is not submitted again');
});

test('rapid Save presses are guarded synchronously before reading image bytes', async () => {
  const f = fixture(); await ready(f); const pending = Promise.withResolvers<Uint8Array>();
  f.io.photoBytes = () => { f.counts.bytes++; return pending.promise; };
  const first = f.draft.save(); await f.draft.save(); await f.draft.save();
  assert.equal(f.counts.bytes, 1); assert.equal(f.draft.getSnapshot().busy, 'saving');
  pending.resolve(jpeg()); await first;
  assert.equal(f.attempts.length, 1); assert.equal(f.counts.writes, 1);
});

test('an uncertain committed import retries its original receipt, PDF bytes and actor without a second library write', async () => {
  const f = fixture(); await ready(f); const importer = f.io.importFile;
  f.io.importFile = async (...args) => { const result = await importer(...args); assert.equal(result.success, true); return new ImportResult(false, undefined, 'Interrupted acknowledgement', false, 'retry'); };
  await f.draft.save();
  assert.equal(f.draft.getSnapshot().photo, photo); assert.ok(f.draft.getSnapshot().transcript);
  assert.match(f.draft.getSnapshot().message, /draft is kept/i); assert.equal(f.cacheCalls.length, 0); sourcesReleased(f);
  const first = f.attempts[0]; f.io.actor = { kind: 'account', uid: 'must-not-recapture' };
  f.io.importFile = importer; f.io.photoBytes = async () => { assert.fail('retry must use frozen final PDF bytes'); };
  await f.draft.rotate(); await f.draft.choose(); await f.draft.recognize();
  const document = await f.draft.save(); assert.ok(document);
  assert.equal(f.attempts[1], first); assert.deepEqual(first.actor, { kind: 'guest' });
  assert.equal(f.counts.copies, 1); assert.equal(f.counts.writes, 1); assert.equal(f.draft.getSnapshot().result?.code, 'committed');
  assert.equal(f.cacheCalls.length, 1); sourcesReleased(f);
});

test('failed preparation keeps the photo and transcript for explicit retry, without any premature library writes', async () => {
  const f = fixture(); await ready(f); const read = f.io.photoBytes;
  f.io.photoBytes = async () => { throw Error('Temporary image read failure'); };
  await f.draft.save(); assert.equal(f.draft.getSnapshot().photo, photo); assert.ok(f.draft.getSnapshot().transcript);
  assert.match(f.draft.getSnapshot().error, /Temporary/); noLibraryWrites(f);
  f.io.photoBytes = read; assert.ok(await f.draft.save()); assert.equal(f.counts.writes, 1);
});

test('account epoch changes before PDF preparation or source completion prevent import entirely', async () => {
  for (const stage of ['bytes', 'source'] as const) {
    const f = fixture(); await ready(f);
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    if (stage === 'bytes') f.io.photoBytes = async () => { entered.resolve(); await resume.promise; return jpeg(); };
    else f.io.withPdfSource = (bytes, use) => web.withScanPdfSource(bytes, async uri => { f.sources.push(uri); entered.resolve(); await resume.promise; return use(uri); });
    const saving = f.draft.save(); await entered.promise;
    f.changeEpoch(); f.draft.deactivate(); resume.resolve(); await saving;
    noLibraryWrites(f); sourcesReleased(f); assert.equal(f.draft.getSnapshot().photo, null);
  }
});

test('storage fence stops same-UID new-epoch writes after importer validation has already started', async () => {
  const f = fixture(); await ready(f);
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const importer = f.io.importFile;
  f.io.importFile = async (uri, ...args) => {
    const blob = web.getWebImportSource(uri), read = blob.arrayBuffer.bind(blob);
    blob.arrayBuffer = async () => { entered.resolve(); await resume.promise; return read(); };
    return importer(uri, ...args);
  };
  const saving = f.draft.save(); await entered.promise;
  f.changeEpoch(); f.draft.deactivate(); resume.resolve(); await saving;
  assert.equal(f.attempts.length, 1); assert.equal(f.counts.writes, 0); assert.equal(f.counts.copies, 0);
  assert.equal(f.cacheCalls.length, 0); sourcesReleased(f);
});

test('an already-started import may finish only in its captured store; stale success never caches or restores the preview', async () => {
  const f = fixture(); await ready(f);
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const write = f.port.writeMetadata;
  f.port.writeMetadata = async value => { entered.resolve(); await resume.promise; await write(value); };
  const saving = f.draft.save(); await entered.promise;
  f.changeEpoch(); f.draft.deactivate(); resume.resolve(); await saving;
  assert.equal(f.counts.writes, 1); assert.equal((await f.repo.getAllDocuments()).length, 1);
  assert.equal(f.cacheCalls.length, 0); assert.equal(f.draft.getSnapshot().result, null);
  assert.equal(f.draft.getSnapshot().photo, null); sourcesReleased(f);
});

test('device-local cache failure reports a saved PDF and never enables another import', async () => {
  const f = fixture(); await ready(f); f.io.saveTranscript = async () => { throw Error('cache quota'); };
  assert.ok(await f.draft.save()); assert.equal(f.draft.getSnapshot().result?.success, true);
  assert.match(f.draft.getSnapshot().error, /PDF was saved.*transcript/);
  await f.draft.save(); assert.equal(f.attempts.length, 1); assert.equal(f.counts.writes, 1);
});

test('deleted receipt replay cannot resurrect a scan or cache text under a missing document', async () => {
  const f = fixture(); await ready(f); const importer = f.io.importFile;
  f.io.importFile = async (...args) => { const result = await importer(...args); assert.ok(result.document); await f.repo.deleteDocument(result.document.id); return new ImportResult(false, undefined, 'Interrupted', false, 'retry'); };
  await f.draft.save(); f.io.importFile = importer;
  await f.draft.save(); assert.equal(f.draft.getSnapshot().result?.code, 'already_deleted');
  const before = f.counts.writes; await f.draft.save();
  assert.equal(f.counts.writes, before); assert.equal(f.counts.copies, 1); assert.equal(f.cacheCalls.length, 0);
  assert.equal((await f.repo.getAllDocuments()).length, 0);
});

test('Discard after an uncertain save performs no rollback/delete and honestly directs the user to the library', async () => {
  const f = fixture(); await ready(f); const importer = f.io.importFile;
  f.io.importFile = async (...args) => { await importer(...args); return new ImportResult(false, undefined, 'Unknown result', false, 'retry'); };
  await f.draft.save(); const writes = f.counts.writes;
  f.draft.discard(); assert.equal(f.counts.writes, writes); assert.equal((await f.repo.getAllDocuments()).length, 1);
  assert.match(f.draft.getSnapshot().message, /interrupted.*My Syllabi/);
  assert.equal(f.draft.getSnapshot().photo, null); assert.equal(f.draft.getSnapshot().transcript, null);
  assert.deepEqual(f.released, [photo.uri]); sourcesReleased(f);
});

test('unavailable account boundary refuses choosing, recognition and saving', async () => {
  const f = fixture(); f.changeEpoch(); f.draft.activate();
  await f.draft.choose(); f.draft.acceptPhoto(photo, 'camera'); f.draft.usePhoto(); await f.draft.recognize(); await f.draft.save();
  assert.equal(f.counts.choose, 0); assert.equal(f.counts.recognize, 0); assert.equal(f.draft.getSnapshot().photo, null);
  assert.deepEqual(f.released, [photo.uri]); noLibraryWrites(f);
});

test('the storage guard rejects stale results as well as stale entry calls', async () => {
  const f = fixture(); let current = true; const pending = Promise.withResolvers<Document | null>();
  f.repo.getDocument = () => pending.promise;
  const fenced = guardScanStorage(f.repo, () => current), reading = fenced.getDocument('old');
  current = false; pending.resolve(new Document('old', 'Old account', DocumentFormat.PDF, 'old.pdf', new Date()));
  await assert.rejects(reading, /session changed/);
  await assert.rejects(fenced.saveDocument({ title: 'Must not save', originalPath: 'missing', format: DocumentFormat.PDF }), /session changed/);
  noLibraryWrites(f);
});

test('rendered shared Scan screen with real controls and synthetic platform IO', async t => {
  const dom = new JSDOM('<main></main>', { url: 'https://scan-ui.test', pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  try {
    const tokens = resolve('src/core/design/tokens.ts').replaceAll('\\', '/');
    const button = resolve('src/components/TTButton.tsx').replaceAll('\\', '/');
    const mocks: Record<string, string> = {
      'scan-test-boundary': `import {useSyncExternalStore} from 'react';
        export let setup;export let focused=true;let params={};const listeners=new Set();export const routes=[];export let cameras=0;
        export const Platform={OS:'web'};
        const appListeners=new Set();let cameraCapture;
        export function configure(value){setup=value;cameras=0;cameraCapture=undefined;routes.length=0;params={source:'camera'};Platform.OS='web';setFocused(true);}
        export function setParams(value){params=value;listeners.forEach(fn=>fn());}
        export const useLocalSearchParams=()=>useSyncExternalStore(subscribe,()=>params,()=>params);
        export function setFocused(value){focused=value;listeners.forEach(fn=>fn());}
        export function setAppState(value){appListeners.forEach(fn=>fn(value));}
        export const appListenerCount=()=>appListeners.size;
        export const AppState={addEventListener:(event,fn)=>{if(event!=='change')throw Error('Unexpected AppState event');appListeners.add(fn);return {remove:()=>appListeners.delete(fn)};}};
        export function setCameraCapture(capture){cameraCapture=capture;}
        const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
        export const useIsFocused=()=>useSyncExternalStore(subscribe,()=>focused,()=>focused);
        export function capture(){cameras++;return cameraCapture?cameraCapture():{uri:'scratch:camera-'+cameras,width:4,height:3};}`,
      'react-native': `export * from 'react-native-web';export {AppState,Platform} from 'scan-test-boundary';`,
      'expo-router': `import {useEffect} from 'react';import {useIsFocused,routes} from 'scan-test-boundary';
        export {useIsFocused} from 'scan-test-boundary';
        export {useLocalSearchParams} from 'scan-test-boundary';
        export const useRouter=()=>({replace:route=>routes.push(route),push:route=>routes.push(route),back:()=>routes.push('back'),canGoBack:()=>false});
        export function useFocusEffect(fn){const focused=useIsFocused();useEffect(()=>focused?fn():undefined,[fn,focused]);}`,
      'expo-image': `import React from 'react';export const Image=()=>React.createElement('span');`,
      '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
      'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
      'expo-clipboard': `import {setup} from 'scan-test-boundary';export const setStringAsync=text=>setup.io.copyText(text);`,
      theme: `import {TTLightColors} from '${tokens}';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
      photo: `import {setup} from 'scan-test-boundary';export const choosePhoto=signal=>setup.io.choosePhoto(signal);export const releasePhoto=p=>setup.io.releasePhoto(p);
        export const rotatePhoto=p=>setup.io.rotatePhoto(p);export const photoBytes=p=>setup.io.photoBytes(p);export const recognizePhoto=(p,s)=>setup.io.recognizePhoto(p,s);`,
      camera: `import React,{useEffect,useImperativeHandle,useRef} from 'react';import {capture,setup} from 'scan-test-boundary';import {TTButton} from '${button}';
        export function ScanCamera({onPhoto,onActiveChange,disabled,label,openRef}){const mounted=useRef(true);
          useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
          function open(){if(disabled)return;onActiveChange?.(true);Promise.resolve(capture()).then(photo=>{
            if(!mounted.current){if(photo)setup.io.releasePhoto(photo);return;}onActiveChange?.(false);if(photo)onPhoto(photo);
          });}useImperativeHandle(openRef,()=>open);
          return <TTButton label={label} disabled={disabled} onPress={open}/>;}`,
      source: `import {setup} from 'scan-test-boundary';export const withScanPdfSource=(bytes,use)=>setup.io.withPdfSource(bytes,use);`,
      storage: `import {setup} from 'scan-test-boundary';export const DocumentStorage={get instance(){return setup.repo;}};`,
      importer: `import {setup} from 'scan-test-boundary';export class DocumentImportService{constructor(storage){this.storage=storage;}importFile(uri,name,attempt){return setup.importFile(this.storage,uri,name,attempt);}}`,
      cache: `import {setup} from 'scan-test-boundary';export const useOcrCache=()=>({warning:'',save:(hash,page,text)=>setup.io.saveTranscript(hash,page,text)});`,
    };
    const built = await build({ stdin: { contents: `export {ScanScreen} from './src/features/scan/ScanScreen';
      export {CloudRuntimeContext} from './src/features/library/CloudLibraryContext';
      export {beginDockScan} from './src/features/scan/scan_entry';
      export {configure,setFocused,setParams,Platform,setAppState,appListenerCount,setCameraCapture,routes,cameras} from 'scan-test-boundary';`, loader: 'tsx', resolveDir: process.cwd() },
      bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.svg': 'dataurl' }, plugins: [{ name: 'scan-screen-io', setup(b) {
        b.onResolve({ filter: /.*/ }, args => {
          const key = /ThemeContext$/.test(args.path) ? 'theme' : /photo_platform$/.test(args.path) ? 'photo'
            : /ScanCamera$/.test(args.path) ? 'camera' : /pdf_source$/.test(args.path) ? 'source'
              : /document_storage$/.test(args.path) ? 'storage' : /document_import$/.test(args.path) ? 'importer'
                : /useOcrCache$/.test(args.path) ? 'cache' : args.path;
          if (key in mocks) return { path: key, namespace: 'test-ui' };
        });
        b.onLoad({ filter: /.*/, namespace: 'test-ui' }, args => ({ contents: mocks[args.path], loader: 'tsx', resolveDir: process.cwd() }));
      } }] });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
    const ui = module.exports as { ScanScreen: React.ComponentType; CloudRuntimeContext: React.Context<unknown>;
      configure(value: unknown): void; setFocused(value: boolean): void; setAppState(value: 'active' | 'inactive' | 'background'): void;
      appListenerCount(): number; setCameraCapture(capture: () => Promise<ScanPhoto | null>): void;
      Platform: { OS: 'web' | 'android' }; setParams(value: { entry: 'pick' | 'capture'; request: string }): void;
      beginDockScan(entry: 'pick' | 'capture', epoch: number): string;
      routes: { pathname: string; params: { documentId: string } }[]; cameras: number };
    const { createRoot } = await import('react-dom/client');
    async function mount(run: (f: ReturnType<typeof fixture>, publish: (value: CloudSyncSnapshot) => void) => Promise<void>,
      beforeMount?: (f: ReturnType<typeof fixture>) => void) {
      const f = fixture();
      ui.configure({ ...f, importFile: (storage: DocumentStorageApi, uri: string, name: string, attempt: ImportAttempt) => new web.DocumentImportService(storage).importFile(uri, name, attempt) });
      beforeMount?.(f);
      let snapshot: CloudSyncSnapshot = { identity: null, key: null, phase: 'guest', epoch: 1, revision: 1, message: '', pending: 0, lastSyncedAt: null };
      const listeners = new Set<() => void>();
      const runtime = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
      const root = createRoot(dom.window.document.querySelector('main')!);
      try {
        await act(async () => root.render(React.createElement(React.StrictMode, null,
          React.createElement(ui.CloudRuntimeContext.Provider, { value: runtime }, React.createElement(ui.ScanScreen)))));
        await run(f, value => { snapshot = value; listeners.forEach(fn => fn()); });
      } finally { await act(async () => root.unmount()); }
    }
    async function press(label: string) {
      const control = dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      assert.ok(control, label); assert.notEqual(control.getAttribute('aria-disabled'), 'true', label);
      await act(async () => control.click());
    }
    await t.test('dock picker starts inside the web gesture and once on a focused Android route; cancellation never saves or reopens', async () => {
      for (const platform of ['web', 'android'] as const) {
        const pending = Promise.withResolvers<ScanPhoto | null>();
        let calls = 0;
        await mount(async f => {
          assert.equal(calls, 1);
          assert.equal(ui.cameras, 0);
          await act(async () => ui.setAppState('background'));
          await act(async () => ui.setAppState('active'));
          await act(async () => pending.resolve(null));
          assert.match(dom.window.document.body.textContent!, /Photo selection cancelled/);
          assert.ok(dom.window.document.querySelector('[aria-label="Choose photo"]'));
          await act(async () => ui.setFocused(false));
          await act(async () => ui.setFocused(true));
          assert.equal(calls, 1);
          noLibraryWrites(f);
        }, f => {
          ui.Platform.OS = platform;
          f.io.choosePhoto = () => { calls++; return pending.promise; };
          ui.setParams({ entry: 'pick', request: ui.beginDockScan('pick', 1) });
          assert.equal(calls, platform === 'web' ? 1 : 0, 'browser picker needs the original press');
        });
      }
    });
    await t.test('dock camera opens once under StrictMode and remains closed on resume, refocus and URL replay', async () => {
      await mount(async f => {
        assert.equal(ui.cameras, 1);
        assert.equal(f.counts.choose, 0);
        await act(async () => ui.setAppState('active'));
        await act(async () => ui.setFocused(false));
        await act(async () => ui.setFocused(true));
        await act(async () => ui.setParams({ entry: 'capture', request: 'restored-link' }));
        assert.equal(ui.cameras, 1);
        assert.ok(dom.window.document.querySelector('[aria-label="Take a photo"]'));
        noLibraryWrites(f);
      }, () => {
        ui.setCameraCapture(async () => null);
        ui.setParams({ entry: 'capture', request: ui.beginDockScan('capture', 1) });
      });
    });
    await t.test('old identity and an existing preview reject a dock handoff and release its result', async () => {
      const stale = Promise.withResolvers<ScanPhoto | null>();
      await mount(async f => {
        await act(async () => stale.resolve({ ...photo, uri: 'scratch:previous-epoch' }));
        assert.deepEqual(f.released, ['scratch:previous-epoch']);
        assert.doesNotMatch(dom.window.document.body.textContent!, /Photo preview/);
        f.io.choosePhoto = async () => photo;
        await press('Choose photo');
        await press('Recognize text');
        f.io.choosePhoto = async () => ({ ...photo, uri: 'scratch:duplicate-entry' });
        await act(async () => ui.setParams({ entry: 'pick', request: ui.beginDockScan('pick', 1) }));
        assert.equal(dom.window.document.querySelector('[data-testid="scan-transcript"]')?.textContent, transcript.text);
        assert.deepEqual(f.released, ['scratch:previous-epoch', 'scratch:duplicate-entry']);
        noLibraryWrites(f);
      }, f => {
        f.io.choosePhoto = () => stale.promise;
        ui.setParams({ entry: 'pick', request: ui.beginDockScan('pick', 99) });
      });
    });
    await t.test('camera preference never auto-opens; review → recognize → selectable/copy → Save → normal reader', async () => {
      await mount(async f => {
        assert.equal(ui.cameras, 0); assert.equal(f.counts.choose, 0);
        await press('Take a photo'); assert.equal(ui.cameras, 1);
        assert.ok(dom.window.document.querySelector('[aria-label="Retake"]'));
        assert.equal(dom.window.document.querySelector('[aria-label="Save to library"]')?.getAttribute('aria-disabled'), 'true');
        assert.equal(dom.window.document.querySelector('[aria-label="Recognize text"]'), null);
        await press('Use photo'); await press('Recognize text');
        const text = dom.window.document.querySelector('[data-testid="scan-transcript"]'); assert.ok(text);
        assert.equal(text.textContent, transcript.text);
        assert.equal(dom.window.getComputedStyle(text).userSelect, 'text');
        await press('Copy transcript'); assert.deepEqual(f.copies, [transcript.text]);
        await press('Save to library'); assert.equal(f.counts.writes, 1); assert.equal(f.cacheCalls.length, 1);
        await press('Open PDF'); assert.equal(ui.routes[0].pathname, '/reader/[documentId]');
        assert.equal(ui.routes[0].params.documentId, (await f.repo.getAllDocuments())[0].id);
      });
    });
    await t.test('epoch changes and focus exit clear rendered private content and ignore late recognition', async () => {
      await mount(async (f, publish) => {
        const pending = Promise.withResolvers<ScanTranscript>(); f.io.recognizePhoto = () => pending.promise;
        await press('Choose photo'); await press('Recognize text');
        assert.ok(dom.window.document.querySelector('[aria-label="Cancel recognition"]'));
        await act(async () => publish({ epoch: 2, revision: 2, phase: 'ready', identity: { project: 'abcdefghijklmnopqrst', uid: 'new-account' },
          key: 'abcdefghijklmnopqrst/new-account', message: '', pending: 0, lastSyncedAt: null }));
        await act(async () => { pending.resolve(transcript); await pending.promise; });
        assert.equal(dom.window.document.querySelector('[data-testid="scan-transcript"]'), null);
        assert.doesNotMatch(dom.window.document.body.textContent!, /Photo preview/);
        f.io.recognizePhoto = async () => transcript;
        await press('Choose photo'); await press('Recognize text');
        assert.match(dom.window.document.body.textContent!, /PRIVATE fixture/);
        await act(async () => ui.setFocused(false)); await act(async () => ui.setFocused(true));
        assert.equal(dom.window.document.querySelector('[data-testid="scan-transcript"]'), null);
        assert.doesNotMatch(dom.window.document.body.textContent!, /Photo preview/);
        noLibraryWrites(f); assert.equal(ui.cameras, 0);
      });
    });
    await t.test('app inactivity cancels focused recognition, retains its photo, rejects late results and requires explicit restart', async () => {
      await mount(async f => {
        await press('Choose photo');
        let calls = 0;
        for (const state of ['inactive', 'background'] as const) {
          const pending = Promise.withResolvers<ScanTranscript>(); let signal!: AbortSignal;
          f.io.recognizePhoto = (_photo, value) => { calls++; signal = value; return pending.promise; };
          await press('Recognize text');
          assert.equal(signal.aborted, false);
          await act(async () => ui.setAppState(state));
          assert.equal(signal.aborted, true, `${state} must abort while the route remains focused`);
          assert.match(dom.window.document.body.textContent!, /Photo preview/);
          assert.match(dom.window.document.body.textContent!, /Recognition cancelled/);
          assert.equal(dom.window.document.querySelector('[aria-label="Cancel recognition"]'), null);
          assert.notEqual(dom.window.document.querySelector('[aria-label="Recognize text"]')?.getAttribute('aria-disabled'), 'true');
          assert.deepEqual(f.released, []);
          const before = calls;
          await act(async () => ui.setAppState('active'));
          assert.equal(calls, before, 'foregrounding must not restart recognition');
          await act(async () => { pending.resolve(transcript); await pending.promise; });
          assert.equal(dom.window.document.querySelector('[data-testid="scan-transcript"]'), null);
          noLibraryWrites(f);
        }
        f.io.recognizePhoto = async () => { calls++; return transcript; };
        await press('Recognize text');
        assert.equal(calls, 3);
        await act(async () => ui.setAppState('background'));
        assert.equal(dom.window.document.querySelector('[data-testid="scan-transcript"]')?.textContent, transcript.text,
          'backgrounding after recognition must preserve the finished transcript');
        assert.deepEqual(f.released, []); noLibraryWrites(f);
        assert.equal(ui.appListenerCount(), 1, 'StrictMode must leave one current subscription');
      });
      assert.equal(ui.appListenerCount(), 0, 'unmount must release the AppState subscription');
    });
    await t.test('an external photo picker can background the app and return without losing the private draft or its result', async () => {
      await mount(async f => {
        await press('Choose photo'); await press('Recognize text');
        const pending = Promise.withResolvers<ScanPhoto | null>(); f.io.choosePhoto = () => pending.promise;
        await press('Choose photo');
        for (const state of ['inactive', 'background', 'active'] as const) await act(async () => ui.setAppState(state));
        assert.match(dom.window.document.body.textContent!, /Waiting for the photo chooser/);
        assert.equal(dom.window.document.querySelector('[data-testid="scan-transcript"]')?.textContent, transcript.text);
        assert.deepEqual(f.released, [], 'picker backgrounding must not discard the existing preview');
        await act(async () => { pending.resolve({ ...photo, uri: 'scratch:external-picker-result' }); await pending.promise; });
        assert.match(dom.window.document.body.textContent!, /Photo preview/);
        assert.equal(dom.window.document.querySelector('[data-testid="scan-transcript"]'), null);
        assert.deepEqual(f.released, [photo.uri], 'only replacing the photo releases the previous preview');
        f.io.recognizePhoto = async received => { assert.equal(received.uri, 'scratch:external-picker-result'); return transcript; };
        await press('Recognize text'); assert.equal(dom.window.document.querySelector('[data-testid="scan-transcript"]')?.textContent, transcript.text);
        noLibraryWrites(f);
      });
    });
    await t.test('system-camera backgrounding preserves its pending capture and returns to explicit Use photo review', async () => {
      await mount(async f => {
        await press('Choose photo');
        const pending = Promise.withResolvers<ScanPhoto>(); ui.setCameraCapture(() => pending.promise);
        await press('Take a photo'); assert.equal(ui.cameras, 1);
        for (const state of ['inactive', 'background', 'active'] as const) await act(async () => ui.setAppState(state));
        assert.match(dom.window.document.body.textContent!, /Photo preview/);
        assert.deepEqual(f.released, []);
        await act(async () => { pending.resolve({ ...photo, uri: 'scratch:system-camera-result' }); await pending.promise; });
        assert.ok(dom.window.document.querySelector('[aria-label="Use photo"]'));
        assert.equal(dom.window.document.querySelector('[aria-label="Save to library"]')?.getAttribute('aria-disabled'), 'true');
        assert.equal(dom.window.document.querySelector('[aria-label="Recognize text"]'), null);
        assert.deepEqual(f.released, [photo.uri], 'the completed capture must replace, not discard, the private draft');
        f.io.recognizePhoto = async received => { assert.equal(received.uri, 'scratch:system-camera-result'); return transcript; };
        await press('Use photo'); await press('Recognize text');
        assert.equal(dom.window.document.querySelector('[data-testid="scan-transcript"]')?.textContent, transcript.text);
        assert.equal(ui.cameras, 1); noLibraryWrites(f);
      });
    });
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
