import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';

// Executes real RN components through RN Web in memory. No app, server or preview is started.
let ui: Record<string, React.ComponentType<any>>;
before(async () => {
const compiled = await build({ stdin: { contents: `export * from './src/components/TTCard'; export * from './src/components/TTButton'; export * from './src/components/TTInput'; export * from './src/components/TTReaderControls';`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
  alias: { 'react-native': 'react-native-web' }, loader: { '.svg': 'dataurl' },
  plugins: [{ name: 'native-boundaries', setup(build) {
    build.onResolve({ filter: /ThemeContext$/ }, () => ({ path: 'theme', namespace: 'test' }));
    build.onResolve({ filter: /^(@expo\/vector-icons|expo-image)$/ }, args => ({ path: args.path, namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ resolveDir: process.cwd(), loader: 'tsx', contents: args.path === 'theme'
      ? `import {TTLightColors} from '${resolve('src/core/design/tokens.ts').replaceAll('\\', '/')}'; export const useColors=()=>({colors:TTLightColors}); export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`
      : args.path === 'expo-image' ? `import React from 'react'; export const Image=({source,style})=>React.createElement('img',{src:typeof source==='string'?source:undefined,style,alt:''});`
      : `import React from 'react'; export const Ionicons=()=>React.createElement('span'); Ionicons.glyphMap={};` }));
  } }] });
const module = { exports: {} as Record<string, React.ComponentType<any>> };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
ui = module.exports;
});
function render(name: string, props: object) { return new JSDOM(renderToStaticMarkup(React.createElement(ui[name], props))).window.document; }

test('document card displays real metadata, upload date, and separate open/options actions', () => {
  const doc = render('TTDocumentCard', { title: 'Organic chemistry', format: 'docx', subtitle: 'DOCX · Text view · 42 KB',
    uploadedAt: new Date('2026-10-20T12:00:00Z'), onPress() {}, onMorePressed() {} });
  assert.match(doc.body.textContent!, /Organic chemistry/);
  assert.match(doc.body.textContent!, /DOCX · Text view · 42 KB/);
  assert.match(doc.body.textContent!, /Uploaded 20 Oct 2026/);
  assert.equal(doc.querySelectorAll('[role="button"]').length, 2);
  assert.equal(doc.querySelector('[aria-label="Open Organic chemistry"]')?.querySelector('[role="button"]'), null);
});

test('disabled upload action exposes disabled state and themed inactive colors', () => {
  const doc = render('TTButton', { label: 'Upload and continue', variant: 'study', disabled: true, onPress() {} });
  assert.equal(doc.querySelector('[role="button"]')?.getAttribute('aria-disabled'), 'true');
  assert.match(doc.head.textContent! + doc.body.innerHTML, /231,238,255|231, 238, 255|E7EEFF/i);
});

test('selection actions preserve Copy and Select All while preventing invalid Study', () => {
  const doc = render('TTTextSelectionMenu', { onCopy() {}, onSelectAll() {}, onStudy() {}, canStudy: false });
  assert.equal(doc.querySelector('[aria-label="Study"]')?.getAttribute('aria-disabled'), 'true');
  assert.equal(doc.querySelector('[aria-label="Copy"]')?.getAttribute('aria-disabled'), null);
  assert.ok(doc.querySelector('[aria-label="Select All"]'));
});

test('reader controls expose first/last navigation without enabling out-of-range page actions', () => {
  assert.equal(typeof ui.TTReaderControls, 'function', 'reader controls must preserve Flutter first/last navigation');
  const doc = render('TTReaderControls', { page: 1, pages: 1, zoom: 1, busy: false, onPage() {}, onZoom() {} });
  assert.equal(doc.querySelector('[aria-label="Previous page"]')?.getAttribute('aria-disabled'), 'true');
  assert.equal(doc.querySelector('[aria-label="Next page"]')?.getAttribute('aria-disabled'), 'true');
  assert.ok(doc.querySelector('[aria-label="Page navigation, 1 of 1"]'));
});

async function interact(name: string, props: object, action: (document: globalThis.Document, update: (props: object) => Promise<void>) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://component.test' });
  const scope = globalThis as unknown as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(scope, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.querySelector('main')!);
  const update = async (value: object) => { await act(async () => root.render(React.createElement(ui[name], value))); };
  try { await update(props); await action(dom.window.document, update); }
  finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(scope, key, descriptor); else delete scope[key];
    }
  }
}
async function press(document: globalThis.Document, label: string) {
  const button = document.querySelector<HTMLElement>('[aria-label="' + label + '"]');
  assert.ok(button, label);
  await act(async () => { button.click(); });
}

test('reader controls invoke exact page targets and bounded zoom through real component events', async () => {
  const pages: number[] = [], zooms: number[] = [];
  const props = { page: 2, pages: 5, zoom: 0.5, busy: false, onPage: (page: number) => pages.push(page), onZoom: (zoom: number) => zooms.push(zoom) };
  await interact('TTReaderControls', props, async (document, update) => {
    await press(document, 'Previous page'); await press(document, 'Next page');
    await press(document, 'Page navigation, 2 of 5'); await press(document, 'Last page');
    await press(document, 'Page navigation, 2 of 5'); await press(document, 'First page');
    assert.deepEqual(pages, [1, 3, 5, 1]);
    await press(document, 'Zoom out'); await press(document, 'Zoom in');
    assert.deepEqual(zooms, [0.75]);
    await update({ ...props, busy: true });
    await press(document, 'Previous page'); await press(document, 'Next page'); await press(document, 'Zoom in');
    assert.deepEqual(pages, [1, 3, 5, 1]); assert.deepEqual(zooms, [0.75]);
  });
});

test('selection menu dispatches Copy and Select All and gates Study until valid', async () => {
  const actions: string[] = [];
  const props = { canStudy: false, onCopy: () => actions.push('copy'), onSelectAll: () => actions.push('all'), onStudy: () => actions.push('study') };
  await interact('TTTextSelectionMenu', props, async (document, update) => {
    await press(document, 'Copy'); await press(document, 'Select All'); await press(document, 'Study');
    assert.deepEqual(actions, ['copy', 'all']);
    await update({ ...props, canStudy: true }); await press(document, 'Study');
    assert.deepEqual(actions, ['copy', 'all', 'study']);
  });
});


