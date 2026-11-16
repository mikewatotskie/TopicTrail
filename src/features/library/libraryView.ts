import type { Document, DocumentFormat } from '../../core/models/document';
import type { ReadingPosition } from '../../core/services/reading_progress';

export type LibraryFormat = 'all' | `${DocumentFormat}`;
export type LibrarySort = 'recent-opened' | 'recent-added' | 'title';
export type CardProgress = ReadingPosition | 'unavailable';
export type DocumentAvailability = 'available' | 'waiting' | 'cloud-only' | 'attention';

export function formatDocumentSize(bytes?: number): string {
  if (bytes === undefined) return '';
  return bytes < 1024 * 1024 ? Math.ceil(bytes / 1024) + ' KB' : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function filterLibraryDocuments(documents: readonly Document[], query: string, format: LibraryFormat, sort: LibrarySort): Document[] {
  const term = query.trim().normalize('NFKC').toLocaleLowerCase();
  return documents.filter(doc => (format === 'all' || doc.format === format) && doc.title.normalize('NFKC').toLocaleLowerCase().includes(term))
    .sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title, undefined, {sensitivity:'base'})
      : sort === 'recent-added' ? b.importedAt.getTime() - a.importedAt.getTime()
      : (b.lastOpenedAt?.getTime() ?? 0) - (a.lastOpenedAt?.getTime() ?? 0)) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export function continueReadingDocuments(documents: readonly Document[], progress: ReadonlyMap<string, CardProgress>): Document[] {
  return filterLibraryDocuments(documents, '', 'all', 'recent-opened').filter(doc => {
    const value = progress.get(doc.id);
    return value && value !== 'unavailable' && value.page > 0 && value.page <= value.totalPages;
  }).slice(0, 3);
}
