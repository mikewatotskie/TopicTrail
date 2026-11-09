import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// This exercises a source patch against controlled native-source fixtures. No Kotlin/Java is compiled.
interface Entry { path: string; originalSha256: string; patchedSha256: string; before: string; after: string }
interface Manifest { packageName: string; version: string; files: Entry[] }
interface Patcher { applyWebViewDownloadPolicy: (packageRoot: string, options?: {check?: boolean}) => {changed: string[]} }
const script = resolve('scripts/patch-webview-download-policy.mjs');
const fixtureParent = realpathSync(resolve('tests'));
const normalized = (text: string) => text.replaceAll('\r\n', '\n');
const hash = (text: string) => createHash('sha256').update(normalized(text)).digest('hex');

async function fixture(run: (root: string, patcher: Patcher, manifest: Manifest) => void) {
  assert.ok(existsSync(script), 'persistent download-policy patch entry point must exist');
  const patcher = await import(pathToFileURL(script).href) as Patcher;
  const manifest = JSON.parse(readFileSync(resolve('scripts/webview-download-policy.json'), 'utf8')) as Manifest;
  const root = mkdtempSync(join(fixtureParent, '.webview-policy-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({name:'react-native-webview',version:'14.0.1'}));
    writeFileSync(join(root, 'untouched.txt'), 'not a patch target\n');
    for (const entry of manifest.files) {
      let source = normalized(readFileSync(resolve('node_modules/react-native-webview', entry.path), 'utf8'));
      if (hash(source) === entry.patchedSha256) source = source.replace(entry.after, entry.before);
      assert.equal(hash(source), entry.originalSha256, 'fixture derives only an exact known upstream file');
      const target = join(root, entry.path); mkdirSync(dirname(target), {recursive:true}); writeFileSync(target, source);
    }
    run(root, patcher, manifest);
  } finally {
    const actual = realpathSync(root);
    assert.equal(dirname(actual), fixtureParent); assert.ok(actual.startsWith(fixtureParent + sep + '.webview-policy-'));
    rmSync(actual, {recursive:true,force:true});
  }
}
function snapshot(root: string): Record<string,string> {
  const result: Record<string,string> = {};
  function visit(directory: string) { for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) visit(path); else result[relative(root, path)] = readFileSync(path).toString('base64');
  } }
  visit(root); return result;
}

test('exact upstream fixture applies only the three policy files and is idempotent', async () => fixture((root, patcher, manifest) => {
  const before = snapshot(root);
  const result = patcher.applyWebViewDownloadPolicy(root);
  assert.equal(result.changed.length, 3); assert.deepEqual(result.changed, manifest.files.map(file => file.path));
  const after = snapshot(root);
  const changed = Object.keys(before).filter(path => before[path] !== after[path]).sort();
  assert.deepEqual(changed, manifest.files.map(file => file.path.replaceAll('/', sep)).sort());
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const file of manifest.files) assert.equal(hash(readFileSync(join(root, file.path), 'utf8')), file.patchedSha256);
  assert.deepEqual(patcher.applyWebViewDownloadPolicy(root).changed, []);
  assert.deepEqual(patcher.applyWebViewDownloadPolicy(root, {check:true}).changed, []);
  assert.deepEqual(snapshot(root), after);
}));

test('check-only fails on unpatched sources without changing any file or timestamp', async () => fixture((root, patcher, manifest) => {
  const before = snapshot(root); const times = manifest.files.map(file => statSync(join(root, file.path)).mtimeMs);
  assert.throws(() => patcher.applyWebViewDownloadPolicy(root, {check:true}), /not fully patched/i);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(manifest.files.map(file => statSync(join(root, file.path)).mtimeMs), times);
}));

for (const version of ['14.0.0','14.0.2','15.0.0']) test(`unknown WebView ${version} aborts before any source mutation`, async () => fixture((root, patcher) => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({name:'react-native-webview',version}));
  const before = snapshot(root); assert.throws(() => patcher.applyWebViewDownloadPolicy(root), /version/i);
  assert.deepEqual(snapshot(root), before);
}));

for (const index of [0,1,2]) test(`an unknown edit in target ${index + 1} aborts before every mutation`, async () => fixture((root, patcher, manifest) => {
  const target = join(root, manifest.files[index].path); writeFileSync(target, readFileSync(target, 'utf8') + '\n// unknown edit\n');
  const before = snapshot(root); assert.throws(() => patcher.applyWebViewDownloadPolicy(root), /unknown.*source|hash/i);
  assert.deepEqual(snapshot(root), before);
  assert.throws(() => patcher.applyWebViewDownloadPolicy(root, {check:true}), /unknown.*source|hash/i);
  assert.deepEqual(snapshot(root), before);
}));

for (const patchedIndices of [[0],[1],[0,1]]) test(`known mixed state ${patchedIndices.join(',')} fails check-only and safely resumes`, async () => fixture((root, patcher, manifest) => {
  for (const index of patchedIndices) {
    const file = manifest.files[index], target = join(root, file.path);
    writeFileSync(target, readFileSync(target, 'utf8').replace(file.before, file.after));
  }
  const before = snapshot(root); assert.throws(() => patcher.applyWebViewDownloadPolicy(root, {check:true}), /not fully patched/i);
  assert.deepEqual(snapshot(root), before);
  assert.equal(patcher.applyWebViewDownloadPolicy(root).changed.length, 3 - patchedIndices.length);
  patcher.applyWebViewDownloadPolicy(root, {check:true});
}));

test('denial is written before capability exports and no download request survives in its listener', async () => fixture((root, patcher, manifest) => {
  const writes = patcher.applyWebViewDownloadPolicy(root).changed;
  assert.equal(writes[0], 'android/src/main/java/com/reactnativecommunity/webview/RNCWebViewManagerImpl.kt');
  const implementation = readFileSync(join(root, writes[0]), 'utf8');
  const listener = implementation.slice(implementation.indexOf('webView.setDownloadListener('), implementation.indexOf('return RNCWebViewWrapper(context, webView)'));
  assert.match(listener, /stopLoading\(\)/); assert.match(listener, /getRNCWebViewClient\(\)\?\.onReceivedError\(/);
  assert.match(listener, /-9001/); assert.doesNotMatch(listener, /DownloadManager\.Request|setDownloadRequest|downloadFile|DIRECTORY_DOWNLOADS/);
  for (const file of manifest.files.slice(1)) assert.match(readFileSync(join(root, file.path), 'utf8'), /getExportedViewConstants\(\)[\s\S]*MapBuilder\.of\("topicTrailDownloadPolicyVersion", 1\)/);
}));

test('LF-normalized upstream hashes accept CRLF source fixtures', async () => fixture((root, patcher, manifest) => {
  for (const file of manifest.files) { const target = join(root, file.path); writeFileSync(target, readFileSync(target, 'utf8').replaceAll('\n','\r\n')); }
  assert.equal(patcher.applyWebViewDownloadPolicy(root).changed.length, 3); patcher.applyWebViewDownloadPolicy(root, {check:true});
}));

test('installed package check passes read-only and CLI rejects arbitrary target arguments', async () => {
  assert.ok(existsSync(script), 'persistent download-policy patch entry point must exist');
  const checked = spawnSync(process.execPath, [script, '--check'], {cwd:resolve('.'),encoding:'utf8'});
  assert.equal(checked.status, 0, checked.stderr); assert.match(checked.stdout, /verified/i);
  const rejected = spawnSync(process.execPath, [script, resolve('tests')], {cwd:resolve('.'),encoding:'utf8'});
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /usage/i);
});
