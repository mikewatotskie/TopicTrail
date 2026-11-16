import assert from 'node:assert/strict';
import test,{before} from 'node:test';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import type {AnnotationPayload} from '../src/core/services/annotations/types';
import type {AnnotationStore} from '../src/core/services/annotations/store';

let ui:{NotesPanel:React.ComponentType<{view?:'notes'|'highlights';documentId?:string}>;reset(account?:boolean,hold?:boolean):void;beginInitialSync():void;initialize(payloads:AnnotationPayload[]):Promise<void>;store():AnnotationStore;refresh():Promise<void>;copyCalls():number;parentDeleted(value:boolean):Promise<void>};
const date='2026-11-11T00:00:00.000Z',hash='a'.repeat(64);
const payload=(id:string,title:string):AnnotationPayload=>({id,title,body:'My study note',documentId:null,documentHash:null,format:null,location:null,anchor:null,color:'yellow',createdAt:date,updatedAt:date});
const marked:AnnotationPayload={...payload('marked','Cells note'),documentId:'doc-1',documentHash:hash,format:'pdf',location:{unit:'page',index:3},color:'blue',anchor:{kind:'text',version:1,surface:'pdf-text',textHash:hash,ranges:[{blockId:'p-3',startUtf16:0,endUtf16:5}],quote:'Cells',prefix:'',suffix:''}};
before(async()=>{
 const tokens=resolve('src/core/design/tokens.ts').replaceAll('\\','/'),controller=resolve('src/features/notes/NotesController.ts').replaceAll('\\','/');
 const mocks:Record<string,string>={
  'react-native':`import React from 'react';export * from 'react-native-web';export const Modal=({children,visible})=>visible?React.createElement('div',{role:'dialog'},children):null;`,
  'expo-router':`export const useRouter=()=>router;export const router={push(){},back(){},canGoBack:()=>false};`,
  'expo-image':`import React from 'react';export const Image=()=>React.createElement('span');`,
  '@expo/vector-icons':`import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
  'react-native-safe-area-context':`export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
  theme:`import {TTLightColors} from '${tokens}';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
  guestPort:`export const createAnnotationPort=()=>({read:async()=>({json:null,revision:0}),commit:async()=>false});`,
  notes:`import {useSyncExternalStore} from 'react';import {NotesController} from '${controller}';let current,json,revision,deleted,copies,holdRemote;export const beginInitialSync=()=>{void current.sync();};export const copyCalls=()=>copies;export const refresh=()=>current.refresh();export function reset(account=false,hold=false){holdRemote=hold;current?.dispose();json=null;revision=0;deleted=false;copies=0;current=new NotesController({scope:account?'abcdefghijklmnopqrst/11111111-1111-1111-1111-111111111111':'guest',epoch:1,account,accountLabel:'student@example.test',checkActive(){},parent:async id=>id==='doc-1'?{hash:'${hash}',format:'pdf',deleted}:null},{read:async()=>({json,revision}),commit:async(expected,next)=>{if(expected!==revision)return false;json=next;revision++;return true;}},async()=>{},async()=>{if(holdRemote)return new Promise(()=>{});throw Error('network forbidden')});current.copyGuest=async()=>{copies++;return 1;};}reset();export const store=()=>current.store;export async function initialize(payloads){for(const payload of payloads)await current.store.save(payload,{highlightOnly:!!payload.anchor&&!payload.body});await current.refresh();}export async function parentDeleted(value){deleted=value;await current.refresh();}export function useNotes(){return {controller:current,state:useSyncExternalStore(current.subscribe,current.getSnapshot,current.getSnapshot)}}`,
  editor:`import React from 'react';export const noteColors={yellow:'#F8D45A',green:'#85D4A1',blue:'#89BAF5',purple:'#CAB0ED'};export const NoteEditor=({initial,item,onClose})=>React.createElement('div',{'data-editor-id':initial.id,'data-editor-has-saved-item':!!item},React.createElement('button',{'aria-label':'Close editor',onClick:onClose},'Close editor'));`,
 };
 const built=await build({stdin:{contents:`export {NotesPanel} from './src/features/notes/NotesPanel';export {reset,initialize,store,parentDeleted,refresh,copyCalls,beginInitialSync} from './src/features/notes/NotesProvider';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.svg':'dataurl'},plugins:[{name:'notes-ui-boundaries',setup(b){b.onResolve({filter:/.*/},a=>{const key=/annotation_port$/.test(a.path)?'guestPort':/ThemeContext$/.test(a.path)?'theme':/NotesProvider$/.test(a.path)?'notes':/NoteEditor$/.test(a.path)?'editor':a.path;if(key in mocks)return {path:key,namespace:'boundary'};});b.onLoad({filter:/.*/,namespace:'boundary'},a=>({contents:mocks[a.path],loader:'tsx',resolveDir:process.cwd()}));}}]});
 const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(resolve('package.json')),module,module.exports);ui=module.exports as typeof ui;
});
async function mounted(run:(doc:globalThis.Document,update:(view:'notes'|'highlights')=>Promise<void>)=>Promise<void>){
 const dom=new JSDOM('<main></main>',{url:'https://notes.test'}),previous=new Map<string,PropertyDescriptor|undefined>();
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true});}
 const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.querySelector('main')!);
 const update=async(view:'notes'|'highlights')=>{await act(async()=>root.render(React.createElement(ui.NotesPanel,{view})));};
 try{await update('notes');await run(dom.window.document,update);}finally{await act(async()=>root.unmount());dom.window.close();for(const[k,v]of previous){if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k);}}
}
async function press(doc:globalThis.Document,label:string){const button=doc.querySelector<HTMLElement>(`[aria-label="${label}"]`);assert.ok(button,label);await act(async()=>button.click());}

