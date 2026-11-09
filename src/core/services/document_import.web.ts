import * as DocumentPicker from 'expo-document-picker';
import { ImportResult, ImportOperationError, createImportAttempt, snapshotImportAttempt, preflightImport, importFailure, type ImportAttempt } from './document_import_contract';
import { DocumentStorage } from './document_storage';
import type { DocumentStorageApi } from './document_storage_contract';
import { MAX_FILE_SIZE_BYTES, validateDocument } from './document_validation';
import { getWebImportSource, registerWebImportSource, releaseWebImportSource } from './web/import_sources';
export { ImportResult } from './document_import_contract';

export class DocumentImportService {
  static readonly instance = new DocumentImportService();
  static readonly MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_BYTES;
  private selected?: string;
  constructor(private readonly storage: DocumentStorageApi = DocumentStorage.instance,
    private readonly picker = DocumentPicker.getDocumentAsync) {}
  discardSelection(uri: string): void {
    if (this.selected !== uri) return;
    releaseWebImportSource(uri); this.selected = undefined;
  }
  async pickDocument(): Promise<DocumentPicker.DocumentPickerAsset | null> {
    // This call stays in the button's user gesture, before any database await.
    const result = await this.picker({ type: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      multiple: false, base64: false });
    if (result.canceled) return null;
    const picked = result.assets[0];
    if (!picked) return null;
    try {
      const file = picked.file;
      if (!file || !(file instanceof Blob)) throw Error('This file cannot be read in this browser. Choose the file again.');
      if (file.size > MAX_FILE_SIZE_BYTES) throw new ImportOperationError('reselect', 'File size exceeds the 50MB limit');
      if (!/\.(pdf|docx)$/i.test(picked.name)) throw Error('Choose a PDF or DOCX file.');
      try { await file.slice(0, 1).arrayBuffer(); }
      catch { throw Error('This file could not be read. Choose the file again.'); }
      const uri = registerWebImportSource(file, picked.uri);
      if (this.selected) this.discardSelection(this.selected);
      this.selected = uri;
      return { ...picked, uri, size: file.size };
    } catch (error) {
      if (picked.uri.startsWith('blob:')) URL.revokeObjectURL(picked.uri);
      throw error;
    }
  }
  async pickAndImportDocument(context: ImportAttempt = createImportAttempt()): Promise<ImportResult> {
    try {
      const attempt = snapshotImportAttempt(context);
      const picked = await this.pickDocument();
      return picked ? await this.importFile(picked.uri, picked.name, attempt) : new ImportResult(false, undefined, undefined, true);
    } catch (error) { return importFailure(error, 'Unable to select file'); }
  }
  async importFile(uri: string, originalName: string, context?: ImportAttempt): Promise<ImportResult> {
    try {
      const attempt = snapshotImportAttempt(context);
      const replay = await preflightImport(this.storage, attempt);
      if (replay) return replay;
      let file: Blob;
      try { file = getWebImportSource(uri); }
      catch { throw new ImportOperationError('reselect', 'The selected file is no longer available. Choose the file again.'); }
      if (file.size > MAX_FILE_SIZE_BYTES) throw new ImportOperationError('reselect', 'File size exceeds the 50MB limit');
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await file.arrayBuffer()); }
      catch { throw new ImportOperationError('reselect', 'This file is no longer readable. Choose the file again.'); }
      let format: ReturnType<typeof validateDocument>;
      try { format = validateDocument(originalName, bytes, file.size); }
      catch (error) { throw new ImportOperationError('reselect', error instanceof Error ? error.message : 'Choose another PDF or DOCX.'); }
      const document = await this.storage.saveDocument({ originalPath: uri,
        title: originalName.replace(/\.[^/.]+$/, '').trim() || 'Untitled syllabus', format, attempt });
      this.discardSelection(uri);
      return new ImportResult(true, document);
    } catch (error) { return importFailure(error, 'Unable to import document'); }
  }
}
