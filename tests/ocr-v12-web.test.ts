import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { boundedPhotoSize, inspectPhotoImage, photoOrientationTransform, strippedPhotoJpeg } from '../src/features/scan/photo_image';
import { abortablePhoto } from '../src/features/scan/photo_abort';
import { browserPhotoBytes, normalizeBrowserPhoto, releaseBrowserPhoto, rotateBrowserPhoto } from '../src/features/scan/browser_photo';
import { bindCameraPageLifetime, createBrowserCamera } from '../src/features/scan/browser_camera';
import { pickBrowserPhotoFile } from '../src/features/scan/browser_photo_picker';
import { createPhotoOcrLoader, recognizeBrowserPhoto } from '../src/features/scan/browser_photo_ocr';
import type { ScanPhoto } from '../src/features/scan/photo_contract';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function concat(...parts: Uint8Array[]) { return new Uint8Array(Buffer.concat(parts)); }
function segment(marker: number, content: Uint8Array) { return concat(Uint8Array.of(255, marker, (content.length + 2) >> 8, (content.length + 2) & 255), content); }
function exif(orientation: number, little = true) {
  const bytes = new Uint8Array(26), view = new DataView(bytes.buffer);
  bytes.set(little ? [73, 73] : [77, 77]);
  view.setUint16(2, 42, little); view.setUint32(4, 8, little); view.setUint16(8, 1, little);
  view.setUint16(10, 0x112, little); view.setUint16(12, 3, little); view.setUint32(14, 1, little); view.setUint16(18, orientation, little);
  return bytes;
}
// Structural fixtures: actual decoding is separately qualified in Brave. These exercise preflight and lifetime boundaries.
function jpeg(width = 800, height = 600, orientation?: number, little = true) {
  return concat(Uint8Array.of(255, 216), orientation === undefined ? new Uint8Array() : segment(0xe1, concat(new TextEncoder().encode('Exif\0\0'), exif(orientation, little))),
    segment(0xc0, Uint8Array.of(8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1)),
    segment(0xda, Uint8Array.of(3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0)), Uint8Array.of(1, 2, 255, 0, 3, 255, 217));
}
function pngChunk(kind: string, bytes: Uint8Array) {
  const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, bytes.length);
  return concat(length, new TextEncoder().encode(kind), bytes, new Uint8Array(4));
}
function png(width = 400, height = 300, orientation?: number, extra?: Uint8Array) {
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header.set([8, 6, 0, 0, 0], 8);
  return concat(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk('IHDR', header),
    orientation === undefined ? new Uint8Array() : pngChunk('eXIf', exif(orientation)), extra ?? new Uint8Array(),
    pngChunk('IDAT', Uint8Array.of(1)), pngChunk('IEND', new Uint8Array()));
}

test('photo preflight trusts signatures, rejects truncation/unsupported content and bounds dimensions before decode', () => {
  assert.equal(inspectPhotoImage(jpeg()).mime, 'image/jpeg');
  assert.equal(inspectPhotoImage(png()).mime, 'image/png');
  for (const bytes of [new TextEncoder().encode('<svg/>'), Uint8Array.of(255, 216), jpeg().slice(0, -1), png().slice(0, -1), png(0, 100), png(100_000, 1), png(9000, 9000)]) {
    assert.throws(() => inspectPhotoImage(bytes), /photo|JPG|PNG|pixels/);
  }
  const bad = jpeg(); bad[4] = 0xff; bad[5] = 0xff;
  assert.throws(() => inspectPhotoImage(bad), /JPG/);
  assert.throws(() => inspectPhotoImage(new Uint8Array(50 * 1024 * 1024 + 1)), /50 MiB/);
});

test('all JPEG EXIF orientations/endian forms and PNG eXIf are read once and stripped from decoder bytes', () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    for (const little of [false, true]) {
      const source = jpeg(600, 800, orientation, little), before = source.slice(), result = inspectPhotoImage(source);
      assert.equal(result.orientation, orientation); assert.equal(inspectPhotoImage(result.bytes).orientation, 1);
      assert.deepEqual(source, before);
    }
    const result = inspectPhotoImage(png(600, 800, orientation));
    assert.equal(result.orientation, orientation); assert.equal(inspectPhotoImage(result.bytes).orientation, 1);
  }
});

