import { annotationEnvelope, readAnnotationEnvelope } from '../annotation_port_contract';
import { decodeAnnotationState, emptyAnnotationState } from '../annotations/validation';
import { decodeDocumentLibrary, encodeDocumentLibrary } from '../document_library_codec';
import { decodeBookmarks, encodeBookmarks } from '../bookmarks/metadata';
import { packAccountEnvelope, unpackAccountEnvelope } from '../cloud/cache_envelope';
import { decodeStudyState } from '../cloud/study_state';
import { codecFor, guestWithPaths, type StudySnapshot } from './study_archive_state';

function conflict(): never {
  throw Error('The archive and this library contain different versions of the same local item. Both copies have been preserved. Keep the old app and archive.');
}
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function union<T>(existing: readonly T[], incoming: readonly T[], key: (r: T) => string, combine?: (a: T,b: T) => T) {
  const items = new Map(existing.map(r => [key(r),r]));
  for (const row of incoming) {
    const id = key(row);
    const current = items.get(id);
    if (current === undefined) items.set(id,row);
    else if (!equal(current,row)) items.set(id,combine ? combine(current,row) : conflict());
  }
  return [...items.values()];
}
function newer<T extends {revision:number}>(a: T,b: T): T {
  if (a.revision === b.revision) return conflict();
  return a.revision > b.revision ? a : b;
}
export function mergeNotes(scope: string, old: string | null, incoming: string) {
  const before = readAnnotationEnvelope(old === null ? null : JSON.parse(old));
  const a = before.json ? decodeAnnotationState(JSON.parse(before.json), scope) : emptyAnnotationState(scope);
  const b = decodeAnnotationState(JSON.parse(incoming), scope);
  const merged = decodeAnnotationState({
    ...a,
    records:union(a.records,b.records,r=>r.id,scope === 'guest' ? undefined : newer),
    pending:union(a.pending,b.pending,r=>r.operationId),
    drafts:union(a.drafts,b.drafts,r=>r.id),
    conflicts:union(a.conflicts,b.conflicts,r=>r.id),
    guestCopies:union(a.guestCopies,b.guestCopies,r=>r.sourceId+':'+r.sourceHash),
  },scope);
  if (old !== null && equal(a,merged)) return old;
  return JSON.stringify(annotationEnvelope(before.revision+1, JSON.stringify(merged)));
}
function mergeAccount(scope: string, old: string | null, incoming: string) {
  const codec = codecFor(scope);
  const before = unpackAccountEnvelope(old);
  const a = codec.decode(before);
  const b = codec.decode({revision:1,json:incoming});
  for (const [id, other] of b.entries) {
    const existing = a.entries.get(id);
    if (!existing) { a.entries.set(id,other); continue; }
    if (other.hash !== existing.hash || other.document.format !== existing.document.format ||
        other.document.fileSize !== existing.document.fileSize) conflict();
    // Existing remote hydration may have already brought back this immutable file.
    existing.synced ||= other.synced;
    existing.hidden ||= other.hidden;
    if (other.document.lastOpenedAt && (!existing.document.lastOpenedAt || other.document.lastOpenedAt > existing.document.lastOpenedAt)) {
      existing.document = existing.document.copyWith({lastOpenedAt: other.document.lastOpenedAt});
    }
  }
  for (const [op,id] of b.receipts) {
    if (a.receipts.has(op) && a.receipts.get(op) !== id) conflict();
    a.receipts.set(op,id);
  }
  const studyKey = (row: {kind:string;id:string}) => row.kind + ':' + row.id;
  a.study = decodeStudyState({...a.study,
    records:union(a.study.records,b.study.records,studyKey,newer),
    pending:union(a.study.pending,b.study.pending,r=>r.operationId),
    conflicts:union(a.study.conflicts,b.study.conflicts,studyKey),
  });
  if (a.study.pending.some(p=>a.study.conflicts.some(c=>studyKey(p)===studyKey(c)))) conflict();
  if (b.retryWindow && (!a.retryWindow || b.retryWindow.until > a.retryWindow.until)) a.retryWindow = b.retryWindow;
  const json = codec.encode(a);
  return old !== null && json === before.json ? old : packAccountEnvelope(before.revision + 1, json);
}
function mergeGuest(old: string | null, incoming: string, localPath:(name:string)=>string) {
  const a = decodeDocumentLibrary(old);
  const b = decodeDocumentLibrary(guestWithPaths(decodeDocumentLibrary(incoming),doc=>localPath(doc.filePath)));
  const documents = union(a.documents,b.documents,d=>d.id);
  const guestImports = union(a.guestImports,b.guestImports,r=>r.attemptId);
  const importAttempts = union(a.importAttempts,b.importAttempts,r=>r.attemptId);
  // A pending deletion is a request to discard a specific original. Never apply it to a different local state.
  for (const doc of b.documents) {
    if (a.documents.some(d => d.id === doc.id) && a.pendingDeletion.has(doc.id) !== b.pendingDeletion.has(doc.id)) conflict();
  }
  const json = encodeDocumentLibrary({...a,documents,guestImports,importAttempts,
    pendingDeletion:new Set([...a.pendingDeletion,...b.pendingDeletion]),
    guestUsageRecoveryRequired:a.guestUsageRecoveryRequired||b.guestUsageRecoveryRequired,
    importReplayRecoveryRequired:a.importReplayRecoveryRequired||b.importReplayRecoveryRequired});
  decodeDocumentLibrary(json);
  return json;
}
export function metadataKeys(data: StudySnapshot): string[] {
  return data.scope === 'guest' ? ['guest/documents','notes/guest','guest/bookmarks',...Object.keys(data.progress).sort()]
    : ['account/'+data.scope+'/library','notes/'+data.scope];
}
export function mergeMetadata(data: StudySnapshot, previous:(string|null)[], localPath:(name:string)=>string): string[] {
  if (data.scope !== 'guest') return [mergeAccount(data.scope, previous[0],data.library),mergeNotes(data.scope,previous[1],data.notes)];
  const bookmarks = union(previous[2] ? decodeBookmarks(previous[2]) : [], decodeBookmarks(data.bookmarks!), b=>b.id);
  const encoded = encodeBookmarks(bookmarks);
  decodeBookmarks(encoded);
  return [mergeGuest(previous[0],data.library,localPath),mergeNotes('guest',previous[1],data.notes),encoded,
    ...Object.keys(data.progress).sort().map((key,i)=>{
      const existing = previous[i+3];
      if (existing !== null && !equal(JSON.parse(existing),JSON.parse(data.progress[key]))) conflict();
      return existing ?? data.progress[key];
    })];
}
