import assert from 'node:assert/strict';
import test from 'node:test';
import { ReaderNoteSession } from '../src/features/notes/reader_note_session';
import type { TextAnchorV1 } from '../src/core/services/annotations/types';

const anchor:TextAnchorV1={kind:'text',version:1,surface:'docx-text',textHash:'a'.repeat(64),ranges:[{blockId:'docx-p-20',startUtf16:0,endUtf16:6}],quote:'repeat',prefix:'',suffix:''};
const page=(page:number)=>({type:'page' as const,page,totalPages:8,hasText:true});
test('Note activation retains the captured anchor through focus collapse and resets on new document interaction',()=>{
  const state=new ReaderNoteSession();state.receive(page(2));state.receive({type:'selection',page:2,text:'repeat',anchor});state.capture();
  state.receive({type:'selection',page:2,text:''});assert.deepEqual(state.consume(),anchor);
  state.receive({type:'selection-reset',page:2});assert.equal(state.consume(),null);
  state.receive({type:'selection',page:2,text:'repeat',anchor});state.receive({type:'surface-change',page:2});assert.equal(state.consume(),null);
  state.receive({type:'selection',page:1,text:'repeat',anchor});assert.equal(state.anchor,null);
});
test('pending passage navigation is issued once and reveals only after its accepted page renders',()=>{
  const state=new ReaderNoteSession();state.requestReveal('saved',true);assert.deepEqual(state.advance(4,8),{type:'wait'});
  state.receive(page(7));assert.deepEqual(state.advance(4,8),{type:'navigate',page:4});
  assert.deepEqual(state.advance(4,8),{type:'wait'});state.beginNavigation();
  state.receive({type:'render-start',page:7});assert.deepEqual(state.advance(4,8),{type:'wait'});
  state.receive(page(4));assert.deepEqual(state.advance(4,8),{type:'reveal',id:'saved',open:true});assert.equal(state.target,undefined);
  state.requestReveal('outside');assert.deepEqual(state.advance(20,8),{type:'unavailable'});
});
