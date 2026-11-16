import test from 'node:test';
import assert from 'node:assert/strict';
import { NotesController } from '../src/features/notes/NotesController';
import { newNotePayload } from '../src/features/notes/note_selection';
import { SyncRateLimit, SyncRetryGate, syncDelayedMessage, type RetryWindow, type RetryWindowStore } from '../src/core/services/cloud/sync_retry';
import { createAnnotationRemote } from '../src/core/services/annotations/remote';
import { validateSupabaseConfiguration } from '../src/core/auth/supabase_config';
import type { AnnotationPort, AnnotationRecord, AnnotationRemote } from '../src/core/services/annotations/types';
const scope='abcdefghijklmnopqrst/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

test('a six-page notes library eventually syncs through a three-read window without restarting at page one',async()=>{
  const ctx=context(),session=await ctx.session(),config=validateSupabaseConfiguration(
    `https://${session.project}.supabase.co`,`sb_publishable_${'a'.repeat(30)}`);
  const records=Array.from({length:6},(_,i)=>{
    const note={...newNotePayload(),id:`note-${i}`,body:`Synthetic note ${i}`};
    return {id:note.id,revision:1,payload:note,deleted:false};
  });
  let now=Date.now(),reads=0,libraryCalls=0,firstPages=0;
  const fetcher:typeof fetch=async(_input,init)=>{
    if(++reads>3)return new Response(null,{status:429,headers:{'retry-after':new Date(now+60_000).toUTCString()}});
    const after=JSON.parse(String(init?.body)).p_after_id;
    if(!after)firstPages++;
    const row=records.find(item=>item.id>after);
    return Response.json(row?[{owner:session.uid,record:row}]:[]);
  };
  const controller=new NotesController(ctx,port(),async()=>{libraryCalls++;},async(signal,pages)=>
    createAnnotationRemote(config,session,signal,fetcher,pages),new SyncRetryGate(undefined,()=>now));
  try {
    for(let window=0;window<8;window++){
      await controller.sync();
      if(controller.getSnapshot().phase==='ready')break;
      assert.equal(controller.getSnapshot().phase,'waiting');now+=60_001;reads=0;
    }
    assert.equal(controller.getSnapshot().phase,'ready');
    assert.equal(controller.getSnapshot().items.length,6);assert.equal(libraryCalls,1);assert.equal(firstPages,2);
  }finally{controller.dispose();}
});

