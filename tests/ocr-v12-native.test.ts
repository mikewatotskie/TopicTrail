import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { nativeProbeSource, type NativePropRecord } from './helpers/accessibility';
import type { ScanPhoto, ScanTranscript } from '../src/features/scan/photo_contract';

// Production TS/React with only native IO replaced. These tests do not execute Android,
// a system camera, ML Kit, permissions, accessibility services or native bitmap decoding.
let compiled: string;
let dom: JSDOM;
const globals = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://scan.test', pretendToBeVisual: true });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const boundaries: Record<string, string> = {
    'react-native': nativeProbeSource() + '\nexport const NativeModules=io.modules;',
    'expo-document-picker': 'export const getDocumentAsync=options=>io.choose(options);',
    'expo-file-system': 'export const File=io.File,Directory=io.Directory,Paths=io.Paths,FileMode={ReadOnly:"r",WriteOnly:"w"};',
    'theme': `import {TTLightColors} from './src/core/design/tokens';export const useColors=()=>({colors:TTLightColors});`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    'react-native-safe-area-context': 'export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});',
  };
  const bundle = await build({ stdin: { contents: `export * from './src/features/scan/native_ocr';
    export * from './src/features/scan/photo_platform';export {ScanCamera} from './src/features/scan/ScanCamera';
    export {setProbePlatform,nativeProps,roleViolations} from 'react-native';`, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  plugins: [{ name: 'native-scan-io', setup(builder) {
    builder.onResolve({ filter: /ThemeContext$/ }, () => ({ path: 'theme', namespace: 'io' }));
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'io' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'io' }, args => ({ contents: boundaries[args.path], loader: 'tsx', resolveDir: process.cwd() }));
  } }] });
  compiled = bundle.outputFiles[0].text;
});
after(() => {
  dom.window.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

type Api = typeof import('../src/features/scan/native_ocr') & typeof import('../src/features/scan/photo_platform') & {
  ScanCamera: typeof import('../src/features/scan/ScanCamera').ScanCamera;
  nativeProps: NativePropRecord[]; roleViolations: string[]; setProbePlatform: (value: string) => void;
};
const providerUri = 'content://synthetic.photos/selected';
const cacheUri = 'file:///data/user/0/com.teamjam.topictrail/cache';
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 0xff, 0xd9]);
const transcript: ScanTranscript = { text: 'English at Filipino', confidence: null, truncated: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const rows = new Map<string, { size: number; bytes?: Uint8Array }>([[providerUri, { size: jpeg.length, bytes: jpeg }]]);
  const state = { sourceSize: jpeg.length, reportedSize: jpeg.length as number | undefined, sourceUri: providerUri,
    pickerCancelled: false, denyRead: false, denyWrite: false, handles: 0, writes: 0, reads: 0, normalizations: 0,
    cameraIds: [] as string[], cancelCameraIds: [] as string[], cancelOcrIds: [] as string[], released: [] as string[],
    deleted: [] as string[], pickerOptions: null as unknown, cancelThrows: false, normalizationFails: false };
  const captures: ReturnType<typeof deferred<ScanPhoto | null>>[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let serial = 0;
  const photo = () => {
    const value = { uri: cacheUri + '/topictrail-scan-previews-v1/scan-00000000-0000-0000-0000-' + String(++serial).padStart(12, '0') + '.jpg', width: 1200, height: 1600 };
    rows.set(value.uri, { size: jpeg.length, bytes: jpeg });
    return value;
  };
  const module = {
    version: 1, engine: 'mlkit-16.0.1-latin-1', bundledLatin: true,
    async normalizePhoto(uri: string, rotate: boolean) {
      state.normalizations++;
      if (state.normalizationFails) throw Error('private-provider-error');
      assert.ok(rows.has(uri)); assert.equal(state.handles, 0, 'close staging handles before native decoding');
      const result = photo();
      return rotate ? { ...result, width: 1600, height: 1200 } : result;
    },
    capturePhoto(id: string) { state.cameraIds.push(id); const item = deferred<ScanPhoto | null>(); captures.push(item); return item.promise; },
    cancelCapture(id: string) { state.cancelCameraIds.push(id); if (state.cancelThrows) throw Error('disposed context'); },
    releasePhoto(uri: string) { state.released.push(uri); rows.delete(uri); },
    async previewByteLength(uri: string) {
      const root = cacheUri + '/topictrail-scan-previews-v1/';
      if (!uri.startsWith(root) || !/^scan-[a-f0-9-]{36}\.jpg$/.test(uri.slice(root.length)) || !rows.has(uri)) {
        throw Error('private native path');
      }
      return rows.get(uri)!.size;
    },
    recognizePhoto: async () => transcript,
    recognizePdf: async () => transcript,
    cancelOcr(id: string) { state.cancelOcrIds.push(id); if (state.cancelThrows) throw Error('disposed context'); },
  };
  const uriOf = (parts: (string | { uri: string })[]) => parts.map(part => (typeof part === 'string' ? part : part.uri).replace(/\/$/, '')).join('/');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) { this.uri = uriOf(parts); }
    create() {}
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) { this.uri = uriOf(parts); }
    get exists() { return rows.has(this.uri); }
    get size() { return rows.get(this.uri)?.size ?? 0; }
    get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/'))); }
    create() { assert.equal(rows.has(this.uri), false); rows.set(this.uri, { size: 0 }); }
    delete() { assert.notEqual(this.uri, providerUri); state.deleted.push(this.uri); rows.delete(this.uri); }
    open(mode: string) {
      if (this.uri === providerUri) assert.equal(mode, 'r');
      state.handles++;
      let offset = 0, closed = false;
      const uri = this.uri;
      return {
        async readBytes(length: number) {
          assert.equal(mode, 'r'); assert.equal(closed, false); state.reads++;
          if (state.denyRead) throw Error('secret-provider-uri');
          const row = rows.get(uri)!;
          const size = uri === providerUri ? state.sourceSize : row.size;
          const count = Math.max(0, Math.min(length, size - offset));
          const bytes = row.bytes && row.bytes.length === size ? row.bytes.slice(offset, offset + count) : new Uint8Array(count);
          offset += count;
          return bytes;
        },
        async writeBytes(bytes: Uint8Array) {
          assert.equal(mode, 'w'); assert.equal(closed, false);
          if (state.denyWrite) throw Error('secret-provider-uri');
          state.writes += bytes.length;
          rows.get(uri)!.size += bytes.length;
        },
        close() { assert.equal(closed, false); closed = true; state.handles--; },
      };
    }
  }
  const io = { File, Directory, Paths: { cache: { uri: cacheUri } }, modules: { TopicTrailOcr: module as object | undefined },
    choose: async (options: unknown) => {
      state.pickerOptions = options;
      return state.pickerCancelled ? { canceled: true, assets: null } : { canceled: false, assets: [{ uri: state.sourceUri, size: state.reportedSize }] };
    } };
  let timerId = 0;
  const result = { exports: {} };
  new Function('require', 'module', 'exports', 'io', 'setTimeout', 'clearTimeout', compiled)(createRequire(resolve('package.json')), result, result.exports, io,
    (callback: () => void, ms: number) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; }, (id: number) => timers.delete(id));
  const api = result.exports as Api;
  api.setProbePlatform('android');
  return { api, module, io, state, rows, photo, captures, timers };
}