test('malformed/out-of-bounds EXIF, animated PNG and broken chunk lengths fail closed', () => {
  assert.throws(() => inspectPhotoImage(jpeg(800, 600, 9)), /JPG/);
  const source = jpeg(800, 600, 6); source.set([255, 255, 255, 255], 16);
  assert.throws(() => inspectPhotoImage(source), /JPG/);
  assert.throws(() => inspectPhotoImage(png(400, 300, undefined, pngChunk('acTL', new Uint8Array(8)))), /still/);
  const broken = png(); new DataView(broken.buffer).setUint32(8, 0xffffffff);
  assert.throws(() => inspectPhotoImage(broken), /JPG/);
});

test('JPEG scan parsing strips late metadata and normalized output removes APP/comments', () => {
  const source = jpeg(800, 600, 6);
  const late = concat(source.slice(0, -2), segment(0xfe, new TextEncoder().encode('private comment')), Uint8Array.of(255, 217));
  const clean = strippedPhotoJpeg(late, 800, 600);
  assert.equal(Buffer.from(clean).includes(Buffer.from('Exif')), false);
  assert.equal(Buffer.from(clean).includes(Buffer.from('private comment')), false);
  assert.throws(() => strippedPhotoJpeg(source, 600, 800), /JPG/);
});

test('orientation transforms preserve every corner, mirror handedness and bounded output pixels/edges', () => {
  const w = 600, h = 800;
  const topLeft = [[0, 0], [w, 0], [w, h], [0, h], [0, 0], [h, 0], [h, w], [0, w]];
  for (let orientation = 1; orientation <= 8; orientation++) {
    const [a, b, c, d, e, f] = photoOrientationTransform(orientation, w, h);
    assert.deepEqual([e, f], topLeft[orientation - 1]);
    const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    assert.equal(Math.max(...corners.map(point => point[0])), orientation >= 5 ? h : w);
    assert.equal(Math.max(...corners.map(point => point[1])), orientation >= 5 ? w : h);
    assert.equal(a * d - b * c, [2, 4, 5, 7].includes(orientation) ? -1 : 1);
  }
  for (const [width, height] of [[8000, 8000], [16384, 1], [6000, 4000], [1, 16384], [32, 32]]) {
    const out = boundedPhotoSize(width, height);
    assert.ok(out.width * out.height <= 4_000_000 && out.width <= 8192 && out.height <= 8192);
  }
});

function withPhotoRuntime() {
  const originals = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), bitmap: Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap') };
  const canvases: { width: number; height: number; transforms: number[][]; draws: number; toBlob: (callback: BlobCallback) => void }[] = [];
  const bitmaps: { closed: boolean; width: number; height: number; close(): void }[] = [];
  const decodeInputs: { blob: Blob; options?: ImageBitmapOptions }[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(kind: string) {
    assert.equal(kind, 'canvas');
    const canvas = { width: 0, height: 0, transforms: [] as number[][], draws: 0,
      getContext: () => ({ fillStyle: '', fillRect() {}, setTransform: (...values: number[]) => canvas.transforms.push(values), drawImage: () => { canvas.draws++; } }),
      toBlob(callback: BlobCallback) { callback(new Blob([jpeg(canvas.width, canvas.height, 1)], { type: 'image/jpeg' })); } };
    canvases.push(canvas); return canvas;
  } } });
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: async (blob: Blob, options?: ImageBitmapOptions) => {
    decodeInputs.push({ blob, options });
    const bitmap = { closed: false, width: options!.resizeWidth!, height: options!.resizeHeight!, close() { this.closed = true; } };
    bitmaps.push(bitmap); return bitmap;
  } });
  return { canvases, bitmaps, decodeInputs, restore() {
    if (originals.document) Object.defineProperty(globalThis, 'document', originals.document); else Reflect.deleteProperty(globalThis, 'document');
    if (originals.bitmap) Object.defineProperty(globalThis, 'createImageBitmap', originals.bitmap); else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  } };
}

