import { assertDocumentStoreProtocol, DOCUMENT_STORE_PROTOCOL, DocumentRecoveryError,
  type DocumentStoreProtocol } from '../document_recovery_contract';

export const SUCCESSOR_DATABASE_VERSION = 3;
const stores = ['libraries', 'documents', 'document-control', 'document-evidence'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Bootstrap is deliberately not an active V4 envelope or a sealed recovery plan. */
export interface BootstrapControl {
  readonly version: 1;
  readonly protocol: DocumentStoreProtocol;
  readonly mode: 'migration';
  readonly controlRevision: 1;
  readonly fenceEpoch: 1;
  readonly migrationId: string;
  readonly sourceDatabaseVersion: 0 | 1;
  readonly captureId: string;
  readonly libraryId: null;
  readonly lastEnvelope: null;
  readonly activeGenerationId: null;
  readonly activePlan: null;
  readonly evidenceManifestIds: readonly [];
}
export interface CapturedLibraryRecord {
  readonly kind: 'raw-library-record';
  readonly migrationId: string;
  readonly id: string;
  readonly sourceKey: IDBValidKey;
  readonly value: unknown;
}
export interface BootstrapCapture {
  readonly kind: 'upgrade-capture';
  readonly migrationId: string;
  readonly id: string;
  readonly sourceDatabaseVersion: 0 | 1;
  readonly recordIds: readonly string[];
  /** Every existing key is retained, including orphan/unknown keys. These are not live-document claims. */
  readonly pinnedDocumentKeys: readonly IDBValidKey[];
}
export interface BootstrapInspection {
  readonly control: BootstrapControl;
  readonly capture: BootstrapCapture;
  readonly records: readonly CapturedLibraryRecord[];
}
export interface SuccessorDatabase {
  readonly name: string;
  readonly version: 3;
  readonly upgraded: boolean;
  /** Cancellation lost the race with upgrade commit: the durable barrier must be resumed. */
  readonly cancelledAfterUpgrade: boolean;
  inspectBootstrap(): Promise<BootstrapInspection>;
  close(): void;
}
function recoveryRequired(): DocumentRecoveryError {
  return new DocumentRecoveryError('recovery_required', 'Library upgrade evidence requires recovery. Existing data has been preserved.');
}
function storageFailure(error: unknown): DocumentRecoveryError {
  if (error instanceof DocumentRecoveryError) return error;
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  if (name === 'VersionError') return new DocumentRecoveryError('upgrade_required', 'This browser library requires a newer compatible TopicTrail version.');
  if (name === 'QuotaExceededError') return new DocumentRecoveryError('storage_full', 'Browser storage is full. Free space before retrying the library upgrade.');
  return new DocumentRecoveryError('storage_unavailable', 'Browser storage could not be accessed. Existing data has been preserved.');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw recoveryRequired();
  return value as Record<string, unknown>;
}
function validateControl(value: unknown): BootstrapControl {
  const item = record(value, ['version', 'protocol', 'mode', 'controlRevision', 'fenceEpoch', 'migrationId',
    'sourceDatabaseVersion', 'captureId', 'libraryId', 'lastEnvelope', 'activeGenerationId', 'activePlan', 'evidenceManifestIds']);
  assertDocumentStoreProtocol(item.protocol);
  if (item.version !== 1 || item.mode !== 'migration' || item.controlRevision !== 1 || item.fenceEpoch !== 1
    || typeof item.migrationId !== 'string' || !uuid.test(item.migrationId)
    || (item.sourceDatabaseVersion !== 0 && item.sourceDatabaseVersion !== 1)
    || item.captureId !== `${item.migrationId}:capture` || item.libraryId !== null || item.lastEnvelope !== null
    || item.activeGenerationId !== null || item.activePlan !== null
    || !Array.isArray(item.evidenceManifestIds) || item.evidenceManifestIds.length !== 0) throw recoveryRequired();
  return value as BootstrapControl;
}
function validateCapture(value: unknown, control: BootstrapControl): BootstrapCapture {
  const item = record(value, ['kind', 'migrationId', 'id', 'sourceDatabaseVersion', 'recordIds', 'pinnedDocumentKeys']);
  if (item.kind !== 'upgrade-capture' || item.migrationId !== control.migrationId || item.id !== control.captureId
    || item.sourceDatabaseVersion !== control.sourceDatabaseVersion || !Array.isArray(item.recordIds)
    || item.recordIds.some((id, index) => id !== `${control.migrationId}:library:${index}`)
    || !Array.isArray(item.pinnedDocumentKeys)) throw recoveryRequired();
  return value as BootstrapCapture;
}
function validateSchema(db: IDBDatabase, tx: IDBTransaction, expected: readonly string[]): void {
  if (db.objectStoreNames.length !== expected.length || expected.some(name => !db.objectStoreNames.contains(name))) throw recoveryRequired();
  for (const name of expected) {
    const store = tx.objectStore(name);
    if (store.keyPath !== null || store.autoIncrement || store.indexNames.length !== 0) throw recoveryRequired();
  }
}

function inspect(db: IDBDatabase, factory: IDBFactory): Promise<BootstrapInspection> {
  return new Promise((resolve, reject) => {
    let result: BootstrapInspection | undefined;
    let failure: unknown;
    try {
      if (db.objectStoreNames.length !== stores.length || stores.some(name => !db.objectStoreNames.contains(name))) throw recoveryRequired();
      const tx = db.transaction([...stores], 'readonly');
      const abort = (error: unknown) => {
        failure ??= error;
        try { tx.abort(); } catch { reject(storageFailure(failure)); }
      };
      tx.onabort = () => reject(storageFailure(failure ?? tx.error));
      tx.onerror = () => { failure ??= tx.error; };
      tx.oncomplete = () => result ? resolve(result) : reject(recoveryRequired());
      validateSchema(db, tx, stores);
      const state = tx.objectStore('document-control').get('state');
      state.onsuccess = () => {
        try {
          const control = validateControl(state.result);
          const evidence = tx.objectStore('document-evidence');
          const captureRequest = evidence.get(control.captureId);
          captureRequest.onsuccess = () => {
            try {
              const capture = validateCapture(captureRequest.result, control);
              const records: CapturedLibraryRecord[] = [];
              result = { control, capture, records };
              const seenKeys: IDBValidKey[] = [];
              for (const [index, id] of capture.recordIds.entries()) {
                const request = evidence.get(id);
                request.onsuccess = () => {
                  try {
                    const item = record(request.result, ['kind', 'migrationId', 'id', 'sourceKey', 'value']);
                    if (item.kind !== 'raw-library-record' || item.id !== id || item.migrationId !== control.migrationId) throw recoveryRequired();
                    const key = item.sourceKey as IDBValidKey;
                    // IDB's comparator validates all supported key types, including binary/compound keys.
                    if (factory.cmp(key, key) !== 0 || seenKeys.some(previous => factory.cmp(previous, key) === 0)) throw recoveryRequired();
                    seenKeys.push(key); records[index] = request.result as CapturedLibraryRecord;
                  } catch (error) { abort(error instanceof DocumentRecoveryError ? error : recoveryRequired()); }
                };
              }
              const actualKeys: IDBValidKey[] = [];
              const cursor = tx.objectStore('documents').openKeyCursor();
              cursor.onsuccess = () => {
                try {
                  if (cursor.result) { actualKeys.push(cursor.result.key); cursor.result.continue(); return; }
                  if (actualKeys.length !== capture.pinnedDocumentKeys.length || actualKeys.some((key, index) =>
                    factory.cmp(key, capture.pinnedDocumentKeys[index]) !== 0)) throw recoveryRequired();
                } catch (error) { abort(error instanceof DocumentRecoveryError ? error : recoveryRequired()); }
              };
              const evidenceCount = evidence.count();
              evidenceCount.onsuccess = () => { if (evidenceCount.result !== capture.recordIds.length + 1) abort(recoveryRequired()); };
              const controlCount = tx.objectStore('document-control').count();
              controlCount.onsuccess = () => { if (controlCount.result !== 1) abort(recoveryRequired()); };
            } catch (error) { abort(error); }
          };
        } catch (error) { abort(error); }
      };
    } catch (error) { reject(storageFailure(error)); }
  });
}

/**
 * Explicit successor bootstrap on the SAME database. Production V3 has no automatic call to this opener.
 * No decoder/JSON round trip runs during upgrade. All writes are within its versionchange transaction.
 * A completed upgrade preserves the old authority and a persistent migration barrier; it activates no library.
 */
export function openSuccessorDatabase(factory: IDBFactory, options: { name?: string; signal?: AbortSignal } = {}): Promise<SuccessorDatabase> {
  const name = options.name ?? 'topictrail-web';
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    let settled = false;
    let abandoned: DocumentRecoveryError | undefined;
    let upgrade: IDBTransaction | undefined;
    let upgraded = false;
    let upgradeCommitted = false;
    let failure: unknown;
    let opened: IDBDatabase | undefined;
    const cancelled = () => new DocumentRecoveryError('cancelled', 'Library upgrade was cancelled. Existing data has been preserved.');
    const finishFailure = (error: unknown) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', cancel); reject(storageFailure(error));
    };
    const cancel = () => {
      if (settled) return;
      if (!upgrade) { abandoned = cancelled(); opened?.close(); finishFailure(abandoned); }
      else if (!upgradeCommitted) {
        failure = cancelled();
        // If commit already won, await onsuccess and return its actual persistent barrier.
        try { upgrade.abort(); } catch { /* The transaction's completion/error event decides. */ }
      }
    };
    if (signal?.aborted) { finishFailure(cancelled()); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const request = factory.open(name, SUCCESSOR_DATABASE_VERSION);
      request.onblocked = () => {
        abandoned = new DocumentRecoveryError('upgrade_blocked', 'Another tab is holding this library open. Close or reload that tab, then retry the upgrade.');
        finishFailure(abandoned);
      };
      request.onupgradeneeded = event => {
        upgrade = request.transaction!;
        // Rejecting onblocked/abort alone does not cancel an IDBOpenDBRequest. Fence its later event too.
        if (abandoned || signal?.aborted) { failure = abandoned ?? cancelled(); upgrade.abort(); return; }
        upgrade.addEventListener('complete', () => { upgradeCommitted = true; });
        upgrade.addEventListener('error', event => { failure ??= (event.target as IDBRequest).error ?? upgrade?.error; });
        try {
          const sourceVersion = event.oldVersion;
          if (sourceVersion !== 0 && sourceVersion !== 1) throw new DocumentRecoveryError('upgrade_required',
            'This existing storage schema requires its compatible migration. Existing data has been preserved.');
          const db = request.result;
          if (sourceVersion === 0) { db.createObjectStore('libraries'); db.createObjectStore('documents'); }
          validateSchema(db, upgrade, ['libraries', 'documents']);
          const migrationId = globalThis.crypto?.randomUUID?.();
          if (!migrationId || !uuid.test(migrationId)) throw new DocumentRecoveryError('writer_unavailable', 'Secure library identity generation is unavailable.');
          const evidence = db.createObjectStore('document-evidence');
          const controlStore = db.createObjectStore('document-control');
          const captureId = `${migrationId}:capture`;
          const recordIds: string[] = [];
          const pinnedDocumentKeys: IDBValidKey[] = [];
          let completed = 0;
          const captured = () => {
            if (++completed !== 2) return;
            const capture: BootstrapCapture = { kind: 'upgrade-capture', id: captureId, migrationId,
              sourceDatabaseVersion: sourceVersion, recordIds, pinnedDocumentKeys };
            const control: BootstrapControl = { version: 1, protocol: DOCUMENT_STORE_PROTOCOL, mode: 'migration',
              controlRevision: 1, fenceEpoch: 1, migrationId, sourceDatabaseVersion: sourceVersion, captureId,
              libraryId: null, lastEnvelope: null, activeGenerationId: null, activePlan: null, evidenceManifestIds: [] };
            evidence.add(capture, captureId); controlStore.add(control, 'state');
          };
          const source = upgrade.objectStore('libraries').openCursor();
          source.onsuccess = () => {
            try {
              if (!source.result) { captured(); return; }
              const id = `${migrationId}:library:${recordIds.length}`;
              evidence.add({ kind: 'raw-library-record', migrationId, id, sourceKey: source.result.key,
                value: source.result.value } satisfies CapturedLibraryRecord, id);
              recordIds.push(id); source.result.continue();
            } catch (error) { failure = error; upgrade!.abort(); }
          };
          const bytes = upgrade.objectStore('documents').openKeyCursor();
          bytes.onsuccess = () => {
            try {
              if (!bytes.result) { captured(); return; }
              pinnedDocumentKeys.push(bytes.result.key); bytes.result.continue();
            } catch (error) { failure = error; upgrade!.abort(); }
          };
          upgraded = true;
        } catch (error) { failure = error; upgrade.abort(); }
      };
      request.onerror = () => finishFailure(failure ?? abandoned ?? request.error);
      request.onsuccess = () => {
        const db = request.result; opened = db;
        if (settled || abandoned || (signal?.aborted && !upgradeCommitted)) {
          db.close(); finishFailure(abandoned ?? cancelled()); return;
        }
        let closed = false;
        const close = () => { closed = true; db.close(); };
        db.onversionchange = close;
        const inspectBootstrap = () => closed ? Promise.reject(storageFailure(null)) : inspect(db, factory);
        void inspectBootstrap().then(() => {
          if (settled) { close(); return; }
          settled = true; signal?.removeEventListener('abort', cancel);
          resolve({ name, version: SUCCESSOR_DATABASE_VERSION, upgraded,
            cancelledAfterUpgrade: upgradeCommitted && !!signal?.aborted, inspectBootstrap, close });
        }).catch(error => { close(); finishFailure(error); });
      };
    } catch (error) { finishFailure(error); }
  });
}
