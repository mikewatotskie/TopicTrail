import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyValueAnnotationPort } from '../src/core/services/annotation_port_contract';

test('two concurrent writers cannot overwrite the same annotation revision', async () => {
  const values = new Map<string,string>();
  const storage = { getItem: async (key:string) => values.get(key) ?? null, setItem: async (key:string,value:string) => { values.set(key,value); } };
  const a=createKeyValueAnnotationPort('guest',storage),b=createKeyValueAnnotationPort('guest',storage);
  const results=await Promise.all([a.commit(0,'first'),b.commit(0,'second')]);
  assert.deepEqual(results,[true,false]);
  assert.deepEqual(await b.read(),{revision:1,json:'first'});
  assert.equal(await b.commit(1,'second'),true);
  assert.deepEqual(await a.read(),{revision:2,json:'second'});
});
test('separate annotation accounts and damaged storage never overwrite existing bytes', async () => {
  const values=new Map<string,string>();
  const storage={getItem:async(key:string)=>values.get(key)??null,setItem:async(key:string,value:string)=>{values.set(key,value);}};
  const a=createKeyValueAnnotationPort('guest',storage),b=createKeyValueAnnotationPort('account-a',storage);
  await a.commit(0,'guest note');assert.deepEqual(await b.read(),{revision:0,json:null});
  const key=[...values.keys()][0];values.set(key,'broken');
  await assert.rejects(a.commit(0,'replacement'),/preserved/i);assert.equal(values.get(key),'broken');
});
