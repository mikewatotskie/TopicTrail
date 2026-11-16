import type { CloudDocumentRow } from './types';
import type { StudyRecord } from './study_state';
import { SyncRateLimit } from './sync_retry';

/** Keep validated pages until the selected account finishes its interrupted pull.
 * The next attempt supplies a fresh session and requests only the next page. */
export class PagedPull<T> {
  private saved?: T[];
  private scope?: string;

  async collect(scope: string, next: (previous: T | undefined) => Promise<T[]>,
    ordered: (value: T, previous: T) => boolean, invalid: () => Error, limit = Infinity): Promise<T[]> {
    const rows = this.scope === scope && this.saved ? this.saved : [];
    this.scope = scope;
    this.saved = undefined;
    try {
      for (;;) {
        const page = await next(rows[rows.length - 1]);
        if (!page.length) return rows;
        if (rows.length + page.length > limit) throw invalid();
        for (const row of page) {
          if (rows.length && !ordered(row, rows[rows.length - 1])) throw invalid();
          rows.push(row);
        }
      }
    } catch (error) {
      if (error instanceof SyncRateLimit && this.scope === scope) this.saved = rows;
      throw error;
    }
  }
}

export class LibraryPull {
  readonly documents = new PagedPull<CloudDocumentRow>();
  readonly study = new PagedPull<StudyRecord>();
  initialStudyMerged = false;
  beforeWritesMerged = false;
  listedFiles?: CloudDocumentRow[];
}
