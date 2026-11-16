import { strToU8 } from 'fflate';

/** Both encoders produce 8-bit, three-component JPEGs. Strip optional metadata again at export. */
function pdfImage(bytes: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 8192 || height > 8192 || width * height > 4_000_000 || bytes.length > 16 * 1024 * 1024 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error('The scan could not be prepared for saving. Choose or take the photo again.');
  }
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let frame = false;
  let scan = false;
  let cursor = 2;
  while (cursor < bytes.length) {
    const start = cursor;
    if (bytes[cursor++] !== 0xff) break;
    while (bytes[cursor] === 0xff) cursor++;
    const marker = bytes[cursor++];
    if (marker === 0xd9) {
      if (!frame || !scan || cursor !== bytes.length) break;
      parts.push(bytes.subarray(start, cursor));
      return join(parts);
    }
    // Standalone markers only belong inside entropy-coded scan data.
    if (marker === undefined || marker === 0x00 || marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd8) || cursor + 2 > bytes.length) break;
    const length = (bytes[cursor] << 8) + bytes[cursor + 1];
    if (length < 2 || cursor + length > bytes.length) break;
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || length !== 17 || bytes[cursor + 2] !== 8 || bytes[cursor + 7] !== 3 ||
          height !== (bytes[cursor + 3] << 8) + bytes[cursor + 4] ||
          width !== (bytes[cursor + 5] << 8) + bytes[cursor + 6]) break;
      frame = true;
    }
    if (marker === 0xda) {
      const components = bytes[cursor + 2];
      if (!frame || components < 1 || components > 3 || length !== 6 + 2 * components) break;
      parts.push(bytes.subarray(start, cursor + length));
      cursor += length;
      const entropyStart = cursor;
      // A JPEG can contain multiple scans and metadata between/after them.
      // Preserve stuffed FF bytes and restart markers, then resume marker parsing.
      while (cursor < bytes.length) {
        if (bytes[cursor++] !== 0xff) continue;
        const markerStart = cursor - 1;
        while (bytes[cursor] === 0xff) cursor++;
        const next = bytes[cursor];
        if (next === 0x00 || next === 0x01 || (next >= 0xd0 && next <= 0xd7)) { cursor++; continue; }
        cursor = markerStart;
        break;
      }
      parts.push(bytes.subarray(entropyStart, cursor));
      scan = true;
      continue;
    }
    const optionalMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!optionalMetadata) parts.push(bytes.subarray(start, cursor + length));
    cursor += length;
  }
  throw new Error('The scan is missing a readable color image.');
}
function join(parts: Uint8Array[]): Uint8Array {
  const data = new Uint8Array(parts.reduce((sum, value) => sum + value.length, 0));
  let position = 0;
  for (const part of parts) { data.set(part, position); position += part.length; }
  return data;
}

/** Embed already normalized pixels once. No OCR transcript, source path or user metadata is embedded. */
export function createScanPdf(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const image = pdfImage(jpeg, width, height);
  const scale = 792 / Math.max(width, height);
  const w = (width * scale).toFixed(3), h = (height * scale).toFixed(3);
  const paint = `q\n${w} 0 0 ${h} 0 0 cm\n/Scan Do\nQ\n`;
  const objects = [
    [strToU8('<< /Type /Catalog /Pages 2 0 R >>')],
    [strToU8('<< /Type /Pages /Count 1 /Kids [3 0 R] >>')],
    [strToU8(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>`)],
    [strToU8(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, strToU8('\nendstream')],
    [strToU8(`<< /Length ${paint.length} >>\nstream\n${paint}endstream`)],
  ];
  const parts: Uint8Array[] = [strToU8('%PDF-1.4\n%'), Uint8Array.of(0xe2, 0xe3, 0xcf, 0xd3, 10)];
  let offset = parts[0].length + parts[1].length;
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(offset);
    const entries = [strToU8(`${index + 1} 0 obj\n`), ...object, strToU8('\nendobj\n')];
    for (const part of entries) { parts.push(part); offset += part.length; }
  }
  const xref = offsets.map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('');
  parts.push(strToU8(`xref\n0 6\n0000000000 65535 f \n${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return join(parts);
}
