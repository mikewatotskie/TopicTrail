import { parseReaderMessage, type ReaderMessage } from './selection';
export type ReaderInput = { dark: boolean } & (
  { format: 'pdf'; bytes: ArrayBuffer; base64?: never; paragraphs?: never } |
  { format: 'pdf'; base64: string; bytes?: never; paragraphs?: never } |
  { format: 'docx'; paragraphs: string[]; bytes?: never; base64?: never });
export type ReaderCommand = { type: 'load'; input: ReaderInput } | { type: 'page' | 'zoom'; value: number }
  | { type: 'selectAll' | 'clearSelection' | 'dispose' } | { type: 'theme'; dark: boolean };
export function validateReaderInput(value: unknown): value is ReaderInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.dark !== 'boolean') return false;
  if (v.format === 'pdf' && v.paragraphs === undefined) {
    if (v.bytes instanceof ArrayBuffer) return v.base64 === undefined && v.bytes.byteLength > 0 && v.bytes.byteLength <= 50 * 1024 * 1024;
    return v.bytes === undefined && typeof v.base64 === 'string' && v.base64.length > 0 && v.base64.length <= Math.ceil(50 * 1024 * 1024 / 3) * 4;
  }
  return v.format === 'docx' && v.bytes === undefined && v.base64 === undefined && Array.isArray(v.paragraphs)
    && v.paragraphs.length <= 100000 && v.paragraphs.every(p => typeof p === 'string')
    && v.paragraphs.reduce((size, p) => size + p.length, 0) <= 8 * 1024 * 1024;
}
export function parseWebReaderEvent(value: unknown, session: string, generation: number): ReaderMessage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.protocol !== 1 || v.session !== session || v.generation !== generation || !v.message || typeof v.message !== 'object') return null;
  try { return parseReaderMessage(JSON.stringify(v.message)); } catch { return null; }
}
