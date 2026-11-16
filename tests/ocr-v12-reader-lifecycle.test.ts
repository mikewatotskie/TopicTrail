import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { OcrCacheResult } from '../src/core/services/ocr_cache';
import type { ReaderConnection } from '../src/features/reader/reader_channel';
import type { usePageOcr } from '../src/features/reader/usePageOcr';

type Api = ReturnType<typeof usePageOcr>;
let dom: JSDOM;
let Harness: React.ComponentType<{ viewer: {current: ReaderConnection | null} }>;
let createRoot: typeof import('react-dom/client')['createRoot'];
let api: Api;
let current = true;
let read: (hash: string, page: number) => Promise<OcrCacheResult | null>;
let retryable = false;
let commit: (value: OcrCacheResult) => Promise<OcrCacheResult | null>;
const saves: unknown[][] = [];
const appEvents = new Set<(state: string) => void>();
const focusCleanups = new Set<() => void>();
const originals = new Map<string, PropertyDescriptor | undefined>();
const result = { text: 'Piña: English and Filipino.\nIkalawang linya.', confidence: null, truncated: false };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve=yes;}); return {resolve,promise}; }

before(async () => {
  dom = new JSDOM('<main></main>', { url: 'https://ocr.test' });
  const globals = { window:dom.window, document:dom.window.document, navigator:dom.window.navigator, IS_REACT_ACT_ENVIRONMENT:true,
    __pageOcrTest: { capture:(value:Api)=>{api=value;}, read:(hash:string,page:number)=>read(hash,page),
      save:async (...args:unknown[])=>{saves.push(args);return commit(args[2] as OcrCacheResult);}, isCurrent:()=>current,
      entry:async(hash:string,page:number)=>{const result=await read(hash,page);return result===null?null:{result,retryable};},
      onApp:(listener:(state:string)=>void)=>{appEvents.add(listener);return {remove:()=>appEvents.delete(listener)};},
      onBlur:(cleanup:()=>void)=>{focusCleanups.add(cleanup);return ()=>focusCleanups.delete(cleanup);} } };
  for (const [key,value] of Object.entries(globals)) { originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{value,configurable:true,writable:true}); }
  const compiled = await build({stdin:{contents:`import React,{useLayoutEffect} from 'react';import {usePageOcr} from './src/features/reader/usePageOcr';export function Harness({viewer}){const api=usePageOcr(viewer);useLayoutEffect(()=>globalThis.__pageOcrTest.capture(api));return null;}`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,packages:'external',platform:'node',format:'cjs',write:false,
    plugins:[{name:'page-ocr-io',setup(builder){
      builder.onResolve({filter:/^(\.\/useOcrCache|react-native|expo-router)$/},args=>({path:args.path,namespace:'ocr-io'}));
      builder.onLoad({filter:/.*/,namespace:'ocr-io'},args=>({loader:'js',resolveDir:process.cwd(),contents:args.path==='react-native'
        ? `export const AppState={addEventListener:(_,cb)=>globalThis.__pageOcrTest.onApp(cb)};`
        : args.path==='expo-router' ? `import {useEffect} from 'react';export function useFocusEffect(fn){useEffect(()=>{const clean=fn();const stop=globalThis.__pageOcrTest.onBlur(clean);return()=>{stop();clean();};},[fn]);}`
        : `export function useOcrCache(){return {warning:'',read:globalThis.__pageOcrTest.read,readEntry:globalThis.__pageOcrTest.entry,save:globalThis.__pageOcrTest.save,isCurrent:globalThis.__pageOcrTest.isCurrent};}`}));
    }}]});
  const module = {exports:{}};
  new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(resolve('package.json')),module,module.exports);
  Harness=(module.exports as {Harness:typeof Harness}).Harness;
  ({createRoot}=await import('react-dom/client'));
});
after(()=>{dom.window.close();for(const [key,value] of originals){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
async function mounted(run:(calls:{shown:unknown[];jobs:(string|undefined)[];cancelled:number},unmount:()=>Promise<void>)=>Promise<void>) {
  current=true;retryable=false;saves.length=0;read=async()=>null;commit=async value=>value;
  const calls={shown:[] as unknown[],jobs:[] as (string|undefined)[],cancelled:0};
  const viewer={current:{showOcr:(value:unknown)=>{calls.shown.push(value);},recognize:(id?:string)=>{calls.jobs.push(id);},cancelOcr:()=>{calls.cancelled++;}} as ReaderConnection};
  const root=createRoot(dom.window.document.querySelector('main')!);let open=true;
  const unmount=async()=>{if(open){open=false;await act(async()=>root.unmount());}};
  await act(async()=>root.render(React.createElement(Harness,{viewer})));
  try { await run(calls,unmount); } finally { await unmount(); }
}

test('page changes and account epochs suppress delayed cached transcripts',async()=>mounted(async calls=>{
  const first=deferred<OcrCacheResult|null>(),second=deferred<OcrCacheResult|null>();
  read=async(_hash,page)=>page===1?first.promise:second.promise;
  await act(async()=>{api.onPage('a'.repeat(64),1);api.onPage('a'.repeat(64),2);});
  await act(async()=>first.resolve(result));assert.equal(calls.shown.length,0);
  current=false;await act(async()=>second.resolve(result));assert.equal(calls.shown.length,0);assert.equal(saves.length,0);
}));

test('previously cached English is shown byte-for-byte without invoking a replacement engine',async()=>mounted(async calls=>{
  const old={...result,text:'  Existing English\r\nPiña — punctuation!  '};read=async()=>old;
  await act(async()=>api.onPage('b'.repeat(64),1));
  await act(async()=>api.recognize(async()=>assert.fail('Cached English must not be re-recognized')));
  assert.equal((calls.shown.at(-1) as {text:string}).text,old.text);assert.equal(calls.jobs.length,0);assert.equal(saves.length,0);assert.equal(api.running,false);
}));

test('native cancel and same-page retry ignore late text from the previous job',async()=>mounted(async calls=>{
  await act(async()=>api.onPage('a'.repeat(64),1));
  const stale=deferred<OcrCacheResult>();let first!:Promise<void>;let signal:AbortSignal|undefined;
  await act(async()=>{first=api.recognize(async s=>{signal=s;return stale.promise;});});
  await act(async()=>api.cancel());assert.equal(signal?.aborted,true);
  await act(async()=>api.recognize(async()=>result));
  await act(async()=>{stale.resolve({...result,text:'Old page'});await first;});
  assert.deepEqual(calls.shown,[{page:1,...result}]);assert.equal(saves.length,1);assert.equal(api.running,false);
}));

test('web cancel/retry requires the current job id even on the same page',async()=>mounted(async calls=>{
  await act(async()=>api.onPage('a'.repeat(64),1));
  await act(async()=>api.recognize());const oldId=calls.jobs.at(-1)!;
  await act(async()=>api.cancel());await act(async()=>api.recognize());const newId=calls.jobs.at(-1)!;
  assert.notEqual(oldId,newId);
  await act(async()=>api.receive({type:'ocr-result',page:1,...result,confidence:90,jobId:oldId}));
  assert.equal(calls.shown.length,0);assert.equal(api.running,true);
  await act(async()=>api.receive({type:'ocr-result',page:1,...result,confidence:90,jobId:newId}));
  assert.equal(calls.shown.length,1);assert.equal(saves.length,1);assert.equal(api.running,false);
}));

test('background and focus exit cancel recognition and unmount ignores native completion',async()=>mounted(async(calls,unmount)=>{
  await act(async()=>api.onPage('a'.repeat(64),1));await act(async()=>api.recognize());
  await act(async()=>{for(const listener of appEvents)listener('background');});assert.equal(api.running,false);
  await act(async()=>api.recognize());await act(async()=>{for(const cancel of focusCleanups)cancel();});assert.equal(api.running,false);
  const late=deferred<OcrCacheResult>();let pending!:Promise<void>;
  await act(async()=>{pending=api.recognize(async()=>late.promise);});
  await unmount();await act(async()=>{late.resolve(result);await pending;});
  assert.equal(calls.shown.length,0);assert.equal(saves.length,0);
}));

test('native output is exposed only after reconciliation and uses the canonical winning transcript',async()=>mounted(async calls=>{
  await act(async()=>api.onPage('a'.repeat(64),1));
  const accepted=deferred<OcrCacheResult|null>();commit=()=>accepted.promise;let pending!:Promise<void>;
  await act(async()=>{pending=api.recognize(async()=>({...result,text:'Late losing transcript'}));});
  assert.equal(saves.length,1);assert.equal(calls.shown.length,0);assert.equal(api.running,true);
  const winner={...result,text:'Canonical winner\nwith exact offsets.  '};
  await act(async()=>{accepted.resolve(winner);await pending;});
  assert.deepEqual(calls.shown,[{page:1,...winner}]);assert.equal(api.running,false);
}));

test('web output uses the canonical winner and duplicate result events cannot start another commit',async()=>mounted(async calls=>{
  await act(async()=>api.onPage('a'.repeat(64),1));await act(async()=>api.recognize());
  const id=calls.jobs.at(-1)!,accepted=deferred<OcrCacheResult|null>();commit=()=>accepted.promise;let pending!:Promise<void>;
  const event={type:'ocr-result' as const,page:1,...result,confidence:90,jobId:id};
  await act(async()=>{pending=api.receive(event);});
  await act(async()=>api.receive(event));
  assert.equal(saves.length,1);assert.equal(calls.shown.length,0);
  const winner={...result,text:'Already stored, not the worker result.'};
  await act(async()=>{accepted.resolve(winner);await pending;});
  assert.deepEqual(calls.shown,[{page:1,...winner}]);
}));

test('cancellation while persistence is pending fences the write and suppresses its later surface',async()=>mounted(async calls=>{
  await act(async()=>api.onPage('a'.repeat(64),1));
  const accepted=deferred<OcrCacheResult|null>();commit=()=>accepted.promise;let pending!:Promise<void>;
  await act(async()=>{pending=api.recognize(async()=>result);});
  const writeIsCurrent=saves[0][3] as ()=>boolean;assert.equal(writeIsCurrent(),true);
  await act(async()=>api.cancel());assert.equal(writeIsCurrent(),false);
  await act(async()=>{accepted.resolve(result);await pending;});
  assert.equal(calls.shown.length,0);assert.equal(api.running,false);
}));

test('blank current-engine pages can retry native and web recognition while blank legacy text stays exact',async()=>mounted(async calls=>{
  const blank={...result,text:''};read=async()=>blank;retryable=true;
  await act(async()=>api.onPage('a'.repeat(64),1));calls.shown.length=0;
  let nativeCalls=0;await act(async()=>api.recognize(async()=>{nativeCalls++;return result;}));
  assert.equal(nativeCalls,1);assert.deepEqual(calls.shown,[{page:1,...result}]);
  await act(async()=>api.recognize());assert.equal(calls.jobs.length,1);
  await act(async()=>api.cancel());
  retryable=false;const old={...blank,text:'  \r\n  '};read=async()=>old;
  await act(async()=>api.recognize(async()=>assert.fail('Legacy whitespace is immutable')));
  assert.equal((calls.shown.at(-1) as {text:string}).text,old.text);
}));

test('failed canonical persistence does not expose an unrepeatable note surface',async()=>mounted(async calls=>{
  await act(async()=>api.onPage('a'.repeat(64),1));commit=async()=>null;
  await act(async()=>api.recognize(async()=>result));
  assert.equal(calls.shown.length,0);assert.match(api.status,/could not be saved/);assert.equal(api.running,false);
}));
