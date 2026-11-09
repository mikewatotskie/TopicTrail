import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Document as Syllabus, DocumentFormat } from '../src/core/models/document';
import type { ReaderMessage } from '../src/features/reader/selection';

// Real web Reader and selection actions, with document/transport/platform IO fixtures.
// Clipboard adapter is NOT mocked: it uses the navigator API installed below.
let dom: JSDOM, Reader: React.ComponentType;
const old = new Map<string, PropertyDescriptor | undefined>();
const io = {
  document: new Syllabus('fixture', 'Fictional syllabus', DocumentFormat.PDF, 'fixture-path', new Date()),
  emit: (_message: ReaderMessage) => {},
  writes: [] as string[], study: [] as { text: string }[], legacyCalls: 0,
  write: async (_value: string): Promise<void> => {},
};
before(async () => {
  dom = new JSDOM('<!doctype html><main></main>', { url: 'https://reader.test', pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async () => ({ ok: true, text: async () => '<html>Isolated reader fixture</html>' }) })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (value: string) => { io.writes.push(value); return io.write(value); } } });
  const boundaries: Record<string, string> = {
    'expo-router': `export const router={push(){},canGoBack:()=>false,replace(){}};export const useLocalSearchParams=()=>({documentId:'fixture'});`,
    'expo-asset': `export const Asset={fromModule:()=>({uri:'https://reader.test/fixture-html'})};`,
    'expo-clipboard': `export const setStringAsync=async()=>{io.legacyCalls++;return false};`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>null;Ionicons.glyphMap={};`,
    'expo-image': `export const Image=()=>null;`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    storage: `export const DocumentStorage={instance:{getDocument:async()=>io.document,updateLastOpened:async()=>{}}};`,
    content: `export const readDocumentBytes=async()=>new Uint8Array(10);`,
    docx: `export const DocxTextExtraction={instance:{extractParagraphs:async()=>['fixture']}};`,
    study: `export const useStudySelection=()=>({setSelection:value=>io.study.push(value)});`,
    theme: `import {TTLightColors} from './src/core/design/tokens';export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});export const useColors=useTheme;`,
    frame: `import React,{useEffect} from 'react';export function ReaderFrame(p){useEffect(()=>{io.emit=p.onMessage;p.onConnect({theme(){},dispose(){},load(){},page(){},zoom(){},selectAll(){},clearSelection(){}})},[]);return <div data-testid="fixture-reader"/>}`,
  };
  const output = await build({ stdin: { contents: `export {ReaderScreen} from './src/features/reader/ReaderScreen.web';`, loader: 'tsx', resolveDir: process.cwd() },
    write: false, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { 'react-native': 'react-native-web' }, loader: { '.svg': 'dataurl', '.html': 'text' },
    plugins: [{ name: 'reader-io', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const key = /document_storage$/.test(args.path) ? 'storage' : /document_content$/.test(args.path) ? 'content'
          : /docx_text_extraction$/.test(args.path) ? 'docx' : /StudySelectionContext$/.test(args.path) ? 'study'
            : /ThemeContext$/.test(args.path) ? 'theme' : /ReaderFrame.web$/.test(args.path) ? 'frame' : args.path;
        if (Object.hasOwn(boundaries, key)) return { path: key, namespace: 'io' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'io' }, args => ({ contents: boundaries[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'io', output.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports, io);
  Reader = (module.exports as { ReaderScreen: React.ComponentType }).ReaderScreen;
});
after(() => { dom?.window.close(); for (const [key, value] of old) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
async function mounted(run: () => Promise<void>) {
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.querySelector('main')!);
  io.writes = []; io.study = []; io.legacyCalls = 0;
  try {
    await act(async () => root.render(React.createElement(Reader)));
    await act(async () => { io.emit({ type: 'page', page: 1, totalPages: 1, hasText: true }); io.emit({ type: 'selection', text: '  Fictional loops 日本語\nexact  ', page: 1 }); });
    await run();
  } finally { await act(async () => root.unmount()); }
}
function button(label: string) {
  const element = dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"][role="button"]`); assert.ok(element); return element;
}
test('web Reader waits for a confirmed write and copies exact text, not an optimistic success', async () => {
  let finish!: () => void; io.write = () => new Promise<void>(resolve => { finish = resolve; });
  await mounted(async () => {
    await act(async () => button('Copy').click());
    assert.equal(dom.window.document.body.textContent?.includes('Selected text copied.'), false);
    assert.deepEqual(io.writes, ['  Fictional loops 日本語\nexact  ']);
    await act(async () => finish());
    assert.ok(dom.window.document.body.textContent?.includes('Selected text copied.'));
    assert.equal(io.legacyCalls, 0);
  });
});
test('web Reader reports rejected clipboard write, retains selection and can explicitly retry', async () => {
  io.write = async () => { throw new DOMException('Controlled denied clipboard', 'NotAllowedError'); };
  await mounted(async () => {
    await act(async () => button('Copy').click());
    assert.ok(dom.window.document.body.textContent?.includes('Clipboard access was denied.'));
    assert.equal(dom.window.document.body.textContent?.includes('Selected text copied.'), false);
    await act(async () => button('Study').click()); assert.equal(io.study[0].text, '  Fictional loops 日本語\nexact  ');
    io.write = async () => {}; await act(async () => button('Copy').click());
    assert.ok(dom.window.document.body.textContent?.includes('Selected text copied.')); assert.equal(io.legacyCalls, 0);
  });
});
test('web Reader missing clipboard API fails honestly without legacy execCommand fallback', async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')!;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  try {
    await mounted(async () => {
      await act(async () => button('Copy').click());
      assert.ok(dom.window.document.body.textContent?.includes('Clipboard access was denied.'));
      assert.equal(dom.window.document.body.textContent?.includes('Selected text copied.'), false);
      await act(async () => button('Study').click()); assert.equal(io.study[0].text, '  Fictional loops 日本語\nexact  ');
      assert.equal(io.legacyCalls, 0); assert.deepEqual(io.writes, []);
    });
  } finally { Object.defineProperty(navigator, 'clipboard', clipboard); }
});
test('web Reader does not publish stale clipboard feedback after selection changes during a write', async () => {
  let finish!: () => void; io.write = () => new Promise<void>(resolve => { finish = resolve; });
  await mounted(async () => {
    await act(async () => button('Copy').click());
    await act(async () => io.emit({ type: 'selection', text: 'A different fictional selection', page: 1 }));
    await act(async () => finish());
    assert.equal(dom.window.document.body.textContent?.includes('Selected text copied.'), false);
    await act(async () => button('Study').click()); assert.equal(io.study[0].text, 'A different fictional selection');
  });
});
