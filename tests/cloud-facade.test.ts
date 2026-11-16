import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentFacade } from '../src/core/services/cloud/facade';
import type { DocumentStorageApi } from '../src/core/services/document_storage_contract';
test('captured account receives a write; switch prevents stale publication', async()=>{
  let epoch=1; let complete!:()=>void; let writes=0;
  const store={guestUploadPolicy:'disabled',saveDocument:async()=>{writes++;await new Promise<void>(r=>complete=r);return {id:'a'};}} as unknown as DocumentStorageApi;
  const facade=createDocumentFacade(()=>({key:'a',epoch,uid:'a',store}),()=>{});
  const task=facade.saveDocument({originalPath:'source',title:'Doc',format:'pdf' as any,attempt:{attemptId:'one',actor:{kind:'account',uid:'a'}}});
  epoch=2;complete();await assert.rejects(task,/changed/i);assert.equal(writes,1);
});
test('wrong account actor is rejected before write and singleton follows new selections', async()=>{
  let key='a';let writes=0;
  const stores={a:{guestUploadPolicy:'disabled',getAllDocuments:async()=>['a'],saveDocument:async()=>{writes++;}},b:{guestUploadPolicy:'disabled',getAllDocuments:async()=>['b']}};
  const facade=createDocumentFacade(()=>({key,epoch:1,uid:key,store:stores[key as 'a'|'b'] as unknown as DocumentStorageApi}),()=>{});
  assert.deepEqual(await facade.getAllDocuments(),['a']);key='b';assert.deepEqual(await facade.getAllDocuments(),['b']);
  await assert.rejects(facade.saveDocument({originalPath:'x',title:'x',format:'pdf' as any,attempt:{attemptId:'x',actor:{kind:'account',uid:'a'}}}),/changed/i);
  assert.equal(writes,0);
});
