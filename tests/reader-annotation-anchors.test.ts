import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderDocxParagraphs, renderPptxSlide } from '../src/features/reader/document_dom';
import * as selectionApi from '../src/features/reader/selection';
import { canonicalSurface, captureTextAnchor, resolveTextAnchor, anchorsOverlap } from '../src/features/reader/reader_anchors';

test('repeated phrases resolve only to their exact UTF16 source range and survive DOM rebuilding', () => {
  const dom = new JSDOM('<main></main>'); const root = dom.window.document.querySelector('main')!;
  renderDocxParagraphs(root, ['repeat 😀 repeat', 'repeat'], 20);
  const selected = dom.window.getSelection()!; const range = dom.window.document.createRange();
  range.setStart(root.firstChild!.firstChild!, 10); range.setEnd(root.firstChild!.firstChild!, 16); selected.addRange(range);
  const anchor = captureTextAnchor(root, selected).anchor!;
  assert.deepEqual(anchor.ranges,[{blockId:'docx-p-20',startUtf16:10,endUtf16:16}]);
  assert.equal(anchor.quote,'repeat');
  renderDocxParagraphs(root,['repeat 😀 repeat','repeat'],20);
  const resolved = resolveTextAnchor(canonicalSurface(root,'docx-text'),anchor)!;
  assert.equal(resolved[0].startContainer,root.firstChild!.firstChild);
  assert.equal(resolved[0].startOffset,10);
  assert.equal(resolveTextAnchor(canonicalSurface(root,'docx-text'),{...anchor,ranges:[{blockId:'docx-p-21',startUtf16:0,endUtf16:6}]}),null);
  renderDocxParagraphs(root,['changed 😀 repeat','repeat'],20);
  assert.equal(resolveTextAnchor(canonicalSurface(root,'docx-text'),anchor),null);
  dom.window.close();
});

test('multiblock selections preserve boundaries and reject cross-surface or oversized anchors', () => {
  const dom = new JSDOM('<main></main>'); const root = dom.window.document.querySelector('main')!;
  renderDocxParagraphs(root,['alpha beta','gamma delta']);
  const selected = dom.window.getSelection()!; const range = dom.window.document.createRange();
  range.setStart(root.firstChild!.firstChild!,6); range.setEnd(root.lastChild!.firstChild!,5); selected.addRange(range);
  const anchor = captureTextAnchor(root,selected).anchor!;
  assert.equal(anchor.quote,'beta\ngamma'); assert.equal(anchor.ranges.length,2);
  assert.equal(anchorsOverlap(anchor,{...anchor,ranges:[{blockId:'docx-p-1',startUtf16:1,endUtf16:3}]}),true);
  assert.equal(anchorsOverlap(anchor,{...anchor,ranges:[{blockId:'docx-p-1',startUtf16:5,endUtf16:6}]}),false);
  (root.lastChild as HTMLElement).dataset.annotationSurface='ocr-text';
  assert.match(captureTextAnchor(root,selected).reason!,/one surface/);
  renderDocxParagraphs(root,['x'.repeat(6001)]);range.selectNodeContents(root);selected.removeAllRanges();selected.addRange(range);
  assert.match(captureTextAnchor(root,selected).reason!,/6,000/);
  dom.window.close();
});

test('DOCX paragraph identities retain absolute positions across sections', () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  renderDocxParagraphs(root, ['repeat', 'repeat'], 20);
  assert.deepEqual([...root.children].map(p => (p as HTMLElement).dataset.annotationBlock), ['docx-p-20', 'docx-p-21']);
  dom.window.close();
});

test('selection bridge rejects a malformed anchor instead of silently treating it as valid', () => {
  assert.equal(selectionApi.parseReaderMessage(JSON.stringify({ type: 'selection', text: 'repeat', page: 1, anchor: {kind:'text',version:1} })), null);
});

test('PPTX paragraph, table cells and speaker notes have disjoint stable paths', () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  renderPptxSlide(root, { paragraphs: ['repeat'], tables: [[['repeat', 'repeat']]], notes: ['repeat'], images: [] });
  const ids = [...root.querySelectorAll('[data-annotation-block]')].map(n => (n as HTMLElement).dataset.annotationBlock);
  assert.deepEqual(ids, ['pptx-p-0', 'pptx-table-0-row-0-cell-0', 'pptx-table-0-row-0-cell-1', 'pptx-note-0']);
  dom.window.close();
});