test('two local devices receive one colored highlight after a restart during a shared account cooldown', async () => {
  let now = Date.now(), retryWindow: RetryWindow | null = null;
  const storage: RetryWindowStore = {
    read: async () => retryWindow,
    extend: async window => (retryWindow = window),
    clear: async () => { retryWindow = null; },
  };
  const gate = () => new SyncRetryGate(storage, () => now);
  const noteDisk = port(), hash = 'a'.repeat(64);
  const ctx = { ...context(), parent: async () => ({hash, format: 'pdf' as const, deleted: false}) };
  const note = { ...newNotePayload(), documentId:'doc-1', documentHash:hash, format:'pdf' as const,
    color:'blue' as const, body:'My offline note', location:{unit:'page' as const,index:2},
    anchor:{kind:'text' as const, version:1 as const, surface:'pdf-text' as const, textHash:hash,
      ranges:[{blockId:'p-1',startUtf16:0,endUtf16:4}], quote:'Keep', prefix:'', suffix:''} };
  const rows = new Map<string,AnnotationRecord>(), operations:string[]=[];
  let networkCalls=0;
  const remote:AnnotationRemote = {
    list:async()=>{networkCalls++;return [...rows.values()];},
    apply:async op=>{
      networkCalls++;operations.push(op.operationId);
      if(operations.length===1)throw new SyncRateLimit(now+60_000);
      const record={id:op.id,revision:1,deleted:false,payload:op.payload};
      rows.set(op.id,record);return {status:'applied',record};
    },
  };
  const first=new NotesController(ctx,noteDisk,async()=>{},async()=>remote,gate());
  await first.store.save(note);
  const original=(await first.store.read()).pending[0].operationId;
  await first.sync();
  assert.equal(first.getSnapshot().message,syncDelayedMessage);assert.equal(first.getSnapshot().pending,1);
  first.dispose();
  const callsBeforeRestart=networkCalls;
  const restarted=new NotesController(ctx,noteDisk,async()=>{},async()=>remote,gate());
  const second=new NotesController(ctx,port(),async()=>{},async()=>remote);
  try {
    await Promise.all([restarted.sync(),restarted.sync()]);
    assert.equal(networkCalls,callsBeforeRestart);
    assert.equal(restarted.getSnapshot().items[0].payload.body,note.body);
    now+=60_001;
    await restarted.sync();await second.sync();
    assert.deepEqual(operations,[original,original]);assert.equal(rows.size,1);
    const received=second.getSnapshot().items;
    assert.equal(received.length,1);assert.deepEqual(received[0].payload.anchor,note.anchor);
    assert.equal(received[0].payload.color,note.color);assert.equal(received[0].payload.body,note.body);
    assert.equal((await restarted.store.read()).pending.length,0);
  } finally { restarted.dispose();second.dispose(); }
});
function port():AnnotationPort{let revision=0,json:string|null=null;return {read:async()=>({revision,json}),commit:async(expected,value)=>{if(expected!==revision)return false;json=value;revision++;return true;}};}
function context(){let active=true;return {scope,epoch:1,account:true,accountLabel:'Synthetic QA',checkActive(){if(!active)throw Error('Changed account');},parent:async()=>null,guestParent:async()=>null,copyGuestDocuments:async()=>new Map(),session:async()=>({project:'abcdefghijklmnopqrst',uid:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',accessToken:'synthetic'}),fetcher:fetch,change(){active=false;}};}
test('offline note survives restart and sync retries the same operation after a lost acknowledgement',async()=>{
 const storage=port(),ctx=context();let online=false,ackLost=true;const applied=new Map<string,AnnotationRecord>(),operations:string[]=[];
 const remote:AnnotationRemote={list:async()=>{if(!online)throw Error('offline');return [...applied.values()];},apply:async op=>{operations.push(op.operationId);const row=applied.get(op.id)??{id:op.id,revision:1,deleted:false,payload:op.payload};applied.set(row.id,row);if(ackLost){ackLost=false;throw Error('lost acknowledgement');}return {status:'applied',record:row};}};
 let controller=new NotesController(ctx,storage,async()=>{},async()=>remote);
 await controller.run(store=>store.save({...newNotePayload(),body:'Offline notebook note'}));await controller.sync();
 assert.equal(controller.getSnapshot().items[0].payload.body,'Offline notebook note');assert.equal(controller.getSnapshot().phase,'error');assert.equal((await controller.store.read()).pending.length,1);controller.dispose();
 controller=new NotesController(ctx,storage,async()=>{},async()=>remote);online=true;await controller.sync();assert.equal((await controller.store.read()).pending.length,1);
 await controller.sync();assert.equal((await controller.store.read()).pending.length,0);assert.equal(controller.getSnapshot().items[0].syncStatus,'synced');
 assert.equal(operations.length,2);assert.equal(operations[0],operations[1]);assert.equal(applied.size,1);controller.dispose();
});
test('an old account response cannot write or reveal notes after account switch',async()=>{
 const storage=port(),ctx=context();let respond!:(value:AnnotationRecord[])=>void;
 const remote:AnnotationRemote={list:()=>new Promise(resolve=>{respond=resolve;}),apply:async()=>{throw Error('must not upload');}};
 const controller=new NotesController(ctx,storage,async()=>{},async()=>remote);const running=controller.sync();
 while(!respond)await new Promise(resolve=>setTimeout(resolve,0));ctx.change();controller.dispose();
 respond([{id:'private',revision:1,deleted:false,payload:{...newNotePayload(),id:'private',body:'Account A private note'}}]);await running;
 assert.deepEqual(await storage.read(),{json:null,revision:0});assert.equal(controller.getSnapshot().items.length,0);
});
test('document upload completes before note upload and Guest never invokes remote',async()=>{
 const events:string[]=[];const controller=new NotesController(context(),port(),async()=>{events.push('documents');},async()=>{events.push('notes');return {list:async()=>[],apply:async()=>{throw Error('unexpected');}};});
 await controller.sync();assert.deepEqual(events,['documents','notes']);controller.dispose();
 const guest=new NotesController({...context(),scope:'guest',account:false},port(),async()=>{throw Error('Guest library must remain local');},async()=>{throw Error('Guest notes must remain local');});
 await guest.run(store=>store.save({...newNotePayload(),body:'Guest private note'}));await guest.sync();assert.equal(guest.getSnapshot().items[0].syncStatus,'local');guest.dispose();
});
test('a parent-Trash conflict retains the attached edit and does not block independent notes in the outbox',async()=>{
 const ctx=context();let parentDeleted=false;const hash='a'.repeat(64),rows=new Map<string,AnnotationRecord>(),uploaded:string[]=[];
 const remote:AnnotationRemote={list:async()=>[...rows.values()],apply:async op=>{
   uploaded.push(op.id);if(op.payload.documentId)return {status:'conflict',reason:'parent-trashed',record:{id:op.id,revision:0,deleted:true,payload:op.payload}};
   const record={id:op.id,revision:1,deleted:false,payload:op.payload};rows.set(op.id,record);return {status:'applied',record};
 }};
 const controller=new NotesController({...ctx,parent:async()=>({hash,format:'pdf',deleted:parentDeleted})},port(),async()=>{parentDeleted=true;},async()=>remote);
 const attached={...newNotePayload(),id:'attached',body:'Preserve interrupted note',documentId:'doc-1',documentHash:hash,format:'pdf' as const};
 await controller.store.save(attached);await controller.store.save({...newNotePayload(),id:'standalone',body:'Independent notebook note'});
 await controller.sync();const state=await controller.store.read();assert.deepEqual(uploaded,['attached','standalone']);assert.equal(state.pending.length,0);
 assert.equal(state.conflicts[0].local.payload.body,attached.body);assert.equal(state.conflicts[0].reason,'parent-trashed');
 assert.equal(controller.getSnapshot().items.find(item=>item.id==='standalone')?.syncStatus,'synced');assert.equal(controller.getSnapshot().items.find(item=>item.id==='attached')?.parentDeleted,true);
 controller.dispose();
});
