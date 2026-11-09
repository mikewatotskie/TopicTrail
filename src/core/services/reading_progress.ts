import { DocumentFormat, type Document } from '../models/document';

export type ProgressDocument = Pick<Document, 'id' | 'format'>;
export type ReadingPosition = { page: number; totalPages: number };

type ProgressIO = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

function progressKey({ id, format }: ProgressDocument): string {
  if (!id || (format !== DocumentFormat.PDF && format !== DocumentFormat.DOCX)) {
    throw new Error('Invalid reading progress document');
  }
  return '@topictrail/reading-progress/v1/' + format + '/' + id;
}

function validPosition({ page, totalPages }: ReadingPosition): boolean {
  return Number.isSafeInteger(page) && Number.isSafeInteger(totalPages) && page >= 1 && page <= totalPages;
}

export class ReadingProgressStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly io: ProgressIO) {}

  async read(document: ProgressDocument): Promise<ReadingPosition | null> {
    const key = progressKey(document);
    await this.pending;
    return this.readRecord(key, document);
  }

  async save(document: ProgressDocument, { page, totalPages }: ReadingPosition): Promise<void> {
    const key = progressKey(document);
    if (!validPosition({ page, totalPages })) throw new Error('Invalid reading progress position');

    const write = this.pending.then(async () => {
      const previous = await this.readRecord(key, document);
      if (previous?.page === page && previous.totalPages === totalPages) return;
      await this.io.setItem(key, JSON.stringify({
        version: 1, documentId: document.id, format: document.format, page, totalPages,
      }));
    });

    // Expose failures to callers without preventing the next operation from reaching storage.
    this.pending = write.catch(() => undefined);
    return write;
  }

  private async readRecord(key: string, document: ProgressDocument): Promise<ReadingPosition | null> {
    const raw = await this.io.getItem(key);
    if (raw === null) return null;

    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error('Invalid reading progress record'); }
    if (typeof value !== 'object' || value === null) throw new Error('Invalid reading progress record');

    const record = value as Partial<ReadingPosition> & { version?: unknown; documentId?: unknown; format?: unknown };
    if (record.version !== 1 || record.documentId !== document.id || record.format !== document.format
      || typeof record.page !== 'number' || typeof record.totalPages !== 'number'
      || !validPosition({ page: record.page, totalPages: record.totalPages })) {
      throw new Error('Invalid reading progress record');
    }
    return { page: record.page, totalPages: record.totalPages };
  }
}

type RenderedPosition =
  | { type: 'ignore' }
  | { type: 'resume'; page: number }
  | { type: 'rendered'; saved?: Promise<void> };

/** A reader attempt only saves confirmed renders after its initial resume has completed. */
export class ReadingProgressSession {
  private initialPosition: ReadingPosition | null | undefined;
  private resumePage: number | undefined;
  private writable = false;

  constructor(private readonly store: ReadingProgressStore, private readonly document: ProgressDocument) {}

  async hydrate(): Promise<void> {
    try {
      this.initialPosition = await this.store.read(this.document);
      this.writable = true;
    } finally {
      this.initialPosition ??= null;
    }
  }

  pageRendered(position: ReadingPosition): RenderedPosition {
    if (this.initialPosition === undefined || !validPosition(position)) return { type: 'ignore' };
    if (this.initialPosition) {
      const page = Math.min(this.initialPosition.page, position.totalPages);
      this.initialPosition = null;
      if (page !== position.page) {
        this.resumePage = page;
        return { type: 'resume', page };
      }
    }
    if (this.resumePage !== undefined && position.page !== this.resumePage) return { type: 'ignore' };
    this.resumePage = undefined;

    return this.writable
      ? { type: 'rendered', saved: this.store.save(this.document, position) }
      : { type: 'rendered' };
  }
}
