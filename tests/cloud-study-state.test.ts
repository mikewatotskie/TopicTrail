import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyStudyState, queueStudyMutation, studyView, acknowledgeStudyMutation, mergeStudyRecords, decodeStudyState, resolveStudyConflict } from '../src/core/services/cloud/study_state';
const doc={kind:'document' as const,id:'doc-1',revision:1,deleted:false,payload:{title:'Cloud'}};
test('pending state survives serialization and uncertain replies preserve the same operation id',()=>{
 const state=emptyStudyState();mergeStudyRecords(state,[doc]);queueStudyMutation(state,{operationId:'op-1',kind:'document',id:doc.id,action:'put',payload:{title:'Local'}});
 const recovered=decodeStudyState(JSON.parse(JSON.stringify(state)));
 assert.equal(studyView(recovered,'document',doc.id)?.payload.title,'Local');assert.equal(recovered.pending[0].operationId,'op-1');
 acknowledgeStudyMutation(recovered,'op-1',{status:'applied',record:{...doc,revision:2,payload:{title:'Local'}},duplicate:true});
 assert.equal(recovered.pending.length,0);assert.equal(studyView(recovered,'document',doc.id)?.revision,2);
});
test('conflict preserves local alternative until explicit cloud or local choice',()=>{
 const state=emptyStudyState();mergeStudyRecords(state,[doc]);queueStudyMutation(state,{operationId:'op-1',kind:'document',id:doc.id,action:'put',payload:{title:'Local'}});
 acknowledgeStudyMutation(state,'op-1',{status:'conflict',record:{...doc,revision:2,payload:{title:'Other device'}}});
 assert.equal(state.conflicts.length,1);assert.equal(state.conflicts[0].local.payload.title,'Local');
 assert.equal(studyView(state,'document',doc.id)?.payload.title,'Other device');
 resolveStudyConflict(state,'document',doc.id,'local','op-2');assert.equal(state.pending[0].expectedRevision,2);assert.equal(studyView(state,'document',doc.id)?.payload.title,'Local');
});
test('old pulls cannot replace newer revisions and remove requires explicit restore',()=>{
 const state=emptyStudyState();mergeStudyRecords(state,[{...doc,revision:3,deleted:true}]);mergeStudyRecords(state,[doc]);
 assert.equal(studyView(state,'document',doc.id)?.deleted,true);
 assert.throws(()=>queueStudyMutation(state,{operationId:'op-1',kind:'document',id:doc.id,action:'put',payload:{title:'Unsafe resurrection'}}));
 queueStudyMutation(state,{operationId:'op-2',kind:'document',id:doc.id,action:'restore',payload:{title:'Restored'}});
 assert.equal(studyView(state,'document',doc.id)?.deleted,false);
});
test('corrupt records and unsupported state are rejected without resetting data',()=>{
 assert.throws(()=>decodeStudyState({version:999,records:[],pending:[],conflicts:[]}));
 assert.throws(()=>decodeStudyState({version:1,records:[{...doc,revision:-1}],pending:[],conflicts:[]}));
});


test('a duplicate stale conflict receipt keeps newer cloud state and cannot restore via rename choice',()=>{
 const state=emptyStudyState();mergeStudyRecords(state,[doc]);queueStudyMutation(state,{operationId:'op-1',kind:'document',id:doc.id,action:'put',payload:{title:'Local'}});
 mergeStudyRecords(state,[{...doc,revision:5,deleted:true}]);
 acknowledgeStudyMutation(state,'op-1',{status:'conflict',duplicate:true,record:{...doc,revision:2}});
 assert.equal(state.conflicts[0].cloud.revision,5);assert.equal(state.conflicts[0].cloud.deleted,true);
 assert.throws(()=>resolveStudyConflict(state,'document',doc.id,'local','op-2'),/Restore/);
 assert.equal(state.conflicts.length,1);assert.equal(state.pending.length,0);
});

test('new cloud mutations reject unsupported controls but allow ordinary multiline text',()=>{
 const state=emptyStudyState();
 assert.throws(()=>queueStudyMutation(state,{operationId:'control-title',kind:'document',id:'document-a',action:'put',payload:{title:'Bad\u0001title'}}),/control characters/);
 assert.equal(state.pending.length,0);
 queueStudyMutation(state,{operationId:'multiline-title',kind:'document',id:'document-a',action:'put',payload:{title:'Good\nTitle\tNotes'}});
 assert.equal(state.pending.length,1);
});
