import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { createImportAttempt } from '../../core/services/document_import_contract';
import type { ScanPhoto } from './photo_contract';
import { nativeOcr, runNativeOcr, validateNativePhoto } from './native_ocr';

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const inputMessage = 'Choose a readable JPG or PNG of 50 MiB or less.';

export async function choosePhoto(signal?: AbortSignal): Promise<ScanPhoto | null> {
  if (signal?.aborted) return null;
  nativeOcr();
  const result = await DocumentPicker.getDocumentAsync({ type: ['image/jpeg', 'image/png'], copyToCacheDirectory: false, multiple: false });
  const picked = result.canceled ? null : result.assets[0];
  if (!picked || signal?.aborted) return null;
  if ((picked.size ?? 0) > MAX_INPUT_BYTES) throw new Error(inputMessage);
  if (!/^(?:content|file):\/\//.test(picked.uri)) throw new Error(inputMessage);
  const directory = new Directory(Paths.cache, 'topictrail-photo-input-v1');
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, createImportAttempt().attemptId + '.tmp');
  try {
    // Provider size is advisory. Bound the actual copy even when size is missing or false;
    // open the user's original read-only and close both handles on every failure.
    file.create();
    const source = new File(picked.uri).open(FileMode.ReadOnly);
    try {
      const target = file.open(FileMode.WriteOnly);
      try {
        let size = 0;
        while (true) {
          const chunk = await source.readBytes(Math.min(64 * 1024, MAX_INPUT_BYTES + 1 - size));
          if (!chunk.length) break;
          size += chunk.length;
          if (size > MAX_INPUT_BYTES) throw new Error(inputMessage);
          await target.writeBytes(chunk);
        }
        if (!size) throw new Error(inputMessage);
      } finally { target.close(); }
    } finally { source.close(); }
    return await normalized(file.uri, false);
  } catch { throw new Error(inputMessage); }
  finally { try { if (file.exists) file.delete(); } catch { /* Only our staging file. */ } }
}
async function normalized(uri: string, rotate: boolean): Promise<ScanPhoto> {
  const module = nativeOcr();
  const photo = await module.normalizePhoto(uri, rotate);
  try { return validateNativePhoto(photo); }
  catch (error) {
    if (photo && typeof photo.uri === 'string') { try { module.releasePhoto(photo.uri); } catch { /* Context teardown. */ } }
    throw error;
  }
}
export function releasePhoto(photo: ScanPhoto): void {
  try { nativeOcr().releasePhoto(photo.uri); } catch { /* A disposed/missing native module must not break screen cleanup. */ }
}
export function rotatePhoto(photo: ScanPhoto): Promise<ScanPhoto> {
  return normalized(validateNativePhoto(photo).uri, true);
}
export async function photoBytes(photo: ScanPhoto): Promise<Uint8Array> {
  const validated = validateNativePhoto(photo);
  const module = nativeOcr();
  const file = new File(validated.uri);
  const unavailable = 'The photo preview is unavailable. Choose it again.';
  let size: number;
  if (typeof module.previewByteLength === 'function') {
    // Android may expose one cache as /data/data or /data/user/0. The native owner
    // checks canonical parent, generated filename, regular file and bounded length.
    try { size = await module.previewByteLength(validated.uri); }
    catch { throw new Error(unavailable); }
  } else {
    // Older native binaries can still save when their original exact-root check succeeds.
    const directory = new Directory(Paths.cache, 'topictrail-scan-previews-v1');
    if (file.parentDirectory.uri !== directory.uri) throw new Error(unavailable);
    size = file.size;
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PREVIEW_BYTES) throw new Error(unavailable);
  const handle = file.open(FileMode.ReadOnly);
  try {
    const bytes = await handle.readBytes(size + 1);
    if (bytes.length !== size || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error('The photo preview is unreadable. Choose it again.');
    }
    return bytes;
  } finally { handle.close(); }
}
export function recognizePhoto(photo: ScanPhoto, signal: AbortSignal) {
  return runNativeOcr(signal, (module, id) => module.recognizePhoto(validateNativePhoto(photo).uri, id));
}
