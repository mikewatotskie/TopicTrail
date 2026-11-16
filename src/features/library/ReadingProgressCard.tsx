import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { TTDocumentCard } from '../../components';
import { DocumentFormat, type Document } from '../../core/models/document';
import { readingProgressStorage } from '../../core/services/reading_progress_storage';
import { documentSubtitle } from './DocumentActions';
import { CompactDocumentRow } from './CompactDocumentRow';
import { useCloudLibrary } from './CloudLibraryContext';
import type { CardProgress, DocumentAvailability } from './libraryView';
const emptyProgress: ReadonlyMap<string, CardProgress> = new Map();
const emptyAvailability: ReadonlyMap<string, DocumentAvailability> = new Map();

export function useReadingProgressCards(documents: readonly Document[]) {
  const {runtime,state}=useCloudLibrary();
  const [entries, setEntries] = useState<{epoch:number;values:ReadonlyMap<string, CardProgress>}>({epoch:-1,values:emptyProgress});

  useFocusEffect(useCallback(() => {
    let active = true;
    if(runtime && (runtime.getSnapshot().epoch!==state.epoch || runtime.getSnapshot().revision!==state.revision))return;
    void Promise.all(documents.map(async doc => {
      try { return [doc.id, await (runtime?runtime.progressStore(readingProgressStorage):readingProgressStorage).read(doc)] as const; }
      catch { return [doc.id, 'unavailable'] as const; }
    })).then(results => {
      if (!active || (runtime && runtime.getSnapshot().epoch !== state.epoch)) return;
      const next = new Map<string, CardProgress>();
      for (const [id, progress] of results) if (progress) next.set(id, progress);
      setEntries({epoch:state.epoch,values:next});
    });
    return () => { active = false; };
  }, [documents,runtime,state.epoch,state.revision]));

  return entries.epoch === state.epoch ? entries.values : emptyProgress;
}

export function useDocumentAvailability(documents: readonly Document[]) {
  const {runtime,state} = useCloudLibrary();
  const [loaded,setLoaded] = useState<{epoch:number;values:ReadonlyMap<string,DocumentAvailability>}>({epoch:-1,values:emptyAvailability});
  useEffect(() => {
    let active = true;
    if (!runtime || state.phase === 'unavailable') return;
    void runtime?.documentAvailability().then(values => {
      if(active && runtime.getSnapshot().epoch === state.epoch) setLoaded({epoch:state.epoch,values});
    }).catch(() => { if(active) setLoaded({epoch:state.epoch,values:new Map(documents.map(doc => [doc.id,'attention']))}); });
    return () => { active = false; };
  }, [runtime,state.phase,state.epoch,state.revision,documents]);
  return loaded.epoch === state.epoch ? loaded.values : emptyAvailability;
}

const availabilityCopy: Record<DocumentAvailability,string> = {available:'Available on this device',waiting:'Waiting to sync','cloud-only':'Download pending',attention:'Needs attention'};
export function ReadingProgressCard({ document, progress, availability, onMorePressed, compact = false }: {
  document: Document;
  progress?: CardProgress;
  availability?: DocumentAvailability;
  onMorePressed(status?: string): void;
  compact?: boolean;
}) {
  const router = useRouter();
  const unit = document.format === DocumentFormat.DOCX ? 'section' : document.format === DocumentFormat.PPTX ? 'slide' : 'page';
  const detail = progress === 'unavailable' ? 'Reading progress unavailable'
    : progress ? `Resume at ${unit} ${progress.page} of ${progress.totalPages}` : '';
  const readingStatus = [detail, availability && availabilityCopy[availability]].filter(Boolean).join(' · ');
  const onOpen = () => router.push({ pathname: '/reader/[documentId]', params: { documentId: document.id } });
  if (compact) {
    const attention = [progress === 'unavailable' ? detail : '', availability && availability !== 'available' && availabilityCopy[availability]]
      .filter(Boolean).join(' · ');
    return <CompactDocumentRow document={document} position={progress && progress !== 'unavailable' ? progress : undefined}
      readingStatus={readingStatus} attention={attention} onOpen={onOpen} onMorePressed={() => onMorePressed(readingStatus)} />;
  }
  return <TTDocumentCard title={document.title} format={document.format} uploadedAt={document.importedAt}
    subtitle={[documentSubtitle(document), readingStatus].filter(Boolean).join(' · ')} onMorePressed={onMorePressed} onPress={onOpen} />;
}
