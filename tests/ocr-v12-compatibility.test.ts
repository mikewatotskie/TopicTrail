import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { OcrCacheStore, type OcrCacheIO, type OcrCacheScope, type OcrCacheResult, type OcrEngine } from '../src/core/services/ocr_cache';
import type { TextAnchorV1 } from '../src/core/services/annotations/types';
import { canonicalSurface, captureTextAnchor, resolveTextAnchor } from '../src/features/reader/reader_anchors';
import { drawAnnotations, revealAnnotation } from '../src/features/reader/reader_overlays';
import { parseWebReaderEvent, validateCachedOcr, type ReaderAnnotation } from '../src/features/reader/reader_protocol';
import { parseReaderMessage } from '../src/features/reader/selection';
import { createScanPdf } from '../src/features/scan/photo_pdf';

const fixtures = new URL('./fixtures/ocr-v12/', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('spec.json', fixtures), 'utf8')) as {
  samples: { id: string; lines: string[]; studyPhrases: string[] }[];
  legacyV11: OcrCacheResult & { noteQuote: string };
};
const legacy: OcrCacheResult = { text: spec.legacyV11.text, confidence: spec.legacyV11.confidence, truncated: spec.legacyV11.truncated };
const legacyEngine = 'tesseract-7-eng-1';
const engines = ['tesseract-7-eng-fil-1', 'mlkit-16.0.1-latin-1'] as const;
const account = { project: 'abcdefghijklmnopqrst', uid: 'a0a0a0a0-0000-0000-0000-000000000001' };
const otherAccount = { ...account, uid: 'a0a0a0a0-0000-0000-0000-000000000002' };
const otherProject = { ...account, project: 'abcdefghijklmnopqrs1' };
const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const newResult: OcrCacheResult = { text: spec.samples[2].lines.join('\n'), confidence: null, truncated: false };

// Literal v11 persisted format: seed old bytes without using the new writer.
function cacheKey(scope: OcrCacheScope, doc = hash, page = 1, engine: OcrEngine = legacyEngine) {
  const owner = scope === 'guest' ? scope : `${scope.project}/${scope.uid}`;
  const language = engine === legacyEngine ? 'eng' : 'eng+fil';
  return `topictrail.ocr.v1/${engine}/${language}/${owner}/${doc}/${page}`;
}
function record(key: string, result: OcrCacheResult) { return JSON.stringify({ key, result }); }
function memory() {
  const stored = new Map<string, string>();
  const writes: string[] = [];
  const io: OcrCacheIO = {
    async getItem(key) { return stored.get(key) ?? null; },
    async setItem(key, value) { writes.push(key); stored.set(key, value); },
  };
  return { stored, writes, io };
}

for (const engine of engines) {
  test(`v11 upgrade preserves literal English transcript bytes, spacing and ñ for ${engine}`, async () => {
    const { io, stored, writes } = memory();
    const key = cacheKey(account);
    const raw = record(key, legacy);
    stored.set(key, raw);
    const cache = new OcrCacheStore(io, engine);
    assert.deepEqual(await cache.read(account, hash, 1), legacy);
    await cache.save(account, hash, 1, newResult);
    assert.deepEqual(await new OcrCacheStore(io, engine).read(account, hash, 1), legacy);
    assert.equal(stored.get(key), raw);
    assert.equal(stored.size, 1, 'a v12 result must not shadow the old note-bearing transcript');
    assert.deepEqual(writes, []);
  });

  test(`v11 empty and whitespace-only entries remain exact and immutable for ${engine}`, async () => {
    for (const text of ['', '  \n\n  \n']) {
      const { io, stored, writes } = memory();
      const key = cacheKey('guest');
      const old = { text, confidence: 0, truncated: false };
      const raw = record(key, old);
      stored.set(key, raw);
      const cache = new OcrCacheStore(io, engine);
      assert.deepEqual(await cache.read('guest', hash, 1), old);
      await cache.save('guest', hash, 1, newResult);
      assert.deepEqual(await cache.read('guest', hash, 1), old);
      assert.deepEqual([...stored], [[key, raw]]);
      assert.deepEqual(writes, []);
    }
  });

  test(`legacy corruption fails closed without a v12 fallback or write for ${engine}`, async () => {
    const key = cacheKey(account);
    for (const corrupt of [
      '{"broken', 'null', record(cacheKey(otherAccount), legacy),
      JSON.stringify({ key, result: { ...legacy, confidence: -1 } }),
      JSON.stringify({ key, result: { text: legacy.text, truncated: false } }),
      JSON.stringify({ key, result: { ...legacy, text: 'x'.repeat(50_001) } }),
    ]) {
      const { io, stored, writes } = memory();
      stored.set(key, corrupt);
      const newerKey = cacheKey(account, hash, 1, engine);
      stored.set(newerKey, record(newerKey, newResult));
      const before = [...stored];
      const cache = new OcrCacheStore(io, engine);
      await assert.rejects(cache.read(account, hash, 1), /stored OCR result/i);
      await assert.rejects(cache.save(account, hash, 1, newResult), /stored OCR result/i);
      await assert.rejects(new OcrCacheStore(io).save(account, hash, 1, legacy), /stored OCR result/i);
      assert.deepEqual([...stored], before, 'keep corrupt and newer entries for recovery');
      assert.deepEqual(writes, []);
    }
  });
}

