import { Inflate, strFromU8, strToU8 } from 'fflate';

const MIB = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * MIB;
const MAX_EXPANDED_BYTES = 64 * MIB;
export const MAX_PPTX_XML_BYTES = 8 * MIB;
const MAX_ENTRIES = 4096;
const INFLATE_CHUNK_BYTES = 4096;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0);
  return byte;
});

interface Entry {
  start: number;
  compressedBytes: number;
  expandedBytes: number;
  compression: number;
  checksum: number;
}

const invalidArchive = () => new Error('The PowerPoint ZIP archive is corrupt or uses an unsupported ZIP format.');
const invalidPath = () => new Error('The document package contains an invalid file or relationship path.');

function decodeSegment(segment: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(segment); } catch { throw invalidPath(); }
  if (!decoded || decoded === '.' || decoded === '..' ||
      /[/\\:?#%\u0000-\u001f\u007f]/u.test(decoded) || decoded.length > 255) throw invalidPath();
  return decoded;
}

/** Resolve internal OPC part references without using a filesystem or URL loader. */
export function resolvePptxPart(owner: string, target: string): string {
  if (target.length > 1024 || target.endsWith('/')) throw invalidPath();
  const rooted = target.startsWith('/');
  const result = rooted || !owner ? [] : owner.split('/').slice(0, -1);
  for (const segment of (rooted ? target.slice(1) : target).split('/')) {
    if (segment === '..') {
      if (!result.length) throw invalidPath();
      result.pop();
    } else if (segment !== '.') {
      result.push(decodeSegment(segment));
    }
  }
  if (!result.length) throw invalidPath();
  return result.join('/');
}

function pathFromArchive(raw: Uint8Array): string {
  let name: string;
  try { name = strFromU8(raw); } catch { throw invalidPath(); }
  const encoded = strToU8(name);
  if (encoded.length !== raw.length || encoded.some((byte, index) => byte !== raw[index])) throw invalidPath();
  return normalizeOfficeEntryName(name);
}

/** Both Office readers consume validated package parts in memory. */
export function normalizeOfficeEntryName(name: string): string {
  if (!name || name.length > 1024) throw invalidPath();
  const directory = name.endsWith('/');
  const parts = (directory ? name.slice(0, -1) : name).split('/').map(decodeSegment);
  return parts.join('/') + (directory ? '/' : '');
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) checksum = (checksum >>> 8) ^ CRC_TABLE[(checksum ^ byte) & 255];
  return (~checksum) >>> 0;
}

