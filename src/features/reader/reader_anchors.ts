import { strToU8 } from 'fflate';
import { sha256 } from '../../core/services/cloud/sha256';
import type { TextAnchorV1, RegionAnchorV1 } from '../../core/services/annotations/types';
import { validateTextAnchor, validateRegionAnchor } from '../../core/services/annotations/validation';

export type TextSurface = TextAnchorV1['surface'];
export interface CanonicalBlock { id: string; text: string; node: HTMLElement }
export interface CanonicalSurface { surface: TextSurface; blocks: CanonicalBlock[]; textHash: string }
export const MAX_ANCHOR_QUOTE = 6000;

// V1 preserves UTF-16 text exactly. Block separators exist in the quote, never in offsets.
export function canonicalSurface(root: HTMLElement, surface: TextSurface): CanonicalSurface {
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-annotation-block]')]
    .filter(node => node.dataset.annotationSurface === surface)
    .map(node => ({ id: node.dataset.annotationBlock!, text: node.dataset.annotationText ?? node.textContent ?? '', node }));
  const textHash = sha256(strToU8(JSON.stringify({ version: 1, surface, blocks: blocks.map(({ id, text }) => [id, text]) })));
  return { surface, blocks, textHash };
}

export function isTextAnchor(value: unknown): value is TextAnchorV1 {
  try { validateTextAnchor(value); return true; } catch { return false; }
}
export function isRegionAnchor(value: unknown): value is RegionAnchorV1 {
  try { validateRegionAnchor(value); return true; } catch { return false; }
}

function textOffset(block: HTMLElement, node: Node, offset: number): number {
  const range = block.ownerDocument.createRange(); range.selectNodeContents(block); range.setEnd(node, offset);
  return range.toString().length;
}
function validUtf16Boundary(text: string, index: number): boolean {
  return !(index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]));
}
export function captureTextAnchor(root: HTMLElement, selected: Selection | null): { anchor?: TextAnchorV1; reason?: string } {
  if (!selected || selected.isCollapsed || selected.rangeCount !== 1 || !selected.anchorNode || !selected.focusNode ||
      !root.contains(selected.anchorNode) || !root.contains(selected.focusNode)) return {};
  const range = selected.getRangeAt(0);
  const chosen = [...root.querySelectorAll<HTMLElement>('[data-annotation-block]')].filter(node => range.intersectsNode(node));
  const pieces = chosen.map(node => ({ node, start: node.contains(range.startContainer) ? textOffset(node, range.startContainer, range.startOffset) : 0,
    end: node.contains(range.endContainer) ? textOffset(node, range.endContainer, range.endOffset) : (node.dataset.annotationText ?? node.textContent ?? '').length }))
    .filter(({ start, end }) => end > start);
  if (!pieces.length) return { reason: 'Select document text to attach a highlight.' };
  const surfaces = new Set(pieces.map(({ node }) => node.dataset.annotationSurface));
  if (surfaces.size !== 1) return { reason: 'Select text from one surface. PDF text and recognized text have separate highlights.' };
  if (pieces.length > 128) return { reason: 'Select a shorter passage to attach a highlight.' };
  const model = canonicalSurface(root, pieces[0].node.dataset.annotationSurface as TextSurface);
  const ranges = pieces.map(({node,start,end}) => ({blockId:node.dataset.annotationBlock!,startUtf16:start,endUtf16:end}));
  const quote = pieces.map(({node,start,end}) => (node.dataset.annotationText ?? node.textContent ?? '').slice(start,end)).join('\n');
  if (quote.length > MAX_ANCHOR_QUOTE) return { reason: 'Highlights support up to 6,000 characters. Select a shorter passage.' };
  const first = pieces[0], last = pieces[pieces.length - 1];
  const firstText=first.node.dataset.annotationText ?? first.node.textContent ?? '', lastText=last.node.dataset.annotationText ?? last.node.textContent ?? '';
  let prefixStart=Math.max(0,first.start-128), suffixEnd=Math.min(lastText.length,last.end+128);
  if(!validUtf16Boundary(firstText,prefixStart))prefixStart++;
  if(!validUtf16Boundary(lastText,suffixEnd))suffixEnd--;
  const anchor: TextAnchorV1 = { kind:'text',version:1,surface:model.surface,textHash:model.textHash,ranges,quote,
    prefix:firstText.slice(prefixStart,first.start),suffix:lastText.slice(last.end,suffixEnd) };
  if (!resolveTextAnchor(model, anchor)) return { reason: 'This selection cannot be placed reliably. Select a complete passage again.' };
  return { anchor };
}

function pointAt(node: HTMLElement, offset: number): [Node,number] | null {
  const walker = node.ownerDocument.createTreeWalker(node, 4); let child = walker.nextNode(); let remaining = offset;
  while (child) { const length = child.textContent?.length ?? 0; if (remaining <= length) return [child,remaining]; remaining -= length; child = walker.nextNode(); }
  return null;
}
// Exact hash + source identity + offsets + quote/context. Never search for a similar quotation.
export function resolveTextAnchor(model: CanonicalSurface, anchor: TextAnchorV1): Range[] | null {
  if (!isTextAnchor(anchor) || model.surface !== anchor.surface || model.textHash !== anchor.textHash) return null;
  const ranges: Range[] = []; const parts: string[] = []; let previous = -1;
  for (const part of anchor.ranges) {
    const index = model.blocks.findIndex(b => b.id === part.blockId);
    if (index <= previous || index < 0) return null;
    previous = index; const block = model.blocks[index];
    if (block.node.textContent !== block.text || part.endUtf16 > block.text.length || !validUtf16Boundary(block.text,part.startUtf16) || !validUtf16Boundary(block.text,part.endUtf16)) return null;
    const start = pointAt(block.node,part.startUtf16), end = pointAt(block.node,part.endUtf16);
    if (!start || !end) return null;
    const range = block.node.ownerDocument.createRange(); range.setStart(...start); range.setEnd(...end); ranges.push(range);
    parts.push(block.text.slice(part.startUtf16,part.endUtf16));
  }
  const first = anchor.ranges[0], last = anchor.ranges[anchor.ranges.length-1];
  const firstText = model.blocks.find(b => b.id === first.blockId)!.text, lastText = model.blocks.find(b => b.id === last.blockId)!.text;
  if (parts.join('\n') !== anchor.quote || !firstText.slice(0,first.startUtf16).endsWith(anchor.prefix) || !lastText.slice(last.endUtf16).startsWith(anchor.suffix)) return null;
  return ranges;
}

export function anchorsOverlap(left: TextAnchorV1, right: TextAnchorV1): boolean {
  return left.surface === right.surface && left.textHash === right.textHash && left.ranges.some(a => right.ranges.some(b =>
    a.blockId === b.blockId && Math.max(a.startUtf16,b.startUtf16) < Math.min(a.endUtf16,b.endUtf16)));
}
