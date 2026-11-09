import { useCallback, useEffect, useRef, useState } from 'react';
import { resourceDiscovery } from '../../core/services/resources';
import { SearchSession } from '../../core/services/resources/session';
import type { SearchSelection, SearchState } from '../../core/services/resources/types';

/** Each mounted selection owns its session; effect setup also supports React's development remount. */
export function useResourceSearch(selection: SearchSelection) {
  const session = useRef<SearchSession | null>(null);
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  useEffect(() => {
    const current = new SearchSession(resourceDiscovery);
    session.current = current;
    const unsubscribe = current.subscribe(() => setState(current.getSnapshot()));
    return () => {
      unsubscribe(); current.dispose();
      if (session.current === current) session.current = null;
    };
  }, []);
  const search = useCallback((query: string) => { void session.current?.search(selection, query); }, [selection]);
  const cancel = useCallback(() => session.current?.cancel(), []);
  return { state, search, cancel };
}
