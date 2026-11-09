import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';
import { ImportResult, ImportOperationError, createImportAttempt, snapshotImportAttempt, preflightImport, importFailure, type ImportAttempt } from './document_import_contract';
import { DocumentStorage } from './document_storage';
import type { DocumentStorageApi } from './document_storage_contract';
import { MAX_FILE_SIZE_BYTES, validateDocument } from './document_validation';

export { ImportResult } from './document_import_contract';

export class DocumentImportService {
  static readonly instance = new DocumentImportService();
  static readonly MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_BYTES;
  private stagedSelection?: File;
  constructor(private readonly storage: DocumentStorageApi = DocumentStorage.instance) {}

  discardSelection(uri: string): void {
    if (this.stagedSelection?.uri !== uri) return;
    this.removeStagedFile(this.stagedSelection);
    this.stagedSelection = undefined;
  }

  private removeStagedFile(file?: File): void {
    // Only callers' app-created staging files reach this helper, never originals.
    try { if (file?.exists) file.delete(); }
    catch { /* A cache cleanup failure must not invalidate a prepared or saved document. */ }
  }

  async pickDocument(): Promise<DocumentPicker.DocumentPickerAsset | null> {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      // Android's picker cache can differ from Expo Go's scoped FileSystem cache.
      // Copy the granted provider URI into our own cache before publishing it.
      copyToCacheDirectory: Platform.OS !== 'android', multiple: false,
    });
    const picked = result.canceled ? null : result.assets[0] ?? null;
    if (!picked || Platform.OS !== 'android') return picked;
    if ((picked.size ?? 0) > MAX_FILE_SIZE_BYTES) throw new ImportOperationError('reselect', 'File size exceeds the 50MB limit');

    const directory = new Directory(Paths.cache, 'topictrail-imports');
    directory.create({ idempotent: true, intermediates: true });
    const staged = new File(directory, `selection-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    try {
      try { await new File(picked.uri).copy(staged); }
      catch { throw new Error('This file could not be copied. Choose the file again from this device.'); }
      if ((staged.size ?? 0) > MAX_FILE_SIZE_BYTES) throw new ImportOperationError('reselect', 'File size exceeds the 50MB limit');
      try {
        const handle = staged.open(FileMode.ReadOnly);
        try { await handle.readBytes(1); }
        finally { handle.close(); }
      } catch { throw new Error('This file could not be read. Choose the file again from this device.'); }
    } catch (error) {
      this.removeStagedFile(staged);
      throw error;
    }
    const previous = this.stagedSelection;
    this.stagedSelection = staged;
    this.removeStagedFile(previous);
    return { ...picked, uri: staged.uri, size: staged.size ?? picked.size };
  }
  async pickAndImportDocument(context: ImportAttempt = createImportAttempt()): Promise<ImportResult> {
    try {
      const attempt = snapshotImportAttempt(context);
      const picked = await this.pickDocument();
      return picked ? this.importFile(picked.uri, picked.name, attempt) : new ImportResult(false, undefined, undefined, true);
    } catch (error) { return importFailure(error, 'Unable to select file'); }
  }
  async importFile(uri: string, originalName: string, context?: ImportAttempt): Promise<ImportResult> {
    try {
      const attempt = snapshotImportAttempt(context);
      const replay = await preflightImport(this.storage, attempt);
      if (replay) return replay;
      const file = new File(uri);
      if ((file.size ?? 0) > MAX_FILE_SIZE_BYTES) throw new ImportOperationError('reselect', 'File size exceeds the 50MB limit');
      const bytes = await file.bytes().catch(() => {
        throw new ImportOperationError('reselect', 'This file is no longer readable. Choose the file again from this device.');
      });
      let format: ReturnType<typeof validateDocument>;
      try { format = validateDocument(originalName, bytes, file.size ?? bytes.length); }
      catch (error) { throw new ImportOperationError('reselect', error instanceof Error ? error.message : 'Choose another PDF or DOCX.'); }
      const document = await this.storage.saveDocument({ originalPath: uri,
        title: originalName.replace(/\.[^/.]+$/, '').trim() || 'Untitled syllabus', format, attempt });
      if (this.stagedSelection?.uri === uri) {
        this.removeStagedFile(this.stagedSelection);
        this.stagedSelection = undefined;
      }
      return new ImportResult(true, document);
    } catch (error) { return importFailure(error, 'Unable to import document'); }
  }
}
