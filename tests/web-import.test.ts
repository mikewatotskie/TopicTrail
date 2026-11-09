import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { DocumentRepository } from '../src/core/services/document_repository';
import { getWebImportSource, registerWebImportSource, releaseWebImportSource } from '../src/core/services/web/import_sources';
import {UploadSession} from '../src/features/upload/upload_session';
import type { DocumentImportService } from '../src/core/services/document_import';
import { ImportOperationError } from '../src/core/services/document_import_contract';
import { createWebDocumentStore } from '../src/core/services/document_storage.web';
import { DocumentFormat } from '../src/core/models/document';
import type { IndexedDbClient } from '../src/core/services/web/indexeddb_client';
import type { SaveDocumentInput } from '../src/core/services/document_repository';

let compiled: string;
before(async () => {
  const result = await build({ stdin: { contents: `export {DocumentImportService} from './src/core/services/document_import';`, resolveDir: process.cwd(), loader: 'ts' },
    write: false, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    resolveExtensions: ['.web.ts', '.ts', '.js'], plugins: [{ name: 'platform-io', setup(builder) {
      const modules: Record<string, string> = {
        'expo-document-picker': `export const getDocumentAsync=options=>io.pick(options);`,
        'expo-file-system': `export class File {constructor(){throw Error('Native filesystem on web')}};export class Directory{};export const FileMode={},Paths={};`,
        'react-native': `export const Platform={OS:'web'};`,
      };
      builder.onResolve({ filter: /.*/ }, args => modules[args.path] ? { path: args.path, namespace: 'boundary' }
        : args.path.endsWith('/web/import_sources') || args.path.endsWith('./import_sources')
          ? { path: 'sources', namespace: 'boundary' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: args.path === 'sources'
        ? `export const getWebImportSource=io.sources.get,registerWebImportSource=io.sources.register,releaseWebImportSource=io.sources.release;`
        : modules[args.path], loader: 'js' }));
    } }] }); compiled = result.outputFiles[0].text;
});
function harness(file: File, policy: 'disabled' | 'two_guest_successes_v1' = 'disabled') {
  let metadata: string | null = null; const files = new Map<string, Blob>();
  const storage = new DocumentRepository({ readMetadata: async () => metadata, writeMetadata: async json => { metadata = json; },
    copyToDocuments: async (uri, id, format) => { const blob = getWebImportSource(uri), path = `topictrail-idb://documents/${id}.${format}`; files.set(path, blob); return { filePath: path, size: blob.size }; },
    fileExists: async path => files.has(path), removeFile: async path => { files.delete(path); } }, policy);
  const state = { canceled: false, options: undefined as { base64?: boolean } | undefined };
  const io = { sources: { get: getWebImportSource, register: registerWebImportSource, release: releaseWebImportSource },
    pick: async (options: { base64?: boolean }) => { state.options = options; return state.canceled ? { canceled: true, assets: null }
      : { canceled: false, assets: [{ uri: 'blob:owned-fixture', name: file.name, size: file.size, file }] }; } };
  const module = { exports: {} };
  new Function('require','module','exports','io',compiled)(createRequire(resolve('package.json')),module,module.exports,io);
  const Ctor = (module.exports as { DocumentImportService: new (store: DocumentRepository) => DocumentImportService }).DocumentImportService;
  return { io, service: new Ctor(storage), fresh: () => new Ctor(storage), state, storage, files };
}
const docx = () => zipSync({ '[Content_Types].xml': strToU8('<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/document.xml': strToU8('<document><body><p><r><t>Actual lesson text.</t></r></p></body></document>') });
for (const [name, bytes] of [['Course.pdf', strToU8('%PDF-1.7\nlesson')], ['Course.docx', docx()]] as const)
  test(`web ${name} import uses real bytes and repository`, async () => {
    const h = harness(new File([bytes as BlobPart], name));
    const selected = await h.service.pickDocument(); assert.ok(selected);
    const result = await h.service.importFile(selected.uri, selected.name);
    assert.equal(result.success, true, result.errorMessage ?? 'Import failed');
    assert.equal(h.state.options?.base64, false);
    assert.deepEqual(new Uint8Array(await h.files.get(result.document!.filePath)!.arrayBuffer()), bytes);
    assert.equal((await h.storage.getAllDocuments()).length, 1);
    assert.throws(() => getWebImportSource(selected.uri), /no longer available/);
  });
test('web picker cancellation keeps previous readable selection', async () => {
  const h = harness(new File(['%PDF-1.7'], 'Course.pdf')); const selected = await h.service.pickDocument(); assert.ok(selected);
  h.state.canceled = true; assert.equal(await h.service.pickDocument(), null);
  assert.equal(getWebImportSource(selected.uri).size, 8); releaseWebImportSource(selected.uri);
});
test('web oversized selection is rejected before reading', async () => {
  class LargeFile extends File { override get size() { return 50 * 1024 * 1024 + 1; } override slice(): Blob { throw Error('Must not read oversize file'); } }
  const h = harness(new LargeFile(['tiny'], 'Large.pdf')); await assert.rejects(h.service.pickDocument(), /50\s?MB/);
});
test('invalid web document does not enter the library', async () => {
  const h = harness(new File(['not a pdf'], 'Fake.pdf')); const selected = await h.service.pickDocument(); assert.ok(selected);
  const result = await h.service.importFile(selected.uri, selected.name); assert.equal(result.success, false);
  assert.equal((await h.storage.getAllDocuments()).length, 0); releaseWebImportSource(selected.uri);
});

const guestAttempt = { attemptId: 'web-once', actor: { kind: 'guest' as const } };
test('web committed_attempt_replays_after_temporary_cleanup from fresh service without source reads/copy/commit', async () => {
  const h = harness(new File(['%PDF-1.7'], 'Course.pdf'), 'two_guest_successes_v1');
  const selected = await h.service.pickDocument(); assert.ok(selected);
  const first = await h.service.importFile(selected.uri, selected.name, guestAttempt); assert.equal(first.success, true);
  assert.throws(() => getWebImportSource(selected.uri), /no longer available/);
  h.storage.saveDocument = async () => { throw Error('Replay must not write'); };
  const replay = await h.fresh().importFile(selected.uri, selected.name, { ...guestAttempt, actor: { kind: 'account', uid: 'changed' } });
  assert.equal(replay.success, true, replay.errorMessage ?? 'Import failed'); assert.equal(replay.code, 'committed'); assert.equal(replay.document?.id, first.document?.id);
  assert.deepEqual(await h.storage.getGuestAllowance(), { kind: 'ready', used: 1, remaining: 1 });
});
test('web enabled missing attempt and third guest return typed errors before selection reads; canceled/failure/account do not charge', async () => {
  const h = harness(new File(['%PDF-1.7'], 'Course.pdf'), 'two_guest_successes_v1');
  assert.equal((await h.service.importFile('missing', 'Course.pdf')).code, 'retry');
  h.state.canceled = true; assert.equal((await h.service.pickAndImportDocument()).canceled, true); h.state.canceled = false;
  assert.equal((await h.service.importFile('missing', 'Course.pdf', guestAttempt)).code, 'reselect');
  for (const [id, actor] of [['account', { kind: 'account', uid: 'u' }], ['one', { kind: 'guest' }], ['two', { kind: 'guest' }]] as const) {
    const selected = await h.service.pickDocument(); assert.ok(selected);
    const result = await h.service.importFile(selected.uri, selected.name, { attemptId: id, actor }); assert.equal(result.success, true, result.errorMessage ?? 'Import failed');
  }
  assert.equal((await h.service.importFile('missing', 'Course.pdf', { attemptId: 'three', actor: { kind: 'guest' } })).code, 'guest_limit');
  assert.equal((await h.storage.getAllDocuments()).length, 3);
});
test('web deleted committed attempt returns typed completion without resurrection', async () => {
  const h = harness(new File(['%PDF-1.7'], 'Course.pdf'), 'two_guest_successes_v1'); const selected = await h.service.pickDocument(); assert.ok(selected);
  const result = await h.service.importFile(selected.uri, selected.name, guestAttempt); assert.ok(result.document); await h.storage.deleteDocument(result.document.id);
  assert.equal((await h.fresh().importFile(selected.uri, selected.name, guestAttempt)).code, 'already_deleted');
  assert.equal((await h.storage.getAllDocuments()).length, 0);
});
for (const policy of ['disabled', 'two_guest_successes_v1'] as const) for (const kind of ['guest', 'account'] as const) {
  test(`web V3 ${policy}/${kind} replays without File and preserves deleted tombstone`, async () => {
    const h = harness(new File(['%PDF-1.7 original'], 'Replay.pdf'), policy);
    const selected = await h.service.pickDocument(); assert.ok(selected);
    const context = { attemptId: 'all-web', actor: kind === 'guest' ? { kind } : { kind, uid: 'fictional' } };
    const first = await h.service.importFile(selected.uri, selected.name, context); assert.ok(first.document, first.errorMessage ?? 'Import failed');
    assert.throws(() => getWebImportSource(selected.uri), /no longer available/);
    const replay = await h.fresh().importFile(selected.uri, selected.name, context);
    assert.equal(replay.code, 'committed'); assert.equal(replay.document?.id, first.document.id); assert.equal(h.files.size, 1);
    await h.storage.deleteDocument(first.document.id);
    assert.equal((await h.fresh().importFile(selected.uri, selected.name, context)).code, 'already_deleted'); assert.equal(h.files.size, 0);
  });
}
test('web authoritative save failures retain domain codes and the selected source', async () => {
  const h = harness(new File(['%PDF-1.7'], 'Course.pdf'), 'two_guest_successes_v1');
  const selected = await h.service.pickDocument(); assert.ok(selected);
  for (const code of ['guest_limit', 'guest_usage_recovery', 'storage_conflict', 'retry'] as const) {
    h.storage.saveDocument = async () => { throw new ImportOperationError(code, 'Authoritative failure'); };
    const result = await h.service.importFile(selected.uri, selected.name, guestAttempt);
    assert.equal(result.code, code); assert.ok(getWebImportSource(selected.uri).size > 0);
  }
  releaseWebImportSource(selected.uri);
});
test('public web save captures guest actor and input synchronously before client/queue awaits', async () => {
  let json: string | null = null, revision = 0;
  const blobs = new Map<string, Blob>();
  const client: IndexedDbClient = {
    readLibrary: async () => ({ json, revision }),
    commitLibrary: async (_, expected, value, pending = []) => {
      assert.equal(expected, revision); json = value; for (const entry of pending) blobs.set(entry.path, entry.blob); return ++revision;
    },
    readOwnedDocument: async path => { const blob = blobs.get(path); assert.ok(blob); return blob; },
    removeOwnedDocument: async path => { blobs.delete(path); return ++revision; },
  };
  let releaseClient!: () => void;
  const clientReady = new Promise<void>(resolve => { releaseClient = resolve; });
  const store = createWebDocumentStore(async () => { await clientReady; return client; }, 'two_guest_successes_v1');
  const file = new File(['%PDF-1.7 original'], 'Original.pdf'), source = registerWebImportSource(file, '');
  const replacement = registerWebImportSource(new File(['replaced'], 'Replacement.docx'), '');
  const submitted: SaveDocumentInput = { originalPath: source, title: 'Original', format: DocumentFormat.PDF,
    attempt: { attemptId: 'submitted-guest', actor: { kind: 'guest' } } };
  const save = store.saveDocument(submitted);
  submitted.attempt = { attemptId: 'later-account', actor: { kind: 'account', uid: 'u' } };
  submitted.originalPath = replacement; submitted.title = 'Replaced'; submitted.format = DocumentFormat.DOCX;
  releaseClient();
  try {
    const document = await save;
    assert.deepEqual(await store.getGuestAllowance(), { kind: 'ready', used: 1, remaining: 1 });
    assert.equal(document.title, 'Original'); assert.equal(document.format, DocumentFormat.PDF);
    assert.deepEqual(JSON.parse(json!).guestImports, [{ attemptId: 'submitted-guest', documentId: document.id }]);
    assert.equal((await store.lookupGuestImportOutcome('later-account')).kind, 'uncommitted');
    assert.equal(await (await client.readOwnedDocument(document.filePath)).text(), await file.text());
  } finally { releaseWebImportSource(source); releaseWebImportSource(replacement); }
});


test('owner serializes canceled web picker and fresh owner retains Blob after disposed picker finishes',async()=>{
 const h=harness(new File(['%PDF-1.7'],'Course.pdf'));const originalPick=h.io.pick;let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve});let calls=0;
 h.io.pick=async options=>{calls++;if(calls===1)await pending;return originalPick(options)};
 const make=(service:DocumentImportService)=>new UploadSession({policy:'disabled',pick:()=>service.pickDocument(),discard:uri=>service.discardSelection(uri),importFile:(u,n,a)=>service.importFile(u,n,a),allowance:()=>h.storage.getGuestAllowance(),lookup:id=>h.storage.lookupGuestImportOutcome(id)});
 const owner=make(h.service);owner.ensure();const first=owner.pick({kind:'guest'});owner.cancel();owner.ensure();assert.equal(owner.pick({kind:'guest'}),first);assert.equal(calls,1);owner.dispose();const replacement=make(h.fresh());replacement.ensure();await replacement.pick({kind:'guest'});const selected=replacement.getSnapshot().asset!;release();await first;assert.equal(getWebImportSource(selected.uri).size,8);replacement.dispose();assert.throws(()=>getWebImportSource(selected.uri),/no longer available/);
});
for(const name of ['Empty.pdf','Wrong.pdf','Invalid.docx'])test(`web invalid ${name} is typed reselect`,async()=>{const h=harness(new File([name==='Empty.pdf'?'':'invalid'],name));const selected=await h.service.pickDocument();assert.ok(selected);assert.equal((await h.service.importFile(selected.uri,selected.name)).code,'reselect');h.service.discardSelection(selected.uri);});
