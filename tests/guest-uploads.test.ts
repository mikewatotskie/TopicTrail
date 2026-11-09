import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentFormat, Document } from '../src/core/models/document';
import { DocumentRepository, type DocumentStoragePort } from '../src/core/services/document_repository';
import { decodeDocumentLibrary, encodeDocumentLibrary } from '../src/core/services/document_library_codec';

const enabled = 'two_guest_successes_v1' as const;
const input = { originalPath: 'selection', title: 'Course', format: DocumentFormat.PDF };
const attempt = (attemptId: string, actor: { kind: 'guest' } | { kind: 'account'; uid: string } = { kind: 'guest' }) => ({ attemptId, actor });
function fixture(initial: string | null = null) {
  let json = initial, writes = 0, copies = 0;
  const files = new Set<string>();
  const port: DocumentStoragePort = { readMetadata: async () => json,
    writeMetadata: async value => { writes++; json = value; },
    copyToDocuments: async (_, id) => { copies++; files.add(id); return { filePath: id, size: 8 }; },
    removeFile: async path => { files.delete(path); }, fileExists: async path => files.has(path) };
  return { port, files, read: () => json, counts: () => ({ writes, copies }), repo: () => new DocumentRepository(port, enabled) };
}
test('guest successes commit 0 -> 1 -> 2 atomically and third/missing context perform no copy/write', async () => {
  const f = fixture(), repo = f.repo();
  assert.deepEqual(await repo.getGuestAllowance(), { kind: 'ready', used: 0, remaining: 2 });
  await assert.rejects(repo.saveDocument(input), /attempt/i);
  for (const id of ['first', 'second']) {
    await repo.saveDocument({ ...input, attempt: attempt(id) });
    const stored = JSON.parse(f.read()!); assert.equal(stored.documents.length, stored.guestImports.length);
  }
  assert.deepEqual(await f.repo().getGuestAllowance(), { kind: 'ready', used: 2, remaining: 0 });
  const before = f.counts(); await assert.rejects(repo.saveDocument({ ...input, attempt: attempt('third') }), /guest|limit/i);
  assert.deepEqual(f.counts(), before);
});
test('same attempt concurrent retries reuse exact document; actor changes cannot create another document', async () => {
  const f = fixture(), repo = f.repo();
  const docs = await Promise.all([repo.saveDocument({ ...input, attempt: attempt('one') }), repo.saveDocument({ ...input, attempt: attempt('one') })]);
  assert.equal(docs[0].id, docs[1].id); assert.deepEqual(f.counts(), { copies: 1, writes: 1 });
  assert.equal((await f.repo().saveDocument({ ...input, attempt: attempt('one', { kind: 'account', uid: 'signed-in' }) })).id, docs[0].id);
});
test('legacy and V2 metadata do not activate disabled policy and disabled saves never retrocharge', async () => {
  const f = fixture(JSON.stringify({ version: 2, documents: [], guestImports: [] }));
  const disabled = new DocumentRepository(f.port);
  assert.equal(disabled.guestUploadPolicy, 'disabled'); assert.deepEqual(await disabled.getGuestAllowance(), { kind: 'disabled' });
  await disabled.saveDocument(input); assert.deepEqual(await f.repo().getGuestAllowance(), { kind: 'ready', used: 0, remaining: 2 });
});
test('receipts survive disabled saves, rename/open, deletion intent, rollback and compaction; deleted replay never resurrects', async () => {
  const f = fixture(), repo = f.repo(); const doc = await repo.saveDocument({ ...input, attempt: attempt('one') });
  const off = new DocumentRepository(f.port); await off.saveDocument(input);
  await off.updateDocument(doc.copyWith({ title: 'Renamed' })); await off.updateLastOpened(doc.id);
  const write = f.port.writeMetadata; const snapshots: string[] = [];
  f.port.writeMetadata = async value => { snapshots.push(value); await write(value); };
  f.port.removeFile = async () => { throw Error('denied'); };
  await assert.rejects(off.deleteDocument(doc.id), /denied/);
  f.port.removeFile = async path => { f.files.delete(path); };
  await off.deleteDocument(doc.id);
  for (const value of snapshots) assert.deepEqual(JSON.parse(value).guestImports, [{ attemptId: 'one', documentId: doc.id }]);
  assert.deepEqual(await f.repo().lookupGuestImportOutcome('one'), { kind: 'deleted' });
  await assert.rejects(f.repo().saveDocument({ ...input, attempt: attempt('one') }), /deleted/);
  assert.deepEqual(await f.repo().getGuestAllowance(), { kind: 'ready', used: 1, remaining: 1 });
});
test('copy failures never charge and signing in cannot bypass backup replay uncertainty', async () => {
  const f = fixture(); f.port.copyToDocuments = async () => { throw Error('copy failed'); };
  await assert.rejects(f.repo().saveDocument({ ...input, attempt: attempt('failed') }), /copy failed/);
  assert.equal(f.read(), null);
  const b = fixture(); b.port.readMetadataWithOrigin = async () => ({ json: b.read(), origin: 'backup' });
  const repo = b.repo(); assert.deepEqual(await repo.getGuestAllowance(), { kind: 'recovery_required' });
  await assert.rejects(repo.saveDocument({ ...input, attempt: attempt('guest') }), /recovery/i);
  await assert.rejects(repo.saveDocument({ ...input, attempt: attempt('account', { kind: 'account', uid: 'u' }) }), /recovery/i);
  assert.equal(b.read(), null); assert.equal(b.counts().writes, 0); assert.equal(b.counts().copies, 0);
  delete b.port.readMetadataWithOrigin;
  // The same repository cannot discard already-observed backup provenance.
  await assert.rejects(repo.saveDocument({ ...input, attempt: attempt('account-again', { kind: 'account', uid: 'u' }) }), /recovery/i);
});
test('uncertain successful metadata write never removes committed bytes; unreadable verification preserves bytes', async () => {
  const f = fixture(), write = f.port.writeMetadata;
  f.port.writeMetadata = async value => { await write(value); throw Error('after commit'); };
  const doc = await f.repo().saveDocument({ ...input, attempt: attempt('one') });
  assert.ok(f.files.has(doc.filePath)); assert.equal((await f.repo().lookupGuestImportOutcome('one')).kind, 'committed');
  const g = fixture(); g.port.writeMetadata = async () => { g.port.readMetadata = async () => { throw Error('unreadable'); }; throw Error('uncertain'); };
  await assert.rejects(g.repo().saveDocument({ ...input, attempt: attempt('two') }), /retry|verif|uncertain/i); assert.equal(g.files.size, 1);
});
for (const recoveryEntry of ['lookup', 'allowance', 'retry', 'mutation'] as const) {
  test(`same repository recovers uncertain committed metadata before later ${recoveryEntry}`, async () => {
    const f = fixture(), repository = f.repo(), write = f.port.writeMetadata, read = f.port.readMetadata;
    let failVerification = false;
    f.port.writeMetadata = async value => { await write(value); failVerification = true; throw Error('Commit reported failure'); };
    f.port.readMetadata = async () => {
      if (failVerification) { failVerification = false; throw Error('Verification temporarily unreadable'); }
      return read();
    };
    await assert.rejects(repository.saveDocument({ ...input, attempt: attempt('uncertain') }), /verified|retry/i);
    const committed = JSON.parse(f.read()!), documentId = committed.documents[0].id;
    assert.equal(f.files.size, 1); f.port.writeMetadata = write;
    if (recoveryEntry === 'lookup') {
      const outcome = await repository.lookupGuestImportOutcome('uncertain');
      assert.equal(outcome.kind, 'committed'); if (outcome.kind === 'committed') assert.equal(outcome.document.id, documentId);
    } else if (recoveryEntry === 'allowance') {
      assert.deepEqual(await repository.getGuestAllowance(), { kind: 'ready', used: 1, remaining: 1 });
    } else if (recoveryEntry === 'retry') {
      const replay = await repository.saveDocument({ ...input, attempt: attempt('uncertain') }); assert.equal(replay.id, documentId);
      assert.equal(f.counts().copies, 1);
    }
    await repository.saveDocument({ ...input, attempt: attempt('account', { kind: 'account', uid: 'u' }) });
    const final = JSON.parse(f.read()!);
    const documents = Array.isArray(final) ? final : final.documents;
    assert.equal(documents.length, 2); assert.ok(documents.some((document: { id: string }) => document.id === documentId));
    assert.deepEqual(final.guestImports, committed.guestImports); assert.equal(f.files.size, 2);
    assert.equal((await repository.lookupGuestImportOutcome('uncertain')).kind, 'committed');
  });
}
test('confirmed failed metadata commit removes only unreferenced output and never spends a guest success', async () => {
  const f = fixture(); f.port.writeMetadata = async () => { throw Error('Disk full'); };
  const repository = f.repo(); await assert.rejects(repository.saveDocument({ ...input, attempt: attempt('failed') }), /Disk full/);
  assert.equal(f.files.size, 0); assert.equal(f.read(), null);
  assert.deepEqual(await repository.getGuestAllowance(), { kind: 'ready', used: 0, remaining: 2 });
});
test('actor is captured before async work, and recovery compaction preserves every receipt and recovery flag', async () => {
  const f = fixture(), repository = f.repo(); const context = attempt('guest');
  const pending = repository.saveDocument({ ...input, attempt: context }); context.actor = { kind: 'account', uid: 'later' };
  const document = await pending; assert.deepEqual(await repository.getGuestAllowance(), { kind: 'ready', used: 1, remaining: 1 });
  const library = JSON.parse(f.read()!); library.documents[0].pendingDeletion = true; library.guestUsageRecoveryRequired = true;
  await f.port.writeMetadata(JSON.stringify(library)); f.files.delete(document.filePath);
  const recovering = f.repo(); assert.deepEqual(await recovering.getAllDocuments(), []);
  await recovering.saveDocument({ ...input, attempt: attempt('account', { kind: 'account', uid: 'u' }) });
  assert.deepEqual(JSON.parse(f.read()!).guestImports, library.guestImports); assert.equal(JSON.parse(f.read()!).guestUsageRecoveryRequired, true);
});
test('corrupt and unknown metadata is recoverable and never reset or overwritten', async () => {
  const doc = new Document('d', 'D', DocumentFormat.PDF, 'p', new Date()).toJson();
  for (const value of ['{bad', { version: 3, documents: [], guestImports: [] },
    { version: 2, documents: [doc], guestImports: [{ attemptId: 'a', documentId: 'd' }, { attemptId: 'a', documentId: 'e' }] },
    { version: 2, documents: [], guestImports: [], guestUsageRecoveryRequired: false },
    { version: 2, documents: [{ ...doc, pendingDeletion: 'yes' }], guestImports: [] }]) {
    const json = typeof value === 'string' ? value : JSON.stringify(value), f = fixture(json);
    await assert.rejects(f.repo().getGuestAllowance(), /metadata|recovery/i); assert.equal(f.read(), json); assert.equal(f.counts().writes, 0);
  }
});

