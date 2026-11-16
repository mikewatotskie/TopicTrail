import type { Document } from '../../core/models/document';
import { sha256 } from '../../core/services/cloud/sha256';
import { createImportAttempt, importFailure, type ImportActor, type ImportAttempt, type ImportResult } from '../../core/services/document_import_contract';
import type { DocumentStorageApi } from '../../core/services/document_storage_contract';
import type { ScanPhoto, ScanTranscript } from './photo_contract';
import { createScanPdf } from './photo_pdf';

export interface ScanDraftIO {
  isCurrent(): boolean;
  actor: ImportActor;
  choosePhoto(): Promise<ScanPhoto | null>;
  releasePhoto(photo: ScanPhoto): void;
  rotatePhoto(photo: ScanPhoto): Promise<ScanPhoto>;
  photoBytes(photo: ScanPhoto): Promise<Uint8Array>;
  recognizePhoto(photo: ScanPhoto, signal: AbortSignal): Promise<ScanTranscript>;
  withPdfSource<T>(bytes: Uint8Array, use: (uri: string) => Promise<T>): Promise<T>;
  importFile(uri: string, name: string, attempt: ImportAttempt, current: () => boolean): Promise<ImportResult>;
  saveTranscript(hash: string, page: number, transcript: ScanTranscript): Promise<void>;
  copyText(text: string): Promise<unknown>;
}

export interface ScanDraftSnapshot {
  photo: ScanPhoto | null;
  source: 'file' | 'camera' | null;
  confirmed: boolean;
  transcript: ScanTranscript | null;
  busy: 'choosing' | 'rotating' | 'recognizing' | 'saving' | 'copying' | null;
  saveAttempted: boolean;
  result: ImportResult | null;
  message: string;
  error: string;
}

const empty = (): ScanDraftSnapshot => ({ photo: null, source: null, confirmed: false, transcript: null,
  busy: null, saveAttempted: false, result: null, message: '', error: '' });
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** The importer awaits preflight and byte validation before saving. Fence every store call too,
 * including same-UID sign-out/sign-in, rather than relying on the facade's UID check alone. */
export function guardScanStorage(storage: DocumentStorageApi, current: () => boolean): DocumentStorageApi {
  const check = () => { if (!current()) throw new Error('The scan session changed. Return to your current library.'); };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    check(); const value = await operation(); check(); return value;
  };
  return {
    get guestUploadPolicy() { check(); return storage.guestUploadPolicy; },
    initialize: () => run(() => storage.initialize()),
    getAllDocuments: () => run(() => storage.getAllDocuments()),
    getDocument: id => run(() => storage.getDocument(id)),
    getGuestAllowance: () => run(() => storage.getGuestAllowance()),
    lookupGuestImportOutcome: id => run(() => storage.lookupGuestImportOutcome(id)),
    documentFileExists: id => run(() => storage.documentFileExists(id)),
    saveDocument: input => run(() => storage.saveDocument(input)),
    updateDocument: document => run(() => storage.updateDocument(document)),
    deleteDocument: id => run(() => storage.deleteDocument(id)),
    updateLastOpened: id => run(() => storage.updateLastOpened(id)),
  };
}

/** Memory-only private draft. Construction/subscription never opens a picker or camera or writes.
 * Only explicit Save creates a PDF/import. An uncertain save freezes its bytes and receipt ID. */
export class ScanDraft {
  private state = empty();
  private readonly listeners = new Set<() => void>();
  private readonly released = new Set<string>();
  private active = false;
  private generation = 0;
  private recognition?: AbortController;
  private attempt?: ImportAttempt;
  private pdf?: { bytes: Uint8Array; hash: string; name: string };