test('engine/language, owner, project, document and page namespaces remain disjoint', async () => {
  const { io, stored } = memory();
  const scopes = [
    { scope: 'guest' as const, hash, page: 1 }, { scope: account, hash, page: 1 },
    { scope: otherAccount, hash, page: 1 }, { scope: otherProject, hash, page: 1 },
    { scope: account, hash: otherHash, page: 1 }, { scope: account, hash, page: 2 },
  ];
  for (const engine of engines) {
    const cache = new OcrCacheStore(io, engine);
    for (const [index, item] of scopes.entries()) {
      assert.equal(await cache.read(item.scope, item.hash, item.page), null);
      await cache.save(item.scope, item.hash, item.page, { ...newResult, text: `${engine}:${index}` });
    }
  }
  for (const engine of engines) {
    for (const [index, item] of scopes.entries()) {
      assert.equal((await new OcrCacheStore(io, engine).read(item.scope, item.hash, item.page))?.text, `${engine}:${index}`);
      assert.ok(stored.has(cacheKey(item.scope, item.hash, item.page, engine)), 'persisted language segment must be eng+fil');
      assert.equal(await new OcrCacheStore(io).read(item.scope, item.hash, item.page), null, 'English-only cache never consumes bilingual/native results');
    }
  }
  // A legacy value for another owner/document/page must not win the compatibility lookup.
  const foreign = cacheKey(otherAccount, otherHash, 9);
  stored.set(foreign, record(foreign, legacy));
  assert.equal((await new OcrCacheStore(io, engines[0]).read(account, hash, 1))?.text, `${engines[0]}:1`);
  assert.equal(stored.size, scopes.length * engines.length + 1);
});

test('current-engine transcript remains stable; a blank current-engine attempt can be retried', async () => {
  const { io, stored, writes } = memory();
  const cache = new OcrCacheStore(io, engines[0]);
  await cache.save('guest', hash, 1, { text: '', confidence: 0, truncated: false });
  await cache.save('guest', hash, 1, legacy);
  const before = [...stored];
  await cache.save('guest', hash, 1, newResult);
  assert.deepEqual([...stored], before);
  assert.deepEqual(await cache.read('guest', hash, 1), legacy);
  assert.equal(writes.length, 2);
});

test('owner/current fence rechecks after each asynchronous read before committing OCR', async () => {
  for (const loseAt of [0, 1, 2]) {
    let active = loseAt !== 0;
    let reads = 0;
    let writes = 0;
    const cache = new OcrCacheStore({
      async getItem() { if (++reads === loseAt) active = false; return null; },
      async setItem() { writes++; },
    }, engines[1]);
    await cache.save(account, hash, 1, newResult, () => active);
    assert.equal(writes, 0, `identity lost at read ${loseAt}`);
    assert.equal(reads, loseAt);
  }
});

test('native null confidence survives persistence and showOcr without inventing a percentage', async () => {
  const { io } = memory();
  const cache = new OcrCacheStore(io, engines[1]);
  await cache.save(account, hash, 1, newResult);
  const restored = await new OcrCacheStore(io, engines[1]).read(account, hash, 1);
  assert.deepEqual(restored, newResult);
  const command = { type: 'showOcr', page: 1, ...restored };
  assert.equal(validateCachedOcr(command), true);
  assert.equal(JSON.parse(JSON.stringify(command)).confidence, null);
  for (const confidence of [undefined, 'unknown', '0', false, NaN, Infinity, -1, 100.01]) {
    assert.equal(validateCachedOcr({ ...command, confidence }), false);
  }
  for (const confidence of [0, 91.25, 100]) assert.equal(validateCachedOcr({ ...command, confidence }), true);
  // Worker events have numeric confidence. Native OCR goes directly through showOcr above.
  assert.equal(parseReaderMessage(JSON.stringify({ type: 'ocr-result', page: 1, ...newResult })), null);
});

