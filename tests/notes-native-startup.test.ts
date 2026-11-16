import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { NotesController } from '../src/features/notes/NotesController';
import { newNotePayload } from '../src/features/notes/note_selection';
test('notes provider starts and cleans up on native window without browser event APIs',()=>{
 const effects:(()=>void|(()=>void))[]=[],cleanups:(()=>void)[]=[];let removed=0,held=0,synced=0;
 const FakeController=class {context={epoch:1};refresh=async()=>{};sync=async()=>{synced++;};hold(){held++;return()=>{held--;};}};
 const createElement=(type:any,props:any,...children:any[]):any=>typeof type==='function'?type({...props,children}):null;
 const scope:any={module:{exports:{}},setInterval:()=>1,clearInterval:()=>{},require(name:string){
  if(name==='react')return {createContext:()=>({Provider:'provider'}),createElement,useState:(init:any)=>[typeof init==='function'?init():init,()=>{}],useEffect:(effect:any)=>effects.push(effect)};
  if(name==='react-native')return {Platform:{OS:'android'},AppState:{currentState:'active',addEventListener:()=>({remove(){removed++;}})}};
  if(name.endsWith('/CloudLibraryContext'))return {useCloudLibrary:()=>({runtime:{annotationContext:()=>({scope:'guest',epoch:1}),sync:async()=>{}},state:{epoch:1,phase:'guest',revision:0}})};
  if(name==='./NotesController')return {NotesController:FakeController};
  if(name.endsWith('/annotation_port'))return {createAnnotationPort:()=>({})};
  if(name.endsWith('/supabase_config'))return {readSupabaseConfiguration:()=>{throw Error('Guest must not read remote config');}};
  if(name.endsWith('/annotations/remote'))return {createAnnotationRemote:()=>{throw Error('Guest must not create remote');}};
  throw Error('Unexpected dependency '+name);
 }};scope.window=scope;scope.exports=scope.module.exports;
 const source=readFileSync(new URL('../src/features/notes/NotesProvider.tsx',import.meta.url),'utf8');
 runInNewContext(transformSync(source,{loader:'tsx',format:'cjs',jsx:'transform'}).code,scope);
 assert.doesNotThrow(()=>scope.module.exports.NotesProvider({children:null}));
 for(const effect of effects){const cleanup=effect();if(cleanup)cleanups.push(cleanup);}
 assert.equal(held,1);assert.equal(synced,1);for(const cleanup of cleanups)cleanup();assert.equal(held,0);assert.equal(removed,1);
});
test('StrictMode effect replay retains notes controller while actual unmount closes it',async()=>{
 let revision=0,json:string|null=null;
 const context:any={scope:'guest',epoch:1,account:false,checkActive(){},parent:async()=>null};
 const controller=new NotesController(context,{read:async()=>({revision,json}),commit:async(expected,value)=>{if(expected!==revision)return false;revision++;json=value;return true;}},async()=>{},async()=>{throw Error('Guest');});
 const first=controller.hold();first();const second=controller.hold();await Promise.resolve();
 await controller.run(store=>store.save({...newNotePayload(),body:'Still writable after StrictMode replay'}));assert.equal(controller.getSnapshot().items.length,1);
 second();await Promise.resolve();await assert.rejects(controller.store.read(),/account changed/);
});