test('normalization validates before decoding, flattens/rotates once and releases bitmap/canvas/private URL', async () => {
  const runtime = withPhotoRuntime();
  let photo: ScanPhoto | undefined;
  try {
    await assert.rejects(normalizeBrowserPhoto(new Blob([png(100_000, 1)])), /pixels/);
    assert.equal(runtime.decodeInputs.length, 0);
    const original = jpeg(600, 800, 6);
    photo = await normalizeBrowserPhoto(new Blob([original], { type: 'text/plain' }));
    assert.deepEqual({ width: photo.width, height: photo.height }, { width: 800, height: 600 });
    assert.equal(inspectPhotoImage(new Uint8Array(await runtime.decodeInputs[0].blob.arrayBuffer())).orientation, 1);
    assert.deepEqual(runtime.canvases[0].transforms[0], [0, 1, -1, 0, 800, 0]);
    assert.equal(runtime.bitmaps[0].closed, true); assert.equal(runtime.canvases[0].width, 0);
    const bytes = await browserPhotoBytes(photo); assert.equal(Buffer.from(bytes).includes(Buffer.from('Exif')), false);
    releaseBrowserPhoto(photo); releaseBrowserPhoto(photo);
    await assert.rejects(browserPhotoBytes(photo), /expired/);
  } finally { if (photo) releaseBrowserPhoto(photo); runtime.restore(); }
});

test('rotation creates a new owned preview and preserves the original until explicitly released', async () => {
  const runtime = withPhotoRuntime(); let original: ScanPhoto | undefined, rotated: ScanPhoto | undefined;
  try {
    original = await normalizeBrowserPhoto(new Blob([jpeg()]));
    const bytes = await browserPhotoBytes(original);
    rotated = await rotateBrowserPhoto(original);
    assert.notEqual(rotated.uri, original.uri); assert.equal(rotated.width, original.height); assert.equal(rotated.height, original.width);
    assert.deepEqual(await browserPhotoBytes(original), bytes);
    await assert.rejects(browserPhotoBytes({ ...original, uri: 'https://example.org/private.jpg' }), /expired/);
  } finally { if (original) releaseBrowserPhoto(original); if (rotated) releaseBrowserPhoto(rotated); runtime.restore(); }
});

test('cancel during decode rejects promptly and closes the late bitmap without allocating a canvas/URL', async () => {
  const runtime = withPhotoRuntime(), late = deferred<ImageBitmap>(), entered = deferred<void>(), controller = new AbortController();
  let closed = false;
  globalThis.createImageBitmap = (() => { entered.resolve(); return late.promise; }) as typeof createImageBitmap;
  try {
    const operation = normalizeBrowserPhoto(new Blob([jpeg()]), controller.signal);
    await entered.promise; controller.abort(); await assert.rejects(operation, { name: 'AbortError' });
    late.resolve({ width: 800, height: 600, close() { closed = true; } } as ImageBitmap);
    await Promise.resolve(); assert.equal(closed, true); assert.equal(runtime.canvases.length, 0);
  } finally { runtime.restore(); }
});

test('cancel during JPEG encoding clears canvas and ignores late encoding callback', async () => {
  const runtime = withPhotoRuntime(), entered = deferred<void>(), controller = new AbortController();
  let complete!: BlobCallback;
  const create = document.createElement.bind(document);
  document.createElement = ((kind: string) => { const canvas = create(kind) as HTMLCanvasElement; canvas.toBlob = callback => { complete = callback; entered.resolve(); }; return canvas; }) as typeof document.createElement;
  try {
    const pending = normalizeBrowserPhoto(new Blob([jpeg()]), controller.signal);
    await entered.promise; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    complete(new Blob([jpeg()])); await Promise.resolve();
    assert.equal(runtime.canvases[0].width, 0); assert.equal(runtime.bitmaps[0].closed, true);
  } finally { runtime.restore(); }
});

