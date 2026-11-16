import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationStore } from '../src/core/services/annotations/store';
import { validateAnnotationPayload, validateTextAnchor } from '../src/core/services/annotations/validation';
import type { AnnotationPayload, AnnotationPort, AnnotationRecord } from '../src/core/services/annotations/types';

const scope = 'abcdefghijklmnopqrst/11111111-1111-1111-1111-111111111111';
const hash = 'a'.repeat(64);
function payload(id='note-1'):AnnotationPayload { return {id,documentId:null,documentHash:null,format:null,location:null,anchor:null,title:'A thought',body:'Keep this thought',color:'yellow',createdAt:'2026-11-11T00:00:00.000Z',updatedAt:'2026-11-11T00:00:00.000Z'}; }
function fixture(guest=false) {
  let json:string|null=null,revision=0,active=true,fail=false,uncertain=false,seq=0;
  const parents=new Map([['doc-1',{hash,format:'pdf' as const,deleted:false}]]);
  const port:AnnotationPort={read:async()=>({json,revision}),commit:async(expected,next)=>{if(expected!==revision)return false;if(fail)throw Error('disk full');json=next;revision++;if(uncertain)throw Error('lost storage acknowledgement');return true;}};
  const make=()=>createAnnotationStore({scope:guest?'guest':scope,port,checkActive(){if(!active)throw Error('account changed');},parent:async id=>parents.get(id)??null,newId:()=>`generated-${++seq}`});
  return {store:make(),make,port,parents,raw:()=>json,fail:()=>{fail=true;},uncertain:()=>{uncertain=true;},leave:()=>{active=false;}};
}
const record=(p:AnnotationPayload,revision=1,deleted=false):AnnotationRecord=>({id:p.id,revision,deleted,payload:p});
function attached():AnnotationPayload{return {...payload(),documentId:'doc-1',documentHash:hash,format:'pdf',location:{unit:'page',index:1},anchor:{kind:'text',version:1,surface:'pdf-text',textHash:hash,ranges:[{blockId:'p-1',startUtf16:0,endUtf16:4}],quote:'Keep',prefix:'',suffix:''}};}

