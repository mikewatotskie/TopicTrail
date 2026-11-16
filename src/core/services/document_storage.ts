import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { resolveGuestUploadPolicy, type GuestUploadPolicy } from '../config/guest_upload_policy';
import { DocumentRepository, DocumentStoragePort } from './document_repository';
import type { DocumentStorageApi } from './document_storage_contract';
import { CloudLibraryRuntime } from './cloud/runtime';
import { isOwnedLegacyPath, readDocumentBytes as readLegacyBytes } from './legacy_document_content';
import { createCloudCache } from './cloud/cache';
import { cloudFetch } from './cloud/transport_fetch';
import { metadataPort, productionMetadata } from './study_metadata';
import { studyTransferNative } from './study_transfer_native';

const metadataFile = () => new File(Paths.document, 'documents.json');
const backupFile = () => new File(Paths.document, 'documents.backup.json');
const privateLibrary = metadataPort('guest/documents');
const port: DocumentStoragePort = {
  async readMetadata() {
    if (productionMetadata()) return privateLibrary.readMetadata();
    const file = metadataFile();
    if (file.exists) return file.text();
    const backup = backupFile();
    return backup.exists ? backup.text() : null;
  },
  async readMetadataWithOrigin() {
    if (productionMetadata()) {
      const json = await privateLibrary.readMetadata();
      return { json, origin: json === null ? 'empty' : 'main' };
    }
    const file = metadataFile();
    if (file.exists) return { json: await file.text(), origin: 'main' };
    const backup = backupFile();
    return backup.exists ? { json: await backup.text(), origin: 'backup' } : { json: null, origin: 'empty' };
  },
  async writeMetadata(json) {
    if (productionMetadata()) return privateLibrary.writeMetadata(json);
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
    if (!isOwnedLegacyPath(destination.uri) || destination.exists) throw new Error('A new owned file is required.');
    const transfer = studyTransferNative();
    if (transfer.role === 'production') {
      const staging = new File(directory, 'incoming-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
      staging.create();
      try {
        await new File(source).copy(staging, { overwrite: true });
        const size = staging.size;
        const hash = await staging.digest('SHA-256');
        if (!size || !hash) throw new Error('The selected original could not be verified.');
        await transfer.publishOriginal(staging.uri, 'documents/' + destination.name, size, hash, false);
        return { filePath: destination.uri, size };
      } finally {
        if (staging.exists) staging.delete();
      }
    }
    try { await new File(source).copy(destination); }
    catch (error) { if (destination.exists) destination.delete(); throw error; }
    return { filePath: destination.uri, size: destination.size ?? 0 };
  },
  async removeFile(path) {
    if (!isOwnedLegacyPath(path)) throw new Error('File is outside the owned document directory');
    const file = new File(path); if (file.exists) file.delete();
  },
  ownsFile: isOwnedLegacyPath,
  async fileExists(path) { return isOwnedLegacyPath(path) && new File(path).exists; },
};

export class DocumentStorage extends DocumentRepository {
  private static current?: DocumentStorage;
  constructor(storagePort: DocumentStoragePort = port, policy: GuestUploadPolicy = resolveGuestUploadPolicy(Platform.OS)) {
    super(storagePort, policy);
  }
  static get legacy(): DocumentStorage { return this.current ??= new DocumentStorage(); }
  static get instance(): DocumentStorageApi { return getCloudLibrary().documents; }
}
let cloud: CloudLibraryRuntime | undefined;
export function getCloudLibrary(): CloudLibraryRuntime { return cloud ??= new CloudLibraryRuntime(DocumentStorage.legacy, readLegacyBytes, {cache:createCloudCache,fetcher:cloudFetch}); }
