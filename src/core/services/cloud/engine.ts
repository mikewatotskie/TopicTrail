import type { Document } from '../../models/document';
import type { DocumentStorageApi } from '../document_storage_contract';
import { cloudIdentityKey, type CloudCache, type CloudIdentity, type CloudRemote, type CloudSession } from './types';
import { SyncRateLimit, SyncRetryGate, scheduleRetry, syncDelayedMessage } from './sync_retry';
import { LibraryPull } from './paged_pull';

export interface CloudSyncSnapshot {
  readonly identity: CloudIdentity | null;
  readonly key: string | null;
  readonly epoch: number;
  readonly revision: number;
  readonly phase: 'guest' | 'unavailable' | 'syncing' | 'waiting' | 'ready' | 'error';
  readonly message: string;
  readonly pending: number;
  readonly lastSyncedAt: number | null;
}

interface CloudSyncDependencies {
  cache(identity: CloudIdentity): CloudCache;
  session(): Promise<CloudSession | null>;
  remote(session: CloudSession, signal: AbortSignal, gate: SyncRetryGate, pull: LibraryPull): CloudRemote;
  legacy: Pick<DocumentStorageApi, 'getAllDocuments'>;
  readLegacy(document: Document): Promise<Uint8Array>;
}

interface AccountSelection {
  readonly identity: CloudIdentity;
  readonly key: string;
  readonly abort: AbortController;
  cache?: CloudCache;
  gate?: SyncRetryGate;
  pull?: LibraryPull;
  retryTimer?: ReturnType<typeof setTimeout>;
  syncing?: Promise<void>;
  copying?: Promise<void>;
  requested: boolean;
}

const unavailableMessage = 'Account library access is unavailable.';
const guestMessage = 'Sign in to sync documents across devices.';
const syncErrorMessage = 'Cloud sync could not finish. Try syncing again.';

export class CloudSyncEngine {
  private selection: AccountSelection | null = null;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private snapshot: CloudSyncSnapshot = {
    identity: null, key: null, epoch: 0, revision: 0, phase: 'unavailable',
    message: unavailableMessage, pending: 0, lastSyncedAt: null,
  };

  constructor(private readonly dependencies: CloudSyncDependencies) {}

  readonly getSnapshot = (): CloudSyncSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  select(identity: CloudIdentity | null, available = true): void {
    if (this.disposed) return;
    const selectedIdentity = available && identity ? Object.freeze({ project: identity.project, uid: identity.uid }) : null;
    const key = selectedIdentity ? cloudIdentityKey(selectedIdentity) : null;
    const phase = selectedIdentity ? 'syncing' : available ? 'guest' : 'unavailable';
    if (key ? this.selection?.key === key : this.snapshot.phase === phase) return;

    clearTimeout(this.selection?.retryTimer);
    this.selection?.abort.abort();
    const selection = selectedIdentity && key
      ? { identity: selectedIdentity, key, abort: new AbortController(), requested: false }
      : null;
    this.selection = selection;
    this.publish({
      ...this.snapshot,
      identity: selectedIdentity,
      key,
      epoch: this.snapshot.epoch + 1,
      phase,
      message: selectedIdentity ? 'Syncing your account library…' : available ? guestMessage : unavailableMessage,
      pending: 0,
      lastSyncedAt: null,
    });
    if (selection && this.isCurrent(selection)) void this.sync();
  }

  sync(): Promise<void> {
    const selection = this.selection;
    if (!selection) return Promise.resolve();
    selection.requested = true;
    selection.syncing ??= Promise.resolve().then(() => this.drain(selection));
    return selection.syncing;
  }

  getRetryGate(): SyncRetryGate | undefined {
    const selection = this.selection;
    if (selection) return selection.gate ??= new SyncRetryGate(this.getCache(selection).retryWindow);
  }

  copyLegacy(): Promise<void> {
    const selection = this.selection;
    if (!selection) return Promise.reject(new Error('Sign in before copying device files.'));
    selection.copying ??= Promise.resolve()
      .then(() => this.copyDeviceFiles(selection))
      .finally(() => { selection.copying = undefined; });
    return selection.copying;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    clearTimeout(this.selection?.retryTimer);
    this.selection?.abort.abort();
    this.selection = null;
  }

