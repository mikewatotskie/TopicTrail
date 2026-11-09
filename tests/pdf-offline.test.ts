import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

// Removing any auxiliary asset or using bytes from a different PDF.js release must fail.
test('offline reader ships every installed CMap/font/decoder/profile with matching hashes and licenses', async () => {
  assert.ok(existsSync('assets/reader/manifest.json'), 'offline PDF asset manifest is missing');
  const manifest = JSON.parse(await readFile('assets/reader/manifest.json', 'utf8'));
  assert.equal(manifest.pdfjsVersion, '6.4.299');
  for (const [file, info] of Object.entries(manifest.resources) as [string, { sha256: string; bytes: number }][]) {
    const original = await readFile('node_modules/pdfjs-dist/' + file);
    assert.equal(createHash('sha256').update(original).digest('hex'), info.sha256, file);
    assert.equal(original.length, info.bytes, file);
  }
  assert.equal(Object.keys(manifest.resources).filter(name => name.startsWith('cmaps/')).length, 168);
  for (const file of ['standard_fonts/FoxitSymbol.pfb', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm', 'wasm/jbig2.wasm', 'wasm/openjpeg_nowasm_fallback.js', 'wasm/jbig2_nowasm_fallback.js', 'wasm/qcms_bg.wasm', 'iccs/CGATS001Compat-v2-micro.icc']) {
    assert.ok(manifest.resources[file], file);
  }
  const dom = new JSDOM(await readFile('assets/reader/viewer.html', 'utf8'));
  try {
    const noticesNode = dom.window.document.getElementById('pdfjs-third-party-notices');
    assert.ok(noticesNode, 'license texts must travel inside the HTML asset used by the app');
    const notices = JSON.parse(noticesNode.textContent!);
    assert.equal(notices['PDFJS-LICENSE.txt'], await readFile('assets/reader/PDFJS-LICENSE.txt', 'utf8'));
    for (const file of manifest.licenses) assert.equal(notices[file], await readFile('assets/reader/licenses/' + file, 'utf8'), file);
  } finally { dom.window.close(); }
});

test('offline resource lookup returns fresh version-matched bytes and rejects unrecognized requests', async () => {
  assert.ok(existsSync('src/features/reader/pdf_offline.ts'), 'offline PDF resource lookup is missing');
  const modulePath = '../src/features/reader/pdf_offline';
  const { createOfflineResourceLoader } = await import(modulePath);
  const original = await readFile('node_modules/pdfjs-dist/cmaps/Adobe-Japan1-UCS2.bcmap');
  const load = createOfflineResourceLoader({ 'cmaps/Adobe-Japan1-UCS2.bcmap': original.toString('base64') });
  const bytes = load('topictrail-offline://pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap');
  assert.deepEqual(bytes, new Uint8Array(original));
  bytes[0] ^= 255;
  assert.deepEqual(load('topictrail-offline://pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap'), new Uint8Array(original));
  for (const url of ['https://example.com/a', 'topictrail-offline://pdfjs/cmaps/../wasm/openjpeg.wasm', 'topictrail-offline://pdfjs/cmaps/%2e%2e/a', 'topictrail-offline://pdfjs/cmaps/missing.bcmap', 'topictrail-offline://pdfjs/__proto__', 'topictrail-offline://pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap?x']) {
    assert.throws(() => load(url), /Unknown offline PDF resource/);
  }
});

// Run the exact worker emitted for the WebView, using PDF.js's supported fake-worker
// transport in Node. No browser preview, native rendering or network is involved.
test('bundled worker parses CJK/standard text and decodes offline JPEG2000/JBIG2/CCITT in WASM and JS fallback modes', async () => {
  const { runInThisContext } = await import('node:vm');
  const { pdfFixture } = await import('./fixtures/pdf-fixtures');
  const { offlinePdfOptions } = await import('../src/features/reader/pdf_offline');
  const bundlerPath = '../scripts/bundle-reader.mjs';
  const { buildOfflineWorker } = await import(bundlerPath);
  const { code } = await buildOfflineWorker();
  runInThisContext(code);
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { extractPdfPageText } = await import('../src/core/services/pdf_text_extraction');
  const network = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('PDF test attempted a network request'); };
  try {
    for (const useWasm of [true, false]) {
      for (const [kind, text] of [['standard', 'Variables and loops'], ['cjk', '日本語'], ['empty', ''], ['jpx', 'Offline image'], ['ccitt', 'Offline image'], ['jbig2', 'Offline image'], ['cmyk', 'Color profile']] as const) {
        const image = kind === 'jpx' ? await readFile('tests/fixtures/red-2x2.jp2') : kind === 'ccitt' ? await readFile('tests/fixtures/white-8x1.ccitt') : kind === 'jbig2' ? await readFile('tests/fixtures/white-8x1.jbig2') : undefined;
        const task = getDocument({ data: pdfFixture(kind, image), ...offlinePdfOptions, useWasm });
        try {
          const pdf = await task.promise;
          assert.equal(pdf.numPages, 1);
          const page = await pdf.getPage(1);
          assert.equal(await extractPdfPageText(page), text, kind);
          const operators = await page.getOperatorList();
          if (image) {
            const index = operators.fnArray.findIndex((operation: number) => operation === OPS.paintImageXObject);
            assert.ok(index >= 0, `${kind}: decoded image must reach the canvas operator list`);
            const objectId = operators.argsArray[index][0];
            const decoded = await new Promise<{ data: Uint8Array }>(resolve => page.objs.get(objectId, resolve));
            assert.ok(decoded.data.length > 0, `${kind}: actual decoded pixel bytes`);
            if (kind === 'jpx') assert.deepEqual([...decoded.data.slice(0, 3)], [255, 0, 0]);
          }
        } finally { await task.destroy(); }
      }
    }
  } finally { globalThis.fetch = network; }
});