test('decoder dimension mismatch closes the bitmap before any output allocation', async () => {
  const runtime = withPhotoRuntime(); let closed = false;
  globalThis.createImageBitmap = (async () => ({ width: 99999, height: 99999, close() { closed = true; } })) as typeof createImageBitmap;
  try { await assert.rejects(normalizeBrowserPhoto(new Blob([jpeg()])), /safely resize/); assert.equal(closed, true); assert.equal(runtime.canvases.length, 0); }
  finally { runtime.restore(); }
});

class Track extends EventTarget { kind = 'video'; readyState = 'live'; stops = 0; stop() { this.stops++; this.readyState = 'ended'; } }
function cameraFixture() {
  const track = new Track(), stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
  const video = Object.assign(new EventTarget(), { readyState: 2, videoWidth: 800, videoHeight: 600, srcObject: null, muted: false, playsInline: false, play: async () => {}, pause() {} }) as unknown as HTMLVideoElement;
  const states: string[] = [], active: boolean[] = [], errors: string[] = [], photos: ScanPhoto[] = [];
  return { track, stream, video, states, active, errors, photos,
    options: { video: () => video, secure: () => true, visible: () => true, onState: (state: string) => states.push(state),
      onPhoto: (photo: ScanPhoto) => photos.push(photo), onError: (error: string) => errors.push(error), onActiveChange: (value: boolean) => active.push(value) } };
}

test('camera creation is passive, explicit open is video-only, duplicate open and close release every track', async () => {
  const fixture = cameraFixture(); let calls = 0;
  const camera = createBrowserCamera({ ...fixture.options, getMedia: async constraints => { calls++; assert.equal(constraints.audio, false); assert.ok(constraints.video); return fixture.stream; } });
  assert.equal(calls, 0);
  await Promise.all([camera.open(), camera.open()]); assert.equal(calls, 1); assert.equal(fixture.video.srcObject, fixture.stream);
  camera.close(); camera.close(); assert.equal(fixture.track.stops, 1); assert.equal(fixture.video.srcObject, null);
  assert.deepEqual(fixture.active, [true, false]); assert.deepEqual(fixture.photos, []); camera.dispose();
});

