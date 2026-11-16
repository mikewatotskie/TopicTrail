import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';

async function fixture(t: TestContext) {
  const work = resolve('work');
  await mkdir(work, { recursive: true });
  const dir = await mkdtemp(join(work, 'presentation-path-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dir)), work);
    assert.ok(basename(dir).startsWith('presentation-path-test-'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('presentation server serves the reviewed export and named app routes', async t => {
  const { createPresentationServer } = await import('../scripts/presentation-server.mjs');
  const directory = await fixture(t);
  const asset = 'assets/font.' + 'a'.repeat(32) + '.ttf';
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!DOCTYPE html><title>Demo</title>');
  await writeFile(join(directory, asset), 'fixture');
  const published = ['index.html', asset];
  const server = await createPresentationServer(directory, published);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  for (const route of ['/', '/index.html', '/demo', '/auth/callback', '/reader/document-1']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const head = await fetch(origin + route, { method: 'HEAD' });
    assert.equal(head.headers.get('x-frame-options'), 'DENY');
    assert.match(await response.text(), /<!DOCTYPE html>/i);
  }
  assert.equal((await fetch(origin + '/' + asset, { method: 'HEAD' })).status, 200);
  for (const route of ['/.git', '/.env', '/admin', '/backup', '/work', '/unknown', '/src/app/index.tsx']) {
    assert.equal((await fetch(origin + route, { method: 'HEAD' })).status, 404, route);
  }
  assert.equal((await fetch(origin + '/demo', { method: 'POST' })).status, 405);
});

test('unlisted files and linked directories stay private even when present on disk', async t => {
  const { createPresentationServer } = await import('../scripts/presentation-server.mjs');
  const parent = await fixture(t);
  const directory = join(parent, 'dist');
  const privateDirectory = join(parent, 'private');
  const name = 'font.' + 'a'.repeat(32) + '.ttf';
  await Promise.all([mkdir(directory), mkdir(privateDirectory)]);
  await Promise.all([writeFile(join(directory, 'index.html'), 'public'), writeFile(join(directory, 'draft.txt'), 'private'),
    writeFile(join(privateDirectory, name), 'private')]);
  await symlink(privateDirectory, join(directory, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = await createPresentationServer(directory, ['index.html', 'assets/' + name]);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    assert.equal((await fetch(origin + '/draft.txt')).status, 404);
    assert.equal((await fetch(origin + '/assets/' + name)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