test('OCR worker job IDs survive parsing and reject malformed IDs and stale reader envelopes', () => {
  const messages = [
    { type: 'ocr-result', page: 1, ...legacy },
    { type: 'ocr-status', page: 1, state: 'running', progress: 0.4, message: 'Recognizing locally' },
  ];
  for (const message of messages) {
    assert.deepEqual(parseReaderMessage(JSON.stringify(message)), message, 'old event without jobId remains parseable');
    for (const jobId of ['scan-2', 'OCR-v12-ABC123', 'a'.repeat(100)]) {
      const event = { ...message, jobId };
      assert.deepEqual(parseReaderMessage(JSON.stringify(event)), event);
      const envelope = { protocol: 1, session: 'reader-session', generation: 3, renderToken: 9, message: event };
      assert.deepEqual(parseWebReaderEvent(envelope, 'reader-session', 3, 9), event);
      assert.equal(parseWebReaderEvent(envelope, 'old-session', 3, 9), null);
      assert.equal(parseWebReaderEvent(envelope, 'reader-session', 2, 9), null);
      assert.equal(parseWebReaderEvent(envelope, 'reader-session', 3, 8), null);
    }
    for (const jobId of ['', 'a'.repeat(101), null, 12, {}, ['scan-2'], '../scan', 'scan 2', 'scan\n', 'ñ']) {
      assert.equal(parseReaderMessage(JSON.stringify({ ...message, jobId })), null, JSON.stringify(jobId));
    }
  }
});

// Frozen v11 UTF-16 anchor; hashing follows the original version-1 canonical envelope.
const oldAnchor: TextAnchorV1 = {
  kind: 'text', version: 1, surface: 'ocr-text',
  textHash: '9996690f56f3eee7e526b17c9f8c076bbb12bf9d04fe6e1acfa6734074ffbb52',
  ranges: [{ blockId: 'ocr-page-text', startUtf16: 32, endUtf16: 97 }],
  quote: spec.legacyV11.noteQuote, prefix: legacy.text.slice(0, 32), suffix: legacy.text.slice(97),
};
function textRoot(text: string) {
  const dom = new JSDOM('<main><div data-annotation-block="ocr-page-text" data-annotation-surface="ocr-text"></div></main>');
  const root = dom.window.document.querySelector('main')!;
  const block = root.firstElementChild as HTMLElement;
  function setText(value: string) { block.textContent = value; block.dataset.annotationText = value; }
  setText(text);
  return { dom, root, block, setText };
}

test('frozen v11 note resolves to exact spaces/newlines/ñ and Study selection keeps that quote', async () => {
  const { io, stored } = memory();
  const key = cacheKey(account);
  stored.set(key, record(key, legacy));
  const restored = await new OcrCacheStore(io, engines[1]).read(account, hash, 1);
  assert.ok(restored);
  const { dom, root } = textRoot(restored.text);
  try {
    const model = canonicalSurface(root, 'ocr-text');
    assert.equal(model.textHash, oldAnchor.textHash);
    const ranges = resolveTextAnchor(model, oldAnchor);
    assert.ok(ranges);
    assert.equal(ranges[0].toString(), oldAnchor.quote);
    const selected = dom.window.getSelection()!;
    selected.addRange(ranges[0]);
    assert.deepEqual(captureTextAnchor(root, selected).anchor, oldAnchor);
    const message = { type: 'selection', page: 1, text: oldAnchor.quote, anchor: oldAnchor };
    assert.deepEqual(parseReaderMessage(JSON.stringify(message)), message);
    const annotation: ReaderAnnotation = { id: 'v11-note', anchor: oldAnchor, color: 'yellow', hasNote: true };
    assert.deepEqual(drawAnnotations(root, [annotation]), [{ id: annotation.id, status: 'placed' }]);
    assert.equal(revealAnnotation(root, annotation), true);
  } finally { dom.window.close(); }
});