test('Android release R8 preserves the no-argument constructors used by ML Kit component discovery', async () => {
  const { readFile } = await import('node:fs/promises');
  const gradle = await readFile(resolve('android/app/build.gradle'), 'utf8');
  const rules = (await readFile(resolve('android/app/proguard-rules.pro'), 'utf8')).replace(/#.*$/gm, '');
  assert.match(gradle, /release\s*\{[^}]*proguardFiles[^\n]*['"]proguard-rules\.pro['"]/);
  const registrars = [
    'com.google.mlkit.common.internal.CommonComponentRegistrar',
    'com.google.mlkit.vision.common.internal.VisionCommonRegistrar',
    'com.google.mlkit.vision.text.internal.TextRegistrar',
  ];
  for (const name of registrars) {
    const rule = new RegExp('-keep\\s+class\\s+' + name.replaceAll('.', '\\.') + '\\s*\\{\\s*public\\s+<init>\\(\\)\\s*;\\s*\\}');
    assert.match(rules, rule, 'Missing reflective public no-argument constructor for ' + name);
  }
});

test('native OCR capability fails closed for Expo Go, other platforms, wrong engine and incomplete bridges', () => {
  const h = harness();
  assert.equal(h.api.nativeOcr(), h.module);
  h.api.setProbePlatform('ios'); assert.throws(() => h.api.nativeOcr(), /updated Android build/);
  h.api.setProbePlatform('android');
  for (const value of [undefined, { ...h.module, bundledLatin: false }, { ...h.module, engine: 'downloadable' }, { ...h.module, capturePhoto: undefined }]) {
    h.io.modules.TopicTrailOcr = value; assert.throws(() => h.api.nativeOcr(), /does not include/);
  }
});

test('already aborted page recognition never reaches native and a late prior-page result cannot publish', async () => {
  const h = harness(), before = new AbortController(); before.abort();
  let calls = 0;
  await assert.rejects(h.api.runNativeOcr(before.signal, async () => { calls++; return transcript; }), /cancelled/);
  assert.equal(calls, 0);
  const job = deferred<ScanTranscript>(), controller = new AbortController();
  let id = '';
  const pending = h.api.runNativeOcr(controller.signal, (_, request) => { id = request; return job.promise; });
  const rejected = assert.rejects(pending, /cancelled/);
  controller.abort(); await rejected;
  assert.deepEqual(h.state.cancelOcrIds, [id]); assert.equal(h.timers.size, 0);
  job.resolve(transcript); await job.promise; await Promise.resolve();
  assert.equal(h.timers.size, 0);
});

test('deadline and failing cancellation still settle once, clear listeners/timer, and fence late OCR', async () => {
  const h = harness(); h.state.cancelThrows = true;
  const job = deferred<ScanTranscript>(), controller = new AbortController();
  const pending = h.api.runNativeOcr(controller.signal, () => job.promise);
  const rejected = assert.rejects(pending, /too long/);
  assert.equal(h.timers.size, 1);
  const timer = [...h.timers.values()][0]; assert.equal(timer.ms, 120_000); timer.callback();
  await rejected; assert.equal(h.timers.size, 0);
  controller.abort(); assert.equal(h.state.cancelOcrIds.length, 1);
  job.resolve(transcript); await job.promise;
});

test('synchronous bridge failure is sanitized and removes its OCR deadline', async () => {
  const h = harness();
  await assert.rejects(h.api.runNativeOcr(new AbortController().signal, () => { throw Error('private-document-name'); }), /^Error: Recognition could not finish/);
  assert.equal(h.timers.size, 0); assert.equal(h.state.cancelOcrIds.length, 1);
});

test('native recognition maps fixed stage codes without exposing native details', async () => {
  const h = harness();
  const cases = [
    ['OCR_BUSY', /still being recognized/], ['OCR_CANCELLED', /cancelled/], ['OCR_TIMEOUT', /too long/],
    ['OCR_PREVIEW', /Choose the photo again/], ['OCR_PDF_INPUT', /PDF page could not be opened/],
    ['OCR_MEMORY', /not enough memory/], ['OCR_ENGINE_INIT', /recognizer is unavailable/],
    ['OCR_ENGINE_UNAVAILABLE', /recognizer is unavailable/], ['OCR_ENGINE_PROCESS', /could not process/],
    ['UNKNOWN_CODE', /Recognition could not finish/],
  ] as const;
  for (const [code, message] of cases) {
    const nativeError = Object.assign(new Error('private filename or provider message'), { code });
    await assert.rejects(h.api.runNativeOcr(new AbortController().signal, async () => { throw nativeError; }),
      (error: Error) => message.test(error.message) && !error.message.includes('private'));
    assert.equal(h.timers.size, 0);
  }
});

test('native transcript validation rejects fabricated confidence/oversize output and preserves literal valid text', async () => {
  const h = harness();
  for (const value of [{ ...transcript, confidence: 0.9 }, { ...transcript, text: 'x'.repeat(50001) }, { ...transcript, truncated: undefined }]) {
    await assert.rejects(h.api.runNativeOcr(new AbortController().signal, async () => value as ScanTranscript), /unreadable/);
  }
  const literal = { text: '<b>aaral</b>\n', confidence: null, truncated: true };
  assert.deepEqual(await h.api.runNativeOcr(new AbortController().signal, async () => literal), literal);
  assert.equal(h.timers.size, 0);
});

test('cancelled camera requests release late scratch and cannot cancel a newer capture', async () => {
  const h = harness(), old = new AbortController(), next = new AbortController();
  const first = h.api.captureNativePhoto(old.signal);
  old.abort(); assert.equal(await first, null);
  const second = h.api.captureNativePhoto(next.signal);
  assert.notEqual(h.state.cameraIds[0], h.state.cameraIds[1]);
  const stale = h.photo(); h.captures[0].resolve(stale); await h.captures[0].promise; await Promise.resolve();
  assert.deepEqual(h.state.released, [stale.uri]); assert.deepEqual(h.state.cancelCameraIds, [h.state.cameraIds[0]]);
  const current = h.photo(); h.captures[1].resolve(current);
  assert.deepEqual(await second, current); next.abort();
  assert.equal(h.state.cancelCameraIds.length, 1);
});

test('camera cancellation tolerates teardown; unreadable/oversized native previews are rejected and released', async () => {
  const h = harness(), controller = new AbortController(); h.state.cancelThrows = true;
  const first = h.api.captureNativePhoto(controller.signal); controller.abort(); assert.equal(await first, null);
  for (const invalid of [{ ...h.photo(), width: 8193 }, { ...h.photo(), width: 2500, height: 2500 }, { ...h.photo(), height: 1.5 }]) {
    const pending = h.api.captureNativePhoto(new AbortController().signal);
    h.captures.at(-1)!.resolve(invalid);
    await assert.rejects(pending, /Choose a photo instead/);
    assert.ok(h.state.released.includes(invalid.uri));
  }
});

test('native choose stages read-only original, closes both handles, and deletes scratch after normalization', async () => {
  const h = harness();
  const result = await h.api.choosePhoto(); assert.ok(result);
  assert.deepEqual(h.state.pickerOptions, { type: ['image/jpeg', 'image/png'], copyToCacheDirectory: false, multiple: false });
  assert.equal(h.state.writes, jpeg.length); assert.equal(h.state.handles, 0); assert.equal(h.state.normalizations, 1);
  assert.equal(h.state.deleted.length, 1); assert.ok(h.rows.has(providerUri));
  assert.deepEqual(h.rows.get(providerUri)!.bytes, jpeg);
  assert.ok([...h.rows.keys()].every(uri => !uri.includes('topictrail-photo-input-v1')));
});

test('unknown/misreported input size cannot copy more than 50 MiB or publish a preview', async () => {
  const h = harness(); h.state.sourceSize = 50 * 1024 * 1024 + 100; h.state.reportedSize = undefined;
  await assert.rejects(h.api.choosePhoto(), /50 MiB/);
  assert.equal(h.state.writes, 50 * 1024 * 1024); assert.equal(h.state.normalizations, 0); assert.equal(h.state.handles, 0);
  assert.equal(h.rows.size, 1); assert.ok(h.rows.has(providerUri));
});

test('picker cancel, invalid URI, unreadable input, full disk and native failure preserve originals and clear scratch', async () => {
  for (const condition of ['cancel', 'uri', 'empty', 'read', 'write', 'normalize'] as const) {
    const h = harness();
    if (condition === 'cancel') h.state.pickerCancelled = true;
    if (condition === 'uri') h.state.sourceUri = 'https://private.example/image.jpg';
    if (condition === 'empty') h.state.sourceSize = 0;
    if (condition === 'read') h.state.denyRead = true;
    if (condition === 'write') h.state.denyWrite = true;
    if (condition === 'normalize') h.state.normalizationFails = true;
    if (condition === 'cancel') assert.equal(await h.api.choosePhoto(), null);
    else await assert.rejects(h.api.choosePhoto(), /^Error: Choose a readable JPG or PNG/);
    assert.equal(h.state.handles, 0); assert.equal(h.rows.size, 1); assert.ok(h.rows.has(providerUri));
  }
});

test('photo byte reads require private normalized JPEG and enforce 16 MiB before returning bytes', async () => {
  const h = harness(), photo = h.photo();
  assert.deepEqual(await h.api.photoBytes(photo), jpeg); assert.equal(h.state.handles, 0);
  const reads = h.state.reads;
  h.rows.get(photo.uri)!.size = 16 * 1024 * 1024 + 1;
  await assert.rejects(h.api.photoBytes(photo), /unavailable/); assert.equal(h.state.reads, reads);
  await assert.rejects(h.api.photoBytes({ ...photo, uri: providerUri }), /unreadable/);
  h.rows.get(photo.uri)!.size = 4; h.rows.get(photo.uri)!.bytes = new Uint8Array([1, 2, 3, 4]);
  await assert.rejects(h.api.photoBytes(photo), /unreadable/); assert.equal(h.state.handles, 0);
  const other = { ...photo, uri: photo.uri.replace('/com.teamjam.topictrail/', '/other.app/') };
  h.rows.set(other.uri, { size: jpeg.length, bytes: jpeg });
  await assert.rejects(h.api.photoBytes(other), /unavailable/);
});

test('saving accepts an owned preview when Expo exposes the same Android cache through an alias', async () => {
  const h = harness(), photo = h.photo();
  h.io.Paths.cache.uri = h.io.Paths.cache.uri.replace('/data/user/0/', '/data/data/');
  assert.deepEqual(await h.api.photoBytes(photo), jpeg);
  assert.equal(h.state.handles, 0);
  const reads = h.state.reads;
  const swapped = { ...photo, uri: photo.uri.replace('/cache/', '/cache/../cache/') };
  await assert.rejects(h.api.photoBytes(swapped), /unavailable/);
  assert.equal(h.state.reads, reads);
  h.module.previewByteLength = async () => jpeg.length + 1;
  await assert.rejects(h.api.photoBytes(photo), /unreadable/);
  assert.equal(h.state.handles, 0);
});

test('rotation preserves the old preview for its caller to release and cleanup tolerates a missing module', async () => {
  const h = harness(), before = h.photo();
  const rotated = await h.api.rotatePhoto(before);
  assert.equal(rotated.width, before.height); assert.equal(rotated.height, before.width);
  assert.notEqual(rotated.uri, before.uri); assert.ok(h.rows.has(before.uri));
  h.api.releasePhoto(before); assert.equal(h.rows.has(before.uri), false);
  h.io.modules.TopicTrailOcr = undefined;
  assert.doesNotThrow(() => h.api.releasePhoto(rotated));
});

async function mountCamera(h: ReturnType<typeof harness>, props: React.ComponentProps<Api['ScanCamera']>) {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.querySelector('main')!);
  const render = async (value: React.ComponentProps<Api['ScanCamera']>) => {
    await act(async () => root.render(React.createElement(React.StrictMode, {}, React.createElement(h.api.ScanCamera, value))));
  };
  await render(props);
  return { render, unmount: () => act(async () => root.unmount()), press: async (name: string) => {
    const button = dom.window.document.querySelector<HTMLElement>(`[aria-label="${name}"]`);
    assert.ok(button, name); await act(async () => button.click());
  } };
}
test('native camera mounts closed, exposes optional label/busy/button semantics, and publishes only an explicit capture', async () => {
  const h = harness(), received: ScanPhoto[] = [], active: boolean[] = [];
  const props = { onPhoto: (photo: ScanPhoto) => received.push(photo), onError: (message: string) => assert.fail(message), onActiveChange: (value: boolean) => active.push(value) };
  const view = await mountCamera(h, props);
  try {
    assert.equal(h.captures.length, 0);
    await view.render({ ...props, label: 'Retake', disabled: true });
    await view.press('Retake'); assert.equal(h.captures.length, 0);
    await view.render({ ...props, label: 'Retake' });
    await view.press('Retake'); assert.equal(h.captures.length, 1);
    const button = h.api.nativeProps.filter(value => value.accessibilityLabel === 'Retake').at(-1)!;
    assert.equal(button.accessibilityRole, 'button'); assert.equal(button.accessibilityState?.busy, true); assert.equal(button.accessibilityState?.disabled, true);
    assert.match(button.accessibilityHint!, /Review/);
    const photo = h.photo(); await act(async () => { h.captures[0].resolve(photo); });
    assert.deepEqual(received, [photo]); assert.deepEqual(active, [true, false]); assert.deepEqual(h.api.roleViolations, []);
  } finally { await view.unmount(); }
});

test('native camera unmount cancels its request and releases a late full-size preview without callback', async () => {
  const h = harness(), active: boolean[] = [];
  const view = await mountCamera(h, { onPhoto: () => assert.fail('late photo'), onError: () => assert.fail('late error'), onActiveChange: value => active.push(value) });
  await view.press('Take photo'); await view.unmount();
  assert.deepEqual(h.state.cancelCameraIds, h.state.cameraIds); assert.deepEqual(active, [true, false]);
  const late = h.photo(); await act(async () => { h.captures[0].resolve(late); });
  assert.deepEqual(h.state.released, [late.uri]);
});

test('native camera cancel and denial leave the button reusable and offer choose-photo recovery', async () => {
  const h = harness(), errors: string[] = [];
  const view = await mountCamera(h, { onPhoto: () => assert.fail('cancelled photo'), onError: message => errors.push(message) });
  try {
    await view.press('Take photo'); await view.press('Cancel camera');
    assert.equal(h.state.cancelCameraIds.length, 1); assert.match(dom.window.document.body.textContent!, /choose a photo/);
    await view.press('Take photo');
    await act(async () => { h.captures[1].reject(Error('private-system-path')); });
    assert.equal(errors.length, 1); assert.match(errors[0], /Choose a photo instead/); assert.doesNotMatch(errors[0], /private/);
    const button = h.api.nativeProps.filter(value => value.accessibilityLabel === 'Take photo').at(-1)!;
    assert.equal(button.accessibilityState?.disabled, false);
  } finally { await view.unmount(); }
});
