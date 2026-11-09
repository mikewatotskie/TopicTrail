import { File } from 'expo-file-system';
import { MAX_FILE_SIZE_BYTES } from './document_validation';
export async function readDocumentBytes(path: string): Promise<Uint8Array> {
  const file = new File(path);
  if ((file.size ?? 0) > MAX_FILE_SIZE_BYTES) throw Error('This document exceeds the 50 MB limit.');
  return file.bytes();
}
