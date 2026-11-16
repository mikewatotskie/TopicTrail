import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate, zipSync } from 'fflate';
import { parsePptx } from '../src/core/services/pptx_parser';

const packageNs = 'http://schemas.openxmlformats.org/package/2006';
const officeNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const namespaces = `xmlns:p="${presentationNs}" xmlns:a="${drawingNs}" xmlns:rel="${officeNs}"`;
const mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const types = `<Types xmlns="${packageNs}/content-types"><Override PartName="/ppt/presentation.xml" ContentType="${mime}"/></Types>`;
const relationships = (content: string) => `<Relationships xmlns="${packageNs}/relationships">${content}</Relationships>`;
const relation = (id: string, kind: string, target: string, external = false) =>
  `<Relationship Id="${id}" Type="${officeNs}/${kind}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;
const paragraph = (text: string) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
const shape = (content: string, extra = '') => `<p:sp>${extra}<p:txBody>${content}</p:txBody></p:sp>`;
const shapeTree = (content: string) => `<p:cSld><p:spTree>${content}</p:spTree></p:cSld>`;
const slide = (content: string) => `<p:sld ${namespaces}>${shapeTree(content)}</p:sld>`;
const presentation = (ids: string[]) => `<p:presentation ${namespaces}><p:sldIdLst>${ids.map((id, index) =>
  `<p:sldId id="${256 + index}" rel:id="${id}"/>`).join('')}</p:sldIdLst></p:presentation>`;
const picture = (id: string, alt = '') =>
  `<p:pic><p:nvPicPr><p:cNvPr descr="${alt}"/></p:nvPicPr><p:blipFill><a:blip rel:embed="${id}"/></p:blipFill></p:pic>`;
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPfkAAAAASUVORK5CYII=';
const png = Uint8Array.from(atob(pngBase64), char => char.charCodeAt(0));

function grayscalePng(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  function chunk(kind: string, data: Uint8Array) {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length);
    chunk.write(kind, 4);
    chunk.set(data, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
  }
  const imageData = deflateSync(Buffer.alloc(height * (1 + Math.ceil(width / 8))));
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', imageData), chunk('IEND', new Uint8Array())]);
}

function deck(overrides: Record<string, string | Uint8Array> = {}, level: 0 | 6 = 6) {
  const contents = {
    '[Content_Types].xml': types,
    '_rels/.rels': relationships(relation('main', 'officeDocument', 'ppt/presentation.xml')),
    'ppt/presentation.xml': presentation(['r9', 'r3']),
    'ppt/_rels/presentation.xml.rels': relationships(
      relation('r3', 'slide', 'slides/slide1.xml') + relation('r9', 'slide', 'slides/slide2.xml')),
    'ppt/slides/slide1.xml': slide(shape(paragraph('Second'))),
    'ppt/slides/slide2.xml': slide(shape(paragraph('First'))),
    ...overrides,
  };
  return zipSync(Object.fromEntries(Object.entries(contents).map(([path, body]) =>
    [path, typeof body === 'string' ? strToU8(body) : body])), { level });
}

test('PowerPoint study content follows relationship order and retains original package bytes', () => {
  const table = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>
    <a:tc><a:txBody>${paragraph('Cells')}${paragraph('can have paragraphs')}</a:txBody></a:tc>
    <a:tc><a:txBody>${paragraph('Größe')}</a:txBody></a:tc>
    </a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const bodyPlaceholder = '<p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>';
  const slideNumber = '<p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>';
  const bytes = deck({
    'ppt/slides/slide2.xml': slide(shape('<a:p><a:r><a:t>First &amp; </a:t></a:r><a:r><a:t>again</a:t></a:r><a:br/><a:r><a:t>Line 2</a:t></a:r></a:p>') +
      `<p:grpSp>${shape(paragraph('Grouped'))}</p:grpSp>` + table + picture('png', 'Fixture &amp; figure') +
      picture('remote') + picture('vector')),
    'ppt/slides/_rels/slide2.xml.rels': relationships(relation('png', 'image', '../media/sample.png') +
      relation('notes', 'notesSlide', '../notesSlides/notesSlide9.xml') +
      relation('remote', 'image', 'https://example.invalid/pixel.png', true) +
      relation('vector', 'image', '../media/figure.svg')),
    'ppt/media/sample.png': png,
    'ppt/media/figure.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'ppt/notesSlides/notesSlide9.xml': `<p:notes ${namespaces}>${shapeTree(
      shape(paragraph('Speaker notes'), bodyPlaceholder) + shape(paragraph('2'), slideNumber))}</p:notes>`,
  });
  const snapshot = bytes.slice();
  assert.deepEqual(parsePptx(bytes), [
    { paragraphs: ['First & again\nLine 2', 'Grouped'], tables: [[['Cells\ncan have paragraphs', 'Größe']]],
      images: [{ mime: 'image/png', base64: pngBase64, alt: 'Fixture & figure' }], notes: ['Speaker notes'] },
    { paragraphs: ['Second'], tables: [], images: [], notes: [] },
  ]);
  assert.deepEqual(bytes, snapshot);
});

test('ordinary streaming ZIP data descriptors are supported', () => {
  const chunks: Uint8Array[] = [];
  const archive = new Zip((error, bytes) => {
    if (error) throw error;
    chunks.push(bytes);
  });
  for (const [path, bytes] of Object.entries(unzipSync(deck()))) {
    const part = new ZipDeflate(path);
    archive.add(part);
    part.push(bytes, true);
  }
  archive.end();
  assert.deepEqual(parsePptx(Buffer.concat(chunks)).map(slide => slide.paragraphs[0]), ['First', 'Second']);
});

test('arbitrary ZIP, incorrect Office type, malformed XML and custom entities are rejected', () => {
  assert.throws(() => parsePptx(zipSync({ 'readme.txt': strToU8('synthetic') })), /PowerPoint/i);
  assert.throws(() => parsePptx(deck({ '[Content_Types].xml': types.replace(mime, 'text/plain') })), /type/i);
  assert.throws(() => parsePptx(deck({ 'ppt/slides/slide2.xml': '<p:sld><broken></p:sld>' })), /XML/i);
  assert.throws(() => parsePptx(deck({
    'ppt/slides/slide2.xml': '<!DOCTYPE p:sld [<!ENTITY leak SYSTEM "file:///test.xml">]>' + slide(shape(paragraph('&leak;'))),
  })), /XML/i);
});

test('mismatched, duplicate, external and escaping slide relationships fail', () => {
  const path = 'ppt/_rels/presentation.xml.rels';
  for (const invalid of [
    relation('r9', 'slide', 'slides/unknown.xml'),
    relation('r9', 'slide', 'slides/slide1.xml') + relation('r9', 'slide', 'slides/slide2.xml'),
    relation('r9', 'slide', 'https://example.invalid/slide.xml', true),
    relation('r9', 'slide', '../../../private.xml'),
    relation('r9', 'slide', '%2e%2e/private.xml'),
  ]) {
    assert.throws(() => parsePptx(deck({ [path]: relationships(invalid) })), /slide|relationship|path/i);
  }
  assert.throws(() => parsePptx(deck({ 'ppt/presentation.xml': presentation(['r9', 'r9']) })), /duplicate|slide/i);
});

test('archive entry paths, duplicate members, truncation, and corrupt content fail', () => {
  assert.throws(() => parsePptx(deck({ '../escape.xml': '<a/>' })), /path/i);
  assert.throws(() => parsePptx(deck({ 'ppt/slides/Slide2.xml': slide('') })), /duplicate/i);
  assert.throws(() => parsePptx(deck().subarray(0, deck().length - 1)), /archive/i);
  const bytes = deck({}, 0);
  const target = strFromU8(bytes, true).indexOf('Second');
  assert.notEqual(target, -1);
  bytes[target] ^= 1;
  assert.throws(() => parsePptx(bytes), /corrupt|checksum/i);
});

test('compressed size, archive expansion, XML expansion, and slide count are bounded', () => {
  assert.throws(() => parsePptx(new Uint8Array(50 * 1024 * 1024 + 1)), /50.*MB|50.*MiB/i);
  assert.throws(() => parsePptx(deck({ 'ppt/slides/slide2.xml': slide(shape(paragraph('a'.repeat(8 * 1024 * 1024)))) })), /XML.*limit/i);
  assert.throws(() => parsePptx(deck({
    'ppt/presentation.xml': presentation(Array.from({ length: 501 }, (_, i) => 's' + i)),
  })), /500.*slide|slide.*limit/i);
  const bytes = deck({ 'large.bin': 'a'.repeat(256) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  const directoryStart = view.getUint32(end + 16, true);
  for (let offset = directoryStart; offset < end;) {
    const nameLength = view.getUint16(offset + 28, true);
    if (strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength)) === 'large.bin') {
      view.setUint32(offset + 24, 64 * 1024 * 1024, true);
      view.setUint32(view.getUint32(offset + 42, true) + 22, 64 * 1024 * 1024, true);
    }
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  assert.throws(() => parsePptx(bytes), /expand.*limit/i);
});

test('forged deflate output size is detected during extraction', () => {
  const bytes = deck({ 'ppt/slides/slide2.xml': slide(shape(paragraph('a'.repeat(256 * 1024)))) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  for (let offset = view.getUint32(end + 16, true); offset < end;) {
    const nameLength = view.getUint16(offset + 28, true);
    if (strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength)) === 'ppt/slides/slide2.xml') {
      view.setUint32(offset + 24, 12, true);
      view.setUint32(view.getUint32(offset + 42, true) + 22, 12, true);
    }
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  assert.throws(() => parsePptx(bytes), /size|expand/i);
});

test('an oversized embedded raster is rejected before it can be decoded', () => {
  const giantPng = png.slice();
  new DataView(giantPng.buffer).setUint32(16, 17_000_001);
  assert.throws(() => parsePptx(deck({
    'ppt/slides/slide2.xml': slide(picture('png')),
    'ppt/slides/_rels/slide2.xml.rels': relationships(relation('png', 'image', '../media/sample.png')),
    'ppt/media/sample.png': giantPng,
  })), /image.*limit/i);
});

test('repeated rasters cannot exceed a single slide’s combined pixel budget', () => {
  const largePng = grayscalePng(4000, 3100);
  const slideParts = {
    'ppt/slides/_rels/slide2.xml.rels': relationships(relation('png', 'image', '../media/sample.png')),
    'ppt/media/sample.png': largePng,
  };
  assert.ok(largePng.length < 2048);
  assert.equal(parsePptx(deck({ ...slideParts, 'ppt/slides/slide2.xml': slide(picture('png')) }))[0].images.length, 1);
  assert.throws(() => parsePptx(deck({ ...slideParts, 'ppt/slides/slide2.xml': slide(picture('png') + picture('png')) })),
    /slide.*pixel.*limit/i);
});

test('separate slide images cannot exceed the document’s combined unique pixel budget', () => {
  const largePng = grayscalePng(4000, 3100);
  const ids = ['s1', 's2', 's3'];
  const entries: Record<string, string | Uint8Array> = {
    'ppt/presentation.xml': presentation(ids),
    'ppt/_rels/presentation.xml.rels': relationships(ids.map(id =>
      relation(id, 'slide', 'slides/' + id + '.xml')).join('')),
  };
  for (const id of ids) {
    entries['ppt/slides/' + id + '.xml'] = slide(picture('png'));
    entries['ppt/slides/_rels/' + id + '.xml.rels'] = relationships(relation('png', 'image', '../media/' + id + '.png'));
    entries['ppt/media/' + id + '.png'] = largePng;
  }
  assert.throws(() => parsePptx(deck(entries)), /document.*pixel.*limit/i);
});

test('embedded JPEG, GIF, and WebP remain byte-identical and SVG cannot masquerade as PNG', () => {
  const fixtures = [
    ['jpg', 'image/jpeg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAKgb/9k='],
    ['gif', 'image/gif', 'R0lGODdhAgADAIEAACg8ZAAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7'],
    ['webp', 'image/webp', 'UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoCAAMAAUAmJYgCdLoAA5gA/vfEX+SUKH/6l4bVWS0AAA=='],
  ];
  const parts = Object.fromEntries(fixtures.map(([ext, , data]) =>
    ['ppt/media/fixture.' + ext, Uint8Array.from(atob(data), char => char.charCodeAt(0))]));
  const bytes = deck({
    'ppt/slides/slide2.xml': slide(fixtures.map(([ext]) => picture(ext, ext)).join('')),
    'ppt/slides/_rels/slide2.xml.rels': relationships(fixtures.map(([ext]) =>
      relation(ext, 'image', '../media/fixture.' + ext)).join('')),
    ...parts,
  });
  assert.deepEqual(parsePptx(bytes)[0].images, fixtures.map(([alt, mime, base64]) => ({ mime, base64, alt })));
  assert.throws(() => parsePptx(deck({
    'ppt/slides/slide2.xml': slide(picture('png')),
    'ppt/slides/_rels/slide2.xml.rels': relationships(relation('png', 'image', '../media/sample.png')),
    'ppt/media/sample.png': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  })), /invalid raster header/i);
});
