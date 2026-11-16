import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnnotationListItem, AnnotationPayload } from '../src/core/services/annotations/types';
import { filterNotes, conflictChoices } from '../src/features/notes/notesListView';

const payload = (id:string,body:string,documentId:string|null=null):AnnotationPayload => ({id,body,documentId,documentHash:documentId?'a'.repeat(64):null,format:documentId?'pdf':null,location:documentId?{unit:'page',index:2}:null,anchor:null,title:'',color:'yellow',createdAt:'2026-11-11T00:00:00.000Z',updatedAt:'2026-11-11T00:00:00.000Z'});
const item = (p:AnnotationPayload,extra:Partial<AnnotationListItem>={}):AnnotationListItem => ({id:p.id,payload:p,revision:1,deleted:false,parentDeleted:false,syncStatus:'local',...extra});
const highlight = {...payload('highlight','Remember cells','biology'),color:'blue' as const,anchor:{kind:'text' as const,version:1 as const,surface:'pdf-text' as const,textHash:'a'.repeat(64),ranges:[{blockId:'p1',startUtf16:0,endUtf16:5}],quote:'Cell walls',prefix:'',suffix:''}};
const items=[item(payload('notebook','Algebra idea')),item(highlight),item({...highlight,id:'plain',body:''}),item(payload('hidden','Saved note','trashed-document'),{parentDeleted:true})];

test('notes and highlights reuse one item identity and filter real context, color, title/body/quote',()=>{
  const base={view:'notes' as const,query:'',context:'all' as const,color:'all' as const,showUnavailable:false};
  assert.deepEqual(filterNotes(items,base).map(i=>i.id),['notebook','highlight']);
  assert.deepEqual(filterNotes(items,{...base,view:'highlights'}).map(i=>i.id),['highlight','plain']);
  assert.deepEqual(filterNotes(items,{...base,query:' CELL WALLS ',color:'blue',context:'documents'}).map(i=>i.id),['highlight']);
  assert.deepEqual(filterNotes(items,{...base,context:'notebook'}).map(i=>i.id),['notebook']);
  assert.deepEqual(filterNotes(items,{...base,documentId:'biology'}).map(i=>i.id),['highlight']);
  assert.deepEqual(filterNotes(items,{...base,showUnavailable:true}).map(i=>i.id),['notebook','highlight','hidden']);
});

test('conflict options never silently restore a cloud-deleted note or duplicate a local deletion',()=>{
  const base=item(highlight,{syncStatus:'conflict',conflict:{id:'highlight',reason:'revision',local:{operationId:'op',id:'highlight',expectedRevision:1,action:'put',payload:highlight},cloud:{id:'highlight',revision:2,deleted:false,payload:{...highlight,body:'Cloud text'}}}});
  assert.deepEqual(conflictChoices(base),{cloud:true,local:true,both:true});
  assert.deepEqual(conflictChoices({...base,parentDeleted:true}),{cloud:true,local:false,both:false});
  assert.deepEqual(conflictChoices({...base,conflict:{...base.conflict!,cloud:{...base.conflict!.cloud,deleted:true}}}),{cloud:true,local:false,both:true});
  assert.deepEqual(conflictChoices({...base,conflict:{...base.conflict!,cloud:{...base.conflict!.cloud,revision:0,deleted:true}}}),{cloud:true,local:true,both:true});
  assert.deepEqual(conflictChoices({...base,conflict:{...base.conflict!,local:{...base.conflict!.local,action:'remove'}}}),{cloud:true,local:true,both:false});
});
