import { sha256 } from '../cloud/sha256';
import type { AnnotationPayload } from './types';

export function checkRelinkFingerprint(documentId: string, bytes: Uint8Array,
  attachments: readonly Pick<AnnotationPayload, 'documentId' | 'documentHash'>[]): void {
  const anchors = attachments.filter(note => note.documentId === documentId && note.documentHash);
  if (!anchors.length) return;
  const hash = sha256(bytes);
  if (anchors.some(note => note.documentHash !== hash)) {
    throw new Error('This file differs from the original linked to your notes. Choose the original file.');
  }
}
