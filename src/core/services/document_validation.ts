import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { DocumentFormat } from '../models/document';

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
type XmlNode = { [name: string]: XmlNode[] | string | Record<string, string> };

function parseXml(xml: string): XmlNode[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('Invalid or unsupported DOCX XML');
  }
  return new XMLParser({ preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true,
    trimValues: false, parseTagValue: false, ignoreDeclaration: true, ignorePiTags: true }).parse(xml) as XmlNode[];
}

/** Port of the Flutter ZIP + word/document.xml paragraph algorithm, with bounded XML expansion. */
export function parseDocx(bytes: Uint8Array, maxXmlBytes = MAX_XML_BYTES): string[] {
  const wanted = new Set(['[Content_Types].xml', 'word/document.xml']);
  const sizes = new Map<string, number>();
  let expanded = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: entry => {
      if (!wanted.has(entry.name)) return false;
      if (sizes.has(entry.name) || (entry.compression === 0 && entry.size !== entry.originalSize)) {
        throw new Error('DOCX XML entry size is inconsistent');
      }
      sizes.set(entry.name, entry.originalSize);
      expanded += entry.originalSize;
      if (expanded > maxXmlBytes) throw new Error('DOCX XML exceeds the readable size limit');
      return true;
    } });
  } catch (error) {
    throw new Error(error instanceof Error ? `Invalid DOCX: ${error.message}` : 'Invalid DOCX archive');
  }
  if (!entries['[Content_Types].xml'] || !entries['word/document.xml']) throw new Error('Not a valid DOCX document');
  let actualBytes = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    actualBytes += bytes.length;
    if (bytes.length !== sizes.get(name) || actualBytes > maxXmlBytes) {
      throw new Error('DOCX XML exceeds the readable size limit or has an inconsistent size');
    }
  }
  const contentTypes = strFromU8(entries['[Content_Types].xml']);
  function hasWordMainPart(nodes: XmlNode[]): boolean {
    return nodes.some(node => {
      const attributes = node[':@'] as Record<string, string> | undefined;
      if ('Override' in node && attributes?.['@_PartName'] === '/word/document.xml' &&
          attributes['@_ContentType'] === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') return true;
      return Object.values(node).some(child => Array.isArray(child) && hasWordMainPart(child));
    });
  }
  if (!hasWordMainPart(parseXml(contentTypes))) {
    throw new Error('Unsupported DOCX document type');
  }
  const nodes = parseXml(strFromU8(entries['word/document.xml']));
  const paragraphs: string[] = [];
  function text(nodes: XmlNode[], insideText = false): string {
    return nodes.map(node => Object.entries(node).map(([name, child]) => {
      if (name === '#text') return insideText ? String(child) : '';
      if (name === 'tab') return '\t';
      if (name === 'br' || name === 'cr') return '\n';
      if (name === ':@' || name === 'del' || name === 'instrText') return '';
      return Array.isArray(child) ? text(child, name === 't') : '';
    }).join('')).join('');
  }
  function visit(nodes: XmlNode[]) {
    for (const node of nodes) for (const [name, child] of Object.entries(node)) {
      if (!Array.isArray(child) || name === 'del') continue;
      if (name === 'p') paragraphs.push(text(child));
      else visit(child);
    }
  }
  visit(nodes);
  return paragraphs;
}

export function validateDocument(name: string, bytes: Uint8Array, size = bytes.length): DocumentFormat {
  if (!Number.isFinite(size) || size <= 0 || !bytes.length) throw new Error('The selected file is empty');
  if (size > MAX_FILE_SIZE_BYTES || bytes.length > MAX_FILE_SIZE_BYTES) throw new Error('File size exceeds the 50MB limit');
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'pdf') {
    if (strFromU8(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('File content does not match a PDF document');
    return DocumentFormat.PDF;
  }
  if (extension === 'docx') { parseDocx(bytes); return DocumentFormat.DOCX; }
  throw new Error('Unsupported file format. Only PDF and DOCX are allowed.');
}
