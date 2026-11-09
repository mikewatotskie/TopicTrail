import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
let ui: {LibraryScreen:React.ComponentType; state:{fail:boolean;empty:boolean}};
before(async()=>{
 const tokens=resolve('src/core/design/tokens.ts').replaceAll('\\','/');
 const mocks:Record<string,string>={
 'react-native':`import React from 'react';export * from 'react-native-web';export const Modal=({children,visible})=>visible?React.createElement('div',{role:'dialog'},children):null;`,
 'expo-router':`import {useEffect} from 'react'; export const useFocusEffect=cb=>useEffect(cb,[cb]);export const router={push(){},navigate(){},back(){},canGoBack:()=>true};`,
 'expo-image':`import React from 'react';export const Image=()=>React.createElement('span');`,
 '@expo/vector-icons':`import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
 'react-native-safe-area-context':`export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
 theme:`import {TTLightColors} from '${tokens}';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
 storage:`export const state={fail:true,empty:true};export const DocumentStorage={instance:{getAllDocuments:async()=>{if(state.fail)throw Error('Storage unavailable. Retry to recover.');return state.empty?[]:[{id:'fixture',title:'長い名前'.repeat(80)+'.pdf',format:'pdf',importedAt:new Date(),fileSize:123}]}}};`
 };
 const result=await build({stdin:{contents:`export {LibraryScreen} from './src/features/library/LibraryScreen';export {state} from './src/core/services/document_storage';`,loader:'tsx',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false,packages:'external',loader:{'.svg':'dataurl'},plugins:[{name:'io',setup(b){b.onResolve({filter:/.*/},a=>{const key=/ThemeContext$/.test(a.path)?'theme':/document_storage$/.test(a.path)?'storage':a.path; if(key in mocks)return{path:key,namespace:'io'}});b.onLoad({filter:/.*/,namespace:'io'},a=>({contents:mocks[a.path],loader:'tsx',resolveDir:process.cwd()}));}}]});
 const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(resolve('package.json')),module,module.exports);ui=module.exports as typeof ui;
});
async function mounted(run:(doc:globalThis.Document)=>Promise<void>){
 const dom=new JSDOM('<main></main>',{url:'https://library.test'});const originals=new Map<string,PropertyDescriptor|undefined>();
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){originals.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true})}
 const{createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.querySelector('main')!);
 try{await act(async()=>root.render(React.createElement(ui.LibraryScreen)));const sheet=dom.window.document.createElement('style');sheet.textContent=createRequire(resolve('package.json'))('react-native-web').StyleSheet.getSheet().textContent;dom.window.document.head.append(sheet);await run(dom.window.document)}finally{await act(async()=>root.unmount());dom.window.close();for(const[k,v]of originals){if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k)}}
}
test('failed library does not claim zero documents; Retry recovers to actual empty state',async()=>{
 ui.state.fail=true;ui.state.empty=true;await mounted(async doc=>{
 assert.match(doc.body.textContent!,/Library unavailable/);assert.doesNotMatch(doc.body.textContent!,/0 documents|No syllabi yet/);
 ui.state.fail=false;await act(async()=>doc.querySelector<HTMLElement>('[aria-label="Retry"]')!.click());
 assert.match(doc.body.textContent!,/0 documents/);assert.match(doc.body.textContent!,/No syllabi yet/);
 });
});
test('long document titles preserve full accessible names and separate actions',async()=>{
 ui.state.fail=false;ui.state.empty=false;await mounted(async doc=>{
 const open=doc.querySelector<HTMLElement>('[aria-label^="Open 長い"]')!;const more=doc.querySelector<HTMLElement>('[aria-label^="More options for 長い"]')!;
 assert.ok(open);assert.ok(more);assert.equal(open.style.minWidth,'0px');assert.equal(open.contains(more),false);
 });
});

test('long_title_keeps_actions_and_full_name_access',async()=>{
 ui.state.fail=false;ui.state.empty=false;await mounted(async doc=>{
 const title='長い名前'.repeat(80)+'.pdf';
 const open=doc.querySelector<HTMLElement>('[aria-label^="Open 長い"]')!;
 const more=doc.querySelector<HTMLElement>('[aria-label^="More options for 長い"]')!;
 assert.equal(open.getAttribute('aria-label'),'Open '+title);
 assert.equal(more.getAttribute('aria-label'),'More options for '+title);
 const preview=[...open.querySelectorAll<HTMLElement>('*')].find(el=>el.textContent===title&&el.firstChild?.nodeType===3)!;
 assert.equal(preview.style.minWidth,'0px');
 assert.equal(preview.style.overflowWrap,'anywhere');
 assert.equal(more.style.minWidth,'48px');assert.equal(more.style.flexShrink,'0');
 await act(async()=>more.click());
 const full=[...doc.querySelectorAll<HTMLElement>('*')].find(el=>el.textContent===title&&el.firstChild?.nodeType===3&&doc.defaultView!.getComputedStyle(el).userSelect==='text');
 assert.ok(full,'Document options exposes the complete selectable name');
 assert.equal(full.textContent,title);assert.equal(full.style.overflowWrap,'anywhere');
 assert.equal(full.style.webkitLineClamp,'');
 });
});
