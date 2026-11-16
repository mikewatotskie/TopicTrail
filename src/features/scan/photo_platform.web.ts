import { Asset } from 'expo-asset';
import { browserPhotoBytes, normalizeBrowserPhoto, releaseBrowserPhoto, rotateBrowserPhoto } from './browser_photo';
import { createPhotoOcrLoader, recognizeBrowserPhoto } from './browser_photo_ocr';
import { pickBrowserPhotoFile } from './browser_photo_picker';
import type { ScanPhoto } from './photo_contract';

const loadSource = createPhotoOcrLoader(
  // Metro requires a static asset reference to package the local worker.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => Asset.fromModule(require('../../../assets/reader/ocr-worker.txt')).uri,
  () => window.location.href,
);

/** Call on opening Scan; successful loading permits recognition after going offline. */
export async function preloadPhotoOcr(): Promise<void> { await loadSource(); }

export async function choosePhoto(signal?: AbortSignal): Promise<ScanPhoto | null> {
  const file = await pickBrowserPhotoFile(signal);
  return file ? normalizeBrowserPhoto(file, signal) : null;
}
export const releasePhoto = releaseBrowserPhoto;
export const rotatePhoto = rotateBrowserPhoto;
export const photoBytes = browserPhotoBytes;
export function recognizePhoto(photo: ScanPhoto, signal: AbortSignal) { return recognizeBrowserPhoto(photo, signal, loadSource); }
