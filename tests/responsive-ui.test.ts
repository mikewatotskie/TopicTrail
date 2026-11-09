import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

let ui: Record<string, React.ComponentType<any>> & { viewport: { width: number } };
before(async () => {
  const tokens = resolve('src/core/design/tokens.ts').replaceAll('\\', '/');
  const mocks: Record<string, string> = {
    'react-native': `export * from 'react-native-web';export const viewport={width:1920};export const useWindowDimensions=()=>({width:viewport.width,height:1080,scale:1,fontScale:1});`,
    'react-native-safe-area-context': `export {View as SafeAreaView} from 'react-native-web';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    'expo-router': `import {useEffect} from 'react';export const useFocusEffect=cb=>useEffect(cb,[cb]);export const router={push(){},navigate(){},back(){},canGoBack:()=>true};`,
    'expo-image': `import React from 'react';export const Image=()=>React.createElement('span');`,
    '@expo/vector-icons': `import React from 'react';export const Ionicons=()=>React.createElement('span');Ionicons.glyphMap={};`,
    theme: `import {TTLightColors} from '${tokens}';export const useColors=()=>({colors:TTLightColors});export const useTheme=()=>({colors:TTLightColors,colorScheme:'light'});`,
    storage: `export const DocumentStorage={instance:{getAllDocuments:async()=>[]}};`,
    bookmarks: `export const useBookmarks=()=>({status:'ready',bookmarks:[],retry(){}});export const savedDate=()=>'';export const useBookmarkAction=()=>({});`,
    details: `export const ResourceDetails=()=>null;`,
  };
  const result = await build({ stdin: { contents: `export {TTScreen} from './src/components/TTScreen';export {TTButton} from './src/components/TTButton';export {TTEmptyState,TTUploadDocumentCard} from './src/components/TTCard';export {HomeScreen} from './src/features/home/HomeScreen';export {SavedScreen} from './src/features/saved/SavedScreen';export {viewport} from 'react-native';`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.svg': 'dataurl' }, plugins: [{ name: 'viewport-io', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const key = /ThemeContext$/.test(args.path) ? 'theme' : /document_storage$/.test(args.path) ? 'storage' : /useBookmarks$/.test(args.path) ? 'bookmarks' : /ResourceDetails$/.test(args.path) ? 'details' : args.path;
        if (key in mocks) return { path: key, namespace: 'io' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'io' }, args => ({ contents: mocks[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }] });
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  ui = module.exports as typeof ui;
});

async function mounted(element: React.ReactNode, run: (doc: globalThis.Document) => Promise<void> | void) {
  const dom = new JSDOM('<!doctype html><main></main>');
  const old = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  const { createRoot } = await import('react-dom/client'); const root = createRoot(dom.window.document.querySelector('main')!);
  try {
    await act(async () => root.render(element));
    // RN-web initializes before JSDOM. Install its actual generated CSS for parent flex rules.
    const { StyleSheet } = createRequire(resolve('package.json'))('react-native-web');
    const sheet = dom.window.document.createElement('style'); sheet.textContent = StyleSheet.getSheet().textContent;
    dom.window.document.head.append(sheet);
    await run(dom.window.document);
  }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, value] of old) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } }
}
function action(doc: globalThis.Document, label: string) {
  const button = doc.querySelector<HTMLElement>(`[role="button"][aria-label="${label}"]`);
  assert.ok(button, label); return button;
}
function responsive(button: HTMLElement, width: number, align: 'flex-start' | 'center') {
  assert.equal(button.style.width, width < 768 ? '100%' : 'auto');
  assert.equal(button.style.maxWidth, '100%'); assert.equal(button.style.alignSelf, align);
  assert.equal(button.style.minHeight, '48px'); assert.equal(button.style.height, 'auto');
}

for (const [variant, expected] of [['standard', '1440px'], ['form', '800px'], ['reader', '1600px']] as const)
  test(`desktop ${variant} screen uses readable responsive width`, async () => {
    ui.viewport.width = 1920;
    await mounted(React.createElement(ui.TTScreen, { variant }, React.createElement('span', { 'data-probe': true })), doc => {
      assert.equal(doc.querySelector('[data-probe]')!.parentElement!.style.maxWidth, expected);
    });
  });

test('home_actions_are_intrinsic_on_desktop', async () => {
  for (const width of [768, 1024, 1920]) {
    ui.viewport.width = width;
    await mounted(React.createElement(ui.HomeScreen), doc => {
      // Production cards stretch in their column; action alignment must override that inheritance.
      const upload = action(doc, 'Upload syllabus'); const saved = action(doc, 'Open saved resources');
      for (const button of [upload, saved]) {
        assert.equal(doc.defaultView!.getComputedStyle(button.parentElement!).display, 'flex');
        responsive(button, width, 'flex-start');
      }
      assert.equal(saved.parentElement!.style.maxWidth, '640px');
      const heroTitle = [...doc.querySelectorAll<HTMLElement>('*')].find(el => el.childNodes.length === 1 && el.textContent === 'Study from your syllabus')!;
      assert.equal(heroTitle.style.maxWidth, '640px');
    });
  }
});

test('empty_state_actions_are_centered_and_responsive', async () => {
  for (const width of [320, 767, 768, 1920]) {
    ui.viewport.width = width;
    await mounted(React.createElement('div', { style: { display: 'flex', alignItems: 'stretch', width } },
      React.createElement(ui.TTEmptyState, { title: 'Empty', message: 'Supporting copy', actionLabel: 'Try again', onAction() {} })), doc => {
      const button = action(doc, 'Try again'); responsive(button, width, 'center');
      const group = button.parentElement!; assert.equal(group.style.alignItems, 'center');
      assert.equal(group.parentElement!.style.maxWidth, '640px'); assert.equal(group.parentElement!.style.width, '100%');
      const copy = [...group.children].find(el => el.textContent === 'Supporting copy') as HTMLElement;
      assert.equal(copy.style.maxWidth, '480px');
    });
  }
});

test('responsive_policy_overrides_legacy_expansion', async () => {
  for (const width of [390, 768, 1366]) {
    ui.viewport.width = width;
    await mounted(React.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', width } },
      React.createElement(ui.TTButton, { label: 'An unusually long action label that must wrap', onPress() {}, isExpanded: true, size: 'fullWidth', widthPolicy: 'responsiveAction',
        style: { width: 2000, minWidth: 1800, maxWidth: 2000, height: 12, minHeight: 8, maxHeight: 12, alignSelf: 'stretch', flex: 1 } })), doc => {
      const button = action(doc, 'An unusually long action label that must wrap');
      assert.equal(button.parentElement!.style.alignItems, 'stretch'); responsive(button, width, 'flex-start');
      assert.equal(button.style.minWidth, '0px'); assert.equal(button.style.maxHeight, '');
      assert.equal(button.style.flexGrow, '0'); assert.equal(button.style.flexShrink, '1'); assert.equal(button.style.flexBasis, 'auto');
    });
  }
});

test('legacy_full_width_buttons_are_preserved', async () => {
  for (const width of [390, 1920]) {
    ui.viewport.width = width;
    await mounted(React.createElement('div', { style: { display: 'flex', alignItems: 'stretch' } },
      React.createElement(ui.TTUploadDocumentCard, { onTap() {} }),
      React.createElement(ui.TTButton, { label: 'Expanded legacy', isExpanded: true, onPress() {} }),
      React.createElement(ui.TTButton, { label: 'Caller legacy', size: 'fullWidth', style: { width: 123 }, onPress() {} })), doc => {
      assert.equal(action(doc, 'Choose file').style.width, '100%'); assert.equal(action(doc, 'Expanded legacy').style.width, '100%');
      assert.equal(action(doc, 'Caller legacy').style.width, '123px');
    });
  }
});

test('saved_search_and_supporting_prose_are_readable', async () => {
  ui.viewport.width = 1920;
  await mounted(React.createElement(ui.SavedScreen), doc => {
    const search = doc.querySelector<HTMLInputElement>('[aria-label="Search saved resources"]')!;
    assert.equal(search.parentElement!.parentElement!.style.maxWidth, '640px');
    const prose = [...doc.querySelectorAll<HTMLElement>('*')].find(el => el.childNodes.length === 1 && el.textContent?.startsWith('Saved links open online.'))!;
    assert.equal(prose.style.maxWidth, '640px'); responsive(action(doc, 'Open My Syllabi'), 1920, 'center');
  });
});
