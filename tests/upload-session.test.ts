import assert from 'node:assert/strict';
import test from 'node:test';
import { UploadSession, uploadAction } from '../src/features/upload/upload_session';
import { ImportResult, type ImportAttempt, type GuestAllowance } from '../src/core/services/document_import_contract';
import type { Document } from '../src/core/models/document';
const file = {uri:'selected.pdf',name:'Course.pdf',lastModified:0};
const document = { id:'saved' } as Document;
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; }
function fixture(enabled=false) {
 const calls:string[]=[]; const attempts:ImportAttempt[]=[]; let allowance:GuestAllowance={kind:'ready',used:0,remaining:2};
 const picker=deferred<typeof file|null>(); const imported=deferred<ImportResult>();
 const owner=new UploadSession({policy:enabled?'two_guest_successes_v1':'disabled',pick:()=>{calls.push('pick');return picker.promise},discard:uri=>calls.push('discard:'+uri),importFile:(_u,_n,a)=>{attempts.push(a);return imported.promise},allowance:async()=>{calls.push('allowance');return allowance},lookup:async()=>({kind:'uncommitted'})});
 return {owner,calls,picker,imported,attempts,setAllowance:(next:GuestAllowance)=>{allowance=next}};
}
test('disabled chooser starts synchronously, duplicates share promise, route lifetime retains selection',async()=>{
 const f=fixture();f.owner.ensure();const picking=f.owner.pick({kind:'guest'});assert.deepEqual(f.calls,['pick']);assert.equal(f.owner.pick({kind:'guest'}),picking);
 f.picker.resolve(file);await picking;const id=f.owner.getSnapshot().sessionId;f.owner.ensure();assert.equal(f.owner.getSnapshot().asset,file);assert.equal(f.owner.getSnapshot().sessionId,id);
});
test('enabled unknown/recovery/exhausted gate before picker; known slot preserves user activation',async()=>{
 const f=fixture(true);f.owner.ensure();await f.owner.pick({kind:'guest'});assert.deepEqual(f.calls,[]);assert.equal(f.owner.getSnapshot().prompt,'unavailable');
 await f.owner.refresh();const p=f.owner.pick({kind:'guest'});assert.deepEqual(f.calls,['allowance','pick']);f.picker.resolve(file);await p;
 for(const allowance of [{kind:'ready',used:2,remaining:0},{kind:'recovery_required'}] as GuestAllowance[]){f.setAllowance(allowance);await f.owner.refresh();await f.owner.pick({kind:'guest'});assert.equal(f.calls.filter(c=>c==='pick').length,1);}
});
test('submit snapshots actor, shares lock, retains attempt for account retry and background result',async()=>{
 const f=fixture();f.owner.ensure();const p=f.owner.pick({kind:'guest'});f.picker.resolve(file);await p;
 const actor:{kind:'account';uid:string}={kind:'account',uid:'first'};const a=f.owner.submit(actor);const b=f.owner.submit({kind:'guest'});assert.equal(a,b);actor.uid='changed';await Promise.resolve();await Promise.resolve();assert.equal(f.attempts[0].actor.kind,'account');assert.deepEqual(f.attempts[0].actor,{kind:'account',uid:'first'});
 f.imported.resolve(new ImportResult(false,undefined,'temporary',false,'retry'));await a;const id=f.attempts[0].attemptId;await f.owner.submit({kind:'account',uid:'second'});assert.equal(f.attempts[1].attemptId,id);assert.deepEqual(f.attempts[1].actor,{kind:'account',uid:'second'});
});
test('cancel rejects stale auth hint and late picker releases staging without overwriting next session',async()=>{
 const f=fixture();const id=f.owner.ensure();const p=f.owner.pick({kind:'guest'});f.owner.cancel();const next=f.owner.ensure();assert.notEqual(next,id);assert.equal(f.owner.matches(id),false);f.picker.resolve(file);await p;assert.equal(f.owner.getSnapshot().asset,null);assert.ok(f.calls.includes('discard:selected.pdf'));assert.equal(f.owner.matches(next),true);
});
test('owner disposal releases selection and offscreen completion remains recorded until explicit cancel',async()=>{
 const f=fixture();f.owner.ensure();const p=f.owner.pick({kind:'guest'});f.picker.resolve(file);await p;const importing=f.owner.submit({kind:'guest'});f.imported.resolve(new ImportResult(true,document));await importing;assert.equal(f.owner.getSnapshot().result?.document,document);f.owner.dispose();assert.ok(f.calls.includes('discard:selected.pdf'));
});
test('typed outcomes expose honest actions including first success, replay, conflict, invalid and retry',()=>{
 assert.equal(uploadAction(new ImportResult(true,document)),'open');assert.equal(uploadAction(new ImportResult(true,document,undefined,false,'committed')),'open');
 for(const [code,action] of [['already_deleted','library'],['retry','retry'],['reselect','reselect'],['storage_conflict','conflict'],['guest_limit','limit'],['guest_usage_recovery','unavailable']] as const)assert.equal(uploadAction(new ImportResult(false,undefined,'',false,code)),action);
});

