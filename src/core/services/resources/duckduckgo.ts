import { evaluateUrl } from '../link_shield';
import { ProviderRequest, type SearchRequestOptions } from './provider_request';
import { DiscoveryError, type ProviderResult, type ResourceProvider } from './types';

export function duckDuckGoSearchUrl(query: string): string {
  const url = new URL('https://duckduckgo.com/');
  url.searchParams.set('q', query);
  return url.href;
}

function displayText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function parseDuckDuckGoResponse(value: unknown, query: string): ProviderResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DiscoveryError('invalid_data', 'DuckDuckGo returned an unreadable answer.');
  }
  const data = value as Record<string, unknown>;
  if (typeof data.AbstractText !== 'string' && typeof data.Definition !== 'string') {
    throw new DiscoveryError('invalid_data', 'DuckDuckGo returned an unreadable answer.');
  }
  const heading = displayText(data.Heading);
  const title = heading && [...heading].length <= 300 ? heading : query;
  let discarded = 0;
  // Pair each answer only with its own source. Related results and redirects are not answers.
  for (const [content, source, link] of [
    [data.AbstractText, data.AbstractSource, data.AbstractURL],
    [data.Definition, data.DefinitionSource, data.DefinitionURL],
  ]) {
    const answer = displayText(content);
    if (!answer) continue;
    const sourceName = displayText(source);
    const { normalizedUrl, canOpenExternal } = evaluateUrl(link);
    if (!sourceName || [...sourceName].length > 120 || !canOpenExternal || !normalizedUrl) {
      discarded++;
      continue;
    }
    const characters = [...answer];
    const description = characters.length > 800 ? characters.slice(0, 799).join('').trimEnd() + '…' : answer;
    return { resources: [{
      id: 'duckduckgo:' + normalizedUrl, providerId: 'duckduckgo', providerName: sourceName,
      title, description, type: 'Instant Answer', url: normalizedUrl, providerOrder: 0,
    }], discarded };
  }
  return { resources: [], discarded };
}

export class DuckDuckGoProvider implements ResourceProvider {
  readonly id = 'duckduckgo';
  readonly name = 'DuckDuckGo';
  private readonly transport: ProviderRequest;
  constructor(options: SearchRequestOptions = {}) {
    this.transport = new ProviderRequest(this.name, query => {
      const url = new URL('https://api.duckduckgo.com/');
      const parameters = { q: query, format: 'json', no_html: '1', no_redirect: '1', t: 'topictrail' };
      for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
      return { url: url.href, headers: { Accept: 'application/json' } };
    }, parseDuckDuckGoResponse, options);
  }
  search(query: string, signal: AbortSignal) { return this.transport.search(query, signal); }
}
