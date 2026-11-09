import { MAX_FILE_SIZE_BYTES } from './document_validation';
import { getBrowserClient } from './web/indexeddb_client';
export async function readDocumentBytes(path: string): Promise<Uint8Array> {
  const file = await (await getBrowserClient()).readOwnedDocument(path);
  if (file.size > MAX_FILE_SIZE_BYTES) throw Error('This document exceeds the 50 MB limit.');
  return new Uint8Array(await file.arrayBuffer());
}
