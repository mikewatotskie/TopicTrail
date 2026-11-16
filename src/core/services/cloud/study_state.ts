import { decodeBookmarks } from '../bookmarks/metadata';

export type StudyKind = 'document' | 'bookmark' | 'progress';
export interface StudyRecord { kind: StudyKind; id: string; revision: number; deleted: boolean; payload: Record<string, unknown> }
export interface StudyMutation { operationId: string; kind: StudyKind; id: string; expectedRevision: number; action: 'put' | 'remove' | 'restore'; payload: Record<string, unknown> }
export interface StudyReply { status: 'applied' | 'conflict'; record: StudyRecord; duplicate?: boolean }
export interface StudyConflict { kind: StudyKind; id: string; local: StudyMutation; cloud: StudyRecord }
export interface StudyState { version: 1; records: StudyRecord[]; pending: StudyMutation[]; conflicts: StudyConflict[] }
const invalid = () => new Error('Account study state is invalid. Existing data has been preserved.');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const key = (v: {kind: StudyKind;id:string}) => v.kind + ':' + v.id;
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(v);
const validRevision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(); return v as Record<string, unknown>; }
function kind(v: unknown): v is StudyKind { return v === 'document' || v === 'bookmark' || v === 'progress'; }
function payload(k: StudyKind, id: string, value: unknown, deleted: boolean): Record<string, unknown> {
  const p = object(value);
  if (JSON.stringify(p).length > 32768) throw invalid();
  if (deleted) return clone(p);
  if (k === 'document') {
    if (Object.keys(p).some(n=>n !== 'title') || typeof p.title !== 'string' || !p.title.trim() || [...p.title].length > 512 || /\0/.test(p.title)) throw invalid();
  } else if (k === 'bookmark') {
    if (p.id !== id) throw invalid();
    decodeBookmarks(JSON.stringify({version:1,bookmarks:[p]}));
  } else {
    if (Object.keys(p).some(n=>!['documentId','hash','readerVersion','format','page','totalPages'].includes(n)) ||
        p.documentId !== id || typeof p.hash !== 'string' || !/^[a-f0-9]{64}$/.test(p.hash) ||
        p.readerVersion !== 1 || !['pdf','docx','pptx'].includes(String(p.format)) ||
        !validRevision(p.page) || !validRevision(p.totalPages) || p.page < 1 || p.page > p.totalPages || p.totalPages > 100000) throw invalid();
  }
  return clone(p);
}
export function validateStudyRecord(value: unknown): StudyRecord {
  const r=object(value);
  if (!kind(r.kind) || !validId(r.id) || !validRevision(r.revision) || typeof r.deleted !== 'boolean') throw invalid();
  return {kind:r.kind,id:r.id,revision:r.revision,deleted:r.deleted,payload:payload(r.kind,r.id,r.payload,r.deleted)};
}
function validateMutation(value: unknown): StudyMutation {
  const m=object(value);
  if (!kind(m.kind)||!validId(m.id)||!validId(m.operationId)||!validRevision(m.expectedRevision)||!['put','remove','restore'].includes(String(m.action))) throw invalid();
  return {operationId:m.operationId,kind:m.kind,id:m.id,expectedRevision:m.expectedRevision,action:m.action as StudyMutation['action'],payload:payload(m.kind,m.id,m.payload,m.action==='remove')};
}
export const emptyStudyState = ():StudyState => ({version:1,records:[],pending:[],conflicts:[]});
let sequence=0;
export function newStudyOperationId():string { return 'mutation-'+Date.now().toString(36)+'-'+(++sequence).toString(36)+'-'+Array.from({length:4},()=>Math.random().toString(36).slice(2)).join(''); }
export function decodeStudyState(value: unknown): StudyState {
  const s=object(value);
  if(s.version!==1||!Array.isArray(s.records)||!Array.isArray(s.pending)||!Array.isArray(s.conflicts)||s.records.length>20000||s.pending.length>10000||s.conflicts.length>20000)throw invalid();
  const records=s.records.map(validateStudyRecord),pending=s.pending.map(validateMutation);
  const conflicts=s.conflicts.map(v=>{const c=object(v);const local=validateMutation(c.local),cloud=validateStudyRecord(c.cloud);if(c.kind!==local.kind||c.id!==local.id||key(local)!==key(cloud))throw invalid();return {kind:local.kind,id:local.id,local,cloud};});
  if(new Set(records.map(key)).size!==records.length||new Set(pending.map(v=>v.operationId)).size!==pending.length||new Set(conflicts.map(key)).size!==conflicts.length)throw invalid();
  return {version:1,records,pending,conflicts};
}
export function studyView(state:StudyState,kind:StudyKind,id:string):StudyRecord|undefined {
  let result=state.records.find(r=>r.kind===kind&&r.id===id);
  for(const op of state.pending.filter(r=>r.kind===kind&&r.id===id)) result={kind,id,revision:op.expectedRevision+1,deleted:op.action==='remove',payload:op.payload};
  return result && clone(result);
}
export function queueStudyMutation(state:StudyState,input:Omit<StudyMutation,'expectedRevision'>):void {
  if(input.action!=='remove'){
    const check=(value:unknown):void=>{if(typeof value==='string'&&/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value))throw Error('Remove unsupported control characters before syncing this item.');if(value&&typeof value==='object')for(const child of Object.values(value))check(child);};check(input.payload);
  }
  if(state.conflicts.some(c=>key(c)===key(input)))throw Error('Resolve this item’s cloud conflict before changing it.');
  const before=studyView(state,input.kind,input.id);
  if(before?.deleted&&input.action==='put')throw Error('Restore this item explicitly before changing it.');
  const mutation=validateMutation({...input,expectedRevision:before?.revision??0});
  if(state.pending.some(m=>m.operationId===mutation.operationId)||state.pending.length>=10000)throw invalid();
  state.pending.push(mutation);
}
export function mergeStudyRecords(state:StudyState,values:readonly StudyRecord[]):void {
  for(const value of values){const row=validateStudyRecord(value);const index=state.records.findIndex(r=>key(r)===key(row));
    if(index<0)state.records.push(row);else if(state.records[index].revision<=row.revision)state.records[index]=row;
    const conflict=state.conflicts.find(c=>key(c)===key(row));if(conflict&&conflict.cloud.revision<=row.revision)conflict.cloud=row;
  }
}
export function acknowledgeStudyMutation(state:StudyState,operationId:string,reply:StudyReply):void {
  const op=state.pending.find(m=>m.operationId===operationId);if(!op)return;
  const record=validateStudyRecord(reply.record);if(key(record)!==key(op)||!['applied','conflict'].includes(reply.status))throw invalid();
  mergeStudyRecords(state,[record]);
  if(reply.status==='conflict'){
    const same=state.pending.filter(m=>key(m)===key(op));const local=same[same.length-1];
    // Pending increments are speculative, not proof that this device observed a Restore.
    // Rebase removal to the first rejected observation with a fresh idempotency key.
    if(local.action==='remove'&&local.operationId!==op.operationId){state.pending=state.pending.filter(m=>key(m)!==key(op));state.pending.push({...clone(local),operationId:newStudyOperationId(),expectedRevision:op.expectedRevision});return;}
    const cloud=state.records.find(r=>key(r)===key(record))!;
    state.conflicts=state.conflicts.filter(c=>key(c)!==key(op));state.conflicts.push({kind:op.kind,id:op.id,local:clone(local),cloud:clone(cloud)});
    state.pending=state.pending.filter(m=>key(m)!==key(op));
  }else state.pending=state.pending.filter(m=>m.operationId!==operationId);
}
export function resolveStudyConflict(state:StudyState,kind:StudyKind,id:string,choice:'local'|'cloud',operationId:string):void {
  const conflict=state.conflicts.find(c=>c.kind===kind&&c.id===id);if(!conflict)return;
  if(choice==='local'&&conflict.cloud.deleted&&conflict.local.action==='put')throw Error('This item was removed. Keep the cloud state, then explicitly Restore it before editing.');
  state.conflicts=state.conflicts.filter(c=>c!==conflict);
  if(choice==='local')queueStudyMutation(state,{...conflict.local,operationId});
}
