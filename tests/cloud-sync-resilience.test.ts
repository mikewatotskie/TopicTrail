import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountCache, type CachePort } from '../src/core/services/cloud/cache_store';
import { CloudSyncEngine } from '../src/core/services/cloud/engine';
import { emptyStudyState, mergeStudyRecords, queueStudyMutation, acknowledgeStudyMutation, studyView, type StudyRecord } from '../src/core/services/cloud/study_state';
import { sha256 } from '../src/core/services/cloud/sha256';

test('counterexample: a queued Trash must still run when its earlier rename conflicts',()=>{
  const state=emptyStudyState();
  const initial:StudyRecord={kind:'document',id:'doc-1',revision:1,deleted:false,payload:{title:'Original'}};
  mergeStudyRecords(state,[initial]);
  queueStudyMutation(state,{operationId:'rename-a',kind:'document',id:initial.id,action:'put',payload:{title:'Offline rename'}});
  queueStudyMutation(state,{operationId:'trash-a',kind:'document',id:initial.id,action:'remove',payload:{title:'Offline rename'}});
  const otherDevice={...initial,revision:2,payload:{title:'Other device rename'}};
  mergeStudyRecords(state,[otherDevice]);
  acknowledgeStudyMutation(state,'rename-a',{status:'conflict',record:otherDevice});
  assert.equal(studyView(state,'document',initial.id)?.deleted,true,'explicit offline Trash is lost from the visible state');
  assert.ok(state.pending.some(op=>op.action==='remove'),'the engine must send the removal that overrides a concurrent rename');
});

test('counterexample: one download failure must not leave an already cached cloud-Trashed document visible',async()=>{
  const owner={project:'abcdefghijklmnopqrst',uid:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'};
  const bytes=new TextEncoder().encode('%PDF-1.7\nsynthetic review\n%%EOF\n');
  let snapshot:{revision:number;json:string|null}={revision:0,json:null};
  const files=new Map<string,Uint8Array>();
  const port:CachePort={path:(id,format)=>'review://'+id+'.'+format,readState:async()=>({...snapshot}),
    commit:async(expected,json,write)=>{if(expected!==snapshot.revision)return false;if(write)files.set(write.path,write.bytes);snapshot={revision:expected+1,json};return true;},
    readFile:async path=>files.get(path)??null,fileExists:async path=>files.has(path),readImport:async()=>bytes};
  const cache=createAccountCache(owner,port);
  const row=(suffix:string)=>({user_id:owner.uid,id:'doc-'+owner.uid+'-'+suffix,title:suffix,format:'pdf' as const,byte_size:bytes.length,sha256:sha256(bytes),imported_at:'2026-11-10T00:00:00.000Z',object_path:owner.uid+'/doc-'+owner.uid+'-'+suffix+'.pdf'});
  const cached=row('a'),broken=row('b');
  await cache.acceptRemote(cached,bytes);
  const tombstone:StudyRecord={kind:'document',id:cached.id,revision:1,deleted:true,payload:{title:'Trashed on device two'}};
  let studyPulls=0;
  const engine=new CloudSyncEngine({cache:()=>cache,session:async()=>({...owner,accessToken:'synthetic'}),legacy:{getAllDocuments:async()=>[]},readLegacy:async()=>bytes,
    remote:()=>({list:async()=>[cached,broken],upload:async()=>{throw Error('unused');},download:async()=>{throw Error('Synthetic individual object download failure');},listStudy:async()=>{studyPulls++;return [tombstone];},applyStudy:async()=>{throw Error('unused');}})});
  engine.select(owner);await engine.sync();engine.dispose();
  assert.ok(studyPulls>0,'an unrelated original-file failure prevents every metadata pull');
  assert.equal(await cache.getDocument(cached.id),null,'remote Trash should hide the cached document even when another download fails');
});

function queuedRemovalAfterTwoRenames(cloudRevision:number){
  const state=emptyStudyState();
  const initial:StudyRecord={kind:'document',id:'doc-1',revision:1,deleted:false,payload:{title:'Original'}};
  mergeStudyRecords(state,[initial]);
  for(const [operationId,action,title] of [['rename-a','put','Rename A'],['rename-b','put','Rename B'],['trash-a','remove','Rename B']] as const){
    queueStudyMutation(state,{operationId,kind:'document',id:initial.id,action,payload:{title}});
  }
  const cloud={...initial,revision:cloudRevision,payload:{title:'Other device state'}};
  mergeStudyRecords(state,[cloud]);acknowledgeStudyMutation(state,'rename-a',{status:'conflict',record:cloud});
  return state.pending.find(op=>op.action==='remove');
}

test('counterexample: multiple queued renames must not make the surviving Trash a future revision',()=>{
  const removal=queuedRemovalAfterTwoRenames(2);assert.ok(removal);
  // Exact deployed SQL removal predicate: expected > existing.revision OR expected < restored_revision.
  const serverWouldConflict=removal.expectedRevision>2||removal.expectedRevision<0;
  assert.equal(serverWouldConflict,false,'two offline renames leave a removal expecting a nonexistent future revision');
});

test('counterexample: speculative revisions must not let a stale Trash override another device explicit Restore',()=>{
  const removal=queuedRemovalAfterTwoRenames(3);assert.ok(removal);
  // Other device performed remove revision 2, then explicit restore revision 3.
  const serverWouldConflict=removal.expectedRevision>3||removal.expectedRevision<3;
  assert.equal(serverWouldConflict,true,'locally predicted revision 3 falsely looks like the user observed remote Restore revision 3');
});
