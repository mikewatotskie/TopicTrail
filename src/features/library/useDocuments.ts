import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { Document } from '../../core/models/document';
import { DocumentStorage } from '../../core/services/document_storage';
import { subscribeLibraryChanges } from '../../core/services/web/library_events';
export function useDocuments() {
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
      setDocuments(next); setError(undefined); setStatus('ready');
    } catch {
      if (!active.current || request !== generation.current) return;
      setError('Your library could not be read. Existing documents have not been discarded. Retry to recover.'); setStatus('error');
    }
  }, []);
  useFocusEffect(useCallback(() => {
    active.current = true; void reload(); const refresh = () => { void reload(); };
    const unsubscribe = Platform.OS === 'web' ? subscribeLibraryChanges('documents', refresh) : () => {};
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('focus', refresh);
    return () => {
      active.current = false; generation.current++; unsubscribe();
      if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('focus', refresh);
    };
  }, [reload]));
  return { documents, status, error, reload };
}
