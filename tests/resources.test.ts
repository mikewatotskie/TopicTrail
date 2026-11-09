import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { DiscoveryError, type ResourceCandidate, type SearchSelection, type ResourceProvider, type DiscoveryResult } from '../src/core/services/resources/types';

const topic: SearchSelection = { documentId: 'private-doc', page: 2, text: '  Variables\n and loops  ' };
const page = (overrides: object = {}) => ({ pageid: 100, ns: 0, title: 'Variables and loops', index: 1,
  canonicalurl: 'https://en.wikipedia.org/wiki/Variables_and_loops', fullurl: 'https://en.wikipedia.org/wiki/Variables_and_loops',
  lastrevid: 1000, extract: 'An actual provider excerpt.', ...overrides });
const response = (pages: unknown[]) => ({ batchcomplete: true, query: { pages } });
const fetchJson = (body: unknown, status = 200, headers?: HeadersInit): typeof fetch => async () => new Response(JSON.stringify(body), { status, headers });
function implemented(name: string) { assert.ok(existsSync('src/core/services/resources/' + name + '.ts'), name + ' is not implemented'); }
function code(error: unknown, expected: string) { return error instanceof DiscoveryError && error.code === expected; }
async function candidate(overrides: Partial<ResourceCandidate> = {}): Promise<ResourceCandidate> {
  implemented('wikipedia'); const { parseWikipediaResponse } = await import('../src/core/services/resources/wikipedia');
  return { ...parseWikipediaResponse(response([page()])).resources[0], ...overrides };
}

