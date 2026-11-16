import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

// Real feature components and Study context; only platform IO/navigation are substituted.
// All rendering is in-memory Node/JSDOM. No app/preview/server is launched.
interface Harness {
  UploadScreen: React.ComponentType;
  hideUpload: () => void;
  uploadResult: () => unknown;
  ReaderHarness: React.ComponentType;
  finishImport: () => void;
  navigation: string[];
  discardedSelections: string[];
  readerEvent: (message: object) => void;
  readerFailure: () => void;
  seedNote: (anchor:object) => Promise<void>;
  readerCommands: {type:string;value?:number}[];
  noteRows:()=>Promise<{payload:{anchor:{kind:string;rect?:number[]}|null;body:string}}[]>;
}
let ui: Harness;
before(async () => {
  const tokenPath = resolve('src/core/design/tokens.ts').replaceAll('\\', '/');
  const substitutions: Record<string, string> = {
    'react-native': `import React from 'react';export * from 'react-native-web'; export const NativeModules={}; export const Platform={OS:'android',select:v=>v.android??v.default};export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};export const Modal=({visible,children})=>visible?React.createElement('section',{role:'dialog'},children):null;`,
    'expo-router': `export const navigation=[]; export const useRouter=()=>router;export const router={replace:p=>navigation.push(typeof p==='string'?p:p.pathname),push:p=>navigation.push(typeof p==='string'?p:p.pathname),canGoBack:()=>true,back:()=>navigation.push('back')}; export const useLocalSearchParams=()=>({documentId:'doc-1'});export const useFocusEffect=effect=>{React.useEffect(effect,[effect])};import React from 'react';`,
    'expo-asset': `export const Asset={fromModule:()=>({downloadAsync:async()=>({localUri:'reader.html'})})};`,
    'expo-file-system': `export class File {exists=true;size=128;async text(){return '<!doctype html><html><body><main id="content"></main></body></html>'} async base64(){return 'AA=='} }`,
    'expo-clipboard': `export const setStringAsync=async()=>{};`,
    'expo-image': `import React from 'react'; export const Image=()=>React.createElement('span');`,
    '@expo/vector-icons': `import React from 'react'; export const Ionicons=()=>React.createElement('span'); Ionicons.glyphMap={};`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web'; export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    'react-native-webview': `import React,{forwardRef,useImperativeHandle,useEffect} from 'react';let latest,session,generation=0,renderToken=0;export const readerCommands=[];
      const raw=m=>latest.onMessage({nativeEvent:{data:JSON.stringify(m)}});const event=message=>raw({protocol:1,session,generation,renderToken,message});
      export const readerEvent=m=>{if(!session)raw({type:'ready'});event(m)};export const readerFailure=()=>latest.onError();
      export default forwardRef((props,ref)=>{latest=props;useEffect(()=>()=>{session=undefined;generation=0;renderToken=0;readerCommands.length=0},[]);
        useImperativeHandle(ref,()=>({injectJavaScript(script){if(script.includes('connectNative(')){session=JSON.parse(script.slice(script.indexOf('connectNative(')+14,script.lastIndexOf(');')));event({type:'ready'});}
          else if(script.includes('dispatch(')){const envelope=JSON.parse(script.slice(script.indexOf('dispatch(')+9,script.lastIndexOf(');')));generation=envelope.generation;const command=envelope.command;readerCommands.push(command);
            if(['load','page','zoom'].includes(command.type)){renderToken++;event({type:'render-start',page:command.type==='page'?command.value:1});}}}}));return React.createElement('div',{'data-reader':true})});`,
    notesio: `import React from 'react';import {NotesController} from '${resolve('src/features/notes/NotesController.ts').replaceAll('\\','/')}';import {sha256} from '${resolve('src/core/services/cloud/sha256.ts').replaceAll('\\','/')}';
      const hash=sha256(new Uint8Array([0]));let json=null,revision=0;
      const controller=new NotesController({scope:'guest',account:false,checkActive(){},parent:async()=>({hash,format:'pdf',deleted:false})},{read:async()=>({json,revision}),commit:async(expected,next)=>{if(expected!==revision)return false;json=next;revision++;return true;}},async()=>{},async()=>{throw Error('Guest must never sync')});
      export const seedNote=async anchor=>controller.run(store=>store.save({id:'saved-reader-note',documentId:'doc-1',documentHash:hash,format:'pdf',location:{unit:'page',index:1},anchor,title:'Saved full passage',body:'Existing attached explanation',color:'blue',createdAt:'2026-11-11T00:00:00.000Z',updatedAt:'2026-11-11T00:00:00.000Z'}));
      export const noteRows=async()=>controller.getSnapshot().items;
      export function useNotes(){const state=React.useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);React.useEffect(()=>{void controller.refresh()},[]);return {state,controller}}`,
    authio: `export function getTopicTrailAuthGateway(){throw Error('Injected auth only')}`,
    theme: `import {TTLightColors} from '${tokenPath}'; export const useColors=()=>({colors:TTLightColors}); export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
    storage: `export const getCloudLibrary=()=>({readBytes:async()=>new Uint8Array([0])});export const DocumentStorage={instance:{getDocument:async()=>({id:'doc-1',title:'Real syllabus',format:'pdf',filePath:'owned.pdf'}),updateLastOpened:async()=>{throw Error('Disk full')}}};`,
    importer: `let done; export const discardedSelections=[];export const finishImport=()=>done({success:true,document:{id:'doc-1'}}); export const DocumentImportService={instance:{pickDocument:async()=>({name:'Course.pdf',uri:'picker.pdf',size:128}),discardSelection:uri=>discardedSelections.push(uri),importFile:()=>new Promise(resolve=>{done=resolve})}};`,
  };
  const result = await build({ stdin: { contents: `import React from 'react'; import {ReaderScreen} from './src/features/reader/ReaderScreen'; import {StudySelectionProvider,useStudySelection} from './src/features/reader/StudySelectionContext'; import {UploadScreen as ActualUploadScreen} from './src/features/upload/UploadScreen';import {UploadSessionProvider} from './src/features/upload/UploadSessionContext';import {UploadSession} from './src/features/upload/upload_session';import {DocumentImportService} from './src/core/services/document_import';let setVisible,owner;export const hideUpload=()=>setVisible(false);export const uploadResult=()=>owner.getSnapshot().result;export function UploadScreen(){const [visible,set]=React.useState(true);setVisible=set;const [session]=React.useState(()=>new UploadSession({policy:'disabled',pick:()=>DocumentImportService.instance.pickDocument(),discard:uri=>DocumentImportService.instance.discardSelection(uri),importFile:(u,n,a)=>DocumentImportService.instance.importFile(u,n,a),allowance:async()=>({kind:'disabled'}),lookup:async()=>({kind:'uncommitted'})}));owner=session;return <UploadSessionProvider owner={session}>{visible&&<ActualUploadScreen/>}</UploadSessionProvider>} export {finishImport,discardedSelections} from './src/core/services/document_import'; export {navigation} from 'expo-router'; export {readerEvent,readerFailure,readerCommands} from 'react-native-webview'; export {seedNote,noteRows} from './src/features/notes/NotesProvider'; function SelectionProbe(){const {selection}=useStudySelection();return <output data-selection>{JSON.stringify(selection)}</output>} export function ReaderHarness(){return <React.StrictMode><StudySelectionProvider><ReaderScreen/><SelectionProbe/></StudySelectionProvider></React.StrictMode>}`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', loader: { '.svg': 'dataurl', '.html': 'dataurl' },
    plugins: [{ name: 'platform-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const name = /core\/auth\/session$|^\.\/session$/.test(args.path) ? 'authio' : /ThemeContext$/.test(args.path) ? 'theme' : /NotesProvider$/.test(args.path)?'notesio': /document_storage$/.test(args.path) ? 'storage' : /document_import$/.test(args.path) ? 'importer' : args.path;
        if (Object.hasOwn(substitutions, name)) return { path: name, namespace: 'boundary' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: substitutions[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  ui = module.exports as Harness;
});

test('completed area remains a visible preview until explicit Save and duplicate presses create one highlight',async()=>{
  await mounted(ui.ReaderHarness,async doc=>{
    await act(async()=>ui.readerEvent({type:'page',page:1,totalPages:3,hasText:true}));
    const area={kind:'region',version:1,rect:[10,20,40,60],pageBox:[0,0,100,100]};
    await act(async()=>ui.readerEvent({type:'area-preview',page:1,anchor:area}));
    assert.match(doc.body.textContent!,/review the outlined rectangle/);
    assert.equal(doc.querySelector('[role="dialog"]'),null,'drawing must not open an obscuring editor');
    assert.ok(doc.querySelector('[aria-label="Add note or color"]'));assert.ok(doc.querySelector('[aria-label="Redraw area"]'));
    assert.equal((await ui.noteRows()).filter(item=>item.payload.anchor?.kind==='region').length,0);
    const button=doc.querySelector<HTMLElement>('[aria-label="Save area highlight"]')!;
    await act(async()=>{button.click();button.click();});
    const saved=(await ui.noteRows()).filter(item=>item.payload.anchor?.kind==='region');
    assert.equal(saved.length,1);assert.deepEqual(saved[0].payload.anchor?.rect,[10,20,40,60]);assert.equal(saved[0].payload.body,'');
    assert.equal(doc.querySelector('[aria-label="Save area highlight"]'),null);
  });
});
async function mounted(component: React.ComponentType, run: (doc: globalThis.Document, unmount: () => Promise<void>) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://flow.test' });
  const values = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.querySelector('main')!);
  let active = true;
  const unmount = async () => { if (active) { await act(async () => root.unmount()); active = false; } };
  try { ui.navigation.length = 0; await act(async () => root.render(React.createElement(component))); await run(dom.window.document, unmount); }
  finally { await unmount(); dom.window.close(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
}
async function press(doc: globalThis.Document, label: string) {
  const button = doc.querySelector<HTMLElement>('[aria-label="' + label + '"]'); assert.ok(button, label);
  await act(async () => button.click());
}
test('route unmount preserves Upload owner and background outcome without redirect; provider disposal cleans selection', async () => {
  await mounted(ui.UploadScreen, async (doc, unmount) => {
    ui.discardedSelections.length = 0;
    assert.equal(doc.querySelector('[aria-label="Scan a photo"], [aria-label="Take a photo"]'), null);
    await press(doc, 'Choose file'); await press(doc, 'Upload and continue');
    await act(async () => ui.hideUpload()); await act(async () => ui.finishImport());
    assert.deepEqual(ui.navigation, []);
    assert.deepEqual(ui.discardedSelections, ['picker.pdf']);
    assert.deepEqual(ui.uploadResult(), {success:true,document:{id:'doc-1'}});
    await unmount();await Promise.resolve();
    assert.deepEqual(ui.discardedSelections, ['picker.pdf']);
  });
});
test('failed recents metadata does not block reading or exact Study transfer; reader failures clear selection', async () => {
  await mounted(ui.ReaderHarness, async doc => {
    assert.match(doc.body.textContent!, /Recent activity could not be saved/);
    assert.doesNotMatch(doc.body.textContent!, /Unable to read this document/);
    await act(async () => ui.readerEvent({ type: 'page', page: 1, totalPages: 3, hasText: true }));
    const passage = '日本語 — loops <and> "variables"';
    await act(async () => ui.readerEvent({ type: 'selection', page: 1, text: passage }));
    await press(doc, 'Study');
    assert.deepEqual(ui.navigation, ['/topic-preview']);
    assert.deepEqual(JSON.parse(doc.querySelector('[data-selection]')!.textContent!), { documentId: 'doc-1', page: 1, text: passage });
    await act(async () => ui.readerFailure());
    assert.equal(doc.querySelector('[aria-label="Copy"]'), null);
    assert.match(doc.body.textContent!, /Unable to read this document/);
  });
});

test('reader Note survives focus loss and partial selection opens the saved full passage in reading mode',async()=>{
  await mounted(ui.ReaderHarness,async doc=>{
    await act(async()=>ui.readerEvent({type:'page',page:1,totalPages:3,hasText:true}));
    const full={kind:'text',version:1,surface:'pdf-text',textHash:'a'.repeat(64),ranges:[{blockId:'pdf-item-0',startUtf16:0,endUtf16:20}],quote:'Full saved quotation',prefix:'',suffix:''};
    await act(async()=>ui.seedNote(full));
    const partial={...full,ranges:[{blockId:'pdf-item-0',startUtf16:5,endUtf16:10}],quote:'saved',prefix:'Full ',suffix:' quotation'};
    await act(async()=>ui.readerEvent({type:'selection',page:1,text:'saved',anchor:partial}));
    const note=doc.querySelector<HTMLElement>('[aria-label="Note"]');assert.ok(note);assert.notEqual(note.getAttribute('aria-disabled'),'true');
    await act(async()=>ui.readerEvent({type:'selection',page:1,text:''}));
    assert.ok(doc.querySelector('[aria-label="Note"]'),'focus collapse preserves the captured action');
    await press(doc,'Note');
    assert.match(doc.body.textContent!,/Full saved quotation/);assert.match(doc.body.textContent!,/Existing attached explanation/);
    assert.ok(doc.querySelector('[aria-label="Edit note or color"]'));assert.equal(doc.querySelector('[aria-label="Note text"]'),null);
    await press(doc,'Edit note or color');
    const field=doc.querySelector<HTMLTextAreaElement>('[aria-label="Note text"]');
    assert.ok(field,'one Edit action opens the actual note editor');assert.equal(field.tagName,'TEXTAREA');
    assert.equal(field.value,'Existing attached explanation');
    await press(doc,'Close');
    await act(async()=>ui.readerEvent({type:'selection-reset',page:1}));assert.equal(doc.querySelector('[aria-label="Note"]'),null);
  });
});
