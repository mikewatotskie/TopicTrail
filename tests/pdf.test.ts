import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPdfPageText } from '../src/core/services/pdf_text_extraction';

function syllabusPdf(): Uint8Array {
  const stream = 'BT /F1 18 Tf 40 700 Td (Variables and loops) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  pdf += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF';
  return new TextEncoder().encode(pdf);
}

test('real PDF.js parser extracts the actual PDF text and page count', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: syllabusPdf(), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    assert.equal(pdf.numPages, 1);
    assert.equal(await extractPdfPageText(await pdf.getPage(1)), 'Variables and loops');
  } finally { await task.destroy(); }
});
