import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentFormat } from '../src/core/models/document';
import { extractPdfPageText } from '../src/core/services/pdf_text_extraction';
import { DocumentRepository, type DocumentStoragePort } from '../src/core/services/document_repository';
import { ImportResult } from '../src/core/services/document_import_contract';
import { parseDocx, validateDocument } from '../src/core/services/document_validation';
import { demoSamples } from '../src/features/demo/demoSamples';
import { ensureDemoSample, type DemoSampleImportPort } from '../src/features/demo/ensureDemoSample';

const [pdfSample, docxSample] = demoSamples;
const guest = { kind: 'guest' } as const;

test('demo PDF has three distinct pages with selectable study topics', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = pdfSample.createBytes();
  assert.equal(validateDocument(pdfSample.filename, data), DocumentFormat.PDF);
  const task = getDocument({ data, useSystemFonts: true });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 3);
    const topics = ['Variables and values', 'Loops and iteration', 'Functions and reuse'];
    for (const [index, topic] of topics.entries()) {
      const text = await extractPdfPageText(await document.getPage(index + 1));
      assert.ok(text.includes(topic), text);
    }
  } finally {
    await task.destroy();
  }
});

test('demo DOCX has three study sections and enough paragraphs to scroll', () => {
  const data = docxSample.createBytes();
  assert.equal(validateDocument(docxSample.filename, data), DocumentFormat.DOCX);
  const paragraphs = parseDocx(data);
  assert.ok(paragraphs.length > 40 && paragraphs.length <= 60);
  assert.equal(paragraphs[2], 'Observe the evidence');
  assert.equal(paragraphs[20], 'Organize your notes');
  assert.equal(paragraphs[40], 'Explain your findings');
});

function libraryHarness() {
  let metadata: string | null = null;
  const files = new Map<string, Uint8Array>();
  const port: DocumentStoragePort = {
    readMetadata: async () => metadata,
    writeMetadata: async value => { metadata = value; },
    async copyToDocuments(source, id) {
      const data = files.get(source);
      assert.ok(data, 'The sample must be staged before the repository saves it');
      files.set(id, data);
      return { filePath: id, size: data.length };
    },
    async removeFile(path) { files.delete(path); },
    fileExists: async path => files.has(path),
  };
  const open = () => new DocumentRepository(port);
  const attempts: string[] = [];
  let failed = false;
  function samplePort(store: DocumentRepository): DemoSampleImportPort {
    return {
      lookup: id => store.lookupGuestImportOutcome(id),
      async importSample(sample, attempt) {
        attempts.push(attempt.attemptId);
        if (failed) {
          failed = false;
          return new ImportResult(false, undefined, 'Temporary import failure', false, 'retry');
        }
        const source = 'sample-source';
        const bytes = sample.createBytes();
        const format = validateDocument(sample.filename, bytes);
        files.set(source, bytes);
        try {
          const document = await store.saveDocument({ originalPath: source, title: sample.title, format, attempt });
          return new ImportResult(true, document);
        } finally {
          files.delete(source);
        }
      },
    };
  }
  return { open, samplePort, attempts, failNext: () => { failed = true; } };
}

test('a failed sample import retries the same attempt and a reopened library reuses it', async () => {
  const h = libraryHarness();
  h.failNext();
  await assert.rejects(ensureDemoSample(pdfSample, guest, h.samplePort(h.open())), /Temporary import failure/);
  const first = await ensureDemoSample(pdfSample, guest, h.samplePort(h.open()));
  const store = h.open();
  const replay = await ensureDemoSample(pdfSample, guest, h.samplePort(store));
  assert.equal(first.id, replay.id);
  assert.equal(h.attempts.length, 2);
  assert.equal(h.attempts[0], h.attempts[1]);
  assert.deepEqual((await store.getAllDocuments()).map(doc => doc.id), [first.id]);
  assert.deepEqual(await store.getGuestAllowance(), { kind: 'disabled' });
});

test('an explicit import after deletion restores a single sample and preserves each tombstone', async () => {
  const h = libraryHarness();
  for (let generation = 0; generation < 2; generation++) {
    const store = h.open();
    const document = await ensureDemoSample(docxSample, guest, h.samplePort(store));
    await store.deleteDocument(document.id);
  }
  const store = h.open();
  const restored = await ensureDemoSample(docxSample, guest, h.samplePort(store));
  const replay = await ensureDemoSample(docxSample, guest, h.samplePort(h.open()));
  assert.equal(restored.id, replay.id);
  assert.equal(h.attempts.length, 3);
  assert.equal(new Set(h.attempts).size, 3);
  for (const attemptId of h.attempts.slice(0, 2)) {
    assert.deepEqual(await store.lookupGuestImportOutcome(attemptId), { kind: 'deleted' });
  }
  assert.deepEqual((await store.getAllDocuments()).map(doc => doc.id), [restored.id]);
});
