import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebReaderEvent } from '../src/features/reader/reader_protocol';
import { connectNativeReader } from '../src/features/reader/reader_channel';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { ReaderMessage } from '../src/features/reader/selection';

test('render tokens reject events from an earlier resize within the same page generation', () => {
  const envelope={protocol:1,session:'private-reader-session',generation:3,renderToken:4,message:{type:'selection',text:'old',page:1}};
  assert.equal(parseWebReaderEvent(envelope,'private-reader-session',3,5),null);
  assert.deepEqual(parseWebReaderEvent({...envelope,renderToken:5},'private-reader-session',3,5),envelope.message);
  assert.equal(parseWebReaderEvent({...envelope,renderToken:undefined},'private-reader-session',3,5),null);
});

test('an unresponsive native reader reports failure and disposal cancels the startup deadline',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const messages:ReaderMessage[]=[];
  const abandoned=connectNativeReader(()=>{},message=>messages.push(message));abandoned.dispose();
  t.mock.timers.tick(15000);assert.equal(messages.length,0);
  const waiting=connectNativeReader(()=>{},message=>messages.push(message));
  t.mock.timers.tick(30000);assert.equal(messages.length,0);
  waiting.documentLoaded();
  waiting.documentLoaded();
  t.mock.timers.tick(14999);assert.equal(messages.length,0);t.mock.timers.tick(1);assert.equal(messages[0]?.type,'error');
  assert.equal(waiting.receive('{"type":"ready"}'),false);waiting.dispose();
  const confirmed=connectNativeReader(()=>{},message=>messages.push(message));
  confirmed.documentLoaded(true);
  t.mock.timers.tick(15000);
  assert.ok(messages.some(m=>m.type==='error' && m.message.includes('viewer started')));
  confirmed.dispose();
  const stalled=connectNativeReader(()=>{},message=>messages.push(message));
  t.mock.timers.tick(120000);assert.equal(messages.length,3);stalled.dispose();t.mock.timers.reset();
});

test('a native viewer that loses its initial ready signal can bind on document load',()=>{
  const injections:string[]=[], messages:ReaderMessage[]=[];
  const connection=connectNativeReader(script=>injections.push(script),message=>messages.push(message));
  try {
    connection.documentLoaded();
    assert.equal(injections.length,1);
    const session=JSON.parse(injections[0].match(/connectNative\((".*?")\)/)![1]);
    assert.equal(connection.receive(JSON.stringify({protocol:1,session,generation:0,renderToken:0,message:{type:'ready'}})),true);
    connection.documentLoaded();
    assert.equal(injections.length,1);
    assert.equal(messages[0].type,'ready');
  } finally { connection.dispose(); }
});

test('native binding retries a lost bind and stops after acknowledgement or disposal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const injections: string[] = [];
  const messages: ReaderMessage[] = [];
  const connection = connectNativeReader(script => injections.push(script), message => messages.push(message));
  const abandonedInjections: string[] = [];
  const abandoned = connectNativeReader(script => abandonedInjections.push(script), message => messages.push(message));
  try {
    connection.documentLoaded();
    abandoned.documentLoaded();
    abandoned.dispose();
    const abandonedCount = abandonedInjections.length;
    // The viewer never received the first injection and sends no other startup signal.
    for (let elapsed = 0; elapsed < 14000 && injections.length < 2; elapsed += 1000) {
      t.mock.timers.tick(1000);
    }
    assert.ok(injections.length >= 2, 'the host should retry before the bind deadline');
    assert.equal(injections[1], injections[0], 'retry must use the same reader session');
    const session = JSON.parse(injections[0].match(/connectNative\((".*?")\)/)![1]);
    const ready = JSON.stringify({ protocol: 1, session, generation: 0, renderToken: 0, message: { type: 'ready' } });
    assert.equal(connection.receive(ready), true);
    const boundCount = injections.length;
    t.mock.timers.tick(120000);
    assert.equal(injections.length, boundCount);
    assert.equal(abandonedInjections.length, abandonedCount);
    assert.equal(abandoned.receive(ready), false);
    assert.deepEqual(messages.map(message => message.type), ['ready']);
  } finally {
    connection.dispose();
    abandoned.dispose();
    t.mock.timers.reset();
  }
});

