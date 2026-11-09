import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import React, { act } from 'react';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// Actual theme, safe-area web implementation and TTScreen. Only storage/image IO is replaced.
let ui: { Harness: React.ComponentType<{ width?: number }> };
let dom: JSDOM;
const previous = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  dom = new JSDOM('<!doctype html><html><head></head><body><main></main></body></html>', { url: 'https://artwork.test', pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {} }) });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot,
    IS_REACT_ACT_ENVIRONMENT: true, __authArtworkStoredTheme: 'light' })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const boundaries: Record<string, string> = {
    '@react-native-async-storage/async-storage': `export default {getItem:async()=>globalThis.__authArtworkStoredTheme,setItem:async()=>{}};`,
    'expo-image': `import React from 'react';export const Image=({source,style,contentFit})=>React.createElement('img',{src:source,style,alt:'','data-content-fit':contentFit});`,
  };
  const compiled = await build({ stdin: { contents: `import React from 'react';import {Text,View} from 'react-native';import {SafeAreaProvider} from 'react-native-safe-area-context';import {ThemeProvider,useTheme} from './src/core/theme/ThemeContext';import {TTScreen} from './src/components/TTScreen';import {AuthStudyIllustration} from './src/features/auth/AuthStudyIllustration';function Probe(){const {colorScheme,isInitialized}=useTheme();return <Text testID="theme-probe">{isInitialized?colorScheme:'loading'}</Text>;}export function Harness({width=472}){return <SafeAreaProvider initialMetrics={{frame:{x:0,y:0,width:1024,height:768},insets:{top:0,left:0,right:0,bottom:0}}}><ThemeProvider><TTScreen><Probe/><View style={{width}}><AuthStudyIllustration/></View></TTScreen></ThemeProvider></SafeAreaProvider>;}`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
    alias: { 'react-native': 'react-native-web', 'react-native-safe-area-context': resolve('node_modules/react-native-safe-area-context/src/index.tsx') },
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.json'], loader: { '.svg': 'dataurl' },
    plugins: [{ name: 'artwork-platform-io', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'io' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'io' }, args => ({ contents: boundaries[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(resolve('package.json')), module, module.exports);
  ui = module.exports as typeof ui;
});
after(() => {
  dom?.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
async function mounted(theme: 'light' | 'dark', run: (doc: Document) => void, width = 472) {
  Reflect.set(globalThis, '__authArtworkStoredTheme', theme);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.querySelector('main')!);
  try {
    await act(async () => root.render(React.createElement(ui.Harness, { width })));
    assert.equal(dom.window.document.querySelector('[data-testid="theme-probe"]')?.textContent, theme);
    await run(dom.window.document);
  } finally { await act(async () => root.unmount()); }
}

test('light TTScreen paints the approved shared canvas through the actual theme consumer', async () => {
  await mounted('light', doc => {
    const content = doc.querySelector<HTMLElement>('[data-testid^="screen-content-"]')!;
    assert.equal(content.style.backgroundColor, 'rgb(245, 245, 245)');
    assert.equal(content.parentElement!.style.backgroundColor, 'rgb(245, 245, 245)');
  });
});

function textNode(doc: Document, value: string) {
  const node = [...doc.querySelectorAll<HTMLElement>('[dir="auto"]')].find(node => node.textContent === value);
  assert.ok(node, `illustration contains ${value}`);
  return node;
}
function assetSource(image: HTMLImageElement) {
  const source = image.getAttribute('src')!;
  const comma = source.indexOf(',');
  return source.slice(0, comma).endsWith(';base64')
    ? Buffer.from(source.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(source.slice(comma + 1));
}

test('illustration explains a highlighted syllabus topic leading to fictional guide and practice resources', async () => {
  await mounted('light', doc => {
    for (const value of ['Programming basics', 'Variables', 'Loops & iteration', 'Functions', 'Study', 'Learning guide', 'Understand loops', 'Practice', 'Explore an example']) textNode(doc, value);
    assert.equal(textNode(doc, 'Loops & iteration').parentElement!.style.backgroundColor, 'rgb(255, 204, 0)');
    assert.equal(textNode(doc, 'Loops & iteration').style.color, 'rgb(21, 27, 38)');
    assert.equal(textNode(doc, 'Study').parentElement!.style.backgroundColor, 'rgb(255, 204, 0)');
    assert.doesNotMatch(doc.querySelector('[data-testid="auth-study-illustration"]')!.textContent!, /verified|screened|free|safe|credibility|Khan|Coursera/i);
  });
});

for (const [theme, assets] of [
  ['light', ['97848.svg', '864ce.svg', 'db7e2.svg', '69b08.svg']],
  ['dark', ['4cb43.svg', '4e7c1.svg', '8198b.svg', '26756.svg']],
] as const) test(`${theme} illustration uses approved theme exports without squeezing the aura or trail`, async () => {
  await mounted(theme, doc => {
    const images = [...doc.querySelectorAll<HTMLImageElement>('[data-testid="auth-study-illustration"] img')];
    assert.equal(images.length, 4);
    for (const file of assets) {
      const expected = readFileSync(resolve('src/assets/figma', file), 'utf8');
      const image = images.find(image => assetSource(image) === expected);
      assert.ok(image, `actual themed asset ${file}`);
      assert.equal(image.getAttribute('data-content-fit'), 'contain');
      if (file === assets[0]) {
        assert.equal(image.style.width, '368px'); assert.equal(image.style.height, '272px');
        assert.equal(image.parentElement!.style.overflow, '');
      } else if (file === assets[3]) {
        assert.equal(image.style.width, '82px'); assert.equal(image.style.height, '94px');
        const backing = image.parentElement!.parentElement!;
        assert.equal(backing.style.backgroundColor, 'rgb(0, 51, 153)');
        assert.equal(backing.style.padding, '12px');
      } else {
        assert.equal(image.style.width, '24px'); assert.equal(image.style.height, '24px');
      }
    }
    assert.equal(textNode(doc, 'Understand loops').style.color, theme === 'light' ? 'rgb(19, 33, 59)' : 'rgb(245, 247, 252)');
    assert.equal(textNode(doc, 'Learning guide').parentElement!.style.backgroundColor, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(17, 29, 50)');
  });
});

test('illustration subtree is hidden from assistive technology and has no interactive or focusable descendants', async () => {
  await mounted('light', doc => {
    const illustration = doc.querySelector<HTMLElement>('[data-testid="auth-study-illustration"]')!;
    assert.equal(illustration.getAttribute('aria-hidden'), 'true');
    assert.equal(dom.window.getComputedStyle(illustration).pointerEvents, 'none');
    assert.equal(illustration.querySelector('button,a,input,select,textarea,[role="button"],[tabindex]:not([tabindex="-1"])'), null);
    assert.equal(textNode(doc, 'Study').closest('[role="button"]'), null);
  });
});

test('illustration allows natural flex sizing at the minimum and roomy desktop intro widths', async () => {
  for (const width of [472, 604]) await mounted('light', doc => {
    const illustration = doc.querySelector<HTMLElement>('[data-testid="auth-study-illustration"]')!;
    assert.equal(illustration.parentElement!.style.width, `${width}px`);
    assert.equal(illustration.style.width, '100%'); assert.equal(illustration.style.minWidth, '0px');
    assert.equal(illustration.style.height, ''); assert.equal(illustration.style.overflow, '');
    const composition = textNode(doc, 'Programming basics').parentElement!.parentElement!;
    assert.equal(composition.style.flexDirection, 'row'); assert.equal(composition.style.flexWrap, 'wrap');
    assert.equal(composition.style.height, '');
    assert.equal(textNode(doc, 'Programming basics').parentElement!.style.position, '');
    assert.equal(textNode(doc, 'Understand loops').parentElement!.style.position, '');
  }, width);
});

test('dark TTScreen retains its independent canvas after a stored theme resolves', async () => {
  await mounted('dark', doc => {
    const content = doc.querySelector<HTMLElement>('[data-testid^="screen-content-"]')!;
    assert.equal(content.style.backgroundColor, 'rgb(11, 18, 32)');
    assert.equal(content.parentElement!.style.backgroundColor, 'rgb(11, 18, 32)');
  });
});
