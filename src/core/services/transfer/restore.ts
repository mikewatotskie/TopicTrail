import type { OpenedTransfer, StudyTransferMetadata, StudyTransferNative } from '../study_transfer_native';
import { mergeMetadata, metadataKeys } from './merge';
import { receiptKey, verifySnapshot } from './study_archive_state';

export async function restoreStudyArchive(opened: OpenedTransfer, scope: string, checkActive: () => void,
  native: Pick<StudyTransferNative,'preflightFiles'|'promoteFiles'>, store: StudyTransferMetadata,
  guestPath: (name: string) => string) {
  checkActive();
  const data = verifySnapshot(opened.metadataJson, scope, opened.files);
  const keys = [...metadataKeys(data), receiptKey(scope, opened.metadataJson)];
  const paths = opened.files.map(f => f.path);
  const missing = data.originals.filter(f => f.bytes === null).map(f => f.path);
  await native.preflightFiles(opened.ticket, paths);
  checkActive();
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await store.read(keys);
    checkActive();
    if (before[before.length - 1] === '1') {
      // A replay must preserve edits and deletions made after the first successful import.
      return { counts: data.counts, missing, repeated: true };
    }
    const next = [...mergeMetadata(data,before,guestPath),'1'];
    // Only identical, immutable originals can be reused. No metadata becomes visible until the single CAS.
    await native.promoteFiles(opened.ticket,paths);
    checkActive();
    if (await store.compareAndSet(keys,before,next)) return {counts:data.counts,missing,repeated:false};
  }
  throw Error('The library kept changing during import. Please retry. Your existing items are preserved.');
}
