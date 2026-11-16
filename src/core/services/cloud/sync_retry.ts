export const syncDelayedMessage = 'Saved on this device. Sync will resume shortly.';
const maxBackoff = 300_000;

export interface RetryWindow {
  until: number;
  attempts: number;
}

export interface RetryWindowStore {
  read(): Promise<RetryWindow | null>;
  extend(window: RetryWindow): Promise<RetryWindow>;
  clear(expected: RetryWindow): Promise<void>;
}

export function validRetryWindow(value: unknown): value is RetryWindow {
  if (!value || typeof value !== 'object') return false;
  const window = value as Partial<RetryWindow>;
  return Number.isSafeInteger(window.until) && window.until! > 0 &&
    Number.isInteger(window.attempts) && window.attempts! >= 1 && window.attempts! <= 7;
}

export function retryAfterDeadline(header: string | null, now = Date.now()): number | null {
  const raw = header?.trim();
  if (raw && /^\d+$/.test(raw)) return Math.min(Number.MAX_SAFE_INTEGER, now + Number(raw) * 1000);
  // Date.parse also accepts strings such as "-1" as calendar dates.
  if (raw && /^[A-Za-z]{3,9},?\s/.test(raw)) {
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

export class SyncRateLimit extends Error {
  readonly status = 429;
  constructor(readonly retryAt: number | null) { super(syncDelayedMessage); }

  static fromResponse(response: Response, now = Date.now()): SyncRateLimit {
    return new SyncRateLimit(retryAfterDeadline(response.headers.get('retry-after'), now));
  }
}

/** One gate for file, study and note requests made by the same signed-in account. */
export class SyncRetryGate {
  private window: RetryWindow | null = null;

  constructor(private readonly store?: RetryWindowStore,
    private readonly now = Date.now, private readonly random = Math.random) {}

  async prepare(): Promise<void> {
    this.assertReady();
    const stored = await this.store?.read();
    if (stored && (!this.window || stored.until >= this.window.until)) this.window = stored;
    this.assertReady();
  }

  assertReady(): void {
    if (this.window && this.window.until > this.now()) throw new SyncRateLimit(this.window.until);
  }

  guard(fetcher: typeof fetch): typeof fetch {
    return async (input, init) => { this.assertReady(); return fetcher(input, init); };
  }

  async defer(error: SyncRateLimit): Promise<number> {
    const now = this.now();
    const old = this.window;
    // A second worker may already have recorded the same response or a longer delay.
    if (old && old.until > now && (error.retryAt ?? 0) <= old.until) return old.until;
    const recentAttempts = old && now - old.until < maxBackoff ? old.attempts : 0;
    const attempts = old && old.until > now ? old.attempts : Math.min(recentAttempts + 1, 7);
    const ceiling = Math.min(maxBackoff, 5_000 * 2 ** (attempts - 1));
    const fallback = now + Math.ceil(ceiling * (0.5 + this.random() / 2));
    const proposed = { attempts, until: Math.max(now + 1000, error.retryAt ?? fallback) };
    this.window = proposed;
    // An unavailable local store must not bypass the in-memory cooldown.
    const stored = await this.store?.extend(proposed).catch(() => undefined);
    if (stored && (!this.window || stored.until >= this.window.until)) this.window = stored;
    return this.window?.until ?? proposed.until;
  }

  async completed(): Promise<void> {
    const old = this.window;
    // A successful library read between two throttled note writes must not
    // reset the note's exponential delay. Forget it after a quiet period.
    if (!old || this.now() - old.until < maxBackoff) return;
    if (this.store) await this.store.clear(old);
    if (this.window === old) this.window = null;
  }
}

export function scheduleRetry(until: number, action: () => void): ReturnType<typeof setTimeout> {
  // JavaScript timers wrap beyond a signed 32-bit delay. The gate rechecks the deadline on wake.
  return setTimeout(action, Math.min(2_147_483_647, Math.max(0, until - Date.now())));
}
