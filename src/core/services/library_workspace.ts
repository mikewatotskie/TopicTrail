import type { AuthState } from '../auth/types';

export type LibraryNamespace = Readonly<
  { kind: 'guest'; libraryId: string; key: string }
  | { kind: 'account'; project: string; uid: string; key: string }
>;
export class WorkspaceChangedError extends Error {
  readonly code = 'workspace_changed';
  constructor() { super('The active library changed. Return to your library and try again.'); }
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function guestNamespace(establishedLibraryId: string): LibraryNamespace {
  // The migration/control authority must establish this ID durably. Never mint one on a read.
  if (!uuid.test(establishedLibraryId)) throw new WorkspaceChangedError();
  return Object.freeze({ kind: 'guest', libraryId: establishedLibraryId, key: `guest/${establishedLibraryId}` });
}
export function accountNamespace(project: string, uid: string): LibraryNamespace {
  if (!/^[a-z0-9]{20}$/.test(project) || !uuid.test(uid)) throw new WorkspaceChangedError();
  return Object.freeze({ kind: 'account', project, uid, key: `account/${project}/${uid}` });
}
/** Unknown authentication is blocked, not silently reinterpreted as the guest or last account. */
export function workspaceForAuthentication(state: AuthState, project: string, guestLibraryId: string | null): LibraryNamespace | null {
  try {
    if (state.status === 'guest') return guestLibraryId ? guestNamespace(guestLibraryId) : null;
    if (state.status === 'account' && state.account.emailVerified && state.account.projectNamespace === project) {
      return accountNamespace(project, state.account.uid);
    }
  } catch { /* Invalid/unestablished ownership cannot select a writable namespace. */ }
  return null;
}
export interface WorkspaceLease {
  readonly namespace: LibraryNamespace;
  readonly epoch: number;
  readonly signal: AbortSignal;
}
export interface WorkspaceSnapshot { readonly namespace: LibraryNamespace | null; readonly epoch: number }

/**
 * Process-local response fence for the successor repository integration.
 * This is NOT a filesystem lock or durable writer fence. Storage commands must also
 * check namespace, protocol, head, control epoch and generation inside their transaction/broker.
 * No storage is opened/migrated here; account changes never adopt guest materials.
 */
export class LibraryWorkspace {
  private snapshot: WorkspaceSnapshot = Object.freeze({ namespace: null, epoch: 0 });
  private controller = new AbortController();
  private readonly leases = new WeakSet<WorkspaceLease>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  getSnapshot = (): WorkspaceSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  select(namespace: LibraryNamespace | null): void {
    if (this.disposed) throw new WorkspaceChangedError();
    // Reconstruct instead of trusting a structurally forged key supplied by a caller.
    const next = namespace?.kind === 'guest' ? guestNamespace(namespace.libraryId)
      : namespace?.kind === 'account' ? accountNamespace(namespace.project, namespace.uid) : null;
    if (next?.key === this.snapshot.namespace?.key) return;
    if (this.snapshot.epoch === Number.MAX_SAFE_INTEGER) { this.dispose(); throw new WorkspaceChangedError(); }
    this.controller.abort(); this.controller = new AbortController();
    this.snapshot = Object.freeze({ namespace: next, epoch: this.snapshot.epoch + 1 });
    for (const listener of this.listeners) listener();
  }
  capture(): WorkspaceLease {
    if (this.disposed || !this.snapshot.namespace) throw new WorkspaceChangedError();
    const lease = Object.freeze({ namespace: this.snapshot.namespace, epoch: this.snapshot.epoch, signal: this.controller.signal });
    this.leases.add(lease); return lease;
  }
  assertCurrent(lease: WorkspaceLease): void {
    if (this.disposed || !this.leases.has(lease) || lease.signal.aborted || lease.epoch !== this.snapshot.epoch
      || lease.namespace.key !== this.snapshot.namespace?.key) throw new WorkspaceChangedError();
  }
  async read<T>(lease: WorkspaceLease, operation: (scope: WorkspaceLease) => Promise<T>): Promise<T> {
    this.assertCurrent(lease);
    const value = await operation(lease);
    this.assertCurrent(lease); // Never publish another account's late read into the current screen/cache.
    return value;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.controller.abort();
    this.snapshot = Object.freeze({ namespace: null, epoch: this.snapshot.epoch });
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}
