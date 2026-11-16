import type { ScanPhoto } from './photo_contract';
import { abortablePhoto, checkPhotoSignal } from './photo_abort';
import { boundedPhotoSize, inspectPhotoImage, MAX_PHOTO_INPUT_BYTES, photoOrientationTransform, strippedPhotoJpeg } from './photo_image';

const photos = new Map<string, { photo: ScanPhoto; blob: Blob }>();

function ownedPhoto(photo: ScanPhoto) {
  const entry = photos.get(photo.uri);
  if (!entry || entry.photo.width !== photo.width || entry.photo.height !== photo.height) throw new Error('This photo preview has expired. Choose or take the photo again.');
  return entry;
}

export function releaseBrowserPhoto(photo: ScanPhoto) {
  if (!photos.delete(photo.uri)) return;
  URL.revokeObjectURL(photo.uri);
}

export async function browserPhotoBytes(photo: ScanPhoto): Promise<Uint8Array> {
  const entry = ownedPhoto(photo);
  const bytes = new Uint8Array(await entry.blob.arrayBuffer());
  if (photos.get(photo.uri) !== entry) throw new Error('This photo preview has expired.');
  return bytes;
}

export async function encodePhotoCanvas(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<ScanPhoto> {
  checkPhotoSignal(signal);
  const encoded = await abortablePhoto(new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('The photo could not be prepared. Try another photo.')), 'image/jpeg', 0.92);
  }), signal);
  checkPhotoSignal(signal);
  const bytes = strippedPhotoJpeg(new Uint8Array(await abortablePhoto(encoded.arrayBuffer(), signal)), canvas.width, canvas.height);
  checkPhotoSignal(signal);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const photo = Object.freeze({ uri: URL.createObjectURL(blob), width: canvas.width, height: canvas.height });
  photos.set(photo.uri, { photo, blob });
  return photo;
}

/** Decoder sees sanitized bytes and bounded dimensions; the original File is never mutated. */
export async function normalizedPhotoCanvas(blob: Blob, signal?: AbortSignal, quarterTurn = false): Promise<HTMLCanvasElement> {
  checkPhotoSignal(signal);
  if (!blob.size || blob.size > MAX_PHOTO_INPUT_BYTES) throw new Error('Choose a JPG or PNG of 50 MiB or less.');
  const source = inspectPhotoImage(new Uint8Array(await abortablePhoto(blob.arrayBuffer(), signal)));
  checkPhotoSignal(signal);
  if (typeof createImageBitmap !== 'function') throw new Error('Photo decoding is unavailable in this browser. Try a current browser.');
  const size = boundedPhotoSize(source.width, source.height);
  const bitmap = await abortablePhoto(createImageBitmap(new Blob([source.bytes], { type: source.mime }), {
    imageOrientation: 'none', resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high',
  }), signal, late => late.close());
  let canvas: HTMLCanvasElement | undefined;
  try {
    checkPhotoSignal(signal);
    if (bitmap.width !== size.width || bitmap.height !== size.height) throw new Error('This browser could not safely resize the photo.');
    // Rotation is only requested for our normalized, orientation-free preview.
    const orientation = quarterTurn ? 6 : source.orientation;
    const swap = orientation >= 5;
    canvas = document.createElement('canvas');
    canvas.width = swap ? size.height : size.width; canvas.height = swap ? size.width : size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo preparation is unavailable in this browser.');
    context.fillStyle = '#ffffff'; // Flatten transparent PNGs onto paper, independent of UI theme.
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.setTransform(...photoOrientationTransform(orientation, size.width, size.height));
    context.drawImage(bitmap, 0, 0);
    context.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  } catch (error) {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    throw error;
  } finally { bitmap.close(); }
}

export async function normalizeBrowserPhoto(blob: Blob, signal?: AbortSignal, quarterTurn = false): Promise<ScanPhoto> {
  const canvas = await normalizedPhotoCanvas(blob, signal, quarterTurn);
  try { return await encodePhotoCanvas(canvas, signal); }
  finally { canvas.width = 0; canvas.height = 0; }
}

export async function rotateBrowserPhoto(photo: ScanPhoto): Promise<ScanPhoto> {
  const entry = ownedPhoto(photo);
  const result = await normalizeBrowserPhoto(entry.blob, undefined, true);
  if (photos.get(photo.uri) !== entry) { releaseBrowserPhoto(result); throw new Error('This photo preview has expired.'); }
  return result;
}

export async function browserPhotoCanvas(photo: ScanPhoto, signal?: AbortSignal) {
  const entry = ownedPhoto(photo);
  const canvas = await normalizedPhotoCanvas(entry.blob, signal);
  if (photos.get(photo.uri) !== entry) {
    canvas.width = 0; canvas.height = 0;
    throw new Error('This photo preview has expired.');
  }
  return canvas;
}

/** Copy one frame synchronously, then stop the stream before JPEG encoding starts. */
export async function captureBrowserPhoto(video: HTMLVideoElement, signal: AbortSignal, copied: () => void): Promise<ScanPhoto> {
  checkPhotoSignal(signal);
  const size = boundedPhotoSize(video.videoWidth, video.videoHeight);
  if (video.readyState < 2) throw new Error('The camera is not ready. Wait for the preview, then try again.');
  const canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Camera capture is unavailable in this browser.');
    context.drawImage(video, 0, 0, size.width, size.height);
    copied();
    return await encodePhotoCanvas(canvas, signal);
  } finally { canvas.width = 0; canvas.height = 0; }
}
