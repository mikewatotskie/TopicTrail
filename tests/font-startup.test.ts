import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { TTTypography } from '../src/core/design/tokens';

function runFontHook(hook: URL, requireModule: (name: string) => unknown) {
  const source = readFileSync(hook, 'utf8');
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} as { useAppFonts(): [boolean, Error | null] } };
  runInNewContext(code, { module, exports: module.exports, require: requireModule });
  return module.exports.useAppFonts();
}

test('Android can render immediately without opening any font through the Expo runtime cache', () => {
  const hook = new URL('../src/core/theme/useAppFonts.android.ts', import.meta.url);
  const [ready, error] = runFontHook(hook, name => {
    throw new Error('Unexpected startup font dependency ' + name);
  });
  assert.equal(ready, true);
  assert.equal(error, null);
});

test('the web and iOS hook supplies a bundled TrueType font for each design-system family', () => {
  const hook = new URL('../src/core/theme/useAppFonts.ts', import.meta.url);
  const families = new Set(Object.values(TTTypography).map(style =>
    typeof style === 'string' ? style : style.fontFamily));
  let requests = 0;
  const [ready, error] = runFontHook(hook, name => {
    if (name === 'expo-font') return {
      useFonts(fonts: Record<string, Buffer>) {
        requests++;
        assert.deepEqual(new Set(Object.keys(fonts)), families);
        for (const asset of Object.values(fonts)) assert.equal(asset.readUInt32BE(0), 0x00010000);
        return [true, null];
      },
    };
    assert.match(name, /^\.\.\/\.\.\/assets\/fonts\/[^/]+\.ttf$/);
    return readFileSync(new URL(name, hook));
  });
  assert.equal(requests, 1);
  assert.equal(ready, true);
  assert.equal(error, null);
});
