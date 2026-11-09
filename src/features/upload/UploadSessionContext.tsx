import React, {createContext,useCallback,useContext,useEffect,useState,useSyncExternalStore} from 'react';
import {UploadSession} from './upload_session';
interface OwnerContext {
  getOwner(): UploadSession;
  current(): UploadSession | null;
  retain(): () => void;
}
const Context=createContext<OwnerContext|null>(null);
function productionOwner() {
  // Lazy boundaries keep document/picker initialization out of unrelated auth routes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {DocumentStorage}=require('../../core/services/document_storage') as typeof import('../../core/services/document_storage');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {DocumentImportService}=require('../../core/services/document_import') as typeof import('../../core/services/document_import');
  const storage=DocumentStorage.instance;
  // Each provider lifetime owns its importer staging; late cleanup cannot delete another owner's selection.
  const importer=new DocumentImportService(storage);
  return new UploadSession({
    policy:storage.guestUploadPolicy,
    pick:()=>importer.pickDocument(),
    discard:uri=>importer.discardSelection(uri),
    importFile:(uri,name,attempt)=>importer.importFile(uri,name,attempt),
    allowance:()=>storage.getGuestAllowance(),
    lookup:id=>storage.lookupGuestImportOutcome(id),
  });
}
export function UploadSessionProvider({children,owner:injected}:{children:React.ReactNode;owner?:UploadSession}) {
  const [value]=useState<OwnerContext>(()=>{
    let owner=injected??null;
    let lifetime=0;
    return {
      getOwner(){return owner??(owner=productionOwner());},
      current:()=>owner,
      retain(){
        const generation=++lifetime;
        // StrictMode's effect replay retains the same owner; true disposal releases staging.
        return ()=>{queueMicrotask(()=>{if(lifetime===generation)owner?.dispose();});};
      },
    };
  });
  useEffect(()=>value.retain(),[value]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useUploadSession() {
  const context=useContext(Context);
  if(!context)throw Error('Upload requires UploadSessionProvider');
  const owner=context.getOwner();
  const state=useSyncExternalStore(owner.subscribe,owner.getSnapshot,owner.getSnapshot);
  return {owner,state};
}
/** Reads only an existing owner; auth screens never initialize upload services. */
export function useUploadContinuation(sessionId?:string) {
  const context=useContext(Context);
  const owner=context?.current();
  const subscribe=useCallback((changed:()=>void)=>owner?.subscribe(changed)??(()=>{}),[owner]);
  const snapshot=useCallback(()=>owner?.getSnapshot().sessionId??null,[owner]);
  const current=useSyncExternalStore(subscribe,snapshot,snapshot);
  return !!sessionId && current===sessionId;
}
