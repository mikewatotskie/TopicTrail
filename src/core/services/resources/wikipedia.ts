import { DiscoveryError, type ProviderResult, type ResourceCandidate, type ResourceProvider } from './types';
import { validateResourceUrl } from './urls';
import { ProviderRequest, type SearchRequestOptions } from './provider_request';

export const WIKIPEDIA_ENDPOINT = 'https://en.wikipedia.org/w/api.php';
export const APPLICATION_ID = 'TopicTrail/1.0 (https://github.com/mikewatotskie/TopicTrail)';
const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalidData = () => new DiscoveryError('invalid_data', 'Wikipedia returned resource data we could not read. Please try again.');

export function parseWikipediaResponse(value: unknown): ProviderResult {
  if (!object(value)) throw invalidData();
  if (Object.hasOwn(value, 'error') && !object(value.error)) throw invalidData();
  if (object(value.error)) {
    if (value.error.code === 'maxlag' || value.error.code === 'ratelimited') throw new DiscoveryError('rate_limit', 'Wikipedia is busy. Please wait before searching again.');
    throw new DiscoveryError('api', 'Wikipedia could not complete this search. Please try again later.');
  }
  // A generator query with no matches returns batchcomplete and no query object.
  if (value.batchcomplete === true && value.query === undefined) return { resources: [], discarded: 0 };
  if (!object(value.query) || !Array.isArray(value.query.pages) || value.query.pages.length > 50) throw invalidData();
  const resources: ResourceCandidate[] = [];
  let discarded = 0;
  for (const entry of value.query.pages) {
    if (!object(entry)) { discarded++; continue; }
    const url = validateResourceUrl(entry.canonicalurl ?? entry.fullurl);
    if (!Number.isSafeInteger(entry.pageid) || Number(entry.pageid) <= 0 || entry.ns !== 0 || !url ||
        typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 300 ||
        (entry.extract !== undefined && typeof entry.extract !== 'string')) { discarded++; continue; }
    const revisionUrl = Number.isSafeInteger(entry.lastrevid) && Number(entry.lastrevid) > 0
      ? `https://en.wikipedia.org/w/index.php?oldid=${entry.lastrevid}` : undefined;
    resources.push({ id: `wikipedia:${entry.pageid}`, title: entry.title.trim(), providerId: 'wikipedia', providerName: 'Wikipedia',
      description: typeof entry.extract === 'string' ? [...entry.extract.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim()].slice(0, 800).join('') || undefined : undefined,
      url, type: 'Article', providerOrder: Number.isSafeInteger(entry.index) ? Number(entry.index) : resources.length + 1,
      attribution: { author: 'Wikipedia contributors', licenseName: 'CC BY-SA 4.0', licenseUrl: LICENSE_URL, sourceUrl: url, revisionUrl } });
  }
  if (!resources.length && discarded) throw invalidData();
  return { resources, discarded };
}

export class WikipediaProvider implements ResourceProvider {
  readonly id = 'wikipedia'; readonly name = 'Wikipedia';
  private readonly transport: ProviderRequest;
  constructor(options: SearchRequestOptions & { native?: boolean } = {}) {
    this.transport = new ProviderRequest(this.name, query => {
      const url = new URL(WIKIPEDIA_ENDPOINT);
      const params = { action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '0', gsrlimit: '8',
        prop: 'info|extracts', inprop: 'url', exintro: '1', explaintext: '1', exchars: '500', exlimit: '8',
        format: 'json', formatversion: '2', origin: '*' };
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      const headers: Record<string, string> = { Accept: 'application/json', 'Api-User-Agent': APPLICATION_ID };
      if (options.native ?? true) headers['User-Agent'] = APPLICATION_ID;
      return { url: url.href, headers };
    }, parseWikipediaResponse, options);
  }
  search(query: string, signal: AbortSignal) { return this.transport.search(query, signal); }
}
