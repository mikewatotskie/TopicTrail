import { Directory, File, Paths } from 'expo-file-system';
import { DocumentImportService } from '../../core/services/document_import';
import type { DemoSampleImportPort } from './ensureDemoSample';

export const importDemoSample: DemoSampleImportPort['importSample'] = async (sample, attempt) => {
  const directory = new Directory(Paths.cache, 'topictrail-presentation');
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, 'sample-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + sample.kind);
  try {
    await file.write(sample.createBytes());
    return await DocumentImportService.instance.importFile(file.uri, sample.filename, attempt);
  } finally {
    try {
      if (file.exists) file.delete();
    } catch { /* Cleanup is limited to this temporary synthetic file. */ }
  }
};
