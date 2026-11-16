import { strToU8 } from 'fflate';
import type { AnnotationDraft, AnnotationMutation, AnnotationPayload, AnnotationRecord, AnnotationReply, AnnotationState, RegionAnchorV1, TextAnchorV1 } from './types';

export const ANNOTATION_PAYLOAD_MAX_BYTES = 32768;
export const ANNOTATION_MAX_RECORDS = 20000;
export const cloneAnnotation = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
export const annotationError = () => new Error('Notes data is invalid. Existing data has been preserved.');
export const validAnnotationId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
export const validAnnotationRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function annotationObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw annotationError();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw annotationError();
}
function text(value: unknown, maximum: number, empty = true): value is string {
  return typeof value === 'string' && value.length <= maximum && (empty || !!value.trim()) &&
    !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value) && !/[\uD800-\uDFFF]/u.test(value);
}
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const millis = Date.parse(value); return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}
/** PostgreSQL jsonb::text includes a space after every comma and colon. Counting all
 * punctuation (even within strings) is deliberately conservative, never truncating. */
export function annotationPayloadBytes(value: unknown): number {
  const json = JSON.stringify(value);
  const numericExpansion = (child: unknown): number => {
    if (typeof child === 'number' && Number.isFinite(child)) {
      const rendered=JSON.stringify(child),match=rendered.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
      if(!match)return 0;
      const digits=match[2].length+(match[3]?.length??0),point=match[2].length+Number(match[4]);
      const decimalLength=match[1].length+(point<=0?2-point+digits:point>=digits?point:digits+1);
      return Math.max(0,decimalLength-rendered.length);
    }
    if(child && typeof child==='object')return Object.values(child).reduce<number>((total,item)=>total+numericExpansion(item),0);
    return 0;
  };
  // jsonb prints numeric exponents in decimal notation. Tiny PDF coordinates
  // otherwise pass the local limit but can be rejected permanently by the RPC.
  return strToU8(json).byteLength + (json.match(/[,:]/g)?.length ?? 0) + numericExpansion(value);
}
export function validateTextAnchor(value: unknown): TextAnchorV1 {
  const a = annotationObject(value);
  keys(a, ['kind','version','surface','textHash','ranges','quote','prefix','suffix']);
  if (a.kind !== 'text' || a.version !== 1 || typeof a.surface !== 'string' || !['pdf-text','docx-text','pptx-text','ocr-text'].includes(a.surface) || !hash(a.textHash) ||
      !Array.isArray(a.ranges) || !a.ranges.length || a.ranges.length > 128 || !text(a.quote,6000,false) || !text(a.prefix,256) || !text(a.suffix,256)) throw annotationError();
  const seen = new Set<string>();
  for (const raw of a.ranges) {
    const r = annotationObject(raw); keys(r,['blockId','startUtf16','endUtf16']);
    if (!text(r.blockId,128,false) || seen.has(r.blockId) || !validAnnotationRevision(r.startUtf16) || !validAnnotationRevision(r.endUtf16) ||
        r.endUtf16 <= r.startUtf16 || r.endUtf16 > 10000000) throw annotationError();
    seen.add(r.blockId);
  }
  return cloneAnnotation(a) as unknown as TextAnchorV1;
}
export function validateRegionAnchor(value: unknown): RegionAnchorV1 {
  const a = annotationObject(value); keys(a,['kind','version','rect','pageBox']);
  const box = (raw: unknown): raw is [number,number,number,number] => Array.isArray(raw) && raw.length === 4 &&
    raw.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e9) && raw[0] < raw[2] && raw[1] < raw[3];
  if (a.kind !== 'region' || a.version !== 1 || !box(a.rect) || !box(a.pageBox) || a.rect[0] < a.pageBox[0] || a.rect[1] < a.pageBox[1] ||
      a.rect[2] > a.pageBox[2] || a.rect[3] > a.pageBox[3]) throw annotationError();
  return cloneAnnotation(a) as unknown as RegionAnchorV1;
}
export function validateAnnotationPayload(value: unknown): AnnotationPayload {
  const p = annotationObject(value);
  keys(p,['id','documentId','documentHash','format','location','anchor','title','body','color','createdAt','updatedAt']);
  if (annotationPayloadBytes(p) > ANNOTATION_PAYLOAD_MAX_BYTES) throw Error('This note or selection is too large (32 KiB limit). Shorten it and retry.');
  if (!validAnnotationId(p.id) || !text(p.title,512) || !text(p.body,16000) || typeof p.color !== 'string' || !['yellow','green','blue','purple'].includes(p.color) || !date(p.createdAt) || !date(p.updatedAt)) throw annotationError();
  if (p.documentId === null) {
    if (p.documentHash !== null || p.format !== null || p.location !== null || p.anchor !== null) throw annotationError();
  } else {
    if (!validAnnotationId(p.documentId) || !hash(p.documentHash) || typeof p.format !== 'string' || !['pdf','docx','pptx'].includes(p.format)) throw annotationError();
    if (p.location !== null) {
      const location = annotationObject(p.location); keys(location,['unit','index']);
      const unit = p.format === 'pdf' ? 'page' : p.format === 'docx' ? 'section' : 'slide';
      if (location.unit !== unit || !validAnnotationRevision(location.index) || location.index < 1 || location.index > 100000) throw annotationError();
    }
    if (p.anchor !== null) {
      if (p.location === null) throw annotationError();
      const anchor = annotationObject(p.anchor);
      if (anchor.kind === 'text') {
        const a = validateTextAnchor(anchor);
        if (a.surface !== `${p.format}-text` && !(p.format === 'pdf' && a.surface === 'ocr-text')) throw annotationError();
      } else if (anchor.kind === 'region' && p.format === 'pdf') validateRegionAnchor(anchor);
      else throw annotationError();
    }
  }
  return cloneAnnotation(p) as unknown as AnnotationPayload;
}
export function validateAnnotationRecord(value: unknown): AnnotationRecord {
  const r = annotationObject(value); keys(r,['id','revision','deleted','payload']);
  const payload = validateAnnotationPayload(r.payload);
  if (r.id !== payload.id || !validAnnotationRevision(r.revision) || typeof r.deleted !== 'boolean' || (r.revision === 0 && !r.deleted)) throw annotationError();
  return {id:payload.id,revision:r.revision,deleted:r.deleted,payload};
}
export function validateAnnotationMutation(value: unknown): AnnotationMutation {
  const m = annotationObject(value); keys(m,['operationId','id','expectedRevision','action','payload']);
  const payload = validateAnnotationPayload(m.payload);
  if (m.id !== payload.id || !validAnnotationId(m.operationId) || !validAnnotationRevision(m.expectedRevision) || typeof m.action !== 'string' || !['put','remove','restore'].includes(m.action)) throw annotationError();
  return {operationId:m.operationId,id:payload.id,expectedRevision:m.expectedRevision,action:m.action as AnnotationMutation['action'],payload};
}
export function validateAnnotationReply(value: unknown): AnnotationReply {
  const r = annotationObject(value);
  if (typeof r.status !== 'string' || !['applied','conflict'].includes(r.status) || Object.keys(r).some(k => !['status','record','duplicate','reason'].includes(k)) ||
      (r.duplicate !== undefined && r.duplicate !== true) || (r.reason !== undefined && !['revision','parent-trashed'].includes(String(r.reason)))) throw annotationError();
  const record = validateAnnotationRecord(r.record);
  if (r.status === 'applied' && record.revision === 0) throw annotationError();
  return {status:r.status as AnnotationReply['status'],record,...(r.duplicate === true ? {duplicate:true} : {}),
    ...(r.reason === undefined ? {} : {reason:r.reason as AnnotationReply['reason']})};
}
export function validateAnnotationDraft(value: unknown): AnnotationDraft {
  const d = annotationObject(value);
  if (Object.keys(d).some(k => !['id','payload','updatedAt','baseRevision'].includes(k)) || !['id','payload','updatedAt'].every(k=>Object.hasOwn(d,k)) ||
      !validAnnotationId(d.id) || !date(d.updatedAt) || (d.baseRevision !== undefined && !validAnnotationRevision(d.baseRevision))) throw annotationError();
  return {id:d.id,payload:validateAnnotationPayload(d.payload),updatedAt:d.updatedAt,...(d.baseRevision===undefined?{}:{baseRevision:d.baseRevision})};
}
export function emptyAnnotationState(scope: string): AnnotationState { return {version:1,scope,records:[],pending:[],conflicts:[],drafts:[],guestCopies:[]}; }
export function decodeAnnotationState(value: unknown, scope: string): AnnotationState {
  const s = annotationObject(value); keys(s,['version','scope','records','pending','conflicts','drafts','guestCopies']);
  if (s.version !== 1 || s.scope !== scope) throw annotationError();
  for (const name of ['records','pending','conflicts','drafts','guestCopies']) if (!Array.isArray(s[name]) || s[name].length > ANNOTATION_MAX_RECORDS) throw annotationError();
  const records = (s.records as unknown[]).map(validateAnnotationRecord), pending = (s.pending as unknown[]).map(validateAnnotationMutation), drafts = (s.drafts as unknown[]).map(validateAnnotationDraft);
  const conflicts = (s.conflicts as unknown[]).map(raw => {
    const c = annotationObject(raw); keys(c,['id','local','cloud','reason']);
    const local = validateAnnotationMutation(c.local), cloud = validateAnnotationRecord(c.cloud);
    if (c.id !== local.id || c.id !== cloud.id || (c.reason !== 'revision' && c.reason !== 'parent-trashed')) throw annotationError();
    return {id:local.id,local,cloud,reason:c.reason as 'revision'|'parent-trashed'};
  });
  const guestCopies = (s.guestCopies as unknown[]).map(raw => {
    const c=annotationObject(raw);keys(c,['sourceId','sourceHash','targetId']);
    if (!validAnnotationId(c.sourceId) || !validAnnotationId(c.targetId) || !(c.sourceHash === 'standalone' || hash(c.sourceHash))) throw annotationError();
    return {sourceId:c.sourceId,sourceHash:c.sourceHash,targetId:c.targetId};
  });
  const unique = (values:string[]) => new Set(values).size === values.length;
  if (!unique(records.map(r=>r.id)) || !unique(pending.map(r=>r.operationId)) || !unique(conflicts.map(r=>r.id)) || !unique(drafts.map(r=>r.id)) ||
      !unique(guestCopies.map(c=>`${c.sourceId}:${c.sourceHash}`)) || pending.some(op=>conflicts.some(c=>c.id===op.id)) ||
      (scope==='guest' && (pending.length > 0 || conflicts.length > 0))) throw annotationError();
  return {version:1,scope,records,pending,conflicts,drafts,guestCopies};
}
