import assert from 'node:assert/strict';
import test from 'node:test';
import { Document, DocumentFormat } from '../src/core/models/document';
import { filterLibraryDocuments, continueReadingDocuments, type CardProgress } from '../src/features/library/libraryView';

const doc = (id: string, title: string, format: DocumentFormat, added: number, opened?: number) =>
  new Document(id, title, format, `/synthetic/${id}`, new Date(added), undefined, undefined, opened === undefined ? undefined : new Date(opened));
const documents = [doc('b', 'Biology', DocumentFormat.PDF, 30, 10), doc('a', 'algebra', DocumentFormat.DOCX, 20, 40), doc('c', 'Biology slides', DocumentFormat.PPTX, 50)];

test('library format and normalized title filters compose before sorting without changing stored order', () => {
  assert.deepEqual(filterLibraryDocuments(documents, ' BIO ', 'pdf', 'recent-added').map(d => d.id), ['b']);
  assert.deepEqual(filterLibraryDocuments(documents, '', 'all', 'title').map(d => d.id), ['a', 'b', 'c']);
  assert.deepEqual(filterLibraryDocuments(documents, '', 'all', 'recent-opened').map(d => d.id), ['a', 'b', 'c']);
  assert.deepEqual(filterLibraryDocuments(documents, '', 'all', 'recent-added').map(d => d.id), ['c', 'b', 'a']);
  assert.deepEqual(documents.map(d => d.id), ['b', 'a', 'c']);
});

test('continue reading includes only actual rendered positions, ordered by device last-opened time', () => {
  const progress = new Map<string, CardProgress>([['a', {page: 4, totalPages: 6}], ['b', 'unavailable'], ['c', {page: 2, totalPages: 3}]]);
  assert.deepEqual(continueReadingDocuments(documents, progress).map(d => d.id), ['a', 'c']);
  assert.deepEqual(continueReadingDocuments(documents, new Map()).map(d => d.id), []);
});
