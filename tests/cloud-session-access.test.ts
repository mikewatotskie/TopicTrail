import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudSessionReader } from '../src/core/auth/cloud_session';
import type { AuthState } from '../src/core/auth/types';
const uid = '11111111-1111-4111-8111-111111111111';
const project = 'abcdefghijklmnopqrst';
const account: AuthState = { status:'account', account:{ uid,email:null,displayName:null,emailVerified:true,projectNamespace:project } };
test('cloud capability uses the existing verified session and rejects unavailable storage', async () => {
  let failed = false;
  const read = createCloudSessionReader({ namespace:project,snapshot:()=>account,epoch:()=>1,unavailable:()=>failed,
    session:async()=>({data:{session:{access_token:'private-test-token',expires_at:Date.now()/1000+600,user:{id:uid,email_confirmed_at:'confirmed'}}},error:null}) });
  assert.deepEqual(await read(),{uid,project,accessToken:'private-test-token'});
  failed=true; await assert.rejects(read(),/unavailable/i);
});
test('logout and A to B to A transitions reject an in-flight token capability', async () => {
  let epoch=1; let resolve!: (value: any)=>void;
  const read=createCloudSessionReader({namespace:project,snapshot:()=>account,epoch:()=>epoch,unavailable:()=>false,
    session:()=>new Promise(r=>{resolve=r;})});
  const pending=read(); epoch=3;
  resolve({data:{session:{access_token:'secret',expires_at:Date.now()/1000+600,user:{id:uid,email_confirmed_at:'confirmed'}}},error:null});
  await assert.rejects(pending,/changed/i);
});
test('guest capability returns no token and foreign sessions are rejected', async () => {
  let state:AuthState={status:'guest'}; let called=0;
  const read=createCloudSessionReader({namespace:project,snapshot:()=>state,epoch:()=>1,unavailable:()=>false,
    session:async()=>{called++;return {data:{session:{access_token:'secret',expires_at:Date.now()/1000+600,user:{id:'other',email_confirmed_at:'confirmed'}}},error:null};}});
  assert.equal(await read(),null);assert.equal(called,0); state=account;
  await assert.rejects(read(),/changed/i);
});
