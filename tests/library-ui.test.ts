import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { Document as Syllabus, DocumentFormat } from '../src/core/models/document';
let ui: {LibraryScreen:React.ComponentType; ReadingProgressCard:typeof import('../src/features/library/ReadingProgressCard').ReadingProgressCard; DocumentActions:typeof import('../src/features/library/DocumentActions').DocumentActions; router:{visits:unknown[]}; viewport:{width:number;fontScale:number}; state:{fail:boolean;empty:boolean;documents?:object[]}};
before(async()=>{
 const tokens=resolve('src/core/design/tokens.ts').replaceAll('\\','/');
 const mocks:Record<string,string>={
 'react-native':`import React from 'react';export * from 'react-native-web';export const viewport={width:390,height:844,scale:1,fontScale:1};export const useWindowDimensions=()=>viewport;export const Modal=({children,visible})=>visible?React.createElement('div',{role:'dialog'},children):null;`,
 'expo-router':`import {useEffect} from 'react'; export const useFocusEffect=cb=>useEffect(cb,[cb]);export const useRouter=()=>router;export const router={visits:[],push(route){this.visits.push(route)},navigate(){},back(){},canGoBack:()=>true};`,
 'expo-image':`import React from 'react';export const Image=()=>React.createElement('span');`,
 '@expo/vector-icons':`import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
 'react-native-safe-area-context':`export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
 guestBookmarks:`export const bookmarkStore={initialize:async()=>{},getSnapshot:()=>({bookmarks:[]})};`,
 theme:`import {TTLightColors} from '${tokens}';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
 storage:`export const state={fail:true,empty:true};export const DocumentStorage={instance:{getAllDocuments:async()=>{if(state.fail)throw Error('Storage unavailable. Retry to recover.');return state.documents??(state.empty?[]:[{id:'fixture',title:'長い名前'.repeat(80)+'.pdf',format:'pdf',importedAt:new Date(),fileSize:123}])}}};`
 };
 const result=await build({stdin:{contents:`export {LibraryScreen} from './src/features/library/LibraryScreen';export {ReadingProgressCard} from './src/features/library/ReadingProgressCard';export {DocumentActions} from './src/features/library/DocumentActions';export {state} from './src/core/services/document_storage';export {router} from 'expo-router';export {viewport} from 'react-native';`,loader:'tsx',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false,packages:'external',loader:{'.svg':'dataurl'},plugins:[{name:'io',setup(b){b.onResolve({filter:/.*/},a=>{const key=/bookmarks\/storage$/.test(a.path)?'guestBookmarks':/ThemeContext$/.test(a.path)?'theme':/document_storage$/.test(a.path)?'storage':a.path; if(key in mocks)return{path:key,namespace:'io'}});b.onLoad({filter:/.*/,namespace:'io'},a=>({contents:mocks[a.path],loader:'tsx',resolveDir:process.cwd()}));}}]});
 const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(resolve('package.json')),module,module.exports);ui=module.exports as typeof ui;
});
async function mounted(run:(doc:globalThis.Document)=>Promise<void>, element:React.ReactElement = React.createElement(ui.LibraryScreen)){
 const dom=new JSDOM('<main></main>',{url:'https://library.test'});const originals=new Map<string,PropertyDescriptor|undefined>();
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){originals.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true})}
 const{createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.querySelector('main')!);
 try{await act(async()=>root.render(element));const sheet=dom.window.document.createElement('style');sheet.textContent=createRequire(resolve('package.json'))('react-native-web').StyleSheet.getSheet().textContent;dom.window.document.head.append(sheet);await run(dom.window.document)}finally{await act(async()=>root.unmount());dom.window.close();for(const[k,v]of originals){if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k)}}
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

test('format and sort controls change actual library results and preserve accessible selection',async()=>{
 ui.state.fail=false;ui.state.empty=false;ui.state.documents=[
  {id:'pdf',title:'Zoology PDF',format:'pdf',importedAt:new Date(10),lastOpenedAt:new Date(40)},
  {id:'docx',title:'Algebra DOCX',format:'docx',importedAt:new Date(30),lastOpenedAt:new Date(20)},
  {id:'pptx',title:'Biology PPTX',format:'pptx',importedAt:new Date(50)},
 ];
 try{await mounted(async doc=>{
  const titles=()=>[...doc.querySelectorAll('[aria-label^="Open "]')].map(el=>el.getAttribute('aria-label'));
  const press=async(label:string)=>{const button=doc.querySelector<HTMLElement>(`[aria-label="${label}"]`);assert.ok(button);await act(async()=>button.click());};
  assert.deepEqual(titles(),['Open Zoology PDF','Open Algebra DOCX','Open Biology PPTX']);
  assert.equal(doc.querySelector('[aria-label="Title"]'),null);
  await press('Filter and sort');
  await press('Title');assert.deepEqual(titles(),['Open Algebra DOCX','Open Biology PPTX','Open Zoology PDF']);
  await press('PPTX');assert.deepEqual(titles(),['Open Biology PPTX']);
  assert.equal(doc.querySelector('[aria-label="PPTX"]')?.getAttribute('aria-selected'),'true');
  await press('All formats');await press('Recently added');
  assert.deepEqual(titles(),['Open Biology PPTX','Open Algebra DOCX','Open Zoology PDF']);
  assert.equal(doc.querySelector('[aria-label="Recently added"]')?.getAttribute('aria-selected'),'true');
 });}finally{ui.state.documents=undefined;}
});

test('compact rows show stored details and keep the Reader independent of document options', async () => {
  ui.state.fail = false;
  ui.state.documents = [
    { id: 'notes', title: 'Botany Notes.PDF', format: 'pdf', importedAt: new Date(2024, 0, 8), pageCount: 3, fileSize: 2048 },
    { id: 'lab', title: 'Lab protocol', format: 'docx', importedAt: new Date(2024, 0, 7) },
    { id: 'talk', title: 'Seminar', format: 'pptx', importedAt: new Date(2024, 0, 6) },
  ];
  ui.router.visits.length = 0;
  try {
    await mounted(async doc => {
      const action = (label: string) => doc.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      const textLayers = (element: HTMLElement) => [...element.querySelectorAll('*')]
        .filter(node => node.firstChild?.nodeType === 3).map(node => node.textContent);
      const notes = action('Open Botany Notes.PDF');
      const more = action('More options for Botany Notes.PDF');
      const lab = action('Open Lab protocol');
      const talk = action('Open Seminar');
      assert.ok(textLayers(notes).includes('Botany Notes.PDF'), 'existing extension retains its case');
      assert.ok(textLayers(notes).includes('Notes'));
      assert.match(notes.textContent!, /3 pages · 2 KB · .*2024/);
      assert.ok(textLayers(lab).includes('Lab protocol.docx'));
      assert.match(lab.textContent!, /Text view · .*2024/);
      assert.doesNotMatch(lab.textContent!, /KB|MB|sections|Guide|Report/);
      assert.ok(textLayers(talk).includes('Slides'));
      assert.doesNotMatch(talk.textContent!, /\d+ slides|KB|MB/);
      assert.equal(notes.parentElement, more.parentElement);
      assert.equal(notes.contains(more), false);
      await act(async () => more.click());
      assert.ok(action('Rename document'));
      assert.deepEqual(ui.router.visits, []);
      await act(async () => action('Cancel').click());
      await act(async () => notes.click());
      assert.deepEqual(ui.router.visits, [{ pathname: '/reader/[documentId]', params: { documentId: 'notes' } }]);
    });
  } finally {
    ui.state.documents = undefined;
    ui.router.visits.length = 0;
  }
});

test('360dp keeps the category beside the filename; narrow or enlarged text moves it below', async () => {
  ui.state.fail = false;
  ui.state.documents = [{ id: 'guide', title: 'Science Guide', format: 'docx', importedAt: new Date(2024, 0, 7) }];
  try {
    for (const [width, fontScale, stacked] of [[360, 1, false], [390, 1, false], [320, 1, true], [360, 1.6, true]] as const) {
      Object.assign(ui.viewport, { width, fontScale });
      await mounted(async doc => {
        const open = doc.querySelector<HTMLElement>('[aria-label="Open Science Guide"]')!;
        const text = [...open.querySelectorAll<HTMLElement>('*')].filter(n => n.firstChild?.nodeType === 3);
        const filename = text.find(n => n.textContent === 'Science Guide.docx')!;
        const tag = text.find(n => n.textContent === 'Guide')!;
        assert.ok(filename && tag);
        assert.equal(filename.parentElement!.contains(tag), stacked);
        assert.equal(doc.querySelector<HTMLElement>('[aria-label="More options for Science Guide"]')!.style.minWidth, '48px');
      });
    }
  } finally {
    Object.assign(ui.viewport, { width: 390, fontScale: 1 });
    ui.state.documents = undefined;
  }
});

test('ordinary sync and resume stay compact while attention stays visible and full status reaches options', async () => {
  const file = new Syllabus('unit', 'Seminar', DocumentFormat.PPTX, '/private/file', new Date(2024, 0, 7));
  for (const [availability, progress, metadata, warning] of [
    ['available', undefined, undefined, undefined],
    ['available', { page: 2, totalPages: 5 }, 'Slide 2 of 5', undefined],
    ['waiting', { page: 2, totalPages: 5 }, 'Slide 2 of 5', 'Waiting to sync'],
    ['cloud-only', undefined, undefined, 'Download pending'],
    ['attention', 'unavailable', undefined, 'Reading progress unavailable · Needs attention'],
  ] as const) {
    let details = '';
    await mounted(async doc => {
      const row = doc.querySelector<HTMLElement>('[aria-label="Open Seminar"]')!;
      assert.doesNotMatch(row.textContent!, /Available on this device|Resume at/);
      if (metadata) assert.ok(row.textContent!.includes(metadata));
      if (warning) assert.ok(row.textContent!.includes(warning));
      await act(async () => doc.querySelector<HTMLElement>('[aria-label="More options for Seminar"]')!.click());
    }, React.createElement(ui.ReadingProgressCard, { compact: true, document: file, progress, availability,
      onMorePressed: message => { details = message ?? ''; } }));
    if (availability === 'available') assert.ok(details.includes('Available on this device'));
    if (metadata) assert.ok(details.includes('Resume at slide 2 of 5'));
    if (warning) assert.ok(details.includes(warning));
    await mounted(async doc => {
      assert.ok(doc.querySelector('[role="dialog"]')!.textContent!.includes(details));
    }, React.createElement(ui.DocumentActions, { document: file, readingStatus: details,
      onClose: () => {}, onChanged: async () => {} }));
  }
});
