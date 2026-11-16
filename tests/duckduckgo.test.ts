import assert from 'node:assert/strict';
import test from 'node:test';
import { DuckDuckGoProvider, duckDuckGoSearchUrl, parseDuckDuckGoResponse } from '../src/core/services/resources/duckduckgo';
import { ResourceDiscoveryService } from '../src/core/services/resources/discovery';
import { SearchSession } from '../src/core/services/resources/session';
import { DiscoveryError, type DiscoveryResult, type ProviderResult } from '../src/core/services/resources/types';

const topic = { kind: 'document' as const, documentId: 'private-id', page: 4, text: 'Private highlighted text' };
const answer = {
  Heading: 'DuckDuckGo', AbstractText: 'A search engine.', AbstractSource: 'Wikipedia',
  AbstractURL: 'https://en.wikipedia.org/wiki/DuckDuckGo', Definition: '',
};
const uncited = { AbstractText: '', AbstractURL: '', AbstractSource: '', Definition: '' };

test('a cited answer credits its original source and a genuine empty response remains empty', () => {
  const result = parseDuckDuckGoResponse(answer, 'DuckDuckGo');
  assert.deepEqual(result.resources[0], {
    id: 'duckduckgo:' + answer.AbstractURL, title: answer.Heading, type: 'Instant Answer',
    url: answer.AbstractURL, providerId: 'duckduckgo', providerName: answer.AbstractSource,
    description: answer.AbstractText, providerOrder: 0,
  });
  assert.deepEqual(parseDuckDuckGoResponse({ ...uncited, RelatedTopics: [answer], Redirect: answer.AbstractURL }, 'Nothing'), { resources: [], discarded: 0 });
  for (const invalid of [{}, { AbstractText: [] }, [], null, 'invalid']) {
    assert.throws(() => parseDuckDuckGoResponse(invalid, 'Test'), error => error instanceof DiscoveryError && error.code === 'invalid_data');
  }
});

test('each answer needs its own safe public HTTPS citation and a named source', () => {
  const incomplete = { ...answer, AbstractURL: 'http://example.org/topic' };
  for (const invalid of [incomplete, {...answer, AbstractURL:'https://127.0.0.1/private'}, {...answer, AbstractSource:''}]) {
    assert.deepEqual(parseDuckDuckGoResponse(invalid, 'Subject'), { resources: [], discarded: 1 });
  }
  const definition = { ...incomplete, Heading: '', Definition: 'A dictionary definition.', DefinitionSource: 'Dictionary',
    DefinitionURL: 'https://dictionary.example.org/term' };
  const parsed = parseDuckDuckGoResponse(definition, 'Study term');
  assert.equal(parsed.resources[0].title, 'Study term');
  assert.equal(parsed.resources[0].description, definition.Definition);
  assert.equal(parsed.resources[0].providerName, definition.DefinitionSource);
  assert.equal(parsed.resources[0].url, definition.DefinitionURL);
  assert.equal(parsed.discarded, 1);
});

test('only reviewed terms and app options reach the API, and the full web link preserves those terms exactly', async () => {
  const terms = 'C++ & C# / 日本語?x=1';
  const browserUrl = new URL(duckDuckGoSearchUrl(terms));
  assert.equal(browserUrl.origin, 'https://duckduckgo.com');
  assert.deepEqual([...browserUrl.searchParams], [['q', terms]]);
  let requestCount = 0;
  const provider = new DuckDuckGoProvider({fetchImpl: async (input, init) => {
    requestCount++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.duckduckgo.com');
    assert.deepEqual(Object.fromEntries(url.searchParams), { q: terms, format:'json', no_html:'1', no_redirect:'1', t:'topictrail' });
    assert.deepEqual(init?.headers, { Accept:'application/json' });
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.referrerPolicy, 'no-referrer');
    return new Response(JSON.stringify(answer), { status: 202 });
  }});
  const service = new ResourceDiscoveryService([provider]);
  assert.equal(requestCount, 0);
  const result = await service.search(topic, terms, undefined, 'duckduckgo');
  assert.equal(requestCount, 1);
  assert.equal(result.resources[0].selectedTopic, topic.text);
  assert.equal(result.resources[0].attribution, undefined);
});

test('each provider owns its cache and cooling down DuckDuckGo leaves Wikipedia available', async () => {
  let wikiCalls = 0, duckCalls = 0;
  const duck = new DuckDuckGoProvider({ minIntervalMs: 0, fetchImpl: async () => {
    duckCalls++;
    return duckCalls === 1 ? new Response(JSON.stringify(answer)) : new Response('', { status: 429, headers: { 'Retry-After': '60' } });
  } });
  const service = new ResourceDiscoveryService([duck, { id:'wikipedia', name:'Wikipedia', search: async () => {
    wikiCalls++; return { resources: [], discarded: 0 };
  } }]);
  assert.equal((await service.search(topic, 'Search engines', undefined, 'duckduckgo')).fromCache, false);
  assert.equal((await service.search(topic, 'Search engines', undefined, 'duckduckgo')).fromCache, true);
  assert.equal((await service.search(topic, 'Search engines')).resources.length, 0);
  for (const subject of ['Applications','Algorithms']) {
    await assert.rejects(service.search(topic, subject, undefined, 'duckduckgo'), error => error instanceof DiscoveryError && error.code === 'rate_limit');
  }
  await service.search(topic, 'Algorithms');
  assert.deepEqual([duckCalls, wikiCalls], [2, 2]);
});

test('source switching cancels an identical topic in flight and its late answer cannot replace the visible lookup', async () => {
  const pending: { signal?: AbortSignal; resolve: (result: DiscoveryResult) => void }[] = [];
  const session = new SearchSession({ search: (_origin, _query, signal) => new Promise(resolve => pending.push({ signal, resolve })) });
  const first = session.search(topic, 'Search engines', 'duckduckgo');
  const next = session.search(topic, 'Search engines', 'wikipedia');
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal?.aborted, true);
  const result = (resources: ProviderResult['resources']): DiscoveryResult => ({
    query: { originalText: topic.text, query:'Search engines', shortened:false }, resources, discarded:0, fromCache:false,
  });
  pending[1].resolve(result([])); await next;
  pending[0].resolve(result(parseDuckDuckGoResponse(answer, 'Search engines').resources)); await first;
  assert.equal(session.getSnapshot().status, 'empty');
  session.dispose();
});
