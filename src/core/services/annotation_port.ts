import AsyncStorage from '@react-native-async-storage/async-storage';
import { annotationEnvelope, createKeyValueAnnotationPort, readAnnotationEnvelope } from './annotation_port_contract';
import { productionMetadata } from './study_metadata';
import type { AnnotationPort } from './annotations/types';
export function createAnnotationPort(scope: string): AnnotationPort {
  const store = productionMetadata();
  if (!store) return createKeyValueAnnotationPort(scope, AsyncStorage);
  const keys = ['notes/' + scope];
  const unpack = (value: string | null) => readAnnotationEnvelope(value === null ? null : JSON.parse(value));
  return {
    async read() { return unpack((await store.read(keys))[0]); },
    async commit(expected, json) {
      const current = await store.read(keys);
      if (unpack(current[0]).revision !== expected) return false;
      return store.compareAndSet(keys, current, [JSON.stringify(annotationEnvelope(expected + 1, json))]);
    },
  };
}