test('native viewer recovers a lost bound-ready ACK once and preserves render state on later bind replays', async () => {
  const bundle=await build({entryPoints:['src/features/reader/reader_web.ts'],bundle:true,write:false,format:'iife',
    define:{PDF_WORKER_SOURCE:'""',OCR_WORKER_SOURCE:'""'},plugins:[{name:'unused-pdf-in-docx-test',setup(b){
      b.onResolve({filter:/^pdfjs-dist\/legacy\/build\/pdf.mjs$/},()=>({path:'pdf',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const getDocument=()=>{throw Error("Unexpected PDF load")};export const GlobalWorkerOptions={};export class TextLayer{};'}));
    }}]});
  const dom=new JSDOM('<main id="content"></main>',{runScripts:'outside-only',url:'https://local.test'});
  const messages:ReaderMessage[]=[];const envelopes:any[]=[];const injected:string[]=[];let requests=0;
  Object.defineProperty(dom.window.document.documentElement,'clientWidth',{value:400,configurable:true});
  let notify:(()=>void)|undefined;
  const connection=connectNativeReader(script=>{injected.push(script);dom.window.eval(script);},message=>{
    messages.push(message);
    if (message.type === 'ready') connection.load({format:'docx',paragraphs:['first repeat','second repeat'],dark:false});
    notify?.();
  });
  const until=async(predicate:()=>boolean)=>{if(predicate())return;let timer:ReturnType<typeof setTimeout>|undefined;try{await new Promise<void>((resolve,reject)=>{notify=()=>{if(predicate())resolve();};timer=setTimeout(()=>reject(Error('Reader event timeout')),3000);});}finally{clearTimeout(timer);notify=undefined;}};
  let droppedAck = false;
  Object.assign(dom.window, {
    fetch: () => { requests++; throw Error('Network unavailable'); },
    ReactNativeWebView: {},
  });
  try{
    // Android can expose the bridge object before installing its postMessage method.
    assert.doesNotThrow(() => dom.window.eval(bundle.outputFiles[0].text));
    assert.equal(injected.length, 0);
    Object.assign(dom.window.ReactNativeWebView!, { postMessage(raw: string) {
      const envelope = JSON.parse(raw);
      envelopes.push(envelope);
      if (!droppedAck && envelope.message?.type === 'ready') {
        droppedAck = true;
        return;
      }
      connection.receive(raw);
    } });
    connection.documentLoaded();
    assert.equal(droppedAck, true);
    assert.equal(messages.length, 0);
    const bind = injected[0];
    const firstAck = envelopes.at(-1);
    const foreignSession = 'different-valid-reader-session';
    assert.equal(connection.receive(JSON.stringify({...firstAck,session:foreignSession})), false);
    const beforeForeignBind = envelopes.length;
    dom.window.TopicTrailReader.connectNative(foreignSession);
    assert.equal(envelopes.length, beforeForeignBind);
    // No more document or bridge events arrive. The host must initiate the replay.
    await until(()=>messages.some(m=>m.type==='page'));
    assert.deepEqual(envelopes.filter(e=>e.message?.type==='ready').map(e=>e.session),[firstAck.session,firstAck.session]);
    connection.selectAll();const selected=messages.at(-1);assert.equal(selected?.type,'selection');assert.equal(selected?.type==='selection'&&selected.anchor?.quote,'first repeat\nsecond repeat');
    const oldSelection=envelopes.at(-1);const oldCommand=injected.at(-1)!;
    Object.defineProperty(dom.window.document.documentElement,'clientWidth',{value:500,configurable:true});dom.window.dispatchEvent(new dom.window.Event('resize'));
    await until(()=>messages.filter(m=>m.type==='page').length===2);
    assert.equal(connection.receive(JSON.stringify(oldSelection)),false);
    const before=messages.length;dom.window.eval(oldCommand);assert.equal(messages.length,before);
    const beforeActiveReplay = envelopes.length;
    dom.window.eval(bind);
    dom.window.TopicTrailReader.connectNative(foreignSession);
    assert.equal(envelopes.length, beforeActiveReplay);
    assert.equal(messages.filter(m=>m.type==='ready').length,1);
    assert.equal(injected.filter(s=>s.includes('"command":{"type":"load"')).length,1);
    connection.selectAll();assert.equal(messages.at(-1)?.type,'selection');
    const newSelection=envelopes.at(-1);assert.ok(newSelection.renderToken>oldSelection.renderToken);
    assert.equal(newSelection.session, firstAck.session);
    assert.equal(newSelection.generation, oldSelection.generation);
    assert.equal(connection.receive(JSON.stringify({...newSelection,session:'different-account-reader'})),false);
    connection.load({format:'docx',paragraphs:['replacement document'],dark:true});await until(()=>messages.filter(m=>m.type==='page').length===3);
    assert.equal(connection.receive(JSON.stringify(newSelection)),false);
    assert.equal(requests,0);
    connection.dispose();assert.equal(connection.receive(JSON.stringify(newSelection)),false);
    const afterDispose = envelopes.length;
    dom.window.eval(bind);
    assert.equal(envelopes.length, afterDispose);
  }finally{connection.dispose();dom.window.close();}
});
