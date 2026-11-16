import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import type {AnnotationListItem,AnnotationPayload} from '../src/core/services/annotations/types';
import type {NotesController} from '../src/features/notes/NotesController';

let dom:JSDOM;
const previous=new Map<string,PropertyDescriptor|undefined>();
let ui:{Editor:React.ComponentType<{initial:AnnotationPayload;item?:AnnotationListItem}>;reset():void;controller():NotesController;parentDeleted():void;failWrites(value:boolean):void;closeCount():number};
const date='2026-11-11T00:00:00.000Z',hash='a'.repeat(64);
const payload=(id='editor-note'):AnnotationPayload=>({id,documentId:null,documentHash:null,format:null,location:null,anchor:null,title:'Editor note',body:'Initial text',color:'yellow',createdAt:date,updatedAt:date});
before(async()=>{
  dom=new JSDOM('<main></main>',{url:'https://notes-editor.test',pretendToBeVisual:true});
  Object.defineProperty(dom.window,'matchMedia',{value:()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})});
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,ShadowRoot:dom.window.ShadowRoot,IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})) {
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const controller=resolve('src/features/notes/NotesController.ts').replaceAll('\\','/'),tokens=resolve('src/core/design/tokens.ts').replaceAll('\\','/');
  const mocks:Record<string,string>={
    'react-native':`import React from 'react';export * from 'react-native-web';export const Modal=({children,visible})=>visible?React.createElement('div',{role:'dialog'},children):null;`,
    'expo-router':`export const useRouter=()=>router;export const router={push(){},back(){},canGoBack:()=>false};`,
    'expo-image':`import React from 'react';export const Image=()=>React.createElement('span');`,
    '@expo/vector-icons':`import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    'react-native-safe-area-context':`export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    theme:`import {TTLightColors} from '${tokens}';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
    notes:`import {useSyncExternalStore} from 'react';import {NotesController} from '${controller}';let current,json,revision,deleted,fail,closes;export const closeCount=()=>closes;export const closed=()=>{closes++;};export const controller=()=>current;export function parentDeleted(){deleted=true;}export function failWrites(value){fail=value;}export function reset(){current?.dispose();json=null;revision=0;deleted=false;fail=false;closes=0;current=new NotesController({scope:'abcdefghijklmnopqrst/11111111-1111-1111-1111-111111111111',epoch:1,account:true,accountLabel:'Synthetic',checkActive(){},parent:async id=>id==='doc-1'?{hash:'${hash}',format:'pdf',deleted}:null},{read:async()=>({json,revision}),commit:async(expected,next)=>{if(expected!==revision)return false;if(fail)throw Error('disk full');json=next;revision++;return true;}},async()=>{},async()=>{throw Error('Synthetic offline boundary');});}reset();export function useNotes(){return {controller:current,state:useSyncExternalStore(current.subscribe,current.getSnapshot,current.getSnapshot)}}`,
  };
  const built=await build({stdin:{contents:`import React from 'react';import {NoteEditor} from './src/features/notes/NoteEditor';import {closed} from './src/features/notes/NotesProvider';export {reset,controller,parentDeleted,failWrites,closeCount} from './src/features/notes/NotesProvider';export const Editor=props=><NoteEditor {...props} startEditing onClose={closed}/>;`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.svg':'dataurl'},plugins:[{name:'note-editor-boundaries',setup(b){b.onResolve({filter:/.*/},a=>{const key=/ThemeContext$/.test(a.path)?'theme':/NotesProvider$/.test(a.path)?'notes':a.path;if(key in mocks)return {path:key,namespace:'boundary'};});b.onLoad({filter:/.*/,namespace:'boundary'},a=>({contents:mocks[a.path],loader:'tsx',resolveDir:process.cwd()}));}}]});
  const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(resolve('package.json')),module,module.exports);ui=module.exports as typeof ui;
});
after(()=>{ui?.controller().dispose();dom?.window.close();for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
async function mounted(initial:AnnotationPayload,item:AnnotationListItem|undefined,run:(document:globalThis.Document)=>Promise<void>) {
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.querySelector('main')!);
  try{await act(async()=>root.render(React.createElement(ui.Editor,{initial,item})));await run(dom.window.document);}finally{await act(async()=>root.unmount());}
}
async function type(doc:globalThis.Document,value:string) {
  const input=doc.querySelector<HTMLTextAreaElement>('[aria-label="Note text"]');assert.ok(input);
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await act(async()=>ui.controller().refresh());
}
async function press(doc:globalThis.Document,label:string) {const control=doc.querySelector<HTMLElement>(`[aria-label="${label}"]`);assert.ok(control,label);await act(async()=>control.click());}
async function openExisting(p:AnnotationPayload) {
  ui.reset();await ui.controller().store.merge([{id:p.id,revision:1,deleted:false,payload:p}]);await ui.controller().refresh();return (await ui.controller().store.list())[0];
}
test('the actual editor persists typed drafts and Save atomically clears the draft with one queued note',async()=>{
  ui.reset();await ui.controller().refresh();const initial={...payload(),body:''};
  await mounted(initial,undefined,async doc=>{
    await type(doc,'Typed in the actual editor');const draft=(await ui.controller().store.read()).drafts[0];assert.equal(draft.payload.body,'Typed in the actual editor');assert.equal(draft.baseRevision,0);
    await press(doc,'Save note');const state=await ui.controller().store.read();assert.equal(state.drafts.length,0);assert.equal(state.pending.length,1);assert.equal(state.pending[0].payload.body,'Typed in the actual editor');assert.equal(ui.closeCount(),1);
  });
});
test('the actual editor keeps its opened revision when a newer cloud version arrives',async()=>{
  const initial=payload(),item=await openExisting(initial);
  await mounted(initial,item,async doc=>{
    await type(doc,'This editor’s version');await act(async()=>{await ui.controller().store.merge([{id:initial.id,revision:2,deleted:false,payload:{...initial,body:'Other device’s version'}}]);await ui.controller().refresh();});
    await press(doc,'Save note');const state=await ui.controller().store.read();assert.equal(state.pending.length,0);assert.equal(state.conflicts[0].local.expectedRevision,1);
    assert.equal(state.conflicts[0].local.payload.body,'This editor’s version');assert.equal(state.conflicts[0].cloud.payload.body,'Other device’s version');assert.equal(state.drafts.length,0);
  });
});
test('the actual editor retains the typed draft when parent Trash locks its controls',async()=>{
  const initial={...payload(),documentId:'doc-1',documentHash:hash,format:'pdf' as const},item=await openExisting(initial);
  await mounted(initial,item,async doc=>{
    await type(doc,'Keep my interrupted work');await act(async()=>{ui.parentDeleted();await ui.controller().refresh();});
    assert.equal(doc.querySelector('[aria-label="Save note"]')?.getAttribute('aria-disabled'),'true');
    await press(doc,'Close');const draft=(await ui.controller().store.read()).drafts[0];assert.equal(draft.payload.body,'Keep my interrupted work');assert.equal(draft.baseRevision,1);
  });
});
test('the actual editor preserves a draft on failed durable Save and permits a safe retry',async()=>{
  ui.reset();await ui.controller().refresh();const initial={...payload(),body:''};
  await mounted(initial,undefined,async doc=>{
    await type(doc,'Saved draft before disk failure');ui.failWrites(true);await press(doc,'Save note');
    assert.match(doc.body.textContent!,/disk full/);assert.equal(ui.closeCount(),0);assert.equal((await ui.controller().store.read()).drafts[0].payload.body,'Saved draft before disk failure');
    ui.failWrites(false);await press(doc,'Save note');assert.equal(ui.closeCount(),1);assert.equal((await ui.controller().store.read()).pending.length,1);
  });
});
test('the actual editor refuses to remove note text that changed after it was opened',async()=>{
  const initial:AnnotationPayload={...payload(),documentId:'doc-1',documentHash:hash,format:'pdf',location:{unit:'page',index:1},anchor:{kind:'text',version:1,surface:'pdf-text',textHash:hash,ranges:[{blockId:'pdf-1',startUtf16:0,endUtf16:4}],quote:'Text',prefix:'',suffix:''}};
  const item=await openExisting(initial);
  await mounted(initial,item,async doc=>{
    await act(async()=>{await ui.controller().store.merge([{id:initial.id,revision:2,deleted:false,payload:{...initial,body:'New cloud text the editor has not shown'}}]);await ui.controller().refresh();});
    await press(doc,'Remove note, keep highlight');await press(doc,'Confirm');
    assert.match(doc.body.textContent!,/Close this editor and reopen the latest/);assert.equal(ui.closeCount(),0);
    const state=await ui.controller().store.read();assert.equal(state.pending.length,0);assert.equal(state.records[0].payload.body,'New cloud text the editor has not shown');
  });
});
