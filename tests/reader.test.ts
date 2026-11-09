import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { captureSelection, parseReaderMessage, buildSelectionMessage } from '../src/features/reader/selection';
import { renderDocxParagraphs } from '../src/features/reader/document_dom';

test('captures the actual selected phrase from document text', () => {
  const dom = new JSDOM('<main id="content"><p>Variables, loops and functions</p></main><aside>Not the syllabus</aside>');
  const root = dom.window.document.querySelector('main')!;
  const text = root.querySelector('p')!.firstChild!;
  const range = dom.window.document.createRange();
  range.setStart(text, 11); range.setEnd(text, 16);
  const selection = dom.window.getSelection()!;
  selection.addRange(range);
  assert.equal(captureSelection(root, selection), 'loops');
  selection.removeAllRanges();
  assert.equal(captureSelection(root, selection), '');
  range.selectNodeContents(dom.window.document.querySelector('aside')!);
  selection.addRange(range);
  assert.equal(captureSelection(root, selection), '');
  dom.window.close();
});
test('bridge rejects malformed, oversized, and invalid-page messages', () => {
  assert.equal(parseReaderMessage('invalid'), null);
  assert.equal(parseReaderMessage(JSON.stringify({ type: 'selection', text: 'loops', page: -1 })), null);
  assert.equal(parseReaderMessage(JSON.stringify({ type: 'selection', text: 'x'.repeat(50001), page: 1 })), null);
  assert.equal(parseReaderMessage(JSON.stringify({ type: 'page', page: 3, totalPages: 2, hasText: true })), null);
  assert.deepEqual(parseReaderMessage(JSON.stringify({ type: 'selection', text: ' loops ', page: 2 })), { type: 'selection', text: ' loops ', page: 2 });
});

test('DOCX text is displayed literally and cannot create executable markup', () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  renderDocxParagraphs(root, ['<img src=x onerror="alert(1)">', 'Loops & iteration']);
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelectorAll('p').length, 2);
  assert.equal(root.lastChild?.textContent, 'Loops & iteration');
  dom.window.close();
});
test('overlong selection produces recoverable validation instead of a stale or fatal selection', () => {
  assert.deepEqual(buildSelectionMessage('x'.repeat(50001), 1), { type: 'selection-limit' });
  assert.deepEqual(buildSelectionMessage(' loops ', 1), { type: 'selection', text: ' loops ', page: 1 });
  assert.deepEqual(parseReaderMessage('{"type":"selection-limit"}'), { type: 'selection-limit' });
});
