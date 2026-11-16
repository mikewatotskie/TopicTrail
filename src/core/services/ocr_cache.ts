import { cloudIdentityKey, type CloudIdentity } from './cloud/types';

export type OcrCacheScope = 'guest' | CloudIdentity;

export interface OcrCacheResult {
  text: string;
  confidence: number | null;
  truncated: boolean;
}

export interface OcrCacheEntry {
  result: OcrCacheResult;
  retryable: boolean;
}

export interface OcrCacheIO {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  withLock?<T>(key: string, work: () => Promise<T>): Promise<T>;
}

const legacyEngine = 'tesseract-7-eng-1';
export type OcrEngine = typeof legacyEngine | 'tesseract-7-eng-fil-1' | 'mlkit-16.0.1-latin-1';
const KEY_PREFIX = 'topictrail.ocr.v1';
const MAX_PAGE = 100_000;
const MAX_TEXT = 50_000;
const MAX_SERIALIZED_LENGTH = MAX_TEXT * 6 + 512;
const writes = new Map<string, Promise<void>>();

function entryIdentity(scope: OcrCacheScope, hash: string, page: number): string {
  if (scope !== 'guest' && (!scope || typeof scope.project !== 'string' || typeof scope.uid !== 'string')) {
    throw new Error('The OCR cache account scope is invalid.');
  }
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) {
    throw new Error('The OCR cache requires a SHA-256 document hash.');
  }
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) {
    throw new Error('The OCR cache page number is invalid.');
  }
  const owner = scope === 'guest' ? 'guest' : cloudIdentityKey(scope);
  return `${owner}/${hash}/${page}`;
}

function resultKey(identity: string, engine: OcrEngine): string {
  const languages = engine === legacyEngine ? 'eng' : 'eng+fil';
  return `${KEY_PREFIX}/${engine}/${languages}/${identity}`;
}

/** All store/IO instances share a queue, including legacy and current engines. */
async function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (writes.get(key) ?? Promise.resolve()).then(work);
  // Rejected/uncertain writes must release the queue without discarding stored bytes.
  const settled = result.then(() => undefined, () => undefined);
  writes.set(key, settled);
  try { return await result; }
  finally { if (writes.get(key) === settled) writes.delete(key); }
}

function parseResult(value: unknown): OcrCacheResult | null {
  if (!value || typeof value !== 'object') return null;
  const { text, confidence, truncated } = value as Partial<OcrCacheResult>;
  if (typeof text !== 'string' || text.length > MAX_TEXT ||
      (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 100)) ||
      typeof truncated !== 'boolean') return null;
  return { text, confidence, truncated };
}

function readRecord(raw: string | null, key: string): OcrCacheResult | null {
  if (raw === null) return null;
  const corrupt = () => new Error('The stored OCR result is invalid.');
  if (typeof raw !== 'string' || raw.length > MAX_SERIALIZED_LENGTH) throw corrupt();
  let record: unknown;
  try { record = JSON.parse(raw); } catch { throw corrupt(); }
  if (!record || typeof record !== 'object') throw corrupt();
  const envelope = record as { key?: unknown; result?: unknown };
  const result = parseResult(envelope.result);
  if (envelope.key !== key || !result) throw corrupt();
  return result;
}

/** One durable entry per owner, document content, engine and page. */
export class OcrCacheStore {
  constructor(private readonly io: OcrCacheIO, private readonly engine: OcrEngine = legacyEngine) {}

  async read(scope: OcrCacheScope, hash: string, page: number): Promise<OcrCacheResult | null> {
    return (await this.readEntry(scope, hash, page))?.result ?? null;
  }

  async readEntry(scope: OcrCacheScope, hash: string, page: number): Promise<OcrCacheEntry | null> {
    const identity = entryIdentity(scope, hash, page);
    if (this.engine !== legacyEngine) {
      const oldKey = resultKey(identity, legacyEngine);
      const original = readRecord(await this.io.getItem(oldKey), oldKey);
      // v11 notes use exact transcript offsets, including whitespace-only results.
      if (original !== null) return { result: original, retryable: false };
    }
    const key = resultKey(identity, this.engine);
    const result = readRecord(await this.io.getItem(key), key);
    return result === null ? null : { result, retryable: this.engine !== legacyEngine && !result.text.trim() };
  }

  async save(scope: OcrCacheScope, hash: string, page: number, value: OcrCacheResult, current: () => boolean = () => true): Promise<OcrCacheResult | null> {
    // Capture the identity and primitive result fields before any queued work.
    const identity = entryIdentity(scope, hash, page);
    const key = resultKey(identity, this.engine);
    const oldKey = resultKey(identity, legacyEngine);
    const lockKey = `${KEY_PREFIX}/lock/${identity}`;
    const result = parseResult(value);
    if (!result) throw new Error('The OCR result is invalid or exceeds the cache limit.');
    if (!current()) return null;
    const commit = async (): Promise<OcrCacheResult | null> => {
      if (!current()) return null; // A cross-tab lock can be granted after account/focus loss.
      if (this.engine !== legacyEngine) {
        const raw = await this.io.getItem(oldKey);
        if (!current()) return null;
        const old = readRecord(raw, oldKey);
        if (old !== null) return old; // Never replace the transcript anchoring a v11 note.
      }
      const raw = await this.io.getItem(key);
      if (!current()) return null;
      const previous = readRecord(raw, key);
      // A nonblank canonical winner is immutable. Blank current attempts can be retried.
      if (previous?.text.trim()) return previous;
      await this.io.setItem(key, JSON.stringify({ key, result }));
      // An already committed old-owner value is retained; it is never published to a new owner.
      return current() ? result : null;
    };
    try {
      const winner = await serialize(lockKey, async () => {
        if (!current()) return null; // Includes time spent in another store instance's queue.
        const saved = this.io.withLock ? await this.io.withLock(lockKey, commit) : await commit();
        return current() ? saved : null;
      });
      return current() ? winner : null;
    } catch (error) {
      if (!current()) return null;
      throw error;
    }
  }
}
