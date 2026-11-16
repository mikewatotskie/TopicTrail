export type PptxImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export const MAX_PPTX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_SIDE = 16384;

type Dimensions = [width: number, height: number];
const invalidImage = () => new Error('An embedded PowerPoint image has an invalid raster header.');

export function pptxRasterMime(path: string): PptxImageMime | undefined {
  switch (path.split('.').pop()?.toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
  }
}

function checkDimensions([width, height]: Dimensions): number {
  if (!width || !height) throw invalidImage();
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('An embedded PowerPoint image exceeds the study view dimension limit.');
  }
  return width * height;
}

function matches(bytes: Uint8Array, start: number, label: string): boolean {
  for (let index = 0; index < label.length; index++) {
    if (bytes[start + index] !== label.charCodeAt(index)) return false;
  }
  return true;
}

function checkPng(bytes: Uint8Array, view: DataView): number | undefined {
  const header = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || !header.every((byte, i) => bytes[i] === byte) ||
      view.getUint32(8) !== 13 || !matches(bytes, 12, 'IHDR')) throw invalidImage();
  const pixels = checkDimensions([view.getUint32(16), view.getUint32(20)]);
  let hasData = false;
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const next = offset + 12 + length;
    if (next > bytes.length) throw invalidImage();
    if (matches(bytes, offset + 4, 'acTL')) return;
    if (matches(bytes, offset + 4, 'IDAT')) hasData = true;
    if (matches(bytes, offset + 4, 'IEND') && length === 0 && next === bytes.length && hasData) return pixels;
    offset = next;
  }
  throw invalidImage();
}

function checkJpeg(bytes: Uint8Array, view: DataView): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalidImage();
  let pixels = 0;
  for (let offset = 2; offset < bytes.length;) {
    if (bytes[offset++] !== 0xff) throw invalidImage();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length) throw invalidImage();
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) throw invalidImage();
    if (marker === 0xda) {
      // JPEG scan data is decoded by the image renderer.
      if (pixels && length >= 8 && offset + length < bytes.length - 2 &&
          bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return pixels;
      throw invalidImage();
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (pixels || length < 8) throw invalidImage();
      pixels = checkDimensions([view.getUint16(offset + 5), view.getUint16(offset + 3)]);
    }
    offset += length;
  }
  throw invalidImage();
}

function checkGif(bytes: Uint8Array, view: DataView): number | undefined {
  if (bytes.length < 14 || (!matches(bytes, 0, 'GIF87a') && !matches(bytes, 0, 'GIF89a'))) throw invalidImage();
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const pixels = checkDimensions([width, height]);
  const colorTableBytes = (flags: number) => flags & 0x80 ? 3 * (2 ** ((flags & 7) + 1)) : 0;
  let offset = 13 + colorTableBytes(bytes[10]);
  let foundFrame = false;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b && foundFrame && offset === bytes.length) return pixels;
    if (block === 0x21 && offset < bytes.length) {
      offset++; // Extension label, followed by data sub-blocks.
    } else if (block === 0x2c && offset + 9 <= bytes.length) {
      if (foundFrame) return;
      const left = view.getUint16(offset, true);
      const top = view.getUint16(offset + 2, true);
      const frameWidth = view.getUint16(offset + 4, true);
      const frameHeight = view.getUint16(offset + 6, true);
      if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) throw invalidImage();
      offset += 10 + colorTableBytes(bytes[offset + 8]); // Image descriptor and LZW code-size byte.
      foundFrame = true;
    } else {
      throw invalidImage();
    }
    while (offset < bytes.length && bytes[offset]) offset += bytes[offset] + 1;
    if (offset >= bytes.length) throw invalidImage();
    offset++;
  }
  throw invalidImage();
}

function checkWebp(bytes: Uint8Array, view: DataView): number | undefined {
  if (bytes.length < 20 || !matches(bytes, 0, 'RIFF') || !matches(bytes, 8, 'WEBP') ||
      view.getUint32(4, true) + 8 !== bytes.length) throw invalidImage();
  const u24 = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  let canvas: Dimensions | undefined;
  let frame: Dimensions | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const next = start + size + (size & 1);
    if (next > bytes.length) throw invalidImage();
    if (matches(bytes, offset, 'VP8X')) {
      if (offset !== 12 || size !== 10) throw invalidImage();
      canvas = [1 + u24(start + 4), 1 + u24(start + 7)];
      checkDimensions(canvas);
      if (bytes[start] & 2) return;
    } else if (matches(bytes, offset, 'ANIM') || matches(bytes, offset, 'ANMF')) {
      return;
    } else if (matches(bytes, offset, 'VP8L')) {
      if (frame || size < 5 || bytes[start] !== 0x2f) throw invalidImage();
      const dimensions = view.getUint32(start + 1, true);
      frame = [1 + (dimensions & 0x3fff), 1 + ((dimensions >>> 14) & 0x3fff)];
    } else if (matches(bytes, offset, 'VP8 ')) {
      if (frame || size < 10 || bytes[start] & 1 || u24(start + 3) !== 0x2a019d) throw invalidImage();
      frame = [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
    }
    offset = next;
  }
  if (offset !== bytes.length || !frame || (canvas && (frame[0] !== canvas[0] || frame[1] !== canvas[1]))) {
    throw invalidImage();
  }
  return checkDimensions(frame);
}

/** Check static raster headers before passing bytes to a browser or WebView image decoder. */
export function studyRasterPixels(bytes: Uint8Array, mime: PptxImageMime): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (mime) {
    case 'image/png': return checkPng(bytes, view);
    case 'image/jpeg': return checkJpeg(bytes, view);
    case 'image/gif': return checkGif(bytes, view);
    case 'image/webp': return checkWebp(bytes, view);
  }
}