test('Notes and Highlights reopen one saved item in reading mode and recover it through Trash',async()=>{
 ui.reset();await ui.initialize([marked,payload('notebook','Notebook idea')]);
 await mounted(async(doc,update)=>{
  await press(doc,'Open note: Cells note');assert.equal(doc.querySelector('[data-editor-id]'),null);
  assert.match(doc.body.textContent!,/My study note/);
  await press(doc,'Edit note');assert.equal(doc.querySelector('[data-editor-id]')?.getAttribute('data-editor-id'),'marked');
  await press(doc,'Close editor');await press(doc,'Close note');
  await update('highlights');assert.equal(doc.querySelector('[aria-label="Open note: Notebook idea"]'),null);
  await press(doc,'Open note: Cells note');await press(doc,'Edit note');assert.equal(doc.querySelector('[data-editor-id]')?.getAttribute('data-editor-id'),'marked');
  await press(doc,'Close editor');await press(doc,'Move to Trash');await press(doc,'Confirm Move to Trash');
  assert.equal((await ui.store().list()).some(item=>item.id==='marked'),false);
  assert.equal((await ui.store().list({trash:true}))[0].id,'marked');
  await press(doc,'Notes Trash');await press(doc,'Open note: Cells note');await press(doc,'Restore note');
  assert.equal((await ui.store().list({trash:true})).length,0);
  assert.equal((await ui.store().list()).filter(item=>item.id==='marked').length,1);
 });
});

test('drafts reopen their original ID and unavailable parents remain hidden until explicitly shown',async()=>{
 ui.reset();await ui.initialize([marked]);await ui.store().saveDraft({id:'draft-1',payload:{...payload('draft-1','Unfinished idea'),body:'Draft text'},updatedAt:date});await ui.parentDeleted(true);
 await mounted(async doc=>{
  assert.equal(doc.querySelector('[aria-label="Open note: Cells note"]'),null);
  await press(doc,'Resume draft: Unfinished idea');assert.equal(doc.querySelector('[data-editor-id]')?.getAttribute('data-editor-id'),'draft-1');assert.equal(doc.querySelector('[data-editor-id]')?.getAttribute('data-editor-has-saved-item'),'false');await press(doc,'Close editor');
  await press(doc,'Show unavailable documents');await press(doc,'Open note: Cells note');
  assert.equal(doc.querySelector('[aria-label="Edit note"]')?.getAttribute('aria-disabled'),'true');
  assert.equal(doc.querySelector('[aria-label="Go to passage"]')?.getAttribute('aria-disabled'),'true');
  assert.equal((await ui.store().read()).records[0].deleted,false);
 });
});

test('conflict comparison exposes both contents and Keep both deliberately persists a distinct item',async()=>{
 ui.reset(true);await ui.initialize([marked]);
 const pending=(await ui.store().read()).pending[0];
 await ui.store().acknowledge(pending.operationId,{status:'conflict',record:{id:marked.id,revision:2,deleted:false,payload:{...marked,body:'Cloud explanation'}}});await ui.refresh();
 await mounted(async doc=>{
  await press(doc,'Compare versions: Cells note');assert.match(doc.body.textContent!,/Cloud explanation/);assert.match(doc.body.textContent!,/My study note/);
  await press(doc,'Keep both');const saved=await ui.store().list();
  assert.equal(saved.length,2);assert.equal(saved.find(item=>item.id===marked.id)?.payload.body,'Cloud explanation');
  assert.equal(saved.find(item=>item.id!==marked.id)?.payload.body,marked.body);
  assert.equal((await ui.store().read()).conflicts.length,0);
 });
});

test('Guest copy names its account and waits for the explicit second action',async()=>{
 ui.reset(true);await ui.initialize([]);
 await mounted(async doc=>{
  assert.equal(ui.copyCalls(),0);await press(doc,'Copy Guest notes to my account');
  assert.match(doc.body.textContent!,/student@example.test/);assert.equal(ui.copyCalls(),0);
  await press(doc,'Cancel Guest copy');assert.equal(ui.copyCalls(),0);
  await press(doc,'Copy Guest notes to my account');await press(doc,'Copy Guest notes and files');
  assert.equal(ui.copyCalls(),1);assert.match(doc.body.textContent!,/1 Guest note copied/);
 });
});

test('initial account synchronization never claims the notes library is empty',async()=>{
 ui.reset(true,true);ui.beginInitialSync();await mounted(async doc=>{assert.match(doc.body.textContent!,/Synchronizing notes/);assert.doesNotMatch(doc.body.textContent!,/No notes yet|No highlights yet/);});
});
