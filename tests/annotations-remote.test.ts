import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationRemote } from '../src/core/services/annotations/remote';
import { SyncRateLimit } from '../src/core/services/cloud/sync_retry';
import { validateSupabaseConfiguration } from '../src/core/auth/supabase_config';
import type { AnnotationMutation, AnnotationRecord } from '../src/core/services/annotations/types';
const project='abcdefghijklmnopqrst',uid='11111111-1111-1111-1111-111111111111';
const config=validateSupabaseConfiguration(`https://${project}.supabase.co`,`sb_publishable_${'a'.repeat(30)}`);
const session={project,uid,accessToken:'synthetic'};
const record:AnnotationRecord={id:'note-1',revision:1,deleted:false,payload:{id:'note-1',documentId:null,documentHash:null,format:null,location:null,anchor:null,title:'Note',body:'A thought',color:'yellow',createdAt:'2026-11-11T00:00:00.000Z',updatedAt:'2026-11-11T00:00:00.000Z'}};
const mutation:AnnotationMutation={operationId:'op-1',id:'note-1',expectedRevision:0,action:'put',payload:record.payload};
test('notes RPC preserves a 429 and Retry-After for both reads and writes',async()=>{
  const remote=createAnnotationRemote(config,session,undefined,async()=>new Response(null,{status:429,headers:{'Retry-After':'90'}}));
  const start=Date.now();
  const limited=(error:unknown)=>error instanceof SyncRateLimit && error.retryAt!==null && error.retryAt>=start+90_000 && error.retryAt<=Date.now()+90_000;
  await assert.rejects(remote.list(),limited);await assert.rejects(remote.apply(mutation),limited);
});
test('annotation remote uses separate owner-checked feed and follows capped keyset pages through empty',async()=>{
  const calls:{url:string;body:any;headers:any}[]=[];
  const remote=createAnnotationRemote(config,session,undefined,(async(input,init)=>{calls.push({url:String(input),body:JSON.parse(String(init!.body)),headers:init!.headers});return Response.json(calls.length===1?[{owner:uid,record}]:[]);}) as typeof fetch);
  assert.deepEqual(await remote.list(),[record]);assert.equal(calls.length,2);assert.equal(calls[1].body.p_after_id,record.id);
  assert.ok(calls.every(c=>c.url.endsWith('/rpc/topictrail_annotations_v1_list')));assert.equal(calls[0].headers.Authorization,'Bearer synthetic');
});
test('annotation remote snapshots existing session and preserves mutation IDs across uncertain retries',async()=>{
  const mutable={...session};const bodies:string[]=[];const headers:string[]=[];
  const remote=createAnnotationRemote(config,mutable,undefined,(async(_,init)=>{bodies.push(String(init!.body));headers.push((init!.headers as Record<string,string>).Authorization);if(bodies.length===1)throw Error('private failure');return Response.json({owner:uid,status:'applied',duplicate:true,record});}) as typeof fetch);
  mutable.uid='22222222-2222-2222-2222-222222222222';mutable.accessToken='different';
  await assert.rejects(remote.apply(mutation),/retry/i);const reply=await remote.apply(mutation);assert.equal(reply.duplicate,true);assert.equal(bodies[0],bodies[1]);assert.deepEqual(headers,['Bearer synthetic','Bearer synthetic']);
});
test('annotation remote rejects wrong owner, wrong identity, repeat cursors, oversized responses and old-session replies',async()=>{
  const create=(answer:unknown)=>createAnnotationRemote(config,session,undefined,(async()=>Response.json(answer)) as typeof fetch);
  await assert.rejects(create([{owner:'other',record}]).list(),/invalid/i);
  await assert.rejects(create([{owner:uid,record}]).list(),/invalid/i);
  await assert.rejects(create({owner:uid,status:'applied',record:{...record,id:'different'}}).apply(mutation),/invalid/i);
  const big=createAnnotationRemote(config,session,undefined,(async()=>new Response('[]',{headers:{'content-length':'5000000'}})) as typeof fetch);await assert.rejects(big.list(),/invalid/i);
  const cancel=new AbortController();const pending=createAnnotationRemote(config,session,cancel.signal,(async()=>{cancel.abort();return Response.json({owner:uid,status:'applied',record});}) as typeof fetch);await assert.rejects(pending.apply(mutation),/cancel/i);
});
test('annotation remote reports unavailable backend without discarding local state or making legacy calls',async()=>{
  const calls:string[]=[];const remote=createAnnotationRemote(config,session,undefined,(async(url)=>{calls.push(String(url));return new Response('',{status:404});}) as typeof fetch);
  await assert.rejects(remote.list(),/saved.*device|not.*available/i);assert.equal(calls.length,1);assert.ok(!calls[0].includes('topictrail_sync_'));
});
