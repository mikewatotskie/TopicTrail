import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReaderInput, parseWebReaderEvent } from '../src/features/reader/reader_protocol';

test('web reader accepts bounded document bytes and literal paragraphs, rejects ambiguous input',()=>{
 assert.ok(validateReaderInput({format:'pdf',bytes:new ArrayBuffer(128),dark:false}));
 assert.equal(validateReaderInput({format:'pdf',bytes:new ArrayBuffer(1),base64:'AA==',dark:false}),false);
 assert.equal(validateReaderInput({format:'docx',paragraphs:['<script>literal</script>'],dark:true}),true);
 assert.equal(validateReaderInput({format:'pdf',bytes:new ArrayBuffer(50*1024*1024+1),dark:false}),false);
 assert.equal(validateReaderInput({format:'docx',paragraphs:[4],dark:false}),false);
});
test('web events reject foreign nonce, stale render and oversized selections',()=>{
 const envelope={protocol:1,session:'test-session',generation:2,message:{type:'selection',text:' loops 日本語 ',page:1}};
 assert.deepEqual(parseWebReaderEvent(envelope,'test-session',2),envelope.message);
 assert.equal(parseWebReaderEvent(envelope,'other-session',2),null);
 assert.equal(parseWebReaderEvent(envelope,'test-session',3),null);
 assert.equal(parseWebReaderEvent({...envelope,message:{...envelope.message,text:'x'.repeat(50001)}},'test-session',2),null);
});

// The timeout only bounds failures; success always requires the relevant channel event.
async function channelEvent<T>(event: Promise<T>, label: string): Promise<T> {
 let timeout: ReturnType<typeof setTimeout> | undefined;
 try {
  return await Promise.race([event, new Promise<never>((_, reject) => {
   timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10000);
  })]);
 } finally { clearTimeout(timeout); }
}

// Real channel implementation with only the iframe transport represented by DOM/MessagePorts.
for (const readyDelay of [0, 40]) test(`only matching frame and nonce bind a port; bytes transfer and disposal invalidate events (ready delay ${readyDelay}ms)`, async()=>{
 const {JSDOM}=await import('jsdom');const{connectWebReader}=await import('../src/features/reader/reader_channel');
 const dom=new JSDOM('<iframe data-reader-session="12345678-1234-1234-1234-123456789abc"></iframe>',{url:'https://reader.test'});
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{value:dom.window,configurable:true});
 const frame=dom.window.document.querySelector('iframe')!;const session=frame.dataset.readerSession!;
 let transferred:MessagePort|undefined;let binds=0;let readyTimer:ReturnType<typeof setTimeout>|undefined;
 frame.contentWindow!.postMessage=((value:unknown,_origin:unknown,ports?:MessagePort[])=>{if((value as {type:string}).type==='topictrail-connect'){binds++;transferred=ports![0]}}) as Window['postMessage'];
 let onReceived:(()=>void)|undefined;
 const received:unknown[]=[];const connection=connectWebReader(frame,m=>{received.push(m);onReceived?.()});
 const nextReceived=(label:string)=>channelEvent(new Promise<void>(resolve=>{onReceived=resolve}),label);
 const hello=(source:Window|null,nonce:string)=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source,data:{protocol:1,type:'topictrail-ready',session:nonce}}));
 try{
 hello(dom.window as unknown as Window,session);hello(frame.contentWindow,'wrong');assert.equal(binds,0);
 hello(frame.contentWindow,session);assert.equal(binds,1);
 const ready=nextReceived('reader ready event');
 const deliverReady=()=>transferred!.postMessage({protocol:1,session,generation:0,message:{type:'ready'}});
 // The delayed case catches an assertion after an arbitrary 20ms sleep, even without CPU contention.
 if(readyDelay)readyTimer=setTimeout(deliverReady,readyDelay);else deliverReady();
 await ready;assert.deepEqual(received,[{type:'ready'}]);
 const bytes=new ArrayBuffer(20);const command=new Promise<{generation:number;command:{input:{bytes:ArrayBuffer}}}>(resolve=>{transferred!.onmessage=e=>resolve(e.data);transferred!.start()});
 connection.load({format:'pdf',bytes,dark:false});const sent=await channelEvent(command,'load command');assert.equal(bytes.byteLength,0);assert.equal(sent.command.input.bytes.byteLength,20);
 const selection=nextReceived('current selection');
 transferred!.postMessage({protocol:1,session,generation:0,message:{type:'selection',text:'stale',page:1}});
 transferred!.postMessage({protocol:1,session,generation:sent.generation,message:{type:'selection',text:'actual',page:1}});await selection;
 // Messages on this port are ordered: actual delivery is the barrier proving stale was processed.
 assert.deepEqual(received,[{type:'ready'},{type:'selection',text:'actual',page:1}]);
 const closed=channelEvent(new Promise<void>(resolve=>transferred!.addEventListener('close',()=>resolve(),{once:true})),'disposed channel close');
 connection.dispose();transferred!.postMessage({protocol:1,session,generation:sent.generation,message:{type:'selection',text:'late',page:1}});await closed;
 assert.deepEqual(received,[{type:'ready'},{type:'selection',text:'actual',page:1}]);
 }finally{clearTimeout(readyTimer);connection.dispose();transferred?.close();dom.window.close();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window')}
});
