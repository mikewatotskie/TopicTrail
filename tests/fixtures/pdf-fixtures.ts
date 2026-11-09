import { Buffer } from 'node:buffer';

/** Small, authored PDFs with valid xref offsets; no personal document content. */
export function pdfFixture(kind: 'standard' | 'cjk' | 'empty' | 'jpx' | 'ccitt' | 'jbig2' | 'cmyk', image?: Uint8Array): Uint8Array {
  const cjk = kind === 'cjk';
  const images = kind === 'jpx' || kind === 'ccitt' || kind === 'jbig2';
  const content = kind === 'empty' ? '' : images ? 'q 8 0 0 8 40 600 cm /I1 Do Q BT /F1 18 Tf 40 700 Td (Offline image) Tj ET'
    : kind === 'cmyk' ? '0 1 1 0 k 20 20 30 30 re f BT /F1 18 Tf 40 700 Td (Color profile) Tj ET'
    : cjk ? 'BT /F1 18 Tf 40 700 Td <65e5672c8a9e> Tj ET' : 'BT /F1 18 Tf 40 700 Td (Variables and loops) Tj ET';
  const objects: (string | Uint8Array)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> ${images ? '/XObject << /I1 6 0 R >>' : ''} >> /Contents 5 0 R >>`,
    cjk ? '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [6 0 R] >>' : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  if (cjk) objects.push('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>', '<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>');
  if (images) {
    if (!image) throw new Error('Image fixture bytes required');
    const dictionary = kind === 'jpx' ? '/Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode' : kind === 'jbig2' ? '/Width 8 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode' : '/Width 8 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 8 /Rows 1 >>';
    objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image ${dictionary} /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]));
  }
  const chunks = [Buffer.from('%PDF-1.7\n')];
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), typeof object === 'string' ? Buffer.from(object) : Buffer.from(object), Buffer.from('\nendobj\n'));
  }
  const start = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`));
  return new Uint8Array(Buffer.concat(chunks));
}