for (const policy of ['disabled', enabled] as const) for (const kind of ['guest', 'account'] as const) {
  test(`V3 ${policy}/${kind} replays across restart and retains deleted tombstone without copying`, async () => {
    const f = fixture(), actor = kind === 'guest' ? { kind } : { kind, uid: 'fictional' };
    const context = attempt('all-imports', actor);
    const repo = new DocumentRepository(f.port, policy), first = await repo.saveDocument({ ...input, attempt: context });
    const snapshot = JSON.parse(f.read()!);
    assert.equal(snapshot.version, 3);
    assert.deepEqual(snapshot.importAttempts, [{ attemptId: context.attemptId, documentId: first.id }]);
    assert.equal(snapshot.guestImports.length, policy === enabled && kind === 'guest' ? 1 : 0);
    const before = f.counts(), fresh = new DocumentRepository(f.port, policy);
    assert.equal((await fresh.saveDocument({ ...input, originalPath: 'missing', attempt: context })).id, first.id);
    assert.deepEqual(f.counts(), before);
    await fresh.updateDocument(first.copyWith({ title: 'Renamed 日本語' })); await fresh.updateLastOpened(first.id);
    const write = f.port.writeMetadata, snapshots: string[] = [];
    f.port.writeMetadata = async value => { snapshots.push(value); await write(value); };
    f.port.removeFile = async () => { throw Error('Denied deletion'); };
    await assert.rejects(fresh.deleteDocument(first.id), /Denied/);
    f.port.removeFile = async path => { f.files.delete(path); };
    await fresh.deleteDocument(first.id);
    for (const value of snapshots) assert.deepEqual(JSON.parse(value).importAttempts, snapshot.importAttempts);
    const deleted = new DocumentRepository(f.port, policy), counts = f.counts();
    assert.deepEqual(await deleted.lookupGuestImportOutcome(context.attemptId), { kind: 'deleted' });
    await assert.rejects(deleted.saveDocument({ ...input, attempt: context }), /deleted/);
    assert.deepEqual(f.counts(), counts);
  });
  test(`V3 ${policy}/${kind} reconciles committed-but-unreadable write on same and fresh repository`, async () => {
    for (const fresh of [false, true]) {
      const f = fixture(), write = f.port.writeMetadata, read = f.port.readMetadata;
      let unreadable = false;
      f.port.writeMetadata = async json => { await write(json); unreadable = true; throw Error('After commit'); };
      f.port.readMetadata = async () => { if (unreadable) { unreadable = false; throw Error('Unreadable verification'); } return read(); };
      const repo = new DocumentRepository(f.port, policy), context = attempt('uncertain-all', kind === 'guest' ? { kind } : { kind, uid: 'fixture' });
      await assert.rejects(repo.saveDocument({ ...input, attempt: context }), /verified|retry/);
      assert.equal(f.files.size, 1); f.port.writeMetadata = write;
      const document = await (fresh ? new DocumentRepository(f.port, policy) : repo).saveDocument({ ...input, attempt: context });
      assert.equal(f.counts().copies, 1); assert.equal(f.counts().writes, 1);
      assert.equal(JSON.parse(f.read()!).documents[0].id, document.id);
    }
  });
}
test('legacy/V2 reads do not write; first mutation emits V3 and seeds only real receipts', async () => {
  const doc = new Document('old-doc', 'Old', DocumentFormat.PDF, 'old-path', new Date(), 17, 4).toJson();
  for (const initial of [JSON.stringify([doc]), JSON.stringify({ version: 2, documents: [doc], guestImports: [{ attemptId: 'old-charged', documentId: 'old-doc' }] })]) {
    const f = fixture(initial), repo = new DocumentRepository(f.port);
    const docs = await repo.getAllDocuments(); assert.equal(f.read(), initial); assert.equal(f.counts().writes, 0);
    await repo.updateDocument(docs[0].copyWith({ title: 'Preserved' }));
    const data = JSON.parse(f.read()!); assert.equal(data.version, 3); assert.equal(data.documents[0].filePath, doc.filePath);
    assert.equal(data.documents[0].fileSize, 17); assert.equal(data.documents[0].pageCount, 4);
    assert.deepEqual(data.importAttempts, data.guestImports);
    assert.equal(data.importAttempts.length, Array.isArray(JSON.parse(initial)) ? 0 : 1);
    assert.deepEqual(await repo.getGuestAllowance(), { kind: 'disabled' });
  }
});
test('V3 codec rejects inconsistent replay mappings and invalid recovery flags without writing', async () => {
  const valid = { version: 3, documents: [], guestImports: [], importAttempts: [{ attemptId: 'a', documentId: 'deleted' }] };
  assert.deepEqual(JSON.parse(encodeDocumentLibrary(decodeDocumentLibrary(JSON.stringify(valid)))), valid);
  for (const value of [
    { ...valid, version: 4 }, { ...valid, importAttempts: null }, { ...valid, importAttempts: [{ attemptId: ' ', documentId: 'd' }] },
    { ...valid, importAttempts: [{ attemptId: 'a', documentId: 'd' }, { attemptId: 'a', documentId: 'e' }] },
    { ...valid, importAttempts: [{ attemptId: 'a', documentId: 'd' }, { attemptId: 'b', documentId: 'd' }] },
    { ...valid, guestImports: [{ attemptId: 'a', documentId: 'different' }] },
    { ...valid, guestImports: [{ attemptId: 'missing', documentId: 'different' }] },
    { ...valid, importReplayRecoveryRequired: false }, { ...valid, importReplayRecoveryRequired: 'true' },
    { ...valid, version: 2 },
  ]) {
    const json = JSON.stringify(value), f = fixture(json);
    await assert.rejects(f.repo().getAllDocuments(), /metadata|recovery/);
    assert.equal(f.read(), json); assert.equal(f.counts().writes, 0);
  }
});
test('backup-origin replay uncertainty blocks every unknown import, survives ordinary mutation and never deletes uncertain bytes', async () => {
  const doc = new Document('kept', 'Keep', DocumentFormat.PDF, 'kept', new Date()).toJson();
  const f = fixture(JSON.stringify({ version: 2, documents: [doc], guestImports: [{ attemptId: 'known', documentId: 'kept' }] }));
  f.files.add('kept'); f.port.readMetadataWithOrigin = async () => ({ json: f.read(), origin: 'backup' });
  const repo = new DocumentRepository(f.port);
  assert.equal((await repo.lookupGuestImportOutcome('known')).kind, 'committed');
  const before = f.counts();
  for (const actor of [{ kind: 'guest' }, { kind: 'account', uid: 'fictional' }] as const) {
    await assert.rejects(repo.saveDocument({ ...input, attempt: attempt('unknown', actor) }), /replay|recovery/i);
  }
  await assert.rejects(repo.saveDocument(input), /replay|recovery/i);
  assert.deepEqual(f.counts(), before);
  await repo.updateDocument((await repo.getDocument('kept'))!.copyWith({ title: 'Still readable' }));
  delete f.port.readMetadataWithOrigin;
  const stored = JSON.parse(f.read()!); assert.equal(stored.importReplayRecoveryRequired, true);
  const restarted = new DocumentRepository(f.port);
  await assert.rejects(restarted.lookupGuestImportOutcome('unknown'), /replay|recovery/i);
  assert.equal((await restarted.lookupGuestImportOutcome('known')).kind, 'committed');
  await restarted.deleteDocument('kept');
  assert.deepEqual(await new DocumentRepository(f.port).lookupGuestImportOutcome('known'), { kind: 'deleted' });
  assert.equal(JSON.parse(f.read()!).importReplayRecoveryRequired, true);

  const uncertain = fixture(); const empty = uncertain.read();
  uncertain.port.writeMetadata = async () => {
    uncertain.port.readMetadataWithOrigin = async () => ({ json: empty, origin: 'backup' });
    throw Error('Uncertain write then older backup');
  };
  await assert.rejects(new DocumentRepository(uncertain.port).saveDocument({ ...input, attempt: attempt('possibly-committed') }), /replay|verified|recovery/i);
  assert.equal(uncertain.files.size, 1, 'An older backup cannot authorize removal of potentially committed bytes');
});
