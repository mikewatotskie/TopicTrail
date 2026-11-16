import { createAnnotationStore, type AnnotationStore } from '../../core/services/annotations/store';
import type { AnnotationDraft, AnnotationListItem, AnnotationPort, AnnotationRecord, AnnotationRemote } from '../../core/services/annotations/types';
import type { CloudLibraryRuntime } from '../../core/services/cloud/runtime';
import { SyncRateLimit, SyncRetryGate, scheduleRetry, syncDelayedMessage } from '../../core/services/cloud/sync_retry';
import { PagedPull } from '../../core/services/cloud/paged_pull';
export interface NotesSnapshot {items:AnnotationListItem[];trash:AnnotationListItem[];drafts:AnnotationDraft[];phase:'loading'|'local'|'ready'|'syncing'|'waiting'|'error';message:string;pending:number;lastSyncedAt:number|null}
export class NotesController {
  readonly store:AnnotationStore;
  private active=true;
  private snapshot:NotesSnapshot={items:[],trash:[],drafts:[],phase:'loading',message:'Loading notes…',pending:0,lastSyncedAt:null};
  private listeners=new Set<()=>void>();
  private loading:Promise<void>|undefined;
  private syncing:Promise<void>|undefined;
  private refreshAgain=false;
  private syncAgain=false;
  private retryTimer?:ReturnType<typeof setTimeout>;
  private pull?:{libraryReady:boolean;notesMerged:boolean;pages:PagedPull<AnnotationRecord>};
  private abort=new AbortController();
  private holds=0;
  constructor(readonly context:ReturnType<CloudLibraryRuntime['annotationContext']>,port:AnnotationPort,
    private readonly librarySync:()=>Promise<void>,private readonly remote:(signal:AbortSignal,pages:PagedPull<AnnotationRecord>)=>Promise<AnnotationRemote>,
    private readonly gate=new SyncRetryGate()){
    this.store=createAnnotationStore({...context,port,checkActive:this.check,onChange:()=>{void this.refresh();}});
  }
  private check=()=>{if(!this.active)throw Error('The notes account changed.');this.context.checkActive();};
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(patch:Partial<NotesSnapshot>){this.check();this.snapshot={...this.snapshot,...patch};for(const listener of this.listeners)listener();}
  refresh=():Promise<void>=>{
    this.refreshAgain=true;return this.loading??=Promise.resolve().then(async()=>{
      while(this.active&&this.refreshAgain){this.refreshAgain=false;
        try{const items=await this.store.list({includeParentDeleted:true}),trash=await this.store.list({trash:true,includeParentDeleted:true}),state=await this.store.read();this.check();
          this.publish({items,trash,drafts:state.drafts,pending:state.pending.length,...(this.snapshot.phase==='loading'?{phase:this.context.account?'ready' as const:'local' as const,message:this.context.account?'Notes saved on this device.':'Guest notes are saved on this device.'}:{})});
        }catch{if(this.active)try{this.publish({phase:'error',message:'Notes could not be loaded. Existing notes have been preserved. Retry.'});}catch{/* account changed */}}
      }
    }).finally(()=>{this.loading=undefined;});
  };
  sync=():Promise<void>=>{
    if(!this.context.account)return this.refresh();
    this.syncAgain=true;return this.syncing??=Promise.resolve().then(async()=>{
      while(this.active&&this.syncAgain){this.syncAgain=false;let paused=false;
        try{this.check();await this.gate.prepare();this.check();
          clearTimeout(this.retryTimer);this.retryTimer=undefined;
          this.publish({phase:'syncing',message:'Synchronizing notes…'});
          const pull=this.pull??={libraryReady:false,notesMerged:false,pages:new PagedPull<AnnotationRecord>()};
          if(!pull.libraryReady){await this.librarySync();this.check();this.gate.assertReady();pull.libraryReady=true;}
          const remote=await this.remote(this.abort.signal,pull.pages);this.check();
          if(!pull.notesMerged){await this.store.merge(await remote.list());this.check();pull.notesMerged=true;}
          // Read after each acknowledgement: a conflict may supersede all queued edits for that note.
          for(let count=0;count<10000;count++){const op=(await this.store.read()).pending[0];this.check();if(!op)break;
            const reply=await remote.apply(op);this.check();await this.store.acknowledge(op.operationId,reply);this.check();}
          await this.store.merge(await remote.list());this.check();await this.refresh();this.check();
          const conflicts=(await this.store.read()).conflicts.length;
          await this.gate.completed();this.check();
          this.publish({phase:'ready',lastSyncedAt:Date.now(),message:conflicts?'Choose a version for conflicting notes.':'Saved notes synchronized with this account.'});
        }catch(error){if(this.active)try{
          this.check();
          if(error instanceof SyncRateLimit){
            paused=true;
            const until=await this.gate.defer(error);this.check();this.syncAgain=false;
            clearTimeout(this.retryTimer);this.retryTimer=scheduleRetry(until,()=>{if(this.active)void this.sync();});
            this.publish({phase:'waiting',message:syncDelayedMessage});await this.refresh();
          }else{await this.refresh();this.publish({phase:'error',message:'Notes are saved on this device. Cloud sync could not finish; retry when connected.'});}
        }catch{/* old account */}}finally{if(!paused)this.pull=undefined;}
      }
    }).finally(()=>{this.syncing=undefined;});
  };
  async run<T>(operation:(store:AnnotationStore)=>Promise<T>):Promise<T>{this.check();const result=await operation(this.store);this.check();if(this.pull)this.pull.libraryReady=false;await this.refresh();void this.sync();return result;}
  async copyGuest(port:AnnotationPort):Promise<number>{
    this.check();if(!this.context.account)throw Error('Sign in before copying Guest notes.');
    const guest=createAnnotationStore({scope:'guest',port,checkActive:this.check,parent:this.context.guestParent});
    const items=await guest.list();this.check();
    const mapping=await this.context.copyGuestDocuments(items.flatMap(item=>item.payload.documentId?[item.payload.documentId]:[]));this.check();
    return this.run(store=>store.copyGuest(items.map(item=>item.payload),mapping));
  }
  dispose(){this.active=false;clearTimeout(this.retryTimer);this.abort.abort();this.listeners.clear();}
  /** StrictMode replays effect setup/cleanup without throwing away component state. */
  hold(){this.holds++;return()=>{this.holds--;queueMicrotask(()=>{if(this.holds===0)this.dispose();});};}
}
