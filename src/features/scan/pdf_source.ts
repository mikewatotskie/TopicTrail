import { File, Paths } from 'expo-file-system';
import { createImportAttempt } from '../../core/services/document_import_contract';

export async function withScanPdfSource<T>(bytes: Uint8Array, consume: (uri: string) => Promise<T>): Promise<T> {
  const file = new File(Paths.cache, 'topictrail-scan-' + createImportAttempt().attemptId + '.pdf');
  try {
    file.create();
    await file.write(bytes);
    return await consume(file.uri);
  } finally {
    // Only the private cache file allocated above is eligible for cleanup.
    try { if (file.exists) file.delete(); } catch { /* Cache cleanup must not invalidate a successful import. */ }
  }
}
