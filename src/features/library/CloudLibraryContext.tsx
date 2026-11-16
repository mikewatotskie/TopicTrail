import { createContext, useContext, useSyncExternalStore } from 'react';
import type { CloudLibraryRuntime } from '../../core/services/cloud/runtime';
import type { CloudSyncSnapshot } from '../../core/services/cloud/engine';
export const CloudRuntimeContext = createContext<CloudLibraryRuntime | null>(null);
const guest: CloudSyncSnapshot = { identity:null,key:null,epoch:0,revision:0,phase:'guest',message:'Files on this device',pending:0,lastSyncedAt:null };
const emptySubscribe = () => () => {};
const emptySnapshot = () => guest;
export function useCloudLibrary() {
  const runtime=useContext(CloudRuntimeContext);
  const state=useSyncExternalStore(runtime?.subscribe??emptySubscribe,runtime?.getSnapshot??emptySnapshot,runtime?.getSnapshot??emptySnapshot);
  return {runtime,state};
}
