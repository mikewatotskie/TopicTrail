import { strToU8 } from 'fflate';
import { decodeBookmarks, MAX_BOOKMARKS, validateBookmarkInput } from '../bookmarks/metadata';
import type { Bookmark, BookmarkInput, BookmarkSnapshot } from '../bookmarks/types';
import { canonicalBookmarkUrl } from '../link_shield';
import { sha256 } from './sha256';
import { newStudyOperationId, studyView, type StudyMutation, type StudyState } from './study_state';

export class StudyBookmarks {
  private snapshot:BookmarkSnapshot={status:'idle',bookmarks:[]};
  private listeners=new Set<()=>void>();
  private pending:Promise<unknown>=Promise.resolve();
  constructor(private readonly read:()=>Promise<StudyState>,private readonly queue:(op:Omit<StudyMutation,'expectedRevision'>)=>Promise<void>){}
  getSnapshot=()=>this.snapshot;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private publish(snapshot:BookmarkSnapshot){this.snapshot=snapshot;for(const fn of this.listeners)fn();}
  private run<T>(operation:()=>Promise<T>):Promise<T>{const next=this.pending.then(operation);this.pending=next.catch(()=>{});return next;}
  private async load(){
    try{
      const state=await this.read();const ids=new Set([...state.records,...state.pending].filter(r=>r.kind==='bookmark').map(r=>r.id));
      const bookmarks=[...ids].map(id=>studyView(state,'bookmark',id)).filter(r=>r&&!r.deleted).map(r=>r!.payload);
      this.publish({status:'ready',bookmarks:decodeBookmarks(JSON.stringify({version:1,bookmarks}))});
    }catch(error){this.publish({...this.snapshot,status:'error',error:'Account saved resources could not be loaded. Existing data is preserved.'});throw error;}
  }
  initialize=()=>this.run(()=>this.load());
  reload=()=>this.run(()=>this.load());
  save(input:BookmarkInput):Promise<Bookmark>{
    const fields=validateBookmarkInput(input);
    return this.run(async()=>{
      await this.load();const existing=this.snapshot.bookmarks.find(b=>b.url===fields.url);if(existing)return existing;
      if(this.snapshot.bookmarks.length>=MAX_BOOKMARKS)throw Error('Your saved resource library is full. Remove a resource before saving another.');
      const id='bookmark-'+sha256(strToU8(fields.url));const state=await this.read();const prior=studyView(state,'bookmark',id);
      const bookmark={...fields,id,savedAt:new Date().toISOString()};
      await this.queue({operationId:newStudyOperationId(),kind:'bookmark',id,action:prior?.deleted?'restore':'put',payload:{...bookmark}});
      await this.load();return bookmark;
    });
  }
  remove(value:string):Promise<void>{
    const url=canonicalBookmarkUrl(value);if(!url)return Promise.reject(Error('Invalid saved resource URL.'));
    return this.run(async()=>{await this.load();const bookmark=this.snapshot.bookmarks.find(b=>b.url===url);if(!bookmark)return;
      await this.queue({operationId:newStudyOperationId(),kind:'bookmark',id:bookmark.id,action:'remove',payload:{...bookmark}});await this.load();});
  }
}
