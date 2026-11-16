import assert from 'node:assert/strict';
import test, { before, afterEach } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DocumentFormat } from '../src/core/models/document';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rename, rm, readdir } from 'node:fs/promises';
import { existsSync, statSync, mkdirSync, unlinkSync, openSync, readSync, closeSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, basename, sep } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {UploadSession} from '../src/features/upload/upload_session';
import type { DocumentImportService } from '../src/core/services/document_import';

// Real importer, validation and repository; native picker/filesystem IO is a
// scoped adapter backed by real temporary files. This does not emulate Android.
let compiled: string;
const roots: string[] = [];
const cacheURI = 'file:///experience-cache/';
const documentURI = 'file:///experience-documents/';
const providerURI = 'content://com.android.providers.downloads.documents/document/raw%3A42';
before(async () => {
  const result = await build({ stdin: { contents: `export {DocumentImportService} from './src/core/services/document_import'; export {DocumentStorage} from './src/core/services/document_storage'; export {accountFilePort} from './src/core/services/cloud/cache';`, loader: 'ts', resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'native-import-io', setup(builder) {
      const boundaries: Record<string, string> = {
        'react-native': `export const Platform=io.Platform; export const NativeModules=io.NativeModules;`,
        'expo-document-picker': `export const getDocumentAsync=options=>io.choose(options);`,
        'expo-file-system': `export const File=io.File,Directory=io.Directory,Paths=io.Paths,FileMode={ReadOnly:'r'};`,
      };
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'native' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'native' }, args => ({ contents: boundaries[args.path], loader: 'js' }));
    } }] });
  compiled = result.outputFiles[0].text;
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('topictrail-import-unit-'));
    await rm(root, { recursive: true, force: true });
  }
});

