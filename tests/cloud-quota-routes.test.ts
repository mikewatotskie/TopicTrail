import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8 } from 'fflate';
import { validateSupabaseConfiguration } from '../src/core/auth/supabase_config';
import { Document, DocumentFormat } from '../src/core/models/document';
import { createAnnotationRemote } from '../src/core/services/annotations/remote';
import { createCloudRemote } from '../src/core/services/cloud/remote';
import { usesStagingQuotas } from '../src/core/services/cloud/quota_routes';

const project = 'abcdefghijklmnopqrst';
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = validateSupabaseConfiguration(`https://${project}.supabase.co`, `sb_publishable_${'a'.repeat(30)}`);
const session = { project, uid, accessToken: 'test-session' };

test('staging routes reserve before transfer and use v2 owner pages on both sync transports', async t => {
  const previous = process.env.EXPO_PUBLIC_TOPICTRAIL_QUOTA_STAGING_REF;
  process.env.EXPO_PUBLIC_TOPICTRAIL_QUOTA_STAGING_REF = project;
  t.after(() => {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_TOPICTRAIL_QUOTA_STAGING_REF;
    else process.env.EXPO_PUBLIC_TOPICTRAIL_QUOTA_STAGING_REF = previous;
  });
  assert.throws(() => usesStagingQuotas('different'), /does not match/);
  const calls: { path: string; method?: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    if (path.endsWith('_list')) return Response.json([]);
    return Response.json(path.endsWith('reserve_upload') ? { expires_at: '2030-01-01T00:00:00Z' } : {});
  };
  const cloud = createCloudRemote(config, session, undefined, fetcher);
  const notes = createAnnotationRemote(config, session, undefined, fetcher);
  const bytes = strToU8('%PDF-1.7\nSynthetic');
  const doc = new Document('test-quota', 'Synthetic', DocumentFormat.PDF, 'local', new Date(0), bytes.length);
  await cloud.upload(doc, bytes);
  await cloud.list();
  await cloud.listStudy!();
  await notes.list();
  assert.deepEqual(calls.map(call => call.path), [
    '/rest/v1/rpc/topictrail_v2_reserve_upload',
    `/storage/v1/object/topictrail-documents/${uid}/test-quota.pdf`,
    '/rest/v1/rpc/topictrail_v2_documents_insert',
    '/rest/v1/rpc/topictrail_v2_documents_list',
    '/rest/v1/rpc/topictrail_v2_study_list',
    '/rest/v1/rpc/topictrail_v2_annotations_list',
  ]);
  assert.deepEqual(calls[0].body, { p_id: doc.id, p_format: 'pdf', p_size: bytes.length });
  assert.ok(calls.every(call => call.method === 'POST'));
  const failedCalls: string[] = [];
  const unavailable = createCloudRemote(config, session, undefined, async input => {
    failedCalls.push(String(input));
    return new Response(null, { status: 404 });
  });
  await assert.rejects(unavailable.upload(doc, bytes));
  assert.equal(failedCalls.length, 1);
  assert.ok(failedCalls[0].endsWith('/rpc/topictrail_v2_reserve_upload'));
  const retried: string[] = [];
  const committed = createCloudRemote(config, session, undefined, async (input, init) => {
    const path = new URL(String(input)).pathname;
    retried.push(init?.method + ' ' + path);
    if (path.endsWith('reserve_upload')) return Response.json({ already_uploaded: true });
    if (init?.method === 'GET') return new Response(bytes);
    return Response.json({});
  });
  await committed.upload(doc, bytes);
  assert.deepEqual(retried, [
    'POST /rest/v1/rpc/topictrail_v2_reserve_upload',
    `GET /storage/v1/object/authenticated/topictrail-documents/${uid}/test-quota.pdf`,
    'POST /rest/v1/rpc/topictrail_v2_documents_insert',
  ]);
});