test('changed/repeated/Unicode-normalized OCR must need review rather than guess a note location', () => {
  const { dom, root, setText } = textRoot(legacy.text);
  const note: ReaderAnnotation = { id: 'v11-note', anchor: oldAnchor, color: 'blue', hasNote: true };
  try {
    for (const text of [
      legacy.text.trim(), legacy.text.replace('  Green', ' Green'), legacy.text.replace(/\n/g, '\r\n'),
      legacy.text.normalize('NFD'), `Different opening\n${oldAnchor.quote}`, `${oldAnchor.quote}\n${oldAnchor.quote}`,
    ]) {
      setText(text);
      assert.equal(resolveTextAnchor(canonicalSurface(root, 'ocr-text'), oldAnchor), null);
      assert.deepEqual(drawAnnotations(root, [note]), [{ id: note.id, status: 'needs-review' }]);
      assert.equal(revealAnnotation(root, note), false);
      assert.equal(root.querySelectorAll('[data-annotation-id]').length, 0);
    }
    root.replaceChildren();
    assert.deepEqual(drawAnnotations(root, [note]), [{ id: note.id, status: 'recognize-page' }]);
  } finally { dom.window.close(); }
});

test('all shared printed Study phrases retain exact UTF-16 punctuation, ñ and line breaks', async () => {
  for (const sample of spec.samples) {
    const transcript = sample.lines.join('\n');
    assert.equal(await readFile(new URL(`${sample.id}-expected.txt`, fixtures), 'utf8'), transcript);
    for (const phrase of sample.studyPhrases) {
      const { dom, root, block } = textRoot(transcript);
      try {
        const start = transcript.indexOf(phrase);
        assert.ok(start >= 0, `${sample.id}: missing literal Study phrase`);
        assert.equal(transcript.indexOf(phrase, start + 1), -1, 'Study fixture phrase is unambiguous');
        const range = dom.window.document.createRange();
        range.setStart(block.firstChild!, start); range.setEnd(block.firstChild!, start + phrase.length);
        const selection = dom.window.getSelection()!; selection.addRange(range);
        const anchor = captureTextAnchor(root, selection).anchor;
        assert.ok(anchor);
        assert.equal(anchor.quote, phrase);
        assert.deepEqual(parseReaderMessage(JSON.stringify({ type: 'selection', text: phrase, page: 1, anchor })),
          { type: 'selection', text: phrase, page: 1, anchor });
      } finally { dom.window.close(); }
    }
  }
});

function jpegSegment(marker: number, text: string) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 255]), payload]);
}
function embeddedImage(pdf: Uint8Array) {
  const bytes = Buffer.from(pdf);
  const body = bytes.toString('latin1');
  const found = /\/Subtype \/Image[\s\S]*?\/Length (\d+) >>\nstream\n/.exec(body);
  assert.ok(found, 'PDF must contain one bounded image stream');
  const start = found.index + found[0].length;
  return bytes.subarray(start, start + Number(found[1]));
}
async function colorJpeg() { return readFile(new URL('color-24x16.jpg', fixtures)); }
async function decodedPixels(bytes: Uint8Array) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, pixels: context.getImageData(0, 0, image.width, image.height).data };
}

test('photo PDF strips APP1-APP15 and COM metadata without changing the actual JPEG pixels', async () => {
  const jpeg = await colorJpeg();
  const metadata = [
    jpegSegment(0xe1, 'Exif\0\0SYNTHETIC-GPS-DO-NOT-EXPORT'),
    jpegSegment(0xe1, 'http://ns.adobe.com/xap/1.0/\0SYNTHETIC-XMP-CREATOR'),
    ...Array.from({ length: 14 }, (_, i) => jpegSegment(0xe2 + i, `SYNTHETIC-APP-${i + 2}-PRIVATE-PATH`)),
    jpegSegment(0xfe, 'SYNTHETIC-JPEG-COMMENT'),
  ];
  const tagged = Buffer.concat([jpeg.subarray(0, 2), ...metadata, jpeg.subarray(2)]);
  const before = Buffer.from(tagged);
  const pdf = createScanPdf(tagged, 24, 16);
  assert.deepEqual(tagged, before, 'export never modifies input');
  // Canvas includes an sRGB ICC APP2 profile. Removing it changes container bytes,
  // so compare actual decoded pixels rather than incorrectly requiring byte equality.
  assert.deepEqual(await decodedPixels(embeddedImage(pdf)), await decodedPixels(jpeg));
  assert.equal(Buffer.from(pdf).includes(Buffer.from('SYNTHETIC-')), false);
});

