import { DocumentImportService } from '../../core/services/document_import';
import { registerWebImportSource, releaseWebImportSource } from '../../core/services/web/import_sources';
import type { DemoSampleImportPort } from './ensureDemoSample';

export const importDemoSample: DemoSampleImportPort['importSample'] = async (sample, attempt) => {
  const bytes = Uint8Array.from(sample.createBytes());
  const file = new File([bytes], sample.filename, { type: sample.mimeType });
  const uri = registerWebImportSource(file, '');
  try {
    return await DocumentImportService.instance.importFile(uri, sample.filename, attempt);
  } finally {
    releaseWebImportSource(uri);
  }
};
