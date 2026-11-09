import React, { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { TTDocumentCard } from '../../components';
import { DocumentFormat, type Document } from '../../core/models/document';
import type { ReadingPosition } from '../../core/services/reading_progress';
import { readingProgressStorage } from '../../core/services/reading_progress_storage';
import { documentSubtitle } from './DocumentActions';

type CardProgress = ReadingPosition | 'unavailable';

export function useReadingProgressCards(documents: readonly Document[]) {
  const [entries, setEntries] = useState<ReadonlyMap<string, CardProgress>>(() => new Map());

  useFocusEffect(useCallback(() => {
    let active = true;
    void Promise.all(documents.map(async doc => {
      try { return [doc.id, await readingProgressStorage.read(doc)] as const; }
      catch { return [doc.id, 'unavailable'] as const; }
    })).then(results => {
      if (!active) return;
      const next = new Map<string, CardProgress>();
      for (const [id, progress] of results) if (progress) next.set(id, progress);
      setEntries(next);
    });
    return () => { active = false; };
  }, [documents]));

  return entries;
}

export function ReadingProgressCard({ document, progress, onMorePressed }: {
  document: Document;
  progress?: CardProgress;
  onMorePressed(): void;
}) {
  const unit = document.format === DocumentFormat.DOCX ? 'section' : 'page';
  const detail = progress === 'unavailable' ? 'Reading progress unavailable'
    : progress ? `Resume at ${unit} ${progress.page} of ${progress.totalPages}` : '';
  const subtitle = [documentSubtitle(document), detail].filter(Boolean).join(' · ');

  return <TTDocumentCard title={document.title} format={document.format} uploadedAt={document.importedAt}
    subtitle={subtitle} onMorePressed={onMorePressed}
    onPress={() => router.push({ pathname: '/reader/[documentId]', params: { documentId: document.id } })} />;
}
