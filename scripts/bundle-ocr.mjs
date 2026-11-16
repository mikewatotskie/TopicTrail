import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const VERSION = '7.0.0';
const MODEL_VERSION = '1.0.0';
const hashes = {
  worker: '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
  core: '6510efc4e8b45c5465df30679b9911ffe0071cd2ee982fa064e6f5136ef2de85',
  wasm: '66b17df6e20c5329a17ffa9c202a47eaa3e32500b253d4c7f38e7f2bc01457c3',
  english: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
  filipino: '2b17f68014ab44b88b5e2334ebcd0ce0090d9af7c6fbef6fab22e0bbd9a934dd',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Strict, reviewed memory-limit adaptation for this exact non-SIMD Tesseract LSTM core. */
export function capOcrWasmMemory(bytes) {
  if (sha(bytes) !== hashes.wasm) throw new Error('Review the OCR WASM before using a different core build.');
  let cursor = 8;
  const integer = index => {
    let value = 0, shift = 0;
    for (let count = 0; count < 5; count++) {
      const byte = bytes[index++];
      if (byte === undefined) throw new Error('Truncated OCR WASM');
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return { value, end: index };
      shift += 7;
    }
    throw new Error('Invalid OCR WASM integer');
  };
  while (cursor < bytes.length) {
    const section = bytes[cursor], length = integer(cursor + 1), end = length.end + length.value;
    if (end > bytes.length) throw new Error('Invalid OCR WASM section');
    if (section === 5) {
      // Original: one nonshared memory, initial264 pages, maximum32768 pages (2GiB).
      const expected = Buffer.from([1, 1, 136, 2, 128, 128, 2]);
      if (!Buffer.from(bytes.subarray(length.end, end)).equals(expected)) throw new Error('OCR memory contract changed');
      // New maximum4096 pages=256MiB. Keep initial memory, functions and all other sections unchanged.
      const replacement = Buffer.from([5, 6, 1, 1, 136, 2, 128, 32]);
      const patched = Buffer.concat([bytes.subarray(0, cursor), replacement, bytes.subarray(end)]);
      if (!WebAssembly.validate(patched)) throw new Error('Bounded OCR WASM did not validate');
      return patched;
    }
    cursor = end;
  }
  throw new Error('OCR WASM has no expected memory section');
}

/** All bytes are read at build time. No model/core/worker network fetch occurs in the reader. */
export async function buildOfflineOcr(options = {}) {
  const roots = options.packageRoots ?? {
    worker: dirname(require.resolve('tesseract.js/package.json')),
    core: dirname(require.resolve('tesseract.js-core/package.json')),
    english: dirname(require.resolve('@tesseract.js-data/eng/package.json')),
  };
  for (const [name, root] of Object.entries(roots)) {
    const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    if (metadata.version !== (name === 'english' ? MODEL_VERSION : VERSION)) throw new Error('Review the offline OCR adapter before upgrading ' + metadata.name);
  }
  const files = {
    worker: resolve(roots.worker, 'dist/worker.min.js'),
    core: resolve(roots.core, 'tesseract-core-lstm.js'),
    wasm: resolve(roots.core, 'tesseract-core-lstm.wasm'),
    english: resolve(roots.english, '4.0.0_best_int/eng.traineddata.gz'),
    filipino: fileURLToPath(new URL('./ocr-models/fil.traineddata', import.meta.url)),
  };
  const assets = {};
  const resources = {};
  for (const [name, path] of Object.entries(files)) {
    assets[name] = await readFile(path);
    const digest = sha(assets[name]);
    if (digest !== hashes[name]) throw new Error('OCR source hash mismatch: ' + name);
    resources[name] = { bytes: assets[name].length, sha256: digest };
  }
  const wasm = capOcrWasmMemory(assets.wasm);
  const coreLicense = await readFile(resolve(roots.core, 'LICENSE'), 'utf8');
  const licenses = {
    'FILIPINO-TRAINEDDATA-NOTICE.txt': 'Filipino (fil) LSTM model from tesseract-ocr/tessdata_fast at 87416418657359cb625c412a48b6e1d6d41c29bd. https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/fil.traineddata\nApache-2.0 license text:\n' + coreLicense,
    'TESSERACT-JS-LICENSE.txt': await readFile(resolve(roots.worker, 'LICENSE.md'), 'utf8'),
    'TESSERACT-WORKER-NOTICES.txt': await readFile(resolve(roots.worker, 'dist/worker.min.js.LICENSE.txt'), 'utf8'),
    'TESSERACT-CORE-LICENSE.txt': coreLicense,
    'ENGLISH-TRAINEDDATA-NOTICE.txt': 'English 4.0.0_best_int traineddata from @tesseract.js-data/eng 1.0.0. Package metadata declares MIT; the model repository naptha/tessdata carries Apache-2.0. Repository license verified at commit806cd9adc8c6e8abc11c782db1818c990576bebc: https://github.com/naptha/tessdata/blob/806cd9adc8c6e8abc11c782db1818c990576bebc/LICENSE\n\nApache-2.0 license text:\n' + coreLicense,
  };
  const prefix = `'use strict';
const topicTrailDenied = () => { throw new Error('External OCR resources are disabled.'); };
Object.defineProperty(self, 'fetch', {value:()=>Promise.reject(new Error('External OCR resources are disabled.')),writable:false,configurable:false});
for (const name of ['XMLHttpRequest','WebSocket','EventSource','importScripts']) Object.defineProperty(self,name,{value:topicTrailDenied,writable:false,configurable:false});
function topicTrailBytes(base64) { const text=atob(base64), bytes=new Uint8Array(text.length); for(let i=0;i<text.length;i++) bytes[i]=text.charCodeAt(i); return bytes; }
const topicTrailWasm=topicTrailBytes(${JSON.stringify(wasm.toString('base64'))});
const topicTrailEnglish=topicTrailBytes(${JSON.stringify(assets.english.toString('base64'))});
const topicTrailFilipino=topicTrailBytes(${JSON.stringify(assets.filipino.toString('base64'))});
`;
  const bridge = `
const topicTrailCoreFactory=TesseractCore;
Object.defineProperty(self,'TesseractCore',{value:options=>topicTrailCoreFactory({...options,wasmBinary:topicTrailWasm,print:()=>{},printErr:()=>{}}),writable:false});
const topicTrailSend=self.postMessage.bind(self);
let topicTrailLastPacket;
self.postMessage=packet=>{
  if(packet.action==='loadLanguage'&&packet.status==='resolve') packet={...packet,data:['eng','fil']};
  if(packet.action==='recognize'&&packet.status==='resolve') packet={...packet,data:{text:packet.data.text,confidence:packet.data.confidence}};
  topicTrailSend(packet);
};
self.addEventListener('unhandledrejection',event=>{
  event.preventDefault();
  if(topicTrailLastPacket) topicTrailSend({...topicTrailLastPacket,payload:undefined,status:'reject',data:'Offline OCR initialization failed.'});
});
self.addEventListener('message',event=>{
  const p=event.data;
  const reject=()=>{event.stopImmediatePropagation();topicTrailSend({jobId:p?.jobId,action:p?.action,status:'reject',data:'Invalid offline OCR request.'});};
  if(!p||typeof p.jobId!=='string'||!['load','loadLanguage','initialize','recognize'].includes(p.action)) return reject();
  topicTrailLastPacket={workerId:p.workerId,jobId:p.jobId,action:p.action};
  if(p.action==='load') p.payload={options:{lstmOnly:true,logging:false}};
   // Tesseract.js 7 detects gzip by each byte array's magic, not this URL-suffix option.
   // English is gzipped; the official Filipino model is raw. Neither is a URL/string language.
   else if(p.action==='loadLanguage') p.payload={langs:[{code:'eng',data:topicTrailEnglish},{code:'fil',data:topicTrailFilipino}],options:{cacheMethod:'none',lstmOnly:true,gzip:false}};
  else if(p.action==='initialize') p.payload={langs:'eng+fil',oem:1,config:{user_defined_dpi:'300'}};
  else {
    const image=p.payload?.image;
    if(!(image instanceof Uint8Array)||image.length<24||image.length>16777216||image[0]!==137||image[1]!==80||image[2]!==78||image[3]!==71||image[12]!==73||image[13]!==72||image[14]!==68||image[15]!==82) return reject();
    const view=new DataView(image.buffer,image.byteOffset,image.byteLength),w=view.getUint32(16),h=view.getUint32(20);
    if(!w||!h||w>8192||h>8192||w*h>4000000) return reject();
    p.payload={image,options:{rotateAuto:true},output:{text:true,blocks:false}};
  }
});
`;
  // Standalone photo workers carry the same upstream notices as the reader asset.
  const notices = Object.entries(licenses).map(([name, text]) => name + '\n' + text).join('\n\n').replaceAll('*/', '* /');
  const workerSource = prefix + '\n/*\n' + notices + '\n*/\n' + assets.core.toString('utf8') + bridge + assets.worker.toString('utf8').replace(/\n?\/\/# sourceMappingURL=.*(?:\r?\n|$)/g, '');
  const manifest = {
    tesseractVersion: VERSION, coreVersion: VERSION, englishPackageVersion: MODEL_VERSION,
    resources, boundedWasm: { bytes: wasm.length, sha256: sha(wasm), maximumBytes: 256 * 1024 * 1024 },
    worker: { bytes: Buffer.byteLength(workerSource), sha256: sha(workerSource) },
    limits: { pixels: 4_000_000, dimension: 8192, pngBytes: 16 * 1024 * 1024, oneJob: true, jobTimeoutMs: 120000 },
    languages: ['eng', 'fil'],
    delivery: 'Core, worker, WASM and both models embedded. Worker fetch/XHR/importScripts/WebSocket/EventSource denied; no runtime network or persistent model cache.',
    adapter: 'Hash-pinned non-SIMD LSTM core with a 256MiB WASM memory maximum. Both language models are supplied through the upstream byte-data API; v7 detects per-model gzip magic. Standalone worker carries license notices.',
  };
  return { workerSource, manifest, licenses };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildOfflineOcr();
  const output = resolve('work/overnight-implementation/ocr');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'ocr.worker.js'), result.workerSource);
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(result.manifest, null, 2));
  await writeFile(resolve(output, 'licenses.json'), JSON.stringify(result.licenses, null, 2));
  console.log('Prepared offline OCR worker: ' + result.manifest.worker.bytes + ' bytes');
}
