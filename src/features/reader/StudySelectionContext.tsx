import React, { createContext, useCallback, useContext, useState } from 'react';
import { useCloudLibrary } from '../library/CloudLibraryContext';
export interface StudySelection { documentId: string; text: string; page: number }
const Context = createContext<{ selection: StudySelection | null; setSelection: (value: StudySelection) => void } | null>(null);
export function StudySelectionProvider({ children }: { children: React.ReactNode }) {
  const {runtime,state}=useCloudLibrary();
  const [stored, setStored] = useState<{epoch:number;value:StudySelection}|null>(null);
  const selection=stored?.epoch===state.epoch?stored.value:null;
  const setSelection=useCallback((value:StudySelection)=>{
    // A late reader callback must not replace the new account's selection.
    if ((runtime?.getSnapshot().epoch ?? 0) !== state.epoch) return;
    setStored({epoch:state.epoch,value});
  },[runtime,state.epoch]);
  return <Context.Provider value={{ selection, setSelection }}>{children}</Context.Provider>;
}
export function useStudySelection() {
  const value = useContext(Context);
  if (!value) throw new Error('StudySelectionProvider is missing');
  return value;
}