test('query normalization preserves exact selected text and technical/non-Latin terms separately', async () => {
  implemented('query'); const { prepareQuery } = await import('../src/core/services/resources/query');
  assert.deepEqual(prepareQuery(' C++\r\nC#  .NET\t日本語 '), { query: 'C++ C# .NET 日本語', originalText: ' C++\r\nC#  .NET\t日本語 ', shortened: false });
  assert.deepEqual(prepareQuery(topic.text, '  Algorithms\n and arrays '), { query: 'Algorithms and arrays', originalText: topic.text, shortened: false });
});
test('empty, meaningless and ambiguous very short queries are rejected before requests', async () => {
  implemented('query'); const { prepareQuery } = await import('../src/core/services/resources/query');
  for (const text of ['', '  \n', '!!!', 'a', '\u200b']) assert.throws(() => prepareQuery(text), error => code(error, 'invalid_query'));
  assert.equal(prepareQuery('C++').query, 'C++'); assert.equal(prepareQuery('C#').query, 'C#');
});
test('long passages yield a bounded readable topic without changing the passage', async () => {
  implemented('query'); const { prepareQuery } = await import('../src/core/services/resources/query');
  const text = 'Photosynthesis and cellular respiration are the processes that students learn about in biology. '.repeat(20);
  const result = prepareQuery(text);
  assert.equal(result.originalText, text); assert.equal(result.shortened, true);
  assert.ok([...result.query].length <= 140); assert.ok(result.query.split(' ').length <= 16); assert.match(result.query, /^Photosynthesis/);
});
test('long passages without spaces still produce a bounded Unicode query', async () => {
  const { prepareQuery } = await import('../src/core/services/resources/query');
  const original = '光合成'.repeat(100);
  const result = prepareQuery(original);
  assert.equal([...result.query].length, 140); assert.match(result.query, /^光合成/);
  assert.equal(result.originalText, original); assert.equal(result.shortened, true);
});
test('resource/attribution URL rules reject unsafe schemes, credentials and deceptive hosts', async () => {
  implemented('urls'); const { validateResourceUrl, isAllowedAttributionUrl } = await import('../src/core/services/resources/urls');
  assert.equal(validateResourceUrl('https://en.wikipedia.org/wiki/C%2B%2B'), 'https://en.wikipedia.org/wiki/C%2B%2B');
  for (const url of ['javascript:alert(1)', 'http://en.wikipedia.org/wiki/A', 'https://en.wikipedia.org.evil.test/wiki/A', 'https://name@en.wikipedia.org/wiki/A', 'https://en.wikipedia.org:8443/wiki/A', 'https://en.wikipedia.org/w/api.php', ' https://en.wikipedia.org/wiki/A', 'https://en.wikipedia.org/wiki/%0aA']) assert.equal(validateResourceUrl(url), null, url);
  assert.equal(isAllowedAttributionUrl('https://creativecommons.org/licenses/by-sa/4.0/'), true);
  assert.equal(isAllowedAttributionUrl('https://en.wikipedia.org/w/index.php?oldid=1000'), true);
  assert.equal(isAllowedAttributionUrl('https://creativecommons.org/evil'), false);
  assert.equal(isAllowedAttributionUrl('https://en.wikipedia.org/w/index.php?oldid=1000&action=edit'), false);
});
test('real MediaWiki-shaped data becomes attributed resource objects with actual URLs', async () => {
  implemented('wikipedia'); const { parseWikipediaResponse } = await import('../src/core/services/resources/wikipedia');
  const parsed = parseWikipediaResponse(response([page()]));
  assert.equal(parsed.discarded, 0); assert.equal(parsed.resources[0].title, 'Variables and loops');
  assert.equal(parsed.resources[0].url, 'https://en.wikipedia.org/wiki/Variables_and_loops');
  assert.equal(parsed.resources[0].description, 'An actual provider excerpt.');
  assert.equal(parsed.resources[0].attribution.author, 'Wikipedia contributors');
  assert.equal(parsed.resources[0].attribution.revisionUrl, 'https://en.wikipedia.org/w/index.php?oldid=1000');
});
test('malformed structures/all-invalid entries differ from genuine empty results; partial invalid entries are counted', async () => {
  implemented('wikipedia'); const { parseWikipediaResponse } = await import('../src/core/services/resources/wikipedia');
  for (const body of [null, {}, { batchcomplete: true, error: 'broken' }, { query: { pages: 'broken' } }, response([page({ canonicalurl: 'https://evil.test/wiki/A' })])]) assert.throws(() => parseWikipediaResponse(body), e => code(e, 'invalid_data'));
  assert.deepEqual(parseWikipediaResponse({ batchcomplete: true }), { resources: [], discarded: 0 });
  assert.deepEqual(parseWikipediaResponse(response([])), { resources: [], discarded: 0 });
  const partial = parseWikipediaResponse(response([page(), page({ pageid: -1 })]));
  assert.equal(partial.resources.length, 1); assert.equal(partial.discarded, 1);
});
test('provider groups query/URL/excerpt requests and identifies client without sending a document', async () => {
  implemented('wikipedia'); const { WikipediaProvider } = await import('../src/core/services/resources/wikipedia');
  let url = ''; let init: RequestInit | undefined;
  const provider = new WikipediaProvider({ minIntervalMs: 0, fetchImpl: async (input, options) => { url = String(input); init = options; return new Response(JSON.stringify(response([page()]))); } });
  await provider.search('C++ loops', new AbortController().signal);
  const parsed = new URL(url); assert.equal(parsed.origin + parsed.pathname, 'https://en.wikipedia.org/w/api.php');
  assert.equal(parsed.searchParams.get('gsrsearch'), 'C++ loops'); assert.equal(parsed.searchParams.get('prop'), 'info|extracts');
  assert.equal(parsed.searchParams.get('explaintext'), '1'); assert.equal(parsed.searchParams.get('gsrlimit'), '8');
  const headers = new Headers(init?.headers); assert.match(headers.get('Api-User-Agent')!, /TopicTrail\/1.0.*https:\/\/github.com\/mikewatotskie\/TopicTrail/);
  assert.equal(init?.credentials, 'omit'); assert.equal(parsed.searchParams.has('document'), false);
});
test('HTTP429 and both Retry-After formats establish a shared provider cooldown across different queries', async () => {
  implemented('wikipedia'); const { WikipediaProvider } = await import('../src/core/services/resources/wikipedia');
  let now = Date.parse('2026-10-27T00:00:00Z'), calls = 0;
  const provider = new WikipediaProvider({ now: () => now, minIntervalMs: 0, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '30' } }); } });
  await assert.rejects(provider.search('Loops', new AbortController().signal), e => code(e, 'rate_limit') && (e as DiscoveryError).retryAt === now + 30000);
  await assert.rejects(provider.search('Arrays', new AbortController().signal), e => code(e, 'rate_limit')); assert.equal(calls, 1);
  now += 30000; await assert.rejects(provider.search('Arrays', new AbortController().signal), e => code(e, 'rate_limit')); assert.equal(calls, 2);
  const date = new WikipediaProvider({ now: () => now, minIntervalMs: 0, fetchImpl: fetchJson({}, 503, { 'Retry-After': new Date(now + 60000).toUTCString() }) });
  await assert.rejects(date.search('Loops', new AbortController().signal), e => (e as DiscoveryError).retryAt === now + 60000);
});
test('maxlag/ratelimited/API/HTTP/network failures have distinct actionable states', async () => {
  implemented('wikipedia'); const { WikipediaProvider } = await import('../src/core/services/resources/wikipedia');
  for (const [fetchImpl, expected] of [[fetchJson({ error: { code: 'maxlag' } }), 'rate_limit'], [fetchJson({ error: { code: 'ratelimited' } }), 'rate_limit'], [fetchJson({ error: { code: 'badvalue' } }), 'api'], [fetchJson({}, 500), 'api'], [async () => { throw new TypeError('network'); }, 'network']] as const) {
    const provider = new WikipediaProvider({ minIntervalMs: 0, fetchImpl });
    await assert.rejects(provider.search('Loops', new AbortController().signal), e => code(e, expected));
  }
});
test('fetch and body-read hangs time out even when transport ignores abort', async () => {
  implemented('wikipedia'); const { WikipediaProvider } = await import('../src/core/services/resources/wikipedia');
  for (const fetchImpl of [async () => new Promise<Response>(() => {}), async () => ({ ok: true, status: 200, headers: new Headers(), text: () => new Promise<string>(() => {}) } as Response)]) {
    const provider = new WikipediaProvider({ minIntervalMs: 0, timeoutMs: 20, fetchImpl });
    await assert.rejects(provider.search('Loops', new AbortController().signal), e => code(e, 'timeout'));
  }
});
test('caller cancellation aborts in-flight transport and does not turn into a network error', async () => {
  implemented('wikipedia'); const { WikipediaProvider } = await import('../src/core/services/resources/wikipedia');
  const controller = new AbortController(); let transportSignal: AbortSignal | undefined;
  const provider = new WikipediaProvider({ minIntervalMs: 0, fetchImpl: async (_input, init) => { transportSignal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); } });
  const result = provider.search('Loops', controller.signal); await Promise.resolve(); await Promise.resolve(); controller.abort();
  await assert.rejects(result, e => code(e, 'cancelled')); assert.equal(transportSignal?.aborted, true);
});
test('provider requests run in series and respect the conservative interval', async t => {
  implemented('wikipedia'); const { WikipediaProvider } = await import('../src/core/services/resources/wikipedia');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 }); let calls = 0;
  const provider = new WikipediaProvider({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(response([page()]))); } });
  await provider.search('Loops', new AbortController().signal);
  const second = provider.search('Arrays', new AbortController().signal); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1); t.mock.timers.tick(1499); await Promise.resolve(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await second; assert.equal(calls, 2);
});
test('duplicate resources are removed and exact/title/keyword ranking is predictable', async () => {
  implemented('discovery'); const { ResourceDiscoveryService } = await import('../src/core/services/resources/discovery');
  const broad = await candidate({ id: 'broad', title: 'Programming', url: 'https://en.wikipedia.org/wiki/Programming', providerOrder: 0 });
  const exact = await candidate({ id: 'exact', providerOrder: 2 });
  const partial = await candidate({ id: 'partial', title: 'Loops', url: 'https://en.wikipedia.org/wiki/Loops', providerOrder: 1 });
  const provider: ResourceProvider = { id: 'wikipedia', name: 'Wikipedia', search: async () => ({ resources: [broad, partial, exact, { ...exact, id: 'duplicate' }], discarded: 0 }) };
  const result = await new ResourceDiscoveryService([provider]).search(topic);
  assert.deepEqual(result.resources.map(resource => resource.id), ['exact', 'partial', 'broad']);
  assert.equal(result.resources[0].selectedTopic, topic.text); assert.equal(result.resources[0].documentId, 'private-doc');
});
test('query cache avoids duplicate requests yet binds results to current exact selection, expires and stays bounded', async () => {
  implemented('discovery'); const { ResourceDiscoveryService } = await import('../src/core/services/resources/discovery');
  const resource = await candidate(); let calls = 0, now = 0;
  const provider: ResourceProvider = { id: 'wikipedia', name: 'Wikipedia', search: async () => { calls++; return { resources: [resource], discarded: 0 }; } };
  const service = new ResourceDiscoveryService([provider], { now: () => now, cacheTtlMs: 100, maxCacheEntries: 1 });
  await service.search(topic);
  const repeated = await service.search({ documentId: 'other', page: 8, text: 'Variables and loops' });
  assert.equal(calls, 1); assert.equal(repeated.fromCache, true); assert.equal(repeated.resources[0].selectedTopic, 'Variables and loops'); assert.equal(repeated.resources[0].page, 8);
  now = 101; await service.search(topic); assert.equal(calls, 2);
  await service.search(topic, 'Arrays'); await service.search(topic); assert.equal(calls, 4);
});
test('invalid selection is rejected before provider and only processed topic crosses provider boundary', async () => {
  implemented('discovery'); const { ResourceDiscoveryService } = await import('../src/core/services/resources/discovery');
  let seen = ''; const provider: ResourceProvider = { id: 'wikipedia', name: 'Wikipedia', search: async query => { seen = query; return { resources: [], discarded: 0 }; } };
  const service = new ResourceDiscoveryService([provider]); await assert.rejects(service.search({ ...topic, text: '' }), e => code(e, 'invalid_query')); assert.equal(seen, '');
  const result = await service.search(topic, 'C++ loops'); assert.equal(seen, 'C++ loops'); assert.equal(result.query.originalText, topic.text);
});
test('superseded responses cannot replace the newest topic even when provider ignores cancellation', async () => {
  implemented('session'); const { SearchSession } = await import('../src/core/services/resources/session');
  const resource = await candidate(); const pending: ((result: DiscoveryResult) => void)[] = [];
  const session = new SearchSession({ search: () => new Promise(resolve => pending.push(resolve)) });
  const first = session.search(topic, 'Loops'); const second = session.search(topic, 'Arrays');
  const output = (query: string): DiscoveryResult => ({ query: { query, originalText: topic.text, shortened: false }, resources: [{ ...resource, selectedTopic: topic.text, documentId: topic.documentId, page: topic.page }], discarded: 0, fromCache: false });
  pending[1](output('Arrays')); await second; pending[0](output('Loops')); await first;
  const state = session.getSnapshot(); assert.equal(state.status, 'success'); if (state.status === 'success') assert.equal(state.result.query.query, 'Arrays');
  session.dispose();
});
test('session deduplicates active requests and cancellation/disposal prevents late state changes', async () => {
  implemented('session'); const { SearchSession } = await import('../src/core/services/resources/session');
  let calls = 0, signal: AbortSignal | undefined, finish!: (result: DiscoveryResult) => void;
  const session = new SearchSession({ search: (_selection, _query, inputSignal) => { calls++; signal = inputSignal; return new Promise(resolve => { finish = resolve; }); } });
  const first = session.search(topic), second = session.search(topic); assert.equal(calls, 1);
  session.cancel(); assert.equal(signal?.aborted, true); assert.equal(session.getSnapshot().status, 'cancelled');
  finish({ query: { query: 'Variables and loops', originalText: topic.text, shortened: false }, resources: [], discarded: 0, fromCache: false }); await Promise.all([first, second]);
  assert.equal(session.getSnapshot().status, 'cancelled'); session.dispose();
});

