import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, writeFile, copyFile, unlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { Document, DocumentFormat } from '../src/core/models/document';
import { parseDocx, validateDocument } from '../src/core/services/document_validation';
import { DocumentRepository, type DocumentStoragePort } from '../src/core/services/document_repository';
import { isOwnedDocumentUri } from '../src/core/services/file_ownership';

const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const temporaryRoots: string[] = [];
after(async () => {
  for (const root of temporaryRoots) {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('topictrail-unit-'));
    await rm(root, { recursive: true, force: true });
  }
});
function docx(body: string) {
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    'word/document.xml': strToU8(`<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body>${body}</x:body></x:document>`),
  });
}

test('DOCX preserves runs, XML entities, tabs, breaks and table paragraphs', () => {
  const bytes = docx('<x:p><x:r><x:t>Loops &amp; </x:t></x:r><x:r><x:t>Iteration</x:t><x:tab/><x:t>Practice</x:t><x:br/><x:t>Repeat</x:t></x:r></x:p><x:tbl><x:tr><x:tc><x:p><x:r><x:t>Cell</x:t></x:r></x:p></x:tc></x:tr></x:tbl>');
  assert.deepEqual(parseDocx(bytes), ['Loops & Iteration\tPractice\nRepeat', 'Cell']);
});
test('arbitrary ZIP is not accepted as DOCX', () => {
  assert.throws(() => parseDocx(zipSync({ 'notes.txt': strToU8('Hello') })), /DOCX/);
});
test('corrupt XML and document types with entities are rejected', () => {
  assert.throws(() => parseDocx(docx('<x:p><x:t>broken</x:p>')), /XML|DOCX/);
  assert.throws(() => parseDocx(docx('<!DOCTYPE x [<!ENTITY payload "hidden">]><x:p/>')), /XML|DOCX/);
});
test('DOCX XML expansion is bounded before decompression', () => {
  const bytes = docx('<x:p><x:r><x:t>' + 'a'.repeat(2000) + '</x:t></x:r></x:p>');
  assert.throws(() => parseDocx(bytes, 1024), /large|limit/i);
});

