import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyAnnotationState } from '../src/core/services/annotations/validation';
import { emptyStudyState } from '../src/core/services/cloud/study_state';
import { unpackAccountEnvelope } from '../src/core/services/cloud/cache_envelope';
import { countsFor, emptyBookmarks, receiptKey, type StudySnapshot } from '../src/core/services/transfer/study_archive_state';
import { restoreStudyArchive } from '../src/core/services/transfer/restore';
import { DocumentRepository } from '../src/core/services/document_repository';
import type { StudyTransferMetadata } from '../src/core/services/study_transfer_native';

const uid='11111111-1111-1111-1111-111111111111';
const scope='abcdefghijklmnopqrst/'+uid;
const date='2026-11-11T00:00:00.000Z';
const digest='a'.repeat(64);
function sample(account=false) {
  const owner=account?scope:'guest';
  const id=account?'doc-'+uid+'-a':'doc-1';
  const name=id+'.pdf';
  const path=account?'topictrail-cloud-v1/'+scope+'/'+name:'documents/'+name;
  const document={id,title:'Synthetic article',format:'pdf',filePath:name,importedAt:date,fileSize:64};
  const study=emptyStudyState();
  study.pending.push({operationId:'trash-op-1',kind:'document',id,expectedRevision:1,action:'remove',payload:{title:'Synthetic article'}});
  const payload={id:'note-1',documentId:id,documentHash:digest,format:'pdf' as const,location:{unit:'page' as const,index:1},
    anchor:{kind:'text' as const,version:1 as const,surface:'pdf-text' as const,textHash:digest,ranges:[{blockId:'page-1',startUtf16:0,endUtf16:4}],quote:'Read',prefix:'',suffix:''},
    title:'Synthetic note',body:'Read again',color:'green' as const,createdAt:date,updatedAt:date};
  const notes=emptyAnnotationState(owner);
  notes.records.push({id:payload.id,revision:1,deleted:false,payload});
  notes.drafts.push({id:'draft-1',payload,updatedAt:date});
  if(account)notes.pending.push({id:payload.id,operationId:'note-op-1',expectedRevision:1,action:'put',payload});
  const library=account ? {version:2,account:scope,entries:[{document,hash:digest,synced:true,hidden:false}],receipts:[{attemptId:'orig-op',documentId:id}],study}
    : {version:3,documents:[document],guestImports:[],importAttempts:[{attemptId:'orig-op',documentId:id}]};
  const progress:Record<string,string>={};
  if(!account)progress['guest/progress/pdf/'+id]=JSON.stringify({version:1,documentId:id,format:'pdf',page:2,totalPages:5});
  const base={version:1 as const,scope:owner,library:JSON.stringify(library),notes:JSON.stringify(notes),bookmarks:account?null:emptyBookmarks(),progress,
    originals:[{path,bytes:64,sha256:digest}]};
  const data:StudySnapshot={...base,counts:countsFor(base)};
  return {ticket:'synthetic',metadataJson:JSON.stringify(data),files:[...base.originals]};
}
function fixture() {
  const rows=new Map<string,string>();
  let promotions=0;
  const store:StudyTransferMetadata={read:async keys=>keys.map(k=>rows.get(k)??null),compareAndSet:async(keys,before,next)=>{
    if(keys.some((k,i)=>(rows.get(k)??null)!==before[i]))return false;
    keys.forEach((k,i)=>rows.set(k,next[i]));return true;
  }};
  const native={async preflightFiles(){},async promoteFiles(){promotions++;}};
  return {rows,store,native,promotions:()=>promotions};
}
const owned=(name:string)=>'file:///data/user/0/com.teamjam.topictrail/files/documents/'+name;

