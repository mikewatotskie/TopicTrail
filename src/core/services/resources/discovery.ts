import { prepareQuery } from './query';
import { DiscoveryError, type DiscoveryResult, type DiscoveryService, type ProviderResult, type ResourceCandidate, type ResourceProvider, type SearchSelection } from './types';

const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en-US');
const words = (value: string) => new Set(fold(value).match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu) ?? []);
function rank(resources: ResourceCandidate[], query: string): ResourceCandidate[] {
  const ids = new Set<string>(), urls = new Set<string>(), terms = words(query), normalized = fold(query);
  const unique = resources.filter(item => {
    const id = item.providerId + ':' + item.id;
    if (ids.has(id) || urls.has(item.url)) return false;
    ids.add(id); urls.add(item.url); return true;
  });
  function score(item: ResourceCandidate) {
    const title = fold(item.title), titleTerms = words(item.title), descriptionTerms = words(item.description ?? '');
    let value = title === normalized ? 1000 : title.includes(normalized) ? 200 : 0;
    for (const term of terms) value += titleTerms.has(term) ? 20 : descriptionTerms.has(term) ? 2 : 0;
    return value;
  }
  return unique.sort((a, b) => score(b) - score(a) || a.providerOrder - b.providerOrder);
}
interface Options { now?: () => number; cacheTtlMs?: number; maxCacheEntries?: number }
export class ResourceDiscoveryService implements DiscoveryService {
  private readonly cache = new Map<string, { until: number; value: ProviderResult }>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly capacity: number;
  constructor(private readonly providers: readonly ResourceProvider[], options: Options = {}) {
    this.now = options.now ?? (() => Date.now()); this.ttl = options.cacheTtlMs ?? 10 * 60 * 1000;
    this.capacity = options.maxCacheEntries ?? 20;
  }
  async search(selection: SearchSelection, queryOverride?: string, signal = new AbortController().signal): Promise<DiscoveryResult> {
    const query = prepareQuery(selection.text, queryOverride);
    if (signal.aborted) throw new DiscoveryError('cancelled', 'Search stopped.');
    const key = fold(query.query);
    let cached = this.cache.get(key), fromCache = false;
    if (cached && cached.until <= this.now()) { this.cache.delete(key); cached = undefined; }
    let value: ProviderResult;
    if (cached) { value = cached.value; fromCache = true; this.cache.delete(key); this.cache.set(key, cached); }
    else {
      value = { resources: [], discarded: 0 };
      for (const provider of this.providers) {
        const result = await provider.search(query.query, signal);
        if (signal.aborted) throw new DiscoveryError('cancelled', 'Search stopped.');
        value.resources.push(...result.resources); value.discarded += result.discarded;
      }
      value.resources = rank(value.resources, query.query);
      // A student's explicit retry of an empty search must contact the provider.
      if (value.resources.length) this.cache.set(key, { until: this.now() + this.ttl, value });
      while (this.cache.size > Math.max(0, this.capacity)) this.cache.delete(this.cache.keys().next().value!);
    }
    return { query, resources: value.resources.map(resource => ({ ...resource, attribution: { ...resource.attribution }, selectedTopic: selection.text,
      documentId: selection.documentId, page: selection.page })), discarded: value.discarded, fromCache };
  }
}
