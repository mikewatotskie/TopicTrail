import { annotationEnvelope, readAnnotationEnvelope } from '../annotation_port_contract';

// Both stores checksum the revision and the exact UTF-8 JSON representation.
export function packAccountEnvelope(revision: number, json: string): string {
  return JSON.stringify(annotationEnvelope(revision, json));
}
export function unpackAccountEnvelope(value: string | null) {
  return readAnnotationEnvelope(value === null ? null : JSON.parse(value));
}
