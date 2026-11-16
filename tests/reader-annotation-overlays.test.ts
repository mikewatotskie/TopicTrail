import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { captureTextAnchor } from '../src/features/reader/reader_anchors';
import { renderPptxSlide } from '../src/features/reader/document_dom';
import { drawAnnotations, revealAnnotation, installAnnotationStyles } from '../src/features/reader/reader_overlays';
import type { ReaderAnnotation } from '../src/features/reader/reader_protocol';

test('missing OCR is reported honestly and changed OCR is never attached by matching quote', () => {
  const dom=new JSDOM('<main><div data-annotation-block="ocr-page-text" data-annotation-surface="ocr-text">Original recognized passage</div></main>');
  const root=dom.window.document.querySelector('main')!;const selected=dom.window.getSelection()!;const range=dom.window.document.createRange();
  range.setStart(root.firstChild!.firstChild!,9);range.setEnd(root.firstChild!.firstChild!,19);selected.addRange(range);
  const anchor=captureTextAnchor(root,selected).anchor!;assert.equal(anchor.quote,'recognized');
  const item:ReaderAnnotation={id:'saved-ocr',anchor,color:'yellow',hasNote:true};
  assert.deepEqual(drawAnnotations(root,[item]),[{id:'saved-ocr',status:'placed'}]);
  root.replaceChildren();assert.deepEqual(drawAnnotations(root,[item]),[{id:'saved-ocr',status:'recognize-page'}]);
  const different=dom.window.document.createElement('div');different.dataset.annotationBlock='ocr-page-text';different.dataset.annotationSurface='ocr-text';different.textContent='Different recognized passage';root.append(different);
  assert.deepEqual(drawAnnotations(root,[item]),[{id:'saved-ocr',status:'needs-review'}]);assert.equal(revealAnnotation(root,item),false);dom.window.close();
});

test('reveal opens anchored speaker notes and area overlays leave reading input available', () => {
  const dom=new JSDOM('<main></main>');const root=dom.window.document.querySelector('main')!;installAnnotationStyles(dom.window.document);
  renderPptxSlide(root,{paragraphs:['slide'],tables:[],images:[],notes:['private speaker note']});
  const note=root.querySelector('[data-annotation-block="pptx-note-0"]')!;const selection=dom.window.getSelection()!;const range=dom.window.document.createRange();range.selectNodeContents(note);selection.addRange(range);
  const item:ReaderAnnotation={id:'notes',anchor:captureTextAnchor(root,selection).anchor!,color:'purple',hasNote:true};
  assert.equal(root.querySelector('details')?.open,false);assert.equal(revealAnnotation(root,item),true);assert.equal(root.querySelector('details')?.open,true);
  const surface=dom.window.document.createElement('section');root.append(surface);
  const region:ReaderAnnotation={id:'area',anchor:{kind:'region',version:1,rect:[10,20,30,40],pageBox:[0,0,100,100]},color:'blue',hasNote:true};
  assert.deepEqual(drawAnnotations(root,[region],surface,{width:100,height:100,transform:[1,0,0,-1,0,100],pageBox:[0,0,100,100]}),[{id:'area',status:'placed'}]);
  const mark=root.querySelector<HTMLElement>('[data-annotation-id="area"]')!;assert.equal(mark.style.top,'60px');assert.equal(mark.style.height,'20px');assert.equal(mark.textContent,'N');
  assert.equal(dom.window.getComputedStyle(mark).pointerEvents,'none');assert.match(mark.getAttribute('aria-label')!,/blue highlight with note/);
  assert.equal(revealAnnotation(root,region),true);assert.equal(mark.classList.contains('tt-revealed'),true);dom.window.close();
});
