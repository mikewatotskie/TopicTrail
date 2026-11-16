import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

test('counterexample: account bookmark details must disappear synchronously when the account epoch changes', async()=>{
  const dom=new JSDOM('<main></main>',{url:'https://review.test'});
  const originals=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const storeCode=`const snapshot={status:'ready',bookmarks:[]};export const bookmarkStore={getSnapshot:()=>snapshot,subscribe:()=>()=>{},initialize:async()=>{},reload:async()=>{}};`;
  const snippets:Record<string,string>={
    'react-native':`import React from 'react';const Box=({children})=>React.createElement('div',null,children);export const View=Box,ScrollView=Box,Text=Box,ActivityIndicator=()=>null;`,
    'expo-router':`export const useRouter=()=>router;export const router={navigate(){}};`,
    '../../components':`import React from 'react';export const TTScreen=({children})=>React.createElement('div',null,children);export const TTCard=TTScreen;export const TTEmptyState=({title})=>React.createElement('p',null,title);export const TTButton=({label,onPress,accessibilityState})=>React.createElement('button',{'aria-label':label,'aria-selected':accessibilityState?.selected,onClick:onPress},label);export const TTAura=()=>null,TTSearchInput=()=>null,TTNoticeCard=()=>null;`,
    '../../navigation':`export const TTAppBar=()=>null;`,
    '../../core/design/tokens':`export const TTTypography={small:{}};`,
    '../../core/theme/ThemeContext':`export const useColors=()=>({colors:{link:'blue',muted:'gray'}});`,
    '../../components/TTResponsiveGrid':`import React from 'react';export const TTResponsiveGrid=({items,renderItem})=>React.createElement(React.Fragment,null,...items.map(renderItem));`,
    '../../core/layout/useResponsiveLayout':`export const useResponsiveLayout=()=>({gutter:16});`,
    '../resources/ResourceCard':`import React from 'react';export const ResourceCard=({resource,onDetails})=>React.createElement('button',{onClick:onDetails},'Details '+resource.title);`,
    '../resources/ResourceDetails':`import React from 'react';export const ResourceDetails=({resource})=>React.createElement('section',{'data-details':true},resource.title+' '+resource.topic);`,
    '../notes/NotesPanel':`import React from 'react';export const NotesPanel=()=>React.createElement('section',{'data-notes':true},'Account A private note');`,
    '../../core/layout/responsive':`export const TTContentWidths={prose:800};`,
    '../../core/services/bookmarks/storage':storeCode,
  };
  const result=await build({stdin:{contents:`export {SavedScreen} from './src/features/saved/SavedScreen';export {CloudRuntimeContext} from './src/features/library/CloudLibraryContext';`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',plugins:[{name:'review-ui-boundaries',setup(builder){builder.onResolve({filter:/.*/},args=>Object.hasOwn(snippets,args.path)?{path:args.path,namespace:'review'}:undefined);builder.onLoad({filter:/.*/,namespace:'review'},args=>({contents:snippets[args.path],loader:'tsx',resolveDir:process.cwd()}));}}]});
  const module={exports:{} as any};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(resolve('package.json')),module,module.exports);
  const {SavedScreen,CloudRuntimeContext}=module.exports;
  const accountSnapshot={status:'ready',bookmarks:[{id:'bookmark-a',title:'Account A private resource',topic:'Account A private topic',url:'https://example.com/private',providerName:'Source',providerId:'source',type:'Article',savedAt:'2026-11-11T00:00:00.000Z'}]};
  const accountStore={getSnapshot:()=>accountSnapshot,subscribe:()=>()=>{},initialize:async()=>{},reload:async()=>{}};
  let snapshot:any={identity:{uid:'account-a',project:'project'},key:'project/account-a',epoch:1,revision:0,phase:'ready'};
  const listeners=new Set<()=>void>();
  const runtime={getSnapshot:()=>snapshot,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},bookmarks:()=>accountStore};
  const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.querySelector('main')!);
  try{
    await act(async()=>root.render(React.createElement(CloudRuntimeContext.Provider,{value:runtime},React.createElement(SavedScreen))));
    await act(async()=>Array.from(dom.window.document.querySelectorAll('button')).find(button=>button.textContent==='Details Account A private resource')!.click());
    assert.match(dom.window.document.querySelector('[data-details]')!.textContent!,/Account A private topic/);
    await act(async()=>{snapshot={identity:null,key:null,epoch:2,revision:1,phase:'guest'};for(const listener of listeners)listener();});
    assert.doesNotMatch(dom.window.document.body.textContent!,/Account A private resource|Account A private topic/,'saved modal retains account A metadata after logout');
    await act(async()=>{snapshot={identity:{uid:'account-a',project:'project'},key:'project/account-a',epoch:3,revision:2,phase:'ready'};for(const listener of listeners)listener();});
    await act(async()=>dom.window.document.querySelector<HTMLElement>('[aria-label="Notes"]')!.click());
    assert.match(dom.window.document.querySelector('[data-notes]')!.textContent!,/Account A private note/);
    await act(async()=>{snapshot={identity:null,key:null,epoch:4,revision:3,phase:'guest'};for(const listener of listeners)listener();});
    assert.equal(dom.window.document.querySelector('[data-notes]'),null,'the old notes panel must unmount on logout');
    assert.equal(dom.window.document.querySelector('[aria-label="Resources"]')?.getAttribute('aria-selected'),'true');
  }finally{
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
});
