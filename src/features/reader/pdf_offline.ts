/** Synthetic identifiers are looked up literally; they are never fetched or resolved as URLs. */
export const OFFLINE_PDF_BASE = 'topictrail-offline://pdfjs/';
export const offlinePdfOptions = {
  cMapUrl: OFFLINE_PDF_BASE + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: OFFLINE_PDF_BASE + 'standard_fonts/',
  wasmUrl: OFFLINE_PDF_BASE + 'wasm/',
  iccUrl: OFFLINE_PDF_BASE + 'iccs/',
  useWorkerFetch: true,
  useSystemFonts: false,
  useWasm: true,
  isEvalSupported: false,
};

/** Each result has its own buffer: PDF.js may transfer or mutate decoder/font bytes. */
export function createOfflineResourceLoader(assets: Readonly<Record<string, string>>) {
  return (url: string): Uint8Array<ArrayBuffer> => {
    const name = typeof url === 'string' && url.startsWith(OFFLINE_PDF_BASE)
      ? url.slice(OFFLINE_PDF_BASE.length) : '';
    if (!name || !Object.hasOwn(assets, name)) {
      throw new Error('Unknown offline PDF resource');
    }
    const binary = atob(assets[name]);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  };
}