async function harness(bytes: Uint8Array, name = 'Course.pdf') {
  const root = await mkdtemp(join(tmpdir(), 'topictrail-import-unit-')); roots.push(root);
  await mkdir(join(root, 'cache')); await mkdir(join(root, 'documents'));
  const original = join(root, 'original'); await writeFile(original, bytes);
  const state = { canceled: false, rejectCopy: false, rejectRead: false, reportedSize: bytes.length,
    options: undefined as undefined | { copyToCacheDirectory: boolean }, copies: [] as { from: string; to: string }[], openHandles: 0 };
  function local(uri: string): string {
    if (uri === providerURI) return original;
    for (const [prefix, directory] of [[cacheURI, 'cache'], [documentURI, 'documents']]) {
      if (uri.startsWith(prefix)) {
        const path = resolve(root, directory, uri.slice(prefix.length));
        assert.ok(path === join(root, directory) || path.startsWith(join(root, directory) + sep));
        return path;
      }
    }
    // A picker-owned cache path is not necessarily readable by a scoped API.
    throw new Error('Read access denied outside the experience directories');
  }
  const uriOf = (parts: (string | { uri: string })[]) => parts.map(part => typeof part === 'string' ? part : part.uri)
    .map((part, index) => index === 0 ? part.replace(/\/$/, '') : part).join('/');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) { this.uri = uriOf(parts); }
    create() { mkdirSync(local(this.uri), { recursive: true }); }
  }
  class File {
    uri: string;
    get name() { return this.uri.split('/').at(-1)!; }
    create() { const fd = openSync(local(this.uri), 'wx'); closeSync(fd); }
    async digest(algorithm: string) {
      assert.equal(algorithm, 'SHA-256');
      return createHash('sha256').update(await readFile(local(this.uri))).digest('hex');
    }
    constructor(...parts: (string | { uri: string })[]) { this.uri = uriOf(parts); }
    get exists() { try { return existsSync(local(this.uri)); } catch { return false; } }
    get size() { try { return statSync(local(this.uri)).size; } catch { return null; } }
    async copy(to: File, options?: { overwrite?: boolean }) {
      state.copies.push({ from: this.uri, to: to.uri });
      if (state.rejectCopy && this.uri === providerURI) {
        await writeFile(local(to.uri), new Uint8Array([1])); throw new Error('Provider read denied');
      }
      await copyFile(local(this.uri), local(to.uri), options?.overwrite ? 0 : constants.COPYFILE_EXCL);
    }
    open(mode: string) {
      assert.equal(mode, 'r');
      const fd = openSync(local(this.uri), 'r'); state.openHandles++;
      return { readBytes: async (length: number) => {
        if (state.rejectRead) throw new Error('Read permission denied');
        const data = new Uint8Array(length); return data.subarray(0, readSync(fd, data, 0, length, null));
      }, close: () => { closeSync(fd); state.openHandles--; } };
    }
    async bytes() { if (state.rejectRead) throw new Error('Read permission denied'); return new Uint8Array(await readFile(local(this.uri))); }
    async text() { return readFile(local(this.uri), 'utf8'); }
    async write(value: string | Uint8Array) { await writeFile(local(this.uri), value); }
    async move(to: File) { await rename(local(this.uri), local(to.uri)); this.uri = to.uri; }
    delete() { unlinkSync(local(this.uri)); }
  }
  const nativeModules: { TopicTrailTransfer?: object; TopicTrailStudyMetadata?: object } = {};
  const io = { File, Directory, NativeModules: nativeModules, Paths: { cache: { uri: cacheURI }, document: { uri: documentURI } }, Platform: { OS: 'android' },
    choose: async (options: { copyToCacheDirectory: boolean }) => {
      state.options = options;
      return state.canceled ? { canceled: true, assets: null } : { canceled: false, assets: [{
        name, size: state.reportedSize, mimeType: name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf',
        uri: options.copyToCacheDirectory ? 'file:///shared-cache/DocumentPicker/selected' : providerURI,
      }] };
    } };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'io', compiled)(createRequire(resolve('package.json')), module, module.exports, io);
  const exports = module.exports as { accountFilePort: typeof import('../src/core/services/cloud/cache').accountFilePort; DocumentImportService: new (store?: import('../src/core/services/document_storage_contract').DocumentStorageApi) => DocumentImportService; DocumentStorage: new (port?: undefined, policy?: 'disabled' | 'two_guest_successes_v1') => import('../src/core/services/document_repository').DocumentRepository };
  const storage = (policy: 'disabled' | 'two_guest_successes_v1' = 'disabled') => new exports.DocumentStorage(undefined, policy);
  return { accountFilePort: exports.accountFilePort, service: new exports.DocumentImportService(storage()), fresh: (store: import('../src/core/services/document_storage_contract').DocumentStorageApi) => new exports.DocumentImportService(store), storage, io, state, root, local, original };
}
const docx = () => zipSync({
  '[Content_Types].xml': strToU8('<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/document.xml': strToU8('<document><body><p><r><t>Photosynthesis converts light energy into chemical energy.</t></r></p></body></document>'),
});
for (const [name, bytes] of [['Course 100% #1.pdf', strToU8('%PDF-1.7\n')], ['Course.docx', docx()]] as const) {
  test(`selected ${name} is readable before publication and saves bytes/metadata to owned storage`, async () => {
    const h = await harness(bytes, name);
    const selected = await h.service.pickDocument(); assert.ok(selected);
    const result = await h.service.importFile(selected.uri, selected.name);
    assert.equal(result.success, true, result.errorMessage ?? 'Document import failed');
    assert.ok(selected.uri.startsWith(cacheURI + 'topictrail-imports/'));
    assert.equal(h.state.copies[0].from, providerURI, 'preserve the actual granted content URI');
    assert.equal(h.state.openHandles, 0);
    const stored = JSON.parse(await readFile(join(h.root, 'documents', 'documents.json'), 'utf8'));
    assert.equal(stored.version, 3); assert.equal(stored.documents.length, 1); assert.equal(stored.documents[0].title, name.replace(/\.[^.]+$/, ''));
    assert.deepEqual(new Uint8Array(await readFile(h.local(stored.documents[0].filePath))), bytes);
    assert.deepEqual(new Uint8Array(await readFile(h.original)), bytes, 'never alter/delete the user original');
    assert.equal(existsSync(h.local(selected.uri)), false, 'release only the app-created temporary selection after saving');
  });
}
test('picker cancellation retains the previously prepared selection and its bytes', async () => {
  const h = await harness(strToU8('%PDF-1.7\n'));
  const selected = await h.service.pickDocument(); assert.ok(selected);
  h.state.canceled = true; assert.equal(await h.service.pickDocument(), null);
  assert.deepEqual(new Uint8Array(await readFile(h.local(selected.uri))), strToU8('%PDF-1.7\n'));
});
test('copy denial removes only partial app-cache output and publishes no document', async () => {
  const h = await harness(strToU8('%PDF-1.7\n')); h.state.rejectCopy = true;
  await assert.rejects(h.service.pickDocument(), /could not be copied|cannot be copied/i);
  assert.equal(existsSync(join(h.root, 'documents', 'documents.json')), false);
  assert.deepEqual(await readdir(join(h.root, 'cache', 'topictrail-imports')), []);
  assert.ok(existsSync(h.original));
});
test('selection exceeding the known 50MiB limit is rejected before cache copying', async () => {
  const h = await harness(strToU8('%PDF-1.7\n')); h.state.reportedSize = 50 * 1024 * 1024 + 1;
  await assert.rejects(h.service.pickDocument(), /50 MiB/);
  assert.equal(h.state.copies.length, 0);
});
test('failed readability probe closes its descriptor and does not retain the temporary file', async () => {
  const h = await harness(strToU8('%PDF-1.7\n')); h.state.rejectRead = true;
  await assert.rejects(h.service.pickDocument(), /cannot be read|could not be read/i);
  assert.equal(h.state.openHandles, 0);
  assert.deepEqual(await readdir(join(h.root, 'cache', 'topictrail-imports')), []);
});
test('lost access after selection produces a recovery instruction without saving metadata', async () => {
  const h = await harness(strToU8('%PDF-1.7\n')); const selected = await h.service.pickDocument(); assert.ok(selected);
  h.state.rejectRead = true;
  const result = await h.service.importFile(selected.uri, selected.name);
  assert.equal(result.success, false); assert.match(result.errorMessage ?? '', /choose.*again/i);
  assert.equal(existsSync(join(h.root, 'documents', 'documents.json')), false);
});

test('native committed_attempt_replays_after_temporary_cleanup from fresh adapter and service', async () => {
  const h = await harness(strToU8('%PDF-1.7')); const store = h.storage('two_guest_successes_v1'), service = h.fresh(store);
  const picked = await service.pickDocument(); assert.ok(picked); const attempt = { attemptId: 'native-once', actor: { kind: 'guest' as const } };
  const first = await service.importFile(picked.uri, picked.name, attempt); assert.equal(first.success, true, first.errorMessage ?? 'Import failed');
  assert.equal(existsSync(h.local(picked.uri)), false); const copies = h.state.copies.length;
  const reopened = h.storage('two_guest_successes_v1');
  const replay = await h.fresh(reopened).importFile(picked.uri, picked.name, { ...attempt, actor: { kind: 'account', uid: 'u' } });
  assert.equal(replay.success, true, replay.errorMessage ?? 'Import failed'); assert.equal(replay.code, 'committed'); assert.equal(replay.document?.id, first.document?.id);
  assert.equal(h.state.copies.length, copies); assert.deepEqual(await reopened.getGuestAllowance(), { kind: 'ready', used: 1, remaining: 1 });
});
test('native older backup never restores allowance or permits account replay; ordinary mutation persists uncertainty', async () => {
  const h = await harness(strToU8('%PDF-1.7')); const backup = join(h.root, 'documents', 'documents.backup.json');
  const legacy = { id: 'old-doc', title: 'Old', format: 'pdf', filePath: documentURI + 'documents/old.pdf', importedAt: '2026-10-01T00:00:00Z' };
  await writeFile(backup, JSON.stringify({ version: 2, documents: [legacy], guestImports: [{ attemptId: 'old', documentId: 'deleted-old' }] }));
  const before = await readFile(backup, 'utf8'); const store = h.storage('two_guest_successes_v1');
  assert.deepEqual(await store.getGuestAllowance(), { kind: 'recovery_required' });
  assert.equal(existsSync(join(h.root, 'documents', 'documents.json')), false); assert.equal(await readFile(backup, 'utf8'), before);
  const service = h.fresh(store), selected = await service.pickDocument(); assert.ok(selected);
  const result = await service.importFile(selected.uri, selected.name, { attemptId: 'account', actor: { kind: 'account', uid: 'u' } });
  assert.equal(result.success, false); assert.equal(result.code, 'retry'); assert.match(result.errorMessage!, /replay|recovery/i);
  assert.equal(existsSync(h.local(selected.uri)), true, 'Uncertain replay retains the selected bytes');
  assert.equal(await readFile(backup, 'utf8'), before); assert.equal(existsSync(join(h.root, 'documents', 'documents.json')), false);
  await store.updateDocument((await store.getDocument(legacy.id))!.copyWith({ title: 'Still readable' }));
  const main = JSON.parse(await readFile(join(h.root, 'documents', 'documents.json'), 'utf8'));
  assert.equal(main.version, 3); assert.equal(main.guestUsageRecoveryRequired, true); assert.equal(main.importReplayRecoveryRequired, true); assert.equal(main.guestImports.length, 1);
  assert.deepEqual(await h.storage('two_guest_successes_v1').getGuestAllowance(), { kind: 'recovery_required' });
  await assert.rejects(h.storage().lookupGuestImportOutcome('unknown'), /replay|recovery/i);
  assert.deepEqual(await h.storage().lookupGuestImportOutcome('old'), { kind: 'deleted' });
  assert.equal(await readFile(backup, 'utf8'), before, 'No recovery snapshot was overwritten by this first new main');
});
test('native corrupt main does not fall back to readable backup or mutate either file', async () => {
  const h = await harness(strToU8('%PDF-1.7')); const main = join(h.root, 'documents', 'documents.json'), backup = join(h.root, 'documents', 'documents.backup.json');
  await writeFile(main, '{bad'); await writeFile(backup, '[]'); await assert.rejects(h.storage('two_guest_successes_v1').getAllDocuments(), /metadata/);
  assert.equal(await readFile(main, 'utf8'), '{bad'); assert.equal(await readFile(backup, 'utf8'), '[]');
});

for (const policy of ['disabled', 'two_guest_successes_v1'] as const) for (const kind of ['guest', 'account'] as const) {
  test(`native V3 ${policy}/${kind} replays after staging cleanup and tombstones after restart`, async () => {
    const h = await harness(strToU8('%PDF-1.7')); const service = h.fresh(h.storage(policy));
    const selected = await service.pickDocument(); assert.ok(selected);
    const context = { attemptId: 'native-all', actor: kind === 'guest' ? { kind } : { kind, uid: 'fictional' } };
    const first = await service.importFile(selected.uri, selected.name, context); assert.ok(first.document, first.errorMessage ?? 'Import failed');
    assert.equal(existsSync(h.local(selected.uri)), false); const copies = h.state.copies.length;
    const fresh = h.storage(policy), replay = await h.fresh(fresh).importFile(selected.uri, selected.name, context);
    assert.equal(replay.document?.id, first.document.id); assert.equal(replay.code, 'committed'); assert.equal(h.state.copies.length, copies);
    await fresh.deleteDocument(first.document.id);
    const copiesAfterDeletion = h.state.copies.length;
    const deleted = await h.fresh(h.storage(policy)).importFile(selected.uri, selected.name, context);
    assert.equal(deleted.code, 'already_deleted'); assert.equal(h.state.copies.length, copiesAfterDeletion);
    const metadata = JSON.parse(await readFile(join(h.root, 'documents', 'documents.json'), 'utf8'));
    assert.deepEqual(metadata.importAttempts, [{ attemptId: context.attemptId, documentId: first.document.id }]);
    assert.equal(metadata.guestImports.length, policy === 'two_guest_successes_v1' && kind === 'guest' ? 1 : 0);
    assert.ok(existsSync(h.original));
  });
}
test('native move committed then reported failure/unreadable verification retains bytes and reconciles on fresh adapter', async () => {
  const h = await harness(strToU8('%PDF-1.7')); const service = h.fresh(h.storage());
  const selected = await service.pickDocument(); assert.ok(selected);
  const move = h.io.File.prototype.move, text = h.io.File.prototype.text;
  let unreadable = false, fail = true;
  h.io.File.prototype.move = async function(to) { await move.call(this, to); if (fail) { fail = false; unreadable = true; throw Error('Move committed but acknowledgment failed'); } };
  h.io.File.prototype.text = async function() { if (unreadable) { unreadable = false; throw Error('Verification read temporarily denied'); } return text.call(this); };
  const context = { attemptId: 'native-uncertain-disabled', actor: { kind: 'guest' as const } };
  const first = await service.importFile(selected.uri, selected.name, context); assert.equal(first.code, 'retry');
  assert.ok(existsSync(h.local(selected.uri))); const copies = h.state.copies.length;
  const replay = await h.fresh(h.storage()).importFile(selected.uri, selected.name, context);
  assert.equal(replay.success, true, replay.errorMessage ?? 'Replay failed'); assert.equal(replay.code, 'committed'); assert.equal(h.state.copies.length, copies);
  assert.equal((await h.storage().getAllDocuments()).length, 1); assert.ok(existsSync(h.local(replay.document!.filePath)));
});


test('owner serializes canceled native picker and fresh owner cannot lose new staging to disposed picker', async () => {
 const h=await harness(strToU8('%PDF-1.7\n'));const originalChoose=h.io.choose;let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve});let calls=0;
 h.io.choose=async options=>{calls++;if(calls===1)await pending;return originalChoose(options)};
 const make=(service:DocumentImportService)=>new UploadSession({policy:'disabled',pick:()=>service.pickDocument(),discard:uri=>service.discardSelection(uri),importFile:(u,n,a)=>service.importFile(u,n,a),allowance:async()=>({kind:'disabled'}),lookup:async()=>({kind:'uncommitted'})});
 const owner=make(h.service);owner.ensure();const first=owner.pick({kind:'guest'});owner.cancel();owner.ensure();assert.equal(owner.pick({kind:'guest'}),first);assert.equal(calls,1);assert.equal(owner.getSnapshot().picking,true);
 owner.dispose();const replacement=make(h.fresh(h.storage()));replacement.ensure();await replacement.pick({kind:'guest'});const selected=replacement.getSnapshot().asset!;assert.ok(existsSync(h.local(selected.uri)));release();await first;assert.ok(existsSync(h.local(selected.uri)));assert.deepEqual(new Uint8Array(await readFile(h.original)),strToU8('%PDF-1.7\n'));assert.equal((await readdir(join(h.root,'cache','topictrail-imports'))).length,1);replacement.dispose();assert.equal((await readdir(join(h.root,'cache','topictrail-imports'))).length,0);
});
for(const [name,bytes] of [['Empty.pdf',new Uint8Array()],['Wrong.pdf',strToU8('invalid')],['Invalid.docx',strToU8('invalid')]] as const)test(`native invalid ${name} is typed reselect`,async()=>{const h=await harness(bytes,name);const selected=await h.service.pickDocument();assert.ok(selected);assert.equal((await h.service.importFile(selected.uri,selected.name)).code,'reselect');assert.ok(existsSync(h.original));});

