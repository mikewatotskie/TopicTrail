import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(project, 'dist-presentation');
const port = 4184;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };
await stat(path.join(root, 'index.html'));
http.createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
  }
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/_topictrail_presentation_status') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ app: 'TopicTrail-main-presentation', port })); return;
    }
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes('\0') || decoded.includes('\\')) { response.writeHead(400); response.end(); return; }
    let file = path.resolve(root, '.' + decoded);
    if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    let info;
    try { info = await stat(file); } catch { /* SPA routes use the entry page below. */ }
    if (!info?.isFile()) {
      if (path.extname(decoded)) { response.writeHead(404); response.end('Not found'); return; }
      file = path.join(root, 'index.html'); info = await stat(file);
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy()); stream.pipe(response);
  } catch { if (!response.headersSent) response.writeHead(400); response.end('Unable to read this request'); }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`TopicTrail presentation ready: http://127.0.0.1:${port}/demo\n`);
}).on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
