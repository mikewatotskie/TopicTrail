export type ReaderMessage =
  | { type: 'ready' }
  | { type: 'selection'; text: string; page: number }
  | { type: 'selection-limit' }
  | { type: 'page'; page: number; totalPages: number; hasText: boolean }
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
    if (msg.type === 'ready') return { type: 'ready' };
    if (msg.type === 'selection-limit') return { type: 'selection-limit' };
    if (msg.type === 'selection' && validPage && typeof msg.text === 'string' && msg.text.length <= 50000) {
      return { type: 'selection', text: msg.text, page: msg.page as number };
    }
    if (msg.type === 'page' && validPage && typeof msg.totalPages === 'number' && Number.isInteger(msg.totalPages) &&
        msg.totalPages >= (msg.page as number) && typeof msg.hasText === 'boolean') {
      return { type: 'page', page: msg.page as number, totalPages: msg.totalPages, hasText: msg.hasText };
    }
    if (msg.type === 'error' && typeof msg.message === 'string') return { type: 'error', message: msg.message.slice(0, 500) };
  } catch { return null; }
  return null;
}
