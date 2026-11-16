import { useCallback, useEffect, useRef, useState } from 'react';
import { resourceDiscovery } from '../../core/services/resources';
import { SearchSession } from '../../core/services/resources/session';
import type { ResourceSource, SearchOrigin, SearchState } from '../../core/services/resources/types';

/** Each mounted selection owns its session; effect setup also supports React's development remount. */
export function useResourceSearch(selection: SearchOrigin) {
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
  const search = useCallback((query: string, source: ResourceSource) => {
    const origin = selection.kind === 'manual' ? {kind: 'manual' as const, text: query} : selection;
    void session.current?.search(origin, query, source);
  }, [selection]);
  const cancel = useCallback(() => session.current?.cancel(), []);
  return { state, search, cancel };
}
