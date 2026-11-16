/** Validate encoded bytes before handing them to a browser image decoder. */
export const MAX_PHOTO_INPUT_BYTES = 50 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 16 * 1024 * 1024;
export const MAX_PHOTO_PIXELS = 4_000_000;
export const MAX_PHOTO_EDGE = 8192;
// Browsers do not promise bounded intermediate allocations when decoding/resizing.
// Reject decompression-sized inputs even when their compressed files are small.
const MAX_INPUT_PIXELS = 64_000_000;
const MAX_INPUT_EDGE = 16384;
export interface PhotoImage {
  mime: 'image/jpeg' | 'image/png'; width: number; height: number; orientation: number;
  /** Encoded copy without orientation metadata, so decoding cannot rotate twice. */
  bytes: Uint8Array<ArrayBuffer>;
}

const invalid = () => new Error('Choose a complete, readable JPG or PNG photo.');
const join = (parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};

export function validatePhotoDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE || width * height > MAX_INPUT_PIXELS) {
    throw new Error('Choose a photo up to 64 million pixels and 16,384 pixels per edge.');
  }
}

export function boundedPhotoSize(width: number, height: number) {
  validatePhotoDimensions(width, height);
  const scale = Math.min(1, Math.sqrt(MAX_PHOTO_PIXELS / (width * height)), MAX_PHOTO_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** TIFF IFD0 only: never follow untrusted thumbnail/GPS/sub-IFD pointers. */
function exifOrientation(bytes: Uint8Array): number | undefined {
  if (bytes.length < 8) throw invalid();
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) throw invalid();
  const first = view.getUint32(4, little);
  if (first < 8 || first > bytes.length - 2) throw invalid();
  const count = view.getUint16(first, little);
  if (count > 4096 || first + 2 + count * 12 + 4 > bytes.length) throw invalid();
  let orientation: number | undefined;
  for (let entry = first + 2; entry < first + 2 + count * 12; entry += 12) {
    if (view.getUint16(entry, little) !== 0x112) continue;
    if (orientation !== undefined || view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) throw invalid();
    orientation = view.getUint16(entry + 8, little);
    if (orientation < 1 || orientation > 8) throw invalid();
  }
  return orientation;
}

function jpeg(bytes: Uint8Array, stripAllMetadata: boolean): PhotoImage {
  if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw invalid();
  const parts = [bytes.subarray(0, 2)];
  let position = 2, width = 0, height = 0, orientation: number | undefined, hasScan = false;
  while (position < bytes.length) {
    const start = position;
    if (bytes[position++] !== 0xff) throw invalid();
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === 0xd9) {
      if (!hasScan || position !== bytes.length) throw invalid();
      parts.push(bytes.subarray(start));
      return { mime: 'image/jpeg', width, height, orientation: orientation ?? 1, bytes: join(parts) };
    }
    if (position + 2 > bytes.length || marker === 0 || marker === 0xd8 || marker === 0xd9) throw invalid();
    const length = bytes[position] * 256 + bytes[position + 1];
    const end = position + length;
    if (length < 2 || end > bytes.length) throw invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (![0xc0, 0xc1, 0xc2].includes(marker) || width || length < 11 || bytes[position + 2] !== 8) throw invalid();
      const components = bytes[position + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + components * 3) throw invalid();
      height = bytes[position + 3] * 256 + bytes[position + 4];
      width = bytes[position + 5] * 256 + bytes[position + 6];
      validatePhotoDimensions(width, height);
    }
    if (marker === 0xe1 && length >= 8 && String.fromCharCode(...bytes.subarray(position + 2, position + 8)) === 'Exif\0\0') {
      const value = exifOrientation(bytes.subarray(position + 8, end));
      if (orientation !== undefined && value !== undefined) throw invalid();
      orientation = value ?? orientation;
    }
    if (marker === 0xda) {
      if (!width || !height || length < 6 || end >= bytes.length - 2) throw invalid();
      hasScan = true;
      // Walk entropy bytes until the next real marker (stuffed FF and restart markers are data).
      position = end;
      while (position < bytes.length) {
        if (bytes[position] !== 0xff) { position++; continue; }
        let next = position + 1;
        while (bytes[next] === 0xff) next++;
        if (bytes[next] === 0 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) { position = next + 1; continue; }
        break;
      }
      parts.push(bytes.subarray(start, position));
      continue;
    }
    // Retain ICC/Adobe color-transform data in decoder input, but never in normalized output.
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!metadata || (!stripAllMetadata && [0xe2, 0xee].includes(marker))) parts.push(bytes.subarray(start, end));
    position = end;
  }
  throw invalid();
}

function png(bytes: Uint8Array): PhotoImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  let position = 8, width = 0, height = 0, orientation: number | undefined, hasImage = false;
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position);
    const end = position + 12 + length;
    if (end > bytes.length) throw invalid();
    const kind = String.fromCharCode(...bytes.subarray(position + 4, position + 8));
    if (position === 8 && (kind !== 'IHDR' || length !== 13)) throw invalid();
    if (kind === 'IHDR') {
      if (position !== 8) throw invalid();
      width = view.getUint32(position + 8); height = view.getUint32(position + 12);
      validatePhotoDimensions(width, height);
      const depth = bytes[position + 16], color = bytes[position + 17];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[position + 18] !== 0 || bytes[position + 19] !== 0 || bytes[position + 20] > 1) throw invalid();
    }
    if (['acTL', 'fcTL', 'fdAT'].includes(kind)) throw new Error('Choose a still JPG or PNG, rather than an animated image.');
    if (kind === 'eXIf') {
      const value = exifOrientation(bytes.subarray(position + 8, end - 4));
      if (orientation !== undefined && value !== undefined) throw invalid();
      orientation = value ?? orientation;
    } else if (!['tEXt', 'zTXt', 'iTXt', 'tIME'].includes(kind)) parts.push(bytes.subarray(position, end));
    if (kind === 'IDAT' && length) hasImage = true;
    if (kind === 'IEND') {
      if (length || end !== bytes.length || !hasImage || !width) throw invalid();
      return { mime: 'image/png', width, height, orientation: orientation ?? 1, bytes: join(parts) };
    }
    position = end;
  }
  throw invalid();
}

export function inspectPhotoImage(bytes: Uint8Array): PhotoImage {
  if (!bytes.length || bytes.length > MAX_PHOTO_INPUT_BYTES) throw new Error('Choose a JPG or PNG of 50 MiB or less.');
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes, false);
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return png(bytes);
  throw invalid();
}

export function strippedPhotoJpeg(bytes: Uint8Array, width: number, height: number) {
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalid();
  const result = jpeg(bytes, true);
  if (result.width !== width || result.height !== height || width > MAX_PHOTO_EDGE || height > MAX_PHOTO_EDGE || width * height > MAX_PHOTO_PIXELS) throw invalid();
  return result.bytes;
}

/** All eight EXIF transforms, including mirrored portrait photographs. */
export function photoOrientationTransform(orientation: number, width: number, height: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, width, 0];
    case 3: return [-1, 0, 0, -1, width, height];
    case 4: return [1, 0, 0, -1, 0, height];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, height, 0];
    case 7: return [0, -1, -1, 0, height, width];
    case 8: return [0, -1, 1, 0, 0, width];
    default: return [1, 0, 0, 1, 0, 0];
  }
}
