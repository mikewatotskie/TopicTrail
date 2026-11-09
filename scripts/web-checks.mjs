import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Real browser IndexedDB, isolated loopback fixture origin; never opens a phone or browser automatically.
const port = Number(process.env.TOPICTRAIL_CHECK_PORT ?? 8808);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid check port');
const entry = resolve('tests/browser/web-storage.cases.ts');
let latest = null;
const server = createServer(async (request, response) => {
  try {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'POST' && request.url === '/results') {
      let text = '';
      for await (const chunk of request) { text += chunk; if (text.length > 100000) throw Error('Oversized result'); }
      latest = JSON.parse(text);
      console.log(JSON.stringify(latest)); response.writeHead(204).end(); return;
    }
    if (request.url === '/results') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(latest)); return; }
    if (request.url === '/checks.js') {
      const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'browser', format: 'iife', conditions: ['browser'],
        plugins: [{ name: 'expo-core-types', setup(builder) {
          builder.onResolve({ filter: /^expo-modules-core$/ }, () => ({ path: resolve('node_modules/expo-modules-core/src/index.ts') }));
          // Fixture importers inject their picker; keep unused Metro-only SDK initialization out of this independent esbuild runner.
          builder.onResolve({ filter: /^expo-document-picker$/ }, () => ({ path: 'picker', namespace: 'fixture-picker' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture-picker' }, () => ({ contents: 'export async function getDocumentAsync(){throw Error("Browser fixture must inject its picker input")}', loader: 'js' }));
        } }],
        resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
        alias: { 'react-native': 'react-native-web' }, define: { __DEV__: 'true', 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"' },
        loader: { '.svg': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.html': 'text' } });
      response.setHeader('Content-Type', 'application/javascript'); response.end(result.outputFiles[0].contents); return;
    }
    if (request.url === '/' || request.url === '/storage') {
      response.setHeader('Content-Type', 'text/html'); response.end(await readFile(resolve('tests/browser/storage.html'))); return;
    }
    response.writeHead(404).end('Not found');
  } catch (error) { response.writeHead(500, { 'Content-Type': 'text/plain' }).end(error instanceof Error ? error.message : String(error)); }
});
server.listen(port, '127.0.0.1', () => console.log(`Browser checks: http://127.0.0.1:${port}/storage`));
