import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ReadingProgressSession, type ProgressDocument, type ReadingPosition } from '../../core/services/reading_progress';
import { readingProgressStorage } from '../../core/services/reading_progress_storage';

export function useReadingProgress() {
  const mounted = useRef(false);
  const current = useRef<ReadingProgressSession | null>(null);
  const [progressWarning, setProgressWarning] = useState('');

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; current.current = null; };
  }, []);

  const hydrateProgress = useCallback(async (document: ProgressDocument, isActive: () => boolean) => {
    const session = new ReadingProgressSession(readingProgressStorage, document);
    let warning = '';
    try { await session.hydrate(); }
    catch { warning = 'Saved reading progress could not be loaded. Progress is unavailable for this reading session.'; }
    if (mounted.current && isActive()) {
      current.current = session;
      setProgressWarning(warning);
    }
  }, []);

  function acceptRenderedPage(position: ReadingPosition, resume: (page: number) => void): boolean {
    const session = current.current;
    if (!session) return false;
    const result = session.pageRendered(position);
    if (result.type === 'resume') resume(result.page);
    if (result.type !== 'rendered') return false;

    void result.saved?.then(
      () => { if (current.current === session) setProgressWarning(''); },
      () => { if (current.current === session) setProgressWarning('Reading progress could not be saved on this device.'); },
    );
    return true;
  }

  return { hydrateProgress, acceptRenderedPage, progressWarning };
}