test('retrying a genuine empty result performs a new request instead of replaying a cached empty screen', async () => {
  const { ResourceDiscoveryService } = await import('../src/core/services/resources/discovery');
  let calls = 0;
  const service = new ResourceDiscoveryService([{ id: 'wikipedia', name: 'Wikipedia', search: async () => { calls++; return { resources: [], discarded: 0 }; } }]);
  await service.search(topic); await service.search(topic);
  assert.equal(calls, 2);
});

test('a synchronous integration failure ends loading with an actionable error state', async () => {
  const { SearchSession } = await import('../src/core/services/resources/session');
  const session = new SearchSession({ search() { throw new Error('Transport initialization failed'); } });
  await session.search(topic);
  const state = session.getSnapshot(); assert.equal(state.status, 'error');
  if (state.status === 'error') assert.equal(state.error.code, 'api');
  session.dispose();
});

test('cancelling a queued request cannot detach subsequent requests from an active predecessor', async () => {
  const { WikipediaProvider } = await import('../src/core/services/resources/wikipedia');
  const starts: string[] = []; let release!: () => void;
  const provider = new WikipediaProvider({ minIntervalMs: 0, fetchImpl: async input => {
    const query = new URL(String(input)).searchParams.get('gsrsearch')!; starts.push(query);
    if (query === 'Alpha') await new Promise<void>(resolve => { release = resolve; });
    return new Response(JSON.stringify(response([page()])));
  } });
  const first = provider.search('Alpha', new AbortController().signal); await Promise.resolve(); await Promise.resolve();
  const cancellation = new AbortController(); const queued = provider.search('Beta', cancellation.signal); cancellation.abort();
  await assert.rejects(queued, e => code(e, 'cancelled'));
  const later = provider.search('Gamma', new AbortController().signal); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  try { assert.deepEqual(starts, ['Alpha']); }
  finally { release(); await Promise.all([first, later]); }
  assert.deepEqual(starts, ['Alpha', 'Gamma']);
});

