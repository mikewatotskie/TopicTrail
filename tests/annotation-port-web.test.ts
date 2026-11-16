import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transformSync} from 'esbuild';
import {annotationEnvelope,readAnnotationEnvelope} from '../src/core/services/annotation_port_contract';
import type {AnnotationPort} from '../src/core/services/annotations/types';

/** A lifecycle boundary, not a fake storage implementation: exercises the real
 * module's connection cache against close/blocked events. Real IndexedDB CAS is
 * additionally checked in the isolated browser qualification. */
function fixture(blocked=false) {
  const databases:any[]=[],requests:any[]=[];
  const snapshot=annotationEnvelope(1,'durable notes');
  const indexedDB={open(){
    const request:any={};requests.push(request);
    const db:any={closed:false,close(){this.closed=true;},transaction(){
      if(this.closed)throw new DOMException('Database is closed','InvalidStateError');
      const tx:any={objectStore:()=>({get:()=>{const get:any={};queueMicrotask(()=>{get.result=snapshot;get.onsuccess();queueMicrotask(()=>tx.oncomplete());});return get;}})};return tx;
    }};databases.push(db);request.result=db;
    queueMicrotask(()=>{if(blocked){blocked=false;request.onblocked();}else request.onsuccess();});return request;
  }};
  const module={exports:{} as {createAnnotationPort(scope:string):AnnotationPort}};
  const source=readFileSync(new URL('../src/core/services/annotation_port.web.ts',import.meta.url),'utf8');
  runInNewContext(transformSync(source,{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,indexedDB,Promise,Error,require:()=>({annotationEnvelope,readAnnotationEnvelope})});
  return {port:module.exports.createAnnotationPort('guest'),databases,requests};
}
test('annotation web storage reopens after an unexpected IndexedDB close and retains the durable state',async()=>{
  const f=fixture();assert.deepEqual(await f.port.read(),{revision:1,json:'durable notes'});
  f.databases[0].close();f.databases[0].onclose?.();
  assert.deepEqual(await f.port.read(),{revision:1,json:'durable notes'});assert.equal(f.databases.length,2);
});
test('a blocked open that eventually succeeds closes its abandoned connection',async()=>{
  const f=fixture(true);await assert.rejects(f.port.read(),/another TopicTrail tab/);
  f.requests[0].onsuccess();assert.equal(f.databases[0].closed,true,'abandoned connection must not retain a database lock');
  assert.deepEqual(await f.port.read(),{revision:1,json:'durable notes'});
});