test('Guest restore binds file paths to the new install, preserves anchors/drafts/progress, and skips a replay after later edits',async()=>{
  const a=sample(), f=fixture();
  await restoreStudyArchive(a,'guest',()=>{},f.native,f.store,owned);
  assert.equal(JSON.parse(f.rows.get('guest/documents')!).documents[0].filePath,owned('doc-1.pdf'));
  const notes=JSON.parse(JSON.parse(f.rows.get('notes/guest')!).json);
  assert.equal(notes.records[0].payload.color,'green');assert.equal(notes.records[0].payload.anchor.quote,'Read');assert.equal(notes.drafts.length,1);
  assert.equal(JSON.parse(f.rows.get('guest/progress/pdf/doc-1')!).page,2);
  f.rows.set('guest/progress/pdf/doc-1','updated');
  assert.equal((await restoreStudyArchive(a,'guest',()=>{},f.native,f.store,owned)).repeated,true);
  assert.equal(f.rows.get('guest/progress/pdf/doc-1'),'updated');assert.equal(f.promotions(),1);
});
test('account restores preserve Trash, immutable IDs and queued operations and cannot enter another scope',async()=>{
  const a=sample(true), f=fixture();
  await assert.rejects(restoreStudyArchive(a,'guest',()=>{},f.native,f.store,owned));
  await assert.rejects(restoreStudyArchive(a,scope.replaceAll('1','2'),()=>{},f.native,f.store,owned));
  assert.equal(f.rows.size,0);
  const restored=await restoreStudyArchive(a,scope,()=>{},f.native,f.store,owned);
  assert.equal(restored.counts.trash,1);
  const cache=JSON.parse(unpackAccountEnvelope(f.rows.get('account/'+scope+'/library')!).json!);
  assert.equal(cache.study.pending[0].operationId,'trash-op-1');assert.equal(cache.receipts[0].attemptId,'orig-op');
  assert.equal(JSON.parse(JSON.parse(f.rows.get('notes/'+scope)!).json).pending[0].operationId,'note-op-1');
  assert.equal(f.rows.has('notes/guest'),false);
});
test('interrupted file promotion and a switched account publish no metadata, then a retry finishes once',async()=>{
  const a=sample(true), f=fixture();let active=true;
  await assert.rejects(restoreStudyArchive(a,scope,()=>{}, {...f.native,async promoteFiles(){throw Error('interrupted');}},f.store,owned));
  await assert.rejects(restoreStudyArchive(a,scope,()=>{if(!active)throw Error('changed');},{...f.native,async promoteFiles(){active=false;}},f.store,owned));
  assert.equal(f.rows.size,0);
  await restoreStudyArchive(a,scope,()=>{},f.native,f.store,owned);assert.ok(f.rows.has(receiptKey(scope,a.metadataJson)));
});
test('inventory, paths and conflicting same-ID metadata are checked before promotion',async()=>{
  const a=sample(),f=fixture();
  for(const edit of [(data:StudySnapshot)=>{data.counts.notes=999;},(data:StudySnapshot)=>{data.originals[0].path='../escape';}]){
    const data:StudySnapshot=JSON.parse(a.metadataJson);edit(data);
    await assert.rejects(restoreStudyArchive({...a,metadataJson:JSON.stringify(data)},'guest',()=>{},f.native,f.store,owned));
  }
  await restoreStudyArchive(a,'guest',()=>{},f.native,f.store,owned);const previous=[...f.rows];
  const data:StudySnapshot=JSON.parse(a.metadataJson);const lib=JSON.parse(data.library);lib.documents[0].title='Another document';data.library=JSON.stringify(lib);
  await assert.rejects(restoreStudyArchive({...a,metadataJson:JSON.stringify(data)},'guest',()=>{},f.native,f.store,owned),/different versions/);
  assert.deepEqual([...f.rows],previous);assert.equal(f.promotions(),1);
});

test('an unavailable original is reported by name and its record and annotations remain recoverable',async()=>{
  const archive=sample();
  const data:StudySnapshot=JSON.parse(archive.metadataJson);
  const path=data.originals[0].path;
  data.originals=[{path,bytes:null,sha256:null}];
  data.counts=countsFor(data);
  const f=fixture();
  const result=await restoreStudyArchive({...archive,metadataJson:JSON.stringify(data),files:[]},'guest',()=>{},f.native,f.store,owned);
  assert.deepEqual(result.missing,[path]);
  assert.equal(result.counts.originals,0);
  assert.equal(result.counts.missing,1);
  assert.equal(JSON.parse(f.rows.get('guest/documents')!).documents.length,1);
  assert.equal(JSON.parse(JSON.parse(f.rows.get('notes/guest')!).json).records.length,1);
});

test('a concurrent cache change causes restore to verify and promote originals again before committing',async()=>{
  const f=fixture();
  const opened=sample(true);
  let checks=0;
  const store={...f.store,compareAndSet:async(keys:string[],before:(string|null)[],next:string[])=>{
    checks++;
    if(checks===1)return false;
    return f.store.compareAndSet(keys,before,next);
  }};
  await restoreStudyArchive(opened,scope,()=>{},f.native,store,owned);
  assert.equal(checks,2);
  assert.equal(f.promotions(),2);
});

test('Guest delete waits until a restore has published and reloaded its document catalog',async()=>{
  const input=JSON.parse(sample().metadataJson) as StudySnapshot;
  let json:string|null=null;
  let removed=false;
  const guest=new DocumentRepository({
    readMetadata:async()=>json,writeMetadata:async value=>{json=value;},
    copyToDocuments:async()=>{throw Error('unexpected copy');},fileExists:async()=>true,
    removeFile:async()=>{removed=true;},
  });
  let begin!:()=>void;
  let applied!:()=>void;
  const started=new Promise<void>(resolve=>{begin=resolve;});
  const release=new Promise<void>(resolve=>{applied=resolve;});
  const restoring=guest.runStudyTransfer(async()=>{begin();await release;json=input.library;});
  await started;
  const deleting=guest.deleteDocument('doc-1');
  assert.equal(removed,false);
  applied();
  await Promise.all([restoring,deleting]);
  assert.equal(removed,true);
  assert.equal((await guest.getAllDocuments()).length,0);
});
