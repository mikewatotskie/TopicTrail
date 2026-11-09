import { DocumentStorage, createWebDocumentStore } from '../../src/core/services/document_storage.web';
import { createIndexedDbClient, openTopicTrailDb } from '../../src/core/services/web/indexeddb_client';
import { getWebImportSource, registerWebImportSource, releaseWebImportSource } from '../../src/core/services/web/import_sources';
import { DocumentFormat } from '../../src/core/models/document';
import { DocumentImportService } from '../../src/core/services/document_import.web';
import { strToU8, zipSync } from 'fflate';
import { BookmarkRepository } from '../../src/core/services/bookmarks/repository';
import { createWebBookmarkPort } from '../../src/core/services/web/bookmark_port';
import { bookmarkStore, createWebBookmarkStore } from '../../src/core/services/bookmarks/storage.web';
import { decodeDocumentLibrary, encodeDocumentLibrary } from '../../src/core/services/document_library_codec';

export interface BrowserCaseResult { name: string; passed: boolean; error?: string }
export async function runWebStorageCases(): Promise<BrowserCaseResult[]> {
  const results: BrowserCaseResult[] = [];
  try {
    const documents = await DocumentStorage.instance.getAllDocuments();
    if (!Array.isArray(documents)) throw Error('Library did not return actual records');
    results.push({ name: 'web library loads without native filesystem', passed: true });
  } catch (error) {
    results.push({ name: 'web library loads without native filesystem', passed: false,
      error: error instanceof Error ? error.message : String(error) });
  }
  const factory = window.indexedDB;
  const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
  try { await bookmarkStore.initialize(); assert(bookmarkStore.getSnapshot().status === 'ready', 'Saved did not initialize'); results.push({ name: 'web Saved loads without native filesystem', passed: true }); }
  catch (error) { results.push({ name: 'web Saved loads without native filesystem', passed: false, error: String(error) }); }
  const cases: Record<string, (client: ReturnType<typeof createIndexedDbClient>, name: string) => Promise<void>> = {
    async 'two_clients_compete_for_exactly_one_guest_slot'(client, name) {
      const policy = 'two_guest_successes_v1' as const;
      const source = registerWebImportSource(new File(['%PDF-1.7 seed'], 'Seed.pdf'), '');
      const seed = createWebDocumentStore(async () => client, policy);
      await seed.saveDocument({ originalPath: source, title: 'Seed', format: DocumentFormat.PDF,
        attempt: { attemptId: 'seed', actor: { kind: 'guest' } } });
      releaseWebImportSource(source);
      const secondDb = await openTopicTrailDb(factory, name);
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      let arrived = 0;
      const revisions: number[] = [], attemptedPaths: string[][] = [];
      const gated = (target: typeof client) => ({ ...target,
        async commitLibrary(...args: Parameters<typeof client.commitLibrary>) {
          revisions.push(args[1]); attemptedPaths.push((args[3] ?? []).map(blob => blob.path));
          if (++arrived === 2) release();
          await barrier;
          return target.commitLibrary(...args);
        },
      });
      const stores = [createWebDocumentStore(async () => gated(client), policy),
        createWebDocumentStore(async () => gated(createIndexedDbClient(secondDb)), policy)];
      const services = stores.map((store, index) => new DocumentImportService(store, async () => ({ canceled: false,
        assets: [{ uri: '', name: `Candidate${index}.pdf`, lastModified: 0, file: new File(['%PDF-1.7 candidate'], `Candidate${index}.pdf`) }] })));
      const selections = await Promise.all(services.map(service => service.pickDocument()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const imports = Promise.all(services.map((service, index) => service.importFile(selections[index]!.uri, selections[index]!.name,
          { attemptId: `candidate-${index}`, actor: { kind: 'guest' } })));
        const outcomes = await Promise.race([imports, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { release(); reject(Error('Both importers did not reach the same-revision commit barrier')); }, 4000);
        })]);
        assert(revisions.length === 2 && revisions[0] === revisions[1] && revisions[0] === 1, 'Clients did not compete from the same seeded revision');
        assert(outcomes.filter(outcome => outcome.success).length === 1, 'Expected exactly one winning guest import');
        assert(outcomes.filter(outcome => outcome.code === 'storage_conflict').length === 1, 'Expected exactly one typed stale-write conflict');
        const record = JSON.parse((await client.readLibrary('documents')).json!);
        assert(record.documents.length === 2 && record.guestImports.length === 2, 'Atomic winner did not leave exactly two documents and receipts');
        const count = await new Promise<number>((resolve, reject) => {
          const tx = secondDb.transaction(['documents'], 'readonly'), request = tx.objectStore('documents').count();
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        assert(count === 2, 'Losing Blob leaked or a winning Blob was lost');
        const loser = outcomes.findIndex(outcome => !outcome.success);
        assert(getWebImportSource(selections[loser]!.uri).size > 0, 'Conflict discarded the losing selection');
        assert(!record.guestImports.some((receipt: { attemptId: string }) => receipt.attemptId === `candidate-${loser}`), 'Loser was charged');
        const committedPaths = new Set(record.documents.map((document: { filePath: string }) => document.filePath));
        assert(attemptedPaths.flat().filter(path => committedPaths.has(path)).length === 1, 'Both pending Blob paths became committed');
      } finally {
        clearTimeout(timer); release(); selections.forEach(selection => { if (selection) releaseWebImportSource(selection.uri); }); secondDb.close();
      }
    },
    async 'browser PDF and DOCX File imports are durable'(client) {
      const docx = zipSync({ '[Content_Types].xml': strToU8('<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
        'word/document.xml': strToU8('<document><body><p><r><t>Actual biology lesson.</t></r></p></body></document>') });
      for (const file of [new File(['%PDF-1.7\nActual fixture'], 'Browser.pdf'), new File([docx as BlobPart], 'Browser.docx')]) {
        const store = createWebDocumentStore(async () => client);
        const importer = new DocumentImportService(store, async () => ({ canceled: false, assets: [{ uri: '', name: file.name, size: file.size, file, lastModified: file.lastModified }] }));
        const selected = await importer.pickDocument(); if (!selected) throw Error('No selected file');
        const result = await importer.importFile(selected.uri, selected.name);
        assert(result.success, result.errorMessage ?? 'Browser import failed');
        const stored = await client.readOwnedDocument(result.document!.filePath);
        assert(await stored.text() === await file.text(), 'Imported bytes changed');
        assert((await store.getDocument(result.document!.id))?.title === file.name.replace(/\.[^.]+$/, ''), 'Imported metadata missing');
      }
    },
    async 'browser bookmarks persist and stale tabs recover without lost data'(client, name) {
      const otherDb = await openTopicTrailDb(factory, name);
      const first = new BookmarkRepository(createWebBookmarkPort(client));
      const second = new BookmarkRepository(createWebBookmarkPort(createIndexedDbClient(otherDb)));
      const article = { url: 'https://en.wikipedia.org/wiki/Iteration', title: 'Iteration', type: 'Article' as const, providerId: 'wikipedia', providerName: 'Wikipedia' };
      try {
        await Promise.all([first.initialize(), second.initialize()]);
        await first.save(article);
        let conflict = false;
        try { await second.save({ ...article, url: 'https://en.wikipedia.org/wiki/Photosynthesis', title: 'Photosynthesis' }); } catch { conflict = true; }
        assert(conflict && second.getSnapshot().bookmarks.length === 0, 'Stale bookmark write published');
        await second.reload();
        await second.save({ ...article, url: 'https://en.wikipedia.org/wiki/Photosynthesis', title: 'Photosynthesis' });
        await first.reload(); assert(first.getSnapshot().bookmarks.length === 2, 'A committed bookmark was lost');
        await first.remove(article.url); await second.reload();
        assert(second.getSnapshot().bookmarks.length === 1 && second.getSnapshot().bookmarks[0].title === 'Photosynthesis', 'Removal did not persist');
      } finally { otherDb.close(); }
    },
    async 'concurrent rename cannot resurrect metadata after byte deletion'(client) {
      const initial = createWebDocumentStore(async () => client);
      const source = registerWebImportSource(new File(['%PDF-1.7 fixture'], 'Race.pdf'), '');
      const saved = await initial.saveDocument({ originalPath: source, title: 'Race', format: DocumentFormat.PDF });
      releaseWebImportSource(source);
      let reached!: () => void; let resume!: () => void;
      const reachedGate = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const pause = async () => { reached(); await gate; };
      const paused = { ...client,
        async commitLibrary(...args: Parameters<typeof client.commitLibrary>) {
          if (((args as unknown[])[4] as readonly string[] | undefined)?.length) await pause();
          return client.commitLibrary(...args);
        },
        async removeOwnedDocument(path: string, revision: number) { await pause(); return client.removeOwnedDocument(path, revision); },
      };
      const first = createWebDocumentStore(async () => paused);
      const deletion = first.deleteDocument(saved.id).then(() => 'deleted', () => 'conflict');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([reachedGate, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Deletion did not reach transaction gate')), 3000); })]);
        const second = createWebDocumentStore(async () => client);
        const current = await second.getDocument(saved.id); assert(current, 'Document disappeared before transaction');
        await second.updateDocument(current!.copyWith({ title: 'Renamed in other tab' }));
        resume(); const outcome = await deletion;
        const record = await second.getDocument(saved.id);
        assert(record?.title === 'Renamed in other tab', 'Concurrent metadata changed');
        assert((await client.readOwnedDocument(saved.filePath)).size > 0, 'Concurrent rename was left without bytes');
        assert(outcome === 'conflict', 'Stale delete incorrectly reported success');
      } finally { clearTimeout(timer); resume(); await deletion; }
    },
    async 'Saved reacquires a replaced database connection without losing bookmarks'(client, name) {
      let connection = await openTopicTrailDb(factory, name);
      let selected = createIndexedDbClient(connection);
      const store = createWebBookmarkStore(async () => selected);
      try {
        await store.initialize();
        await store.save({ url: 'https://en.wikipedia.org/wiki/Iteration', title: 'Iteration', providerId: 'wikipedia', providerName: 'Wikipedia', type: 'Article', description: 'Fixture' });
        connection.close(); connection = await openTopicTrailDb(factory, name); selected = createIndexedDbClient(connection);
        await store.reload();
        assert(store.getSnapshot().bookmarks.length === 1, 'Replacement lost existing bookmark');
        await store.save({ url: 'https://en.wikipedia.org/wiki/Photosynthesis', title: 'Photosynthesis', providerId: 'wikipedia', providerName: 'Wikipedia', type: 'Article', description: 'Fixture' });
        assert(store.getSnapshot().bookmarks.length === 2, 'Replacement could not persist new bookmark');
      } finally { connection.close(); }
    },
    async 'successful byte deletion advances revision and rejects stale resurrection'(client) {
      const source = registerWebImportSource(new File(['%PDF-1.7 fixture'], 'Delete.pdf'), '');
      const store = createWebDocumentStore(async () => client);
      const saved = await store.saveDocument({ originalPath: source, title: 'Delete', format: DocumentFormat.PDF }); releaseWebImportSource(source);
      const before = await client.readLibrary('documents');
      const library = decodeDocumentLibrary(before.json); library.pendingDeletion = new Set([saved.id]);
      const intent = encodeDocumentLibrary(library);
      const revision = await client.commitLibrary('documents', before.revision, intent);
      const stale = await client.readLibrary('documents'); await client.readOwnedDocument(saved.filePath);
      const removed = await client.removeOwnedDocument(saved.filePath, revision);
      assert(removed > stale.revision, 'Byte removal did not advance metadata revision');
      let conflict = false; try { await client.commitLibrary('documents', stale.revision, before.json!); } catch { conflict = true; }
      assert(conflict, 'Stale tab resurrected deleted metadata');
      assert((await store.getAllDocuments()).length === 0, 'Journal recovery resurrected missing bytes');
    },
    async 'new library is empty'(client) { const record = await client.readLibrary('documents'); assert(record.json === null && record.revision === 0, 'Unexpected initial library'); },
    async 'document bytes and metadata survive reopen'(client, name) {
      const file = new File(['%PDF-1.7\noriginal fixture'], 'Original.pdf');
      const source = registerWebImportSource(file, '');
      try {
        const store = createWebDocumentStore(async () => client);
        const doc = await store.saveDocument({ originalPath: source, title: 'Original', format: DocumentFormat.PDF });
        const secondDb = await openTopicTrailDb(factory, name);
        try {
          const reopened = createIndexedDbClient(secondDb);
          const docs = await createWebDocumentStore(async () => reopened).getAllDocuments();
          assert(docs.length === 1 && docs[0].filePath === doc.filePath, 'Metadata not durable');
          assert(await (await reopened.readOwnedDocument(doc.filePath)).text() === await file.text(), 'Bytes changed');
          await store.updateDocument(doc.copyWith({ title: 'Renamed' }));
          assert((await store.getDocument(doc.id))?.title === 'Renamed', 'Rename failed');
          await store.deleteDocument(doc.id);
          assert((await store.getAllDocuments()).length === 0, 'Delete failed');
          assert(await file.text() === '%PDF-1.7\noriginal fixture', 'Original changed');
        } finally { secondDb.close(); }
      } finally { releaseWebImportSource(source); }
    },
    async 'aborted commit preserves previous bytes and metadata'(client) {
      const path = 'topictrail-idb://documents/fixture-one.pdf';
      await client.commitLibrary('documents', 0, 'previous', [{ path, blob: new Blob(['original']) }]);
      let failed = false;
      try { await client.commitLibrary('documents', 1, 'replacement', [{ path, blob: new Blob(['overwrite']) }]); } catch { failed = true; }
      assert(failed, 'Duplicate owned file was overwritten');
      assert((await client.readLibrary('documents')).json === 'previous', 'Aborted metadata leaked');
      assert(await (await client.readOwnedDocument(path)).text() === 'original', 'Old bytes lost');
    },
    async 'stale revision is rejected'(client) {
      await client.commitLibrary('documents', 0, 'first');
      let failed = false;
      try { await client.commitLibrary('documents', 0, 'stale'); } catch { failed = true; }
      assert(failed && (await client.readLibrary('documents')).json === 'first', 'Stale writer replaced data');
    },
    async 'two connections cannot silently overwrite a library'(client, name) {
      const secondDb = await openTopicTrailDb(factory, name);
      try {
        const second = createIndexedDbClient(secondDb);
        const outcomes = await Promise.allSettled([
          client.commitLibrary('documents', 0, 'first'), second.commitLibrary('documents', 0, 'second'),
        ]);
        assert(outcomes.filter(value => value.status === 'fulfilled').length === 1, 'Both stale writers committed');
        assert((await client.readLibrary('documents')).revision === 1, 'Concurrent transaction was not atomic');
      } finally { secondDb.close(); }
    },
    async 'quota rejection does not publish a new document'(client) {
      await client.commitLibrary('documents', 0, '[]');
      const source = registerWebImportSource(new File(['%PDF-1.7'], 'Quota.pdf'), '');
      try {
        const quotaClient = { ...client, commitLibrary: async (): Promise<number> => { throw new DOMException('Quota test', 'QuotaExceededError'); } };
        let failed = false;
        try { await createWebDocumentStore(async () => quotaClient).saveDocument({ originalPath: source, title: 'Quota', format: DocumentFormat.PDF }); }
        catch { failed = true; }
        assert(failed && (await client.readLibrary('documents')).json === '[]', 'Quota failure replaced the library');
      } finally { releaseWebImportSource(source); }
    },
    async 'foreign path cannot be removed'(client) {
      let failed = false; try { await client.removeOwnedDocument('file:///user/Original.pdf', 0); } catch { failed = true; }
      assert(failed, 'Foreign path accepted');
    },
    async 'corrupt metadata remains recoverable'(client) {
      await client.commitLibrary('documents', 0, '{broken');
      let failed = false; try { await createWebDocumentStore(async () => client).getAllDocuments(); } catch { failed = true; }
      assert(failed && (await client.readLibrary('documents')).json === '{broken', 'Corrupt data reset');
    },
  };
  for (const policy of ['disabled', 'two_guest_successes_v1'] as const) for (const kind of ['guest', 'account'] as const) {
    cases[`V3 ${policy}/${kind} replay, uncertain commit, reopen and deleted tombstone`] = async (client, name) => {
      const file = new File(['%PDF-1.7 V3 replay'], 'V3.pdf'), source = registerWebImportSource(file, '');
      const attempt = { attemptId: 'browser-replay', actor: kind === 'guest' ? { kind } : { kind, uid: 'fictional' } };
      const input = { originalPath: source, title: 'Replay', format: DocumentFormat.PDF, attempt };
      let failRead = false, commits = 0;
      const uncertain = { ...client,
        readLibrary: async (...args: Parameters<typeof client.readLibrary>) => {
          if (failRead) { failRead = false; throw Error('Controlled verification failure'); } return client.readLibrary(...args);
        },
        commitLibrary: async (...args: Parameters<typeof client.commitLibrary>) => {
          await client.commitLibrary(...args); commits++; failRead = true; throw Error('Controlled failure after real atomic commit');
        },
      };
      let secondDb: IDBDatabase | undefined;
      try {
        let code: string | undefined;
        try { await createWebDocumentStore(async () => uncertain, policy).saveDocument(input); }
        catch (error) { code = (error as { code?: string }).code; }
        assert(code === 'retry' && commits === 1, 'Did not exercise an uncertain committed transaction');
        const stored = JSON.parse((await client.readLibrary('documents')).json!);
        assert(stored.version === 3 && stored.documents.length === 1 && stored.importAttempts.length === 1, 'Replay identity not atomic with document');
        const expectedCharges = policy === 'two_guest_successes_v1' && kind === 'guest' ? 1 : 0;
        assert(stored.guestImports.length === expectedCharges, 'Incorrect guest charge');
        releaseWebImportSource(source);
        secondDb = await openTopicTrailDb(factory, name);
        const reopened = createWebDocumentStore(async () => createIndexedDbClient(secondDb!), policy);
        const replay = await reopened.saveDocument(input);
        assert(replay.id === stored.documents[0].id, 'Uncharged replay created another document');
        assert(await (await client.readOwnedDocument(replay.filePath)).text() === await file.text(), 'Committed bytes lost');
        const service = new DocumentImportService(reopened);
        assert((await service.importFile('missing', 'V3.pdf', attempt)).code === 'committed', 'Replay required selected File');
        await reopened.deleteDocument(replay.id);
        const after = JSON.parse((await client.readLibrary('documents')).json!);
        assert(after.documents.length === 0 && after.importAttempts.length === 1 && after.guestImports.length === expectedCharges, 'Deletion stripped tombstone or refunded charge');
        assert((await service.importFile('missing', 'V3.pdf', attempt)).code === 'already_deleted', 'Deleted attempt resurrected');
        assert((await client.readLibrary('documents')).json === JSON.stringify(after), 'Read-only replay wrote metadata');
      } finally { secondDb?.close(); releaseWebImportSource(source); }
    };
  }
  for (const [name, run] of Object.entries(cases)) {
    if (typeof document !== 'undefined') document.querySelector('pre')!.textContent = JSON.stringify([...results, { name, state: 'running' }], null, 2);
    const databaseName = 'topictrail-check-' + crypto.randomUUID();
    const db = await openTopicTrailDb(factory, databaseName);
    try { await run(createIndexedDbClient(db), databaseName); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); }
    finally {
      db.close();
      if (!databaseName.startsWith('topictrail-check-')) throw Error('Unsafe test cleanup');
      await new Promise<void>((resolve, reject) => { const request = factory.deleteDatabase(databaseName); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    }
  }
  return results;
}

if (typeof window !== 'undefined') {
  void runWebStorageCases().then(async results => {
    const output = document.querySelector('pre')!;
    output.textContent = JSON.stringify(results, null, 2);
    document.title = results.every(result => result.passed) ? 'PASS — TopicTrail checks' : 'FAIL — TopicTrail checks';
    await fetch('/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(results) });
  });
}
