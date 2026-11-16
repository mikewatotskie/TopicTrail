import React, { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import type { CloudLibraryRuntime } from '../../core/services/cloud/runtime';
import { useAuth } from '../auth/AuthContext';
import { CloudRuntimeContext } from './CloudLibraryContext';
export function CloudLibraryProvider({children,runtime}:{children:React.ReactNode;runtime:CloudLibraryRuntime}) {
  const {gateway}=useAuth();
  useEffect(()=>runtime.attach(gateway),[runtime,gateway]);
  useEffect(()=>{
    const sync=()=>{if(AppState.currentState!=='background' && (typeof document==='undefined' || document.visibilityState!=='hidden'))void runtime.sync();};
    const subscription=AppState.addEventListener('change',state=>{if(state==='active')sync();});
    // React Native also defines window, but it does not supply browser event methods.
    const browser=Platform.OS==='web' && typeof window!=='undefined'
      && typeof window.addEventListener==='function' && typeof window.removeEventListener==='function' ? window : null;
    browser?.addEventListener('focus',sync);browser?.addEventListener('online',sync);
    const timer=setInterval(sync,60_000);
    return()=>{clearInterval(timer);subscription.remove();browser?.removeEventListener('focus',sync);browser?.removeEventListener('online',sync);};
  },[runtime]);
  return <CloudRuntimeContext.Provider value={runtime}>{children}</CloudRuntimeContext.Provider>;
}
