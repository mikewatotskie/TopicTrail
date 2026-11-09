import type { Document } from '../models/document';
import type { DocumentStorageApi } from './document_storage_contract';
export type ImportActor = Readonly<{ kind: 'guest' } | { kind: 'account'; uid: string }>;
export interface ImportAttempt { readonly attemptId: string; readonly actor: ImportActor }
export type GuestAllowance = { kind: 'disabled' } | { kind: 'ready'; used: number; remaining: number } | { kind: 'recovery_required' };
export type GuestImportOutcome = { kind: 'uncommitted' } | { kind: 'committed'; document: Document } | { kind: 'deleted' };
export type ImportResultCode = 'guest_limit' | 'guest_usage_recovery' | 'storage_conflict' | 'retry' | 'reselect' | 'already_deleted' | 'committed';
export class ImportOperationError extends Error {
  constructor(public readonly code: Exclude<ImportResultCode, 'committed'>, message: string) { super(message); }
}
export function importFailure(error: unknown, fallback: string): ImportResult {
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code: ImportResultCode = rawCode === 'guest_limit' || rawCode === 'guest_usage_recovery'
    || rawCode === 'storage_conflict' || rawCode === 'retry' || rawCode === 'reselect' || rawCode === 'already_deleted'
    ? rawCode : rawCode === 'conflict' ? 'storage_conflict' : 'retry';
  return new ImportResult(false, undefined, error instanceof Error ? error.message : fallback, false, code);
}
export function createImportAttempt(): ImportAttempt {
  return { attemptId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, actor: { kind: 'guest' } };
}
/** Copy context before the first await, so session changes cannot alter a submission. */
export function snapshotImportAttempt(attempt?: ImportAttempt): ImportAttempt | undefined {
  if (!attempt) return undefined;
  if (typeof attempt.attemptId !== 'string' || !attempt.attemptId.trim()
    || !attempt.actor || (attempt.actor.kind !== 'guest' && attempt.actor.kind !== 'account')
    || (attempt.actor.kind === 'account' && (typeof attempt.actor.uid !== 'string' || !attempt.actor.uid.trim())))
    throw new ImportOperationError('retry', 'A valid import attempt and actor are required.');
  return { attemptId: attempt.attemptId, actor: { ...attempt.actor } };
}
export async function preflightImport(storage: DocumentStorageApi, attempt?: ImportAttempt): Promise<ImportResult | undefined> {
  if (attempt) {
    const outcome = await storage.lookupGuestImportOutcome(attempt.attemptId);
    if (outcome.kind === 'committed') return new ImportResult(true, outcome.document, undefined, false, 'committed');
    if (outcome.kind === 'deleted') return new ImportResult(false, undefined,
      'This import was already completed and its document was deleted.', false, 'already_deleted');
  }
  if (storage.guestUploadPolicy !== 'two_guest_successes_v1') return;
  if (!attempt) throw new ImportOperationError('retry', 'An import attempt and actor are required.');
  if (attempt.actor.kind === 'account') return;
  const allowance = await storage.getGuestAllowance();
  if (allowance.kind === 'recovery_required') throw new ImportOperationError('guest_usage_recovery', 'Guest usage recovery is required. Sign in to continue.');
  if (allowance.kind === 'ready' && allowance.remaining === 0) throw new ImportOperationError('guest_limit', 'The two guest imports have been used. Sign in to continue.');
}
export class ImportResult {
  constructor(public readonly success: boolean, public readonly document?: Document,
    public readonly errorMessage?: string, public readonly canceled = false, public readonly code?: ImportResultCode) {}
}
