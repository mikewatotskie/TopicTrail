import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { Children, createElement, isValidElement, type ReactNode } from 'react';

test('splash expiry before the global router binds requests a focused welcome redirect', () => {
  const source = readFileSync(new URL('../src/features/splash/SplashScreen.tsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code;
  let finished = false;
  let effect!: () => () => void;
  let expire: (() => void) | undefined;
  const modules: Record<string, unknown> = {
    react: { createElement, useState: () => [finished, (next: boolean) => { finished = next; }],
      useEffect: (callback: typeof effect) => { effect = callback; } },
    'react-native': { View: 'View', Text: 'Text' },
    'expo-router': { Redirect: 'Redirect', router: { replace() { throw Error('Router unavailable before first render'); } } },
    '../../components': { TTScreen: 'Screen', TTArtwork: 'Artwork' },
    '../../core/theme/ThemeContext': { useTheme: () => ({ colors: {}, colorScheme: 'light' }) },
    '../../core/design/tokens': { TTTypography: {} },
  };
  const module = { exports: {} as { SplashScreen(): { type: string; props: { href?: string } } } };
  runInNewContext(code, {
    module, exports: module.exports, require: (name: string) => modules[name],
    setTimeout: (callback: () => void) => { expire = callback; return 1; },
    clearTimeout: () => { expire = undefined; },
  });
  assert.equal(module.exports.SplashScreen().type, 'Screen');
  const cleanup = effect();
  assert.ok(expire);
  expire();
  const redirect = module.exports.SplashScreen();
  assert.equal(redirect.type, 'Redirect');
  assert.equal(redirect.props.href, '/welcome');
  cleanup();
  assert.equal(expire, undefined);
});

test('Get started uses its mounted navigation context even if the global router is unbound', () => {
  const source = readFileSync(new URL('../src/features/splash/WelcomeScreen.tsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code;
  const visited: string[] = [];
  const modules: Record<string, unknown> = {
    react: { createElement },
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'Scroll' },
    'expo-router': { useRouter: () => ({ replace: (url: string) => visited.push(url) }),
      get router() { throw Error('Global navigation unavailable after resume'); } },
    '../../components': { TTButton: 'Button', TTScreen: 'Screen', TTCard: 'Card', TTFigmaIcon: 'Icon', TTAura: 'Aura' },
    '../../navigation': { TTAppBar: 'AppBar' },
    '../../core/theme/ThemeContext': { useColors: () => ({ colors: {} }) },
    '../../core/design/tokens': { TTTypography: {} },
  };
  const module = { exports: {} as { WelcomeScreen(): ReactNode } };
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => modules[name] });
  function pressGetStarted(node: ReactNode): void {
    if (!isValidElement<{ label?: string; onPress?: () => void; children?: ReactNode }>(node)) return;
    if (node.props.label === 'Get started') node.props.onPress?.();
    Children.forEach(node.props.children, pressGetStarted);
  }
  pressGetStarted(module.exports.WelcomeScreen());
  assert.deepEqual(visited, ['/(tabs)/home']);
});
