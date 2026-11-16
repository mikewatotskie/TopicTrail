import { studyTransferMetadata, studyTransferNative } from './study_transfer_native';

export function productionMetadata() {
  return studyTransferNative().role === 'production' ? studyTransferMetadata() : null;
}

/** A storage adapter keeps the version actually read by its repository. An
 * import changing it in the meantime must never be overwritten by stale UI. */
export function metadataPort(key: string) {
  let observed: string | null | undefined;
  return {
    async readMetadata() {
      const store = productionMetadata()!;
      [observed] = await store.read([key]);
      return observed;
    },
    async writeMetadata(value: string) {
      const store = productionMetadata()!;
      if (observed === undefined || !await store.compareAndSet([key], [observed], [value])) {
        throw Error('The library changed. Reopen it and retry.');
      }
      observed = value;
    },
  };
}
