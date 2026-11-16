import { cloudIdentityKey } from '../cloud/types';
import { newStudyOperationId } from '../cloud/study_state';
import type { AnnotationDocumentMapping, AnnotationDraft, AnnotationListItem, AnnotationMutation, AnnotationParent, AnnotationPayload, AnnotationPort, AnnotationRecord, AnnotationReply, AnnotationState } from './types';
import { ANNOTATION_MAX_RECORDS, annotationError, cloneAnnotation, decodeAnnotationState, emptyAnnotationState, validAnnotationId, validAnnotationRevision, validateAnnotationDraft, validateAnnotationPayload, validateAnnotationRecord, validateAnnotationReply } from './validation';

export interface AnnotationStoreOptions {
  scope: string; port: AnnotationPort; checkActive(): void;
  parent(documentId: string): Promise<AnnotationParent | null>;
  newId?(): string; now?(): string; onChange?(): void;
}
export interface AnnotationListOptions { trash?: boolean; documentId?: string | null; includeParentDeleted?: boolean }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const attachment = (p: AnnotationPayload) => [p.documentId,p.documentHash,p.format,p.location,p.anchor,p.createdAt];

/** Local records/outbox/drafts share one durable CAS document, isolated from all
 * legacy caches. Consumers must capture their account epoch in checkActive. */
