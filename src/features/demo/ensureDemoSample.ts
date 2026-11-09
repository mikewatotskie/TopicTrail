import type { Document } from '../../core/models/document';
import type { GuestImportOutcome, ImportActor, ImportAttempt, ImportResult } from '../../core/services/document_import_contract';
import type { DemoSample } from './demoSamples';

type LookupAttempt = (attemptId: string) => Promise<GuestImportOutcome>;
export interface DemoSampleImportPort {
  lookup: LookupAttempt;
  importSample(sample: DemoSample, attempt: ImportAttempt): Promise<ImportResult>;
}

async function nextSampleAttempt(sample: DemoSample, lookup: LookupAttempt, start = 1) {
  for (let generation = start; ; generation++) {
    const attemptId = 'topictrail-presentation-v1-' + sample.kind + '-' + generation;
    const outcome = await lookup(attemptId);
    if (outcome.kind !== 'deleted') return { attemptId, generation, outcome };
  }
}

export async function findDemoSample(sample: DemoSample, lookup: LookupAttempt): Promise<Document | undefined> {
  const { outcome } = await nextSampleAttempt(sample, lookup);
  return outcome.kind === 'committed' ? outcome.document : undefined;
}

export async function ensureDemoSample(sample: DemoSample, actor: ImportActor, port: DemoSampleImportPort): Promise<Document> {
  let start = 1;
  for (;;) {
    const { attemptId, generation, outcome } = await nextSampleAttempt(sample, port.lookup, start);
    if (outcome.kind === 'committed') return outcome.document;

    const result = await port.importSample(sample, { attemptId, actor });
    if (result.success && result.document) return result.document;
    // Another window can finish and delete this generation between lookup and import.
    if (result.code !== 'already_deleted') throw Error(result.errorMessage ?? 'The sample could not be added. Try again.');
    start = generation + 1;
  }
}
