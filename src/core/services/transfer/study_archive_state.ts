import { strToU8 } from 'fflate';
import { Document, type DocumentFormat } from '../../models/document';
import { decodeDocumentLibrary, encodeDocumentLibrary, type DocumentLibrary } from '../document_library_codec';
import { decodeBookmarks, encodeBookmarks } from '../bookmarks/metadata';
import { decodeAnnotationState, emptyAnnotationState } from '../annotations/validation';
import { accountCacheCodec } from '../cloud/cache_store';
import { studyView } from '../cloud/study_state';
import { cloudIdentityKey } from '../cloud/types';
import { sha256 } from '../cloud/sha256';
import type { TransferFile } from '../study_transfer_native';

export interface StudySnapshot {
  version: 1;
  scope: string;
  library: string;
  notes: string;
  bookmarks: string | null;
  progress: Record<string, string>;
  originals: { path: string; bytes: number | null; sha256: string | null }[];
  counts: Record<string, number>;
}
export function identityOf(scope: string) {
  const [project, uid] = scope.split('/');
  if (cloudIdentityKey({ project, uid }) !== scope) throw Error('Invalid account scope.');
  return { project, uid };
}
export function codecFor(scope: string) {
  return accountCacheCodec(identityOf(scope), (id, format) => id + '.' + format);
}
export function archivePath(scope: string, name: string) {
  if (!/^[A-Za-z0-9_-]{1,160}\.(pdf|docx|pptx)$/.test(name)) throw Error('Invalid original file name.');
  return scope === 'guest' ? 'documents/' + name : 'topictrail-cloud-v1/' + cloudIdentityKey(identityOf(scope)) + '/' + name;
}
export function guestWithPaths(library: DocumentLibrary, path: (doc: Document) => string) {
  return encodeDocumentLibrary({ ...library, documents: library.documents.map(doc => doc.copyWith({filePath: path(doc)})) });
}
export function emptyNotes(scope: string) { return JSON.stringify(emptyAnnotationState(scope)); }
export function emptyBookmarks() { return encodeBookmarks([]); }
export function scopeDocs(scope: string, library: string) {
  if (scope === 'guest') return decodeDocumentLibrary(library).documents;
  return [...codecFor(scope).decode({revision: 1, json: library}).entries.values()].map(entry => entry.document);
}
export function progressRow(id: string, format: DocumentFormat, json: string) {
  const row = JSON.parse(json);
  if (row?.version !== 1 || row.documentId !== id || row.format !== format || !Number.isSafeInteger(row.page) ||
      !Number.isSafeInteger(row.totalPages) || row.page < 1 || row.page > row.totalPages) throw Error('Invalid reading position.');
  return JSON.stringify({version: 1, documentId: id, format, page: row.page, totalPages: row.totalPages});
}
export function progressKeyFor(doc: Document) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(doc.id)) throw Error('Invalid study document identifier.');
  return 'guest/progress/' + doc.format + '/' + doc.id;
}
export function countsFor(data: Omit<StudySnapshot,'counts'>) {
  const notes = decodeAnnotationState(JSON.parse(data.notes), data.scope);
  const cache = data.scope === 'guest' ? null : codecFor(data.scope).decode({revision:1, json:data.library});
  const study = cache?.study;
  return {
    documents: scopeDocs(data.scope, data.library).length,
    trash: cache ? [...cache.entries.keys()].filter(id => studyView(cache.study,'document',id)?.deleted).length : 0,
    originals: data.originals.filter(f => f.sha256 !== null).length,
    missing: data.originals.filter(f => f.sha256 === null).length,
    bookmarks: data.bookmarks === null ? study!.records.filter(r => r.kind === 'bookmark').length : decodeBookmarks(data.bookmarks).length,
    progress: Object.keys(data.progress).length + (study?.records.filter(r => r.kind === 'progress').length ?? 0),
    notes: notes.records.length, drafts: notes.drafts.length,
    conflicts: notes.conflicts.length + (study?.conflicts.length ?? 0),
    pending: notes.pending.length + (study?.pending.length ?? 0),
    studyRecords: study?.records.length ?? 0,
  };
}
const invalid = () => Error('The archive inventory does not match the study data.');
export function verifySnapshot(json: string, scope: string, files: TransferFile[]): StudySnapshot {
  const data: StudySnapshot = JSON.parse(json);
  if (!data || data.version !== 1 || data.scope !== scope) throw Error('Open this archive in the same Guest or signed-in account library that exported it.');
  if (typeof data.library !== 'string' || typeof data.notes !== 'string' || !Array.isArray(data.originals) ||
      !data.counts || !data.progress || typeof data.progress !== 'object' || Array.isArray(data.progress)) throw invalid();
  const guest = scope === 'guest';
  if (guest ? typeof data.bookmarks !== 'string' : data.bookmarks !== null || Object.keys(data.progress).length > 0) throw invalid();
  const docs = scopeDocs(scope, data.library);
  if (new Set(docs.map(d => d.id)).size !== docs.length) throw invalid();
  const expected = new Map(docs.map(doc => {
    if (!doc.filePath.endsWith('.' + doc.format)) throw invalid();
    return [archivePath(scope, doc.filePath), doc];
  }));
  if (expected.size !== docs.length || expected.size !== data.originals.length) throw invalid();
  const present = new Map(files.map(f => [f.path, f]));
  if (present.size !== files.length) throw invalid();
  const cache = guest ? null : codecFor(scope).decode({revision: 1, json: data.library});
  const checkedKeys = new Set<string>();
  for (const original of data.originals) {
    const doc = expected.get(original.path);
    if (!doc) throw invalid();
    expected.delete(original.path);
    if (guest) {
      const key = progressKeyFor(doc);
      if (Object.hasOwn(data.progress, key)) {
        if (typeof data.progress[key] !== 'string') throw invalid();
        data.progress[key] = progressRow(doc.id, doc.format, data.progress[key]);
        checkedKeys.add(key);
      }
    }
    if (original.sha256 === null && original.bytes === null) continue;
    const entry = present.get(original.path);
    if (!entry || !Number.isSafeInteger(original.bytes) || entry.bytes !== original.bytes ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.sha256 !== original.sha256 ||
        (doc.fileSize !== undefined && entry.bytes !== doc.fileSize) ||
        (cache && cache.entries.get(doc.id)?.hash !== entry.sha256)) throw invalid();
    present.delete(original.path);
  }
  if (present.size || expected.size || Object.keys(data.progress).length !== checkedKeys.size) throw invalid();
  const counts = countsFor(data);
  if (Object.entries(counts).some(([key, count]) => data.counts[key] !== count) ||
      Object.keys(data.counts).length !== Object.keys(counts).length) throw invalid();
  return data;
}
export const receiptKey = (scope: string, json: string) => 'receipts/' + scope + '/' + sha256(strToU8(json));
