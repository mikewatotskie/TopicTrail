import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceDiscoveryService } from '../src/core/services/resources/discovery';
import { SearchSession } from '../src/core/services/resources/session';
import type { SearchOrigin, DiscoveryResult, ResourceCandidate } from '../src/core/services/resources/types';

const candidate: ResourceCandidate = {id:'physics',title:'Physics',providerId:'wikipedia',providerName:'Wikipedia',url:'https://en.wikipedia.org/wiki/Physics',type:'Article',providerOrder:0,
  attribution:{author:'Wikipedia contributors',licenseName:'CC BY-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',sourceUrl:'https://en.wikipedia.org/wiki/Physics'}};

test('manual search sends only the reviewed query and returns no invented document context', async () => {
  const sent: string[] = [];
  const discovery = new ResourceDiscoveryService([{id:'wikipedia',name:'Wikipedia',search:async query => {sent.push(query);return {resources:[candidate],discarded:0};}}]);
  const origin: SearchOrigin = {kind:'manual',text:'Quantum physics'};
  const result = await discovery.search(origin, '  Particle physics  ');
  assert.deepEqual(sent, ['Particle physics']);
  assert.deepEqual(result.resources[0].origin, origin);
  assert.equal('documentId' in result.resources[0], false);
  assert.equal('page' in result.resources[0], false);
  assert.equal('selectedTopic' in result.resources[0], false);
  const documentResult = await discovery.search({kind:'document',documentId:'synthetic-doc',text:'Private passage',page:9}, 'Particle physics');
  assert.equal(documentResult.fromCache, true);
  assert.equal(documentResult.resources[0].page, 9);
  assert.equal(documentResult.resources[0].selectedTopic, 'Private passage');
  assert.equal('documentId' in result.resources[0], false);
});

test('manual and document search lifetimes stay distinct and cancel ignores late responses', async () => {
  const pending: {signal: AbortSignal; resolve(result: DiscoveryResult):void}[] = [];
  const session = new SearchSession({search:(_origin,_query,signal)=>new Promise(resolve=>pending.push({signal:signal!,resolve}))});
  const manual = session.search({kind:'manual',text:'Physics'});
  const document = session.search({kind:'document',documentId:'doc',page:1,text:'Physics'});
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  session.cancel(); assert.equal(pending[1].signal.aborted, true);
  const result: DiscoveryResult = {query:{query:'Physics',originalText:'Physics',shortened:false},resources:[],discarded:0,fromCache:false};
  pending.forEach(item=>item.resolve(result)); await Promise.all([manual,document]);
  assert.equal(session.getSnapshot().status, 'cancelled');
  session.dispose(); await session.search({kind:'manual',text:'Biology'}); assert.equal(pending.length,2);
});
