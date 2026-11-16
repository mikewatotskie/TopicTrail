import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { StudySelectionProvider, useStudySelection } from '../src/features/reader/StudySelectionContext';
import { CloudRuntimeContext } from '../src/features/library/CloudLibraryContext';
import type { CloudLibraryRuntime } from '../src/core/services/cloud/runtime';
import type { CloudSyncSnapshot } from '../src/core/services/cloud/engine';

test('selection setter stays stable per account and rejects obsolete account callbacks', async () => {
  const dom = new JSDOM('<main></main>');
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})) {
    original.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const { createRoot } = await import('react-dom/client');
  const root=createRoot(dom.window.document.querySelector('main')!);
  let state: CloudSyncSnapshot={identity:null,key:null,epoch:1,revision:0,phase:'guest',message:'',pending:0,lastSyncedAt:null};
  const listeners=new Set<()=>void>();
  const runtime={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};}} as CloudLibraryRuntime;
  let observed!:ReturnType<typeof useStudySelection>;
  function Probe(){observed=useStudySelection();return null;}
  try {
    await act(async()=>{root.render(React.createElement(CloudRuntimeContext.Provider,{value:runtime},React.createElement(StudySelectionProvider,null,React.createElement(Probe))));});
    const oldSetter=observed.setSelection;
    await act(async()=>{oldSetter({documentId:'A',text:'old account',page:1});});
    assert.equal(observed.setSelection,oldSetter);
    await act(async()=>{state={...state,epoch:2};for(const fn of listeners)fn();});
    assert.equal(observed.selection,null);
    assert.notEqual(observed.setSelection,oldSetter);
    await act(async()=>{observed.setSelection({documentId:'B',text:'new account',page:2});});
    await act(async()=>{oldSetter({documentId:'A',text:'late old account',page:3});});
    assert.equal((observed.selection as {documentId:string}|null)?.documentId,'B');
  } finally {
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,descriptor] of original){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
});
