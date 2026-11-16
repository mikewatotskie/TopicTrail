import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { Document } from '../../core/models/document';
import { DocumentStorage } from '../../core/services/document_storage';
import { subscribeLibraryChanges } from '../../core/services/web/library_events';
import { useCloudLibrary } from './CloudLibraryContext';
const noDocuments: readonly Document[] = Object.freeze([]);
export function useDocuments() {
  const { state: cloud, runtime } = useCloudLibrary();
  const scope = `${cloud.key ?? (cloud.phase === 'guest' ? 'guest' : 'unavailable')}:${cloud.epoch}`;
  const [loadedScope, setLoadedScope] = useState('');
  const [documents, setDocuments] = useState<readonly Document[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>();
  const generation = useRef(0); const active = useRef(false);
  const reload = useCallback(async () => {
    const request = ++generation.current; if (!active.current) return;
    setStatus('loading');
    try {
      const next = await DocumentStorage.instance.getAllDocuments();
      if (!active.current || request !== generation.current) return;
      setDocuments(next); setLoadedScope(scope); setError(undefined); setStatus('ready');
    } catch {
      if (!active.current || request !== generation.current) return;
      setError('Your library could not be read. Existing documents have not been discarded. Retry to recover.'); setStatus('error');
    }
  }, [scope]);
  useFocusEffect(useCallback(() => {
    active.current = true; void reload(); const refresh = () => { void reload(); };
    const unsubscribe = Platform.OS === 'web' ? subscribeLibraryChanges('documents', refresh) : () => {};
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('focus', refresh);
    return () => {
      active.current = false; generation.current++; unsubscribe();
      if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('focus', refresh);
    };
  }, [reload]));
  useEffect(()=>{if(active.current)void reload();},[reload,cloud.revision]);
  useFocusEffect(useCallback(() => { void runtime?.sync(); }, [runtime]));
  return { documents: loadedScope === scope ? documents : noDocuments, status: loadedScope === scope ? status : status === 'error' ? 'error' as const : 'loading' as const, error, reload };
}
