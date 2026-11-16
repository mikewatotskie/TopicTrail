import { Platform } from 'react-native';
import { createImportAttempt } from '../../core/services/document_import_contract';
import { choosePhoto, releasePhoto } from './photo_platform';
import type { ScanPhoto } from './photo_contract';

export type DockScanEntry = 'pick' | 'capture';
interface DockRequest {
  id: string;
  entry: DockScanEntry;
  epoch: number;
  controller: AbortController;
  picked?: Promise<ScanPhoto | null>;
  timeout: ReturnType<typeof setTimeout>;
}

let pending: DockRequest | undefined;

function discard(request: DockRequest) {
  clearTimeout(request.timeout);
  pending = undefined;
  request.controller.abort();
  void request.picked?.then(photo => { if (photo) releasePhoto(photo); }, () => {});
}

/** Called directly in the dock row's press handler while browser activation is available. */
export function beginDockScan(entry: DockScanEntry, epoch: number): string {
  if (pending) discard(pending);
  const id = createImportAttempt().attemptId;
  const controller = new AbortController();
  const picked = Platform.OS === 'web' && entry === 'pick' ? choosePhoto(controller.signal) : undefined;
  // The route will adopt the original rejection once it mounts.
  void picked?.catch(() => {});
  const timeout = setTimeout(() => {
    if (pending?.id === id) discard(pending);
  }, 30_000);
  pending = { id, entry, epoch, controller, picked, timeout };
  return id;
}

/** A URL, a refocus or a restored route cannot replay a dock gesture. */
export function takeDockScan(entry: unknown, id: unknown, epoch: number, canStart: boolean) {
  const request = pending;
  if (!request || request.id !== id) return;
  if (!canStart || request.entry !== entry || request.epoch !== epoch) {
    discard(request);
    return;
  }
  clearTimeout(request.timeout);
  pending = undefined;
  return {
    entry: request.entry,
    pick: request.picked ? () => request.picked! : () => choosePhoto(request.controller.signal),
    cancel: () => request.controller.abort(),
  };
}