export function openPptxArchive(bytes: Uint8Array) {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('The PowerPoint file exceeds the 50 MiB size limit.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);

  // The ZIP end record is followed by its optional comment and cannot point to a split archive.
  let end = bytes.length - 22;
  for (const first = Math.max(0, end - 65535); end >= first; end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
  }
  if (end < Math.max(0, bytes.length - 22 - 65535) || u16(end + 4) || u16(end + 6)) throw invalidArchive();
  const count = u16(end + 10);
  const directoryStart = u32(end + 16);
  if (count > MAX_ENTRIES) throw new Error('The PowerPoint ZIP archive exceeds the entry limit.');
  if (!count || count !== u16(end + 8) || directoryStart + u32(end + 12) !== end) throw invalidArchive();

  const entries = new Map<string, Entry>();
  const ranges: { start: number; end: number }[] = [];
  let expanded = 0;
  let xmlBytes = 0;
  let offset = directoryStart;

  function validDescriptor(start: number, checksum: number, compressed: number, original: number) {
    return start + 12 <= directoryStart &&
      u32(start) === checksum && u32(start + 4) === compressed && u32(start + 8) === original;
  }

  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw invalidArchive();
    const flags = u16(offset + 8);
    const compression = u16(offset + 10);
    const checksum = u32(offset + 16);
    const compressedBytes = u32(offset + 20);
    const expandedBytes = u32(offset + 24);
    const nameBytes = u16(offset + 28);
    const local = u32(offset + 42);
    const next = offset + 46 + nameBytes + u16(offset + 30) + u16(offset + 32);
    // Accept only plain stored/DEFLATE entries, optionally with a trailing data descriptor.
    if ((flags & ~0x080e) || u16(offset + 34) || next > end || !nameBytes || nameBytes > 1024 ||
        ![0, 8].includes(compression) || (compression === 0 && compressedBytes !== expandedBytes) ||
        (compression === 8 && !compressedBytes)) throw invalidArchive();

    const rawName = bytes.subarray(offset + 46, offset + 46 + nameBytes);
    const name = pathFromArchive(rawName).toLowerCase();
    if (entries.has(name)) throw new Error('The PowerPoint ZIP archive contains duplicate file paths.');
    expanded += expandedBytes;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('The expanded PowerPoint ZIP exceeds the 64 MiB limit.');
    if (/(?:\.xml|\.rels)$/u.test(name)) {
      xmlBytes += expandedBytes;
      if (xmlBytes > MAX_PPTX_XML_BYTES) throw new Error('PowerPoint XML exceeds the 8 MiB limit.');
    }

    if (local + 30 > directoryStart || u32(local) !== 0x04034b50 ||
        u16(local + 6) !== flags || u16(local + 8) !== compression || u16(local + 26) !== nameBytes) {
      throw invalidArchive();
    }
    const start = local + 30 + nameBytes + u16(local + 28);
    let memberEnd = start + compressedBytes;
    if (memberEnd > directoryStart || rawName.some((byte, nameIndex) => bytes[local + 30 + nameIndex] !== byte) ||
        (name.endsWith('/') && expandedBytes)) throw invalidArchive();
    if (flags & 8) {
      if (validDescriptor(memberEnd, checksum, compressedBytes, expandedBytes)) memberEnd += 12;
      else if (memberEnd + 16 <= directoryStart && u32(memberEnd) === 0x08074b50 &&
               validDescriptor(memberEnd + 4, checksum, compressedBytes, expandedBytes)) memberEnd += 16;
      else throw invalidArchive();
    } else if (u32(local + 14) !== checksum || u32(local + 18) !== compressedBytes || u32(local + 22) !== expandedBytes) {
      throw invalidArchive();
    }

    entries.set(name, { start, compressedBytes, expandedBytes, compression, checksum });
    ranges.push({ start: local, end: memberEnd });
    offset = next;
  }
  ranges.sort((left, right) => left.start - right.start);
  let lastEnd = 0;
  for (const range of ranges) {
    if (range.start !== lastEnd) throw invalidArchive();
    lastEnd = range.end;
  }
  if (offset !== end || lastEnd !== directoryStart) throw invalidArchive();

  return {
    size(path: string) {
      return entries.get(path.toLowerCase())?.expandedBytes;
    },
    read(path: string): Uint8Array {
      const entry = entries.get(path.toLowerCase());
      if (!entry) throw new Error('The PowerPoint package is missing a referenced file or slide.');
      const input = bytes.subarray(entry.start, entry.start + entry.compressedBytes);
      let output = input;
      if (entry.compression === 8) {
        output = new Uint8Array(entry.expandedBytes);
        let written = 0;
        const inflate = new Inflate(chunk => {
          if (written + chunk.length > output.length) {
            throw new Error('A PowerPoint ZIP entry expanded beyond its declared size.');
          }
          output.set(chunk, written);
          written += chunk.length;
        });
        for (let start = 0; start < input.length; start += INFLATE_CHUNK_BYTES) {
          const end = Math.min(start + INFLATE_CHUNK_BYTES, input.length);
          inflate.push(input.subarray(start, end), end === input.length);
        }
        if (written !== output.length) throw invalidArchive();
      }
      if (crc32(output) !== entry.checksum) throw invalidArchive();
      return output;
    },
  };
}