  private publish(snapshot: CloudSyncSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private isCurrent(selection: AccountSelection): boolean {
    return this.selection === selection && !selection.abort.signal.aborted;
  }

  private assertCurrent(selection: AccountSelection): void {
    if (!this.isCurrent(selection)) throw new Error('The selected account changed.');
  }

  private getCache(selection: AccountSelection): CloudCache {
    this.assertCurrent(selection);
    if (!selection.cache) {
      const cache = this.dependencies.cache(selection.identity);
      if (cloudIdentityKey(cache.identity) !== selection.key) throw new Error('The account library does not match.');
      selection.cache = cache;
    }
    return selection.cache;
  }

  private async drain(selection: AccountSelection): Promise<void> {
    try {
      while (this.isCurrent(selection) && selection.requested) {
        selection.requested = false;
        await this.syncOnce(selection);
      }
    } finally {
      selection.syncing = undefined;
    }
  }

  private async syncOnce(selection: AccountSelection): Promise<void> {
    let paused = false;
    try {
      const gate = this.getRetryGate()!;
      await gate.prepare();
      this.assertCurrent(selection);
      clearTimeout(selection.retryTimer);
      selection.retryTimer=undefined;
      this.publish({ ...this.snapshot, phase: 'syncing', message: 'Syncing your account library…' });
      const cache = this.getCache(selection);
      const entries = await cache.listSyncEntries();
      this.assertCurrent(selection);
      const uploads = entries.filter(entry => !entry.hidden && !entry.synced);
      let pending = uploads.length;
      this.publish({ ...this.snapshot, pending });

      this.assertCurrent(selection);
      const session = await this.dependencies.session();
      this.assertCurrent(selection);
      if (!session || session.uid !== selection.identity.uid || session.project !== selection.identity.project || !session.accessToken) {
        this.publish({ ...this.snapshot, phase: 'error', message: 'Your account session is unavailable. Try signing in again.' });
        return;
      }

      const pull = selection.pull ??= new LibraryPull();
      const remote = this.dependencies.remote(session, selection.abort.signal, gate, pull);
      let fileFailures=0;let listFailed=false;
      if(cache.study&&remote.listStudy&&!pull.initialStudyMerged){const metadata=await remote.listStudy();this.assertCurrent(selection);await cache.study.merge(metadata);this.assertCurrent(selection);pull.initialStudyMerged=true;this.publish({...this.snapshot,revision:this.snapshot.revision+1});}
      let rows:Awaited<ReturnType<CloudRemote['list']>>=[];
      try{rows=pull.listedFiles??=await remote.list();}catch(error){this.assertCurrent(selection);if(error instanceof SyncRateLimit)throw error;fileFailures++;listFailed=true;}
      this.assertCurrent(selection);
      if (rows.some(row => row.user_id !== selection.identity.uid)) throw new Error('The cloud library does not match.');

      for (const { document } of (listFailed?[]:uploads)) {
        try {
        this.assertCurrent(selection);
        const bytes = await cache.readBytes(document);
        this.assertCurrent(selection);
        let visible = await cache.getDocument(document.id);
        this.assertCurrent(selection);
        // A file moved to account Trash before its first sync still needs its
        // immutable original uploaded before the metadata RPC can reference it.
        if(!visible&&cache.study){
          const currentEntries=await cache.listSyncEntries();this.assertCurrent(selection);
          const entry=currentEntries.find(item=>item.document.id===document.id&&!item.hidden);
          if(entry)visible=entry.document;
        }
        if (visible) {
          const uploaded = await remote.upload(visible, bytes);
          this.assertCurrent(selection);
          await cache.markSynced(document.id, uploaded);
          this.assertCurrent(selection);
        }
        pending--;
        this.publish({ ...this.snapshot, pending, revision: this.snapshot.revision + (visible ? 1 : 0) });
        }catch(error){this.assertCurrent(selection);if(error instanceof SyncRateLimit)throw error;fileFailures++;}
      }

      const known = new Map(entries.map(entry => [entry.document.id, entry]));
      for (const row of rows) {
        try {
        this.assertCurrent(selection);
        const existing = known.get(row.id);
        if (existing && (existing.hidden || !existing.synced)) continue;
        if (existing) {
          const hasBytes = await cache.documentFileExists(row.id);
          this.assertCurrent(selection);
          if (hasBytes) continue;
          const visible = await cache.getDocument(row.id);
          this.assertCurrent(selection);
          if (!visible) continue;
        }
        const bytes = await remote.download(row);
        this.assertCurrent(selection);
        const document = await cache.acceptRemote(row, bytes);
        this.assertCurrent(selection);
        known.set(row.id, { document, hidden: false, synced: true });
        this.publish({ ...this.snapshot, revision: this.snapshot.revision + 1 });
        }catch(error){this.assertCurrent(selection);if(error instanceof SyncRateLimit)throw error;fileFailures++;}
      }

      let conflicts=0;let failedStudy=0;let rejectedStudy=0;
      const failedItems=new Set<string>();
      if(cache.study&&remote.listStudy&&remote.applyStudy){
        if(!pull.beforeWritesMerged){
          const pulled=await remote.listStudy();this.assertCurrent(selection);await cache.study.merge(pulled);this.assertCurrent(selection);
          pull.beforeWritesMerged=true;
        }
        const pendingStudy=(await cache.study.read()).pending;this.assertCurrent(selection);
        this.publish({...this.snapshot,pending:pending+pendingStudy.length});
        for(const mutation of pendingStudy){
          const current=await cache.study.read();this.assertCurrent(selection);
          if(!current.pending.some(item=>item.operationId===mutation.operationId))continue;
          const itemKey=mutation.kind+':'+mutation.id;if(failedItems.has(itemKey))continue;
          try { const reply=await remote.applyStudy(mutation);this.assertCurrent(selection);
            await cache.study.acknowledge(mutation.operationId,reply);this.assertCurrent(selection);
          } catch(error) {this.assertCurrent(selection);if(error instanceof SyncRateLimit)throw error;failedItems.add(itemKey);failedStudy++;
            if(error&&typeof error==='object'&&'status' in error&&[400,413,422].includes(Number(error.status)))rejectedStudy++;
          }
        }
        // Pull again: Trash/Restore also changes document progress on the server.
        const latest=await remote.listStudy();this.assertCurrent(selection);await cache.study.merge(latest);this.assertCurrent(selection);
        const state=await cache.study.read();this.assertCurrent(selection);conflicts=state.conflicts.length;
        if(state.pending.some(item=>!pendingStudy.some(old=>old.operationId===item.operationId)))selection.requested=true;
        this.publish({...this.snapshot,pending:pending+state.pending.length,revision:this.snapshot.revision+1});
      }
      if (this.isCurrent(selection) && !selection.requested) {
        if (!failedStudy && !fileFailures) {
          await gate.completed();
          this.assertCurrent(selection);
        }
        this.publish({ ...this.snapshot, phase: failedStudy||fileFailures?'error':'ready', message: fileFailures ? 'Some original files could not transfer. Study changes were processed independently; retry sync to finish the files.' : failedStudy ? (rejectedStudy ? 'Some changes were rejected by the cloud. They remain safely queued; other items were synchronized.' : 'Some changes are still queued. Check your connection and retry; other items were synchronized.') : conflicts?`${conflicts} cloud conflict${conflicts===1?'':'s'} need your choice. Your alternatives are preserved.`:'Account library synced.', lastSyncedAt: failedStudy||fileFailures?this.snapshot.lastSyncedAt:Date.now() });
      }
    } catch (error) {
      if (error instanceof SyncRateLimit && this.isCurrent(selection)) {
        paused = true;
        const until = await this.getRetryGate()!.defer(error);
        if (!this.isCurrent(selection)) return;
        const cache=this.getCache(selection);
        const pending=await Promise.all([cache.listSyncEntries(),cache.study?.read()])
          .then(([entries,study])=>entries.filter(entry=>!entry.synced&&!entry.hidden).length+(study?.pending.length??0))
          .catch(()=>this.snapshot.pending);
        if (!this.isCurrent(selection)) return;
        selection.requested = false;
        clearTimeout(selection.retryTimer);
        selection.retryTimer = scheduleRetry(until, () => {
          selection.retryTimer = undefined;
          if (this.isCurrent(selection)) void this.sync();
        });
        this.publish({ ...this.snapshot, pending, phase: 'waiting', message: syncDelayedMessage });
        return;
      }
      if (this.isCurrent(selection) && !selection.requested) {
        this.publish({ ...this.snapshot, phase: 'error', message: syncErrorMessage });
      }
    } finally {
      if (!paused) selection.pull = undefined;
    }
  }

  private async copyDeviceFiles(selection: AccountSelection): Promise<void> {
    const cache = this.getCache(selection);
    const documents = await this.dependencies.legacy.getAllDocuments();
    this.assertCurrent(selection);
    let failed = false;
    for (const document of documents) {
      this.assertCurrent(selection);
      try {
        const bytes = await this.dependencies.readLegacy(document);
        this.assertCurrent(selection);
        await cache.copyLegacy(document, bytes);
        this.assertCurrent(selection);
        this.publish({ ...this.snapshot, revision: this.snapshot.revision + 1 });
      } catch {
        this.assertCurrent(selection);
        failed = true;
      }
    }
    this.assertCurrent(selection);
    await this.sync();
    this.assertCurrent(selection);
    if (failed) throw new Error('Some device files could not be copied. You can try copying them again.');
  }
}
