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
}
let ui: Harness;
before(async () => {
  const tokenPath = resolve('src/core/design/tokens.ts').replaceAll('\\', '/');
  const substitutions: Record<string, string> = {
    'react-native': `export * from 'react-native-web'; export const Platform={OS:'android',select:v=>v.android??v.default};`,
    'expo-router': `export const navigation=[]; export const router={replace:p=>navigation.push(typeof p==='string'?p:p.pathname),push:p=>navigation.push(typeof p==='string'?p:p.pathname),canGoBack:()=>true,back:()=>navigation.push('back')}; export const useLocalSearchParams=()=>({documentId:'doc-1'});export const useFocusEffect=effect=>{React.useEffect(effect,[effect])};import React from 'react';`,
    'expo-asset': `export const Asset={fromModule:()=>({downloadAsync:async()=>({localUri:'reader.html'})})};`,
    'expo-file-system': `export class File {exists=true;size=128;async text(){return '<html></html>'} async base64(){return 'AA=='} }`,
    'expo-clipboard': `export const setStringAsync=async()=>{};`,
    'expo-image': `import React from 'react'; export const Image=()=>React.createElement('span');`,
    '@expo/vector-icons': `import React from 'react'; export const Ionicons=()=>React.createElement('span'); Ionicons.glyphMap={};`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web'; export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    'react-native-webview': `import React,{forwardRef,useImperativeHandle} from 'react'; let latest; export const readerEvent=m=>latest.onMessage({nativeEvent:{data:JSON.stringify(m)}}); export const readerFailure=()=>latest.onError(); export default forwardRef((props,ref)=>{latest=props;useImperativeHandle(ref,()=>({injectJavaScript(){}}));return React.createElement('div',{'data-reader':true})});`,
    authio: `export function getTopicTrailAuthGateway(){throw Error('Injected auth only')}`,
    theme: `import {TTLightColors} from '${tokenPath}'; export const useColors=()=>({colors:TTLightColors}); export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
    storage: `export const DocumentStorage={instance:{getDocument:async()=>({id:'doc-1',title:'Real syllabus',format:'pdf',filePath:'owned.pdf'}),updateLastOpened:async()=>{throw Error('Disk full')}}};`,
    importer: `let done; export const discardedSelections=[];export const finishImport=()=>done({success:true,document:{id:'doc-1'}}); export const DocumentImportService={instance:{pickDocument:async()=>({name:'Course.pdf',uri:'picker.pdf',size:128}),discardSelection:uri=>discardedSelections.push(uri),importFile:()=>new Promise(resolve=>{done=resolve})}};`,
  };
  const result = await build({ stdin: { contents: `import React from 'react'; import {ReaderScreen} from './src/features/reader/ReaderScreen'; import {StudySelectionProvider,useStudySelection} from './src/features/reader/StudySelectionContext'; import {UploadScreen as ActualUploadScreen} from './src/features/upload/UploadScreen';import {UploadSessionProvider} from './src/features/upload/UploadSessionContext';import {UploadSession} from './src/features/upload/upload_session';import {DocumentImportService} from './src/core/services/document_import';let setVisible,owner;export const hideUpload=()=>setVisible(false);export const uploadResult=()=>owner.getSnapshot().result;export function UploadScreen(){const [visible,set]=React.useState(true);setVisible=set;const [session]=React.useState(()=>new UploadSession({policy:'disabled',pick:()=>DocumentImportService.instance.pickDocument(),discard:uri=>DocumentImportService.instance.discardSelection(uri),importFile:(u,n,a)=>DocumentImportService.instance.importFile(u,n,a),allowance:async()=>({kind:'disabled'}),lookup:async()=>({kind:'uncommitted'})}));owner=session;return <UploadSessionProvider owner={session}>{visible&&<ActualUploadScreen/>}</UploadSessionProvider>} export {finishImport,discardedSelections} from './src/core/services/document_import'; export {navigation} from 'expo-router'; export {readerEvent,readerFailure} from 'react-native-webview'; function SelectionProbe(){const {selection}=useStudySelection();return <output data-selection>{JSON.stringify(selection)}</output>} export function ReaderHarness(){return <StudySelectionProvider><ReaderScreen/><SelectionProbe/></StudySelectionProvider>}`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', loader: { '.svg': 'dataurl', '.html': 'dataurl' },
    plugins: [{ name: 'platform-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const name = /core\/auth\/session$|^\.\/session$/.test(args.path) ? 'authio' : /ThemeContext$/.test(args.path) ? 'theme' : /document_storage$/.test(args.path) ? 'storage' : /document_import$/.test(args.path) ? 'importer' : args.path;
        if (Object.hasOwn(substitutions, name)) return { path: name, namespace: 'boundary' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: substitutions[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  ui = module.exports as Harness;
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