test('a queued timeout never fetches its topic and does not strand the next eligible request', async t => {
  const { WikipediaProvider } = await import('../src/core/services/resources/wikipedia');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const starts: string[] = [];
  const provider = new WikipediaProvider({ minIntervalMs: 50, timeoutMs: 20, fetchImpl: async input => {
    starts.push(new URL(String(input)).searchParams.get('gsrsearch')!); return new Response(JSON.stringify(response([page()])));
  } });
  await provider.search('Alpha', new AbortController().signal);
  const queued = provider.search('Beta', new AbortController().signal); await Promise.resolve(); await Promise.resolve();
  const rejection = assert.rejects(queued, e => code(e, 'timeout')); t.mock.timers.tick(20); await rejection;
  t.mock.timers.tick(30); await provider.search('Gamma', new AbortController().signal);
  assert.deepEqual(starts, ['Alpha', 'Gamma']);
});

test('a cancelled middle request cannot bypass a predecessor Retry-After response', async () => {
  const { WikipediaProvider } = await import('../src/core/services/resources/wikipedia');
  const starts: string[] = []; let release!: () => void;
  const provider = new WikipediaProvider({ minIntervalMs: 0, now: () => 0, fetchImpl: async input => {
    starts.push(new URL(String(input)).searchParams.get('gsrsearch')!);
    await new Promise<void>(resolve => { release = resolve; });
    return new Response('', { status: 429, headers: { 'Retry-After': '30' } });
  } });
  const first = assert.rejects(provider.search('Alpha', new AbortController().signal), error => code(error, 'rate_limit'));
  await Promise.resolve(); await Promise.resolve();
  const middleController = new AbortController(); const middle = provider.search('Beta', middleController.signal); middleController.abort();
  await assert.rejects(middle, error => code(error, 'cancelled'));
  const later = assert.rejects(provider.search('Gamma', new AbortController().signal), error => code(error, 'rate_limit') && (error as DiscoveryError).retryAt === 30000);
  release(); await Promise.all([first, later]); assert.deepEqual(starts, ['Alpha']);
});
