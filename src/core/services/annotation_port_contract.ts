import { strToU8 } from 'fflate';
import { sha256 } from './cloud/sha256';
import type { AnnotationPort } from './annotations/types';
type KeyValueStore={getItem(key:string):Promise<string|null>;setItem(key:string,value:string):Promise<void>};
const queues=new WeakMap<KeyValueStore,Map<string,Promise<unknown>>>();
export function annotationEnvelope(revision:number,json:string){return {revision,json,checksum:sha256(strToU8(revision+':'+json))};}
export function readAnnotationEnvelope(value:unknown):{revision:number;json:string|null}{
  if(value===null||value===undefined)return {revision:0,json:null};
  if(typeof value!=='object')throw Error('Notes storage could not be read. Existing data is preserved.');
  const row=value as ReturnType<typeof annotationEnvelope>;
  if(!Number.isSafeInteger(row.revision)||row.revision<1||typeof row.json!=='string'||row.checksum!==annotationEnvelope(row.revision,row.json).checksum)
    throw Error('Notes storage could not be read. Existing data is preserved.');
  return {revision:row.revision,json:row.json};
}
/** Native AsyncStorage writes a whole value atomically. A shared queue provides CAS within the app process. */
export function createKeyValueAnnotationPort(scope:string,storage:KeyValueStore):AnnotationPort{
  const key='topictrail-annotations-v1:'+encodeURIComponent(scope);
  let locks=queues.get(storage);if(!locks){locks=new Map();queues.set(storage,locks);}
  const read=async()=>{const raw=await storage.getItem(key);try{return readAnnotationEnvelope(raw===null?null:JSON.parse(raw));}catch{throw Error('Notes storage could not be read. Existing data is preserved.');}};
  return {read,commit(expected,json){
    const result=(locks!.get(key)??Promise.resolve()).catch(()=>{}).then(async()=>{
      const current=await read();if(current.revision!==expected)return false;
      await storage.setItem(key,JSON.stringify(annotationEnvelope(expected+1,json)));return true;
    });locks!.set(key,result);return result;
  }};
}