test('photo PDF strips valid post-scan JPEG comments as well as pre-scan metadata', async () => {
  const jpeg = await colorJpeg();
  // COM before EOI is legal after the entropy-coded scan. The image must still decode.
  const comment = jpegSegment(0xfe, 'SYNTHETIC-POST-SCAN-PRIVATE-COMMENT');
  const tagged = Buffer.concat([jpeg.subarray(0, -2), comment, jpeg.subarray(-2)]);
  const decoded = await decodedPixels(tagged);
  assert.equal(decoded.width, 24); assert.equal(decoded.height, 16);
  const pdf = createScanPdf(tagged, 24, 16);
  assert.equal(Buffer.from(pdf).includes(Buffer.from('SYNTHETIC-POST-SCAN-PRIVATE-COMMENT')), false);
  assert.deepEqual(await decodedPixels(embeddedImage(pdf)), await decodedPixels(jpeg));
});

test('photo PDF rejects raster/frame mismatches, malformed JPEGs and byte/pixel/edge overflows', async () => {
  const jpeg = await colorJpeg();
  for (const [width, height] of [[16, 24], [23, 16], [24, 15], [0, 16], [-1, 16], [24.5, 16], [NaN, 16], [24, Infinity], [8193, 1], [2001, 2000]]) {
    assert.throws(() => createScanPdf(jpeg, width, height), /scan|image/i, `${width}x${height}`);
  }
  const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
  oversized.set(jpeg.subarray(0, 2)); oversized.set(jpeg.subarray(-2), oversized.length - 2);
  for (const bytes of [new Uint8Array(), Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), jpeg.subarray(0, -2), oversized]) {
    assert.throws(() => createScanPdf(bytes, 24, 16), /scan|image/i);
  }
});

test('real PDF.js validates one-page photo PDF, aspect ratio and decoded raster without network', async () => {
  const jpeg = await colorJpeg();
  const pdf = createScanPdf(jpeg, 24, 16);
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const oldFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = async () => { networkRequests++; throw new Error('Synthetic PDF test attempted network IO'); };
  const task = getDocument({ data: pdf, useSystemFonts: false, useWorkerFetch: false });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 1);
    const page = await document.getPage(1);
    assert.deepEqual(page.view, [0, 0, 792, 528]);
    assert.equal((await page.getTextContent()).items.length, 0, 'photo PDF must not inject OCR text');
    assert.deepEqual(await page.getAnnotations(), []);
    const metadata = await document.getMetadata();
    assert.equal(metadata.metadata, null);
    assert.equal('Author' in metadata.info, false);
    const operators = await page.getOperatorList();
    const images = operators.fnArray.flatMap((op: number, i: number) => op === OPS.paintImageXObject ? [i] : []);
    assert.equal(images.length, 1);
    const index = images[0];
    assert.deepEqual(operators.argsArray[index].slice(1), [24, 16]);
    const image = await new Promise<{ width: number; height: number; data: Uint8Array }>(resolve => page.objs.get(operators.argsArray[index][0], resolve));
    assert.equal(image.width, 24); assert.equal(image.height, 16);
    assert.ok(image.data.length >= 24 * 16 * 3, 'actual decoded pixels must be present');
    assert.ok(image.data[0] > 150 && image.data[2] < 80, 'synthetic left side must decode red');
    assert.equal(networkRequests, 0);
  } finally { await task.destroy(); globalThis.fetch = oldFetch; }
});

test('shared synthetic fixture hashes, rotated dimensions and actual one-page PDFs match the manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', fixtures), 'utf8')) as {
    synthetic: boolean; specSha256: string;
    pages: { id: string; width: number; height: number; variant: string; assets: { file: string; bytes: number; sha256: string }[] }[];
  };
  const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.specSha256, digest(await readFile(new URL('spec.json', fixtures))));
  assert.equal(manifest.pages.length, 10);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const page of manifest.pages) {
    assert.deepEqual([page.width, page.height], page.variant === 'rotated-90' ? [900, 1200] : [1200, 900]);
    for (const asset of page.assets) {
      const data = await readFile(new URL(asset.file, fixtures));
      assert.equal(data.length, asset.bytes, asset.file);
      assert.equal(digest(data), asset.sha256, asset.file);
      if (!asset.file.endsWith('.pdf')) continue;
      const task = getDocument({ data: new Uint8Array(data), useWorkerFetch: false });
      try {
        const pdf = await task.promise;
        assert.equal(pdf.numPages, 1, asset.file);
        const parsed = await pdf.getPage(1);
        assert.deepEqual(parsed.view, page.variant === 'rotated-90' ? [0, 0, 594, 792] : [0, 0, 792, 594]);
        assert.equal((await parsed.getTextContent()).items.length, 0);
      } finally { await task.destroy(); }
    }
  }
});
