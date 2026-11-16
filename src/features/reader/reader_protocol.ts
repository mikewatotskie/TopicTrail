import { parseReaderMessage, type ReaderMessage } from './selection';
import type { PptxSlide } from '../../core/services/pptx_parser';
import type { TextAnchorV1, RegionAnchorV1 } from '../../core/services/annotations/types';
import { isTextAnchor, isRegionAnchor } from './reader_anchors';
export interface ReaderAnnotation { id: string; anchor: TextAnchorV1 | RegionAnchorV1; color: 'yellow' | 'green' | 'blue' | 'purple'; hasNote: boolean }
export function validateReaderAnnotations(value: unknown): value is ReaderAnnotation[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  const ids = new Set<string>();
  if (!value.every(a => a && typeof a.id === 'string' && a.id.length > 0 && a.id.length <= 160 && !ids.has(a.id) && !!ids.add(a.id) &&
      ['yellow','green','blue','purple'].includes(a.color) && typeof a.hasNote === 'boolean' && (isTextAnchor(a.anchor) || isRegionAnchor(a.anchor)))) return false;
  try { return JSON.stringify(value).length <= 1024 * 1024; } catch { return false; }
}
export type ReaderInput = { dark: boolean } & (
  { format: 'pdf'; bytes: ArrayBuffer; base64?: never; paragraphs?: never } |
  { format: 'pdf'; base64: string; bytes?: never; paragraphs?: never } |
  { format: 'docx'; paragraphs: string[]; bytes?: never; base64?: never } |
  { format: 'pptx'; slides: PptxSlide[]; bytes?: never; base64?: never; paragraphs?: never });
export type ReaderCommand = { type: 'load'; input: ReaderInput } | { type: 'page' | 'zoom'; value: number }
  | { type: 'selectAll' | 'clearSelection' | 'dispose' | 'cancelOcr' } | { type: 'recognize'; jobId?: string } | { type: 'theme'; dark: boolean }
  | ({ type: 'showOcr' } & CachedOcr)
  | { type: 'setAnnotations'; items: ReaderAnnotation[] }
  | { type: 'revealAnnotation'; id: string }
  | { type: 'markArea'; mode: 'drag' | 'corners' }
  | { type: 'cancelArea' | 'focus' };
export interface ReaderEnvelope { protocol: 1; session: string; generation: number; renderToken: number; command: ReaderCommand }
export interface CachedOcr { page: number; text: string; confidence: number | null; truncated?: boolean }
export function validateCachedOcr(value: unknown): value is CachedOcr {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return typeof data.page === 'number' && Number.isSafeInteger(data.page) && data.page >= 1 && data.page <= 100000 &&
    typeof data.text === 'string' && data.text.length <= 50000 && (data.confidence === null ||
    (typeof data.confidence === 'number' && Number.isFinite(data.confidence) && data.confidence >= 0 && data.confidence <= 100)) &&
    (data.truncated === undefined || typeof data.truncated === 'boolean');
}
export function validateReaderInput(value: unknown): value is ReaderInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.dark !== 'boolean') return false;
  if(v.format==='pptx')return v.bytes===undefined&&v.base64===undefined&&v.paragraphs===undefined&&validatePptxSlides(v.slides);
  if (v.format === 'pdf' && v.paragraphs === undefined) {
    if (v.bytes instanceof ArrayBuffer) return v.base64 === undefined && v.bytes.byteLength > 0 && v.bytes.byteLength <= 50 * 1024 * 1024;
    return v.bytes === undefined && typeof v.base64 === 'string' && v.base64.length > 0 && v.base64.length <= Math.ceil(50 * 1024 * 1024 / 3) * 4;
  }
  return v.format === 'docx' && v.bytes === undefined && v.base64 === undefined && Array.isArray(v.paragraphs)
    && v.paragraphs.length <= 100000 && v.paragraphs.every(p => typeof p === 'string')
    && v.paragraphs.reduce((size, p) => size + p.length, 0) <= 8 * 1024 * 1024;
}
export function validatePptxSlides(value:unknown):value is PptxSlide[]{
  if(!Array.isArray(value)||value.length<1||value.length>500)return false;
  let textSize=0,imageSize=0;
  const lines=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=100000&&v.every(s=>{if(typeof s!=='string')return false;textSize+=s.length;return textSize<=8*1024*1024;});
  return value.every(slide=>{
    if(!slide||typeof slide!=='object'||!lines(slide.paragraphs)||!lines(slide.notes)||!Array.isArray(slide.tables)||slide.tables.length>1000||!slide.tables.every((table:unknown)=>Array.isArray(table)&&table.length<=10000&&table.every(lines))||!Array.isArray(slide.images)||slide.images.length>500)return false;
    return slide.images.every((image:unknown)=>{if(!image||typeof image!=='object')return false;const i=image as Record<string,unknown>;if(!['image/png','image/jpeg','image/gif','image/webp'].includes(String(i.mime))||typeof i.base64!=='string'||i.base64.length>Math.ceil(8*1024*1024/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(i.base64)||typeof i.alt!=='string'||i.alt.length>2048)return false;imageSize+=i.base64.length;return imageSize<=Math.ceil(64*1024*1024/3)*4;});
  });
}
export function parseWebReaderEvent(value: unknown, session: string, generation: number, renderToken?: number): ReaderMessage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.protocol !== 1 || v.session !== session || v.generation !== generation || !v.message || typeof v.message !== 'object') return null;
  if (renderToken !== undefined && v.renderToken !== renderToken) return null;
  try { return parseReaderMessage(JSON.stringify(v.message)); } catch { return null; }
}
