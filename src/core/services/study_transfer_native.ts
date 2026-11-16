import { NativeModules, Platform } from 'react-native';

export interface TransferFile { path: string; bytes: number; sha256: string }
export type ExpectedFiles = Record<string, { bytes?: number; sha256?: string }>;
export interface OpenedTransfer { ticket: string; metadataJson: string; files: TransferFile[] }
export interface StudyTransferMetadata {
  read(keys: string[]): Promise<(string | null)[]>;
  compareAndSet(keys: string[], previous: (string | null)[], next: string[]): Promise<boolean>;
}
export function studyTransferMetadata(): StudyTransferMetadata {
  const module = Platform.OS === 'android' && NativeModules.TopicTrailTransfer?.role === 'production'
    ? NativeModules.TopicTrailStudyMetadata : null;
  if (!module) throw Error('Study metadata is unavailable in this build.');
  return module as StudyTransferMetadata;
}
export interface StudyTransferNative {
  role: 'legacy' | 'production' | 'unavailable';
  exportArchive(passphrase: string, metadataJson: string, paths: string[], expected?: ExpectedFiles): Promise<void>;
  openArchive(passphrase: string): Promise<OpenedTransfer>;
  preflightFiles(ticket: string, paths: string[]): Promise<void>;
  promoteFiles(ticket: string, paths: string[]): Promise<void>;
  publishOriginal(stagedUri: string, relativeDestination: string, bytes: number, sha256: string, allowIdentical: boolean): Promise<void>;
  discard(ticket: string): Promise<void>;
}

const unavailable = async (): Promise<never> => { throw Error('Study transfer requires an updated Android APK.'); };
const unsupported: StudyTransferNative = {
  role: 'unavailable', exportArchive: unavailable, openArchive: unavailable,
  preflightFiles: unavailable, promoteFiles: unavailable, publishOriginal: unavailable, discard: unavailable,
};

export function studyTransferNative(): StudyTransferNative {
  const module = Platform.OS === 'android' ? NativeModules.TopicTrailTransfer : null;
  if (module?.role !== 'legacy' && module?.role !== 'production') return unsupported;
  return {
    role: module.role,
    exportArchive: (passphrase, metadata, paths, expected = {}) => module.exportArchive(passphrase, metadata, paths, expected),
    openArchive: passphrase => module.openArchive(passphrase),
    preflightFiles: (ticket, paths) => module.preflightFiles(ticket, paths),
    promoteFiles: (ticket, paths) => module.promoteFiles(ticket, paths),
    publishOriginal: (stagedUri, destination, bytes, sha256, allowIdentical) =>
      module.publishOriginal(stagedUri, destination, bytes, sha256, allowIdentical),
    discard: ticket => module.discard(ticket),
  };
}
