import { newStudyOperationId } from '../../core/services/cloud/study_state';
import type { AnnotationListItem, AnnotationPayload, TextAnchorV1 } from '../../core/services/annotations/types';
export function newNotePayload():AnnotationPayload{const date=new Date().toISOString();return {id:newStudyOperationId(),documentId:null,documentHash:null,format:null,location:null,anchor:null,title:'',body:'',color:'yellow',createdAt:date,updatedAt:date};}
export function matchingNotes(items:readonly AnnotationListItem[],documentId:string,hash:string,page:number,anchor:TextAnchorV1){
  const candidates=items.filter(item=>{const p=item.payload,a=p.anchor;return !item.deleted&&!item.parentDeleted&&p.documentId===documentId&&p.documentHash===hash&&p.location?.index===page&&a?.kind==='text'&&a.surface===anchor.surface&&a.textHash===anchor.textHash;});
  const exact=candidates.filter(item=>JSON.stringify((item.payload.anchor as TextAnchorV1).ranges)===JSON.stringify(anchor.ranges));
  if(exact.length)return exact;
  return candidates.filter(item=>(item.payload.anchor as TextAnchorV1).ranges.some(a=>anchor.ranges.some(b=>a.blockId===b.blockId&&a.startUtf16<b.endUtf16&&b.startUtf16<a.endUtf16)));
}