test('insecure camera context and permission denial preserve a usable photo-choice error', async () => {
  const fixture = cameraFixture(); let calls = 0;
  const insecure = createBrowserCamera({ ...fixture.options, secure: () => false, getMedia: async () => { calls++; return fixture.stream; } });
  await insecure.open(); assert.equal(calls, 0); assert.match(fixture.errors[0], /HTTPS or localhost/); insecure.dispose();
  const denied = createBrowserCamera({ ...fixture.options, getMedia: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
  await denied.open(); assert.match(fixture.errors[1], /still choose a photo/); assert.equal(fixture.active.at(-1), false); denied.dispose();
});

test('close/unmount while permission is pending stops a late stream and cannot publish a preview', async () => {
  for (const dispose of [false, true]) {
    const fixture = cameraFixture(), permission = deferred<MediaStream>();
    const camera = createBrowserCamera({ ...fixture.options, getMedia: () => permission.promise });
    const pending = camera.open(); if (dispose) camera.dispose(); else camera.close(); await pending;
    permission.resolve(fixture.stream); await Promise.resolve();
    assert.equal(fixture.track.stops, 1); assert.equal(fixture.video.srcObject, null); assert.equal(fixture.states.includes('ready'), false); assert.deepEqual(fixture.errors, []); camera.dispose();
  }
});

test('camera capture stops tracks before encoding, then emits exactly one photo for parent review', async () => {
  const fixture = cameraFixture(), encoded = deferred<ScanPhoto>();
  const photo = { uri: 'blob:fixture', width: 800, height: 600 };
  const camera = createBrowserCamera({ ...fixture.options, getMedia: async () => fixture.stream,
    captureFrame: async (_video, _signal, copied) => { copied(); assert.equal(fixture.track.stops, 1); return encoded.promise; } });
  await camera.open(); const pending = camera.capture(); await camera.capture();
  assert.equal(fixture.video.srcObject, null); assert.equal(fixture.track.stops, 1); assert.deepEqual(fixture.photos, []);
  encoded.resolve(photo); await pending; assert.deepEqual(fixture.photos, [photo]); assert.equal(fixture.active.at(-1), false); camera.dispose();
});

test('hide/unmount during capture releases a late photo and never emits stale parent state', async () => {
  const fixture = cameraFixture(), encoded = deferred<ScanPhoto>(), releasedDone = deferred<void>(), released: ScanPhoto[] = [];
  const photo = { uri: 'blob:late', width: 800, height: 600 };
  const camera = createBrowserCamera({ ...fixture.options, getMedia: async () => fixture.stream, releasePhoto: value => { released.push(value); releasedDone.resolve(); },
    captureFrame: async (_video, _signal, copied) => { copied(); return encoded.promise; } });
  await camera.open(); const pending = camera.capture(); camera.dispose(); await pending;
  encoded.resolve(photo); await releasedDone.promise; assert.deepEqual(released, [photo]); assert.deepEqual(fixture.photos, []);
});

test('visibility and pagehide stop camera; unbinding removes both handlers', async () => {
  const fixture = cameraFixture();
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' }); const host = new EventTarget();
  const camera = createBrowserCamera({ ...fixture.options, getMedia: async () => fixture.stream });
  const unbind = bindCameraPageLifetime(camera, page as unknown as Document, host as unknown as Window);
  await camera.open(); page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(fixture.track.stops, 1); assert.equal(fixture.active.at(-1), false);
  let closes = 0; const probe = bindCameraPageLifetime({ ...camera, close: () => { closes++; } }, page as unknown as Document, host as unknown as Window);
  host.dispatchEvent(new Event('pagehide')); assert.equal(closes, 1); probe(); unbind(); host.dispatchEvent(new Event('pagehide')); assert.equal(closes, 1); camera.dispose();
});

test('track-ended and video playback failure both close camera and preserve Choose photo fallback', async () => {
  const first = cameraFixture(), camera = createBrowserCamera({ ...first.options, getMedia: async () => first.stream });
  await camera.open(); first.track.dispatchEvent(new Event('ended')); assert.equal(first.track.stops, 1); assert.match(first.errors[0], /choose a photo/); camera.dispose();
  const second = cameraFixture(); second.video.play = async () => { throw new Error('play rejected'); };
  const other = createBrowserCamera({ ...second.options, getMedia: async () => second.stream });
  await other.open(); assert.equal(second.track.stops, 1); assert.equal(second.video.srcObject, null); assert.match(second.errors[0], /choose a photo/); other.dispose();
});

test('file picker removes input/listeners on selection, cancel, abort and page exit', async () => {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost' });
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  try {
    let pending = pickBrowserPhotoFile(); let input = document.querySelector('input')!;
    const file = new dom.window.File(['not decoded here'], 'photo.jpg'); Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new dom.window.Event('change')); assert.equal(await pending, file); assert.equal(document.querySelector('input'), null);
    pending = pickBrowserPhotoFile(); input = document.querySelector('input')!; input.dispatchEvent(new dom.window.Event('cancel'));
    assert.equal(await pending, null); assert.equal(document.querySelector('input'), null);
    const abort = new AbortController(); pending = pickBrowserPhotoFile(abort.signal); abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(document.querySelector('input'), null);
    pending = pickBrowserPhotoFile(); window.dispatchEvent(new dom.window.Event('pagehide')); assert.equal(await pending, null); assert.equal(document.querySelector('input'), null);
  } finally {
    dom.window.close(); if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

const syntheticSource = "'use strict';\nconst topicTrailWasm=0;\nconst topicTrailFilipino=0;";
test('bundled OCR preload is same-origin, credential-free, redirect-free and cached for offline use', async () => {
  let calls = 0;
  const load = createPhotoOcrLoader(() => '/assets/ocr-worker.txt', () => 'http://localhost:8081/scan', async (uri, options) => {
    calls++; assert.equal(uri, 'http://localhost:8081/assets/ocr-worker.txt'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
    return new Response(syntheticSource);
  });
  const values = await Promise.all([load(), load()]); assert.equal(calls, 1); assert.deepEqual(values, [syntheticSource, syntheticSource]);
  assert.equal(await load(), syntheticSource); assert.equal(calls, 1);
  await assert.rejects(createPhotoOcrLoader(() => 'https://cdn.example.org/ocr.js', () => 'http://localhost', async () => { calls++; return new Response(''); })(), /this application/);
  assert.equal(calls, 1);
});

test('failed worker preload is retryable and rejects oversized/malformed bundles', async () => {
  let calls = 0;
  const load = createPhotoOcrLoader(() => '/worker.txt', () => 'http://localhost', async () => ++calls === 1 ? new Response('missing', { status: 404 }) : new Response(syntheticSource));
  await assert.rejects(load(), /could not be loaded/); assert.equal(await load(), syntheticSource); assert.equal(calls, 2);
  await assert.rejects(createPhotoOcrLoader(() => '/worker.txt', () => 'http://localhost', async () => new Response('', { headers: { 'content-length': String(33 * 1024 * 1024) } }))(), /size limit/);
  await assert.rejects(createPhotoOcrLoader(() => '/worker.txt', () => 'http://localhost', async () => new Response('<html>fallback</html>'))(), /invalid/);
});

test('abortable resources are released even when already aborted before the result arrives', async () => {
  const controller = new AbortController(); controller.abort(); const late = deferred<string>(); const released: string[] = [];
  const pending = abortablePhoto(late.promise, controller.signal, value => released.push(value));
  await assert.rejects(pending, { name: 'AbortError' }); late.resolve('resource'); await Promise.resolve(); assert.deepEqual(released, ['resource']);
});

test('photo OCR cancellation while loading cannot create a bitmap or worker afterwards', async () => {
  const runtime = withPhotoRuntime(), controller = new AbortController(), source = deferred<string>();
  try {
    const pending = recognizeBrowserPhoto({ uri: 'blob:unused', width: 1, height: 1 }, controller.signal, () => source.promise);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); source.resolve(syntheticSource); await Promise.resolve();
    assert.equal(runtime.bitmaps.length, 0); assert.equal(runtime.canvases.length, 0);
  } finally { runtime.restore(); }
});

test('photo OCR returns bounded exact text/confidence and disposes worker/canvas after recognition or abort', async () => {
  const runtime = withPhotoRuntime(); const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  class FakeWorker {
    static instances: FakeWorker[] = []; static held = false;
    onmessage: ((event: MessageEvent) => void) | null = null; terminated = false;
    constructor() { FakeWorker.instances.push(this); }
    postMessage(packet: { action: string; jobId: string }) {
      if (FakeWorker.held) return;
      queueMicrotask(() => this.onmessage?.({ data: { ...packet, status: 'resolve', data: packet.action === 'recognize' ? { text: 'A'.repeat(49999) + '😀tail', confidence: 87 } : {} } } as MessageEvent));
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker }); let photo: ScanPhoto | undefined;
  try {
    photo = await normalizeBrowserPhoto(new Blob([jpeg()]));
    const result = await recognizeBrowserPhoto(photo, new AbortController().signal, async () => syntheticSource);
    assert.equal(result.text, 'A'.repeat(49999)); assert.equal(result.confidence, 87); assert.equal(result.truncated, true);
    assert.equal(FakeWorker.instances[0].terminated, true); assert.ok(runtime.canvases.every(canvas => canvas.width === 0));
    FakeWorker.held = true; const controller = new AbortController();
    const pending = recognizeBrowserPhoto(photo, controller.signal, async () => syntheticSource);
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(FakeWorker.instances[1].terminated, true); assert.ok(runtime.canvases.every(canvas => canvas.width === 0));
  } finally { if (photo) releaseBrowserPhoto(photo); runtime.restore(); if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor); else Reflect.deleteProperty(globalThis, 'Worker'); }
});
