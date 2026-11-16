import type { TextAnchorV1, RegionAnchorV1 } from '../../core/services/annotations/types';
import { isTextAnchor, isRegionAnchor } from './reader_anchors';

export type AnnotationPlacement = { id: string; status: 'placed' | 'recognize-page' | 'needs-review' };
export type ReaderMessage =
  | { type: 'ready' }
  | { type: 'selection'; text: string; page: number; anchor?: TextAnchorV1; annotationUnavailable?: string }
  | { type: 'render-start'; page: number }
  | { type: 'surface-change'; page: number }
  | { type: 'selection-reset'; page: number }
  | { type: 'area-preview'; page: number; anchor: RegionAnchorV1 }
  | { type: 'area-cancelled'; page: number }
  | { type: 'annotation-placements'; page: number; placements: AnnotationPlacement[] }
  | { type: 'selection-limit' }
  | { type: 'page'; page: number; totalPages: number; hasText: boolean }
  | { type: 'ocr-status'; page: number; state: 'running' | 'cancelled' | 'error'; progress: number; message?: string; jobId?: string }
  | { type: 'ocr-result'; page: number; text: string; confidence: number; truncated: boolean; jobId?: string }
  | { type: 'error'; message: string };

export function captureSelection(root: Node, selection: Selection | null): string {
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode ||
      !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return '';
  return selection.toString();
}
export function buildSelectionMessage(text: string, page: number): ReaderMessage {
  return text.length > 50000 ? { type: 'selection-limit' } : { type: 'selection', text, page };
}
export function parseReaderMessage(raw: string): ReaderMessage | null {
  if (raw.length > 310000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const msg = value as Record<string, unknown>;
    const validPage = typeof msg.page === 'number' && Number.isInteger(msg.page) && msg.page >= 1;
    if ((msg.type === 'ocr-result' || msg.type === 'ocr-status') && msg.jobId !== undefined &&
        (typeof msg.jobId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(msg.jobId))) return null;
    const job = typeof msg.jobId === 'string' ? { jobId: msg.jobId } : {};
    if (msg.type === 'ready') return { type: 'ready' };
    if (msg.type === 'selection-limit') return { type: 'selection-limit' };
    if ((msg.type === 'render-start' || msg.type === 'surface-change' || msg.type === 'selection-reset' || msg.type === 'area-cancelled') && validPage) return { type: msg.type, page: msg.page as number };
    if (msg.type === 'area-preview' && validPage && isRegionAnchor(msg.anchor)) return { type:'area-preview',page:msg.page as number,anchor:msg.anchor };
    if (msg.type === 'annotation-placements' && validPage && Array.isArray(msg.placements) && msg.placements.length <= 256 && msg.placements.every(p =>
      p && typeof p.id === 'string' && p.id.length <= 160 && ['placed','recognize-page','needs-review'].includes(p.status)))
      return {type:'annotation-placements',page:msg.page as number,placements:msg.placements};
    if (msg.type === 'ocr-result' && validPage && (msg.page as number) <= 100000 && typeof msg.text === 'string' && msg.text.length <= 50000 &&
        typeof msg.confidence === 'number' && Number.isFinite(msg.confidence) && msg.confidence >= 0 && msg.confidence <= 100 && typeof msg.truncated === 'boolean') {
      return { type: 'ocr-result', page: msg.page as number, text: msg.text, confidence: msg.confidence, truncated: msg.truncated, ...job };
    }
    if (msg.type === 'ocr-status' && validPage && (msg.page as number) <= 100000 && ['running', 'cancelled', 'error'].includes(String(msg.state)) &&
        typeof msg.progress === 'number' && Number.isFinite(msg.progress) && msg.progress >= 0 && msg.progress <= 1 &&
        (msg.message === undefined || typeof msg.message === 'string')) {
      return { type: 'ocr-status', page: msg.page as number, state: msg.state as 'running' | 'cancelled' | 'error', progress: msg.progress, ...job,
        ...(typeof msg.message === 'string' ? { message: msg.message.slice(0, 500) } : {}) };
    }
    if (msg.type === 'selection' && validPage && typeof msg.text === 'string' && msg.text.length <= 50000) {
      if (msg.anchor !== undefined && (!isTextAnchor(msg.anchor) || msg.anchor.quote !== msg.text)) return null;
      if (msg.annotationUnavailable !== undefined && (typeof msg.annotationUnavailable !== 'string' || msg.annotationUnavailable.length > 500)) return null;
      return { type: 'selection', text: msg.text, page: msg.page as number,
        ...(msg.anchor !== undefined ? {anchor:msg.anchor as TextAnchorV1} : {}),
        ...(typeof msg.annotationUnavailable === 'string' ? {annotationUnavailable:msg.annotationUnavailable} : {}) };
    }
    if (msg.type === 'page' && validPage && typeof msg.totalPages === 'number' && Number.isInteger(msg.totalPages) &&
        msg.totalPages >= (msg.page as number) && typeof msg.hasText === 'boolean') {
      return { type: 'page', page: msg.page as number, totalPages: msg.totalPages, hasText: msg.hasText };
    }
    if (msg.type === 'error' && typeof msg.message === 'string') return { type: 'error', message: msg.message.slice(0, 500) };
  } catch { return null; }
  return null;
}
