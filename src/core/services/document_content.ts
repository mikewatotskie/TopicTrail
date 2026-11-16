import { getCloudLibrary } from './document_storage';
export async function readDocumentBytes(path: string): Promise<Uint8Array> {
  return getCloudLibrary().readBytes(path);
}
