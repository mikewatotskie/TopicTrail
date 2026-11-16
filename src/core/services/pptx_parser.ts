import { strFromU8 } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { encodeBase64 } from './cloud/base64';
import { MAX_PPTX_XML_BYTES, openPptxArchive, resolvePptxPart } from './pptx_archive';
import { MAX_PPTX_IMAGE_BYTES, pptxRasterMime, studyRasterPixels, type PptxImageMime } from './pptx_images';

export interface PptxImage {
  mime: PptxImageMime;
  base64: string;
  alt: string;
}

export interface PptxSlide {
  paragraphs: string[];
  tables: string[][][];
  images: PptxImage[];
  notes: string[];
}

const MAX_SLIDES = 500;
const MAX_XML_MARKUP = 120_000;
const MAX_SLIDE_TABLES = 1000;
const MAX_TABLE_ROWS = 10_000;
const MAX_IMAGE_REFERENCES = 256;
const MAX_STUDY_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_SLIDE_IMAGE_PIXELS = 24_000_000;
const MAX_DOCUMENT_IMAGE_PIXELS = 32_000_000;
const PRESENTATION_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const PACKAGE_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006';
const OFFICE_NAMESPACES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
];
const PRESENTATION_NAMESPACES = [
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
];

type XmlNode = Record<string, string | XmlNode[] | Record<string, string>>;
type Element = { name: string; children: XmlNode[]; attrs: Record<string, string> };
type Relationship = { type: string; path: string | null };
type Raster = Pick<PptxImage, 'mime' | 'base64'> & { pixels: number };
const xmlError = () => new Error('The PowerPoint file contains invalid or unsupported XML.');
const relationshipError = () => new Error('The PowerPoint package contains a missing or invalid relationship.');

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

function* elements(nodes: XmlNode[], name?: string): Generator<Element> {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key !== ':@' && Array.isArray(value) && (!name || localName(key) === name)) {
        yield { name: key, children: value, attrs: (node[':@'] ?? {}) as Record<string, string> };
      }
    }
  }
}

function child(element: Element | undefined, name: string): Element | undefined {
  return element && elements(element.children, name).next().value;
}

function attr(element: Element | undefined, name: string): string | undefined {
  return element?.attrs['@_' + name];
}

function namespace(scope: Element[], prefix: string): string | undefined {
  const key = prefix ? 'xmlns:' + prefix : 'xmlns';
  for (let index = scope.length - 1; index >= 0; index--) {
    const value = attr(scope[index], key);
    if (value !== undefined) return value;
  }
}

function relationshipAttribute(scope: Element[], name: string): string | undefined {
  const element = scope[scope.length - 1];
  let result: string | undefined;
  for (const [key, value] of Object.entries(element.attrs)) {
    if (key.startsWith('@_') && key.endsWith(':' + name)) {
      const prefix = key.slice(2, -(name.length + 1));
      if (OFFICE_NAMESPACES.includes(namespace(scope, prefix) ?? '')) {
        if (result !== undefined) throw relationshipError();
        result = value;
      }
    }
  }
  return result;
}

function isRelationship(relationship: Relationship, type: string): boolean {
  return OFFICE_NAMESPACES.some(namespace => relationship.type === `${namespace}/${type}`);
}

function relationshipPart(owner: string): string {
  if (!owner) return '_rels/.rels';
  const index = owner.lastIndexOf('/') + 1;
  return owner.slice(0, index) + '_rels/' + owner.slice(index) + '.rels';
}

function readTextParagraphs(body: Element | undefined): string[] {
  if (!body) return [];
  const paragraphs: string[] = [];
  for (const paragraph of elements(body.children, 'p')) {
    const fragments: string[] = [];
    for (const run of elements(paragraph.children)) {
      const name = localName(run.name);
      if (name === 'br') fragments.push('\n');
      if (name === 'tab') fragments.push('\t');
      if (name === 'r' || name === 'fld') {
        const text = child(run, 't');
        for (const node of text?.children ?? []) if (typeof node['#text'] === 'string') fragments.push(node['#text']);
      }
    }
    const text = fragments.join('');
    if (text.trim()) paragraphs.push(text);
  }
  return paragraphs;
}

function readTable(frame: Element): string[][] {
  const table = child(child(child(frame, 'graphic'), 'graphicData'), 'tbl');
  const rows: string[][] = [];
  if (!table) return rows;
  for (const row of elements(table.children, 'tr')) {
    if (rows.length >= MAX_TABLE_ROWS) throw new Error('A PowerPoint table exceeds the study view row limit.');
    rows.push(Array.from(elements(row.children, 'tc'), cell => readTextParagraphs(child(cell, 'txBody')).join('\n')));
  }
  return rows;
}

