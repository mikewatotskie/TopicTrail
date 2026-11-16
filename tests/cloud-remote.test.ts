import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { validateSupabaseConfiguration } from '../src/core/auth/supabase_config';
import { Document, DocumentFormat } from '../src/core/models/document';
import { createCloudRemote } from '../src/core/services/cloud/remote';
import { sha256 } from '../src/core/services/cloud/sha256';
import { SyncRateLimit, SyncRetryGate } from '../src/core/services/cloud/sync_retry';
import { LibraryPull } from '../src/core/services/cloud/paged_pull';
import type { CloudDocumentRow } from '../src/core/services/cloud/types';

const project = 'abcdefghijklmnopqrst', uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = validateSupabaseConfiguration(`https://${project}.supabase.co`, `sb_publishable_${'a'.repeat(30)}`);
const session = { project, uid, accessToken: 'synthetic-token' };
const bytes = strToU8('%PDF-1.7\ncloud fixture');
const document = new Document(`account-${uid}-one`, 'Course', DocumentFormat.PDF, '/fixture.pdf', new Date('2026-11-10T01:02:03Z'), bytes.length);
const row: CloudDocumentRow = { user_id: uid, id: document.id, title: document.title, format: 'pdf', byte_size: bytes.length,
  sha256: sha256(bytes), imported_at: document.importedAt.toISOString(), object_path: `${uid}/${document.id}.pdf` };
type Call = { url: string; init: RequestInit };
function fixture(handler: (call: Call, index: number) => Response | Promise<Response>, signal?: AbortSignal) {
  const calls: Call[] = [];
  const fetcher = (async (input, init) => { const call = { url: String(input), init: init! }; calls.push(call); return handler(call, calls.length - 1); }) as typeof fetch;
  return { calls, remote: createCloudRemote(config, session, signal, fetcher) };
}
const binary = (value = bytes) => new Response(value);
const ok = () => new Response(null, { status: 201 });

test('document pagination resumes the interrupted cursor using a fresh session and discards it on account switch',async()=>{
  const pull=new LibraryPull(),cursors:string[]=[],tokens:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));cursors.push(url.searchParams.get('id')??'first');tokens.push((init?.headers as Record<string,string>).Authorization);
    if(cursors.length===1||cursors.length===4)return Response.json([row]);
    if(cursors.length===2||cursors.length===5)return new Response(null,{status:429});
    return Response.json([]);
  };
  const original=createCloudRemote(config,session,undefined,fetcher,pull);
  await assert.rejects(original.list(),SyncRateLimit);
  const refreshed=createCloudRemote(config,{...session,accessToken:'renewed'},undefined,fetcher,pull);
  assert.deepEqual(await refreshed.list(),[row]);
  assert.deepEqual(cursors,['first','gt.'+row.id,'gt.'+row.id]);assert.equal(tokens[2],'Bearer renewed');
  await assert.rejects(original.list(),SyncRateLimit);
  const other=createCloudRemote(config,{...session,uid:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},undefined,fetcher,pull);
  assert.deepEqual(await other.list(),[]);assert.equal(cursors.at(-1),'first');
});

test('missing or malformed Retry-After uses increasing capped jitter without additional HTTP traffic', async () => {
  let now = 100_000, calls = 0;
  const gate = new SyncRetryGate(undefined, () => now, () => 0.5);
  const limited = SyncRateLimit.fromResponse(new Response(null,{status:429, headers:{'Retry-After':'unknown'}}),now);
  assert.equal(limited.retryAt,null);
  const fetcher=gate.guard(async()=>{calls++;return Response.json([]);});
  for(const expected of [3750,7500,15000,30000,60000,120000,225000,225000]) {
    const until=await gate.defer(limited);
    assert.equal(until-now,expected);
    await assert.rejects(fetcher('https://example.invalid'),SyncRateLimit);
    now=until;
    await gate.prepare();
    await gate.completed();
  }
  await fetcher('https://example.invalid');
  assert.equal(calls,1);
});

