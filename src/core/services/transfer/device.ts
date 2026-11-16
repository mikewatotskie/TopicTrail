import { File, Paths } from 'expo-file-system';
import type { AuthGateway } from '../../auth/types';
import { DocumentStorage, getCloudLibrary } from '../document_storage';
import { createAnnotationPort } from '../annotation_port';
import { guestBookmarkPort, bookmarkStore } from '../bookmarks/storage';
import { decodeDocumentLibrary } from '../document_library_codec';
import { isOwnedLegacyPath } from '../legacy_document_content';
import { progressKey } from '../reading_progress';
import { progressIO } from '../reading_progress_storage';
import { accountFilePort } from '../cloud/cache';
import { productionMetadata } from '../study_metadata';
import { studyTransferMetadata, studyTransferNative, type ExpectedFiles } from '../study_transfer_native';
import { archivePath, codecFor, countsFor, emptyBookmarks, emptyNotes, guestWithPaths, identityOf,
  progressKeyFor, scopeDocs, verifySnapshot, type StudySnapshot } from './study_archive_state';
import { restoreStudyArchive } from './restore';

const guestPath = (name: string) => new File(Paths.document,'documents',name).uri;
function scopeOf(gateway: AuthGateway) {
  const state = gateway.getSnapshot();
  if (state.status === 'guest') return 'guest';
  if (state.status === 'account' && state.account.emailVerified && state.account.projectNamespace) {
    const scope = state.account.projectNamespace + '/' + state.account.uid;
    identityOf(scope);
    return scope;
  }
  throw Error('Wait for your account to finish loading, then retry.');
}
function fence(gateway: AuthGateway, restore = false) {
  const scope = scopeOf(gateway);
  const epoch = gateway.getSessionEpoch?.();
  const check = () => {
    if (scopeOf(gateway) !== scope || gateway.getSessionEpoch?.() !== epoch) throw Error('The account changed. Reopen transfer in the intended library.');
    if (restore && scope !== 'guest' && !gateway.hasFreshTransferSignIn?.())
      throw Error('For an account restore, log out and sign in again, then import within ten minutes.');
  };
  check();
  return { scope, check };
}
async function metadata(scope: string) {
  const annotation = await createAnnotationPort(scope).read();
  const notes = annotation.json ?? emptyNotes(scope);
  const progress: Record<string,string> = {};
  const unsafe = new Set<string>();
  if (scope !== 'guest') {
    const codec = codecFor(scope);
    const raw = await accountFilePort(identityOf(scope)).readState();
    const library = codec.encode(codec.decode(raw));
    return {notes,library,progress,bookmarks:null,unsafe};
  }
  const db = productionMetadata();
  const main = new File(Paths.document,'documents.json');
  const backup = new File(Paths.document,'documents.backup.json');
  const source = db ? (await db.read(['guest/documents']))[0] : main.exists ? await main.text() : backup.exists ? await backup.text() : null;
  const parsed = decodeDocumentLibrary(source);
  if (!db && !main.exists && backup.exists) { parsed.guestUsageRecoveryRequired = true; parsed.importReplayRecoveryRequired = true; }
  const library = guestWithPaths(parsed, doc => {
    const name = doc.filePath.split('/').at(-1) ?? '';
    try {
      if (isOwnedLegacyPath(doc.filePath) && name.endsWith('.'+doc.format)) {
        archivePath(scope,name);
        return name;
      }
    } catch { /* Preserve the metadata and list this original for relinking. */ }
    const placeholder = doc.id + '.' + doc.format;
    archivePath(scope,placeholder);
    unsafe.add(placeholder);
    return placeholder;
  });
  for (const doc of parsed.documents) {
    const value = await progressIO.getItem(progressKey(doc));
    if (value !== null) progress[progressKeyFor(doc)] = value;
  }
  const bookmarkData = db ? (await db.read(['guest/bookmarks']))[0] : await guestBookmarkPort.readMetadata();
  const bookmarks = bookmarkData ?? emptyBookmarks();
  return {notes,library,progress,bookmarks,unsafe};
}

export async function exportStudyData(gateway: AuthGateway, passphrase: string) {
  const {scope,check} = fence(gateway);
  const state = await metadata(scope);
  const originals: StudySnapshot['originals'] = [];
  const expected: ExpectedFiles = {};
  const docs = scopeDocs(scope,state.library);
  const actualFiles = [];
  for (const doc of docs) {
    check();
    const path = archivePath(scope,doc.filePath);
    const file = new File(Paths.document,...path.split('/'));
    if (state.unsafe.has(doc.filePath) || !file.exists) {
      originals.push({path,bytes:null,sha256:null});
    } else {
      const sha256 = await file.digest('SHA-256');
      const bytes = file.size;
      if (bytes === null || !sha256) throw Error('An original could not be read. Keep the old app and retry.');
      originals.push({path,bytes,sha256});
      actualFiles.push({path,bytes,sha256});
      expected[path] = {bytes,sha256};
    }
  }
  const after = await metadata(scope);
  if (state.library !== after.library || state.notes !== after.notes || state.bookmarks !== after.bookmarks ||
      JSON.stringify(state.progress) !== JSON.stringify(after.progress)) throw Error('Study data changed while exporting. Please retry.');
  check();
  const base = {version:1 as const,scope,notes:state.notes,library:state.library,progress:state.progress,bookmarks:state.bookmarks,originals};
  const data = {...base,counts:countsFor(base)};
  const json = JSON.stringify(data);
  verifySnapshot(json,scope,actualFiles);
  await studyTransferNative().exportArchive(passphrase,json,actualFiles.map(f=>f.path),expected);
  return {counts:data.counts,missing:originals.filter(f=>f.bytes===null).map(f=>f.path)};
}

export async function importStudyData(gateway: AuthGateway, passphrase: string) {
  const {scope,check} = fence(gateway,true);
  const native = studyTransferNative();
  const opened = await native.openArchive(passphrase);
  try {
    const restore = () => restoreStudyArchive(opened, scope, check, native, studyTransferMetadata(), guestPath);
    const result = scope === 'guest' ? await DocumentStorage.legacy.runStudyTransfer(restore) : await restore();
    if (scope === 'guest') await bookmarkStore.reload();
    getCloudLibrary().refreshAfterTransfer();
    return result;
  } finally { await native.discard(opened.ticket); }
}