type PublishOriginal = (staged: string, destination: string, size: number, hash: string, allowIdentical: boolean) => Promise<void>;

async function publishingFixture(bytes: Uint8Array, publish: PublishOriginal) {
  const fixture = await harness(bytes);
  const metadata = new Map<string, string>();
  fixture.io.NativeModules.TopicTrailTransfer = { role: 'production', publishOriginal: publish };
  fixture.io.NativeModules.TopicTrailStudyMetadata = {
    read: async (keys: string[]) => keys.map(key => metadata.get(key) ?? null),
    compareAndSet: async (keys: string[], before: (string | null)[], after: string[]) => {
      if (keys.some((key, i) => (metadata.get(key) ?? null) !== before[i])) return false;
      keys.forEach((key, i) => metadata.set(key, after[i]));
      return true;
    },
  };
  return { ...fixture, metadata };
}

const sampleOriginal = Buffer.from('%PDF-1.7\\nSynthetic original\\n%%EOF');
const differentOriginal = Buffer.alloc(sampleOriginal.length, 77);
const originalHash = createHash('sha256').update(sampleOriginal).digest('hex');
const accountId = { project: 'abcdefghijklmnopqrst', uid: '10000000-2000-4000-8000-500000000000' };

test('production Guest writes a distinct verified staging file and publishes before committing the document', async () => {
  let stagedURI = '', destinationURI = '', calls = 0;
  const h = await publishingFixture(sampleOriginal, async (staged, destination, size, hash, allowIdentical) => {
    calls++;
    stagedURI = staged;
    destinationURI = documentURI + destination;
    assert.match(destination, /^documents\/[a-z0-9-]+\.pdf$/);
    assert.ok(staged.startsWith(documentURI + 'documents/incoming-'));
    assert.notEqual(staged, destinationURI);
    assert.deepEqual(await readFile(h.local(staged)), sampleOriginal);
    assert.equal(size, sampleOriginal.length);
    assert.equal(hash, originalHash);
    assert.equal(allowIdentical, false);
    assert.equal(h.metadata.size, 0);
    await copyFile(h.local(staged), h.local(destinationURI), constants.COPYFILE_EXCL);
  });
  const saved = await h.storage().saveDocument({ originalPath: providerURI, title: 'Original', format: DocumentFormat.PDF });
  assert.equal(calls, 1);
  assert.equal(saved.filePath, destinationURI);
  assert.deepEqual(await readFile(h.local(destinationURI)), sampleOriginal);
  assert.equal(existsSync(h.local(stagedURI)), false);
  assert.equal((await h.storage().getAllDocuments())[0].id, saved.id);
});