test('forged ZIP sizes cannot bypass the DOCX XML limit for stored entries', () => {
  const bytes = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    'word/document.xml': strToU8('<document><p><t>' + 'a'.repeat(2000) + '</t></p></document>'),
  }, { level: 0 });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let patched = 0;
  for (let index = 0; index + 46 <= bytes.length; index++) {
    if (view.getUint32(index, true) === 0x02014b50) {
      view.setUint32(index + 24, 1, true);
      patched++;
    }
  }
  assert.equal(patched, 2);
  assert.throws(() => parseDocx(bytes, 1024), /size|limit/i);
});
test('pretty-printed OOXML does not add formatting whitespace to readable text', () => {
  assert.deepEqual(parseDocx(docx('<x:p>\n  <x:r>\n    <x:t xml:space="preserve">  Loop </x:t>\n  </x:r>\n  <x:r><x:t>again</x:t></x:r>\n</x:p>')), ['  Loop again']);
});
test('a content-type name inside a comment does not validate a renamed ZIP', () => {
  const bytes = zipSync({
    '[Content_Types].xml': strToU8('<Types><!--application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml--><Override PartName="/word/document.xml" ContentType="text/plain"/></Types>'),
    'word/document.xml': strToU8('<document><p><t>Not Word</t></p></document>'),
  });
  assert.throws(() => parseDocx(bytes), /DOCX/);
});
test('validates original picker filename even when cache URI has no extension', () => {
  assert.equal(validateDocument('Syllabus.PDF', strToU8('%PDF-1.7\n'), 9), DocumentFormat.PDF);
  assert.equal(validateDocument('Syllabus.docx', docx('<x:p/>')), DocumentFormat.DOCX);
});
test('rejects empty, mismatched, unsupported and oversized imports', () => {
  assert.throws(() => validateDocument('empty.pdf', new Uint8Array()), /empty/i);
  assert.throws(() => validateDocument('fake.pdf', strToU8('not pdf')), /content|PDF/i);
  assert.throws(() => validateDocument('notes.exe', strToU8('%PDF-1.7')), /format/i);
  assert.throws(() => validateDocument('huge.pdf', strToU8('%PDF-1.7'), 50 * 1024 * 1024 + 1), /50/);
});
test('metadata decoder refuses unknown formats and invalid dates', () => {
  const json = new Document('1', 'Course', DocumentFormat.PDF, 'file:///course.pdf', new Date('2026-10-25T00:00:00Z')).toJson();
  assert.throws(() => Document.fromJson({ ...json, format: 'exe' }), /metadata/i);
  assert.throws(() => Document.fromJson({ ...json, importedAt: 'not a date' }), /metadata/i);
});
test('owned-file guard accepts Expo trailing-slash directory URIs and rejects escaping paths', () => {
  assert.equal(isOwnedDocumentUri('file:///data/app/documents/abc.pdf', 'file:///data/app/documents/'), true);
  assert.equal(isOwnedDocumentUri('file:///data/app/documents/abc.pdf', 'file:///data/app/documents'), true);
  assert.equal(isOwnedDocumentUri('file:///data/app/documents-other/abc.pdf', 'file:///data/app/documents/'), false);
  assert.equal(isOwnedDocumentUri('file:///data/app/documents/../private.json', 'file:///data/app/documents'), false);
  assert.equal(isOwnedDocumentUri('file:///data/app/documents/%2e%2e/private.json', 'file:///data/app/documents'), false);
  assert.equal(isOwnedDocumentUri('file:///data/app/documents/nested%2Fprivate.json', 'file:///data/app/documents'), false);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'topictrail-unit-'));
  temporaryRoots.push(root);
  const metadata = join(root, 'documents.json');
  const source = join(root, 'source.pdf');
  await writeFile(source, '%PDF-1.7\n');
  let failWrites = false;
  const port: DocumentStoragePort = {
    async readMetadata() {
      try { return await readFile(metadata, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async writeMetadata(text) { if (failWrites) throw new Error('Disk full'); await writeFile(metadata, text); },
    async copyToDocuments(uri, id, format) {
      const filePath = join(root, `${id}.${format}`);
      await copyFile(uri, filePath);
      return { filePath, size: (await stat(filePath)).size };
    },
    async removeFile(path) { await unlink(path); },
    async fileExists(path) { try { await stat(path); return true; } catch { return false; } },
  };
  return { source, port, failWrites: () => { failWrites = true; }, root };
}
test('import copies owned file, survives repository restart, then renames and deletes', async () => {
  const f = await fixture();
  const repository = new DocumentRepository(f.port);
  const imported = await repository.saveDocument({ originalPath: f.source, title: 'Course', format: DocumentFormat.PDF });
  assert.notEqual(imported.filePath, f.source);
  assert.equal(await readFile(imported.filePath, 'utf8'), '%PDF-1.7\n');
  const restarted = new DocumentRepository(f.port);
  assert.equal((await restarted.getDocument(imported.id))?.title, 'Course');
  await restarted.updateDocument(imported.copyWith({ title: 'Renamed' }));
  assert.equal((await new DocumentRepository(f.port).getAllDocuments())[0].title, 'Renamed');
  await restarted.updateLastOpened(imported.id);
  assert.ok((await restarted.getDocument(imported.id))?.lastOpenedAt instanceof Date);
  await restarted.deleteDocument(imported.id);
  assert.deepEqual(await new DocumentRepository(f.port).getAllDocuments(), []);
  assert.equal(await f.port.fileExists(imported.filePath), false);
  assert.equal(await f.port.fileExists(f.source), true);
});
test('concurrent imports retain distinct metadata entries', async () => {
  const f = await fixture();
  const repository = new DocumentRepository(f.port);
  const imported = await Promise.all(Array.from({ length: 5 }, (_, i) => repository.saveDocument({ originalPath: f.source, title: `Course ${i}`, format: DocumentFormat.PDF })));
  assert.equal(new Set(imported.map(d => d.id)).size, 5);
  assert.equal((await new DocumentRepository(f.port).getAllDocuments()).length, 5);
});
test('failed rename/delete writes preserve prior metadata and readable file', async () => {
  const f = await fixture();
  const repository = new DocumentRepository(f.port);
  const doc = await repository.saveDocument({ originalPath: f.source, title: 'Original', format: DocumentFormat.PDF });
  f.failWrites();
  await assert.rejects(repository.updateDocument(doc.copyWith({ title: 'Wrong' })), /Disk full/);
  await assert.rejects(repository.deleteDocument(doc.id), /Disk full/);
  assert.equal((await repository.getDocument(doc.id))?.title, 'Original');
  assert.equal(await f.port.fileExists(doc.filePath), true);
});
test('corrupted persisted metadata is reported instead of reset to an empty library', async () => {
  const f = await fixture();
  await f.port.writeMetadata('{bad');
  await assert.rejects(new DocumentRepository(f.port).getAllDocuments(), /metadata/i);
  assert.equal(await f.port.readMetadata(), '{bad');
});

test('failed file deletion plus failed rollback preserves a discoverable library entry after restart', async () => {
  const f = await fixture();
  const repository = new DocumentRepository(f.port);
  const doc = await repository.saveDocument({ originalPath: f.source, title: 'Keep me', format: DocumentFormat.PDF });
  const write = f.port.writeMetadata;
  let writes = 0;
  f.port.writeMetadata = async json => {
    if (++writes > 1) throw new Error('Disk full during rollback');
    await write(json);
  };
  f.port.removeFile = async () => { throw new Error('Deletion denied'); };
  await assert.rejects(repository.deleteDocument(doc.id), /Deletion denied/);
  assert.equal((await repository.getDocument(doc.id))?.title, 'Keep me');
  assert.equal((await new DocumentRepository(f.port).getDocument(doc.id))?.title, 'Keep me');
  assert.equal(await f.port.fileExists(doc.filePath), true);
});

test('completed deletion remains durable when its final metadata cleanup fails', async () => {
  const f = await fixture();
  const repository = new DocumentRepository(f.port);
  const doc = await repository.saveDocument({ originalPath: f.source, title: 'Delete me', format: DocumentFormat.PDF });
  const write = f.port.writeMetadata;
  let writes = 0;
  f.port.writeMetadata = async json => {
    if (++writes > 1) throw new Error('Disk full during cleanup');
    await write(json);
  };
  await repository.deleteDocument(doc.id);
  assert.equal(writes, 2, 'exercise the failed final cleanup write');
  assert.equal(await f.port.fileExists(doc.filePath), false);
  assert.deepEqual(await repository.getAllDocuments(), []);
  assert.deepEqual(await new DocumentRepository(f.port).getAllDocuments(), []);
  assert.equal(await f.port.fileExists(f.source), true);
});