export function createAnnotationStore(options: AnnotationStoreOptions) {
  const {scope,port,checkActive,parent} = options;
  if (scope !== 'guest') {
    const [project,uid,...extra] = scope.split('/');
    if (extra.length || cloudIdentityKey({project,uid}) !== scope) throw annotationError();
  }
  const guest = scope === 'guest';
  const newId = () => { const id = (options.newId ?? newStudyOperationId)(); if (!validAnnotationId(id)) throw annotationError(); return id; };
  const now = options.now ?? (()=>new Date().toISOString());
  let serial: Promise<unknown> = Promise.resolve();
  function run<T>(operation:()=>Promise<T>):Promise<T> {
    const promise=serial.then(()=>{checkActive();return operation();});serial=promise.catch(()=>undefined);return promise;
  }
  function decode(snapshot:{json:string|null;revision:number}) {
    if (snapshot.revision === 0 && snapshot.json === null) return emptyAnnotationState(scope);
    try {
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || typeof snapshot.json !== 'string') throw annotationError();
      return decodeAnnotationState(JSON.parse(snapshot.json),scope);
    } catch { throw annotationError(); }
  }
  async function load() {checkActive();const snapshot=await port.read();checkActive();return decode(snapshot);}
  function mutate<T>(operation:(state:AnnotationState)=>Promise<{value:T;changed:boolean}>|{value:T;changed:boolean}):Promise<T> {
    return run(async()=>{
      for(let retry=0;retry<8;retry++) {
        checkActive();const snapshot=await port.read();checkActive();const state=decode(snapshot);
        const result=await operation(state);checkActive();if(!result.changed)return cloneAnnotation(result.value);
        // Validate the complete transaction before writing any of it.
        const json=JSON.stringify(decodeAnnotationState(state,scope));checkActive();
        let committed:boolean;
        try { committed=await port.commit(snapshot.revision,json); }
        catch(error) {
          // A completed local commit may lose its acknowledgement. Reconcile it
          // without discarding the pending ID or retrying with another identity.
          const actual=await port.read().catch(()=>null);checkActive();
          if(actual?.revision!==snapshot.revision+1 || actual.json!==json)throw error;
          committed=true;
        }
        checkActive();if(committed){options.onChange?.();return cloneAnnotation(result.value);}
      }
      throw Error('Notes changed in another window. Retry to load the latest version.');
    });
  }
  function view(state:AnnotationState,id:string):AnnotationRecord|undefined {
    let result=state.records.find(r=>r.id===id);
    for(const op of state.pending.filter(m=>m.id===id))result={id,revision:op.expectedRevision+1,deleted:op.action==='remove',payload:op.payload};
    const conflict=state.conflicts.find(c=>c.id===id);
    if(conflict)result={id,revision:conflict.cloud.revision,deleted:conflict.local.action==='remove',payload:conflict.local.payload};
    return result && cloneAnnotation(result);
  }
  function requireRecord(state:AnnotationState,id:string) {
    const record=view(state,id);if(!record)throw Error('This note could not be found.');return record;
  }
  function unconflicted(state:AnnotationState,id:string) {
    if(state.conflicts.some(c=>c.id===id))throw Error('Choose which version to keep before changing this note.');
  }
  function observedRevision(record:AnnotationRecord,baseRevision:number|undefined) {
    if(baseRevision!==undefined && (!validAnnotationRevision(baseRevision) || baseRevision!==record.revision))
      throw Error('This note changed since you opened it. Close this editor and reopen the latest note before removing its text or moving it to Trash.');
  }
  async function requireParent(payload:AnnotationPayload) {
    if(payload.documentId===null)return;
    const found=await parent(payload.documentId);checkActive();
    if(!found || found.hash!==payload.documentHash || found.format!==payload.format)throw Error('The original document or its verified hash is unavailable. Your note has been preserved.');
    if(found.deleted)throw Error('The parent document is in Trash. Restore the document before changing its notes.');
  }
  function putRecord(state:AnnotationState,row:AnnotationRecord) {
    const previous=state.records.findIndex(r=>r.id===row.id);
    if(previous<0)state.records.push(cloneAnnotation(row));else if(state.records[previous].revision<=row.revision)state.records[previous]=cloneAnnotation(row);
  }
  function queue(state:AnnotationState,payload:AnnotationPayload,action:AnnotationMutation['action'],operationId:string):AnnotationRecord {
    unconflicted(state,payload.id);
    const before=view(state,payload.id);
    if(before?.deleted && before.revision>0 && action==='put')throw Error('This note is in Trash. Restore it explicitly before editing.');
    if(action==='restore' && !before?.deleted)throw Error('Only a note in Trash can be restored.');
    if(state.pending.length>=10000 || new Set([...state.records.map(r=>r.id),...state.pending.map(m=>m.id),payload.id]).size>ANNOTATION_MAX_RECORDS)throw Error('Your notes library is full.');
    const record={id:payload.id,revision:(before?.revision??0)+1,deleted:action==='remove',payload:cloneAnnotation(payload)};
    if(guest)putRecord(state,record);
    else state.pending.push({operationId,id:payload.id,expectedRevision:before?.revision??0,action,payload:cloneAnnotation(payload)});
    return record;
  }
  function validateSave(payload:AnnotationPayload,highlightOnly:boolean) {
    if(!payload.body.trim()) {
      if(!payload.anchor)throw Error('Enter note text before saving.');
      if(!highlightOnly)throw Error('Choose Save highlight only to save a selection without note text.');
    }
  }
  function mergeInto(state:AnnotationState,rows:readonly AnnotationRecord[]) {
    for(const raw of rows) {
      const row=validateAnnotationRecord(raw);putRecord(state,row);
      const conflict=state.conflicts.find(c=>c.id===row.id);
      if(conflict && conflict.cloud.revision<=row.revision)conflict.cloud=cloneAnnotation(row);
    }
  }
  const api={
    read:()=>run(load),
    list:(filters:AnnotationListOptions={}):Promise<AnnotationListItem[]>=>run(async()=>{
      const state=await load();const ids=new Set([...state.records.map(r=>r.id),...state.pending.map(m=>m.id),...state.conflicts.map(c=>c.id)]);
      const items:AnnotationListItem[]=[];
      for(const id of ids) {
        const row=view(state,id)!;
        if(row.revision===0 && row.deleted && !state.conflicts.some(c=>c.id===id))continue;
        if(row.deleted!==Boolean(filters.trash) || (filters.documentId!==undefined && row.payload.documentId!==filters.documentId))continue;
        const p=row.payload.documentId===null?null:await parent(row.payload.documentId);checkActive();
        const parentDeleted=row.payload.documentId!==null && (!p || p.deleted || p.hash!==row.payload.documentHash || p.format!==row.payload.format);
        if(parentDeleted && !filters.includeParentDeleted)continue;
        const conflict=state.conflicts.find(c=>c.id===id);
        items.push({...row,parentDeleted,syncStatus:guest?'local':conflict?'conflict':state.pending.some(m=>m.id===id)?'pending':'synced',...(conflict?{conflict:cloneAnnotation(conflict)}:{})});
      }
      return items.sort((a,b)=>b.payload.updatedAt.localeCompare(a.payload.updatedAt)||a.id.localeCompare(b.id));
    }),
    save:async(value:AnnotationPayload,settings:{highlightOnly?:boolean;draftId?:string;baseRevision?:number}={}):Promise<AnnotationRecord>=>{
      const payload=validateAnnotationPayload(value),operationId=newId(),recoveryId=settings.draftId??newId();validateSave(payload,settings.highlightOnly===true);
      if(!validAnnotationId(recoveryId) || (settings.baseRevision!==undefined && !validAnnotationRevision(settings.baseRevision)))throw annotationError();
      const result=await mutate<{row:AnnotationRecord|null;error:string|null}>(async state=>{
        unconflicted(state,payload.id);
        const before=view(state,payload.id);
        const baseRevision=settings.baseRevision??before?.revision??0;
        const recover=(message:string)=>{
          const draft=validateAnnotationDraft({id:recoveryId,payload,updatedAt:payload.updatedAt,baseRevision});
          state.drafts=state.drafts.filter(d=>d.id!==recoveryId);state.drafts.push(draft);
          return {value:{row:null,error:message},changed:true};
        };
        try{await requireParent(payload);}catch(error){return recover(error instanceof Error?error.message:'The document is unavailable. Your draft has been preserved.');}
        if(before && !same(attachment(before.payload),attachment(payload)))throw Error('Keep the original note attachment and full anchor when editing.');
        const equal=before && same(before.payload,payload),hadDraft=!!settings.draftId && state.drafts.some(d=>d.id===settings.draftId);
        if(equal && !before.deleted) {
          if(settings.draftId)state.drafts=state.drafts.filter(d=>d.id!==settings.draftId);
          return {value:{row:before,error:null},changed:hadDraft};
        }
        if(settings.baseRevision!==undefined && baseRevision!==(before?.revision??0)) {
          // A second local edit may itself still be unacknowledged. Keep it in
          // the outbox and retain this editor as a draft rather than calling it
          // a cloud alternative or silently deleting an uncertain operation.
          const cloud=state.records.find(r=>r.id===payload.id);
          if(guest || state.pending.some(m=>m.id===payload.id) || !cloud)return recover('This note changed while editing. Your draft is saved; reopen the latest note before applying it.');
          state.conflicts.push({id:payload.id,local:{operationId,id:payload.id,expectedRevision:baseRevision,action:'put',payload:cloneAnnotation(payload)},cloud:cloneAnnotation(cloud),reason:'revision'});
          if(settings.draftId)state.drafts=state.drafts.filter(d=>d.id!==settings.draftId);
          return {value:{row:{id:payload.id,revision:cloud.revision,deleted:false,payload},error:null},changed:true};
        }
        if(before?.deleted && before.revision>0)return recover('This note is in Trash. Restore it explicitly before editing. Your draft has been preserved.');
        const row=equal?before:queue(state,payload,'put',operationId);
        if(settings.draftId)state.drafts=state.drafts.filter(d=>d.id!==settings.draftId);
        return {value:{row,error:null},changed:!equal||hadDraft};
      });
      if(result.error)throw Error(result.error);return result.row!;
    },
    remove:(id:string,settings:{baseRevision?:number}={}):Promise<void>=>{
      const operationId=newId();return mutate(async state=>{unconflicted(state,id);const before=requireRecord(state,id);await requireParent(before.payload);
        if(before.deleted)return {value:undefined,changed:false};observedRevision(before,settings.baseRevision);queue(state,before.payload,'remove',operationId);return {value:undefined,changed:true};});
    },
    restore:(id:string):Promise<void>=>{
      const operationId=newId();return mutate(async state=>{unconflicted(state,id);const before=requireRecord(state,id);await requireParent(before.payload);
        if(!before.deleted)return {value:undefined,changed:false};queue(state,before.payload,'restore',operationId);return {value:undefined,changed:true};});
    },
    removeNote:(id:string,settings:{baseRevision?:number}={}):Promise<void>=>{
      const operationId=newId(),updatedAt=now();return mutate(async state=>{unconflicted(state,id);const before=requireRecord(state,id);await requireParent(before.payload);
        if(!before.payload.anchor)throw Error('This is a note without a highlight. Move it to Trash to remove it.');
        if(!before.payload.body)return {value:undefined,changed:false};observedRevision(before,settings.baseRevision);queue(state,validateAnnotationPayload({...before.payload,body:'',updatedAt}),'put',operationId);return {value:undefined,changed:true};});
    },
    saveDraft:(value:AnnotationDraft):Promise<void>=>{
      const draft=validateAnnotationDraft(value);return mutate(state=>{const before=state.drafts.find(d=>d.id===draft.id);if(before && same(before,draft))return {value:undefined,changed:false};
        state.drafts=state.drafts.filter(d=>d.id!==draft.id);state.drafts.push(draft);return {value:undefined,changed:true};});
    },
    discardDraft:(id:string):Promise<void>=>mutate(state=>{const count=state.drafts.length;state.drafts=state.drafts.filter(d=>d.id!==id);return {value:undefined,changed:count!==state.drafts.length};}),
    merge:(values:readonly AnnotationRecord[]):Promise<void>=>{
      const rows=values.map(validateAnnotationRecord);return mutate(state=>{if(guest)throw Error('Guest notes do not synchronize.');mergeInto(state,rows);return {value:undefined,changed:rows.length>0};});
    },
    acknowledge:(operationId:string,value:AnnotationReply):Promise<void>=>{
      const reply=validateAnnotationReply(value);return mutate(state=>{
        const op=state.pending.find(m=>m.operationId===operationId);if(!op)return {value:undefined,changed:false};
        if(reply.record.id!==op.id || (reply.status==='applied' && reply.record.revision!==op.expectedRevision+1))throw annotationError();mergeInto(state,[reply.record]);
        if(reply.status==='applied')state.pending=state.pending.filter(m=>m.operationId!==operationId);
        else {
          const sameItem=state.pending.filter(m=>m.id===op.id),local=sameItem[sameItem.length-1];
          state.conflicts=state.conflicts.filter(c=>c.id!==op.id);
          state.conflicts.push({id:op.id,local:cloneAnnotation(local),cloud:cloneAnnotation(state.records.find(r=>r.id===op.id)!),reason:reply.reason??'revision'});
          state.pending=state.pending.filter(m=>m.id!==op.id);
        }
        return {value:undefined,changed:true};
      });
    },
    resolve:(id:string,choice:'cloud'|'local'|'both'):Promise<string|null>=>{
      const operationId=newId(),copyId=choice==='both'?newId():null,createdAt=now();
      return mutate(async state=>{
        const conflict=state.conflicts.find(c=>c.id===id);if(!conflict)return {value:null,changed:false};
        if(choice!=='cloud')await requireParent(conflict.local.payload);
        if(choice==='local' && conflict.cloud.deleted && conflict.cloud.revision>0 && conflict.local.action==='put')throw Error('This note is in Trash. Keep cloud, then Restore it explicitly before editing.');
        if(choice==='both' && conflict.local.action==='remove')throw Error('A deletion cannot be copied. Keep cloud or keep this device’s deletion.');
        state.conflicts=state.conflicts.filter(c=>c.id!==id);
        if(choice==='local')queue(state,conflict.local.payload,conflict.local.action,operationId);
        else if(choice==='both')queue(state,validateAnnotationPayload({...conflict.local.payload,id:copyId!,createdAt,updatedAt:createdAt}),'put',operationId);
        return {value:choice==='both'?copyId:id,changed:true};
      });
    },
    copyGuest:(values:readonly AnnotationPayload[],mapping:ReadonlyMap<string,AnnotationDocumentMapping>):Promise<number>=>{
      if(guest)return Promise.reject(Error('Sign in before copying Guest notes.'));
      const originals=values.map(validateAnnotationPayload);
      // IDs are allocated once outside CAS retries, so a failed attempt cannot duplicate copies.
      const candidates=originals.map(p=>({source:p,id:newId(),operationId:newId()}));
      return mutate(async state=>{
        let copied=0;
        for(const {source,id,operationId} of candidates) {
          const sourceHash=source.documentHash??'standalone';
          if(state.guestCopies.some(c=>c.sourceId===source.id && c.sourceHash===sourceHash))continue;
          let payload:AnnotationPayload={...source,id};
          if(source.documentId!==null) {
            const target=mapping.get(source.documentId);
            if(!target || target.documentHash!==source.documentHash || target.format!==source.format)throw Error('Copy the original document first and verify its document/hash mapping before copying Guest notes.');
            payload={...payload,documentId:target.documentId,documentHash:target.documentHash,format:target.format};
          }
          payload=validateAnnotationPayload(payload);validateSave(payload,!!payload.anchor);await requireParent(payload);
          queue(state,payload,'put',operationId);state.guestCopies.push({sourceId:source.id,sourceHash,targetId:id});copied++;
        }
        return {value:copied,changed:copied>0};
      });
    },
  };
  return api;
}
export type AnnotationStore = ReturnType<typeof createAnnotationStore>;
