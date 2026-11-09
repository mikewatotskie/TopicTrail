import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const supportedVersion = '6.4.299';

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('PDF.js offline adapter no longer matches installed source');
  return source.replace(before, after);
}

/** Adapt the three external-resource paths in this exact PDF.js release, without changing its parser. */
export async function buildOfflineWorker() {
  const { version } = JSON.parse(await readFile(resolve(pdfRoot, 'package.json'), 'utf8'));
  if (version !== supportedVersion) throw new Error(`Review the offline PDF.js adapter before upgrading from ${supportedVersion} to ${version}`);
  const assets = {};
  const manifest = { pdfjsVersion: version, resources: {}, licenses: [],
    delivery: 'All resources and decoder JavaScript are embedded in viewer.html; no network or local-file fetch.',
    adapter: 'Worker binary/synchronous reads use literal allowlisted bytes; JPEG2000/JBIG2 fallback imports are bundled inline.' };
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const name of (await readdir(resolve(pdfRoot, directory))).sort()) {
      // QuickJS executes PDF scripting, which the reader does not expose or enable.
      if (name.startsWith('quickjs-')) continue;
      const bytes = await readFile(resolve(pdfRoot, directory, name));
      const key = directory + '/' + name;
      if (name.startsWith('LICENSE')) {
        manifest.licenses.push(directory + '-' + name + '.txt');
      } else {
        manifest.resources[key] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        // Decoder helpers are compiled into the worker, rather than stored as inert base64 strings.
        if (!name.endsWith('.js')) assets[key] = bytes.toString('base64');
      }
    }
  }
  let source = await readFile(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'), 'utf8');
  source = replaceOnce(source, `async function fetchBinaryData(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(\`Failed to fetch file "\${url}" with "\${response.statusText}".\`);
  }
  return response.bytes();
}`, 'async function fetchBinaryData(url) { return topicTrailLoadResource(url); }');
  source = replaceOnce(source, `function fetchSync(url) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.responseType = "arraybuffer";
  xhr.send(null);
  return xhr.response;
}`, 'function fetchSync(url) { return topicTrailLoadResource(url).buffer; }');
  source = replaceOnce(source, `await import(
      /*webpackIgnore: true*/
      /*@vite-ignore*/
      \`\${WasmImage.#wasmUrl}\${this._noWasmFilename}\`)`, 'await topicTrailDecoderModule(this._noWasmFilename)');
  const helper = resolve('src/features/reader/pdf_offline.ts').replaceAll('\\', '/');
  const preamble = `import { createOfflineResourceLoader } from ${JSON.stringify(helper)};
import OfflineOpenJPEG from '../../wasm/openjpeg_nowasm_fallback.js';
import OfflineJBig2 from '../../wasm/jbig2_nowasm_fallback.js';
const topicTrailLoadResource = createOfflineResourceLoader(PDF_OFFLINE_ASSETS);
async function topicTrailDecoderModule(name) {
  if (name === 'openjpeg_nowasm_fallback.js') return { default: OfflineOpenJPEG };
  if (name === 'jbig2_nowasm_fallback.js') return { default: OfflineJBig2 };
  throw new Error('Unknown offline PDF decoder');
}
`;
  const worker = await build({ stdin: { contents: preamble + source.replaceAll('import.meta.url', JSON.stringify('topictrail-offline://pdfjs/wasm/')), resolveDir: resolve(pdfRoot, 'legacy/build'), loader: 'js' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome108', minify: true, write: false,
    define: { PDF_OFFLINE_ASSETS: JSON.stringify(assets) },
    plugins: [{ name: 'offline-decoder-import-meta', setup(bundler) {
      bundler.onLoad({ filter: /(?:openjpeg|jbig2)_nowasm_fallback\.js$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8')).replaceAll('import.meta.url', JSON.stringify('topictrail-offline://pdfjs/wasm/')),
        loader: 'js',
      }));
    } }],
  });
  return { code: worker.outputFiles[0].text, manifest };
}

export async function bundleReader() {
  const worker = await buildOfflineWorker();
  const reader = await build({ entryPoints: ['src/features/reader/reader_web.ts'], bundle: true,
    format: 'iife', platform: 'browser', target: 'chrome108', minify: true, write: false,
    define: { PDF_WORKER_SOURCE: JSON.stringify(worker.code) } });
  const viewerCss = await readFile(require.resolve('pdfjs-dist/web/pdf_viewer.css'), 'utf8');
  const textCss = viewerCss.slice(viewerCss.indexOf('.textLayer {'), viewerCss.indexOf('.textLayerImages {'));
  const css = await transform(textCss, { loader: 'css', target: 'chrome108', minify: true });
  const customCss = 'html{overflow-y:scroll}body{margin:0;padding:16px;background:#F7F9FC;color:#13213B}#content{position:relative;margin:0 auto;max-width:100%;box-sizing:border-box}#content.pdf{max-width:none;background:white}#content.docx{max-width:688px;border:1px solid #718096;border-radius:12px;padding:16px;background:white;font-family:Inter,sans-serif;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}p{margin:0 0 16px}canvas{display:block}.textLayer{z-index:1}[data-theme=dark] body{background:#0B1220;color:#F5F7FC}[data-theme=dark] #content.docx{background:#111D32;border-color:#627897}::selection{background:#B4CBFF}';
  const font = (await readFile('src/assets/fonts/Inter-Regular.ttf')).toString('base64');
  const notices = { 'PDFJS-LICENSE.txt': await readFile(require.resolve('pdfjs-dist/LICENSE'), 'utf8') };
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const name of await readdir(resolve(pdfRoot, directory))) {
      if (name.startsWith('LICENSE')) notices[directory + '-' + name + '.txt'] = await readFile(resolve(pdfRoot, directory, name), 'utf8');
    }
  }
  // Metro only imports viewer.html, so notices must be carried in that asset too.
  const noticeJson = JSON.stringify(notices).replaceAll('<', '\\u003c');
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'wasm-unsafe-eval\' blob:; worker-src blob:; style-src \'unsafe-inline\'; font-src data: blob:; img-src data: blob:; connect-src \'none\'"><style>@font-face{font-family:Inter;src:url(data:font/ttf;base64,' + font + ')}' + css.code + customCss + '</style></head><body><main id="content" aria-label="Syllabus document"></main><script>' + reader.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
  const outputHtml = html.replace('</main><script>', '</main><script type="application/json" id="pdfjs-third-party-notices">' + noticeJson + '</script><script>');
  await mkdir('assets/reader/licenses', { recursive: true });
  await writeFile('assets/reader/viewer.html', outputHtml);
  await writeFile('assets/reader/PDFJS-LICENSE.txt', await readFile(require.resolve('pdfjs-dist/LICENSE')));
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const name of await readdir(resolve(pdfRoot, directory))) {
      if (name.startsWith('LICENSE')) await writeFile('assets/reader/licenses/' + directory + '-' + name + '.txt', await readFile(resolve(pdfRoot, directory, name)));
    }
  }
  await writeFile('assets/reader/manifest.json', JSON.stringify(worker.manifest, null, 2) + '\n');
  console.log('Bundled offline reader: ' + Buffer.byteLength(outputHtml).toLocaleString('en-US') + ' bytes');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bundleReader();

