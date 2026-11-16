import { File } from 'expo-file-system';
import type { Document } from '../models/document';
import { DocumentImportService } from './document_import';
import { DocumentStorage } from './document_storage';
import { MAX_FILE_SIZE_BYTES, validateDocument } from './document_validation';
import { createAnnotationPort } from './annotation_port';
import { decodeAnnotationState } from './annotations/validation';
import { checkRelinkFingerprint } from './annotations/relink';

export async function relinkGuestFile(document: Document, checkActive: () => void): Promise<boolean> {
  checkActive();
  const picker = new DocumentImportService(DocumentStorage.legacy);
  const selection = await picker.pickDocument();
  if (!selection) return false;
  try {
    checkActive();
    const file = new File(selection.uri);
    if ((file.size ?? 0) > MAX_FILE_SIZE_BYTES) throw new Error('The selected file exceeds the 50 MiB limit.');
    const bytes = await file.bytes();
    const format = validateDocument(selection.name, bytes);
    const snapshot = await createAnnotationPort('guest').read();
    checkActive();
    if (snapshot.json !== null) {
      const state = decodeAnnotationState(JSON.parse(snapshot.json), 'guest');
      checkRelinkFingerprint(document.id, bytes, [...state.records, ...state.drafts].map(note => note.payload));
    }
    await DocumentStorage.legacy.relinkMissingDocument(document.id, selection.uri, format, bytes.byteLength, checkActive);
    return true;
  } finally { picker.discardSelection(selection.uri); }
}
