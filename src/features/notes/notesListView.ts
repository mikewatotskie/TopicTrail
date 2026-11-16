import type { AnnotationColor, AnnotationDraft, AnnotationListItem, AnnotationPayload } from '../../core/services/annotations/types';

export interface NotesFilter {view:'notes'|'highlights';query:string;context:'all'|'notebook'|'documents';color:'all'|AnnotationColor;showUnavailable:boolean;documentId?:string}
function matches(payload:AnnotationPayload,filter:NotesFilter) {
  if(filter.documentId && payload.documentId!==filter.documentId)return false;
  if(filter.context==='notebook'&&payload.documentId!==null)return false;
  if(filter.context==='documents'&&payload.documentId===null)return false;
  if(filter.color!=='all'&&payload.color!==filter.color)return false;
  const query=filter.query.trim().normalize('NFKC').toLocaleLowerCase();
  return [payload.title,payload.body,payload.anchor?.kind==='text'?payload.anchor.quote:''].some(text=>text.normalize('NFKC').toLocaleLowerCase().includes(query));
}
export function filterNotes(items:readonly AnnotationListItem[],filter:NotesFilter):AnnotationListItem[] {
  return items.filter(item=>(filter.showUnavailable||!item.parentDeleted) && (filter.view==='highlights'?!!item.payload.anchor:!!item.payload.body.trim()) && matches(item.payload,filter));
}
export function filterNoteDrafts(drafts:readonly AnnotationDraft[],filter:NotesFilter):AnnotationDraft[] {
  return drafts.filter(draft=>(filter.view==='highlights'?!!draft.payload.anchor:!draft.payload.anchor||!!draft.payload.body.trim())&&matches(draft.payload,filter));
}
export function conflictChoices(item:AnnotationListItem) {
  const conflict=item.conflict;
  return {cloud:!!conflict,local:!!conflict&&!item.parentDeleted&&!(conflict.cloud.deleted&&conflict.cloud.revision>0&&conflict.local.action==='put'),both:!!conflict&&!item.parentDeleted&&conflict.local.action!=='remove'};
}
export function noteTitle(payload:AnnotationPayload):string {return payload.title.trim() || (payload.body.trim()?payload.body.trim().split('\n')[0].slice(0,100):payload.anchor?.kind==='text'?payload.anchor.quote.slice(0,100):payload.anchor?.kind==='region'?'Area highlight':'Untitled draft');}
export function noteContext(payload:AnnotationPayload):string {return payload.documentId===null?'Notebook':payload.location?`${payload.location.unit[0].toUpperCase()+payload.location.unit.slice(1)} ${payload.location.index}`:'Document note';}
