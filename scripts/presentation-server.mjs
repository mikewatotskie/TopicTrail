import http from 'node:http';
import { createHash } from 'node:crypto';
import { open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const project = resolve(dirname(script), '..');
const release = process.argv.includes('--packaged') ? project : join(project, 'deliverables', 'duckduckgo-v11', 'web');
const root = join(release, 'dist-presentation');
const manifest = join(dirname(script), 'presentation-public-files.json');
const routes = new Set(['/', '/demo', '/home', '/library', '/saved', '/settings', '/upload', '/notes',
  '/topic-search', '/topic-preview', '/welcome', '/auth/callback', '/auth/created', '/auth/login',
  '/auth/profile', '/auth/recovery', '/auth/register', '/auth/update-password', '/auth/verify']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon' };

function isExportFile(name) {
  if (['index.html', 'favicon.ico', 'metadata.json'].includes(name)) return true;
  if (name.split('/').some(part => !part || part.startsWith('.') || /[\\:%\x00-\x1f]/u.test(part))) return false;
  if (/^_expo\/static\/js\/web\/[\w.[\]-]+-[a-f0-9]{32}\.js$/u.test(name)) return true;
  return name.startsWith('assets/') && /\.[a-f0-9]{32}(?:@[1-9]x)?\.[a-z0-9]+$/u.test(name) &&
    Object.hasOwn(types, extname(name));
}

export async function buildPresentationManifest(directory, prefix = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isDirectory()) files.push(...await buildPresentationManifest(join(directory, item.name), name + '/'));
    else if (item.isFile() && isExportFile(name)) files.push(name);
    else throw Error('Unexpected file in the presentation export. Review the export before packaging.');
  }
  return files.sort();
}

function requestPath(target) {
  const pathname = target.split('?', 1)[0];
  if (!pathname.startsWith('/') || /%(?:2f|5c|25)/i.test(pathname)) return null;
  const decoded = decodeURIComponent(pathname);
  if (/[:\\#?\x00-\x1f\x7f]/u.test(decoded) || decoded.includes('//') ||
      decoded.split('/').some(part => part.startsWith('.'))) return null;
  return decoded;
}

export async function createPresentationServer(directory, fileList) {
  const rootPath = await realpath(directory);
  if (rootPath !== join(await realpath(dirname(directory)), basename(directory))) {
    throw Error('The presentation export must be a project directory.');
  }
  if (!Array.isArray(fileList) || !fileList.includes('index.html') || !fileList.every(isExportFile)) {
    throw Error('Invalid presentation file manifest.');
  }
  const allowed = new Set(fileList);
  const indexHash = createHash('sha256').update(await readFile(join(rootPath, 'index.html'))).digest('hex');
  return http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    let handle;
    try {
      const pathname = requestPath(request.url);
      if (pathname === '/_topictrail_presentation_status') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ app: 'TopicTrail-main-presentation', securityRevision: 1, indexHash, port: request.socket.localPort })); return;
      }
      const route = pathname?.replace(/\/$/, '') || '/';
      const name = pathname && (routes.has(route) || /^\/reader\/[a-zA-Z0-9_-]{1,128}$/u.test(route)
        ? 'index.html' : pathname.slice(1));
      if (!name || !allowed.has(name)) { response.writeHead(404); response.end(); return; }
      const file = await realpath(join(rootPath, name));
      if (relative(rootPath, file).split(sep).join('/') !== name) {
        response.writeHead(404); response.end(); return;
      }
      handle = await open(file, 'r');
      const info = await handle.stat();
      if (!info.isFile()) { response.writeHead(404); response.end(); return; }
      if (extname(name) === '.html') {
        response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        response.setHeader('X-Frame-Options', 'DENY');
      }
      response.writeHead(200, { 'Content-Type': types[extname(name)], 'Content-Length': info.size,
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = handle.createReadStream();
      handle = undefined;
      response.on('close', () => stream.destroy());
      stream.on('error', () => response.destroy()); stream.pipe(response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(error instanceof URIError ? 400 : 404);
      response.end();
    } finally { await handle?.close(); }
  });
}

async function main() {
  if (process.argv.includes('--write-manifest') || process.argv.includes('--check-manifest')) {
    const generated = JSON.stringify(await buildPresentationManifest(root), null, 2) + '\n';
    if (process.argv.includes('--write-manifest')) await writeFile(manifest, generated);
    else if ((await readFile(manifest, 'utf8')).replace(/\r\n/g, '\n') !== generated) {
      throw Error('The presentation export differs from the reviewed file manifest.');
    }
  } else {
    const server = await createPresentationServer(root, JSON.parse(await readFile(manifest, 'utf8')));
    server.listen(4184, '127.0.0.1', () => {
      process.stdout.write('TopicTrail presentation ready: http://127.0.0.1:4184/demo\n');
    }).on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
