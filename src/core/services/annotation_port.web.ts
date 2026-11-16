import type { AnnotationPort } from './annotations/types';
import { annotationEnvelope, readAnnotationEnvelope } from './annotation_port_contract';
let opening:Promise<IDBDatabase>|undefined;
function database(){
  if(opening)return opening;
  let attempt:Promise<IDBDatabase>;
  attempt=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('topictrail-annotations-v1',1);let abandoned=false;
    const forget=()=>{if(opening===attempt)opening=undefined;};
    request.onupgradeneeded=()=>{request.result.createObjectStore('scopes');};
    request.onerror=()=>{abandoned=true;reject(Error('Notes storage is unavailable. Existing data is preserved.'));};
    request.onblocked=()=>{abandoned=true;reject(Error('Close another TopicTrail tab and retry notes storage.'));};
    request.onsuccess=()=>{
      const db=request.result;
      // A rejected blocked request can still finish after the blocking tab exits.
      // Close that abandoned connection so it cannot hold a future upgrade open.
      if(abandoned){db.close();return;}
      db.onversionchange=()=>{db.close();forget();};
      // Browser shutdown/eviction can close a connection without versionchange.
      // A retry must reopen the database rather than reuse that closed handle.
      db.onclose=forget;resolve(db);
    };
  }).catch(error=>{if(opening===attempt)opening=undefined;throw error;});
  opening=attempt;return attempt;
}
export function createAnnotationPort(scope:string):AnnotationPort{
  return {async read(){const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction('scopes','readonly'),request=tx.objectStore('scopes').get(scope);
    let result:{revision:number;json:string|null};
    request.onsuccess=()=>{try{result=readAnnotationEnvelope(request.result);}catch(error){reject(error);}};
    tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(Error('Notes storage could not be read.'));
  });},async commit(expected,json){const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction('scopes','readwrite'),store=tx.objectStore('scopes'),request=store.get(scope);let applied=false;
    request.onsuccess=()=>{try{const value=readAnnotationEnvelope(request.result);if(value.revision===expected){store.put(annotationEnvelope(expected+1,json),scope);applied=true;}}catch(error){reject(error);tx.abort();}};
    tx.oncomplete=()=>resolve(applied);tx.onabort=tx.onerror=()=>reject(Error('Notes could not be saved. Existing data is preserved.'));
  });}};
}
