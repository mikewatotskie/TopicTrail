import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { resolveGuestUploadPolicy, type GuestUploadPolicy } from '../config/guest_upload_policy';
import { DocumentRepository, DocumentStoragePort } from './document_repository';
import { isOwnedDocumentUri } from './file_ownership';

const metadataFile = () => new File(Paths.document, 'documents.json');
const backupFile = () => new File(Paths.document, 'documents.backup.json');
const port: DocumentStoragePort = {
  async readMetadata() {
    const file = metadataFile();
    if (file.exists) return file.text();
    const backup = backupFile();
    return backup.exists ? backup.text() : null;
  },
  async readMetadataWithOrigin() {
    const file = metadataFile();
    if (file.exists) return { json: await file.text(), origin: 'main' };
    const backup = backupFile();
    return backup.exists ? { json: await backup.text(), origin: 'backup' } : { json: null, origin: 'empty' };
  },
  async writeMetadata(json) {
    const staging = new File(Paths.document, 'documents.pending.json');
    await staging.write(json);
    const file = metadataFile();
    const backup = backupFile();
    if (file.exists) await file.copy(backup, { overwrite: true });
    await staging.move(file, { overwrite: true });
  },
  async copyToDocuments(source, id, format) {
    const directory = new Directory(Paths.document, 'documents');
    directory.create({ idempotent: true, intermediates: true });
    const destination = new File(directory, id + '.' + format);
    try { await new File(source).copy(destination); }
    catch (error) { if (destination.exists) destination.delete(); throw error; }
    return { filePath: destination.uri, size: destination.size ?? 0 };
  },
  async removeFile(path) {
    if (!isOwnedDocumentUri(path, new Directory(Paths.document, 'documents').uri)) throw new Error('File is outside the owned document directory');
    const file = new File(path); if (file.exists) file.delete();
  },
  async fileExists(path) { return new File(path).exists; },
};

export class DocumentStorage extends DocumentRepository {
  private static current?: DocumentStorage;
  constructor(storagePort: DocumentStoragePort = port, policy: GuestUploadPolicy = resolveGuestUploadPolicy(Platform.OS)) {
    super(storagePort, policy);
  }
  static get instance(): DocumentStorage { return this.current ??= new DocumentStorage(); }
}