  constructor(private readonly io: ScanDraftIO) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  isCurrent = () => this.active && this.io.isCurrent();
  private current = (generation: number) => this.generation === generation && this.isCurrent();
  private update(patch: Partial<ScanDraftSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private release(photo: ScanPhoto | null) {
    if (!photo || this.released.has(photo.uri)) return;
    this.released.add(photo.uri);
    try { this.io.releasePhoto(photo); } catch { /* Only owned scratch; cleanup cannot reverse a saved PDF. */ }
  }
  activate() { this.active = true; }
  /** Reversible activation supports StrictMode effect replay; old generations never revive. */
  deactivate() { this.active = false; this.reset(); }
  private reset() {
    this.generation++;
    this.recognition?.abort(); this.recognition = undefined;
    this.release(this.state.photo);
    this.attempt = undefined; this.pdf = undefined;
    this.update(empty());
  }
  discard() {
    const { saveAttempted, result } = this.state;
    this.reset();
    if (this.isCurrent()) this.update({ message: result?.success
      ? 'Preview closed. Your saved PDF is in My Syllabi.'
      : saveAttempted ? 'Draft discarded. If a save was interrupted, check My Syllabi before scanning it again.'
        : 'Photo discarded. Nothing was saved to your library.' });
  }
  private editable() { return this.isCurrent() && !this.state.busy && !this.state.saveAttempted; }

  acceptPhoto(photo: ScanPhoto, source: 'file' | 'camera') {
    if (!this.editable()) { this.release(photo); return; }
    if (this.state.photo?.uri !== photo.uri) this.release(this.state.photo);
    this.generation++;
    this.update({ ...empty(), photo, source, confirmed: source === 'file',
      message: source === 'camera' ? 'Review the photo. Choose Retake or Use photo.' : 'Check the orientation, then recognize the text.' });
  }
  usePhoto() {
    if (this.editable() && this.state.photo) this.update({ confirmed: true, message: 'Check the orientation, then recognize the text.', error: '' });
  }
  async choose(picker: ScanDraftIO['choosePhoto'] = this.io.choosePhoto) {
    if (!this.editable()) return;
    const generation = this.generation;
    this.update({ busy: 'choosing', error: '', message: 'Waiting for the photo chooser…' });
    try {
      // Invoke in the original button gesture, before any await (required by browser pickers).
      const photo = await picker();
      if (!this.current(generation)) { this.release(photo); return; }
      this.update({ busy: null });
      if (photo) this.acceptPhoto(photo, 'file');
      else this.update({ message: this.state.photo ? 'Photo selection cancelled. Your preview is unchanged.' : 'Photo selection cancelled. Nothing was saved.' });
    } catch (error) {
      if (this.current(generation)) this.update({ busy: null, message: '', error: messageOf(error, 'This photo could not be read. Choose a JPG or PNG, or take another photo.') });
    }
  }
  async rotate() {
    if (!this.editable() || !this.state.photo) return;
    const photo = this.state.photo, generation = this.generation;
    this.update({ busy: 'rotating', message: 'Rotating photo…', error: '' });
    try {
      const rotated = await this.io.rotatePhoto(photo);
      if (!this.current(generation)) { this.release(rotated); return; }
      if (rotated.uri !== photo.uri) this.release(photo);
      this.update({ photo: rotated, transcript: null, busy: null, message: 'Photo rotated. Recognize again for this orientation.' });
    } catch (error) {
      if (this.current(generation)) this.update({ busy: null, message: '', error: messageOf(error, 'The photo could not be rotated. Your preview is unchanged.') });
    }
  }
  async recognize() {
    if (!this.editable() || !this.state.confirmed || !this.state.photo) return;
    const generation = this.generation, abort = new AbortController();
    this.recognition = abort;
    this.update({ busy: 'recognizing', transcript: null, error: '', message: 'Recognizing text on this device…' });
    try {
      const value = await this.io.recognizePhoto(this.state.photo, abort.signal);
      if (!this.current(generation) || abort.signal.aborted) return;
      if (!value || typeof value.text !== 'string' || value.text.length > 50_000 || typeof value.truncated !== 'boolean' ||
          (value.confidence !== null && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 100))) {
        throw new Error('The recognition result was unreadable. Try a clearer photo.');
      }
      this.update({ transcript: { ...value }, message: value.text.trim()
        ? 'Text is ready below the photo. Review it for recognition errors.'
        : 'No readable text was found. Try rotating, retaking, or choosing a clearer photo. You can still save the photo as a PDF.' });
    } catch (error) {
      if (this.current(generation) && !abort.signal.aborted) this.update({ message: '', error: messageOf(error, 'Text recognition failed. Try a clearer photo or recognize again.') });
    } finally {
      if (this.current(generation) && this.recognition === abort) { this.recognition = undefined; this.update({ busy: null }); }
    }
  }
  cancelRecognition() {
    if (this.state.busy !== 'recognizing') return;
    this.generation++;
    this.recognition?.abort(); this.recognition = undefined;
    this.update({ busy: null, transcript: null, error: '', message: 'Recognition cancelled. Your photo is still private and has not been saved.' });
  }
  async copyTranscript() {
    if (!this.isCurrent() || this.state.busy || !this.state.transcript?.text.trim()) return;
    const generation = this.generation;
    this.update({ busy: 'copying', error: '' });
    try {
      await this.io.copyText(this.state.transcript.text);
      if (this.current(generation)) this.update({ message: 'Transcript copied to clipboard.' });
    } catch {
      if (this.current(generation)) this.update({ error: 'The transcript could not be copied. Select the text below and copy it manually.' });
    } finally { if (this.current(generation)) this.update({ busy: null }); }
  }
  async save(): Promise<Document | undefined> {
    if (!this.isCurrent() || this.state.busy) return;
    if (this.state.result?.success) return this.state.result.document;
    if (!this.state.photo || !this.state.confirmed || this.state.result?.code === 'already_deleted') return;
    const generation = this.generation, photo = this.state.photo, transcript = this.state.transcript;
    const current = () => this.current(generation);
    // This guard and the attempt are set synchronously, before any IO or reentrant button press.
    this.attempt ??= Object.freeze({ attemptId: createImportAttempt().attemptId, actor: Object.freeze({ ...this.io.actor }) });
    const attempt = this.attempt;
    this.update({ busy: 'saving', saveAttempted: true, error: '', message: 'Saving one PDF to your library…' });
    try {
      if (!this.pdf) {
        const jpeg = await this.io.photoBytes(photo);
        if (!current()) return;
        const bytes = createScanPdf(jpeg, photo.width, photo.height);
        this.pdf = { bytes, hash: sha256(bytes), name: `Scan ${new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')}.pdf` };
      }
      const pdf = this.pdf;
      if (!current()) return;
      const result = await this.io.withPdfSource(pdf.bytes, async uri => {
        if (!current()) throw new Error('The scan session changed before import.');
        return this.io.importFile(uri, pdf.name, attempt, current);
      });
      if (!current()) return;
      this.update({ result });
      if (!result.success || !result.document) {
        this.update({ message: 'Your draft is kept. Retry save uses the same import attempt; it does not create a second copy.',
          error: result.canceled ? 'Save cancelled. Your draft is still available.' : result.errorMessage ?? 'The save could not be confirmed. Retry save to check its receipt.' });
        return;
      }
      // A cache failure must never turn a committed PDF into another import/retry.
      this.update({ message: 'PDF saved. Open it to use notes, highlights and Study.' });
      if (transcript && current()) {
        try { await this.io.saveTranscript(pdf.hash, 1, transcript); }
        catch { if (current()) this.update({ error: 'The PDF was saved, but its transcript could not be cached on this device. You can recognize it again in the reader.' }); }
      }
      if (!current()) return;
      this.release(photo); this.pdf = undefined;
      this.update({ photo: null });
      return result.document;
    } catch (error) {
      if (current()) this.update({ result: importFailure(error, 'The save could not be confirmed.'),
        error: messageOf(error, 'The save could not be confirmed.'),
        message: 'Your draft is kept. Retry save checks the same import attempt. Check My Syllabi before discarding an interrupted save.' });
    } finally { if (current()) this.update({ busy: null }); }
  }
}