test('pending picker/import locks survive Cancel and communicate pending state to next session',async()=>{
 const f=fixture();f.owner.ensure();const p=f.owner.pick({kind:'guest'});f.owner.cancel();f.owner.ensure();assert.equal(f.owner.getSnapshot().picking,true);assert.equal(f.owner.pick({kind:'guest'}),p);f.picker.resolve(file);await p;assert.equal(f.owner.getSnapshot().picking,false);
 const next=f.owner.pick({kind:'guest'});await next;const importing=f.owner.submit({kind:'guest'});f.owner.cancel();f.owner.ensure();assert.equal(f.owner.getSnapshot().processing,true);await f.owner.pick({kind:'guest'});assert.equal(f.calls.filter(c=>c==='pick').length,2);f.imported.resolve(new ImportResult(false,undefined,'temporary',false,'retry'));await importing;assert.equal(f.owner.getSnapshot().processing,false);
});
test('uncertain lookup fails closed before saving and verified receipt opens without staged bytes',async()=>{
 let saves=0;let lookupFails=true;const owner=new UploadSession({policy:'disabled',pick:async()=>file,discard(){},allowance:async()=>({kind:'disabled'}),lookup:async()=>{if(lookupFails)throw Error('unreadable');return {kind:'committed',document}},importFile:async()=>{saves++;return new ImportResult(false)}});owner.ensure();await owner.pick({kind:'guest'});await owner.submit({kind:'guest'});assert.equal(saves,0);assert.equal(uploadAction(owner.getSnapshot().result),'retry');lookupFails=false;await owner.submit({kind:'guest'});assert.equal(saves,0);assert.equal(owner.getSnapshot().result?.code,'committed');
});

for(const kind of ['committed','deleted'] as const)test(`selected uncertain ${kind} attempt reconciles before exhausted allowance without source IO`,async()=>{
 let full=false,received=false,saves=0;const owner=new UploadSession({policy:'two_guest_successes_v1',pick:async()=>file,discard(){},allowance:async()=>({kind:'ready',used:full?2:1,remaining:full?0:1}),lookup:async()=>received?(kind==='committed'?{kind,document}:{kind}):{kind:'uncommitted'},importFile:async()=>{saves++;return new ImportResult(false,undefined,'uncertain commit',false,'retry')}});owner.ensure();await owner.refresh();await owner.pick({kind:'guest'});const attempt=owner.getSnapshot().attemptId;await owner.submit({kind:'guest'});full=true;received=true;await owner.refresh();await owner.submit({kind:'guest'});assert.equal(owner.getSnapshot().attemptId,attempt);assert.equal(saves,1);assert.equal(uploadAction(owner.getSnapshot().result),kind==='committed'?'open':'library');assert.equal(owner.getSnapshot().prompt,null);
});

test('completion releases large selected asset and staging but keeps replay/open result and allows new attempt',async()=>{
 const f=fixture();f.owner.ensure();let p=f.owner.pick({kind:'guest'});f.picker.resolve(file);await p;const old=f.owner.getSnapshot().attemptId;const importing=f.owner.submit({kind:'guest'});f.imported.resolve(new ImportResult(true,document));await importing;assert.equal(f.owner.getSnapshot().asset,null);assert.equal(f.owner.getSnapshot().result?.document,document);assert.deepEqual(f.calls.filter(c=>c.startsWith('discard:')),['discard:selected.pdf']);p=f.owner.pick({kind:'guest'});await p;assert.notEqual(f.owner.getSnapshot().attemptId,old);assert.equal(f.owner.getSnapshot().result,undefined);
});