test('a limited storage upload exposes its deadline and sends no reconciliation or metadata request', async () => {
  const deadline = new Date('2036-01-01T12:00:00Z');
  const f = fixture(()=>new Response(null,{status:429,headers:{'Retry-After':deadline.toUTCString()}}));
  await assert.rejects(f.remote.upload(document,bytes), (e:unknown)=>e instanceof SyncRateLimit && e.retryAt===+deadline);
  assert.equal(f.calls.length,1);
});

test('portable SHA-256 matches published vectors, padding boundaries and offset views', () => {
  assert.equal(sha256(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256(strToU8('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(strToU8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  for (const length of [1, 55, 56, 63, 64, 65, 127, 128, 1000, 1000000]) {
    const input = new Uint8Array(length + 11).fill(97).subarray(7, length + 7);
    assert.equal(sha256(input), createHash('sha256').update(input).digest('hex'));
  }
});

test('binary upload precedes metadata, does not upsert, and download preserves exact bytes', async () => {
  const f = fixture(call => call.init.method === 'GET' ? binary() : ok());
  assert.deepEqual(await f.remote.upload(document, bytes), row);
  assert.deepEqual(await f.remote.download(row), bytes);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[0].url, /\/storage\/v1\/object\/topictrail-documents\//);
  assert.deepEqual(new Uint8Array(f.calls[0].init.body as Uint8Array), bytes);
  const headers = f.calls[0].init.headers as Record<string, string>;
  assert.equal(headers['x-upsert'], 'false'); assert.equal(headers['Content-Type'], 'application/pdf');
  assert.equal(headers.Authorization, 'Bearer synthetic-token');
  const metadata = JSON.parse(f.calls[1].init.body as string);
  assert.equal(metadata.sha256, row.sha256); assert.equal(metadata.user_id, uid);
  assert.equal(metadata.object_path, undefined); assert.equal(metadata.created_at, undefined);
  assert.ok(f.calls.every(call => call.url.startsWith(config.url) && call.init.redirect === 'error'));
});

test('valid DOCX transfers use DOCX content type and validate the package', async () => {
  const docxBytes = zipSync({ '[Content_Types].xml': strToU8('<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/document.xml': strToU8('<w:document xmlns:w="test"><w:body><w:p><w:r><w:t>Test</w:t></w:r></w:p></w:body></w:document>') });
  const f = fixture(() => ok());
  const value = await f.remote.upload(document.copyWith({ format: DocumentFormat.DOCX }), docxBytes);
  assert.equal(value.format, 'docx');
  assert.equal((f.calls[0].init.headers as Record<string, string>)['Content-Type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('session/config mismatch and invalid owner metadata fail closed before download', async () => {
  assert.throws(() => createCloudRemote(config, { ...session, project: 'zzzzzzzzzzzzzzzzzzzz' }), /invalid/);
  const f = fixture(() => binary());
  for (const mutation of [{ user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { id: '../file' }, { object_path: `${uid}/other.pdf` },
    { sha256: 'ABC' }, { format: 'exe' }, { byte_size: 0 }, { title: ' ' }, { imported_at: 'infinity' }]) {
    await assert.rejects(f.remote.download({ ...row, ...mutation } as CloudDocumentRow), /invalid/);
  }
  assert.equal(f.calls.length, 0);
});

test('invalid local content never uploads and the transport snapshots its session capability', async () => {
  const f = fixture(() => ok());
  await assert.rejects(f.remote.upload(document, strToU8('not a PDF')), /format/);
  await assert.rejects(f.remote.upload(document, new Uint8Array()), /invalid/);
  await assert.rejects(f.remote.upload(document.copyWith({ importedAt: new Date('invalid') }), bytes), /invalid/);
  assert.equal(f.calls.length, 0);
  const mutable = { ...session }; let observed = '';
  const remote = createCloudRemote(config, mutable, undefined, (async (_, init) => {
    observed = (init!.headers as Record<string, string>).Authorization;
    return binary();
  }) as typeof fetch);
  mutable.accessToken = 'other-token'; mutable.uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.deepEqual(await remote.download(row), bytes);
  assert.equal(observed, 'Bearer synthetic-token');
});

test('malformed and cross-owner list rows cannot enter the account library', async () => {
  for (const value of [{ rows: [] }, [{ ...row, user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], [{ ...row, object_path: '../x.pdf' }], [row, row]]) {
    const f = fixture(() => Response.json(value));
    await assert.rejects(f.remote.list());
  }
});

test('list uses scoped keyset pagination and rejects out-of-order pages', async () => {
  const page = Array.from({ length: 100 }, (_, i) => {
    const id = `item-${String(i).padStart(3, '0')}`;
    return { ...row, id, object_path: `${uid}/${id}.pdf` };
  });
  const f = fixture((_, index) => Response.json(index ? [] : page));
  assert.equal((await f.remote.list()).length, 100);
  assert.ok(f.calls.every(call => call.url.includes(`user_id=eq.${uid}`)));
  assert.match(f.calls[1].url, /id=gt.item-099/);
  const bad = fixture((_, index) => Response.json(index ? [page[0]] : page));
  await assert.rejects(bad.remote.list(), /invalid/);
  const capped = fixture((_, index) => Response.json(index < 2 ? [page[index]] : []));
  assert.equal((await capped.remote.list()).length, 2, 'server limits below requested page size must not truncate the library');
});

test('corrupt, oversized and wrong-format downloads are rejected', async () => {
  const corrupt = bytes.slice(); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(fixture(() => binary(corrupt)).remote.download(row), /integrity/);
  await assert.rejects(fixture(() => binary(new Uint8Array(bytes.length + 1))).remote.download(row));
  const wrong = strToU8('this is not a pdf');
  await assert.rejects(fixture(() => binary(wrong)).remote.download({ ...row, byte_size: wrong.length, sha256: sha256(wrong) }), /format/);
  await assert.rejects(fixture(() => new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } })).remote.download(row));
});

test('duplicate object requires exact bytes and duplicate metadata requires immutable identity', async () => {
  const f = fixture((_, index) => [new Response(null, { status: 400 }), binary(), new Response(null, { status: 409 }), Response.json([row])][index]);
  assert.deepEqual(await f.remote.upload(document, bytes), row);
  assert.equal(f.calls.length, 4);
  for (const changed of [{ sha256: 'a'.repeat(64) }, { byte_size: row.byte_size + 1 }]) {
    const conflict = fixture((_, index) => [new Response(null, { status: 409 }), binary(), new Response(null, { status: 409 }), Response.json([{ ...row, ...changed }])][index]);
    await assert.rejects(conflict.remote.upload(document, bytes), /different cloud document/);
  }
  const mismatched = fixture((_, index) => index ? binary(strToU8('%PDF-1.7\nDIFFERENT!!!')) : new Response(null, { status: 409 }));
  await assert.rejects(mismatched.remote.upload(document, bytes));
  assert.equal(mismatched.calls.length, 2, 'mismatched bytes must not insert metadata');
});

test('lost upload or metadata replies reconcile without overwriting anything', async () => {
  const f = fixture((_, index) => {
    if (index === 0 || index === 2) throw Error('PRIVATE network token url');
    return index === 1 ? binary() : Response.json([row]);
  });
  assert.deepEqual(await f.remote.upload(document, bytes), row);
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 2);
});

test('retry after a lost metadata reply and local rename preserves both titles and accepts identical content', async () => {
  let stored: CloudDocumentRow | undefined;
  let failFirstRead = true;
  const f = fixture(call => {
    if (call.url.includes('/storage/')) {
      if (call.init.method === 'GET') return binary();
      return stored ? new Response(null, { status: 409 }) : ok();
    }
    if (call.init.method === 'POST') {
      if (stored) return new Response(null, { status: 409 });
      stored = { ...JSON.parse(call.init.body as string), object_path: row.object_path };
      throw Error('Metadata committed but its reply was lost');
    }
    if (failFirstRead) { failFirstRead = false; return new Response(null, { status: 503 }); }
    return Response.json([stored]);
  });
  await assert.rejects(f.remote.upload(document, bytes));
  assert.equal(stored!.title, document.title, 'the first metadata insert committed its original title');
  const renamed = document.copyWith({ title: 'My local course title' });
  const reconciled = await f.remote.upload(renamed, bytes);
  assert.equal(reconciled.title, document.title, 'return the original immutable cloud metadata');
  assert.equal(stored!.title, document.title, 'the retry does not overwrite the cloud title');
  assert.equal(renamed.title, 'My local course title', 'the local-only title stays on the local document');
  assert.equal(reconciled.sha256, row.sha256);
  assert.ok(f.calls.every(call => call.init.method === 'POST' || call.init.method === 'GET'));
  assert.equal(f.calls.filter(call => call.url.includes('/storage/') && call.init.method === 'GET').length, 1,
    'the existing stored bytes must pass download verification before metadata reconciliation');
});

test('two devices importing the same sample identity at different times retain the original cloud metadata', async () => {
  let stored: CloudDocumentRow | undefined;
  const server = (call: Call) => {
    if (call.url.includes('/storage/')) {
      if (call.init.method === 'GET') return binary();
      return stored ? new Response(null, { status: 409 }) : ok();
    }
    if (call.init.method === 'POST') {
      if (stored) return new Response(null, { status: 409 });
      stored = { ...JSON.parse(call.init.body as string), object_path: row.object_path };
      return ok();
    }
    return Response.json([stored]);
  };
  const firstDevice = fixture(server), secondDevice = fixture(server);
  const original = await firstDevice.remote.upload(document, bytes);
  const laterImport = document.copyWith({ title: 'Second device title', importedAt: new Date('2026-11-11T12:00:00Z') });
  const reconciled = await secondDevice.remote.upload(laterImport, bytes);
  assert.deepEqual(reconciled, original, 'same owned identity and verified bytes reuse the original metadata');
  assert.deepEqual(stored, original, 'the second device does not replace the cloud title or import time');
  assert.equal(laterImport.title, 'Second device title');
  assert.equal(laterImport.importedAt.toISOString(), '2026-11-11T12:00:00.000Z');
});

test('auth denial is sanitized and never initiates reconciliation', async () => {
  const f = fixture(() => new Response('PRIVATE token response', { status: 403 }));
  await assert.rejects(f.remote.upload(document, bytes), error => /Sign in again/.test(String(error)) && !String(error).includes('PRIVATE'));
  assert.equal(f.calls.length, 1);
});

test('abort settles even when fetch ignores AbortSignal and stops later stages', async () => {
  const controller = new AbortController();
  const f = fixture(() => new Promise<Response>(() => undefined), controller.signal);
  const pending = f.remote.upload(document, bytes); controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(f.remote.list(), /cancelled/);
  assert.equal(f.calls.length, 1);
});

test('request deadline covers stalled fetch and stalled response body', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = fixture(() => new Promise<Response>(() => undefined));
    const pending = f.remote.list();
    context.mock.timers.tick(30_000);
    await assert.rejects(pending, /timed out/);
    const stalled = fixture(() => new Response(new ReadableStream({ start() {} })));
    const bodyPending = stalled.remote.download(row);
    await Promise.resolve(); await Promise.resolve();
    context.mock.timers.tick(30_000);
    await assert.rejects(bodyPending, /timed out/);
  } finally { context.mock.timers.reset(); }
});
