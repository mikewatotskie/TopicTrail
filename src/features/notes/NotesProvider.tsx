import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { readSupabaseConfiguration } from '../../core/auth/supabase_config';
import { createAnnotationPort } from '../../core/services/annotation_port';
import { createAnnotationRemote } from '../../core/services/annotations/remote';
import { useCloudLibrary } from '../library/CloudLibraryContext';
import { NotesController, type NotesSnapshot } from './NotesController';
import type { CloudLibraryRuntime } from '../../core/services/cloud/runtime';
const Context=createContext<NotesController|null>(null);
const empty:NotesSnapshot={items:[],trash:[],drafts:[],phase:'loading',message:'Notes are loading with your library.',pending:0,lastSyncedAt:null};
const subscribeEmpty=()=>()=>{},getEmpty=()=>empty;
export function NotesProvider({children}:{children:React.ReactNode}){
  const {runtime,state}=useCloudLibrary();
  if(!runtime||state.phase==='unavailable')return <Context.Provider value={null}>{children}</Context.Provider>;
  return <NotesScope key={state.epoch} runtime={runtime} revision={state.revision}>{children}</NotesScope>;
}
function NotesScope({children,runtime,revision}:{children:React.ReactNode;runtime:CloudLibraryRuntime;revision:number}){
  const [controller]=useState(()=>{
    const context=runtime.annotationContext(),gate=context.account?runtime.engine.getRetryGate():undefined;
    return new NotesController(context,createAnnotationPort(context.scope),runtime.sync,
      async (signal,pages)=>createAnnotationRemote(readSupabaseConfiguration(),await context.session(),signal,gate?gate.guard(context.fetcher):context.fetcher,pages),gate);
  });
  useEffect(()=>{
    const release=controller.hold();
    void controller.refresh();void controller.sync();
    const sync=()=>{if(AppState.currentState!=='background')void controller.sync();};
    const subscription=AppState.addEventListener('change',value=>{if(value==='active')sync();});
    const browser=Platform.OS==='web'&&typeof window!=='undefined'&&typeof window.addEventListener==='function'&&typeof window.removeEventListener==='function'?window:null;
    browser?.addEventListener('focus',sync);browser?.addEventListener('online',sync);
    const timer=setInterval(sync,60_000);
    return()=>{clearInterval(timer);subscription.remove();browser?.removeEventListener('focus',sync);browser?.removeEventListener('online',sync);release();};
  },[controller]);
  useEffect(()=>{void controller.refresh();},[controller,revision]);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}
export function useNotes(){const controller=useContext(Context);const state=useSyncExternalStore(controller?.subscribe??subscribeEmpty,controller?.getSnapshot??getEmpty,controller?.getSnapshot??getEmpty);return {controller,state};}