for (const owner of ['Guest', 'account'] as const) {
  for (const failure of ['conflicting destination', 'lost acknowledgement'] as const) {
    test('production ' + owner + ' preserves the destination and removes its staging file after ' + failure, async () => {
      let stagedURI = '', finalURI = '', calls = 0;
      const winner = failure === 'conflicting destination' ? differentOriginal : sampleOriginal;
      const h = await publishingFixture(sampleOriginal, async (staged, destination, size, hash, allowIdentical) => {
        calls++;
        stagedURI = staged;
        finalURI = documentURI + destination;
        assert.notEqual(stagedURI, finalURI);
        assert.deepEqual(await readFile(h.local(stagedURI)), sampleOriginal);
        assert.equal(size, sampleOriginal.length);
        assert.equal(hash, originalHash);
        assert.equal(allowIdentical, owner === 'account');
        // The native boundary either saw another publisher win, or installed these bytes and lost its reply.
        await writeFile(h.local(finalURI), winner, { flag: 'wx' });
        throw Error(failure);
      });
      if (owner === 'Guest') {
        await assert.rejects(h.storage().saveDocument({ originalPath: providerURI, title: 'Guest file', format: DocumentFormat.PDF }), new RegExp(failure));
      } else {
        const port = h.accountFilePort(accountId);
        const id = 'doc-' + accountId.uid + '-original';
        const write = { path: port.path(id, DocumentFormat.PDF), bytes: sampleOriginal, hash: originalHash };
        await assert.rejects(port.commit(0, 'account metadata', write), new RegExp(failure));
        assert.equal(finalURI, documentURI + 'topictrail-cloud-v1/' + accountId.project + '/' + accountId.uid + '/' + id + '.pdf');
        assert.equal((await port.readState()).revision, 0);
        if (failure === 'lost acknowledgement') {
          assert.equal(await port.commit(0, 'account metadata', write), true);
          assert.equal((await port.readState()).revision, 1);
        } else {
          await assert.rejects(port.commit(0, 'account metadata', write), /conflict/i);
          assert.equal((await port.readState()).revision, 0);
        }
      }
      assert.equal(calls, 1, 'retry must use the immutable destination and its verified digest');
      assert.equal(existsSync(h.local(stagedURI)), false);
      assert.deepEqual(await readFile(h.local(finalURI)), winner);
      assert.deepEqual(await readFile(h.original), sampleOriginal);
      if (owner === 'Guest') assert.equal(h.metadata.size, 0);
    });
  }
}
