import { DiscoveryError, type ProviderResult } from './types';

const MAX_RESPONSE_CHARS = 200000;
export interface SearchRequestOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  minIntervalMs?: number;
}

interface SearchRequest { url: string; headers: Record<string, string> }

/** One queue and cooldown per source. Only an explicitly submitted topic reaches the transport. */
export class ProviderRequest {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  constructor(
    private readonly name: string,
    private readonly request: (query: string) => SearchRequest,
    private readonly parse: (data: unknown, query: string) => ProviderResult,
    options: SearchRequestOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.minIntervalMs = options.minIntervalMs ?? 1500;
  }
  private invalidData() {
    return new DiscoveryError('invalid_data', `${this.name} returned resource data we could not read. Please try again.`);
  }

  private cooldown(header: string | null): DiscoveryError {
    const seconds = header !== null && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
    const date = header === null ? NaN : Date.parse(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - this.now()) : 5000;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + delay);
    return new DiscoveryError('rate_limit', `${this.name} is busy. Please wait before searching again.`, this.blockedUntil);
  }
  search(query: string, signal: AbortSignal): Promise<ProviderResult> {
    const controller = new AbortController();
    let rejectStop!: (error: DiscoveryError) => void;
    let stopError: DiscoveryError | undefined;
    let spacingTimer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const stop = (error: DiscoveryError) => {
      if (stopError) return;
      stopError = error;
      controller.abort();
      rejectStop(error);
    };
    const cancelled = () => stop(new DiscoveryError('cancelled', 'Search stopped.'));
    signal.addEventListener('abort', cancelled, { once: true });
    const timeout = setTimeout(() => stop(new DiscoveryError('timeout', 'The search took too long. Please try again.')), this.timeoutMs);
    if (signal.aborted) cancelled();
    const check = () => {
      if (stopError) throw stopError;
      if (this.blockedUntil > this.now()) {
        throw new DiscoveryError('rate_limit', `Please wait before searching ${this.name} again.`, this.blockedUntil);
      }
    };
    const work = this.tail.then(async () => {
      check();
      const spacing = this.minIntervalMs - (this.now() - this.lastStart);
      if (spacing > 0) {
        const delay = new Promise<void>(resolve => { spacingTimer = setTimeout(resolve, spacing); });
        await Promise.race([delay, stopped]);
      }
      check();
      this.lastStart = this.now();
      const { url, headers } = this.request(query);
      const response = await Promise.race([this.fetchImpl(url, {
        headers, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      }), stopped]);
      if (response.status === 429 || response.status === 503) throw this.cooldown(response.headers.get('Retry-After'));
      if (!response.ok) throw new DiscoveryError('api', `${this.name} is unavailable right now. Please try again later.`);
      if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_CHARS) throw this.invalidData();
      const text = await Promise.race([response.text(), stopped]);
      if (text.length > MAX_RESPONSE_CHARS) throw this.invalidData();
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw this.invalidData(); }
      try { return this.parse(data, query); }
      catch (error) {
        if (error instanceof DiscoveryError && error.code === 'rate_limit') {
          throw this.cooldown(response.headers.get('Retry-After'));
        }
        throw error;
      }
    });
    const result = Promise.race([work, stopped]).catch(error => {
      if (stopError) throw stopError;
      if (error instanceof DiscoveryError) throw error;
      throw new DiscoveryError('network', `Could not connect to ${this.name}. Check your connection and try again.`);
    }).finally(() => {
      clearTimeout(timeout);
      if (spacingTimer !== undefined) clearTimeout(spacingTimer);
      signal.removeEventListener('abort', cancelled);
    });
    // A cancelled caller may finish before its queue position is reached. Keep
    // later work behind that position's predecessor, not the caller's abort race.
    this.tail = work.catch(() => undefined);
    return result;
  }
}