test('annotation save persists the item and same durable outbox atomically before reporting success',async()=>{
  const f=fixture();await f.store.save(payload());const s=await f.make().read();
  assert.equal(s.scope,scope);assert.equal(s.pending.length,1);assert.equal(s.pending[0].payload.body,'Keep this thought');
  assert.equal((await f.make().list())[0].syncStatus,'pending');
  f.fail();await assert.rejects(f.store.save({...payload(),body:'lost'}),/disk full/);
  assert.equal((await f.make().list())[0].payload.body,'Keep this thought');
});
test('CAS retries preserve edits from independent tabs and reconcile a lost storage acknowledgement',async()=>{
  const f=fixture();await Promise.all([f.store.save(payload('a')),f.make().save(payload('b'))]);
  assert.deepEqual((await f.store.list()).map(x=>x.id).sort(),['a','b']);
  f.uncertain();await f.store.save(payload('c'));assert.equal((await f.make().read()).pending.length,3);
});
test('Guest notes remain local; account and corrupt stores never silently reset',async()=>{
  const f=fixture(true);await f.store.save(payload());assert.equal((await f.make().read()).pending.length,0);assert.equal((await f.store.list())[0].syncStatus,'local');
  const wrong=createAnnotationStore({scope,port:f.port,checkActive(){},parent:async()=>null});await assert.rejects(wrong.read(),/preserved/);
  const bad=createAnnotationStore({scope,port:{read:async()=>({json:'{"version":99}',revision:2}),commit:async()=>{throw Error('must not overwrite');}},checkActive(){},parent:async()=>null});
  await assert.rejects(bad.save(payload()),/preserved/);f.leave();await assert.rejects(f.store.list(),/account changed/);
});
test('unsaved drafts survive restart and Save clears the draft in the same commit',async()=>{
  const f=fixture();await f.store.saveDraft({id:'draft-1',payload:{...payload(),body:''},updatedAt:'2026-11-11T00:00:00.000Z'});
  assert.equal((await f.make().read()).drafts.length,1);assert.equal((await f.store.list()).length,0);
  await f.store.save(payload(),{draftId:'draft-1'});assert.equal((await f.make().read()).drafts.length,0);
});
test('empty notes require explicit highlight-only and remove-note keeps the same highlight identity',async()=>{
  const f=fixture();await assert.rejects(f.store.save({...attached(),body:''}),/highlight only/i);
  await f.store.save({...attached(),body:''},{highlightOnly:true});await f.store.save({...attached(),body:'Explanation'});
  await f.store.removeNote('note-1');const item=(await f.store.list())[0];assert.equal(item.id,'note-1');assert.equal(item.payload.body,'');assert.equal(item.payload.anchor?.kind,'text');
  await assert.rejects(f.store.save({...payload('empty'),body:''},{highlightOnly:true}),/note text/i);
});
test('parent Trash hides and locks attachments without changing their tombstones or standalone notes',async()=>{
  const f=fixture();await f.store.save(attached());await f.store.save(payload('standalone'));await f.store.remove('note-1');
  f.parents.get('doc-1')!.deleted=true;assert.deepEqual((await f.store.list()).map(x=>x.id),['standalone']);
  await assert.rejects(f.store.restore('note-1'),/parent|document.*Trash/i);
  f.parents.get('doc-1')!.deleted=false;assert.equal((await f.store.list()).length,1);assert.equal((await f.store.list({trash:true}))[0].id,'note-1');
  await f.store.restore('note-1');assert.equal((await f.store.list()).length,2);
});
test('saved attachment and anchor stay immutable when editing a partial selection',async()=>{
  const f=fixture();await f.store.save(attached());const p=attached();(p.anchor as any).ranges[0].endUtf16=2;
  await assert.rejects(f.store.save(p),/anchor|attachment/i);assert.equal((await f.store.list())[0].payload.anchor?.kind,'text');
  await assert.rejects(f.store.save({...attached(),id:'bad-hash',documentHash:'b'.repeat(64)}),/document|hash/i);
});
test('lost remote response retries the same operation and acknowledgement does not erase later local edits',async()=>{
  const f=fixture();await f.store.save(payload());const first=(await f.store.read()).pending[0];await f.store.save({...payload(),body:'Newer device edit'});
  assert.equal((await f.make().read()).pending[0].operationId,first.operationId);
  await f.store.acknowledge(first.operationId,{status:'applied',record:record(first.payload)});
  assert.equal((await f.store.list())[0].payload.body,'Newer device edit');assert.equal((await f.store.read()).pending[0].expectedRevision,1);
});
test('conflicts retain latest device and cloud versions; keep both creates one distinct record repeat-safely',async()=>{
  const f=fixture();await f.store.save(payload());const op=(await f.store.read()).pending[0];await f.store.save({...payload(),body:'Latest local'});
  await f.store.acknowledge(op.operationId,{status:'conflict',record:record({...payload(),body:'Cloud'},2)});
  let s=await f.store.read();assert.equal(s.conflicts[0].local.payload.body,'Latest local');assert.equal(s.conflicts[0].cloud.payload.body,'Cloud');assert.equal(s.pending.length,0);
  await f.store.resolve('note-1','both');await f.store.resolve('note-1','both');s=await f.store.read();
  assert.equal(s.conflicts.length,0);assert.equal(s.pending.length,1);assert.notEqual(s.pending[0].id,'note-1');
  assert.equal((await f.store.list()).find(x=>x.id==='note-1')!.payload.body,'Cloud');
});
test('parent conflict preserves local edit and cannot silently restore parent or individually deleted note',async()=>{
  const f=fixture();await f.store.save(attached());const op=(await f.store.read()).pending[0];f.parents.get('doc-1')!.deleted=true;
  await f.store.acknowledge(op.operationId,{status:'conflict',reason:'parent-trashed',record:record(op.payload,0,true)});
  assert.equal((await f.store.read()).conflicts[0].local.payload.body,op.payload.body);
  await assert.rejects(f.store.resolve(op.id,'local'),/Trash|parent/i);assert.equal((await f.store.read()).conflicts.length,1);
  f.parents.get('doc-1')!.deleted=false;await f.store.resolve(op.id,'local');
  assert.equal((await f.store.read()).pending[0].expectedRevision,0,'uncreated note can be retried after explicit parent restore');
});
test('Guest copy requires verified document/hash mapping, preserves source and is repeat-safe',async()=>{
  const guest=fixture(true),account=fixture();await guest.store.save(attached());await guest.store.save(payload('standalone'));
  const source=(await guest.store.list()).map(x=>x.payload);await assert.rejects(account.store.copyGuest(source,new Map()),/mapping/i);
  const mapping=new Map([['doc-1',{documentId:'doc-1',documentHash:hash,format:'pdf' as const}]]);
  await account.store.copyGuest(source,mapping);await account.store.copyGuest(source,mapping);
  assert.equal((await account.store.list()).length,2);assert.equal((await guest.store.list()).length,2);assert.equal((await account.store.read()).pending.length,2);
});
test('payload limits count UTF8 bytes and reject oversized or malformed anchors without truncation',()=>{
  assert.throws(()=>validateAnnotationPayload({...payload(),body:'😀'.repeat(9000)}),/large|limit|32/i);
  assert.throws(()=>validateAnnotationPayload({...attached(),location:{unit:'slide',index:1}}),/invalid|location/i);
  assert.throws(()=>validateTextAnchor({...attached().anchor,ranges:[{blockId:'p',startUtf16:4,endUtf16:1}]}),/invalid|range/i);
  const p=payload();assert.deepEqual(validateAnnotationPayload(p),p);
});
test('the payload byte bound includes PostgreSQL decimal expansion of tiny PDF coordinates',()=>{
  const p={...attached(),title:'x'.repeat(512),body:'😀'.repeat(7720),anchor:{kind:'region',version:1,rect:[1e-300,1e-300,5e-300,5e-300],pageBox:[0,0,300,200]}};
  assert.ok(Buffer.byteLength(JSON.stringify(p),'utf8')<32768,'compact JS JSON alone is misleading');
  const expanded=JSON.stringify(p).replace(/1e-300/g,'0.'+'0'.repeat(299)+'1').replace(/5e-300/g,'0.'+'0'.repeat(299)+'5');
  assert.ok(Buffer.byteLength(expanded,'utf8')>32768,'the decimal expansion exceeds the server bound even before jsonb spacing');
  assert.throws(()=>validateAnnotationPayload(p),/large|32 KiB/i);
});
test('individual Trash conflicts require explicit Restore; keep-cloud does not leave phantom absent notes',async()=>{
  const f=fixture();await f.store.save(payload());let op=(await f.store.read()).pending[0];
  await f.store.acknowledge(op.operationId,{status:'conflict',record:record(payload(),2,true)});
  await assert.rejects(f.store.resolve(op.id,'local'),/Restore/);await f.store.resolve(op.id,'cloud');
  assert.equal((await f.store.list()).length,0);await f.store.restore(op.id);assert.equal((await f.store.read()).pending[0].action,'restore');
  const absent=fixture();await absent.store.save(attached());op=(await absent.store.read()).pending[0];
  await absent.store.acknowledge(op.operationId,{status:'conflict',record:record(attached(),0,true),reason:'parent-trashed'});
  await absent.store.resolve(op.id,'cloud');assert.equal((await absent.store.list({trash:true})).length,0);
});
test('late account changes during durable commits are not published into the next account',async()=>{
  let active=true,json:string|null=null;
  const store=createAnnotationStore({scope,parent:async()=>null,checkActive(){if(!active)throw Error('account changed');},port:{read:async()=>({json,revision:json?1:0}),commit:async(_,next)=>{json=next;active=false;return true;}}});
  await assert.rejects(store.save(payload()),/account changed/);assert.ok(json,'old account durable data is preserved');await assert.rejects(store.list(),/account changed/);
});
test('acknowledgement cannot remove a pending operation using a mismatched server revision',async()=>{
  const f=fixture();await f.store.save(payload());const op=(await f.store.read()).pending[0];
  await assert.rejects(f.store.acknowledge(op.operationId,{status:'applied',record:record(payload(),5)}),/invalid/);
  assert.equal((await f.store.read()).pending[0].operationId,op.operationId);
});
test('an editor opened before a remote change preserves both versions instead of overwriting the unseen revision',async()=>{
  const f=fixture();await f.store.merge([record(payload(),1)]);
  await f.store.saveDraft({id:'open-editor',payload:{...payload(),body:'Unsaved editor'},updatedAt:payload().updatedAt,baseRevision:1});
  await f.store.merge([record({...payload(),body:'New remote edit'},2)]);
  await f.store.save({...payload(),body:'Unsaved editor'},{baseRevision:1,draftId:'open-editor'});
  const state=await f.store.read();assert.equal(state.pending.length,0);assert.equal(state.conflicts[0].local.payload.body,'Unsaved editor');
  assert.equal(state.conflicts[0].local.expectedRevision,1);assert.equal(state.conflicts[0].cloud.payload.body,'New remote edit');assert.equal(state.drafts.length,0);
  assert.equal((await f.store.list())[0].syncStatus,'conflict');
});
test('a cloud deletion while an editor is open retains attempted text as a conflict and requires explicit restoration',async()=>{
  const f=fixture();await f.store.merge([record(payload(),1)]);await f.store.merge([record(payload(),2,true)]);
  await f.store.save({...payload(),body:'Interrupted editor'},{baseRevision:1});const s=await f.store.read();
  assert.equal(s.conflicts[0].cloud.deleted,true);assert.equal(s.conflicts[0].local.payload.body,'Interrupted editor');
  await assert.rejects(f.store.resolve('note-1','local'),/Restore/);assert.equal((await f.store.read()).conflicts.length,1);
});
test('stale editor cannot erase newer pending local work and its draft base survives restart',async()=>{
  const f=fixture();await f.store.merge([record(payload(),1)]);await f.store.save({...payload(),body:'New pending edit'},{baseRevision:1});
  await assert.rejects(f.store.save({...payload(),body:'Older editor'},{baseRevision:1,draftId:'old-editor'}),/changed while editing/);
  const state=await f.make().read();assert.equal(state.pending.length,1);assert.equal(state.pending[0].payload.body,'New pending edit');
  assert.equal(state.drafts[0].payload.body,'Older editor');assert.equal(state.drafts[0].baseRevision,1);
});
test('parent Trash while editing retains the latest incoming editor text as a recovery draft',async()=>{
  const f=fixture();await f.store.merge([record(attached(),1)]);f.parents.get('doc-1')!.deleted=true;
  await assert.rejects(f.store.save({...attached(),body:'Interrupted by parent Trash'},{baseRevision:1,draftId:'open-editor'}),/Trash/);
  const state=await f.make().read();assert.equal(state.drafts[0].payload.body,'Interrupted by parent Trash');assert.equal(state.drafts[0].baseRevision,1);assert.equal(state.pending.length,0);
});
test('destructive actions from an older editor cannot remove unseen cloud text or queue a deletion',async()=>{
  const f=fixture(),p=attached();await f.store.merge([record(p,1)]);
  await f.store.merge([record({...p,body:'New text from another device'},2)]);
  await assert.rejects(f.store.removeNote(p.id,{baseRevision:1}),/Close.*reopen.*latest/i);
  await assert.rejects(f.store.remove(p.id,{baseRevision:1}),/Close.*reopen.*latest/i);
  let state=await f.store.read();assert.equal(state.pending.length,0);assert.equal(state.records[0].payload.body,'New text from another device');assert.equal(state.records[0].deleted,false);
  await f.store.removeNote(p.id,{baseRevision:2});state=await f.store.read();assert.equal(state.pending.length,1);assert.equal(state.pending[0].expectedRevision,2);assert.equal(state.pending[0].payload.body,'');
});
