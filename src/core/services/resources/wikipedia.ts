import { DiscoveryError, type ProviderResult, type ResourceCandidate, type ResourceProvider } from './types';
import { validateResourceUrl } from './urls';

export const WIKIPEDIA_ENDPOINT = 'https://en.wikipedia.org/w/api.php';
export const APPLICATION_ID = 'TopicTrail/1.0 (https://github.com/mikewatotskie/TopicTrail)';
const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const MAX_RESPONSE_CHARS = 200000;
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

interface Options { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number; minIntervalMs?: number; native?: boolean }
export class WikipediaProvider implements ResourceProvider {
  readonly id = 'wikipedia'; readonly name = 'Wikipedia';
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly native: boolean;
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  constructor(options: Options = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 10000; this.minIntervalMs = options.minIntervalMs ?? 1500;
    this.native = options.native ?? true;
  }
  private cooldown(header: string | null): DiscoveryError {
    const seconds = header !== null && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
    const date = header === null ? NaN : Date.parse(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - this.now()) : 5000;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + delay);
    return new DiscoveryError('rate_limit', 'Wikipedia is busy. Please wait before searching again.', this.blockedUntil);
  }
  search(query: string, signal: AbortSignal): Promise<ProviderResult> {
    const controller = new AbortController();
    let rejectStop!: (error: DiscoveryError) => void;
    let stopError: DiscoveryError | undefined;
    let spacingTimer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const stop = (error: DiscoveryError) => { if (!stopError) { stopError = error; controller.abort(); rejectStop(error); } };
    const cancelled = () => stop(new DiscoveryError('cancelled', 'Search stopped.'));
    signal.addEventListener('abort', cancelled, { once: true });
    const timeout = setTimeout(() => stop(new DiscoveryError('timeout', 'The search took too long. Please try again.')), this.timeoutMs);
    if (signal.aborted) cancelled();
    const check = () => { if (stopError) throw stopError; if (this.blockedUntil > this.now()) throw new DiscoveryError('rate_limit', 'Please wait before searching Wikipedia again.', this.blockedUntil); };
    const work = this.tail.then(async () => {
      check();
      const spacing = this.minIntervalMs - (this.now() - this.lastStart);
      if (spacing > 0) await Promise.race([new Promise<void>(resolve => { spacingTimer = setTimeout(resolve, spacing); }), stopped]);
      check(); this.lastStart = this.now();
      const url = new URL(WIKIPEDIA_ENDPOINT);
      const params = { action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '0', gsrlimit: '8',
        prop: 'info|extracts', inprop: 'url', exintro: '1', explaintext: '1', exchars: '500', exlimit: '8',
        format: 'json', formatversion: '2', origin: '*' };
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      const headers: Record<string, string> = { Accept: 'application/json', 'Api-User-Agent': APPLICATION_ID };
      if (this.native) headers['User-Agent'] = APPLICATION_ID;
      const response = await Promise.race([this.fetchImpl(url.href, { headers, signal: controller.signal, credentials: 'omit' }), stopped]);
      if (response.status === 429 || response.status === 503) throw this.cooldown(response.headers.get('Retry-After'));
      if (!response.ok) throw new DiscoveryError('api', 'Wikipedia is unavailable right now. Please try again later.');
      if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_CHARS) throw invalidData();
      const text = await Promise.race([response.text(), stopped]);
      if (text.length > MAX_RESPONSE_CHARS) throw invalidData();
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw invalidData(); }
      try { return parseWikipediaResponse(data); }
      catch (error) { if (error instanceof DiscoveryError && error.code === 'rate_limit') throw this.cooldown(response.headers.get('Retry-After')); throw error; }
    });
    const result = Promise.race([work, stopped]).catch(error => {
      if (stopError) throw stopError;
      if (error instanceof DiscoveryError) throw error;
      throw new DiscoveryError('network', 'Could not connect to Wikipedia. Check your connection and try again.');
    }).finally(() => {
      clearTimeout(timeout); if (spacingTimer !== undefined) clearTimeout(spacingTimer);
      signal.removeEventListener('abort', cancelled);
    });
    // A cancelled caller may finish before its queue position is reached. Keep
    // later work behind that position's predecessor, not the caller's abort race.
    this.tail = work.catch(() => undefined);
    return result;
  }
}
