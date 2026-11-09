import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(new URL('./webview-download-policy.json', import.meta.url), 'utf8'));
const normalize = text => text.replaceAll('\r\n', '\n');
const sha256 = text => createHash('sha256').update(normalize(text)).digest('hex');

/** Three fixed files only; the explicit root is for bounded source fixtures in tests. */
export function applyWebViewDownloadPolicy(packageRoot, { check = false } = {}) {
  const root = realpathSync(packageRoot);
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (packageJson.name !== manifest.packageName || packageJson.version !== manifest.version) {
    throw new Error(`WebView download policy requires ${manifest.packageName} version ${manifest.version}; refusing this package/version.`);
  }

  // Validate every whole-file hash and every prospective result before the first write.
  // Never partially overwrite an unknown upstream version, local edit or interrupted write.
  const plan = manifest.files.map(entry => {
    const path = realpathSync(resolve(root, entry.path));
    if (!path.startsWith(root + sep)) throw new Error('WebView policy target escapes its package.');
    const source = normalize(readFileSync(path, 'utf8'));
    const hash = sha256(source);
    if (hash === entry.patchedSha256) return { path, entry, patched: true, source };
    if (hash !== entry.originalSha256) throw new Error(`Unknown WebView source hash: ${entry.path}. No source files were changed.`);
    if (source.split(entry.before).length !== 2) throw new Error(`WebView patch anchor is not unique: ${entry.path}.`);
    const replacement = source.replace(entry.before, entry.after);
    if (sha256(replacement) !== entry.patchedSha256) throw new Error(`WebView patch result hash mismatch: ${entry.path}.`);
    return { path, entry, patched: false, source: replacement };
  });

  if (check) {
    if (plan.some(file => !file.patched)) throw new Error('WebView download policy is not fully patched. Native source must be prepared before a future build.');
    return { changed: [] };
  }

  const changed = [];
  // Manifest order is intentional: deny downloads first, then export the native markers.
  // Known original/patched mixtures can resume; --check rejects every mixed state.
  for (const file of plan) {
    if (file.patched) continue;
    writeFileSync(file.path, file.source, 'utf8');
    if (sha256(readFileSync(file.path, 'utf8')) !== file.entry.patchedSha256) {
      throw new Error(`WebView policy write verification failed: ${file.entry.path}. Do not build this source.`);
    }
    changed.push(file.entry.path);
  }
  return { changed };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/patch-webview-download-policy.mjs [--check]');
  }
  // Resolve using the actual app, never cwd or a user-supplied CLI target directory.
  const require = createRequire(resolve(appRoot, 'package.json'));
  const packageRoot = dirname(require.resolve('react-native-webview/package.json'));
  if (realpathSync(packageRoot) !== realpathSync(resolve(appRoot, 'node_modules/react-native-webview'))) {
    throw new Error('WebView policy requires the app-local installed package.');
  }
  const result = applyWebViewDownloadPolicy(packageRoot, { check: args[0] === '--check' });
  console.log(`WebView download-policy native source verified (${result.changed.length} files updated). Native build/acceptance remains required.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'WebView policy preparation failed.'); process.exitCode = 1; }
}
