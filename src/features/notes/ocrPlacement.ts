import { strToU8 } from 'fflate';
import { sha256 } from '../../core/services/cloud/sha256';
import type { AnnotationPayload, TextAnchorV1 } from '../../core/services/annotations/types';
import { validateTextAnchor } from '../../core/services/annotations/validation';
import type { AnnotationPlacement } from '../reader/selection';

export type OcrNotePlacement = AnnotationPlacement['status'] | 'matches-text' | 'check-on-open';
export interface OcrPlacementOwner { scope: string; epoch: number; checkActive(): void }
/** A reader-local snapshot, valid only for its captured account and exact anchors. */
export interface OcrRenderPlacements {
  owner: OcrPlacementOwner;
  checks: readonly { key: string; status: AnnotationPlacement['status'] }[];
}
export type OcrPlacementTarget = Pick<AnnotationPayload, 'id' | 'documentId' | 'documentHash' | 'format' | 'location' | 'anchor'>;

export function ocrPlacementKey(payload: OcrPlacementTarget): string | null {
  if (payload.anchor?.kind !== 'text' || payload.anchor.surface !== 'ocr-text') return null;
  const { id, documentId, documentHash, format, location, anchor } = payload;
  return JSON.stringify({ id, documentId, documentHash, format, location, anchor });
}

function utf16Boundary(text: string, offset: number): boolean {
  return !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}

/** Same one-block, exact UTF-16 contract as reader_anchors. Hash once per cached page.
 * This checks text only; a cache match is not proof of a rendered highlight. */
export function createOcrPlacementCheck(text: string | null): (anchor: TextAnchorV1) => OcrNotePlacement {
  const textHash = text === null ? null : sha256(strToU8(JSON.stringify({
    version: 1, surface: 'ocr-text', blocks: [['ocr-page-text', text]],
  })));
  return anchor => {
    if (text === null) return 'recognize-page';
    try { validateTextAnchor(anchor); } catch { return 'needs-review'; }
    if (anchor.surface !== 'ocr-text' || anchor.textHash !== textHash || anchor.ranges.length !== 1) return 'needs-review';
    const range = anchor.ranges[0];
    if (range.blockId !== 'ocr-page-text' || range.endUtf16 > text.length ||
        !utf16Boundary(text, range.startUtf16) || !utf16Boundary(text, range.endUtf16) ||
        text.slice(range.startUtf16, range.endUtf16) !== anchor.quote ||
        !text.slice(0, range.startUtf16).endsWith(anchor.prefix) || !text.slice(range.endUtf16).startsWith(anchor.suffix)) return 'needs-review';
    return 'matches-text';
  };
}

export const ocrPlacementCopy: Record<OcrNotePlacement, { label: string; message: string }> = {
  'needs-review': {
    label: 'Needs review',
    message: 'This highlight cannot be placed reliably in this device’s recognized text. Another device or OCR engine may produce a different transcript. Your note and saved passage are preserved; the highlight was not guessed.',
  },
  'recognize-page': {
    label: 'Recognize page',
    message: 'Open the original page and recognize its text to check this OCR highlight. Your note and saved passage remain available.',
  },
  'check-on-open': {
    label: 'Placement checked when opened',
    message: 'OCR placement has not been verified on this device. Your note and original passage are preserved.',
  },
  'matches-text': {
    label: 'Matches saved OCR text',
    message: 'The cached text on this device exactly matches this saved passage and its anchor. Open the page to display its highlight.',
  },
  placed: {
    label: 'Placed on this page',
    message: 'The reader matched this highlight to the exact recognized text on the current page.',
  },
};