test('enabled guest lookup failure invalidates stale ready allowance and exposes unavailable recovery without saving',async()=>{
 let unreadable=false,checks=0,saves=0;const owner=new UploadSession({policy:'two_guest_successes_v1',pick:async()=>file,discard(){},allowance:async()=>{checks++;if(unreadable)throw Error('metadata unreadable');return {kind:'ready',used:1,remaining:1}},lookup:async()=>{throw Error('metadata unreadable')},importFile:async()=>{saves++;return new ImportResult(false)}});owner.ensure();await owner.refresh();await owner.pick({kind:'guest'});const attempt=owner.getSnapshot().attemptId;unreadable=true;await owner.submit({kind:'guest'});assert.equal(checks,2);assert.equal(saves,0);assert.deepEqual(owner.getSnapshot().allowance,{kind:'recovery_required'});assert.equal(owner.getSnapshot().prompt,'unavailable');assert.equal(uploadAction(owner.getSnapshot().result),'unavailable');assert.equal(owner.getSnapshot().asset,file);assert.equal(owner.getSnapshot().attemptId,attempt);
});
for(const next of ['failed','recovery','ready'] as const)test(`refresh reconciles open exhausted prompt to ${next} without picker/import IO`,async()=>{
 let changed=false,picks=0,saves=0;const owner=new UploadSession({policy:'two_guest_successes_v1',pick:async()=>{picks++;return file},discard(){},allowance:async()=>{if(!changed)return {kind:'ready',used:2,remaining:0};if(next==='failed')throw Error('metadata');return next==='recovery'?{kind:'recovery_required'}:{kind:'ready',used:1,remaining:1}},lookup:async()=>({kind:'uncommitted'}),importFile:async()=>{saves++;return new ImportResult(false)}});owner.ensure();await owner.refresh();owner.check({kind:'guest'});assert.equal(owner.getSnapshot().prompt,'limit');changed=true;await owner.refresh();assert.equal(owner.getSnapshot().prompt,next==='ready'?null:'unavailable');assert.equal(picks,0);assert.equal(saves,0);
});

for(const ending of ['cancel','dispose'] as const)test(`failed lookup releases old staging when ${ending} happens during deferred allowance recheck`,async()=>{
 const staging=new Map<string,typeof file>();const discarded:string[]=[];const recheck=deferred<GuestAllowance>();let checks=0,saves=0;
 const owner=new UploadSession({policy:'two_guest_successes_v1',pick:async()=>{staging.set(file.uri,file);return file},discard:uri=>{discarded.push(uri);staging.delete(uri)},allowance:async()=>{checks++;return checks===1?{kind:'ready',used:1,remaining:1}:recheck.promise},lookup:async()=>{throw Error('metadata unreadable')},importFile:async()=>{saves++;return new ImportResult(false)}});
 owner.ensure();await owner.refresh();await owner.pick({kind:'guest'});const pending=owner.submit({kind:'guest'});await Promise.resolve();await Promise.resolve();assert.equal(checks,2);owner[ending]();assert.equal(owner.getSnapshot().prompt,null);
 const nextFile={...file,uri:'new-selection.pdf',name:'New.pdf'};const next=new UploadSession({policy:'disabled',pick:async()=>{staging.set(nextFile.uri,nextFile);return nextFile},discard:uri=>{discarded.push(uri);staging.delete(uri)},allowance:async()=>({kind:'disabled'}),lookup:async()=>({kind:'uncommitted'}),importFile:async()=>{saves++;return new ImportResult(false)}});next.ensure();await next.pick({kind:'guest'});
 recheck.resolve({kind:'recovery_required'});await pending;assert.equal(saves,0);assert.equal(owner.getSnapshot().prompt,null);assert.deepEqual(discarded,[file.uri]);assert.equal(staging.has(file.uri),false);assert.equal(staging.get(nextFile.uri),nextFile);assert.equal(next.getSnapshot().asset,nextFile);
});