function* shapes(scope: Element[]): Generator<Element[]> {
  for (const shape of elements(scope[scope.length - 1].children)) {
    const name = localName(shape.name);
    if (name === 'grpSp') yield* shapes([...scope, shape]);
    else if (name === 'AlternateContent') {
      const fallback = child(shape, 'Fallback') ?? child(shape, 'Choice');
      if (fallback) yield* shapes([...scope, shape, fallback]);
    } else if (['sp', 'cxnSp', 'graphicFrame', 'pic'].includes(name)) {
      yield [...scope, shape];
    }
  }
}

function shapeScope(root: Element): Element[] {
  const content = child(root, 'cSld');
  const tree = child(content, 'spTree');
  if (!content || !tree) throw xmlError();
  return [root, content, tree];
}

/** Extract presentation-ordered study content. This leaves the original package bytes intact. */
export function parsePptx(bytes: Uint8Array): PptxSlide[] {
  const archive = openPptxArchive(bytes);
  const media = new Map<string, Raster | null>();
  const notePaths = new Set<string>();
  const xmlParser = new XMLParser({
    preserveOrder: true, ignoreAttributes: false, trimValues: false,
    parseTagValue: false, parseAttributeValue: false, ignoreDeclaration: true, ignorePiTags: true,
    maxNestedTags: 64,
  });
  let xmlBytes = 0;
  let markup = 0;
  let imageReferences = 0;
  let imageBytes = 0;
  let uniqueImagePixels = 0;

  function xml(path: string, expected: string, namespaces: string[]): Element {
    const size = archive.size(path);
    if (size === undefined) throw new Error('The PowerPoint package is missing a required XML file or slide.');
    xmlBytes += size;
    if (xmlBytes > MAX_PPTX_XML_BYTES) throw new Error('PowerPoint XML exceeds the 8 MiB limit.');
    const contents = archive.read(path);
    let source: string;
    try {
      source = strFromU8(contents);
    } catch {
      throw xmlError();
    }
    if (/<!DOCTYPE|<!ENTITY|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/iu.test(source)) throw xmlError();
    for (let offset = source.indexOf('<'); offset !== -1; offset = source.indexOf('<', offset + 1)) {
      if (++markup > MAX_XML_MARKUP) throw new Error('PowerPoint XML exceeds the structure limit.');
    }
    let root: Element;
    try {
      if (XMLValidator.validate(source) !== true) throw xmlError();
      const roots = [...elements(xmlParser.parse(source) as XmlNode[])];
      if (roots.length !== 1) throw xmlError();
      root = roots[0];
    } catch {
      throw xmlError();
    }
    const colon = root.name.indexOf(':');
    if (localName(root.name) !== expected ||
        !namespaces.includes(namespace([root], colon < 0 ? '' : root.name.slice(0, colon)) ?? '')) throw xmlError();
    return root;
  }

  function relationships(owner: string, optional = false): Map<string, Relationship> {
    const path = relationshipPart(owner);
    const byId = new Map<string, Relationship>();
    if (optional && archive.size(path) === undefined) return byId;
    const root = xml(path, 'Relationships', [PACKAGE_NAMESPACE + '/relationships']);
    for (const relationship of elements(root.children, 'Relationship')) {
      const id = attr(relationship, 'Id');
      const type = attr(relationship, 'Type');
      const target = attr(relationship, 'Target');
      const mode = attr(relationship, 'TargetMode') ?? 'Internal';
      if (!id || !type || !target || !['Internal', 'External'].includes(mode) || byId.has(id)) throw relationshipError();
      byId.set(id, { type, path: mode === 'Internal' ? resolvePptxPart(owner, target) : null });
    }
    return byId;
  }

  function readImage(scope: Element[], links: Map<string, Relationship>, slidePixels: number):
      { image: PptxImage; pixels: number } | undefined {
    const picture = scope[scope.length - 1];
    const fill = child(picture, 'blipFill');
    const blip = child(fill, 'blip');
    if (!fill || !blip) return;
    const id = relationshipAttribute([...scope, fill, blip], 'embed');
    if (!id) return;
    const link = links.get(id);
    if (!link || !isRelationship(link, 'image')) throw relationshipError();
    if (!link.path) return;
    const mime = pptxRasterMime(link.path);
    if (!mime) return;
    const size = archive.size(link.path);
    if (size === undefined) throw relationshipError();
    if (size > MAX_PPTX_IMAGE_BYTES) throw new Error('An embedded PowerPoint image exceeds the 8 MiB image limit.');
    const key = link.path.toLowerCase();
    let data = media.get(key);
    if (data === null) return;
    if (++imageReferences > MAX_IMAGE_REFERENCES || imageBytes + size > MAX_STUDY_IMAGE_BYTES) {
      throw new Error('Embedded PowerPoint images exceed the study view size limit.');
    }
    if (!data) {
      const image = archive.read(link.path);
      const pixels = studyRasterPixels(image, mime);
      if (pixels === undefined) {
        media.set(key, null);
        return;
      }
      uniqueImagePixels += pixels;
      if (uniqueImagePixels > MAX_DOCUMENT_IMAGE_PIXELS) {
        throw new Error('Embedded PowerPoint images exceed the document pixel limit.');
      }
      data = { mime, base64: encodeBase64(image), pixels };
      media.set(key, data);
    }
    if (slidePixels + data.pixels > MAX_SLIDE_IMAGE_PIXELS) {
      throw new Error('Embedded PowerPoint images exceed the slide pixel limit.');
    }
    imageBytes += size;
    const properties = child(child(picture, 'nvPicPr'), 'cNvPr');
    const alt = (attr(properties, 'descr') ?? attr(properties, 'name') ?? '').slice(0, 1024);
    return { image: { mime: data.mime, base64: data.base64, alt }, pixels: data.pixels };
  }

  function readNotes(links: Map<string, Relationship>): string[] {
    const parts = [...links.values()].filter(link => isRelationship(link, 'notesSlide'));
    if (parts.length > 1) throw relationshipError();
    const path = parts[0]?.path;
    if (!path) return [];
    const key = path.toLowerCase();
    if (notePaths.has(key)) throw relationshipError();
    notePaths.add(key);
    const result: string[] = [];
    const root = xml(path, 'notes', PRESENTATION_NAMESPACES);
    for (const scope of shapes(shapeScope(root))) {
      const shape = scope[scope.length - 1];
      if (localName(shape.name) !== 'sp') continue;
      const placeholder = child(child(child(shape, 'nvSpPr'), 'nvPr'), 'ph');
      if (!placeholder || attr(placeholder, 'type') === 'body') {
        result.push(...readTextParagraphs(child(shape, 'txBody')));
      }
    }
    return result;
  }

  const mainParts = [...relationships('').values()].filter(link => isRelationship(link, 'officeDocument'));
  const presentationPath = mainParts[0]?.path;
  if (mainParts.length !== 1 || !presentationPath) throw relationshipError();
  const contentTypes = xml('[Content_Types].xml', 'Types', [PACKAGE_NAMESPACE + '/content-types']);
  const declaredTypes: string[] = [];
  for (const override of elements(contentTypes.children, 'Override')) {
    const part = attr(override, 'PartName');
    const type = attr(override, 'ContentType');
    if (!part?.startsWith('/') || !type) throw xmlError();
    if (resolvePptxPart('', part).toLowerCase() === presentationPath.toLowerCase()) declaredTypes.push(type);
  }
  if (declaredTypes.length !== 1 || declaredTypes[0] !== PRESENTATION_TYPE) {
    throw new Error('This file is not a supported PowerPoint presentation type.');
  }

  const presentation = xml(presentationPath, 'presentation', PRESENTATION_NAMESPACES);
  const list = child(presentation, 'sldIdLst');
  if (!list) throw new Error('The PowerPoint file has no slides.');
  const slideIds = [...elements(list.children, 'sldId')];
  if (!slideIds.length) throw new Error('The PowerPoint file has no slides.');
  if (slideIds.length > MAX_SLIDES) throw new Error('The PowerPoint file exceeds the 500-slide limit.');
  const links = relationships(presentationPath);
  const slides: PptxSlide[] = [];
  const seen = new Set<string>();
  for (const slideId of slideIds) {
    const id = relationshipAttribute([presentation, list, slideId], 'id');
    const link = id ? links.get(id) : undefined;
    if (!link?.path || !isRelationship(link, 'slide')) throw relationshipError();
    const key = link.path.toLowerCase();
    if (seen.has(key)) throw new Error('The PowerPoint presentation contains a duplicate slide reference.');
    seen.add(key);
    const slide = xml(link.path, 'sld', PRESENTATION_NAMESPACES);
    const slideLinks = relationships(link.path, true);
    const result: PptxSlide = { paragraphs: [], tables: [], images: [], notes: readNotes(slideLinks) };
    let slidePixels = 0;
    for (const scope of shapes(shapeScope(slide))) {
      const shape = scope[scope.length - 1];
      const name = localName(shape.name);
      if (name === 'pic') {
        const raster = readImage(scope, slideLinks, slidePixels);
        if (raster) {
          slidePixels += raster.pixels;
          result.images.push(raster.image);
        }
      } else if (name === 'graphicFrame') {
        const table = readTable(shape);
        if (table.length) {
          if (result.tables.length >= MAX_SLIDE_TABLES) {
            throw new Error('A PowerPoint slide exceeds the study view table limit.');
          }
          result.tables.push(table);
        }
      } else {
        result.paragraphs.push(...readTextParagraphs(child(shape, 'txBody')));
      }
    }
    slides.push(result);
  }
  return slides;
}
