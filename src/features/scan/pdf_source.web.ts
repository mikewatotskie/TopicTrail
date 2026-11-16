import { registerWebImportSource, releaseWebImportSource } from '../../core/services/web/import_sources';

export async function withScanPdfSource<T>(bytes: Uint8Array, consume: (uri: string) => Promise<T>): Promise<T> {
  const file = new File([new Uint8Array(bytes)], 'scan.pdf', { type: 'application/pdf' });
  const uri = registerWebImportSource(file, '');
  try { return await consume(uri); }
  finally { releaseWebImportSource(uri); }
}