for(const code of ['storage_conflict','guest_limit','guest_usage_recovery'] as const)
for(const ending of ['cancel','dispose'] as const)test(`${code} settlement releases captured selection once after ${ending} during normal deferred refresh`,async()=>{
 const staging=new Map<string,typeof file>();const discarded:string[]=[];const recheck=deferred<GuestAllowance>();const entered=deferred<void>();let checks=0,saves=0;
 const owner=new UploadSession({policy:'two_guest_successes_v1',pick:async()=>{staging.set(file.uri,file);return file},discard:uri=>{discarded.push(uri);staging.delete(uri)},allowance:async()=>{if(++checks===1)return {kind:'ready',used:1,remaining:1};entered.resolve();return recheck.promise},lookup:async()=>({kind:'uncommitted'}),importFile:async()=>{saves++;return new ImportResult(false,undefined,'retry after refresh',false,code)}});
 owner.ensure();await owner.refresh();await owner.pick({kind:'guest'});const pending=owner.submit({kind:'guest'});await entered.promise;assert.equal(saves,1);owner[ending]();if(ending==='cancel')owner.ensure();
 const nextFile={...file,uri:'replacement.pdf',name:'Replacement.pdf'};const next=new UploadSession({policy:'disabled',pick:async()=>{staging.set(nextFile.uri,nextFile);return nextFile},discard:uri=>{discarded.push(uri);staging.delete(uri)},allowance:async()=>({kind:'disabled'}),lookup:async()=>({kind:'uncommitted'}),importFile:async()=>{saves++;return new ImportResult(false)}});next.ensure();await next.pick({kind:'guest'});
 recheck.resolve({kind:'ready',used:2,remaining:0});await pending;
 assert.equal(owner.getSnapshot().prompt,null);assert.equal(owner.getSnapshot().result,undefined);assert.equal(saves,1);assert.deepEqual(discarded,[file.uri]);assert.equal(staging.has(file.uri),false);assert.equal(staging.get(nextFile.uri),nextFile);assert.equal(next.getSnapshot().asset,nextFile);owner.cancel();owner.dispose();assert.deepEqual(discarded,[file.uri]);
});

for(const available of [false,true])
for(const ending of ['cancel','dispose'] as const)test(`abandoned deferred lookup with gate ${available} cannot prompt or import after ${ending}`,async()=>{
 const staging=new Map<string,typeof file>();const discarded:string[]=[];const lookup=deferred<{kind:'uncommitted'}>();let full=false,saves=0;
 const owner=new UploadSession({policy:'two_guest_successes_v1',pick:async()=>{staging.set(file.uri,file);return file},discard:uri=>{discarded.push(uri);staging.delete(uri)},allowance:async()=>({kind:'ready',used:full?2:1,remaining:full?0:1}),lookup:()=>lookup.promise,importFile:async()=>{saves++;return new ImportResult(false)}});
 owner.ensure();await owner.refresh();await owner.pick({kind:'guest'});const pending=owner.submit({kind:'guest'});full=!available;await owner.refresh();owner[ending]();if(ending==='cancel')owner.ensure();
 const nextFile={...file,uri:'replacement.pdf',name:'Replacement.pdf'};const next=new UploadSession({policy:'disabled',pick:async()=>{staging.set(nextFile.uri,nextFile);return nextFile},discard:uri=>{discarded.push(uri);staging.delete(uri)},allowance:async()=>({kind:'disabled'}),lookup:async()=>({kind:'uncommitted'}),importFile:async()=>{saves++;return new ImportResult(false)}});next.ensure();await next.pick({kind:'guest'});
 lookup.resolve({kind:'uncommitted'});await pending;
 assert.equal(saves,0);assert.equal(owner.getSnapshot().prompt,null);assert.equal(owner.getSnapshot().result,undefined);assert.deepEqual(discarded,[file.uri]);assert.equal(staging.has(file.uri),false);assert.equal(staging.get(nextFile.uri),nextFile);assert.equal(next.getSnapshot().asset,nextFile);owner.cancel();owner.dispose();assert.deepEqual(discarded,[file.uri]);
});
