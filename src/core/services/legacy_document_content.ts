import { Directory, File, Paths } from 'expo-file-system';
import { isOwnedDocumentUri } from './file_ownership';
import { MAX_FILE_SIZE_BYTES } from './document_validation';
export function isOwnedLegacyPath(path: string): boolean {
  return isOwnedDocumentUri(path, new Directory(Paths.document, 'documents').uri);
}
export async function readDocumentBytes(path: string): Promise<Uint8Array> {
  if (!isOwnedLegacyPath(path)) throw Error('Open Document options and choose Relink original file to read this syllabus.');
  const file = new File(path);
  if (!file.exists) throw Error('The stored file is missing. Open Document options and choose Relink original file.');
  if ((file.size ?? 0) > MAX_FILE_SIZE_BYTES) throw Error('This document exceeds the 50 MiB limit.');
  return file.bytes();
}
