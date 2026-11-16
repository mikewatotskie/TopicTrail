import type { AuthGateway } from '../../auth/types';
import { readSupabaseConfiguration } from '../../auth/supabase_config';
import type { DocumentStorageApi } from '../document_storage_contract';
import { CloudSyncEngine } from './engine';
import { createCloudRemote } from './remote';
import { cloudIdentityKey, type CloudCache, type CloudIdentity } from './types';
import { createDocumentFacade, type LibrarySelection } from './facade';
import { newStudyOperationId, studyView, type StudyKind, type StudyMutation } from './study_state';
import { StudyBookmarks } from './study_bookmarks';
import type { ReadingProgressStore } from '../reading_progress';
import { sha256 } from './sha256';
import type { AnnotationParent, AnnotationDocumentMapping } from '../annotations/types';

export class CloudLibraryRuntime {
  private gateway?: AuthGateway;
  private caches = new Map<string, CloudCache>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private engineRevision = 0;
  private bookmarkStores=new Map<string,{epoch:number;store:StudyBookmarks}>();
  private progressTimer:ReturnType<typeof setTimeout>|undefined;
  readonly engine: CloudSyncEngine;
  readonly documents: DocumentStorageApi;
  private view: ReturnType<CloudSyncEngine['getSnapshot']>;
  constructor(readonly legacy: DocumentStorageApi, private readonly readLegacy: (path: string) => Promise<Uint8Array>,
    private readonly platform: { cache(identity: CloudIdentity): CloudCache; fetcher: typeof fetch }) {
    this.engine = new CloudSyncEngine({ legacy, readLegacy: doc => readLegacy(doc.filePath), cache: identity => this.cache(identity),
      session: () => this.gateway?.getCloudSession?.() ?? Promise.reject(new Error('Cloud account access is unavailable. Sign in again.')),
      remote: (session, signal, gate, pull) => createCloudRemote(readSupabaseConfiguration(), session, signal, gate.guard(platform.fetcher), pull) });
    this.engine.select(null, false); this.view = this.engine.getSnapshot();
    this.engine.subscribe(() => this.emit());
    this.documents = createDocumentFacade(() => this.selection(), upload => { this.emit(true); if (upload) void this.engine.sync(); });
  }
  private emit(force = false) {
    const next = this.engine.getSnapshot();
    if (force || this.engineRevision !== next.revision || this.view.epoch !== next.epoch) this.revision++;
    this.engineRevision = next.revision; this.view = { ...next, revision: this.revision };
    for (const listener of this.listeners) listener();
    if(next.key)void this.bookmarkStores.get(next.key)?.store.reload().catch(()=>{});
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private cache(identity: CloudIdentity) {
    const key = cloudIdentityKey(identity); let cache = this.caches.get(key);
    if (!cache) { cache = this.platform.cache(identity); this.caches.set(key, cache); }
    return cache;
  }
  attach(gateway: AuthGateway): () => void {
    this.gateway = gateway;
    const update = () => {
      if (this.gateway !== gateway) return;
      const state = gateway.getSnapshot();
      if (state.status === 'account' && state.account.emailVerified && state.account.projectNamespace) {
        this.engine.select({project:state.account.projectNamespace,uid:state.account.uid});
      } else this.engine.select(null, state.status === 'guest');
    };
    const unsubscribe = gateway.subscribe(update); update();
    return () => { unsubscribe(); if (this.gateway === gateway) { this.gateway = undefined; this.engine.select(null, false); } };
  }
  private selection(): LibrarySelection {
    const state = this.gateway?.getSnapshot(); const snapshot = this.engine.getSnapshot();
    if (state?.status === 'guest' && !snapshot.identity && snapshot.phase === 'guest') return {key:'guest',epoch:snapshot.epoch,uid:null,store:this.legacy};
    if (state?.status === 'account' && snapshot.identity?.uid === state.account.uid && snapshot.identity.project === state.account.projectNamespace) {
      return {key:cloudIdentityKey(snapshot.identity),epoch:snapshot.epoch,uid:snapshot.identity.uid,store:this.cache(snapshot.identity)};
    }
    throw new Error('Your account library is loading or unavailable. Please retry when sign-in finishes.');
  }
  async readBytes(path: string): Promise<Uint8Array> {
    const selected = this.selection();
    let bytes: Uint8Array;
    if (selected.uid) {
      const doc = (await selected.store.getAllDocuments()).find(item => item.filePath === path);
      if (!doc) throw new Error('This file is not in the current account library.');
      bytes = await (selected.store as CloudCache).readBytes(doc);
    } else bytes = await this.readLegacy(path);
    const current = this.selection();
    if (current.key !== selected.key || current.epoch !== selected.epoch) throw new Error('The account library changed.');
    return bytes;
  }
  async legacyCount(): Promise<number> { return (await this.legacy.getAllDocuments()).length; }
  accountLabel(): string | null { const state=this.gateway?.getSnapshot(); return state?.status==='account' && state.account.uid===this.view.identity?.uid ? state.account.email : null; }
  async documentAvailability():Promise<ReadonlyMap<string,'available'|'waiting'|'cloud-only'|'attention'>>{
    const selected=this.selection();const result=new Map<string,'available'|'waiting'|'cloud-only'|'attention'>();
    const check=()=>{const now=this.selection();if(now.key!==selected.key||now.epoch!==selected.epoch)throw Error('The account changed.');};
    if(!selected.uid){for(const doc of await selected.store.getAllDocuments()){check();result.set(doc.id,await selected.store.documentFileExists(doc.id)?'available':'attention');}}
    else {const cache=selected.store as CloudCache;const studyState=await cache.study?.read();const conflicts=studyState?.conflicts??[];
      for(const entry of await cache.listSyncEntries()){check();if(entry.hidden)continue;const exists=await cache.documentFileExists(entry.document.id);check();
        result.set(entry.document.id,conflicts.some(c=>(c.kind==='document'||c.kind==='progress')&&c.id===entry.document.id)?'attention':!exists?'attention':!entry.synced||studyState?.pending.some(m=>(m.kind==='document'||m.kind==='progress')&&m.id===entry.document.id)?'waiting':exists?'available':'cloud-only');}}
    check();return result;
  }
  annotationContext(){
    const selected=this.selection();const checkActive=()=>{const now=this.selection();if(now.key!==selected.key||now.epoch!==selected.epoch)throw Error('The account changed.');};
    const hashes=new Map<string,string>();
    const parent=async(id:string):Promise<AnnotationParent|null>=>{
      checkActive();let doc=await selected.store.getDocument(id);checkActive();let deleted=false;
      if(selected.uid){const study=(selected.store as CloudCache).study!;if(!doc){doc=(await study.trashed()).find(d=>d.id===id)??null;deleted=true;}
        if(!doc)return null;const hash=await study.documentHash(id);checkActive();return {hash,format:doc.format,deleted};}
      if(!doc)return null;let hash=hashes.get(id);if(!hash){hash=sha256(await this.readLegacy(doc.filePath));checkActive();hashes.set(id,hash);}return {hash,format:doc.format,deleted};
    };
    const guestParent=async(id:string):Promise<AnnotationParent|null>=>{checkActive();const doc=await this.legacy.getDocument(id);checkActive();if(!doc)return null;const hash=sha256(await this.readLegacy(doc.filePath));checkActive();return {hash,format:doc.format,deleted:false};};
    const copyGuestDocuments=async(ids:readonly string[]):Promise<ReadonlyMap<string,AnnotationDocumentMapping>>=>{
      checkActive();if(!selected.uid)throw Error('Sign in before copying Guest notes.');const cache=selected.store as CloudCache;const mapping=new Map<string,AnnotationDocumentMapping>();
      for(const id of new Set(ids)){checkActive();const original=await this.legacy.getDocument(id);if(!original)throw Error('A Guest note’s original file is missing. Existing notes are preserved.');const bytes=await this.readLegacy(original.filePath);checkActive();
        const copy=await cache.copyLegacy(original,bytes);checkActive();mapping.set(id,{documentId:copy.id,documentHash:sha256(bytes),format:copy.format});}
      this.emit(true);return mapping;
    };
    return {scope:selected.key,epoch:selected.epoch,account:!!selected.uid,accountLabel:this.accountLabel(),checkActive,parent,guestParent,copyGuestDocuments,
      session:async()=>{checkActive();const session=await this.gateway?.getCloudSession?.();checkActive();if(!session||cloudIdentityKey(session)!==selected.key)throw Error('Sign in again to synchronize notes.');return session;},fetcher:this.platform.fetcher};
  }
  refreshAfterTransfer() { this.emit(true); }
  sync = () => this.engine.sync();
  copyLegacy = () => this.engine.copyLegacy();
  private accountStudy(){
    const selected=this.selection();if(!selected.uid)throw Error('Sign in to synchronize study data.');
    const study=(selected.store as CloudCache).study;if(!study)throw Error('Account study storage is unavailable.');
    const check=()=>{const now=this.selection();if(now.key!==selected.key||now.epoch!==selected.epoch)throw Error('The account changed.');};
    return {selected,study,check};
  }
  async studyState(){const {study,check}=this.accountStudy();const state=await study.read();check();return state;}
  private async queueStudy(input:Omit<StudyMutation,'expectedRevision'>,debounce=false){
    const {study,check}=this.accountStudy();check();await study.queue(input);check();this.emit(true);
    if(debounce){if(this.progressTimer)clearTimeout(this.progressTimer);this.progressTimer=setTimeout(()=>{this.progressTimer=undefined;try{check();void this.engine.sync();}catch{/* old account stays queued in its own store */}},1200);}
    else void this.engine.sync();
  }
  bookmarks(){
    const {selected}=this.accountStudy();const existing=this.bookmarkStores.get(selected.key);let store=existing?.epoch===selected.epoch?existing.store:undefined;
    // The epoch is captured by consumers below; each method verifies current identity before IO.
    if(!store){const key=selected.key;const check=()=>{const now=this.selection();if(now.key!==key||now.epoch!==selected.epoch)throw Error('The account changed.');};
      store=new StudyBookmarks(async()=>{check();const state=await this.studyState();check();return state;},async op=>{check();await this.queueStudy(op);check();});this.bookmarkStores.set(key,{epoch:selected.epoch,store});}
    return store;
  }
  progressStore(fallback:Pick<ReadingProgressStore,'read'|'save'>):Pick<ReadingProgressStore,'read'|'save'>{
    const selected=this.selection();const check=()=>{const now=this.selection();if(now.key!==selected.key||now.epoch!==selected.epoch)throw Error('The account changed.');};
    if(!selected.uid)return {read:async doc=>{check();const value=await fallback.read(doc);check();return value;},save:async(doc,value)=>{check();await fallback.save(doc,value);check();}};
    const study=(selected.store as CloudCache).study!;
    return {
      read:async doc=>{check();const state=await study.read();const hash=await study.documentHash(doc.id);check();
        if(state.conflicts.some(c=>c.kind==='progress'&&c.id===doc.id))throw Error('Choose the cloud or device reading position before resuming.');
        const row=studyView(state,'progress',doc.id);
        if(!row||row.deleted||row.payload.hash!==hash||row.payload.format!==doc.format||row.payload.readerVersion!==1)return null;
        return {page:row.payload.page as number,totalPages:row.payload.totalPages as number};},
      save:async(doc,position)=>{check();const hash=await study.documentHash(doc.id);check();const state=await study.read();check();const row=studyView(state,'progress',doc.id);
        if(row&&!row.deleted&&row.payload.page===position.page&&row.payload.totalPages===position.totalPages)return;
        await this.queueStudy({operationId:newStudyOperationId(),kind:'progress',id:doc.id,action:'put',payload:{documentId:doc.id,hash,readerVersion:1,format:doc.format,page:position.page,totalPages:position.totalPages}},true);check();},
    };
  }
  async trashDocument(id:string){const {check}=this.accountStudy();const doc=await this.documents.getDocument(id);check();if(!doc)throw Error('Document not found');await this.queueStudy({operationId:newStudyOperationId(),kind:'document',id,action:'remove',payload:{title:doc.title}});}
  async restoreDocument(id:string){const {study,check}=this.accountStudy();const doc=(await study.trashed()).find(d=>d.id===id);check();if(!doc)throw Error('Document not found');await this.queueStudy({operationId:newStudyOperationId(),kind:'document',id,action:'restore',payload:{title:doc.title.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,' ').trim()||'Untitled document'}});}
  async trashedDocuments(){const {study,check}=this.accountStudy();const docs=await study.trashed();check();return docs;}
  async resolveConflict(kind:StudyKind,id:string,choice:'local'|'cloud'){const {study,check}=this.accountStudy();await study.resolve(kind,id,choice,newStudyOperationId());check();this.emit(true);void this.engine.sync();}
}
