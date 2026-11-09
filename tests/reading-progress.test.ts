import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentFormat } from '../src/core/models/document';
import { ReadingProgressSession, ReadingProgressStore } from '../src/core/services/reading_progress';

const pdf = { id: 'syllabus', format: DocumentFormat.PDF };
const docx = { id: 'syllabus', format: DocumentFormat.DOCX };
const position = (page: number, totalPages = 9) => ({ page, totalPages });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const values = new Map<string, string>();
  const io = {
    async getItem(key: string) { return values.get(key) ?? null; },
    async setItem(key: string, value: string) { values.set(key, value); },
  };
  return { values, io, store: new ReadingProgressStore(io) };
}

test('durable positions are isolated by document and format', async () => {
  const { io, store } = fixture();
  await store.save(pdf, position(4));
  await store.save(docx, position(2, 3));

  const reopened = new ReadingProgressStore(io);
  assert.deepEqual(await reopened.read(pdf), position(4));
  assert.deepEqual(await reopened.read(docx), position(2, 3));
  assert.equal(await reopened.read({ ...pdf, id: 'other' }), null);
});

test('invalid positions and malformed stored progress cannot replace the stored value', async () => {
  const { values, store } = fixture();
  await store.save(pdf, position(4));
  const key = [...values.keys()][0];
  await assert.rejects(store.save(pdf, position(10)));
  assert.deepEqual(await store.read(pdf), position(4));

  const serialized = JSON.parse(values.get(key)!);
  for (const corrupt of ['broken json', JSON.stringify({ ...serialized, version: 2 }),
    JSON.stringify({ ...serialized, page: 0 }), JSON.stringify({ ...serialized, documentId: 'other' })]) {
    values.set(key, corrupt);
    await assert.rejects(store.read(pdf), /Invalid reading progress/);
    await assert.rejects(store.save(pdf, position(3)), /Invalid reading progress/);
    assert.equal(values.get(key), corrupt);
  }
});

test('a failed durable write preserves the old position and does not poison the queue', async () => {
  const { io, store } = fixture();
  await store.save(pdf, position(2));
  const commit = io.setItem;
  io.setItem = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(store.save(pdf, position(4)), /Storage unavailable/);
  assert.deepEqual(await store.read(pdf), position(2));
  io.setItem = commit;
  await store.save(pdf, position(3));
  assert.deepEqual(await store.read(pdf), position(3));
});

test('concurrent writes commit in order and a focus read waits for queued writes', async () => {
  const { values, io, store } = fixture();
  const gate = deferred();
  const commit = io.setItem;
  io.setItem = async (key, value) => { await gate.promise; await commit(key, value); };
  const first = store.save(pdf, position(2));
  const second = store.save(pdf, position(5));
  const read = store.read(pdf);
  await Promise.resolve();
  assert.equal(values.size, 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(await read, position(5));
});

test('initial and duplicate page events cannot replace progress during hydration or resume', async () => {
  const { io, store } = fixture();
  await store.save(pdf, position(7));
  const gate = deferred();
  const get = io.getItem;
  io.getItem = async key => { await gate.promise; return get(key); };
  const session = new ReadingProgressSession(store, pdf);
  const hydration = session.hydrate();
  assert.deepEqual(session.pageRendered(position(1)), { type: 'ignore' });
  gate.resolve();
  await hydration;

  assert.deepEqual(session.pageRendered(position(1, 4)), { type: 'resume', page: 4 });
  assert.deepEqual(session.pageRendered(position(1, 4)), { type: 'ignore' });
  assert.deepEqual(await store.read(pdf), position(7));
  const resumed = session.pageRendered(position(4, 4));
  assert.equal(resumed.type, 'rendered');
  await resumed.saved;
  assert.deepEqual(await store.read(pdf), position(4, 4));

  const wentBack = session.pageRendered(position(1, 4));
  assert.equal(wentBack.type, 'rendered');
  await wentBack.saved;
  assert.deepEqual(await store.read(pdf), position(1, 4));
});

test('a hydration read failure keeps the document readable and leaves saved progress alone', async () => {
  const { io, store } = fixture();
  await store.save(docx, position(2, 3));
  const get = io.getItem;
  io.getItem = async () => { throw new Error('Access denied'); };
  const session = new ReadingProgressSession(store, docx);
  await assert.rejects(session.hydrate(), /Access denied/);
  io.getItem = get;
  assert.deepEqual(session.pageRendered(position(1, 3)), { type: 'rendered' });
  assert.deepEqual(await store.read(docx), position(2, 3));
});
